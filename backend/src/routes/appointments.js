import { Router } from 'express';
import * as Sentry from '@sentry/node';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { requireOwned } from '../lib/ownership.js';
import { validate } from '../middleware/validate.js';
import { updateClientIntelligence } from '../services/client-intelligence.js';
import { triggerSequence } from '../services/email-sequences.js';
import { scheduleReviewRequest } from '../services/review-requests.js';
import { awardLoyaltyPoints } from '../services/loyalty.js';
import { chargePolicyFee, chargeRemainingBalance, chargeCardAmount, getCardOnFile } from '../services/policy-fees.js';
import { feePreview } from '../lib/platform-fees.js';
import { logAssumedTakings } from '../lib/takings.js';
import { onlyFlipped, PRICE_SETTLED_TYPES, assumedTakingsCents, settledPriceCents, uncollectedCents } from '../lib/money-guards.js';
import { recomputeTotals, endsAtWall, parseExtraTreatmentIds } from '../lib/appointment-treatments.js';
import logger from '../lib/logger.js';
import { needsPatchTest, patchTestEvidence, patchTestWindowStart, RECORDED_BY_OWNER, todayWall, wallDate } from '../lib/patch-test-status.js';
import { parsePagination, buildPaginationMeta, handleQueryError } from '../lib/queries.js';
import { completeDaySchema, manualAppointmentSchema } from '../lib/schemas.js';
import { notifyBookingConfirmed, sendWhatsApp, sendSMS, sendMessage, pickChannel } from '../services/notifications.js';
import { guardedSend } from '../lib/outbound-guard.js';
import Stripe from 'stripe';

const router = Router();

const stripe = process.env.STRIPE_SECRET_KEY ? new Stripe(process.env.STRIPE_SECRET_KEY) : null;

/**
 * Did money actually move on this payment intent?
 *
 * Returns true only on a definite yes and false only on a definite no, so a
 * caller can treat null as "assume money" rather than "assume none". The whole
 * reason this exists is that our own columns lie when the webhook is down.
 *
 * @returns {Promise<boolean|null>} true paid, false definitely not, null unknown
 */
async function stripeSaysPaid(paymentIntentId) {
  if (!stripe || !paymentIntentId) return null;
  try {
    const pi = await stripe.paymentIntents.retrieve(paymentIntentId);
    if (pi?.status === 'succeeded') return true;
    if (['canceled', 'requires_payment_method'].includes(pi?.status)) return false;
    return null;
  } catch (err) {
    logger.warn({ err, paymentIntentId }, 'Could not ask Stripe whether this booking was paid');
    return null;
  }
}

/**
 * GET /api/appointments
 * List appointments. Supports pagination and filtering.
 * Query params:
 *   - page=1 (default 1)
 *   - per_page=25 (default 25, max 100)
 *   - from=2026-03-24 (ISO date filter)
 *   - to=2026-03-30 (ISO date filter)
 *   - status=confirmed
 */
router.get('/', requireAuth, async (req, res) => {
  const { page, per_page, offset } = parsePagination(req.query);

  // Build query
  let query = supabase
    .from('appointments')
    .select('*, clients(first_name, last_name, phone, email), treatments(name, duration_minutes, price_cents)', { count: 'exact' })
    .eq('beautician_id', req.beautician.id)
    .order('starts_at', { ascending: true });

  if (req.query.from) {
    query = query.gte('starts_at', req.query.from);
  }
  if (req.query.to) {
    query = query.lte('starts_at', req.query.to);
  }
  if (req.query.status) {
    query = query.eq('status', req.query.status);
  }

  // Apply pagination
  const { data, error, count } = await query.range(offset, offset + per_page - 1);
  if (handleQueryError(error, res, 'fetch appointments')) {
    return;
  }

  const pagination = buildPaginationMeta(count || 0, page, per_page);
  res.json({ data: data || [], pagination });
});

/**
 * GET /api/appointments/deposits
 * Every appointment that carries a deposit, with a DERIVED display status.
 *
 * The Deposit Tracker used to read the appointments table directly from the
 * browser and bucket rows by deposit_status values that the payment engine
 * never writes ('held'/'applied'/'forfeited' — real values are pending/paid/
 * refunded), so the page showed £0.00 forever. Served here instead (service
 * role, no RLS surprises) with the status derived from what actually
 * happened to the money:
 *   awaiting   deposit requested, client has not paid yet
 *   held       paid, appointment still upcoming
 *   applied    paid, appointment completed (deposit went toward the bill)
 *   forfeited  paid, appointment cancelled / no-show (deposit kept)
 *   refunded   deposit refunded via Stripe
 */
router.get('/deposits', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('appointments')
    // client_notes was selected here and never used. Dropped: it is the column
    // the booking page filled with consultation answers, and a column pulled
    // into a payload for no reason is the one that gets returned by accident.
    .select('id, starts_at, created_at, status, deposit_cents, deposit_paid, deposit_status, payment_method, clients(first_name, last_name), treatments(name)')
    .eq('beautician_id', req.beautician.id)
    .gt('deposit_cents', 0)
    .order('created_at', { ascending: false })
    .limit(300);

  if (handleQueryError(error, res, 'fetch deposits')) return;

  const DEAD = ['cancelled', 'cancelled_by_client', 'cancelled_by_beautician', 'no_show'];
  const rows = (data || []).map(a => {
    let display;
    if (a.deposit_status === 'refunded') display = 'refunded';
    else if (a.deposit_paid) {
      if (a.status === 'completed') display = 'applied';
      else if (DEAD.includes(a.status)) display = 'forfeited';
      else display = 'held';
    } else {
      // Deposit requested but never paid. Expired pending bookings get
      // auto-cancelled, so only live ones show as awaiting.
      display = DEAD.includes(a.status) ? 'lapsed' : 'awaiting';
    }
    const name = [a.clients?.first_name, a.clients?.last_name].filter(Boolean).join(' ') || 'Client';
    return {
      id: a.id,
      client: name,
      treatment: a.treatments?.name || '',
      amount: a.deposit_cents || 0,
      takenDate: (a.created_at || '').slice(0, 10),
      appointmentDate: (a.starts_at || '').slice(0, 10) || null,
      appointmentTime: (a.starts_at || '').slice(11, 16) || null,
      method: a.payment_method || 'card',
      status: display,
    };
  });

  res.json({ deposits: rows });
});

/**
 * POST /api/appointments
 * Create a new appointment (manual or AI-booked).
 */
router.post('/', requireAuth, async (req, res) => {
  const { client_id, treatment_id, starts_at, client_notes, booked_via } = req.body;

  if (!client_id || !treatment_id || !starts_at) {
    return res.status(400).json({ error: 'client_id, treatment_id, and starts_at are required' });
  }

  // Get treatment details for duration/price
  const { data: treatment, error: tError } = await supabase
    .from('treatments')
    .select('*')
    .eq('id', treatment_id)
    .eq('beautician_id', req.beautician.id)
    .single();

  if (tError || !treatment) {
    return res.status(404).json({ error: 'Treatment not found' });
  }

  // Validate starts_at is a valid date
  const startsAtDate = new Date(starts_at);
  if (isNaN(startsAtDate.getTime())) {
    return res.status(400).json({ error: 'Invalid starts_at date format' });
  }

  // Block appointments in the past
  if (startsAtDate < new Date()) {
    return res.status(400).json({ error: 'Cannot book an appointment in the past' });
  }

  // Validate appointment falls within working hours
  const { data: beauticianHours } = await supabase
    .from('beauticians')
    .select('working_hours')
    .eq('id', req.beautician.id)
    .single();

  if (beauticianHours?.working_hours) {
    const dayKey = startsAtDate.toLocaleDateString('en-US', { weekday: 'short' }).toLowerCase();
    const hours = beauticianHours.working_hours[dayKey];

    if (!hours) {
      return res.status(400).json({ error: 'Not available on this day' });
    }

    // Parse working hours (e.g. "09:00" and "17:00")
    const [startH, startM] = hours.start.split(':').map(Number);
    const [endH, endM] = hours.end.split(':').map(Number);
    const apptHour = startsAtDate.getUTCHours();
    const apptMin = startsAtDate.getUTCMinutes();
    const apptTime = apptHour * 60 + apptMin;
    const workStart = startH * 60 + startM;
    const workEnd = endH * 60 + endM;

    if (apptTime < workStart || apptTime >= workEnd) {
      return res.status(400).json({ error: 'Requested time is outside working hours' });
    }
  }

  // Check for client lateness padding
  const { data: client } = await supabase
    .from('clients')
    .select('lateness_score, lateness_count')
    .eq('id', client_id)
    .single();

  const extraPadding = (client?.lateness_count >= 3 && client?.lateness_score > 5)
    ? Math.round(client.lateness_score)
    : 0;

  const totalMinutes = treatment.duration_minutes + treatment.buffer_minutes + extraPadding;
  const startsDate = new Date(starts_at);
  const endsDate = new Date(startsDate.getTime() + totalMinutes * 60 * 1000);

  // Conflict check — no overlapping appointments
  const { data: conflicts } = await supabase
    .from('appointments')
    .select('id')
    .eq('beautician_id', req.beautician.id)
    .in('status', ['confirmed', 'pending', 'in_progress'])
    .lt('starts_at', endsDate.toISOString())
    .gt('ends_at', startsDate.toISOString());

  if (conflicts && conflicts.length > 0) {
    return res.status(409).json({ error: 'Time slot conflicts with an existing appointment' });
  }

  const { data: appointment, error } = await supabase
    .from('appointments')
    .insert({
      beautician_id: req.beautician.id,
      client_id,
      treatment_id,
      starts_at,
      ends_at: endsDate.toISOString(),
      duration_minutes: treatment.duration_minutes,
      buffer_minutes: treatment.buffer_minutes,
      extra_padding_minutes: extraPadding,
      price_cents: treatment.price_cents,
      deposit_cents: treatment.deposit_cents,
      client_notes: client_notes || null,
      booked_via: booked_via || 'manual',
      status: 'confirmed'
    })
    .select('*, clients(first_name, last_name), treatments(name)')
    .single();

  if (error) {
    logger.error({ err: error }, 'Failed to create appointment');
    // 23505 = no-double-book unique guard (same start); 23P01 = no-overlap
    // exclusion guard (overlapping times). Both mean the slot is taken.
    if (error.code === '23505' || error.code === '23P01') {
      return res.status(409).json({ error: 'That time is already booked.' });
    }
    return res.status(500).json({ error: 'Something went wrong' });
  }

  // This route creates a real, confirmed booking and told the client nothing.
  // It is the plain sibling of /manual, which at least has a toggle; here
  // there was no send at all and no way to ask for one.
  //
  // Default ON, unconditionally, and that is safe here in a way it is not on
  // /manual: line 179 above already refuses a past start, so every booking
  // that reaches this point is in the future and is one somebody is expecting
  // to hear about. The backfill case cannot occur on this route.
  const wantsConfirmation = typeof req.body?.send_confirmation === 'boolean'
    ? req.body.send_confirmation
    : true;
  let confirmation = { requested: wantsConfirmation, sent: false, reason: 'not_requested' };
  if (wantsConfirmation) {
    try {
      const result = await notifyBookingConfirmed(appointment.id);
      confirmation = { requested: true, sent: !!result?.sent, channels: result?.channels || [], reason: result?.reason || null };
    } catch (err) {
      logger.warn({ err, appointmentId: appointment.id }, 'Appointment confirmation failed');
      confirmation = { requested: true, sent: false, reason: 'delivery_failed' };
    }
  }
  res.status(201).json({ appointment, confirmation });
});

/**
 * POST /api/appointments/manual
 * Beautician-entered appointment from the day calendar's plus button.
 *
 * Deliberately different from POST /api/appointments:
 *   - NO working-hours check (last-minute out-of-hours clients are the point)
 *   - NO past-date block, NO conflict check, NO Stripe, NO deposit
 *   - Price is whatever the beautician typed (custom pricing allowed)
 *   - Confirmation message only goes out when send_confirmation is true
 *     (default off: mirroring bookings from an old system must stay silent)
 *   - Quick-creates the client (name + optional phone) when no client_id,
 *     reusing an existing client when the phone or exact name matches
 *
 * Times follow the wall-clock convention: date + time are stored as-is
 * (e.g. "2026-06-12T14:00:00"), never timezone-converted.
 */
router.post('/manual', requireAuth, validate(manualAppointmentSchema), async (req, res) => {
  const beauticianId = req.beautician.id;
  const {
    client_id, client_name, client_phone,
    treatment_id, date, time, duration_minutes, price_cents, send_confirmation, notes
  } = req.body;

  // Treatment must belong to this beautician (inactive/imported ones are fine)
  const { data: treatment, error: tError } = await supabase
    .from('treatments')
    .select('id, name')
    .eq('id', treatment_id)
    .eq('beautician_id', beauticianId)
    .single();

  if (tError || !treatment) {
    return res.status(404).json({ error: 'Treatment not found' });
  }

  // Resolve the client: existing by id, otherwise find-or-create by phone/name
  let clientId = null;
  if (client_id) {
    const { data: existing } = await supabase
      .from('clients')
      .select('id')
      .eq('id', client_id)
      .eq('beautician_id', beauticianId)
      .single();
    if (!existing) return res.status(404).json({ error: 'Client not found' });
    clientId = existing.id;
  } else {
    const digitsOf = (p) => String(p || '').replace(/\D/g, '');
    const phone = client_phone ? String(client_phone).trim().substring(0, 30) : null;
    const digits = digitsOf(phone);
    const nameKey = client_name.trim().toLowerCase();

    // Match against this beautician's clients: phone (last 9 digits) first, exact name second
    const { data: clientRows } = await supabase
      .from('clients')
      .select('id, first_name, last_name, phone')
      .eq('beautician_id', beauticianId);

    let match = null;
    if (digits.length >= 9) {
      const last9 = digits.slice(-9);
      match = (clientRows || []).find((c) => {
        const d = digitsOf(c.phone);
        return d.length >= 9 && d.endsWith(last9);
      }) || null;
    }
    if (!match) {
      match = (clientRows || []).find(
        (c) => `${c.first_name || ''} ${c.last_name || ''}`.trim().toLowerCase() === nameKey
      ) || null;
    }

    if (match) {
      clientId = match.id;
    } else {
      const parts = client_name.trim().split(/\s+/);
      const first = parts[0];
      const last = parts.slice(1).join(' ') || null;
      const { data: created, error: createErr } = await supabase
        .from('clients')
        .insert({
          beautician_id: beauticianId,
          first_name: first.substring(0, 100),
          last_name: last ? last.substring(0, 100) : null,
          phone,
          status: 'new',
        })
        .select('id')
        .single();

      if (createErr) {
        // Unique collision on (beautician_id, phone): someone with this phone
        // already exists, re-fetch and reuse (mirrors import-appointments.js)
        if (createErr.code === '23505' && phone) {
          const { data: refetched } = await supabase
            .from('clients')
            .select('id')
            .eq('beautician_id', beauticianId)
            .eq('phone', phone)
            .maybeSingle();
          if (refetched) clientId = refetched.id;
        }
        if (!clientId) {
          logger.error({ err: createErr }, 'Manual appointment client create failed');
          return res.status(500).json({ error: 'Could not create the client' });
        }
      } else {
        clientId = created.id;
      }
    }
  }

  // Wall-clock strings. UTC arithmetic for ends_at so no local timezone leaks in.
  const startsAt = `${date}T${time}:00`;
  const [y, mo, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const endDate = new Date(Date.UTC(y, mo - 1, d, hh, mm + duration_minutes));
  const pad = (n) => String(n).padStart(2, '0');
  const endsAt = `${endDate.getUTCFullYear()}-${pad(endDate.getUTCMonth() + 1)}-${pad(endDate.getUTCDate())}T${pad(endDate.getUTCHours())}:${pad(endDate.getUTCMinutes())}:00`;

  const { data: appointment, error } = await supabase
    .from('appointments')
    .insert({
      beautician_id: beauticianId,
      client_id: clientId,
      treatment_id,
      starts_at: startsAt,
      ends_at: endsAt,
      duration_minutes,
      buffer_minutes: 0,
      price_cents,
      deposit_cents: 0,
      status: 'confirmed',
      booked_via: 'manual',
      beautician_notes: notes || null,
    })
    .select('*, clients(first_name, last_name, phone), treatments(name)')
    .single();

  if (error) {
    logger.error({ err: error }, 'Failed to create manual appointment');
    // 23505 = no-double-book unique guard (same exact start time);
    // 23P01 = no-overlap exclusion guard. After migration 070 re-scopes the
    // overlap constraint to non-manual bookings, an intentional manual
    // double-book succeeds; these only fire when a manual add collides with a
    // protected online booking (or on the exact-start unique index). Either way
    // the slot is genuinely taken, so surface that clearly, not a generic 500.
    if (error.code === '23505' || error.code === '23P01') {
      return res.status(409).json({ error: 'That time is already taken by another booking.' });
    }
    return res.status(500).json({ error: 'Something went wrong' });
  }

  // Awaited, not fire-and-forget, and the outcome goes back in the response.
  //
  // Levi asked to check that a client he books in himself actually gets the
  // confirmation. Three things were in the way. The toggle defaulted off on
  // every open. This call was fire-and-forget with a logger.warn, so a failure
  // reached a log nobody reads. And notifyBookingConfirmed stamped
  // confirmation_sent_at even when the client had neither a phone nor an email
  // and nothing had gone anywhere — so the appointment then displayed a
  // confirmation timestamp for a message that never existed.
  //
  // A second or so on the save is a fair price for the sheet being able to say
  // "confirmation sent" or "no phone or email on file — nothing sent", which
  // is the only version of this she can act on.
  let confirmation = { requested: !!send_confirmation, sent: false, reason: 'not_requested' };
  if (send_confirmation) {
    try {
      const result = await notifyBookingConfirmed(appointment.id);
      confirmation = { requested: true, sent: !!result?.sent, channels: result?.channels || [], reason: result?.reason || null };
    } catch (err) {
      logger.warn({ err, appointmentId: appointment.id }, 'Manual appointment confirmation failed');
      confirmation = { requested: true, sent: false, reason: 'delivery_failed' };
    }
  }

  res.status(201).json({ appointment, confirmation });
});

/**
 * POST /api/appointments/:id/resend-confirmation
 *
 * Ellie's side of "did she get it?". A client messaged her the evening before
 * her appointment — "I have an appointment with you tomorrow at 6pm correct?
 * all my other booking dates show up but not tomorrow's" — and there was
 * nothing Ellie could do about it from inside the app except retype the
 * details by hand.
 *
 * There is already a client-facing resend behind the management token, which
 * is no use here: the client is the one who cannot find the message that
 * carries that token.
 *
 * Returns what actually happened rather than ok:true, so the sheet can say
 * "no phone or email on file" instead of pretending.
 */
router.post('/:id/resend-confirmation', requireAuth, async (req, res) => {
  if (!await requireOwned(req, res, [{ table: 'appointments', id: req.params.id }])) return;

  const { data: appt, error } = await supabase
    .from('appointments')
    .select('id, status, confirmation_sent_at')
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .maybeSingle();
  if (error) {
    logger.error({ err: error }, 'resend-confirmation lookup failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  if (!appt) return res.status(404).json({ error: 'Not found' });

  try {
    const result = await notifyBookingConfirmed(appt.id);
    logger.info({ appointmentId: appt.id, sent: !!result?.sent, reason: result?.reason }, 'Confirmation re-sent from the app');
    return res.json({
      sent: !!result?.sent,
      channels: result?.channels || [],
      reason: result?.reason || null,
    });
  } catch (err) {
    logger.error({ err, appointmentId: appt.id }, 'resend-confirmation failed');
    return res.status(500).json({ sent: false, reason: 'delivery_failed' });
  }
});

/**
 * HER APPOINTMENT MOVED AND NOBODY TOLD HER.
 *
 * Dragging a card to a new time on the calendar comes through PATCH, and it
 * changed a client's appointment in silence: Ellie's diary said one thing and
 * the client had another in her head, so she arrived at the old time. The voice
 * assistant has told the client since it was written (voice-tools toolReschedule);
 * this is the same sentence, sent the same way, so there is one wording for
 * "your appointment has moved" wherever the move came from.
 *
 * Goes through the outbound guard like every other message Florrie sends on
 * Ellie's behalf, and obeys the master pause.
 */
async function notifyAppointmentMoved(beauticianId, appt) {
  const { data: biz, error: bizErr } = await supabase
    .from('beauticians')
    .select('client_reminder_prefs')
    .eq('id', beauticianId)
    .maybeSingle();
  if (bizErr) {
    logger.error({ err: bizErr, appointmentId: appt.id }, 'appointment moved: could not read messaging preferences');
    return;
  }
  const prefs = biz?.client_reminder_prefs || {};

  // ALWAYS SENDS. Telling a client their appointment moved is the client's own
  // booking admin, not Florrie speaking on Ellie's behalf, and it is the one
  // message where silence is most expensive: they turn up at the old time. See
  // the note in services/notifications.js notifyBookingConfirmed.

  const { data: client } = await supabase
    .from('clients')
    .select('id, first_name, phone, email, whatsapp_id, instagram_id')
    .eq('id', appt.client_id)
    .maybeSingle();
  if (!client) return;

  // Wall-time convention: starts_at holds salon wall time inside a UTC slot, so
  // it is read with timeZone UTC. Intl-converting this is the BST hour drift.
  const when = new Date(`${String(appt.starts_at).slice(0, 19)}Z`);
  if (isNaN(when.getTime())) return;
  const dateLabel = when.toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  const timeLabel = when.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' });
  const treatmentName = appt.treatments?.name || 'appointment';
  const body = `Hi ${client.first_name || 'there'}! Quick update, your ${treatmentName} has been moved to ${dateLabel} at ${timeLabel}. See you then!`;

  // 'reschedule' is transactional, so the guard passes it through rather than
  // holding it for approval, and it is still what records the send.
  await guardedSend({
    beauticianId,
    clientId: client.id,
    messageType: 'reschedule',
    channel: pickChannel(client, prefs) || 'sms',
    client,
    body,
    send: async () => !!(await sendMessage({ client, body, beauticianId, beauticianPrefs: prefs })),
  });
}

/**
 * PATCH /api/appointments/:id
 * Update appointment status, reschedule, add notes.
 */
router.patch('/:id', requireAuth, async (req, res) => {
  const allowedFields = [
    'status', 'starts_at', 'ends_at', 'beautician_notes',
    'no_show_fee_charged', 'treatment_id', 'duration_minutes',
    // Extra treatments on an appointment that already exists. Ellie's ask: a
    // client turns up for a patch test and has an infill done at the same time.
    'extra_treatment_ids',
  ];

  const VALID_TRANSITIONS = {
    'pending': ['confirmed', 'cancelled'],
    'confirmed': ['completed', 'cancelled', 'no_show'],
    'completed': [],
    'cancelled': [],
    'no_show': []
  };

  const updates = {};
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  }

  // Extra treatment ids are shaped-checked before the ownership pass, so a
  // malformed body is a plain 400 rather than a row of pointless lookups.
  let extraIds = null;      // the ids she wants attached, [] means clear them
  let extraStore = undefined; // what goes in the column: an array, or null for none
  if (req.body.extra_treatment_ids !== undefined) {
    const parsed = parseExtraTreatmentIds(req.body.extra_treatment_ids);
    if (!parsed.ok) return res.status(400).json({ error: parsed.error });
    extraIds = parsed.ids;
    extraStore = parsed.store;
    updates.extra_treatment_ids = extraStore;
  }

  // treatment_id and every extra treatment id come straight from the body.
  // Without this, a booking can be repointed at (or padded out with) another
  // salon's treatment, which then drives its price, its duration and the
  // ends_at recomputed below. The backend uses the service key, so RLS is
  // bypassed and this is the only check there is. 404 rather than 403, so the
  // response does not confirm the treatment exists.
  if (!await requireOwned(req, res, [
    { table: 'treatments', id: req.body.treatment_id },
    // Deduplicated: two of the same treatment is a legitimate booking, but it
    // is one ownership question, not two.
    ...[...new Set(extraIds || [])].map(id => ({ table: 'treatments', id })),
  ])) return;

  // Validate status transition if status is being updated
  if (req.body.status !== undefined) {
    const { data: existing } = await supabase
      .from('appointments')
      .select('status')
      .eq('id', req.params.id)
      .eq('beautician_id', req.beautician.id)
      .single();

    if (!existing) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    const currentStatus = existing.status;
    const newStatus = req.body.status;
    const allowedTransitions = VALID_TRANSITIONS[currentStatus] || [];

    if (!allowedTransitions.includes(newStatus)) {
      return res.status(400).json({
        error: `Cannot transition from '${currentStatus}' to '${newStatus}'`,
        currentStatus,
        allowedTransitions
      });
    }
  }

  // Track cancellation
  if (req.body.status?.startsWith('cancelled')) {
    updates.cancelled_at = new Date().toISOString();
    updates.cancellation_reason = req.body.cancellation_reason || null;
  }

  // If moving the appointment (new starts_at), store wall-clock and recompute
  // ends_at from the treatment length. Appointment times are wall-clock strings
  // (no trailing Z): the frontend sends "...T14:00:00.000Z", so we slice to the
  // first 16 chars (YYYY-MM-DDTHH:MM) and rebuild as a plain wall-clock string,
  // exactly how manual-create stores it. Never toISOString() here - that would
  // convert to UTC and shift the day/hour under British Summer Time.
  let movedFromStartsAt = null;  // set only when this request actually moves it
  if (req.body.starts_at) {
    const m = String(req.body.starts_at).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!m) {
      return res.status(400).json({ error: 'That date and time look wrong. Please pick again.' });
    }
    const [, yy, mo, dd, hh, mi] = m;
    updates.starts_at = `${yy}-${mo}-${dd}T${hh}:${mi}:00`;

    // Read the current start before it is overwritten. Comparing on the wall
    // minute, so re-saving a sheet without touching the time does not text the
    // client to tell her nothing has changed.
    const { data: existing } = await supabase
      .from('appointments')
      .select('starts_at, duration_minutes, buffer_minutes, extra_padding_minutes')
      .eq('id', req.params.id)
      .single();

    if (existing && String(existing.starts_at || '').slice(0, 16) !== updates.starts_at.slice(0, 16)) {
      movedFromStartsAt = existing.starts_at;
    }

    // Recompute ends_at unless the caller passed one explicitly.
    if (!req.body.ends_at) {
      if (existing) {
        const total = (existing.duration_minutes || 0) + (existing.buffer_minutes || 0) + (existing.extra_padding_minutes || 0);
        // UTC arithmetic on the wall-clock parts, then read the parts straight
        // back out, so no local timezone leaks into the stored string.
        const endDate = new Date(Date.UTC(Number(yy), Number(mo) - 1, Number(dd), Number(hh), Number(mi) + total));
        const pad = (n) => String(n).padStart(2, '0');
        updates.ends_at = `${endDate.getUTCFullYear()}-${pad(endDate.getUTCMonth() + 1)}-${pad(endDate.getUTCDate())}T${pad(endDate.getUTCHours())}:${pad(endDate.getUTCMinutes())}:00`;
      }
    }
  }

  // THE TREATMENTS ON THIS APPOINTMENT, WHATEVER THEY NOW ARE.
  //
  // Ellie: "she is trying to add to a patch test appointment and can't. And
  // then the time change auto also." A patch test carries no treatment_id (it
  // is not one of her priced treatments), so the sheet's Change dropdown was
  // keyed on null and there was no way in at all. This branch takes the WHOLE
  // set, base plus every extra, and recomputes length, price and finish time
  // in one pass, so she never works out the new end time herself.
  //
  // It also owns a plain treatment_id swap, which used to have its own branch
  // that read the new treatment's length as THE length. That was fine while a
  // booking could only hold one treatment: with extras attached it silently
  // dropped their time and their money off the row while leaving them listed.
  // One path, one answer. A swap on a booking with no extras comes out exactly
  // as it did before, with a clash check it did not have.
  if (req.body.extra_treatment_ids !== undefined || req.body.treatment_id) {
    const { data: current, error: curErr } = await supabase
      .from('appointments')
      .select('starts_at, ends_at, treatment_id, extra_treatment_ids, duration_minutes, price_cents, buffer_minutes, extra_padding_minutes')
      .eq('id', req.params.id)
      .eq('beautician_id', req.beautician.id)
      .maybeSingle();
    if (curErr) {
      logger.error({ err: curErr, appointmentId: req.params.id }, 'extra treatments: could not load appointment');
      return res.status(500).json({ error: 'Something went wrong' });
    }
    if (!current) return res.status(404).json({ error: 'Appointment not found' });

    // The base is whatever the treatment is AFTER this request: a treatment_id
    // in the same body wins, otherwise the one already on the row. Both went
    // through the ownership pass above.
    const baseId = req.body.treatment_id || current.treatment_id || null;
    const currentExtraIds = Array.isArray(current.extra_treatment_ids) ? current.extra_treatment_ids : [];
    // A body that says nothing about extras is not saying "remove them". Only
    // an explicit list (including an empty one) changes what is attached.
    const nextExtraIds = extraIds !== null ? extraIds : currentExtraIds;

    // One query for every treatment involved: the base, the extras being
    // attached, and the extras ALREADY attached. The last of those is what
    // lets a patch test keep its own ten minutes (see ownTotals).
    const wanted = [...new Set([baseId, ...nextExtraIds, ...currentExtraIds].filter(Boolean))];
    let byId = {};
    if (wanted.length > 0) {
      const { data: rows, error: tErr } = await supabase
        .from('treatments')
        .select('id, name, duration_minutes, price_cents')
        .eq('beautician_id', req.beautician.id)
        .in('id', wanted);
      if (tErr) {
        logger.error({ err: tErr, appointmentId: req.params.id }, 'extra treatments: could not load treatments');
        return res.status(500).json({ error: 'Something went wrong' });
      }
      byId = Object.fromEntries((rows || []).map(t => [t.id, t]));
    }

    // A treatment that vanished between her tapping and this request would
    // otherwise be priced at zero minutes and zero pounds. Refuse instead.
    if (baseId && !byId[baseId]) {
      return res.status(400).json({ error: 'That treatment was not found.' });
    }
    for (const id of nextExtraIds) {
      if (!byId[id]) {
        // Only ever raised for extras she just picked. An extra already on the
        // row that has since been deleted is handled below, not rejected here,
        // because refusing would lock her out of her own appointment.
        if (extraIds && extraIds.includes(id)) {
          return res.status(400).json({ error: 'One of those treatments was not found.' });
        }
      }
    }

    const extraTreatments = nextExtraIds.map(id => byId[id]).filter(Boolean);
    // An already-attached extra that has since been deleted just drops out of
    // the subtraction. Undercounting what to take off is the safe direction:
    // it leaves the appointment longer than it should be, never shorter, so
    // nothing lands on top of the next client.
    const currentExtras = currentExtraIds.map(id => byId[id]).filter(Boolean);

    const totals = recomputeTotals({
      baseTreatment: baseId ? byId[baseId] : null,
      extraTreatments,
      existing: current,
      currentExtras,
    });

    // Re-end from the new start if she is moving it in the same request,
    // otherwise from where it already is. Wall frame only, see endsAtWall.
    const startStr = updates.starts_at || current.starts_at;
    const newEnd = endsAtWall(startStr, totals.blockMinutes);
    if (!newEnd) {
      return res.status(400).json({ error: 'This appointment has no usable start time.' });
    }

    updates.duration_minutes = totals.durationMinutes;
    updates.price_cents = totals.priceCents;
    updates.ends_at = newEnd;

    // Clash check, same rule as the length change: only when the new end
    // pushes PAST the current one. Thirteen legacy bookings deliberately
    // overlap, and taking a treatment OFF one of those must not be rejected
    // for an overlap it is actually reducing.
    if (newEnd.slice(0, 16) > String(current.ends_at || '').slice(0, 16)) {
      const newStartIso = `${String(startStr).slice(0, 16)}:00.000Z`;
      const newEndIso = `${newEnd.slice(0, 16)}:00.000Z`;
      const { data: clashes, error: clashErr } = await supabase
        .from('appointments')
        .select('id')
        .eq('beautician_id', req.beautician.id)
        .neq('id', req.params.id)
        .not('status', 'in', '(cancelled,cancelled_by_client,cancelled_by_beautician,no_show)')
        .lt('starts_at', newEndIso)
        .gt('ends_at', newStartIso)
        .limit(1);
      if (clashErr) {
        // Cannot read the diary = do not write. A blind write here would
        // double-book a client.
        logger.error({ err: clashErr, appointmentId: req.params.id }, 'extra treatments: clash check failed');
        return res.status(500).json({ error: 'Could not check the diary just then. Nothing was changed, try again.' });
      }
      if (clashes && clashes.length > 0) {
        return res.status(409).json({ error: 'That runs into the next booking. Move the time first, or take something off.' });
      }
    }
  }

  // Shorten (or lengthen) a booking without changing the treatment. Ellie's
  // ask: a client wants less doing today, so the slot should give the time
  // back to the diary. ends_at is recomputed from starts_at + the new length
  // in the WALL frame (string/UTC arithmetic only, exactly like the branches
  // above) - never new Date(local).toISOString(), which shifts an hour in BST.
  if (req.body.duration_minutes !== undefined) {
    const dur = Number(req.body.duration_minutes);
    if (!Number.isInteger(dur) || dur < 5 || dur > 480) {
      return res.status(400).json({ error: 'Duration must be between 5 minutes and 8 hours.' });
    }

    const { data: current, error: curErr } = await supabase
      .from('appointments')
      .select('starts_at, ends_at, buffer_minutes, extra_padding_minutes')
      .eq('id', req.params.id)
      .eq('beautician_id', req.beautician.id)
      .maybeSingle();
    if (curErr) {
      logger.error({ err: curErr, appointmentId: req.params.id }, 'duration change: could not load appointment');
      return res.status(500).json({ error: 'Something went wrong' });
    }
    if (!current) return res.status(404).json({ error: 'Appointment not found' });

    const startStr = updates.starts_at || current.starts_at;
    const dm = String(startStr || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!dm) {
      return res.status(400).json({ error: 'This appointment has no usable start time.' });
    }
    updates.duration_minutes = dur;

    // Buffer and extra padding stay part of the blocked slot, same as every
    // other ends_at computation in this file.
    const [, dy, dmo, ddd, dhh, dmi] = dm;
    const total = dur + (current.buffer_minutes || 0) + (current.extra_padding_minutes || 0);
    const dEnd = new Date(Date.UTC(Number(dy), Number(dmo) - 1, Number(ddd), Number(dhh), Number(dmi) + total));
    const dp = (n) => String(n).padStart(2, '0');
    updates.ends_at = `${dEnd.getUTCFullYear()}-${dp(dEnd.getUTCMonth() + 1)}-${dp(dEnd.getUTCDate())}T${dp(dEnd.getUTCHours())}:${dp(dEnd.getUTCMinutes())}:00`;

    // Clash check, mirroring voice-tools toolReschedule: never let a longer
    // slot land on top of another live booking. Only checked when the new end
    // pushes PAST the current one - a handful of legacy bookings deliberately
    // overlap, and shortening one of those must not be rejected for an
    // overlap it is actually reducing.
    const currentEndWall = String(current.ends_at || '').slice(0, 16);
    if (updates.ends_at.slice(0, 16) > currentEndWall) {
      const newStartIso = `${dy}-${dmo}-${ddd}T${dhh}:${dmi}:00.000Z`;
      const newEndIso = `${updates.ends_at.slice(0, 16)}:00.000Z`;
      const { data: clashes, error: clashErr } = await supabase
        .from('appointments')
        .select('id')
        .eq('beautician_id', req.beautician.id)
        .neq('id', req.params.id)
        .not('status', 'in', '(cancelled,cancelled_by_client,cancelled_by_beautician,no_show)')
        .lt('starts_at', newEndIso)
        .gt('ends_at', newStartIso)
        .limit(1);
      if (clashErr) {
        // Cannot verify the diary = do not write. Failing closed here is the
        // safe direction: a blind write could double-book a client.
        logger.error({ err: clashErr, appointmentId: req.params.id }, 'duration change: clash check failed');
        return res.status(500).json({ error: 'Could not check the diary just then. Nothing was changed, try again.' });
      }
      if (clashes && clashes.length > 0) {
        return res.status(409).json({ error: 'That length runs into the next booking. Move the time first, or pick a shorter length.' });
      }
    }
  }

  const { data, error } = await supabase
    .from('appointments')
    .update(updates)
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .select('*, clients(first_name, last_name), treatments(name)')
    .single();

  if (error) {
    // 23505 = no-double-book unique guard (same start); 23P01 = no-overlap
    // exclusion guard (overlapping times). Either means the new slot is taken,
    // so the move is rejected and the old time is kept.
    if (error.code === '23505' || error.code === '23P01') {
      return res.status(409).json({ error: 'That time is already booked.' });
    }
    logger.error({ err: error }, 'Failed to update appointment');
    return res.status(500).json({ error: 'Something went wrong' });
  }

  // The move is saved, so tell the client where to turn up. Fire and forget:
  // a messaging failure must not fail a change that has already happened, and
  // it must not happen at all if the write did not (this sits below the error
  // return above on purpose). Only for a booking that is still going to happen:
  // tidying the time on something already cancelled, completed or no-showed is
  // bookkeeping, and texting somebody about it would be nonsense.
  const stillHappening = ['pending', 'confirmed', 'in_progress'].includes(String(data?.status || ''));
  if (movedFromStartsAt && data?.client_id && stillHappening) {
    notifyAppointmentMoved(req.beautician.id, data).catch(err =>
      logger.error({ err, appointmentId: data.id }, 'appointment moved: client was not told'));
  }

  // Fire-and-forget: award loyalty points when marked completed (idempotent)
  if (req.body.status === 'completed') {
    awardLoyaltyPoints(req.beautician.id, data).catch(() => {});
    // Count the visit and the spend. clients.total_spend_cents is what the
    // client profile's "spent" figure reads, and only /complete-day ever
    // incremented it, so anyone completed by THIS path (the normal one-tap
    // complete) showed as 0 pounds spent forever. Ellie: "says 0 spent but
    // this client been to me 3 times this month".
    if (data.client_id) {
      const { error: visitErr } = await supabase.rpc('increment_client_visit', {
        p_client_id: data.client_id,
        p_amount: data.price_cents || 0,
      });
      if (visitErr) logger.error({ err: visitErr, appointmentId: data.id }, 'quick complete: visit increment failed');
    }
    // Log takings so the Money tab counts this as income, exactly like the
    // auto-complete sweep and the "All done" batch. Without this, tapping a
    // single appointment complete recorded NO income, so the Money page read
    // far too low. Guarded + null-method so it never double-logs and the
    // no_show reversal above still clears it.
    logAssumedTakings(req.beautician.id, data).catch(err =>
      logger.error({ err, appointmentId: data.id }, 'manual complete takings log failed'));
  }

  if (req.body.status === 'no_show') {
    // Reverse any assumed/auto takings for this appointment so the Money tab
    // drops the income - the appointment didn't happen. Assumed takings (from
    // auto-complete or the "All done" batch) are type 'payment' with a null
    // method; real card charges (deposits, balance) keep a method and are left
    // alone. This is what makes "mark a no-show at the end of the day" update
    // everything, even for appointments that already auto-completed.
    // The shape here IS the assumed row, and it is now named: see
    // isAssumedTakingsRow in lib/money-guards.js. The intent-id clause is new
    // (27 August 2026): a real charge always carries one, so this can never
    // delete money that actually moved even if its method column is somehow
    // empty. Belt and braces on a delete against the money table.
    const { error: revErr } = await supabase
      .from('transactions')
      .delete()
      .eq('appointment_id', req.params.id)
      .eq('type', 'payment')
      .is('payment_method', null)
      .is('stripe_payment_intent_id', null);
    if (revErr) logger.error({ err: revErr, appointmentId: req.params.id }, 'no_show takings reversal failed');

    // Fire-and-forget: auto-charge the no-show fee to the saved card when the
    // beautician's policy has one configured (idempotent, no-op otherwise).
    chargePolicyFee(req.params.id, 'no_show').catch(err =>
      logger.error({ err, appointmentId: req.params.id }, 'no_show policy fee charge failed (non-fatal)')
    );
  }

  // The sheet lists every treatment on the appointment by name. treatments()
  // only joins the base one, and extra_treatment_ids is a bare array of uuids,
  // so name the extras here rather than making the app guess. Fail-soft: a
  // failure here costs the names, not the change she just made.
  if (Array.isArray(data.extra_treatment_ids) && data.extra_treatment_ids.length > 0) {
    const { data: extraRows, error: exErr } = await supabase
      .from('treatments')
      .select('id, name, duration_minutes, price_cents')
      .eq('beautician_id', req.beautician.id)
      .in('id', data.extra_treatment_ids);
    if (exErr) {
      logger.error({ err: exErr, appointmentId: data.id }, 'could not name the extra treatments');
    } else {
      const nameById = Object.fromEntries((extraRows || []).map(t => [t.id, t]));
      // Mapped over the stored ids, not the query result, so the order she
      // added them in survives and a repeated treatment appears twice.
      data.extra_treatments = data.extra_treatment_ids.map(id => nameById[id]).filter(Boolean);
    }
  } else {
    data.extra_treatments = [];
  }

  res.json({ appointment: data });
});

/**
 * DELETE /api/appointments/:id
 * Remove an appointment that was added by mistake (e.g. wrong time).
 * Guarded: if money is attached (a deposit was paid or a policy fee charged) we
 * do NOT hard-delete, because that would orphan the payment record. In that case
 * the beautician should cancel (and refund if needed) instead. Mis-entries, which
 * is what this is for, have no payment and are hard-removed.
 */
router.delete('/:id', requireAuth, async (req, res) => {
  // A booking with money on it used to be UNDELETABLE: hard 409, "cancel it
  // instead", no way through. That left Ellie stuck with bookings she could
  // not clear off her calendar. It is her diary, so she can always delete.
  // We warn her first (409 + requires_confirmation), and when she confirms
  // (?force=true) we delete the booking but KEEP the money record, unlinked,
  // so her takings and Stripe history stay intact.
  const force = req.query.force === 'true' || req.body?.force === true;

  const { data: appt, error: fetchErr } = await supabase
    .from('appointments')
    .select('id, deposit_paid, deposit_cents, policy_fee_charged_at, status, starts_at, stripe_payment_intent_id')
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .single();

  if (fetchErr || !appt) {
    return res.status(404).json({ error: 'Appointment not found' });
  }

  const { data: paidTx, error: txErr } = await supabase
    .from('transactions')
    .select('id')
    .eq('appointment_id', appt.id)
    .or('stripe_payment_intent_id.not.is.null,stripe_charge_id.not.is.null')
    .limit(1);

  // An unreadable money check is not an empty money check. PostgREST returns
  // its errors in the result object, so the old unchecked destructure left
  // paidTx null and read as "no payment on this booking", which is the one
  // answer that lets a paid booking be deleted without so much as a warning.
  // Refuse, and refuse even with force, because the warning she would be
  // confirming could not be written truthfully.
  if (txErr) {
    logger.error({ err: txErr, appointmentId: appt.id }, 'delete refused: could not read the payments on this booking');
    return res.status(503).json({
      error: "I couldn't check whether this booking has been paid for, so nothing has been deleted. Try again in a moment.",
      code: 'payment_check_failed',
    });
  }

  const hasCardPayment = !!(paidTx && paidTx.length);

  // CHARLOTTE'S EIGHTY POUNDS.
  //
  // On 5 August she had paid in full and both `deposit_paid` and her
  // transactions row said otherwise, because the webhook that writes them had
  // been dead since launch. Everything this guard consulted was downstream of
  // the same broken pipe, so the booking she had paid for was one tap from
  // being deleted with no warning at all.
  //
  // A pinned payment intent is upstream of that pipe: it is written when the
  // Checkout session is created, whether or not any event ever comes back. So
  // its mere presence means money may exist, and we ask Stripe itself. Only a
  // definite "no" from Stripe clears a booking that carries one; unknown
  // counts as money, because the cost of being wrong is asymmetric.
  const intentPaid = appt.stripe_payment_intent_id ? await stripeSaysPaid(appt.stripe_payment_intent_id) : false;
  const hasIntentMoney = !!appt.stripe_payment_intent_id && intentPaid !== false;

  const hasMoney = appt.deposit_paid === true || !!appt.policy_fee_charged_at || hasCardPayment || hasIntentMoney;

  if (hasMoney && !force) {
    const bits = [];
    if (appt.deposit_paid && appt.deposit_cents > 0) bits.push(`a £${(appt.deposit_cents / 100).toFixed(2)} deposit`);
    else if (appt.deposit_paid) bits.push('a paid deposit');
    if (appt.policy_fee_charged_at) bits.push('a charged policy fee');
    if (hasCardPayment && !bits.length) bits.push('a card payment');
    if (hasIntentMoney && !bits.length) {
      bits.push(intentPaid === true
        ? 'a card payment Stripe has confirmed'
        : 'a card payment we cannot rule out');
    }
    const what = bits.join(' and ');

    return res.status(409).json({
      code: 'has_payment',
      requires_confirmation: true,
      error: `This booking has ${what} on it.`,
      warning: `This booking has ${what} on it. Deleting it will NOT refund the client, and it will not tell them the appointment is gone. The payment stays in your takings. If you want the client told and the deposit handled by your policy, cancel it instead. Delete anyway?`,
    });
  }

  // Several tables reference appointments(id) with NO ON DELETE rule, so a
  // booking that has been completed (assumed-takings row), had a consultation
  // form, earned loyalty, etc. would fail to delete with a foreign-key error
  // (the old "Something went wrong"). Clear those dependents first.
  //
  // Real card payments are UNLINKED, never deleted: the money genuinely moved,
  // so it has to survive in her books. Only the assumed-takings rows (no Stripe
  // id) go with the booking.
  await supabase
    .from('transactions')
    .delete()
    .eq('appointment_id', appt.id)
    .is('stripe_payment_intent_id', null)
    .is('stripe_charge_id', null);
  await supabase.from('transactions').update({ appointment_id: null }).eq('appointment_id', appt.id);

  // A patch test booked against this appointment goes back to "not booked yet",
  // so the client can pick a new time instead of being silently left without one.
  try {
    await supabase
      .from('patch_tests')
      .update({ appointment_id: null, confirmed_at: null, suggested_slot: null })
      .eq('appointment_id', appt.id);
  } catch (e) {
    logger.warn({ err: e }, 'Could not release patch test on appointment delete');
  }

  for (const tbl of ['consultations', 'form_submissions', 'loyalty_points', 'ai_actions', 'reviews']) {
    try {
      await supabase.from(tbl).update({ appointment_id: null }).eq('appointment_id', appt.id);
    } catch (e) {
      logger.warn({ err: e, table: tbl }, 'Could not unlink dependent on appointment delete');
    }
  }

  if (hasMoney) {
    logger.warn({ id: appt.id, beauticianId: req.beautician.id, hasCardPayment, hasIntentMoney, intentPaid }, 'Appointment with payment force-deleted');
  }

  const { error } = await supabase
    .from('appointments')
    .delete()
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id);

  if (error) {
    logger.error({ err: error }, 'Failed to delete appointment');
    return res.status(500).json({ error: "Couldn't delete this booking. If it has a payment, cancel it instead." });
  }

  res.json({ success: true });
});

/**
 * POST /api/appointments/:id/charge-balance
 * Charge the client's remaining balance (price minus deposit paid) to their
 * saved card. The fallback for when they don't pay the rest by bank transfer.
 */
router.post('/:id/charge-balance', requireAuth, async (req, res) => {
  const { data: appt } = await supabase
    .from('appointments')
    .select('id')
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .maybeSingle();
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });

  const result = await chargeRemainingBalance(req.params.id);
  if (result.charged) {
    return res.json({ success: true, amountCents: result.amountCents });
  }
  const messages = {
    nothing_due: 'There is no balance left to charge.',
    // 'already_charged' now means what it says. It used to include the assumed
    // takings row completion writes, so it fired on every completed booking for
    // money that had never touched a card, which is exactly what stopped the
    // salon owner charging a card after a booking said completed (27 August
    // 2026). Only a real payment reaches this message now.
    already_charged: 'This has already been paid, so nothing was charged.',
    paid_in_full: 'This booking was paid in full at booking. There is nothing left to charge.',
    guard_unreadable: 'Could not verify what has already been paid, so nothing was charged. Try again in a moment.',
    no_card_on_file: 'No saved card on file for this client. Cards are only saved when deposits (card required at booking) are turned on in Settings. For a client with no card, send them a payment link instead.',
    stripe_not_onboarded: 'Connect your Stripe payouts first to charge cards.',
    stripe_not_configured: 'Card payments are not set up.',
    card_declined: "The client's card was declined.",
    authentication_required: "The client's card needs extra authentication, send them a payment link instead.",
  };
  return res.status(400).json({ error: messages[result.reason] || 'Could not charge the balance', reason: result.reason });
});

/**
 * GET /api/appointments/:id/card
 * Is there a card we can charge for this client, and which one? Lets the app
 * tell Ellie BEFORE she tries, instead of surfacing it as an error.
 */
router.get('/:id/card', requireAuth, async (req, res) => {
  const { data: appt } = await supabase
    .from('appointments')
    .select('id, price_cents, deposit_cents, deposit_paid, payment_type')
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .maybeSingle();
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });

  // Outstanding balance, IDENTICAL arithmetic to chargeRemainingBalance: a
  // pay-in-full booking owes nothing regardless of what price minus deposit
  // says, because deposit_cents still carries the standard deposit figure on
  // those rows. Computed here so the sheet's breakdown, the collect button
  // and the actual charge can never disagree with each other.
  const outstandingCents = appt.payment_type === 'full'
    ? 0
    : Math.max(0, (appt.price_cents || 0) - (appt.deposit_paid ? (appt.deposit_cents || 0) : 0));

  // What the books actually say about this booking's price, split into the two
  // things that were indistinguishable until 27 August 2026, when the salon
  // owner asked how to charge a card after a booking says completed:
  //
  //   assumed  a row completion wrote to make the Money tab add up. Nobody
  //            handed over anything; Florrie guessed she was paid in the room.
  //   settled  a row with a Stripe intent, or a cash/transfer she keyed in.
  //            Money that really moved.
  //
  // outstanding_cents keeps its old meaning (price minus deposit) because it is
  // the arithmetic chargeRemainingBalance performs, and the two must never
  // disagree. uncollected_cents is the honest figure to put in front of her:
  // what could still be taken. An assumption does not reduce it.
  const { data: priceRows, error: priceRowsError } = await supabase
    .from('transactions')
    .select('id, type, amount_cents, payment_method, stripe_payment_intent_id')
    .eq('appointment_id', req.params.id)
    .in('type', PRICE_SETTLED_TYPES);

  // Read the error: PostgREST resolves with { data: null, error }, and a silent
  // null here would tell the sheet "nothing is assumed", which is the one wrong
  // answer. takings_readable false means the app says nothing rather than
  // something confident and false.
  if (priceRowsError) {
    logger.error({ err: priceRowsError, appointmentId: req.params.id }, 'card: could not read what has been paid');
  }

  const assumedCents = priceRowsError ? 0 : assumedTakingsCents(priceRows);
  const settledCents = priceRowsError ? 0 : settledPriceCents(priceRows);
  const uncollected = priceRowsError ? outstandingCents : uncollectedCents(outstandingCents, priceRows);

  // Fee preview so the app can say what actually reaches the beautician.
  // ?amount_cents previews a custom figure; default is what is still collectable.
  const q = Number.parseInt(req.query.amount_cents, 10);
  const previewCents = Number.isFinite(q) && q > 0 ? q : uncollected;

  const card = await getCardOnFile(req.params.id);
  res.json({
    ...card,
    outstanding_cents: outstandingCents,
    takings_readable: !priceRowsError,
    assumed_cents: assumedCents,
    settled_cents: settledCents,
    uncollected_cents: uncollected,
    fees: feePreview(previewCents),
  });
});

/**
 * POST /api/appointments/:id/charge-card  { amount_cents, reason }
 * Charge an amount Ellie types to the client's saved card. She confirms every
 * charge herself; nothing here happens automatically.
 */
router.post('/:id/charge-card', requireAuth, async (req, res) => {
  const { data: appt } = await supabase
    .from('appointments')
    .select('id')
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .maybeSingle();
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });

  const result = await chargeCardAmount(req.params.id, req.body?.amount_cents, req.body?.reason);
  if (result.charged) {
    return res.json({ success: true, amountCents: result.amountCents, paymentIntentId: result.paymentIntentId });
  }
  const messages = {
    amount_too_small: 'The smallest charge is 30p.',
    amount_too_large: 'That amount looks too high. The most you can charge in one go is £1000.',
    no_card_on_file: 'No saved card for this client. Cards are saved when a client pays a deposit online, so for a booking you added yourself, send them a payment link instead.',
    stripe_not_onboarded: 'Finish your Stripe setup before charging cards.',
    stripe_not_configured: 'Card payments are not set up.',
    card_declined: "The card was declined. Send them a payment link instead.",
    authentication_required: 'That card needs the client to approve the payment. Send them a payment link instead.',
  };
  return res.status(400).json({ error: messages[result.reason] || 'Could not charge the card', reason: result.reason });
});

/**
 * POST /api/appointments/:id/complete
 * Mark appointment as completed + auto-log income transaction.
 */
router.post('/:id/complete', requireAuth, async (req, res) => {
  // Nothing in the frontend calls this endpoint, but it was live and had NO
  // status guard: every repeat call inserted another full-price transaction
  // and incremented the visit count again. Guarded compare-and-swap so a
  // second call is a harmless no-op instead of double-counted money.
  const { data: appointment, error } = await supabase
    .from('appointments')
    .update({ status: 'completed' })
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .eq('status', 'confirmed')
    .select()
    .maybeSingle();

  if (!error && !appointment) {
    return res.status(409).json({ error: 'Appointment already completed or not completable' });
  }

  if (error) {
    logger.error({ err: error }, 'Failed to mark appointment as completed');
    return res.status(500).json({ error: 'Something went wrong' });
  }

  // Auto-log the income transaction.
  //
  // This used to insert appointment.price_cents, unchecked, while the
  // auto-complete sweep logged price MINUS the deposit already paid. Two paths
  // to the same outcome disagreed, so a deposit-paid booking over-reported
  // income by the deposit whenever it was completed this way. Both paths now
  // go through logAssumedTakings, which cannot drift because there is only one
  // of it, and which checks its own insert and captures the failure.
  const takingsResult = await logAssumedTakings(req.beautician.id, appointment);
  if (!takingsResult.logged && takingsResult.reason === 'insert_failed') {
    // Do not tell her it worked. The appointment is completed either way, but
    // the takings are not in the books.
    logger.error({ appointmentId: appointment.id }, 'complete: appointment flipped but takings were not logged');
  }

  // Update client stats. The lifetime spend on the client record is the FULL
  // price (the deposit was part of what they paid), unlike the takings row
  // above which is only what is left to bank. Same as the cron.
  const { error: visitErr } = await supabase.rpc('increment_client_visit', {
    p_client_id: appointment.client_id,
    p_amount: appointment.price_cents
  });
  if (visitErr) {
    logger.error({ err: visitErr, appointmentId: appointment.id }, 'complete: visit increment failed');
  }

  // Fire-and-forget: update client intelligence
  updateClientIntelligence(req.beautician.id, appointment.client_id).catch(() => {});

  // Fire-and-forget: award loyalty points (idempotent, no-op when loyalty is off)
  awardLoyaltyPoints(req.beautician.id, appointment).catch(() => {});

  // Fire-and-forget: schedule review request (2hr delay, SMS/WhatsApp + email)
  if (appointment.client_id) {
    scheduleReviewRequest(req.beautician.id, appointment.id, appointment.client_id)
      .catch(err => logger.warn({ err }, 'Review request scheduling failed'));
  }

  res.json({ appointment });
});

/**
 * POST /api/appointments/complete-day
 * Mark all confirmed appointments that have ended as completed.
 * Optional { date } (defaults to today).
 * Returns { count, completed_appointments }.
 */
router.post('/complete-day', requireAuth, validate(completeDaySchema), async (req, res) => {
  try {
    // Use provided date or today
    const dateStr = req.body.date || new Date().toISOString().split('T')[0];
    const [year, month, day] = dateStr.split('-').map(Number);

    // Start of day (00:00:00)
    const dayStart = new Date(year, month - 1, day, 0, 0, 0);
    const dayStartIso = dayStart.toISOString();

    // End of day (23:59:59)
    const dayEnd = new Date(year, month - 1, day, 23, 59, 59);
    const dayEndIso = dayEnd.toISOString();

    // Find all confirmed appointments for this beautician on this day
    // that have ended (ends_at < now)
    const now = new Date().toISOString();

    const { data: appointments, error: fetchError } = await supabase
      .from('appointments')
      // deposit_cents / deposit_paid are needed to work out the takings.
      // Without them every completion here logs the FULL price and
      // double-counts the deposit the client already paid at booking.
      .select('id, starts_at, ends_at, status, client_id, price_cents, deposit_cents, deposit_paid')
      .eq('beautician_id', req.beautician.id)
      .eq('status', 'confirmed')
      .gte('starts_at', dayStartIso)
      .lte('starts_at', dayEndIso)
      .lt('ends_at', now);

    if (fetchError) {
      return res.status(500).json({ error: 'Failed to fetch appointments' });
    }

    if (!appointments || appointments.length === 0) {
      return res.json({
        count: 0,
        message: 'No completed appointments found for this day',
        completed_appointments: []
      });
    }

    // Mark all as completed with timestamp
    const completedAt = new Date().toISOString();
    const ids = appointments.map(a => a.id);

    // Compare-and-swap on status, and keep only the rows WE flipped. The
    // auto-complete cron chases exactly the same appointments, so without this
    // a row it completed between our fetch and our write got its takings and
    // visit counted twice, once by each.
    const { data: flipped, error: updateError } = await supabase
      .from('appointments')
      .update({ status: 'completed', completed_at: completedAt })
      .in('id', ids)
      .eq('status', 'confirmed')
      .select('id');

    if (updateError) {
      return res.status(500).json({ error: 'Failed to update appointments' });
    }
    const flippedIds = new Set((flipped || []).map(r => r.id));

    // Everything after this point acts ONLY on the rows this request flipped.
    // The transactions insert already filtered on flippedIds; the visit loop
    // below did not, and iterated the pre-flip list instead, so every row the
    // auto-complete cron had flipped in the seconds between our read and our
    // write got its visit counted twice and its lifetime spend inflated.
    const flippedAppointments = onlyFlipped(appointments, flippedIds);

    // Auto-log income, one appointment at a time, through the SAME helper the
    // cron and the one-tap complete use. A batch insert here is what let this
    // path drift: it logged the full price while the cron logged the
    // remainder, it had no already-paid guard, and its error was unchecked so
    // a rejected batch lost a whole day's takings in silence.
    let takingsFailures = 0;
    for (const apt of flippedAppointments) {
      const result = await logAssumedTakings(req.beautician.id, apt);
      if (!result.logged && (result.reason === 'insert_failed' || result.reason === 'guard_unreadable')) {
        takingsFailures += 1;
      }
    }
    if (takingsFailures) {
      // The appointments are already marked completed, so she believes she was
      // paid and the Money tab counts nothing.
      logger.error({ beauticianId: req.beautician.id, takingsFailures },
        'complete-day: some appointments completed with no income logged');
      Sentry.captureMessage('Takings lost: complete-day could not log every appointment', {
        level: 'error',
        tags: { area: 'payments', check: 'transaction_insert' },
        extra: {
          beauticianId: req.beautician.id,
          failures: takingsFailures,
          appointmentIds: flippedAppointments.map(a => a.id).slice(0, 25),
        },
      });
    }

    // Update client stats, only for the rows this request flipped.
    for (const apt of flippedAppointments) {
      if (apt.client_id) {
        // Supabase returns a thenable, not a Promise, so destructure the error
        // instead of .catch(). It WAS destructured here and then never read,
        // which is the same as not checking it: a client whose visit count and
        // lifetime spend silently failed to move is how regulars showed zero
        // pounds spent.
        const { error: rpcErr } = await supabase.rpc('increment_client_visit', {
          p_client_id: apt.client_id,
          p_amount: apt.price_cents
        });
        if (rpcErr) {
          logger.error({ err: rpcErr, appointmentId: apt.id, clientId: apt.client_id },
            'complete-day: visit increment failed');
        }
      }

      // Fire-and-forget: update client intelligence
      updateClientIntelligence(req.beautician.id, apt.client_id).catch(() => {});

      // Fire-and-forget: award loyalty points (idempotent, no-op when loyalty is off)
      awardLoyaltyPoints(req.beautician.id, apt).catch(() => {});
    }

    // Report what actually happened, not what we hoped. The old response
    // counted the pre-flip list, so a day where the cron had already done the
    // work still told Ellie she had completed them all.
    res.json({
      count: flippedAppointments.length,
      message: `Marked ${flippedAppointments.length} appointment(s) as completed`,
      completed_appointments: flippedAppointments,
      ...(takingsFailures ? { takings_logged: false, takings_failures: takingsFailures } : {}),
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * GET /api/appointments/slots
 * Get available booking slots for a given date + treatment.
 * Public endpoint (used by booking page).
 */
router.get('/slots', async (req, res) => {
  const { beautician_id, treatment_id, date } = req.query;

  if (!beautician_id || !treatment_id || !date) {
    return res.status(400).json({ error: 'beautician_id, treatment_id, and date are required' });
  }

  // Get beautician working hours
  const { data: beautician } = await supabase
    .from('beauticians')
    .select('working_hours')
    .eq('id', beautician_id)
    .single();

  if (!beautician) return res.status(404).json({ error: 'Beautician not found' });

  // Get treatment duration
  const { data: treatment } = await supabase
    .from('treatments')
    .select('duration_minutes, buffer_minutes')
    .eq('id', treatment_id)
    .single();

  if (!treatment) return res.status(404).json({ error: 'Treatment not found' });

  // Get existing appointments for the date
  const dayStart = `${date}T00:00:00Z`;
  const dayEnd = `${date}T23:59:59Z`;

  const { data: existing } = await supabase
    .from('appointments')
    .select('starts_at, ends_at')
    .eq('beautician_id', beautician_id)
    .in('status', ['confirmed', 'pending', 'in_progress'])
    .gte('starts_at', dayStart)
    .lte('starts_at', dayEnd);

  // Calculate available slots
  const dayOfWeek = new Date(date).toLocaleDateString('en-US', { weekday: 'short' }).toLowerCase();
  const hours = beautician.working_hours?.[dayOfWeek];

  if (!hours) {
    return res.json({ slots: [], message: 'Not available on this day' });
  }

  const slots = generateSlots(
    date,
    hours.start,
    hours.end,
    treatment.duration_minutes + treatment.buffer_minutes,
    existing || []
  );

  res.json({ slots });
});

// Helpers

function generateSlots(date, startTime, endTime, durationMinutes, existingAppointments) {
  const slots = [];
  const slotInterval = 15; // 15-minute slot intervals

  // Build candidate slots in the wall frame (the UTC slot IS the salon wall
  // clock for starts_at), so the conflict check and the stored value line up.
  let current = new Date(`${date}T${startTime}:00Z`);
  const end = new Date(`${date}T${endTime}:00Z`);

  while (current.getTime() + durationMinutes * 60000 <= end.getTime()) {
    const slotEnd = new Date(current.getTime() + durationMinutes * 60000);

    // Check for conflicts
    const hasConflict = existingAppointments.some(appt => {
      const apptStart = new Date(appt.starts_at);
      const apptEnd = new Date(appt.ends_at);
      return current < apptEnd && slotEnd > apptStart;
    });

    if (!hasConflict) {
      slots.push({
        starts_at: current.toISOString(),
        ends_at: slotEnd.toISOString(),
        display: current.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'UTC' })
      });
    }

    current = new Date(current.getTime() + slotInterval * 60000);
  }

  return slots;
}

/**
 * GET /api/appointments/:id/manage-link
 * The client's booking-management link, for Ellie to copy/paste or re-send if
 * a client's original link went astray. management_token is a permanent UUID.
 */
router.get('/:id/manage-link', requireAuth, async (req, res) => {
  const { data: appt } = await supabase
    .from('appointments')
    .select('management_token, client_id, beauticians(booking_slug)')
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .maybeSingle();
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });
  const slug = appt.beauticians?.booking_slug;
  const base = process.env.FRONTEND_URL;
  if (!appt.management_token || !slug || !base) {
    return res.status(409).json({ error: 'Booking link is not available for this appointment yet' });
  }
  // If they still owe a patch test, hand back the deep link so the page opens
  // straight on the picker, and tell the app so it can say so.
  const needsPatchTest = await clientNeedsPatchTest(req.beautician.id, appt.client_id);
  const url = `${base}/book/${slug}/manage/${appt.management_token}`;
  res.json({
    url: needsPatchTest ? `${url}?book=patch` : url,
    needs_patch_test: needsPatchTest,
  });
});

/** Does this client still have an unbooked patch test on file? Exported so
 * the Florrie-thinks feed grounds its patch-test card in the same rule the
 * appointment sheet uses, rather than growing a second definition. */
export async function clientNeedsPatchTest(beauticianId, clientId) {
  // The rule itself lives in lib/patch-test-status.js now: the Florrie-thinks
  // feed and the voice tools ask the same question, and a rule with three
  // callers that lives inside an HTTP route grows a second copy.
  return needsPatchTest(supabase, beauticianId, clientId, logger);
}

/* ==========================================================================
 * THE OWNER'S OWN RECORD
 *
 * Ellie patch tests people in the chair. She always has. Nothing in this app
 * has ever let her write that down, so as far as the software was concerned
 * every one of those clients had never been tested, and the manage page went
 * on demanding a test from them forever. On 26 August that cost Sophie a slot
 * she did not need and Ellie an evening's tidying up.
 *
 * The one route that looked like it could record a test, POST
 * /api/features/patch-tests, needs a treatment_id and offers a `result`
 * dropdown, and the page that calls it wrote to two columns patch_tests does
 * not have (client_name, notes) with client_id NULL against a NOT NULL
 * constraint. PostgREST rejected the whole statement every time and the
 * frontend swallowed the throw, so the row appeared in the list and was never
 * saved. Nobody has ever successfully logged a patch test by hand.
 *
 * WHAT THIS WRITES, AND WHAT IT REFUSES TO WRITE.
 *
 *   status       'recorded_by_owner'. Legal without a migration: 078 created
 *                patch_tests.status as unconstrained text. It says who said
 *                so, which is the only thing anybody actually knows.
 *   test_date    the date SHE picks. Not today, not created_at: she is
 *                usually recording something that happened weeks ago.
 *   confirmed_at now. Every reader in this codebase uses confirmed_at for
 *                exactly one thing, "this patch test is settled rather than
 *                outstanding", and a recorded one is settled. What keeps it
 *                distinguishable from a slot a client booked is
 *                appointment_id being NULL and status not being 'pending'.
 *   result       left at the column default, 'pending'. THIS IS THE POINT.
 *                Nobody has told us the outcome, so nothing is written for
 *                it. The row says "Ellie recorded a patch test on the 7th"
 *                and never "she passed". If she wants to record an actual
 *                outcome she has to say so, and even then it is written in
 *                the schema's own vocabulary: 'pass' or 'reaction', the words
 *                in the CHECK constraint, never the invented 'passed'.
 *   expires_at   left NULL, as it is on every row in production. Validity is
 *                one calculation from test_date against her own
 *                patch_test_expiry_months setting, in one place, and a second
 *                copy of it frozen into a column would be a second answer.
 * ======================================================================== */

/** The outcomes a human may state, in the schema's own words. */
const STATEABLE_RESULTS = new Set(['pass', 'reaction', 'fail']);

/**
 * POST /api/appointments/patch-test-records
 * Body: { client_id, test_date, treatment_id?, result?, product_used?, notes? }
 *
 * Record that a client had a patch test on a date, with no slot booked and no
 * appointment behind it, because there was not one: it happened in the chair.
 */
router.post('/patch-test-records', requireAuth, async (req, res) => {
  const { client_id, test_date, treatment_id, result, product_used, notes } = req.body || {};

  if (!client_id) return res.status(400).json({ error: 'Please choose a client.' });
  if (!test_date || !/^\d{4}-\d{2}-\d{2}$/.test(String(test_date))) {
    return res.status(400).json({ error: 'Please pick the date of the patch test.' });
  }
  // A test dated next week has not happened. Wall frame, same as everything
  // else that talks about days rather than instants.
  if (String(test_date) > todayWall()) {
    return res.status(400).json({ error: 'That date is in the future. Record it after it has happened.' });
  }
  if (result != null && result !== '' && !STATEABLE_RESULTS.has(String(result))) {
    return res.status(400).json({ error: 'That is not a result this can record.' });
  }

  // Hers, or nobody's. Same check the rest of this router makes before it
  // touches a row it was handed an id for.
  if (!await requireOwned(req, res, [
    { table: 'clients', id: client_id },
    { table: 'treatments', id: treatment_id },
  ])) return;

  const row = {
    beautician_id: req.beautician.id,
    client_id,
    treatment_id: treatment_id || null,
    test_date: String(test_date),
    status: RECORDED_BY_OWNER,
    // No slot, no appointment. That is the whole point of this route.
    appointment_id: null,
    auto_booked: false,
    confirmed_at: new Date().toISOString(),
    product_used: product_used ? String(product_used).slice(0, 500) : null,
  };
  // Only if a human actually stated one. Absent means absent, not pass.
  if (result && STATEABLE_RESULTS.has(String(result))) row.result = String(result);
  // reaction_notes, not `notes`: patch_tests has never had a column called
  // notes, and naming one made PostgREST throw the whole insert away.
  if (notes) row.reaction_notes = String(notes).slice(0, 2000);

  const { data, error } = await supabase
    .from('patch_tests')
    .insert(row)
    .select('id, client_id, treatment_id, test_date, status, result, confirmed_at, appointment_id')
    .single();

  if (error) {
    logger.error({ err: error, clientId: client_id }, 'Could not record the patch test');
    return res.status(500).json({ error: 'Could not save that just then. Please try again.' });
  }

  res.status(201).json({ patchTest: data });
});

/**
 * GET /api/appointments/patch-test-alerts?days=21
 *
 * WHO IS ASKED WHEN NOBODY KNOWS.
 *
 * The client is not the right person to ask about a gap in our own records.
 * She was told "you need a patch test", which is an assertion, and for a
 * returning client it is a guess: she books a slot she does not need, the
 * diary loses it, and the owner spends her evening undoing it. Ellie is the
 * one who was in the room, and she is the one who can settle it in a tap.
 *
 * So this is the ask, and it lands on the owner's Patch Tests page. Each row
 * says what the evidence actually is, in the vocabulary of
 * lib/patch-test-status.js, and never pretends absence is a negative.
 *
 * The old version of that page could not do this. It decided which treatments
 * needed a test by looking for 'tint' and 'lamination' in the NAME, ignoring
 * the requires_patch_test column that exists for it, and then matched clients
 * to tests on patch_tests.client_name, a column that does not exist.
 */
router.get('/patch-test-alerts', requireAuth, async (req, res) => {
  const days = Math.min(90, Math.max(1, Number(req.query.days) || 21));
  const from = todayWall();
  const [fy, fm, fd] = from.split('-').map(Number);
  const to = new Date(Date.UTC(fy, fm - 1, fd + days));
  const until = to.toISOString().slice(0, 10);

  const { data: appts, error } = await supabase
    .from('appointments')
    .select('id, starts_at, status, client_id, treatment_id, extra_treatment_ids, clients(id, first_name, last_name), treatments(id, name, requires_patch_test)')
    .eq('beautician_id', req.beautician.id)
    .gte('starts_at', `${from}T00:00:00`)
    .lte('starts_at', `${until}T23:59:59`)
    .in('status', ['confirmed', 'pending', 'in_progress'])
    .order('starts_at', { ascending: true })
    .limit(300);

  // A silent empty list on the page that exists to catch this is the one
  // outcome worth shouting about.
  if (error) {
    logger.error({ err: error }, 'Could not read the diary for patch-test alerts');
    return res.status(500).json({ error: 'Could not check the diary just then.' });
  }

  const rows = appts || [];

  // Extras count. A lash tint added to a booking needs a test exactly as much
  // as one booked as the main thing, and only extra_treatment_ids knows.
  const extraIds = new Set();
  for (const a of rows) {
    const extras = Array.isArray(a.extra_treatment_ids) ? a.extra_treatment_ids : [];
    for (const id of extras) if (id) extraIds.add(id);
  }
  let extraNeeds = new Set();
  if (extraIds.size > 0) {
    const { data: extras, error: exErr } = await supabase
      .from('treatments')
      .select('id, requires_patch_test')
      .eq('beautician_id', req.beautician.id)
      .in('id', [...extraIds]);
    if (exErr) {
      logger.error({ err: exErr }, 'Could not read the extra treatments for patch-test alerts');
      return res.status(500).json({ error: 'Could not check the diary just then.' });
    }
    extraNeeds = new Set((extras || []).filter(t => t.requires_patch_test === true).map(t => t.id));
  }

  const needing = rows.filter((a) => {
    if (a.treatments?.requires_patch_test === true) return true;
    const extras = Array.isArray(a.extra_treatment_ids) ? a.extra_treatment_ids : [];
    return extras.some(id => extraNeeds.has(id));
  });

  const expiryMonths = req.beautician.patch_test_expiry_months || 6;

  // One evidence read per CLIENT, not per booking: she may have four in.
  const byClient = new Map();
  for (const a of needing) {
    if (!a.client_id) continue;
    if (!byClient.has(a.client_id)) byClient.set(a.client_id, []);
    byClient.get(a.client_id).push(a);
  }

  const alerts = [];
  for (const [clientId, bookings] of byClient) {
    const soonest = bookings[0];
    const evidence = await patchTestEvidence(supabase, req.beautician.id, clientId, {
      expiryMonths,
      asOf: soonest.starts_at,
      logger,
    });
    if (evidence.ok) continue;

    /* THE 27 AUGUST 2026 POPULATIONS, on the owner's side of the same rule.
     *
     * A client who was last in inside her own expiry window is not a question:
     * she sat in this chair more recently than the salon's patch test window
     * is long. She is one of the 52 (of 673 imported regulars with no Florrie
     * appointment at all), and putting her on this list buries the 621 who
     * matter. She is not told anything either, so nobody is chasing her.
     *
     * Prior history is NOT read as a patch test here any more than anywhere
     * else. It only decides whether there is a question worth the owner's
     * evening. Flip this one line back if the salon would rather see them all.
     */
    const prior = evidence.priorHistory || { known: false, inWindow: false };
    if (prior.known && prior.inWindow && evidence.kind !== 'adverse' && evidence.kind !== 'unknown') continue;

    // What the owner is actually being asked. Never a verdict on her client.
    //
    // 'never_been_in' used to fire on completedVisits === 0, which counts
    // Florrie-era completed appointments and nothing else. That is what made
    // 673 established regulars read as brand new. A client with prior history
    // has been in; we simply have no patch test written down for her.
    const askedBecause =
      evidence.kind === 'unknown' ? 'could_not_check'
        : evidence.kind === 'adverse' ? 'reaction_on_record'
          : evidence.pending ? 'booked_not_attended'
            : (prior.known || evidence.completedVisits > 0) ? 'been_in_but_nothing_on_record'
              : 'never_been_in';

    alerts.push({
      client_id: clientId,
      client_name: `${soonest.clients?.first_name || ''} ${soonest.clients?.last_name || ''}`.trim() || 'Client',
      appointment_id: soonest.id,
      // Wall date, read the way the rest of this file reads starts_at.
      appointment_date: wallDate(soonest.starts_at),
      treatment: soonest.treatments?.name || null,
      bookings: bookings.length,
      evidence: evidence.kind,
      evidence_date: evidence.when,
      completed_visits: evidence.completedVisits,
      // What the old system knew about her, so the card can say "last seen
      // March 2026, from Timely" instead of pretending she is new.
      prior_visits: prior.totalVisits || 0,
      prior_last_visit: prior.lastVisit || null,
      reason: askedBecause,
      // So the page can say "anything before this is too old" in her words.
      window_from: patchTestWindowStart(wallDate(soonest.starts_at), expiryMonths),
    });
  }

  res.json({ alerts, expiryMonths, checkedUntil: until });
});

/**
 * POST /api/appointments/:id/send-manage-link
 * Text the client their booking-management link. If they still owe a patch
 * test, the link opens straight on the patch-test slot picker.
 */
router.post('/:id/send-manage-link', requireAuth, async (req, res) => {
  // This used to call notifyBookingConfirmed, which on WhatsApp sends the
  // booking_confirmation_v2 template with params [name, date, time]. The manage
  // URL is NOT one of those params, so the client got a confirmation with no
  // link and no way to reach the patch-test picker (and it read as if she had
  // just rebooked them). Send the link itself, on a template that carries text.
  const { data: appt } = await supabase
    .from('appointments')
    .select(`
      id, management_token, starts_at, client_id,
      clients(first_name, phone, email),
      beauticians(business_name, first_name, booking_slug, client_reminder_prefs)
    `)
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .maybeSingle();
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });

  const client = appt.clients;
  const biz = appt.beauticians;
  // No pause check. Ellie pressed the button: that is her sending a message,
  // not Florrie sending one on her behalf, and the switch only ever governs
  // the second thing. Refusing here used to mean the pause silently blocked
  // her own deliberate action and told her to go and change a setting first.

  if (!appt.management_token || !biz?.booking_slug || !process.env.FRONTEND_URL) {
    return res.status(422).json({ error: 'This booking has no manage link yet.' });
  }
  if (!client?.phone) {
    return res.status(422).json({ error: 'No phone number on file for this client.' });
  }

  const needsPatchTest = await clientNeedsPatchTest(req.beautician.id, appt.client_id);

  const base = `${process.env.FRONTEND_URL}/book/${biz.booking_slug}/manage/${appt.management_token}`;
  const url = needsPatchTest ? `${base}?book=patch` : base;
  const bizName = biz.business_name || biz.first_name;
  // Lead with the thing they actually have to do. Burying the patch test behind
  // "manage your booking" is how it gets ignored and the appointment falls over
  // on the day.
  const body = needsPatchTest
    ? `You still need to book your patch test before your appointment with ${bizName}. It only takes a few minutes, and it has to be done at least 24 hours beforehand or the appointment cannot go ahead. Pick a time here: ${url} (you can also reschedule or cancel on the same page).`
    : `Here's your booking with ${bizName}. You can view, reschedule or cancel it here: ${url}`;

  try {
    const channel = prefs.channel || 'whatsapp';
    let sentOn = null;

    if (channel === 'whatsapp') {
      // generic_message is the only template with a free-text slot, so the
      // link travels in its body. booking_confirmation_v2 has nowhere to put
      // it. Named fields, both essential: generic_message_v2's approved body
      // turned out to have ONE slot and no room for a url (27 August 2026), so
      // a version that cannot carry `message` refuses the send and control
      // falls to the SMS below rather than sending a link-less hello.
      const wa = await sendWhatsApp({
        to: client.phone,
        templateName: 'generic_message_v2',
        templateFields: { first_name: client.first_name, message: body },
        beauticianId: req.beautician.id,
        clientId: appt.client_id,
        // Her own booking link is a service message, not marketing. Without
        // this it was blocked by the PECR quiet-hours gate after 21:00 and
        // fell back to SMS, so nothing arrived.
        transactional: true,
      });
      if (wa) sentOn = 'whatsapp';
    }

    if (!sentOn) {
      const sms = await sendSMS({
        to: client.phone,
        body,
        beauticianId: req.beautician.id,
        messageType: 'booking_confirmation',
      });
      if (sms) sentOn = 'sms';
    }

    if (!sentOn) {
      logger.warn({ id: appt.id }, 'send-manage-link: no channel delivered');
      return res.status(502).json({ error: 'Could not deliver the link. Check your WhatsApp connection in Settings.' });
    }

    logger.info({ id: appt.id, sentOn, needsPatchTest }, 'Manage link sent');
    res.json({ ok: true, channel: sentOn, patch_test_link: needsPatchTest });
  } catch (err) {
    logger.error({ err, id: appt.id }, 'send-manage-link failed');
    res.status(500).json({ error: 'Could not send the link' });
  }
});

export default router;
