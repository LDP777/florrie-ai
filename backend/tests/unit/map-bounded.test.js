import { it, expect } from 'vitest';
import { mapBounded } from '../../src/lib/map-bounded.js';

it('reads concurrently within the limit and preserves client order', async () => {
  let active = 0, peak = 0;
  const release = [];
  const result = mapBounded(['a', 'b', 'c'], 2, async value => {
    active++; peak = Math.max(peak, active);
    await new Promise(resolve => release.push(resolve));
    active--; return value;
  });
  expect(active).toBe(2);
  release[1]();
  await new Promise(resolve => setTimeout(resolve, 0));
  expect(release).toHaveLength(3);
  release[2](); release[0]();
  expect(await result).toEqual(['a', 'b', 'c']);
  expect(peak).toBe(2);
});

it('propagates a failed read and handles an empty diary', async () => {
  await expect(mapBounded([1], 6, async () => { throw new Error('read failed'); })).rejects.toThrow('read failed');
  expect(await mapBounded([], 6, () => { throw new Error('should not read'); })).toEqual([]);
});
