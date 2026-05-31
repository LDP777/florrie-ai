/**
 * Friendly display layer for WhatsApp templates.
 *
 * Beauticians shouldn't see Meta plumbing: snake_case names, {{1}} placeholders,
 * MARKETING/UTILITY, language codes, or the hello_world test template. This maps
 * the templates we ship to a human label + one-line blurb + a readable example,
 * and cleans up custom ones. The real Meta template name is still what gets sent,
 * this is display only.
 */
const KNOWN = {
  booking_confirmation: { label: 'Booking confirmation', blurb: 'Confirms an appointment',
    preview: "Hi Sarah, your appointment is confirmed for Friday at 2pm. We can't wait to see you." },
  reminder_24h: { label: '24-hour reminder', blurb: 'Reminds a client the day before',
    preview: "Hi Sarah, just a reminder your appointment is tomorrow at 2pm. See you then. Reply to reschedule if needed." },
  gap_fill_offer: { label: 'Last-minute gap offer', blurb: 'Offers a freed-up slot',
    preview: "Hi Sarah, we have a last-minute gap on Friday at 2pm. Want to grab it? Reply YES to book, or let me know if you'd prefer another time." },
  rebook_nudge: { label: 'Rebook invite', blurb: 'Invites a client to book again',
    preview: "Hi Sarah, it's been a little while. Fancy getting booked back in? Reply and I'll find you a time." },
  generic_message: { label: 'Quick hello', blurb: 'A friendly general message',
    preview: "Hi Sarah, hope to see you soon." },
};
const HIDDEN = new Set(['hello_world']);

export function isClientTemplate(name) {
  return !HIDDEN.has((name || '').toLowerCase());
}

function titleise(name) {
  return (name || '').replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).trim() || 'Template';
}

function bodyText(t) {
  if (Array.isArray(t.components)) {
    return t.components.find(c => (c.type || '').toUpperCase() === 'BODY')?.text || '';
  }
  return t.body || '';
}

// Turn raw / mangled {{n}} placeholders into a readable token for custom templates.
function humanise(text) {
  if (typeof text !== 'string') return '';
  return text.replace(/\{+\s*\d+[^{}]*\}+/g, '[…]').replace(/\{\{[^}]*\}\}/g, '[…]').trim();
}

export function templateDisplay(t) {
  const known = KNOWN[(t.name || '').toLowerCase()];
  if (known) return known;
  return { label: titleise(t.name), blurb: 'Your custom template', preview: humanise(bodyText(t)) };
}
