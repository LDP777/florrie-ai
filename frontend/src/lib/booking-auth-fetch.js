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

/** SDK locks and retries must not leave the public form waiting indefinitely. */
export async function waitForBookingAuth(operation, timeoutMs = 25_000) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new DOMException('Verification outcome is not confirmed', 'TimeoutError')), timeoutMs);
      }),
    ]);
  } finally { clearTimeout(timer); }
}
