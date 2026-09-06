/** Keep a stalled public verification request from leaving the form busy. */
export function createBookingAuthFetch(fetchImpl = (...args) => fetch(...args), timeoutMs = 20_000) {
  return async (input, options = {}) => {
    const controller = new AbortController();
    const source = options.signal;
    const cancel = () => controller.abort(source.reason);
    if (source?.aborted) cancel();
    else source?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(() => controller.abort(new DOMException('Email verification timed out', 'TimeoutError')), timeoutMs);
    try { return await fetchImpl(input, { ...options, signal: controller.signal }); }
    finally { clearTimeout(timer); source?.removeEventListener('abort', cancel); }
  };
}
