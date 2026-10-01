import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/config.js', () => ({ supabase: {} }));

import { isSocialLead } from '../../src/lib/inbox-space.js';
import { INSTAGRAM_STORY_UNAVAILABLE_MARKER as marker } from '../../src/lib/instagram-story-context.js';
import { explainHold } from '../../../frontend/src/lib/hold-reasons.js';

const story = content => `${content}\n${marker}`;
const lead = content => isSocialLead({ content, intent: 'general_question' });

describe('unanswered Instagram questions stay visible', () => {
  it.each([
    'When is December dates out!! Need to book in asap xx',
    'When will the Christmas diary open xx',
    'Are November dates released yet xx',
  ])('recognises diary-release wording with or without story metadata: %s', question => {
    expect(lead(question)).toBe(true);
    expect(lead(story(question))).toBe(true);
  });

  it.each([
    'How much is this xx',
    'What does this include xx',
    'Can I book this please xx',
    'I need to book in asap xx',
    'Tell me which treatment this is xx',
  ])('preserves a story question without a question mark: %s', question => {
    expect(lead(story(question))).toBe(true);
  });

  it.each(['❤️', '😍😍', 'Thanks lovely xx', 'Love these', 'Gorgeous brows', 'How gorgeous', 'What a lovely colour', ''])('keeps reactions and compliments quiet: %s', reaction => {
    expect(lead(story(reaction))).toBe(false);
  });

  it('does not treat generic general_question labels or a marker as buying intent', () => {
    expect(lead('Love these')).toBe(false);
    expect(lead(marker)).toBe(false);
    expect(lead('Just saying hi')).toBe(false);
  });

  it.each(['How much is that xx', 'Can I book that xx'])('keeps a held story follow-up visible from metadata alone: %s', content => {
    expect(isSocialLead({ content, intent: 'general_question', escalated_reason: 'story_context:unavailable' })).toBe(true);
    expect(isSocialLead({ content, intent: 'general_question', media_type: 'story_reply' })).toBe(true);
    expect(isSocialLead({ content, intent: 'general_question' })).toBe(false);
  });

  it('does not turn thanks into a lead merely because a prior story is unavailable', () => {
    expect(isSocialLead({ content: 'Thanks lovely xx', intent: 'general_question', escalated_reason: 'story_context:unavailable' })).toBe(false);
  });

  it('keeps the junk exclusion ahead of question or booking signals', () => {
    expect(isSocialLead({ content: story('When is December dates out!!'), intent: 'general_question', isJunk: true })).toBe(false);
    expect(isSocialLead({ content: 'Can I book?', intent: 'booking_request', isJunk: true })).toBe(false);
  });

  it('preserves existing buying intent and direct question behavior', () => {
    expect(isSocialLead({ content: 'Friday please', intent: 'availability_check' })).toBe(true);
    expect(isSocialLead({ content: 'Do you offer brows?', intent: 'unknown' })).toBe(true);
  });

  it('explains missing story context without claiming the story was read', () => {
    expect(explainHold('story_context:unavailable')).toBe('They asked about an Instagram story that Florrie cannot see. Check the story and reply to their question.');
  });

  it('explains that a diary announcement still needs confirmation', () => {
    expect(explainHold('diary_release:announcement_unconfirmed')).toContain('Confirm the release date before replying.');
  });
});
