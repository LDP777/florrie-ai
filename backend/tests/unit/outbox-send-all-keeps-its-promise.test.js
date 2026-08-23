/**
 * Florrie's outbox, driven over real HTTP. Two ways it sent messages it was
 * not supposed to send.
 *
 * 1. Send all sent the ones the page promises it will not.
 *    A client Ellie sets to "Florrie never initiates" (clients
 *    .messaging_autonomy = 'just_me') still gets a draft written, tagged
 *    reason 'just_me_silent_draft', so the words are there if she ever wants
 *    them. GET /api/outbound/count leaves those out of the badge and
 *    frontend/src/pages/Outbox.jsx puts them in their own section under
 *    "nothing sends unless you say so". POST /approve-all selected on
 *    status='pending_approval' alone. So Ellie tapped Send all to clear three
 *    gap offers and also sent a proactive message to every client she had
 *    explicitly told Florrie never to initiate with. That setting is the one
 *    promise the product makes about not messaging people.
 *
 * 2. Approve was read, send, then mark.
 *    It read the row filtered on pending_approval, called the sender, and only
 *    then flipped the row to 'sent'. Two requests both passed the read, so a
 *    double tap, or approve racing approve-all, sent the same proactive
 *    message to the same client twice. The fix is the same shape as the AI
 *    action approve: claim the row with a compare-and-swap first, send second,
 *    and put the row back if the send did not happen.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';

// Every column outbound_sends has, straight off 066_outbound_guard.sql.
const OUTBOUND_COLUMNS = new Set([
  'id', 'beautician_id', 'client_id', 'message_type', 'tier', 'channel',
  'status', 'reason', 'body', 'created_at', 'decided_at',
]);
const COLUMNS = { outbound_sends: OUTBOUND_COLUMNS };

const db = { outbound_sends: [], beauticians: [] };

/** PostgREST `or=(a,b)`: one of the branches has to match. */
function orPredicate(expr) {
  const branches = String(expr).split(',').map(part => {
    const [col, op, ...rest] = part.split('.');
    const val = rest.join('.');
    if (op === 'is') return r => (r[col] ?? null) === (val === 'null' ? null : val);
    if (op === 'eq') return r => r[col] === val;
    if (op === 'neq') return r => r[col] !== val;
    throw new Error(`unsupported or() operator: ${op}`);
  });
  return r => branches.some(f => f(r));
}

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
    if (pending?.op === 'update') {
      const rows = matched();
      for (const r of rows) Object.assign(r, pending.payload);
      return { data: wantRows ? rows.map(r => ({ ...r })) : null, error: null };
    }
    return { data: matched(), error: null };
  };

  const b = {
    select(_cols, opts) { if (opts?.head) head = true; wantRows = true; return b; },
    update(p) { pending = { op: 'update', payload: p }; checkColumns(p); return b; },
    eq(c, v) { filters.push(r => r[c] === v); return b; },
    // SQL, not JavaScript: `col <> 'x'` is NULL for a NULL col, so the row
    // is NOT returned. That difference is the whole of the null-reason case.
    neq(c, v) { filters.push(r => (r[c] ?? null) !== null && r[c] !== v); return b; },
    or(expr) { filters.push(orPredicate(expr)); return b; },
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

// Every message that actually left the building.
const delivered = [];
let sendOk = true;
vi.mock('../../src/services/messaging.js', () => ({
  sendOnChannel: async (args) => {
    delivered.push(args);
    // A real send takes a moment. The await is what lets a second request
    // interleave, which is what a double tap does.
    await new Promise(r => setTimeout(r, 5));
    return sendOk ? { ok: true } : { ok: false, error: 'Carrier rejected it' };
  },
}));

// The claim guards that are not what this test is about.
vi.mock('../../src/lib/reply-claims-guard.js', () => ({ safeReply: (body) => ({ rejected: false, body }) }));
vi.mock('../../src/lib/free-slots.js', () => ({ getFreeSlots: async () => [] }));
vi.mock('../../src/services/conversational-booking.js', () => ({
  heldBookingClaimContext: async () => ({ allowedTimes: [], actionPerformed: false }),
}));
vi.mock('../../src/lib/idiolect.js', () => ({ AUTHOR: { AI: 'ai', HUMAN: 'human' } }));

const { default: router } = await import('../../src/routes/outbound.js');

const app = express();
app.use(express.json());
app.use('/api/outbound', router);

let server, base;

function hold({ id, clientId, reason, body }) {
  db.outbound_sends.push({
    id, beautician_id: 'b1', client_id: clientId, message_type: 'gap_fill',
    tier: 'proactive', channel: 'sms', status: 'pending_approval', reason,
    body: body || `Hiya, I have a slot on Monday if you fancy it.`,
    created_at: new Date().toISOString(), decided_at: null,
  });
}

const row = id => db.outbound_sends.find(r => r.id === id);
const approve = id => fetch(`${base}/${id}/approve`, { method: 'POST' });
const approveAll = () => fetch(`${base}/approve-all`, { method: 'POST' });
const count = async () => (await (await fetch(`${base}/count`)).json()).count;

beforeEach(async () => {
  db.outbound_sends = [];
  db.beauticians = [{ id: 'b1', first_name: 'Ellie', timezone: 'Europe/London', working_hours: null, whatsapp_phone_id: 'wa1' }];
  delivered.length = 0;
  sendOk = true;

  if (!server) {
    server = app.listen(0);
    base = `http://127.0.0.1:${server.address().port}/api/outbound`;
    server.unref();
  }
});

describe('Ellie taps Send all to clear three gap offers', () => {
  beforeEach(() => {
    hold({ id: 'o1', clientId: 'c1', reason: 'awaiting_approval' });
    hold({ id: 'o2', clientId: 'c2', reason: 'below_confidence_threshold' });
    hold({ id: 'o3', clientId: 'c3', reason: 'known_client_review' });
    // Priya is hers. She told Florrie never to initiate with her.
    hold({ id: 'quiet1', clientId: 'c9', reason: 'just_me_silent_draft' });
  });

  it('sends the three', async () => {
    const res = await approveAll();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ sent: 3, failed: 0 });
  });

  it('and does NOT message the client she keeps to herself', async () => {
    await approveAll();
    expect(delivered.map(d => d.clientId)).not.toContain('c9');
    expect(delivered).toHaveLength(3);
  });

  it('leaving that draft exactly where it was', async () => {
    await approveAll();
    expect(row('quiet1').status).toBe('pending_approval');
    expect(row('quiet1').decided_at).toBeNull();
  });

  it('and the badge and Send all agree on what the queue is', async () => {
    // The badge said three. Send all must send three. They used to be two
    // separate filters and they disagreed by exactly the quiet drafts.
    const badge = await count();
    const { sent } = await (await approveAll()).json();
    expect(badge).toBe(3);
    expect(sent).toBe(badge);
  });
});

describe('the quiet draft on its own card', () => {
  beforeEach(() => hold({ id: 'quiet1', clientId: 'c9', reason: 'just_me_silent_draft' }));

  it('still sends when Ellie approves that one person herself', async () => {
    // "Just me" means Florrie never initiates. It does not mean Ellie cannot.
    const res = await approve('quiet1');
    expect(res.status).toBe(200);
    expect(delivered).toHaveLength(1);
    expect(delivered[0].clientId).toBe('c9');
  });
});

describe('a hold with no reason recorded at all', () => {
  beforeEach(() => hold({ id: 'o1', clientId: 'c1', reason: null }));

  it('is loud, exactly as the page shows it', async () => {
    // reason is nullable, and `reason <> 'x'` is NULL rather than true in SQL,
    // so a plain .neq() dropped these rows from the badge while the page
    // listed them as ordinary holds.
    expect(await count()).toBe(1);
    const { sent } = await (await approveAll()).json();
    expect(sent).toBe(1);
  });
});

describe('Ellie double taps approve on one offer', () => {
  beforeEach(() => hold({ id: 'o1', clientId: 'c1', reason: 'awaiting_approval' }));

  it('the client gets it once', async () => {
    await Promise.all([approve('o1'), approve('o1')]);
    expect(delivered).toHaveLength(1);
  });

  it('and the second tap is told it has already been handled', async () => {
    const [a, b] = await Promise.all([approve('o1'), approve('o1')]);
    const codes = [a.status, b.status].sort();
    expect(codes[0]).toBe(200);
    expect(codes[1]).toBe(404);
  });

  it('one after the other is the same answer', async () => {
    await approve('o1');
    const second = await approve('o1');
    expect(delivered).toHaveLength(1);
    expect(second.status).toBe(404);
    expect(row('o1').status).toBe('sent');
  });
});

describe('approve racing Send all', () => {
  beforeEach(() => {
    hold({ id: 'o1', clientId: 'c1', reason: 'awaiting_approval' });
    hold({ id: 'o2', clientId: 'c2', reason: 'awaiting_approval' });
  });

  it('nobody is messaged twice', async () => {
    await Promise.all([approve('o1'), approveAll()]);
    const perClient = delivered.reduce((acc, d) => ({ ...acc, [d.clientId]: (acc[d.clientId] || 0) + 1 }), {});
    expect(perClient).toEqual({ c1: 1, c2: 1 });
  });

  it('and the totals add up to the queue, not more than it', async () => {
    const [, allRes] = await Promise.all([approve('o1'), approveAll()]);
    const all = await allRes.json();
    expect(delivered).toHaveLength(2);
    expect(all.sent).toBeLessThanOrEqual(2);
  });
});

describe('a send that fails after the row has been claimed', () => {
  beforeEach(() => hold({ id: 'o1', clientId: 'c1', reason: 'awaiting_approval' }));

  it('does not leave the message stuck with no way to retry', async () => {
    sendOk = false;

    const res = await approve('o1');

    expect(res.status).toBe(400);
    expect(row('o1').status).toBe('pending_approval');
    expect(row('o1').decided_at).toBeNull();
  });

  it('so it is back in the queue and the badge counts it again', async () => {
    sendOk = false;
    await approve('o1');
    expect(await count()).toBe(1);
  });

  it('and the retry goes through', async () => {
    sendOk = false;
    await approve('o1');
    sendOk = true;

    const res = await approve('o1');

    expect(res.status).toBe(200);
    expect(row('o1').status).toBe('sent');
  });

  it('the same on Send all: a failure is counted and put back', async () => {
    sendOk = false;
    const { sent, failed } = await (await approveAll()).json();
    expect(sent).toBe(0);
    expect(failed).toBe(1);
    expect(row('o1').status).toBe('pending_approval');
  });
});

describe('the row a claim writes', () => {
  beforeEach(() => hold({ id: 'o1', clientId: 'c1', reason: 'awaiting_approval' }));

  it('only names columns outbound_sends actually has', async () => {
    // 066_outbound_guard.sql: decided_at, not resolved_at. The fake rejects an
    // unknown column the way PostgREST does, with 42703.
    const res = await approve('o1');
    expect(res.status).toBe(200);
    expect(row('o1').decided_at).toBeTruthy();
  });
});
