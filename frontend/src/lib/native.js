/**
 * Native bridge — wraps Capacitor plugins so web + native both work.
 *
 * Every function checks `Capacitor.isNativePlatform()` first.
 * On web, they silently no-op or fall back to web APIs.
 */
import { Capacitor } from '@capacitor/core';
import logger from './logger.js';

export const isNative = Capacitor.isNativePlatform();
export const platform = Capacitor.getPlatform(); // 'ios' | 'android' | 'web'

/**
 * Configure the status bar for native platforms.
 */
export async function configureStatusBar() {
  if (!isNative) return;
  try {
    const { StatusBar, Style } = await import('@capacitor/status-bar');
    // App background is near-white, so use dark glyphs (Style.Dark) for legible
    // status-bar text. Background hex matches capacitor.config.ts + App.jsx shell.
    await StatusBar.setStyle({ style: Style.Dark });
    await StatusBar.setBackgroundColor({ color: '#FBF6F1' });
  } catch (err) {
    logger.debug('StatusBar plugin not available:', err);
  }
}

/**
 * Trigger haptic feedback on native platforms.
 */
export async function hapticTap() {
  if (!isNative) return;
  try {
    const { Haptics, ImpactStyle } = await import('@capacitor/haptics');
    await Haptics.impact({ style: ImpactStyle.Light });
  } catch {
    // Haptics not available
  }
}

export async function hapticSuccess() {
  if (!isNative) return;
  try {
    const { Haptics, NotificationType } = await import('@capacitor/haptics');
    await Haptics.notification({ type: NotificationType.Success });
  } catch {
    // Haptics not available
  }
}

/**
 * Register for native push notifications.
 *
 * THIS IS WHY NO BOOKING EVER BUZZED HER PHONE.
 *
 * It used to call `PushNotifications.register()` and THEN attach the
 * 'registration' listener, inside a Promise executor:
 *
 *     await PushNotifications.register();
 *     return new Promise((resolve) => {
 *       PushNotifications.addListener('registration', t => resolve(t.value));
 *
 * register() is what asks APNs for the token, and APNs frequently answers
 * before the next line runs, especially on a warm start where iOS already has
 * one cached. The event then fires with nothing listening, the promise never
 * settles, and registerNativePushToken() awaits it forever. No token is ever
 * POSTed, so native_push_tokens stays empty for that salon, so
 * sendApnsToBeautician finds no rows and returns null, so every push the
 * backend sends reaches nobody. Silently, because a promise that never settles
 * throws nothing and logs nothing.
 *
 * Capacitor's own documentation attaches the listeners first and awaits them,
 * for exactly this reason: addListener returns a Promise<PluginListenerHandle>,
 * so even attaching before register() is not enough on its own if you do not
 * wait for the handle.
 *
 * Also fixed here:
 *   - a TIMEOUT, so this settles even if neither event ever arrives. The old
 *     shape could hang for the life of the app, which is indistinguishable
 *     from "iOS is thinking about it".
 *   - the one-shot handles are REMOVED afterwards. App.jsx calls this on every
 *     session change, and the old code added a fresh set of four listeners
 *     each time.
 *   - the tap and receive handlers are attached ONCE and left alone, because
 *     those are for the life of the app, not for this one registration.
 *
 * @returns {Promise<string|null>} the APNs/FCM device token
 */
let lifetimeListenersAttached = false;

async function attachLifetimeListeners(PushNotifications) {
  if (lifetimeListenersAttached) return;
  lifetimeListenersAttached = true;

  await PushNotifications.addListener('pushNotificationReceived', (notification) => {
    logger.info('Push received:', notification);
  });

  await PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
    logger.info('Push action:', action);
    const d = action.notification?.data || {};
    const url = d.url || d.data?.url;
    if (url && String(url).startsWith('/')) {
      window.location.href = url;
    }
  });
}

// Long enough for a cold start on a poor connection, short enough that a
// failure is a failure rather than a hang. APNs normally answers in under a
// second.
const REGISTRATION_TIMEOUT_MS = 20_000;

export async function registerNativePush() {
  if (!isNative) return null;
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');

    const permission = await PushNotifications.requestPermissions();
    if (permission.receive !== 'granted') {
      logger.warn('Native push: permission not granted, no token will exist for this device');
      return null;
    }

    await attachLifetimeListeners(PushNotifications);

    let onToken;
    let onError;
    let timer;

    const token = await new Promise((resolve) => {
      const settle = (value) => {
        clearTimeout(timer);
        resolve(value);
      };

      timer = setTimeout(() => {
        logger.warn(`Native push: no registration event within ${REGISTRATION_TIMEOUT_MS}ms, giving up rather than hanging`);
        settle(null);
      }, REGISTRATION_TIMEOUT_MS);

      // BOTH listeners attached and awaited BEFORE register() is called.
      Promise.all([
        PushNotifications.addListener('registration', (t) => settle(t?.value || null)),
        PushNotifications.addListener('registrationError', (err) => {
          logger.warn('Native push registration error:', err);
          settle(null);
        }),
      ])
        .then(([tokenHandle, errorHandle]) => {
          onToken = tokenHandle;
          onError = errorHandle;
          return PushNotifications.register();
        })
        .catch((err) => {
          logger.warn('Native push register() failed:', err);
          settle(null);
        });
    });

    // One-shot handles go away. This runs on every session change, and leaving
    // them attached meant a new pair of listeners on each sign-in.
    await Promise.all([
      onToken?.remove?.(),
      onError?.remove?.(),
    ].filter(Boolean)).catch(() => {});

    if (!token) logger.warn('Native push: registration produced no token');
    return token;
  } catch (err) {
    logger.warn('Native push setup failed:', err);
    return null;
  }
}

/**
 * Hide the splash screen (call after app is ready).
 */
export async function hideSplash() {
  if (!isNative) return;
  try {
    const { SplashScreen } = await import('@capacitor/splash-screen');
    await SplashScreen.hide();
  } catch {
    // Splash not available
  }
}
