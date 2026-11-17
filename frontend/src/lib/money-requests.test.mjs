import test from 'node:test';
import assert from 'node:assert/strict';
import { boundedMoneyRequest, moneyApi, saveMoneyEntry } from './money-requests.js';
import { parseMoneyInput } from './money-view.js';

const session = { data: { session: { access_token: 'fictional-token' } } };

test('manual money accepts pennies, rejects negative, malformed and fractional-penny amounts', () => {
  for (const [input, cents] of [['0.01', 1], [' 12.30 ', 1230], ['5', 500], ['10.29', 1029]]) assert.equal(parseMoneyInput(input), cents);
  for (const input of ['', '-1', '0', 'NaN', 'Infinity', '1e3', '1.001', '1,000', '1000000.01']) assert.throws(() => parseMoneyInput(input));
});

test('a timed-out operation aborts its request and does not hang the form', async () => {
  let signal;
  await assert.rejects(boundedMoneyRequest(s => { signal = s; return new Promise(() => {}); }, { timeoutMs: 5 }), /taking too long/);
  assert.equal(signal.aborted, true);
});

test('financial writes do not retry a 401 or a lost response', async () => {
  for (const fail of ['unauthorized', 'network']) {
    let sends = 0;
    const auth = { getSession: async () => session, refreshSession: () => assert.fail('A financial write must not refresh and replay') };
    await assert.rejects(moneyApi({ auth, url: 'https://fictional.test/write', options: { method: 'POST', body: '{}' }, request: async (url, options) => {
      sends++; assert.equal(options.headers.Authorization, 'Bearer fictional-token');
      if (fail === 'network') throw new Error('Connection lost');
      return new Response('{"error":"Please sign in"}', { status: 401 });
    } }));
    assert.equal(sends, 1);
  }
});

function memoryDb() {
  const rows = new Map(), reads = [];
  let loseResponse = true;
  return { rows, reads, db: { from(table) {
    let row, mode = 'read', filters = {};
    const q = {
      insert(value) { row = structuredClone(value); mode = 'insert'; return q; },
      select() { return q; }, single() { return q; },
      eq(key, value) { filters[key] = value; return q; },
      abortSignal() {
        if (mode === 'insert') {
          if (rows.has(row.id)) return Promise.resolve({ error: { code: '23505' } });
          rows.set(row.id, { ...row, created_at: '2026-11-17T12:00:00Z' });
          if (loseResponse) { loseResponse = false; return Promise.reject(new Error('Response lost after save')); }
        }
        reads.push({ table, filters });
        const data = rows.get(filters.id);
        return Promise.resolve({ data: data && data.beautician_id === filters.beautician_id ? data : null });
      },
    }; return q;
  } } };
}

test('retry after a lost response recovers the same owner-scoped entry without duplication', async () => {
  const { db, rows, reads } = memoryDb();
  const row = { id: 'entry-1', beautician_id: 'salon-1', amount_cents: 500, type: 'tip', status: 'completed' };
  await assert.rejects(saveMoneyEntry({ db, table: 'transactions', row }), /Response lost/);
  const result = await saveMoneyEntry({ db, table: 'transactions', row });
  assert.equal(result.amount_cents, 500); assert.equal(rows.size, 1);
  assert.deepEqual(reads, [{ table: 'transactions', filters: { id: row.id, beautician_id: row.beautician_id } }]);
  await assert.rejects(saveMoneyEntry({ db, table: 'transactions', row: { ...row, amount_cents: 700 } }), /earlier entry may already be saved/);
  await assert.rejects(saveMoneyEntry({ db, table: 'transactions', row: { ...row, beautician_id: 'salon-2' } }), /earlier entry may already be saved/);
  assert.equal(rows.get(row.id).amount_cents, 500); assert.equal(rows.size, 1);
});
