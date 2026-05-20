/**
 * Platform detection helpers.
 *
 * Used to gate iOS-specific UI for App Store compliance (Guideline 3.1.3(b)
 * "Multiplatform Services"). On native iOS we must not show pricing CTAs,
 * external purchase links, or signup flows that lead to a paid web checkout.
 *
 * The Capacitor import is dynamic-but-safe: `@capacitor/core` is already a
 * direct dependency, so the import is synchronous and cheap, but every call
 * is wrapped in a try/catch so a missing/broken module never crashes the web
 * build or SSR-style render paths.
 */
import { Capacitor } from '@capacitor/core';

/** True when running inside the Capacitor iOS native shell. */
export function isIOSNative() {
  try {
    return Capacitor.getPlatform() === 'ios' && Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

/** True when running inside any Capacitor native shell (iOS or Android). */
export function isNativeApp() {
  try {
    return Capacitor.isNativePlatform();
  } catch {
    return false;
  }
}

/** Raw platform string: 'ios' | 'android' | 'web'. */
export function getPlatform() {
  try {
    return Capacitor.getPlatform();
  } catch {
    return 'web';
  }
}
