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
import { safeReply } from '../lib/reply-claims-guard.js';
import { getFreeSlots } from '../lib/free-slots.js';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { sendOnChannel } from '../services/messaging.js';
import { AUTHOR } from '../lib/idiolect.js';
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
    .eq('status', 'pending_approval')
    .neq('reason', 'just_me_silent_draft') // quiet drafts never nag;
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

  // Same send-boundary guard as escalations. Everything queued here was written
  // by Florrie, and rows can sit for days, so a time that was free when the
  // draft was made may be booked by the time Ellie approves it.
  let allowedTimes = [];
  try {
    const slots = await getFreeSlots(beauticianId, {
      workingHours: beautician.working_hours,
      timezone: beautician.timezone || 'Europe/London',
    });
    allowedTimes = slots.map(s => s.time);
  } catch (err) {
    logger.warn({ err, beauticianId }, 'outbound send: diary read failed, refusing any named time');
  }

  const guarded = safeReply(row.body, { allowedTimes });
  if (guarded.rejected) {
    logger.warn({
      beauticianId, rowId: row.id, reason: guarded.reason, offending: guarded.offending,
    }, 'BLOCKED an unverifiable claim at the outbound send boundary');
    return {
      ok: false,
      error: guarded.reason === 'claimed a booking change that never happened'
        ? 'This says the booking has been changed, but Florrie cannot move bookings. Edit it before sending.'
        : 'This names a time that is not free in your diary any more. Edit it before sending.',
    };
  }

  const result = await sendOnChannel({
    beautician,
    clientId: row.client_id,
    channel: row.channel || 'whatsapp',
    body: row.body,
    // Everything in this queue was written by Florrie. Approving it is not
    // authoring it, and the PATCH above overwrites body in place, so an edited
    // row is indistinguishable from an untouched one. Marked 'ai' either way:
    // losing a rewritten sample costs nothing, learning from a machine draft
    // costs her voice.
    authoredBy: AUTHOR.AI,
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
