/**
 * What Florrie hides from Ellie. A false positive here means a real client's
 * message never reaches her, which is far worse than a spammer getting
 * through, so the "never flags a real client" cases are the ones that matter.
 */
import { describe, it, expect } from 'vitest';
import { classifyInboundMessage, looksLikeKnownClient } from '../../src/lib/junk-classifier.js';

// The two Ellie actually received, plus the categories they represent.
const JUNK = [
  ["wingman DM", "hey! my friend just moved here and tinder's been a disaster for her, thought you two would get on, here's her snap"],
  ["retoucher pitch", "Hi! I'm a beauty retoucher and I'd love to work with you. I'll do one free test photo for your page, no obligation"],
  ["follower selling", "Hello, I can get you 5000 followers in 30 days, guaranteed results, completely risk-free"],
  ["mass outreach", "Dear Sir/Madam, we are a digital marketing agency and hope this message finds you well. Portfolio in my bio"],
  ["crypto", "Invest 200 in bitcoin today and withdraw 2000 in 24 hours, message me for the trading signals"],
  ["two weak signals", "Hi there, I came across your page and love your content. Let me know if you are interested in a collab"],
];

// Anything here being hidden from Ellie is a far worse outcome than a spammer
// getting through, so these are the tests that matter most.
const REAL = [
  "Hi Ellie, do you have any availability on Saturday for a lash infill?",
  "hey can I move my appointment to next week please x",
  "How much is a full set babe?",
  "Thank you so much, they look amazing!!",
  "Hiya, I'm new here, my friend just moved to the area and recommended you. Could I book in for brows?",
  "Hi hope you're well! Just wondering if you have any slots free tomorrow",
  "Sorry running late, be there in 10",
  "Hi! I found your page on instagram and would love to book a lash lift, do you do them?",
  "Do I need a patch test before my appointment?",
  "hi",
  "Hey hun, can I pay the rest on the day?",
  "I have to cancel Friday sorry, family emergency",
];

describe('junk classifier', () => {
  it('flags obvious non-client outreach', () => {
    for (const [label, text] of JUNK) {
      expect(classifyInboundMessage(text).isJunk, `missed: ${label}`).toBe(true);
    }
  });

  it('never flags a real client message', () => {
    for (const text of REAL) {
      const result = classifyInboundMessage(text);
      expect(result.isJunk, `false positive on: ${text} (${result.reason})`).toBe(false);
    }
  });

  it('one weak signal alone is never enough', () => {
    expect(classifyInboundMessage('Hi, I came across your page and wanted to say hello to you').isJunk).toBe(false);
    expect(classifyInboundMessage('Hello there, I hope you are doing well today, just saying hi').isJunk).toBe(false);
  });

  it('salon vocabulary beats every spam signal', () => {
    // Deliberate false negative: better a spammer gets through than a client
    // asking about lashes gets hidden.
    const text = "I'm a photographer, I'd love to shoot your lash work for free, no obligation";
    expect(classifyInboundMessage(text).isJunk).toBe(false);
  });

  it('someone she already deals with is exempt', () => {
    const text = JUNK[0][1];
    expect(classifyInboundMessage(text).isJunk).toBe(true);
    expect(classifyInboundMessage(text, { isKnownClient: true }).isJunk).toBe(false);
  });

  it('short messages and media stubs are never judged', () => {
    expect(classifyInboundMessage('hi').isJunk).toBe(false);
    expect(classifyInboundMessage('[Photo]').isJunk).toBe(false);
    expect(classifyInboundMessage('').isJunk).toBe(false);
    expect(classifyInboundMessage(null).isJunk).toBe(false);
  });

  it('a phone number is not evidence on the channel that supplied it', () => {
    const fresh = { phone: '+447700900000', whatsapp_id: '447700900000', status: 'new' };
    expect(looksLikeKnownClient(fresh, { channel: 'whatsapp' })).toBe(false);
    expect(looksLikeKnownClient(fresh, { channel: 'instagram' })).toBe(true);
    expect(looksLikeKnownClient({ ...fresh, total_visits: 3 }, { channel: 'whatsapp' })).toBe(true);
  });
});
