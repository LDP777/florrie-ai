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
import posthog from 'posthog-js';
import { supabase } from './supabase.js';
import logger from './logger.js';

let initialized = false;

export function initAnalytics() {
  if (initialized) return;

  const key = import.meta.env?.VITE_POSTHOG_KEY;
  const host = import.meta.env?.VITE_POSTHOG_HOST || 'https://eu.i.posthog.com';

  if (!key) {
    // No key = local dev or env-not-set. Silent no-op.
    return;
  }

  try {
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
    initialized = true;
  } catch (err) {
    logger.warn('PostHog init failed:', err);
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

export function track(event, props = {}) {
  if (!initialized) return;
  try {
    posthog.capture(event, props);
  } catch (err) {
    logger.warn('PostHog track failed:', err);
  }
}

export function identify(userId, traits = {}) {
  if (!initialized || !userId) return;
  try {
    posthog.identify(userId, traits);
  } catch (err) {
    logger.warn('PostHog identify failed:', err);
  }
}

export function reset() {
  if (!initialized) return;
  try {
    posthog.reset();
  } catch (err) {
    logger.warn('PostHog reset failed:', err);
  }
}

/** Returns true if a feature flag is enabled for the current user. */
export function isFeatureEnabled(flagKey) {
  if (!initialized) return false;
  try {
    return posthog.isFeatureEnabled(flagKey);
  } catch {
    return false;
  }
}

/** Returns the variant value for a multivariate flag (string | boolean | null). */
export function getFeatureFlag(flagKey) {
  if (!initialized) return null;
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
