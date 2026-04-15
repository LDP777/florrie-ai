/**
 * Value Coaching Service — Florrie analyses pricing and suggests revenue growth.
 *
 * Instead of discounts, Florrie helps beauticians charge what they're worth:
 *   1. High-demand slot detection: "Your Saturday mornings fill within 2 hours. Raise gel set by £5."
 *   2. Inflation-adjusted pricing: "You haven't raised prices in 8 months. A £3 increase adds £380/month."
 *   3. Upsell opportunities: "Clients who add brow lamination spend £25 more per visit."
 *
 * Runs weekly via autonomous scheduler. Results stored in ai_actions for dashboard display.
 */
import { supabase } from '../config.js';
import logger from '../lib/logger.js';

/**
 * Main entry — run weekly value coaching analysis for all beauticians.
 */
export async function runValueCoaching() {
  logger.info('Value coaching: starting weekly analysis');

  try {
    const { data: beauticians } = await supabase
      .from('beauticians')
      .select('id, first_name, created_at');

    if (!beauticians?.length) return;

    let totalInsights = 0;
    for (const b of beauticians) {
      try {
        totalInsights += await analyseBeautician(b);
      } catch (err) {
        logger.error({ err, beauticianId: b.id }, 'Value coaching failed for beautician');
      }
    }

    logger.info({ totalInsights }, 'Value coaching: weekly analysis complete');
  } catch (err) {
    logger.error({ err }, 'Value coaching: fatal error');
  }
}

async function analyseBeautician(beautician) {
  const bid = beautician.id;
  const insights = [];

  // Trailing 8 weeks of data
  const eightWeeksAgo = new Date(Date.now() - 56 * 24 * 60 * 60 * 1000).toISOString();

  const [{ data: appointments }, { data: treatments }, { data: transactions }] = await Promise.all([
    supabase
      .from('appointments')
      .select('starts_at, treatment_id, status, duration_minutes')
      .eq('beautician_id', bid)
      .gte('starts_at', eightWeeksAgo)
      .neq('status', 'cancelled'),
    supabase
      .from('treatments')
      .select('id, name, price_cents, updated_at')
      .eq('beautician_id', bid),
    supabase
      .from('transactions')
      .select('amount_cents, created_at, appointment_id')
      .eq('beautician_id', bid)
      .eq('status', 'completed')
      .gte('created_at', eightWeeksAgo),
  ]);

  if (!appointments?.length || !treatments?.length) return 0;

  // 1. High-demand slot detection
  const slotDemand = analyseSlotDemand(appointments);
  const hotSlots = slotDemand.filter(s => s.fillRate > 0.85 && s.count >= 4);
  if (hotSlots.length) {
    const top = hotSlots[0];
    const topTreatment = findMostPopularTreatment(appointments, treatments, top.dayOfWeek, top.hourBlock);
    if (topTreatment) {
      const suggestedIncrease = Math.ceil(topTreatment.price_cents * 0.05 / 100) * 100; // Round to nearest £1
      const increasePounds = suggestedIncrease / 100;
      insights.push({
        type: 'high_demand',
        summary: `Your ${top.label} fills ${Math.round(top.fillRate * 100)}% of the time. You could increase ${topTreatment.name} by £${increasePounds} — demand supports it.`,
        confidence: 0.88,
      });
    }
  }

  // 2. Inflation-adjusted pricing
  const staletreatments = treatments.filter(t => {
    const lastUpdated = new Date(t.updated_at || t.created_at || beautician.created_at);
    const monthsSince = (Date.now() - lastUpdated.getTime()) / (30 * 24 * 60 * 60 * 1000);
    return monthsSince > 6 && t.price_cents > 0;
  });

  if (staletreatments.length >= 3) {
    // Calculate monthly bookings to estimate revenue impact
    const monthlyBookings = appointments.length / 2; // 8 weeks ≈ 2 months
    const avgIncrease = 300; // £3 average increase
    const monthlyGain = Math.round(monthlyBookings * avgIncrease / 100);

    insights.push({
      type: 'price_stale',
      summary: `You haven't updated prices on ${staletreatments.length} treatments in 6+ months. A £3 increase across these adds roughly £${monthlyGain}/month based on your current bookings.`,
      confidence: 0.85,
    });
  }

  // 3. Upsell / add-on opportunities
  const treatmentCombos = findCommonCombinations(appointments, treatments);
  if (treatmentCombos.length) {
    const best = treatmentCombos[0];
    insights.push({
      type: 'upsell',
      summary: `Clients who add ${best.addon} spend £${best.extraPounds} more per visit. Mention it when rebooking ${best.base} clients — it could mean £${best.monthlyGainPounds}/month extra.`,
      confidence: 0.82,
    });
  }

  // Store insights as ai_actions
  for (const insight of insights.slice(0, 3)) { // Max 3 per beautician per week
    // Check we haven't already sent this type recently
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const { data: existing } = await supabase
      .from('ai_actions')
      .select('id')
      .eq('beautician_id', bid)
      .eq('action_type', 'value_coaching')
      .gte('created_at', weekAgo)
      .limit(3);

    if ((existing || []).length >= 3) break; // Already got 3 this week

    await supabase.from('ai_actions').insert({
      beautician_id: bid,
      action_type: 'value_coaching',
      status: 'info', // Not actionable, just insight
      summary: insight.summary,
      confidence: insight.confidence,
      agent_name: 'Florrie',
      digital_employee: 'scout',
      metadata: { coaching_type: insight.type },
      created_at: new Date().toISOString(),
    });
  }

  return insights.length;
}

/**
 * Analyse fill rate by day-of-week + time block.
 */
function analyseSlotDemand(appointments) {
  const dayLabels = ['Sunday morning', 'Monday morning', 'Tuesday morning', 'Wednesday morning', 'Thursday morning', 'Friday morning', 'Saturday morning',
    'Sunday afternoon', 'Monday afternoon', 'Tuesday afternoon', 'Wednesday afternoon', 'Thursday afternoon', 'Friday afternoon', 'Saturday afternoon'];

  const slots = {};

  appointments.forEach(apt => {
    const d = new Date(apt.starts_at);
    const dayOfWeek = d.getDay();
    const hour = d.getHours();
    const block = hour < 12 ? 'morning' : 'afternoon';
    const key = `${dayOfWeek}-${block}`;

    if (!slots[key]) {
      slots[key] = { dayOfWeek, hourBlock: block, count: 0, label: dayLabels[dayOfWeek + (block === 'afternoon' ? 7 : 0)] };
    }
    slots[key].count += 1;
  });

  // 8 weeks = 8 instances of each slot. Fill rate = booked / available.
  // Assume avg 3 bookings per half-day slot max.
  const maxPerSlot = 8 * 3;
  return Object.values(slots).map(s => ({
    ...s,
    fillRate: Math.min(1, s.count / maxPerSlot),
  })).sort((a, b) => b.fillRate - a.fillRate);
}

/**
 * Find most popular treatment for a given day/block.
 */
function findMostPopularTreatment(appointments, treatments, dayOfWeek, block) {
  const treatmentMap = {};
  treatments.forEach(t => { treatmentMap[t.id] = t; });

  const counts = {};
  appointments.forEach(apt => {
    const d = new Date(apt.starts_at);
    if (d.getDay() !== dayOfWeek) return;
    if ((d.getHours() < 12 ? 'morning' : 'afternoon') !== block) return;
    if (!apt.treatment_id) return;

    counts[apt.treatment_id] = (counts[apt.treatment_id] || 0) + 1;
  });

  const sorted = Object.entries(counts).sort(([, a], [, b]) => b - a);
  if (!sorted.length) return null;

  return treatmentMap[sorted[0][0]] || null;
}

/**
 * Find common treatment combinations (base + add-on patterns).
 */
function findCommonCombinations(appointments, treatments) {
  // Group appointments by date to find same-day combos
  const byDate = {};
  appointments.forEach(apt => {
    const dateKey = new Date(apt.starts_at).toISOString().split('T')[0];
    if (!byDate[dateKey]) byDate[dateKey] = [];
    byDate[dateKey].push(apt);
  });

  const treatmentMap = {};
  treatments.forEach(t => { treatmentMap[t.id] = t; });

  // Look for appointments close together (potential add-ons)
  const combos = {};
  Object.values(byDate).forEach(dayApts => {
    if (dayApts.length < 2) return;
    dayApts.sort((a, b) => new Date(a.starts_at) - new Date(b.starts_at));

    for (let i = 0; i < dayApts.length - 1; i++) {
      const t1 = treatmentMap[dayApts[i].treatment_id];
      const t2 = treatmentMap[dayApts[i + 1].treatment_id];
      if (!t1 || !t2) continue;

      // The more expensive one is the "base", cheaper is the "add-on"
      const [base, addon] = t1.price_cents >= t2.price_cents ? [t1, t2] : [t2, t1];
      const key = `${base.id}+${addon.id}`;
      if (!combos[key]) combos[key] = { base: base.name, addon: addon.name, addonPrice: addon.price_cents, count: 0 };
      combos[key].count += 1;
    }
  });

  return Object.values(combos)
    .filter(c => c.count >= 3)
    .sort((a, b) => b.count - a.count)
    .map(c => ({
      ...c,
      extraPounds: Math.round(c.addonPrice / 100),
      monthlyGainPounds: Math.round((c.count / 2) * c.addonPrice / 100), // project 8 weeks → monthly
    }));
}
