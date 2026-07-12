import webpush from 'web-push';
import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import { sendApnsToBeautician } from './apns.js';

/**
 * Web Push Notification Service.
 *
 * Uses the Web Push protocol (VAPID) to send real-time notifications
 * to beauticians' browsers/phones even when the app isn't open.
 *
 * Notification types:
 *   - New booking received
 *   - Client message (escalated from AI)
 *   - Daily earnings summary
 *   - Florrie action completed (e.g. auto-replied to 3 messages)
 *   - Review received
 */

const VAPID_PUBLIC = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
const VAPID_EMAIL = process.env.VAPID_EMAIL || 'mailto:hello@florrie.ai';

if (VAPID_PUBLIC && VAPID_PRIVATE) {
  webpush.setVapidDetails(VAPID_EMAIL, VAPID_PUBLIC, VAPID_PRIVATE);
  logger.info('Web Push configured');
} else {
  logger.debug('VAPID keys not set — push notifications disabled');
}

/**
 * Send a push notification to a beautician.
 * Fans out to BOTH channels: web push (VAPID subscriptions) and native
 * APNs (iOS app device tokens). Each leg is fail-soft: one channel being
 * down or unconfigured never blocks the other, and neither ever throws.
 */
export async function sendPush(beauticianId, { title, body, icon, url, tag, data, sound }) {
  let webResult = null;
  try {
    webResult = await sendWebPush(beauticianId, { title, body, icon, url, tag, data });
  } catch (err) {
    logger.warn({ err, beauticianId }, 'Web push fan-out failed');
  }

  // Native iOS (APNs): same title/body, deep-link url carried in data.
  try {
    await sendApnsToBeautician(beauticianId, {
      title: title || 'florrie.ai',
      body,
      data: { ...(data || {}), url: url || '/' },
      sound,
    });
  } catch (err) {
    logger.warn({ err, beauticianId }, 'APNs fan-out failed');
  }

  return webResult;
}

/**
 * Web push leg (VAPID). Silently skips if they have no subscriptions or
 * push isn't configured.
 */
async function sendWebPush(beauticianId, { title, body, icon, url, tag, data }) {
  if (!VAPID_PUBLIC || !VAPID_PRIVATE) return null;

  const { data: subs } = await supabase
    .from('push_subscriptions')
    .select('subscription')
    .eq('beautician_id', beauticianId);

  if (!subs?.length) return null;

  const payload = JSON.stringify({
    title: title || 'florrie.ai',
    body,
    icon: icon || '/favicon-192.png',
    badge: '/favicon-192.png',
    url: url || '/',
    tag: tag || 'florrie-default',
    data: data || {},
  });

  let sent = 0;
  const expired = [];

  for (const record of subs) {
    try {
      await webpush.sendNotification(record.subscription, payload);
      sent++;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        // Subscription expired — clean up
        expired.push(record.subscription.endpoint);
      } else {
        logger.warn({ err, beauticianId }, 'Push send failed');
      }
    }
  }

  // Clean up expired subscriptions
  if (expired.length) {
    for (const endpoint of expired) {
      await supabase
        .from('push_subscriptions')
        .delete()
        .eq('beautician_id', beauticianId)
        .filter('subscription->>endpoint', 'eq', endpoint);
    }
  }

  return { sent, expired: expired.length };
}

const AGENT_PUSH = {
  front_desk: { name: 'Front Desk', emoji: '💬' },
  content_creator: { name: 'Content Studio', emoji: '🎨' },
  client_intel: { name: 'Client Intel', emoji: '🔮' },
  bookkeeper: { name: 'Bookkeeper', emoji: '💷' },
  business_coach: { name: 'Biz Coach', emoji: '📊' },
  guardian: { name: 'Guardian', emoji: '🛡️' },
};

/**
 * Map action_type → agent id for push routing.
 */
const ACTION_TO_AGENT = {
  message_replied: 'front_desk',
  message_escalated: 'front_desk',
  booking_confirmed: 'front_desk',
  booking_pending: 'front_desk',
  patch_test_booked: 'front_desk',
  daily_money_summary: 'bookkeeper',
  milestone: 'business_coach',
  weekly_review: 'business_coach',
  booking_rescheduled: 'front_desk',
  booking_cancelled: 'front_desk',
  booking_auto_cancelled: 'front_desk',
  content_drafted: 'content_creator',
  content_posted: 'content_creator',
  gap_post: 'content_creator',
  rebook_nudge: 'client_intel',
  predictive_nudge: 'client_intel',
  value_coaching: 'business_coach',
  expense_logged: 'bookkeeper',
  income_logged: 'bookkeeper',
  tax_drafted: 'bookkeeper',
  receipt_processed: 'bookkeeper',
  review_request: 'guardian',
  follow_up: 'guardian',
  aftercare_sent: 'guardian',
};

/**
 * Send a push notification styled as a team update from a specific agent.
 * This is the primary notification method — all AI actions route through here.
 */
// Settings pref keys (notification_prefs JSONB on beauticians) per push type.
const ACTION_TO_PREF = {
  daily_money_summary: 'daily_summary',
  milestone: 'milestones',
  weekly_review: 'weekly_review',
  booking_confirmed: 'booking_confirmed',
  booking_pending: 'booking_confirmed',
  booking_rescheduled: 'booking_confirmed',
  patch_test_booked: 'booking_confirmed',
  booking_cancelled: 'booking_cancelled',
  booking_auto_cancelled: 'booking_cancelled',
  message_escalated: 'ai_escalation',
  message_replied: 'ai_escalation',
};

// Pushes that may wake her up regardless of quiet hours.
const URGENT_ACTIONS = new Set(['message_escalated']);

// The signature sound language: she learns to feel the difference in her
// pocket without looking. Good news = soft two-note bloom; needs-you = a
// gentler single note. Files must be bundled in the iOS target (see
// docs/NOTIFICATION_SOUNDS.md); env-gated in apns.js until they are.
const GOOD_NEWS = new Set(['booking_confirmed', 'booking_rescheduled', 'patch_test_booked', 'gap_post', 'review_request', 'daily_money_summary', 'milestone', 'weekly_review', 'value_coaching', 'income_logged']);
const NEEDS_YOU = new Set(['message_escalated', 'booking_pending', 'booking_cancelled', 'booking_auto_cancelled', 'channel_failover']);
function soundFor(actionType) {
  if (GOOD_NEWS.has(actionType)) return 'bloom-good.caf';
  if (NEEDS_YOU.has(actionType)) return 'bloom-needsyou.caf';
  return undefined; // default system sound
}

/**
 * Should this push actually fire? Enforces the per-event toggles Ellie sets
 * in Settings (which were saved but never read at send time), plus an
 * OPT-IN quiet hours window. Quiet hours default OFF (Levi, 9 Jul): a 2am
 * booking ping is Florrie proving she works while the beautician sleeps,
 * so nothing is suppressed unless she explicitly turns quiet hours on in
 * her prefs. Everything suppressed still appears in the app. Fail-open.
 */
async function shouldPush(beauticianId, actionType) {
  try {
    const { data: b } = await supabase
      .from('beauticians')
      .select('notification_prefs, timezone')
      .eq('id', beauticianId)
      .maybeSingle();
    const prefs = b?.notification_prefs || {};

    // Per-event opt-out from Settings.
    const prefKey = ACTION_TO_PREF[actionType];
    if (prefKey && prefs[prefKey] && prefs[prefKey].push === false) {
      return { send: false, reason: 'pref_off' };
    }

    if (URGENT_ACTIONS.has(actionType)) return { send: true };

    // Quiet hours: OPT-IN only. No quiet_hours pref, or enabled !== true,
    // means every push lands, whatever the hour.
    const qh = prefs.quiet_hours || {};
    if (qh.enabled !== true) return { send: true };
    const start = qh.start || '21:00';
    const end = qh.end || '08:00';
    const tz = b?.timezone || 'Europe/London';
    const hhmm = new Intl.DateTimeFormat('en-GB', {
      timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(new Date());
    const inWindow = start <= end
      ? (hhmm >= start && hhmm < end)
      : (hhmm >= start || hhmm < end);
    if (inWindow) return { send: false, reason: 'quiet_hours' };

    return { send: true };
  } catch (err) {
    logger.warn({ err, beauticianId, actionType }, 'shouldPush check failed, sending');
    return { send: true };
  }
}

// Booking events must be tellable apart at a glance, from the TITLE alone
// (Levi, 9 Jul): booked-and-paid, attempt-awaiting-deposit, and self-serve
// changes are different moments and must never share a headline.
const ACTION_TITLES = {
  booking_confirmed: '🌸 New booking',
  booking_pending: '⌛ Deposit not completed',
  booking_rescheduled: '🔁 Booking moved',
  patch_test_booked: '🩺 Patch test booked',
  booking_cancelled: 'Booking cancelled',
  booking_auto_cancelled: 'Slot released',
  message_escalated: '💬 Needs you',
  daily_money_summary: '💷 Today\u2019s takings',
  milestone: '🌸 Milestone',
  weekly_review: '🌸 Your week with Florrie',
};

export async function pushTeamUpdate(beauticianId, actionType, summary, { url, clientName } = {}) {
  const agentId = ACTION_TO_AGENT[actionType] || 'front_desk';
  const agent = AGENT_PUSH[agentId] || AGENT_PUSH.front_desk;

  const verdict = await shouldPush(beauticianId, actionType);
  if (!verdict.send) {
    logger.info({ beauticianId, actionType, reason: verdict.reason }, 'push suppressed');
    return { sent: 0, suppressed: verdict.reason };
  }

  return sendPush(beauticianId, {
    title: ACTION_TITLES[actionType] || `${agent.emoji} ${agent.name}`,
    body: summary,
    url: url || '/',
    tag: `team-${agentId}-${Date.now()}`,
    data: { agentId, actionType, clientName },
    sound: soundFor(actionType),
  });
}

export async function pushNewBooking(beauticianId, clientName, treatmentName, dateStr, { appointmentId = null, apptDate = null, pending = false } = {}) {
  // Tap the notification -> open the calendar on the appointment's day, with
  // that appointment selected. Falls back gracefully if the id/date is missing.
  //
  // pending = deposit not paid yet. Ellie was getting the exact same wording
  // for a paid booking and one still sitting at the payment screen, so she
  // could not tell them apart. Pending gets its own copy; the confirmed push
  // fires from the Stripe webhook when the money actually lands.
  const day = apptDate ? String(apptDate).slice(0, 10) : null;
  const url = appointmentId && day ? `/calendar/week?date=${day}&appt=${appointmentId}`
    : appointmentId ? `/calendar/week?appt=${appointmentId}`
    : '/calendar/week';
  if (pending) {
    // NOT a booking yet, and must never read like one.
    return pushTeamUpdate(beauticianId, 'booking_pending',
      `${clientName} is trying to book ${treatmentName} for ${dateStr}. Not confirmed until the deposit is paid.`,
      { url, clientName }
    );
  }
  return pushTeamUpdate(beauticianId, 'booking_confirmed',
    `${clientName} booked in: ${treatmentName}, ${dateStr}`,
    { url, clientName }
  );
}

export async function pushBookingConfirmed(beauticianId, clientName, treatmentName, dateStr, { appointmentId = null, apptDate = null } = {}) {
  // Deposit landed: the pending booking is now real. Fired from the Stripe
  // webhook so Ellie gets a clear second beat that the money is in.
  const day = apptDate ? String(apptDate).slice(0, 10) : null;
  const url = appointmentId && day ? `/calendar/week?date=${day}&appt=${appointmentId}`
    : appointmentId ? `/calendar/week?appt=${appointmentId}`
    : '/calendar/week';
  return pushTeamUpdate(beauticianId, 'booking_confirmed',
    `${clientName} booked in: ${treatmentName}, ${dateStr}. Deposit paid.`,
    { url, clientName }
  );
}

export async function pushReschedule(beauticianId, clientName, dateStr, { appointmentId = null, apptDate = null } = {}) {
  // A client moved their own booking via the manage link. Tap -> open the
  // calendar on the new day, with the appointment selected (same deep-link
  // shape as a new booking). Fail-soft like every other push helper.
  const day = apptDate ? String(apptDate).slice(0, 10) : null;
  const url = appointmentId && day ? `/calendar/week?date=${day}&appt=${appointmentId}`
    : appointmentId ? `/calendar/week?appt=${appointmentId}`
    : '/calendar/week';
  return pushTeamUpdate(beauticianId, 'booking_rescheduled',
    `${clientName} moved her own booking to ${dateStr} using her manage link`,
    { url, clientName }
  );
}

export async function pushPatchTestBooked(beauticianId, clientName, dateStr, { appointmentId = null, apptDate = null } = {}) {
  // A client picked her own patch test slot off the manage link. Ellie needs to
  // know it landed in her diary, not find out on the day.
  const day = apptDate ? String(apptDate).slice(0, 10) : null;
  const url = appointmentId && day ? `/calendar/week?date=${day}&appt=${appointmentId}`
    : appointmentId ? `/calendar/week?appt=${appointmentId}`
    : '/calendar/week';
  return pushTeamUpdate(beauticianId, 'patch_test_booked',
    `${clientName} booked a patch test for ${dateStr}`,
    { url, clientName }
  );
}

export async function pushEscalation(beauticianId, clientName, preview) {
  const body = preview.length > 80 ? preview.slice(0, 77) + '...' : preview;
  return pushTeamUpdate(beauticianId, 'message_escalated',
    `${clientName}: ${body}`,
    { url: '/inbox', clientName }
  );
}

export async function pushDailySummary(beauticianId, earnings, bookingsCount) {
  return pushTeamUpdate(beauticianId, 'value_coaching',
    `£${(earnings / 100).toFixed(0)} earned from ${bookingsCount} appointment${bookingsCount === 1 ? '' : 's'} today`,
    { url: '/money' }
  );
}

export async function pushFlorrieAction(beauticianId, actionType, summary) {
  return pushTeamUpdate(beauticianId, actionType || 'message_replied', summary, { url: '/' });
}

export async function pushReviewReceived(beauticianId, clientName, rating) {
  const stars = '⭐'.repeat(Math.min(rating, 5));
  return pushTeamUpdate(beauticianId, 'review_request',
    `${clientName} left a ${rating}-star review ${stars}`,
    { url: '/reviews', clientName }
  );
}

export async function pushRebookNudge(beauticianId, clientName) {
  return pushTeamUpdate(beauticianId, 'rebook_nudge',
    `Sent a rebook nudge to ${clientName} — they're overdue`,
    { url: '/clients', clientName }
  );
}

export async function pushContentDrafted(beauticianId, caption) {
  const preview = caption.length > 70 ? caption.slice(0, 67) + '...' : caption;
  return pushTeamUpdate(beauticianId, 'content_drafted',
    `Drafted a new post: "${preview}"`,
    { url: '/content' }
  );
}

export async function pushGapFilled(beauticianId, clientName, time) {
  return pushTeamUpdate(beauticianId, 'gap_post',
    `Filled your ${time} gap with ${clientName} from the waitlist`,
    { url: '/calendar', clientName }
  );
}

// Non-invasive: at most one "messages waiting" push per beautician+channel per
// 15 minutes, so a burst of client messages yields ONE calm notification.
const _msgWaitingThrottle = new Map(); // `${beauticianId}:${channel}` -> lastMs
export async function pushMessagesWaiting(beauticianId, channel) {
  if (!beauticianId) return null;
  const label = channel === 'instagram' ? 'Instagram' : channel === 'whatsapp' ? 'WhatsApp' : 'New';
  const key = `${beauticianId}:${channel}`;
  const now = Date.now();
  if (now - (_msgWaitingThrottle.get(key) || 0) < 15 * 60 * 1000) return { skipped: 'throttled' };
  _msgWaitingThrottle.set(key, now);
  return sendPush(beauticianId, {
    title: 'Florrie',
    body: `You have ${label} messages waiting for you`,
    url: '/inbox',
    tag: `messages-waiting-${channel}`,
    data: { kind: 'messages_waiting', channel },
  });
}
