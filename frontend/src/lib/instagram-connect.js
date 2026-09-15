// Open native OAuth through Capacitor's system browser. window.open after an
// awaited session/API call can lose the user gesture and be blocked on iOS.
export async function startInstagramConnection({ api, getToken, native, fetchImpl = fetch,
  openNative = async url => { const { Browser } = await import('@capacitor/browser'); await Browser.open({ url }); },
  navigateWeb = url => { window.location.href = url; }, beforeOpen = async () => {}, timeoutMs = 15000,
}) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new Error('The connection took too long. Try again.'));
    }, timeoutMs);
  });
  try {
    const token = await Promise.race([getToken(), deadline]);
    if (!token) throw new Error('Please sign in again to connect Instagram.');
    const response = await Promise.race([fetchImpl(`${api}/api/instagram/connect${native ? '?platform=native' : ''}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
    }), deadline]);
    const data = await Promise.race([response.json(), deadline]);
    if (!response.ok) throw new Error(response.status === 503
      ? 'Instagram connection is unavailable right now. You can keep using Florrie and try again from Settings.'
      : data.error || 'Could not start the Instagram connection. Try again.');
    let url;
    try { url = new URL(data.url); } catch { throw new Error('Instagram returned an invalid connection link.'); }
    if (url.protocol !== 'https:' || url.hostname !== 'www.instagram.com' || url.pathname !== '/oauth/authorize' || url.username || url.password) {
      throw new Error('Instagram returned an invalid connection link.');
    }
    await Promise.race([beforeOpen(), deadline]);
    if (controller.signal.aborted) throw new Error('The connection took too long. Try again.');
    // Opening a system browser is a local action, not a network request. Stop
    // the network deadline before the user starts their provider sign-in.
    clearTimeout(timer);
    if (native) await openNative(url.href);
    else navigateWeb(url.href);
  } finally {
    clearTimeout(timer);
  }
}
