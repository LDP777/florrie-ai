import { API_BASE } from './config.js';
import logger from './logger.js';

/**
 * Push notification registration helper.
 *
 * Call `registerPush()` after login. It:
 *   1. Fetches the VAPID public key from the backend
 *   2. Requests notification permission from the browser
 *   3. Subscribes via the service worker
 *   4. Sends the subscription to the backend
 *
 * Silently no-ops if push isn't supported or the user declines.
 */

function getToken() {
  // Supabase stores session under sb-<project-ref>-auth-token — find it by pattern
  const key = Object.keys(localStorage).find(k => /^sb-.+-auth-token$/.test(k));
  if (!key) return null;
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed?.access_token || parsed?.session?.access_token || raw;
  } catch { return raw; }
}

function authHeaders() {
  const t = getToken();
  return t
    ? { 'Authorization': `Bearer ${t}`, 'Content-Type': 'application/json' }
    : { 'Content-Type': 'application/json' };
}

export async function registerPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    logger.debug('Push not supported in this browser');
    return false;
  }

  try {
    // 1. Get VAPID key
    const keyRes = await fetch(`${API_BASE}/api/push/vapid-key`);
    if (!keyRes.ok) return false;
    const { publicKey } = await keyRes.json();

    // 2. Request permission
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') {
      logger.debug('Push permission denied');
      return false;
    }

    // 3. Subscribe via service worker
    const reg = await navigator.serviceWorker.ready;
    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });

    // 4. Send subscription to backend
    await fetch(`${API_BASE}/api/push/subscribe`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ subscription: subscription.toJSON() }),
    });

    logger.info('Push notifications registered');
    return true;
  } catch (err) {
    logger.warn('Push registration failed:', err);
    return false;
  }
}

/**
 * Native (iOS/Android) push registration. Asks for permission, registers
 * with APNs/FCM via @capacitor/push-notifications, then stores the device
 * token server-side so the backend can send real APNs pushes.
 *
 * No-ops on web. Call after a login session exists (the POST is authed).
 */
export async function registerNativePushToken() {
  try {
    const { registerNativePush, platform } = await import('./native.js');
    const token = await registerNativePush();
    if (!token) return false;

    const res = await fetch(`${API_BASE}/api/push/native-token`, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ token, platform }),
    });
    if (!res.ok) {
      logger.warn('Native push token save failed:', res.status);
      return false;
    }

    logger.info('Native push token registered');
    return true;
  } catch (err) {
    logger.warn('Native push token registration failed:', err);
    return false;
  }
}

export async function unregisterPush() {
  try {
    const reg = await navigator.serviceWorker.ready;
    const subscription = await reg.pushManager.getSubscription();
    if (!subscription) return;

    await subscription.unsubscribe();

    await fetch(`${API_BASE}/api/push/subscribe`, {
      method: 'DELETE',
      headers: authHeaders(),
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    });
  } catch (err) {
    logger.warn('Push unregistration failed:', err);
  }
}

/**
 * Check current push subscription status.
 */
export async function getPushStatus() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return 'unsupported';

  const permission = Notification.permission;
  if (permission === 'denied') return 'denied';

  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    return sub ? 'subscribed' : 'unsubscribed';
  } catch {
    return 'error';
  }
}

// Utility: convert base64 VAPID key to Uint8Array
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const arr = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    arr[i] = rawData.charCodeAt(i);
  }
  return arr;
}
