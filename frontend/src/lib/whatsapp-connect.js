export async function startWhatsAppConnection({ api, getToken, native, fetchImpl = fetch,
  openNative = async url => { const { Browser } = await import('@capacitor/browser'); await Browser.open({ url }); },
  navigateWeb = url => { window.location.assign(url); }, timeoutMs = 15000,
}) {
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => {
    controller.abort(); reject(new Error('The connection took too long. Try again.'));
  }, timeoutMs); });
  try {
    const token = await Promise.race([getToken(), deadline]);
    if (!token) throw new Error('Please sign in again to connect WhatsApp.');
    const response = await Promise.race([fetchImpl(`${api}/api/whatsapp/embedded/start`, {
      method:'POST', headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},
      body:JSON.stringify({platform:native?'native':'web'}),signal:controller.signal,
    }),deadline]);
    const result = await Promise.race([response.json(),deadline]);
    if (!response.ok) throw new Error(result.error || 'Could not start WhatsApp setup. Try again.');
    let url; try { url = new URL(result.url); } catch { throw new Error('Invalid WhatsApp setup link.'); }
    // The bridge is on the configured Florrie API, never a user-controlled URL.
    const expected = new URL(api);
    if (![expected.origin, 'https://api.florrie.ai'].includes(url.origin) || url.protocol !== 'https:' || url.pathname !== '/api/whatsapp/embedded' || url.search ||
      !/^#[a-f0-9]{64}$/.test(url.hash) || url.username || url.password) throw new Error('Invalid WhatsApp setup link.');
    clearTimeout(timer);
    if (native) await openNative(url.href); else navigateWeb(url.href);
  } finally { clearTimeout(timer); }
}
