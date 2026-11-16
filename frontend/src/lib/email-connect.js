export async function emailRequest({ api, auth, path, body, fetchImpl = fetch, timeoutMs = 18000 }) {
  const controller = new AbortController();
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('This is taking too long. Return here to check the result before trying again.')); }, timeoutMs); });
  try {
    const session = await Promise.race([auth.getSession(), timeout]);
    const token = session.data?.session?.access_token;
    if (session.error || !token) throw new Error('Sign in again to connect your email.');
    const response = await Promise.race([fetchImpl(`${api}/api/email/${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal }), timeout]);
    const result = await Promise.race([response.json(), timeout]);
    if (!response.ok) throw new Error(result.error || 'Could not check email. Try again.');
    return result;
  } finally { clearTimeout(timer); }
}
export async function startEmailConnection({ api, auth, provider, native, preferences, fetchImpl = fetch,
  openNative = async url => { const { Browser } = await import('@capacitor/browser'); await Browser.open({ url }); },
  navigateWeb = url => window.location.assign(url),
}) {
  const result = await emailRequest({ api, auth, path: 'start', fetchImpl, body: { provider, platform: native ? 'native' : 'web', ...preferences } });
  let url;
  try { url = new URL(result.url); } catch { throw new Error('Email setup did not return a valid sign-in link.'); }
  const allowed = provider === 'google' ? ['https://accounts.google.com', '/o/oauth2/v2/auth'] : ['https://login.microsoftonline.com', '/common/oauth2/v2.0/authorize'];
  if (url.origin !== allowed[0] || url.pathname !== allowed[1] || url.hash || url.username || url.password) throw new Error('Email setup did not return a valid sign-in link.');
  if (native) await openNative(url.href); else navigateWeb(url.href);
}
