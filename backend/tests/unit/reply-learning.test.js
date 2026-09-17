import { describe, it, expect, vi, beforeEach } from 'vitest';
const state = vi.hoisted(() => ({ rows: {}, model: vi.fn(), calls: [] }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: state.model }; } }));
vi.mock('../../src/config.js', () => ({ supabase: { from(table) {
  let filters = [], mode = '', values, single = false, count = 100;
  const q = {
    select: () => q, order: () => q, limit: n => { count = n; return q; },
    eq: (k,v) => { filters.push(row => row[k] === v); return q; },
    lte: (k,v) => { filters.push(row => row[k] <= v); return q; },
    upsert: v => { mode = 'upsert'; values = v; return q; },
    update: v => { mode = 'update'; values = v; return q; },
    maybeSingle: () => { single = true; return q; },
    then: resolve => {
      state.calls.push({ table, mode });
      const rows = state.rows[table] ||= [];
      let found = rows.filter(row => filters.every(f => f(row))).slice(0,count);
      if (mode === 'upsert') {
        const exists = rows.find(row => row.beautician_id === values.beautician_id && row.source_message_id === values.source_message_id);
        found = exists ? [] : [{ ...values, id: 'suggestion', status: 'processing', updated_at: new Date().toISOString() }]; rows.push(...found);
      }
      if (mode === 'update') found.forEach(row => Object.assign(row, values));
      resolve({ data: single ? found[0] || null : found.map(row => ({...row})), error: null });
    },
  }; return q;
} } }));
const { extractReplyLesson, eligibleReply, learnReply } = await import('../../src/services/reply-learning.js');
const ID = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const rule = 'Gift vouchers remain valid for twelve months from purchase.';
const modelAnswer = evidence => ({ content: [{ text: JSON.stringify({ reusable: true, category: 'faq', title: 'How long do vouchers last?', evidence }) }] });
beforeEach(() => { state.rows = {}; state.calls = []; state.model.mockReset(); });

it('extracts an exact complete owner rule, preserving its qualifications', async () => {
  const evidence = `${rule} They cannot be exchanged for cash.`;
  const askModel = vi.fn().mockResolvedValue(modelAnswer(evidence));
  expect(await extractReplyLesson({ reply: `Hi lovely. ${evidence}`, askModel })).toMatchObject({ content: evidence, evidence });
  expect(askModel.mock.calls[0][0].messages[0].content).toContain('owner_reply');
});
it.each([
 ['Just for you, gift vouchers remain valid for twelve months.', 'gift vouchers remain valid for twelve months.'],
 [rule, 'Gift vouchers remain valid forever.'],
 ['Contact me on alex@example.com for a gift voucher.', 'Contact me on alex@example.com for a gift voucher.'],
 ['Your appointment is confirmed for Monday at 14:30.', 'Your appointment is confirmed for Monday at 14:30.'],
 ['Sam can use these vouchers for twelve months.', 'Sam can use these vouchers for twelve months.'],
])('refuses a private, fabricated or stripped rule: %s', async (reply, evidence) => {
  expect(await extractReplyLesson({ reply, clientNames: ['Sam'], askModel: async () => modelAnswer(evidence) })).toBeNull();
});
it('does not turn malformed or explicitly nonreusable model output into knowledge', async () => {
  for (const text of ['not json', JSON.stringify({ reusable: false }), JSON.stringify({ reusable: true, evidence: rule })]) {
    expect(await extractReplyLesson({ reply: rule, askModel: async () => ({ content: [{ text }] }) })).toBeNull();
  }
});
it('only considers owner-authored successful text replies', () => {
  const source = { content: rule, direction: 'outbound', authored_by: 'human', send_status: null };
  expect(eligibleReply(source)).toBe(true);
  expect(eligibleReply({ ...source, authored_by: 'ai_edited' })).toBe(true);
  for (const change of [{ direction: 'inbound' }, { authored_by: 'ai' }, { authored_by: 'unknown' }, { send_status: 'failed' }, { content: 'Thanks x' }]) expect(eligibleReply({ ...source, ...change })).toBe(false);
});
function fixtures() {
  state.rows.messages = [{ id: ID, beautician_id: 'owner', client_id: 'client', direction: 'outbound', authored_by: 'human', content: rule, created_at: '2026-09-17' }];
  state.rows.clients = [{ id: 'client', beautician_id: 'owner', first_name: 'Sam' }];
  state.model.mockResolvedValue(modelAnswer(rule));
}
it('creates a pending suggestion, never an approved note, and deduplicates repeat requests', async () => {
  fixtures();
  expect(await learnReply('owner', ID)).toMatchObject({ status: 'pending', content: rule });
  expect(await learnReply('owner', ID)).toMatchObject({ status: 'pending' });
  expect(state.model).toHaveBeenCalledTimes(1);
  expect(state.rows.knowledge_suggestions).toHaveLength(1);
  expect(state.calls.some(c => c.table === 'knowledge_entries')).toBe(false);
});
it('never learns another owner’s message or a failed send, and never revives a dismissal', async () => {
  fixtures(); expect(await learnReply('other', ID)).toBeNull();
  state.rows.messages[0].send_status = 'failed'; expect(await learnReply('owner', ID)).toBeNull();
  expect(state.model).not.toHaveBeenCalled();
  state.rows.messages[0].send_status = null; await learnReply('owner', ID);
  state.rows.knowledge_suggestions[0].status = 'dismissed';
  expect(await learnReply('owner', ID)).toMatchObject({ status: 'dismissed' });
  expect(state.model).toHaveBeenCalledTimes(1);
});
it('leaves model failures retryable without touching the sent message', async () => {
  fixtures(); state.model.mockRejectedValue(new Error('offline'));
  const original = structuredClone(state.rows.messages);
  await expect(learnReply('owner', ID)).rejects.toThrow('offline');
  expect(state.rows.messages).toEqual(original);
  expect(state.rows.knowledge_suggestions[0].status).toBe('retry');
  state.model.mockResolvedValue(modelAnswer(rule));
  expect(await learnReply('owner', ID)).toMatchObject({ status: 'pending' });
});

it('keeps trailing qualifications even when the model selects only the first rule', async () => {
  const reply = 'Leave at least eight weeks between full brow laminations. Irritated brows need a personal assessment first.';
  const lesson = await extractReplyLesson({ reply, askModel: async () => modelAnswer('Leave at least eight weeks between full brow laminations.') });
  expect(lesson.content).toBe(reply);
  expect(lesson.evidence).toBe(reply);
});
it('removes a greeting to this client but rejects private facts elsewhere in the reply', async () => {
  expect((await extractReplyLesson({ reply: `Hi Sam. ${rule}`, clientNames: ['Sam'], askModel: async () => modelAnswer(rule) })).content).toBe(rule);
  expect(await extractReplyLesson({ reply: `${rule} Sam also has credit on their account.`, clientNames: ['Sam'], askModel: async () => modelAnswer(rule) })).toBeNull();
});
