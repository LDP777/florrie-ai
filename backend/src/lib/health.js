/**
 * Health checks that can actually fail.
 *
 * WHY THIS EXISTS
 * /health used to be `res.json({ status: 'ok' })`, a literal. BetterStack has
 * been monitoring it happily throughout every incident this codebase has had:
 * while the Stripe webhook rejected every event for six weeks, while the
 * Instagram token was dead for five, while card charges were failing to record.
 * A monitor that cannot go red is decoration.
 *
 * Design rules learned from those incidents:
 *   - Prove the dependency, do not assert it. A round trip, not a variable.
 *   - Fast and bounded. A health check that hangs is an outage of its own.
 *   - Never throw. The handler must always answer, even when everything is
 *     broken, because "no response" tells a human nothing.
 *   - Two tiers. CRITICAL means the service cannot do its job right now and
 *     BetterStack should page. WARN means a human needs to act but paging every
 *     30 seconds for days (an expired Instagram token only Ellie can reconnect)
 *     would just train everyone to ignore the alarm.
 */
import * as Sentry from '@sentry/node';
import { supabase } from '../config.js';
import logger from './logger.js';
import { readJobRuns } from './job-runs.js';

const DEFAULT_TIMEOUT_MS = 3000;

// A cron that claims a daily cadence but has not succeeded in a day and a half
// has stopped, whether it is throwing or was never scheduled after the last
// redeploy. 36h leaves room for one missed run plus deploy churn. Used only
// when the caller gives a bare job name with no cadence.
const STALE_JOB_MS = 36 * 60 * 60 * 1000;

// When the caller passes a cadence (the scheduler knows all of them), judge
// each job against its own clock instead. Two whole missed cycles plus an
// hour of deploy churn: a 5 minute job goes stale after 70 minutes, a daily
// one after 49 hours. One skipped run must never page anybody, because that
// is how a monitor gets ignored.
function staleAfterMs(intervalMs) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) return STALE_JOB_MS;
  return intervalMs * 2 + 60 * 60 * 1000;
}

// Accepts either 'name' or { name, intervalMs }, so existing callers and
// tests that pass plain strings keep working.
function normaliseJobSpecs(specs) {
  return (specs || []).map((spec) => (
    typeof spec === 'string'
      ? { name: spec, staleAfterMs: STALE_JOB_MS }
      : { name: spec.name, staleAfterMs: staleAfterMs(spec.intervalMs) }
  )).filter((spec) => spec.name);
}

const IG_EXPIRY_WARN_MS = 7 * 24 * 60 * 60 * 1000;

// 42703 = column does not exist. Same shape as lib/junk-classifier.js
// isMissingColumnError. Health must degrade to "unknown" on an un-run
// migration, never to "failing", or applying migrations by hand would page
// everyone in the meantime.
function isMissingColumnError(error) {
  if (!error) return false;
  if (error.code === '42703') return true;
  return /column .* does not exist/i.test(error.message || '');
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, status: 'fail', detail: `timed out after ${ms}ms`, timedOut: true, check: label }), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Cheapest possible proof that Supabase is reachable and the service key still
 * works. head + count sends no rows over the wire.
 */
async function checkSupabase() {
  const { count, error } = await supabase
    .from('beauticians')
    .select('id', { count: 'exact', head: true });

  if (error) {
    return { ok: false, status: 'fail', critical: true, detail: error.message || 'query failed' };
  }
  return { ok: true, status: 'ok', critical: true, beauticians: count ?? null };
}

/**
 * An authenticated Stripe call. Proves the key is present, valid and not
 * revoked. balance.retrieve is the cheapest authenticated endpoint there is.
 */
async function checkStripeApi(stripe) {
  if (!stripe) {
    // Not configured is a deployment choice, not a fault. Say so plainly rather
    // than passing it off as healthy.
    return { ok: true, status: 'skipped', critical: false, detail: 'STRIPE_SECRET_KEY not set' };
  }
  try {
    const balance = await stripe.balance.retrieve();
    const available = (balance?.available || []).reduce((a, b) => a + (b.amount || 0), 0);
    const pending = (balance?.pending || []).reduce((a, b) => a + (b.amount || 0), 0);
    return {
      ok: true,
      status: 'ok',
      critical: true,
      livemode: Boolean(balance?.livemode),
      // The platform balance went negative once because destination charges
      // meant the platform paid Stripe's processing fee out of a cut that did
      // not cover it. Worth seeing at a glance.
      available_pence: available,
      pending_pence: pending,
    };
  } catch (err) {
    return { ok: false, status: 'fail', critical: true, detail: err?.message || 'stripe call failed' };
  }
}

/**
 * The webhook secret. Missing means every Stripe event is rejected, which is
 * the six-week incident exactly.
 *
 * Honest caveat, because a check that overclaims is its own trap: presence does
 * not prove correctness, and the six-week outage was a MISMATCHED secret, not
 * an absent one. checkStripeWebhookActivity below is the check that catches
 * that case; this one catches the trivial version instantly.
 */
function checkStripeWebhookSecret(stripeConfigured) {
  if (!stripeConfigured) {
    return { ok: true, status: 'skipped', critical: false, detail: 'Stripe not configured' };
  }
  const present = Boolean(process.env.STRIPE_WEBHOOK_SECRET);
  return present
    ? { ok: true, status: 'ok', critical: true }
    : { ok: false, status: 'fail', critical: true, detail: 'STRIPE_WEBHOOK_SECRET missing, every Stripe event will be rejected' };
}

/**
 * Is the webhook actually landing? Card payments happening with no webhook
 * events recorded alongside them is the signature of a rejected signature.
 * Warn rather than critical: a genuinely quiet week is indistinguishable at
 * small volumes, so this points a human at the question instead of paging.
 */
async function checkStripeWebhookActivity(stripeConfigured) {
  if (!stripeConfigured) {
    return { ok: true, status: 'skipped', critical: false, detail: 'Stripe not configured' };
  }
  const sinceIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const events = await supabase
    .from('stripe_events')
    .select('id', { count: 'exact', head: true })
    .gte('processed_at', sinceIso);

  if (events.error) {
    // The table may not exist in a given environment. Unknown, not failing.
    return { ok: true, status: 'unknown', critical: false, detail: events.error.message || 'stripe_events unreadable' };
  }

  const cardPayments = await supabase
    .from('transactions')
    .select('id', { count: 'exact', head: true })
    .not('stripe_payment_intent_id', 'is', null)
    .gte('created_at', sinceIso);

  if (cardPayments.error) {
    return { ok: true, status: 'unknown', critical: false, detail: cardPayments.error.message || 'transactions unreadable' };
  }

  const eventCount = events.count || 0;
  const paymentCount = cardPayments.count || 0;

  if (eventCount === 0 && paymentCount > 0) {
    return {
      ok: false,
      status: 'warn',
      critical: false,
      events_7d: eventCount,
      card_payments_7d: paymentCount,
      detail: 'card payments recorded but no Stripe webhook events in 7 days, signature verification is probably failing',
    };
  }
  return { ok: true, status: 'ok', critical: false, events_7d: eventCount, card_payments_7d: paymentCount };
}

/**
 * Instagram tokens, read from our own rows only.
 *
 * Deliberately does NOT call Meta per tenant: /health is polled every 30
 * seconds by BetterStack and a per-tenant Graph call would be both slow and a
 * rate-limit risk. GET /api/instagram/status does the live check, once, when
 * Ellie opens the screen.
 *
 * Warn rather than critical: reconnecting is a human action that can take days
 * (Ellie's token died on 21 June and outbound Instagram was dead for five
 * weeks), and a monitor that stays red for a week gets muted.
 */
async function checkInstagramTokens() {
  const withExpiry = await supabase
    .from('beauticians')
    .select('id, instagram_page_id, instagram_page_token, instagram_token_expires_at')
    .not('instagram_page_id', 'is', null);

  let rows = withExpiry.data;
  let expiryTracked = true;

  if (withExpiry.error) {
    if (!isMissingColumnError(withExpiry.error)) {
      return { ok: true, status: 'unknown', critical: false, detail: withExpiry.error.message || 'beauticians unreadable' };
    }
    // No expiry column in this schema yet. Fall back to what we can prove.
    expiryTracked = false;
    const fallback = await supabase
      .from('beauticians')
      .select('id, instagram_page_id, instagram_page_token')
      .not('instagram_page_id', 'is', null);
    if (fallback.error) {
      return { ok: true, status: 'unknown', critical: false, detail: fallback.error.message || 'beauticians unreadable' };
    }
    rows = fallback.data;
  }

  const connected = rows || [];
  // Storing an account id is not the same as being connected. A row with an
  // instagram_page_id and no token is an account the UI will happily call
  // "Connected" while every outbound message fails.
  const invalid = connected.filter((b) => !b.instagram_page_token).length;

  let expiringSoon = 0;
  if (expiryTracked) {
    const cutoff = Date.now() + IG_EXPIRY_WARN_MS;
    expiringSoon = connected.filter((b) => {
      const ms = Date.parse(b.instagram_token_expires_at || '');
      return Number.isFinite(ms) && ms <= cutoff;
    }).length;
  }

  const problem = invalid + expiringSoon;
  return {
    ok: problem === 0,
    status: problem === 0 ? 'ok' : 'warn',
    critical: false,
    connected_accounts: connected.length,
    invalid,
    expiring_within_7d: expiringSoon,
    expiry_tracked: expiryTracked,
    ...(problem === 0 ? {} : { detail: 'one or more Instagram connections need reconnecting, outbound Instagram is dead for those accounts' }),
  };
}

/**
 * Cron heartbeats. Reads job_runs (migration 020). If the migration has not
 * been applied the answer is "unknown", never "failing".
 */
async function checkJobs(specs) {
  const jobSpecs = normaliseJobSpecs(specs);
  const { available, rows, reason } = await readJobRuns(jobSpecs.map((s) => s.name));
  if (!available) {
    return { ok: true, status: 'unknown', critical: false, detail: reason || 'job_runs unavailable' };
  }

  const byName = new Map((rows || []).map((r) => [r.job_name, r]));
  const jobs = {};
  const stale = [];

  for (const { name, staleAfterMs: threshold } of jobSpecs) {
    const row = byName.get(name);
    if (!row) {
      // No row yet means it has never run since the migration. On a fresh
      // deploy that is normal for a few minutes, so it is not a failure.
      jobs[name] = { status: 'never_run' };
      continue;
    }
    const lastSuccessMs = Date.parse(row.last_success_at || '');
    const isStale = !Number.isFinite(lastSuccessMs) || (Date.now() - lastSuccessMs) > threshold;
    jobs[name] = {
      status: isStale ? 'stale' : 'ok',
      last_success_at: row.last_success_at || null,
      consecutive_failures: row.consecutive_failures || 0,
      ...(row.last_error ? { last_error: String(row.last_error).slice(0, 200) } : {}),
    };
    if (isStale) stale.push(name);
  }

  return {
    ok: stale.length === 0,
    status: stale.length === 0 ? 'ok' : 'warn',
    critical: false,
    jobs,
    ...(stale.length ? { detail: `stale jobs: ${stale.join(', ')}` } : {}),
  };
}

/**
 * Run every check in parallel, each individually timed out, and fold the
 * results into one answer.
 *
 * @param {object} [deps]
 * @param {object|null} [deps.stripe] a Stripe client, or null when unconfigured
 * @param {number} [deps.timeoutMs]
 * @param {Array<string|{name:string,intervalMs:number}>} [deps.jobs] jobs whose
 *   heartbeat should be reported. Pass the scheduler registry so the names
 *   here can never drift from the names that actually run.
 * @returns {Promise<{status:string, checks:object, failing:string[], warnings:string[]}>}
 */
export async function runHealthChecks({ stripe = null, timeoutMs = DEFAULT_TIMEOUT_MS, jobs: jobSpecs = ['reconciliation'] } = {}) {
  const startedAt = Date.now();
  const stripeConfigured = Boolean(stripe);

  const guarded = (label, fn) => withTimeout(
    Promise.resolve()
      .then(fn)
      // A check that throws is a failed check, not a failed endpoint.
      .catch((err) => ({ ok: false, status: 'fail', detail: err?.message || 'check threw' })),
    timeoutMs,
    label,
  );

  const [database, stripeApi, webhookSecret, webhookActivity, instagram, jobs] = await Promise.all([
    guarded('database', checkSupabase),
    guarded('stripe_api', () => checkStripeApi(stripe)),
    guarded('stripe_webhook_secret', () => checkStripeWebhookSecret(stripeConfigured)),
    guarded('stripe_webhook_activity', () => checkStripeWebhookActivity(stripeConfigured)),
    guarded('instagram_tokens', checkInstagramTokens),
    guarded('crons', () => checkJobs(jobSpecs)),
  ]);

  const checks = {
    database,
    stripe_api: stripeApi,
    stripe_webhook_secret: webhookSecret,
    stripe_webhook_activity: webhookActivity,
    instagram_tokens: instagram,
    crons: jobs,
  };

  // A timed-out check has no `critical` flag of its own, so treat a timeout on
  // a known-critical dependency as critical. Silence from the database is not
  // reassurance.
  const CRITICAL = new Set(['database', 'stripe_api', 'stripe_webhook_secret']);

  const failing = [];
  const warnings = [];
  for (const [name, result] of Object.entries(checks)) {
    if (result.ok) continue;
    const isCritical = result.critical === true || (result.timedOut && CRITICAL.has(name));
    (isCritical ? failing : warnings).push(name);
  }

  return {
    status: failing.length ? 'degraded' : 'ok',
    service: 'florrie-api',
    version: '0.1.0',
    checked_at: new Date().toISOString(),
    duration_ms: Date.now() - startedAt,
    checks,
    failing,
    warnings,
  };
}

/**
 * Report a degraded result to Sentry, at most once every quarter of an hour.
 *
 * /health is polled every 30 seconds; without this throttle a single broken
 * dependency would file thousands of events, which is its own kind of silence.
 */
let lastDegradedReportMs = 0;
const DEGRADED_REPORT_INTERVAL_MS = 15 * 60 * 1000;

export function reportDegraded(result) {
  const now = Date.now();
  if (now - lastDegradedReportMs < DEGRADED_REPORT_INTERVAL_MS) return;
  lastDegradedReportMs = now;

  logger.error({ failing: result.failing, warnings: result.warnings, checks: result.checks }, 'HEALTH DEGRADED');
  Sentry.captureMessage('Health check degraded', {
    level: 'error',
    tags: { area: 'infra', check: 'health' },
    extra: { failing: result.failing, warnings: result.warnings, checks: result.checks },
  });
}
