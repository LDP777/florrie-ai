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
import { heldBookingClaimContext } from '../services/conversational-booking.js';

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

/**
 * A quiet draft: a client Ellie set to "Florrie never initiates" (clients
 * .messaging_autonomy = 'just_me'). The guard still writes the words, tagged
 * with this reason, so she can use them if she ever wants to. Nothing about
 * them may be swept up by a bulk action.
 */
const QUIET_REASON = 'just_me_silent_draft';

/**
 * The one definition of "a hold a bulk action is allowed to touch". The badge
 * count and Send all now share it instead of each carrying their own copy.
 *
 * They did not agree before. GET /count excluded quiet drafts and
 * frontend/src/pages/Outbox.jsx splits them into their own section with the
 * promise that nothing sends unless she says so, but POST /approve-all
 * selected on status alone. Tapping Send all to clear three gap offers also
 * sent a proactive message to every client she had explicitly told Florrie
 * never to initiate with. That setting is the one promise the product makes
 * about not messaging people.
 *
 * `reason` is nullable, and in SQL `reason <> 'x'` is NULL, not true, for a
 * NULL reason, so a plain .neq() silently dropped those rows as well. The
 * frontend calls a row quiet only when the reason matches exactly, so the
 * predicate says the same thing: quiet means the reason IS the quiet one.
 */
function loudPending(query) {
  return query
    .eq('status', 'pending_approval')
    .or(`reason.is.null,reason.neq.${QUIET_REASON}`);
}

/** GET /api/outbound/count - pending count for the home/nav badge. */
router.get('/count', async (req, res) => {
  const { count } = await loudPending(
    supabase
      .from('outbound_sends')
      .select('id', { count: 'exact', head: true })
      .eq('beautician_id', req.beautician.id)
  );
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

/**
 * Claim one pending row for sending: flip pending_approval -> sent, filtered
 * on the old status, and take the row the flip returned.
 *
 * This is the whole concurrency fix. Approve used to read the row filtered on
 * pending_approval, send, and only then mark it sent, so two requests both
 * passed the read and the client got the same proactive message twice. A
 * double tap did it, and so did approve racing approve-all.
 *
 * Claiming to the FINAL status rather than an in-between one is deliberate. A
 * crash between the claim and the send then leaves a message unsent, which is
 * recoverable, instead of leaving the row parked in a state that no query
 * looks at and no frequency cap counts. Nothing needs a stale-claim sweeper.
 *
 * Returns { row, error }. row is null when somebody else got there first.
 */
async function claimPending(rowId, beauticianId) {
  const { data, error } = await supabase
    .from('outbound_sends')
    .update({ status: 'sent', decided_at: new Date().toISOString() })
    .eq('id', rowId)
    .eq('beautician_id', beauticianId)
    .eq('status', 'pending_approval')
    .select('*');
  if (error) {
    logger.error({ err: error, rowId }, 'outbound: could not claim the row for sending');
    return { row: null, error: 'Could not send that one' };
  }
  return { row: (data || [])[0] || null, error: null };
}

/**
 * Undo a claim whose send did not happen, so the message comes back into the
 * outbox and she can try again. Only ever called on a path that knows nothing
 * was delivered, and filtered on the status the claim set, so a row anything
 * else has since moved is left alone.
 */
async function releaseClaim(rowId, beauticianId) {
  const { error } = await supabase
    .from('outbound_sends')
    .update({ status: 'pending_approval', decided_at: null })
    .eq('id', rowId)
    .eq('beautician_id', beauticianId)
    .eq('status', 'sent');
  if (error) {
    logger.error({ err: error, rowId }, 'outbound: could not release a claim after a failed send');
  }
}

// Deliver one already-claimed row. Returns { ok, error }. Loads the full
// beautician row (sendOnChannel needs whatsapp_phone_id etc., which the
// sanitised req.beautician may not carry). The row's status is not touched
// here: claimPending already moved it, and the caller releases the claim if
// this comes back not ok.
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

  // Same reason as routes/escalations.js: a slot Florrie holds for this client
  // is no longer free, so it has to be named from the appointment row instead.
  const held = await heldBookingClaimContext(beauticianId, row.client_id);
  const guarded = safeReply(row.body, {
    allowedTimes: [...allowedTimes, ...held.allowedTimes],
    actionPerformed: held.actionPerformed,
  });
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
  return { ok: true };
}

/** POST /api/outbound/:id/approve - send this one now. */
router.post('/:id/approve', async (req, res) => {
  // Claim first, send second. A quiet draft is fair game here: this is Ellie
  // deciding about one named person, which is exactly what 'just me' leaves
  // to her. It is the BULK action that must never touch them.
  const { row, error } = await claimPending(req.params.id, req.beautician.id);
  if (error) return res.status(500).json({ error });
  if (!row) return res.status(404).json({ error: 'Not found or already handled' });

  let out;
  try {
    out = await deliverQueued(row, req.beautician.id);
  } catch (err) {
    logger.error({ err, rowId: row.id }, 'outbound approve: delivery threw');
    out = { ok: false, error: 'Could not send that one' };
  }
  if (!out.ok) {
    await releaseClaim(row.id, req.beautician.id);
    return res.status(400).json({ error: out.error });
  }
  res.json({ ok: true });
});

/**
 * POST /api/outbound/approve-all - send everything still pending.
 *
 * Everything LOUD, that is. Quiet drafts are excluded here by the same
 * predicate the badge count uses, because the page tells her they are.
 */
router.post('/approve-all', async (req, res) => {
  const { data: rows, error } = await loudPending(
    supabase
      .from('outbound_sends')
      .select('id')
      .eq('beautician_id', req.beautician.id)
  )
    .order('created_at', { ascending: true })
    .limit(200);

  if (error) {
    logger.error({ err: error }, 'outbound approve-all: could not read the queue');
    return res.status(500).json({ error: 'Could not send them all' });
  }

  let sent = 0, failed = 0;
  for (const pending of rows || []) {
    // Claim each one on its own, so approve-all racing a single approve (or a
    // second approve-all) can never send the same message twice.
    const { row } = await claimPending(pending.id, req.beautician.id);
    if (!row) continue; // somebody else took it: not ours to count either way

    let out;
    try {
      out = await deliverQueued(row, req.beautician.id);
    } catch (err) {
      logger.error({ err, rowId: row.id }, 'outbound approve-all: delivery threw');
      out = { ok: false, error: 'Send failed' };
    }
    if (out.ok) {
      sent++;
    } else {
      failed++;
      await releaseClaim(row.id, req.beautician.id);
    }
  }
  res.json({ ok: true, sent, failed });
});

export default router;
