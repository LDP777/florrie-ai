import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../index.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { updateClientIntelligence } from '../services/client-intelligence.js';
import logger from '../lib/logger.js';

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
  // Pagination params
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const per_page = Math.min(100, Math.max(1, parseInt(req.query.per_page) || 25));
  const offset = (page - 1) * per_page;

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
  if (error) {
    logger.error({ err: error }, 'Failed to fetch appointments');
    return res.status(500).json({ error: 'Something went wrong' });
  }

  const total = count || 0;
  const total_pages = Math.ceil(total / per_page);

  res.json({
    data: data || [],
    pagination: {
      page,
      per_page,
      total,
      total_pages
    }
  });
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
    return res.status(500).json({ error: 'Something went wrong' });
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
    'no_show_fee_charged'
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

  // If rescheduling, recalculate ends_at
  if (req.body.starts_at && !req.body.ends_at) {
    const { data: existing } = await supabase
      .from('appointments')
      .select('duration_minutes, buffer_minutes, extra_padding_minutes')
      .eq('id', req.params.id)
      .single();

    if (existing) {
      const total = existing.duration_minutes + existing.buffer_minutes + (existing.extra_padding_minutes || 0);
      const newEnd = new Date(new Date(req.body.starts_at).getTime() + total * 60 * 1000);
      updates.ends_at = newEnd.toISOString();
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
    logger.error({ err: error }, 'Failed to update appointment');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ appointment: data });
});

/**
 * POST /api/appointments/:id/complete
 * Mark appointment as completed + auto-log income transaction.
 */
router.post('/:id/complete', requireAuth, async (req, res) => {
  const { data: appointment, error } = await supabase
    .from('appointments')
    .update({ status: 'completed' })
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .select()
    .single();

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

  res.json({ appointment });
});

/**
 * POST /api/appointments/complete-day
 * Mark all confirmed appointments that have ended as completed.
 * Optional { date } (defaults to today).
 * Returns { count, completed_appointments }.
 */
const completeDaySchema = z.object({
  date: z.string().date().optional()
});

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

    const { error: updateError } = await supabase
      .from('appointments')
      .update({ status: 'completed', completed_at: completedAt })
      .in('id', ids);

    if (updateError) {
      return res.status(500).json({ error: 'Failed to update appointments' });
    }

    // Auto-log income transactions for all completed appointments
    const transactions = appointments.map(apt => ({
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

  let current = new Date(`${date}T${startTime}:00`);
  const end = new Date(`${date}T${endTime}:00`);

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
        display: current.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
      });
    }

    current = new Date(current.getTime() + slotInterval * 60000);
  }

  return slots;
}

function getTaxYear(date) {
  const year = date.getFullYear();
  const month = date.getMonth(); // 0-indexed
  // UK tax year runs April 6 to April 5
  if (month < 3 || (month === 3 && date.getDate() < 6)) {
    return `${year - 1}-${String(year).slice(2)}`;
  }
  return `${year}-${String(year + 1).slice(2)}`;
}

export default router;
