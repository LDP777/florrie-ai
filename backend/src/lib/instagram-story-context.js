// A reference to a story is not its contents. Keep that distinction in the
// stored transcript as well as the current request; no story URL is fetched.
export const INSTAGRAM_STORY_UNAVAILABLE_MARKER = '[Reply to an Instagram story; story content unavailable to Florrie]';

function safeStoryId(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return null;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const id = String(value);
  return /^\d{1,40}$/.test(id) ? id : null;
}

function safeStoryUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u0020\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const allowed = ['instagram.com', 'cdninstagram.com', 'fbsbx.com', 'fbcdn.net'];
    if (!allowed.some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) return null;
    return url.href;
  } catch { return null; }
}

/** Meta message.reply_to.story may have expired or arrive without its media. */
export function describeInstagramStoryReply(message) {
  const replyTo = message?.reply_to;
  if (!replyTo || !Object.prototype.hasOwnProperty.call(replyTo, 'story')) return null;
  const story = replyTo.story;
  return {
    id: safeStoryId(story?.id),
    media_url: safeStoryUrl(story?.url),
    media_type: 'story_reply',
    contentAvailable: false,
  };
}

export function formatInstagramStoryReply(text, story, attachmentLabel = null) {
  if (!story) return text || attachmentLabel || '[Message]';
  // Put the client's actual words first: inbox previews must show the question.
  return [text || attachmentLabel, INSTAGRAM_STORY_UNAVAILABLE_MARKER].filter(Boolean).join('\n');
}

export function isUnavailableStoryContext(messageOrContent) {
  const row = typeof messageOrContent === 'string' ? { content: messageOrContent } : messageOrContent;
  return row?.media_type === 'story_reply'
    || row?.escalated_reason === 'story_context:unavailable'
    || String(row?.content || '').includes(INSTAGRAM_STORY_UNAVAILABLE_MARKER);
}
