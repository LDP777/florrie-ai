/**
 * The approve button on an AI action, driven over real HTTP.
 *
 * Two things were wrong with POST /api/ai-actions/:id/execute, and the second
 * one is a legal problem rather than a bug.
 *
 * 1. It sent the SMS and THEN wrote `resolved_at`, a column ai_actions has
 *    never had. Check 001_initial_schema.sql (the table), 051 (constraints
 *    only) and 20260803_schema_drift_columns.sql (which added `status`, the
 *    column this route actually wants). PostgREST rejects the whole write with
 *    42703. The error was never destructured, so the row stayed at
 *    pending_approval, the card stayed on screen, and the next tap ran the
 *    rebook_nudge branch and texted the client all over again. The dismiss
 *    handler named the same column, so it 500'd every time and the card could
 *    not even be cleared.
 *
 * 2. The sendSMS call passed no messageType. It defaulted to 'general',
 *    isMarketingSmsType('general') is false, and the PECR opt-out check at the
 *    top of sendSMS was skipped entirely. A client who had replied STOP got a
 *    marketing rebook nudge. Nothing about it went through the outbound gate
 *    either, so consent, the per-client autonomy override, quiet hours, the
 *    cross-engine frequency cap, the monthly cap and the allowance were all
 *    bypassed.
 *
 * The fake below rejects a write naming a column that is not in the real
 * table, exactly as PostgREST does, because that IS the bug in (1).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';

// Every column ai_actions has, read off supabase/migrations: 001 created the
// table, 20260803_schema_drift_columns.sql added status. There is no
// resolved_at, and no decided_at either.
const AI_ACTION_COLUMNS = new Set([
  'id', 'beautician_id', 'action_type', 'digital_employee', 'summary', 'details',
  'confidence', 'autonomous', 'client_id', 'appointment_id', 'message_id',
  'outcome', 'notification_sent', 'notification_text', 'created_at', 'status',
]);

const COLUMNS = { ai_actions: AI_ACTION_COLUMNS };

const db = { ai_actions: [], clients: [] };

function builder(table) {
  const filters = [];
  let pending = null;
  let head = false;
  let wantRows = false;
  let rejected = null;

  const matched = () => (db[table] || []).filter(r => filters.every(f => f(r)));

  const checkColumns = (payload) => {
    const known = COLUMNS[table];
    if (!known) return;
    const bad = Object.keys(payload).find(c => !known.has(c));
    if (bad) rejected = { code: '42703', message: `column "${bad}" of relation "${table}" does not exist` };
  };

  const settle = () => {
    if (rejected) return { data: null, error: rejected, count: null };
    if (head) return { data: null, error: null, count: matched().length };
    if (pending?.op === 'insert') {
      const row = { id: `${table}_${db[table].length + 1}`, ...pending.payload };
      db[table].push(row);
      return { data: [row], error: null };
    }
    if (pending?.op === 'update') {
      const rows = matched();
      for (const r of rows) Object.assign(r, pending.payload);
      return { data: wantRows ? rows : null, error: null };
    }
    return { data: matched(), error: null };
  };

  const b = {
    select(_cols, opts) { if (opts?.head) head = true; wantRows = true; return b; },
    insert(p) { pending = { op: 'insert', payload: p }; checkColumns(p); return b; },
    update(p) { pending = { op: 'update', payload: p }; checkColumns(p); return b; },
    eq(c, v) { filters.push(r => r[c] === v); return b; },
    // SQL, not JavaScript: `col <> 'x'` is NULL for a NULL col, so the row
    // is NOT returned. That difference is the whole of the null-reason case.
    neq(c, v) { filters.push(r => (r[c] ?? null) !== null && r[c] !== v); return b; },
    in(c, v) { filters.push(r => v.includes(r[c])); return b; },
    is(c, v) { filters.push(r => (r[c] ?? null) === v); return b; },
    gte(c, v) { filters.push(r => String(r[c] ?? '') >= String(v)); return b; },
    order() { return b; }, limit() { return b; },
    maybeSingle() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    single() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    then(res, rej) { return Promise.resolve(settle()).then(res, rej); },
  };
  return b;
}

vi.mock('../../src/config.js', () => ({ supabase: { from: builder } }));
vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.beautician = { id: 'b1' }; next(); },
}));

// Every text that actually left the building.
const texts = [];
vi.mock('../../src/services/notifications.js', () => ({
  sendSMS: async (args) => {
    texts.push(args);
    // A real send takes a moment. The await is what lets a second request
    // interleave, which is the whole point of the double-tap case.
    await new Promise(r => setTimeout(r, 5));
    return sendResult;
  },
}));

// The gate. Recorded rather than reimplemented: this test is about whether the
// route asks it at all, and what it tells it.
const gateCalls = [];
const recorded = [];
let verdict = { decision: 'send', tier: 'proactive', reason: 'trusted_auto' };
let sendResult = { id: 'bird-1' };
vi.mock('../../src/lib/outbound-guard.js', () => ({
  evaluateOutbound: async (args) => { gateCalls.push(args); return verdict; },
  recordOutbound: async (args) => { recorded.push(args); return 'out-1'; },
}));

const { default: router } = await import('../../src/routes/ai-actions.js');

const app = express();
app.use(express.json());
app.use('/api/ai-actions', router);

let server, base;
beforeEach(async () => {
  db.ai_actions = [];
  db.clients = [];
  texts.length = 0;
  gateCalls.length = 0;
  recorded.length = 0;
  verdict = { decision: 'send', tier: 'proactive', reason: 'trusted_auto' };
  sendResult = { id: 'bird-1' };

  db.clients.push({
    id: 'c1', beautician_id: 'b1', first_name: 'Nadia', phone: '+447700900002',
    marketing_consent: true, marketing_opted_out_at: null, messaging_autonomy: null,
  });
  db.ai_actions.push({
    id: 'act-1', beautician_id: 'b1', client_id: 'c1', action_type: 'rebook_nudge',
    digital_employee: 'comeback', summary: 'Nadia is overdue for a rebook. Send nudge?',
    outcome: 'pending', status: 'pending_approval', confidence: 0.85,
    created_at: new Date().toISOString(),
  });

  if (!server) {
    server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}/api/ai-actions`;
    server.unref();
  }
});

const action = () => db.ai_actions.find(a => a.id === 'act-1');
const execute = () => fetch(`${base}/act-1/execute`, { method: 'POST' });

describe('Ellie taps approve on a rebook nudge', () => {
  it('sends the client one text', async () => {
    const res = await execute();
    expect(res.status).toBe(200);
    expect(texts).toHaveLength(1);
    expect(texts[0].to).toBe('+447700900002');
    expect(texts[0].body).toContain('Nadia');
  });

  it('and the card goes away, because the status actually moved', async () => {
    await execute();
    expect(action().status).toBe('executed');
  });

  it('writing only columns ai_actions has, so nothing comes back 42703', async () => {
    const res = await execute();
    expect(res.status).toBe(200);
    // resolved_at is not a column on this table. If the route names it again,
    // the fake rejects the write the way PostgREST does and this fails.
    expect(Object.keys(action())).not.toContain('resolved_at');
  });
});

describe('Ellie taps it twice, because the card did not move the first time', () => {
  it('the client is texted once, not twice', async () => {
    await execute();
    await execute();
    expect(texts).toHaveLength(1);
  });

  it('and two taps that land together still only send one', async () => {
    const [a, b] = await Promise.all([execute(), execute()]);
    expect(texts).toHaveLength(1);
    // One wins, one is told it was already handled.
    const codes = [a.status, b.status].sort();
    expect(codes[0]).toBe(200);
    expect(codes[1]).toBeGreaterThanOrEqual(400);
  });

  it('the second tap is refused rather than re-run', async () => {
    await execute();
    const second = await execute();
    expect(second.status).toBeGreaterThanOrEqual(400);
  });
});

describe('the client who replied STOP', () => {
  it('is classified as marketing, which is what makes the PECR check run', async () => {
    // Against the real classifier, not a copy of its list, so this moves if
    // anyone reclassifies the type.
    const { isMarketingSmsType } = await vi.importActual('../../src/lib/marketing-guard.js');
    const { classifyTier } = await vi.importActual('../../src/lib/outbound-guard.js');
    expect(isMarketingSmsType('rebook_nudge')).toBe(true);
    expect(isMarketingSmsType('general')).toBe(false);
    expect(classifyTier('rebook_nudge')).toBe('proactive');
  });

  it('is named on the send, so sendSMS runs the opt-out check', async () => {
    await execute();
    expect(texts[0].messageType).toBe('rebook_nudge');
    expect(texts[0].clientId).toBe('c1');
  });

  it('gets nothing when the gate says she has opted out', async () => {
    db.clients[0].marketing_opted_out_at = new Date().toISOString();
    verdict = { decision: 'block', tier: 'proactive', reason: 'opted_out' };

    const res = await execute();

    expect(texts).toHaveLength(0);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toMatch(/opted out/i);
  });

  it('and the refusal is recorded, so the caps can see it', async () => {
    verdict = { decision: 'block', tier: 'proactive', reason: 'opted_out' };
    await execute();
    expect(recorded.some(r => r.status === 'blocked' && r.reason === 'opted_out')).toBe(true);
  });
});

describe('the gate is asked before anything is sent', () => {
  it('every text has a gate decision behind it', async () => {
    await execute();
    expect(gateCalls).toHaveLength(1);
    expect(gateCalls[0]).toMatchObject({ beauticianId: 'b1', clientId: 'c1', messageType: 'rebook_nudge' });
    expect(texts).toHaveLength(1);
  });

  it('and a block at the gate stops the send whatever the reason is', async () => {
    verdict = { decision: 'block', tier: 'proactive', reason: 'frequency_cap' };
    const res = await execute();
    expect(texts).toHaveLength(0);
    expect(res.status).toBe(400);
  });
});

describe('a send that fails', () => {
  it('puts the card back so she can try again', async () => {
    sendResult = null; // sendSMS returns null on every failure path

    const res = await execute();

    expect(res.status).toBe(400);
    expect(action().status).toBe('pending_approval');
  });

  it('and the retry is allowed to send', async () => {
    sendResult = null;
    await execute();
    sendResult = { id: 'bird-2' };

    const res = await execute();

    expect(res.status).toBe(200);
    expect(texts).toHaveLength(2); // one that failed, one that went
    expect(action().status).toBe('executed');
  });
});

describe('dismissing an action', () => {
  it('works at all', async () => {
    const res = await fetch(`${base}/act-1/dismiss`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect(action().status).toBe('dismissed');
  });

  it('sends nothing', async () => {
    await fetch(`${base}/act-1/dismiss`, { method: 'POST' });
    expect(texts).toHaveLength(0);
  });

  it('and an already dismissed card cannot be dismissed twice', async () => {
    await fetch(`${base}/act-1/dismiss`, { method: 'POST' });
    const again = await fetch(`${base}/act-1/dismiss`, { method: 'POST' });
    expect(again.status).toBe(404);
  });
});

describe('an action of a type this route does not send', () => {
  it('is marked done without texting anybody', async () => {
    db.ai_actions.push({
      id: 'act-2', beautician_id: 'b1', client_id: null, action_type: 'gap_post',
      digital_employee: 'content', summary: 'Drafted a gap post', outcome: 'pending',
      status: 'pending_approval', created_at: new Date().toISOString(),
    });

    const res = await fetch(`${base}/act-2/execute`, { method: 'POST' });

    expect(res.status).toBe(200);
    expect(texts).toHaveLength(0);
    expect(db.ai_actions.find(a => a.id === 'act-2').status).toBe('executed');
  });
});
