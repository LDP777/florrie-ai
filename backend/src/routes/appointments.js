import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { updateClientIntelligence } from '../services/client-intelligence.js';
import { triggerSequence } from '../services/email-sequences.js';
import { scheduleReviewRequest } from '../services/review-requests.js';
import { awardLoyaltyPoints } from '../services/loyalty.js';
import { chargePolicyFee, chargeRemainingBalance, chargeCardAmount, getCardOnFile } from '../services/policy-fees.js';
import { feePreview } from '../lib/platform-fees.js';
import { logAssumedTakings } from '../lib/takings.js';
import logger from '../lib/logger.js';
import { parsePagination, buildPaginationMeta, handleQueryError } from '../lib/queries.js';
import { completeDaySchema, manualAppointmentSchema } from '../lib/schemas.js';
import { getTaxYear } from '../lib/time-utils.js';
import { notifyBookingConfirmed, sendWhatsApp, sendSMS } from '../services/notifications.js';

const router = Router();

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
    .select('id, starts_at, created_at, status, deposit_cents, deposit_paid, deposit_status, payment_method, client_notes, clients(first_name, last_name), treatments(name)')
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
  res.status(201).json({ appointment });
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

  // Fire-and-forget: confirmation only when explicitly asked for
  if (send_confirmation) {
    notifyBookingConfirmed(appointment.id).catch((err) =>
      logger.warn({ err, appointmentId: appointment.id }, 'Manual appointment confirmation failed')
    );
  }

  res.status(201).json({ appointment });
});

/**
 * PATCH /api/appointments/:id
 * Update appointment status, reschedule, add notes.
 */
router.patch('/:id', requireAuth, async (req, res) => {
  const allowedFields = [
    'status', 'starts_at', 'ends_at', 'beautician_notes',
    'no_show_fee_charged', 'treatment_id', 'duration_minutes'
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
  if (req.body.starts_at) {
    const m = String(req.body.starts_at).match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (!m) {
      return res.status(400).json({ error: 'That date and time look wrong. Please pick again.' });
    }
    const [, yy, mo, dd, hh, mi] = m;
    updates.starts_at = `${yy}-${mo}-${dd}T${hh}:${mi}:00`;

    // Recompute ends_at unless the caller passed one explicitly.
    if (!req.body.ends_at) {
      const { data: existing } = await supabase
        .from('appointments')
        .select('duration_minutes, buffer_minutes, extra_padding_minutes')
        .eq('id', req.params.id)
        .single();

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

  // Changing the treatment (e.g. a full lamination swapped for a maintenance)
  // must pull the new length + price across, and re-end the appointment from
  // its start. Previously there was nowhere to change a booking's treatment at
  // all - only its time.
  if (req.body.treatment_id) {
    const { data: newTreat } = await supabase
      .from('treatments')
      .select('duration_minutes, price_cents')
      .eq('id', req.body.treatment_id)
      .eq('beautician_id', req.beautician.id)
      .maybeSingle();
    if (!newTreat) {
      return res.status(400).json({ error: 'That treatment was not found.' });
    }
    updates.duration_minutes = newTreat.duration_minutes;
    updates.price_cents = newTreat.price_cents;

    // Re-end from the (new or existing) start using the new length.
    const startStr = updates.starts_at
      || (await supabase.from('appointments').select('starts_at').eq('id', req.params.id).single()).data?.starts_at;
    const sm = String(startStr || '').match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
    if (sm) {
      const [, yy2, mo2, dd2, hh2, mi2] = sm;
      const { data: pad0 } = await supabase
        .from('appointments')
        .select('buffer_minutes, extra_padding_minutes')
        .eq('id', req.params.id).single();
      const total = (newTreat.duration_minutes || 0) + (pad0?.buffer_minutes || 0) + (pad0?.extra_padding_minutes || 0);
      const endDate = new Date(Date.UTC(Number(yy2), Number(mo2) - 1, Number(dd2), Number(hh2), Number(mi2) + total));
      const p2 = (n) => String(n).padStart(2, '0');
      updates.ends_at = `${endDate.getUTCFullYear()}-${p2(endDate.getUTCMonth() + 1)}-${p2(endDate.getUTCDate())}T${p2(endDate.getUTCHours())}:${p2(endDate.getUTCMinutes())}:00`;
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
    const { error: revErr } = await supabase
      .from('transactions')
      .delete()
      .eq('appointment_id', req.params.id)
      .eq('type', 'payment')
      .is('payment_method', null);
    if (revErr) logger.error({ err: revErr, appointmentId: req.params.id }, 'no_show takings reversal failed');

    // Fire-and-forget: auto-charge the no-show fee to the saved card when the
    // beautician's policy has one configured (idempotent, no-op otherwise).
    chargePolicyFee(req.params.id, 'no_show').catch(err =>
      logger.error({ err, appointmentId: req.params.id }, 'no_show policy fee charge failed (non-fatal)')
    );
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
    .select('id, deposit_paid, deposit_cents, policy_fee_charged_at, status, starts_at')
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .single();

  if (fetchErr || !appt) {
    return res.status(404).json({ error: 'Appointment not found' });
  }

  const { data: paidTx } = await supabase
    .from('transactions')
    .select('id')
    .eq('appointment_id', appt.id)
    .or('stripe_payment_intent_id.not.is.null,stripe_charge_id.not.is.null')
    .limit(1);
  const hasCardPayment = !!(paidTx && paidTx.length);
  const hasMoney = appt.deposit_paid === true || !!appt.policy_fee_charged_at || hasCardPayment;

  if (hasMoney && !force) {
    const bits = [];
    if (appt.deposit_paid && appt.deposit_cents > 0) bits.push(`a £${(appt.deposit_cents / 100).toFixed(2)} deposit`);
    else if (appt.deposit_paid) bits.push('a paid deposit');
    if (appt.policy_fee_charged_at) bits.push('a charged policy fee');
    if (hasCardPayment && !bits.length) bits.push('a card payment');
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
    logger.warn({ id: appt.id, beauticianId: req.beautician.id, hasCardPayment }, 'Appointment with payment force-deleted');
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
    // 'already_charged' includes the assumed takings row that completion
    // writes, so it fires for money never actually carded. The wording stays
    // honest about that rather than claiming a card was charged.
    already_charged: 'This balance is already recorded as settled, so nothing was charged.',
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

  // Fee preview so the app can say what actually reaches the beautician.
  // ?amount_cents previews a custom figure; default is the outstanding balance.
  const q = Number.parseInt(req.query.amount_cents, 10);
  const previewCents = Number.isFinite(q) && q > 0 ? q : outstandingCents;

  const card = await getCardOnFile(req.params.id);
  res.json({ ...card, outstanding_cents: outstandingCents, fees: feePreview(previewCents) });
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

  // Auto-log the income transaction
  await supabase.from('transactions').insert({
    beautician_id: req.beautician.id,
    appointment_id: appointment.id,
    amount_cents: appointment.price_cents,
    type: 'payment',
    status: 'completed',
    tax_year: getTaxYear(new Date())
  });

  // Update client stats
  await supabase.rpc('increment_client_visit', {
    p_client_id: appointment.client_id,
    p_amount: appointment.price_cents
  });

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
      .select('id, starts_at, ends_at, status, client_id, price_cents')
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

    // Auto-log income transactions, only for the rows this request flipped
    const transactions = appointments.filter(apt => flippedIds.has(apt.id)).map(apt => ({
      beautician_id: req.beautician.id,
      appointment_id: apt.id,
      amount_cents: apt.price_cents,
      type: 'payment',
      status: 'completed',
      tax_year: getTaxYear(new Date(apt.starts_at))
    }));

    if (transactions.length > 0) {
      await supabase.from('transactions').insert(transactions);
    }

    // Update client stats for each
    for (const apt of appointments) {
      // Supabase returns thenable, not Promise — destructure instead of .catch()
      const { error: _rpcErr } = await supabase.rpc('increment_client_visit', {
        p_client_id: apt.client_id,
        p_amount: apt.price_cents
      });

      // Fire-and-forget: update client intelligence
      updateClientIntelligence(req.beautician.id, apt.client_id).catch(() => {});

      // Fire-and-forget: award loyalty points (idempotent, no-op when loyalty is off)
      awardLoyaltyPoints(req.beautician.id, apt).catch(() => {});
    }

    res.json({
      count: appointments.length,
      message: `Marked ${appointments.length} appointment(s) as completed`,
      completed_appointments: appointments
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
  if (!clientId) return false;
  const { data, error } = await supabase
    .from('patch_tests')
    .select('id')
    .eq('client_id', clientId)
    .eq('beautician_id', beauticianId)
    .is('confirmed_at', null)
    .limit(1);
  if (error) {
    // Fail soft to "no": the sheet just keeps its generic booking-link label,
    // which is a wording downgrade, not a broken card.
    logger.warn({ err: error, clientId }, 'patch-test lookup failed');
    return false;
  }
  return (data || []).length > 0;
}

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
  const prefs = biz?.client_reminder_prefs || {};
  if (prefs.paused) return res.status(409).json({ error: 'Messages are paused. Turn the pause off in Settings to send this.' });

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
      // generic_message_v2 takes [first_name, message], so the link travels in
      // the body. booking_confirmation_v2 has nowhere to put it.
      const wa = await sendWhatsApp({
        to: client.phone,
        templateName: 'generic_message_v2',
        templateParams: [client.first_name, body],
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
