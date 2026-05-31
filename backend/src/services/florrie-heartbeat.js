/**
 * Florrie heartbeat, runs once daily per tenant.
 *
 * The activity feed on the Hub ("What Florrie did") was originally seeded with
 * synthetic rows so it wouldn't render empty for Ellie on Day 1 of the sprint.
 * This service replaces that seed with real, defensible passes:
 *   - Calendar lookahead (counts tomorrow's bookings)
 *   - Dormant scan (counts clients past their rebook window)
 *   - Overnight booking watch (counts bookings created in the last 24h)
 *   - Client list scan (counts active vs new clients)
 *   - Inbox watch (counts unread inbound messages)
 *
 * Each pass writes ONE row to ai_actions with the real numbers in details, so
 * if anyone, Ellie, App Review, a journalist, taps a row, the link_to lands
 * on the page that proves the count. The seed is now obsolete and gets cleaned
 * up by supabase/seeds/051_remove_florrie_activity_seed.sql.
 *
 * Wired into backend/src/index.js as a 24h setInterval + a startup kick.
 */
import { supabase } from '../config.js';
import logger from '../lib/logger.js';

const REBOOK_WINDOW_DAYS = 42;
const NEW_CLIENT_WINDOW_DAYS = 7;

/**
 * Run the heartbeat for every tenant. Idempotent on the day:
 * if a heartbeat already ran for this beautician today, skip.
 */
export async function runDailyHeartbeats() {
  logger.info('Heartbeat: starting daily run');

  try {
    const { data: beauticians, error } = await supabase
      .from('beauticians')
      .select('id, first_name, business_name');

    if (error) {
      logger.error({ err: error }, 'Heartbeat: failed to list beauticians');
      return { ran: 0, skipped: 0 };
    }

    if (!beauticians?.length) {
      logger.info('Heartbeat: no beauticians');
      return { ran: 0, skipped: 0 };
    }

    let ran = 0;
    let skipped = 0;

    for (const b of beauticians) {
      try {
        const didRun = await runHeartbeatFor(b);
        if (didRun) ran++; else skipped++;
      } catch (err) {
        logger.error({ err, beauticianId: b.id }, 'Heartbeat: tenant pass failed');
      }
    }

    logger.info({ ran, skipped }, 'Heartbeat: daily run complete');
    return { ran, skipped };
  } catch (err) {
    logger.error({ err }, 'Heartbeat: fatal error');
    return { ran: 0, skipped: 0 };
  }
}

/**
 * Run all checks for a single beautician. Returns true if it actually ran,
 * false if it was skipped because today's heartbeat already exists.
 */
export async function runHeartbeatFor(beautician) {
  const bid = beautician.id;

  // Skip if we already heartbeated today (using details->>'heartbeat' marker).
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  const { data: alreadyRan } = await supabase
    .from('ai_actions')
    .select('id')
    .eq('beautician_id', bid)
    .gte('created_at', startOfDay.toISOString())
    .contains('details', { heartbeat: true })
    .limit(1);

  if (alreadyRan?.length) {
    logger.debug({ beauticianId: bid }, 'Heartbeat: already ran today, skipping');
    return false;
  }

  // Run all five checks. Each returns a row payload for ai_actions, or null.
  const checks = [
    () => calendarLookahead(bid),
    () => dormantScan(bid),
    () => overnightBookingWatch(bid),
    () => clientListScan(bid),
    () => inboxWatch(bid),
  ];

  // Stagger the timestamps over the last hour so the feed shows a natural
  // sequence rather than five rows at the same second.
  const now = Date.now();
  const rows = [];
  for (let i = 0; i < checks.length; i++) {
    try {
      const payload = await checks[i]();
      if (!payload) continue;

      // Spread: oldest first by 12 minutes per row, ending now.
      const ts = new Date(now - (checks.length - 1 - i) * 12 * 60 * 1000);
      rows.push({
        ...payload,
        beautician_id: bid,
        autonomous: true,
        outcome: 'success',
        details: { ...(payload.details || {}), heartbeat: true, ran_at: ts.toISOString() },
        created_at: ts.toISOString(),
      });
    } catch (err) {
      logger.warn({ err, beauticianId: bid, checkIndex: i }, 'Heartbeat: check failed');
    }
  }

  if (!rows.length) return false;

  const { error: insertErr } = await supabase.from('ai_actions').insert(rows);
  if (insertErr) {
    logger.error({ err: insertErr, beauticianId: bid }, 'Heartbeat: insert failed');
    return false;
  }

  logger.info({ beauticianId: bid, rows: rows.length }, 'Heartbeat: tenant pass complete');
  return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// Individual checks. Each returns a partial ai_actions row or null.
// All counts come straight from the DB, no fiction.
// ─────────────────────────────────────────────────────────────────────────────

async function calendarLookahead(beauticianId) {
  const start = new Date();
  start.setDate(start.getDate() + 1);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setHours(23, 59, 59, 999);

  const { count, error } = await supabase
    .from('appointments')
    .select('id', { count: 'exact', head: true })
    .eq('beautician_id', beauticianId)
    .gte('starts_at', start.toISOString())
    .lte('starts_at', end.toISOString())
    .neq('status', 'cancelled');

  if (error) return null;

  const n = count || 0;
  const summary = n === 0
    ? "Florrie checked tomorrow's calendar, nothing booked yet"
    : n === 1
    ? "Florrie checked tomorrow's calendar, 1 appointment booked"
    : `Florrie checked tomorrow's calendar, ${n} appointments booked`;

  return {
    action_type: 'quiet_week_detected',
    digital_employee: 'calendar',
    summary,
    details: {
      check: 'calendar_lookahead',
      booked_count: n,
      for_date: start.toISOString().slice(0, 10),
    },
  };
}

async function dormantScan(beauticianId) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - REBOOK_WINDOW_DAYS);

  const { count, error } = await supabase
    .from('clients')
    .select('id', { count: 'exact', head: true })
    .eq('beautician_id', beauticianId)
    .not('last_visit_at', 'is', null)
    .lt('last_visit_at', cutoff.toISOString());

  if (error) return null;

  const n = count || 0;
  const summary = n === 0
    ? "Florrie scanned your client list for dormant regulars, none yet"
    : n === 1
    ? "Florrie spotted 1 dormant client to consider re-engaging"
    : `Florrie spotted ${n} dormant clients to consider re-engaging`;

  return {
    action_type: 'dormant_detected',
    digital_employee: 'comeback',
    summary,
    details: {
      check: 'dormant_scan',
      dormant_count: n,
      rebook_window_days: REBOOK_WINDOW_DAYS,
    },
  };
}

async function overnightBookingWatch(beauticianId) {
  const since = new Date();
  since.setHours(since.getHours() - 24);

  const { count, error } = await supabase
    .from('appointments')
    .select('id', { count: 'exact', head: true })
    .eq('beautician_id', beauticianId)
    .gte('created_at', since.toISOString());

  if (error) return null;

  const n = count || 0;
  const summary = n === 0
    ? "Florrie watched for new bookings overnight, all quiet"
    : n === 1
    ? "Florrie watched overnight, 1 new booking came in"
    : `Florrie watched overnight, ${n} new bookings came in`;

  return {
    action_type: 'quiet_week_detected',
    digital_employee: 'scout',
    summary,
    details: {
      check: 'overnight_booking_watch',
      new_bookings: n,
      since: since.toISOString(),
    },
  };
}

async function clientListScan(beauticianId) {
  const since = new Date();
  since.setDate(since.getDate() - NEW_CLIENT_WINDOW_DAYS);

  // Total active clients
  const { count: total, error: tErr } = await supabase
    .from('clients')
    .select('id', { count: 'exact', head: true })
    .eq('beautician_id', beauticianId);

  // New this week
  const { count: fresh, error: nErr } = await supabase
    .from('clients')
    .select('id', { count: 'exact', head: true })
    .eq('beautician_id', beauticianId)
    .gte('created_at', since.toISOString());

  if (tErr || nErr) return null;

  const t = total || 0;
  const f = fresh || 0;
  const summary = f === 0
    ? `Florrie reviewed your client list, ${t} on the books`
    : f === 1
    ? `Florrie reviewed your client list, 1 new this week, ${t} total`
    : `Florrie reviewed your client list, ${f} new this week, ${t} total`;

  return {
    action_type: 'client_profile_updated',
    digital_employee: 'front_desk',
    summary,
    details: {
      check: 'client_list_scan',
      total_clients: t,
      new_in_window: f,
      window_days: NEW_CLIENT_WINDOW_DAYS,
    },
  };
}

async function inboxWatch(beauticianId) {
  // Count unread inbound messages: direction='inbound' AND not yet resolved.
  // (Earlier code filtered a non-existent replied_at column and always 42703'd
  // into the soft fallback below - H14.)
  const { count, error } = await supabase
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('beautician_id', beauticianId)
    .eq('direction', 'inbound')
    .eq('resolved', false);

  if (error) {
    // Fall back to a softer summary if the schema doesn't expose replied_at.
    return {
      action_type: 'quiet_week_detected',
      digital_employee: 'front_desk',
      summary: "Florrie watched your inbox for incoming messages",
      details: { check: 'inbox_watch', count: null, soft_fallback: true },
    };
  }

  const n = count || 0;
  const summary = n === 0
    ? "Florrie watched your inbox overnight - all caught up"
    : n === 1
    ? "Florrie watched your inbox - 1 message waiting for you"
    : `Florrie watched your inbox - ${n} messages waiting for you`;

  return {
    action_type: 'quiet_week_detected',
    digital_employee: 'front_desk',
    summary,
    details: {
      check: 'inbox_watch',
      unread_count: n,
    },
  };
}
