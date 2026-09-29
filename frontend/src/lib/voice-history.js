const STORAGE_PREFIX = 'florrie_voice_chat:v1:';
const LEGACY_KEY = 'florrie_voice_chat';
const MAX_MESSAGES = 40;
const MAX_TEXT_LENGTH = 12000;
const MAX_STORED_LENGTH = 600000;
const AGENTS = new Set(['general', 'calendar', 'clients', 'campaigns', 'money', 'content', 'settings']);

const PROPOSAL_NOTE = 'This earlier proposal is no longer active. Ask Florrie again to prepare it.';
const PRIVATE_NOTE = 'Client details are not kept in conversation history. Ask again to see the latest information.';

function ownerKey(ownerId) {
  if (typeof ownerId !== 'string' || !ownerId.trim() || ownerId.length > 200) return null;
  return `${STORAGE_PREFIX}${encodeURIComponent(ownerId)}`;
}

function discardLegacy(storage) {
  // The old shared key cannot be attributed to any salon, so never migrate it.
  try { storage?.removeItem(LEGACY_KEY); } catch { /* Storage can be unavailable. */ }
}

function hasItems(value) {
  return Array.isArray(value) ? value.length > 0 : value != null;
}

function safeMessage(message) {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return null;
  if (!['user', 'assistant'].includes(message.role)) return null;
  if (typeof message.id !== 'string' || !message.id || message.id.length > 128) return null;
  if (typeof message.text !== 'string' || !message.text.trim()) return null;

  // Only presentation fields survive. Tool inputs, consultation answers,
  // contact lists and future structured payloads must not enter local storage.
  const safe = {
    id: message.id,
    role: message.role,
    text: message.text.slice(0, MAX_TEXT_LENGTH),
  };
  if (typeof message.timestamp === 'string' && message.timestamp.length <= 40 && Number.isFinite(Date.parse(message.timestamp))) {
    safe.timestamp = message.timestamp;
  }
  if (message.role === 'user') {
    if (message.isVoice === true) safe.isVoice = true;
    return safe;
  }
  safe.agent = AGENTS.has(message.agent) ? message.agent : 'general';

  // Notes must survive another save/load, without accepting arbitrary metadata.
  const earlierNote = typeof message.historyNote === 'string' ? message.historyNote : '';
  const hadProposal = hasItems(message.proposals) || earlierNote.includes(PROPOSAL_NOTE);
  const hadPrivateCards = hasItems(message.consultation) || hasItems(message.needed) || earlierNote.includes(PRIVATE_NOTE);
  if (hadProposal && /^\s*(?:please\s+)?review(?:\s+(?:the\s+)?(?:proposed\s+)?actions?)?\s+below[.!]?\s*$/i.test(safe.text)) {
    safe.text = 'An action was proposed in this conversation.';
  }
  const notes = [hadProposal && PROPOSAL_NOTE, hadPrivateCards && PRIVATE_NOTE].filter(Boolean);
  if (notes.length) safe.historyNote = notes.join(' ');
  return safe;
}

function safeMessages(messages) {
  if (!Array.isArray(messages)) return [];
  // Process the recent window only; duplicate IDs otherwise break React keys.
  const seen = new Set();
  const result = [];
  for (let i = messages.length - 1; i >= Math.max(0, messages.length - MAX_MESSAGES); i -= 1) {
    const message = safeMessage(messages[i]);
    if (!message || seen.has(message.id)) continue;
    seen.add(message.id);
    result.unshift(message);
  }
  return result;
}

/** Restore a read-only transcript for one signed-in salon. Never restore commands. */
export function loadVoiceHistory(storage, ownerId) {
  discardLegacy(storage);
  const key = ownerKey(ownerId);
  if (!key) return [];
  try {
    const raw = storage?.getItem(key);
    if (typeof raw !== 'string' || raw.length > MAX_STORED_LENGTH) return [];
    const saved = JSON.parse(raw);
    if (saved?.version !== 1 || saved.ownerId !== ownerId) return [];
    return safeMessages(saved.messages);
  } catch {
    return [];
  }
}

/** Call only after this owner's transcript has loaded; never save another owner's state. */
export function saveVoiceHistory(storage, ownerId, messages) {
  discardLegacy(storage);
  const key = ownerKey(ownerId);
  if (!key || !Array.isArray(messages)) return false;
  try {
    if (typeof storage?.setItem !== 'function') return false;
    const saved = { version: 1, ownerId, messages: safeMessages(messages) };
    let raw = JSON.stringify(saved);
    // Escaped text can occupy more space than its character count. Always
    // write a transcript that the read limit can restore.
    while (raw.length > MAX_STORED_LENGTH && saved.messages.length) {
      saved.messages.shift();
      raw = JSON.stringify(saved);
    }
    storage.setItem(key, raw);
    return true;
  } catch {
    return false;
  }
}

/** Forget this salon's local conversation without touching another salon's history. */
export function clearVoiceHistory(storage, ownerId) {
  discardLegacy(storage);
  const key = ownerKey(ownerId);
  if (!key) return false;
  try {
    if (typeof storage?.removeItem !== 'function') return false;
    storage.removeItem(key);
    return true;
  } catch {
    return false;
  }
}
