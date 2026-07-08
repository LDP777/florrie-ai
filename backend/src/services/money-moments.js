/**
 * Money moments
 *
 * The emotional layer on notifications: the end-of-day takings push with a
 * real comparison ("your best Tuesday this month"), and once-ever milestone
 * pushes (first £1k week, first fully booked day, 100th client). All
 * editable in Settings (pref keys daily_summary / milestones) and deduped
 * so nothing ever fires twice.
 *
 * Driven by an hourly tick from index.js; each beautician gets her daily
 * summary in HER evening (19:00-21:00 salon time), not at a UTC o'clock.
 */
import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import { pushTeamUpdate } from './push-notifications.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function localParts(tz) {
  const fmt = new Intl.DateTimeFormat('en-GB', {
    timeZone: tz || 'Europe/London',
    hour: '2-digit', minute: '2-digit', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'long',
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date()).map(p => [p.type, p.value]));
  return {
    hour: parseInt(parts.hour, 10),
    dateStr: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday,
  };
}

/** Has this exact moment already fired? florrie_decisions is the dedupe log. */
async function alreadyFired(beauticianId, key) {
  const { data } = await supabase
    .from('florrie_decisions')
    .select('id')
    .eq('beautician_id', beauticianId)
    .eq('suggestion_type', 'money_moment')
    .contains('suggestion_payload', { key })
    .limit(1);
  return !!data?.length;
}

async function markFired(beauticianId, key, extra = {}) {
  // response must satisfy the CHECK on florrie_decisions
  // (yes/no/tweak/dismissed). 'sent' violated it, the insert failed
  // silently, and milestones re-fired every tick. Never again: log failures.
  const { error } = await supabase.from('florrie_decisions').insert({
    beautician_id: beauticianId,
    suggestion_type: 'money_moment',
    suggestion_payload: { key, ...extra },
    response: 'yes',
    acted_on: true,
  });
  if (error) logger.error({ err: error, beauticianId, key }, 'money moments: dedupe insert FAILED, this moment will repeat');
}

/** Sum of takings (pence) between two ISO instants. */
async function takingsBetween(beauticianId, fromIso, toIso) {
  const { data } = await supabase
    .from('transactions')
    .select('amount_cents, created_at')
    .eq('beautician_id', beauticianId)
    .gte('created_at', fromIso)
    .lt('created_at', toIso);
  return (data || []).reduce((s, t) => s + (t.amount_cents || 0), 0);
}

/**
 * The end-of-day summary, fired once per beautician per local day in her
 * 19:00-21:00 window. Emotional where the data earns it, quiet otherwise.
 * Days with zero takings send nothing: silence beats a sad push.
 */
async function maybeSendDailySummary(b) {
  const { hour, dateStr, weekday } = localParts(b.timezone);
  if (hour < 19 || hour >= 21) return false;

  const key = `daily:${dateStr}`;
  if (await alreadyFired(b.id, key)) return false;

  const dayStart = new Date(`${dateStr}T00:00:00Z`).toISOString();
  const dayEnd = new Date(new Date(dayStart).getTime() + DAY_MS).toISOString();
  const todayPence = await takingsBetween(b.id, dayStart, dayEnd);
  if (todayPence <= 0) { await markFired(b.id, key, { skipped: 'no_takings' }); return false; }

  // Same weekday over the previous 4 weeks, for the "best Tuesday" line.
  let bestPrior = 0;
  for (let w = 1; w <= 4; w++) {
    const from = new Date(new Date(dayStart).getTime() - w * 7 * DAY_MS).toISOString();
    const to = new Date(new Date(from).getTime() + DAY_MS).toISOString();
    const v = await takingsBetween(b.id, from, to);
    if (v > bestPrior) bestPrior = v;
  }

  const pounds = `£${(todayPence / 100).toFixed(todayPence % 100 === 0 ? 0 : 2)}`;
  const { count: apptCount } = await supabase
    .from('appointments')
    .select('id', { count: 'exact', head: true })
    .eq('beautician_id', b.id)
    .eq('status', 'completed')
    .gte('starts_at', `${dateStr}T00:00:00`)
    .lte('starts_at', `${dateStr}T23:59:59`);

  let body;
  if (todayPence > bestPrior && bestPrior > 0) {
    body = `${pounds} today, your best ${weekday} this month`;
  } else if (apptCount > 0) {
    body = `${pounds} today from ${apptCount} client${apptCount === 1 ? '' : 's'}, all wrapped up`;
  } else {
    body = `${pounds} in the till today`;
  }

  await markFired(b.id, key, { pence: todayPence });
  await pushTeamUpdate(b.id, 'daily_money_summary', body, { url: '/money' });
  return true;
}

/**
 * Once-ever milestones. Checked alongside the daily summary tick.
 */
async function maybeSendMilestones(b) {
  const { dateStr } = localParts(b.timezone);
  let fired = 0;

  // First run for this beautician: swallow everything already achieved,
  // silently. Milestones are only news when they happen AFTER Florrie
  // started watching.
  const { data: anyRow } = await supabase
    .from('florrie_decisions')
    .select('id')
    .eq('beautician_id', b.id)
    .eq('suggestion_type', 'money_moment')
    .limit(1);
  const isBaselineRun = !anyRow?.length;

  // 1) First £1k week (Monday-to-now takings).
  const now = new Date();
  const dow = (now.getUTCDay() + 6) % 7; // Monday=0
  const weekStart = new Date(now.getTime() - dow * DAY_MS);
  const weekStartIso = new Date(Date.UTC(weekStart.getUTCFullYear(), weekStart.getUTCMonth(), weekStart.getUTCDate())).toISOString();
  const weekPence = await takingsBetween(b.id, weekStartIso, now.toISOString());
  if (weekPence >= 100000 && !(await alreadyFired(b.id, 'first_1k_week'))) {
    if (!isBaselineRun) {
      await pushTeamUpdate(b.id, 'milestone', `£${Math.floor(weekPence / 100)} this week. Your first £1,000 week 🌸`, { url: '/money' });
      fired++;
    }
    await markFired(b.id, 'first_1k_week', { pence: weekPence, baseline: isBaselineRun });
  }

  // 2) Client count milestones (100, 250, 500, 1000).
  const { count: clientCount } = await supabase
    .from('clients')
    .select('id', { count: 'exact', head: true })
    .eq('beautician_id', b.id);
  for (const n of [100, 250, 500, 1000]) {
    if ((clientCount || 0) >= n && !(await alreadyFired(b.id, `clients_${n}`))) {
      if (isBaselineRun) {
        // history, not news: record without pushing, and keep sweeping
        await markFired(b.id, `clients_${n}`, { count: clientCount, baseline: true });
        continue;
      }
      await pushTeamUpdate(b.id, 'milestone', `Client number ${n} just joined your books`, { url: '/clients' });
      await markFired(b.id, `clients_${n}`, { count: clientCount });
      fired++;
      break; // one milestone push max per tick
    }
  }

  // 3) Fully booked day: 90%+ of today's working minutes booked (min 4 appts).
  const dayKeyMap = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
  const dayKey = dayKeyMap[new Date(`${dateStr}T12:00:00Z`).getUTCDay()];
  const hours = b.working_hours?.[dayKey];
  if (hours?.start && hours?.end) {
    const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
    const workMins = toMin(hours.end) - toMin(hours.start);
    const { data: appts } = await supabase
      .from('appointments')
      .select('duration_minutes, status')
      .eq('beautician_id', b.id)
      .gte('starts_at', `${dateStr}T00:00:00`)
      .lte('starts_at', `${dateStr}T23:59:59`)
      .in('status', ['confirmed', 'booked', 'completed']);
    const bookedMins = (appts || []).reduce((s, a) => s + (a.duration_minutes || 0), 0);
    const key = `fully_booked:${dateStr}`;
    if (workMins > 0 && (appts || []).length >= 4 && bookedMins / workMins >= 0.9 && !(await alreadyFired(b.id, key))) {
      if (!isBaselineRun) {
        await pushTeamUpdate(b.id, 'milestone', `Fully booked today. Not a gap in sight`, { url: '/calendar/week' });
        fired++;
      }
      await markFired(b.id, key, { bookedMins, workMins, baseline: isBaselineRun });
    }
  }

  return fired;
}

/**
 * Hourly tick over all beauticians. Fail-soft per beautician.
 */
export async function runMoneyMoments() {
  const { data: beauticians, error } = await supabase
    .from('beauticians')
    .select('id, timezone, working_hours')
    .limit(500);
  if (error) {
    logger.warn({ err: error }, 'money moments: beautician list failed');
    return { summaries: 0, milestones: 0 };
  }

  let summaries = 0;
  let milestones = 0;
  for (const b of beauticians || []) {
    try {
      if (await maybeSendDailySummary(b)) summaries++;
      milestones += await maybeSendMilestones(b);
    } catch (err) {
      logger.warn({ err, beauticianId: b.id }, 'money moments: one beautician failed');
    }
  }
  if (summaries || milestones) logger.info({ summaries, milestones }, 'money moments: run complete');
  return { summaries, milestones };
}
