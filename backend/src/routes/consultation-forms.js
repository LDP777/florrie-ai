import { Router } from 'express';
import crypto from 'crypto';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { sendSMS } from '../services/notifications.js';
import logger from '../lib/logger.js';
import { handleQueryError } from '../lib/queries.js';
import { requireOwned } from '../lib/ownership.js';
import { shapeResponse } from '../lib/consultation-answers.js';
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
        const seenF = new Set();
        const uniqueFields = fields.filter(f => {
          const k = `${f.type}|${f.label}|${JSON.stringify(f.options || [])}`;
          if (seenF.has(k)) return false; seenF.add(k); return true;
        });
        const fieldRows = uniqueFields.map((f, i) => ({
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
 * The join that makes a submission readable.
 *
 * The answers blob is keyed by field id, so without the field definitions it
 * is a wall of uuids. signature_data is selected only so the row knows whether
 * one exists: the blob itself never leaves in a list payload.
 */
const RESPONSE_SELECT =
  'id, form_id, client_id, appointment_id, status, completed_at, created_at, answers, signature_data, ' +
  'consultation_forms(name, consent_text, consultation_form_fields(id, type, label, options, sort_order))';

/**
 * Does this account have a form it could actually send?
 *
 * Returns false when the lookup fails rather than throwing: the only thing
 * riding on it is whether a "Send a form" button appears, and a missing
 * button is a far better failure than a button that sends nothing.
 */
async function hasSendableForm(beauticianId) {
  const { data, error } = await supabase
    .from('consultation_forms')
    .select('id')
    .eq('beautician_id', beauticianId)
    .eq('is_active', true)
    .limit(1);
  if (error) {
    logger.warn({ err: error }, 'Could not check for a sendable consultation form');
    return false;
  }
  return (data || []).length > 0;
}

/**
 * GET /api/consultation-forms/responses/list?client_id=&appointment_id=
 *
 * Every completed submission, newest first, already paired up with the
 * questions that produced it. The pairing happens here rather than in the app
 * so the flagging rules are tested once, server side, instead of living in a
 * component nobody can run in isolation.
 *
 * Health data, so: authenticated, scoped to this beautician on the query
 * itself, and any id that arrived in the request is checked against this
 * account before a single answer is read.
 */
router.get('/responses/list', requireAuth, async (req, res) => {
  const { client_id, appointment_id } = req.query;

  // The ids come from the request, so they are somebody's guess until proven
  // otherwise. A wrong-tenant client_id must not return that tenant's
  // allergies.
  if (!await requireOwned(req, res, [
    { table: 'clients', id: client_id },
    { table: 'appointments', id: appointment_id },
  ])) return;

  let query = supabase
    .from('consultation_responses')
    .select(RESPONSE_SELECT)
    .eq('beautician_id', req.beautician.id)
    .eq('status', 'completed')
    .order('completed_at', { ascending: false });

  if (client_id) query = query.eq('client_id', client_id);
  if (appointment_id) query = query.eq('appointment_id', appointment_id);

  const { data, error } = await query;
  // Checked, always. An unchecked select here returns null on one wrong
  // column name and the section renders "no consultation form yet" for a
  // client who filled one in, which is the worst possible lie on this screen.
  if (handleQueryError(error, res, 'fetch consultation responses')) return;

  res.json({
    responses: (data || []).map(shapeResponse),
    form_available: await hasSendableForm(req.beautician.id),
  });
});

/**
 * GET /api/consultation-forms/responses/:id
 *
 * One submission, including the signature image. Fetched on demand rather
 * than shipped with every list, because a base64 png per row turns a client
 * profile into a megabyte of scribble she did not ask to download.
 */
router.get('/responses/:id', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('consultation_responses')
    .select(RESPONSE_SELECT)
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .maybeSingle();

  if (error) {
    logger.error({ err: error }, 'Failed to fetch consultation response');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  if (!data) return res.status(404).json({ error: 'Response not found' });

  res.json({
    response: { ...shapeResponse(data), signature_data: data.signature_data || null },
  });
});

/**
 * GET /api/consultation-forms/for-appointment/:appointmentId
 *
 * Everything the appointment sheet needs in one call: does anything booked
 * today require a consultation, is there a form on file for this client, and
 * what did they answer that is worth knowing before they sit down.
 *
 * The form is looked up by CLIENT, not by appointment. A regular fills one in
 * once, at their first booking, and it is still the form on file two years
 * later. Scoping to appointment_id would tell her "nothing on file" for every
 * client she has.
 */
router.get('/for-appointment/:appointmentId', requireAuth, async (req, res) => {
  const { data: appt, error: apptErr } = await supabase
    .from('appointments')
    .select('id, client_id, treatment_id, extra_treatment_ids')
    .eq('id', req.params.appointmentId)
    .eq('beautician_id', req.beautician.id)
    .maybeSingle();

  if (apptErr) {
    logger.error({ err: apptErr }, 'Failed to fetch appointment for consultation lookup');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  if (!appt) return res.status(404).json({ error: 'Appointment not found' });

  // Extras count. A brow tint added on the day can be the treatment that
  // needs the consultation, and it lives in extra_treatment_ids, not
  // treatment_id.
  const treatmentIds = [
    appt.treatment_id,
    ...(Array.isArray(appt.extra_treatment_ids) ? appt.extra_treatment_ids : []),
  ].filter(Boolean);

  let requiresConsultation = false;
  if (treatmentIds.length > 0) {
    const { data: treats, error: tErr } = await supabase
      .from('treatments')
      .select('id, requires_consultation')
      .in('id', treatmentIds)
      .eq('beautician_id', req.beautician.id);
    // A failed lookup must not read as "no consultation needed". Better to
    // fail the call and show her nothing than to quietly reassure her.
    if (handleQueryError(tErr, res, 'fetch treatments for consultation lookup')) return;
    requiresConsultation = (treats || []).some(t => t.requires_consultation === true);
  }

  let response = null;
  if (appt.client_id) {
    const { data: rows, error: rErr } = await supabase
      .from('consultation_responses')
      .select(RESPONSE_SELECT)
      .eq('beautician_id', req.beautician.id)
      .eq('client_id', appt.client_id)
      .eq('status', 'completed')
      .order('completed_at', { ascending: false })
      .limit(1);
    if (handleQueryError(rErr, res, 'fetch consultation response for appointment')) return;
    if ((rows || []).length > 0) response = shapeResponse(rows[0]);
  }

  res.json({
    requires_consultation: requiresConsultation,
    response,
    form_available: response ? false : await hasSendableForm(req.beautician.id),
  });
});

/**
 * POST /api/consultation-forms/send
 * Body: { client_id, appointment_id? }
 *
 * Sends the client the same form link the booking flow sends, using the same
 * sender. There is deliberately no second implementation of "text them a
 * form": one sender means one set of rules about which form, how long the
 * link lives, and what gets logged.
 */
router.post('/send', requireAuth, async (req, res) => {
  const { client_id, appointment_id } = req.body || {};
  if (!client_id) return res.status(400).json({ error: 'Which client?' });

  if (!await requireOwned(req, res, [
    { table: 'clients', id: client_id },
    { table: 'appointments', id: appointment_id },
  ])) return;

  const { data: client, error: cErr } = await supabase
    .from('clients')
    .select('id, first_name, phone')
    .eq('id', client_id)
    .eq('beautician_id', req.beautician.id)
    .maybeSingle();

  if (handleQueryError(cErr, res, 'fetch client for consultation form send')) return;
  if (!client) return res.status(404).json({ error: 'Not found' });
  if (!client.phone) {
    return res.status(400).json({ error: 'No mobile number on file for this client, so there is nowhere to send it.' });
  }

  // The treatment decides which form: a treatment-specific one wins over the
  // default, and that rule lives in the sender.
  let treatmentId = null;
  if (appointment_id) {
    const { data: appt, error: aErr } = await supabase
      .from('appointments')
      .select('id, treatment_id')
      .eq('id', appointment_id)
      .eq('beautician_id', req.beautician.id)
      .maybeSingle();
    if (handleQueryError(aErr, res, 'fetch appointment for consultation form send')) return;
    treatmentId = appt?.treatment_id || null;
  }

  try {
    const sent = await sendConsultationFormSMS({
      beauticianId: req.beautician.id,
      clientId: client.id,
      appointmentId: appointment_id || null,
      clientPhone: client.phone,
      clientFirstName: client.first_name || 'there',
      treatmentId,
      beauticianName: req.beautician.business_name || req.beautician.first_name || 'your beautician',
    });

    if (!sent) {
      return res.status(400).json({
        error: 'No consultation form set up yet. Build one and mark it as your default, then you can send it.',
      });
    }
    // Ids only. The answers do not exist yet, and the token never gets logged.
    logger.info({ clientId: client.id }, 'Consultation form sent from the app');
    res.json({ sent: true });
  } catch (err) {
    logger.error({ err }, 'Failed to send consultation form');
    res.status(500).json({ error: 'Could not send the form just now. Try again in a moment.' });
  }
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
  const { data: response, error } = await supabase
    .from('consultation_responses')
    .select('id, status, expires_at, form_id, consultation_forms(name, consent_text, consultation_form_fields(*)), clients(first_name), beauticians(business_name, first_name, brand_color, logo_url)')
    .eq('token', req.params.token)
    .maybeSingle();

  // Logged, never with the token: the token IS the credential guarding this
  // form. The client still sees the same "not found", because an unreadable
  // token and a wrong token must look identical from outside.
  if (error) logger.warn({ err: error }, 'Public consultation form lookup failed');
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
  }).catch(() => {}); // non-fatal

  // Do not log the token: it is the only credential guarding the public
  // consultation form (special-category health data).
  logger.info({ clientId, formId }, 'Consultation form SMS sent');
  return response;
}

export default router;
