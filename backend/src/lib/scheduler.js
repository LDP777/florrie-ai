/**
 * The cron scheduler.
 *
 * WHY THIS EXISTS
 * Every background job used to be a bare `setInterval` inside `app.listen`.
 * That has three failure modes, and this service has been living with all
 * three:
 *
 *   1. setInterval fires for the FIRST time after one whole interval. A 24h
 *      job on a container that redeploys most days never matures, so it never
 *      runs at all. Two jobs were in exactly that state and had, as far as
 *      anything can tell, never once executed in production:
 *        - billMonthlySurplus  (daily, startup kick deliberately removed)
 *        - checkTrialExpiry    (daily, never had a startup kick)
 *      Nothing recorded the absence, because an absence writes no log line.
 *
 *   2. No leader election. Railway runs one replica today. The moment it runs
 *      two, every job runs twice: two reminder sends, two billing passes, two
 *      auto-complete sweeps writing takings.
 *
 *   3. Deploy-time amnesia. A restart resets every timer, so on a bad day the
 *      only jobs that ever ran were the ones with a startup kick, and those
 *      ran on EVERY boot, which is its own bug (the reminder kick was removed
 *      for re-sending the same 24h reminder over and over).
 *
 * HOW THIS FIXES IT
 * Scheduling is DUE-BASED, not interval-based. A tick runs every minute and
 * asks the job_runs ledger a different question: "which jobs have not
 * SUCCEEDED within their own cadence?" A daily job therefore runs on the first
 * tick after 24h have passed since its last success, no matter how many times
 * the process restarted in between. Restarts stop mattering, and a startup
 * kick stops being the only thing that makes a daily job work.
 *
 * The same property kills the double-run problem from the other side: because
 * the clock lives in the database rather than in the process, "already ran
 * recently" is a fact both replicas can see.
 *
 * LEADER ELECTION: claim-by-update, not an advisory lock.
 * The obvious answer is pg_try_advisory_lock. It is the wrong answer here:
 *
 *   - The backend talks to Postgres through PostgREST (supabase-js). There is
 *     no persistent session, and pg_catalog functions are not exposed over
 *     PostgREST, so calling it at all would need a hand-applied SQL wrapper
 *     function and an .rpc() call.
 *   - Even with the wrapper it would not work. Session-level advisory locks
 *     are held by a SESSION. PostgREST returns its connection to the pool the
 *     moment the statement finishes, and production sits behind PgBouncer in
 *     transaction mode, so the lock is released before the job has started.
 *     A lock that unlocks itself immediately is a lie that reads as safety.
 *
 * So the claim is a compare-and-swap on the row we already have:
 *
 *     UPDATE job_runs SET last_started_at = now
 *      WHERE job_name = $1 AND last_started_at IS NOT DISTINCT FROM $observed
 *
 * $observed is the exact value this replica read a moment ago. Postgres takes
 * a row lock for the UPDATE, and under READ COMMITTED the loser re-evaluates
 * its WHERE against the winner's committed row, sees a different
 * last_started_at, and updates zero rows. Exactly one replica gets the job.
 * It needs no new table, no new column, no extension, and it survives
 * PgBouncer because the atomicity is inside a single statement.
 *
 * The trade-off, stated honestly: a replica that claims a job and then dies
 * mid-run leaves last_started_at newer than last_success_at. That is what
 * `leaseMs` is for. The job is treated as in flight, and therefore not
 * re-claimable, until the lease expires. Set a job's lease longer than it
 * could plausibly take to run.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 * It does not change a single job's business logic, its cadence, or its
 * arguments. It only changes when and by whom the function is called.
 */
import logger from './logger.js';
import { supabase } from '../config.js';
import { recordJobRun } from './job-runs.js';

// One tick a minute. The tick reads ONE row set for all jobs, so the cost is a
// single small select per minute, and a minute of granularity keeps the 10
// minute jobs honest. A 5 minute tick would quietly turn every 10 minute job
// into a 15 minute job, because a job that came due 4 minutes ago has to wait
// for the next tick.
const TICK_INTERVAL_MS = 60 * 1000;

// A job whose interval elapsed a few seconds ago should run on THIS tick, not
// the next one. Without this, every cadence drifts a whole tick per cycle and
// an hourly job slowly becomes a 61 minute job, then 62, and so on.
const DUE_TOLERANCE_MS = 30 * 1000;

// How long a claimed run is assumed to still be in progress before another
// replica may take it. Deliberately generous: re-running a job that is still
// working is worse than waiting.
const DEFAULT_LEASE_MS = 15 * 60 * 1000;

// The old startup behaviour was a ladder of setTimeouts (30s, 45s, 60s, 75s,
// 90s, 120s, 180s, 240s) whose only purpose was to stop a deploy firing every
// job at once and spiking the connection pool. Due-based scheduling makes the
// ladder meaningless, so the anti-spike intent is preserved directly: at most
// this many jobs may START on any one tick, most overdue first. Everything
// else waits a minute.
const MAX_STARTS_PER_TICK = 3;

/** @type {Map<string, {name:string, intervalMs:number, startupDelayMs:number, leaseMs:number, handler:Function, description:string}>} */
const registry = new Map();

// Jobs this process currently has in flight. The database claim stops OTHER
// replicas; this stops us from starting a second copy of a job that is simply
// taking longer than one tick.
const inFlight = new Set();

let tickTimer = null;
let bootedAt = 0;
let ledgerWarned = false;

// Fallback clock for when job_runs cannot be read at all (missing table on a
// fresh database, or Supabase down). Scheduling then degrades to in-process
// timing, which is no worse than the setInterval world it replaced, and the
// jobs keep running instead of stopping dead.
const memoryRuns = new Map();

/**
 * Register a job. Call before startScheduler().
 *
 * @param {object} job
 * @param {string} job.name          stable key, also the job_runs primary key
 *                                   and the name /health reports
 * @param {number} job.intervalMs    how often it should SUCCEED
 * @param {Function} job.handler     the work. May be async. Must be idempotent
 * @param {number} [job.startupDelayMs] do not run in the first N ms of process
 *                                   life. Only for jobs that need connections
 *                                   or caches to settle first
 * @param {number} [job.leaseMs]     how long a started run is presumed alive
 * @param {string} [job.description] one line, for logs and humans
 */
export function registerJob({ name, intervalMs, handler, startupDelayMs = 0, leaseMs = DEFAULT_LEASE_MS, description = '' }) {
  if (!name || typeof name !== 'string') throw new Error('registerJob: name is required');
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new Error(`registerJob(${name}): intervalMs must be a positive number`);
  if (typeof handler !== 'function') throw new Error(`registerJob(${name}): handler must be a function`);
  if (registry.has(name)) throw new Error(`registerJob(${name}): already registered`);

  registry.set(name, { name, intervalMs, handler, startupDelayMs, leaseMs, description });
  return registry.get(name);
}

/** Every registered job, with its cadence. /health uses this so the names it
 *  reports and the names that actually run can never drift apart. */
export function listJobs() {
  return [...registry.values()].map(({ name, intervalMs, description }) => ({ name, intervalMs, description }));
}

/** Names only, for callers that just want the list. */
export function jobNames() {
  return [...registry.keys()];
}

/**
 * Should this job run, given what the ledger says about it?
 *
 * Pure, so it can be tested without a database. Returns a reason either way,
 * because "why did this not run" is the question nobody could answer before.
 *
 * @param {object} job
 * @param {object|null} row job_runs row, or null when the job has no row yet
 * @param {object} ctx
 * @param {number} ctx.now epoch ms
 * @param {number} ctx.uptimeMs how long this process has been up
 */
export function dueState(job, row, { now, uptimeMs = Infinity }) {
  if (uptimeMs < (job.startupDelayMs || 0)) {
    return { run: false, reason: 'startup_delay', overdueMs: 0 };
  }

  // No row at all means it has never run since job_runs existed. Infinitely
  // overdue, so it sorts to the front of the queue.
  if (!row) return { run: true, reason: 'never_run', overdueMs: Number.MAX_SAFE_INTEGER };

  const lastSuccess = Date.parse(row.last_success_at || '');
  const lastStarted = Date.parse(row.last_started_at || '');
  const hasSucceeded = Number.isFinite(lastSuccess);

  if (hasSucceeded) {
    const sinceSuccess = now - lastSuccess;
    if (sinceSuccess < job.intervalMs - DUE_TOLERANCE_MS) {
      return { run: false, reason: 'not_due', overdueMs: sinceSuccess - job.intervalMs };
    }
  }

  // Started more recently than it succeeded means a run is either still going
  // or died mid-flight. Wait out the lease before assuming the worst.
  const startedSinceSuccess = Number.isFinite(lastStarted) && (!hasSucceeded || lastStarted > lastSuccess);
  if (startedSinceSuccess) {
    const sinceStart = now - lastStarted;
    const lease = job.leaseMs || DEFAULT_LEASE_MS;
    if (sinceStart < lease) {
      return { run: false, reason: 'in_flight', overdueMs: 0 };
    }
    return { run: true, reason: 'lease_expired', overdueMs: sinceStart };
  }

  const overdueMs = hasSucceeded ? (now - lastSuccess) - job.intervalMs : Number.MAX_SAFE_INTEGER;
  return { run: true, reason: hasSucceeded ? 'due' : 'never_succeeded', overdueMs };
}

// 42P01 = relation does not exist, same degrade path as lib/job-runs.js. An
// un-applied migration is not an outage.
function isMissingTable(error) {
  if (!error) return false;
  if (error.code === '42P01') return true;
  return /relation .* does not exist/i.test(error.message || '');
}

// 23505 = unique violation. Two replicas inserting the first ever row for a
// job: one wins, the loser sees this and simply does not run.
function isUniqueViolation(error) {
  if (!error) return false;
  return error.code === '23505' || /duplicate key value/i.test(error.message || '');
}

async function readLedger(names) {
  const { data, error } = await supabase
    .from('job_runs')
    .select('job_name, last_started_at, last_success_at, consecutive_failures')
    .in('job_name', names);

  // Supabase returns errors in the result object rather than throwing. Every
  // incident in this codebase started with an unchecked result object.
  if (error) {
    if (!ledgerWarned) {
      ledgerWarned = true;
      logger.warn(
        { err: error, missingTable: isMissingTable(error) },
        'Scheduler: job_runs unreadable, falling back to in-process timing (single replica only)',
      );
    }
    return { available: false, byName: new Map() };
  }

  ledgerWarned = false;
  return { available: true, byName: new Map((data || []).map((r) => [r.job_name, r])) };
}

/**
 * Take the job, or discover that another replica already has it.
 *
 * The compare-and-swap is the whole leader election. See the module header for
 * why this and not pg_try_advisory_lock.
 */
async function claim(job, row, now) {
  const stamp = new Date(now).toISOString();

  if (!row) {
    const { error } = await supabase
      .from('job_runs')
      .insert({ job_name: job.name, last_started_at: stamp });
    if (error) {
      if (isUniqueViolation(error)) return false; // another replica got there first
      logger.warn({ err: error, job: job.name }, 'Scheduler: could not create job_runs row, skipping this tick');
      return false;
    }
    return true;
  }

  let query = supabase
    .from('job_runs')
    .update({ last_started_at: stamp })
    .eq('job_name', job.name);

  // Compare against exactly what we read. If anything moved it since, we lose.
  query = row.last_started_at
    ? query.eq('last_started_at', row.last_started_at)
    : query.is('last_started_at', null);

  const { data, error } = await query.select('job_name');
  if (error) {
    logger.warn({ err: error, job: job.name }, 'Scheduler: claim failed, skipping this tick');
    return false;
  }
  // Zero rows back is the normal, expected outcome for the replica that lost.
  return Array.isArray(data) && data.length > 0;
}

async function runJob(job) {
  inFlight.add(job.name);
  memoryRuns.set(job.name, { ...(memoryRuns.get(job.name) || {}), last_started_at: new Date().toISOString() });
  try {
    // recordJobRun stamps job_runs, never throws, and reports failures to
    // Sentry. It is the only path a job should ever be called down.
    const outcome = await recordJobRun(job.name, job.handler);
    if (outcome.ok) {
      memoryRuns.set(job.name, { ...(memoryRuns.get(job.name) || {}), last_success_at: new Date().toISOString() });
      logger.info({ job: job.name, durationMs: outcome.durationMs }, 'Cron job finished');
    }
    return outcome;
  } finally {
    inFlight.delete(job.name);
  }
}

/**
 * One pass over every registered job. Exported so tests can drive it directly
 * rather than waiting on wall-clock time.
 *
 * @param {object} [opts]
 * @param {number} [opts.now]
 * @param {boolean} [opts.await] wait for the jobs it starts (tests only). In
 *   production a slow job must never hold up the tick.
 */
export async function tick({ now = Date.now(), await: awaitJobs = false } = {}) {
  const jobs = [...registry.values()];
  if (jobs.length === 0) return { started: [], skipped: [] };

  const uptimeMs = bootedAt ? now - bootedAt : Infinity;
  const { available, byName } = await readLedger(jobs.map((j) => j.name));

  const candidates = [];
  const skipped = [];

  for (const job of jobs) {
    if (inFlight.has(job.name)) {
      skipped.push({ name: job.name, reason: 'in_flight_here' });
      continue;
    }
    const row = available ? (byName.get(job.name) || null) : (memoryRuns.get(job.name) || null);
    const state = dueState(job, row, { now, uptimeMs });
    if (!state.run) {
      skipped.push({ name: job.name, reason: state.reason });
      continue;
    }
    candidates.push({ job, row, state });
  }

  // Most overdue first, so a job that has been starved does not lose its place
  // every tick to one that merely came due this minute.
  candidates.sort((a, b) => b.state.overdueMs - a.state.overdueMs);

  const started = [];
  const pending = [];
  for (const { job, row, state } of candidates) {
    if (started.length >= MAX_STARTS_PER_TICK) {
      skipped.push({ name: job.name, reason: 'tick_budget' });
      continue;
    }
    if (available) {
      const got = await claim(job, row, now);
      if (!got) {
        // Almost always means another replica is running it. Not an error.
        skipped.push({ name: job.name, reason: 'claimed_elsewhere' });
        continue;
      }
    }
    logger.info({ job: job.name, reason: state.reason }, 'Cron job starting');
    started.push(job.name);
    const p = runJob(job).catch((err) => {
      // recordJobRun swallows job errors, so reaching here means the
      // bookkeeping itself broke. Never let it become an unhandled rejection:
      // Node 18 kills the process for those, which would take the API down.
      logger.error({ err, job: job.name }, 'Scheduler: job wrapper threw');
    });
    pending.push(p);
  }

  if (awaitJobs) await Promise.all(pending);
  return { started, skipped };
}

/**
 * Start ticking. Idempotent.
 *
 * @param {object} [opts]
 * @param {number} [opts.intervalMs] tick cadence, for tests
 */
export function startScheduler({ intervalMs = TICK_INTERVAL_MS } = {}) {
  if (tickTimer) return tickTimer;
  bootedAt = Date.now();

  logger.info(
    { jobs: registry.size, tickMs: intervalMs },
    'Scheduler started: due-based, leader-elected by compare-and-swap on job_runs',
  );

  // Tick immediately as well as on the interval. The whole point is that a
  // container which only lives an hour still runs the daily jobs that are due.
  const run = () => { tick().catch((err) => logger.error({ err }, 'Scheduler: tick failed')); };
  run();

  tickTimer = setInterval(run, intervalMs);
  // Do not hold the event loop open on a process that is trying to exit.
  if (typeof tickTimer.unref === 'function') tickTimer.unref();
  return tickTimer;
}

/** Stop ticking. Jobs already in flight are left to finish. */
export function stopScheduler() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
}

/** Test seam. Not for production use. */
export const __testing = {
  reset() {
    stopScheduler();
    registry.clear();
    inFlight.clear();
    memoryRuns.clear();
    bootedAt = 0;
    ledgerWarned = false;
  },
  setBootedAt(ms) { bootedAt = ms; },
  registry,
  inFlight,
  constants: { TICK_INTERVAL_MS, DUE_TOLERANCE_MS, DEFAULT_LEASE_MS, MAX_STARTS_PER_TICK },
};
