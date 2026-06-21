import { supabase } from '../config.js';

/**
 * Returns a Set of client_ids who already have an active appointment in the
 * future (status confirmed or pending, starts_at later than now).
 *
 * Used to stop "needs a rebook" / overdue / predictive nudges firing for a
 * client who is already booked in. Ellie flagged Florrie suggesting rebooks for
 * people who were in her diary the following week, which erodes trust in the
 * suggestions, so every rebook generator filters through this.
 */
export async function getFutureBookedClientIds(beauticianId) {
  const { data, error } = await supabase
    .from('appointments')
    .select('client_id')
    .eq('beautician_id', beauticianId)
    .in('status', ['confirmed', 'pending'])
    .gt('starts_at', new Date().toISOString());

  if (error || !data) return new Set();
  return new Set(data.map(a => a.client_id).filter(Boolean));
}
