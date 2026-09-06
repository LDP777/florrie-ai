import { dedupeJsonFetch } from './dedupe-json-fetch.js';

// Session refresh can hold Supabase's auth lock during a network change.
// Share that work across Today cards, but never leave their UI waiting for it.
export function createAuthenticatedJsonReader({ sessionTimeoutMs = 10_000 } = {}) {
  const sessions = new WeakMap();

  function sessionCall(auth, method) {
    let pending = sessions.get(auth);
    if (!pending) { pending = new Map(); sessions.set(auth, pending); }
    if (pending.has(method)) return pending.get(method);
    let timer;
    const work = Promise.race([
      Promise.resolve().then(() => auth[method]()),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Your connection is taking too long. Please try again.')), sessionTimeoutMs);
      }),
    ]).finally(() => {
      clearTimeout(timer);
      if (pending.get(method) === work) pending.delete(method);
    });
    pending.set(method, work);
    return work;
  }

  async function readAuthenticatedJson({ auth, url, request = dedupeJsonFetch }) {
    let session = await sessionCall(auth, 'getSession');
    if (session.error || !session.data?.session?.access_token) {
      throw new Error('Your session is unavailable. Try again or sign in again.');
    }
    const send = token => request(url, { headers: { Authorization: `Bearer ${token}` } });
    let response;
    try {
      response = await send(session.data.session.access_token);
      if (response.status === 401) {
        session = await sessionCall(auth, 'refreshSession');
        if (session.error || !session.data?.session?.access_token) {
          throw new Error('Your session has expired. Sign in again to continue.');
        }
        response = await send(session.data.session.access_token);
      }
    } catch (error) {
      if (error?.name === 'TimeoutError') throw new Error('Your connection is taking too long. Please try again.');
      if (error instanceof TypeError) throw new Error('Could not connect. Check your connection and try again.');
      if (error instanceof SyntaxError) throw new Error('Could not load this section. Please try again.');
      throw error;
    }
    if (!response.ok) {
      const error = new Error(response.status === 401
        ? 'Your session has expired. Sign in again to continue.'
        : 'Could not load this section. Please try again.');
      error.status = response.status;
      throw error;
    }
    return response.data;
  }
  readAuthenticatedJson.invalidateSession = auth => sessions.delete(auth);
  return readAuthenticatedJson;
}

export const readAuthenticatedJson = createAuthenticatedJsonReader();
