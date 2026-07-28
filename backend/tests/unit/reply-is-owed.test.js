/**
 * replyIsOwed decides whether a message needs Ellie at all.
 *
 * The noise it exists to kill: every message from a known client used to
 * escalate, so "thanks lovely, see you then x" produced the same badge point
 * as "can I move to Saturday?". The badge sat at 99+ and stopped meaning
 * anything.
 *
 * The asymmetry that drives the rules: a wasted glance costs her a second, a
 * client left hanging costs her the client. So anything about money, the
 * diary or unhappiness stays owed even when it arrives as a bare "yes",
 * because that "yes" may be answering a question Florrie asked.
 */
import { describe, it, expect } from 'vitest';
import { replyIsOwed } from '../../src/services/ai-front-desk.js';

describe('replyIsOwed', () => {
  it('goes quiet on sign-offs, including strings of them', () => {
    // The classifier readily calls chit-chat general_question, so the wording
    // has to get the final say or nothing is ever quiet.
    expect(replyIsOwed('thanks lovely, see you then x', { intent: 'general_question' })).toBe(false);
    expect(replyIsOwed('ok', { intent: 'general_question' })).toBe(false);
    expect(replyIsOwed('perfect thank you!', { intent: 'review_thanks' })).toBe(false);
    expect(replyIsOwed('hiya', { intent: 'greeting' })).toBe(false);
    expect(replyIsOwed('❤️❤️', { intent: 'review_thanks' })).toBe(false);
  });

  it('always owes a reply to a question', () => {
    expect(replyIsOwed('can I move to Saturday?', { intent: 'reschedule' })).toBe(true);
    // No question mark, still plainly a question.
    expect(replyIsOwed('what time am I booked in', { intent: 'general_question' })).toBe(true);
  });

  it('never goes quiet on money, diary or complaints', () => {
    expect(replyIsOwed('how much is a full set', { intent: 'price_enquiry' })).toBe(true);
    expect(replyIsOwed('my lashes fell out after 2 days', { intent: 'complaint' })).toBe(true);
    expect(replyIsOwed('I need to cancel', { intent: 'cancellation' })).toBe(true);
  });

  it('keeps bare acknowledgements owed when they answer a real question', () => {
    // "yes" to "shall I cancel it?" is a decision, not a sign-off. These
    // intents deliberately outrank the closing-phrase test.
    expect(replyIsOwed('yes', { intent: 'cancellation' })).toBe(true);
    expect(replyIsOwed('no', { intent: 'cancellation' })).toBe(true);
    expect(replyIsOwed('x', { intent: 'cancellation' })).toBe(true);
  });

  it('does not let a sign-off swallow a request that follows it', () => {
    expect(replyIsOwed('perfect see you then, oh also how much for a refill', { intent: 'price_enquiry' })).toBe(true);
    expect(replyIsOwed('thanks but I need to move it', { intent: 'reschedule' })).toBe(true);
    expect(replyIsOwed('yes please', { intent: 'general_question' })).toBe(true);
  });

  it('surfaces unknown intent with real content', () => {
    // Better a wasted glance than a client left hanging.
    expect(replyIsOwed('my sister wants to come too next time', { intent: 'unknown' })).toBe(true);
  });
});

/**
 * The sticky-flag bug, which is what actually pinned the badge at 99+.
 *
 * Production, 26 Jul: 323 unresolved escalations across 132 clients. But only
 * 15 conversations had the client speaking last with something owed. The gap
 * is threads Ellie HAD answered, still counting because an old escalated row
 * was never marked resolved.
 */
describe('who is actually waiting', () => {
  const owed = (t) => (
    t.last_message_direction === 'inbound'
    && replyIsOwed(t.last_inbound_preview, { intent: t.last_inbound_intent })
  );

  it('does not count a thread she has already answered', () => {
    // The old rule returned true here purely because needs_attention was set.
    expect(owed({
      needs_attention: true,
      last_message_direction: 'outbound',
      last_inbound_preview: 'can I move to Saturday?',
      last_inbound_intent: 'reschedule',
    })).toBe(false);
  });

  it('still counts a thread where the client spoke last and asked something', () => {
    expect(owed({
      needs_attention: false,
      last_message_direction: 'inbound',
      last_inbound_preview: 'can I move to Saturday?',
      last_inbound_intent: 'reschedule',
    })).toBe(true);
  });

  it('does not count a thread whose last word was a sign-off', () => {
    // 85 of the 323 were intent 'unknown' chit-chat like "*round lol x".
    expect(owed({
      needs_attention: true,
      last_message_direction: 'inbound',
      last_inbound_preview: 'amazing thank you xx',
      last_inbound_intent: 'review_thanks',
    })).toBe(false);
  });
});
