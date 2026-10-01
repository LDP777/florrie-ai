import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({ messages: [], selects: [] }));
function from(table) {
  const filters = [];
  const query = {
    select(spec) { fixture.selects.push({ table, spec }); return query; },
    eq(key, value) { filters.push(row => row[key] === value); return query; },
    in(key, values) { filters.push(row => values.includes(row[key])); return query; },
    gte() { return query; }, lte() { return query; }, gt() { return query; },
    not() { return query; }, order() { return query; }, limit() { return query; },
    abortSignal() { return query; },
    then(resolve, reject) {
      const rows = table === 'messages' ? fixture.messages : [];
      return Promise.resolve({ data: rows.filter(row => filters.every(filter => filter(row))), error: null }).then(resolve, reject);
    },
  };
  return query;
}
vi.mock('../../src/config.js', () => ({ supabase: { from } }));
vi.mock('../../src/services/gap-fill-engine.js', () => ({ getGapFillSuggestions: async () => [] }));
vi.mock('../../src/routes/appointments.js', () => ({ clientNeedsPatchTest: async () => false }));

const { getFlorrieThoughts } = await import('../../src/services/florrie-thinking.js');
const owner = { id: 'fictional-story-salon', timezone: 'Europe/London' };

beforeEach(() => {
  fixture.selects = [];
  getFlorrieThoughts.invalidate(owner.id);
  fixture.messages = [{
    id: 'story-follow-up', beautician_id: owner.id, client_id: 'fictional-lead',
    content: 'Can I book that xx', ai_intent: 'general_question', ai_response: null,
    channel: 'instagram', escalated: true, escalated_reason: 'story_context:unavailable', resolved: false,
    created_at: new Date().toISOString(), clients: { id: 'fictional-lead', first_name: 'Nora' },
  }];
});

describe('Florrie thinks shows what work actually exists', () => {
  it.each([null, undefined, '', '   '])('asks for a reply when the held story question has no usable draft (%s)', async draft => {
    fixture.messages[0].ai_response = draft;
    const result = await getFlorrieThoughts(owner);
    expect(result.partial).toBe(false);
    expect(result.cards).toHaveLength(1);
    expect(result.cards[0]).toMatchObject({ type: 'lead', link_to: '/inbox?client=fictional-lead' });
    expect(result.cards[0].summary).toMatch(/Needs your reply\.$/);
    expect(result.cards[0].summary).not.toContain('Reply ready');
    expect(fixture.selects.find(row => row.table === 'messages').spec).toContain('ai_response');
  });

  it('offers review only when a saved nonblank reply exists', async () => {
    fixture.messages[0].ai_response = 'Could you tell me which treatment you mean?';
    const { cards } = await getFlorrieThoughts(owner);
    expect(cards[0].summary).toMatch(/Reply ready for your OK\.$/);
  });
});
