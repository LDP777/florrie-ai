/**
 * Expired, never-completed consultation forms have their answers cleared.
 *
 * expires_at was declared "auto-expire after 7 days" in migration 009 and
 * nothing read it. The job sweeps rows past expires_at that were never
 * completed, nulls answers and signature_data, marks them expired, and stamps
 * purged_at when the column exists. Completed forms are the clinical record
 * and are NEVER touched here; consultation-status.js reads "a completed row
 * exists" as proof the consultation is on file, so the rows stay too.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = { rows: [], purgedAtExists: true, readError: null, writeError: null, updates: [] };

function builder(table) {
  expect(table).toBe('consultation_responses');
  const f = { lt: null, neq: null, isNull: null, notNull: null, limit: null, in: null, columns: null };
  let op = 'select';
  let patch = null;
  const settle = () => {
    if (op === 'select') {
      if (f.columns === 'purged_at') {
        return state.purgedAtExists
          ? { data: [], error: null }
          : { data: null, error: { code: '42703', message: 'column consultation_responses.purged_at does not exist' } };
      }
      if (state.readError) return { data: null, error: state.readError };
      let rows = state.rows.filter(r => r.expires_at < f.lt && r.status !== f.neq);
      if (f.isNull) rows = rows.filter(r => r[f.isNull] == null);
      if (f.notNull) rows = rows.filter(r => r[f.notNull] != null);
      return { data: rows.slice(0, f.limit).map(r => ({ id: r.id })), error: null };
    }
    if (op === 'update') {
      if (state.writeError) return { data: null, error: state.writeError };
      state.updates.push({ ids: f.in, patch });
      for (const r of state.rows) if (f.in.includes(r.id)) Object.assign(r, patch);
      return { data: null, error: null };
    }
    throw new Error(`unexpected op ${op}`);
  };
  const b = {
    select(cols) { f.columns = cols; return b; },
    update(p) { op = 'update'; patch = p; return b; },
    lt(c, v) { f.lt = v; return b; },
    neq(c, v) { f.neq = v; return b; },
    is(c) { f.isNull = c; return b; },
    not(c) { f.notNull = c; return b; },
    in(c, v) { f.in = v; return b; },
    limit(n) { f.limit = n; return b; },
    then(res, rej) { return Promise.resolve(settle()).then(res, rej); },
  };
  return b;
}

vi.mock('../../src/config.js', () => ({ supabase: { from: builder } }));

const { purgeExpiredConsultationResponses, _resetPurgedAtProbe, PURGE_BATCH_SIZE } =
  await import('../../src/jobs/consultation-purge.js');

const NOW = new Date('2026-09-02T03:00:00Z');
const past = '2026-08-01T00:00:00Z';
const future = '2026-09-09T00:00:00Z';

function row(id, extra) {
  return { id, status: 'pending', answers: {}, signature_data: null, expires_at: past, purged_at: null, ...extra };
}

beforeEach(() => {
  _resetPurgedAtProbe();
  state.rows = [];
  state.purgedAtExists = true;
  state.readError = null;
  state.writeError = null;
  state.updates = [];
});

describe('consultation purge', () => {
  it('clears answers on expired pending rows and stamps purged_at', async () => {
    state.rows = [row('a'), row('b', { answers: { q1: 'penicillin' } })];
    const result = await purgeExpiredConsultationResponses({ now: NOW });
    expect(result.purged).toBe(2);
    for (const r of state.rows) {
      expect(r.answers).toBeNull();
      expect(r.signature_data).toBeNull();
      expect(r.status).toBe('expired');
      expect(r.purged_at).toBe(NOW.toISOString());
    }
  });

  it('never touches a completed form, even one past its link expiry', async () => {
    state.rows = [
      row('done', { status: 'completed', answers: { allergies: 'latex' }, signature_data: 'data:png' }),
      row('dead'),
    ];
    const result = await purgeExpiredConsultationResponses({ now: NOW });
    expect(result.purged).toBe(1);
    const done = state.rows.find(r => r.id === 'done');
    expect(done.answers).toEqual({ allergies: 'latex' });
    expect(done.signature_data).toBe('data:png');
    expect(done.status).toBe('completed');
  });

  it('leaves rows whose link has not expired alone', async () => {
    state.rows = [row('live', { expires_at: future })];
    const result = await purgeExpiredConsultationResponses({ now: NOW });
    expect(result.purged).toBe(0);
    expect(state.rows[0].answers).toEqual({});
  });

  it('works without purged_at when the migration has not been applied', async () => {
    state.purgedAtExists = false;
    state.rows = [row('a')];
    const result = await purgeExpiredConsultationResponses({ now: NOW });
    expect(result.purged).toBe(1);
    expect(state.updates[0].patch).not.toHaveProperty('purged_at');
    expect(state.rows[0].answers).toBeNull();
    // A second pass finds nothing: answers is null, so the row is not re-swept.
    const again = await purgeExpiredConsultationResponses({ now: NOW });
    expect(again.purged).toBe(0);
  });

  it('runs in batches of 500', async () => {
    state.rows = Array.from({ length: PURGE_BATCH_SIZE + 3 }, (_, i) => row(`r${i}`));
    const result = await purgeExpiredConsultationResponses({ now: NOW });
    expect(result.purged).toBe(PURGE_BATCH_SIZE + 3);
    expect(result.batches).toBe(2);
    expect(state.updates[0].ids).toHaveLength(PURGE_BATCH_SIZE);
    expect(state.updates[1].ids).toHaveLength(3);
  });

  it('reads the error on the select and on the update rather than reporting a clean run', async () => {
    state.rows = [row('a')];
    state.readError = { code: 'XX000', message: 'boom' };
    await expect(purgeExpiredConsultationResponses({ now: NOW })).rejects.toMatchObject({ message: 'boom' });
    state.readError = null;
    state.writeError = { code: 'XX000', message: 'write boom' };
    await expect(purgeExpiredConsultationResponses({ now: NOW })).rejects.toMatchObject({ message: 'write boom' });
  });
});

describe('registration', () => {
  it('is in the daily job table', async () => {
    const { JOBS } = await import('../../src/jobs/register.js');
    const job = JOBS.find(j => j.name === 'consultation-purge');
    expect(job).toBeTruthy();
    expect(job.intervalMs).toBe(24 * 60 * 60 * 1000);
    expect(job.handler).toBe(purgeExpiredConsultationResponses);
  });
});
