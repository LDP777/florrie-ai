/**
 * A MARKETING EMAIL WITH NO READABLE CONSENT DOES NOT GO.
 *
 * 2 September 2026. processEmailQueue read beauticians.marketing_emails_enabled
 * with `const { data: prefs }` and threw the error away. That column arrives in
 * supabase/migrations/022_email_sends.sql, which is applied by hand and is not
 * known to be applied in production. PostgREST answers a select naming a
 * missing column with { data: null, error } and never throws, so on that
 * database `prefs` was null, `null?.marketing_emails_enabled === false` was
 * false, and an owner who had unsubscribed got the email anyway.
 *
 * PECR reg 22 puts the burden of proving consent on the sender. A preference
 * we cannot read is not consent, so the sequence now holds the email, logs the
 * migration by name, and marks the row skipped.
 *
 * The same file's checkTrialExpiry discarded its query error too. A failed
 * read there is indistinguishable from "no trial is ending", which is the one
 * thing the cron exists to notice, so it is now logged.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const db = { beauticians: [], email_sends: [] };

/** How the next beauticians select of a given column should answer. */
const faults = { marketing_emails_enabled: null, trial_query: null };

const MISSING_COLUMN = { code: '42703', message: 'column beauticians.marketing_emails_enabled does not exist' };
const NETWORK_BLIP = { code: '57P01', message: 'terminating connection due to administrator command' };

function builder(table) {
  const filters = [];
  let pending = null;
  let selectSpec = '*';
  let selectError = null;
  const rows = () => (db[table] || []).filter(r => filters.every(f => f(r)));
  const settle = () => {
    if (selectError) return { data: null, error: selectError };
    if (pending?.op === 'update') {
      const hit = rows();
      for (const r of hit) Object.assign(r, pending.payload);
      return { data: hit, error: null };
    }
    if (pending?.op === 'insert') {
      const row = { id: `${table}_${db[table].length + 1}`, ...pending.payload };
      db[table].push(row);
      return { data: [row], error: null };
    }
    return { data: rows(), error: null };
  };
  const b = {
    select(spec = '*') {
      selectSpec = spec;
      if (table === 'beauticians' && spec === 'marketing_emails_enabled') selectError = faults.marketing_emails_enabled;
      return b;
    },
    insert(p) { pending = { op: 'insert', payload: p }; return b; },
    update(p) { pending = { op: 'update', payload: p }; return b; },
    eq(c, v) {
      if (table === 'beauticians' && selectSpec === 'id' && c === 'subscription_plan') selectError = faults.trial_query;
      filters.push(r => r[c] === v); return b;
    },
    in(c, vals) { filters.push(r => vals.includes(r[c])); return b; },
    lte(c, v) { filters.push(r => String(r[c] ?? '') <= String(v)); return b; },
    gte(c, v) { filters.push(r => String(r[c] ?? '') >= String(v)); return b; },
    lt(c, v) { filters.push(r => String(r[c] ?? '') < String(v)); return b; },
    order() { return b; },
    limit() { return b; },
    single() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    maybeSingle() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    then(res, rej) { return Promise.resolve(settle()).then(res, rej); },
  };
  return b;
}

vi.mock('../../src/config.js', () => ({ supabase: { from: builder }, supabaseAnon: { from: builder } }));

const sent = [];
vi.mock('../../src/services/notifications.js', () => ({
  sendEmail: async (payload) => { sent.push(payload); return true; },
}));

const logged = { error: [], warn: [] };
vi.mock('../../src/lib/logger.js', () => {
  const rec = (level) => (a, b) => { logged[level]?.push({ ctx: typeof a === 'object' ? a : {}, msg: typeof a === 'string' ? a : b }); };
  return { default: { error: rec('error'), warn: rec('warn'), info: () => {}, debug: () => {} } };
});

const { processEmailQueue, checkTrialExpiry } = await import('../../src/services/email-sequences.js');

const due = (sequence, key) => ({
  id: `send_${db.email_sends.length + 1}`, beautician_id: 'b1', sequence,
  email_key: `${key}_b1`, subject: 'hello', status: 'pending',
  send_at: new Date(Date.now() - 60_000).toISOString(), context: {},
});

beforeEach(() => {
  db.beauticians = [{
    id: 'b1', email: 'jo@newsalon.co.uk', first_name: 'Jo', booking_slug: 'jo-brows',
    subscription_plan: 'trial', marketing_emails_enabled: true,
  }];
  db.email_sends = [];
  sent.length = 0;
  logged.error.length = 0;
  logged.warn.length = 0;
  faults.marketing_emails_enabled = null;
  faults.trial_query = null;
});

describe('marketing emails fail closed when the preference cannot be read', () => {
  it('still sends when the column is there and she has not unsubscribed', async () => {
    db.email_sends.push(due('welcome', 'welcome_day7'));
    await processEmailQueue();
    expect(sent).toHaveLength(1);
    expect(db.email_sends[0].status).toBe('sent');
  });

  it('holds the email and names the migration when the column is missing', async () => {
    faults.marketing_emails_enabled = MISSING_COLUMN;
    db.email_sends.push(due('welcome', 'welcome_day7'));

    await processEmailQueue();

    expect(sent).toHaveLength(0);
    expect(db.email_sends[0].status).toBe('skipped');
    const complaint = logged.error.find(l => /022_email_sends/.test(l.msg || ''));
    expect(complaint).toBeTruthy();
    expect(complaint.ctx.err).toEqual(MISSING_COLUMN);
  });

  it('holds the email on any other read error too', async () => {
    faults.marketing_emails_enabled = NETWORK_BLIP;
    db.email_sends.push(due('trial_expiring', 'trial_3day_warning'));

    await processEmailQueue();

    expect(sent).toHaveLength(0);
    expect(db.email_sends[0].status).toBe('skipped');
    expect(logged.error.some(l => /could not read marketing_emails_enabled/i.test(l.msg || ''))).toBe(true);
  });

  it('still sends the post-appointment review request, which is not marketing', async () => {
    // The one sequence the unsubscribe never covered: it answers an
    // appointment she just had, and it went out before this change even for
    // an owner with marketing_emails_enabled false. A missing column must not
    // widen the hold to it.
    faults.marketing_emails_enabled = MISSING_COLUMN;
    db.email_sends.push(due('post_appointment', 'review_request'));

    await processEmailQueue();

    expect(sent).toHaveLength(1);
    expect(db.email_sends[0].status).toBe('sent');
  });

  it('honours an explicit unsubscribe exactly as before', async () => {
    db.beauticians[0].marketing_emails_enabled = false;
    db.email_sends.push(due('welcome', 'welcome_day7'));
    await processEmailQueue();
    expect(sent).toHaveLength(0);
    expect(db.email_sends[0].status).toBe('skipped');
  });
});

describe('checkTrialExpiry reads its own error', () => {
  it('logs a failed query instead of reporting that nobody is expiring', async () => {
    faults.trial_query = NETWORK_BLIP;
    const out = await checkTrialExpiry();
    expect(out).toEqual({ triggered: 0 });
    const complaint = logged.error.find(l => /checkTrialExpiry/.test(l.msg || ''));
    expect(complaint).toBeTruthy();
    expect(complaint.ctx.err).toEqual(NETWORK_BLIP);
  });

  it('says nothing when the query simply finds nobody', async () => {
    db.beauticians[0].trial_ends_at = null;
    const out = await checkTrialExpiry();
    expect(out).toEqual({ triggered: 0 });
    expect(logged.error).toHaveLength(0);
  });
});
