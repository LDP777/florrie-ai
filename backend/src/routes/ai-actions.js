import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { evaluateOutbound, recordOutbound } from '../lib/outbound-guard.js';
import { sendSMS } from '../services/notifications.js';
import logger from '../lib/logger.js';

const router = Router();

/**
 * GET /api/ai-actions
 * Activity feed: all AI actions, most recent first.
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
 * Dashboard summary: counts by employee, recent highlights.
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
 * The one message this route can actually send: the rebook nudge.
 *
 * It goes through the outbound gate (lib/outbound-guard.js) and it is typed
 * 'rebook_nudge', which matters twice over. In the gate it classifies as
 * PROACTIVE, so consent, the per-client autonomy override, marketing quiet
 * hours, the cross-engine frequency cap, the monthly per-client cap and the
 * allowance reserve all apply. In sendSMS, isMarketingSmsType('rebook_nudge')
 * is true, so the PECR opt-out check runs. The old call passed no messageType
 * at all, so it defaulted to 'general', that check was skipped, and a client
 * who had replied STOP was texted a marketing message anyway.
 *
 * Why 'approve' counts as a yes here, and only here: the gate's 'approve'
 * verdicts (just_me_silent_draft, client_prefers_drafts, known_client_review,
 * awaiting_approval) all mean "ask the owner first". This endpoint IS the
 * owner answering. Every verdict that is a hard no (opted out, quiet hours,
 * frequency cap, monthly cap, allowance reserve, autonomy off, error) comes
 * back as 'block' and is refused. Nothing is auto-sent on her behalf.
 *
 * Returns null when the client was messaged, or a human sentence when nothing
 * went out. The caller uses that to release the claim so she can try again.
 */
const GATE_REFUSALS = {
  opted_out: 'She has opted out of marketing messages, so this cannot go.',
  quiet_hours: 'It is outside sociable hours. Try again after 8am.',
  frequency_cap: 'She has already had a message from Florrie this week.',
  monthly_cap: 'She has had her limit of proactive messages this month.',
  allowance_reserved: 'Your message allowance is nearly gone and the rest is held back for confirmations and reminders.',
  autonomy_off: 'Rebook nudges are switched off in your settings.',
  no_client_match: 'Florrie could not match that client, so it was not sent.',
  error_failsafe: 'Something went wrong checking whether that could be sent, so nothing was.',
};

async function sendRebookNudge(action, beauticianId) {
  const { data: client, error: clientErr } = await supabase
    .from('clients')
    .select('id, first_name, phone, marketing_consent, marketing_opted_out_at, messaging_autonomy')
    .eq('id', action.client_id)
    .eq('beautician_id', beauticianId)
    .maybeSingle();

  if (clientErr) {
    logger.error({ err: clientErr, actionId: action.id }, 'ai-action execute: client read failed');
    return 'Could not read that client.';
  }
  if (!client) return 'That client is not on your list any more.';
  if (!client.phone) return 'There is no mobile number on that client.';

  const body = `Hey ${client.first_name}! It's been a while since your last visit. We'd love to see you again, fancy booking in? 💕`;

  const verdict = await evaluateOutbound({
    beauticianId,
    clientId: client.id,
    messageType: 'rebook_nudge',
    channel: 'sms',
    client,
  });

  if (verdict.decision === 'block') {
    await recordOutbound({
      beauticianId, clientId: client.id, messageType: 'rebook_nudge', channel: 'sms',
      tier: verdict.tier, status: 'blocked', reason: verdict.reason, body,
    });
    return GATE_REFUSALS[verdict.reason] || 'Florrie is not allowed to send that one right now.';
  }

  const sent = await sendSMS({
    to: client.phone,
    body,
    beauticianId,
    messageType: 'rebook_nudge',
    clientId: client.id,
  });

  // sendSMS returns null on every failure path, including its own PECR check.
  await recordOutbound({
    beauticianId, clientId: client.id, messageType: 'rebook_nudge', channel: 'sms',
    tier: verdict.tier, status: sent ? 'sent' : 'blocked',
    reason: sent ? verdict.reason : 'send_failed', body,
  });

  return sent ? null : 'The text would not go through. Nothing was sent.';
}

/**
 * POST /api/ai-actions/:id/execute
 * Approve and execute a queued autonomous action.
 *
 * The state transition is the lock. The status is flipped from
 * pending_approval to executed FIRST, filtered on the old status, and the
 * message only goes if that flip actually claimed a row. Two taps race, one
 * wins, the loser sends nothing.
 *
 * It used to send first and write afterwards, and the write named resolved_at,
 * which ai_actions has never had (001, 051, 20260803). PostgREST answered
 * 42703, nobody destructured the error, the status stayed pending_approval and
 * the card stayed on screen, so every tap texted the client again.
 *
 * If the send does not happen the claim is released back to pending_approval,
 * so the card comes back and she can retry. Releasing is safe because we only
 * get there when we know nothing was delivered.
 */
router.post('/:id/execute', requireAuth, async (req, res) => {
  const { id } = req.params;

  const { data: action, error: fetchErr } = await supabase
    .from('ai_actions')
    .select('*')
    .eq('id', id)
    .eq('beautician_id', req.beautician.id)
    .maybeSingle();

  if (fetchErr) {
    logger.error({ err: fetchErr, actionId: id }, 'Failed to read ai_action for execution');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  if (!action) return res.status(404).json({ error: 'Action not found' });
  if (action.status !== 'pending_approval') {
    return res.status(400).json({ error: 'Action already processed' });
  }

  // Claim it. Only the request that moves the row may send.
  const { data: claimed, error: claimErr } = await supabase
    .from('ai_actions')
    .update({ status: 'executed' })
    .eq('id', id)
    .eq('beautician_id', req.beautician.id)
    .eq('status', 'pending_approval')
    .select('id');

  if (claimErr) {
    logger.error({ err: claimErr, actionId: id }, 'Failed to claim ai_action for execution');
    return res.status(500).json({ error: 'Execution failed' });
  }
  if (!claimed || claimed.length === 0) {
    // Somebody else got there first: a second tap, or another device.
    return res.status(409).json({ error: 'Action already processed' });
  }

  let failure = null;
  try {
    if (action.action_type === 'rebook_nudge' && action.client_id) {
      failure = await sendRebookNudge(action, req.beautician.id);
    } else if (action.action_type === 'gap_post') {
      // Nothing to send. The draft already lives in content_posts; the flip to
      // executed above is the whole job.
    }
  } catch (err) {
    logger.error({ err, actionId: id }, 'Failed to execute approved action');
    failure = 'Execution failed';
  }

  if (failure) {
    // Put it back so she can try again. Filtered on the status we set, so a
    // row somebody else has since moved is left alone.
    const { error: releaseErr } = await supabase
      .from('ai_actions')
      .update({ status: 'pending_approval' })
      .eq('id', id)
      .eq('beautician_id', req.beautician.id)
      .eq('status', 'executed');
    if (releaseErr) {
      logger.error({ err: releaseErr, actionId: id }, 'Failed to release ai_action claim after a failed send');
    }
    return res.status(400).json({ error: failure });
  }

  const { error: outcomeErr } = await supabase
    .from('ai_actions')
    .update({ outcome: 'success' })
    .eq('id', id)
    .eq('beautician_id', req.beautician.id);
  if (outcomeErr) {
    logger.warn({ err: outcomeErr, actionId: id }, 'Executed, but could not record the outcome');
  }

  res.json({ ok: true, action_type: action.action_type });
});

/**
 * POST /api/ai-actions/:id/dismiss
 * Dismiss a queued autonomous action.
 *
 * Also used to name resolved_at, so this 500'd on every single call and the
 * card could not even be cleared. ai_actions carries status (20260803) and
 * outcome (001); there is no timestamp column for a decision, and created_at
 * is not it.
 */
router.post('/:id/dismiss', requireAuth, async (req, res) => {
  const { id } = req.params;

  const { data, error } = await supabase
    .from('ai_actions')
    .update({ status: 'dismissed' })
    .eq('id', id)
    .eq('beautician_id', req.beautician.id)
    .eq('status', 'pending_approval')
    .select('id');

  if (error) {
    logger.error({ err: error, actionId: id }, 'Failed to dismiss ai_action');
    return res.status(500).json({ error: 'Failed to dismiss' });
  }
  if (!data || data.length === 0) {
    return res.status(404).json({ error: 'Not found or already handled' });
  }

  res.json({ ok: true });
});

export default router;
