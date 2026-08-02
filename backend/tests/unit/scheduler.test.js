/**
 * The scheduler decides whether a job runs. Two things must hold, and both
 * were broken before it existed:
 *
 *   1. A daily job must run a day after its last SUCCESS, not a day after the
 *      process started. Two daily jobs had never once run in production
 *      because their container never lived long enough for setInterval to
 *      mature.
 *   2. Two replicas must never run the same job. The claim is a
 *      compare-and-swap, so the loser must come back with zero rows and
 *      quietly do nothing.
 *
 * The supabase client is stubbed: this stays a pure logic test.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// State the stub reads and writes. `rows` is the fake job_runs table.
const db = { rows: [], selectError: null, updateResult: null, updateError: null, insertError: null, updates: [], inserts: [] };

vi.mock('../../src/config.js', () => ({
  supabase: {
    from() {
      const builder = {
        _mode: null,
        _payload: null,
        select(cols) {
          if (this._mode === 'update') {
            // Terminal for update().select(): resolve with claimed rows.
            return Promise.resolve(db.updateError
              ? { data: null, error: db.updateError }
              : { data: db.updateResult ?? [{ job_name: 'x' }], error: null });
          }
          this._mode = 'select';
          return this;
        },
        in() {
          return Promise.resolve(db.selectError ? { data: null, error: db.selectError } : { data: db.rows, error: null });
        },
        update(payload) { this._mode = 'update'; this._payload = payload; db.updates.push(payload); return this; },
        insert(payload) { db.inserts.push(payload); return Promise.resolve({ data: null, error: db.insertError }); },
        eq() { return this; },
        is() { return this; },
      };
      return builder;
    },
  },
}));

vi.mock('../../src/lib/logger.js', () => ({
  default: { info() {}, warn() {}, error() {}, debug() {} },
}));

// job-runs is exercised by its own path; here it only has to not explode.
vi.mock('../../src/lib/job-runs.js', () => ({
  recordJobRun: async (name, fn) => {
    try {
      const result = await fn();
      return { ok: true, jobName: name, result, durationMs: 1 };
    } catch (err) {
      return { ok: false, jobName: name, error: String(err?.message || err), durationMs: 1 };
    }
  },
}));

const { registerJob, dueState, tick, listJobs, __testing } = await import('../../src/lib/scheduler.js');

const MINUTE = 60 * 1000;
const DAY = 24 * 60 * MINUTE;
const NOW = Date.parse('2026-08-02T12:00:00.000Z');

function iso(msAgo) {
  return new Date(NOW - msAgo).toISOString();
}

beforeEach(() => {
  __testing.reset();
  db.rows = [];
  db.selectError = null;
  db.updateResult = null;
  db.updateError = null;
  db.insertError = null;
  db.updates = [];
  db.inserts = [];
});

describe('dueState', () => {
  const daily = { name: 'daily', intervalMs: DAY, leaseMs: 15 * MINUTE, startupDelayMs: 0 };

  it('runs a daily job that has never run', () => {
    expect(dueState(daily, null, { now: NOW }).run).toBe(true);
  });

  it('THE BUG: runs a daily job whose last success was over a day ago, however many restarts happened since', () => {
    const row = { last_success_at: iso(DAY + MINUTE), last_started_at: iso(DAY + MINUTE) };
    const state = dueState(daily, row, { now: NOW, uptimeMs: 30 * 1000 });
    expect(state.run).toBe(true);
    expect(state.reason).toBe('due');
  });

  it('does not run a daily job that succeeded an hour ago', () => {
    const row = { last_success_at: iso(60 * MINUTE), last_started_at: iso(60 * MINUTE) };
    expect(dueState(daily, row, { now: NOW }).run).toBe(false);
  });

  it('tolerates a few seconds of tick drift so cadence does not creep', () => {
    // 10 seconds short of a full day. Waiting a whole tick here is how an
    // hourly job slowly becomes a 61 minute job.
    const row = { last_success_at: iso(DAY - 10 * 1000), last_started_at: iso(DAY - 10 * 1000) };
    expect(dueState(daily, row, { now: NOW }).run).toBe(true);
  });

  it('leaves a job alone while another replica is mid-run', () => {
    const row = { last_success_at: iso(2 * DAY), last_started_at: iso(MINUTE) };
    const state = dueState(daily, row, { now: NOW });
    expect(state.run).toBe(false);
    expect(state.reason).toBe('in_flight');
  });

  it('retries a run that started and never finished, once the lease expires', () => {
    const row = { last_success_at: iso(2 * DAY), last_started_at: iso(20 * MINUTE) };
    const state = dueState(daily, row, { now: NOW });
    expect(state.run).toBe(true);
    expect(state.reason).toBe('lease_expired');
  });

  it('honours a startup delay', () => {
    const settled = { ...daily, startupDelayMs: 4 * MINUTE };
    const state = dueState(settled, null, { now: NOW, uptimeMs: MINUTE });
    expect(state.run).toBe(false);
    expect(state.reason).toBe('startup_delay');
  });

  it('keeps a 10 minute job on a 10 minute cadence', () => {
    const frequent = { name: 'auto-complete', intervalMs: 10 * MINUTE, leaseMs: 15 * MINUTE, startupDelayMs: 0 };
    const nine = { last_success_at: iso(9 * MINUTE), last_started_at: iso(9 * MINUTE) };
    const ten = { last_success_at: iso(10 * MINUTE), last_started_at: iso(10 * MINUTE) };
    expect(dueState(frequent, nine, { now: NOW }).run).toBe(false);
    expect(dueState(frequent, ten, { now: NOW }).run).toBe(true);
  });
});

describe('leader election', () => {
  it('runs the job when the compare-and-swap claims the row', async () => {
    const ran = [];
    registerJob({ name: 'daily', intervalMs: DAY, handler: async () => { ran.push(1); } });
    db.rows = [{ job_name: 'daily', last_success_at: iso(2 * DAY), last_started_at: iso(2 * DAY) }];
    db.updateResult = [{ job_name: 'daily' }];

    const result = await tick({ now: NOW, await: true });
    expect(result.started).toEqual(['daily']);
    expect(ran).toHaveLength(1);
  });

  it('does NOT run the job when another replica won the swap', async () => {
    const ran = [];
    registerJob({ name: 'daily', intervalMs: DAY, handler: async () => { ran.push(1); } });
    db.rows = [{ job_name: 'daily', last_success_at: iso(2 * DAY), last_started_at: iso(2 * DAY) }];
    db.updateResult = []; // zero rows updated: someone else got there first

    const result = await tick({ now: NOW, await: true });
    expect(result.started).toEqual([]);
    expect(ran).toHaveLength(0);
    expect(result.skipped).toContainEqual({ name: 'daily', reason: 'claimed_elsewhere' });
  });

  it('does not run when the claim itself errors, rather than assuming it won', async () => {
    const ran = [];
    registerJob({ name: 'daily', intervalMs: DAY, handler: async () => { ran.push(1); } });
    db.rows = [{ job_name: 'daily', last_success_at: iso(2 * DAY), last_started_at: iso(2 * DAY) }];
    db.updateError = { code: '08006', message: 'connection failure' };

    const result = await tick({ now: NOW, await: true });
    expect(ran).toHaveLength(0);
  });

  it('a losing insert race on a brand new job is not an error', async () => {
    const ran = [];
    registerJob({ name: 'fresh', intervalMs: DAY, handler: async () => { ran.push(1); } });
    db.rows = [];
    db.insertError = { code: '23505', message: 'duplicate key value violates unique constraint' };

    const result = await tick({ now: NOW, await: true });
    expect(ran).toHaveLength(0);
    expect(result.started).toEqual([]);
  });
});

describe('tick', () => {
  it('starts at most three jobs per tick, most overdue first', async () => {
    // Five jobs all overdue. The old code fired every startup kick within a
    // few minutes of boot and spiked the connection pool; the budget is that
    // intent expressed once.
    const overdueByDays = { a: 5, b: 1, c: 9, d: 3, e: 7 };
    for (const name of Object.keys(overdueByDays)) {
      registerJob({ name, intervalMs: DAY, handler: async () => {} });
    }
    db.rows = Object.entries(overdueByDays).map(([job_name, days]) => ({
      job_name,
      last_success_at: iso(days * DAY),
      last_started_at: iso(days * DAY),
    }));
    db.updateResult = [{ job_name: 'x' }];

    const result = await tick({ now: NOW, await: true });
    expect(result.started).toEqual(['c', 'e', 'a']);
  });

  it('keeps running jobs when job_runs cannot be read at all', async () => {
    // An un-applied migration must not stop the salon working. Degrade to
    // in-process timing rather than to silence.
    const ran = [];
    registerJob({ name: 'daily', intervalMs: DAY, handler: async () => { ran.push(1); } });
    db.selectError = { code: '42P01', message: 'relation "job_runs" does not exist' };

    await tick({ now: NOW, await: true });
    expect(ran).toHaveLength(1);
    // Second tick immediately after: in-process clock says it is not due.
    await tick({ now: NOW + MINUTE, await: true });
    expect(ran).toHaveLength(1);
  });

  it('a throwing job never becomes an unhandled rejection', async () => {
    registerJob({ name: 'boom', intervalMs: DAY, handler: async () => { throw new Error('kaboom'); } });
    db.rows = [];
    db.updateResult = [{ job_name: 'boom' }];
    await expect(tick({ now: NOW, await: true })).resolves.toBeTruthy();
  });

  it('exposes every registered job with its cadence, for /health', () => {
    registerJob({ name: 'daily', intervalMs: DAY, handler: async () => {}, description: 'the daily one' });
    expect(listJobs()).toEqual([{ name: 'daily', intervalMs: DAY, description: 'the daily one' }]);
  });
});
