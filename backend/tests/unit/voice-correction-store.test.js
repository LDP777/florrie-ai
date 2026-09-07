import { it, expect, vi, beforeEach } from 'vitest';
const state = vi.hoisted(() => ({ profile: null, conflict: false, fail: false, patches: [] }));
vi.mock('../../src/config.js', () => ({ supabase: { from(table) {
  if (table !== 'beauticians') throw new Error('Unexpected table');
  let patch, compare; const filters = []; const q = {};
  for (const method of ['select', 'single']) q[method] = () => q;
  q.eq = (key, value) => { filters.push([key, value]); if (key === 'tone_model') compare = JSON.parse(value); return q; };
  q.is = (key, value) => { if (key === 'tone_model') compare = value; return q; };
  q.update = value => { patch = value; return q; };
  q.then = resolve => {
    if (!patch) return resolve({ data: { tone_model: state.profile }, error: null });
    expect(filters).toContainEqual(['id', 'owner']);
    if (state.fail) return resolve({ data: null, error: { code: 'offline' } });
    if (state.conflict) {
      state.conflict = false;
      state.profile = { corrections: [{ original: 'one', corrected: 'other saved edit' }] };
      return resolve({ data: [], error: null });
    }
    expect(compare).toEqual(state.profile);
    state.patches.push(patch); state.profile = patch.tone_model;
    return resolve({ data: [{ id: 'owner' }], error: null });
  };
  return q;
} } }));
const { learnFromCorrection } = await import('../../src/services/ai-front-desk.js');
beforeEach(() => { state.profile = null; state.conflict = false; state.fail = false; state.patches = []; });
it('saves the first correction and keeps a bounded history', async () => {
  for (let n = 0; n < 22; n++) await learnFromCorrection('owner', 'hello', `hey ${n}`);
  expect(state.profile.corrections).toHaveLength(20);
  expect(state.profile.corrections.at(-1).corrected).toBe('hey 21');
});
it('merges a concurrent saved edit instead of overwriting it', async () => {
  state.conflict = true;
  await learnFromCorrection('owner', 'hello', 'hey lovely xx');
  expect(state.profile.corrections.map(c => c.corrected)).toEqual(['other saved edit', 'hey lovely xx']);
});
it('reports a database failure without pretending the correction was learned', async () => {
  state.fail = true;
  await expect(learnFromCorrection('owner', 'hello', 'hey')).rejects.toThrow('Could not save');
  expect(state.patches).toHaveLength(0);
});
