/**
 * Three settings pages wired to nothing, and two loaded guns.
 *
 * services/automations.js exported five processors. None of them appeared in
 * any job in jobs/register.js, which registers twenty-one, and nothing
 * imported them: the only import anywhere in the tree is createBookingSuggestion,
 * from ai-front-desk.js, which is a different function on a different path.
 *
 * So Ellie could fill in the Aftercare page, tap "Send rebook reminder in 4
 * weeks" on a finished appointment, and build a multi-step follow-up sequence,
 * and no process on earth would ever read any of it back. Forms that save and
 * do nothing.
 *
 * Wiring all five up would have been worse than leaving them dead. Two are
 * gone:
 *
 *   processReviewRequests   an ungated second implementation of what
 *     services/review-requests.js already does, gated and deduped, on a call
 *     path that is already registered. Registering it means every client is
 *     asked twice.
 *
 *   processAutomationRules  reads `rule.config`; the columns are
 *     trigger_config and action_config. Branches on trigger types that the
 *     CHECK constraint in 007_all_features.sql forbids, so no such row can
 *     exist. AutomationRules.jsx inserts seven columns that do not exist, so
 *     no rule can be created at all. Its send_message action would therefore
 *     always have fallen through to a hardcoded "Hey {name}, just a quick
 *     message from {business}!" and sent it, ungated, to every client the
 *     trigger matched.
 *
 * The three that remain are registered, and every one of them now sends
 * underneath guardedSend.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

const db = {
  aftercare_messages: [], aftercare_sends: [], appointments: [],
  rebook_reminders: [], follow_up_sequences: [], follow_up_enrollments: [],
  clients: [], beauticians: [],
};
const writes = [];

// aftercare_messages as 007_all_features.sql actually defines it. `message_text`
// and `timing_days`, which the old code read, are in no migration, so anything
// naming them here comes back undefined exactly as it did in production.
const AFTERCARE_COLUMNS = [
  'id', 'beautician_id', 'treatment_id', 'name', 'message',
  'send_after_hours', 'channel', 'is_active', 'created_at', 'updated_at',
];

function builder(table) {
  const filters = [];
  let pending = null;
  const rows = () => (db[table] || []).filter(r => filters.every(f => f(r)));
  const settle = () => {
    if (pending?.op === 'insert') {
      db[table].push({ id: `${table}_${db[table].length + 1}`, ...pending.payload });
      writes.push({ table, op: 'insert', payload: pending.payload });
      return { data: [], error: null };
    }
    if (pending?.op === 'update') {
      const hit = rows();
      for (const r of hit) Object.assign(r, pending.payload);
      writes.push({ table, op: 'update', payload: pending.payload, ids: hit.map(r => r.id) });
      return { data: hit, error: null };
    }
    return { data: rows(), error: null };
  };
  const b = {
    select() { return b; },
    insert(p) { pending = { op: 'insert', payload: p }; return b; },
    update(p) { pending = { op: 'update', payload: p }; return b; },
    eq(c, v) { filters.push(r => r[c] === v); return b; },
    in(c, v) { filters.push(r => v.includes(r[c])); return b; },
    is(c, v) { filters.push(r => (r[c] ?? null) === v); return b; },
    not(c, _o, v) { filters.push(r => (r[c] ?? null) !== v); return b; },
    gte(c, v) { filters.push(r => String(r[c] ?? '') >= String(v)); return b; },
    lte(c, v) { filters.push(r => String(r[c] ?? '') <= String(v)); return b; },
    neq() { return b; }, gt() { return b; }, lt() { return b; }, or() { return b; },
    order() { return b; }, limit() { return b; },
    maybeSingle() { return Promise.resolve({ data: rows()[0] || null, error: null }); },
    single() { return Promise.resolve({ data: rows()[0] || null, error: null }); },
    then(res, rej) { return Promise.resolve(settle()).then(res, rej); },
  };
  return b;
}

vi.mock('../../src/config.js', () => ({ supabase: { from: builder } }));

const gateCalls = [];
let verdict = { decision: 'send', tier: 'proactive', reason: 'trusted_auto' };
vi.mock('../../src/lib/outbound-guard.js', () => ({
  guardedSend: async ({ send, ...args }) => {
    gateCalls.push(args);
    if (verdict.decision !== 'send') return { ...verdict, delivered: false };
    return { ...verdict, delivered: !!(await send()) };
  },
}));
const sentSms = [];
// Partial mock: jobs/register.js pulls processReminders and friends from the
// same module, and this test asserts on the real JOBS list.
vi.mock('../../src/services/notifications.js', async (importOriginal) => ({
  ...(await importOriginal()),
  sendSMS: async (a) => { sentSms.push(a); return { id: 'sms1' }; },
  sendWhatsApp: async (a) => { sentSms.push(a); return { id: 'wa1' }; },
  sendEmail: async () => true,
}));
vi.mock('../../src/services/sms-metering.js', () => ({ shouldAutoSend: async () => ({ shouldSend: true }) }));
vi.mock('../../src/services/loyalty.js', () => ({
  getLoyaltyConfig: async () => null, getClientPoints: async () => 0, loyaltyProximity: () => null,
}));

const automations = await import('../../src/services/automations.js');
const { JOBS } = await import('../../src/jobs/register.js');

const SRC = new URL('../../src/services/automations.js', import.meta.url).pathname;
const source = readFileSync(SRC, 'utf8');
// The file explains at length what was removed and why, so a bare substring
// search would match the explanation. Only CODE counts.
const code = source
  .split('\n')
  .filter(l => { const t = l.trimStart(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*'); })
  .join('\n');

const beautician = { id: 'b1', business_name: 'Ellindigo', first_name: 'Ellie', client_reminder_prefs: { channel: 'sms' }, booking_slug: 'ellindigo' };
const client = { id: 'c1', first_name: 'Shauna', phone: '+447700900007', email: 's@example.com' };
const minsAgo = m => new Date(Date.now() - m * 60_000).toISOString();

beforeEach(() => {
  for (const t of Object.keys(db)) db[t] = [];
  writes.length = 0;
  gateCalls.length = 0;
  sentSms.length = 0;
  verdict = { decision: 'send', tier: 'proactive', reason: 'trusted_auto' };
});

describe('what is registered', () => {
  const named = n => JOBS.find(j => j.name === n);

  it('runs the aftercare follow-ups', () => {
    expect(named('aftercare-followups')?.handler).toBe(automations.processAftercareFollowups);
  });

  it('runs the rebook reminder queue Ellie fills from the diary', () => {
    expect(named('rebook-reminder-queue')?.handler).toBe(automations.processRebookNudges);
  });

  it('runs the follow-up sequences', () => {
    expect(named('follow-up-sequences')?.handler).toBe(automations.processFollowUpSequences);
  });

  it('runs all three hourly, because each looks at a one-hour window', () => {
    for (const n of ['aftercare-followups', 'rebook-reminder-queue', 'follow-up-sequences']) {
      expect(named(n).intervalMs).toBe(60 * 60 * 1000);
    }
  });

  it('and every job in the list still has a handler that exists', () => {
    for (const job of JOBS) expect(typeof job.handler).toBe('function');
  });
});

describe('what is deleted', () => {
  it('exports no second review-request processor', () => {
    expect(automations.processReviewRequests).toBeUndefined();
  });

  it('exports no automation rules engine', () => {
    expect(automations.processAutomationRules).toBeUndefined();
  });

  it('and the placeholder message that engine would have sent is gone from the file', () => {
    expect(code).not.toContain('just a quick message from');
  });

  it('and nothing in the file reads rule.config, the column that never was', () => {
    expect(code).not.toMatch(/rule\.config/);
  });

  it('and the phantom booking_page_url is gone with it', () => {
    expect(code).not.toContain('booking_page_url');
  });
});

describe('aftercare follow-ups', () => {
  beforeEach(() => {
    db.aftercare_messages.push({
      id: 'ac1', beautician_id: 'b1', treatment_id: 't1', name: 'Lash aftercare',
      message: 'Hey {name}, keep them dry for 24h!', send_after_hours: 24, is_active: true,
      beauticians: beautician,
    });
    db.appointments.push({
      id: 'a1', beautician_id: 'b1', client_id: 'c1', treatment_id: 't1', status: 'completed',
      ends_at: new Date(Date.now() - 24.5 * 3600_000).toISOString(),
      clients: client,
    });
  });

  it('reads the columns that exist, and sends', async () => {
    const result = await automations.processAftercareFollowups();
    expect(result.sent).toBe(1);
    expect(gateCalls[0].body).toContain('keep them dry');
  });

  it('names only real columns of aftercare_messages', () => {
    const select = code.match(/from\('aftercare_messages'\)\s*\.select\('([^']+)'/)?.[1] || '';
    expect(select).toBeTruthy();
    const named = select
      .replace(/\w+\([^)]*\)/g, '')   // drop embedded joins, e.g. beauticians(...)
      .split(',').map(s => s.trim()).filter(Boolean);
    expect(named.length).toBeGreaterThan(0);
    for (const c of named) expect(AFTERCARE_COLUMNS).toContain(c);
  });

  it('goes through the gate', async () => {
    await automations.processAftercareFollowups();
    expect(gateCalls).toHaveLength(1);
    expect(gateCalls[0].messageType).toBe('aftercare_followup');
  });

  it('and when the gate holds it, the dedup row is NOT written', async () => {
    // aftercare_sends is the "already sent" key. Writing it for a send that
    // never happened would suppress this message for this appointment forever.
    verdict = { decision: 'approve', tier: 'proactive', reason: 'awaiting_approval' };

    const result = await automations.processAftercareFollowups();

    expect(result.sent).toBe(0);
    expect(writes.filter(w => w.table === 'aftercare_sends')).toHaveLength(0);
  });

  it('does not chase a booking still marked confirmed an hour after it ended', async () => {
    db.appointments[0].status = 'confirmed';
    const result = await automations.processAftercareFollowups();
    expect(result.sent).toBe(0);
  });
});

describe('the rebook reminder queue', () => {
  beforeEach(() => {
    db.rebook_reminders.push({
      id: 'r1', beautician_id: 'b1', client_id: 'c1', appointment_id: 'a1',
      reminder_date: new Date(Date.now() - 86400_000).toISOString().slice(0, 10),
      message: 'Time to rebook Shauna for their brow lamination.',
      sent: false, clients: client, beauticians: beautician,
    });
  });

  it('sends the client a message written for the client', async () => {
    const result = await automations.processRebookNudges();

    expect(result.sent).toBe(1);
    // The `message` column holds a note Ellie wrote to HERSELF from the diary
    // screen. Texting that sentence to Shauna is the thing this must not do.
    expect(gateCalls[0].body).not.toContain('Time to rebook');
    expect(gateCalls[0].body).toContain('{name}');
    expect(gateCalls[0].body).toContain('florrie.ai/book/ellindigo');
  });

  it('goes through the gate', async () => {
    await automations.processRebookNudges();
    expect(gateCalls[0].messageType).toBe('rebook_nudge');
    expect(gateCalls[0].clientId).toBe('c1');
  });

  it('marks the row done so it is not retried hourly forever', async () => {
    await automations.processRebookNudges();
    expect(db.rebook_reminders[0].sent).toBe(true);
  });

  it('retires the row even when the gate blocks it', async () => {
    verdict = { decision: 'block', tier: 'proactive', reason: 'opted_out' };
    const result = await automations.processRebookNudges();
    expect(result.sent).toBe(0);
    expect(db.rebook_reminders[0].sent).toBe(true);
  });

  it('leaves a reminder that is not due yet alone', async () => {
    db.rebook_reminders[0].reminder_date = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 10);
    const result = await automations.processRebookNudges();
    expect(result.sent).toBe(0);
    expect(gateCalls).toHaveLength(0);
  });
});

describe('follow-up sequences', () => {
  beforeEach(() => {
    db.follow_up_sequences.push({
      id: 's1', beautician_id: 'b1', name: 'Lash lift chain', trigger: 'after-appointment',
      treatments: [], active: true,
      steps: [{ delay: '0h', channel: 'sms', message: 'Step one, {name}' }, { delay: '3d', channel: 'sms', message: 'Step two, {name}' }],
    });
  });

  it('enrols an appointment that has just been completed', async () => {
    db.appointments.push({
      id: 'a1', beautician_id: 'b1', client_id: 'c1', treatment_id: 't1', status: 'completed',
      ends_at: minsAgo(10), treatments: { name: 'lash lift' },
    });

    const result = await automations.processFollowUpSequences();

    expect(result.enrolled).toBe(1);
  });

  it('does not enrol a booking still marked confirmed', async () => {
    db.appointments.push({
      id: 'a1', beautician_id: 'b1', client_id: 'c1', treatment_id: 't1', status: 'confirmed',
      ends_at: minsAgo(10), treatments: { name: 'lash lift' },
    });

    const result = await automations.processFollowUpSequences();

    expect(result.enrolled).toBe(0);
  });

  it('sends a due step through the gate', async () => {
    db.follow_up_enrollments.push({
      id: 'e1', sequence_id: 's1', beautician_id: 'b1', client_id: 'c1', appointment_id: 'a1',
      current_step: 0, next_send_at: minsAgo(5), status: 'active',
      clients: client, beauticians: beautician,
      follow_up_sequences: { steps: db.follow_up_sequences[0].steps, name: 'Lash lift chain' },
    });

    const result = await automations.processFollowUpSequences();

    expect(result.sent).toBe(1);
    expect(gateCalls[0].messageType).toBe('marketing');
    expect(gateCalls[0].body).toContain('Step one');
    expect(db.follow_up_enrollments[0].current_step).toBe(1);
  });

  it('counts a held step as progress but not as a send', async () => {
    db.follow_up_enrollments.push({
      id: 'e1', sequence_id: 's1', beautician_id: 'b1', client_id: 'c1', appointment_id: 'a1',
      current_step: 0, next_send_at: minsAgo(5), status: 'active',
      clients: client, beauticians: beautician,
      follow_up_sequences: { steps: db.follow_up_sequences[0].steps, name: 'Lash lift chain' },
    });
    verdict = { decision: 'block', tier: 'proactive', reason: 'quiet_hours' };

    const result = await automations.processFollowUpSequences();

    expect(result.sent).toBe(0);
    // The schedule moves on. A chain that stalls delivers step 3 weeks late,
    // referring to a visit nobody remembers.
    expect(db.follow_up_enrollments[0].current_step).toBe(1);
  });
});

describe('nothing in this file sends without asking', () => {
  it('the raw sender is never called from a processor, only from gatedSend', () => {
    // One call site: inside gatedSend itself.
    const calls = source.match(/await sendOnChannel\(/g) || [];
    expect(calls).toHaveLength(1);
  });
});
