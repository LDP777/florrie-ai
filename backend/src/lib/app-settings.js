/**
 * The settings Ellie can change by talking to Florrie.
 *
 * One registry, because the alternative is a tool per setting and a prompt
 * that has to be edited every time one is added. Everything the voice
 * commander needs — what it is called, what it means in her words, where it
 * lives in the row, what values it takes, and how to say the change back to
 * her — is here, and the tool descriptions are generated from it.
 *
 * WHY THIS EXISTS. The switch that decides whether Florrie answers her clients
 * herself lives four taps deep in Settings, under a heading nobody would think
 * to open mid-shift. Ellie's whole complaint was that the app costs her
 * attention; making her hunt for the control that fixes that is the joke
 * writing itself. She should be able to say "stop answering my clients
 * yourself" and have it be done.
 *
 * Two rules hold everything here together.
 *
 *   1. Nothing in this file has a client-visible side effect on its own. These
 *      flip a preference; they do not send, book, cancel or charge. Anything
 *      that touches a client goes through the existing tools, which have their
 *      own confirmation.
 *   2. A change is still PROPOSED, never applied on speech alone. Voice
 *      transcription mishears, and "don't pause my messages" and "pause my
 *      messages" are one dropped word apart. voice-orchestrator.js holds
 *      change_setting for the on-screen confirm card, same as a booking.
 */

/**
 * Where a setting lives.
 *   column — a plain column on `beauticians`
 *   json   — a key inside a jsonb column on `beauticians`
 */
export const SETTINGS = [
  {
    id: 'florrie_answers_easy_ones',
    label: 'Let Florrie answer the easy ones',
    // What she would SAY, not what the column is called. The model matches on
    // these, so they carry the weight.
    says: [
      'let florrie answer my clients', 'stop answering my clients yourself',
      'answer the easy questions', 'stop replying for me',
      'you reply to them', 'I want to see every message first',
      'turn the ai up', 'turn the ai down',
    ],
    means: "When it's on, Florrie replies straight away to questions she can answer from your diary and price list (when someone is booked in, what a treatment costs, aftercare), signed as Florrie, with a way for the client to ask for you instead. Availability, moving a booking, anything about money owed or a complaint still comes to you either way.",
    where: { json: 'autonomy', key: 'grounded_replies' },
    type: 'boolean',
    default: true,
    onSaid: 'Florrie will answer the easy ones herself.',
    offSaid: 'Every message will come to you first, like before.',
  },
  {
    id: 'pause_all_messages',
    label: 'Pause everything Florrie sends',
    says: ['pause all messages', 'stop all messages', 'go quiet', 'unpause', 'start messaging again'],
    means: 'The master switch. Nothing automated goes out on your behalf at all, including reminders. Use it if you are away or something has gone wrong.',
    where: { json: 'client_reminder_prefs', key: 'paused' },
    type: 'boolean',
    default: false,
    onSaid: 'Everything is paused. Nothing automated goes out until you turn it back on.',
    offSaid: 'Messages are back on.',
  },
  {
    id: 'booking_confirmations',
    label: 'Send booking confirmations',
    says: ['send confirmations', 'stop sending confirmations', 'confirmation texts'],
    means: 'The text or WhatsApp a client gets when a booking is made, with the calendar link in it.',
    where: { json: 'client_reminder_prefs', key: 'booking_confirmation' },
    type: 'boolean',
    default: true,
    onSaid: 'Clients will get a confirmation when they book.',
    offSaid: 'No confirmation texts will go out. Email still will unless you turn that off too.',
  },
  {
    id: 'confirmation_emails',
    label: 'Send confirmation emails',
    says: ['send confirmation emails', 'stop the emails', 'email confirmations'],
    means: 'The confirmation email, which is the one that carries the calendar invite as an attachment.',
    where: { json: 'client_reminder_prefs', key: 'email_confirmation' },
    type: 'boolean',
    default: true,
    onSaid: 'Confirmation emails are on.',
    offSaid: 'No confirmation emails. Worth knowing the calendar invite rides on that email, so clients lose the one-tap add.',
  },
  {
    id: 'message_channel',
    label: 'How Florrie messages clients',
    says: ['use whatsapp', 'use text messages', 'message people on whatsapp', 'send texts instead'],
    means: 'Which channel Florrie reaches clients on first. If WhatsApp is not available for someone she falls back to a text anyway.',
    where: { json: 'client_reminder_prefs', key: 'channel' },
    type: 'enum',
    values: ['whatsapp', 'sms'],
    default: 'whatsapp',
    said: (v) => (v === 'whatsapp' ? 'Florrie will use WhatsApp first.' : 'Florrie will send texts.'),
  },
  {
    id: 'promos_in_offers',
    label: 'Add a promo to gap offers',
    says: ['add my promo to offers', 'include the discount code', 'stop adding promo codes'],
    means: 'When you have a promo code running, Florrie can add it to a last-minute gap offer.',
    where: { json: 'autonomy', key: 'promos_in_offers' },
    type: 'boolean',
    default: false,
    onSaid: 'Florrie will add a live promo code to gap offers.',
    offSaid: 'Gap offers will go out without a promo code.',
  },
  {
    id: 'auto_reply',
    label: 'Florrie replies to new enquiries',
    says: ['reply to new enquiries', 'stop replying to strangers', 'answer new people'],
    means: 'Whether Florrie answers people who have never booked with you at all. Separate from the setting about your existing clients.',
    where: { column: 'auto_reply_enabled' },
    type: 'boolean',
    default: true,
    onSaid: 'Florrie will answer new enquiries.',
    offSaid: 'New enquiries will wait for you.',
  },
  {
    id: 'known_client_min_visits',
    label: 'When somebody counts as your client',
    says: ['who counts as my client', 'treat people as mine after', 'only regulars'],
    means: 'How many visits before Florrie treats somebody as one of your own clients rather than a new enquiry.',
    where: { json: 'autonomy', key: 'known_client_min_visits' },
    type: 'number',
    min: 1,
    max: 3,
    default: 1,
    said: (v) => `Somebody counts as your client after ${v} visit${Number(v) === 1 ? '' : 's'}.`,
  },
];

export const byId = (id) => SETTINGS.find(s => s.id === id) || null;

/** Read the live value, falling back to the documented default. */
export function readSetting(setting, beautician) {
  if (!setting || !beautician) return undefined;
  const raw = setting.where.column
    ? beautician[setting.where.column]
    : (beautician[setting.where.json] || {})[setting.where.key];
  return raw === undefined || raw === null ? setting.default : raw;
}

/**
 * Coerce whatever the model produced into the setting's type, or explain why
 * it cannot be. A model asked for a boolean will sometimes answer "on".
 */
export function coerceValue(setting, value) {
  if (setting.type === 'boolean') {
    if (typeof value === 'boolean') return { ok: true, value };
    const s = String(value).trim().toLowerCase();
    if (['true', 'on', 'yes', 'enabled', '1'].includes(s)) return { ok: true, value: true };
    if (['false', 'off', 'no', 'disabled', '0'].includes(s)) return { ok: true, value: false };
    return { ok: false, why: `${setting.label} is on or off.` };
  }
  if (setting.type === 'enum') {
    const s = String(value).trim().toLowerCase();
    if (setting.values.includes(s)) return { ok: true, value: s };
    return { ok: false, why: `${setting.label} can be ${setting.values.join(' or ')}.` };
  }
  if (setting.type === 'number') {
    const n = Number(value);
    if (!Number.isFinite(n)) return { ok: false, why: `${setting.label} needs a number.` };
    if (setting.min !== undefined && n < setting.min) return { ok: false, why: `${setting.label} cannot be less than ${setting.min}.` };
    if (setting.max !== undefined && n > setting.max) return { ok: false, why: `${setting.label} cannot be more than ${setting.max}.` };
    return { ok: true, value: n };
  }
  return { ok: false, why: 'I do not know how to set that.' };
}

/** How to say the new state back to her, in her words rather than the column's. */
export function describeValue(setting, value) {
  if (setting.said) return setting.said(value);
  if (setting.type === 'boolean') return value ? setting.onSaid : setting.offSaid;
  return `${setting.label} is now ${value}.`;
}

/**
 * The catalogue, rendered for the tool description so the model knows what
 * exists without a second round trip. Generated rather than written out, so a
 * new setting is one entry above and nothing else.
 */
export function renderCatalogue() {
  return SETTINGS.map(s => {
    const type = s.type === 'enum' ? `one of ${s.values.join('/')}`
      : s.type === 'number' ? `a number ${s.min}-${s.max}`
      : 'on or off';
    return `- ${s.id} (${type}): ${s.label}. She might say: ${s.says.slice(0, 3).map(x => `"${x}"`).join(', ')}.`;
  }).join('\n');
}

/**
 * The patch to apply. Returns the whole jsonb object for a json setting,
 * because a partial update would drop her other keys — the settings page
 * merges for the same reason.
 */
export function buildUpdate(setting, value, beautician) {
  if (setting.where.column) return { [setting.where.column]: value };
  const current = beautician[setting.where.json] || {};
  return { [setting.where.json]: { ...current, [setting.where.key]: value } };
}
