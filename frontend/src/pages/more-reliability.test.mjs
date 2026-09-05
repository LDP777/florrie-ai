import test from 'node:test';
import assert from 'node:assert/strict';
import { rebookClients, voucherIsActive, successfulBatchIds } from './more-reliability.js';

test('rebooking uses completed visit dates, never creation or cancelled/future visits', () => {
  const rows = [{ id: 'a', first_name: 'A', phone: '123', appointments: [
    { status: 'cancelled', starts_at: '2026-09-04', treatment_name: 'Cancelled' },
    { status: 'completed', starts_at: '2026-08-01T14:00:00Z', created_at: '2026-09-04', treatments: { name: 'Brows' } },
    { status: 'completed', starts_at: '2026-07-01T14:00:00Z' },
    { status: 'completed', starts_at: '2026-12-01T14:00:00Z' },
  ] }];
  const [client] = rebookClients(rows, '2026-09-05');
  assert.equal(client.lastVisit, '2026-08-01');
  assert.equal(client.avgInterval, 31);
  assert.equal(client.treatment, 'Brows');
  assert.equal(client.status, 'overdue');
  assert.equal(client.phone, true);
});

test('no visit, archived and opted-out clients do not enter rebook queue', () => {
  const visit = [{ status: 'completed', starts_at: '2026-01-01' }];
  assert.deepEqual(rebookClients([{ appointments: [] }, { appointments: visit, archived_at: '2026-08-01' }, { appointments: visit, marketing_opted_out_at: '2026-08-01' }], '2026-09-05'), []);
});

test('expired and redeemed vouchers cannot be redeemed', () => {
  const now = Date.parse('2026-09-05T12:00:00Z');
  assert.equal(voucherIsActive({ status: 'active', expires_at: '2026-09-05T12:00:00Z' }, now), false);
  assert.equal(voucherIsActive({ status: 'redeemed' }, now), false);
  assert.equal(voucherIsActive({ status: 'active', expires_at: '2026-09-06' }, now), true);
});

test('batch preserves HTTP failures, explicit failures and network failures', async () => {
  const items = [1, 2, 3, 4].map(id => ({ id }));
  const ids = await successfulBatchIds(items, async item => {
    if (item.id === 4) throw new Error('offline');
    return { ok: item.id !== 2, json: async () => item.id === 3 ? { success: false } : {} };
  });
  assert.deepEqual(ids, [1]);
});
