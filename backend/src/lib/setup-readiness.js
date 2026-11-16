// A read-only checklist. Completing setup never enables replies or blocks work.
import { cancellationNoticeHours } from './booking-policy.js';

export function validWorkingHours(hours) {
  const time = value => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);
  return !!hours && typeof hours === 'object' && ['mon','tue','wed','thu','fri','sat','sun'].some(day => {
    const value = hours[day];
    return value && time(value.start) && time(value.end) && value.start < value.end;
  });
}
export function setupChecklist(status, owner) {
  const items = [];
  const add = (key, group, label, complete, detail, path, optional = false) => items.push({ key, group, label,
    state: complete == null ? 'unknown' : complete ? 'ready' : 'todo', detail, path, optional });
  const b = status.business, s = status.services;
  add('name', 'Your booking page', 'Business details', b.name, 'The name clients see on your booking page and messages.', '/business');
  add('treatments', 'Your booking page', 'Treatments, prices & duration', s.bookable_count == null ? null : s.bookable_count > 0 && s.incomplete_count === 0,
    s.bookable_count == null ? 'We could not check your treatments. Try again.' : `${s.bookable_count} ready to book${s.incomplete_count ? `; ${s.incomplete_count} need a price or duration` : ''}.`, '/treatments');
  add('hours', 'Your booking page', 'Working hours', b.hours, 'At least one working day with a valid start and finish time.', '/settings?section=hours');
  add('policy', 'Your booking page', 'Cancellation terms', true,
    `${cancellationNoticeHours(owner.booking_policy)} hours’ notice. Late-cancellation fee: ${Math.max(0, Math.min(100, Number(owner.booking_policy?.late_cancel_charge_percent) || 0))}%. Check these terms before sharing your link.`, '/settings?section=policy');
  add('link', 'Your booking page', 'Booking link', b.booking_slug, b.slug ? `florrie.ai/book/${b.slug}` : 'Choose a short link for clients to book.', '/business?tab=booking');
  add('branding', 'Make it yours', 'Your logo', !!owner.logo_url, 'Add your logo to the client booking page.', '/business?tab=branding', true);
  add('care', 'Before appointments', 'Consultation forms', s.missing_forms == null ? null : s.missing_forms === 0,
    s.missing_forms == null ? 'Could not check required forms.' : s.missing_forms ? `${s.missing_forms} treatments require a form but do not have one attached.` : 'Required consultation forms are attached. Review patch-test requirements in Treatments.', '/treatments');
  add('stripe', 'Payments', 'Card payments', status.money.stripe,
    status.money.stripe ? 'Stripe onboarding is complete. Check the live payment status in Payments.' : 'Finish Stripe setup to collect card payments.', '/settings?section=payments', s.deposits === false);
  add('connections', 'Messages', 'Connect & check an enquiry', status.channels.test_receipt == null ? null : !!status.channels.test_receipt, status.channels.test_receipt ? `A ${status.channels.test_receipt.channel === 'instagram' ? 'Instagram' : 'WhatsApp'} test enquiry arrived on ${new Date(status.channels.test_receipt.received_at).toLocaleDateString('en-GB', { timeZone: 'UTC' })}. Check connection health in Connections.` : 'Check account access, then prove that a test message reaches your Inbox.', '/connections', true);
  add('replies', 'Messages', 'Choose how Florrie replies', true, status.replies.summary, '/settings?section=ai', true);
  return { items, done: items.filter(i => !i.optional && i.state === 'ready').length,
    total: items.filter(i => !i.optional).length };
}
export function replySettings(owner) {
  const paused = owner.client_reminder_prefs?.paused === true;
  const automatic = owner.auto_reply_enabled === true;
  const instagram = ['ai', 'redirect', 'off'].includes(owner.instagram_dm_mode) ? owner.instagram_dm_mode : 'off';
  return { paused, automatic, instagram, booking_help: owner.autonomy?.grounded_replies !== false,
    summary: paused ? 'Messaging is paused in your settings.' : automatic
      ? 'WhatsApp and SMS new-enquiry replies are enabled. Per-client choices and safety checks still apply.'
      : 'WhatsApp and SMS new-enquiry replies are off. Existing booking requests can still receive help when grounded replies are enabled.' };
}
export function validateConnectionProof(query, now = Date.now()) {
  const { channel, code, since } = query;
  if (!['instagram', 'whatsapp'].includes(channel) || typeof code !== 'string' || !/^FLORRIE-[A-F0-9]{12}$/.test(code)
    || typeof since !== 'string') return null;
  const start = Date.parse(since);
  if (!Number.isFinite(start) || start > now + 60000 || start < now - 86400000) return null;
  return { channel, code, since: new Date(start).toISOString() };
}
