/**
 * PostHog analytics for florrie.ai — single source of truth.
 *
 * Usage:
 *   import { track, identify } from '@/lib/analytics';
 *   track('onboarding_step_completed', { step: 'whatsapp' });
 *
 * Init is called once from main.jsx. If VITE_POSTHOG_KEY is absent
 * (local dev without a key) every call is a silent no-op — no crashes.
 *
 * Privacy posture:
 *   - autocapture OFF — we emit events deliberately, not by DOM sniffing
 *   - users identified by Supabase auth UUID, never by email
 *   - only email_domain is sent as a trait (no PII)
 *   - session replay masks all input fields by default; use
 *     data-ph-mask="true" on any additional content to mask
 */
import { afterPaint } from './after-paint.js';
import { supabase } from './supabase.js';
import logger from './logger.js';

let initialized = false;

/**
 * PostHog is loaded AFTER first paint, not before it.
 *
 * It is 230 KB — 27% of everything the browser had to fetch before Ellie could
 * see anything, on a screen she opens between clients on mobile data. Measured
 * with scripts/check-boot.mjs on a throttled 4G phone, not guessed at.
 *
 * Nothing is lost by arriving a second late: every call site here is
 * fire-and-forget, and the calls made before the SDK lands are queued and
 * replayed in order. Feature flags read false until it loads, which is safe
 * because nothing in the app reads a flag (grep: zero call sites).
 */
let posthog = null;
const queue = [];

function flush() {
  while (queue.length) {
    const [fn, args] = queue.shift();
    try { posthog[fn](...args); } catch (err) { logger.warn(`PostHog ${fn} failed:`, err); }
  }
}

/** Queue until the SDK is here, then pass straight through. */
function call(fn, ...args) {
  if (!initialized) return;
  if (!posthog) { queue.push([fn, args]); return; }
  try { posthog[fn](...args); } catch (err) { logger.warn(`PostHog ${fn} failed:`, err); }
}

export function initAnalytics() {
  if (initialized) return;

  const key = import.meta.env?.VITE_POSTHOG_KEY;
  const host = import.meta.env?.VITE_POSTHOG_HOST || 'https://eu.i.posthog.com';

  if (!key) {
    // No key = local dev or env-not-set. Silent no-op.
    return;
  }

  initialized = true;   // start accepting calls into the queue immediately

  afterPaint(() => {
    import('posthog-js')
      .then(m => { boot(m.default, key, host); })
      .catch(err => logger.warn('PostHog failed to load:', err));
  });
}

function boot(ph, key, host) {
  try {
    posthog = ph;
    posthog.init(key, {
      api_host: host,
      // We emit events deliberately. Autocapture generates noise that's
      // hard to reason about at low volume.
      autocapture: false,
      // Pageviews + pageleaves are fine — they're the backbone of any funnel.
      capture_pageview: true,
      capture_pageleave: true,
      // 100% session replay sampling while we're pre-launch.
      // Drop to ~10% once we pass ~500 sessions/day.
      disable_session_recording: false,
      session_recording: {
        maskAllInputs: true,
        maskTextSelector: '[data-ph-mask]',
      },
      persistence: 'localStorage+cookie',
      // Don't send events from localhost to prod project.
      loaded: (ph) => {
        if (import.meta.env?.DEV) ph.opt_out_capturing();
      },
    });
    // Anything called between initAnalytics() and now is waiting in the queue.
    flush();
  } catch (err) {
    logger.warn('PostHog init failed:', err);
    posthog = null;
    queue.length = 0;   // do not hold events for an SDK that will never arrive
    return;
  }

  // Hook into Supabase auth so every signed-in session is identified
  // without each page needing to remember to call identify().
  if (supabase) {
    supabase.auth.getUser().then(({ data: { user } }) => {
      if (user?.id) identify(user.id, { email_domain: emailDomain(user.email) });
    });

    supabase.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' && session?.user?.id) {
        identify(session.user.id, { email_domain: emailDomain(session.user.email) });
      } else if (event === 'SIGNED_OUT') {
        reset();
      }
    });
  }
}

export function track(event, props = {}) { call('capture', event, props); }

export function identify(userId, traits = {}) { if (userId) call('identify', userId, traits); }

export function reset() { call('reset'); }

/** Returns true if a feature flag is enabled for the current user. */
export function isFeatureEnabled(flagKey) {
  if (!initialized || !posthog) return false;
  try {
    return posthog.isFeatureEnabled(flagKey);
  } catch {
    return false;
  }
}

/** Returns the variant value for a multivariate flag (string | boolean | null). */
export function getFeatureFlag(flagKey) {
  if (!initialized || !posthog) return null;
  try {
    return posthog.getFeatureFlag(flagKey);
  } catch {
    return null;
  }
}

function emailDomain(email) {
  if (!email || typeof email !== 'string') return null;
  const at = email.indexOf('@');
  return at > -1 ? email.slice(at + 1) : null;
}
