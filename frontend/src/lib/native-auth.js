export const NATIVE_AUTH_CALLBACK = 'ai.florrie.app://auth/callback';
export const NATIVE_RECOVERY_CALLBACK = 'ai.florrie.app://auth/update-password';

// PKCE keeps an intercepted custom-scheme code unusable without this app's verifier.
// Never accept an arbitrary URL or bearer tokens delivered through a deep link.
export function parseNativeAuthCallback(value) {
  if (typeof value !== 'string' || value.length > 8192) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'ai.florrie.app:' || url.host !== 'auth' || url.username || url.password) return null;
  if (!['/callback', '/update-password'].includes(url.pathname)) return null;
  const code = url.searchParams.get('code');
  if (url.hash || url.searchParams.has('error') || !code || url.searchParams.getAll('code').length !== 1) {
    return { error: true };
  }
  return { code, destination: url.pathname === '/update-password' ? '/update-password' : '/today' };
}

export function createNativeAuthHandler({ auth, navigate, closeBrowser }) {
  const seen = new Set();
  return async value => {
    const callback = parseNativeAuthCallback(value);
    if (!callback) return;
    if (callback.code && seen.has(callback.code)) return;
    if (callback.code) seen.add(callback.code);
    try {
      if (callback.error) throw new Error('Invalid callback');
      const { data, error } = await auth.exchangeCodeForSession(callback.code);
      if (error || !data?.session) throw new Error('Session exchange failed');
      navigate(callback.destination, { replace: true });
    } catch {
      navigate('/login?auth_error=1', { replace: true });
    } finally {
      await closeBrowser().catch(() => {});
    }
  };
}

export async function appleNoncePair(cryptoApi = globalThis.crypto) {
  const bytes = cryptoApi.getRandomValues(new Uint8Array(32));
  const raw = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  const digest = await cryptoApi.subtle.digest('SHA-256', new TextEncoder().encode(raw));
  return { raw, hashed: Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('') };
}
