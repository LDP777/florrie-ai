const DEFAULT_TIMEOUT_MS = 15_000;

function requestKey(url, options) {
  const headers = [...new Headers(options.headers).entries()].sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([String(url), headers, options.credentials, options.mode, options.cache,
    options.redirect, options.referrer, options.referrerPolicy, options.integrity]);
}

/** Share a GET through its full body read, then give each caller its own JSON. */
export function createDedupeJsonFetch(fetchImpl = (...args) => fetch(...args), timeoutMs = DEFAULT_TIMEOUT_MS, timers = globalThis) {
  const inFlight = new Map();

  async function read(url, options) {
    const controller = new AbortController();
    const source = options.signal;
    if (source?.aborted) throw source.reason || new DOMException('Request cancelled', 'AbortError');

    let rejectStopped;
    const stopped = new Promise((_, reject) => { rejectStopped = reject; });
    const stop = reason => {
      controller.abort(reason);
      // A suspended WebView can leave fetch pending even after abort().
      rejectStopped(reason);
    };
    const cancel = () => stop(source.reason || new DOMException('Request cancelled', 'AbortError'));
    source?.addEventListener('abort', cancel, { once: true });
    const timer = timers.setTimeout(() => stop(new DOMException('Loading took too long. Please try again.', 'TimeoutError')), timeoutMs);

    try {
      const response = Promise.resolve()
        .then(() => fetchImpl(url, { ...options, signal: controller.signal }))
        .then(async result => ({ ok: result.ok, status: result.status, text: await result.text() }));
      return await Promise.race([response, stopped]);
    } finally {
      timers.clearTimeout(timer);
      source?.removeEventListener('abort', cancel);
    }
  }

  return async function dedupeJsonFetch(url, options = {}) {
    if ((options.method || 'GET').toUpperCase() !== 'GET') {
      throw new TypeError('dedupeJsonFetch only accepts GET requests');
    }

    // A caller's cancellation must not cancel another caller's request.
    const key = options.signal ? null : requestKey(url, options);
    let pending = key === null ? null : inFlight.get(key);
    if (!pending) {
      pending = read(url, options).finally(() => {
        if (key !== null && inFlight.get(key) === pending) inFlight.delete(key);
      });
      if (key !== null) inFlight.set(key, pending);
    }

    const { ok, status, text } = await pending;
    let data = null;
    try { data = JSON.parse(text); }
    catch (error) {
      // Preserve HTTP errors (including 401) even when a proxy returns HTML.
      if (ok) throw error;
    }
    return { ok, status, data };
  };
}

export const dedupeJsonFetch = createDedupeJsonFetch();
