import { supabase } from '../config.js';
import { effectiveHours } from './effective-hours.js';

export async function loadDateHours(beauticianId, from, to = from) {
  const { data, error, count } = await supabase.from('date_working_hours')
    .select('date, start_time, end_time', { count: 'exact' })
    .eq('beautician_id', beauticianId).gte('date', from).lte('date', to);
  if (error || !Array.isArray(data) || data.length >= 1000 || (count != null && count !== data.length)) {
    throw new Error('Could not check the hours for these dates. Please try again.');
  }
  for (const row of data) effectiveHours({}, row.date, [row]);
  return data;
}

export async function hoursForDate(beauticianId, weekly, date) {
  return effectiveHours(weekly, date, await loadDateHours(beauticianId, date));
}
