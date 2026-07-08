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

  const [msgRes, actionsRes, txRes, bookingsRes] = await Promise.all([
    supabase.from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('beautician_id', beauticianId)
      .eq('direction', 'outbound')
      .eq('ai_handled', true)
      .gte('created_at', fromIso).lt('created_at', toIso),
    supabase.from('ai_actions')
      .select('action_type')
      .eq('beautician_id', beauticianId)
      .gte('created_at', fromIso).lt('created_at', toIso)
      .limit(2000),
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
  const gapsFilled = actions.filter(a => String(a.action_type).startsWith('gap_fill')).length;
  const broughtBack = actions.filter(a => ['rebook_nudge', 'comeback', 'gap_fill_dormant_rescue'].includes(a.action_type)).length;
  const totalHandled = actions.length + messagesAnswered;
  const takingsPence = (txRes.data || []).reduce((s, t) => s + (t.amount_cents || 0), 0);
  const bookingsTaken = bookingsRes.count || 0;

  // Honest time estimate: ~3 min per handled message, ~5 min per admin action.
  const minutesSaved = messagesAnswered * 3 + actions.length * 5;
  const hoursSaved = Math.max(1, Math.round(minutesSaved / 60));

  return {
    from: fromIso.slice(0, 10),
    to: toIso.slice(0, 10),
    messages_answered: messagesAnswered,
    gaps_filled: gapsFilled,
    brought_back: broughtBack,
    bookings_taken: bookingsTaken,
    total_handled: totalHandled,
    takings_pence: takingsPence,
    hours_saved: hoursSaved,
  };
}

function buildPushCopy(stats) {
  const bits = [];
  if (stats.messages_answered > 0) bits.push(`answered ${stats.messages_answered} message${stats.messages_answered === 1 ? '' : 's'}`);
  if (stats.gaps_filled > 0) bits.push(`filled ${stats.gaps_filled} gap${stats.gaps_filled === 1 ? '' : 's'}`);
  if (stats.brought_back > 0) bits.push(`brought back ${stats.brought_back} client${stats.brought_back === 1 ? '' : 's'}`);
  if (!bits.length) return null; // a quiet week sends nothing
  return `This week I ${bits.join(', ')} and saved you about ${stats.hours_saved} hour${stats.hours_saved === 1 ? '' : 's'}. Have a look 🌸`;
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

      await supabase.from('florrie_decisions').insert({
        beautician_id: b.id,
        suggestion_type: 'week_in_review',
        suggestion_payload: { week, ...stats },
        response: copy ? 'sent' : 'skipped_quiet_week',
        acted_on: !!copy,
      });

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
