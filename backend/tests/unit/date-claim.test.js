/**
 * A reply that names a day has to name the right one.
 *
 * Leanne Hill wrote "Haha hello you" on Wednesday 19 August. Florrie replied,
 * signed and sent on her own:
 *
 *   "Hi Leanne, hey! How are you doing, all set for tomorrow! 💗"
 *
 * Leanne's appointment is Wednesday 26 August — a week out. Leanne wrote back
 * "For my appointment NEXT WEEK, if possible, could you order me a tube of the
 * nourish conditioner?", correcting a machine that had just told her the wrong
 * day.
 *
 * The intent was `greeting`, which IS grounded: answering hello needs no
 * evidence. The failure was that the reply did not stay a greeting. The model
 * added "all set for tomorrow!" the way a person adds warmth, without that
 * being a fact it had checked, and neither text guard caught it — one looks
 * for offers of availability, the other for promises that a human will do
 * something. Neither is a date.
 *
 * A wrong date is worse than no date, because the client acts on it.
 */
import { describe, it, expect } from 'vitest';
import { dateClaimCheck, isGroundedReply } from '../../src/lib/grounded-reply.js';

// Wednesday 19 August 2026, the day it happened.
const TODAY = new Date('2026-08-19T09:00:00Z');
const nextWeekWed = [{ starts_at: '2026-08-26T11:00:00', treatments: { name: 'Brow Lamination & tint' } }];
const tomorrow = [{ starts_at: '2026-08-20T11:00:00' }];
const laterToday = [{ starts_at: '2026-08-19T17:00:00' }];

describe('the message Leanne got', () => {
  it('is held now', () => {
    const v = dateClaimCheck(
      'Hi Leanne, hey! How are you doing, all set for tomorrow! 💗',
      nextWeekWed, TODAY,
    );
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('reply_said_tomorrow_but_booking_is_7_days_away');
  });

  it('is held through the full gate, not just the helper', () => {
    const v = isGroundedReply({
      intent: 'greeting',
      message: 'Haha hello you',
      context: { clientUpcoming: nextWeekWed, treatments: [], knowledge: [] },
      reply: 'Hi Leanne, hey! How are you doing, all set for tomorrow! 💗',
    });
    expect(v.grounded).toBe(false);
    expect(v.reason).toContain('tomorrow');
  });

  it('would have been fine had the booking actually been tomorrow', () => {
    // The guard must not ban warmth — only wrongness.
    expect(dateClaimCheck('all set for tomorrow!', tomorrow, TODAY).ok).toBe(true);
  });
});

describe('relative days', () => {
  it('allows "today" when it is today', () => {
    expect(dateClaimCheck('see you later today!', laterToday, TODAY).ok).toBe(true);
  });

  it('holds "today" when the booking is not today', () => {
    const v = dateClaimCheck('see you today!', tomorrow, TODAY);
    expect(v.ok).toBe(false);
    expect(v.reason).toContain('said_today');
  });

  it('holds any day claim when the client has nothing booked at all', () => {
    // The worst version: inventing an appointment out of nothing.
    const v = dateClaimCheck('see you tomorrow!', [], TODAY);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('reply_names_a_day_with_nothing_booked');
  });
});

describe('weekdays', () => {
  it('allows the right weekday within the week', () => {
    expect(dateClaimCheck('see you Thursday!', [{ starts_at: '2026-08-20T11:00:00' }], TODAY).ok).toBe(true);
  });

  it('holds the wrong weekday', () => {
    const v = dateClaimCheck('see you Friday!', [{ starts_at: '2026-08-20T11:00:00' }], TODAY);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('reply_said_friday_but_booking_is_thursday');
  });

  it('holds the RIGHT weekday when it is more than a week out', () => {
    // "See you Wednesday" for a booking three Wednesdays away is true and
    // still misleading — she will turn up on the wrong one.
    const v = dateClaimCheck('see you Wednesday!', [{ starts_at: '2026-09-09T11:00:00' }], TODAY);
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('reply_named_a_weekday_more_than_a_week_out');
  });
});

describe('vaguer claims', () => {
  it('allows "next week" for a booking next week', () => {
    expect(dateClaimCheck('see you next week!', nextWeekWed, TODAY).ok).toBe(true);
  });

  it('holds "next week" when it is tomorrow', () => {
    expect(dateClaimCheck('see you next week!', tomorrow, TODAY).ok).toBe(false);
  });

  it('holds "this week" when it is a month out', () => {
    const v = dateClaimCheck('see you this week!', [{ starts_at: '2026-09-20T11:00:00' }], TODAY);
    expect(v.ok).toBe(false);
  });
});

describe('it stays out of the way when no day is claimed', () => {
  it.each([
    'Hi Leanne, hey! How are you doing?',
    "You're all booked in, see you soon!",
    'A lash lift is £45.',
    'No steam for 24 hours after, and try not to rub them.',
  ])('passes %j', (reply) => {
    // Nothing here names a day, so nothing here needs checking — and the guard
    // must not start holding ordinary replies for having the word "set" in them.
    expect(dateClaimCheck(reply, nextWeekWed, TODAY).ok).toBe(true);
  });

  it('does not fire on a client name that contains a day word', () => {
    expect(dateClaimCheck('Hi Sunday, all booked in!', nextWeekWed, TODAY).ok).toBe(false);
    // ^ deliberately DOES fire: "Sunday" is unusual as a name and the cost of
    // a false hold (Ellie sees a draft) is far below a wrong date.
  });
});
