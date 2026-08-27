import { describe, it, expect } from 'vitest';
import {
  TEMPLATE_SPECS,
  splitTemplateName,
  paramFieldsFor,
  fieldsFromParams,
  paramsFor,
  fieldsWithoutSlots,
  adaptParams,
  chooseTemplateVersion,
  renderTemplateBody,
  metaBodyFor,
  exampleValuesFor,
  starterPack,
  starterPackNames,
} from '../../src/lib/whatsapp-templates.js';

// Every beautician sits on ONE shared WABA, so template names are global.
// The old _v3 pack wrote the salon name into the body, which meant customer
// two sent confirmations signed with customer one's business name. _v4 passes
// the name as a parameter instead. These pin the two things that make that
// safe: the parameter ORDER per template, and the version fallback while _v4
// is still in Meta review.

describe('template names', () => {
  it('splits a name into base and version', () => {
    expect(splitTemplateName('booking_confirmation_v4')).toEqual({ base: 'booking_confirmation', version: 'v4' });
    expect(splitTemplateName('reminder_24h_v2')).toEqual({ base: 'reminder_24h', version: 'v2' });
    expect(splitTemplateName('hello_world')).toEqual({ base: 'hello_world', version: null });
  });
});

describe('parameter order', () => {
  it('puts the salon name second in every v4 template', () => {
    for (const [base, spec] of Object.entries(TEMPLATE_SPECS)) {
      expect(spec.versions.v4[1], `${base} v4`).toBe('business_name');
    }
  });

  it('builds the exact array each template expects, given a client and an appointment', () => {
    const fields = {
      first_name: 'Sarah',
      business_name: 'Ellindigo',
      date: 'Friday 6 June',
      time: '2pm',
      treatment: 'Korean lash lift',
      day: 'Monday',
      message: 'Your patch test is booked in.',
    };
    expect(paramsFor('booking_confirmation_v4', fields)).toEqual(['Sarah', 'Ellindigo', 'Friday 6 June', '2pm']);
    expect(paramsFor('reminder_24h_v4', fields)).toEqual(['Sarah', 'Ellindigo', 'Korean lash lift', '2pm']);
    expect(paramsFor('gap_fill_offer_v4', fields)).toEqual(['Sarah', 'Ellindigo', 'Monday', '2pm']);
    expect(paramsFor('rebook_nudge_v4', fields)).toEqual(['Sarah', 'Ellindigo']);
    expect(paramsFor('generic_message_v4', fields)).toEqual(['Sarah', 'Ellindigo', 'Your patch test is booked in.']);
  });

  it('keeps the older shapes untouched, they have no salon slot', () => {
    const fields = { first_name: 'Sarah', business_name: 'Ellindigo', date: 'Friday', time: '2pm' };
    expect(paramsFor('booking_confirmation_v2', fields)).toEqual(['Sarah', 'Friday', '2pm']);
    expect(paramsFor('booking_confirmation_v3', fields)).toEqual(['Sarah', 'Friday', '2pm']);
  });

  it('gives every param slot a length that matches the body placeholders', () => {
    for (const name of starterPackNames()) {
      const body = metaBodyFor(name);
      const highest = Math.max(...[...body.matchAll(/\{\{(\d+)\}\}/g)].map((m) => Number(m[1])));
      expect(highest, name).toBe(paramFieldsFor(name).length);
      expect(exampleValuesFor(name).length, name).toBe(paramFieldsFor(name).length);
    }
  });
});

/* ================================================= the registry, self-checked =
 * THE BUG THIS BLOCK EXISTS TO CATCH, 27 August 2026.
 *
 * `versions` is a claim about Meta's servers: "the approved body under this
 * name has exactly these slots". Two of the five claims were false and had
 * been for as long as they existed. reminder_24h_v2 claimed three parameters
 * against a two-slot body, so every WhatsApp reminder was rejected for
 * parameter count and no client was ever reminded. generic_message_v2 claimed
 * two against one, so no booking link ever arrived. Meta answers a mismatched
 * count with a refusal, which produces no bounce and no complaint, so the
 * failure is indistinguishable from silence.
 *
 * lib/health.js `template_params` catches that against the LIVE WABA, which is
 * the only place the truth lives. This block catches the repo-level half of
 * it, on every template and every version, before anything is submitted:
 * whatever the renderer produces must be numbered 1..n with no gaps and no
 * repeats, and n must be exactly what `versions` declares. A future _v5 whose
 * copy and slot list drift apart fails here rather than in production.
 */
describe('every declared version describes its own body', () => {
  const everyVersion = Object.entries(TEMPLATE_SPECS)
    .flatMap(([base, spec]) => Object.keys(spec.versions).map((v) => `${base}_${v}`));

  it('covers every template and every version, so nothing can be added unwatched', () => {
    expect(everyVersion.length).toBe(15);
    expect(everyVersion).toContain('generic_message_v2');
    expect(everyVersion).toContain('reminder_24h_v4');
  });

  for (const name of everyVersion) {
    it(`${name} has exactly as many placeholders as it declares fields`, () => {
      const fields = paramFieldsFor(name);
      const body = metaBodyFor(name);
      expect(body, `${name} renders no body`).toBeTruthy();

      const numbers = [...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
      const distinct = [...new Set(numbers)].sort((a, b) => a - b);

      // As many distinct {{n}} as fields, and numbered 1..n with no gaps. A
      // gap is the same fault as a miscount: Meta reads the highest index it
      // finds and refuses anything that does not line up with it.
      expect(distinct.length, `${name} distinct placeholders`).toBe(fields.length);
      expect(distinct, `${name} numbering`).toEqual(fields.map((_, i) => i + 1));

      // And each one appears once. Meta substitutes positionally; a repeated
      // {{2}} means one value is read twice and one is never read at all.
      expect(numbers.length, `${name} repeats a placeholder`).toBe(distinct.length);
    });
  }

  it('leaves nothing undefined in a body when a version has fewer slots', () => {
    // The shared renderer names a treatment and a salon. v2 carries neither as
    // a parameter, so without FIELD_LITERALS the reminder body read "your is
    // tomorrow at {{2}}" the moment v2 was corrected to its real two slots.
    for (const name of everyVersion) {
      expect(metaBodyFor(name), name).not.toMatch(/undefined/);
      expect(metaBodyFor(name), name).not.toMatch(/ {2,}/);
    }
  });

  it('knows which named values a version simply cannot carry', () => {
    // The whole reason a caller can refuse rather than truncate.
    expect(fieldsWithoutSlots('generic_message_v2', { first_name: 'Sarah', message: 'here is your link' }))
      .toEqual(['message']);
    expect(fieldsWithoutSlots('generic_message_v4', { first_name: 'Sarah', message: 'here is your link' }))
      .toEqual([]);
    // A blank value was never going to be read, so it is not a loss.
    expect(fieldsWithoutSlots('generic_message_v2', { first_name: 'Sarah', message: '  ' })).toEqual([]);
    // Not one of ours: nothing to judge, and guessing would be worse.
    expect(fieldsWithoutSlots('her_own_template', { anything: 'x' })).toBeNull();
  });
});

describe('the shapes Meta actually has', () => {
  // Read off the live WABA (1458055882486306) on 27 August 2026. If one of
  // these ever needs changing, the body on Meta changed, and every send site
  // that builds params for it has to change in the same commit.
  it('reminder_24h_v2 takes the client name and the time, and nothing else', () => {
    expect(paramFieldsFor('reminder_24h_v2')).toEqual(['first_name', 'time']);
  });

  it('generic_message_v2 takes the client name only, so it can never carry a link', () => {
    expect(paramFieldsFor('generic_message_v2')).toEqual(['first_name']);
  });

  it('leaves the three that were already right alone', () => {
    expect(paramFieldsFor('booking_confirmation_v2')).toEqual(['first_name', 'date', 'time']);
    expect(paramFieldsFor('gap_fill_offer_v2')).toEqual(['first_name', 'day', 'time']);
    expect(paramFieldsFor('rebook_nudge_v2')).toEqual(['first_name']);
  });

  it('names the params back from a positional array', () => {
    // Two, not three. reminder_24h_v2's approved body is "Hi {{1}}, just a
    // reminder that your appointment is tomorrow at {{2}}." and has never had
    // a treatment slot. This test used to pin the three-slot belief that made
    // every WhatsApp reminder a send Meta refused.
    expect(fieldsFromParams('reminder_24h_v2', ['Sarah', '12:20'])).toEqual({
      first_name: 'Sarah', time: '12:20',
    });
    expect(fieldsFromParams('reminder_24h_v4', ['Sarah', 'Ellindigo', 'Lash lift', '12:20'])).toEqual({
      first_name: 'Sarah', business_name: 'Ellindigo', treatment: 'Lash lift', time: '12:20',
    });
    expect(fieldsFromParams('hello_world', ['Sarah'])).toEqual({});
  });
});

describe('adapting params across versions', () => {
  it('inserts the salon name when upgrading v2 to v4', () => {
    expect(adaptParams({
      requestedName: 'booking_confirmation_v2',
      sendAsName: 'booking_confirmation_v4',
      params: ['Sarah', 'Friday 6 June', '2pm'],
      businessName: 'Ellindigo',
    })).toEqual(['Sarah', 'Ellindigo', 'Friday 6 June', '2pm']);
  });

  it('leaves the salon name out when staying on v3', () => {
    expect(adaptParams({
      requestedName: 'gap_fill_offer_v2',
      sendAsName: 'gap_fill_offer_v3',
      params: ['Sarah', 'Monday', '12:20'],
      businessName: 'Ellindigo',
    })).toEqual(['Sarah', 'Monday', '12:20']);
  });

  it('drops params the target template has no slot for', () => {
    // The rebook invite has ONE slot. A caller passing a suggested time as a
    // second param used to make Meta reject the send for parameter count.
    expect(adaptParams({
      requestedName: 'rebook_nudge_v2',
      sendAsName: 'rebook_nudge_v4',
      params: ['Sarah', 'Tuesday at 2pm'],
      businessName: 'Ellindigo',
    })).toEqual(['Sarah', 'Ellindigo']);
  });

  it('refuses to guess for templates it does not know', () => {
    expect(adaptParams({
      requestedName: 'her_own_template',
      sendAsName: 'her_own_template',
      params: ['Sarah'],
      businessName: 'Ellindigo',
    })).toBeNull();
    expect(adaptParams({
      requestedName: 'booking_confirmation_v2',
      sendAsName: 'booking_confirmation_v4',
      params: undefined,
      businessName: 'Ellindigo',
    })).toBeNull();
  });
});

describe('choosing a version to send', () => {
  const approved = (...names) => (n) => names.includes(n);

  it('prefers the shared v4 when Meta has approved it', () => {
    expect(chooseTemplateVersion('booking_confirmation_v2', approved('booking_confirmation_v3', 'booking_confirmation_v4')))
      .toBe('booking_confirmation_v4');
  });

  it('stays on v2 while v4 is in review, rather than dropping to v3', () => {
    // This is the second customer's path on her first day: _v3 is APPROVED
    // on the shared WABA because the pilot submitted it, and its body has
    // the PILOT's salon name typed into it. Upgrading to it sent her client
    // a confirmation signed with another salon. _v2 is the plain original
    // and names nobody, so that is where an un-upgraded send belongs.
    expect(chooseTemplateVersion('booking_confirmation_v2', approved('booking_confirmation_v3')))
      .toBe('booking_confirmation_v2');
  });

  it('falls back to the requested name when nothing else is approved', () => {
    expect(chooseTemplateVersion('booking_confirmation_v2', approved()))
      .toBe('booking_confirmation_v2');
  });

  it('never upgrades a template it does not own', () => {
    expect(chooseTemplateVersion('her_own_template_v2', () => true)).toBe('her_own_template_v2');
    expect(chooseTemplateVersion('hello_world', () => true)).toBe('hello_world');
  });

  it('honours an explicit version request as-is', () => {
    expect(chooseTemplateVersion('booking_confirmation_v3', () => true)).toBe('booking_confirmation_v3');
  });

  it('picks a version and its params together, so the two can never disagree', () => {
    const requested = 'booking_confirmation_v2';
    const params = ['Sarah', 'Friday 6 June', '2pm'];
    for (const isAvailable of [approved(), approved('booking_confirmation_v3'), approved('booking_confirmation_v4')]) {
      const sendAs = chooseTemplateVersion(requested, isAvailable);
      const adapted = sendAs === requested
        ? params
        : adaptParams({ requestedName: requested, sendAsName: sendAs, params, businessName: 'Ellindigo' });
      expect(adapted.length, sendAs).toBe(paramFieldsFor(sendAs).length);
    }
  });
});

describe('bodies', () => {
  it('generates the Meta body from the same renderer clients read', () => {
    expect(metaBodyFor('booking_confirmation_v4'))
      .toBe("Hi {{1}}! It's {{2}} 🌸 Your appointment is confirmed for {{3}} at {{4}}. Reply here if anything needs changing. See you then!");
    expect(renderTemplateBody('booking_confirmation_v4', {
      first_name: 'Sarah', business_name: 'Ellindigo', date: 'Friday 6 June', time: '2pm',
    })).toBe("Hi Sarah! It's Ellindigo 🌸 Your appointment is confirmed for Friday 6 June at 2pm. Reply here if anything needs changing. See you then!");
  });

  it('names no salon in any body or example, they are shared by everyone', () => {
    for (const tpl of starterPack()) {
      expect(tpl.body).not.toMatch(/Ellindigo/i);
      expect(tpl.body.replace(/\{\{\d+\}\}/g, '')).not.toMatch(/salon/i);
      for (const ex of tpl.examples) expect(ex).not.toMatch(/Ellindigo/i);
    }
  });

  it('reads sensibly for the older versions too, the name comes from the record', () => {
    expect(renderTemplateBody('reminder_24h_v2', {
      first_name: 'Sarah', business_name: 'Ellindigo', treatment: 'Lash lift', time: '12:20',
    })).toBe("Hi Sarah, it's Ellindigo! A little reminder that your Lash lift is tomorrow at 12:20. Reply if you need to reschedule. See you soon 🌸");
  });

  it('says something neutral rather than blank when no salon name is on file', () => {
    expect(renderTemplateBody('rebook_nudge_v2', { first_name: 'Sarah' })).toContain("it's your salon");
  });

  it('has no em dashes or en dashes in client-facing copy', () => {
    for (const tpl of starterPack()) expect(tpl.body).not.toMatch(/[\u2013\u2014]/);
  });
});

describe('starter pack', () => {
  it('ships the five shared v4 templates', () => {
    expect(starterPackNames()).toEqual([
      'booking_confirmation_v4',
      'reminder_24h_v4',
      'gap_fill_offer_v4',
      'rebook_nudge_v4',
      'generic_message_v4',
    ]);
  });

  it('keeps the marketing templates marketing, so the PECR guard still catches them', () => {
    const cats = Object.fromEntries(starterPack().map((t) => [t.name, t.category]));
    expect(cats.booking_confirmation_v4).toBe('UTILITY');
    expect(cats.reminder_24h_v4).toBe('UTILITY');
    expect(cats.gap_fill_offer_v4).toBe('MARKETING');
    expect(cats.rebook_nudge_v4).toBe('MARKETING');
    expect(cats.generic_message_v4).toBe('MARKETING');
  });
});
