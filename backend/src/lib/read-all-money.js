// Query factories preserve tenant filters and stable ordering on every page.
// Exact counts detect early truncation and concurrent edits instead of quietly
// publishing a partial financial total. No result is returned on partial failure.
export async function readAllMoney(query, { pageSize = 500, maxRows = 100000 } = {}) {
  const rows = [], seen = new Set();
  let expected;
  while (true) {
    const { data, error, count } = await query().range(rows.length, rows.length + pageSize - 1);
    if (error) throw error;
    if (!Array.isArray(data) || !Number.isInteger(count)) throw new Error('Could not verify the complete money records');
    if (expected === undefined) expected = count;
    if (count !== expected) throw new Error('Money records changed while loading. Please refresh.');
    if (count > maxRows) throw new Error('Too many money records to load safely. Please contact support.');
    for (const r of data) {
      if (!r.id || seen.has(r.id)) throw new Error('Money records changed while loading. Please refresh.');
      seen.add(r.id); rows.push(r);
    }
    if (rows.length === count) return rows;
    if (!data.length || rows.length > count) throw new Error('Money records were incomplete. Please refresh.');
  }
}
