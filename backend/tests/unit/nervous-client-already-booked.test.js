/**
 * 1 September 2026, 21:26, Instagram. One message, five separate faults.
 *
 *   Client   Hey lovely, I hope you're okay! Just to let you know I've just
 *            booked in for a Korean lash lift on the 9th Sept at 11am. Super
 *            nervous as I've been a lash extension girly for as long as I can
 *            remember. When would you be free for a patch test? Xx
 *
 *   Florrie  For Korean lash lift I've got Wednesday 9 September at 1.45pm or
 *            2pm. Which one suits you? There's a quick patch test to do at
 *            least 24 hours before, I'll sort that with you once the deposit
 *            is in.
 *
 * Read as the client:
 *   - my booking did not go through
 *   - the times I am being offered are not the time I booked
 *   - I owe money I have already paid
 *   - nobody answered what I asked, which was about the patch test
 *   - I said I was frightened and got a timetable
 *
 * Every one of those is tested here against the real words.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { alreadyBookedForThis } from '../../src/lib/already-booked.js';
import { looksLikeABookingOpening, patchTestLine } from '../../src/lib/booking-rules.js';
import { needsAPerson } from '../../src/lib/needs-a-person.js';
import { mayFlorrieSend } from '../../src/services/ai-front-desk.js';

const HER_MESSAGE = "Hey lovely, I hope you're okay! Just to let you know I've just booked in "
  + 'for a Korean lash lift on the 9th Sept at 11am. Super nervous as I\'ve been a lash '
  + 'extension girly for as long as I can remember 🤣 When would you be free for a patch test? Xx';

const MENU = [
  { name: 'Korean lash lift' },
  { name: 'Classic lash extensions' },
  { name: 'Hybrid lash extensions' },
  { name: 'Brow wax' },
];

const HER_BOOKING = {
  id: 'appt-morgan',
  starts_at: '2026-09-09T11:00:00',
  status: 'confirmed',
  treatments: { name: 'Korean lash lift' },
};

describe('1. she had already booked, and the diary knew', () => {
  it('recognises that the treatment she named is one she is already booked for', () => {
    const v = alreadyBookedForThis({
      message: HER_MESSAGE,
      clientUpcoming: [HER_BOOKING],
      treatments: MENU,
    });
    expect(v.booked).toBe(true);
    expect(v.appointment.id).toBe('appt-morgan');
    expect(v.treatmentName).toBe('Korean lash lift');
  });

  it('does not fire for a DIFFERENT treatment, so she can still add a wax', () => {
    // The narrowness is the point. Refusing every booking conversation from
    // anyone with anything in the diary would cost Ellie the bookings this
    // feature exists to win.
    const v = alreadyBookedForThis({
      message: 'can I get a brow wax as well please',
      clientUpcoming: [HER_BOOKING],
      treatments: MENU,
    });
    expect(v.booked).toBe(false);
  });

  it('ignores a cancelled booking, which is not a booking', () => {
    const v = alreadyBookedForThis({
      message: HER_MESSAGE,
      clientUpcoming: [{ ...HER_BOOKING, status: 'cancelled' }],
      treatments: MENU,
    });
    expect(v.booked).toBe(false);
  });

  it('says no when she has nothing booked at all', () => {
    expect(alreadyBookedForThis({ message: HER_MESSAGE, clientUpcoming: [], treatments: MENU }).booked)
      .toBe(false);
    expect(alreadyBookedForThis({ message: HER_MESSAGE, clientUpcoming: null, treatments: MENU }).booked)
      .toBe(false);
  });

  it('matches the treatment the way the booker would, not by exact string', () => {
    const v = alreadyBookedForThis({
      message: 'quick one about my korean lash lift',
      clientUpcoming: [HER_BOOKING],
      treatments: MENU,
    });
    expect(v.booked).toBe(true);
  });
});

describe('2. the text gate missed her by one phrase', () => {
  it('no longer reads "I have just booked in" as asking to book', () => {
    expect(looksLikeABookingOpening(HER_MESSAGE, MENU)).toBe(false);
  });

  it('treats a patch test question as being about an appointment she has', () => {
    // The patch test is the appointment BEFORE the appointment. Asking about
    // it is never a request for the treatment itself.
    expect(looksLikeABookingOpening('when can I come for a patch test?', MENU)).toBe(false);
  });

  it('still opens on a real booking request, which is the whole feature', () => {
    expect(looksLikeABookingOpening('can I book a korean lash lift please', MENU)).toBe(true);
    expect(looksLikeABookingOpening('do you have anything friday for a brow wax', MENU)).toBe(true);
    expect(looksLikeABookingOpening('when are you free next week', MENU)).toBe(true);
  });
});

describe('3. it told her she owed money', () => {
  it('says nothing about a deposit when the treatment does not take one', () => {
    // This is the branch that exists BECAUSE no deposit is taken, and it still
    // told the client to pay one.
    const line = patchTestLine({ patchTest: true, depositDue: false });
    expect(line).toMatch(/quick patch test/);
    expect(line).not.toMatch(/deposit/i);
  });

  it('says nothing about a deposit when the copy beside it already has', () => {
    const line = patchTestLine({ patchTest: true, depositDue: true, depositAlreadyMentioned: true });
    expect(line).not.toMatch(/deposit/i);
  });

  it('does mention it when a deposit really is still to come and nothing else said so', () => {
    expect(patchTestLine({ patchTest: true, depositDue: true })).toMatch(/once the deposit is in/);
  });

  it('says nothing at all when the treatment needs no patch test', () => {
    expect(patchTestLine({ patchTest: false, depositDue: true })).toBe('');
  });
});

describe('4. she said she was frightened', () => {
  it('sends her to Ellie', () => {
    const v = needsAPerson(HER_MESSAGE);
    expect(v.yes).toBe(true);
    expect(v.reason).toBe('client_expressed_apprehension');
  });

  it('leaves ordinary questions alone', () => {
    expect(needsAPerson('how much is a lash lift?').yes).toBe(false);
    expect(needsAPerson('can I book in for friday please').yes).toBe(false);
    expect(needsAPerson('cant wait!! so excited xx').yes).toBe(false);
  });

  it('does not hand over somebody else"s nerves, relayed', () => {
    expect(needsAPerson('my friend was really nervous but she loved it, can I book?').yes).toBe(false);
    expect(needsAPerson("don't be nervous, you'll be great").yes).toBe(false);
  });
});

describe('5. every dial said yes', () => {
  // The state of the world at 21:26: a confident classification, a grounded
  // answer available, a stranger, no per-client override. Nothing said no.
  const asItWas = {
    classification: { intent: 'booking_request', confidence: 0.95 },
    groundedDecision: { grounded: true, reason: 'grounded' },
    known: false,
    autonomyOverride: null,
    threshold: 0.5,
    arrivalNote: 'Ring the bell and I will come down.',
    ownerPresent: { present: false },
    florriePaused: false,
  };

  it('would have sent, and now does not', () => {
    expect(mayFlorrieSend({ ...asItWas, message: 'can I book a korean lash lift please' })).toBe(true);
    expect(mayFlorrieSend({ ...asItWas, message: HER_MESSAGE })).toBe(false);
  });

  it('outranks a client Ellie has whitelisted for Florrie', () => {
    expect(mayFlorrieSend({ ...asItWas, autonomyOverride: 'florrie', message: HER_MESSAGE })).toBe(false);
  });
});

describe('6. what Ellie sees when it reaches her', () => {
  const src = readFileSync(new URL('../../src/services/ai-front-desk.js', import.meta.url), 'utf8');

  it('names apprehension as the escalation reason, above the autonomy dial', () => {
    // "Low confidence (85%)" on a message held because the client said she was
    // frightened sends Ellie looking for a missing fact. The reason field was
    // added to stop exactly that, and a new hold that does not set it puts the
    // old mistake straight back.
    expect(src).toMatch(/personNeeded\?\.yes/);
    const reasonBlock = src.slice(src.indexOf('reason: doorstep'), src.indexOf('reason: doorstep') + 1200);
    expect(reasonBlock.indexOf('personNeeded')).toBeLessThan(reasonBlock.indexOf('client_set_to'));
  });

  it('also names the owner being in the thread, and the pause', () => {
    // Both were added today and neither said why it held. Same failure.
    expect(src).toMatch(/ownerPresent\?\.present\s*\n?\s*\?\s*ownerPresent\.reason/);
    expect(src).toMatch(/'florrie_paused'/);
  });
});
