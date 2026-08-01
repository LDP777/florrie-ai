import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
// Client limits removed — all plans have unlimited clients (Apr 2026)
import { validate } from '../middleware/validate.js';
import { refreshAllIntelligence } from '../services/client-intelligence.js';
import logger from '../lib/logger.js';
import { parsePagination, buildPaginationMeta, handleQueryError, buildSearchFilter } from '../lib/queries.js';
import { getOutstandingBalanceCents } from '../services/outstanding-balance.js';
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

  // Build query. Archived clients are hidden by default; ?archived=true
  // flips the view to ONLY the archived ones (that is the "Archived" row at
  // the bottom of the Clients page, not a merged list).
  const wantArchived = req.query.archived === 'true';
  let query = supabase
    .from('clients')
    .select('*', { count: 'exact' })
    .eq('beautician_id', req.beautician.id)
    .order('last_visit_at', { ascending: false, nullsFirst: false });
  query = wantArchived
    ? query.not('archived_at', 'is', null)
    : query.is('archived_at', null);

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
  let { data, error, count } = await query.range(offset, offset + per_page - 1);
  if (error && error.code === '42703' && !wantArchived) {
    // archived_at does not exist yet (migration 018 applied by hand). The
    // client list must keep working in the meantime, so fall back to the
    // unfiltered query - before the migration nobody is archived anyway.
    let retry = supabase
      .from('clients')
      .select('*', { count: 'exact' })
      .eq('beautician_id', req.beautician.id)
      .order('last_visit_at', { ascending: false, nullsFirst: false });
    if (req.query.status) retry = retry.eq('status', req.query.status);
    if (req.query.search) {
      const sf = buildSearchFilter(req.query.search, ['first_name', 'last_name', 'email']);
      if (sf) retry = retry.or(sf);
    }
    ({ data, error, count } = await retry.range(offset, offset + per_page - 1));
  }
  if (handleQueryError(error, res, 'fetch clients')) {
    return;
  }

  const pagination = buildPaginationMeta(count || 0, page, per_page);
  res.json({ data: data || [], pagination });
});

/**
 * GET /api/clients/inactive-review
 * The one-time tidy-up helper: clients who have not visited in over 12 months
 * (or were added over 12 months ago and never visited), are not archived, not
 * blocked, and have nothing upcoming in the diary. Powers the "12 clients have
 * not visited in over a year. Review?" card on the Clients page.
 * Registered before /:id so the router does not read "inactive-review" as an id.
 */
router.get('/inactive-review', requireAuth, async (req, res) => {
  try {
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - 12);
    const cutoffIso = cutoff.toISOString();

    const { data: all, error } = await supabase
      .from('clients')
      .select('id, first_name, last_name, last_visit_at, created_at, total_visits, archived_at, blocked_at')
      .eq('beautician_id', req.beautician.id);
    if (error) {
      // Fail soft: the card simply does not appear. Never break the page.
      logger.warn({ err: error }, 'inactive-review query failed');
      return res.json({ count: 0, candidates: [] });
    }

    let candidates = (all || []).filter(c =>
      !c.archived_at && !c.blocked_at
      && (c.last_visit_at ? c.last_visit_at < cutoffIso : (c.created_at || '') < cutoffIso)
    );

    // Someone with a future booking is coming back, whatever their history
    // says - never suggest archiving them.
    if (candidates.length > 0) {
      const { data: upcoming, error: upErr } = await supabase
        .from('appointments')
        .select('client_id')
        .eq('beautician_id', req.beautician.id)
        .in('client_id', candidates.map(c => c.id))
        .in('status', ['confirmed', 'pending'])
        .gte('starts_at', new Date().toISOString());
      if (upErr) {
        logger.warn({ err: upErr }, 'inactive-review upcoming check failed');
        return res.json({ count: 0, candidates: [] });
      }
      const hasUpcoming = new Set((upcoming || []).map(a => a.client_id));
      candidates = candidates.filter(c => !hasUpcoming.has(c.id));
    }

    candidates.sort((a, b) => String(a.last_visit_at || a.created_at || '').localeCompare(String(b.last_visit_at || b.created_at || '')));
    res.json({
      count: candidates.length,
      candidates: candidates.map(c => ({
        id: c.id,
        first_name: c.first_name,
        last_name: c.last_name,
        last_visit_at: c.last_visit_at,
        total_visits: c.total_visits || 0,
      })),
    });
  } catch (err) {
    logger.warn({ err }, 'inactive-review failed');
    res.json({ count: 0, candidates: [] });
  }
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
 * GET /api/clients/:id/payments
 * Payment truth for one client, assembled from BOTH sources:
 *   - transactions rows (what was actually charged and logged)
 *   - the appointment's own deposit fields (deposit_paid, deposit_status,
 *     deposit_amount_cents, deposit_cents, stripe_payment_intent_id)
 *
 * WHY both: the Stripe webhook historically failed to fire in production, so
 * plenty of deposits that clients genuinely paid have NO transaction row. The
 * appointment still carries the Stripe payment intent and the deposit_paid
 * flag, which is proof the charge happened, so a deposit evidenced that way
 * counts as paid even without a transaction row. This is why the client
 * profile used to say "£0 spent" for clients who had paid three deposits.
 */
router.get('/:id/payments', requireAuth, async (req, res) => {
  // Confirm the client belongs to this beautician before exposing money data.
  const { data: client, error: cErr } = await supabase
    .from('clients')
    .select('id')
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .single();

  if (cErr || !client) return res.status(404).json({ error: 'Client not found' });

  const [txRes, apptRes] = await Promise.all([
    supabase
      .from('transactions')
      .select('id, appointment_id, amount_cents, type, payment_method, status, created_at')
      .eq('beautician_id', req.beautician.id)
      .eq('client_id', client.id)
      .eq('status', 'completed')
      .order('created_at', { ascending: false })
      .limit(100),
    supabase
      .from('appointments')
      .select('id, starts_at, status, price_cents, deposit_cents, deposit_amount_cents, deposit_paid, deposit_status, payment_type, stripe_payment_intent_id, treatments(name)')
      .eq('beautician_id', req.beautician.id)
      .eq('client_id', client.id)
      .order('starts_at', { ascending: false })
      .limit(50),
  ]);

  if (handleQueryError(txRes.error, res, 'fetch client transactions')) return;
  if (handleQueryError(apptRes.error, res, 'fetch client appointments')) return;

  const transactions = txRes.data || [];
  const txByAppt = new Map();
  for (const tx of transactions) {
    if (!tx.appointment_id) continue;
    if (!txByAppt.has(tx.appointment_id)) txByAppt.set(tx.appointment_id, []);
    txByAppt.get(tx.appointment_id).push(tx);
  }

  let depositsTotalCents = 0;
  const perAppointment = (apptRes.data || []).map(appt => {
    const txs = txByAppt.get(appt.id) || [];
    const upfrontTx = txs.find(t => t.type === 'deposit' || t.type === 'full_payment') || null;

    // Paid evidence, strongest first: a logged transaction, then the paid
    // flag, then a Stripe intent alongside a paid deposit status. The last
    // two exist purely to cover the historic recording gap described above.
    const depositPaid = !!(
      upfrontTx ||
      appt.deposit_paid ||
      (appt.stripe_payment_intent_id && appt.deposit_status === 'paid')
    );

    // Amount: prefer what was ACTUALLY charged (the transaction, which is
    // what the card statement shows), then the amount the checkout session
    // was created for, then the configured deposit. Never recomputed from
    // the treatment price, so this figure cannot contradict the statement.
    const depositCents = upfrontTx?.amount_cents
      ?? appt.deposit_amount_cents
      ?? appt.deposit_cents
      ?? 0;

    const paidInFull = depositPaid &&
      (appt.payment_type === 'full' || upfrontTx?.type === 'full_payment');

    const balanceTx = txs.find(t => t.type === 'payment' || t.type === 'payment_link') || null;
    const balanceCents = paidInFull
      ? 0
      : Math.max(0, (appt.price_cents || 0) - (depositPaid ? depositCents : 0));
    // A completed appointment is treated as settled: the balance is taken on
    // the day, so an open balance on a past visit would just be noise.
    const balanceSettled = paidInFull || balanceCents === 0 || !!balanceTx || appt.status === 'completed';

    // Full payments count towards the total too: it is all money the client
    // paid up front, which is exactly what Ellie could not see before.
    if (depositPaid) depositsTotalCents += depositCents;

    return {
      appointment_id: appt.id,
      starts_at: appt.starts_at,
      status: appt.status,
      treatment: appt.treatments?.name || 'Appointment',
      deposit_cents: depositCents,
      deposit_paid: depositPaid,
      paid_in_full: paidInFull,
      balance_cents: balanceCents,
      balance_settled: balanceSettled,
    };
  });

  res.json({
    deposits_total_cents: depositsTotalCents,
    payments: transactions,
    per_appointment: perAppointment,
  });
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
 * POST /api/clients/:id/archive and /api/clients/:id/unarchive
 * Reversible tidy-up for clients who have drifted away. Archiving hides them
 * from the client list; NOTHING is deleted, and the backend auto-unarchives
 * them if they message or book again. Follows the block-route pattern above.
 */
router.post('/:id/archive', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('clients')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .select('id, first_name, archived_at')
    .single();

  if (error) {
    logger.error({ err: error }, 'Failed to archive client');
    return res.status(500).json({ error: 'Could not archive this client. If archiving has just been added, the database may need a moment.' });
  }
  res.json({ client: data, archived: !!data.archived_at });
});

router.post('/:id/unarchive', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('clients')
    .update({ archived_at: null })
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .select('id, first_name, archived_at')
    .single();

  if (error) {
    logger.error({ err: error }, 'Failed to unarchive client');
    return res.status(500).json({ error: 'Could not restore this client.' });
  }
  res.json({ client: data, archived: !!data.archived_at });
});

/**
 * GET /api/clients/:id/outstanding-balance
 * What this client still owes from previous visits (unpaid policy fees +
 * unsettled remainders). Shown on the appointment sheet so Ellie knows before
 * they arrive. The service fails open (zero) on any error.
 */
router.get('/:id/outstanding-balance', requireAuth, async (req, res) => {
  const { owesCents, sources } = await getOutstandingBalanceCents(req.beautician.id, req.params.id);
  res.json({ owes_cents: owesCents || 0, sources: sources || [] });
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
