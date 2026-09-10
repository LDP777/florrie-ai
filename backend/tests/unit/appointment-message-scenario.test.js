import { describe, expect, it } from 'vitest';
import { appointmentChangeIntent, planAppointmentChange, shouldProcessInbound } from '../../src/lib/appointment-message-scenario.js';
import { ownerIsInThread } from '../../src/lib/owner-in-thread.js';

const now = Date.parse('2026-09-10T09:00:00Z'); // 10am BST, appointments use wall time
const beautician = { first_name: 'Ellie', booking_slug: 'ellindigo', timezone: 'Europe/London', booking_policy: { cancellation_notice_hours: 48 } };
const appointment = { id: 'a1', starts_at: '2026-09-17T13:00:00Z', status: 'confirmed', management_token: 'test-token' };
const message = 'Hi Ellie, am I able to reschedule this appointment. So sorry - I have a really bad cold! X';
const plan = (rows = [appointment], extra = {}) => planAppointmentChange({ message, beautician, now, context: { clientUpcoming: rows }, ...extra });

describe('appointment scenarios', () => {
  it.each([
    message, 'Sorry I cannot make my appointment today', 'Please move my booking to next week',
    'Can we do tomorrow instead?', 'Could I come later instead?', 'I need to reschedule', 'Can we move to next week?',
  ])('recognises the request without needing a question mark: %s', text => {
    expect(appointmentChangeIntent(text)).toBe('reschedule');
  });
  it.each(['Please cancel my appointment', 'I need to cancel today'])('recognises cancellation: %s', text => {
    expect(appointmentChangeIntent(text)).toBe('cancellation');
  });
  it.each([
    'Thanks lovely, see you then x', 'Yes no problem!! Xxx', 'I have already rescheduled my appointment',
    'Thanks for moving my appointment', "Don't cancel my appointment", 'Can you change my hair colour?',
    'Can I move my training course?', 'Can I cancel my subscription?', 'Can I move house next week?',
  ])('does not reopen a finished exchange or an unrelated request: %s', text => {
    expect(appointmentChangeIntent(text)).toBeNull();
  });
  it('returns the actual management link for an unambiguous future booking', () => {
    expect(plan()).toMatchObject({ needsOwner: false, reason: 'booking_manage_link', appointmentId: 'a1' });
    expect(plan().reply).toContain('/book/ellindigo/manage/test-token');
    expect(plan().reply).toContain('stays in place until');
  });
  it('acknowledges a short-notice change and keeps it for the owner', () => {
    const result = plan([{ ...appointment, starts_at: '2026-09-10T13:00:00Z' }]);
    expect(result).toMatchObject({ needsOwner: true, reason: 'short_notice' });
    expect(result.reply).toContain("I haven't changed or cancelled");
    expect(result.reply).not.toContain('/manage/');
  });
  it('uses the appointment policy and the salon clock at the notice boundary', () => {
    expect(plan([{ ...appointment, starts_at: '2026-09-12T09:30:00Z' }]).reason).toBe('short_notice');
    expect(plan([{ ...appointment, starts_at: '2026-09-12T10:30:00Z' }]).reason).toBe('booking_manage_link');
    expect(plan([{ ...appointment, policy_snapshot: { cancellation_notice_hours: 240 } }]).reason).toBe('short_notice');
  });
  it('does not guess between bookings or disclose one arbitrarily', () => {
    const result = plan([appointment, { ...appointment, id: 'a2', management_token: 'other' }]);
    expect(result.reason).toBe('booking_unclear');
    expect(result.reply).toContain('Which date and treatment');
    expect(result.reply).not.toContain('test-token');
  });
  it('distinguishes missing bookings from a failed diary read', () => {
    expect(plan([]).reason).toBe('booking_not_found');
    expect(plan([], { context: { clientUpcomingReadable: false } }).reason).toBe('diary_unavailable');
  });
  it('holds missing links and bookings already moved under the once-only rule', () => {
    expect(plan([{ ...appointment, management_token: null }]).reason).toBe('manage_link_unavailable');
    expect(plan([{ ...appointment, rescheduled_at: '2026-09-09T12:00:00Z' }], {
      beautician: { ...beautician, booking_policy: { reschedule_once: true } },
    }).reason).toBe('already_rescheduled');
  });
  it('does not let the new-enquiry toggle discard service requests', () => {
    expect(shouldProcessInbound({ auto_reply_enabled: false }, message)).toBe(true);
    expect(shouldProcessInbound({ auto_reply_enabled: false }, 'Hi, how much are brows?')).toBe(false);
    expect(shouldProcessInbound({ auto_reply_enabled: false, autonomy: { grounded_replies: false } }, message)).toBe(false);
  });
  it('uses the classifier’s conversation context for an indirect request', () => {
    expect(appointmentChangeIntent('Something has come up, Friday would work better for me', { intent: 'reschedule', confidence: 0.9 })).toBe('reschedule');
    expect(appointmentChangeIntent('Yes no problem!! Thank you so much xx', { intent: 'reschedule', confidence: 0.99 })).toBeNull();
  });
  it('lets a fresh appointment request restart an old personal thread, but preserves a live conversation', () => {
    const human = minutes => [{ id: 'human', direction: 'outbound', authored_by: 'human', created_at: new Date(now - minutes * 60_000).toISOString() }];
    const check = (minutes, appointmentRequest) => ownerIsInThread({ conversation: human(minutes), now, appointmentRequest });
    expect(check(60, true).present).toBe(false);
    expect(check(1440, true).present).toBe(false);
    expect(check(5, true).present).toBe(true);
    expect(check(15, true).present).toBe(true);
    expect(check(60, false).present).toBe(true);
    expect(check(1440, false).present).toBe(true);
  });
});
