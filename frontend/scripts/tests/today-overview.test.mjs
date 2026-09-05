import { test } from 'node:test';
import assert from 'node:assert/strict';
import { salonClock, todayOverview, decisionOverview } from '../../src/lib/today-overview.js';

const clock = { date: '2026-09-05', time: '10:00' };
const appointment = (id, time, status = 'confirmed', extra = {}) => ({
  id, starts_at: `2026-09-05T${time}:00Z`, status, price_cents: 3000, ...extra,
});

test('uses salon time through British summer time and date rollover', () => {
  assert.deepEqual(salonClock(new Date('2026-09-05T09:00:00Z')), clock);
  assert.deepEqual(salonClock(new Date('2026-09-05T23:30:00Z')), { date: '2026-09-06', time: '00:30' });
  assert.deepEqual(salonClock(new Date('2026-01-05T09:00:00Z')), { date: '2026-01-05', time: '09:00' });
  assert.deepEqual(salonClock(new Date('2026-09-05T09:00:00Z'), 'invalid'), clock);
});

test('keeps stored wall times and prefers the current appointment', () => {
  const rows = [appointment('next', '11:00'), appointment('current', '09:30', 'confirmed', { ends_at: '2026-09-05T10:30:00Z' })];
  const day = todayOverview(rows, clock);
  assert.equal(day.focus.id, 'current');
  assert.equal(day.next.id, 'next');
  assert.deepEqual(rows.map(a => a.id), ['next', 'current']);
});

test('excludes cancelled, pending and completed bookings from the next client', () => {
  const day = todayOverview([
    appointment('cancelled', '10:00', 'cancelled'),
    appointment('pending', '10:15', 'pending_deposit'),
    appointment('completed', '10:30', 'completed'),
    appointment('next', '11:00'),
    appointment('tomorrow', '00:00', 'confirmed', { starts_at: '2026-09-06T00:00:00Z' }),
  ], clock);
  assert.equal(day.focus.id, 'next');
  assert.equal(day.diary.length, 2);
  assert.equal(day.pending, 1);
  assert.equal(day.completedValue, 3000);
  assert.equal(day.potentialValue, 9000);
});

test('distinguishes an empty day from a finished diary', () => {
  const empty = todayOverview([], clock);
  const finished = todayOverview([appointment('done', '09:00', 'completed')], clock);
  assert.equal(empty.focus, null);
  assert.equal(empty.diary.length, 0);
  assert.equal(finished.focus, null);
  assert.equal(finished.completed, 1);
});

test('respects recorded zero prices and excludes no-shows from totals', () => {
  const day = todayOverview([
    appointment('free', '11:00', 'confirmed', { price_cents: 0, treatments: { price_cents: 5000 } }),
    appointment('fallback', '12:00', 'confirmed', { price_cents: null, treatments: { price_cents: 1250 } }),
    appointment('absent', '09:00', 'no_show'),
  ], clock);
  assert.equal(day.potentialValue, 1250);
  assert.equal(day.needsPrice, 1);
});

test('counts only escalations with drafts and never interprets missing queues as clear', () => {
  const holds = { pending: [{ id: 'p1', body: 'A draft' }] };
  const escalations = { escalations: [{ id: 'e1', ai_response: 'Another draft' }, { id: 'e2', ai_response: '   ' }] };
  assert.deepEqual(decisionOverview(holds, escalations).map(i => i.draft), ['A draft', 'Another draft']);
  assert.deepEqual(decisionOverview({ pending: [] }, { escalations: [] }), []);
  assert.throws(() => decisionOverview(holds, {}));
  assert.throws(() => decisionOverview(null, escalations));
});
