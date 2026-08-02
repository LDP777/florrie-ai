/**
 * Every background job, in one list.
 *
 * This replaces roughly fifteen `setInterval` calls and nine `setTimeout`
 * startup kicks that used to live inside `app.listen` in index.js. Nothing
 * about what the jobs DO has changed. What changed is when they are called and
 * how we know whether they ran. See lib/scheduler.js for the mechanism.
 *
 * READING THE TABLE
 *   intervalMs      how often the job should SUCCEED. Same cadence as before.
 *   startupDelayMs  do not run in the first N ms of process life. Only used
 *                   where the old code had a deliberate settle delay.
 *   leaseMs         how long a started run is presumed still alive before
 *                   another replica may retry it. Raise it for slow jobs.
 *
 * WHAT THE OLD STARTUP KICKS BECAME
 * Most jobs had a `setTimeout(fn, 30s..240s)` alongside the interval, for one
 * of two reasons:
 *   (a) "the container restarts too often for a 24h interval to mature" , this
 *       is now handled properly. A daily job runs on the first tick after 24h
 *       since its last SUCCESS, restarts included. The kick is not needed.
 *   (b) staggering, so a deploy did not fire everything at once , the
 *       scheduler caps starts per tick instead, which is the same intent
 *       expressed once rather than as a ladder of magic numbers.
 * Where a delay genuinely meant "let the database connections settle first",
 * it is kept as startupDelayMs.
 *
 * TWO JOBS THAT HAD NEVER RUN
 * `trial-expiry` and `surplus-billing` were daily setIntervals with no startup
 * kick, on a service that redeploys most days. setInterval does not fire until
 * a full interval has passed, so neither had any realistic chance of executing
 * in production, and nothing recorded that. Both are safe to run now: they are
 * idempotent, and the scheduler will not run them more than once a day across
 * all replicas. Watch job_runs after the first deploy.
 */
import { registerJob } from '../lib/scheduler.js';

import { processReminders } from '../services/notifications.js';
import { cleanupStaleBookings } from '../services/cleanup.js';
import { refreshInstagramTokens } from '../services/instagram-token-refresh.js';
import { expireStaleOutboundSends } from '../services/outbound-expiry.js';
import { runMoneyMoments } from '../services/money-moments.js';
import { runWeekInReview } from '../services/week-in-review.js';
import { publishScheduledPosts } from '../services/content-scheduler.js';
import { runVoiceProfileRefresh } from '../services/voice-profile.js';
import { runAutonomousCycle } from '../services/autonomous-scheduler.js';
import { autoCompletePastAppointments } from '../services/auto-complete.js';
import { runPredictiveNudges } from '../services/predictive-nudge.js';
import { runDailyHeartbeats } from '../services/florrie-heartbeat.js';
import { processEmailQueue, checkTrialExpiry } from '../services/email-sequences.js';
import { processRetryQueue as processWhatsAppRetryQueue } from '../services/whatsapp-retry.js';
import { runComeback } from './comeback.js';
import { cleanupStripeEvents } from '../services/stripe-cleanup.js';
import { billMonthlySurplus } from '../services/whatsapp-metering.js';
import { runReconciliation } from '../services/reconciliation.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const JOBS = [
  {
    name: 'reminders',
    description: '24h appointment reminders',
    intervalMs: HOUR,
    handler: processReminders,
    // The old code deliberately had NO startup kick: running on every boot
    // re-sent the same 24h reminder on every deploy. Due-based scheduling
    // gives the stronger version of that guarantee, at most one pass an hour
    // no matter how often the container restarts, so the intent survives while
    // the missed-hour problem goes away.
  },
  {
    name: 'stale-booking-cleanup',
    description: 'auto-cancel unpaid deposit bookings after 15 minutes',
    intervalMs: 5 * MINUTE,
    handler: cleanupStaleBookings,
  },
  {
    name: 'instagram-token-refresh',
    description: 'refresh 60 day Instagram Business Login tokens',
    intervalMs: DAY,
    handler: refreshInstagramTokens,
    startupDelayMs: MINUTE,
  },
  {
    name: 'outbound-expiry',
    description: 'expire proactive sends nobody ever answered',
    intervalMs: 6 * HOUR,
    handler: expireStaleOutboundSends,
  },
  {
    name: 'content-scheduler',
    description: 'publish scheduled posts whose time has arrived',
    intervalMs: 5 * MINUTE,
    handler: publishScheduledPosts,
  },
  {
    name: 'money-moments',
    description: 'evening money moment, fires in the salon local window',
    intervalMs: HOUR,
    handler: runMoneyMoments,
  },
  {
    // Shared one setInterval with money-moments before. Separate jobs now, so
    // one failing cannot silently take the other down with it.
    name: 'week-in-review',
    description: 'weekly review, fires in the salon local window',
    intervalMs: HOUR,
    handler: runWeekInReview,
  },
  {
    name: 'voice-profile-refresh',
    description: 'distil each beautician own writing style',
    intervalMs: 7 * DAY,
    handler: runVoiceProfileRefresh,
    startupDelayMs: 5 * MINUTE,
    leaseMs: 30 * MINUTE,
  },
  {
    name: 'autonomous-cycle',
    description: 'rebook nudges, gap posts, unanswered messages',
    intervalMs: 2 * HOUR,
    handler: runAutonomousCycle,
    startupDelayMs: 30 * 1000,
    leaseMs: 30 * MINUTE,
  },
  {
    name: 'predictive-nudges',
    description: 'daily predictive nudge scan',
    intervalMs: DAY,
    handler: runPredictiveNudges,
    startupDelayMs: MINUTE,
  },
  {
    name: 'auto-complete',
    description: 'mark past appointments completed and log takings',
    intervalMs: 10 * MINUTE,
    handler: autoCompletePastAppointments,
    startupDelayMs: 45 * 1000,
  },
  {
    name: 'daily-heartbeat',
    description: 'once-daily passive checks that populate the Hub feed',
    intervalMs: DAY,
    handler: runDailyHeartbeats,
    startupDelayMs: 75 * 1000,
  },
  {
    name: 'email-queue',
    description: 'send due sequence emails',
    intervalMs: 15 * MINUTE,
    handler: processEmailQueue,
    startupDelayMs: 45 * 1000,
  },
  {
    // NEVER RAN IN PRODUCTION. Daily setInterval, no startup kick, on a
    // container that rarely lived 24 hours.
    name: 'trial-expiry',
    description: 'warn trials that are about to end',
    intervalMs: DAY,
    handler: checkTrialExpiry,
  },
  {
    name: 'whatsapp-retry',
    description: 'retry WhatsApp number registration once Meta releases cooldowns',
    intervalMs: 5 * MINUTE,
    handler: processWhatsAppRetryQueue,
    startupDelayMs: 90 * 1000,
  },
  {
    name: 'comeback',
    description: 're-engage lapsed clients',
    intervalMs: DAY,
    handler: runComeback,
    startupDelayMs: 2 * MINUTE,
    leaseMs: 30 * MINUTE,
  },
  {
    // NEVER RAN IN PRODUCTION, same reason as trial-expiry. Its own comment
    // even recorded that the per-boot run had been removed because frequent
    // deploys caused many billing passes a day. Once removed, the daily
    // interval was the only trigger left, and it never matured.
    //
    // Safe now: the rows are claimed optimistically (billed=true gated on
    // billed=false) so an overlap cannot double-bill, and this scheduler
    // guarantees one run a day across every replica rather than one a deploy.
    name: 'surplus-billing',
    description: 'bill completed months over the 120 message allowance',
    intervalMs: DAY,
    handler: billMonthlySurplus,
    leaseMs: 30 * MINUTE,
  },
  {
    name: 'stripe-events-cleanup',
    description: 'prune stripe_events rows past TTL',
    intervalMs: DAY,
    handler: cleanupStripeEvents,
    startupDelayMs: 3 * MINUTE,
  },
  {
    // Reports, never repairs. Already wrapped in recordJobRun before this
    // scheduler existed; the wrapping now comes from the scheduler instead so
    // there is exactly one place that stamps job_runs.
    name: 'reconciliation',
    description: 'nightly Stripe versus ledger money reconciliation',
    intervalMs: DAY,
    handler: runReconciliation,
    startupDelayMs: 4 * MINUTE,
    leaseMs: 30 * MINUTE,
  },
];

/** Register the lot. Call once, before startScheduler(). */
export function registerAllJobs() {
  for (const job of JOBS) registerJob(job);
  return JOBS.length;
}
