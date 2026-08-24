/**
 * Week in review
 *
 * Sunday evening, story-shaped: "This week I answered 47 messages, filled 3
 * gaps, brought back 2 clients, saved you about 6 hours." One push linking
 * to /week-review, which renders a Florrie-branded card built to screenshot
 * and share. That screenshot in a beautician group chat is the growth loop.
 *
 * Driven by the hourly tick in index.js: fires once per ISO week per
 * beautician, Sunday 18:00-21:00 her time. Pref key: weekly_review.
 */
import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import { pushTeamUpdate } from './push-notifications.js';

function isoWeek(d = new Date()) {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (date.getUTCDay() + 6) % 7;
  date.setUTCDate(date.getUTCDate() - dayNum + 3);
  const firstThursday = new Date(Date.UTC(date.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((date - firstThursday) / 86400000 - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

/**
 * Compute the week's story stats for one beautician. Exported so the
 * /api/activity/week-review endpoint renders the same numbers the push
 * described. Week = last 7 days ending now.
 */
export async function computeWeekReview(beauticianId) {
  const to = new Date();
  const from = new Date(to.getTime() - 7 * 86400000);
  const fromIso = from.toISOString();
  const toIso = to.toISOString();

  const [msgRes, actionsRes, apptsRes, txRes, bookingsRes] = await Promise.all([
    supabase.from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('beautician_id', beauticianId)
      .eq('direction', 'outbound')
      .eq('ai_handled', true)
      .gte('created_at', fromIso).lt('created_at', toIso),
    supabase.from('ai_actions')
      .select('action_type, client_id, created_at')
      .eq('beautician_id', beauticianId)
      .gte('created_at', fromIso).lt('created_at', toIso)
      .limit(2000),
    supabase.from('appointments')
      .select('id, client_id, created_at')
      .eq('beautician_id', beauticianId)
      .gte('created_at', fromIso).lt('created_at', toIso)
      .neq('status', 'cancelled'),
    supabase.from('transactions')
      .select('amount_cents')
      .eq('beautician_id', beauticianId)
      .gte('created_at', fromIso).lt('created_at', toIso),
    supabase.from('appointments')
      .select('id', { count: 'exact', head: true })
      .eq('beautician_id', beauticianId)
      .eq('booked_via', 'booking_page')
      .gte('created_at', fromIso).lt('created_at', toIso),
  ]);

  const messagesAnswered = msgRes.count || 0;
  const actions = actionsRes.data || [];
  const appts = apptsRes.data || [];

  // Gaps filled / clients brought back use the SAME attribution as the value
  // receipt (usage.js): a booking only counts if it landed within the window
  // after a real offer to that client, one credit per booking. Raw action
  // counts overstate wildly (every engine log line is an action).
  const credited = new Set();
  let gapsFilled = 0;
  let broughtBack = 0;
  for (const action of actions) {
    const type = String(action.action_type || '');
    const isGap = type.startsWith('gap_fill');
    const isRebook = type === 'rebook_nudge' || type === 'comeback';
    if ((!isGap && !isRebook) || !action.client_id) continue;
    const windowMs = (isGap ? 48 : 168) * 3600 * 1000;
    const t0 = new Date(action.created_at).getTime();
    for (const appt of appts) {
      if (appt.client_id !== action.client_id || credited.has(appt.id)) continue;
      const dt = new Date(appt.created_at).getTime() - t0;
      if (dt >= 0 && dt <= windowMs) {
        credited.add(appt.id);
        if (isGap) gapsFilled++;
        else broughtBack++;
      }
    }
  }

  // "Handled" = real front-desk work, not engine diagnostics.
  const REAL_WORK = new Set(['message_replied', 'booking_created', 'booking_confirmed', 'booking_auto_cancelled', 'rebook_nudge', 'comeback', 'review_request', 'aftercare_sent', 'content_posted']);
  const realActions = actions.filter(a => REAL_WORK.has(a.action_type) || String(a.action_type).startsWith('gap_fill')).length;
  const totalHandled = realActions + messagesAnswered;
  const takingsPence = (txRes.data || []).reduce((s, t) => s + (t.amount_cents || 0), 0);
  const bookingsTaken = bookingsRes.count || 0;

  // Honest time estimate: ~3 min per handled message, ~5 min per real action.
  //
  // This used to be Math.max(1, ...), so a week in which Florrie did precisely
  // nothing still reported "about 1 hour saved", and the share card printed it
  // under the "A quiet week" headline. A floor on a derived number is a lie
  // with a nice bedside manner: it is worst for a brand new account, where the
  // very first thing the product says about itself is untrue. No floor. Zero
  // work is zero minutes, and minutes_saved goes out alongside the rounded
  // hours so the card can say "40 minutes" instead of rounding it to nothing
  // or up to an hour.
  const minutesSaved = messagesAnswered * 3 + realActions * 5;

  return {
    from: fromIso.slice(0, 10),
    to: toIso.slice(0, 10),
    messages_answered: messagesAnswered,
    gaps_filled: gapsFilled,
    brought_back: broughtBack,
    bookings_taken: bookingsTaken,
    total_handled: totalHandled,
    takings_pence: takingsPence,
    minutes_saved: minutesSaved,
    hours_saved: Math.round(minutesSaved / 60),
  };
}

/**
 * "about 40 minutes" / "about 2 hours", or null when nothing was saved.
 *
 * Null is the point: every caller has to decide what to say when the honest
 * answer is nothing, instead of being handed a "0" or a rounded-up "1" to
 * print unchallenged.
 *
 * @param {number} minutes
 * @returns {string|null}
 */
export function formatTimeSaved(minutes) {
  const m = Math.round(Number(minutes) || 0);
  if (m <= 0) return null;
  if (m < 60) return `${m} minute${m === 1 ? '' : 's'}`;
  const hours = Math.round(m / 60);
  return `${hours} hour${hours === 1 ? '' : 's'}`;
}

function buildPushCopy(stats) {
  const bits = [];
  if (stats.messages_answered > 0) bits.push(`answered ${stats.messages_answered} message${stats.messages_answered === 1 ? '' : 's'}`);
  if (stats.gaps_filled > 0) bits.push(`filled ${stats.gaps_filled} gap${stats.gaps_filled === 1 ? '' : 's'}`);
  if (stats.brought_back > 0) bits.push(`brought back ${stats.brought_back} client${stats.brought_back === 1 ? '' : 's'}`);
  if (!bits.length) return null; // a quiet week sends nothing
  const saved = formatTimeSaved(stats.minutes_saved);
  return `This week I ${bits.join(', ')}${saved ? ` and saved you about ${saved}` : ''}. Have a look 🌸`;
}

/**
 * Hourly tick: Sunday evening (18:00-21:00 salon time), once per ISO week.
 */
export async function runWeekInReview() {
  const { data: beauticians, error } = await supabase
    .from('beauticians')
    .select('id, timezone')
    .limit(500);
  if (error) {
    logger.warn({ err: error }, 'week in review: beautician list failed');
    return { sent: 0 };
  }

  const week = isoWeek();
  let sent = 0;

  for (const b of beauticians || []) {
    try {
      const fmt = new Intl.DateTimeFormat('en-GB', {
        timeZone: b.timezone || 'Europe/London',
        hour: '2-digit', hour12: false, weekday: 'long',
      });
      const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
      if (parts.weekday !== 'Sunday') continue;
      const hour = parseInt(parts.hour, 10);
      if (hour < 18 || hour >= 21) continue;

      const { data: prior } = await supabase
        .from('florrie_decisions')
        .select('id')
        .eq('beautician_id', b.id)
        .eq('suggestion_type', 'week_in_review')
        .contains('suggestion_payload', { week })
        .limit(1);
      if (prior?.length) continue;

      const stats = await computeWeekReview(b.id);
      const copy = buildPushCopy(stats);

      const { error: markErr } = await supabase.from('florrie_decisions').insert({
        beautician_id: b.id,
        suggestion_type: 'week_in_review',
        suggestion_payload: { week, ...stats, skipped: !copy },
        // must satisfy the response CHECK (yes/no/tweak/dismissed)
        response: copy ? 'yes' : 'no',
        acted_on: !!copy,
      });
      if (markErr) {
        logger.error({ err: markErr, beauticianId: b.id }, 'week in review: dedupe insert FAILED, skipping push to avoid repeats');
        continue;
      }

      if (copy) {
        await pushTeamUpdate(b.id, 'weekly_review', copy, { url: '/week-review' });
        sent++;
      }
    } catch (err) {
      logger.warn({ err, beauticianId: b.id }, 'week in review: one beautician failed');
    }
  }

  if (sent) logger.info({ sent }, 'week in review: run complete');
  return { sent };
}
