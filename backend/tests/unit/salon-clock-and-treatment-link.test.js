/**
 * THREE READS THAT WERE POINTED AT THE WRONG THING, AND ANSWERED ANYWAY.
 *
 * 1. coach.js filtered appointments on `treatment_name`. appointments has no
 *    such column (001_initial_schema.sql); the link to a treatment is the
 *    treatment_id foreign key. PostgREST rejects the whole select when one
 *    column is unknown and reports it by RESOLVING with { data: null, error },
 *    so `bookings` came back null, `count60` and `revenue60` came out zero, and
 *    the prompt handed Claude "Bookings last 60 days: 0 | Revenue last 60 days:
 *    0". Ellie was then advised about the price of a treatment she does twice a
 *    week, shown to the model as one she has never sold.
 *
 * 2. suggestions.js selected `beauticians.postcode`. postcode lives on
 *    locations (027_multi_location.sql) and on no other table. Same silent
 *    resolve: `b` came back undefined, postcodeToDivision(undefined) fell back
 *    to England and Wales, and a Scottish salon was never told about 2 January
 *    while being prompted about bank holidays she does not have.
 *
 * 3. money.js counted the week's appointments with
 *    `.lt('starts_at', now.toISOString())`. starts_at is SALON WALL TIME in a
 *    UTC slot; `now` is a real instant, an hour behind the salon clock all
 *    summer. So an appointment that finished in the last hour fell out of the
 *    week, out of completedAppts and out of noShows. The one missing from the
 *    Money tab was always the one she had just finished and opened the page to
 *    check.
 *
 * The fake Supabase knows the real columns of appointments, treatments,
 * beauticians and locations, taken from supabase/migrations, and refuses
 * anything else exactly as PostgREST does. Without that, defects 1 and 2 are
 * invisible: a stub that answers every select cannot tell a query that ran from
 * one that never did.
 */
process.env.TZ = 'UTC';
process.env.ANTHROPIC_API_KEY = 'sk-test';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

/* ------------------------------------------------------------------ schema --
 * 001_initial_schema.sql, plus every ALTER TABLE ... ADD COLUMN that follows.
 */
const COLUMNS = {
  appointments: [
    'id', 'beautician_id', 'client_id', 'treatment_id', 'starts_at', 'ends_at',
    'duration_minutes', 'buffer_minutes', 'extra_padding_minutes', 'status',
    'price_cents', 'deposit_cents', 'deposit_paid', 'no_show_fee_cents',
    'no_show_fee_charged', 'booked_via', 'ai_booked', 'ai_action_id',
    'cancelled_at', 'cancellation_reason', 'client_notes', 'beautician_notes',
    'created_at', 'updated_at',
    'stripe_payment_intent_id', 'deposit_amount_cents', 'deposit_status',
    'google_event_id', 'payment_type', 'no_show_fee_payment_intent',
    'no_showed_at', 'completed_at', 'location_id', 'management_token',
    'payment_expires_at', 'policy_snapshot', 'client_email',
    'late_cancel_charged', 'payment_method', 'photo_consent', 'discount_meta',
    'discount_cents', 'package_redemption', 'client_package_id',
    'extra_treatment_ids', 'stripe_payment_method_id', 'policy_fee_charged_at',
    'policy_fee_amount_cents', 'policy_fee_payment_intent_id',
    'rescheduled_at', 'confirmation_sent_at', 'rescheduled_from',
    'late_reschedule_charged',
    // There is no treatment_name here, and there never has been.
  ],
  treatments: [
    'id', 'beautician_id', 'name', 'description', 'duration_minutes',
    'buffer_minutes', 'price_cents', 'deposit_cents', 'category',
    'product_cost_cents', 'contraindications', 'is_active', 'booking_enabled',
    'sort_order', 'created_at', 'updated_at',
    'deposit_percent', 'consultation_form_id', 'location_id',
    'requires_patch_test', 'requires_consultation', 'color',
  ],
  beauticians: [
    'id', 'auth_id', 'first_name', 'last_name', 'business_name', 'email',
    'phone', 'avatar_url', 'booking_slug', 'timezone', 'currency', 'locale',
    'working_hours', 'tone_model', 'confidence_threshold', 'auto_reply_enabled',
    'stripe_account_id', 'stripe_onboarding_complete', 'subscription_status',
    'trial_ends_at', 'brand_color', 'brand_font', 'logo_url',
    'whatsapp_phone_id', 'whatsapp_token', 'instagram_page_id',
    'instagram_token', 'google_place_id', 'onboarding_completed_at',
    'created_at', 'updated_at',
    'notification_prefs', 'client_reminder_prefs', 'stripe_customer_id',
    'subscription_plan', 'subscription_stripe_id',
    'subscription_current_period_end', 'tagline', 'address', 'social_links',
    'google_calendar_connected', 'google_calendar_tokens', 'google_calendar_id',
    'xero_connected', 'xero_tokens', 'xero_tenant_id', 'quickbooks_connected',
    'quickbooks_tokens', 'quickbooks_realm_id', 'ai_chats_this_month',
    'ai_chats_reset_at', 'instagram_page_token', 'marketing_emails_enabled',
    'referral_enabled', 'referral_reward_type', 'referral_reward_value_cents',
    'referral_code', 'hmrc_nino', 'hmrc_access_token', 'hmrc_refresh_token',
    'hmrc_token_expires_at', 'default_location_id', 'whatsapp_display_name',
    'whatsapp_registered_at', 'whatsapp_pending_phone', 'calendar_settings',
    'payment_settings', 'booking_policy', 'business_type', 'vat_registered',
    'vat_number', 'instagram_dm_mode', 'instagram_redirect_message',
    'credit_priority_rules', 'instagram_page_name', 'patch_test_expiry_months',
    'whatsapp_pin', 'whatsapp_phone', 'whatsapp_connected',
    'whatsapp_pending_activation', 'whatsapp_retry_at', 'whatsapp_retry_reason',
    'whatsapp_retry_attempts', 'whatsapp_retry_exhausted', 'google_review_link',
    'patch_test_auto_remind', 'patch_test_remind_days_before',
    'patch_test_block_booking', 'wa_provider', 'twilio_wa_sender', 'autonomy',
    'ical_token', 'sms_originator', 'sms_enabled',
    'patch_test_duration_minutes', 'patch_test_price_cents', 'voice_profile',
    'voice_profile_updated_at',
    // No postcode. That is defect 2.
  ],
  // 016_locations.sql + 027_multi_location.sql. The postcode lives HERE.
  locations: [
    'id', 'beautician_id', 'name', 'address', 'phone', 'is_primary', 'status',
    'created_at', 'updated_at', 'booking_slug', 'email', 'postcode',
    'latitude', 'longitude', 'timezone', 'notes',
  ],
  transactions: [
    'id', 'beautician_id', 'appointment_id', 'amount_cents', 'type',
    'stripe_payment_intent_id', 'stripe_charge_id', 'payment_method', 'status',
    'tax_year', 'created_at', 'client_id', 'description', 'accounting_synced',
    'accounting_invoice_id',
  ],
  expenses: [
    'id', 'beautician_id', 'amount_cents', 'vendor', 'description', 'category',
    'receipt_url', 'ocr_data', 'tax_deductible', 'date', 'created_at',
    'accounting_synced', 'accounting_bill_id', 'hmrc_category',
    'recurring_expense_id',
  ],
};

const db = {};
/** Tables told to fail, so "the query did not run" can be told from "no rows". */
const failing = new Map();
const TABLES = [
  ...Object.keys(COLUMNS),
  'clients', 'florrie_decisions', 'hours_exceptions', 'booking_suggestions',
  'reviews', 'rebook_reminders',
];
const reset = () => { for (const t of TABLES) db[t] = []; };

const undefinedColumn = (table, col) => ({
  code: '42703',
  message: `column ${table}.${col} does not exist`,
  details: null, hint: null,
});

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

function parseSelect(table, spec) {
  if (!spec || spec === '*') return null;
  for (const item of splitTop(spec)) {
    const nested = /^([\w]+)\s*\(([\s\S]*)\)$/.exec(item);
    if (nested) continue;
    const known = COLUMNS[table];
    if (!known) continue;
    const col = item.includes(':') ? item.split(':').pop().trim() : item;
    if (col === '*') continue;
    if (!known.includes(col)) return undefinedColumn(table, col);
  }
  return null;
}

function makeBuilder(table) {
  const filters = [];
  let pending = null;
  let selectError = null;
  let filterError = null;
  let wantCount = false;

  const known = COLUMNS[table];
  const guard = (c) => {
    if (!filterError && known && !known.includes(c)) filterError = undefinedColumn(table, c);
  };
  const matching = () => (db[table] || []).filter(r => filters.every(f => f(r)));

  const settle = () => {
    if (failing.has(table)) return { data: null, error: failing.get(table), count: null };
    if (filterError) return { data: null, error: filterError, count: null };
    if (selectError) return { data: null, error: selectError, count: null };
    if (pending?.op === 'update') {
      const rows = matching();
      for (const r of rows) Object.assign(r, pending.payload);
      return { data: rows, error: null, count: rows.length };
    }
    const rows = matching();
    if (wantCount) return { data: [], error: null, count: rows.length };
    return { data: rows, error: null, count: rows.length };
  };

  const b = {
    select(spec = '*', opts) {
      selectError = parseSelect(table, spec);
      wantCount = opts?.count === 'exact';
      return b;
    },
    update(p) { pending = { op: 'update', payload: p }; return b; },
    eq(c, v) { guard(c); filters.push(r => r[c] === v); return b; },
    neq(c, v) { guard(c); filters.push(r => r[c] !== v); return b; },
    in(c, v) { guard(c); filters.push(r => v.includes(r[c])); return b; },
    is(c) { guard(c); return b; },
    not(c, op, v) {
      guard(c);
      if (op === 'is' && v === null) filters.push(r => (r[c] ?? null) !== null);
      return b;
    },
    contains() { filters.push(() => false); return b; },
    or() { return b; },
    ilike(c, v) {
      guard(c);
      const needle = String(v).replace(/%/g, '').toLowerCase();
      filters.push(r => String(r[c] ?? '').toLowerCase().includes(needle));
      return b;
    },
    gte(c, v) { guard(c); filters.push(r => String(r[c]) >= String(v)); return b; },
    lte(c, v) { guard(c); filters.push(r => String(r[c]) <= String(v)); return b; },
    gt(c, v) { guard(c); filters.push(r => String(r[c]) > String(v)); return b; },
    lt(c, v) { guard(c); filters.push(r => String(r[c]) < String(v)); return b; },
    order(c) { guard(c); return b; },
    limit() { return b; },
    maybeSingle() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    single() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    then(res, rej) { return Promise.resolve(settle()).then(res, rej); },
  };
  return b;
}

vi.mock('../../src/config.js', () => ({ supabase: { from: (t) => makeBuilder(t) } }));
vi.mock('../../src/middleware/auth.js', () => ({ requireAuth: (_q, _s, next) => next() }));

/* -------------------------------------------------------------- coach mocks -- */
const prompts = [];
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    constructor() {
      this.messages = {
        create: async ({ messages }) => {
          prompts.push(messages[0].content);
          return {
            content: [{
              text: JSON.stringify({
                headline: 'Room to move', body: 'x', cta_label: 'Prices',
                cta_path: '/price-list', urgency: 'opportunity', icon: 'trending_up',
              }),
            }],
          };
        },
      };
    }
  },
}));

/* -------------------------------------------------------- suggestions mocks -- */
vi.mock('../../src/lib/future-bookings.js', () => ({ getFutureBookedClientIds: async () => new Set() }));
vi.mock('../../src/lib/outbound-guard.js', () => ({ guardedSend: async () => ({ delivered: false, decision: 'block' }) }));
vi.mock('../../src/services/notifications.js', () => ({
  sendSMS: async () => true, sendOnPreferredChannel: async () => true,
  notifyBookingConfirmed: async () => true, sendNudge: async () => ({ skipped: true }),
}));
vi.mock('../../src/services/gap-fill-engine.js', () => ({
  getGapFillSuggestions: async () => [], gapFillDiagnostic: async () => ({}),
}));
vi.mock('../../src/services/florrie-heartbeat.js', () => ({ quietWeekStatus: async () => ({ quiet: false }) }));
vi.mock('@sentry/node', () => ({ captureMessage: () => {}, captureException: () => {} }));

const coachRouter = (await import('../../src/routes/coach.js')).default;
const suggestionsRouter = (await import('../../src/routes/suggestions.js')).default;
const moneyRouter = (await import('../../src/routes/money.js')).default;

async function run(router, method, path, req = {}) {
  const layer = router.stack.find(l => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`no ${method} ${path}`);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const out = { status: 200, body: null };
  const res = {
    status(c) { out.status = c; return res; },
    json(p) { out.body = p; return res; },
    end() { return res; },
  };
  await handler({ query: {}, body: {}, params: {}, beautician: { id: 'b1' }, ...req }, res);
  return out;
}

const B = 'b1';

beforeEach(() => {
  reset();
  failing.clear();
  prompts.length = 0;
  db.beauticians.push({ id: B, first_name: 'Ellie', business_name: 'Florrie' });
});
afterEach(() => { vi.useRealTimers(); });

/* ---------------------------------------------------------------- canaries -- */
describe('the fake refuses what PostgREST refuses', () => {
  it('rejects appointments.treatment_name', async () => {
    const { error } = await makeBuilder('appointments').select('id').ilike('treatment_name', '%lash%');
    expect(error?.code).toBe('42703');
  });

  it('rejects beauticians.postcode', async () => {
    const { error } = await makeBuilder('beauticians').select('postcode');
    expect(error?.code).toBe('42703');
    expect(error.message).toMatch(/beauticians\.postcode/);
  });

  it('accepts locations.postcode, which is where it lives', async () => {
    const { error } = await makeBuilder('locations').select('postcode');
    expect(error).toBeNull();
  });
});

/* ------------------------------------------------- 1. the pricing coach -- */
describe('POST /api/coach/nudge, price_edit', () => {
  beforeEach(() => {
    db.treatments.push({ id: 't1', beautician_id: B, name: 'Lash Lift', price_cents: 3500 });
    // Twice a week for eight weeks. This is the history the coach was blind to.
    const now = Date.now();
    for (let i = 1; i <= 16; i += 1) {
      db.appointments.push({
        id: `a${i}`, beautician_id: B, client_id: 'c1', treatment_id: 't1',
        starts_at: new Date(now - i * 3 * 86400000).toISOString(),
        price_cents: 3500, status: 'completed',
      });
    }
  });

  it('counts her bookings through treatment_id instead of quoting zero', async () => {
    const out = await run(coachRouter, 'post', '/nudge', {
      body: { trigger: 'price_edit', context: { treatment_name: 'Lash Lift', price_cents: 3500 } },
    });
    expect(out.status).toBe(200);
    expect(prompts).toHaveLength(1);
    // Twenty of the sixteen fall inside 60 days; all of them do here.
    expect(prompts[0]).toMatch(/Bookings last 60 days: 16/);
    expect(prompts[0]).toMatch(/Revenue last 60 days: £560/);
    expect(prompts[0]).not.toMatch(/Bookings last 60 days: 0/);
  });

  it('counts nothing that belongs to another treatment', async () => {
    db.treatments.push({ id: 't2', beautician_id: B, name: 'Brow Lamination', price_cents: 3800 });
    db.appointments.push({
      id: 'aX', beautician_id: B, treatment_id: 't2',
      starts_at: new Date().toISOString(), price_cents: 3800, status: 'completed',
    });
    await run(coachRouter, 'post', '/nudge', {
      body: { trigger: 'price_edit', context: { treatment_name: 'Lash Lift', price_cents: 3500 } },
    });
    expect(prompts[0]).toMatch(/Bookings last 60 days: 16/);
  });

  it('says it could not work it out rather than advising from a zero', async () => {
    // A read that fails is what the old code turned into "never booked".
    failing.set('treatments', { code: '42501', message: 'permission denied' });
    const out = await run(coachRouter, 'post', '/nudge', {
      body: { trigger: 'price_edit', context: { treatment_name: 'Lash Lift', price_cents: 3500 } },
    });
    expect(out.status).toBe(503);
    expect(prompts).toHaveLength(0);
  });
});

/* ------------------------------------------- 2. bank holidays by nation -- */
describe('GET /api/suggestions, the bank holiday card', () => {
  const bankHolidayCard = (body) => (body.suggestions || []).find(s => s.type === 'bank_holiday');

  it('reads the postcode off locations, so a Scottish salon gets Scottish dates', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-01-02T09:00:00Z'));
    db.locations.push({
      id: 'l1', beautician_id: B, name: 'Glasgow', postcode: 'G1 2AA',
      is_primary: true, created_at: '2026-01-01T00:00:00Z',
    });

    const out = await run(suggestionsRouter, 'get', '/');
    const card = bankHolidayCard(out.body);
    expect(card).toBeTruthy();
    // On 2 January the next English holiday is Good Friday, months away.
    // Scotland's 2nd January is two days off, and she has never been told.
    expect(card.date).toBe('2027-01-04');
    expect(card.title).toBe('2nd January');
  });

  it('prefers the default location over the rest', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-01-02T09:00:00Z'));
    db.beauticians[0].default_location_id = 'l2';
    db.locations.push(
      { id: 'l1', beautician_id: B, name: 'Leeds', postcode: 'LS1 1AA', is_primary: true, created_at: '2026-01-01T00:00:00Z' },
      { id: 'l2', beautician_id: B, name: 'Edinburgh', postcode: 'EH1 1AA', created_at: '2026-02-01T00:00:00Z' },
    );

    const out = await run(suggestionsRouter, 'get', '/');
    const card = bankHolidayCard(out.body);
    expect(card.date).toBe('2027-01-04');   // Scotland's 2nd January, observed
    expect(card.title).toBe('2nd January');
  });

  it('still falls back to England and Wales when there is no location on file', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2027-01-02T09:00:00Z'));

    const out = await run(suggestionsRouter, 'get', '/');
    const card = bankHolidayCard(out.body);
    expect(card.date).toBe('2027-03-26');
    expect(card.title).toBe('Good Friday');
  });
});

/* -------------------------------------- 3. the Money tab and the salon clock -- */
describe('GET /api/money/pulse in British Summer Time', () => {
  // Wednesday 19 August 2026, 09:30 UTC. The salon clock says 10:30.
  const BST_NOW = '2026-08-19T09:30:00Z';

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(BST_NOW));
  });

  it('counts the appointment she has just finished', async () => {
    db.appointments.push({
      id: 'a1', beautician_id: B, client_id: 'c1', treatment_id: 't1',
      // 10:00 on the salon clock, so it ended half an hour ago. Stored as a
      // wall time in a UTC slot, which is an hour AHEAD of the real instant.
      starts_at: '2026-08-19T10:00:00Z', status: 'completed', price_cents: 3500,
    });

    const out = await run(moneyRouter, 'get', '/pulse');
    expect(out.status).toBe(200);
    expect(out.body.thisWeek.appointments).toBe(1);
  });

  it('counts a no-show from the same hour, so the rate is not quietly flattering', async () => {
    db.appointments.push(
      { id: 'a1', beautician_id: B, starts_at: '2026-08-19T10:00:00Z', status: 'no_show' },
      { id: 'a2', beautician_id: B, starts_at: '2026-08-18T10:00:00Z', status: 'completed' },
    );

    const out = await run(moneyRouter, 'get', '/pulse');
    expect(out.body.thisWeek.noShows).toBe(1);
    expect(out.body.thisWeek.noShowRate).toBe(50);
  });

  it('does not count an appointment still to come', async () => {
    db.appointments.push({
      id: 'a1', beautician_id: B, starts_at: '2026-08-19T14:00:00Z', status: 'confirmed',
    });
    const out = await run(moneyRouter, 'get', '/pulse');
    expect(out.body.thisWeek.appointments).toBe(0);
  });

  it('keeps created_at in the real-instant frame, so midnight Monday takings count', async () => {
    // 00:30 Monday on the salon clock is 23:30 Sunday UTC. It belongs to this
    // week. Forcing the week boundary to plain UTC pushed it into last week.
    db.transactions.push({
      id: 'tx1', beautician_id: B, amount_cents: 4000, type: 'payment',
      status: 'completed', created_at: '2026-08-16T23:30:00Z',
    });
    const out = await run(moneyRouter, 'get', '/pulse');
    expect(out.body.thisWeek.income).toBe(4000);
    expect(out.body.lastWeek.income).toBe(0);
  });

  it('on a Sunday the week is the one that has been running, not the one still to start', async () => {
    // Sunday 23 August 2026, 12:00 UTC. `- getDay() + 1` jumped FORWARD to
    // Monday the 24th, so the whole page read zero every Sunday.
    vi.setSystemTime(new Date('2026-08-23T12:00:00Z'));
    db.appointments.push({
      id: 'a1', beautician_id: B, starts_at: '2026-08-19T10:00:00Z', status: 'completed',
    });
    const out = await run(moneyRouter, 'get', '/pulse');
    expect(out.body.thisWeek.appointments).toBe(1);
  });
});

describe('GET /api/money/reports in British Summer Time', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-19T09:30:00Z'));
  });

  it('treats the appointment that has just finished as past, not upcoming', async () => {
    db.appointments.push(
      { id: 'a1', beautician_id: B, client_id: 'c1', starts_at: '2026-08-19T10:00:00Z', status: 'no_show' },
      { id: 'a2', beautician_id: B, client_id: 'c2', starts_at: '2026-08-12T10:00:00Z', status: 'completed' },
    );
    const out = await run(moneyRouter, 'get', '/reports');
    expect(out.status).toBe(200);
    expect(out.body.no_show_rate.total).toBe(2);
    expect(out.body.no_show_rate.no_shows).toBe(1);
    expect(out.body.no_show_rate.pct).toBe(50);
  });
});
