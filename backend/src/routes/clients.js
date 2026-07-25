import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
// Client limits removed — all plans have unlimited clients (Apr 2026)
import { validate } from '../middleware/validate.js';
import { refreshAllIntelligence } from '../services/client-intelligence.js';
import logger from '../lib/logger.js';
import { parsePagination, buildPaginationMeta, handleQueryError, buildSearchFilter } from '../lib/queries.js';
import {
  createClientSchema,
  updateClientSchema,
  importClientsSchema
} from '../lib/schemas.js';

const router = Router();

/**
 * GET /api/clients
 * List all clients. Supports pagination and filtering.
 * Query params:
 *   - page=1 (default 1)
 *   - per_page=25 (default 25, max 100)
 *   - status=dormant
 *   - search=sarah
 */
router.get('/', requireAuth, async (req, res) => {
  const { page, per_page, offset } = parsePagination(req.query);

  // Build query
  let query = supabase
    .from('clients')
    .select('*', { count: 'exact' })
    .eq('beautician_id', req.beautician.id)
    .order('last_visit_at', { ascending: false, nullsFirst: false });

  if (req.query.status) {
    query = query.eq('status', req.query.status);
  }

  if (req.query.search) {
    const searchFilter = buildSearchFilter(req.query.search, ['first_name', 'last_name', 'email']);
    if (searchFilter) {
      query = query.or(searchFilter);
    }
  }

  // Apply pagination
  const { data, error, count } = await query.range(offset, offset + per_page - 1);
  if (handleQueryError(error, res, 'fetch clients')) {
    return;
  }

  const pagination = buildPaginationMeta(count || 0, page, per_page);
  res.json({ data: data || [], pagination });
});

/**
 * GET /api/clients/:id
 * Get a single client with their intelligence data.
 */
router.get('/:id', requireAuth, async (req, res) => {
  const { data: client, error } = await supabase
    .from('clients')
    .select('*, client_intelligence(*)')
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .single();

  if (error) return res.status(404).json({ error: 'Client not found' });

  // Use verified client.id (not raw URL param) and scope to beautician for both sub-queries
  const { data: appointments } = await supabase
    .from('appointments')
    .select('*, treatments(name)')
    .eq('client_id', client.id)
    .eq('beautician_id', req.beautician.id)
    .order('starts_at', { ascending: false })
    .limit(10);

  const { data: messages } = await supabase
    .from('messages')
    .select('*')
    .eq('client_id', client.id)
    .eq('beautician_id', req.beautician.id)
    .order('created_at', { ascending: false })
    .limit(20);

  res.json({ client, appointments: appointments || [], messages: messages || [] });
});

/**
 * POST /api/clients
 * Create a new client.
 */
router.post('/', requireAuth, validate(createClientSchema), async (req, res) => {
  const { first_name, last_name, email, phone, preferred_channel, notes } = req.body;

  const { data, error } = await supabase
    .from('clients')
    .insert({
      beautician_id: req.beautician.id,
      first_name,
      last_name: last_name || null,
      email: email || null,
      phone: phone || null,
      preferred_channel: preferred_channel || 'whatsapp',
      notes: notes || null,
      status: 'new'
    })
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Failed to create client');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ client: data });
});

/**
 * PATCH /api/clients/:id
 */
router.patch('/:id', requireAuth, validate(updateClientSchema), async (req, res) => {
  const updates = { ...req.body };

  // Track consent timestamps
  if (req.body.marketing_consent !== undefined) {
    updates.marketing_consent_at = new Date().toISOString();
  }
  if (req.body.health_data_consent !== undefined) {
    updates.health_data_consent_at = new Date().toISOString();
  }

  const { data, error } = await supabase
    .from('clients')
    .update(updates)
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Failed to update client');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ client: data });
});

/**
 * POST /api/clients/:id/block  { blocked: true|false }
 * Block or unblock a client. A blocked client cannot book online (booking.js
 * rejects them on the phone/email match); Ellie can still add them manually.
 */
router.post('/:id/block', requireAuth, async (req, res) => {
  const blocked = req.body?.blocked !== false; // default to blocking
  const { data, error } = await supabase
    .from('clients')
    .update({ blocked_at: blocked ? new Date().toISOString() : null })
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .select('id, first_name, blocked_at')
    .single();

  if (error) {
    logger.error({ err: error }, 'Failed to (un)block client');
    return res.status(500).json({ error: 'Could not update this client. If blocking has just been added, the database may need a moment.' });
  }
  res.json({ client: data, blocked: !!data.blocked_at });
});

/**
 * POST /api/clients/import
 * Bulk import clients from CSV (Fresha/Timely format).
 */
router.post('/import', requireAuth, validate(importClientsSchema), async (req, res) => {
  const { clients, source } = req.body;

  const records = clients.map(c => ({
    beautician_id: req.beautician.id,
    first_name: c.first_name || c.firstName || c.name?.split(' ')[0] || 'Unknown',
    last_name: c.last_name || c.lastName || c.name?.split(' ').slice(1).join(' ') || null,
    email: c.email || null,
    phone: c.phone || c.mobile || null,
    notes: c.notes || null,
    imported_from: source || 'csv',
    external_id: c.id || c.external_id || null,
    status: 'active'
  }));

  const { data, error } = await supabase
    .from('clients')
    .upsert(records, { onConflict: 'beautician_id,email', ignoreDuplicates: true })
    .select();

  if (error) {
    logger.error({ err: error }, 'Failed to import clients');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ imported: data.length, clients: data });
});

/**
 * POST /api/clients/refresh-intelligence
 * Refresh client intelligence for all clients of this beautician.
 * Recalculates: visits, spend, booking gaps, churn risk, etc.
 */
router.post('/refresh-intelligence', requireAuth, async (req, res) => {
  try {
    const result = await refreshAllIntelligence(req.beautician.id);
    res.json({
      success: true,
      total_clients: result.count,
      completed: result.completed,
      message: `Refreshed intelligence for ${result.completed}/${result.count} clients`
    });
  } catch (err) {
    logger.error({ err }, 'Failed to refresh client intelligence');
    res.status(500).json({ error: 'Something went wrong' });
  }
});
/**
 * POST /api/clients/:id/merge   Body: { duplicate_id }
 * Folds a duplicate client record into this one: every referencing row moves
 * to the primary, missing contact details are backfilled from the duplicate,
 * then the duplicate is deleted. This is the cure for split threads (an IG
 * DM creating a second record next to the imported one, etc).
 */
const CLIENT_REF_TABLES = [
  'ai_actions', 'appointments', 'booking_suggestions', 'client_intelligence',
  'client_packages', 'client_portal_tokens', 'client_tag_assignments',
  'consultation_responses', 'consultations', 'follow_up_enrollments',
  'form_submissions', 'loyalty_points', 'membership_subscriptions', 'messages',
  'outbound_sends', 'patch_tests', 'payment_links', 'photo_consents',
  'reviews', 'transactions', 'voice_metrics', 'waitlist',
];

router.post('/:id/merge', requireAuth, async (req, res) => {
  const primaryId = req.params.id;
  const duplicateId = req.body?.duplicate_id;
  if (!duplicateId || duplicateId === primaryId) {
    return res.status(400).json({ error: 'duplicate_id required (and must differ)' });
  }
  try {
    // Both records must belong to this beautician.
    const { data: rows } = await supabase
      .from('clients')
      .select('*')
      .in('id', [primaryId, duplicateId])
      .eq('beautician_id', req.beautician.id);
    const primary = (rows || []).find(r => r.id === primaryId);
    const duplicate = (rows || []).find(r => r.id === duplicateId);
    if (!primary || !duplicate) return res.status(404).json({ error: 'Client not found' });

    // 1) Move every referencing row. Per-table best effort: a unique-index
    //    clash on one table must not strand the rest half-merged silently,
    //    so failures are collected and reported.
    const failed = [];
    for (const table of CLIENT_REF_TABLES) {
      const { error } = await supabase
        .from(table)
        .update({ client_id: primaryId })
        .eq('client_id', duplicateId);
      if (error && error.code === '23505') {
        // The primary already has an identical row (same tag, same waitlist
        // entry...): the duplicate's copy is redundant, so drop it.
        const { error: delErr } = await supabase.from(table).delete().eq('client_id', duplicateId);
        if (delErr) failed.push({ table, code: delErr.code });
      } else if (error) {
        failed.push({ table, code: error.code });
      }
    }

    // 2) Backfill contact/identity gaps on the primary from the duplicate.
    const fill = {};
    for (const f of ['phone', 'email', 'whatsapp_id', 'instagram_id', 'last_name', 'notes']) {
      if ((primary[f] == null || primary[f] === '') && duplicate[f]) fill[f] = duplicate[f];
    }
    if (duplicate.last_visit_at && (!primary.last_visit_at || duplicate.last_visit_at > primary.last_visit_at)) {
      fill.last_visit_at = duplicate.last_visit_at;
    }
    if (Object.keys(fill).length) {
      await supabase.from('clients').update(fill).eq('id', primaryId);
    }

    // 3) Remove the duplicate (only if nothing still points at it).
    let deleted = false;
    if (failed.length === 0) {
      const { error: delErr } = await supabase.from('clients').delete().eq('id', duplicateId);
      deleted = !delErr;
      if (delErr) failed.push({ table: 'clients(delete)', code: delErr.code });
    }

    await supabase.from('ai_actions').insert({
      beautician_id: req.beautician.id,
      client_id: primaryId,
      action_type: 'client_profile_updated',
      outcome: failed.length ? 'partial' : 'success',
      summary: `Merged a duplicate record into ${primary.first_name}${primary.last_name ? ' ' + primary.last_name : ''}`,
      digital_employee: 'front_desk',
      created_at: new Date().toISOString(),
    });

    res.json({ merged: true, deleted, filled: Object.keys(fill), failed });
  } catch (err) {
    logger.error({ err, primaryId, duplicateId }, 'Client merge failed');
    res.status(500).json({ error: 'Merge failed part-way. Nothing was lost; try again.' });
  }
});

export default router;
