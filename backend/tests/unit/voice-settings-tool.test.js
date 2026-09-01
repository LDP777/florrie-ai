/**
 * The settings tools, driven the way the voice route drives them.
 *
 * app-settings.test.js proves the registry. This proves the two tools on top
 * of it actually read her row, write the right patch, and say something she
 * can act on — including the cases where it must refuse.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const writes = [];
let failNext = false;

function makeBuilder(table) {
  let pending = null;
  const b = {
    select() { return b; },
    update(p) { pending = p; return b; },
    insert() { return b; },
    eq() {
      if (pending) {
        if (failNext) { failNext = false; return Promise.resolve({ data: null, error: { message: 'boom' } }); }
        writes.push({ table, patch: pending });
        return Promise.resolve({ data: [{}], error: null });
      }
      return b;
    },
    order() { return b; }, limit() { return b; }, in() { return b; }, gte() { return b; }, lte() { return b; },
    maybeSingle() { return Promise.resolve({ data: null, error: null }); },
    single() { return Promise.resolve({ data: null, error: null }); },
    then(res) { return Promise.resolve({ data: [], error: null }).then(res); },
  };
  return b;
}

const supabase = { from: (t) => makeBuilder(t) };

vi.mock('../../src/config.js', () => ({ supabase, supabaseAdmin: supabase }));
vi.mock('../../src/lib/logger.js', () => ({ default: { info() {}, warn() {}, error() {}, debug() {} } }));
vi.mock('@sentry/node', () => ({ captureMessage: () => {}, captureException: () => {} }));

const { executeTool, TOOL_DEFINITIONS } = await import('../../src/services/voice-tools.js');

const ellie = () => ({
  id: 'b1',
  first_name: 'Ellie',
  auto_reply_enabled: true,
  autonomy: { promos_in_offers: true, known_client_min_visits: 2 },
  client_reminder_prefs: { channel: 'whatsapp', paused: false },
});

beforeEach(() => { writes.length = 0; failNext = false; });

describe('the tools are offered to the model', () => {
  it('both are in the definitions', () => {
    const names = TOOL_DEFINITIONS.map(t => t.name);
    expect(names).toContain('get_settings');
    expect(names).toContain('change_setting');
  });

  it('change_setting carries the whole catalogue in its description', () => {
    const t = TOOL_DEFINITIONS.find(x => x.name === 'change_setting');
    // Generated from the registry, so a new setting needs no prompt edit.
    expect(t.description).toContain('florrie_answers_easy_ones');
    expect(t.description).toContain('pause_all_messages');
    expect(t.description).toContain('stop answering my clients yourself');
  });
});

describe('reading it back', () => {
  it('answers in labels, not column names', async () => {
    const out = await executeTool('get_settings', {}, ellie(), supabase);
    expect(out.result).toContain('Let Florrie answer the easy ones: on');
    expect(out.result).toContain('Pause Florrie replying to clients: off');
    expect(out.result).not.toContain('grounded_replies');
  });

  it('answers about one setting when asked about one', async () => {
    const out = await executeTool('get_settings', { setting_id: 'message_channel' }, ellie(), supabase);
    expect(out.result).toBe('How Florrie messages clients: whatsapp');
  });

  it('says so when there is no such setting', async () => {
    const out = await executeTool('get_settings', { setting_id: 'nope' }, ellie(), supabase);
    expect(out.result).toContain('do not have a setting');
  });
});

describe('changing it', () => {
  it('writes the merged jsonb, keeping her other keys', async () => {
    const b = ellie();
    const out = await executeTool('change_setting', { setting_id: 'florrie_answers_easy_ones', value: false }, b, supabase);

    expect(writes).toHaveLength(1);
    expect(writes[0].table).toBe('beauticians');
    expect(writes[0].patch.autonomy).toEqual({
      promos_in_offers: true,
      known_client_min_visits: 2,
      grounded_replies: false,
    });
    expect(out.result).toBe('Every message will come to you first, like before.');
  });

  it('updates the in-memory record so a follow-up in the same breath is right', async () => {
    const b = ellie();
    await executeTool('change_setting', { setting_id: 'pause_all_messages', value: true }, b, supabase);
    const after = await executeTool('get_settings', { setting_id: 'pause_all_messages' }, b, supabase);
    expect(after.result).toBe('Pause Florrie replying to clients: on');
  });

  it('does nothing when it is already that way', async () => {
    const out = await executeTool('change_setting', { setting_id: 'promos_in_offers', value: true }, ellie(), supabase);
    expect(writes).toHaveLength(0);
    expect(out.result).toContain('already on');
  });

  it('refuses a value the setting cannot take, and writes nothing', async () => {
    const out = await executeTool('change_setting', { setting_id: 'message_channel', value: 'carrier pigeon' }, ellie(), supabase);
    expect(writes).toHaveLength(0);
    expect(out.result).toContain('whatsapp or sms');
  });

  it('refuses an unknown setting rather than inventing a column', async () => {
    const out = await executeTool('change_setting', { setting_id: 'delete_everything', value: true }, ellie(), supabase);
    expect(writes).toHaveLength(0);
    expect(out.result).toContain('do not have a setting');
  });

  it('says it could not save when the write fails, rather than claiming success', async () => {
    failNext = true;
    const out = await executeTool('change_setting', { setting_id: 'auto_reply', value: false }, ellie(), supabase);
    expect(out.result).toContain('could not save');
    expect(out.result).not.toMatch(/will answer|enquiries will wait/i);
  });

  it('coerces "off" from a model that answered in words', async () => {
    const out = await executeTool('change_setting', { setting_id: 'auto_reply', value: 'off' }, ellie(), supabase);
    expect(writes[0].patch).toEqual({ auto_reply_enabled: false });
    expect(out.result).toBe('New enquiries will wait for you.');
  });
});
