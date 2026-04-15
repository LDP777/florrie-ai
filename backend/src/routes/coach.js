/**
 * Biz Coach — Contextual AI insights that surface at the right moment.
 *
 * POST /api/coach/nudge
 *   Body: { trigger, context }
 *   Response: { id, headline, body, cta_label, cta_path, urgency, icon }
 *
 * Triggers:
 *   price_edit       — user is editing a treatment price
 *   calendar_gaps    — schedule page loaded with gaps detected
 *   expense_added    — new expense just saved
 *   dashboard_open   — home dashboard loaded
 *   client_count     — client list page loaded
 *
 * For each trigger we:
 *   1. Pull relevant live data from Supabase
 *   2. Enrich with UK beauty market benchmarks
 *   3. Ask Claude Haiku to generate a specific, numbered insight
 *   4. Return structured JSON the frontend renders as a nudge card
 *
 * Rate limit: 8 nudges per 10 minutes per beautician (in-memory).
 */

import { Router } from 'express';
import Anthropic from '@anthropic-ai/sdk';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../lib/logger.js';

const router = Router();

// Source: NHBF Industry Report 2024, BABTAC member surveys
const UK_BENCHMARKS = {
  'lash lift': { avg: 49, low: 35, high: 70 },
  'lash tint': { avg: 14, low: 10, high: 20 },
  'lash lift and tint': { avg: 58, low: 42, high: 78 },
  'lash extensions full set': { avg: 95, low: 65, high: 140 },
  'lash extensions infill': { avg: 50, low: 35, high: 70 },
  'lash extensions half set': { avg: 65, low: 45, high: 90 },
  'brow lamination': { avg: 38, low: 28, high: 55 },
  'brow tint': { avg: 13, low: 9, high: 20 },
  'brow wax': { avg: 16, low: 10, high: 25 },
  'brow lamination and tint': { avg: 50, low: 38, high: 68 },
  'hd brows': { avg: 35, low: 25, high: 50 },
  'microblading': { avg: 280, low: 180, high: 400 },
  'ombre brows': { avg: 280, low: 200, high: 380 },
  'combination brows': { avg: 310, low: 220, high: 420 },
  'facial': { avg: 55, low: 38, high: 90 },
  'dermaplaning': { avg: 65, low: 45, high: 95 },
  'gel manicure': { avg: 35, low: 25, high: 50 },
  'gel pedicure': { avg: 42, low: 30, high: 60 },
  'acrylic nails': { avg: 48, low: 35, high: 70 },
  'full leg wax': { avg: 42, low: 30, high: 60 },
  'bikini wax': { avg: 22, low: 15, high: 35 },
  'brazilian wax': { avg: 35, low: 25, high: 50 },
  'underarm wax': { avg: 14, low: 10, high: 22 },
  'lip wax': { avg: 9, low: 6, high: 15 },
  'chin wax': { avg: 9, low: 6, high: 15 },
};

function findBenchmark(treatmentName) {
  if (!treatmentName) return null;
  const lower = treatmentName.toLowerCase();
  // Exact match first
  if (UK_BENCHMARKS[lower]) return { key: lower, ...UK_BENCHMARKS[lower] };
  // Partial match
  const match = Object.entries(UK_BENCHMARKS).find(([k]) => lower.includes(k) || k.includes(lower));
  return match ? { key: match[0], ...match[1] } : null;
}

const rateLimitMap = new Map(); // beauticianId → { count, resetAt }
function checkRateLimit(id) {
  const now = Date.now();
  const entry = rateLimitMap.get(id);
  if (!entry || now > entry.resetAt) {
    rateLimitMap.set(id, { count: 1, resetAt: now + 10 * 60 * 1000 });
    return true;
  }
  if (entry.count >= 8) return false;
  entry.count++;
  return true;
}

const SYSTEM_PROMPT = `You are Florrie's Biz Coach — a sharp, friendly business advisor embedded in a beauty salon app.
You surface concise, data-backed insights to help beauticians earn more and work smarter.

Rules:
- Always use the exact numbers provided. Never make up figures.
- Be specific. "Raise by £4" beats "consider raising your price".
- One insight per response. No preamble, no sign-off.
- Tone: warm but direct. Like a savvy friend who knows the industry.
- Max 2 sentences for body. Headline max 8 words.

Return ONLY valid JSON in this exact shape:
{
  "headline": "...",
  "body": "...",
  "cta_label": "...",
  "cta_path": "...",
  "urgency": "opportunity" | "warning" | "info",
  "icon": "trending_up" | "warning" | "lightbulb" | "money_off" | "groups"
}`;

router.post('/nudge', requireAuth, async (req, res) => {
  const { trigger, context = {} } = req.body;
  const beauticianId = req.beautician.id;

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'AI not configured' });
  }
  if (!checkRateLimit(beauticianId)) {
    return res.status(429).json({ error: 'Rate limit reached' });
  }

  try {
    let prompt = '';

    if (trigger === 'price_edit') {
      const { treatment_name, price_cents, category } = context;
      const currentPrice = (price_cents || 0) / 100;

      // Bookings for this treatment last 60 days
      const since = new Date(); since.setDate(since.getDate() - 60);
      const { data: bookings } = await supabase
        .from('appointments')
        .select('price_cents, starts_at')
        .eq('beautician_id', beauticianId)
        .ilike('treatment_name', `%${treatment_name}%`)
        .gte('starts_at', since.toISOString())
        .neq('status', 'cancelled');

      const count60 = bookings?.length || 0;
      const revenue60 = (bookings || []).reduce((s, b) => s + (b.price_cents || 0), 0) / 100;
      const benchmark = findBenchmark(treatment_name);

      if (!benchmark) {
        return res.status(204).end(); // No benchmark = no nudge
      }

      const diff = benchmark.avg - currentPrice;
      const revImpact = diff > 0 ? Math.round(diff * count60) : 0;

      prompt = `Treatment: "${treatment_name}" | Current price: £${currentPrice} | UK average: £${benchmark.avg} (range £${benchmark.low}–£${benchmark.high}) | Bookings last 60 days: ${count60} | Revenue last 60 days: £${revenue60.toFixed(0)} | Revenue uplift if raised to avg: £${revImpact} over 60 days.

${diff > 0 ? `The price is £${diff.toFixed(0)} below market average.` : `The price is already at or above market average (£${Math.abs(diff).toFixed(0)} above).`}

Generate a ${diff > 0 ? '"opportunity"' : '"info"'} nudge. CTA should go to "/price-list". If above average, congratulate and suggest the next uplift milestone.`;

    } else if (trigger === 'calendar_gaps') {
      const { gap_count, gap_hours, revenue_at_risk, utilisation } = context;

      // Most recent 4 weeks revenue
      const fourWeeksAgo = new Date(); fourWeeksAgo.setDate(fourWeeksAgo.getDate() - 28);
      const { data: recentAppts } = await supabase
        .from('appointments')
        .select('price_cents')
        .eq('beautician_id', beauticianId)
        .gte('starts_at', fourWeeksAgo.toISOString())
        .neq('status', 'cancelled');

      const weeklyAvgRevenue = ((recentAppts || []).reduce((s, a) => s + (a.price_cents || 0), 0) / 100 / 4).toFixed(0);

      // Dormant clients who could fill gaps
      const ninetyDaysAgo = new Date(); ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
      const { count: dormantCount } = await supabase
        .from('clients')
        .select('id', { count: 'exact', head: true })
        .eq('beautician_id', beauticianId);

      prompt = `Schedule this week: ${gap_count} gaps, ${gap_hours}h empty, £${revenue_at_risk} revenue at risk, ${utilisation}% utilisation.
Average weekly revenue (last 4 weeks): £${weeklyAvgRevenue}.
Total clients in system: ${dormantCount || 0}.

Generate a "warning" nudge about the gap revenue at risk. CTA should go to "/smart-schedule" with label "Fill gaps".`;

    } else if (trigger === 'expense_added') {
      const { category, amount_pence, vendor } = context;

      // This month vs last month for this category
      const now = new Date();
      const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
      const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
      const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);

      const [thisMonthRes, lastMonthRes] = await Promise.all([
        supabase.from('expenses').select('amount_pence').eq('beautician_id', beauticianId).eq('category', category).gte('date', thisMonthStart.toISOString().slice(0, 10)),
        supabase.from('expenses').select('amount_pence').eq('beautician_id', beauticianId).eq('category', category).gte('date', lastMonthStart.toISOString().slice(0, 10)).lte('date', lastMonthEnd.toISOString().slice(0, 10)),
      ]);

      const thisMonthTotal = ((thisMonthRes.data || []).reduce((s, e) => s + Math.abs(e.amount_pence || 0), 0) / 100).toFixed(0);
      const lastMonthTotal = ((lastMonthRes.data || []).reduce((s, e) => s + Math.abs(e.amount_pence || 0), 0) / 100).toFixed(0);
      const currentExpense = (Math.abs(amount_pence || 0) / 100).toFixed(0);
      const pctChange = lastMonthTotal > 0 ? Math.round(((thisMonthTotal - lastMonthTotal) / lastMonthTotal) * 100) : 0;

      // Monthly revenue for margin context
      const { data: monthAppts } = await supabase
        .from('appointments')
        .select('price_cents')
        .eq('beautician_id', beauticianId)
        .gte('starts_at', thisMonthStart.toISOString())
        .neq('status', 'cancelled');
      const monthRevenue = ((monthAppts || []).reduce((s, a) => s + (a.price_cents || 0), 0) / 100).toFixed(0);

      prompt = `Category: ${category} | This expense: £${currentExpense} (${vendor || 'unlabelled'}) | This month's total for ${category}: £${thisMonthTotal} | Last month: £${lastMonthTotal} | Month-on-month change: ${pctChange > 0 ? '+' : ''}${pctChange}% | Month revenue so far: £${monthRevenue}.

Generate a ${Math.abs(pctChange) > 20 ? '"warning"' : '"info"'} nudge about expense trend. CTA should go to "/expenses". Keep it practical.`;

    } else if (trigger === 'dashboard_open') {
      const thisWeekStart = new Date(); thisWeekStart.setDate(thisWeekStart.getDate() - thisWeekStart.getDay());
      const lastWeekStart = new Date(thisWeekStart); lastWeekStart.setDate(lastWeekStart.getDate() - 7);
      const lastWeekEnd = new Date(thisWeekStart); lastWeekEnd.setDate(lastWeekEnd.getDate() - 1);

      const [thisWeek, lastWeek, atRisk] = await Promise.all([
        supabase.from('appointments').select('price_cents').eq('beautician_id', beauticianId).gte('starts_at', thisWeekStart.toISOString()).neq('status', 'cancelled'),
        supabase.from('appointments').select('price_cents').eq('beautician_id', beauticianId).gte('starts_at', lastWeekStart.toISOString()).lte('starts_at', lastWeekEnd.toISOString()).neq('status', 'cancelled'),
        supabase.from('clients').select('id', { count: 'exact', head: true }).eq('beautician_id', beauticianId),
      ]);

      const thisRevenue = ((thisWeek.data || []).reduce((s, a) => s + (a.price_cents || 0), 0) / 100).toFixed(0);
      const lastRevenue = ((lastWeek.data || []).reduce((s, a) => s + (a.price_cents || 0), 0) / 100).toFixed(0);
      const revChange = lastRevenue > 0 ? Math.round(((thisRevenue - lastRevenue) / lastRevenue) * 100) : 0;
      const clientCount = atRisk.count || 0;

      prompt = `This week revenue so far: £${thisRevenue} | Last week: £${lastRevenue} | Change: ${revChange > 0 ? '+' : ''}${revChange}% | Total clients: ${clientCount}.

Generate a ${revChange < -10 ? '"warning"' : revChange > 10 ? '"opportunity"' : '"info"'} nudge about weekly business health. CTA should go to "/dashboard". Be encouraging if doing well, practical if not.`;

    } else {
      return res.status(400).json({ error: 'Unknown trigger' });
    }

    const anthropic = new Anthropic();
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 180,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    });

    const raw = response.content[0]?.text?.trim() || '';
    // Extract JSON even if Claude adds surrounding text
    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      logger.error({ raw }, 'Coach: Claude returned non-JSON');
      return res.status(500).json({ error: 'Bad response from AI' });
    }

    const nudge = JSON.parse(jsonMatch[0]);
    nudge.id = `${trigger}-${Date.now()}`;
    nudge.trigger = trigger;

    return res.json(nudge);
  } catch (err) {
    logger.error({ err }, 'Coach nudge failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
});

export default router;
