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
    const { data, error } = await supabase
      .from('promo_codes')
      .select('*')
      .eq('beautician_id', beauticianId)
      .eq('is_active', true)
      .lte('valid_from', nowIso)
      .gte('valid_until', nowIso)
      .order('valid_until', { ascending: true })
      .limit(10);
    if (error) throw error;
    const active = (data || []).filter(p => p.max_uses == null || (p.current_uses || 0) < p.max_uses).slice(0, limit);
    const treatmentIds = [...new Set(active.filter(p => p.marketing_approved_at).flatMap(p => p.treatment_ids || []))];
    if (treatmentIds.length) {
      const menu = await supabase.from('treatments').select('id,name,price_cents').eq('beautician_id', beauticianId).in('id', treatmentIds);
      if (menu.error) throw menu.error;
      for (const promo of active) if (promo.marketing_approved_at) promo.treatments = (menu.data || []).filter(t => promo.treatment_ids?.includes(t.id));
    }
    return active;
  } catch (err) {
    logger.warn({ err, beauticianId }, 'getActivePromos failed');
    return [];
  }
}

// A short, human phrase for a promo. 'percentage' value is a whole percent;
// 'fixed' value is pence (matches booking.js discount application).
export function describePromo(p) {
  if (!p || !p.code) return '';
  if (p.marketing_approved_at) return offerForMessaging(p)?.client_reply || '';
  if (p.discount_type === 'percentage') {
    return `${p.discount_value}% off with code ${p.code}`;
  }
  const pounds = (p.discount_value || 0) / 100;
  const amt = pounds % 1 === 0 ? `£${pounds}` : `£${pounds.toFixed(2)}`;
  return `${amt} off with code ${p.code}`;
}

const money = pence => new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP', maximumFractionDigits: pence % 100 ? 2 : 0 }).format(pence / 100);
const day = value => String(value || '').slice(0, 10);
const dateLabel = value => new Date(`${day(value)}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' });
const today = value => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London', year: 'numeric', month: '2-digit', day: '2-digit' }).format(value);

export function offerForMessaging(promo, { now = new Date() } = {}) {
  if (!promo?.marketing_approved_at || !promo.code) return null;
  const treatments = Array.isArray(promo.treatments) ? promo.treatments : [];
  const names = treatments.map(treatment => treatment.name).filter(Boolean);
  const treatmentNames = names.length ? names : (promo.treatment_names || []);
  const expired = (promo.valid_until && Date.parse(promo.valid_until) < +now)
    || (promo.appointments_to && day(promo.appointments_to) < today(now));
  const unavailable = promo.is_active === false || expired
    || (promo.max_uses != null && (promo.current_uses || 0) >= promo.max_uses);
  const notStarted = promo.valid_from && Date.parse(promo.valid_from) > +now;
  const discount = promo.discount_type === 'percentage' ? `${promo.discount_value}% off` : `${money(promo.discount_value || 0)} off`;
  const phrases = [];
  if (treatmentNames.length) phrases.push(`${discount} ${treatmentNames.join(' or ')}`);
  if (promo.appointments_from && promo.appointments_to) {
    const from = day(promo.appointments_from), to = day(promo.appointments_to);
    const range = from.slice(0, 7) === to.slice(0, 7) ? `${Number(from.slice(8))} to ${dateLabel(to)}` : `${dateLabel(from)} to ${dateLabel(to)}`;
    phrases.push(`for appointments ${range}`);
  }
  const prices = treatments.filter(t => Number.isInteger(t.price_cents)).map(t => {
    const reduced = Math.max(0, t.price_cents - (promo.discount_type === 'percentage' ? Math.round(t.price_cents * promo.discount_value / 100) : promo.discount_value));
    return { treatment_id: t.id, name: t.name, old_pence: t.price_cents, new_pence: reduced };
  });
  for (const price of prices) phrases.push(`${money(price.new_pence)} instead of ${money(price.old_pence)}${prices.length > 1 ? ` for ${price.name}` : ''}`);
  if (promo.valid_until) phrases.push(`Book by ${dateLabel(promo.valid_until)}`);
  phrases.push(`code ${promo.code}`);
  if (promo.terms) phrases.push(String(promo.terms).replace(/[\u2013\u2014]/g, ',').trim().replace(/\.$/, ''));
  const complete = treatmentNames.length > 0 && !!promo.appointments_from && !!promo.appointments_to && !!promo.valid_until;
  const title = promo.title || promo.code;
  const priceWords = prices.map(price => `${money(price.new_pence)} instead of ${money(price.old_pence)}${prices.length > 1 ? ` for ${price.name}` : ''}`).join(', ');
  const clientReply = unavailable ? `The ${title} offer has finished.` : notStarted ? `The ${title} offer has not started yet.`
    : complete ? `${phrases[0]} ${phrases[1]}.${priceWords ? ` It's ${priceWords}.` : ''} Book by ${dateLabel(promo.valid_until)} with code ${promo.code}.${promo.terms ? ` ${String(promo.terms).replace(/[\u2013\u2014]/g, ',').trim().replace(/\.$/, '')}.` : ''}` : '';
  return { id: promo.id, title, code: promo.code, treatment_ids: promo.treatment_ids || [], treatment_names: treatmentNames,
    discount_type: promo.discount_type, discount_value: promo.discount_value, prices,
    appointments_from: promo.appointments_from, appointments_to: promo.appointments_to,
    book_by: promo.valid_until, terms: promo.terms || '', active: !unavailable && !notStarted && complete,
    finished: unavailable, client_reply: clientReply, required_phrases: phrases };
}

export async function getMarketingOffers(beauticianId, { now = new Date() } = {}) {
  const result = await supabase.from('promo_codes').select('*').eq('beautician_id', beauticianId)
    .order('valid_until', { ascending: false }).limit(50);
  if (result.error) throw new Error('Could not read the approved offers.');
  const approved = (result.data || []).filter(p => p.marketing_approved_at);
  const ids = [...new Set(approved.flatMap(p => p.treatment_ids || []))];
  let treatments = [];
  if (ids.length) {
    const menu = await supabase.from('treatments').select('id,name,price_cents').eq('beautician_id', beauticianId).in('id', ids);
    if (menu.error) throw new Error('Could not check the prices in your offers.');
    treatments = menu.data || [];
  }
  return approved.map(p => offerForMessaging({ ...p, treatments: treatments.filter(t => p.treatment_ids?.includes(t.id)) }, { now })).filter(Boolean);
}
