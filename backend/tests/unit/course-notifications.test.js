/**
 * The student's email and the trainer's push, for a course place.
 * What is asserted is the copy a person reads and the calendar file that
 * lands in her phone, because those are the two things that were missing.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const emails = [];
const pushes = [];
vi.mock('../../src/config.js', () => ({ supabase: { from() { throw new Error('not used here'); } } }));
vi.mock('../../src/lib/logger.js', () => ({ default: { info() {}, warn() {}, error() {}, debug() {} } }));
vi.mock('../../src/services/notifications.js', () => ({ sendEmail: async (m) => { emails.push(m); return { id: 'em_1' }; } }));
vi.mock('../../src/services/push-notifications.js', () => ({ pushTeamUpdate: async (id, kind, text, opts) => { pushes.push({ id, kind, text, opts }); } }));

const { announceEnrolment, courseWindow, durationMinutes } = await import('../../src/services/course-notifications.js');

const beautician = { id: 'biz-1', first_name: 'Ellie', business_name: 'Ellindigo', email: 'ellie@example.com', phone: '07700900000', booking_slug: 'ellindigo' };
const course = { id: 'c1', name: 'Ultimate Beginner Course', date: '2026-10-12', start_time: '09:30:00', duration: 'Full day (7hrs)', location: 'Ellindigo, Brighton', price: 750, deposit: 150, includes: ['certificate', 'kit'] };

beforeEach(() => { emails.length = 0; pushes.length = 0; });

describe('courseWindow', () => {
  it('reads the duration label', () => {
    expect(durationMinutes('Full day (7hrs)')).toBe(420);
    expect(durationMinutes('Half day (4hrs)')).toBe(240);
    expect(durationMinutes('2 hours')).toBe(120);
    expect(durationMinutes('2 days')).toBe(840);
    expect(durationMinutes('')).toBe(420);
  });
  it('uses the start time when there is one and says when it had to assume', () => {
    expect(courseWindow(course)).toEqual({ startsAt: '2026-10-12T09:30:00', endsAt: '2026-10-12T16:30:00', timeAssumed: false });
    expect(courseWindow({ ...course, start_time: null }).timeAssumed).toBe(true);
    expect(courseWindow({ ...course, date: null })).toBeNull();
  });
});

describe('announceEnrolment', () => {
  it('pushes the trainer under its own headline and emails the student the facts and a calendar file', async () => {
    await announceEnrolment({ beautician, course, enrollment: { id: 'e1', name: 'Chloe Morgan', email: 'chloe@example.com', notes: 'Complete beginner', payment_status: 'deposit_paid', amount_paid_cents: 15000 }, paid: 'deposit' });
    expect(pushes).toHaveLength(1);
    expect(pushes[0].kind).toBe('course_enrolled');
    expect(pushes[0].text).toBe('Chloe Morgan booked onto Ultimate Beginner Course, Monday 12 October 2026. Deposit paid (£150).');
    expect(pushes[0].opts.url).toBe('/packages');

    expect(emails).toHaveLength(1);
    const m = emails[0];
    expect(m.to).toBe('chloe@example.com');
    expect(m.replyTo).toBe('ellie@example.com');
    expect(m.subject).toBe('Your place on Ultimate Beginner Course is booked');
    expect(m.html).toContain('Monday 12 October 2026, starting 09:30');
    expect(m.html).toContain('£150.00 is paid. £600.00 is due on the day');
    expect(m.html).toContain('Certificate, Starter kit');
    expect(m.html).toContain('Complete beginner');
    expect(m.html).toContain('WhatsApp 07700900000');
    expect(m.attachments[0].filename).toBe('course.ics');
    expect(m.attachments[0].content).toContain('SUMMARY:Ultimate Beginner Course at Ellindigo');
    expect(m.attachments[0].content).toContain('DTSTART;TZID=Europe/London:20261012T093000');
    expect(m.html).not.toMatch(/[\u2014\u2013]/);
  });

  it('says the time is to be confirmed when there is no start time, and skips the calendar file with no date', async () => {
    await announceEnrolment({ beautician, course: { ...course, start_time: null }, enrollment: { id: 'e2', name: 'Amy', email: 'amy@example.com', payment_status: 'unpaid' }, paid: 'unpaid' });
    expect(emails[0].html).toContain('Ellindigo will confirm the start time');
    expect(emails[0].html).toContain('A deposit of £150.00 secures your place');
    await announceEnrolment({ beautician, course: { ...course, date: null }, enrollment: { id: 'e3', name: 'Bea', email: 'bea@example.com', payment_status: 'unpaid' }, paid: 'unpaid' });
    expect(emails[1].attachments).toBeUndefined();
    expect(emails[1].html).toContain('Date to be confirmed');
  });

  it('never throws when the email fails', async () => {
    const bad = { ...beautician, booking_slug: undefined };
    await expect(announceEnrolment({ beautician: bad, course, enrollment: { id: 'e4', name: 'X', email: null }, paid: 'unpaid' })).resolves.toBeUndefined();
    expect(emails).toHaveLength(0);
    expect(pushes).toHaveLength(1);
  });
});
