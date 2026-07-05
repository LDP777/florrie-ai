// "Florrie on the desk" Live Activity bridge (iOS 16.1+). Starts the strip,
// hands the activity's APNs push token to the backend so Florrie can update it
// all day, and ends it on request. No-ops on web and non-iOS. Fail soft.
import { registerPlugin } from '@capacitor/core';
import { API_BASE } from './config.js';
import { isNativeApp } from './platform.js';

const Plugin = registerPlugin('FlorrieLiveActivity');

function getToken() {
  try {
    const key = Object.keys(localStorage).find(k => /^sb-.+-auth-token$/.test(k));
    if (!key) return null;
    return JSON.parse(localStorage.getItem(key))?.access_token || null;
  } catch { return null; }
}
function authHeaders() {
  const t = getToken();
  return t
    ? { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' };
}

let tokenListener = null;

export async function startDeskActivity(salonName = 'Florrie') {
  if (!isNativeApp()) return;
  try {
    const running = await Plugin.isRunning().catch(() => ({ running: false }));
    if (running?.running) return; // already on the desk today

    // Seed the strip with real state so it looks alive before the first push.
    let state = { handled: 0, nextClient: '', nextTime: '', status: 'On the desk' };
    try {
      const r = await fetch(`${API_BASE}/api/push/live-activity/state`, { headers: authHeaders() });
      if (r.ok) state = (await r.json()).state || state;
    } catch { /* default seed is fine */ }

    // The push token can arrive just after start and can rotate; register each.
    if (!tokenListener) {
      tokenListener = await Plugin.addListener('token', async ({ activityId, pushToken }) => {
        try {
          await fetch(`${API_BASE}/api/push/live-activity/register`, {
            method: 'POST',
            headers: authHeaders(),
            body: JSON.stringify({ activity_id: activityId, push_token: pushToken }),
          });
        } catch { /* backend picks it up on the next start */ }
      });
    }

    await Plugin.start({ salonName, state });
  } catch { /* a strip is a garnish, never break the app */ }
}

export async function endDeskActivity() {
  if (!isNativeApp()) return;
  try {
    await Plugin.end();
    await fetch(`${API_BASE}/api/push/live-activity/end`, { method: 'POST', headers: authHeaders() }).catch(() => {});
  } catch { /* noop */ }
}
