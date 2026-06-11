import http2 from 'node:http2';
import crypto from 'node:crypto';
import { supabase } from '../config.js';
import logger from '../lib/logger.js';

/**
 * APNs sender - real Apple push for the native iOS app.
 *
 * Zero dependencies: ES256 provider JWT via node:crypto, HTTP/2 via node:http2.
 *
 * Env:
 *   APNS_KEY_ID      - Key ID of the .p8 APNs auth key (Apple Developer > Keys)
 *   APNS_TEAM_ID     - Apple Developer Team ID
 *   APNS_PRIVATE_KEY - contents of the .p8 file (PEM). \n-escaped is fine,
 *                      Railway single-line values get unescaped here.
 *   APNS_BUNDLE_ID   - apns-topic, defaults to ai.florrie.app
 *   APNS_HOST        - defaults to https://api.push.apple.com
 *                      (set https://api.sandbox.push.apple.com for dev builds)
 *
 * When env is missing everything returns null with a single warn - push
 * fan-out elsewhere must never break because APNs isn't configured.
 */

const APNS_BUNDLE_ID = process.env.APNS_BUNDLE_ID || 'ai.florrie.app';

function apnsHost() {
  const host = process.env.APNS_HOST || 'api.push.apple.com';
  return host.startsWith('https://') ? host : `https://${host}`;
}

function getPrivateKey() {
  const raw = process.env.APNS_PRIVATE_KEY;
  if (!raw) return null;
  // Railway env vars are often pasted single-line with literal \n sequences.
  return raw.includes('\\n') ? raw.replace(/\\n/g, '\n') : raw;
}

export function isApnsConfigured() {
  return Boolean(process.env.APNS_KEY_ID && process.env.APNS_TEAM_ID && process.env.APNS_PRIVATE_KEY);
}

// ---------------------------------------------------------------------------
// Provider JWT (ES256), cached ~45 min. Apple requires refresh within 20-60 min.
// ---------------------------------------------------------------------------

const JWT_TTL_MS = 45 * 60 * 1000;
let cachedJwt = null;
let cachedJwtAt = 0;
let warnedMissingEnv = false;

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

function getProviderJwt() {
  const keyId = process.env.APNS_KEY_ID;
  const teamId = process.env.APNS_TEAM_ID;
  const privateKey = getPrivateKey();

  if (!keyId || !teamId || !privateKey) {
    if (!warnedMissingEnv) {
      warnedMissingEnv = true;
      logger.warn('APNs not configured (APNS_KEY_ID / APNS_TEAM_ID / APNS_PRIVATE_KEY missing) - native iOS push disabled');
    }
    return null;
  }

  const now = Date.now();
  if (cachedJwt && now - cachedJwtAt < JWT_TTL_MS) return cachedJwt;

  try {
    const header = b64url(JSON.stringify({ alg: 'ES256', kid: keyId }));
    const claims = b64url(JSON.stringify({ iss: teamId, iat: Math.floor(now / 1000) }));
    const signingInput = `${header}.${claims}`;

    const signer = crypto.createSign('SHA256');
    signer.update(signingInput);
    // JWT ES256 needs the raw r||s signature, not DER.
    const signature = signer.sign({ key: privateKey, dsaEncoding: 'ieee-p1363' });

    cachedJwt = `${signingInput}.${signature.toString('base64url')}`;
    cachedJwtAt = now;
    return cachedJwt;
  } catch (err) {
    logger.warn({ err }, 'APNs JWT signing failed - check APNS_PRIVATE_KEY format (.p8 PEM contents)');
    return null;
  }
}

// ---------------------------------------------------------------------------
// Single-device send over HTTP/2
// ---------------------------------------------------------------------------

/**
 * Send one alert push to one APNs device token.
 * Resolves { ok, status, reason } - or null when APNs isn't configured /
 * the connection failed. Never rejects.
 */
export function sendApnsNotification(deviceToken, { title, body, badge, data } = {}) {
  const jwt = getProviderJwt();
  if (!jwt) return Promise.resolve(null);

  const payload = JSON.stringify({
    aps: {
      alert: { title: title || 'florrie.ai', body: body || '' },
      sound: 'default',
      ...(Number.isFinite(badge) ? { badge } : {}),
    },
    data: data || {},
  });

  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      try { client.close(); } catch { /* noop */ }
      resolve(result);
    };

    let client;
    try {
      client = http2.connect(apnsHost());
    } catch (err) {
      logger.warn({ err }, 'APNs connect failed');
      return resolve(null);
    }

    client.on('error', (err) => {
      logger.warn({ err }, 'APNs connection error');
      done(null);
    });

    const req = client.request({
      ':method': 'POST',
      ':path': `/3/device/${deviceToken}`,
      'authorization': `bearer ${jwt}`,
      'apns-topic': APNS_BUNDLE_ID,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
    });

    let status = 0;
    let responseBody = '';

    req.setEncoding('utf8');
    req.setTimeout(10000, () => {
      logger.warn('APNs request timed out');
      try { req.close(); } catch { /* noop */ }
      done(null);
    });
    req.on('response', (headers) => { status = headers[':status']; });
    req.on('data', (chunk) => { responseBody += chunk; });
    req.on('end', () => {
      if (status === 200) return done({ ok: true, status });
      let reason = '';
      try { reason = JSON.parse(responseBody)?.reason || ''; } catch { /* noop */ }
      done({ ok: false, status, reason });
    });
    req.on('error', (err) => {
      logger.warn({ err }, 'APNs request error');
      done(null);
    });

    req.end(payload);
  });
}

// ---------------------------------------------------------------------------
// Beautician fan-out (mirrors the web-push sendPush shape)
// ---------------------------------------------------------------------------

/**
 * Send a push to every native device token a beautician has registered.
 * Dead tokens (410 / BadDeviceToken / Unregistered / ExpiredToken) are
 * deleted so the table self-cleans. Never throws.
 */
export async function sendApnsToBeautician(beauticianId, { title, body, badge, data } = {}) {
  if (!isApnsConfigured()) return null;

  let tokens;
  try {
    const { data: rows, error } = await supabase
      .from('native_push_tokens')
      .select('token')
      .eq('beautician_id', beauticianId);
    if (error) {
      logger.warn({ err: error, beauticianId }, 'APNs token lookup failed');
      return null;
    }
    tokens = rows;
  } catch (err) {
    logger.warn({ err, beauticianId }, 'APNs token lookup threw');
    return null;
  }

  if (!tokens?.length) return null;

  let sent = 0;
  const dead = [];

  for (const { token } of tokens) {
    const result = await sendApnsNotification(token, { title, body, badge, data });
    if (result?.ok) {
      sent++;
    } else if (result && (
      result.status === 410 ||
      result.reason === 'BadDeviceToken' ||
      result.reason === 'Unregistered' ||
      result.reason === 'ExpiredToken'
    )) {
      dead.push(token);
    } else if (result) {
      logger.warn({ beauticianId, status: result.status, reason: result.reason }, 'APNs send rejected');
    }
  }

  if (dead.length) {
    try {
      await supabase.from('native_push_tokens').delete().in('token', dead);
      logger.info({ beauticianId, removed: dead.length }, 'Removed dead APNs tokens');
    } catch (err) {
      logger.warn({ err, beauticianId }, 'Failed to remove dead APNs tokens');
    }
  }

  return { sent, removed: dead.length };
}
