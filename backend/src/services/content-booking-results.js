import { supabase } from '../config.js';
import logger from '../lib/logger.js';

export const validContentToken = token => typeof token === 'string' && /^[a-f0-9]{32}$/.test(token);
export function contentBookingUrl(slug, token) {
  if (typeof slug !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/i.test(slug) || !validContentToken(token)) return null;
  const url = new URL(`/book/${encodeURIComponent(slug)}`, process.env.FRONTEND_URL || 'https://florrie.ai');
  url.searchParams.set('fl_content', token);
  return url.href;
}

// Optional attribution never delays, rejects or changes a customer's booking.
// The RPC validates BOTH owners and records each appointment once. The report
// joins current appointment status; webhook replays cannot increment a counter.
export async function recordContentBooking(owner, appointment, token) {
  if (!validContentToken(token)) return false;
  try {
    const { data, error } = await supabase.rpc('record_content_booking', {
      p_owner: owner, p_appointment: appointment, p_token: token,
    }).abortSignal(AbortSignal.timeout(2000));
    if (error) throw error;
    return data === true;
  } catch {
    logger.warn({ beauticianId: owner, appointmentId: appointment }, 'Content booking source could not be recorded');
    return false;
  }
}
