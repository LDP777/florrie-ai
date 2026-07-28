/**
 * The 28 Jul incident: Florrie told a client "4.30 on Thursday" was available
 * when it was not, and implied the appointment had moved when nothing in the
 * inbound path can move one. These tests are the regression.
 */
import { describe, it, expect } from 'vitest';
import { checkReplyClaims, safeReply, timesMentionedIn, HOLDING_REPLY } from '../../src/lib/reply-claims-guard.js';

describe('checkReplyClaims', () => {
  it('refuses the exact message that caused the incident', () => {
    const v = checkReplyClaims("Yes lovely, 4.30 on Thursday is free, I've moved you over x");
    expect(v.ok).toBe(false);
  });

  it('refuses a time that is not on the verified list', () => {
    const v = checkReplyClaims('I can do 4.30 on Thursday', { allowedTimes: ['16:00', '17:15'] });
    expect(v.ok).toBe(false);
    expect(v.offending).toContain('16:30');
  });

  it('allows a time that IS on the verified list, in any notation', () => {
    // The diary speaks 24h; clients and Florrie speak "4.30" and "4pm".
    expect(checkReplyClaims('how about 4.30?', { allowedTimes: ['16:30'] }).ok).toBe(true);
    expect(checkReplyClaims('how about 4pm?', { allowedTimes: ['16:00'] }).ok).toBe(true);
    expect(checkReplyClaims('how about 16:30?', { allowedTimes: ['16:30'] }).ok).toBe(true);
  });

  it('refuses any time when nothing has been verified', () => {
    // The reply prompts get no diary at all, so this is the normal case.
    expect(checkReplyClaims('4.30 works!').ok).toBe(false);
  });

  it('refuses claims that a booking changed when nothing was written', () => {
    for (const claim of [
      "I've moved you to Thursday",
      "you're now booked in",
      'that is all sorted',
      "I've put you down for Thursday",
      'your appointment has been moved',
    ]) {
      expect(checkReplyClaims(claim).ok, claim).toBe(false);
    }
  });

  it('allows the claim when the booking really was written', () => {
    const v = checkReplyClaims("I've moved you to 16:30", {
      allowedTimes: ['16:30'],
      actionPerformed: true,
    });
    expect(v.ok).toBe(true);
  });

  it('leaves ordinary warm replies alone', () => {
    for (const fine of [
      'Thanks lovely, see you then x',
      'No problem at all, I will check my book and come back to you',
      'Your usual is £35 and takes about an hour',
      'Pop onto the link and you can pick whatever suits you best x',
    ]) {
      expect(checkReplyClaims(fine).ok, fine).toBe(true);
    }
  });

  it('does not mistake a price or a date for a time', () => {
    expect(checkReplyClaims('It is £35.50 and lasts 90 minutes').ok).toBe(true);
  });
});

describe('safeReply', () => {
  it('swaps a bad draft for a holding reply rather than sending it', () => {
    const r = safeReply("4.30 Thursday is free, you're moved x");
    expect(r.rejected).toBe(true);
    expect(r.text).toBe(HOLDING_REPLY);
  });

  it('passes a good draft through untouched', () => {
    const r = safeReply('See you soon lovely x');
    expect(r.rejected).toBe(false);
    expect(r.text).toBe('See you soon lovely x');
  });
});

describe('timesMentionedIn', () => {
  it('normalises salon times to 24h', () => {
    expect(timesMentionedIn('4.30')).toEqual(['16:30']);
    expect(timesMentionedIn('9.15')).toEqual(['09:15']);
    expect(timesMentionedIn('10am')).toEqual(['10:00']);
  });
});

/**
 * Found by running the real incident message through the guard rather than
 * assuming it held. Two leaks, both silent:
 *   - "half four" was DETECTED as a time token but normaliseTime returned null,
 *     so it was dropped from the list and never checked.
 *   - "Appointment moved!" did not match, because the claim pattern demanded
 *     "has been moved". A full stop is still a promise.
 */
describe('the leaks the first version missed', () => {
  it('blocks spoken times, not just digits', () => {
    expect(checkReplyClaims("That's fine hun, half four Thursday. Appointment moved!").ok).toBe(false);
    expect(checkReplyClaims('quarter past two suits me', { allowedTimes: ['16:30'] }).ok).toBe(false);
  });

  it('normalises spoken times so a genuinely free one is still allowed', () => {
    expect(checkReplyClaims('half four?', { allowedTimes: ['16:30'] }).ok).toBe(true);
    expect(checkReplyClaims('quarter past two?', { allowedTimes: ['14:15'] }).ok).toBe(true);
    // Quarter TO five is the hour before.
    expect(checkReplyClaims('quarter to five?', { allowedTimes: ['16:45'] }).ok).toBe(true);
  });

  it('does not let a price or a duration read as a clock time', () => {
    // Tightening the guard introduced this: 35.50 matched the digit pattern.
    expect(checkReplyClaims('It is £35.50 and lasts 90 minutes').ok).toBe(true);
    expect(checkReplyClaims('That one is £42.00 hun').ok).toBe(true);
  });

  it('blocks bare past-tense claims with no subject', () => {
    for (const claim of ['Appointment moved!', 'Booking changed', 'All done. Moved!', "changed it for you"]) {
      expect(checkReplyClaims(claim, { allowedTimes: [] }).ok, claim).toBe(false);
    }
  });

  it('still lets ordinary replies through', () => {
    // Over-blocking would make Florrie useless, which is its own failure.
    for (const fine of [
      'Half price on your next one lovely',
      'You have 3 loyalty points, one more and your next infill is half price!',
      'Your usual is £35 and takes about an hour hun',
      'I will check my book and come straight back to you',
    ]) {
      expect(checkReplyClaims(fine, { allowedTimes: ['16:30'] }).ok, fine).toBe(true);
    }
  });
});
