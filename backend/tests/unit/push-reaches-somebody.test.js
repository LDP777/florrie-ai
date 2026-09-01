/**
 * "i think there is still no ios notification when someone books in".
 *
 * She was right, and every layer said the same nothing.
 *
 * The cause was in the iOS app: PushNotifications.register() was called BEFORE
 * the 'registration' listener was attached, so the token arrived with nothing
 * listening, the promise never settled, and no token was ever sent to the
 * server. native_push_tokens stayed empty, sendApnsToBeautician found no rows,
 * and every push since reached nobody.
 *
 * None of that was visible. This file pins the two things that make it visible
 * next time: the ordering in the app, and a reason on every way the send can
 * reach zero devices.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

/**
 * Comments stripped before searching for ordering. The file documents the OLD
 * broken order in its header, quoting `await PushNotifications.register()`
 * above the listener, and a naive indexOf finds the quotation rather than the
 * code and fails a correct file. Caught by this test failing on the fix.
 */
const codeOnly = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

describe('the iOS app registers in an order that can actually receive the token', () => {
  const native = codeOnly(read('../../../frontend/src/lib/native.js'));

  it('attaches the registration listener before calling register', () => {
    const listenerAt = native.indexOf("addListener('registration'");
    const registerAt = native.indexOf('PushNotifications.register()');
    expect(listenerAt).toBeGreaterThan(-1);
    expect(registerAt).toBeGreaterThan(-1);
    // The whole bug, as one comparison. Capacitor's own documentation attaches
    // listeners first and awaits them, because register() is what asks APNs and
    // APNs frequently answers before the next line runs.
    expect(listenerAt).toBeLessThan(registerAt);
  });

  it('awaits the listener handles, because addListener is itself async', () => {
    // Attaching before register() is not enough on its own: addListener returns
    // a Promise<PluginListenerHandle>, so the handle may not exist yet either.
    expect(native).toMatch(/Promise\.all\(\[\s*\n\s*PushNotifications\.addListener\('registration'/);
  });

  it('always settles, so it can never hang for the life of the app', () => {
    // The old shape could wait forever, which looks exactly like iOS being
    // slow and is why this went unnoticed for so long.
    expect(native).toMatch(/REGISTRATION_TIMEOUT_MS/);
    expect(native).toMatch(/setTimeout\(/);
  });

  it('removes the one-shot listeners, because this runs on every sign-in', () => {
    expect(native).toMatch(/onToken\?\.remove\?\.\(\)/);
    expect(native).toMatch(/onError\?\.remove\?\.\(\)/);
  });

  it('keeps the tap handler attached once for the life of the app, not per registration', () => {
    expect(native).toMatch(/lifetimeListenersAttached/);
  });
});

describe('a push that reaches nobody says why', () => {
  const apns = read('../../src/services/apns.js');
  const push = read('../../src/services/push-notifications.js');

  it('distinguishes the three ways the APNs leg reaches zero devices', () => {
    // All three used to be a bare `null`, and sendPush added 0 for each, so a
    // missing signing key, a broken query and a phone that never registered
    // were the same event everywhere downstream.
    expect(apns).toMatch(/reason: 'apns_not_configured'/);
    expect(apns).toMatch(/reason: 'token_lookup_failed'/);
    expect(apns).toMatch(/reason: 'no_device_registered'/);
  });

  it('still returns a sent count, so no existing caller changes shape', () => {
    // pushAtTheDoor reads `delivered` and falls back to SMS on zero. Breaking
    // that arithmetic to add a reason would trade one silent failure for a
    // louder one.
    for (const m of apns.matchAll(/return \{ sent: 0[^}]*\}/g)) {
      expect(m[0]).toMatch(/sent: 0/);
    }
    expect(apns).not.toMatch(/if \(!isApnsConfigured\(\)\) return null;/);
  });

  it('says it once, in the logs, when nothing was delivered on either leg', () => {
    expect(push).toMatch(/Push reached zero devices/);
    expect(push).toMatch(/apnsReason/);
  });
});

describe('health says whether anyone can be buzzed at all', () => {
  const health = read('../../src/lib/health.js');

  it('reports APNs configuration and how many salons have no device', () => {
    expect(health).toMatch(/checkPushReach/);
    expect(health).toMatch(/salons_with_a_device/);
    expect(health).toMatch(/no device registered/);
  });

  it('warns rather than passing when APNs is not configured', () => {
    // Every other "not configured" in this file is a deployment choice and
    // passes. Not this one: the iOS app is shipped and the booking alert
    // depends on it, so an unconfigured deployment can buzz nobody.
    const block = health.slice(health.indexOf('async function checkPushReach'));
    const notConfigured = block.slice(block.indexOf('if (!configured)'), block.indexOf('if (silent.length)'));
    expect(notConfigured).toMatch(/ok: false/);
    expect(notConfigured).toMatch(/status: 'warn'/);
  });
});
