/**
 * Florrie's Outbox API.
 *
 * The outbound guard (lib/outbound-guard.js) queues proactive messages it isn't
 * allowed to auto-send into outbound_sends with status 'pending_approval'. This
 * route lets the beautician review that queue and approve / edit / skip, one tap
 * or all at once. Approving actually delivers the message via the unified
 * sendOnChannel() path and flips the row to 'sent'.
 */
import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { sendOnChannel } from '../services/messaging.js';
import logger from '../lib/logger.js';
import { deDash } from '../lib/text.js';

const router = Router();
router.use(requireAuth);

/** GET /api/outbound/pending - what Florrie wants to send, oldest first. */
router.get('/pending', async (req, res) => {
  const { data, error } = await supabase
    .from('outbound_sends')
    .select('id, client_id, message_type, tier, channel, status, reason, body, created_at, clients(first_name, last_name)')
    .eq('beautician_id', req.beautician.id)
    .eq('status', 'pending_approval')
    .order('created_at', { ascending: true })
    .limit(200);
  if (error) {
    logger.error({ err: error }, 'outbound pending fetch failed');
    return res.status(500).json({ error: 'Could not load the outbox' });
  }
  res.json({ pending: data || [] });
});

/** GET /api/outbound/count - pending count for the home/nav badge. */
router.get('/count', async (req, res) => {
  const { count } = await supabase
    .from('outbound_sends')
    .select('id', { count: 'exact', head: true })
    .eq('beautician_id', req.beautician.id)
    .eq('status', 'pending_approval');
  res.json({ count: count || 0 });
});

/** PATCH /api/outbound/:id - edit the drafted message before approving. */
router.patch('/:id', async (req, res) => {
  // Keep Ellie's edits to the house rule too: no em/en dashes go out.
  const body = deDash(String(req.body?.body || '').trim());
  if (!body) return res.status(400).json({ error: 'Message body required' });
  const { error } = await supabase
    .from('outbound_sends')
    .update({ body })
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .eq('status', 'pending_approval');
  if (error) return res.status(500).json({ error: 'Could not save the edit' });
  res.json({ ok: true });
});

/** POST /api/outbound/:id/skip - bin this one, do not send. */
router.post('/:id/skip', async (req, res) => {
  const { error } = await supabase
    .from('outbound_sends')
    .update({ status: 'skipped', decided_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .eq('status', 'pending_approval');
  if (error) return res.status(500).json({ error: 'Could not skip' });
  res.json({ ok: true });
});

// Deliver one queued row. Returns { ok, error }. Loads the full beautician row
// (sendOnChannel needs whatsapp_phone_id etc., which the sanitised req.beautician
// may not carry).
async function deliverQueued(row, beauticianId) {
  const { data: beautician } = await supabase
    .from('beauticians')
    .select('*')
    .eq('id', beauticianId)
    .maybeSingle();
  if (!beautician) return { ok: false, error: 'Beautician not found' };
  if (!row.client_id) return { ok: false, error: 'No client on this message' };
  if (!row.body) return { ok: false, error: 'Nothing to send' };

  const result = await sendOnChannel({
    beautician,
    clientId: row.client_id,
    channel: row.channel || 'whatsapp',
    body: row.body,
  });
  if (!result.ok) return { ok: false, error: result.error || 'Send failed' };

  await supabase
    .from('outbound_sends')
    .update({ status: 'sent', decided_at: new Date().toISOString() })
    .eq('id', row.id);
  return { ok: true };
}

/** POST /api/outbound/:id/approve - send this one now. */
router.post('/:id/approve', async (req, res) => {
  const { data: row } = await supabase
    .from('outbound_sends')
    .select('*')
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .eq('status', 'pending_approval')
    .maybeSingle();
  if (!row) return res.status(404).json({ error: 'Not found or already handled' });

  const out = await deliverQueued(row, req.beautician.id);
  if (!out.ok) return res.status(400).json({ error: out.error });
  res.json({ ok: true });
});

/** POST /api/outbound/approve-all - send everything still pending. */
router.post('/approve-all', async (req, res) => {
  const { data: rows } = await supabase
    .from('outbound_sends')
    .select('*')
    .eq('beautician_id', req.beautician.id)
    .eq('status', 'pending_approval')
    .order('created_at', { ascending: true })
    .limit(200);

  let sent = 0, failed = 0;
  for (const row of rows || []) {
    const out = await deliverQueued(row, req.beautician.id);
    if (out.ok) sent++; else failed++;
  }
  res.json({ ok: true, sent, failed });
});

export default router;
