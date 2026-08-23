/**
 * A review request that is scheduled and never sent.
 *
 * scheduleReviewRequest() is called from routes/appointments.js the moment an
 * appointment is marked complete. It writes an ai_actions row and sets
 * `outcome: 'pending'`. processReviewRequests(), two hours later, asks for
 * `.eq('status', 'scheduled')`.
 *
 * status and outcome are two different axes. outcome is the RESULT of an
 * action (success / pending / failed / escalated). status is where the row
 * sits in a queue (scheduled / pending_approval / executed / dismissed). The
 * insert set one and the query filtered on the other, and in PostgREST
 * `.eq('status', 'scheduled')` does not match NULL, so the queue query matched
 * nothing, forever. Every completed appointment since the feature shipped has
 * written a row that is still sitting in ai_actions.
 *
 * The second half of the same bug only becomes reachable once the first is
 * fixed. The CHECK on ai_actions.outcome allows exactly four values and
 * 'skipped' is not one of them (001_initial_schema.sql:370, never widened).
 * Two of the three update paths wrote 'skipped', which raises 23514, so the
 * row would never leave 'scheduled' and the next run would pick it up and try
 * to send it again. Harmless while nothing was ever selected; an endless
 * re-send loop the moment rows start flowing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// The four values the CHECK constraint on ai_actions.outcome allows.
const ALLOWED_OUTCOMES = ['success', 'pending', 'failed', 'escalated'];

const db = { ai_actions: [], appointments: [] };
const inserted = [];
const updated = [];
let guardVerdict = { decision: 'send', delivered: true, tier: 'proactive', reason: 'trusted_auto' };

function builder(table) {
  const filters = [];
  let pending = null;
  const rows = () => (db[table] || []).filter(r => filters.every(f => f(r)));
  const settle = () => {
    if (pending?.op === 'insert') {
      const row = { id: `row_${inserted.length + 1}`, created_at: new Date().toISOString(), ...pending.payload };
      // Behave like the real constraint: reject an outcome outside the CHECK.
      if (row.outcome !== undefined && row.outcome !== null && !ALLOWED_OUTCOMES.includes(row.outcome)) {
        return { data: null, error: { code: '23514', message: 'new row violates check constraint "ai_actions_outcome_check"' } };
      }
      db[table].push(row);
      inserted.push({ table, payload: pending.payload });
      return { data: [row], error: null };
    }
    if (pending?.op === 'update') {
      const p = pending.payload;
      if (p.outcome !== undefined && p.outcome !== null && !ALLOWED_OUTCOMES.includes(p.outcome)) {
        updated.push({ table, payload: p, rejected: true });
        return { data: null, error: { code: '23514', message: 'new row violates check constraint "ai_actions_outcome_check"' } };
      }
      const hit = rows();
      for (const r of hit) Object.assign(r, p);
      updated.push({ table, payload: p, ids: hit.map(r => r.id) });
      return { data: hit, error: null };
    }
    return { data: rows(), error: null };
  };
  const b = {
    select() { return b; },
    insert(p) { pending = { op: 'insert', payload: p }; return b; },
    update(p) { pending = { op: 'update', payload: p }; return b; },
    eq(c, v) { filters.push(r => r[c] === v); return b; },
    gte(c, v) { filters.push(r => String(r[c] ?? '') >= v); return b; },
    lte(c, v) { filters.push(r => String(r[c] ?? '') <= v); return b; },
    // details->>send_at, the JSON arrow form PostgREST accepts.
    limit() { return b; },
    maybeSingle() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    single() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    then(res, rej) { return Promise.resolve(settle()).then(res, rej); },
  };
  return b;
}

vi.mock('../../src/config.js', () => ({ supabase: { from: builder } }));
vi.mock('../../src/lib/outbound-guard.js', () => ({
  guardedSend: async ({ send }) => {
    if (guardVerdict.decision === 'send') await send();
    return guardVerdict;
  },
}));
vi.mock('../../src/services/notifications.js', () => ({
  sendMessage: async () => ({ channel: 'sms' }),
  sendEmail: async () => true,
}));

const { scheduleReviewRequest, processReviewRequests } =
  await import('../../src/services/review-requests.js');

beforeEach(() => {
  db.ai_actions = [];
  db.appointments = [];
  inserted.length = 0;
  updated.length = 0;
  guardVerdict = { decision: 'send', delivered: true, tier: 'proactive', reason: 'trusted_auto' };
});

describe('scheduling a review request', () => {
  it('puts the row IN the queue, by setting status', async () => {
    await scheduleReviewRequest('b1', 'appt1', 'c1');

    const row = inserted.find(i => i.table === 'ai_actions')?.payload;
    expect(row).toBeTruthy();
    // The assertion the bug is made of. Without this the row is invisible to
    // the only thing that would ever send it.
    expect(row.status).toBe('scheduled');
  });

  it('still records the outcome separately, because they are different axes', async () => {
    await scheduleReviewRequest('b1', 'appt1', 'c1');
    const row = inserted.find(i => i.table === 'ai_actions')?.payload;
    expect(row.outcome).toBe('pending');
    expect(ALLOWED_OUTCOMES).toContain(row.outcome);
  });
});

describe('the round trip: what is written is what is read back', () => {
  it('processReviewRequests finds the row scheduleReviewRequest just wrote', async () => {
    db.appointments.push({
      id: 'appt1', beautician_id: 'b1',
      clients: { id: 'c1', first_name: 'Shauna', phone: '+447700900000', preferred_channel: 'sms' },
      treatments: { name: 'brow lamination' },
      beauticians: { first_name: 'Ellie', business_name: 'Ellindigo' },
    });

    await scheduleReviewRequest('b1', 'appt1', 'c1');
    // The row is due: send_at is two hours out, so pretend two hours passed.
    db.ai_actions[0].details.send_at = new Date(Date.now() - 60_000).toISOString();

    const result = await processReviewRequests();

    expect(result.sent).toBe(1);
  });
});

describe('every outcome written is one the constraint allows', () => {
  it('does not write "skipped" when the gate holds the send', async () => {
    db.appointments.push({
      id: 'appt1', beautician_id: 'b1',
      clients: { id: 'c1', first_name: 'Shauna', phone: '+447700900000' },
      treatments: { name: 'brow lamination' },
      beauticians: { first_name: 'Ellie' },
    });
    guardVerdict = { decision: 'block', delivered: false, tier: 'proactive', reason: 'frequency_cap' };

    await scheduleReviewRequest('b1', 'appt1', 'c1');
    db.ai_actions[0].details.send_at = new Date(Date.now() - 60_000).toISOString();
    await processReviewRequests();

    const rejected = updated.filter(u => u.rejected);
    expect(rejected).toHaveLength(0);
    for (const u of updated) {
      if (u.payload.outcome !== undefined) expect(ALLOWED_OUTCOMES).toContain(u.payload.outcome);
    }
  });

  it('and having written a real outcome, the row leaves the queue instead of looping', async () => {
    db.appointments.push({
      id: 'appt1', beautician_id: 'b1',
      clients: { id: 'c1', first_name: 'Shauna', phone: '+447700900000' },
      treatments: { name: 'brow lamination' },
      beauticians: { first_name: 'Ellie' },
    });
    guardVerdict = { decision: 'block', delivered: false, tier: 'proactive', reason: 'frequency_cap' };

    await scheduleReviewRequest('b1', 'appt1', 'c1');
    db.ai_actions[0].details.send_at = new Date(Date.now() - 60_000).toISOString();
    await processReviewRequests();

    // Not still 'scheduled'. If the update had been rejected by the CHECK this
    // row would be picked up again on the next pass, and the one after that.
    expect(db.ai_actions[0].status).toBe('executed');
  });
});
