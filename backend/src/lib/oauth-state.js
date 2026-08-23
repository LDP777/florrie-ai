/**
 * Signed, expiring OAuth `state`.
 *
 * The bug this exists for: three OAuth callbacks (Google Calendar, Instagram,
 * HMRC) read the beautician id straight out of `state` and wrote credentials
 * onto that row. `state` comes back from the provider, which means it comes
 * back from whoever started the flow, and a beautician id is public: GET
 * /api/booking/:slug hands out `beautician.id` on every booking page. So
 * anyone could run the OAuth dance with their OWN Google or Instagram account,
 * paste a victim's id into `state`, and have the callback overwrite HER
 * credentials with THEIRS. Her appointments then sync into the attacker's
 * calendar, complete with client names, and her Instagram DMs route to the
 * attacker's account while Florrie answers the attacker's DMs with her diary.
 *
 * The fix is to stop treating `state` as data the client may choose. It is
 * minted server side at connect time, when the session is known, signed, and
 * only accepted back if the signature still verifies and it is recent.
 *
 * Wire format (all base64url, so it is safe in a query string as is):
 *
 *   v1.<base64url(JSON payload + iat)>.<base64url(HMAC-SHA256)>
 *
 * The payload is readable by anyone holding the string. That is fine, and it
 * is why nothing secret goes in it: a beautician id is already public. What
 * the signature buys is that the id cannot be CHANGED, and the timestamp
 * caps how long a captured state stays usable.
 */
import { createHash, createHmac, timingSafeEqual } from 'crypto';

/** Format marker. Bump if the payload shape ever changes. */
const PREFIX = 'v1';

/**
 * Ten minutes. Long enough for a real login, including the "hang on, I need my
 * password" detour, and short enough that a state captured out of a browser
 * history or a referrer header is usually already dead.
 */
export const OAUTH_STATE_MAX_AGE_MS = 10 * 60 * 1000;

/**
 * A little tolerance for a server clock that is behind the one that minted the
 * state. Anything further into the future than this is treated as garbage.
 */
const FUTURE_SKEW_MS = 60 * 1000;

/**
 * Why a state was refused. Safe to log: none of these carry the payload, the
 * token or the secret.
 */
export const OAUTH_STATE_REASONS = {
  MISSING: 'missing',
  LEGACY_UNSIGNED: 'legacy_unsigned',
  MALFORMED: 'malformed',
  BAD_SIGNATURE: 'bad_signature',
  EXPIRED: 'expired',
  NO_SECRET: 'no_secret',
};

export class OAuthStateError extends Error {
  constructor(message, reason) {
    super(message);
    this.name = 'OAuthStateError';
    this.reason = reason;
  }
}

/**
 * Which server secret this uses, and why it is not a new env var.
 *
 * ENCRYPTION_KEY first: it is already the server's "secret material" knob, it
 * is already listed in OPTIONAL_ENV in index.js, and the Google tokens this
 * flow writes are encrypted with it anyway.
 *
 * SUPABASE_SERVICE_KEY second: it is in REQUIRED_ENV, so on any box that
 * booted at all it is present. lib/crypto.js already falls back the same way,
 * so this is the house pattern rather than a new one.
 *
 * A new required variable was the wrong shape twice over. It would have to go
 * somewhere, and the documented trap is that a feature scoped variable in
 * REQUIRED_ENV takes the WHOLE server down at boot (that is what happened with
 * the WhatsApp vars). Left out of REQUIRED_ENV it would just be silently
 * missing, which is the failure mode this helper is supposed to end.
 *
 * The raw secret is never used as the HMAC key directly. It is hashed with a
 * label first, so this key cannot be confused with the AES key crypto.js
 * derives from the same material.
 */
function stateSecret() {
  return process.env.ENCRYPTION_KEY || process.env.SUPABASE_SERVICE_KEY || null;
}

function stateKey() {
  const secret = stateSecret();
  if (!secret) return null;
  return createHash('sha256').update(`florrie.oauth.state.${PREFIX}:${secret}`).digest();
}

/**
 * Null when state can be signed, otherwise a sentence naming what is unset.
 *
 * Connect endpoints use this to return a 503 that says what is wrong, rather
 * than issuing state nobody will be able to verify on the way back.
 */
export function oauthStateSecretProblem() {
  if (stateSecret()) return null;
  return 'Neither ENCRYPTION_KEY nor SUPABASE_SERVICE_KEY is set on the server, so the OAuth handshake cannot be signed.';
}

const encode = (value) => Buffer.from(value).toString('base64url');

/**
 * Mint a state string for a flow that is starting.
 *
 * @param {object} payload  Fields to carry through the provider and back. Public
 *                          by construction, so nothing secret belongs in here.
 * @param {object} [opts]
 * @param {number} [opts.now]  Override the issued-at, for tests.
 * @returns {string} URL safe, opaque to the client.
 * @throws {OAuthStateError} reason 'no_secret' when nothing can sign it.
 */
export function signOAuthState(payload = {}, opts = {}) {
  const key = stateKey();
  if (!key) throw new OAuthStateError(oauthStateSecretProblem(), OAUTH_STATE_REASONS.NO_SECRET);

  const issuedAt = Number.isFinite(opts.now) ? opts.now : Date.now();
  const body = encode(JSON.stringify({ ...payload, iat: issuedAt }));
  const signature = encode(createHmac('sha256', key).update(`${PREFIX}.${body}`).digest());

  return `${PREFIX}.${body}.${signature}`;
}

function refuse(reason) {
  return { ok: false, reason, payload: null };
}

/**
 * Check a state string and say why if it fails.
 *
 * Callbacks use this rather than verifyOAuthState when they want the reason for
 * the log line. The reason is a fixed word from OAUTH_STATE_REASONS, never the
 * state itself.
 *
 * @returns {{ok: boolean, reason: string|null, payload: object|null}}
 */
export function inspectOAuthState(state, opts = {}) {
  const raw = typeof state === 'string' ? state : '';
  if (!raw) return refuse(OAUTH_STATE_REASONS.MISSING);

  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX || !parts[1] || !parts[2]) {
    // Anything that is not in our format at all. In practice this is a state
    // minted by the OLD code (a bare uuid, `uuid|native`, or base64url JSON),
    // which is exactly what an attacker's hand written state looks like too.
    // There is no way to tell the two apart, so both are refused.
    return refuse(
      raw.startsWith(`${PREFIX}.`)
        ? OAUTH_STATE_REASONS.MALFORMED
        : OAUTH_STATE_REASONS.LEGACY_UNSIGNED,
    );
  }

  const key = stateKey();
  // Fail CLOSED. If the secret went missing between minting and returning,
  // nothing gets accepted on trust.
  if (!key) return refuse(OAUTH_STATE_REASONS.NO_SECRET);

  const expected = createHmac('sha256', key).update(`${PREFIX}.${parts[1]}`).digest();
  const given = Buffer.from(parts[2], 'base64url');
  // timingSafeEqual throws on a length mismatch, so check that first. The
  // length of a signature is not a secret.
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return refuse(OAUTH_STATE_REASONS.BAD_SIGNATURE);
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch {
    return refuse(OAUTH_STATE_REASONS.MALFORMED);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return refuse(OAUTH_STATE_REASONS.MALFORMED);
  }

  const issuedAt = Number(payload.iat);
  if (!Number.isFinite(issuedAt)) return refuse(OAUTH_STATE_REASONS.MALFORMED);

  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const maxAge = Number.isFinite(opts.maxAgeMs) ? opts.maxAgeMs : OAUTH_STATE_MAX_AGE_MS;
  const age = now - issuedAt;
  if (age > maxAge || age < -FUTURE_SKEW_MS) return refuse(OAUTH_STATE_REASONS.EXPIRED);

  return { ok: true, reason: null, payload };
}

/**
 * The payload, or null if the state is not one we minted, has been edited, or
 * is too old.
 */
export function verifyOAuthState(state, opts = {}) {
  const result = inspectOAuthState(state, opts);
  return result.ok ? result.payload : null;
}

/**
 * Read the claims WITHOUT verifying anything.
 *
 * For presentation only, and there is exactly one caller: the Instagram
 * callback has to decide whether to render the "go back to the app" page or
 * redirect to the web settings screen, and it has to decide that even when the
 * state failed to verify, or a phone gets a blank redirect to a login form.
 * Choosing which apology to draw is not a security decision.
 *
 * Never use this for identity. Nothing it returns is trustworthy.
 */
export function peekOAuthStateClaims(state) {
  const raw = typeof state === 'string' ? state : '';
  const parts = raw.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX || !parts[1]) return {};
  try {
    const claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return claims && typeof claims === 'object' && !Array.isArray(claims) ? claims : {};
  } catch {
    return {};
  }
}
