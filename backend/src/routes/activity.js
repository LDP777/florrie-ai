import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../lib/logger.js';

const router = Router();

/**
 * GET /api/activity/feed?limit=50
 *
 * Day 1 of the 2026-05-28 refactor sprint. Returns the user-facing activity
 * feed surfaced on the Hub. Each row is a single thing Florrie did for the
 * beautician, ordered newest first.
 *
 * The underlying ai_actions table already has summary + action_type +
 * client_id + appointment_id, so we compute link_to + icon hint server-side
 * rather than adding new columns. Keeps schema churn at zero.
 */
router.get('/feed', requireAuth, async (req, res) => {
  const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 50));

  const { data, error } = await supabase
    .from('ai_actions')
    .select(`
      id,
      action_type,
      digital_employee,
      summary,
      details,
      client_id,
      appointment_id,
      message_id,
      outcome,
      created_at,
      clients ( first_name, last_name ),
      appointments ( starts_at )
    `)
    .eq('beautician_id', req.beautician.id)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    logger.error({ err: error }, 'Failed to fetch activity feed');
    return res.status(500).json({ error: 'Something went wrong' });
  }

  const rows = (data || []).map(shape);

  // Dedupe by summary: the heartbeat can log the same line repeatedly.
  const seen = new Set();
  const deduped = rows.filter(r => (seen.has(r.summary) ? false : (seen.add(r.summary), true)));

  res.json({ rows: deduped, count: deduped.length });
});

/**
 * GET /api/activity/stats
 * Cumulative proof-of-work counts for milestone moments (first booking,
 * 100th message handled, ...). Cheap head-only counts, no rows fetched.
 */
router.get('/stats', requireAuth, async (req, res) => {
  try {
    const bid = req.beautician.id;
    const countOf = async (extra) => {
      let q = supabase
        .from('ai_actions')
        .select('id', { count: 'exact', head: true })
        .eq('beautician_id', bid);
      if (extra) q = extra(q);
      const { count, error } = await q;
      if (error) throw error;
      return count || 0;
    };
    const [total, messages, bookings, gaps] = await Promise.all([
      countOf(null),
      countOf(q => q.eq('action_type', 'message_replied')),
      countOf(q => q.eq('action_type', 'booking_created')),
      countOf(q => q.in('action_type', ['gap_fill', 'gap_fill_waitlist', 'gap_fill_rebook', 'gap_fill_dormant', 'gap_fill_rebook_overdue', 'cancellation_filled']).eq('outcome', 'success')),
    ]);
    res.json({ total_actions: total, messages_handled: messages, bookings_created: bookings, gaps_closed: gaps });
  } catch (err) {
    logger.error({ err }, 'Failed to compute activity stats');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * Shape an ai_actions row into the lightweight activity-feed contract.
 * Keep this pure so it's easy to unit-test later.
 */
function shape(row) {
  return {
    id: row.id,
    type: row.action_type,
    digital_employee: row.digital_employee,
    summary: row.summary || friendlySummary(row),
    created_at: row.created_at,
    client_id: row.client_id,
    appointment_id: row.appointment_id,
    link_to: resolveLink(row),
    outcome: row.outcome || null,
  };
}

function friendlySummary(row) {
  const who = clientName(row);
  switch (row.action_type) {
    case 'message_replied':       return `Florrie replied to ${who || 'a client'}`;
    case 'message_escalated':     return `Florrie escalated a message to you`;
    case 'booking_created':       return who ? `Booked ${who}` : 'New booking created';
    case 'booking_rescheduled':   return who ? `Rescheduled ${who}` : 'Booking moved';
    case 'cancellation_filled':   return 'Filled a cancelled slot';
    case 'waitlist_offered':      return `Offered a slot to ${who || 'someone on the waitlist'}`;
    case 'client_reactivated':    return who ? `Re-engaged ${who}` : 'Re-engaged a dormant client';
    case 'content_drafted':       return 'Drafted a social post for you';
    case 'content_posted':        return 'Posted to social';
    case 'expense_logged':        return 'Logged an expense';
    case 'review_requested':      return who ? `Asked ${who} for a review` : 'Asked a client for a review';
    case 'campaign_drafted':      return 'Drafted a campaign';
    case 'campaign_sent':         return 'Sent a campaign';
    case 'price_suggestion':      return 'Suggested a price change';
    case 'voice_note_processed':  return 'Processed a voice note';
    case 'client_profile_updated':return who ? `Updated ${who}'s profile` : 'Updated a client profile';
    case 'dormant_detected':      return who ? `Spotted ${who} going quiet` : 'Spotted a dormant client';
    case 'quiet_week_detected':   return 'Spotted a quiet week ahead';
    case 'contraindication_flagged': return who ? `Flagged a contraindication on ${who}` : 'Flagged a contraindication';
    case 'appointment_padded':    return 'Padded a booking';
    case 'bundle_suggested':      return who ? `Suggested a bundle for ${who}` : 'Suggested a bundle';
    case 'predictive_nudge':      return who ? `Nudged ${who} to rebook` : 'Sent a rebook nudge';
    case 'rebook_nudge':          return who ? `Reminded ${who} to rebook` : 'Sent a rebook reminder';
    case 'value_coaching':        return 'Spotted a pricing opportunity';
    case 'booking_auto_cancelled':return 'Auto-cancelled an unpaid booking';
    case 'referral_rewarded':     return who ? `Rewarded ${who}'s referral` : 'Issued a referral reward';
    case 'gap_post':              return 'Drafted a post to fill a gap';
    case 'gap_fill':
    case 'gap_fill_waitlist':
    case 'gap_fill_rebook':
    case 'gap_fill_dormant':      return who ? `Offered ${who} a freed-up slot` : 'Filled a calendar gap';
    default:                      return 'Florrie did something';
  }
}

function clientName(row) {
  const c = row.clients;
  if (!c) return null;
  const first = c.first_name?.trim();
  const last  = c.last_name?.trim();
  if (first && last) return `${first} ${last}`;
  return first || last || null;
}

function resolveLink(row) {
  const cid = row.client_id;
  // Prefer the appointment's actual day so a booking row opens the calendar on
  // the day of the appointment, not the day Florrie happened to log the action.
  const apptDay = row.appointments?.starts_at ? String(row.appointments.starts_at).slice(0, 10) : null;
  const day = apptDay || (row.created_at || '').slice(0, 10);
  const calendarDay = day
    ? `/calendar/week?date=${day}${row.appointment_id ? `&appt=${row.appointment_id}` : ''}`
    : (row.appointment_id ? `/calendar/week?appt=${row.appointment_id}` : '/calendar/week');
  // Florrie is conversation-first: one thread per client, so the client's thread
  // is the right landing for anything message/relationship related. There is no
  // /clients/:id page, so never link there.
  const thread = cid ? `/inbox?client=${cid}` : '/inbox';

  // Daily-heartbeat "check" rows route to the page that proves the count.
  const check = row.details?.check;
  switch (check) {
    case 'calendar_lookahead':
    case 'overnight_booking_watch': return '/calendar/week';
    case 'dormant_scan':            return '/clients?filter=dormant';
    case 'client_list_scan':        return '/clients';
    case 'inbox_watch':             return '/inbox';
  }

  switch (row.action_type) {
    // → the actual conversation
    case 'message_replied':
    case 'message_escalated':
    case 'client_reactivated':
    case 'predictive_nudge':
    case 'rebook_nudge':
      return thread;
    case 'review_requested':
      return cid ? thread : '/reviews';

    // → the calendar (on the action's day when it concerns a booking)
    case 'booking_created':
    case 'booking_rescheduled':
    case 'cancellation_filled':
    case 'waitlist_offered':
    case 'appointment_padded':
    case 'booking_auto_cancelled':
    case 'gap_fill':
    case 'gap_fill_waitlist':
    case 'gap_fill_rebook':
    case 'gap_fill_dormant':
      return row.appointment_id ? calendarDay : '/calendar/week';
    case 'quiet_week_detected':
      return '/calendar/week';

    // → content / marketing
    case 'content_drafted':
    case 'content_posted':
    case 'gap_post':
      return '/content';
    case 'campaign_drafted':
    case 'campaign_sent':
      return '/campaigns';

    // → money / pricing
    case 'expense_logged':
      return '/expenses';
    case 'price_suggestion':
      return '/treatments';
    case 'value_coaching':
      return '/money';

    // → clients
    case 'dormant_detected':
      return '/clients?filter=dormant';
    case 'client_profile_updated':
    case 'contraindication_flagged':
      return cid ? thread : '/clients';
    case 'bundle_suggested':
      return '/packages';
    case 'referral_rewarded':
      return '/referrals';
    case 'voice_note_processed':
      return '/voice';

    default:
      // Sensible fallback based on what the row references.
      if (row.appointment_id) return calendarDay;
      if (cid) return thread;
      return null;
  }
}

export default router;
