import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clientQuestionScenario } from '../../src/lib/client-question.js';
import { INSTAGRAM_STORY_UNAVAILABLE_MARKER } from '../../src/lib/instagram-story-context.js';

const now = new Date('2026-10-01T14:00:00Z');
const row = (content, extra = {}) => ({ direction: 'inbound', content, created_at: now.toISOString(), ...extra });
const story = () => row(`When is December dates out!! Need to book in asap xx\n${INSTAGRAM_STORY_UNAVAILABLE_MARKER}`);
const firstComment = 'Haven’t been able to find a time/date I can do in October but this has helped for what I’m booking December 😂xx';
const secondComment = 'Keeping an eye out on December 7th 😂 xx';
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(now); });
afterEach(() => vi.useRealTimers());

describe('unseen story context outlives intervening client chatter', () => {
  it.each(['Can I book that?', 'How much is that xx', 'Does it include tinting?', 'Can I book it with a brow tint?', 'What about December 7th?', 'December 7th', secondComment])('keeps the original uncertainty for a follow-up: %s', message => {
    const conversation = [story(), row(firstComment), row('Thanks lovely xx'), row(message)];
    expect(clientQuestionScenario(message, conversation)).toMatchObject({ kind: 'story_context', question: message });
  });
  it('does not mistake an AI response for an owner explanation of the story', () => {
    const conversation = [story(), row(firstComment), row('Which treatment would you like?', { direction: 'outbound', authored_by: 'ai' })];
    expect(clientQuestionScenario('Can I book that?', conversation)?.kind).toBe('story_context');
  });
  it('does not extend the age of the story because the client sent a recent comment', () => {
    const conversation = [{ ...story(), created_at: new Date(now.getTime() - 49 * 3600000).toISOString() }, row(firstComment)];
    expect(clientQuestionScenario('How much is that?', conversation)?.kind).not.toBe('story_context');
  });
  it.each(['human', 'ai_edited'])('stops at a real owner response: %s', authored_by => {
    const conversation = [story(), row(firstComment), row('That story is about our December opening dates.', { direction: 'outbound', authored_by }), row('Thanks xx')];
    expect(clientQuestionScenario('Can I book that?', conversation)?.kind).not.toBe('story_context');
  });
  it('recognises stored unavailable context when only its reason remains in the transcript', () => {
    const conversation = [row('How much is that?', { escalated_reason: 'story_context:unavailable' }), row(firstComment)];
    expect(clientQuestionScenario('Can I book that?', conversation)?.kind).toBe('story_context');
  });
});

describe('an old story does not own the whole conversation', () => {
  it.each([
    'Can I book brow tint tomorrow?', 'Please book brow lamination this Friday',
    'I would like to book hybrid brows on December 7th',
    'Can I book an appointment for December 7th?',
  ])('allows a new self-contained action request: %s', message => {
    expect(clientQuestionScenario(message, [story(), row(firstComment)])?.kind).not.toBe('story_context');
  });
  it('does not revive an old story during a later explicit booking conversation', () => {
    const conversation = [story(), row(firstComment), row('Can I book brow tint tomorrow?'),
      row('There is a brow tint appointment at 3pm.', { direction: 'outbound', authored_by: 'ai' })];
    expect(clientQuestionScenario('Can I book that one?', conversation)?.kind).not.toBe('story_context');
  });
  it('recognises a new named treatment choice with please as a topic boundary', () => {
    const conversation = [story(), row(firstComment), row('Brow tint please'),
      row('There is a brow tint appointment at 3pm.', { direction: 'outbound', authored_by: 'ai' })];
    expect(clientQuestionScenario('Can I book that one?', conversation)?.kind).not.toBe('story_context');
  });
  it('does not mistake a treatment mention or price question for a new booking topic', () => {
    const conversation = [story(), row('Brow tint sounds lovely'), row('How much is that brow tint please?')];
    expect(clientQuestionScenario('Does that include wax?', conversation)?.kind).toBe('story_context');
  });
  it.each([
    'Where do I park?', 'How much is a brow tint?', 'What is your cancellation policy?',
    'I was thinking about getting a brow tint, how much is it?',
    'Is it too soon for brow lamination again in two weeks?', 'Can I move my appointment to Friday?',
  ])('leaves an unrelated question or existing-booking request alone: %s', message => {
    expect(clientQuestionScenario(message, [story(), row(firstComment)])?.kind).not.toBe('story_context');
  });
  it.each(['4pm please', 'yes please', 'the second one'])('does not turn a plain booking continuation into a missing-story question: %s', message => {
    expect(clientQuestionScenario(message, [story(), row('Can I book brow tint tomorrow?'), row('3pm or 4pm?', { direction: 'outbound', authored_by: 'ai' })])?.kind).not.toBe('story_context');
  });
  it('does not invent story uncertainty when the conversation never had a story marker', () => {
    expect(clientQuestionScenario('Can I book that?', [row('Can I book a brow tint?')])?.kind).not.toBe('story_context');
  });
});

describe('declared diary questions survive passive follow-ups without story metadata', () => {
  const original = 'When is December dates out!! Need to book in asap xx';
  it('allows get/have requests that name the treatment after an earlier diary question', () => {
    for (const message of ['Can I get a brow tint on December 7th?', 'Could I have hybrid brows on December 7th?', 'May I have full brow lamination on December 7th?']) {
      expect(clientQuestionScenario(message, [row(original), row(firstComment)])).toBeNull();
      expect(clientQuestionScenario('Can I book that one?', [story(), row(message)])?.kind).not.toBe('story_context');
    }
  });
  it('does not treat receipt/refund requests or story pronouns as a new treatment booking', () => {
    for (const message of ['Can I get a receipt for my brow tint?', 'Could I have a refund for my brow tint?', 'Can I get that brow tint?']) {
      expect(clientQuestionScenario('Can I book that one?', [story(), row(message)])?.kind).toBe('story_context');
    }
  });
  it.each([secondComment, 'December 7th', 'Im after Wednesday 25th November at 5pm'])('retains the original question for %s', message => {
    const conversation = [row(original), row(firstComment), row('Thanks lovely xx'), row(message)];
    const result = clientQuestionScenario(message, conversation);
    expect(result).toEqual({ kind: 'diary_release', question: `${original}\nClient clarification: ${message}` });
  });
  it.each(['human', 'ai_edited'])('does not restore a diary question after the owner answers: %s', authored_by => {
    const conversation = [row(original), row('December opens on Sunday.', { direction: 'outbound', authored_by }), row(firstComment)];
    expect(clientQuestionScenario('December 7th', conversation)?.kind).not.toBe('diary_release');
  });
  it.each(['Can I book brow tint tomorrow?', 'Brow tint please'])('leaves a later booking conversation intact after %s', message => {
    const conversation = [row(original), row(firstComment), row(message), row('When would suit?', { direction: 'outbound', authored_by: 'ai' })];
    expect(clientQuestionScenario('December 7th', conversation)?.kind).not.toBe('diary_release');
  });
  it('does not renew an old diary question from the age of its latest passive comment', () => {
    const conversation = [row(original, { created_at: new Date(now.getTime() - 49 * 3600000).toISOString() }), row(firstComment)];
    expect(clientQuestionScenario('December 7th', conversation)?.kind).not.toBe('diary_release');
  });
  it('does not turn an unrelated current question into a release clarification', () => {
    expect(clientQuestionScenario('How much is a brow tint?', [row(original), row(firstComment)])?.kind).toBe('treatment_menu');
  });
});
