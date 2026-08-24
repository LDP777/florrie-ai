/**
 * The pilot's name cannot travel to another salon's clients.
 *
 * Florrie has had one customer all year, so her name got typed into places
 * that are read by EVERY customer. Three of them, all shipping to other
 * salons in September:
 *
 *   1. the signature on every autonomous reply told the client to "Reply
 *      ELLIE", whoever her beautician actually was
 *   2. worse than cosmetic: the human-detection regex only knew that one
 *      name, so "can I speak to Priya" was not an ask for a human, the
 *      thread was never handed over, and Florrie carried on replying to
 *      somebody who had asked twice for a person
 *   3. the WhatsApp booking confirmation could be sent on the _v3 template,
 *      whose Meta-approved body has the pilot's SALON name written into it
 *
 * Each block below fails against the code as it was.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  asksForHuman,
  handoffWord,
  florrieSignature,
  signAsFlorrie,
  isGroundedReply,
  GENERIC_HANDOFF_WORD,
} from '../../src/lib/grounded-reply.js';
import {
  chooseTemplateVersion,
  bodyLeaksSalonName,
  isTenantSafeVersion,
  metaBodyFor,
  starterPack,
  TEMPLATE_SPECS,
} from '../../src/lib/whatsapp-templates.js';

const src = (rel) => readFileSync(fileURLToPath(new URL(`../../src/${rel}`, import.meta.url)), 'utf8');

describe('the signature belongs to the salon that sent it', () => {
  it('tells a client of another salon her own beautician\'s word', () => {
    const sig = florrieSignature('Priya');
    expect(sig).toBe("Florrie, Priya's assistant. Reply PRIYA if you'd rather speak to her.");
    expect(sig).not.toMatch(/ellie/i);
  });

  it('says something true when a fresh signup has no first name yet', () => {
    // first_name is NOT NULL but an empty string is what a half-finished
    // signup holds, and the old code turned that into the pilot's name.
    for (const empty of ['', '   ', null, undefined]) {
      const sig = florrieSignature(empty);
      expect(sig).toContain("Florrie, the salon's assistant.");
      expect(sig).toContain(`Reply ${GENERIC_HANDOFF_WORD}`);
      expect(sig).not.toMatch(/'s assistant\. Reply\s+\./);
      expect(sig).not.toMatch(/ellie/i);
    }
  });

  it('advertises a word the client can actually send back', () => {
    // The invariant that matters: whatever the signature shouts, sending
    // exactly that word gets you a person. Anything else and the escape
    // hatch is decoration.
    for (const name of ['Priya', 'Ellie', 'Zoë', 'Mary Jane', 'Anne-Marie', "O'Hara", 'Bartholomewina', '李', '', 'Stop']) {
      const word = florrieSignature(name).match(/Reply ([A-Z]+) /)[1];
      expect(asksForHuman(word, name), `${name} -> ${word}`).toBe(true);
      expect(asksForHuman(word.toLowerCase(), name), `${name} -> ${word}`).toBe(true);
    }
  });

  it('never puts a dash in the line, the house rule holds', () => {
    for (const name of ['Priya', 'Mary Jane', '']) {
      expect(florrieSignature(name)).not.toMatch(/[–—]/);
    }
  });
});

describe('the handoff word, for names that are not five friendly letters', () => {
  it.each([
    ['Priya', 'PRIYA'],
    ['ellie', 'ELLIE'],
    ['Zoë', 'ZOE'],                    // folds, and the fold works both ways below
    ['Mary Jane', 'MARY'],             // one word, not MARYJANE and not "MARY JANE"
    ['Anne-Marie', 'ANNEMARIE'],       // punctuation reads as a typo in caps
    ["O'Hara", 'OHARA'],
    ['  Jo  ', 'JO'],
    ['Bartholomewina', 'HUMAN'],       // 14 characters, mistyped every time
    ['李', 'HUMAN'],                    // nothing a Latin keyboard can produce
    ['Stop', 'HUMAN'],                 // the network already owns STOP
    ['Yes', 'HUMAN'],                  // and gap_fill_offer already owns YES
    ['', 'HUMAN'],
    [undefined, 'HUMAN'],
  ])('%j becomes %s', (name, word) => expect(handoffWord(name)).toBe(word));

  it('matches the accented spelling as well as the folded one', () => {
    expect(asksForHuman('zoë', 'Zoë')).toBe(true);
    expect(asksForHuman('ZOE', 'Zoë')).toBe(true);
  });

  it('takes HUMAN from anybody, whatever her signature advertised', () => {
    for (const name of ['Priya', 'Bartholomewina', '']) {
      expect(asksForHuman('HUMAN', name)).toBe(true);
      expect(asksForHuman('person', name)).toBe(true);
      expect(asksForHuman('can I talk to a real person', name)).toBe(true);
    }
  });
});

describe('asking for YOUR beautician by name is asking for a human', () => {
  it('recognises the name of the salon the message actually arrived at', () => {
    // The bug in one line: this returned false, so messaging_autonomy was
    // never flipped to just_me and Florrie kept answering.
    expect(asksForHuman('can I speak to Priya', 'Priya')).toBe(true);
    expect(asksForHuman('can I speak to Priya please?', 'Priya')).toBe(true);
    expect(asksForHuman('id rather chat with Mary Jane', 'Mary Jane')).toBe(true);
    expect(asksForHuman('talk to Mary', 'Mary Jane')).toBe(true);
    expect(asksForHuman('PRIYA', 'Priya')).toBe(true);
  });

  it('does not answer to another salon\'s owner', () => {
    // Priya's client typing the pilot's name is not asking for Priya.
    expect(asksForHuman('can I speak to Ellie', 'Priya')).toBe(false);
    expect(asksForHuman('ellie', 'Priya')).toBe(false);
  });

  it('still ignores her name used in passing', () => {
    expect(asksForHuman('thanks Priya see you Tuesday', 'Priya')).toBe(false);
    expect(asksForHuman('Priya did my brows last time', 'Priya')).toBe(false);
    expect(asksForHuman('are you free tomorrow', 'Priya')).toBe(false);
  });

  it('carries the name through the grounded check, which is where it acts', () => {
    const context = { clientUpcoming: [{ starts_at: '2026-08-24T18:00:00' }] };
    const v = isGroundedReply({
      intent: 'booking_lookup',
      message: 'can I speak to Priya about it',
      context,
      beauticianFirstName: 'Priya',
    });
    expect(v).toEqual({ grounded: false, reason: 'asked_for_a_human' });
  });

  it('holds a reply that promises HER, not just a pronoun', () => {
    const v = isGroundedReply({
      intent: 'booking_lookup',
      message: 'when am I in?',
      context: { clientUpcoming: [{ starts_at: '2026-08-24T18:00:00' }] },
      reply: "You're booked in. Priya will call you about the other thing.",
      beauticianFirstName: 'Priya',
    });
    expect(v.reason).toBe('reply_promises_a_human_action');
  });
});

describe('the already-signed guard still covers the historic form', () => {
  it('does not add a second signature to a stored message in the old style', () => {
    // Thousands of these are in the messages table, em dash and all. Quoting
    // one back through the signer must not sign it twice.
    const historic = "You're booked in Tuesday at 6pm.\n\n— Florrie, Ellie's assistant. Reply ELLIE if you'd rather speak to her.";
    expect(signAsFlorrie(historic, 'Ellie')).toBe(historic);
    // And it holds for a different tenant reading the same stored text.
    expect(signAsFlorrie(historic, 'Priya')).toBe(historic);
  });

  it('does not sign twice in the new style either', () => {
    const once = signAsFlorrie('Hello', 'Priya');
    expect(signAsFlorrie(once, 'Priya')).toBe(once);
    const unnamed = signAsFlorrie('Hello', '');
    expect(signAsFlorrie(unnamed, '')).toBe(unnamed);
  });

  it('is not fooled by a client thanking Florrie mid-sentence', () => {
    const out = signAsFlorrie('thanks Florrie, see you then', 'Priya');
    expect(out).toContain("Florrie, Priya's assistant");
  });
});

describe('the booking confirmation cannot go out signed with another salon', () => {
  const approved = (...names) => (n) => names.includes(n);

  it('never chooses _v3, whose approved body names the pilot salon', () => {
    // The live risk: a brand new salon submits the pack, _v4 sits in review
    // for hours, _v3 is already APPROVED on the shared WABA. This used to
    // return booking_confirmation_v3.
    for (const base of Object.keys(TEMPLATE_SPECS)) {
      expect(chooseTemplateVersion(`${base}_v2`, approved(`${base}_v3`))).toBe(`${base}_v2`);
      expect(chooseTemplateVersion(`${base}_v2`, () => true)).toBe(`${base}_v4`);
    }
  });

  it('still upgrades to _v4 as soon as Meta approves it', () => {
    expect(chooseTemplateVersion('booking_confirmation_v2', approved('booking_confirmation_v3', 'booking_confirmation_v4')))
      .toBe('booking_confirmation_v4');
  });

  it('falls back to the name-neutral _v2 the caller asked for', () => {
    expect(chooseTemplateVersion('booking_confirmation_v2', approved())).toBe('booking_confirmation_v2');
  });

  it('will not send a version that has no slot for the salon name', () => {
    for (const [base, spec] of Object.entries(TEMPLATE_SPECS)) {
      for (const version of Object.keys(spec.versions)) {
        const chosen = chooseTemplateVersion(`${base}_v2`, (n) => n === `${base}_${version}`);
        if (chosen !== `${base}_v2`) {
          expect(isTenantSafeVersion(base, version), `${base}_${version}`).toBe(true);
        }
      }
    }
  });
});

describe('a hardcoded salon name in a body fails here, not on a client phone', () => {
  it('spots the shapes the copy uses to name the sender', () => {
    expect(bodyLeaksSalonName("Hi {{1}}! It's Ellindigo 🌸 Your appointment is confirmed for {{2}} at {{3}}.")).toBe('Ellindigo');
    expect(bodyLeaksSalonName('Hi {{1}}, a reminder from Glow Bar Leeds about your {{2}}.')).toBe('Glow Bar Leeds');
    expect(bodyLeaksSalonName("Hi {{1}}, you're booked in with Priya Beauty on {{2}}.")).toBe('Priya Beauty');
  });

  it('leaves a body that takes the name as a parameter alone', () => {
    expect(bodyLeaksSalonName("Hi {{1}}! It's {{2}} 🌸 Confirmed for {{3}} at {{4}}. See you then!")).toBeNull();
    expect(bodyLeaksSalonName("Reply YES and it's yours, or tell me a time that suits.")).toBeNull();
  });

  it('holds for every body in the file, in every version', () => {
    for (const [base, spec] of Object.entries(TEMPLATE_SPECS)) {
      for (const version of Object.keys(spec.versions)) {
        const name = `${base}_${version}`;
        expect(bodyLeaksSalonName(metaBodyFor(name)), name).toBeNull();
      }
    }
  });

  it('refuses to submit a leaking body to Meta at all', () => {
    const spec = TEMPLATE_SPECS.booking_confirmation;
    const render = spec.render;
    spec.render = (f) => `Hi ${f.first_name}! It's Ellindigo, confirmed for ${f.date} at ${f.time}.`;
    try {
      expect(() => starterPack()).toThrow(/Ellindigo/);
    } finally {
      spec.render = render;
    }
  });
});

describe('the pilot\'s name cannot come back', () => {
  // A find and replace fixes this once. This stops it being undone.
  const OWNED = ['lib/grounded-reply.js', 'lib/whatsapp-templates.js', 'services/ai-front-desk.js'];

  /** Code only: the comments in these files are the record of what went wrong. */
  const codeOnly = (text) => text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:\\])\/\/[^\n]*/g, '$1');

  it.each(OWNED)('%s names no salon and no beautician in its code', (rel) => {
    const code = codeOnly(src(rel));
    expect(code, `${rel} still says Ellie in code`).not.toMatch(/\bellie\b/i);
    expect(code, `${rel} still says Ellindigo in code`).not.toMatch(/ellindigo/i);
  });

  it('checks the stripper actually leaves code behind', () => {
    // Otherwise the test above passes by deleting the whole file.
    for (const rel of OWNED) {
      const code = codeOnly(src(rel));
      expect(code).toMatch(/export function/);
      expect(code.length).toBeGreaterThan(500);
    }
  });
});
