/** Small tenant-scoped cache. Pending reads coalesce; failures are never retained. */
export function briefCache(load, { ttlMs = 30000, maxEntries = 100 } = {}) {
  const entries = new Map();
  function get(owner) {
    const key = `${owner.id}:${owner.timezone || 'Europe/London'}`;
    const previous = entries.get(key);
    if (previous && previous.expires > Date.now()) return previous.promise;
    if (entries.size >= maxEntries) entries.delete(entries.keys().next().value);
    const entry = { expires: Date.now() + ttlMs };
    entry.promise = Promise.resolve().then(() => load(owner)).catch(error => {
      if (entries.get(key) === entry) entries.delete(key);
      throw error;
    });
    entries.set(key, entry);
    return entry.promise;
  }
  get.invalidate = id => { for (const key of entries.keys()) if (key.startsWith(`${id}:`)) entries.delete(key); };
  return get;
}
