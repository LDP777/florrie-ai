import { Router } from 'express';
import { supabase } from '../index.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

/**
 * GET /api/clients
 * List all clients. Supports ?status=dormant&search=sarah
 */
router.get('/', requireAuth, async (req, res) => {
  let query = supabase
    .from('clients')
    .select('*')
    .eq('beautician_id', req.beautician.id)
    .order('last_visit_at', { ascending: false, nullsFirst: false });

  if (req.query.status) {
    query = query.eq('status', req.query.status);
  }

  if (req.query.search) {
    query = query.or(`first_name.ilike.%${req.query.search}%,last_name.ilike.%${req.query.search}%,email.ilike.%${req.query.search}%`);
  }

  const { data, error } = await query;
  if (error) return res.status(500).json({ error: error.message });
  res.json({ clients: data });
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
router.post('/', requireAuth, async (req, res) => {
  const { first_name, last_name, email, phone, preferred_channel, notes } = req.body;

  if (!first_name) {
    return res.status(400).json({ error: 'First name is required' });
  }

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

  if (error) return res.status(500).json({ error: error.message });
  res.status(201).json({ client: data });
});

/**
 * PATCH /api/clients/:id
 */
router.patch('/:id', requireAuth, async (req, res) => {
  const allowedFields = [
    'first_name', 'last_name', 'email', 'phone', 'preferred_channel',
    'marketing_consent', 'health_data_consent', 'notes', 'status',
    'preferences', 'life_events'
  ];

  const updates = {};
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) updates[field] = req.body[field];
  }

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

  if (error) return res.status(500).json({ error: error.message });
  res.json({ client: data });
});

/**
 * POST /api/clients/import
 * Bulk import clients from CSV (Fresha/Timely format).
 */
router.post('/import', requireAuth, async (req, res) => {
  const { clients, source } = req.body; // source: 'fresha', 'timely', 'csv'

  if (!Array.isArray(clients) || clients.length === 0) {
    return res.status(400).json({ error: 'Provide an array of clients' });
  }

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

  if (error) return res.status(500).json({ error: error.message });
  res.json({ imported: data.length, clients: data });
});

export default router;
