/**
 * Where the line sits between "Florrie answers" and "Ellie answers".
 *
 * Ellie's verdict after a month with Florrie was that she still had just as
 * much admin. She was right. ai-front-desk.js held every message from a known
 * client for approval, and `isKnownClient` means "any appointment ever, in any
 * status" — so Florrie auto-replied to strangers and to nobody else. Every
 * regular got drafted and queued. The admin never went away; it changed shape,
 * from writing messages to approving them.
 *
 * The guard existed for a real reason. On 28 July Florrie told a client 4.30
 * Thursday was free when it was not, and the instruction was "we shouldn't
 * fuck with Ellie's clients." So this file is mostly about proving the new
 * line does NOT let that back through, while letting the harmless case out.
 *
 * The distinction is evidence, not topic:
 *   grounded   — the answer is already a fact in the database
 *   ungrounded — the answer needs a judgement, a negotiation, or a claim about
 *                the future
 *
 * The 28 July incident was an availability claim. It stays gated, three
 * different ways: by intent, by the text of the generated reply, and by the
 * absence of the data that would make it a lookup.
 */
import { describe, it, expect } from 'vitest';
import { isGroundedReply, asksForHuman, signAsFlorrie, florrieSignature } from '../../src/lib/grounded-reply.js';

const CONTEXT = {
  treatments: [{ name: 'Lash lift & tint', price_cents: 4500 }],
  knowledge: [{ q: 'aftercare', a: 'no steam for 24h' }],
  clientUpcoming: [{ starts_at: '2026-08-18T18:00:00', treatments: { name: 'Lash lift & tint' } }],
};

const ask = (over = {}) => isGroundedReply({
  intent: 'booking_lookup',
  message: 'I have an appointment with you tomorrow at 6pm correct?',
  context: CONTEXT,
  ...over,
});

describe('the message that started this', () => {
  it('lets Florrie confirm a booking the diary already holds', () => {
    // The exact message a client sent Ellie the evening before hers. It is a
    // lookup. Florrie knows the answer with certainty.
    const v = ask();
    expect(v.grounded).toBe(true);
    expect(v.reason).toBe('grounded:booking_lookup');
  });

  it('will not confirm a booking that is not there', () => {
    // "You're not booked in" is a claim worth a human eye when the client
    // clearly believes otherwise — and that IS this client's situation.
    const v = ask({ context: { ...CONTEXT, clientUpcoming: [] } });
    expect(v.grounded).toBe(false);
    expect(v.reason).toBe('no_upcoming_booking_to_confirm');
  });
});

describe('the 28 July incident stays impossible', () => {
  it('never answers "are you free Saturday?" on its own', () => {
    const v = ask({ intent: 'availability_check', message: 'you free saturday?' });
    expect(v.grounded).toBe(false);
    expect(v.reason).toBe('ungrounded_intent:availability_check');
  });

  it.each(['booking_request', 'reschedule', 'cancellation', 'complaint', 'unknown'])(
    'holds %s for Ellie', (intent) => {
      expect(ask({ intent }).grounded).toBe(false);
    });

  it('holds a reply that CLAIMS availability even when the intent looked safe', () => {
    // The second gate, on the text rather than the intent. A lookup that comes
    // back offering a time is not a lookup any more.
    const v = ask({ reply: "Yes you're in Tuesday at 6! I've also got Saturday free if you fancy a top up." });
    expect(v.grounded).toBe(false);
    expect(v.reason).toBe('reply_claims_availability');
  });

  it('holds a reply that promises a human will do something', () => {
    const v = ask({ reply: "You're booked for Tuesday. I'll get Ellie to call you about the other thing." });
    expect(v.grounded).toBe(false);
    expect(v.reason).toBe('reply_promises_a_human_action');
  });

  it('still allows a plain negative that only sounds like availability', () => {
    // "not free" must not trip the availability guard, or Florrie can never
    // say the honest thing.
    const v = ask({ reply: "You're booked in Tuesday at 6pm. Ellie is not free before that I'm afraid." });
    expect(v.grounded).toBe(true);
  });
});

describe('grounded means the data is actually there', () => {
  it('answers a price question when there is a price list', () => {
    expect(ask({ intent: 'price_enquiry', message: 'how much is a lash lift?' }).grounded).toBe(true);
  });

  it('refuses a price question with no price list, rather than guessing', () => {
    const v = ask({ intent: 'price_enquiry', message: 'how much?', context: { ...CONTEXT, treatments: [] } });
    expect(v.grounded).toBe(false);
    expect(v.reason).toBe('no_price_list');
  });

  it('answers a general question only from the knowledge base', () => {
    expect(ask({ intent: 'general_question', message: 'can I shower after?' }).grounded).toBe(true);
    const v = ask({ intent: 'general_question', message: 'can I shower after?', context: { ...CONTEXT, knowledge: [] } });
    expect(v.grounded).toBe(false);
    expect(v.reason).toBe('no_knowledge_match');
  });

  it('treats an intent it has never heard of as ungrounded', () => {
    expect(ask({ intent: 'something_new' }).grounded).toBe(false);
  });
});

describe('asking for a person gets a person', () => {
  // The beautician in these fixtures is the pilot, so HER name is the one
  // that counts here. It is passed in rather than baked into the module:
  // every tenant gets her own name matched, see tenant-name-leak.test.js.
  const HER = 'Ellie';

  it.each([
    'ELLIE',
    'ellie',
    'can I speak to Ellie please',
    'is this a bot?',
    'am I talking to a real person',
    'I want to talk to a human',
    'is that an AI',
    'are you a bot',
    'are you human?',
    'is this an actual person',
  ])('recognises %j', (m) => expect(asksForHuman(m, HER)).toBe(true));

  it.each([
    'thanks Ellie see you Tuesday',
    'Ellie did my brows last time',
    'can I book in with you',
    'are you free tomorrow',
    'is this the right number for lashes',
    'hi!',
  ])('does not fire on %j', (m) => expect(asksForHuman(m, HER)).toBe(false));

  it('overrides even a perfectly grounded question', () => {
    // A client who asks for Ellie by name and gets a machine is the worst
    // outcome available here, whatever else the message says.
    const v = ask({ message: 'is this a bot? when am I booked in' });
    expect(v.grounded).toBe(false);
    expect(v.reason).toBe('asked_for_a_human');
  });
});

describe('every message Florrie sends says it is Florrie', () => {
  it('names her, names who she works for, and offers the way out', () => {
    const sig = florrieSignature('Ellie');
    expect(sig).toContain('Florrie');
    expect(sig).toContain("Ellie's assistant");
    // The client cannot be expected to guess the word. It has to be on the
    // message, every time.
    expect(sig).toMatch(/reply ELLIE/i);
  });

  it('appends to a reply without touching the reply', () => {
    const out = signAsFlorrie("You're booked in Tuesday at 6pm.", 'Ellie');
    expect(out.startsWith("You're booked in Tuesday at 6pm.")).toBe(true);
    expect(out).toContain("Florrie, Ellie's assistant");
  });

  it('does not sign twice', () => {
    const once = signAsFlorrie('Hello', 'Ellie');
    expect(signAsFlorrie(once, 'Ellie')).toBe(once);
  });

  it('uses the beautician\'s own name', () => {
    expect(signAsFlorrie('Hi', 'Priya')).toContain("Priya's assistant");
  });
});

/**
 * 26 AUGUST: "i'll send you a new one now. should come through in a min xx"
 *
 * Nothing was sent, because Florrie had no ability to send anything, and the
 * client replied "Thanks" and went on waiting for an email that was not
 * coming. The claims guard now catches the FIRST person form on evidence: if a
 * confirmation really was resent in that same request the sentence is true and
 * must stand, and if it was not, the draft is held.
 *
 * promisesAHumanAction is the other half, and it had the same blind spot from
 * the other direction. Its verb list was call, ring, text, check, get back,
 * confirm, sort. "Ellie will send that over" matched nothing, so a promise
 * about a HUMAN sending something was caught by no guard at all.
 *
 * The two halves must not be merged. A first person "I'll send" is evidenced
 * by the send actually happening; a third person one never can be, because
 * Florrie cannot commit somebody else's afternoon.
 */
describe('a promise that somebody else will send something', () => {
  const grounded = (reply) => isGroundedReply({
    intent: 'greeting',
    message: 'Hey, did my confirmation come through?',
    context: { clientUpcoming: [], treatments: [], knowledge: [] },
    reply,
    beauticianFirstName: 'Ellie',
  });

  it('holds "Ellie will send that over", which nobody promised', () => {
    expect(grounded('No problem, Ellie will send that over shortly.').grounded).toBe(false);
  });

  it('holds it for she and we as well', () => {
    expect(grounded("She'll email it across to you tonight.").grounded).toBe(false);
    expect(grounded("We'll resend it in the morning.").grounded).toBe(false);
  });

  it('still holds the original human promises', () => {
    expect(grounded("I'll get Ellie to call you back.").grounded).toBe(false);
    expect(grounded('Ellie will ring you this afternoon.').grounded).toBe(false);
  });

  it('does not hold Florrie describing her own send, which the claims guard judges on evidence', () => {
    // If this became false, the fix for 26 August would have broken the case
    // where the resend genuinely happened, and Florrie would be refusing to
    // describe something she had just done.
    const v = grounded("I'll send you a new one now, it should come through in a minute.");
    expect(v.reason).not.toMatch(/human/i);
  });

  it('leaves the sanctioned holding reply alone', () => {
    expect(grounded('Let me check my book and come straight back to you.').grounded).toBe(true);
  });
});
