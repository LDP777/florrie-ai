/**
 * OAuth `state` has to be unforgeable, because three callbacks decide whose
 * credentials to overwrite from it.
 *
 * The bug: /api/gcal/callback, /api/instagram/callback and /api/hmrc/callback
 * read the beautician id straight out of `state`. A beautician id is public
 * (GET /api/booking/:slug returns it on every booking page), so anyone could
 * run the OAuth dance with their own Google or Instagram account, hand back a
 * victim's id, and have the server file THEIR tokens on HER row. Her diary
 * then syncs into a stranger's calendar and her DMs route to a stranger's
 * inbox.
 *
 * So the cases below are the attack, not a formality: a swapped id, an edited
 * payload, a borrowed signature, a stale state, and the old unsigned format
 * that anyone can type out by hand.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { createHmac, createHash } from 'crypto';
import {
  signOAuthState,
  verifyOAuthState,
  inspectOAuthState,
  peekOAuthStateClaims,
  oauthStateSecretProblem,
  OAUTH_STATE_MAX_AGE_MS,
  OAUTH_STATE_REASONS,
  OAuthStateError,
} from '../../src/lib/oauth-state.js';

const VICTIM = '11111111-1111-4111-8111-111111111111';
const ATTACKER = '22222222-2222-4222-8222-222222222222';

/** Rebuild a state string from parts, the way a forger would. */
const encode = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');

let savedEncryptionKey;
let savedServiceKey;

beforeEach(() => {
  savedEncryptionKey = process.env.ENCRYPTION_KEY;
  savedServiceKey = process.env.SUPABASE_SERVICE_KEY;
  process.env.ENCRYPTION_KEY = 'a'.repeat(64);
});

afterEach(() => {
  if (savedEncryptionKey === undefined) delete process.env.ENCRYPTION_KEY;
  else process.env.ENCRYPTION_KEY = savedEncryptionKey;
  if (savedServiceKey === undefined) delete process.env.SUPABASE_SERVICE_KEY;
  else process.env.SUPABASE_SERVICE_KEY = savedServiceKey;
});

describe('a valid round trip', () => {
  it('gives back the payload it was given', () => {
    const state = signOAuthState({ beauticianId: VICTIM });
    expect(verifyOAuthState(state)).toMatchObject({ beauticianId: VICTIM });
  });

  it('carries the extra fields each flow needs, such as the native marker', () => {
    const state = signOAuthState({ beauticianId: VICTIM, platform: 'native' });
    expect(verifyOAuthState(state).platform).toBe('native');
  });

  it('stamps an issued-at', () => {
    const state = signOAuthState({ beauticianId: VICTIM }, { now: 1_700_000_000_000 });
    expect(verifyOAuthState(state, { now: 1_700_000_000_000 }).iat).toBe(1_700_000_000_000);
  });

  it('is url safe, so it survives the trip through the provider unescaped', () => {
    const state = signOAuthState({ beauticianId: VICTIM, platform: 'native' });
    expect(state).toBe(encodeURIComponent(state));
    expect(state).toMatch(/^v1\.[\w-]+\.[\w-]+$/);
  });

  it('does not repeat itself, because the timestamp moves', () => {
    const first = signOAuthState({ beauticianId: VICTIM }, { now: 1000 });
    const second = signOAuthState({ beauticianId: VICTIM }, { now: 2000 });
    expect(first).not.toBe(second);
  });
});

describe('a tampered payload', () => {
  it('refuses a state whose body was swapped for another id', () => {
    const state = signOAuthState({ beauticianId: ATTACKER });
    const [prefix, , signature] = state.split('.');
    const forged = [prefix, encode({ beauticianId: VICTIM, iat: Date.now() }), signature].join('.');

    expect(verifyOAuthState(forged)).toBeNull();
    expect(inspectOAuthState(forged).reason).toBe(OAUTH_STATE_REASONS.BAD_SIGNATURE);
  });

  it('refuses a flipped character in the signature', () => {
    const state = signOAuthState({ beauticianId: VICTIM });
    const flipped = state.slice(0, -1) + (state.endsWith('A') ? 'B' : 'A');
    expect(verifyOAuthState(flipped)).toBeNull();
  });

  it('refuses a state signed with a different secret', () => {
    const body = encode({ beauticianId: VICTIM, iat: Date.now() });
    const wrongKey = createHash('sha256').update('florrie.oauth.state.v1:not-the-secret').digest();
    const signature = createHmac('sha256', wrongKey).update(`v1.${body}`).digest().toString('base64url');

    expect(verifyOAuthState(`v1.${body}.${signature}`)).toBeNull();
  });

  it('refuses a truncated signature rather than throwing on the length', () => {
    const state = signOAuthState({ beauticianId: VICTIM });
    const [prefix, body, signature] = state.split('.');
    const short = [prefix, body, signature.slice(0, 10)].join('.');

    expect(() => verifyOAuthState(short)).not.toThrow();
    expect(verifyOAuthState(short)).toBeNull();
  });

  it('refuses a payload that is not an object', () => {
    const forged = `v1.${encode(['beauticianId', VICTIM])}.x`;
    expect(verifyOAuthState(forged)).toBeNull();
  });
});

describe('an expired state', () => {
  const minted = 1_700_000_000_000;

  it('accepts one that is a few minutes old', () => {
    const state = signOAuthState({ beauticianId: VICTIM }, { now: minted });
    expect(verifyOAuthState(state, { now: minted + 5 * 60 * 1000 })).not.toBeNull();
  });

  it('refuses one past the ten minute window', () => {
    const state = signOAuthState({ beauticianId: VICTIM }, { now: minted });
    const later = minted + OAUTH_STATE_MAX_AGE_MS + 1000;

    expect(verifyOAuthState(state, { now: later })).toBeNull();
    expect(inspectOAuthState(state, { now: later }).reason).toBe(OAUTH_STATE_REASONS.EXPIRED);
  });

  it('refuses one stamped well into the future', () => {
    const state = signOAuthState({ beauticianId: VICTIM }, { now: minted + 60 * 60 * 1000 });
    expect(verifyOAuthState(state, { now: minted })).toBeNull();
  });

  it('refuses a state with no issued-at at all, even correctly signed', () => {
    // Signed with the real key, so only the missing iat can reject it.
    const body = encode({ beauticianId: VICTIM });
    const key = createHash('sha256')
      .update(`florrie.oauth.state.v1:${process.env.ENCRYPTION_KEY}`)
      .digest();
    const signature = createHmac('sha256', key).update(`v1.${body}`).digest().toString('base64url');

    expect(verifyOAuthState(`v1.${body}.${signature}`)).toBeNull();
  });
});

describe('an unsigned legacy state', () => {
  // Exactly what the old code minted, and exactly what an attacker types.
  const legacy = [
    ['a bare beautician id, as Google Calendar used to send', VICTIM],
    ['the Instagram id with a native suffix', `${VICTIM}|native`],
    ['the HMRC base64url json', Buffer.from(JSON.stringify({ beauticianId: VICTIM })).toString('base64url')],
  ];

  it.each(legacy)('refuses %s', (_label, state) => {
    expect(verifyOAuthState(state)).toBeNull();
    expect(inspectOAuthState(state).reason).toBe(OAUTH_STATE_REASONS.LEGACY_UNSIGNED);
  });

  it('refuses an empty or missing state', () => {
    expect(verifyOAuthState('')).toBeNull();
    expect(verifyOAuthState(undefined)).toBeNull();
    expect(verifyOAuthState(null)).toBeNull();
    expect(inspectOAuthState(undefined).reason).toBe(OAUTH_STATE_REASONS.MISSING);
  });

  it('refuses something that only looks like our format', () => {
    expect(inspectOAuthState('v1.notbase64.nope').reason).toBe(OAUTH_STATE_REASONS.BAD_SIGNATURE);
    expect(inspectOAuthState('v1..').reason).toBe(OAUTH_STATE_REASONS.MALFORMED);
    expect(verifyOAuthState('v2.abc.def')).toBeNull();
  });

  it('refuses a non string', () => {
    expect(verifyOAuthState(42)).toBeNull();
    expect(verifyOAuthState({ beauticianId: VICTIM })).toBeNull();
  });
});

describe('a state signed for a different beautician', () => {
  it('still names that other beautician, so it can never speak for the victim', () => {
    const attackerState = signOAuthState({ beauticianId: ATTACKER });
    expect(verifyOAuthState(attackerState).beauticianId).toBe(ATTACKER);
    expect(verifyOAuthState(attackerState).beauticianId).not.toBe(VICTIM);
  });

  it('cannot lend its signature to a state naming the victim', () => {
    const attackerState = signOAuthState({ beauticianId: ATTACKER }, { now: 1_700_000_000_000 });
    const victimState = signOAuthState({ beauticianId: VICTIM }, { now: 1_700_000_000_000 });

    const attackerSignature = attackerState.split('.')[2];
    const victimBody = victimState.split('.')[1];
    const spliced = `v1.${victimBody}.${attackerSignature}`;

    expect(verifyOAuthState(spliced, { now: 1_700_000_000_000 })).toBeNull();
  });

  it('gives the two different signatures in the first place', () => {
    const a = signOAuthState({ beauticianId: ATTACKER }, { now: 1000 });
    const b = signOAuthState({ beauticianId: VICTIM }, { now: 1000 });
    expect(a.split('.')[2]).not.toBe(b.split('.')[2]);
  });
});

describe('the secret', () => {
  it('uses ENCRYPTION_KEY when it is set', () => {
    process.env.SUPABASE_SERVICE_KEY = 'service-key';
    const state = signOAuthState({ beauticianId: VICTIM });

    // Change ENCRYPTION_KEY and the old state must stop verifying, which is
    // only true if ENCRYPTION_KEY is what signed it.
    process.env.ENCRYPTION_KEY = 'b'.repeat(64);
    expect(verifyOAuthState(state)).toBeNull();
  });

  it('falls back to SUPABASE_SERVICE_KEY, which REQUIRED_ENV guarantees', () => {
    delete process.env.ENCRYPTION_KEY;
    process.env.SUPABASE_SERVICE_KEY = 'service-key';

    expect(oauthStateSecretProblem()).toBeNull();
    expect(verifyOAuthState(signOAuthState({ beauticianId: VICTIM }))).toMatchObject({
      beauticianId: VICTIM,
    });
  });

  it('is not the raw secret, so it cannot be confused with the crypto.js key', () => {
    const state = signOAuthState({ beauticianId: VICTIM });
    const body = state.split('.')[1];
    const rawKeySignature = createHmac('sha256', process.env.ENCRYPTION_KEY)
      .update(`v1.${body}`)
      .digest()
      .toString('base64url');

    expect(state.split('.')[2]).not.toBe(rawKeySignature);
  });

  it('fails closed with nothing to sign with', () => {
    delete process.env.ENCRYPTION_KEY;
    delete process.env.SUPABASE_SERVICE_KEY;

    expect(oauthStateSecretProblem()).toMatch(/ENCRYPTION_KEY/);
    expect(oauthStateSecretProblem()).toMatch(/SUPABASE_SERVICE_KEY/);
    expect(() => signOAuthState({ beauticianId: VICTIM })).toThrow(OAuthStateError);
    expect(inspectOAuthState('v1.abc.def').reason).toBe(OAUTH_STATE_REASONS.NO_SECRET);
  });

  it('refuses a state minted before the secret went missing', () => {
    const state = signOAuthState({ beauticianId: VICTIM });
    delete process.env.ENCRYPTION_KEY;
    delete process.env.SUPABASE_SERVICE_KEY;

    expect(verifyOAuthState(state)).toBeNull();
  });

  it('never puts the secret in the state or in the error', () => {
    const state = signOAuthState({ beauticianId: VICTIM });
    expect(state).not.toContain(process.env.ENCRYPTION_KEY);

    delete process.env.ENCRYPTION_KEY;
    delete process.env.SUPABASE_SERVICE_KEY;
    expect(oauthStateSecretProblem()).not.toContain('a'.repeat(64));
  });
});

describe('peeking at the claims', () => {
  // Used by the Instagram callback to pick which apology page to draw when the
  // state does not verify. Presentation only.
  it('reads the platform marker without a signature check', () => {
    const [prefix, body] = signOAuthState({ beauticianId: VICTIM, platform: 'native' }).split('.');
    expect(peekOAuthStateClaims(`${prefix}.${body}.garbage`).platform).toBe('native');
  });

  it('returns nothing for a legacy or nonsense state', () => {
    expect(peekOAuthStateClaims(`${VICTIM}|native`)).toEqual({});
    expect(peekOAuthStateClaims('')).toEqual({});
    expect(peekOAuthStateClaims(undefined)).toEqual({});
  });
});
