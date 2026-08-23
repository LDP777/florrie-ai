/**
 * WHAT THESE HOURLY JOBS LOOK AT, AND HOW FAR BACK.
 *
 * Two separate ways a window can be wrong, both of them new in this sweep.
 *
 * 1. THE BACKLOG. `rebook-reminder-queue` asked for every unsent row with
 *    reminder_date <= today, with no lower bound and no limit. The button that
 *    writes those rows has been on the completed-appointment sheet since
 *    migration 078 and NOTHING has ever read the table back. So the first run
 *    after this deploy does not meet today's work, it meets a year of it: two
 *    minutes after boot, hundreds of stale drafts in the Outbox one tap from
 *    delivery, each about a visit last spring, and every client on
 *    messaging_autonomy = 'florrie' simply texted. The other two jobs
 *    registered alongside it are window-bounded; this one was not.
 *
 * 2. THE CLOCK. appointments.ends_at holds SALON WALL TIME parked in a UTC
 *    slot (lib/appointment-treatments.js endsAtWall). Both new jobs compared it
 *    against a window built from `new Date()`, which is a real instant. In BST
 *    that is an hour out, so a 24 hour aftercare goes out 25 wall hours after
 *    the visit, every day from late March to late October.
 *
 *    Moving to the wall frame introduces the opposite hazard, and it is why the
 *    window is now WIDER than the cadence: on the morning the clocks go
 *    forward, wall time jumps from 01:00 to 02:00 between two hourly runs, so
 *    an hour-wide wall window steps clean over an hour of finished
 *    appointments and never comes back to it. Three hours against an hourly
 *    run cannot, and both passes dedupe, so the overlap costs nothing.
 */
process.env.TZ = 'UTC';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const db = {
  clients: [], beauticians: [], appointments: [], treatments: [],
  aftercare_messages: [], aftercare_sends: [], rebook_reminders: [],
  follow_up_sequences: [], follow_up_enrollments: [],
};

const RELATIONS = {
  appointments: {
    clients: { table: 'clients', fk: 'client_id' },
    treatments: { table: 'treatments', fk: 'treatment_id' },
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

function parseEmbeds(spec) {
  const embeds = [];
  if (!spec || spec === '*') return embeds;
  for (const item of splitTop(spec)) {
    const nested = /^([\w]+)\s*\(([\s\S]*)\)$/.exec(item);
    if (nested) embeds.push(nested[1]);
  }
  return embeds;
}

function makeBuilder(table) {
  const filters = [];
  let pending = null;
  let embeds = [];
  let sort = null;
  let cap = null;

  const matching = () => {
    let rows = (db[table] || []).filter(r => filters.every(f => f(r)));
    if (sort) {
      rows = [...rows].sort((a, b) => {
        const av = String(a[sort.col] ?? ''), bv = String(b[sort.col] ?? '');
        return sort.asc ? av.localeCompare(bv) : bv.localeCompare(av);
      });
    }
    if (cap !== null) rows = rows.slice(0, cap);
    return rows;
  };

  const withEmbeds = (rows) => rows.map((r) => {
    const out = { ...r };
    for (const rel of embeds) {
      const cfg = RELATIONS[table]?.[rel];
      if (!cfg) continue;
      const found = (db[cfg.table] || []).find(x => x.id === r[cfg.fk]);
      out[rel] = found ? { ...found } : null;
    }
    return out;
  });

  const settle = () => {
    if (pending?.op === 'insert') {
      const payload = Array.isArray(pending.payload) ? pending.payload : [pending.payload];
      const created = payload.map(p => ({ id: `${table}_${++idCounter}`, created_at: new Date().toISOString(), ...p }));
      db[table].push(...created);
      return { data: created, error: null };
    }
    if (pending?.op === 'update') {
      const rows = matching();
      for (const r of rows) Object.assign(r, pending.payload);
      return { data: rows.map(r => ({ id: r.id })), error: null };
    }
    return { data: withEmbeds(matching()), error: null };
  };

  const b = {
    select(spec = '*') { embeds = parseEmbeds(spec); return b; },
    insert(p) { pending = { op: 'insert', payload: p }; return b; },
    update(p) { pending = { op: 'update', payload: p }; return b; },
    eq(c, v) { filters.push(r => r[c] === v); return b; },
    in(c, v) { filters.push(r => v.includes(r[c])); return b; },
    is(c, v) { filters.push(r => (r[c] ?? null) === v); return b; },
    not(c, _op, v) { filters.push(r => (r[c] ?? null) !== v); return b; },
    gte(c, v) { filters.push(r => String(r[c] ?? '') >= String(v)); return b; },
    lte(c, v) { filters.push(r => String(r[c] ?? '') <= String(v)); return b; },
    gt(c, v) { filters.push(r => String(r[c] ?? '') > String(v)); return b; },
    lt(c, v) { filters.push(r => String(r[c] ?? '') < String(v)); return b; },
    or() { return b; },
    order(col, opts) { sort = { col, asc: opts?.ascending !== false }; return b; },
    limit(n) { cap = n; return b; },
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

const gateCalls = [];
vi.mock('../../src/lib/outbound-guard.js', () => ({
  guardedSend: async ({ send, ...args }) => {
    gateCalls.push(args);
    return { decision: 'send', tier: 'proactive', reason: 'trusted_auto', delivered: !!(await send()) };
  },
}));

const sent = { sms: [], email: [] };
vi.mock('../../src/services/notifications.js', () => ({
  sendSMS: async (a) => { sent.sms.push(a); return { id: 'sms_1' }; },
  sendWhatsApp: async () => ({ id: 'wa_1' }),
  sendEmail: async (a) => { sent.email.push(a); return { id: 'em_1' }; },
}));
vi.mock('../../src/services/sms-metering.js', () => ({ shouldAutoSend: async () => ({ shouldSend: true }) }));
vi.mock('../../src/services/loyalty.js', () => ({
  getLoyaltyConfig: async () => null, getClientPoints: async () => 0, loyaltyProximity: () => null,
}));

const automations = await import('../../src/services/automations.js');

const beautician = {
  id: 'b1', business_name: 'Ellindigo', first_name: 'Ellie', booking_slug: 'ellindigo',
  timezone: 'Europe/London', client_reminder_prefs: { channel: 'sms' },
};
const client = {
  id: 'c1', beautician_id: 'b1', first_name: 'Shauna', phone: '+447700900007',
  email: null, marketing_consent: true, marketing_opted_out_at: null, messaging_autonomy: null,
};

beforeEach(() => {
  for (const t of Object.keys(db)) db[t] = [];
  idCounter = 0;
  gateCalls.length = 0;
  sent.sms.length = 0;
  sent.email.length = 0;
  db.beauticians.push({ ...beautician });
  db.clients.push({ ...client });
});

afterEach(() => { vi.useRealTimers(); });

/* ================================================== 1. the first-boot backlog */
describe('the rebook queue on the morning it is first switched on', () => {
  const dayAgo = (n) => new Date(Date.now() - n * 86400_000).toISOString().slice(0, 10);

  /** A year of rows nobody has ever read back, one client each so they can
   *  be told apart on the way out. */
  const seedBacklog = (days = 300) => {
    for (let i = 1; i <= days; i += 1) {
      db.clients.push({ ...client, id: `c${i}`, first_name: `Client ${i}` });
      db.rebook_reminders.push({
        id: `r${i}`, beautician_id: 'b1', client_id: `c${i}`, appointment_id: `a${i}`,
        reminder_date: dayAgo(i), message: 'Time to rebook', sent: false,
      });
    }
  };

  it('never nudges anybody about a visit from months ago', async () => {
    seedBacklog();

    await automations.processRebookNudges();

    const floor = dayAgo(14);
    for (const call of gateCalls) {
      const row = db.rebook_reminders.find(r => r.client_id === call.clientId);
      expect(row, 'a nudge went out for a row that is not in the queue').toBeTruthy();
      expect(
        row.reminder_date >= floor,
        `nudged about ${row.reminder_date}, which is months old`,
      ).toBe(true);
    }
  });

  it('sends a fortnight of work, not a year of it', async () => {
    seedBacklog();

    await automations.processRebookNudges();

    // 300 rows in. Days 1 to 14 are inside the floor; the other 286 are not.
    expect(gateCalls).toHaveLength(14);
    expect(sent.sms).toHaveLength(14);
  });

  it('caps one pass even when everything is inside the floor', async () => {
    // Eighty rows all dated in the last fortnight: a real backlog can still be
    // bigger than an hour's work, and a surprise must not become a flood.
    for (let i = 1; i <= 80; i += 1) {
      db.clients.push({ ...client, id: `c${i}` });
      db.rebook_reminders.push({
        id: `r${i}`, beautician_id: 'b1', client_id: `c${i}`, appointment_id: `a${i}`,
        reminder_date: dayAgo(i % 14), message: 'Time to rebook', sent: false,
      });
    }

    await automations.processRebookNudges();

    expect(gateCalls).toHaveLength(50);
    // And the rest are still there for the next pass, not lost.
    expect(db.rebook_reminders.filter(r => !r.sent)).toHaveLength(30);
  });

  it('closes the stale rows so they stop looking due forever', async () => {
    seedBacklog();

    await automations.processRebookNudges();

    const stillPending = db.rebook_reminders.filter(r => !r.sent);
    expect(stillPending, 'a backlog that comes back every hour for ever').toHaveLength(0);
  });

  it('closes them WITHOUT sending them', async () => {
    seedBacklog();

    await automations.processRebookNudges();

    const oldest = db.rebook_reminders.find(r => r.reminder_date === dayAgo(300));
    expect(oldest.sent, 'left pending, so it is due again in an hour').toBe(true);
    expect(gateCalls.some(c => c.clientId === oldest.client_id),
      'a client was nudged about a visit ten months ago').toBe(false);
  });

  it('still sends the one Ellie set for last week', async () => {
    db.rebook_reminders.push({
      id: 'r1', beautician_id: 'b1', client_id: 'c1', appointment_id: 'a1',
      reminder_date: dayAgo(3), message: 'Time to rebook Shauna', sent: false,
    });

    const result = await automations.processRebookNudges();

    expect(result.sent).toBe(1);
    expect(sent.sms).toHaveLength(1);
  });

  it('and one dated today', async () => {
    db.rebook_reminders.push({
      id: 'r1', beautician_id: 'b1', client_id: 'c1', appointment_id: 'a1',
      reminder_date: dayAgo(0), message: 'Time to rebook Shauna', sent: false,
    });

    const result = await automations.processRebookNudges();
    expect(result.sent).toBe(1);
  });

  it('leaves one dated next month alone, neither sent nor retired', async () => {
    const future = new Date(Date.now() + 30 * 86400_000).toISOString().slice(0, 10);
    db.rebook_reminders.push({
      id: 'r1', beautician_id: 'b1', client_id: 'c1', appointment_id: 'a1',
      reminder_date: future, message: 'Time to rebook Shauna', sent: false,
    });

    const result = await automations.processRebookNudges();

    expect(result.sent).toBe(0);
    expect(gateCalls).toHaveLength(0);
    expect(db.rebook_reminders[0].sent).toBe(false);
  });
});

/* ========================================================= 2. the salon clock */
describe('a job that reads a wall-time column', () => {
  const seedAftercare = (endsAtWall) => {
    db.aftercare_messages.push({
      id: 'ac1', beautician_id: 'b1', treatment_id: 't1', name: 'Lash aftercare',
      message: 'Hey {name}, keep them dry for 24h!', send_after_hours: 24, is_active: true,
    });
    db.appointments.push({
      id: 'a1', beautician_id: 'b1', client_id: 'c1', treatment_id: 't1',
      status: 'completed', ends_at: endsAtWall,
    });
  };

  it('sends a 24 hour aftercare 24 wall hours later, not 25, in British Summer Time', async () => {
    // 15 July, high summer, the clocks are an hour ahead. Ellie's 13:00 finish
    // yesterday is stored as 13:00 in the UTC slot, and it is 13:00 in the
    // salon right now.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T12:00:00Z'));   // 13:00 in the salon
    seedAftercare('2026-07-14T13:00:00');                 // 24 salon hours ago

    const result = await automations.processAftercareFollowups();

    expect(result.sent, 'her aftercare is an hour late every day all summer').toBe(1);
    expect(sent.sms[0].body).toContain('keep them dry');
  });

  it('does not send it early', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T12:00:00Z'));   // 13:00 in the salon
    seedAftercare('2026-07-15T11:00:00');                 // finished two hours ago

    const result = await automations.processAftercareFollowups();

    expect(result.sent).toBe(0);
  });

  it('does not lose the hour the clocks jump over in March', async () => {
    // 01:00 GMT becomes 02:00 BST on 29 March 2026. An hour-wide wall window
    // steps from [23:30, 00:30] straight to [01:30, 02:30] and never scans the
    // hour in between, so these clients get no aftercare and nobody is told.
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-29T01:30:00Z'));   // 02:30 in the salon
    seedAftercare('2026-03-28T01:00:00');                 // inside the lost hour

    const result = await automations.processAftercareFollowups();

    expect(result.sent, 'an hour of finished appointments fell down the gap').toBe(1);
  });

  it('enrols a sequence off the same clock', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T12:00:00Z'));   // 13:00 in the salon
    db.follow_up_sequences.push({
      id: 's1', beautician_id: 'b1', name: 'Lash lift chain', trigger: 'after-appointment',
      treatments: [], active: true,
      steps: [{ delay: '24h', channel: 'sms', message: 'Step one, {name}' }],
    });
    db.appointments.push({
      id: 'a1', beautician_id: 'b1', client_id: 'c1', treatment_id: 't1',
      status: 'completed', ends_at: '2026-07-15T12:30:00',   // half an hour ago, salon time
    });

    const result = await automations.processFollowUpSequences();

    expect(result.enrolled, 'a visit that finished half an hour ago was invisible').toBe(1);
  });

  it('does not enrol a booking that has not happened yet', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-15T12:00:00Z'));   // 13:00 in the salon
    db.follow_up_sequences.push({
      id: 's1', beautician_id: 'b1', name: 'Lash lift chain', trigger: 'after-appointment',
      treatments: [], active: true, steps: [{ delay: '24h', message: 'Step one' }],
    });
    db.appointments.push({
      id: 'a1', beautician_id: 'b1', client_id: 'c1', treatment_id: 't1',
      status: 'completed', ends_at: '2026-07-15T16:00:00',   // this afternoon
    });

    const result = await automations.processFollowUpSequences();
    expect(result.enrolled).toBe(0);
  });
});
