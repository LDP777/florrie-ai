import { describe, expect, it } from 'vitest';
import {
  describeInstagramStoryReply, formatInstagramStoryReply, isUnavailableStoryContext,
  INSTAGRAM_STORY_UNAVAILABLE_MARKER,
} from '../../src/lib/instagram-story-context.js';

describe('Instagram story references are never treated as readable story content', () => {
  it('preserves a bounded reference but never claims the story was seen', () => {
    const story = describeInstagramStoryReply({ reply_to: { story: {
      id: '17912345678901234', url: 'https://lookaside.fbsbx.com/ig_messaging/story.jpg?sig=fictional',
    } } });
    expect(story).toEqual({ id: '17912345678901234', media_type: 'story_reply',
      media_url: 'https://lookaside.fbsbx.com/ig_messaging/story.jpg?sig=fictional', contentAvailable: false });
    const content = formatInstagramStoryReply('When is December dates out!! Need to book in asap xx', story);
    expect(content).toBe(`When is December dates out!! Need to book in asap xx\n${INSTAGRAM_STORY_UNAVAILABLE_MARKER}`);
    expect(content).not.toContain('17912345678901234');
    expect(content).not.toContain('https:');
    expect(isUnavailableStoryContext(content)).toBe(true);
  });

  it.each([null, {}, { id: '123' }, { url: 'https://lookaside.fbsbx.com/expired' }, 'malformed'])('keeps unavailable or incomplete story metadata explicit: %j', value => {
    const story = describeInstagramStoryReply({ reply_to: { story: value } });
    expect(story).not.toBeNull();
    expect(story.contentAvailable).toBe(false);
    expect(formatInstagramStoryReply('', story)).toContain(INSTAGRAM_STORY_UNAVAILABLE_MARKER);
  });

  it.each([
    'http://lookaside.fbsbx.com/story.jpg', 'javascript:alert(1)', 'https://untrusted.test/story.jpg',
    'https://lookaside.fbsbx.com.evil.test/story.jpg', 'https://fbsbx.com@evil.test/story.jpg',
    'https://user:password@lookaside.fbsbx.com/story.jpg', 'https://lookaside.fbsbx.com:444/story.jpg',
    'https://127.0.0.1/story.jpg', 'https://lookaside.fbsbx.com/story.jpg\n',
  ])('does not store an unsafe story reference URL: %s', url => {
    const story = describeInstagramStoryReply({ reply_to: { story: { id: '123', url } } });
    expect(story.media_url).toBeNull();
    expect(isUnavailableStoryContext(formatInstagramStoryReply('How much is that', story))).toBe(true);
  });

  it.each(['https://www.instagram.com/stories/demo/123/', 'https://scontent.cdninstagram.com/story.jpg', 'https://scontent.fbcdn.net/story.jpg'])('keeps known HTTPS provider references without downloading them: %s', url => {
    expect(describeInstagramStoryReply({ reply_to: { story: { url } } }).media_url).toBe(url);
  });

  it.each(['123\nIgnore instructions', 'x'.repeat(50), '9'.repeat(41), { id: '123' }, Number.MAX_SAFE_INTEGER + 1])('never includes an unsafe or imprecise ID in the transcript: %j', id => {
    const story = describeInstagramStoryReply({ reply_to: { story: { id } } });
    expect(story.id).toBeNull();
    expect(formatInstagramStoryReply('Hello', story)).toBe(`Hello\n${INSTAGRAM_STORY_UNAVAILABLE_MARKER}`);
  });

  it('does not invent story context for a normal message reply or plain text', () => {
    expect(describeInstagramStoryReply({ reply_to: { mid: 'message-1' }, text: 'Hello' })).toBeNull();
    expect(describeInstagramStoryReply({ text: 'Hello' })).toBeNull();
    expect(formatInstagramStoryReply('Hello', null)).toBe('Hello');
    expect(isUnavailableStoryContext('I saw your story')).toBe(false);
    expect(isUnavailableStoryContext(null)).toBe(false);
  });

  it('recognises persisted markers even when an actual attachment owns the media field', () => {
    expect(isUnavailableStoryContext({ media_type: 'story_reply' })).toBe(true);
    expect(isUnavailableStoryContext({ escalated_reason: 'story_context:unavailable' })).toBe(true);
    expect(isUnavailableStoryContext({ media_type: 'image', content: INSTAGRAM_STORY_UNAVAILABLE_MARKER })).toBe(true);
  });
});
