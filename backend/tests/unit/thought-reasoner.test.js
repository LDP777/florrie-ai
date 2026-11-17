import { expect, it, vi } from 'vitest';
import { createThoughtReasoner } from '../../src/services/thought-reasoner.js';
const owner = { id: 'salon' }, cards = [{ id: 'holiday', type: 'holiday_habit', summary: 'Two recorded bank holidays off.', evidence: { facts: ['Two explicit closures'] }, action: { kind: 'protect_time', date: '2026-12-25' } }];
const good = { thoughts: [{ id: 'holiday', reason: 'Would you like to protect the next one too?', related_ids: [] }] };
it('returns facts immediately, adds only reviewed thinking, and caches separately for each salon', async () => {
  const generate = vi.fn(async () => good), review = vi.fn(async () => ({ supported: true }));
  const enrich = createThoughtReasoner({ generate, review, enabled: () => true });
  expect(enrich(owner, cards)).toMatchObject({ thinking: true, cards });
  await enrich.wait(owner.id);
  expect(enrich(owner, cards).cards[0].consideration).toBe(good.thoughts[0].reason);
  expect(generate).toHaveBeenCalledTimes(1);
  enrich({ id: 'different' }, cards); await enrich.wait('different');
  expect(generate).toHaveBeenCalledTimes(2);
});
it.each([
  [{ thoughts: [{ ...good.thoughts[0], id: 'invented' }] }, true],
  [{ thoughts: [{ ...good.thoughts[0], related_ids: ['invented'] }] }, true],
  [good, false],
])('keeps the checked facts if generated advice is unsupported', async (output, supported) => {
  const enrich = createThoughtReasoner({ generate: async () => output, review: async () => ({ supported }), enabled: () => true });
  enrich(owner, cards); await enrich.wait(owner.id);
  expect(enrich(owner, cards)).toEqual({ cards, thinking: false });
});
it('never attaches an old interpretation after its summary or evidence changes', async () => {
  let time = 0;
  const generate = vi.fn(async () => good);
  const enrich = createThoughtReasoner({ generate, enabled: () => true, now: () => time });
  enrich(owner, cards); await enrich.wait(owner.id);
  const changed = [{ ...cards[0], summary: 'A booking now exists on that day.' }];
  expect(enrich(owner, changed).cards).toEqual(changed);
  time = 180001; enrich(owner, changed); await enrich.wait(owner.id);
  expect(generate).toHaveBeenCalledTimes(2);
});
it('does not call a provider when AI is unavailable', () => {
  const generate = vi.fn(); const enrich = createThoughtReasoner({ generate, enabled: () => false });
  expect(enrich(owner, cards)).toEqual({ cards, thinking: false }); expect(generate).not.toHaveBeenCalled();
});
