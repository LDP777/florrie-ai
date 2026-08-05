/**
 * THE ACTUAL BUG, held down.
 *
 * v1 learned Ellie's voice from every outbound message where ai_handled was
 * not true. ai_handled DEFAULTS to false and six insert sites never set it, so
 * the corpus was mostly Florrie's own drafts and canned template copy. A model
 * trained on its own output converges on its own output, which is why her
 * regulars could tell.
 *
 * These tests assert the corpus, not the prose. If a future change lets an
 * ai, ai_edited, template or system row back into the training set, one of
 * these fails.
 *
 * Supabase is stubbed, and so is the model call, so this stays a pure logic
 * test with no network.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state = {
  messages: [],
  messagesError: null,
  aiResponses: [],
  queued: [],
  clients: [],
  saved: null,
  saveError: null,
};

vi.mock('../../src/config.js', () => {
  const make = (table) => {
    const ctx = { table, cols: '', isUpdate: false, payload: null };
    const b = {
      select: (cols) => { ctx.cols = String(cols || ''); return b; },
      update: (p) => { ctx.isUpdate = true; ctx.payload = p; return b; },
      eq: () => b, in: () => b, not: () => b, order: () => b, limit: () => b,
      then: (resolve) => {
        if (ctx.table === 'beauticians' && ctx.isUpdate) {
          state.saved = ctx.payload;
          return resolve({ data: null, error: state.saveError });
        }
        if (ctx.table === 'messages' && ctx.cols.includes('authored_by')) {
          return resolve({ data: state.messagesError ? null : state.messages, error: state.messagesError });
        }
        if (ctx.table === 'messages') return resolve({ data: state.aiResponses, error: null });
        if (ctx.table === 'outbound_sends') return resolve({ data: state.queued, error: null });
        if (ctx.table === 'clients') return resolve({ data: state.clients, error: null });
        return resolve({ data: [], error: null });
      },
    };
    return b;
  };
  return { supabase: { from: make } };
});

// The never_say pass is the only model call left, and it must never be load
// bearing: the measured profile has to save whatever it returns.
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    constructor() {
      this.messages = { create: async () => ({ content: [{ text: '{"never_say":["pamper yourself"]}' }] }) };
    }
  },
}));

const { buildVoiceProfile } = await import('../../src/services/voice-profile.js');

let clock = 0;
const row = (over) => ({
  id: `m${clock}`,
  client_id: 'c1',
  direction: 'outbound',
  created_at: new Date(1_700_000_000_000 - (clock++ * 60_000)).toISOString(),
  authored_by: 'human',
  ...over,
});

// How Ellie writes.
const HERS = [
  'hey lovely, all booked in for thursday xx',
  'no worries at all hun, let me know what suits xx',
  'lash lift is 45 and takes about an hour xx',
  'aw thank you so much lovely xx',
  'so sorry im running 10 mins behind xx',
  'ive got a space next week if you fancy it xx',
  'course you can hun, ill move it over xx',
  'brow lam is 40 and lasts about 6 weeks xx',
  'keep them dry for 24 hours and no mascara xx',
  'ill pop you in the book for that xx',
];

// How Florrie writes. Longer, capitalised, full stops, no kiss. This is what
// v1 was learning from.
const FLORRIES = [
  'Hi there, thank you so much for getting in touch. A lash lift is £45 and takes around 45 minutes. Let me know if you would like me to book you in.',
  'Hello, thanks for your message. I have a few slots free next week. Would any of those work for you at all?',
  'Hi, thank you for letting me know. I will check my book and come straight back to you shortly.',
  'Hello, thanks so much for your lovely feedback. It is always a pleasure to see you.',
  'Hi there, brow lamination is £40 and lasts around six to eight weeks. Would you like me to pop you in?',
];

beforeEach(() => {
  clock = 0;
  state.messages = [];
  state.messagesError = null;
  state.aiResponses = [];
  state.queued = [];
  state.clients = [{ id: 'c1', first_name: 'Sarah' }];
  state.saved = null;
  state.saveError = null;
});

describe('the training corpus', () => {
  it('learns from her rows and ignores the AI, template and system rows sitting beside them', async () => {
    state.messages = [
      ...HERS.map(text => row({ content: text, authored_by: 'human' })),
      ...FLORRIES.map(text => row({ content: text, authored_by: 'ai' })),
      ...FLORRIES.map(text => row({ content: text, authored_by: 'ai_edited' })),
      row({ content: 'Hi Sarah, your appointment is confirmed for Thursday.', authored_by: 'template' }),
      row({ content: 'Your booking did not complete because the deposit was not paid.', authored_by: 'system' }),
      row({ content: 'how much is a lash lift?', direction: 'inbound', authored_by: 'client' }),
    ];

    const profile = await buildVoiceProfile('b1');

    expect(profile.provenance).toBe('human');
    expect(profile.sample_count).toBe(HERS.length);
    // Hers: a kiss, lower case, no full stops. Florrie's: none of those. If any
    // of Florrie's rows had leaked in, these would move.
    expect(profile.style.kiss.token).toBe('xx');
    expect(profile.style.kiss.rate).toBe(1);
    expect(profile.style.lowercase_start_rate).toBe(1);
    expect(profile.style.ends_full_stop_rate).toBe(0);
    expect(profile.style.length.median_words).toBeLessThan(15);
  });

  it('never puts a machine sentence in the few-shot examples', async () => {
    state.messages = [
      ...HERS.map(text => row({ content: text, authored_by: 'human' })),
      ...FLORRIES.map(text => row({ content: text, authored_by: 'ai' })),
    ];
    const profile = await buildVoiceProfile('b1');
    const all = profile.examples.map(e => e.text).join(' ');
    expect(all).not.toContain('thank you so much for getting in touch');
    expect(profile.examples.length).toBeGreaterThan(0);
  });

  it('masks the client name before storing an example, so one client never appears in another prompt', async () => {
    state.messages = HERS.map(text => row({ content: `hey Sarah, ${text}`, authored_by: 'human' }));
    const profile = await buildVoiceProfile('b1');
    expect(profile.examples.every(e => !/Sarah/i.test(e.text))).toBe(true);
    expect(profile.examples[0].text).toContain('{name}');
  });

  it('pairs each example with the message it answered, so retrieval can match the situation', async () => {
    state.messages = [
      row({ content: 'lash lift is 45 and takes about an hour xx', authored_by: 'human' }),
      row({ content: 'how much is a lash lift?', direction: 'inbound', authored_by: 'client' }),
      ...HERS.map(text => row({ content: text, authored_by: 'human' })),
    ];
    const profile = await buildVoiceProfile('b1');
    const priced = profile.examples.find(e => e.text.includes('45'));
    expect(priced.reply_to).toContain('how much is a lash lift');
  });
});

describe('the bootstrap for history nobody labelled', () => {
  it('uses unlabelled rows only when there are no labelled ones, and says so', async () => {
    state.messages = HERS.map(text => row({ content: text, authored_by: 'unknown' }));
    const profile = await buildVoiceProfile('b1');
    expect(profile.provenance).toBe('bootstrap');
    // Inferred, so it must never claim the confidence of a measured profile.
    expect(profile.style.confidence).toBe('low');
  });

  it('subtracts every message that matches a draft Florrie is on record as writing', async () => {
    state.messages = [
      ...HERS.map(text => row({ content: text, authored_by: 'unknown' })),
      ...FLORRIES.map(text => row({ content: text, authored_by: 'unknown' })),
    ];
    state.aiResponses = [{ ai_response: FLORRIES[0] }, { ai_response: FLORRIES[1] }];
    state.queued = [{ body: FLORRIES[2] }, { body: FLORRIES[3] }, { body: FLORRIES[4] }];

    const profile = await buildVoiceProfile('b1');
    expect(profile.sample_count).toBe(HERS.length);
    expect(profile.style.kiss.rate).toBe(1);
  });

  it('subtracts anything shaped like machine copy even when no draft is on record', async () => {
    state.messages = [
      ...HERS.map(text => row({ content: text, authored_by: 'unknown' })),
      row({ content: 'Book here: https://florrie.ai/book/ellindigo', authored_by: 'unknown' }),
      row({ content: 'Hi {name}, your appointment is confirmed', authored_by: 'unknown' }),
      row({ content: 'Special offer this month. Reply STOP to opt out.', authored_by: 'unknown' }),
    ];
    const profile = await buildVoiceProfile('b1');
    expect(profile.sample_count).toBe(HERS.length);
  });

  it('stops bootstrapping the moment there is enough of her real writing', async () => {
    state.messages = [
      ...HERS.map(text => row({ content: text, authored_by: 'human' })),
      ...FLORRIES.map(text => row({ content: text, authored_by: 'unknown' })),
    ];
    const profile = await buildVoiceProfile('b1');
    expect(profile.provenance).toBe('human');
    expect(profile.sample_count).toBe(HERS.length);
  });
});

describe('failing quietly is not allowed to look like success', () => {
  it('builds nothing at all from three messages, rather than a confident wrong voice', async () => {
    state.messages = HERS.slice(0, 3).map(text => row({ content: text, authored_by: 'human' }));
    expect(await buildVoiceProfile('b1')).toBe(null);
    expect(state.saved).toBe(null);
  });

  it('returns null when the authored_by column is not there yet, instead of an empty profile', async () => {
    state.messagesError = { code: '42703', message: 'column messages.authored_by does not exist' };
    expect(await buildVoiceProfile('b1')).toBe(null);
    expect(state.saved).toBe(null);
  });

  it('returns null when the save fails, so nobody reads a profile that was never stored', async () => {
    state.messages = HERS.map(text => row({ content: text, authored_by: 'human' }));
    state.saveError = { code: '42703', message: 'column beauticians.voice_profile does not exist' };
    expect(await buildVoiceProfile('b1')).toBe(null);
  });

  it('keeps the measured profile when the model pass returns nothing useful', async () => {
    state.messages = HERS.map(text => row({ content: text, authored_by: 'human' }));
    const profile = await buildVoiceProfile('b1');
    // v1 threw the entire profile away on an unparseable model response.
    expect(profile.style.kiss.token).toBe('xx');
    expect(Array.isArray(profile.never_say)).toBe(true);
  });
});
