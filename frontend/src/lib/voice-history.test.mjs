import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadVoiceHistory, saveVoiceHistory, clearVoiceHistory } from './voice-history.js';

function memoryStorage() {
  const data = new Map();
  return {
    data,
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, value),
    removeItem: key => data.delete(key),
  };
}

function message(id, text = 'What does today look like?') {
  return { id, role: 'user', text, timestamp: '2026-09-29T10:00:00.000Z', isVoice: true };
}

test('each salon restores only its own transcript and clears only its own history', () => {
  const storage = memoryStorage();
  assert.equal(saveVoiceHistory(storage, 'ellie', [message('e', 'My diary')]), true);
  saveVoiceHistory(storage, 'demo', [message('d', 'Demo diary')]);
  assert.equal(loadVoiceHistory(storage, 'ellie')[0].text, 'My diary');
  assert.equal(loadVoiceHistory(storage, 'demo')[0].text, 'Demo diary');
  assert.deepEqual(loadVoiceHistory(storage, 'new-salon'), []);
  assert.equal(clearVoiceHistory(storage, 'ellie'), true);
  assert.deepEqual(loadVoiceHistory(storage, 'ellie'), []);
  assert.equal(loadVoiceHistory(storage, 'demo')[0].text, 'Demo diary');
});

test('the unowned legacy transcript is removed instead of claimed by the next salon', () => {
  const storage = memoryStorage();
  storage.setItem('florrie_voice_chat', JSON.stringify([message('private', 'Another salon’s client')]));
  assert.deepEqual(loadVoiceHistory(storage, 'demo'), []);
  assert.equal(storage.getItem('florrie_voice_chat'), null);
});

test('sign-out or an invalid owner cannot read or write a shared transcript', () => {
  const storage = memoryStorage();
  for (const owner of [null, undefined, '', ' ', 42, {}, 'a'.repeat(201)]) {
    assert.equal(saveVoiceHistory(storage, owner, [message('e')]), false);
    assert.deepEqual(loadVoiceHistory(storage, owner), []);
    assert.equal(clearVoiceHistory(storage, owner), false);
  }
  assert.equal(storage.data.size, 0);
});

test('only the last forty messages survive without changing their order or voice marker', () => {
  const storage = memoryStorage();
  const messages = Array.from({ length: 50 }, (_, index) => message(String(index)));
  saveVoiceHistory(storage, 'ellie', messages);
  const restored = loadVoiceHistory(storage, 'ellie');
  assert.deepEqual(restored, messages.slice(-40));
});

test('client cards, hidden metadata and actionable proposals never enter persisted JSON', () => {
  const storage = memoryStorage();
  const reply = {
    id: 'reply', role: 'assistant', text: 'Here is what I found.', agent: 'clients',
    consultation: [{ pairs: [{ answer: 'SENSITIVE_ALLERGY' }] }],
    needed: [{ email: 'SENSITIVE_EMAIL' }], neededLabel: 'SENSITIVE_LABEL',
    proposals: [{ tool: 'send_message', input: { message: 'SENSITIVE_DRAFT', phone: 'SENSITIVE_PHONE' } }],
    action: { path: '/clients/SENSITIVE_ID', label: 'Open client' },
    actions: [{ data: 'SENSITIVE_RESPONSE' }], other: { nested: 'SENSITIVE_FUTURE_FIELD' },
    multiStep: true, toolCount: 3,
  };
  saveVoiceHistory(storage, 'ellie', [reply]);
  const json = [...storage.data.values()].join('');
  assert.doesNotMatch(json, /SENSITIVE_|send_message|proposals|consultation|needed|toolCount/);
  const [restored] = loadVoiceHistory(storage, 'ellie');
  assert.equal(restored.text, reply.text);
  assert.match(restored.historyNote, /proposal is no longer active/);
  assert.match(restored.historyNote, /Client details are not kept/);
  assert.equal(reply.proposals[0].input.message, 'SENSITIVE_DRAFT', 'Saving does not mutate live cards');
});

test('restored proposals cannot replay and the empty Review below instruction is replaced', () => {
  const storage = memoryStorage();
  saveVoiceHistory(storage, 'ellie', [{ id: 'p', role: 'assistant', text: 'Review the proposed action below.', proposals: [{ tool: 'create_booking' }] }]);
  const first = loadVoiceHistory(storage, 'ellie');
  assert.equal(first[0].proposals, undefined);
  assert.equal(first[0].text, 'An action was proposed in this conversation.');
  assert.match(first[0].historyNote, /Ask Florrie again/);
  saveVoiceHistory(storage, 'ellie', first);
  assert.deepEqual(loadVoiceHistory(storage, 'ellie'), first, 'The explanation survives later navigation');
  saveVoiceHistory(storage, 'ellie', [{ id: 'p', role: 'assistant', text: 'Review below.', proposals: [{}] }]);
  assert.equal(loadVoiceHistory(storage, 'ellie')[0].text, 'An action was proposed in this conversation.');
});

test('loading sanitizes edited or older scoped storage as well as saving', () => {
  const storage = memoryStorage();
  saveVoiceHistory(storage, 'ellie', []);
  const key = [...storage.data.keys()][0];
  storage.setItem(key, JSON.stringify({ version: 1, ownerId: 'ellie', messages: [
    { id: 'p', role: 'assistant', text: 'Ready to send.', proposals: [{ tool: 'send_message' }], consultation: ['private'], historyNote: 'untrusted', agent: 'unknown' },
  ] }));
  const [restored] = loadVoiceHistory(storage, 'ellie');
  assert.equal(restored.agent, 'general');
  assert.equal(restored.proposals, undefined);
  assert.equal(restored.consultation, undefined);
  assert.match(restored.historyNote, /no longer active/);
  assert.doesNotMatch(restored.historyNote, /untrusted/);
});

test('malformed envelopes, mismatched owners and malformed JSON return an empty history', () => {
  const storage = memoryStorage();
  saveVoiceHistory(storage, 'ellie', []);
  const key = [...storage.data.keys()][0];
  for (const raw of ['{', 'null', '[]', '{}', JSON.stringify({ version: 2, ownerId: 'ellie', messages: [message('x')] }), JSON.stringify({ version: 1, ownerId: 'demo', messages: [message('x')] }), JSON.stringify({ version: 1, ownerId: 'ellie', messages: {} }), 'x'.repeat(600001)]) {
    storage.setItem(key, raw);
    assert.deepEqual(loadVoiceHistory(storage, 'ellie'), []);
  }
});

test('invalid messages are skipped, duplicate IDs resolve to the most recent message and text is bounded', () => {
  const storage = memoryStorage();
  saveVoiceHistory(storage, 'ellie', [
    null, {}, [], { id: 'x', role: 'system', text: 'Bad role' }, { id: 'x', role: 'assistant', text: {} },
    message('duplicate', 'Old'), message('duplicate', 'Newest'), message('long', 'a'.repeat(13000)),
    { id: 'time', role: 'assistant', text: 'Hello', timestamp: 'not-a-date' },
  ]);
  const restored = loadVoiceHistory(storage, 'ellie');
  assert.deepEqual(restored.map(item => item.id), ['duplicate', 'long', 'time']);
  assert.equal(restored[0].text, 'Newest');
  assert.equal(restored[1].text.length, 12000);
  assert.equal(restored[2].timestamp, undefined);
});

test('blocked storage and quota errors never break the voice page', () => {
  const blocked = { getItem() { throw new Error('Blocked'); }, setItem() { throw new Error('Quota'); }, removeItem() { throw new Error('Blocked'); } };
  for (const storage of [blocked, null, {}]) {
    assert.deepEqual(loadVoiceHistory(storage, 'ellie'), []);
    assert.equal(saveVoiceHistory(storage, 'ellie', [message('x')]), false);
    assert.equal(clearVoiceHistory(storage, 'ellie'), false);
  }
});

test('unusually large escaped transcripts remain readable and retain the newest messages', () => {
  const storage = memoryStorage();
  saveVoiceHistory(storage, 'ellie', Array.from({ length: 40 }, (_, i) => message(String(i), `Question ${'\u0000'.repeat(11990)}`)));
  assert.ok([...storage.data.values()][0].length <= 600000);
  const restored = loadVoiceHistory(storage, 'ellie');
  assert.ok(restored.length > 0);
  assert.equal(restored.at(-1).id, '39');
});
