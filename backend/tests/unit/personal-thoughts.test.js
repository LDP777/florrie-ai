import { describe, expect, it } from 'vitest';
import { derivePersonalThoughts } from '../../src/services/personal-thoughts.js';
const now = new Date('2026-11-17T10:00:00Z');
const fixture = { owner: { id: 'salon', timezone: 'Europe/London' }, now, appointments: [], blocks: [], clients: [], locations: [{ address: 'Fictional salon, SW1A 1AA' }], holidays: { 'england-and-wales': [
  { date: '2026-05-04', title: 'Early May bank holiday' }, { date: '2026-08-31', title: 'Summer bank holiday' }, { date: '2026-12-25', title: 'Christmas Day' },
] } };
const closed = (date, extra = {}) => ({ id: date, date, type: 'closed', ...extra });
const visit = (date, extra = {}) => ({ id: date, client_id: 'regular', starts_at: `${date}T10:00:00Z`, ends_at: `${date}T11:00:00Z`, status: 'completed', ...extra });
const cards = overrides => derivePersonalThoughts({ ...fixture, ...overrides });
describe('considerate suggestions need real evidence', () => {
  it('does not call an empty bank-holiday diary a habit', () => {
    expect(cards({})).toEqual([]);
    expect(cards({ blocks: [closed('2026-05-04')] })).toEqual([]);
  });
  it('offers the real next holiday after two explicit days off, with a reversible proposal', () => {
    const [card] = cards({ blocks: [closed('2026-05-04'), closed('2026-08-31')] });
    expect(card).toMatchObject({ type: 'holiday_habit', conflict_count: 0, action: { kind: 'protect_time', date: '2026-12-25', start_time: null } });
    expect(card.evidence.facts[0]).toContain('2 of 2');
  });
  it('requires a national calendar and does not offer an already closed holiday', () => {
    const blocks = [closed('2026-05-04'), closed('2026-08-31')];
    expect(cards({ blocks, locations: [] })).toEqual([]);
    expect(cards({ blocks: [...blocks, closed('2026-12-25')] })).toEqual([]);
  });
  it('discloses existing holiday bookings and never proposes moving them', () => {
    const [card] = cards({ blocks: [closed('2026-05-04'), closed('2026-08-31')], appointments: [visit('2026-12-25', { status: 'confirmed' })] });
    expect(card.conflict_count).toBe(1);
    expect(card.summary).toContain('already have bookings');
    expect(card.action.kind).toBe('protect_time');
  });
  it('does not nudge an owner to close a weekday already absent from their recorded hours', () => {
    expect(cards({ owner: { ...fixture.owner, working_hours: { mon: { start: '09:00', end: '17:00' } } }, blocks: [closed('2026-05-04'), closed('2026-08-31')] })).toEqual([]);
  });
  it('does not count a closed holiday that was actually worked as time off', () => {
    expect(cards({ blocks: [closed('2026-05-04'), closed('2026-08-31')], appointments: [visit('2026-05-04')] })).toEqual([]);
  });
  it('protects a repeated personal break only when the new diary leaves it free', () => {
    const blocks = ['2026-10-28','2026-11-04','2026-11-11'].map(date => ({ date, type: 'amended', reason: 'personal', start_time: '12:00', end_time: '12:30' }));
    const appointments = [visit('2026-11-18', { status: 'confirmed' })];
    expect(cards({ blocks, appointments })[0]).toMatchObject({ type: 'personal_rhythm', action: { date: '2026-11-18', start_time: '12:00', end_time: '12:30' } });
    expect(cards({ blocks, appointments: [...appointments, visit('2026-11-18', { starts_at: '2026-11-18T12:15:00Z', ends_at: '2026-11-18T13:00:00Z', status: 'pending' })] })).toEqual([]);
  });
  it('connects a consistent visit cadence with time off, excluding already booked and blocked clients', () => {
    const input = { clients: [{ id: 'regular', first_name: 'Nora' }], appointments: ['2026-09-10','2026-10-08','2026-11-05'].map(d => visit(d)), blocks: [closed('2026-12-01', { end_date: '2026-12-06' })] };
    const [card] = cards(input);
    expect(card).toMatchObject({ type: 'before_time_off', action: { clients: [{ id: 'regular', interval_days: 28, due: '2026-12-03' }] } });
    expect(card.evidence.facts.at(-1)).toContain('not a booking or permission');
    expect(cards({ ...input, appointments: [...input.appointments, visit('2027-02-01', { status: 'confirmed' })] })).toEqual([]);
    expect(cards({ ...input, clients: [{ ...input.clients[0], blocked_at: '2026-11-10' }] })).toEqual([]);
  });
  it('spots a fuller day against the salon’s own history without diagnosing stress', () => {
    const history = ['2026-10-20','2026-10-21','2026-10-22','2026-10-23','2026-11-03','2026-11-04','2026-11-05','2026-11-06'].map(d => visit(d));
    const busy = visit('2026-11-19', { status: 'confirmed', ends_at: '2026-11-19T16:00:00Z' });
    const [card] = cards({ appointments: [...history, busy] });
    expect(card).toMatchObject({ type: 'busy_day', action: { kind: 'care_day', date: '2026-11-19' } });
    expect(card.evidence.facts.at(-1)).toContain('not a measure of stress');
  });
});
