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

    // head: true means we get the count without dragging rows over the wire.
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

export default router;
