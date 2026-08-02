/**
 * Friendly display layer for WhatsApp templates.
 *
 * Beauticians shouldn't see Meta plumbing: snake_case names, {{1}} placeholders,
 * MARKETING/UTILITY, language codes, or the hello_world test template. This maps
 * the templates we ship to a human label + one-line blurb + a readable example,
 * and cleans up custom ones. The real Meta template name is still what gets sent,
 * this is display only.
 *
 * v3 entries are the old personalised pack (salon name baked into the body).
 * v4 is the shared pack every salon uses: the salon name is passed with each
 * send instead of being written into the body, which is what stops one salon's
 * name reaching another salon's clients. Both take their preview from the REAL
 * body text rather than canned copy.
 */
const KNOWN = {
  booking_confirmation_v2: { label: 'Booking confirmation', blurb: 'Confirms an appointment',
    preview: "Hi Sarah, your appointment is confirmed for Friday at 2pm. We can't wait to see you." },
  reminder_24h_v2: { label: '24-hour reminder', blurb: 'Reminds a client the day before',
    preview: "Hi Sarah, just a reminder your appointment is tomorrow at 2pm. See you then. Reply to reschedule if needed." },
  gap_fill_offer_v2: { label: 'Last-minute gap offer', blurb: 'Offers a freed-up slot',
    preview: "Hi Sarah, we have a last-minute gap on Friday at 2pm. Want to grab it? Reply YES to book, or let me know if you'd prefer another time." },
  rebook_nudge_v2: { label: 'Rebook invite', blurb: 'Invites a client to book again',
    preview: "Hi Sarah, it's been a little while. Fancy getting booked back in? Reply and I'll find you a time." },
  generic_message_v2: { label: 'Quick hello', blurb: 'A friendly general message',
    preview: "Hi Sarah, hope to see you soon." },
  // Personalised set, preview built from the real body text below.
  booking_confirmation_v3: { label: 'Booking confirmation', blurb: 'Confirms an appointment, signed with your name' },
  reminder_24h_v3: { label: '24-hour reminder', blurb: 'Reminds a client the day before, signed with your name' },
  gap_fill_offer_v3: { label: 'Last-minute gap offer', blurb: 'Offers a freed-up slot, signed with your name' },
  rebook_nudge_v3: { label: 'Rebook invite', blurb: 'Invites a client back, signed with your name' },
  generic_message_v3: { label: 'Quick hello', blurb: 'A friendly general message, signed with your name' },
  // Shared set, preview built from the real body text below.
  booking_confirmation_v4: { label: 'Booking confirmation', blurb: 'Confirms an appointment, signed with your name' },
  reminder_24h_v4: { label: '24-hour reminder', blurb: 'Reminds a client the day before, signed with your name' },
  gap_fill_offer_v4: { label: 'Last-minute gap offer', blurb: 'Offers a freed-up slot, signed with your name' },
  rebook_nudge_v4: { label: 'Rebook invite', blurb: 'Invites a client back, signed with your name' },
  generic_message_v4: { label: 'Quick hello', blurb: 'A friendly general message, signed with your name' },
};

/**
 * What each {{n}} slot means, per template. The salon name became a parameter
 * in v4 and it sits in a different position per message, so one shared list
 * would label a date as a salon name in the preview.
 */
const SLOTS_BY_NAME = {
  booking_confirmation_v4: ['client name', 'your salon name', 'date', 'time'],
  reminder_24h_v4: ['client name', 'your salon name', 'treatment', 'time'],
  gap_fill_offer_v4: ['client name', 'your salon name', 'day', 'time'],
  rebook_nudge_v4: ['client name', 'your salon name'],
  generic_message_v4: ['client name', 'your salon name', 'message'],
  reminder_24h_v3: ['client name', 'treatment', 'time'],
  gap_fill_offer_v3: ['client name', 'day', 'time'],
  rebook_nudge_v3: ['client name'],
  generic_message_v3: ['client name', 'message'],
};
const HIDDEN = new Set(['hello_world', 'test_template_for_deletion_demo', 'test_template_for_deletion_de']);

export function isClientTemplate(name) {
  return !HIDDEN.has((name || '').toLowerCase());
}

export function isPersonalised(name) {
  return /_v[34]$/.test((name || '').toLowerCase());
}

/** The base set every salon should have, used to decide if the starter pack is done. */
export const STARTER_NAMES = [
  'booking_confirmation_v4',
  'reminder_24h_v4',
  'gap_fill_offer_v4',
  'rebook_nudge_v4',
  'generic_message_v4',
];

/** The base name without its version suffix. */
export function templateBase(name) {
  return (name || '').toLowerCase().replace(/_v\d+$/, '');
}

function titleise(name) {
  return (name || '').replace(/_v\d+$/, '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim() || 'Template';
}

function bodyText(t) {
  if (Array.isArray(t.components)) {
    return t.components.find(c => (c.type || '').toUpperCase() === 'BODY')?.text || '';
  }
  return t.body || '';
}

// Turn raw {{n}} placeholders into readable tokens. The named slots cover the
// templates we ship; anything else collapses to a neutral token.
const SLOT_WORDS = ['client name', 'date', 'time'];
export function humanise(text, slots = SLOT_WORDS) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n) => {
      const i = parseInt(n, 10) - 1;
      return slots[i] ? `[${slots[i]}]` : '[…]';
    })
    .replace(/\{+\s*\d+[^{}]*\}+/g, '[…]')
    .trim();
}

export function templateDisplay(t) {
  const name = (t.name || '').toLowerCase();
  const known = KNOWN[name];
  if (known) {
    return { ...known, preview: known.preview || humanise(bodyText(t), SLOTS_BY_NAME[name] || SLOT_WORDS) };
  }
  return { label: titleise(t.name), blurb: 'Your custom template', preview: humanise(bodyText(t)) };
}
