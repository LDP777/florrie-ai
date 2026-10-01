import { beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({ rows: {}, errors: {}, queries: [], writes: [] }));

vi.mock('../../src/config.js', () => ({
  supabase: {
    from(table) {
      const query = { table, filters: [], columns: null };
      db.queries.push(query);
      const builder = {
        select(columns) { query.columns = columns; return builder; },
        eq(column, value) { query.filters.push(['eq', column, value]); return builder; },
        in(column, values) { query.filters.push(['in', column, values]); return builder; },
        gt(column, value) { query.filters.push(['gt', column, value]); return builder; },
        order(column, options) { query.order = [column, options]; return builder; },
        limit(value) { query.limit = value; return builder; },
        maybeSingle() { query.single = true; return builder; },
        insert(value) { db.writes.push(['insert', table, value]); throw new Error('Unexpected write'); },
        update(value) { db.writes.push(['update', table, value]); throw new Error('Unexpected write'); },
        delete() { db.writes.push(['delete', table]); throw new Error('Unexpected write'); },
        then(resolve, reject) {
          try {
            if (db.errors[table] instanceof Error) throw db.errors[table];
            let rows = (db.rows[table] || []).filter(row => query.filters.every(([op, column, value]) => {
              if (op === 'eq') return row[column] === value;
              if (op === 'in') return value.includes(row[column]);
              return Number(row[column]) > value;
            }));
            if (query.order) {
              const [column, options] = query.order;
              rows = [...rows].sort((a, b) => String(a[column]).localeCompare(String(b[column])) * (options.ascending ? 1 : -1));
            }
            if (query.limit) rows = rows.slice(0, query.limit);
            if (query.columns) rows = rows.map(row => Object.fromEntries(query.columns.split(',').map(column => [column.trim(), row[column.trim()]])));
            return Promise.resolve({ data: query.single ? (rows[0] || null) : rows, error: db.errors[table] || null }).then(resolve, reject);
          } catch (error) {
            return Promise.reject(error).then(resolve, reject);
          }
        },
      };
      return builder;
    },
  },
}));

vi.mock('../../src/lib/logger.js', () => ({ default: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

import { getOutstandingBalanceCents } from '../../src/services/outstanding-balance.js';

const OWNER = 'salon-one';
const CLIENT = 'client-one';
const empty = () => ({ owesCents: 0, sources: [], reviewCents: 0, reviewSources: [] });
const appointment = (overrides = {}) => ({
  id: 'visit-one', beautician_id: OWNER, client_id: CLIENT,
  status: 'completed', price_cents: 3500, deposit_cents: 700,
  deposit_paid: true, payment_type: 'deposit',
  policy_snapshot: null, policy_fee_charged_at: null, late_cancel_charged: false,
  starts_at: '2026-10-01T12:00:00.000Z', ...overrides,
});
const transaction = (overrides = {}) => ({
  id: 'payment-one', appointment_id: 'visit-one', beautician_id: OWNER,
  type: 'payment', status: 'completed', amount_cents: 2800,
  payment_method: 'cash', stripe_payment_intent_id: null, ...overrides,
});
const balance = () => getOutstandingBalanceCents(OWNER, CLIENT);

beforeEach(() => {
  db.rows = { appointments: [], transactions: [], beauticians: [{ id: OWNER, booking_policy: {} }] };
  db.errors = {};
  db.queries = [];
  db.writes = [];
});

describe('previous-visit balances do not turn missing records into client debt', () => {
  it('does not invent £28 for a £35 fully paid visit when another completed deposit booking exists', async () => {
    db.rows.appointments = [
      appointment({ id: 'paid-in-full', payment_type: 'full' }),
      appointment({ id: 'deposit-visit', starts_at: '2026-09-20T12:00:00.000Z' }),
    ];
    db.rows.transactions = [
      transaction({ appointment_id: 'paid-in-full', type: 'full_payment', amount_cents: 3500 }),
      transaction({ appointment_id: 'deposit-visit' }),
    ];
    expect(await balance()).toEqual(empty());
    const txQuery = db.queries.find(query => query.table === 'transactions');
    expect(txQuery.filters).toContainEqual(['in', 'appointment_id', ['deposit-visit']]);
    expect(db.writes).toEqual([]);
  });

  it('does not review a full-paid visit even if its old receipt is missing and another visit needs review', async () => {
    db.rows.appointments = [appointment({ id: 'paid-in-full', payment_type: 'full' }), appointment()];
    expect(await balance()).toEqual({
      ...empty(), reviewCents: 2800,
      reviewSources: [{ appointment_id: 'visit-one', kind: 'payment_record_missing', cents: 2800, starts_at: '2026-10-01T12:00:00.000Z' }],
    });
  });

  it('does not need a receipt query to recognise a full-paid visit by itself', async () => {
    db.rows.appointments = [appointment({ payment_type: 'full' })];
    expect(await balance()).toEqual(empty());
    expect(db.queries.some(query => query.table === 'transactions')).toBe(false);
  });

  it.each(['payment', 'full_payment', 'payment_link'])('recognises a completed positive %s record', async (type) => {
    db.rows.appointments = [appointment()];
    db.rows.transactions = [transaction({ type })];
    expect(await balance()).toEqual(empty());
    expect(db.writes).toEqual([]);
  });

  it('keeps existing assumed completion takings recorded without asserting they prove cash was received', async () => {
    db.rows.appointments = [appointment()];
    db.rows.transactions = [transaction({ payment_method: null, stripe_payment_intent_id: null })];
    expect(await balance()).toEqual(empty());
    expect(db.writes).toEqual([]);
  });

  it('returns a missing record only for owner review, with its visit date and deposit-adjusted amount', async () => {
    db.rows.appointments = [appointment()];
    expect(await balance()).toEqual({
      owesCents: 0, sources: [], reviewCents: 2800,
      reviewSources: [{ appointment_id: 'visit-one', kind: 'payment_record_missing', cents: 2800, starts_at: '2026-10-01T12:00:00.000Z' }],
    });
    expect(db.writes).toEqual([]);
  });

  it.each([
    { status: 'failed' }, { status: 'pending' }, { status: 'refunded' },
    { amount_cents: 0 }, { amount_cents: -2800 }, { type: 'deposit' }, { type: 'no_show_fee' },
  ])('does not mistake an ineligible transaction for a completed price record: %j', async (overrides) => {
    db.rows.appointments = [appointment()];
    db.rows.transactions = [transaction(overrides)];
    const result = await balance();
    expect(result.owesCents).toBe(0);
    expect(result.sources).toEqual([]);
    expect(result.reviewCents).toBe(2800);
  });

  it('does not let another salon’s transaction clear this salon’s missing-record review', async () => {
    db.rows.appointments = [appointment()];
    db.rows.transactions = [transaction({ beautician_id: 'another-salon' })];
    expect((await balance()).reviewCents).toBe(2800);
    expect(db.queries.find(query => query.table === 'transactions').filters).toContainEqual(['eq', 'beautician_id', OWNER]);
  });

  it('does not include another owner or client’s appointments', async () => {
    db.rows.appointments = [appointment({ beautician_id: 'another-salon' }), appointment({ id: 'other-client-visit', client_id: 'another-client' })];
    expect(await balance()).toEqual(empty());
  });

  it('never creates a negative review amount or treats an unpaid deposit as received', async () => {
    db.rows.appointments = [appointment({ id: 'no-deposit', deposit_paid: false }), appointment({ id: 'covered-by-deposit', deposit_cents: 4000 })];
    const result = await balance();
    expect(result.owesCents).toBe(0);
    expect(result.reviewCents).toBe(3500);
    expect(result.reviewSources.map(source => source.appointment_id)).toEqual(['no-deposit']);
  });
});

describe('eligible policy fees keep their existing behaviour', () => {
  it('keeps unpaid no-show and late-cancel fees separate from missing payment records', async () => {
    db.rows.beauticians[0].booking_policy = { no_show_charge_percent: 100, late_cancel_charge_percent: 50 };
    db.rows.appointments = [
      appointment({ id: 'missed', status: 'no_show' }),
      appointment({ id: 'cancelled', status: 'cancelled', late_cancel_charged: true }),
      appointment(),
    ];
    const result = await balance();
    expect(result.owesCents).toBe(3850);
    expect(result.sources).toEqual([
      { appointment_id: 'missed', kind: 'no_show_fee', cents: 2800 },
      { appointment_id: 'cancelled', kind: 'late_cancel_fee', cents: 1050 },
    ]);
    expect(result.reviewCents).toBe(2800);
    expect(db.writes).toEqual([]);
  });

  it('uses the agreed snapshot, and omits already charged or non-chargeable cancellations', async () => {
    db.rows.beauticians[0].booking_policy = { no_show_charge_percent: 100, late_cancel_charge_percent: 100 };
    db.rows.appointments = [
      appointment({ id: 'snapshot', status: 'no_show', policy_snapshot: { no_show_charge_percent: 50 } }),
      appointment({ id: 'already-charged', status: 'no_show', policy_fee_charged_at: '2026-10-01T13:00:00Z' }),
      appointment({ id: 'timely-cancel', status: 'cancelled' }),
    ];
    expect(await balance()).toEqual({ ...empty(), owesCents: 1050, sources: [{ appointment_id: 'snapshot', kind: 'no_show_fee', cents: 1050 }] });
  });

  it('preserves the existing old-snapshot no-show policy fallback', async () => {
    db.rows.beauticians[0].booking_policy = { no_show_charge_percent: 50 };
    db.rows.appointments = [appointment({ status: 'no_show', policy_snapshot: { late_cancel_charge_percent: 0 } })];
    expect((await balance()).owesCents).toBe(1050);
  });

  it('keeps eligible fees but does not fabricate review items when payment reads fail', async () => {
    db.rows.beauticians[0].booking_policy = { no_show_charge_percent: 100 };
    db.rows.appointments = [appointment({ id: 'missed', status: 'no_show' }), appointment()];
    db.errors.transactions = { message: 'Database temporarily unavailable' };
    expect(await balance()).toEqual({ ...empty(), owesCents: 2800, sources: [{ appointment_id: 'missed', kind: 'no_show_fee', cents: 2800 }] });
  });

  it.each(['appointments', 'beauticians'])('fails open when %s reads fail', async (table) => {
    db.rows.appointments = [appointment()];
    db.errors[table] = { message: 'Database temporarily unavailable' };
    expect(await balance()).toEqual(empty());
  });

  it('fails open on a thrown query error and does nothing without both identifiers', async () => {
    db.errors.appointments = new Error('Connection lost');
    expect(await balance()).toEqual(empty());
    db.queries = [];
    expect(await getOutstandingBalanceCents(null, CLIENT)).toEqual(empty());
    expect(await getOutstandingBalanceCents(OWNER, null)).toEqual(empty());
    expect(db.queries).toEqual([]);
    expect(db.writes).toEqual([]);
  });
});
