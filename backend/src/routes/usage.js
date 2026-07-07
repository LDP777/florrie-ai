/**
 * Usage routes, Day 5 of the 2026-05-28 refactor sprint.
 *
 *   GET /api/usage/messages
 *     -> { used, limit, month_start, month_end }
 *
 * Used drives the slim usage panel on Hub. limit defaults to 120, the
 * messaging cap baked into the GBP29 plan. We count outbound rows in
 * the `messages` table for this beautician, this calendar month.
 */
import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../lib/logger.js';

const router = Router();

const DEFAULT_LIMIT = 120;

function monthBounds(now = new Date()) {
  const start = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
  return { start, end };
}

router.get('/messages', requireAuth, async (req, res) => {
  try {
    const { start, end } = monthBounds();

    // Read the BILLING meter (message_usage), not a raw messages count: the
    // number Ellie sees must be the number that bills. The old count included
    // free in-window replies, so the panel read 22 while billing metered 9.
    const monthKey = `${start.getFullYear()}-${String(start.getMonth() + 1).padStart(2, '0')}-01`;
    const { data: usageRow } = await supabase
      .from('message_usage')
      .select('sms_sent, whatsapp_sent, free_limit')
      .eq('beautician_id', req.beautician.id)
      .eq('month', monthKey)
      .maybeSingle();

    if (usageRow) {
      return res.json({
        used: (usageRow.sms_sent || 0) + (usageRow.whatsapp_sent || 0),
        limit: usageRow.free_limit || DEFAULT_LIMIT,
        month_start: start.toISOString(),
        month_end: end.toISOString(),
      });
    }

    // No metered row yet this month: fall back to the raw outbound count.
    const { count, error } = await supabase
      .from('messages')
      .select('id', { count: 'exact', head: true })
      .eq('beautician_id', req.beautician.id)
      .eq('direction', 'outbound')
      .gte('created_at', start.toISOString())
      .lt('created_at', end.toISOString());

    if (error) {
      logger.error({ err: error }, 'usage.messages count failed');
      // Fail soft, fresh tenant returns 0/120.
      return res.json({
        used: 0,
        limit: DEFAULT_LIMIT,
        month_start: start.toISOString(),
        month_end: end.toISOString(),
        error: true,
      });
    }

    res.json({
      used: count || 0,
      limit: req.beautician?.message_limit || DEFAULT_LIMIT,
      month_start: start.toISOString(),
      month_end: end.toISOString(),
    });
  } catch (err) {
    logger.error({ err }, 'usage.messages threw');
    res.status(500).json({ error: 'Failed to load usage' });
  }
});




/**
 * GET /api/usage/voice
 * Voice-moat headline: of the replies that started as Florrie drafts in the
 * last 30 days, how many went out untouched?
 */
router.get('/voice', requireAuth, async (req, res) => {
  try {
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000).toISOString();
    const { data, error } = await supabase
      .from('voice_metrics')
      .select('untouched, similarity')
      .eq('beautician_id', req.beautician.id)
      .gte('created_at', since);
    if (error) throw error;
    const total = data?.length || 0;
    const untouched = (data || []).filter((r) => r.untouched).length;
    return res.json({
      total,
      untouched,
      pct: total ? Math.round((untouched / total) * 100) : null,
    });
  } catch (err) {
    logger.warn({ err }, 'voice stats failed');
    return res.json({ total: 0, untouched: 0, pct: null });
  }
});

/**
 * GET /api/usage/value-receipt
 * "Florrie found you £X this month": estimated money recovered by agentic
 * actions month to date. Three honest parts:
 *   gap_fill  appointments booked within 48h of a successful gap-fill offer
 *   rebook    appointments booked within 7d of a rebook nudge
 *   deposits  deposits actually collected on this month's bookings
 */
router.get('/value-receipt', requireAuth, async (req, res) => {
  const bId = req.beautician.id;
  const monthStart = new Date();
  monthStart.setUTCDate(1);
  monthStart.setUTCHours(0, 0, 0, 0);
  const monthIso = monthStart.toISOString();
  try {
    const [{ data: actions }, { data: appts }, { data: depositRows }] = await Promise.all([
      supabase.from('ai_actions')
        .select('action_type, client_id, created_at')
        .eq('beautician_id', bId)
        .gte('created_at', monthIso)
        .or('action_type.like.gap_fill%,action_type.eq.rebook_nudge')
        .not('client_id', 'is', null),
      supabase.from('appointments')
        .select('id, client_id, price_cents, created_at, starts_at, clients(first_name, last_name), treatments(name)')
        .eq('beautician_id', bId)
        .gte('created_at', monthIso)
        .neq('status', 'cancelled'),
      supabase.from('appointments')
        .select('deposit_cents')
        .eq('beautician_id', bId)
        .gte('created_at', monthIso)
        .eq('deposit_paid', true),
    ]);

    // Credit each appointment to at most one Florrie action, and keep an
    // itemised trail so the breakdown screen can show exactly what was counted
    // and why. Honest by construction: a booking only counts if it landed
    // inside the attribution window after a real gap-fill offer or rebook nudge.
    const credited = new Set();
    const items = [];
    let gapFillPence = 0;
    let rebookPence = 0;
    for (const action of actions || []) {
      const isGap = action.action_type.startsWith('gap_fill');
      const windowMs = (isGap ? 48 : 168) * 3600 * 1000;
      const t0 = new Date(action.created_at).getTime();
      for (const appt of appts || []) {
        if (appt.client_id !== action.client_id || credited.has(appt.id)) continue;
        const dt = new Date(appt.created_at).getTime() - t0;
        if (dt >= 0 && dt <= windowMs) {
          credited.add(appt.id);
          const pence = appt.price_cents || 0;
          if (isGap) gapFillPence += pence;
          else rebookPence += pence;
          const first = appt.clients?.first_name || '';
          const lastInit = appt.clients?.last_name ? ' ' + appt.clients.last_name.charAt(0) + '.' : '';
          items.push({
            appointment_id: appt.id,
            reason: isGap ? 'gap_fill' : 'rebook',
            client: (first ? `${first}${lastInit}` : 'A client'),
            treatment: appt.treatments?.name || 'Appointment',
            amount_pence: pence,
            booked_at: appt.created_at,
            // starts_at is stored wall-clock; the client renders it with a slice.
            appt_at: appt.starts_at || null,
          });
        }
      }
    }
    items.sort((a, b) => b.amount_pence - a.amount_pence);
    const depositsPence = (depositRows || []).reduce((sum, r) => sum + (r.deposit_cents || 0), 0);
    return res.json({
      month: monthIso.slice(0, 7),
      // Headline value = money Florrie's actions brought in PLUS deposits she
      // secured on this month's bookings, per Levi's call.
      total_pence: gapFillPence + rebookPence + depositsPence,
      parts: {
        gap_fill_pence: gapFillPence,
        rebook_pence: rebookPence,
        deposits_protected_pence: depositsPence,
      },
      counts: {
        credited_appointments: credited.size,
        gap_fill: items.filter(i => i.reason === 'gap_fill').length,
        rebook: items.filter(i => i.reason === 'rebook').length,
        deposits: (depositRows || []).length,
      },
      items,
    });
  } catch (err) {
    logger.warn({ err }, 'value receipt failed');
    return res.json({ month: monthIso.slice(0, 7), total_pence: 0, parts: { gap_fill_pence: 0, rebook_pence: 0, deposits_protected_pence: 0 }, counts: { credited_appointments: 0 } });
  }
});

export default router;
