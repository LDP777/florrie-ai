import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../index.js';
import { requireAuth } from '../middleware/auth.js';
// Client limits removed — all plans have unlimited clients (Apr 2026)
import { validate } from '../middleware/validate.js';
import { refreshAllIntelligence } from '../services/client-intelligence.js';
import logger from '../lib/logger.js';

const router = Router();

const createClientSchema = z.object({
  first_name: z.string().min(1, 'First name is required').max(100).trim(),
  last_name: z.string().max(100).trim().optional().nullable(),
  email: z.string().email('Invalid email').optional().nullable(),
  phone: z.string().max(30).trim().optional().nullable(),
  preferred_channel: z.enum(['whatsapp', 'sms', 'email']).optional().default('whatsapp'),
  notes: z.string().max(5000).optional().nullable(),
});

const updateClientSchema = z.object({
  first_name: z.string().min(1).max(100).trim().optional(),
  last_name: z.string().max(100).trim().optional().nullable(),
  email: z.string().email().optional().nullable(),
  phone: z.string().max(30).trim().optional().nullable(),
  preferred_channel: z.enum(['whatsapp', 'sms', 'email']).optional(),
  marketing_consent: z.boolean().optional(),
  health_data_consent: z.boolean().optional(),
  notes: z.string().max(5000).optional().nullable(),
  status: z.enum(['new', 'active', 'dormant', 'vip']).optional(),
  preferences: z.record(z.any()).optional().nullable(),
  life_events: z.record(z.any()).optional().nullable(),
}).strict();

const importClientsSchema = z.object({
  clients: z.array(z.object({
    first_name: z.string().optional(),
    firstName: z.string().optional(),
    last_name: z.string().optional(),
    lastName: z.string().optional(),
    name: z.string().optional(),
    email: z.string().email().optional().nullable(),
    phone: z.string().optional().nullable(),
    mobile: z.string().optional().nullable(),
    notes: z.string().optional().nullable(),
    id: z.any().optional(),
    external_id: z.any().optional(),
  })).min(1, 'Provide at least one client'),
  source: z.enum(['fresha', 'timely', 'csv']).optional().default('csv'),
});

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
  // Pagination params
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const per_page = Math.min(100, Math.max(1, parseInt(req.query.per_page) || 25));
  const offset = (page - 1) * per_page;

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
    // Sanitise: strip PostgREST filter metacharacters to prevent .or() injection
    const search = req.query.search.replace(/[^a-zA-Z0-9\s\-'.@]/g, '').trim().substring(0, 100);
    if (search) {
      query = query.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%`);
    }
  }

  // Apply pagination
  const { data, error, count } = await query.range(offset, offset + per_page - 1);
  if (error) {
    logger.error({ err: error }, 'Failed to fetch clients');
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

  // Get recent appointments
  const { data: appointments } = await supabase
    .from('appointments')
    .select('*, treatments(name)')
    .eq('client_id', req.params.id)
    .order('starts_at', { ascending: false })
    .limit(10);

  // Get recent messages
  const { data: messages } = await supabase
    .from('messages')
    .select('*')
    .eq('client_id', req.params.id)
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

export default router;
