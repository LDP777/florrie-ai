import { Router } from 'express';
import crypto from 'crypto';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { sendSMS } from '../services/notifications.js';
import logger from '../lib/logger.js';
import {
  createConsultationFormSchema,
  submitConsultationFormSchema
} from '../lib/schemas.js';

const router = Router();
const FRONTEND_URL = process.env.FRONTEND_URL;

// ═══════════════════════════════════════════════
// BEAUTICIAN FORM MANAGEMENT (auth required)
// ═══════════════════════════════════════════════

/**
 * GET /api/consultation-forms
 * List all forms for the authenticated beautician.
 */
router.get('/', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('consultation_forms')
    .select('*, consultation_form_fields(count)')
    .eq('beautician_id', req.beautician.id)
    .eq('is_active', true)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ err: error }, 'Failed to fetch consultation forms');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ forms: data || [] });
});

/**
 * GET /api/consultation-forms/:id
 * Get a single form with all its fields.
 */
router.get('/:id', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('consultation_forms')
    .select('*, consultation_form_fields(*)')
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Form not found' });

  // Sort fields by sort_order
  if (data.consultation_form_fields) {
    data.consultation_form_fields.sort((a, b) => a.sort_order - b.sort_order);
  }

  res.json({ form: data });
});

/**
 * POST /api/consultation-forms
 * Create a new consultation form with fields.
 */
router.post('/', requireAuth, validate(createConsultationFormSchema), async (req, res) => {
  const { name, consent_text, is_default, fields } = req.body;

  // If marking as default, unset other defaults first
  if (is_default) {
    await supabase
      .from('consultation_forms')
      .update({ is_default: false })
      .eq('beautician_id', req.beautician.id)
      .eq('is_default', true);
  }

  // Create the form
  const { data: form, error: formError } = await supabase
    .from('consultation_forms')
    .insert({
      beautician_id: req.beautician.id,
      name,
      consent_text,
      is_default,
    })
    .select()
    .single();

  if (formError) {
    logger.error({ err: formError }, 'Failed to create consultation form');
    return res.status(500).json({ error: 'Something went wrong' });
  }

  // Insert fields if provided
  if (fields.length > 0) {
    const fieldRows = fields.map((f, i) => ({
      form_id: form.id,
      type: f.type,
      label: f.label,
      options: f.options || [],
      required: f.required || false,
      sort_order: f.sort_order ?? i,
    }));

    const { error: fieldsError } = await supabase
      .from('consultation_form_fields')
      .insert(fieldRows);

    if (fieldsError) {
      logger.warn({ err: fieldsError }, 'Failed to insert form fields');
    }
  }

  // Fetch full form with fields
  const { data: fullForm } = await supabase
    .from('consultation_forms')
    .select('*, consultation_form_fields(*)')
    .eq('id', form.id)
    .single();

  res.status(201).json({ form: fullForm });
});

/**
 * PATCH /api/consultation-forms/:id
 * Update form metadata and/or replace all fields.
 */
router.patch('/:id', requireAuth, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, consent_text, is_default, fields } = req.body;

    // Verify ownership
    const { data: existing } = await supabase
      .from('consultation_forms')
      .select('id')
      .eq('id', id)
      .eq('beautician_id', req.beautician.id)
      .single();

    if (!existing) return res.status(404).json({ error: 'Form not found' });

    // Update form metadata
    const updates = {};
    if (name !== undefined) updates.name = name;
    if (consent_text !== undefined) updates.consent_text = consent_text;
    if (is_default !== undefined) {
      if (is_default) {
        // Unset other defaults
        await supabase
          .from('consultation_forms')
          .update({ is_default: false })
          .eq('beautician_id', req.beautician.id)
          .eq('is_default', true);
      }
      updates.is_default = is_default;
    }
    updates.updated_at = new Date().toISOString();

    const { error: updateError } = await supabase
      .from('consultation_forms')
      .update(updates)
      .eq('id', id);

    if (updateError) {
      logger.error({ err: updateError }, 'Failed to update consultation form');
      return res.status(500).json({ error: 'Something went wrong' });
    }

    // Replace fields if provided (delete all, re-insert)
    if (fields !== undefined && Array.isArray(fields)) {
      await supabase
        .from('consultation_form_fields')
        .delete()
        .eq('form_id', id);

      if (fields.length > 0) {
        const fieldRows = fields.map((f, i) => ({
          form_id: id,
          type: f.type,
          label: f.label,
          options: f.options || [],
          required: f.required || false,
          sort_order: f.sort_order ?? i,
        }));

        const { error: fieldsError } = await supabase
          .from('consultation_form_fields')
          .insert(fieldRows);

        if (fieldsError) {
          logger.error({ err: fieldsError }, 'Failed to update form fields');
          return res.status(500).json({ error: 'Something went wrong' });
        }
      }
    }

    // Return full updated form
    const { data: fullForm } = await supabase
      .from('consultation_forms')
      .select('*, consultation_form_fields(*)')
      .eq('id', id)
      .single();

    if (fullForm?.consultation_form_fields) {
      fullForm.consultation_form_fields.sort((a, b) => a.sort_order - b.sort_order);
    }

    res.json({ form: fullForm });
  } catch (err) {
    logger.error({ err }, 'Unexpected error updating consultation form');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

/**
 * DELETE /api/consultation-forms/:id
 * Soft-delete (deactivate) a form.
 */
router.delete('/:id', requireAuth, async (req, res) => {
  const { error } = await supabase
    .from('consultation_forms')
    .update({ is_active: false, is_default: false })
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id);

  if (error) {
    logger.error({ err: error }, 'Failed to delete consultation form');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ success: true });
});

/**
 * GET /api/consultation-forms/responses
 * List responses for the beautician (optionally filtered by client).
 */
router.get('/responses/list', requireAuth, async (req, res) => {
  const { client_id, appointment_id } = req.query;

  let query = supabase
    .from('consultation_responses')
    .select('*, consultation_forms(name), clients(first_name, last_name)')
    .eq('beautician_id', req.beautician.id)
    .eq('status', 'completed')
    .order('completed_at', { ascending: false });

  if (client_id) query = query.eq('client_id', client_id);
  if (appointment_id) query = query.eq('appointment_id', appointment_id);

  const { data, error } = await query;
  if (error) {
    logger.error({ err: error }, 'Failed to fetch consultation responses');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ responses: data || [] });
});

/**
 * GET /api/consultation-forms/responses/:id
 * Get a single response with form fields for display.
 */
router.get('/responses/:id', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('consultation_responses')
    .select('*, consultation_forms(name, consultation_form_fields(*))')
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .single();

  if (error || !data) return res.status(404).json({ error: 'Response not found' });
  res.json({ response: data });
});

// ═══════════════════════════════════════════════
// PUBLIC FORM ACCESS (no auth — token-based)
// ═══════════════════════════════════════════════

/**
 * GET /api/consultation-forms/public/:token
 * Load a consultation form by token. No auth required.
 * Returns the form structure + client name for personalisation.
 */
router.get('/public/:token', async (req, res) => {
  const { data: response } = await supabase
    .from('consultation_responses')
    .select('id, status, expires_at, form_id, consultation_forms(name, consent_text, consultation_form_fields(*)), clients(first_name), beauticians(business_name, first_name, brand_color, logo_url)')
    .eq('token', req.params.token)
    .single();

  if (!response) return res.status(404).json({ error: 'Form not found or link has expired' });

  // Check expiry
  if (response.expires_at && new Date(response.expires_at) < new Date()) {
    await supabase
      .from('consultation_responses')
      .update({ status: 'expired' })
      .eq('id', response.id);
    return res.status(410).json({ error: 'This form link has expired. Please contact your beautician for a new link.' });
  }

  // Already completed
  if (response.status === 'completed') {
    return res.json({ completed: true, message: 'You have already submitted this form. Thank you!' });
  }

  // Sort fields
  const form = response.consultation_forms;
  if (form?.consultation_form_fields) {
    form.consultation_form_fields.sort((a, b) => a.sort_order - b.sort_order);
  }

  res.json({
    form: {
      name: form.name,
      consent_text: form.consent_text,
      fields: form.consultation_form_fields || [],
    },
    client_name: response.clients?.first_name || null,
    beautician: {
      name: response.beauticians?.business_name || response.beauticians?.first_name,
      brand_color: response.beauticians?.brand_color,
      logo: response.beauticians?.logo_url,
    },
  });
});

/**
 * POST /api/consultation-forms/public/:token/submit
 * Submit a completed consultation form. No auth required.
 */
router.post('/public/:token/submit', validate(submitConsultationFormSchema), async (req, res) => {
  const { answers, signature_data } = req.body;

  // Load response
  const { data: response } = await supabase
    .from('consultation_responses')
    .select('id, status, expires_at, form_id')
    .eq('token', req.params.token)
    .single();

  if (!response) return res.status(404).json({ error: 'Form not found' });
  if (response.status === 'completed') return res.status(400).json({ error: 'Form already submitted' });
  if (response.expires_at && new Date(response.expires_at) < new Date()) {
    return res.status(410).json({ error: 'Form link has expired' });
  }

  // Validate required fields
  const { data: fields } = await supabase
    .from('consultation_form_fields')
    .select('id, type, required, label')
    .eq('form_id', response.form_id)
    .eq('required', true);

  const missingFields = [];
  for (const field of (fields || [])) {
    if (field.type === 'text_block') continue; // text blocks aren't answerable
    const answer = answers[field.id];
    if (answer === undefined || answer === null || answer === '' ||
        (Array.isArray(answer) && answer.length === 0)) {
      missingFields.push(field.label);
    }
  }

  if (missingFields.length > 0) {
    return res.status(400).json({
      error: 'Please complete all required fields',
      missing: missingFields,
    });
  }

  // Save
  const { error } = await supabase
    .from('consultation_responses')
    .update({
      answers,
      signature_data,
      status: 'completed',
      completed_at: new Date().toISOString(),
    })
    .eq('id', response.id);

  if (error) return res.status(500).json({ error: 'Failed to save form' });

  res.json({ success: true, message: 'Thank you — your form has been submitted.' });
});

// ═══════════════════════════════════════════════
// SEND FORM LINK (used internally after booking)
// ═══════════════════════════════════════════════

/**
 * Send a consultation form SMS to a client.
 * Called internally by the booking route for first-time clients.
 *
 * @param {{beauticianId: string, clientId: string, appointmentId: string, clientPhone: string, clientFirstName: string, treatmentId: string, beauticianName: string}} opts
 * @param {string} opts.beauticianId - UUID of the beautician
 * @param {string} opts.clientId - UUID of the client
 * @param {string} opts.appointmentId - UUID of the appointment
 * @param {string} opts.clientPhone - phone number to send SMS to
 * @param {string} opts.clientFirstName - client's first name for personalization
 * @param {string} opts.treatmentId - UUID used to find treatment-specific form
 * @param {string} opts.beauticianName - beautician's name for SMS personalization
 * @returns {Promise<{id: string, form_id: string, token: string, status: string, expires_at: string, created_at: string}|null>} consultation response record or null if no form configured
 */
export async function sendConsultationFormSMS({
  beauticianId, clientId, appointmentId, clientPhone, clientFirstName,
  treatmentId, beauticianName,
}) {
  // 1. Find the right form: treatment-specific first, then beautician default
  let formId = null;

  if (treatmentId) {
    const { data: treatment } = await supabase
      .from('treatments')
      .select('consultation_form_id')
      .eq('id', treatmentId)
      .single();
    formId = treatment?.consultation_form_id;
  }

  if (!formId) {
    const { data: defaultForm } = await supabase
      .from('consultation_forms')
      .select('id')
      .eq('beautician_id', beauticianId)
      .eq('is_default', true)
      .eq('is_active', true)
      .maybeSingle();
    formId = defaultForm?.id;
  }

  if (!formId) return null; // No form configured — skip

  // 2. Create a response record with a unique token
  const token = crypto.randomUUID();
  const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days

  const { data: response, error } = await supabase
    .from('consultation_responses')
    .insert({
      form_id: formId,
      beautician_id: beauticianId,
      client_id: clientId,
      appointment_id: appointmentId,
      token,
      status: 'pending',
      expires_at: expiresAt.toISOString(),
    })
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Failed to create consultation response');
    throw error;
  }

  // 3. Send SMS with link
  const formUrl = `${FRONTEND_URL}/form/${token}`;
  const smsBody = `Hi ${clientFirstName}, ${beauticianName} needs you to fill in a quick consultation form before your appointment. It takes about 2 minutes:\n\n${formUrl}`;

  await sendSMS({ to: clientPhone, body: smsBody, beauticianId });

  // Log message
  await supabase.from('messages').insert({
    beautician_id: beauticianId,
    client_id: clientId,
    direction: 'outbound',
    channel: 'sms',
    content: smsBody,
    status: 'sent',
  }).catch(() => {}); // non-fatal

  logger.info({ clientId, formId, token }, 'Consultation form SMS sent');
  return response;
}

export default router;
