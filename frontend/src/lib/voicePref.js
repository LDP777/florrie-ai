// Voice button is opt-in. Stored per-device in localStorage (no backend round
// trip), default OFF so the mic never appears unless the owner asks for it.
const KEY = 'florrie_voice_enabled';

export function isVoiceEnabled() {
  try { return localStorage.getItem(KEY) === '1'; } catch { return false; }
}

export function setVoiceEnabled(on) {
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch { /* ignore */ }
  try { window.dispatchEvent(new Event('florrie:voice-pref')); } catch { /* ignore */ }
}
