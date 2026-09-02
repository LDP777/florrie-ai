/**
 * Keep a module-scope Map from growing with the customer base.
 *
 * WHY THIS EXISTS
 * Six caches and throttles were plain `new Map()`s at module scope with no
 * eviction at all: payment idempotency keys, the "messages waiting" push
 * throttle, the coach rate limiter, the per-beautician name matcher, and the
 * two WhatsApp catalogue caches. Each is keyed by something that grows with
 * the customer base (a beautician, a phone number, a request body hash), so
 * each is a slow leak that only shows up as a container that gets restarted
 * more and more often as the pilot turns into a hundred salons. The doorstep
 * duplicate suppressor in services/push-notifications.js and the resend claim
 * map in routes/booking.js already had the right shape (prune what has aged
 * out, on write, once the map is worth pruning). These helpers are that shape,
 * written once, so the six sites cannot drift apart.
 *
 * Maps iterate in insertion order, which makes "oldest first" free: the first
 * entry is the one that has been there longest. `touch` re-inserts so an entry
 * that is refreshed moves to the young end rather than being evicted while it
 * is still the one in use.
 */

/**
 * Delete every entry the predicate calls stale. Runs on every call, so gate
 * it behind a size check at the call site if the map is written on a hot
 * path.
 *
 * @param {Map} map
 * @param {(value: any, key: any) => boolean} isStale
 * @returns {number} how many were removed
 */
export function pruneExpired(map, isStale) {
  let removed = 0;
  for (const [key, value] of map) {
    if (isStale(value, key)) {
      map.delete(key);
      removed++;
    }
  }
  return removed;
}

/**
 * Evict the oldest inserted entries until the map holds at most `max`.
 * The hard ceiling behind a TTL prune: a burst inside the TTL window can
 * still not grow the map without limit.
 *
 * @param {Map} map
 * @param {number} max
 * @returns {number} how many were removed
 */
export function capSize(map, max) {
  let removed = 0;
  if (!(max >= 0)) return 0;
  while (map.size > max) {
    const oldest = map.keys().next();
    if (oldest.done) break;
    map.delete(oldest.value);
    removed++;
  }
  return removed;
}

/**
 * `set`, but the entry moves to the young end of the insertion order, so a
 * key that is refreshed is the LAST candidate for capSize, not the first.
 *
 * @param {Map} map
 * @param {any} key
 * @param {any} value
 */
export function touch(map, key, value) {
  map.delete(key);
  map.set(key, value);
  return map;
}
