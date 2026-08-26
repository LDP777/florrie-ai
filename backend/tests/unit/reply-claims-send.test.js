/**
 * THE GUARD WAS SCOPED TO THE LAST INCIDENT, NOT TO THE PROBLEM.
 *
 * lib/reply-claims-guard.js was written after 28 July 2026, when Florrie told
 * a client "4.30 on Thursday is free, I've moved you over x" and neither half
 * was true. ACTION_CLAIMS came out of that: moved, rescheduled, booked,
 * sorted, changed, switched, shifted. Every single pattern is about a booking
 * CHANGE.
 *
 * On 26 August a client wrote "...don't think I got a confirmation" and
 * Florrie replied "Hey, i'll send you a new one now. should come through in a
 * min xx". Nothing was sent, nothing could have been, and the guard let it
 * through without a murmur, because a promise to SEND is a different sentence
 * from a claim to have MOVED and nobody had written it down.
 *
 * So this file tests the shape of the failure rather than the wording of one
 * incident: Florrie narrating an action nobody performed. It also pins the
 * things that must keep passing, because a guard that holds ordinary warmth is
 * a different way of being useless.
 */
import { describe, it, expect } from 'vitest';
import { checkReplyClaims, safeReply, HOLDING_REPLY } from '../../src/lib/reply-claims-guard.js';

const held = (text, opts = {}) => checkReplyClaims(text, { allowedTimes: [], ...opts });

describe('promises to send, when nothing was sent', () => {
  it('refuses the exact message Sophie was sent on 26 August', () => {
    const v = held("Hey, i'll send you a new one now. should come through in a min xx");
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('claimed something was sent when nothing was sent');
  });

  it.each([
    // future, first person
    "I'll send you a new one now",
    'I will send that over',
    "I'll email that across",
    "I'm sending it over now",
    "we'll resend the confirmation",
    "I'll forward it to you",
    "I'll just pop that over to you",
    "I'll text it over now",
    "I'm going to email it across",
    // already gone
    'just sent you a new one',
    "I've resent it",
    'I have emailed it over',
    "I've just popped that over",
    // no subject at all
    'sending it over now',
    'popping that over',
    'emailing it across in a sec',
    // bare past tense, the shape the existing list already bothers with
    'Sent!',
    'Resent.',
    'All sent lovely',
    'Confirmation sent',
    'the email has been resent',
    // the delivery promise with no verb of sending in it, which is the half
    // that would have survived on its own
    'should come through in a min',
    "it'll come through shortly",
    'it is on its way',
    'it should be in your inbox any second',
    'it should be with you shortly',
    'it will arrive in a minute',
  ])('refuses %j', (claim) => {
    expect(held(claim).ok, claim).toBe(false);
  });

  it('swaps the draft for the holding reply rather than sending it', () => {
    const r = safeReply("Hey, i'll send you a new one now. should come through in a min xx");
    expect(r.rejected).toBe(true);
    expect(r.text).toBe(HOLDING_REPLY);
  });
});

describe('the same promise, once it is true', () => {
  it('is allowed when a send really happened in this request', () => {
    expect(held("Hey, i'll send you a new one now. should come through in a min xx", { sendPerformed: true }).ok).toBe(true);
    expect(held("just resent it, should be in your inbox", { sendPerformed: true }).ok).toBe(true);
  });

  /*
   * TWO FLAGS, NOT ONE, AND THIS IS WHY.
   *
   * A booking write and a message dispatch are different facts evidenced by
   * different code. One flag carrying both would let the fix for 26 August
   * wave 28 July back through: a request that genuinely resent a confirmation
   * would also license "you're all moved to Thursday".
   */
  it('does not let a real send license a booking claim', () => {
    const v = held("all sent! and you're moved to Thursday", { sendPerformed: true });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('claimed a booking change that never happened');
  });

  it('does not let a real booking write license a send claim', () => {
    const v = held("you're booked in, I'll email the confirmation over now", { actionPerformed: true });
    expect(v.ok).toBe(false);
    expect(v.reason).toBe('claimed something was sent when nothing was sent');
  });

  it('allows both when both really happened', () => {
    expect(held("you're moved, and I've just sent the new confirmation", {
      actionPerformed: true, sendPerformed: true,
    }).ok).toBe(true);
  });
});

describe('what it deliberately lets through', () => {
  it('does not ban the sanctioned holding reply', () => {
    // This is the sentence the prompts are told to fall back to. If the guard
    // holds it, the guard has nothing left to swap a bad draft for.
    expect(held(HOLDING_REPLY).ok).toBe(true);
    expect(held('I will check my book and come straight back to you').ok).toBe(true);
    expect(held('I will come back to you later today').ok).toBe(true);
    expect(held("I'll have a look and come back to you").ok).toBe(true);
  });

  it('does not ban a promise about a HUMAN', () => {
    // A claim about Ellie is a different fact with a different owner: the
    // draft goes to Ellie, who reads it and knows she has to do it.
    // lib/grounded-reply.js owns third-party promises (promisesAHumanAction);
    // duplicating them here would hold a legitimate handover.
    expect(held('Ellie will send that over to you').ok).toBe(true);
    expect(held('She will pop that over when she gets a minute').ok).toBe(true);
  });

  it.each([
    'Thanks lovely, see you then x',
    'Your usual is £35 and takes about an hour',
    'Pop onto the link and you can pick whatever suits you best x',
    'Half price on your next one lovely',
    'You have 3 loyalty points, one more and your next infill is half price!',
    'No steam for 24 hours after, and try not to rub them.',
    'Pop you a message when I know more',
  ])('leaves %j alone', (fine) => {
    expect(held(fine).ok, fine).toBe(true);
  });
});
