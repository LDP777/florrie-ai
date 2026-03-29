import { Router } from 'express';
import { z } from 'zod';
import Stripe from 'stripe';
import { supabase } from '../index.js';
import { notifyBookingConfirmed } from '../services/notifications.js';
import { sendConsultationFormSMS } from './consultation-forms.js';
import { validate } from '../middleware/validate.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../lib/logger.js';

const router = Router();
const FRONTEND_URL = process.env.FRONTEND_URL;

const bookingSchema = z.object({
  treatment_id: z.string().uuid('Invalid treatment ID'),
  starts_at: z.string().refine(
    v => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v) && !isNaN(Date.parse(v)),
    { message: 'Invalid date/time format — expected ISO 8601 (e.g. 2026-03-28T14:00:00)' }
  ),
  client_name: z.string().min(1, 'Name is required').max(200).trim(),
  client_email: z.string().email('Invalid email').optional().nullable().default(null),
  client_phone: z.string().min(5, 'Phone number too short').max(30).trim(),
  notes: z.string().max(2000).optional().nullable().default(null),
  consultation: z.record(z.any()).optional().nullable().default(null),
});

// Only init Stripe if key is present (avoids crash in dev without keys)
const stripe = process.env.STRIPE_SECRET_KEY
  ? new Stripe(process.env.STRIPE_SECRET_KEY)
  : null;

/**
 * GET /api/booking/:slug
 * Public endpoint — returns the beautician's booking page data.
 * This powers the branded booking link (florrie.ai/book/ellie-brows).
 */
router.get('/:slug', async (req, res) => {
  const { data: beautician, error } = await supabase
    .from('beauticians')
    .select('id, first_name, business_name, avatar_url, brand_color, brand_font, logo_url, working_hours, timezone')
    .eq('booking_slug', req.params.slug)
    .single();

  if (error || !beautician) {
    return res.status(404).json({ error: 'Booking page not found' });
  }

  // Get active, bookable treatments
  const { data: treatments } = await supabase
    .from('treatments')
    .select('id, name, description, duration_minutes, price_cents, deposit_cents, category')
    .eq('beautician_id', beautician.id)
    .eq('is_active', true)
    .eq('booking_enabled', true)
    .order('sort_order', { ascending: true });

  res.json({
    beautician: {
      id: beautician.id,
      name: beautician.business_name || beautician.first_name,
      avatar: beautician.avatar_url,
      brandColor: beautician.brand_color,
      brandFont: beautician.brand_font,
      logo: beautician.logo_url,
      workingHours: beautician.working_hours,
      timezone: beautician.timezone
    },
    treatments: treatments || []
  });
});

/**
 * PATCH /api/booking/appointments/:id/status
 * Transition appointment status with validation.
 * Only allows valid state transitions.
 * Requires authentication.
 */
const statusTransitionSchema = z.object({
  status: z.enum(['confirmed', 'cancelled', 'no_show', 'completed'], {
    errorMap: () => ({ message: 'Invalid status. Must be: confirmed, cancelled, no_show, or completed' })
  })
});

const VALID_TRANSITIONS = {
  'pending': ['confirmed', 'cancelled'],
  'confirmed': ['completed', 'cancelled', 'no_show'],
  'completed': [],
  'cancelled': [],
  'no_show': []
};

router.patch('/appointments/:id/status', requireAuth, validate(statusTransitionSchema), async (req, res) => {
  const { id } = req.params;
  const { status: newStatus } = req.body;

  try {
    // Get current appointment
    const { data: appointment, error: fetchError } = await supabase
      .from('appointments')
      .select('id, status, starts_at, ends_at, beautician_id, price_cents, client_id')
      .eq('id', id)
      .single();

    if (fetchError || !appointment) {
      return res.status(404).json({ error: 'Appointment not found' });
    }

    // Verify ownership
    if (appointment.beautician_id !== req.beautician.id) {
      return res.status(403).json({ error: 'Unauthorized' });
    }

    // Validate transition
    const currentStatus = appointment.status;
    const allowedTransitions = VALID_TRANSITIONS[currentStatus] || [];

    if (!allowedTransitions.includes(newStatus)) {
      return res.status(400).json({
        error: `Cannot transition from '${currentStatus}' to '${newStatus}'`,
        currentStatus,
        allowedTransitions
      });
    }

    // Build update object
    const updates = { status: newStatus };

    // Set completion timestamp
    if (newStatus === 'completed') {
      updates.completed_at = new Date().toISOString();
    }

    // Set cancellation timestamp
    if (newStatus === 'cancelled') {
      updates.cancelled_at = new Date().toISOString();
    }

    // Set no-show timestamp
    if (newStatus === 'no_show') {
      updates.no_showed_at = new Date().toISOString();
    }

    // Perform update
    const { data: updated, error: updateError } = await supabase
      .from('appointments')
      .update(updates)
      .eq('id', id)
      .eq('beautician_id', req.beautician.id)
      .select('*, clients(first_name, last_name, phone), treatments(name, duration_minutes, price_cents)')
      .single();

    if (updateError) {
      return res.status(500).json({ error: 'Failed to update appointment status' });
    }

    res.json({
      message: `Appointment status updated to '${newStatus}'`,
      appointment: updated
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

/**
 * POST /api/booking/:slug/book
 * Public endpoint — creates a booking from the booking page.
 * Creates or finds the client, creates the appointment.
 * If deposit is required and beautician has Stripe Connect, creates a
 * Checkout session and returns checkout_url for redirect.
 * Returning clients with a saved Stripe customer see their saved cards.
 */
router.post('/:slug/book', validate(bookingSchema), async (req, res) => {
  const { treatment_id, starts_at, client_name, client_email, client_phone, notes, consultation } = req.body;

  // Get beautician from slug (include Stripe fields for deposit flow)
  const { data: beautician } = await supabase
    .from('beauticians')
    .select('id, business_name, first_name, stripe_account_id, stripe_onboarding_complete')
    .eq('booking_slug', req.params.slug)
    .single();

  if (!beautician) return res.status(404).json({ error: 'Booking page not found' });

  // Get treatment (including deposit_percent for percentage-based deposits)
  const { data: treatment } = await supabase
    .from('treatments')
    .select('*, deposit_percent, consultation_form_id')
    .eq('id', treatment_id)
    .eq('beautician_id', beautician.id)
    .single();

  if (!treatment) return res.status(404).json({ error: 'Treatment not found' });

  // Find or create client (track whether new for consultation form trigger)
  const nameParts = client_name.trim().split(' ');
  const firstName = nameParts[0];
  const lastName = nameParts.slice(1).join(' ') || null;

  let client;
  let isNewClient = false;

  // Try to find existing client by phone
  const { data: existingClient } = await supabase
    .from('clients')
    .select('id, stripe_customer_id')
    .eq('beautician_id', beautician.id)
    .eq('phone', client_phone)
    .maybeSingle();

  if (existingClient) {
    client = existingClient;
  } else {
    // Create new client
    const { data: newClient, error: cError } = await supabase
      .from('clients')
      .insert({
        beautician_id: beautician.id,
        first_name: firstName,
        last_name: lastName,
        email: client_email || null,
        phone: client_phone,
        status: 'new'
      })
      .select('id, stripe_customer_id')
      .single();

    if (cError) return res.status(500).json({ error: 'Failed to create client record' });
    client = newClient;
    isNewClient = true;
  }

  // Calculate times
  const totalMinutes = treatment.duration_minutes + (treatment.buffer_minutes || 0);
  const startsDate = new Date(starts_at);
  const endsDate = new Date(startsDate.getTime() + totalMinutes * 60 * 1000);

  // Conflict check
  const { data: conflicts } = await supabase
    .from('appointments')
    .select('id')
    .eq('beautician_id', beautician.id)
    .in('status', ['confirmed', 'pending'])
    .lt('starts_at', endsDate.toISOString())
    .gt('ends_at', startsDate.toISOString());

  if (conflicts && conflicts.length > 0) {
    return res.status(409).json({ error: 'This time slot is no longer available' });
  }

  // Build client_notes — combine free text notes + consultation form answers
  let clientNotes = notes || null;
  if (consultation && Object.keys(consultation).length > 0) {
    clientNotes = JSON.stringify({ notes: notes || '', consultation });
  }

  // Calculate deposit: percentage overrides flat amount
  let depositCents = treatment.deposit_cents || 0;
  if (treatment.deposit_percent > 0 && treatment.price_cents > 0) {
    depositCents = Math.round(treatment.price_cents * treatment.deposit_percent / 100);
  }

  // Create appointment
  const depositRequired = depositCents > 0;
  const { data: appointment, error: aError } = await supabase
    .from('appointments')
    .insert({
      beautician_id: beautician.id,
      client_id: client.id,
      treatment_id,
      starts_at,
      ends_at: endsDate.toISOString(),
      duration_minutes: treatment.duration_minutes,
      buffer_minutes: treatment.buffer_minutes || 0,
      price_cents: treatment.price_cents,
      deposit_cents: depositCents,
      client_notes: clientNotes,
      booked_via: 'booking_page',
      status: depositRequired ? 'pending' : 'confirmed'
    })
    .select()
    .single();

  if (aError) {
    logger.error({ err: aError }, 'Appointment insert error');
    return res.status(500).json({ error: 'Failed to create booking' });
  }

  // Log AI action
  await supabase.from('ai_actions').insert({
    beautician_id: beautician.id,
    action_type: 'booking_created',
    digital_employee: 'front_desk',
    summary: `${firstName} booked ${treatment.name} for ${startsDate.toLocaleDateString('en-GB')} at ${startsDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`,
    details: { appointment_id: appointment.id, treatment: treatment.name, client_name },
    client_id: client.id,
    appointment_id: appointment.id,
    confidence: 1.0,
    autonomous: false,
    outcome: 'success',
    notification_sent: true,
    notification_text: `New booking: ${firstName} — ${treatment.name}, ${startsDate.toLocaleDateString('en-GB')} at ${startsDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
  }).catch(err => logger.warn({ err }, 'AI action log failed (non-fatal)'));

  // ── DEPOSIT FLOW ──────────────────────────────────────────
  // If deposit required and beautician has Stripe Connect, create Checkout session.
  // Returning clients with a saved stripe_customer_id see saved payment methods.
  if (depositRequired && stripe && beautician.stripe_account_id && beautician.stripe_onboarding_complete) {
    try {
      const bookingSlug = req.params.slug;
      const dateLabel = startsDate.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

      // Ensure client has a Stripe Customer for saved card reuse
      let stripeCustomerId = client.stripe_customer_id;
      if (!stripeCustomerId) {
        const customer = await stripe.customers.create({
          name: client_name,
          email: client_email || undefined,
          phone: client_phone,
          metadata: { client_id: client.id, beautician_id: beautician.id },
        });
        stripeCustomerId = customer.id;
        await supabase.from('clients').update({ stripe_customer_id: stripeCustomerId }).eq('id', client.id);
      }

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        customer: stripeCustomerId,
        line_items: [{
          price_data: {
            currency: 'gbp',
            product_data: {
              name: `${treatment.name} — deposit`,
              description: `${dateLabel} at ${startsDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })} with ${beautician.business_name || beautician.first_name}`,
            },
            unit_amount: depositCents,
          },
          quantity: 1,
        }],
        payment_intent_data: {
          // No platform fee on deposits — Florrie revenue comes from subscriptions
          transfer_data: {
            destination: beautician.stripe_account_id,
          },
          setup_future_usage: 'off_session', // saves card for returning clients
          metadata: {
            appointment_id: appointment.id,
            beautician_id: beautician.id,
            client_id: client.id,
          },
        },
        success_url: `${FRONTEND_URL}/book/${bookingSlug}/confirmed?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${FRONTEND_URL}/book/${bookingSlug}?cancelled=true`,
        metadata: {
          appointment_id: appointment.id,
          beautician_id: beautician.id,
          client_id: client.id,
        },
      });

      // Store payment intent on the appointment
      await supabase.from('appointments').update({
        stripe_payment_intent_id: session.payment_intent,
        deposit_amount_cents: depositCents,
        deposit_status: 'pending',
      }).eq('id', appointment.id);

      // Fire confirmation notification for pending deposit booking (non-blocking)
      notifyBookingConfirmed(appointment.id).catch(err =>
        logger.warn({ err }, 'Booking confirmation notification failed (non-fatal)')
      );

      // Send consultation form to first-time clients (non-blocking)
      if (isNewClient && client_phone) {
        sendConsultationFormSMS({
          beauticianId: beautician.id,
          clientId: client.id,
          appointmentId: appointment.id,
          clientPhone: client_phone,
          clientFirstName: firstName,
          treatmentId: treatment_id,
          beauticianName: beautician.business_name || beautician.first_name,
        }).catch(err =>
          logger.warn({ err }, 'Consultation form SMS failed (non-fatal)')
        );
      }

      return res.status(201).json({
        booking: {
          id: appointment.id,
          treatment: treatment.name,
          date: startsDate.toLocaleDateString('en-GB'),
          time: startsDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
          price: `£${(treatment.price_cents / 100).toFixed(2)}`,
          deposit: `£${(depositCents / 100).toFixed(2)}`,
          status: 'pending',
        },
        checkout_url: session.url,
      });
    } catch (err) {
      logger.error({ err }, 'Stripe checkout creation failed');
      // Booking was created but payment setup failed — still return the booking
      // The beautician can send a payment link manually
    }
  }

  // No deposit or Stripe not configured — booking is confirmed immediately
  // Fire confirmation notification (non-blocking)
  notifyBookingConfirmed(appointment.id).catch(err =>
    logger.warn({ err }, 'Booking confirmation notification failed (non-fatal)')
  );

  // Send consultation form to first-time clients (non-blocking)
  if (isNewClient && client_phone) {
    sendConsultationFormSMS({
      beauticianId: beautician.id,
      clientId: client.id,
      appointmentId: appointment.id,
      clientPhone: client_phone,
      clientFirstName: firstName,
      treatmentId: treatment_id,
      beauticianName: beautician.business_name || beautician.first_name,
    }).catch(err =>
      logger.warn({ err }, 'Consultation form SMS failed (non-fatal)')
    );
  }

  res.status(201).json({
    booking: {
      id: appointment.id,
      treatment: treatment.name,
      date: startsDate.toLocaleDateString('en-GB'),
      time: startsDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
      price: `£${(treatment.price_cents / 100).toFixed(2)}`,
      deposit: null,
      status: appointment.status
    }
  });
});

export default router;
