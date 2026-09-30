// Use the system browser on iPhone, keeping the signed-in app underneath it.
export async function startGoogleCalendarConnection({ api, getToken, native, fetchImpl = fetch,
  openNative = async url => { const { Browser } = await import('@capacitor/browser'); await Browser.open({ url }); },
  navigateWeb = url => { window.location.assign(url); }, beforeOpen = () => {}, isCurrent = () => true, timeoutMs = 15000,
}) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => {
    controller.abort(); reject(new Error('The connection took too long. Try again.'));
  }, timeoutMs); });
  const checkCurrent = () => { if (!isCurrent()) throw new Error('The salon changed. Start Calendar setup again.'); };
  try {
    const token = await Promise.race([getToken(), deadline]);
    checkCurrent();
    if (!token) throw new Error('Please sign in again to connect Google Calendar.');
    const response = await Promise.race([fetchImpl(`${api}/api/gcal/connect${native ? '?platform=native' : ''}`, {
      headers: { Authorization: `Bearer ${token}` }, signal: controller.signal,
    }), deadline]);
    const data = await Promise.race([response.json(), deadline]);
    checkCurrent();
    if (!response.ok) throw new Error('Google Calendar setup is unavailable right now. Try again shortly.');
    let url;
    try { url = new URL(data.url); } catch { throw new Error('Could not open a verified Google Calendar connection link.'); }
    if (url.origin !== 'https://accounts.google.com' || url.pathname !== '/o/oauth2/v2/auth' || url.username || url.password) {
      throw new Error('Could not open a verified Google Calendar connection link.');
    }
    if (controller.signal.aborted) throw new Error('The connection took too long. Try again.');
    clearTimeout(timer);
    beforeOpen();
    if (native) await openNative(url.href);
    else navigateWeb(url.href);
  } finally { clearTimeout(timer); }
}

// Closing Safari means the owner returned, not that Google connected. One
// current-owner status read settles each attempt; duplicate/late events do not.
export function createGoogleCalendarReturnCheck({ readStatus, refresh, isCurrent, onChecking, onResult, timeoutMs = 15000 }) {
  let generation = 0, pending = false;
  return {
    begin() { generation++; pending = true; },
    cancel() { generation++; pending = false; },
    async finish() {
      if (!pending || !isCurrent()) return;
      pending = false;
      const run = generation;
      const active = () => run === generation && isCurrent();
      let timer;
      const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Calendar check took too long')), timeoutMs); });
      onChecking(true);
      try {
        const status = await Promise.race([readStatus(), deadline]);
        if (!active()) return;
        if (typeof status?.connected !== 'boolean') throw new Error('Calendar status was not confirmed');
        await Promise.race([refresh(), deadline]);
        if (active()) onResult(status.connected ? 'success' : 'not_connected');
      } catch {
        if (active()) onResult('error');
      } finally { clearTimeout(timer); if (active()) onChecking(false); }
    },
  };
}
