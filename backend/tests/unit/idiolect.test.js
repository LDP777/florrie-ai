/**
 * Ellie's clients could tell it was not her. This file is the regression test
 * for that sentence.
 *
 * The corpus below is a plausible Ellie: lower case, "hey lovely", "xx", short
 * enough to have been thumbed between two clients. Every assertion is a thing
 * one of her regulars would notice if it changed, which is the whole point of
 * measuring instead of describing. A profile that says "warm and friendly"
 * cannot be tested; a profile that says "she signs off xx, twelve words, no
 * full stop" can.
 */
import { describe, it, expect } from 'vitest';
import {
  extractStyleProfile,
  renderVoiceSection,
  pickExamples,
  checkDraftStyle,
  repairDraft,
  styleFit,
  authorshipForSend,
  looksAutomated,
  maskName,
  kissAtEnd,
  AUTHOR,
} from '../../src/lib/idiolect.js';

// 30 messages, newest first, as they would come out of the messages table.
const ELLIE = [
  ['hey sarah, all booked in for you thursday at half 2 xx', 'Sarah'],
  ['aw thanks lovely, so glad you like them xx', 'Sarah'],
  ['hey emma, lash lift is 45 and takes about an hour xx', 'Emma'],
  ['no worries at all lovely, let me know when suits you xx', 'Emma'],
  ['hey jess, just checking you still ok for friday xx', 'Jess'],
  ['hey lucy, brow lam is 40 and lasts about 6 weeks xx', 'Lucy'],
  ['thats fine hun, ill pop you in the book xx', 'Lucy'],
  ['hey katie, so sorry im running about 15 mins behind xx', 'Katie'],
  ['hey sarah, your patch test is booked for tuesday xx', 'Sarah'],
  ['no worries lovely, ill see you then xx', 'Jess'],
  ['hey emma, ive got a space next week if you fancy it xx', 'Emma'],
  ['aw bless you, thank you lovely xx', 'Katie'],
  ['hey beth, lash lift and tint together is 55 xx', 'Beth'],
  ['course you can hun, just let me know what day xx', 'Beth'],
  ['hey lucy, ill get you in the diary for that xx', 'Lucy'],
  ['hey jess, infills are 35 if you come within 3 weeks xx', 'Jess'],
  ['no rush lovely, whenever suits xx', 'Beth'],
  ['hey katie, ive had a cancellation if you want it xx', 'Katie'],
  ['aw thank you so much lovely xx', 'Emma'],
  ['hey beth, keep them dry for 24 hours and no mascara xx', 'Beth'],
  ['hey sarah, brow tint on its own is 15 xx', 'Sarah'],
  ['sorry lovely just seen this, ill check and come back to you xx', 'Lucy'],
  ['hey emma, that ones 45 and takes about 45 mins xx', 'Emma'],
  ['hey jess, all done for you, see you soon xx', 'Jess'],
  ['thats no problem hun, ill move it over xx', 'Katie'],
  ['hey lucy, so sorry ive had to shuffle the morning about xx', 'Lucy'],
  ['hey beth, ive put you down for the lash lift xx', 'Beth'],
  ['aw youre so welcome lovely xx', 'Sarah'],
  ['hey katie, i can do you a patch test before if thats easier xx', 'Katie'],
  ['hey emma, they should last about 6 to 8 weeks xx', 'Emma'],
  ['no worries lovely, let me know what suits and ill sort it xx', 'Beth'],
].map(([text, clientFirstName]) => ({ text, clientFirstName }));

const style = extractStyleProfile(ELLIE);

describe('extractStyleProfile: measuring Ellie', () => {
  it('measures the exact sign off, not "she is friendly"', () => {
    expect(style.kiss.token).toBe('xx');
    expect(style.kiss.rate).toBeGreaterThan(0.9);
  });

  it('learns the opener with the client name masked out, so it is one habit not thirty', () => {
    expect(style.opener.text).toBe('hey {name}');
    expect(style.opener.rate).toBeGreaterThan(0.5);
  });

  it('notices she starts in lower case and does not end with a full stop', () => {
    expect(style.lowercase_start_rate).toBe(1);
    expect(style.ends_full_stop_rate).toBe(0);
  });

  it('measures how long she actually writes', () => {
    expect(style.length.median_words).toBeGreaterThan(4);
    expect(style.length.median_words).toBeLessThan(16);
    expect(style.length.p90_words).toBeLessThan(20);
  });

  it('records that she uses the client first name', () => {
    expect(style.uses_first_name_rate).toBeGreaterThan(0.6);
  });

  it('picks up what she calls people, verbatim', () => {
    const words = style.endearments.map(e => e.word);
    expect(words).toContain('lovely');
    expect(words).toContain('hun');
  });

  it('keeps her phrases word for word rather than paraphrasing them', () => {
    expect(style.phrases).toContain('no worries');
    expect(style.phrases.some(p => p.includes('let me know'))).toBe(true);
  });

  it('says she uses no emoji when she uses none, which is as important as which ones she uses', () => {
    expect(style.emoji.rate_any).toBe(0);
    expect(style.emoji.top).toEqual([]);
  });

  it('reports full confidence only with enough of her writing', () => {
    expect(style.confidence).toBe('good');
    expect(extractStyleProfile(ELLIE.slice(0, 12)).confidence).toBe('low');
  });
});

describe('extractStyleProfile: not enough data', () => {
  it('returns nothing at all for a brand new customer, rather than a confident guess', () => {
    expect(extractStyleProfile(ELLIE.slice(0, 3))).toBe(null);
    expect(extractStyleProfile([])).toBe(null);
    expect(extractStyleProfile(null)).toBe(null);
  });

  it('a different beautician gets a different profile, not Ellie flavoured defaults', () => {
    const formal = Array.from({ length: 12 }, (_, i) => ({
      text: `Good morning Claire. Your appointment on the ${i + 1}th is confirmed. Kind regards.`,
      clientFirstName: 'Claire',
    }));
    const s = extractStyleProfile(formal);
    expect(s.kiss.token).toBe(null);
    expect(s.lowercase_start_rate).toBe(0);
    expect(s.ends_full_stop_rate).toBe(1);
  });
});

describe('maskName and kissAtEnd', () => {
  it('masks the name case insensitively and leaves the rest alone', () => {
    expect(maskName('hey Sarah, sarah your lashes', 'sarah')).toBe('hey {name}, {name} your lashes');
  });
  it('does not mask a one letter name, which would shred the message', () => {
    expect(maskName('hey there', 'A')).toBe('hey there');
  });
  it('reads the kiss exactly as written', () => {
    expect(kissAtEnd('all booked x')).toBe('x');
    expect(kissAtEnd('all booked xx')).toBe('xx');
    expect(kissAtEnd('all booked Xx')).toBe('Xx');
    expect(kissAtEnd('all booked')).toBe(null);
    expect(kissAtEnd('lash lift x 2 please')).toBe(null);
  });
});

describe('pickExamples: show her, do not describe her', () => {
  const examples = [
    { text: 'hey {name}, all booked in for thursday xx', reply_to: 'can i book in for thursday please' },
    { text: 'hey {name}, lash lift is 45 and takes about an hour xx', reply_to: 'how much is a lash lift' },
    { text: 'no worries lovely, ill take the deposit off the next one xx', reply_to: 'so sorry i have to cancel tomorrow' },
    { text: 'aw thank you so much lovely xx', reply_to: 'thanks so much i love them' },
  ];

  it('picks the price answer for a price question', () => {
    const picked = pickExamples(examples, 'hiya how much is a lash lift these days', 2);
    expect(picked[0]).toContain('lash lift is 45');
  });

  it('picks the cancellation answer for a cancellation', () => {
    const picked = pickExamples(examples, 'so sorry i need to cancel tomorrow', 2);
    expect(picked[0]).toContain('deposit');
  });

  it('still returns her real messages when nothing overlaps, because some of her beats none', () => {
    const picked = pickExamples(examples, 'zzzz qqqq', 3);
    expect(picked).toHaveLength(3);
  });

  it('returns nothing when there is nothing', () => {
    expect(pickExamples([], 'anything')).toEqual([]);
  });
});

describe('renderVoiceSection', () => {
  const profile = { style, examples: [{ text: 'hey {name}, all booked xx', reply_to: 'can i book in' }] };

  it('gives the model instructions it can copy, not adjectives', () => {
    const out = renderVoiceSection(profile, 'can i book in');
    expect(out).toContain('"xx"');
    expect(out).toContain('"hey {name}"');
    expect(out).toContain('lower case');
    expect(out).toMatch(/LENGTH/);
    expect(out).toContain('hey {name}, all booked xx');
  });

  it('says nothing at all when there is no profile, so callers fall back to plain', () => {
    expect(renderVoiceSection(null, 'hi')).toBe('');
    expect(renderVoiceSection({}, 'hi')).toBe('');
    expect(renderVoiceSection({ style: null }, 'hi')).toBe('');
  });

  it('flags a bootstrap profile as thin rather than presenting it as fact', () => {
    const out = renderVoiceSection({ ...profile, provenance: 'bootstrap' }, 'hi');
    expect(out).toContain('small sample');
  });

  it('never emits an em dash or an en dash', () => {
    const out = renderVoiceSection(profile, 'can i book in');
    expect(out).not.toMatch(/[–—]/);
  });
});

describe('checkDraftStyle: catching the message her clients would not recognise', () => {
  it('rejects the generic assistant reply on every count', () => {
    const generic = 'Hi Sarah, thank you so much for getting in touch. A lash lift is £45 and takes around 45 minutes. Please let me know if you would like me to book you in and I will get that sorted for you.';
    const verdict = checkDraftStyle(generic, style);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toContain('too_long');
    expect(verdict.problems).toContain('capitalised_start');
    expect(verdict.problems).toContain('sign_off_missing');
    expect(verdict.tooLong).toBe(true);
  });

  it('passes a message that reads like her', () => {
    const verdict = checkDraftStyle('hey sarah, lash lift is 45 and takes about an hour xx', style);
    expect(verdict.ok).toBe(true);
    expect(verdict.problems).toEqual([]);
  });

  it('catches the wrong kiss, which is as audible as no kiss', () => {
    const single = extractStyleProfile(ELLIE.map(m => ({ ...m, text: m.text.replace(/xx$/, 'x') })));
    expect(checkDraftStyle('hey sarah all booked xx', single).problems).toContain('sign_off_wrong');
  });

  it('catches emoji she does not use', () => {
    expect(checkDraftStyle('hey sarah all booked xx ✨', style).problems).toContain('emoji_unwanted');
  });

  it('catches a sign off on someone who does not sign off', () => {
    const formal = extractStyleProfile(Array.from({ length: 12 }, () => ({
      text: 'Good morning Claire. Your appointment is confirmed. Kind regards.',
      clientFirstName: 'Claire',
    })));
    expect(checkDraftStyle('All booked in for you xx', formal).problems).toContain('sign_off_unwanted');
  });

  it('waves everything through when there is no profile, rather than inventing a standard', () => {
    const verdict = checkDraftStyle('Anything at all, at any length, with a full stop.', null);
    expect(verdict.ok).toBe(true);
  });
});

describe('repairDraft: the deterministic half of the fix', () => {
  it('adds her sign off, drops the full stop and lowers the capital', () => {
    const fixed = repairDraft('Hi Sarah, that is all booked in for you.', style);
    expect(fixed).toBe('hi Sarah, that is all booked in for you xx');
    expect(checkDraftStyle(fixed, style).problems).toEqual([]);
  });

  it('strips a full stop hiding in front of the kiss', () => {
    expect(repairDraft('all booked in for you. xx', style)).toBe('all booked in for you xx');
  });

  it('swaps the wrong kiss for hers', () => {
    const single = extractStyleProfile(ELLIE.map(m => ({ ...m, text: m.text.replace(/xx$/, 'x') })));
    expect(repairDraft('all booked in x x x x', single)).toBe('all booked in x');
  });

  it('removes emoji from a woman who does not use them', () => {
    expect(repairDraft('hey sarah all booked ✨💕 xx', style)).toBe('hey sarah all booked xx');
  });

  it('keeps only her own emoji, up to her own budget', () => {
    const emojiEllie = extractStyleProfile(ELLIE.map((m, i) => ({
      ...m, text: i % 2 ? `${m.text} 🤍` : m.text,
    })));
    const fixed = repairDraft('hey sarah all booked ✨🎉🤍 xx', emojiEllie);
    expect(fixed).not.toContain('✨');
    expect(fixed).not.toContain('🎉');
    expect(fixed).toContain('🤍');
  });

  it('never lowercases a word that might be a name', () => {
    expect(repairDraft('Sarah thats all booked in for you', style)).toBe('Sarah thats all booked in for you xx');
  });

  it('leaves a message alone when it already sounds like her', () => {
    const already = 'hey sarah, all booked in for thursday xx';
    expect(repairDraft(already, style)).toBe(already);
  });

  it('does nothing without a profile, so a new customer is never restyled into a stranger', () => {
    const draft = 'Hello Claire. Your appointment is confirmed.';
    expect(repairDraft(draft, null)).toBe(draft);
  });

  it('cannot introduce a time, a price or a claim, which is what keeps the claims guard meaningful', () => {
    const draft = 'Let me check my book and come straight back to you.';
    const fixed = repairDraft(draft, style);
    expect(fixed.replace(/\s*xx$/, '').toLowerCase())
      .toBe('let me check my book and come straight back to you'.toLowerCase());
  });
});

describe('styleFit', () => {
  it('reports what it could not fix, and length is the only thing it cannot', () => {
    const long = 'Hi Sarah, thank you so much for getting in touch. A lash lift is £45 and takes around 45 minutes. Please let me know if you would like me to book you in and I will get that sorted for you.';
    const fit = styleFit(long, style);
    expect(fit.tooLong).toBe(true);
    expect(fit.problems).toEqual(['too_long']);
    expect(fit.text.endsWith('xx')).toBe(true);
  });

  it('settles in one pass: fitting twice changes nothing', () => {
    const once = styleFit('Hi Sarah, that is all booked in for you.', style);
    const twice = styleFit(once.text, style);
    expect(twice.text).toBe(once.text);
    expect(twice.ok).toBe(true);
  });
});

describe('authorshipForSend: whose words actually went out', () => {
  const draft = 'Hi Sarah, your lash lift is booked for Thursday at 2.30. See you then.';

  it('a draft sent untouched is the AI, whoever tapped send', () => {
    expect(authorshipForSend({ draft, sent: draft })).toBe(AUTHOR.AI);
  });

  it('a lightly edited draft is still the AI, because the sentence is still its sentence', () => {
    expect(authorshipForSend({ draft, sent: 'Hi Sarah, your lash lift is booked for Thursday at 2.30. see you then x' }))
      .toBe(AUTHOR.AI_EDITED);
  });

  it('a rewrite is hers', () => {
    expect(authorshipForSend({ draft, sent: 'hey sarah, all booked in for thursday xx' })).toBe(AUTHOR.HUMAN);
  });

  it('no draft offered means she typed it from scratch', () => {
    expect(authorshipForSend({ draft: null, sent: 'hey lovely xx' })).toBe(AUTHOR.HUMAN);
    expect(authorshipForSend({ draft: '   ', sent: 'hey lovely xx' })).toBe(AUTHOR.HUMAN);
  });
});

describe('looksAutomated: keeping machine copy out of the bootstrap', () => {
  it('spots a link, a placeholder and a PECR footer', () => {
    expect(looksAutomated('Book here: https://florrie.ai/book/ellindigo')).toBe(true);
    expect(looksAutomated('Hi {name}, your appointment is confirmed')).toBe(true);
    expect(looksAutomated('Offers from us. Reply STOP to opt out')).toBe(true);
  });

  it('spots a message no one thumbs between clients', () => {
    expect(looksAutomated(Array.from({ length: 70 }, () => 'word').join(' '))).toBe(true);
  });

  it('lets her real messages through', () => {
    expect(looksAutomated('hey sarah, all booked in for thursday xx')).toBe(false);
    expect(looksAutomated('no worries lovely, whenever suits xx')).toBe(false);
  });

  it('treats empty as automated, because an empty sample teaches nothing', () => {
    expect(looksAutomated('')).toBe(true);
    expect(looksAutomated(null)).toBe(true);
  });
});
