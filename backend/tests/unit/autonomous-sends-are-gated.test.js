/**
 * Two senders that walked straight past the gate.
 *
 * lib/outbound-guard.js is the one place that decides whether Florrie may
 * speak to a client at all. It applies consent, the per-client autonomy
 * override (clients.messaging_autonomy: florrie / drafts / just_me), marketing
 * quiet hours, the cross-engine frequency cap, the monthly per-client cap, the
 * allowance reserve kept back for transactional sends, and the trust dial. It
 * also writes the outbound_sends row that every one of those caps reads from,
 * so a send that skips the gate is invisible to every OTHER engine's cap too.
 *
 * checkRebookDueClients in this file had always gone through guardedSend.
 * checkPatchTestsExpiring and checkPreAppointmentRequirements, in the same
 * file, called sendNudge directly. A client set to 'just me' got the text. A
 * client already messaged three times this week got the text. A client for
 * whom it was eleven at night got the text.
 *
 * WHY THE TWO ARE CLASSIFIED DIFFERENTLY, and it is deliberate:
 *
 *   patch_test_reminder (expiry)  PROACTIVE. Nobody asked for it. Florrie
 *     noticed a date and reached out. Full consent, caps and dial apply, and
 *     on the default 'ask' dial it waits in Ellie's outbox.
 *
 *   patch_test / consultation_form (pre-arrival)  TRANSACTIONAL, and already
 *     named as such in the guard's own list. It is about a booking this client
 *     has already made, in the next 24 to 72 hours, and it tells her the one
 *     thing she must do first. Holding it for approval could mean she arrives
 *     for a lash lift she cannot legally be given. It still goes THROUGH the
 *     gate, so it is recorded and so it obeys any future reclassification;
 *     the gate simply says yes.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const db = {
  beauticians: [], clients: [], appointments: [], patch_tests: [],
  consultation_responses: [], ai_actions: [],
};

function builder(table) {
  const filters = [];
  let pending = null;
  let head = false;
  const rows = () => (db[table] || []).filter(r => filters.every(f => f(r)));
  const settle = () => {
    if (head) return { data: null, error: null, count: rows().length };
    if (pending?.op === 'insert') { db[table].push({ id: `${table}_${db[table].length + 1}`, ...pending.payload }); return { data: [], error: null }; }
    if (pending?.op === 'update') { for (const r of rows()) Object.assign(r, pending.payload); return { data: rows(), error: null }; }
    return { data: rows(), error: null };
  };
  const b = {
    select(_c, o) { if (o?.head) head = true; return b; },
    insert(p) { pending = { op: 'insert', payload: p }; return b; },
    update(p) { pending = { op: 'update', payload: p }; return b; },
    eq(c, v) { filters.push(r => r[c] === v); return b; },
    neq(c, v) { filters.push(r => r[c] !== v); return b; },
    in(c, v) { filters.push(r => v.includes(r[c])); return b; },
    is(c, v) { filters.push(r => (r[c] ?? null) === v); return b; },
    not(c, _o, v) { filters.push(r => (r[c] ?? null) !== v); return b; },
    gte(c, v) { filters.push(r => String(r[c] ?? '') >= String(v)); return b; },
    lte(c, v) { filters.push(r => String(r[c] ?? '') <= String(v)); return b; },
    gt() { return b; }, lt() { return b; }, or() { return b; },
    like() { return b; }, order() { return b; }, limit() { return b; },
    maybeSingle() { return Promise.resolve({ data: rows()[0] || null, error: null }); },
    single() { return Promise.resolve({ data: rows()[0] || null, error: null }); },
    then(res, rej) { return Promise.resolve(settle()).then(res, rej); },
  };
  return b;
}

vi.mock('../../src/config.js', () => ({ supabase: { from: builder } }));

// Every actual delivery. If a name shows up here without a matching entry in
// `gateCalls`, something sent a message without asking permission first.
const delivered = [];
vi.mock('../../src/services/notifications.js', () => ({
  sendNudge: async (args) => { delivered.push(args); return { channel: 'sms' }; },
}));

const gateCalls = [];
let verdict = { decision: 'send', tier: 'transactional', reason: 'transactional' };
vi.mock('../../src/lib/outbound-guard.js', () => ({
  guardedSend: async ({ send, ...args }) => {
    gateCalls.push(args);
    if (verdict.decision !== 'send') return { ...verdict, delivered: false };
    const ok = !!(await send());
    return { ...verdict, delivered: ok };
  },
}));
vi.mock('../../src/services/client-intelligence.js', () => ({ refreshAllIntelligence: async () => 0 }));
vi.mock('../../src/services/content-autopilot.js', () => ({ draftAvailabilityPost: async () => ({}) }));
vi.mock('../../src/services/ai-front-desk.js', () => ({ processInboundMessage: async () => ({}) }));
vi.mock('../../src/services/sms-metering.js', () => ({ shouldAutoSend: async () => ({ shouldSend: true }) }));
vi.mock('../../src/services/value-coaching.js', () => ({ runValueCoaching: async () => ({}) }));
vi.mock('../../src/services/review-requests.js', () => ({ processReviewRequests: async () => ({ sent: 0 }) }));
vi.mock('../../src/services/push-notifications.js', () => ({ pushTeamUpdate: async () => true }));
vi.mock('../../src/services/gap-fill-engine.js', () => ({ checkGapFillOpportunities: async () => ({ matched: 0 }) }));

const { runAutonomousCycle } = await import('../../src/services/autonomous-scheduler.js');

const inHours = h => new Date(Date.now() + h * 3600_000).toISOString();

/**
 * The exact test_date the expiry sweep is looking for, computed the way the
 * sweep computes it: seven days from now is the far edge of the reminder
 * window, and a test expires six months after it was taken, so a test taken
 * (now + 7 days - 6 months) expires on the last day of the window.
 */
function expiringTestDate() {
  const windowEnd = new Date(Date.now() + 7 * 86400_000);
  windowEnd.setMonth(windowEnd.getMonth() - 6);
  return windowEnd.toISOString().slice(0, 10);
}

beforeEach(() => {
  for (const t of Object.keys(db)) db[t] = [];
  delivered.length = 0;
  gateCalls.length = 0;
  verdict = { decision: 'send', tier: 'transactional', reason: 'transactional' };
  db.beauticians.push({
    id: 'b1', first_name: 'Ellie', confidence_threshold: 0.9, auto_reply_enabled: true,
    subscription_plan: 'pro', tone_model: {}, autonomy: {}, booking_slug: 'ellindigo',
    patch_test_auto_remind: true, patch_test_remind_days_before: 7, patch_test_expiry_months: 6,
    whatsapp_phone_id: 'wa1', client_reminder_prefs: {}, phone: '+447700900001',
    working_hours: null,
  });
});

/** A patch test taken 6 months minus 5 days ago, so it expires this week. */
function expiringPatchTest() {
  db.patch_tests.push({
    id: 'pt1', beautician_id: 'b1', client_id: 'c9', result: 'pass',
    test_date: expiringTestDate(),
    clients: { id: 'c9', first_name: 'Rhiannon', last_name: 'Pryce', phone: '+447700900009', whatsapp_id: '447700900009', email: 'r@example.com' },
  });
}

function preArrivalAppointment() {
  db.appointments.push({
    id: 'a1', beautician_id: 'b1', client_id: 'c1', status: 'confirmed',
    starts_at: inHours(48), management_token: 'tok-1',
    treatments: { name: 'lash lift', requires_patch_test: true, requires_consultation: false },
    clients: { id: 'c1', first_name: 'Nadia', phone: '+447700900002', whatsapp_id: '447700900002', email: 'n@example.com', imported_from: null },
  });
}

describe('the patch-test expiry reminder', () => {
  it('asks the gate before it sends', async () => {
    expiringPatchTest();
    await runAutonomousCycle();

    const call = gateCalls.find(c => c.messageType === 'patch_test_reminder');
    expect(call).toBeTruthy();
    expect(call.clientId).toBe('c9');
    expect(call.body).toMatch(/patch test/i);
  });

  it('is classified proactive, so the caps and the dial actually apply to it', async () => {
    // Against the guard's REAL classifier, not a copy of its list, so this
    // test moves if somebody reclassifies the type.
    const { classifyTier } = await vi.importActual('../../src/lib/outbound-guard.js');
    expect(classifyTier('patch_test_reminder')).toBe('proactive');
  });

  it('and when the gate says no, nothing is sent', async () => {
    expiringPatchTest();
    verdict = { decision: 'block', tier: 'proactive', reason: 'frequency_cap' };

    await runAutonomousCycle();

    expect(gateCalls.some(c => c.messageType === 'patch_test_reminder')).toBe(true);
    expect(delivered).toHaveLength(0);
  });

  it('and when the gate holds it for approval, nothing is sent either', async () => {
    expiringPatchTest();
    verdict = { decision: 'approve', tier: 'proactive', reason: 'just_me_silent_draft' };

    await runAutonomousCycle();

    expect(delivered).toHaveLength(0);
  });
});

describe('the pre-appointment requirements reminder', () => {
  it('asks the gate before it sends', async () => {
    preArrivalAppointment();
    await runAutonomousCycle();

    const call = gateCalls.find(c => c.messageType === 'patch_test');
    expect(call).toBeTruthy();
    expect(call.clientId).toBe('c1');
  });

  it('is classified transactional, so a safety message is not queued behind an approval', async () => {
    const { classifyTier } = await vi.importActual('../../src/lib/outbound-guard.js');
    expect(classifyTier('patch_test')).toBe('transactional');
    expect(classifyTier('consultation_form')).toBe('transactional');
  });

  it('names itself consultation_form when that is what the message is about', async () => {
    db.appointments.push({
      id: 'a2', beautician_id: 'b1', client_id: 'c2', status: 'confirmed',
      starts_at: inHours(48), management_token: 'tok-2',
      treatments: { name: 'microblading', requires_patch_test: false, requires_consultation: true },
      clients: { id: 'c2', first_name: 'Aoife', phone: '+447700900003', imported_from: null },
    });
    db.consultation_responses.push({ id: 'f1', client_id: 'c2', beautician_id: 'b1', status: 'pending', token: 'formtok', form_url: null });

    await runAutonomousCycle();

    expect(gateCalls.find(c => c.messageType === 'consultation_form')).toBeTruthy();
  });

  it('and when the gate says no, nothing is sent and nothing is logged as sent', async () => {
    preArrivalAppointment();
    verdict = { decision: 'block', tier: 'transactional', reason: 'error_failsafe' };

    await runAutonomousCycle();

    expect(delivered).toHaveLength(0);
    expect(db.ai_actions.filter(a => a.action_type === 'prearrival_reminder')).toHaveLength(0);
  });
});

describe('nothing in this file sends without asking', () => {
  it('every delivery has a gate decision behind it', async () => {
    expiringPatchTest();
    preArrivalAppointment();

    await runAutonomousCycle();

    expect(delivered.length).toBeGreaterThan(0);
    expect(gateCalls.length).toBe(delivered.length);
  });

  it('and sendNudge is never called outside a guardedSend in the source', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../src/services/autonomous-scheduler.js', import.meta.url).pathname, 'utf8');

    // Every sendNudge( in this file must sit inside a send: async () => { ... }
    // block belonging to a guardedSend call. Counting is enough to catch a
    // regression: one guardedSend per sendNudge, no more and no fewer.
    const sends = (src.match(/await sendNudge\(/g) || []).length;
    const guards = (src.match(/await guardedSend\(/g) || []).length;
    expect(sends).toBeGreaterThan(0);
    expect(guards).toBe(sends);
  });
});
