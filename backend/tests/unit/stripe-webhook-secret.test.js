/**
 * Two endpoints, one url, one variable.
 *
 * The bug this covers cost every Stripe event Florrie has ever been sent:
 * stripe_events had zero rows in production and the platform endpoint was
 * disabled by Stripe after 452 consecutive 400s. Nothing here weakens
 * verification, so the last group is the important one: a forged event must
 * still be refused no matter how many secrets are configured.
 */
import { describe, it, expect } from 'vitest';
import { parseWebhookSecrets, verifyWebhook } from '../../src/lib/stripe-webhook-secret.js';

/** A Stripe stub that only accepts one known secret. */
function stripeAccepting(good) {
  return {
    webhooks: {
      constructEvent(payload, signature, secret) {
        if (secret !== good) throw new Error('No signatures found matching the expected signature for payload');
        if (signature !== 'sig_ok') throw new Error('No signatures found matching the expected signature for payload');
        return { id: 'evt_1', type: 'checkout.session.completed' };
      },
    },
  };
}

describe('parseWebhookSecrets', () => {
  it('reads a single value', () => {
    expect(parseWebhookSecrets('whsec_aaa')).toEqual(['whsec_aaa']);
  });

  // The shapes a human actually pastes into a Railway variable.
  it('reads a comma separated pair', () => {
    expect(parseWebhookSecrets('whsec_aaa,whsec_bbb')).toEqual(['whsec_aaa', 'whsec_bbb']);
  });

  it('copes with spaces, newlines and a trailing comma', () => {
    expect(parseWebhookSecrets(' whsec_aaa,\n whsec_bbb , ')).toEqual(['whsec_aaa', 'whsec_bbb']);
  });

  it('strips quotes left on by a copy', () => {
    expect(parseWebhookSecrets('"whsec_aaa" \'whsec_bbb\'')).toEqual(['whsec_aaa', 'whsec_bbb']);
  });

  it('de-duplicates so the same secret is not tried twice', () => {
    expect(parseWebhookSecrets('whsec_aaa,whsec_aaa')).toEqual(['whsec_aaa']);
  });

  it('returns nothing for empty or missing', () => {
    expect(parseWebhookSecrets('')).toEqual([]);
    expect(parseWebhookSecrets(undefined)).toEqual([]);
    expect(parseWebhookSecrets(null)).toEqual([]);
  });
});

describe('verifyWebhook', () => {
  it('accepts an event signed with the only configured secret', () => {
    const { event, reason } = verifyWebhook({
      stripe: stripeAccepting('whsec_aaa'), payload: '{}', signature: 'sig_ok', rawSecret: 'whsec_aaa',
    });
    expect(event.id).toBe('evt_1');
    expect(reason).toBeNull();
  });

  // THE BUG. The platform endpoint's secret was second in the list, or absent,
  // and every one of its events was rejected.
  it('accepts an event signed with the SECOND configured secret', () => {
    const { event, secretsTried } = verifyWebhook({
      stripe: stripeAccepting('whsec_bbb'), payload: '{}', signature: 'sig_ok', rawSecret: 'whsec_aaa,whsec_bbb',
    });
    expect(event.id).toBe('evt_1');
    expect(secretsTried).toBe(2);
  });

  it('refuses an event that matches none of them', () => {
    const { event, reason, secretsTried } = verifyWebhook({
      stripe: stripeAccepting('whsec_zzz'), payload: '{}', signature: 'sig_ok', rawSecret: 'whsec_aaa,whsec_bbb',
    });
    expect(event).toBeNull();
    expect(secretsTried).toBe(2);
    expect(reason).toContain('No signatures found');
  });

  it('refuses when the signature header is missing', () => {
    const { event, reason } = verifyWebhook({
      stripe: stripeAccepting('whsec_aaa'), payload: '{}', signature: undefined, rawSecret: 'whsec_aaa',
    });
    expect(event).toBeNull();
    expect(reason).toBe('no stripe-signature header');
  });

  it('refuses when nothing is configured, rather than waving it through', () => {
    const { event, reason, secretsTried } = verifyWebhook({
      stripe: stripeAccepting('whsec_aaa'), payload: '{}', signature: 'sig_ok', rawSecret: '',
    });
    expect(event).toBeNull();
    expect(secretsTried).toBe(0);
    expect(reason).toBe('no webhook secret configured');
  });

  // A bad signature is a bad signature however many secrets exist. Trying more
  // of them must never become a way in.
  it('a forged signature is refused against every secret', () => {
    const { event } = verifyWebhook({
      stripe: stripeAccepting('whsec_aaa'), payload: '{}', signature: 'sig_forged',
      rawSecret: 'whsec_aaa,whsec_bbb,whsec_ccc',
    });
    expect(event).toBeNull();
  });

  // The reason gets logged and sent to Sentry, so it must carry no secret.
  it('never puts a secret in the reason it reports', () => {
    const { reason } = verifyWebhook({
      stripe: stripeAccepting('whsec_zzz'), payload: '{}', signature: 'sig_ok',
      rawSecret: 'whsec_supersecretaaa,whsec_supersecretbbb',
    });
    expect(reason).not.toContain('whsec_');
  });
});
