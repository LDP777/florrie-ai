/**
 * Verifying a Stripe webhook when there is more than one endpoint.
 *
 * WHY THIS FILE EXISTS
 * On 3 August Stripe disabled the platform webhook endpoint after nine days of
 * failures. The dashboard showed 452 deliveries this week and 452 of them
 * returned 400. stripe_events had ZERO rows, ever: not one Stripe event has
 * ever been recorded in production.
 *
 * The cause was not a wrong secret. It was TWO endpoints on ONE url:
 *
 *   florrie-platform-events        Your account        5 events    452/452 failed
 *   brilliant-euphoria-snapshot    Connected accounts  26 events   0 deliveries
 *
 * Stripe signs each destination with its own secret. The code read a single
 * STRIPE_WEBHOOK_SECRET, so whichever one was in Railway, every event from the
 * other destination failed verification, permanently and silently. And because
 * these are DESTINATION CHARGES, the PaymentIntent is created on the platform
 * account, so the endpoint that carries every one of Ellie's client payments is
 * the platform one. It is the one that was failing.
 *
 * THE RULE
 * A secret is not a scalar. STRIPE_WEBHOOK_SECRET may hold a comma or
 * whitespace separated list, and an event is genuine if ANY of them verifies
 * it. Adding a second endpoint, or rolling a secret with an overlap window,
 * then stops being an outage: you add the new value and both work.
 *
 * Rejecting is still the default. Nothing here weakens verification: each
 * candidate goes through stripe.webhooks.constructEvent exactly as before, and
 * an event that satisfies none of them is refused.
 */

/**
 * Split the configured secret into candidates.
 *
 * Tolerates the shapes a human actually pastes into a Railway variable: one
 * value, two on one line, quotes left on from a copy, a trailing comma.
 *
 * @param {string} raw
 * @returns {string[]} unique, in the order given
 */
export function parseWebhookSecrets(raw) {
  if (typeof raw !== 'string') return [];
  const parts = raw
    .split(/[,\s]+/)
    .map(s => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
  return [...new Set(parts)];
}

/**
 * Verify against every configured secret and return the first event that
 * checks out.
 *
 * @param {object} args
 * @param {object} args.stripe the Stripe client
 * @param {Buffer|string} args.payload the RAW body, exactly as received
 * @param {string} args.signature the stripe-signature header
 * @param {string} args.rawSecret the STRIPE_WEBHOOK_SECRET value
 * @returns {{event: object|null, secretsTried: number, reason: string|null}}
 *   reason is safe to log: it is Stripe's own message, never a secret.
 */
export function verifyWebhook({ stripe, payload, signature, rawSecret }) {
  const secrets = parseWebhookSecrets(rawSecret);

  if (secrets.length === 0) {
    return { event: null, secretsTried: 0, reason: 'no webhook secret configured' };
  }
  if (!signature) {
    return { event: null, secretsTried: secrets.length, reason: 'no stripe-signature header' };
  }

  let lastReason = null;
  for (const secret of secrets) {
    try {
      const event = stripe.webhooks.constructEvent(payload, signature, secret);
      return { event, secretsTried: secrets.length, reason: null };
    } catch (err) {
      // Stripe's message says which check failed (timestamp outside tolerance,
      // no matching signature) and never contains the secret.
      lastReason = err?.message || 'signature did not verify';
    }
  }

  return { event: null, secretsTried: secrets.length, reason: lastReason };
}
