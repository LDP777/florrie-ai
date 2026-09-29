import { createClient } from '@supabase/supabase-js';

export const validConfirmationCode = value => /^\d{6,8}$/.test(String(value || '').trim());

/** Verify without installing a session that could arrive after changing email. */
export async function verifySignupEmail({
  email, code, signal, timeoutMs = 15000,
  url = import.meta.env?.VITE_SUPABASE_URL,
  key = import.meta.env?.VITE_SUPABASE_ANON_KEY,
  request = (...args) => fetch(...args),
}) {
  const address = String(email || '').trim().toLowerCase();
  if (!address || !validConfirmationCode(code)) throw new Error('Enter the code from your email.');
  if (!url || !key) throw new Error('Email confirmation is unavailable. Please use the link in your email.');
  if (signal?.aborted) throw signal.reason || new DOMException('Verification cancelled', 'AbortError');

  const controller = new AbortController();
  const cancel = () => controller.abort(signal?.reason || new DOMException('Verification cancelled', 'AbortError'));
  if (signal?.aborted) cancel();
  else signal?.addEventListener('abort', cancel, { once: true });
  let timer;
  let stop;
  let verifier;
  const cancelled = new Promise((_, reject) => {
    stop = () => reject(controller.signal.reason);
    if (controller.signal.aborted) stop();
    else controller.signal.addEventListener('abort', stop, { once: true });
  });
  timer = setTimeout(() => controller.abort(new DOMException('Verification timed out', 'TimeoutError')), timeoutMs);

  try {
    if (controller.signal.aborted) throw controller.signal.reason;
    // Supabase verifyOtp persists its returned session before resolving. Keep
    // it entirely in memory and off the app's auth channel, including retries.
    verifier = createClient(url, key, {
      auth: {
        persistSession: false, autoRefreshToken: false, detectSessionInUrl: false,
        storageKey: `florrie-signup-confirmation-${crypto.randomUUID()}`,
      },
      global: { fetch: async (input, options = {}) => {
        const response = await request(input, { ...options, signal: controller.signal });
        // Bound a stalled response body as well as the connection. A late
        // provider response cannot reach the SDK after cancellation.
        const body = await response.text();
        if (controller.signal.aborted) throw controller.signal.reason;
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      } },
    });
    const { data, error } = await Promise.race([
      verifier.auth.verifyOtp({ email: address, token: code.trim(), type: 'email' }),
      cancelled,
    ]);
    if (controller.signal.aborted) throw controller.signal.reason;
    if (error) {
      if (error.code === 'otp_expired' || error.status === 403 || /expired|invalid/i.test(error.message || '')) {
        throw new Error('That code is incorrect or has expired. Check your latest email, or use its confirmation link.');
      }
      throw new Error('We could not confirm your email. Try again, or use the link in your email. If you already confirmed, sign in below.');
    }
    const user = data?.user || data?.session?.user;
    if (!user?.email_confirmed_at || String(user.email || '').trim().toLowerCase() !== address) {
      throw new Error('We could not confirm your email. Please use the link in your email.');
    }
    return { confirmed: true };
  } catch (error) {
    if (controller.signal.reason?.name === 'TimeoutError') {
      throw new Error('Confirmation is taking too long. Your code is still here. Try again, or use the link in your email. If you already confirmed, sign in below.');
    }
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.signal.removeEventListener('abort', stop);
    controller.abort();
    // Also release the temporary client's visibility listener.
    await verifier?.auth.stopAutoRefresh();
  }
}
