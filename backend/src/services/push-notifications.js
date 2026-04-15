import webpush from 'web-push';
import { supabase } from '../config.js';
import logger from '../lib/logger.js';

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
 * Silently skips if they have no subscriptions or push isn't configured.
 */
export async function sendPush(beauticianId, { title, body, icon, url, tag, data }) {
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
  content_creator: { name: 'Content Creator', emoji: '🎨' },
  client_intel: { name: 'Client Intel', emoji: '🔮' },
  business_coach: { name: 'Business Coach', emoji: '📊' },
  scheduler: { name: 'Scheduler', emoji: '📅' },
  guardian: { name: 'Guardian', emoji: '🛡️' },
};

/**
 * Map action_type → agent id for push routing.
 */
const ACTION_TO_AGENT = {
  message_replied: 'front_desk',
  message_escalated: 'front_desk',
  booking_confirmed: 'front_desk',
  booking_rescheduled: 'front_desk',
  booking_cancelled: 'front_desk',
  content_drafted: 'content_creator',
  content_posted: 'content_creator',
  gap_post: 'content_creator',
  rebook_nudge: 'client_intel',
  predictive_nudge: 'client_intel',
  value_coaching: 'business_coach',
  booking_auto_cancelled: 'scheduler',
  review_request: 'guardian',
  follow_up: 'guardian',
  aftercare_sent: 'guardian',
};

/**
 * Send a push notification styled as a team update from a specific agent.
 * This is the primary notification method — all AI actions route through here.
 */
export async function pushTeamUpdate(beauticianId, actionType, summary, { url, clientName } = {}) {
  const agentId = ACTION_TO_AGENT[actionType] || 'front_desk';
  const agent = AGENT_PUSH[agentId] || AGENT_PUSH.front_desk;

  return sendPush(beauticianId, {
    title: `${agent.emoji} ${agent.name}`,
    body: summary,
    url: url || '/',
    tag: `team-${agentId}-${Date.now()}`,
    data: { agentId, actionType, clientName },
  });
}

export async function pushNewBooking(beauticianId, clientName, treatmentName, dateStr) {
  return pushTeamUpdate(beauticianId, 'booking_confirmed',
    `${clientName} booked ${treatmentName} for ${dateStr}`,
    { url: '/calendar', clientName }
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
