import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ tables: {}, errors: {}, calendars: [], draft: vi.fn(), pushes: vi.fn(), reads: [] }));
function builder(table) {
  const filters = [];
  let update, inserted, head = false;
  const query = {
    select(_columns, options) { head = options?.head === true; return query; },
    eq(key, value) { filters.push(row => row[key] === value); return query; },
    in(key, values) { filters.push(row => values.includes(row[key])); return query; },
    gte(key, value) { filters.push(row => String(row[key]) >= value); return query; },
    insert(value) { inserted = value; return query; },
    update(value) { update = value; return query; },
    single() { return Promise.resolve(resolve(true)); },
    then(ok, bad) { return Promise.resolve(resolve()).then(ok, bad); },
  };
  function resolve(single = false) {
    state.reads.push(table);
    if (state.errors[table]) return { data: null, count: null, error: state.errors[table] };
    const rows = state.tables[table] || [];
    if (inserted) rows.push({ id: `new-${rows.length}`, created_at: new Date().toISOString(), ...inserted });
    const matches = rows.filter(row => filters.every(filter => filter(row)));
    if (update) matches.forEach(row => Object.assign(row, update));
    return { data: head ? null : single ? matches.at(-1) : matches, count: matches.length, error: null };
  }
  return query;
}
vi.mock('../../src/config.js', () => ({ supabase: { from: builder } }));
vi.mock('../../src/lib/gap-availability.js', async importOriginal => ({
  ...await importOriginal(),
  currentGapCalendar: vi.fn(async () => {
    const calendar = state.calendars.length > 1 ? state.calendars.shift() : state.calendars[0];
    if (calendar instanceof Error) throw calendar;
    return calendar;
  }),
}));
vi.mock('../../src/services/content-autopilot.js', () => ({ draftAvailabilityPost: state.draft }));
vi.mock('../../src/services/ai-front-desk.js', () => ({ processInboundMessage: vi.fn() }));
vi.mock('../../src/services/notifications.js', () => ({ sendNudge: vi.fn() }));
vi.mock('../../src/services/sms-metering.js', () => ({ shouldAutoSend: vi.fn() }));
vi.mock('../../src/services/push-notifications.js', () => ({ pushTeamUpdate: state.pushes }));
vi.mock('../../src/services/gap-fill-engine.js', () => ({ checkGapFillOpportunities: vi.fn() }));
vi.mock('../../src/services/review-requests.js', () => ({ processReviewRequests: vi.fn() }));
vi.mock('../../src/services/booking-preparation-reminder.js', () => ({ sendBookingPreparationReminder: vi.fn() }));

const { findGapPostOpportunity, draftVerifiedGapPost, verifyGapPostOpportunity } = await import('../../src/services/gap-content.js');
const { checkCalendarGaps } = await import('../../src/services/autonomous-scheduler.js');
const { computeCalendarGaps } = await import('../../src/lib/gap-availability.js');

const now = new Date('2026-09-29T12:00:00Z');
const gap = { date: '2026-09-30', start: '13:30', end: '16:00', duration_minutes: 150 };
const treatment = { id: 't1', beautician_id: 'owner', is_active: true, name: 'Brow tint', duration_minutes: 45, buffer_minutes: 15 };
const stored = () => ({ gap, treatment_ids: ['t1'], treatment_names: ['old name'], checked_at: '2026-09-29T00:00:00Z' });
const calendar = gaps => ({ beautician: { timezone: 'Europe/London' }, gaps });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(now);
  state.tables = { treatments: [{ ...treatment }], ai_actions: [] };
  state.errors = {};
  state.reads = [];
  state.calendars = [calendar([{ ...gap }])];
  state.pushes.mockReset().mockResolvedValue(true);
  state.draft.mockReset().mockImplementation(async (_owner, _date, _time, _names, options) => {
    await options.beforeSave();
    return { id: 'draft-1', status: 'draft' };
  });
});
afterEach(() => vi.useRealTimers());

describe('background availability uses current diary evidence', () => {
  it('uses the actual gap after appointments and blocked time, not salon opening time', async () => {
    const appointments = [{ starts_at: '2026-09-30T09:00:00Z', ends_at: '2026-09-30T12:00:00Z', status: 'confirmed' }];
    const gaps = computeCalendarGaps(now, appointments, { wed: { start: '09:00', end: '17:00' } }, 'Europe/London', {
      closedDays: new Set(), intervals: [{ start: new Date('2026-09-30T12:00:00Z'), end: new Date('2026-09-30T13:30:00Z') }],
    });
    state.calendars = [calendar(gaps)];
    const result = await findGapPostOpportunity('owner');
    expect(result.gap).toMatchObject({ date: '2026-09-30', start: '13:30', end: '17:00' });
  });

  it('uses tomorrow in the salon timezone when UTC is still yesterday', async () => {
    vi.setSystemTime(new Date('2026-09-29T23:30:00Z'));
    state.calendars = [calendar([{ ...gap, date: '2026-10-01' }])];
    expect((await findGapPostOpportunity('owner')).gap.date).toBe('2026-10-01');
  });

  it('does not combine short fragments into one imaginary treatment opening', async () => {
    state.calendars = [calendar([0, 1, 2, 3].map(n => ({ ...gap, start: `${10 + n}:00`, end: `${10 + n}:30`, duration_minutes: 30 })))];
    expect(await findGapPostOpportunity('owner')).toBeNull();
  });

  it('includes the buffer and excludes inactive or other-salon treatments', async () => {
    state.tables.treatments.push({ ...treatment, id: 'other', beautician_id: 'another', duration_minutes: 15 },
      { ...treatment, id: 'inactive', is_active: false, duration_minutes: 15 });
    state.tables.treatments[0].duration_minutes = 145;
    expect(await findGapPostOpportunity('owner')).toBeNull();
  });

  it('fails closed if a calendar or treatment read cannot be completed', async () => {
    state.calendars = [new Error('Diary read incomplete')];
    await expect(findGapPostOpportunity('owner')).rejects.toThrow('incomplete');
    state.calendars = [calendar([gap])];
    state.errors.treatments = { message: 'unavailable' };
    await expect(findGapPostOpportunity('owner')).rejects.toThrow('Could not check the treatments');
  });

  it('keeps the existing two-hour trigger without announcing smaller free totals', async () => {
    state.calendars = [calendar([{ ...gap, duration_minutes: 90, end: '15:00' }])];
    expect(await findGapPostOpportunity('owner')).toBeNull();
  });
});

describe('approval rechecks the exact stored opening', () => {
  it('rejects legacy actions with no stored date and time', async () => {
    await expect(draftVerifiedGapPost('owner', undefined)).rejects.toMatchObject({ code: 'gap_unavailable' });
    expect(state.draft).not.toHaveBeenCalled();
  });

  it('does not substitute a different available time after the approved one is booked', async () => {
    state.calendars = [calendar([{ ...gap, start: '16:00', end: '18:30' }])];
    await expect(draftVerifiedGapPost('owner', stored())).rejects.toMatchObject({ code: 'gap_unavailable' });
    expect(state.draft).not.toHaveBeenCalled();
  });

  it('rejects an old or invalid date and a treatment that no longer fits', async () => {
    await expect(verifyGapPostOpportunity('owner', { ...stored(), gap: { ...gap, date: '2026-02-31' } })).rejects.toMatchObject({ code: 'invalid_gap' });
    state.tables.treatments[0].duration_minutes = 150;
    await expect(draftVerifiedGapPost('owner', stored())).rejects.toMatchObject({ code: 'gap_unavailable' });
  });

  it('checks again after caption generation before saving the draft', async () => {
    state.calendars = [calendar([gap]), calendar([])];
    await expect(draftVerifiedGapPost('owner', stored())).rejects.toMatchObject({ code: 'gap_unavailable' });
  });

  it('uses current treatment names and returns the actual saved draft link', async () => {
    const result = await draftVerifiedGapPost('owner', stored());
    expect(state.draft).toHaveBeenCalledWith('owner', '2026-09-30', '13:30', ['Brow tint'], expect.objectContaining({ beforeSave: expect.any(Function) }));
    expect(result.details).toMatchObject({ post_id: 'draft-1', gap, treatment_ids: ['t1'] });
  });
});

describe('scheduler keeps approval and drafting separate from publishing', () => {
  it('queues exact evidence with a real pending status under the default threshold', async () => {
    expect(await checkCalendarGaps('owner', 0.9)).toBe(1);
    expect(state.tables.ai_actions[0]).toMatchObject({ status: 'pending_approval', outcome: 'pending', details: { gap, treatment_ids: ['t1'] } });
    expect(state.tables.ai_actions[0].summary).toContain('30 September');
    expect(state.draft).not.toHaveBeenCalled();
    expect(state.pushes).not.toHaveBeenCalled();
  });

  it('only drafts at the existing auto threshold and records the saved post', async () => {
    expect(await checkCalendarGaps('owner', 0.8)).toBe(1);
    expect(state.draft).toHaveBeenCalledTimes(1);
    expect(state.tables.ai_actions[0]).toMatchObject({ status: 'executed', outcome: 'success', details: { post_id: 'draft-1' } });
    expect(await checkCalendarGaps('owner', 0.8)).toBe(0);
    expect(state.draft).toHaveBeenCalledTimes(1);
  });

  it('creates nothing on dedupe errors and keeps failed drafts available for approval', async () => {
    state.errors.ai_actions = { message: 'unavailable' };
    expect(await checkCalendarGaps('owner', 0.8)).toBe(0);
    expect(state.tables.ai_actions).toHaveLength(0);
    delete state.errors.ai_actions;
    state.draft.mockRejectedValue(new Error('Model unavailable'));
    expect(await checkCalendarGaps('owner', 0.8)).toBe(0);
    expect(state.tables.ai_actions[0].status).toBe('pending_approval');
    expect(state.pushes).not.toHaveBeenCalled();
  });
});
