import { supabase } from '../config.js';
import logger from './logger.js';

/**
 * Wire 5: give Florrie a truthful view of a beautician's live promo codes so
 * she can answer "any offers?" and, when the beautician opts in, add one to a
 * gap-fill draft. Fail soft (empty array), never throws.
 *
 * Active = is_active, inside the valid_from..valid_until window, and not used
 * up (max_uses null or current_uses below it). Soonest to expire first.
 */
export async function getActivePromos(beauticianId, limit = 3) {
  try {
    const nowIso = new Date().toISOString();
    const { data } = await supabase
      .from('promo_codes')
      .select('code, discount_type, discount_value, valid_until, max_uses, current_uses')
      .eq('beautician_id', beauticianId)
      .eq('is_active', true)
      .lte('valid_from', nowIso)
      .gte('valid_until', nowIso)
      .order('valid_until', { ascending: true })
      .limit(10);
    return (data || [])
      .filter(p => p.max_uses == null || (p.current_uses || 0) < p.max_uses)
      .slice(0, limit);
  } catch (err) {
    logger.warn({ err, beauticianId }, 'getActivePromos failed');
    return [];
  }
}

// A short, human phrase for a promo. 'percentage' value is a whole percent;
// 'fixed' value is pence (matches booking.js discount application).
export function describePromo(p) {
  if (!p || !p.code) return '';
  if (p.discount_type === 'percentage') {
    return `${p.discount_value}% off with code ${p.code}`;
  }
  const pounds = (p.discount_value || 0) / 100;
  const amt = pounds % 1 === 0 ? `£${pounds}` : `£${pounds.toFixed(2)}`;
  return `${amt} off with code ${p.code}`;
}
