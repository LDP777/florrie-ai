// Keep independent reads moving without issuing one request per client at once.
export async function mapBounded(items, limit, read) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const index = next++;
      results[index] = await read(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(items.length, Math.max(1, limit)) }, worker));
  return results;
}
