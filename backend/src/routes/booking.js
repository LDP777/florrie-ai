import { Router } from 'express';
import { supabase } from '../index.js';

const router = Router();

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
 * POST /api/booking/:slug/book
 * Public endpoint — creates a booking from the booking page.
 * Creates or finds the client, creates the appointment.
 */
router.post('/:slug/book', async (req, res) => {
  const { treatment_id, starts_at, client_name, client_email, client_phone, notes } = req.body;

  if (!treatment_id || !starts_at || !client_name || !client_phone) {
    return res.status(400).json({ error: 'Treatment, time, name, and phone are required' });
  }

  // Get beautician from slug
  const { data: beautician } = await supabase
    .from('beauticians')
    .select('id')
    .eq('booking_slug', req.params.slug)
    .single();

  if (!beautician) return res.status(404).json({ error: 'Booking page not found' });

  // Get treatment
  const { data: treatment } = await supabase
    .from('treatments')
    .select('*')
    .eq('id', treatment_id)
    .eq('beautician_id', beautician.id)
    .single();

  if (!treatment) return res.status(404).json({ error: 'Treatment not found' });

  // Find or create client
  const nameParts = client_name.trim().split(' ');
  const firstName = nameParts[0];
  const lastName = nameParts.slice(1).join(' ') || null;

  let client;

  // Try to find existing client by phone
  const { data: existingClient } = await supabase
    .from('clients')
    .select('id')
    .eq('beautician_id', beautician.id)
    .eq('phone', client_phone)
    .single();

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
      .select()
      .single();

    if (cError) return res.status(500).json({ error: 'Failed to create client record' });
    client = newClient;
  }

  // Calculate times
  const totalMinutes = treatment.duration_minutes + treatment.buffer_minutes;
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

  // Create appointment
  const { data: appointment, error: aError } = await supabase
    .from('appointments')
    .insert({
      beautician_id: beautician.id,
      client_id: client.id,
      treatment_id,
      starts_at,
      ends_at: endsDate.toISOString(),
      duration_minutes: treatment.duration_minutes,
      buffer_minutes: treatment.buffer_minutes,
      price_cents: treatment.price_cents,
      deposit_cents: treatment.deposit_cents,
      client_notes: notes || null,
      booked_via: 'booking_page',
      status: treatment.deposit_cents > 0 ? 'pending' : 'confirmed'
    })
    .select()
    .single();

  if (aError) return res.status(500).json({ error: 'Failed to create booking' });

  // Log AI action
  await supabase.from('ai_actions').insert({
    beautician_id: beautician.id,
    action_type: 'booking_created',
    digital_employee: 'front_desk',
    summary: `${firstName} booked ${treatment.name} for ${startsDate.toLocaleDateString('en-GB')} at ${startsDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`,
    details: { appointment_id: appointment.id, treatment: treatment.name, client_name: client_name },
    client_id: client.id,
    appointment_id: appointment.id,
    confidence: 1.0,
    autonomous: false,
    outcome: 'success',
    notification_sent: true,
    notification_text: `New booking: ${firstName} — ${treatment.name}, ${startsDate.toLocaleDateString('en-GB')} at ${startsDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
  });

  res.status(201).json({
    booking: {
      id: appointment.id,
      treatment: treatment.name,
      date: startsDate.toLocaleDateString('en-GB'),
      time: startsDate.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
      price: `£${(treatment.price_cents / 100).toFixed(2)}`,
      deposit: treatment.deposit_cents > 0 ? `£${(treatment.deposit_cents / 100).toFixed(2)}` : null,
      status: appointment.status
    }
  });
});

export default router;
