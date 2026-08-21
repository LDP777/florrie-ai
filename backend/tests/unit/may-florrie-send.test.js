/**
 * The single most consequential `if` in the product.
 *
 * WHAT IT IS FOR. Thirty days of Ellie's inbox, measured on 21 August:
 *
 *   177 client messages in
 *   Florrie wrote a reply to 147 of them
 *   Florrie sent 5
 *   142 escalated for Ellie to approve — 43 of them at exactly 85% confidence
 *   14 of the 177 were ever marked resolved
 *
 * A queue nobody works is not a safety mechanism, it is a pile. And the pile
 * was not made of hard cases: one held message was a client saying "So don't
 * rush xx" with Florrie wanting to answer "no worries! take your time".
 * Twenty-one greetings and six thank-yous did the same.
 *
 * The cause was structural. canActAutonomously ran first and isGroundedReply
 * could only narrow what it had already allowed — and canActAutonomously
 * demands 0.9 from a classifier that says 0.85 when it is certain. So the
 * whole grounded system, built precisely to answer Ellie's "I still have just
 * as much admin", was close to unreachable.
 *
 * The guards decide now. These tests exist so that stays true, and so the
 * things that must NOT change cannot drift: availability is still a claim
 * about the future, and it still waits for her.
 */
import { describe, it, expect } from 'vitest';
import { mayFlorrieSend } from '../../src/services/ai-front-desk.js';
import { isGroundedReply } from '../../src/lib/grounded-reply.js';

const KNOWLEDGE = [{ question: 'aftercare', answer: 'Keep them dry for 24 hours.' }];
const PRICES = [{ name: 'Korean lash lift', price_cents: 5000 }];
const BOOKED = [{ starts_at: '2026-09-05T14:00:00', treatments: { name: 'Brow lamination' } }];

/** The real grounded verdict, so these two files cannot disagree. */
const verdict = (intent, message = 'hello', context = {}) =>
  isGroundedReply({ intent, message, context });

const decide = (intent, opts = {}) => mayFlorrieSend({
  classification: { intent, confidence: opts.confidence ?? 0.85 },
  groundedDecision: verdict(intent, opts.message ?? 'hello', opts.context ?? {}),
  known: opts.known ?? true,
  autonomyOverride: opts.autonomyOverride ?? null,
  threshold: opts.threshold ?? 0.9,
});

describe('the messages that were piling up', () => {
  it('answers a greeting from a regular', () => {
    // 21 of these in 30 days, every one of them queued for approval.
    expect(decide('greeting')).toBe(true);
  });

  it('answers a thank you', () => {
    expect(decide('review_thanks', { message: 'Thanks so much, loved it!' })).toBe(true);
  });

  it('answers "when am I booked in?" from the diary', () => {
    expect(decide('booking_lookup', { context: { clientUpcoming: BOOKED } })).toBe(true);
  });

  it('answers a price from the price list', () => {
    expect(decide('price_enquiry', { context: { treatments: PRICES } })).toBe(true);
  });

  it('answers a general question that the knowledge base actually covers', () => {
    expect(decide('general_question', { context: { knowledge: KNOWLEDGE } })).toBe(true);
  });

  it('does all of that at 85%, which is what this classifier says when it is sure', () => {
    // The exact number on 43 held messages. If this ever goes back to false,
    // the queue fills up again and nobody will notice for a month.
    expect(decide('greeting', { confidence: 0.85 })).toBe(true);
    expect(decide('greeting', { confidence: 0.6 })).toBe(true);
  });
});

describe('what still waits for Ellie, and must keep waiting', () => {
  it('holds an availability check, which is what 28 July actually was', () => {
    // "4.30 on Thursday is available" when it was not. A free slot is a claim
    // about the future that a stale read gets wrong.
    expect(decide('availability_check', { message: 'is Saturday free?' })).toBe(false);
  });

  it('holds a booking request even at full confidence', () => {
    expect(decide('booking_request', { confidence: 1 })).toBe(false);
  });

  it.each(['reschedule', 'cancellation', 'complaint', 'unknown'])('holds %s', (intent) => {
    expect(decide(intent, { confidence: 1 })).toBe(false);
  });

  it('holds a general question the knowledge base cannot answer', () => {
    // Otherwise the model is answering from the prompt, which is ungrounded
    // however confident it sounds.
    expect(decide('general_question', { context: { knowledge: [] } })).toBe(false);
  });

  it('holds a price enquiry with no price list behind it', () => {
    expect(decide('price_enquiry', { context: { treatments: [] } })).toBe(false);
  });

  it('holds a booking lookup when there is nothing in the diary', () => {
    // Telling a client she has no appointment when she believes otherwise is
    // a claim worth a human eye.
    expect(decide('booking_lookup', { context: { clientUpcoming: [] } })).toBe(false);
  });

  it('holds anything at all when the client asked for a person', () => {
    expect(decide('greeting', { message: 'can I speak to Ellie please' })).toBe(false);
    expect(decide('greeting', { message: 'is this a bot?' })).toBe(false);
  });
});

describe('the per-thread switches she controls', () => {
  it('says nothing in a thread she set to just me', () => {
    expect(decide('greeting', { autonomyOverride: 'just_me' })).toBe(false);
    expect(decide('booking_lookup', { context: { clientUpcoming: BOOKED }, autonomyOverride: 'just_me' })).toBe(false);
  });

  it('says nothing in a thread set to drafts', () => {
    expect(decide('greeting', { autonomyOverride: 'drafts' })).toBe(false);
  });

  it('lets a whitelisted client through the old path too', () => {
    // She has explicitly said Florrie may speak to this one.
    expect(decide('booking_request', { autonomyOverride: 'florrie', confidence: 0.95 })).toBe(true);
  });

  it('still refuses a whitelisted client below her threshold on an ungrounded intent', () => {
    expect(decide('booking_request', { autonomyOverride: 'florrie', confidence: 0.5 })).toBe(false);
  });

  it('switching grounded replies off puts it back exactly as it was', () => {
    // The one-line rollback, no deploy needed.
    const off = { grounded: false, reason: 'grounded_replies_switched_off' };
    expect(mayFlorrieSend({
      classification: { intent: 'greeting', confidence: 0.85 },
      groundedDecision: off, known: true, autonomyOverride: null, threshold: 0.9,
    })).toBe(false);
  });
});

describe('somebody who has never booked', () => {
  it('is answered from the price list like anyone else', () => {
    expect(decide('price_enquiry', { known: false, context: { treatments: PRICES } })).toBe(true);
  });

  it('can still be booked in by the old path at her threshold', () => {
    // Unchanged: this is the one thing Florrie was already doing, and the
    // booking conversation behind it reads the real diary.
    expect(decide('booking_request', { known: false, confidence: 0.95 })).toBe(true);
  });

  it('is not booked in below her threshold', () => {
    expect(decide('booking_request', { known: false, confidence: 0.7 })).toBe(false);
  });

  it('is treated as a stranger, not as a regular, for the ungrounded intents', () => {
    // The asymmetry is deliberate: a regular's booking request is a
    // relationship Ellie manages, a stranger's is a lead Florrie may work.
    expect(decide('booking_request', { known: true, confidence: 0.95 })).toBe(false);
    expect(decide('booking_request', { known: false, confidence: 0.95 })).toBe(true);
  });
});

describe('the shape of the change, stated as a number', () => {
  it('clears the intents that made up the pile and keeps the ones that did not', () => {
    // The 142 escalations of the last 30 days, by what they were.
    const wouldSend = (intent, ctx) => decide(intent, { context: ctx, confidence: 0.85 });
    expect(wouldSend('greeting')).toBe(true);              // 25
    expect(wouldSend('review_thanks')).toBe(true);         //  8
    expect(wouldSend('price_enquiry', { treatments: PRICES })).toBe(true);
    expect(wouldSend('general_question', { knowledge: KNOWLEDGE })).toBe(true);
    // And the ones that are genuinely hers stay hers.
    expect(wouldSend('availability_check')).toBe(false);
    expect(wouldSend('reschedule')).toBe(false);
    expect(wouldSend('cancellation')).toBe(false);
    expect(wouldSend('complaint')).toBe(false);
    expect(wouldSend('unknown')).toBe(false);
  });
});
