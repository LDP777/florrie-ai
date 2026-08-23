/**
 * THREE NEW SENDERS THAT SWITCHED THE OPT-OUT CHECK OFF BY ACCIDENT.
 *
 * lib/outbound-guard.js evaluateOutbound only reads the client from the
 * database when it is handed nothing. Give it a row and it trusts the row:
 *
 *     if (c.marketing_opted_out_at) return decision('block', tier, 'opted_out');
 *
 * A row selected as `clients(id, first_name, phone, email)` has
 * marketing_opted_out_at === undefined, which is falsy, so that line never
 * fires. Not "the check failed": the check was not there. A client who replied
 * STOP walks through the gate, and on the default `ask` dial she lands in the
 * Outbox as an ordinary loud pending_approval draft, inside "Send all", where
 * services/messaging.js sends her with no messageType so sendSMS's own PECR
 * check does not fire either. On `florrie` she is simply texted.
 *
 * Texting an opted-out client is a PECR breach, not a missing field. The three
 * jobs registered in this sweep (aftercare, the rebook queue, follow-up
 * sequences) and the patch-test and rebook nudges in autonomous-scheduler all
 * passed such a row. booking.js:2392, written in the same diff, selects
 * marketing_consent, marketing_opted_out_at and messaging_autonomy and is
 * correct, which is how you can tell this was an omission.
 *
 * These tests run the REAL guard against a Supabase double that PROJECTS an
 * embedded join to the columns actually named, exactly as PostgREST does. That
 * is the whole point: a stub that hands back the full row whatever you ask for
 * cannot fail on any of this.
 */
process.env.TZ = 'UTC';

import { describe, it, expect, beforeEach, vi } from 'vitest';

const db = {
  clients: [], beauticians: [], appointments: [], treatments: [],
  aftercare_messages: [], aftercare_sends: [], rebook_reminders: [],
  follow_up_sequences: [], follow_up_enrollments: [], outbound_sends: [],
};

/** Embedded resource -> the table it comes from and the column that points at it. */
const RELATIONS = {
  appointments: {
    clients: { table: 'clients', fk: 'client_id' },
    treatments: { table: 'treatments', fk: 'treatment_id' },
    beauticians: { table: 'beauticians', fk: 'beautician_id' },
  },
  aftercare_messages: { beauticians: { table: 'beauticians', fk: 'beautician_id' } },
  rebook_reminders: {
    clients: { table: 'clients', fk: 'client_id' },
    beauticians: { table: 'beauticians', fk: 'beautician_id' },
  },
  follow_up_enrollments: {
    clients: { table: 'clients', fk: 'client_id' },
    beauticians: { table: 'beauticians', fk: 'beautician_id' },
    follow_up_sequences: { table: 'follow_up_sequences', fk: 'sequence_id' },
  },
};

let idCounter = 0;

/** Split "a, b(c, d), e" on top-level commas only. */
function splitTop(spec) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of String(spec)) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim()).filter(Boolean);
}

/** The embedded resources a select asks for, and the columns it asks of each. */
function parseEmbeds(spec) {
  const embeds = {};
  if (!spec || spec === '*') return embeds;
  for (const item of splitTop(spec)) {
    const nested = /^([\w]+)\s*\(([\s\S]*)\)$/.exec(item);
    if (!nested) continue;
    embeds[nested[1]] = splitTop(nested[2]);
  }
  return embeds;
}

function project(row, cols) {
  if (!row) return null;
  if (!cols || cols.includes('*')) return { ...row };
  const out = {};
  // PostgREST returns the columns you asked for and NOTHING else, whether or
  // not they hold a value. Asking for four columns is how you end up with a
  // client row that cannot say whether she opted out.
  for (const c of cols) out[c] = row[c] ?? null;
  return out;
}

function makeBuilder(table) {
  const filters = [];
  let pending = null;
  let embeds = {};
  let wantCount = false;

  const matching = () => (db[table] || []).filter(r => filters.every(f => f(r)));

  const withEmbeds = (rows) => rows.map((r) => {
    const out = { ...r };
    for (const [rel, cols] of Object.entries(embeds)) {
      const cfg = RELATIONS[table]?.[rel];
      if (!cfg) continue;
      out[rel] = project((db[cfg.table] || []).find(x => x.id === r[cfg.fk]), cols);
    }
    return out;
  });

  const settle = () => {
    if (pending?.op === 'insert') {
      const payload = Array.isArray(pending.payload) ? pending.payload : [pending.payload];
      const created = payload.map(p => ({
        id: `${table}_${++idCounter}`, created_at: new Date().toISOString(), ...p,
      }));
      db[table].push(...created);
      return { data: created, error: null, count: created.length };
    }
    if (pending?.op === 'update') {
      const rows = matching();
      for (const r of rows) Object.assign(r, pending.payload);
      return { data: rows, error: null, count: rows.length };
    }
    const rows = matching();
    if (wantCount) return { data: [], error: null, count: rows.length };
    return { data: withEmbeds(rows), error: null, count: rows.length };
  };

  const b = {
    select(spec = '*', opts) {
      wantCount = opts?.count === 'exact';
      embeds = parseEmbeds(spec);
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
    gt(c, v) { filters.push(r => String(r[c] ?? '') > String(v)); return b; },
    lt(c, v) { filters.push(r => String(r[c] ?? '') < String(v)); return b; },
    or() { return b; },
    order() { return b; },
    limit() { return b; },
    maybeSingle() { const o = settle(); return Promise.resolve({ data: (o.data || [])[0] || null, error: null }); },
    single() { const o = settle(); return Promise.resolve({ data: (o.data || [])[0] || null, error: null }); },
    then(res, rej) { return Promise.resolve(settle()).then(res, rej); },
  };
  return b;
}

vi.mock('../../src/config.js', () => ({ supabase: { from: (t) => makeBuilder(t) } }));
vi.mock('../../src/lib/logger.js', () => ({
  default: { info() {}, warn() {}, error() {}, debug() {}, fatal() {} },
}));

/* The two outside dependencies of the real guard, pinned so this does not
 * depend on the time of day it happens to run. */
vi.mock('../../src/services/whatsapp-metering.js', () => ({
  getMonthlyUsage: async () => null,
  checkWhatsAppQuota: async () => ({ allowed: true }),
  trackWhatsAppMessage: async () => true,
  trackSmsInMonthlyQuota: async () => true,
}));
vi.mock('../../src/lib/marketing-guard.js', () => ({
  inMarketingQuietHours: () => false,
  isMarketingTemplate: () => false,
  isMarketingSmsType: () => false,
  canSendMarketing: async () => ({ allowed: true }),
  findClientByPhone: async () => null,
}));

const sent = { sms: [], whatsapp: [], email: [] };
vi.mock('../../src/services/notifications.js', () => ({
  sendSMS: async (a) => { sent.sms.push(a); return { id: 'sms_1' }; },
  sendWhatsApp: async (a) => { sent.whatsapp.push(a); return { id: 'wa_1' }; },
  sendEmail: async (a) => { sent.email.push(a); return { id: 'em_1' }; },
  sendNudge: async (a) => { sent.sms.push(a); return { ok: true }; },
  processReminders: async () => ({ sent: 0 }),
}));
vi.mock('../../src/services/sms-metering.js', () => ({ shouldAutoSend: async () => ({ shouldSend: true }) }));
vi.mock('../../src/services/loyalty.js', () => ({
  getLoyaltyConfig: async () => null, getClientPoints: async () => 0, loyaltyProximity: () => null,
}));

const automations = await import('../../src/services/automations.js');
const { nowInSalonWall } = await import('../../src/lib/free-slots.js');

const wallAgo = (hours) => new Date(nowInSalonWall('Europe/London').getTime() - hours * 3600_000).toISOString();
const dayAgo = (days) => new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10);

/** Ellie's salon, with the trust dial turned all the way up. */
const seedBeautician = () => db.beauticians.push({
  id: 'b1', business_name: 'Ellindigo', first_name: 'Ellie', booking_slug: 'ellindigo',
  timezone: 'Europe/London', client_reminder_prefs: { channel: 'sms' },
  autonomy: { proactive: 'auto' },
});

/**
 * Shauna. She replied STOP in June, and she is set to `florrie` from before
 * that, which is the combination that texts her outright rather than drafting.
 */
const seedClient = (over = {}) => db.clients.push({
  id: 'c1', beautician_id: 'b1', first_name: 'Shauna',
  phone: '+447700900007', email: 'shauna@example.com',
  marketing_consent: true, marketing_opted_out_at: '2026-06-02T09:14:00Z',
  messaging_autonomy: 'florrie', ...over,
});

const lastRecorded = () => db.outbound_sends[db.outbound_sends.length - 1] || null;

beforeEach(() => {
  for (const t of Object.keys(db)) db[t] = [];
  idCounter = 0;
  sent.sms.length = 0; sent.whatsapp.length = 0; sent.email.length = 0;
  seedBeautician();
});

/* ============================================================== 1. aftercare */
describe('the aftercare follow-up', () => {
  const seed = () => {
    db.aftercare_messages.push({
      id: 'ac1', beautician_id: 'b1', treatment_id: 't1', name: 'Lash aftercare',
      message: 'Hey {name}, keep them dry for 24h!', send_after_hours: 24, is_active: true,
    });
    db.appointments.push({
      id: 'a1', beautician_id: 'b1', client_id: 'c1', treatment_id: 't1',
      status: 'completed', ends_at: wallAgo(24.5),
    });
  };

  it('does not text a client who replied STOP', async () => {
    seedClient();
    seed();

    const result = await automations.processAftercareFollowups();

    expect(sent.sms, 'an opted-out client was texted').toHaveLength(0);
    expect(result.sent).toBe(0);
  });

  it('records the refusal as a block, not as a draft waiting in the Outbox', async () => {
    seedClient();
    seed();

    await automations.processAftercareFollowups();

    // pending_approval would put her one tap from delivery in "Send all".
    expect(lastRecorded()).toMatchObject({ status: 'blocked', reason: 'opted_out' });
  });

  it('leaves the dedup row unwritten so nothing is silently lost', async () => {
    seedClient();
    seed();
    await automations.processAftercareFollowups();
    expect(db.aftercare_sends).toHaveLength(0);
  });

  it('still sends to a client who has not opted out', async () => {
    seedClient({ marketing_opted_out_at: null });
    seed();

    const result = await automations.processAftercareFollowups();

    expect(result.sent).toBe(1);
    expect(sent.sms).toHaveLength(1);
    expect(sent.sms[0].body).toContain('keep them dry');
  });
});

/* ========================================================== 2. rebook queue */
describe('the rebook queue Ellie fills from the diary', () => {
  const seed = () => db.rebook_reminders.push({
    id: 'r1', beautician_id: 'b1', client_id: 'c1', appointment_id: 'a1',
    reminder_date: dayAgo(1), message: 'Time to rebook Shauna for their brow lamination.',
    sent: false,
  });

  it('does not text a client who replied STOP', async () => {
    seedClient();
    seed();

    const result = await automations.processRebookNudges();

    expect(sent.sms).toHaveLength(0);
    expect(result.sent).toBe(0);
    expect(lastRecorded()).toMatchObject({ status: 'blocked', reason: 'opted_out' });
  });

  it('still nudges a client who has not', async () => {
    seedClient({ marketing_opted_out_at: null });
    seed();

    const result = await automations.processRebookNudges();

    expect(result.sent).toBe(1);
    expect(sent.sms).toHaveLength(1);
  });
});

/* ====================================================== 3. follow-up chains */
describe('a follow-up sequence step', () => {
  const seed = () => {
    db.follow_up_sequences.push({
      id: 's1', beautician_id: 'b1', name: 'Lash lift chain', trigger: 'after-appointment',
      treatments: [], active: true,
      steps: [{ delay: '0h', channel: 'sms', message: 'Step one, {name}' }],
    });
    db.follow_up_enrollments.push({
      id: 'e1', sequence_id: 's1', beautician_id: 'b1', client_id: 'c1', appointment_id: 'a1',
      current_step: 0, next_send_at: new Date(Date.now() - 300_000).toISOString(), status: 'active',
    });
  };

  it('does not text a client who replied STOP', async () => {
    seedClient();
    seed();

    const result = await automations.processFollowUpSequences();

    expect(sent.sms).toHaveLength(0);
    expect(result.sent).toBe(0);
    expect(lastRecorded()).toMatchObject({ status: 'blocked', reason: 'opted_out' });
  });

  it('still sends the step to a client who has not', async () => {
    seedClient({ marketing_opted_out_at: null });
    seed();

    const result = await automations.processFollowUpSequences();

    expect(result.sent).toBe(1);
    expect(sent.sms[0].body).toContain('Step one');
  });
});

/* =========================================================== 4. the email leg */
describe('the email leg of the same message', () => {
  it('does not email a client who replied STOP either', async () => {
    // An opt-out is an opt-out on every channel, not just the one she happened
    // to reply on. The SMS leg had two consent checks on it and the email leg
    // had none: "always send if client has email".
    seedClient();
    db.aftercare_messages.push({
      id: 'ac1', beautician_id: 'b1', treatment_id: 't1', name: 'Lash aftercare',
      message: 'Hey {name}, keep them dry for 24h!', send_after_hours: 24, is_active: true,
    });
    db.appointments.push({
      id: 'a1', beautician_id: 'b1', client_id: 'c1', treatment_id: 't1',
      status: 'completed', ends_at: wallAgo(24.5),
    });

    await automations.processAftercareFollowups();

    expect(sent.email, 'an opted-out client got the message by email').toHaveLength(0);
  });

  it('still emails a client who has not opted out', async () => {
    seedClient({ marketing_opted_out_at: null });
    db.aftercare_messages.push({
      id: 'ac1', beautician_id: 'b1', treatment_id: 't1', name: 'Lash aftercare',
      message: 'Hey {name}, keep them dry for 24h!', send_after_hours: 24, is_active: true,
    });
    db.appointments.push({
      id: 'a1', beautician_id: 'b1', client_id: 'c1', treatment_id: 't1',
      status: 'completed', ends_at: wallAgo(24.5),
    });

    await automations.processAftercareFollowups();

    expect(sent.email).toHaveLength(1);
  });
});
