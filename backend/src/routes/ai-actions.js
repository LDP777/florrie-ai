import { Router } from 'express';
import { supabase } from '../index.js';
import { requireAuth } from '../middleware/auth.js';
import { requirePlan } from '../middleware/require-plan.js';
import logger from '../lib/logger.js';

const router = Router();

/**
 * GET /api/ai-actions
 * Activity feed — all AI actions, most recent first.
 * Supports filtering by digital_employee.
 */
router.get('/', requireAuth, requirePlan('pro'), async (req, res) => {
  let query = supabase
    .from('ai_actions')
    .select('*, clients(first_name, last_name)')
    .eq('beautician_id', req.beautician.id)
    .order('created_at', { ascending: false })
    .limit(Math.min(100, Math.max(1, parseInt(req.query.limit) || 50)));

  if (req.query.employee) {
    query = query.eq('digital_employee', req.query.employee);
  }

  if (req.query.since) {
    query = query.gte('created_at', req.query.since);
  }

  const { data, error } = await query;
  if (error) {
    logger.error({ err: error }, 'Failed to fetch ai_actions');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ actions: data });
});

/**
 * GET /api/ai-actions/summary
 * Dashboard summary — counts by employee, recent highlights.
 */
router.get('/summary', requireAuth, async (req, res) => {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayISO = today.toISOString();

  const weekAgo = new Date(today.getTime() - 7 * 24 * 60 * 60 * 1000).toISOString();

  // Today's actions by employee
  const { data: todayActions } = await supabase
    .from('ai_actions')
    .select('digital_employee, action_type')
    .eq('beautician_id', req.beautician.id)
    .gte('created_at', todayISO);

  // This week's actions by employee
  const { data: weekActions } = await supabase
    .from('ai_actions')
    .select('digital_employee, action_type, outcome')
    .eq('beautician_id', req.beautician.id)
    .gte('created_at', weekAgo);

  // Latest action per employee
  const employees = ['front_desk', 'calendar', 'comeback', 'content', 'money', 'scout'];
  const latestByEmployee = {};

  for (const emp of employees) {
    const { data } = await supabase
      .from('ai_actions')
      .select('summary, created_at, action_type')
      .eq('beautician_id', req.beautician.id)
      .eq('digital_employee', emp)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    latestByEmployee[emp] = data || null;
  }

  // Count actions by employee
  const countByEmployee = {};
  for (const emp of employees) {
    countByEmployee[emp] = {
      today: (todayActions || []).filter(a => a.digital_employee === emp).length,
      week: (weekActions || []).filter(a => a.digital_employee === emp).length
    };
  }

  res.json({
    countByEmployee,
    latestByEmployee,
    totalToday: (todayActions || []).length,
    totalWeek: (weekActions || []).length
  });
});

export default router;
