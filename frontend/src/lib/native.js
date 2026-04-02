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
    await StatusBar.setStyle({ style: Style.Light });
    await StatusBar.setBackgroundColor({ color: '#FAF8F5' });
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
 * Returns the device token (APNs/FCM) or null.
 */
export async function registerNativePush() {
  if (!isNative) return null;
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');

    const permission = await PushNotifications.requestPermissions();
    if (permission.receive !== 'granted') return null;

    await PushNotifications.register();

    return new Promise((resolve) => {
      PushNotifications.addListener('registration', (token) => {
        logger.info('Native push token:', token.value);
        resolve(token.value);
      });

      PushNotifications.addListener('registrationError', (err) => {
        logger.warn('Native push registration error:', err);
        resolve(null);
      });

      // Handle received notifications
      PushNotifications.addListener('pushNotificationReceived', (notification) => {
        logger.info('Push received:', notification);
      });

      // Handle notification tap
      PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
        logger.info('Push action:', action);
        const url = action.notification?.data?.url;
        if (url) {
          window.location.href = url;
        }
      });
    });
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
