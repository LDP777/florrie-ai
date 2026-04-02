import { Router } from 'express';
import { supabase } from '../index.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../lib/logger.js';

const router = Router();

/**
 * GET /api/ai-actions
 * Activity feed — all AI actions, most recent first.
 * Supports filtering by digital_employee.
 */
router.get('/', requireAuth, async (req, res) => {
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

/**
 * POST /api/ai-actions/:id/execute
 * Approve and execute a queued autonomous action.
 */
router.post('/:id/execute', requireAuth, async (req, res) => {
  const { id } = req.params;

  // Fetch the action
  const { data: action, error: fetchErr } = await supabase
    .from('ai_actions')
    .select('*')
    .eq('id', id)
    .eq('beautician_id', req.beautician.id)
    .single();

  if (fetchErr || !action) {
    return res.status(404).json({ error: 'Action not found' });
  }

  if (action.status !== 'pending_approval') {
    return res.status(400).json({ error: 'Action already processed' });
  }

  try {
    // Execute based on action type
    if (action.action_type === 'rebook_nudge' && action.client_id) {
      // Fetch client phone and send nudge
      const { data: client } = await supabase
        .from('clients')
        .select('first_name, phone')
        .eq('id', action.client_id)
        .single();

      if (client?.phone) {
        const { sendSMS } = await import('../services/notifications.js');
        await sendSMS({
          to: client.phone,
          body: `Hey ${client.first_name}! It's been a while since your last visit. We'd love to see you again — fancy booking in? 💕`,
          beauticianId: req.beautician.id,
        });
      }
    } else if (action.action_type === 'gap_post') {
      // Gap post was already drafted, just mark executed
      // The draft lives in content_posts table
    }

    // Update status
    await supabase
      .from('ai_actions')
      .update({
        status: 'executed',
        resolved_at: new Date().toISOString(),
      })
      .eq('id', id);

    res.json({ ok: true, action_type: action.action_type });
  } catch (err) {
    logger.error({ err, actionId: id }, 'Failed to execute approved action');
    res.status(500).json({ error: 'Execution failed' });
  }
});

/**
 * POST /api/ai-actions/:id/dismiss
 * Dismiss a queued autonomous action.
 */
router.post('/:id/dismiss', requireAuth, async (req, res) => {
  const { id } = req.params;

  const { error } = await supabase
    .from('ai_actions')
    .update({
      status: 'dismissed',
      resolved_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('beautician_id', req.beautician.id)
    .eq('status', 'pending_approval');

  if (error) {
    return res.status(500).json({ error: 'Failed to dismiss' });
  }

  res.json({ ok: true });
});

export default router;
