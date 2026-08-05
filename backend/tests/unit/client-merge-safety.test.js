/**
 * Merging two client records must never resolve a conflict by deleting money.
 *
 * Charlotte Scott paid GBP 80 in full on 26 July for two treatments at 14:00
 * on 5 August. She turned up. There was no booking. Not cancelled, GONE: the
 * Stripe metadata still names appointment_id 8a7f063b, her client row still
 * exists, and two ai_actions prove the booking was made.
 *
 * We could not prove what deleted it. This loop is the only code in the
 * product that could have done it silently, because it used to answer a unique
 * clash on ANY table by deleting the duplicate's rows in that table, and that
 * list included appointments and transactions. Whether or not it was the
 * culprit, resolving a conflict by deleting somebody's booking or the record
 * of them paying is not a thing we do.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = { updateErrors: {}, deletes: [], updates: [], rows: {} };

function builder(table) {
  const filters = {};
  let op = null;
  const settle = () => {
    if (op === 'update') {
      const err = state.updateErrors[table];
      if (err) return { data: null, error: err };
      state.updates.push(table);
      return { data: [], error: null };
    }
    if (op === 'delete') { state.deletes.push(table); return { data: [], error: null }; }
    return { data: state.rows[table] || [], error: null };
  };
  const b = {
    select() { return b; },
    update() { op = 'update'; return b; },
    delete() { op = 'delete'; return b; },
    insert() { op = 'insert'; return b; },
    eq(c, v) { filters[c] = v; return b; },
    in() { return b; },
    single() { return Promise.resolve(settle()); },
    maybeSingle() { return Promise.resolve(settle()); },
    then(res, rej) { return Promise.resolve(settle()).then(res, rej); },
  };
  return b;
}

vi.mock('../../src/config.js', () => ({ supabase: { from: builder } }));
vi.mock('../../src/middleware/auth.js', () => ({ requireAuth: (req, _res, next) => next() }));
vi.mock('../../src/services/client-intelligence.js', () => ({ refreshAllIntelligence: async () => ({}) }), { virtual: true });

const mod = await import('../../src/routes/clients.js');

/** Drive the merge handler straight, without an HTTP server. */
async function runMerge() {
  const layer = mod.default.stack.find(l => l.route?.path === '/:id/merge' && l.route.methods.post);
  const handler = layer.route.stack[layer.route.stack.length - 1].handle;
  const req = { params: { id: 'primary' }, body: { duplicate_id: 'dupe' }, beautician: { id: 'b1' } };
  let payload = null;
  const res = { status() { return res; }, json(p) { payload = p; return res; } };
  await handler(req, res);
  return payload;
}

beforeEach(() => {
  state.updateErrors = {};
  state.deletes = [];
  state.updates = [];
  state.rows = { clients: [{ id: 'primary', beautician_id: 'b1' }, { id: 'dupe', beautician_id: 'b1' }] };
});

describe('a merge never deletes a booking or a payment', () => {
  it('refuses rather than deleting appointments on a unique clash', async () => {
    state.updateErrors.appointments = { code: '23505', message: 'duplicate key' };
    await runMerge();
    expect(state.deletes, 'the merge deleted appointments').not.toContain('appointments');
  });

  it('refuses rather than deleting transactions on a unique clash', async () => {
    state.updateErrors.transactions = { code: '23505', message: 'duplicate key' };
    await runMerge();
    expect(state.deletes).not.toContain('transactions');
  });

  it('refuses rather than deleting messages, which are evidence', async () => {
    state.updateErrors.messages = { code: '23505', message: 'duplicate key' };
    await runMerge();
    expect(state.deletes).not.toContain('messages');
  });

  // The duplicate's copy of a tag really is redundant, so that one still goes.
  it('still drops a redundant tag assignment', async () => {
    state.updateErrors.client_tag_assignments = { code: '23505', message: 'duplicate key' };
    await runMerge();
    expect(state.deletes).toContain('client_tag_assignments');
  });

  // And when something was refused, the duplicate client must survive, because
  // deleting it is what used to take the appointments down with it.
  it('leaves the duplicate client in place when anything was refused', async () => {
    state.updateErrors.appointments = { code: '23505', message: 'duplicate key' };
    await runMerge();
    expect(state.deletes).not.toContain('clients');
  });
});
