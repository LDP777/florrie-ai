/**
 * THIRTEEN WRITE HANDLERS THAT NAMED COLUMNS NO MIGRATION HAS EVER CREATED.
 *
 * PostgREST rejects the WHOLE statement when one column in it is unknown, and
 * it reports that by RESOLVING with { data: null, error }, not by throwing. In
 * these handlers the error IS read, so the failure was not silent: it was a
 * flat 500 on every single attempt, for as long as each route has existed.
 * Every one has a page behind it, so the visible symptom was a feature that
 * looked implemented and could never save anything.
 *
 *   add_ons.price                  the insert sent price AND price_cents, and
 *                                  only price_cents exists, so the whole row
 *                                  was rejected. No add-on was creatable.
 *   packages.price/.treatments     price_cents / treatment_ids. And the
 *                                  client-packages read embedded
 *                                  packages(name, price), so fixing only the
 *                                  write would have moved the 500, not ended it.
 *   aftercare_messages
 *     .message_text/.timing_days   message / send_after_hours. The rename is
 *                                  also a UNIT change: days to HOURS. And
 *                                  `name` is NOT NULL with no default, so the
 *                                  handler has to supply one or the insert
 *                                  fails on the constraint instead.
 *   policies.name/.policy_text
 *     /.category                   title / content / type. 'general' is not in
 *                                  type's CHECK either.
 *   hours_exceptions
 *     .exception_type/.details     type, plus flat columns. There is no JSONB
 *                                  details bag to put the rest in.
 *   loyalty_config.min_points_
 *     redeem                       reward_threshold. redemption_rate has no
 *                                  column at all.
 *   loyalty_points.transaction_
 *     date                         created_at. And balance_after is NOT NULL
 *                                  and is what every reader treats as the
 *                                  running total.
 *   referrals.reward               referrer_reward_cents / referred_reward_cents,
 *                                  and the id columns are referrer_id /
 *                                  referred_id.
 *   client_memberships.status
 *     /.starts_at                  wrong TABLE, not just wrong columns: this is
 *                                  the plans table, enrolments are
 *                                  membership_subscriptions.
 *   membership_subscriptions
 *     .subscription_status
 *     /.next_billing_date          status / next_billing_at, and client_id is
 *                                  NOT NULL and was never sent.
 *   portal_settings.*              all four names wrong; one has a real column.
 *   campaigns.campaign_type
 *     /.content                    type / message_template, which this same
 *                                  file's send handler already reads.
 *   client_tag_assignments
 *     .beautician_id               the table is client_id + tag_id. The insert
 *                                  was fixed once and the READ and the DELETE
 *                                  were not, so a repaired write still looked
 *                                  broken.
 *
 * The fake Supabase below therefore does what the real one does: it knows the
 * columns of these tables, taken from supabase/migrations, and refuses a
 * select, a filter, an insert or an update that names anything else. It also
 * enforces NOT NULL and the CHECK constraints, because two of these bugs are
 * only visible once the column names are right. A stub that accepts whatever
 * you hand it cannot fail on any of this, which is why a thousand passing
 * tests never saw it.
 */
process.env.TZ = 'UTC';

import { describe, it, expect, beforeEach, vi } from 'vitest';

/* ------------------------------------------------------------------ schema --
 * Copied from supabase/migrations. The file that proves each one is named in
 * the comment beside it.
 */
const COLUMNS = {
  // 007_all_features.sql + 20260409_backend010_add_ons_extended.sql
  add_ons: [
    'id', 'beautician_id', 'name', 'description', 'price_cents',
    'duration_minutes', 'compatible_treatment_ids', 'is_active', 'sort_order',
    'created_at', 'updated_at',
    'category', 'suggest_with', 'auto_suggest',
  ],
  // 007_all_features.sql
  packages: [
    'id', 'beautician_id', 'name', 'description', 'treatment_ids',
    'sessions_total', 'price_cents', 'saving_cents', 'validity_days',
    'is_active', 'created_at', 'updated_at',
  ],
  // 007_all_features.sql
  client_packages: [
    'id', 'beautician_id', 'client_id', 'package_id', 'sessions_used',
    'sessions_total', 'purchased_at', 'expires_at', 'status', 'created_at',
  ],
  // 007_all_features.sql
  aftercare_messages: [
    'id', 'beautician_id', 'treatment_id', 'name', 'message',
    'send_after_hours', 'channel', 'is_active', 'created_at', 'updated_at',
  ],
  // 007_all_features.sql
  policies: [
    'id', 'beautician_id', 'type', 'title', 'content', 'is_active',
    'show_on_booking', 'require_acceptance', 'created_at', 'updated_at',
  ],
  // 007 + 008_hours_exceptions_updates.sql + 027_multi_location.sql
  hours_exceptions: [
    'id', 'beautician_id', 'date', 'is_closed', 'custom_start', 'custom_end',
    'reason', 'created_at',
    'type', 'end_date', 'start_time', 'end_time', 'note', 'notify_clients',
    'location_id',
  ],
  // 007 + 058_loyalty_reward.sql
  loyalty_config: [
    'id', 'beautician_id', 'points_per_pound', 'reward_threshold',
    'reward_type', 'reward_value_cents', 'is_active', 'created_at',
    'updated_at', 'reward_name',
  ],
  // 007_all_features.sql
  loyalty_points: [
    'id', 'beautician_id', 'client_id', 'points', 'reason', 'appointment_id',
    'balance_after', 'created_at',
  ],
  // 007_all_features.sql creates referrals first, so 023's second
  // CREATE TABLE IF NOT EXISTS is a no-op and this is the shape that exists.
  referrals: [
    'id', 'beautician_id', 'referrer_id', 'referred_id', 'referred_name',
    'referred_email', 'referred_phone', 'status', 'referrer_reward_cents',
    'referred_reward_cents', 'created_at', 'completed_at',
  ],
  // 007 + 20260712_backend013_memberships_catchup.sql. The PLANS she offers.
  client_memberships: [
    'id', 'beautician_id', 'name', 'description', 'price_cents', 'benefits',
    'is_active', 'created_at', 'updated_at',
  ],
  // 007 + 20260712_backend013_memberships_catchup.sql. The ENROLMENTS.
  membership_subscriptions: [
    'id', 'beautician_id', 'client_id', 'membership_id', 'status',
    'started_at', 'next_billing_at', 'cancelled_at', 'created_at',
  ],
  // 007_all_features.sql
  portal_settings: [
    'id', 'beautician_id', 'allow_self_booking', 'allow_rescheduling',
    'allow_cancellation', 'cancellation_window_hours', 'show_prices',
    'show_reviews', 'custom_welcome', 'created_at', 'updated_at',
  ],
  // 001_initial_schema.sql
  campaigns: [
    'id', 'beautician_id', 'type', 'trigger_reason', 'name',
    'message_template', 'target_client_ids', 'target_count', 'status',
    'approved_at', 'sent_at', 'delivered_count', 'opened_count',
    'responded_count', 'booked_count', 'revenue_recovered_cents',
    'digital_employee', 'created_at',
  ],
  // 007_all_features.sql. No beautician_id. That is the whole defect.
  client_tag_assignments: ['id', 'client_id', 'tag_id', 'created_at'],
  client_tags: ['id', 'beautician_id', 'name', 'color', 'created_at'],
  clients: ['id', 'beautician_id', 'first_name', 'last_name', 'email', 'phone'],
  treatments: [
    'id', 'beautician_id', 'name', 'description', 'duration_minutes',
    'buffer_minutes', 'price_cents', 'deposit_cents', 'category',
    'product_cost_cents', 'contraindications', 'is_active', 'booking_enabled',
    'sort_order', 'created_at', 'updated_at', 'color', 'requires_patch_test',
    'requires_consultation', 'deposit_percent', 'consultation_form_id',
    'location_id',
  ],
};

/** NOT NULL with no default: the insert has to supply these itself. */
const REQUIRED = {
  add_ons: ['beautician_id', 'name', 'price_cents'],
  packages: ['beautician_id', 'name', 'price_cents'],
  aftercare_messages: ['beautician_id', 'name', 'message'],
  policies: ['beautician_id', 'type', 'title', 'content'],
  hours_exceptions: ['beautician_id', 'date'],
  loyalty_config: ['beautician_id'],
  loyalty_points: ['beautician_id', 'client_id', 'points', 'reason'],
  referrals: ['beautician_id', 'referrer_id'],
  client_memberships: ['beautician_id', 'name', 'price_cents'],
  membership_subscriptions: ['beautician_id', 'client_id', 'membership_id'],
  portal_settings: ['beautician_id'],
  campaigns: ['beautician_id', 'type', 'name', 'message_template'],
  client_tag_assignments: ['client_id', 'tag_id'],
};

/** CHECK constraints the handlers can now trip, so a bad value is a 400. */
const CHECKS = {
  'policies.type': ['cancellation', 'no_show', 'deposit', 'late', 'health', 'privacy', 'custom'],
  'campaigns.type': ['reactivation', 'rescue', 'weather', 'bank_holiday', 'event', 'custom'],
  'referrals.status': ['pending', 'booked', 'completed', 'rewarded'],
};

const RELATIONS = {
  client_packages: {
    packages: { table: 'packages', fk: 'package_id' },
    clients: { table: 'clients', fk: 'client_id' },
  },
  membership_subscriptions: {
    clients: { table: 'clients', fk: 'client_id' },
    client_memberships: { table: 'client_memberships', fk: 'membership_id' },
  },
};

const db = {};
const TABLES = [
  ...Object.keys(COLUMNS), 'beauticians', 'appointments',
];
const reset = () => { for (const t of TABLES) db[t] = []; };

let idCounter = 0;
const nextId = (p) => `${p}_${++idCounter}`;

const undefinedColumn = (table, col) => ({
  code: '42703',
  message: `column ${table}.${col} does not exist`,
  details: null, hint: null,
});
const notNull = (table, col) => ({
  code: '23502',
  message: `null value in column "${col}" of relation "${table}" violates not-null constraint`,
  details: null, hint: null,
});
const checkViolation = (table, col) => ({
  code: '23514',
  message: `new row for relation "${table}" violates check constraint "${table}_${col}_check"`,
  details: null, hint: null,
});

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

function parseSelect(table, spec) {
  const embeds = [];
  if (!spec || spec === '*') return { error: null, embeds };
  for (const item of splitTop(spec)) {
    const nested = /^([\w]+)\s*\(([\s\S]*)\)$/.exec(item);
    if (nested) {
      const [, rel, inner] = nested;
      embeds.push(rel);
      const relTable = RELATIONS[table]?.[rel]?.table || rel;
      const known = COLUMNS[relTable];
      if (known) {
        for (const c of splitTop(inner)) {
          const col = c.includes(':') ? c.split(':').pop().trim() : c;
          if (col !== '*' && !known.includes(col)) return { error: undefinedColumn(relTable, col), embeds };
        }
      }
      continue;
    }
    const known = COLUMNS[table];
    if (!known) continue;
    const col = item.includes(':') ? item.split(':').pop().trim() : item;
    if (col === '*') continue;
    if (!known.includes(col)) return { error: undefinedColumn(table, col), embeds };
  }
  return { error: null, embeds };
}

/** What the database does with a row on the way in. */
function validateWrite(table, payload, { isInsert }) {
  const known = COLUMNS[table];
  if (!known) return null;
  for (const col of Object.keys(payload)) {
    if (!known.includes(col)) return undefinedColumn(table, col);
  }
  for (const [key, allowed] of Object.entries(CHECKS)) {
    const [t, col] = key.split('.');
    if (t !== table) continue;
    const value = payload[col];
    if (value !== undefined && value !== null && !allowed.includes(value)) {
      return checkViolation(table, col);
    }
  }
  if (isInsert) {
    for (const col of REQUIRED[table] || []) {
      if (payload[col] === undefined || payload[col] === null) return notNull(table, col);
    }
  }
  return null;
}

function makeBuilder(table) {
  const filters = [];
  let pending = null;
  let embeds = [];
  let selectError = null;
  let filterError = null;

  const known = COLUMNS[table];
  const guardColumn = (c) => {
    if (!filterError && known && !known.includes(c)) filterError = undefinedColumn(table, c);
  };

  const matching = () => (db[table] || []).filter(r => filters.every(f => f(r)));

  const withEmbeds = (rows) => rows.map((r) => {
    const out = { ...r };
    for (const rel of embeds) {
      const cfg = RELATIONS[table]?.[rel];
      if (!cfg) continue;
      out[rel] = (db[cfg.table] || []).find(x => x.id === r[cfg.fk]) || null;
    }
    return out;
  });

  const settle = () => {
    if (filterError) return { data: null, error: filterError };
    if (selectError) return { data: null, error: selectError };

    if (pending?.op === 'insert' || pending?.op === 'upsert') {
      const payloads = Array.isArray(pending.payload) ? pending.payload : [pending.payload];
      const created = [];
      for (const p of payloads) {
        const existing = pending.op === 'upsert'
          ? (db[table] || []).find(r => r.beautician_id === p.beautician_id)
          : null;
        const err = validateWrite(table, p, { isInsert: !existing });
        if (err) return { data: null, error: err };
        if (existing) { Object.assign(existing, p); created.push(existing); continue; }
        const row = { id: nextId(table), created_at: new Date().toISOString(), ...p };
        db[table].push(row);
        created.push(row);
      }
      return { data: withEmbeds(created), error: null };
    }

    if (pending?.op === 'update') {
      const err = validateWrite(table, pending.payload, { isInsert: false });
      if (err) return { data: null, error: err };
      const rows = matching();
      for (const r of rows) Object.assign(r, pending.payload);
      return { data: withEmbeds(rows), error: null };
    }

    if (pending?.op === 'delete') {
      const gone = matching();
      db[table] = (db[table] || []).filter(r => !filters.every(f => f(r)));
      return { data: gone, error: null };
    }

    return { data: withEmbeds(matching()), error: null };
  };

  const b = {
    select(spec = '*') {
      const parsed = parseSelect(table, spec);
      selectError = parsed.error;
      embeds = parsed.embeds;
      return b;
    },
    insert(p) { pending = { op: 'insert', payload: p }; return b; },
    upsert(p) { pending = { op: 'upsert', payload: p }; return b; },
    update(p) { pending = { op: 'update', payload: p }; return b; },
    delete() { pending = { op: 'delete' }; return b; },
    eq(c, v) { guardColumn(c); filters.push(r => r[c] === v); return b; },
    neq(c, v) { guardColumn(c); filters.push(r => r[c] !== v); return b; },
    in(c, v) { guardColumn(c); filters.push(r => v.includes(r[c])); return b; },
    is(c) { guardColumn(c); return b; },
    not(c, op, v) {
      guardColumn(c);
      if (op === 'is' && v === null) filters.push(r => (r[c] ?? null) !== null);
      return b;
    },
    ilike(c, v) {
      guardColumn(c);
      const needle = String(v).replace(/%/g, '').toLowerCase();
      filters.push(r => String(r[c] ?? '').toLowerCase().includes(needle));
      return b;
    },
    gte(c, v) { guardColumn(c); filters.push(r => String(r[c]) >= String(v)); return b; },
    lte(c, v) { guardColumn(c); filters.push(r => String(r[c]) <= String(v)); return b; },
    gt(c, v) { guardColumn(c); filters.push(r => String(r[c]) > String(v)); return b; },
    lt(c, v) { guardColumn(c); filters.push(r => String(r[c]) < String(v)); return b; },
    order(c) { guardColumn(c); return b; },
    limit() { return b; },
    maybeSingle() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    single() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    then(res, rej) { return Promise.resolve(settle()).then(res, rej); },
  };
  return b;
}

vi.mock('../../src/config.js', () => ({ supabase: { from: (t) => makeBuilder(t) } }));
vi.mock('../../src/middleware/auth.js', () => ({ requireAuth: (_q, _s, next) => next() }));
vi.mock('../../src/lib/outbound-guard.js', () => ({ guardedSend: async () => ({ delivered: false, decision: 'block' }) }));
vi.mock('../../src/services/notifications.js', () => ({ sendNudge: async () => ({ skipped: true }) }));
vi.mock('@sentry/node', () => ({ captureMessage: () => {}, captureException: () => {} }));

const featuresRouter = (await import('../../src/routes/features.js')).default;

/** Drive one route handler straight, no HTTP server. */
async function run(method, path, req = {}) {
  const layer = featuresRouter.stack.find(l => l.route?.path === path && l.route.methods[method]);
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
const OTHER = 'b2';

beforeEach(() => {
  reset();
  db.beauticians.push({ id: B }, { id: OTHER });
  db.clients.push(
    { id: 'c1', beautician_id: B, first_name: 'Shauna' },
    { id: 'cX', beautician_id: OTHER, first_name: 'Someone else' },
  );
  db.treatments.push({ id: 't1', beautician_id: B, name: 'Lash Lift', price_cents: 4000 });
});

/* ---------------------------------------------------------------- canary -- */
describe('the fake refuses what PostgREST refuses', () => {
  it('rejects a select naming a column no migration created', async () => {
    const { error } = await makeBuilder('packages').select('id, price');
    expect(error?.code).toBe('42703');
    expect(error.message).toMatch(/packages\.price/);
  });

  it('rejects an insert naming a column no migration created', async () => {
    const { error } = await makeBuilder('add_ons')
      .insert({ beautician_id: B, name: 'x', price_cents: 1, price: 1 }).select();
    expect(error?.code).toBe('42703');
  });

  it('rejects a filter on a column the table does not have', async () => {
    const { error } = await makeBuilder('client_tag_assignments').select('*').eq('beautician_id', B);
    expect(error?.code).toBe('42703');
  });

  it('rejects an insert missing a NOT NULL column with no default', async () => {
    const { error } = await makeBuilder('aftercare_messages')
      .insert({ beautician_id: B, treatment_id: 't1', message: 'hi' }).select();
    expect(error?.code).toBe('23502');
    expect(error.message).toMatch(/"name"/);
  });
});

/* --------------------------------------------------------------- add-ons -- */
describe('POST /add-ons', () => {
  it('creates an add-on instead of 500ing on a phantom price column', async () => {
    const out = await run('post', '/add-ons', { body: { name: 'Lip wax', price_cents: 900 } });
    expect(out.status).toBe(201);
    expect(db.add_ons).toHaveLength(1);
    expect(db.add_ons[0].price_cents).toBe(900);
    expect(db.add_ons[0]).not.toHaveProperty('price');
  });

  it('still accepts the old `price` body field and stores it as pence', async () => {
    const out = await run('post', '/add-ons', { body: { name: 'Brow mask', price: 750 } });
    expect(out.status).toBe(201);
    expect(db.add_ons[0].price_cents).toBe(750);
  });

  it('PATCH no longer writes the phantom column either', async () => {
    await run('post', '/add-ons', { body: { name: 'Lip wax', price_cents: 900 } });
    const out = await run('patch', '/add-ons/:id', {
      params: { id: db.add_ons[0].id }, body: { price: 1100 },
    });
    expect(out.status).toBe(200);
    expect(db.add_ons[0].price_cents).toBe(1100);
    expect(db.add_ons[0]).not.toHaveProperty('price');
  });
});

/* -------------------------------------------------------------- packages -- */
describe('packages', () => {
  it('POST maps price/treatments onto price_cents/treatment_ids', async () => {
    const out = await run('post', '/packages', {
      body: { name: '6 lash infills', price: 24000, treatments: ['t1'] },
    });
    expect(out.status).toBe(201);
    expect(db.packages[0].price_cents).toBe(24000);
    expect(db.packages[0].treatment_ids).toEqual(['t1']);
    expect(db.packages[0]).not.toHaveProperty('price');
    // The external shape she was promised is still what comes back.
    expect(out.body.package.price).toBe(24000);
    expect(out.body.package.treatments).toEqual(['t1']);
  });

  it('GET /client-packages no longer embeds the phantom packages.price', async () => {
    db.packages.push({ id: 'p1', beautician_id: B, name: 'Six pack', price_cents: 24000 });
    db.client_packages.push({ id: 'cp1', beautician_id: B, client_id: 'c1', package_id: 'p1', sessions_total: 6 });
    const out = await run('get', '/client-packages');
    expect(out.status).toBe(200);
    expect(out.body.clientPackages[0].packages.price_cents).toBe(24000);
  });
});

/* ------------------------------------------------------------- aftercare -- */
describe('POST /aftercare-messages', () => {
  it('writes message + send_after_hours, and converts DAYS to HOURS', async () => {
    const out = await run('post', '/aftercare-messages', {
      body: { treatment_id: 't1', message_text: 'Keep them dry for 24h', timing_days: 2 },
    });
    expect(out.status).toBe(201);
    const row = db.aftercare_messages[0];
    expect(row.message).toBe('Keep them dry for 24h');
    expect(row.send_after_hours).toBe(48);
    expect(row).not.toHaveProperty('message_text');
    expect(row).not.toHaveProperty('timing_days');
  });

  it('supplies the NOT NULL name from the treatment it belongs to', async () => {
    await run('post', '/aftercare-messages', {
      body: { treatment_id: 't1', message: 'Aftercare' },
    });
    expect(db.aftercare_messages[0].name).toBe('Lash Lift aftercare');
  });

  it('echoes both spellings back so an existing caller still reads it', async () => {
    const out = await run('post', '/aftercare-messages', {
      body: { treatment_id: 't1', message_text: 'Hi', timing_days: 3 },
    });
    expect(out.body.aftercareMessage.message_text).toBe('Hi');
    expect(out.body.aftercareMessage.timing_days).toBe(3);
  });

  it('PATCH converts days to hours too', async () => {
    await run('post', '/aftercare-messages', { body: { treatment_id: 't1', message: 'Hi' } });
    const out = await run('patch', '/aftercare-messages/:id', {
      params: { id: db.aftercare_messages[0].id }, body: { timing_days: 3 },
    });
    expect(out.status).toBe(200);
    expect(db.aftercare_messages[0].send_after_hours).toBe(72);
  });
});

/* -------------------------------------------------------------- policies -- */
describe('POST /policies', () => {
  it('writes title/content/type', async () => {
    const out = await run('post', '/policies', {
      body: { name: 'Cancellations', policy_text: '48 hours notice.', category: 'cancellation' },
    });
    expect(out.status).toBe(201);
    expect(db.policies[0]).toMatchObject({
      type: 'cancellation', title: 'Cancellations', content: '48 hours notice.',
    });
    expect(out.body.policy.name).toBe('Cancellations');
    expect(out.body.policy.policy_text).toBe('48 hours notice.');
  });

  it('defaults to a type the CHECK constraint actually allows', async () => {
    const out = await run('post', '/policies', { body: { name: 'House rules', policy_text: 'Be kind.' } });
    expect(out.status).toBe(201);
    expect(db.policies[0].type).toBe('custom');
  });

  it('answers a bad category with 400, not a 500 out of the database', async () => {
    const out = await run('post', '/policies', {
      body: { name: 'x', policy_text: 'y', category: 'general' },
    });
    expect(out.status).toBe(400);
    expect(db.policies).toHaveLength(0);
  });
});

/* ------------------------------------------------------- hours exceptions -- */
describe('POST /hours-exceptions', () => {
  it('writes type and derives is_closed', async () => {
    const out = await run('post', '/hours-exceptions', {
      body: { date: '2026-08-31', exception_type: 'closed', details: { reason: 'holiday', note: 'Bank holiday' } },
    });
    expect(out.status).toBe(201);
    expect(db.hours_exceptions[0]).toMatchObject({
      date: '2026-08-31', type: 'closed', is_closed: true, reason: 'holiday', note: 'Bank holiday',
    });
    expect(db.hours_exceptions[0]).not.toHaveProperty('details');
  });

  it('refuses a details key with no column rather than losing the day she blocked', async () => {
    const out = await run('post', '/hours-exceptions', {
      body: { date: '2026-08-31', exception_type: 'closed', details: { colour: 'red' } },
    });
    expect(out.status).toBe(400);
    expect(out.body.error).toMatch(/colour/);
    expect(db.hours_exceptions).toHaveLength(0);
  });

  it('refuses an exception_type the column was never meant to hold', async () => {
    const out = await run('post', '/hours-exceptions', {
      body: { date: '2026-08-31', exception_type: 'bank_holiday' },
    });
    expect(out.status).toBe(400);
  });
});

/* --------------------------------------------------------------- loyalty -- */
describe('loyalty', () => {
  it('POST /loyalty-config renames min_points_redeem to reward_threshold', async () => {
    const out = await run('post', '/loyalty-config', {
      body: { points_per_pound: 2, min_points_redeem: 150 },
    });
    expect(out.status).toBe(201);
    expect(db.loyalty_config[0]).toMatchObject({ points_per_pound: 2, reward_threshold: 150 });
    expect(out.body.loyaltyConfig.min_points_redeem).toBe(150);
  });

  it('refuses redemption_rate loudly rather than dropping it', async () => {
    const out = await run('post', '/loyalty-config', { body: { redemption_rate: 100 } });
    expect(out.status).toBe(400);
    expect(out.body.error).toMatch(/redemption_rate/);
    expect(db.loyalty_config).toHaveLength(0);
  });

  it('POST /loyalty-points drops transaction_date and keeps the balance honest', async () => {
    db.loyalty_points.push({
      id: 'lp0', beautician_id: B, client_id: 'c1', points: 40,
      reason: 'appointment', balance_after: 40,
    });
    const out = await run('post', '/loyalty-points', {
      body: { client_id: 'c1', points: 25 },
    });
    expect(out.status).toBe(201);
    const row = db.loyalty_points[1];
    expect(row).not.toHaveProperty('transaction_date');
    expect(row.points).toBe(25);
    expect(row.balance_after).toBe(65);
  });
});

/* ------------------------------------------------------------- referrals -- */
describe('POST /referrals', () => {
  beforeEach(() => { db.clients.push({ id: 'c2', beautician_id: B, first_name: 'Daisy' }); });

  it('writes referrer_id / referred_id, not the client_id spellings', async () => {
    const out = await run('post', '/referrals', {
      body: { referrer_client_id: 'c1', referred_client_id: 'c2', reward: 500 },
    });
    expect(out.status).toBe(201);
    expect(db.referrals[0]).toMatchObject({
      referrer_id: 'c1', referred_id: 'c2', referrer_reward_cents: 500, status: 'pending',
    });
    expect(db.referrals[0]).not.toHaveProperty('reward');
    expect(out.body.referral.referrer_client_id).toBe('c1');
    expect(out.body.referral.reward).toBe(500);
  });

  it('refuses a free-text reward instead of dropping it', async () => {
    const out = await run('post', '/referrals', {
      body: { referrer_client_id: 'c1', referred_client_id: 'c2', reward: 'a free lash lift' },
    });
    expect(out.status).toBe(400);
    expect(db.referrals).toHaveLength(0);
  });

  it("still refuses another salon's client", async () => {
    const out = await run('post', '/referrals', {
      body: { referrer_client_id: 'c1', referred_client_id: 'cX' },
    });
    expect(out.status).toBe(404);
  });
});

/* ----------------------------------------------------------- memberships -- */
describe('memberships', () => {
  it('POST /client-memberships creates a PLAN', async () => {
    const out = await run('post', '/client-memberships', {
      body: { name: 'Brow club', price_cents: 2500, benefits: [{ type: 'discount', value: 10 }] },
    });
    expect(out.status).toBe(201);
    expect(db.client_memberships[0]).toMatchObject({ name: 'Brow club', price_cents: 2500 });
  });

  it('POST /client-memberships sends an enrolment to the right endpoint instead of dropping it', async () => {
    const out = await run('post', '/client-memberships', {
      body: { client_id: 'c1', membership_id: 'm1' },
    });
    expect(out.status).toBe(400);
    expect(out.body.error).toMatch(/membership-subscriptions/);
    expect(db.client_memberships).toHaveLength(0);
  });

  it('POST /membership-subscriptions writes membership_id/status/next_billing_at and the NOT NULL client_id', async () => {
    db.client_memberships.push({ id: 'm1', beautician_id: B, name: 'Brow club', price_cents: 2500 });
    const out = await run('post', '/membership-subscriptions', {
      body: {
        client_id: 'c1',
        client_membership_id: 'm1',
        subscription_status: 'active',
        next_billing_date: '2026-09-23T00:00:00.000Z',
      },
    });
    expect(out.status).toBe(201);
    expect(db.membership_subscriptions[0]).toMatchObject({
      client_id: 'c1', membership_id: 'm1', status: 'active',
      next_billing_at: '2026-09-23T00:00:00.000Z',
    });
    expect(out.body.membershipSubscription.subscription_status).toBe('active');
    expect(out.body.membershipSubscription.next_billing_date).toBe('2026-09-23T00:00:00.000Z');
  });

  it('POST /membership-subscriptions refuses to enrol nobody', async () => {
    db.client_memberships.push({ id: 'm1', beautician_id: B, name: 'Brow club', price_cents: 2500 });
    const out = await run('post', '/membership-subscriptions', { body: { client_membership_id: 'm1' } });
    expect(out.status).toBe(400);
  });
});

/* ------------------------------------------------------- portal settings -- */
describe('POST /portal-settings', () => {
  it('renames show_online_booking to allow_self_booking', async () => {
    const out = await run('post', '/portal-settings', { body: { show_online_booking: false } });
    expect(out.status).toBe(201);
    expect(db.portal_settings[0].allow_self_booking).toBe(false);
    expect(out.body.portalSettings.show_online_booking).toBe(false);
  });

  it('names the fields that have no column instead of throwing them away', async () => {
    const out = await run('post', '/portal-settings', { body: { theme: 'dark' } });
    expect(out.status).toBe(400);
    expect(out.body.error).toMatch(/theme/);
    expect(db.portal_settings).toHaveLength(0);
  });
});

/* ------------------------------------------------------------- campaigns -- */
describe('POST /campaigns', () => {
  it('writes type + message_template, which is what the send handler reads', async () => {
    const out = await run('post', '/campaigns', {
      body: { name: 'August comeback', campaign_type: 'reactivation', content: 'Hi {name}, fancy a catch up?' },
    });
    expect(out.status).toBe(201);
    expect(db.campaigns[0]).toMatchObject({
      type: 'reactivation', message_template: 'Hi {name}, fancy a catch up?',
    });
    expect(db.campaigns[0]).not.toHaveProperty('campaign_type');
    expect(out.body.campaign.campaign_type).toBe('reactivation');
    expect(out.body.campaign.content).toBe('Hi {name}, fancy a catch up?');
  });

  it('refuses a type the CHECK constraint would reject', async () => {
    const out = await run('post', '/campaigns', {
      body: { name: 'x', campaign_type: 'newsletter', content: 'hi' },
    });
    expect(out.status).toBe(400);
    expect(db.campaigns).toHaveLength(0);
  });

  it('refuses an object where the NOT NULL message text belongs', async () => {
    const out = await run('post', '/campaigns', {
      body: { name: 'x', campaign_type: 'custom', content: { body: 'hi' } },
    });
    expect(out.status).toBe(400);
  });
});

/* -------------------------------------------------- client tag assignments -- */
describe('client tag assignments', () => {
  beforeEach(() => {
    db.client_tags.push(
      { id: 'tag1', beautician_id: B, name: 'VIP' },
      { id: 'tagX', beautician_id: OTHER, name: 'Theirs' },
    );
    db.client_tag_assignments.push(
      { id: 'a1', client_id: 'c1', tag_id: 'tag1' },
      { id: 'aX', client_id: 'cX', tag_id: 'tagX' },
    );
  });

  it('GET no longer filters on a beautician_id this table does not have', async () => {
    const out = await run('get', '/client-tag-assignments');
    expect(out.status).toBe(200);
    expect(out.body.clientTagAssignments.map(a => a.id)).toEqual(['a1']);
  });

  it("GET by client_id still refuses another salon's client", async () => {
    const out = await run('get', '/client-tag-assignments', { query: { client_id: 'cX' } });
    expect(out.status).toBe(404);
  });

  it('DELETE removes her own assignment', async () => {
    const out = await run('delete', '/client-tag-assignments/:id', { params: { id: 'a1' } });
    expect(out.status).toBe(200);
    expect(db.client_tag_assignments.map(a => a.id)).toEqual(['aX']);
  });

  it('DELETE will not reach across into another salon', async () => {
    const out = await run('delete', '/client-tag-assignments/:id', { params: { id: 'aX' } });
    expect(out.status).toBe(404);
    expect(db.client_tag_assignments).toHaveLength(2);
  });
});
