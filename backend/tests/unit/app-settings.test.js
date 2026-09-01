/**
 * Ellie changing how the app behaves by talking to it.
 *
 * The switch that decides whether Florrie answers her clients herself lives
 * four taps deep in Settings, under a heading nobody would think to open
 * mid-shift. Her whole complaint was that the app costs her attention, so
 * making her hunt for the control that fixes that is the joke writing itself.
 * She should be able to say "stop answering my clients yourself" and have it
 * be done.
 *
 * Two things this file is really about.
 *
 * MERGING. A json setting lives inside a jsonb column with her other keys in
 * it. Writing `{ autonomy: { grounded_replies: false } }` would silently drop
 * promos_in_offers and known_client_min_visits — a data loss she would only
 * notice weeks later when a gap offer stopped carrying her promo code.
 *
 * MISHEARING. "don't pause my messages" and "pause my messages" are one
 * dropped word apart, and one of them stops every reminder she sends. Nothing
 * here may fire on speech alone; it goes to a confirm card, and the card has to
 * read as the thing it does rather than as an id.
 */
import { describe, it, expect } from 'vitest';
import {
  SETTINGS, byId, readSetting, coerceValue, describeValue, renderCatalogue, buildUpdate,
} from '../../src/lib/app-settings.js';
import { CONFIRM_REQUIRED } from '../../src/services/voice-orchestrator.js';

const ELLIE = {
  id: 'b1',
  first_name: 'Ellie',
  auto_reply_enabled: true,
  autonomy: { promos_in_offers: true, known_client_min_visits: 2 },
  client_reminder_prefs: { channel: 'whatsapp', paused: false },
};

describe('reading how she is set up', () => {
  it('reads a value out of a jsonb column', () => {
    expect(readSetting(byId('promos_in_offers'), ELLIE)).toBe(true);
    expect(readSetting(byId('known_client_min_visits'), ELLIE)).toBe(2);
  });

  it('reads a plain column', () => {
    expect(readSetting(byId('auto_reply'), ELLIE)).toBe(true);
  });

  it('falls back to the documented default when the key was never written', () => {
    // grounded_replies has never been set on this row, and its default is ON —
    // which is the whole point of the change, so it must not read as off.
    expect(readSetting(byId('florrie_answers_easy_ones'), ELLIE)).toBe(true);
  });

  it('treats an explicit false as false, not as missing', () => {
    const off = { ...ELLIE, autonomy: { ...ELLIE.autonomy, grounded_replies: false } };
    expect(readSetting(byId('florrie_answers_easy_ones'), off)).toBe(false);
  });
});

describe('writing one key does not wipe the others', () => {
  it('merges into the existing jsonb rather than replacing it', () => {
    const patch = buildUpdate(byId('florrie_answers_easy_ones'), false, ELLIE);
    expect(patch).toEqual({
      autonomy: {
        promos_in_offers: true,        // still here
        known_client_min_visits: 2,    // still here
        grounded_replies: false,
      },
    });
  });

  it('merges the reminder prefs the same way', () => {
    const patch = buildUpdate(byId('pause_all_messages'), true, ELLIE);
    expect(patch.client_reminder_prefs).toEqual({ channel: 'whatsapp', paused: true });
  });

  it('copes with a row that has no json object at all yet', () => {
    const fresh = { id: 'b2' };
    expect(buildUpdate(byId('promos_in_offers'), true, fresh)).toEqual({ autonomy: { promos_in_offers: true } });
  });

  it('writes a plain column plainly', () => {
    expect(buildUpdate(byId('auto_reply'), false, ELLIE)).toEqual({ auto_reply_enabled: false });
  });
});

describe('what the model produced becomes what the column takes', () => {
  const flag = byId('florrie_answers_easy_ones');

  it.each([[true, true], ['true', true], ['on', true], ['yes', true],
           [false, false], ['false', false], ['off', false], ['no', false]])(
    'coerces %j to %j', (input, want) => {
      expect(coerceValue(flag, input)).toEqual({ ok: true, value: want });
    });

  it('refuses something that is neither', () => {
    const v = coerceValue(flag, 'maybe');
    expect(v.ok).toBe(false);
    expect(v.why).toContain('on or off');
  });

  it('holds an enum to its list', () => {
    expect(coerceValue(byId('message_channel'), 'SMS')).toEqual({ ok: true, value: 'sms' });
    expect(coerceValue(byId('message_channel'), 'carrier pigeon').ok).toBe(false);
  });

  it('holds a number to its range', () => {
    const n = byId('known_client_min_visits');
    expect(coerceValue(n, '3')).toEqual({ ok: true, value: 3 });
    expect(coerceValue(n, 0).ok).toBe(false);
    expect(coerceValue(n, 9).ok).toBe(false);
    expect(coerceValue(n, 'lots').ok).toBe(false);
  });
});

describe('it says back what it did, in her words', () => {
  it('describes a flag by what changes, not by true/false', () => {
    const s = byId('florrie_answers_easy_ones');
    expect(describeValue(s, true)).toBe('Florrie will answer the easy ones herself.');
    expect(describeValue(s, false)).toBe('Every message will come to you first, like before.');
  });

  it('offers no way to turn a client\'s booking confirmation off at all', () => {
    // REPLACED 1 September 2026. This used to check that switching confirmation
    // emails off warned her she was losing the calendar invite. The better
    // answer, and the owner's instruction on the day, is not to offer the
    // switch: confirmations, the 24h reminder and the calendar link always
    // send. A warning still leaves a way to break a client's booking details
    // by accident, and Ellie had just done exactly that by accident with a
    // different switch.
    expect(byId('confirmation_emails')).toBeFalsy();
    expect(byId('booking_confirmations')).toBeFalsy();
  });

  it('pluralises the visit count', () => {
    const s = byId('known_client_min_visits');
    expect(describeValue(s, 1)).toContain('1 visit.');
    expect(describeValue(s, 2)).toContain('2 visits.');
  });
});

describe('the catalogue the model reads', () => {
  it('names every setting, its type and how she might say it', () => {
    const cat = renderCatalogue();
    for (const s of SETTINGS) {
      expect(cat).toContain(s.id);
      expect(cat).toContain(s.label);
    }
    expect(cat).toContain('on or off');
    expect(cat).toContain('one of whatsapp/sms');
  });

  it('gives the model her actual phrasing, not the column names', () => {
    expect(renderCatalogue()).toContain('stop answering my clients yourself');
  });
});

describe('nothing changes on speech alone', () => {
  it('holds change_setting for the confirm card', () => {
    // The card is the only thing between a misheard word and Florrie going
    // silent on every client.
    expect(CONFIRM_REQUIRED.has('change_setting')).toBe(true);
  });

  it('lets reading settings answer instantly', () => {
    expect(CONFIRM_REQUIRED.has('get_settings')).toBe(false);
  });
});

describe('the registry itself stays coherent', () => {
  it('has no duplicate ids', () => {
    const ids = SETTINGS.map(s => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every setting somewhere to live and something to say', () => {
    for (const s of SETTINGS) {
      expect(s.where.column || s.where.json, `${s.id} has no home`).toBeTruthy();
      if (s.where.json) expect(s.where.key, `${s.id} has no key`).toBeTruthy();
      expect(s.means, `${s.id} has no plain-English meaning`).toBeTruthy();
      expect(s.says.length, `${s.id} has no phrasings`).toBeGreaterThan(0);
      // Every setting must be able to describe its own new value, or the
      // confirmation says nothing useful.
      const sample = s.type === 'boolean' ? true : s.type === 'number' ? s.min : s.values[0];
      expect(describeValue(s, sample), `${s.id} cannot describe itself`).toBeTruthy();
    }
  });

  it('defaults grounded replies ON, which is the change Levi asked for', () => {
    expect(byId('florrie_answers_easy_ones').default).toBe(true);
  });
});
