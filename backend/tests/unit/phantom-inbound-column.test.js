/**
 * One column that does not exist, three features that never ran.
 *
 * `clients.last_whatsapp_inbound_at` appears in no migration in
 * supabase/migrations and never has. It appeared in three selects:
 *
 *   autonomous-scheduler.js  the pre-appointment requirements reminder
 *   autonomous-scheduler.js  the rebook-due nudge
 *   predictive-nudge.js      the predicted-visit nudge
 *
 * PostgREST does not skip a column it does not recognise. It rejects the
 * ENTIRE select with 42703, so `data` comes back null and `error` carries the
 * reason. Every one of these three discarded the error, and null reads exactly
 * like "nobody matched". Three engines that report a quiet week, every run,
 * for as long as the column has been named.
 *
 * The worst of the three is the pre-appointment reminder, which is why it is
 * the one driven end to end here. A first-time client books a lash lift for
 * Thursday. She needs a patch test at least 24 hours before, or she cannot be
 * treated, and if she is treated anyway she is the one who finds out why the
 * rule exists. The reminder that tells her goes out 24 to 72 hours ahead. It
 * has never gone out.
 *
 * The column was only ever carried so sendNudge could decide whether the 24h
 * WhatsApp window was open. That question is answered from the messages table
 * now (see whatsapp-session-window.test.js), so nothing needs it here.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Columns confirmed absent from every file in supabase/migrations. The fake
// below rejects any select naming one, exactly as PostgREST does, rather than
// quietly returning the other columns.
const PHANTOM_COLUMNS = ['last_whatsapp_inbound_at'];

const db = {
  beauticians: [], clients: [], appointments: [], treatments: [],
  patch_tests: [], consultation_responses: [], ai_actions: [],
};
const rejectedSelects = [];

/** Pull every leaf column name out of a PostgREST select, embeds included. */
function leafColumns(cols) {
  return String(cols)
    .replace(/[()]/g, ',')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
}

function builder(table) {
  const filters = [];
  let pending = null;
  let head = false;
  let rejected = null;
  const rows = () => (db[table] || []).filter(r => filters.every(f => f(r)));
  const settle = () => {
    if (rejected) return { data: null, error: rejected, count: null };
    if (head) return { data: null, error: null, count: rows().length };
    if (pending?.op === 'insert') {
      db[table].push({ id: `${table}_${db[table].length + 1}`, created_at: new Date().toISOString(), ...pending.payload });
      return { data: [], error: null };
    }
    if (pending?.op === 'update') { for (const r of rows()) Object.assign(r, pending.payload); return { data: rows(), error: null }; }
    return { data: rows(), error: null };
  };
  const b = {
    select(cols, opts) {
      if (opts?.head) head = true;
      const bad = leafColumns(cols).find(c => PHANTOM_COLUMNS.includes(c));
      if (bad) {
        rejected = { code: '42703', message: `column ${table}.${bad} does not exist` };
        rejectedSelects.push({ table, column: bad });
      }
      return b;
    },
    insert(p) { pending = { op: 'insert', payload: p }; return b; },
    update(p) { pending = { op: 'update', payload: p }; return b; },
    eq(c, v) { filters.push(r => r[c] === v); return b; },
    neq(c, v) { filters.push(r => r[c] !== v); return b; },
    in(c, v) { filters.push(r => v.includes(r[c])); return b; },
    is(c, v) { filters.push(r => (r[c] ?? null) === v); return b; },
    not(c, _op, v) { filters.push(r => (r[c] ?? null) !== v); return b; },
    gte(c, v) { filters.push(r => String(r[c] ?? '') >= String(v)); return b; },
    lte(c, v) { filters.push(r => String(r[c] ?? '') <= String(v)); return b; },
    gt() { return b; }, lt() { return b; }, or() { return b; },
    order() { return b; }, limit() { return b; },
    maybeSingle() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    single() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    then(res, rej) { return Promise.resolve(settle()).then(res, rej); },
  };
  return b;
}

vi.mock('../../src/config.js', () => ({ supabase: { from: builder } }));

const nudges = [];
vi.mock('../../src/services/notifications.js', () => ({
  sendNudge: async (args) => { nudges.push(args); return { channel: 'whatsapp_freeform' }; },
}));
vi.mock('../../src/lib/outbound-guard.js', () => ({
  guardedSend: async ({ send, ...rest }) => {
    const ok = !!(await send());
    return { decision: 'send', tier: 'transactional', reason: 'transactional', delivered: ok, ...(rest.__never ? rest : {}) };
  },
}));
// Everything else runAutonomousCycle touches, stubbed out. This test is about
// one query in one function.
vi.mock('../../src/services/client-intelligence.js', () => ({ refreshAllIntelligence: async () => 0 }));
vi.mock('../../src/services/content-autopilot.js', () => ({ draftAvailabilityPost: async () => ({}) }));
vi.mock('../../src/services/ai-front-desk.js', () => ({ processInboundMessage: async () => ({}) }));
vi.mock('../../src/services/sms-metering.js', () => ({ shouldAutoSend: async () => ({ shouldSend: true }) }));
vi.mock('../../src/services/value-coaching.js', () => ({ runValueCoaching: async () => ({}) }));
vi.mock('../../src/services/review-requests.js', () => ({ processReviewRequests: async () => ({ sent: 0 }) }));
vi.mock('../../src/services/push-notifications.js', () => ({ pushTeamUpdate: async () => true }));
vi.mock('../../src/services/gap-fill-engine.js', () => ({ checkGapFillOpportunities: async () => ({ matched: 0 }) }));

const { runAutonomousCycle } = await import('../../src/services/autonomous-scheduler.js');

const inHours = (h) => new Date(Date.now() + h * 60 * 60 * 1000).toISOString();

beforeEach(() => {
  for (const t of Object.keys(db)) db[t] = [];
  nudges.length = 0;
  rejectedSelects.length = 0;

  db.beauticians.push({
    id: 'b1', first_name: 'Ellie', confidence_threshold: 0.9, auto_reply_enabled: true,
    subscription_plan: 'pro', tone_model: {}, autonomy: {}, booking_slug: 'ellindigo',
    patch_test_auto_remind: true, patch_test_remind_days_before: 7, patch_test_expiry_months: 6,
    whatsapp_phone_id: 'wa1', client_reminder_prefs: {}, phone: '+447700900001',
    working_hours: null,
  });
});

describe('the first-time client booked in for a lash lift on Thursday', () => {
  beforeEach(() => {
    db.clients.push({
      id: 'c1', beautician_id: 'b1', first_name: 'Nadia', last_name: 'Okafor',
      phone: '+447700900002', whatsapp_id: '447700900002', email: 'nadia@example.com',
      imported_from: null, status: 'active', next_expected_visit: null,
    });
    db.appointments.push({
      id: 'a1', beautician_id: 'b1', client_id: 'c1', status: 'confirmed',
      starts_at: inHours(48), management_token: 'tok-1',
      treatments: { name: 'lash lift', requires_patch_test: true, requires_consultation: false },
      clients: {
        id: 'c1', first_name: 'Nadia', last_name: 'Okafor', phone: '+447700900002',
        whatsapp_id: '447700900002', email: 'nadia@example.com', imported_from: null,
      },
    });
    // No patch test on file. Nothing booked. She has never been before.
  });

  it('is told she needs a patch test first', async () => {
    await runAutonomousCycle();

    expect(nudges).toHaveLength(1);
    expect(nudges[0].body).toMatch(/patch test/i);
    expect(nudges[0].body).toContain('Nadia');
  });

  it('is given the link to book it', async () => {
    await runAutonomousCycle();
    expect(nudges[0].body).toContain('/manage/tok-1?book=patch');
  });

  it('and no select in that path was rejected for naming a column that does not exist', async () => {
    await runAutonomousCycle();
    expect(rejectedSelects).toEqual([]);
  });
});

describe('the clients who should still be left alone', () => {
  it('a client imported from her old system is not chased', async () => {
    db.appointments.push({
      id: 'a1', beautician_id: 'b1', client_id: 'c1', status: 'confirmed',
      starts_at: inHours(48), management_token: 'tok-1',
      treatments: { name: 'lash lift', requires_patch_test: true, requires_consultation: false },
      clients: { id: 'c1', first_name: 'Jo', phone: '+447700900003', imported_from: 'timely' },
    });

    await runAutonomousCycle();
    expect(nudges).toHaveLength(0);
  });

  it('a client with a valid patch test already on file is not chased', async () => {
    db.appointments.push({
      id: 'a1', beautician_id: 'b1', client_id: 'c2', status: 'confirmed',
      starts_at: inHours(48), management_token: 'tok-2',
      treatments: { name: 'lash lift', requires_patch_test: true, requires_consultation: false },
      clients: { id: 'c2', first_name: 'Priya', phone: '+447700900004', imported_from: null },
    });
    db.patch_tests.push({
      id: 'pt1', client_id: 'c2', beautician_id: 'b1', status: 'passed', result: 'pass',
      test_date: new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10), confirmed_at: null,
    });

    await runAutonomousCycle();
    expect(nudges).toHaveLength(0);
  });

  it('an appointment further out than 72 hours waits its turn', async () => {
    db.appointments.push({
      id: 'a1', beautician_id: 'b1', client_id: 'c3', status: 'confirmed',
      starts_at: inHours(24 * 10), management_token: 'tok-3',
      treatments: { name: 'lash lift', requires_patch_test: true, requires_consultation: false },
      clients: { id: 'c3', first_name: 'Marie', phone: '+447700900005', imported_from: null },
    });

    await runAutonomousCycle();
    expect(nudges).toHaveLength(0);
  });
});
