import { expect, it, vi } from 'vitest';
import { createThoughtActions } from '../../src/services/thought-actions.js';
const owner = { id: 'salon' }, now = new Date('2026-11-17T10:00:00Z');
const card = { id: 'holiday-2026-12-25', title: 'Your day off', action: { kind: 'protect_time', date: '2026-12-25', start_time: null, end_time: null, reason: 'bank_holiday', note: 'Christmas Day' } };
function fixture(rows = []) {
  const query = { select: () => query, eq: () => query, in: () => query, lt: () => query, gt: () => query, order: () => query, range: async () => ({ data: rows, count: rows.length }) };
  const db = { from: vi.fn(() => query), rpc: vi.fn(async () => ({ data: { ok: true, block_id: 'block' } })) };
  const candidates = vi.fn(async () => ({ cards: [card] }));
  const actions = createThoughtActions({ db, candidates, secret: () => 'test-only-secret', now: () => now });
  return { actions, db, candidates };
}
it('preparation is read-only; only an owner-bound confirmed preview can protect time', async () => {
  const { actions, db } = fixture();
  const prepared = await actions.prepare(owner, card.id);
  expect(prepared.conflict_count).toBe(0); expect(db.rpc).not.toHaveBeenCalled();
  await expect(actions.execute({ id: 'other' }, prepared.confirmation_token)).rejects.toMatchObject({ status: 403 });
  await expect(actions.execute(owner, prepared.confirmation_token + 'bad')).rejects.toMatchObject({ status: 400 });
  const result = await actions.execute(owner, prepared.confirmation_token);
  expect(result.ok).toBe(true);
  expect(db.rpc).toHaveBeenCalledWith('confirm_suggested_time', expect.objectContaining({ p_owner: 'salon', p_date: '2026-12-25', p_start: null }));
});
it('a conflict removes the confirmation action and never touches existing bookings', async () => {
  const { actions, db } = fixture([{ id: 'booked' }]);
  expect(await actions.prepare(owner, card.id)).toMatchObject({ conflict_count: 1, confirmation_token: null });
  expect(db.rpc).not.toHaveBeenCalled();
});
it('stale cards and expired confirmation are rejected', async () => {
  const { actions, db, candidates } = fixture();
  const prepared = await actions.prepare(owner, card.id);
  candidates.mockResolvedValue({ cards: [] });
  await expect(actions.prepare(owner, card.id)).rejects.toMatchObject({ status: 409 });
  const later = createThoughtActions({ db, candidates, secret: () => 'test-only-secret', now: () => new Date(now.getTime() + 600001) });
  await expect(later.execute(owner, prepared.confirmation_token)).rejects.toMatchObject({ status: 409 });
});
it('a booking arriving after preview produces a conflict, not a false success', async () => {
  const { actions, db } = fixture();
  const prepared = await actions.prepare(owner, card.id);
  db.rpc.mockResolvedValue({ error: { code: '23P01' } });
  await expect(actions.execute(owner, prepared.confirmation_token)).rejects.toMatchObject({ status: 409, message: expect.stringContaining('Nothing was moved') });
  db.rpc.mockResolvedValue({ error: { code: 'timeout' } });
  await expect(actions.execute(owner, prepared.confirmation_token)).rejects.toMatchObject({ status: 503 });
});
it('closure messages are drafts only, selected from freshly read candidate facts', async () => {
  const { db } = fixture(), draft = vi.fn(async () => [{ client_id: 'nora', text: 'A fictional draft' }]);
  const actions = createThoughtActions({ db, draft, candidates: async () => ({ cards: [{ id: 'away', action: { kind: 'return_before_closure' } }] }) });
  expect(await actions.prepare(owner, 'away')).toMatchObject({ kind: 'drafts', drafts: [{ client_id: 'nora' }] });
  expect(draft).toHaveBeenCalledTimes(1); expect(db.rpc).not.toHaveBeenCalled();
});
