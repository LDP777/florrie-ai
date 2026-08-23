/**
 * THE SAME CLOSURE, ENTERED THROUGH THE OTHER DOOR.
 *
 * Two routes write hours_exceptions:
 *
 *   POST /api/hours-exceptions          (routes/hours-exceptions.js)
 *   POST /api/features/hours-exceptions (routes/features.js)
 *
 * A closure is a RANGE, date..end_date. lib/free-slots.js blockEndDate falls
 * back to `date` when end_date does not read as a later day, so a holiday
 * entered end-first, 30 Aug to 24 Aug, closes exactly one day and leaves the
 * other six bookable on the public page. Ellie finds out when a client turns
 * up while she is away. Commit ede39ba closed that on the first route and left
 * the second one wide open, writing the same two columns to the same table.
 *
 * The check is one exported function now, so the two doors cannot drift again.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const db = { hours_exceptions: [] };
let idCounter = 0;

function makeBuilder(table) {
  const filters = [];
  let pending = null;
  const matching = () => (db[table] || []).filter(r => filters.every(f => f(r)));
  const settle = () => {
    if (pending?.op === 'insert') {
      const payload = Array.isArray(pending.payload) ? pending.payload : [pending.payload];
      const created = payload.map(p => ({ id: `he_${++idCounter}`, ...p }));
      db[table].push(...created);
      return { data: created, error: null };
    }
    if (pending?.op === 'delete') {
      const gone = matching();
      db[table] = (db[table] || []).filter(r => !filters.every(f => f(r)));
      return { data: gone, error: null };
    }
    return { data: matching(), error: null };
  };
  const b = {
    select() { return b; },
    insert(p) { pending = { op: 'insert', payload: p }; return b; },
    update(p) { pending = { op: 'update', payload: p }; return b; },
    delete() { pending = { op: 'delete' }; return b; },
    eq(c, v) { filters.push(r => r[c] === v); return b; },
    gte(c, v) { filters.push(r => String(r[c]) >= String(v)); return b; },
    lte(c, v) { filters.push(r => String(r[c]) <= String(v)); return b; },
    order() { return b; },
    limit() { return b; },
    maybeSingle() { const o = settle(); return Promise.resolve({ data: (o.data || [])[0] || null, error: o.error }); },
    single() { const o = settle(); return Promise.resolve({ data: (o.data || [])[0] || null, error: o.error }); },
    then(res, rej) { return Promise.resolve(settle()).then(res, rej); },
  };
  return b;
}

vi.mock('../../src/config.js', () => ({ supabase: { from: (t) => makeBuilder(t) } }));
vi.mock('../../src/lib/logger.js', () => ({
  default: { info() {}, warn() {}, error() {}, debug() {}, fatal() {}, child() { return this; } },
}));
vi.mock('../../src/middleware/auth.js', () => ({
  requireAuth: (req, _res, next) => { req.beautician = { id: 'b1' }; next(); },
  requireAdmin: (_req, _res, next) => next(),
}));
vi.mock('@sentry/node', () => ({ captureMessage: () => {}, captureException: () => {} }));

const featuresRouter = (await import('../../src/routes/features.js')).default;
const { exceptionRangeError } = await import('../../src/routes/features.js');

async function run(router, method, path, req) {
  const layer = router.stack.find(l => l.route?.path === path && l.route.methods[method]);
  if (!layer) throw new Error(`no ${method} ${path}`);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const out = { status: 200, body: null };
  const res = {
    status(c) { out.status = c; return res; },
    json(p) { out.body = p; return res; },
    send(p) { out.body = p; return res; },
  };
  await handler({ headers: {}, query: {}, body: {}, params: {}, beautician: { id: 'b1' }, ...req }, res);
  return out;
}

beforeEach(() => { db.hours_exceptions = []; idCounter = 0; });

describe('POST /api/features/hours-exceptions', () => {
  it('refuses a range whose end is before its start', async () => {
    const out = await run(featuresRouter, 'post', '/hours-exceptions', {
      body: { date: '2026-08-30', type: 'closed', reason: 'holiday', end_date: '2026-08-24' },
    });

    expect(out.status).toBe(400);
    expect(out.body.error).toMatch(/end_date cannot be before date/i);
    expect(db.hours_exceptions, 'six bookable days inside a closure she thinks she took')
      .toHaveLength(0);
  });

  it('refuses it through the details bag as well, which is the shape the app sends', async () => {
    const out = await run(featuresRouter, 'post', '/hours-exceptions', {
      body: {
        date: '2026-08-30', exception_type: 'closed',
        details: { end_date: '2026-08-24', reason: 'holiday' },
      },
    });

    expect(out.status).toBe(400);
    expect(db.hours_exceptions).toHaveLength(0);
  });

  it('still stores a range the right way round', async () => {
    const out = await run(featuresRouter, 'post', '/hours-exceptions', {
      body: { date: '2026-08-24', type: 'closed', reason: 'holiday', end_date: '2026-08-30' },
    });

    expect(out.status).toBe(201);
    expect(db.hours_exceptions[0]).toMatchObject({
      date: '2026-08-24', end_date: '2026-08-30', is_closed: true,
    });
  });

  it('still stores a single day, which is not a range at all', async () => {
    const out = await run(featuresRouter, 'post', '/hours-exceptions', {
      body: { date: '2026-08-24', type: 'closed', reason: 'sick' },
    });

    expect(out.status).toBe(201);
    expect(db.hours_exceptions[0].end_date).toBeUndefined();
  });

  it('treats a blank end_date as a single day rather than writing an empty date', async () => {
    const out = await run(featuresRouter, 'post', '/hours-exceptions', {
      body: { date: '2026-08-24', type: 'closed', reason: 'sick', end_date: '' },
    });

    expect(out.status).toBe(201);
    expect(db.hours_exceptions[0].end_date).toBeUndefined();
  });

  it('accepts a one day range where end and start are the same day', async () => {
    const out = await run(featuresRouter, 'post', '/hours-exceptions', {
      body: { date: '2026-08-24', type: 'closed', reason: 'sick', end_date: '2026-08-24' },
    });
    expect(out.status).toBe(201);
  });
});

describe('the check itself, so both doors can share it', () => {
  it('names the fault the same way the other route does', () => {
    expect(exceptionRangeError('2026-08-30', '2026-08-24')).toBe('end_date cannot be before date');
  });

  it('passes anything that is not a backwards range', () => {
    expect(exceptionRangeError('2026-08-24', '2026-08-30')).toBeNull();
    expect(exceptionRangeError('2026-08-24', '2026-08-24')).toBeNull();
    expect(exceptionRangeError('2026-08-24', null)).toBeNull();
    expect(exceptionRangeError('2026-08-24', '')).toBeNull();
    expect(exceptionRangeError('2026-08-24', '  ')).toBeNull();
  });

  it('ignores the whitespace a date picker leaves behind', () => {
    expect(exceptionRangeError('2026-08-30', ' 2026-08-24 ')).toBe('end_date cannot be before date');
  });
});
