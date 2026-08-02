/**
 * Job heartbeats.
 *
 * WHY THIS EXISTS
 * Every cron in this backend is a setInterval registered inside app.listen.
 * That has two failure modes nobody can currently see:
 *
 *   1. The job throws, the .catch swallows it into a log line, and it keeps
 *      being scheduled while achieving nothing. This is how the Instagram
 *      token stayed dead for five weeks.
 *   2. The container restarts before a long interval matures. A 24h interval
 *      on a service that redeploys most days never fires at all. Nothing
 *      records the absence, because an absence writes no log.
 *
 * recordJobRun stamps a row in job_runs before and after each run, so
 * /health can answer "when did this last actually work" instead of guessing.
 *
 * Contract: it NEVER throws into the caller, and a bookkeeping failure never
 * prevents the job itself from running. Watching the work must not break the
 * work.
 *
 * Only the reconciliation job is wrapped for now. The other crons are a later
 * phase; this helper is deliberately generic so wrapping them is a one-line
 * change each.
 */
import * as Sentry from '@sentry/node';
import { supabase } from '../config.js';
import logger from './logger.js';

const MAX_ERROR_CHARS = 500;

// 42P01 = relation does not exist. Migration 020 is run by hand, so until Levi
// applies it (and restarts Railway for PgBouncer's schema cache) every call
// here will hit a missing table. Degrade quietly: a heartbeat we cannot write
// must not take down the job it is watching.
function isMissingTable(error) {
  if (!error) return false;
  if (error.code === '42P01') return true;
  return /relation .* does not exist/i.test(error.message || '');
}

let missingTableWarned = false;
function noteMissingTable(where) {
  if (missingTableWarned) return;
  missingTableWarned = true;
  logger.warn({ where }, 'job_runs table missing, heartbeats disabled until migration 020 is applied');
}

async function stampStart(jobName) {
  const { error } = await supabase
    .from('job_runs')
    .upsert({ job_name: jobName, last_started_at: new Date().toISOString() }, { onConflict: 'job_name' });
  // Supabase returns errors in the result object rather than throwing. Every
  // incident behind this module started with an unchecked result object.
  if (error) {
    if (isMissingTable(error)) return noteMissingTable('stampStart');
    logger.warn({ err: error, jobName }, 'job_runs: could not stamp start');
  }
}

async function stampSuccess(jobName) {
  const { error } = await supabase
    .from('job_runs')
    .upsert({
      job_name: jobName,
      last_success_at: new Date().toISOString(),
      last_error: null,
      consecutive_failures: 0,
    }, { onConflict: 'job_name' });
  if (error) {
    if (isMissingTable(error)) return noteMissingTable('stampSuccess');
    logger.warn({ err: error, jobName }, 'job_runs: could not stamp success');
  }
}

async function stampFailure(jobName, err) {
  // Read-then-write rather than an RPC: there is one writer per job and a lost
  // increment costs us nothing, whereas a stored procedure is another thing to
  // deploy by hand.
  let failures = 1;
  const { data, error: readError } = await supabase
    .from('job_runs')
    .select('consecutive_failures')
    .eq('job_name', jobName)
    .maybeSingle();
  if (readError) {
    if (isMissingTable(readError)) return noteMissingTable('stampFailure');
    logger.warn({ err: readError, jobName }, 'job_runs: could not read failure count');
  } else if (data && Number.isFinite(data.consecutive_failures)) {
    failures = data.consecutive_failures + 1;
  }

  const message = String(err?.message || err || 'unknown error').slice(0, MAX_ERROR_CHARS);
  const { error: writeError } = await supabase
    .from('job_runs')
    .upsert({
      job_name: jobName,
      last_error: message,
      consecutive_failures: failures,
    }, { onConflict: 'job_name' });
  if (writeError) {
    if (isMissingTable(writeError)) return noteMissingTable('stampFailure');
    logger.warn({ err: writeError, jobName }, 'job_runs: could not stamp failure');
  }
  return failures;
}

/**
 * Run a job with a heartbeat around it.
 *
 * @param {string} jobName stable key, also the primary key in job_runs
 * @param {Function} fn the job. May be async. Its return value is passed back.
 * @returns {Promise<{ok:boolean, jobName:string, result?:any, error?:string, durationMs:number}>}
 */
export async function recordJobRun(jobName, fn) {
  const startedAt = Date.now();
  try {
    await stampStart(jobName);
  } catch (err) {
    // Bookkeeping must never block the work.
    logger.warn({ err, jobName }, 'job_runs: start stamp threw');
  }

  try {
    const result = await fn();
    try {
      await stampSuccess(jobName);
    } catch (err) {
      logger.warn({ err, jobName }, 'job_runs: success stamp threw');
    }
    return { ok: true, jobName, result, durationMs: Date.now() - startedAt };
  } catch (err) {
    let failures = null;
    try {
      failures = await stampFailure(jobName, err);
    } catch (stampErr) {
      logger.warn({ err: stampErr, jobName }, 'job_runs: failure stamp threw');
    }

    logger.error({ err, jobName, consecutiveFailures: failures }, 'Cron job failed');
    // A cron that fails is exactly the class of problem this codebase has
    // repeatedly discovered by accident, weeks late. Send it somewhere a human
    // is actually looking.
    Sentry.captureException(err, {
      tags: { area: 'cron', job: jobName },
      extra: { consecutiveFailures: failures },
    });

    return {
      ok: false,
      jobName,
      error: String(err?.message || err),
      consecutiveFailures: failures,
      durationMs: Date.now() - startedAt,
    };
  }
}

/**
 * Read heartbeats for the health endpoint.
 *
 * Returns { available:false } when migration 020 has not been applied, so the
 * caller can report "unknown" instead of "failing". An un-run migration is not
 * an outage.
 *
 * @param {string[]} jobNames
 */
export async function readJobRuns(jobNames = []) {
  const query = supabase
    .from('job_runs')
    .select('job_name, last_started_at, last_success_at, last_error, consecutive_failures');

  const { data, error } = jobNames.length
    ? await query.in('job_name', jobNames)
    : await query;

  if (error) {
    if (isMissingTable(error)) return { available: false, rows: [], reason: 'table_missing' };
    return { available: false, rows: [], reason: error.message || 'query_failed' };
  }
  return { available: true, rows: data || [] };
}

export const __testing = { isMissingTable };
