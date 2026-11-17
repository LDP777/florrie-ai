import { readAuthenticatedJson } from './authenticated-json.js';

export async function boundedMoneyRequest(work, { timeoutMs = 20000 } = {}) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() => work(controller.signal)),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('This is taking too long. Check your connection and try again.')); }, timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

export function moneyApi({ auth, url, options = {}, request = fetch }) {
  if (!options.method || options.method === 'GET') return readAuthenticatedJson({ auth, url });
  // A financial write is never replayed after a 401 or an uncertain response.
  return boundedMoneyRequest(async signal => {
    const session = await auth.getSession();
    if (signal.aborted) throw new Error('Request expired');
    if (!session.data?.session?.access_token || session.error) throw new Error('Please sign in again before saving.');
    const response = await request(url, { ...options, signal, headers: { 'Content-Type': 'application/json', ...options.headers, Authorization: `Bearer ${session.data.session.access_token}` } });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error || 'Could not save this change. Please try again.');
    return body;
  });
}

// Keep the same UUID after a lost response. A retry reads back the original
// entry instead of creating a second tip, sale or expense.
export async function saveMoneyEntry({ db, table, row, timeoutMs = 20000 }) {
  return boundedMoneyRequest(async signal => {
    const query = db.from(table).insert(row);
    const { data, error } = await query.select().single().abortSignal(signal);
    if (!error && data?.id) return data;
    if (error?.code === '23505') {
      const read = await db.from(table).select('*').eq('id', row.id).eq('beautician_id', row.beautician_id).single().abortSignal(signal);
      if (!read.error && read.data && Object.keys(row).every(key => read.data[key] === row[key])) return read.data;
      throw new Error('The earlier entry may already be saved. Refresh your records before adding it again.');
    }
    throw new Error(error?.message || 'The save was not confirmed. Refresh your records before adding it again.');
  }, { timeoutMs });
}
