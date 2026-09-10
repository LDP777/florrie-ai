/** Direct appointment requests are service work, irrespective of visit count. */
const CHANGE = /\b(?:reschedul(?:e|ing)|rearrang(?:e|ing)|mov(?:e|ing)|chang(?:e|ing)|cancel(?:ling)?)\b/i;
const BOOKING = /\b(?:appointment|booking|booked|appt|slot|today|tomorrow)\b/i;
const REQUEST = /\b(?:can|could|would|please|need|want|able|possible|have to|hoping|looking to)\b/i;
const CANNOT_ATTEND = /\b(?:can'?t|cannot|unable to|won'?t be able to)\s+(?:make|attend|come)(?:\s+it)?\b/i;
const ALTERNATIVE = /\b(?:can|could|would)\b.{0,70}\b(?:instead|another day|another time|earlier|later)\b/i;
const MOVE_REQUEST = /\b(?:can|could|need to|have to|able to)\s+(?:i |we |you )?(?:move|rearrange|reschedule)\b/i;
const ALREADY_DONE = /\b(?:thanks? (?:you )?for|thank you for|already|just|have|i'?ve|you'?ve|you)\s+(?:rescheduled|rescheduling|rearranged|rearranging|moved|moving|changed|changing|cancelled|cancelling)\b/i;

export function appointmentChangeIntent(message, classification = null) {
  const text = String(message || '').replace(/’/g, "'").trim();
  if (!text || (ALREADY_DONE.test(text) && !REQUEST.test(text))) return null;
  if (/\b(?:don't|do not|no need to|not to)\s+(?:cancel|move|change|reschedule)\b/i.test(text)) return null;
  if (/\b(?:course|training|enrol|enroll|order|subscription|house|flat|furniture)\b/i.test(text)) return null;
  const asksToChange = CHANGE.test(text) && (BOOKING.test(text) || /\breschedule\b/i.test(text));
  if (!asksToChange && !CANNOT_ATTEND.test(text) && !ALTERNATIVE.test(text) && !MOVE_REQUEST.test(text)) {
    // The classifier has the transcript for requests phrased indirectly.
    // A short agreement or thank-you must not reopen the previous change.
    if (text.length > 20 && !/^(?:yes|yeah|yep|thanks|thank you|perfect|no problem)\b/i.test(text)
      && classification?.confidence >= 0.8 && ['reschedule', 'cancellation'].includes(classification.intent)) return classification.intent;
    return null;
  }
  return /\bcancel(?:ling)?\b/i.test(text) ? 'cancellation' : 'reschedule';
}

// The switch is labelled "new enquiries". Existing booking admin still reaches
// the front desk; its pause, human-only and drafts checks still decide delivery.
export function shouldProcessInbound(beautician, message) {
  return !!beautician.auto_reply_enabled || (
    beautician.autonomy?.grounded_replies !== false && !!appointmentChangeIntent(message)
  );
}

function wallNow(now, timezone) {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now)).reduce((a, x) => (a[x.type] = x.value, a), {});
  return Date.parse(`${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}Z`);
}

/** Plans a reply only. This function never moves a booking or waives a fee. */
export function planAppointmentChange({ message, classification, context, beautician, now = Date.now() }) {
  const intent = appointmentChangeIntent(message, classification);
  if (!intent) return null;
  const owner = beautician.first_name || 'the salon';
  const plan = { intent, reply: '', needsOwner: true, reason: '', appointmentId: null };
  const rows = context.clientUpcoming || [];
  const handoff = (reason, reply) => ({ ...plan, reason, reply });
  if (context.clientUpcomingReadable === false) {
    return handoff('diary_unavailable', `I couldn't check your booking just now. Your request is in ${owner}'s inbox for review. I haven't changed or cancelled anything.`);
  }
  if (rows.length !== 1) {
    return handoff(rows.length ? 'booking_unclear' : 'booking_not_found',
      `Which date and treatment do you need to change? Your request is in ${owner}'s inbox for review. I haven't changed or cancelled anything.`);
  }
  const appt = rows[0];
  plan.appointmentId = appt.id;
  const remaining = (Date.parse(appt.starts_at) - wallNow(now, beautician.timezone)) / 3_600_000;
  const notice = Number((appt.policy_snapshot || beautician.booking_policy || {}).cancellation_notice_hours) || 48;
  if (!Number.isFinite(remaining) || remaining < notice || /\b(?:today|last minute|short notice)\b/i.test(message)) {
    return handoff('short_notice', `Thanks for letting us know. This is a short-notice change, so your request is in ${owner}'s inbox for review. I haven't changed or cancelled your booking, and any fees need to be checked.`);
  }
  if (beautician.booking_policy?.reschedule_once === true && appt.rescheduled_at) {
    return handoff('already_rescheduled', `This booking has already been moved once, so your request is in ${owner}'s inbox for review. I haven't changed or cancelled it.`);
  }
  if (!appt.management_token || !beautician.booking_slug || !['pending', 'confirmed'].includes(appt.status)) {
    return handoff('manage_link_unavailable', `Your request is in ${owner}'s inbox for review. I couldn't get a booking management link, so I haven't changed or cancelled anything.`);
  }
  const link = `https://florrie.ai/book/${encodeURIComponent(beautician.booking_slug)}/manage/${encodeURIComponent(appt.management_token)}`;
  return { ...plan, needsOwner: false, reason: 'booking_manage_link',
    reply: `You can ${intent === 'cancellation' ? 'cancel your booking' : 'choose a new time'} using your booking link: ${link}\nYour current booking stays in place until you confirm the change there. The booking page shows any fees before you confirm.` };
}
