/**
 * Florrie "on the desk" Live Activity (iOS lock screen + Dynamic Island).
 *
 * The native app starts the activity in the morning and registers its APNs
 * push token here. This service pushes fresh content-state to that token
 * whenever Florrie does something, so the strip stays live while the phone
 * sits on the counter: "Florrie on the desk · 3 handled · next: Kayleigh 2pm".
 *
 * Everything fails soft. A Live Activity is a garnish; it must never break a
 * booking, a reply or a send.
 */
import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import { sendLiveActivityPush } from './apns.js';

// "14:00" (salon wall time in the UTC slot) -> "2pm" / "2:30pm". Never
// Intl-convert starts_at; read the wall clock straight off the string.
function friendlyTime(iso) {
  if (!iso || iso.length < 16) return '';
  const hh = parseInt(iso.slice(11, 13), 10);
  const mm = iso.slice(14, 16);
  if (Number.isNaN(hh)) return '';
  const ampm = hh < 12 ? 'am' : 'pm';
  let h = hh % 12; if (h === 0) h = 12;
  return mm === '00' ? `${h}${ampm}` : `${h}:${mm}${ampm}`;
}

/**
 * The dynamic content shown on the strip. Keys match the Swift ContentState.
 */
export async function buildDeskState(beauticianId) {
  const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
  const nowIso = new Date().toISOString();

  let handled = 0;
  try {
    const { count } = await supabase
      .from('ai_actions')
      .select('id', { count: 'exact', head: true })
      .eq('beautician_id', beauticianId)
      .eq('outcome', 'success')
      .gte('created_at', startOfDay.toISOString());
    handled = count || 0;
  } catch (err) {
    logger.warn({ err, beauticianId }, 'live-activity: handled count failed');
  }

  let nextClient = '', nextTime = '';
  try {
    const { data } = await supabase
      .from('appointments')
      .select('starts_at, clients(first_name)')
      .eq('beautician_id', beauticianId)
      .in('status', ['confirmed', 'pending'])
      .gte('starts_at', nowIso)
      .order('starts_at', { ascending: true })
      .limit(1)
      .maybeSingle();
    if (data) {
      nextClient = data.clients?.first_name || 'your next client';
      nextTime = friendlyTime(data.starts_at);
    }
  } catch (err) {
    logger.warn({ err, beauticianId }, 'live-activity: next appt failed');
  }

  const status = nextClient
    ? `Next: ${nextClient} ${nextTime}`.trim()
    : (handled ? "All handled, nothing booked yet" : "On the desk, watching your diary");

  return { handled, nextClient, nextTime, status };
}

// Active (not ended) activity tokens for a beautician.
async function activeTokens(beauticianId) {
  try {
    const { data } = await supabase
      .from('live_activity_tokens')
      .select('push_token')
      .eq('beautician_id', beauticianId)
      .is('ended_at', null);
    return (data || []).map(r => r.push_token).filter(Boolean);
  } catch (err) {
    logger.warn({ err, beauticianId }, 'live-activity: token lookup failed');
    return [];
  }
}

async function retireToken(token) {
  try { await supabase.from('live_activity_tokens').update({ ended_at: new Date().toISOString() }).eq('push_token', token); }
  catch { /* noop */ }
}

/**
 * Push the current desk state to every live activity this beautician has open.
 * Call this after Florrie does something worth reflecting (booking, gap filled,
 * message handled). Fire and forget.
 */
export async function refreshLiveActivity(beauticianId, { event = 'update' } = {}) {
  try {
    const tokens = await activeTokens(beauticianId);
    if (!tokens.length) return;
    const contentState = await buildDeskState(beauticianId);
    const staleDate = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(); // 2h
    for (const token of tokens) {
      const res = await sendLiveActivityPush(token, { event, contentState, staleDate });
      if (res && (res.status === 410 || res.reason === 'BadDeviceToken' || res.reason === 'Unregistered' || res.reason === 'ExpiredToken')) {
        await retireToken(token);
      }
    }
  } catch (err) {
    logger.warn({ err, beauticianId }, 'refreshLiveActivity failed');
  }
}

/**
 * End the strip for the day (or when the app asks). Sends the end event and
 * marks the tokens retired so nothing pushes to them again.
 */
export async function endLiveActivity(beauticianId, finalStatus = 'That is your day. Rest well.') {
  try {
    const tokens = await activeTokens(beauticianId);
    if (!tokens.length) return;
    const contentState = await buildDeskState(beauticianId);
    contentState.status = finalStatus;
    const dismissalDate = new Date(Date.now() + 5 * 60 * 1000).toISOString();
    for (const token of tokens) {
      await sendLiveActivityPush(token, { event: 'end', contentState, dismissalDate });
      await retireToken(token);
    }
  } catch (err) {
    logger.warn({ err, beauticianId }, 'endLiveActivity failed');
  }
}
