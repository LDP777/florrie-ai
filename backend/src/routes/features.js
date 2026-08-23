import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../lib/logger.js';
import { guardedSend } from '../lib/outbound-guard.js';
import { sendNudge } from '../services/notifications.js';
import { requireOwned } from '../lib/ownership.js';
import { authorship } from '../lib/authorship.js';
import { exceptionRangeError } from '../lib/hours-exception-range.js';

const router = Router();

// DAILY CHECKLISTS

/**
 * GET /api/features/daily-checklists
 * Get checklists by date (optional ?date=YYYY-MM-DD)
 */
router.get('/daily-checklists', requireAuth, async (req, res) => {
  let query = supabase
    .from('daily_checklists')
    .select('*')
    .eq('beautician_id', req.beautician.id)
    .order('date', { ascending: false });

  if (req.query.date) {
    query = query.eq('date', req.query.date);
  }

  const { data, error } = await query;
  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ checklists: data });
});

/**
 * POST /api/features/daily-checklists
 *
 * daily_checklists holds one row PER ITEM: label, list_type, done, sort_order
 * (supabase/migrations/007_all_features.sql). It has never had an `items`
 * column, so the previous body shape ({ date, items }) could only ever 500.
 * The shape below is the one the DailyChecklist page reads and writes.
 */
router.post('/daily-checklists', requireAuth, async (req, res) => {
  const { date, label, list_type, sort_order } = req.body;

  if (!date) {
    return res.status(400).json({ error: 'Date is required' });
  }
  if (!label || !String(label).trim()) {
    return res.status(400).json({ error: 'Label is required' });
  }

  const listType = ['opening', 'closing', 'custom'].includes(list_type) ? list_type : 'custom';

  const { data, error } = await supabase
    .from('daily_checklists')
    .insert({
      beautician_id: req.beautician.id,
      date,
      label: String(label).trim(),
      list_type: listType,
      sort_order: Number.isInteger(sort_order) ? sort_order : 0,
      done: false
    })
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ checklist: data });
});

/**
 * PATCH /api/features/daily-checklists/:id
 * Toggle done, rename the item, or reorder it.
 */
router.patch('/daily-checklists/:id', requireAuth, async (req, res) => {
  // Same reason as the POST above: there is no `items` column, so a body
  // carrying one made PostgREST reject the whole update.
  const { done, label, sort_order } = req.body;
  const updates = {};

  if (done !== undefined) updates.done = done;
  if (label !== undefined) updates.label = String(label).trim();
  if (sort_order !== undefined && Number.isInteger(sort_order)) updates.sort_order = sort_order;

  const { data, error } = await supabase
    .from('daily_checklists')
    .update(updates)
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ checklist: data });
});

/**
 * DELETE /api/features/daily-checklists/:id
 */
router.delete('/daily-checklists/:id', requireAuth, async (req, res) => {
  const { error } = await supabase
    .from('daily_checklists')
    .delete()
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id);

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ success: true });
});

// CONSULTATIONS

/**
 * GET /api/features/consultations
 */
router.get('/consultations', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('consultations')
    .select('*, clients(first_name, last_name, email), treatments(name)')
    .eq('beautician_id', req.beautician.id)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ consultations: data });
});

/**
 * POST /api/features/consultations
 */
router.post('/consultations', requireAuth, async (req, res) => {
  const { client_id, treatment_id, notes, status } = req.body;

  if (!client_id || !treatment_id) {
    return res.status(400).json({ error: 'client_id and treatment_id are required' });
  }

  // The backend uses the service key, so RLS is bypassed and this check is
  // the only thing stopping a foreign id from being accepted. 404, not 403.
  if (!await requireOwned(req, res, [
    { table: 'clients', id: client_id },
    { table: 'treatments', id: treatment_id },
  ])) return;

  const { data, error } = await supabase
    .from('consultations')
    .insert({
      beautician_id: req.beautician.id,
      client_id,
      treatment_id,
      notes: notes || null,
      status: status || 'pending'
    })
    .select('*, clients(first_name, last_name, email), treatments(name)')
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ consultation: data });
});

/**
 * PATCH /api/features/consultations/:id
 */
router.patch('/consultations/:id', requireAuth, async (req, res) => {
  const { notes, status } = req.body;
  const updates = {};

  if (notes !== undefined) updates.notes = notes;
  if (status !== undefined) updates.status = status;

  const { data, error } = await supabase
    .from('consultations')
    .update(updates)
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .select('*, clients(first_name, last_name, email), treatments(name)')
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ consultation: data });
});

/**
 * DELETE /api/features/consultations/:id
 */
router.delete('/consultations/:id', requireAuth, async (req, res) => {
  const { error } = await supabase
    .from('consultations')
    .delete()
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id);

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ success: true });
});

// PATCH TESTS

/**
 * GET /api/features/patch-tests
 */
router.get('/patch-tests', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('patch_tests')
    .select('*, clients(first_name, last_name, email), treatments(name)')
    .eq('beautician_id', req.beautician.id)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ patchTests: data });
});

/**
 * POST /api/features/patch-tests
 */
router.post('/patch-tests', requireAuth, async (req, res) => {
  const { client_id, treatment_id, test_date, result } = req.body;

  if (!client_id || !treatment_id || !test_date) {
    return res.status(400).json({ error: 'client_id, treatment_id, and test_date are required' });
  }

  // The backend uses the service key, so RLS is bypassed and this check is
  // the only thing stopping a foreign id from being accepted. 404, not 403.
  if (!await requireOwned(req, res, [
    { table: 'clients', id: client_id },
    { table: 'treatments', id: treatment_id },
  ])) return;

  const { data, error } = await supabase
    .from('patch_tests')
    .insert({
      beautician_id: req.beautician.id,
      client_id,
      treatment_id,
      test_date,
      result: result || 'pending'
    })
    .select('*, clients(first_name, last_name, email), treatments(name)')
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ patchTest: data });
});

/**
 * PATCH /api/features/patch-tests/:id
 */
router.patch('/patch-tests/:id', requireAuth, async (req, res) => {
  const { result } = req.body;
  const updates = {};

  if (result !== undefined) updates.result = result;

  const { data, error } = await supabase
    .from('patch_tests')
    .update(updates)
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .select('*, clients(first_name, last_name, email), treatments(name)')
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ patchTest: data });
});

/**
 * DELETE /api/features/patch-tests/:id
 */
router.delete('/patch-tests/:id', requireAuth, async (req, res) => {
  const { error } = await supabase
    .from('patch_tests')
    .delete()
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id);

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ success: true });
});

// AFTERCARE MESSAGES

/**
 * aftercare_messages is `name` + `message` + `send_after_hours`
 * (supabase/migrations/007_all_features.sql). The API's field names were
 * `message_text` and `timing_days`, and neither has ever been a column, so
 * PostgREST rejected the whole insert and no aftercare message could be
 * created. Both spellings are still accepted on the way in and both are
 * echoed on the way out, and DAYS are converted to HOURS rather than dropped:
 * the name change is also a unit change.
 */
const aftercareOut = (row) => (row ? {
  ...row,
  message_text: row.message,
  timing_days: row.send_after_hours == null ? null : row.send_after_hours / 24,
} : row);

/**
 * GET /api/features/aftercare-messages
 */
router.get('/aftercare-messages', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('aftercare_messages')
    .select('*')
    .eq('beautician_id', req.beautician.id)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ aftercareMessages: (data || []).map(aftercareOut) });
});

/**
 * POST /api/features/aftercare-messages
 */
router.post('/aftercare-messages', requireAuth, async (req, res) => {
  const {
    treatment_id, name, message, message_text,
    timing_days, send_after_hours, channel, is_active,
  } = req.body;

  const text = message ?? message_text;
  if (!treatment_id || !text) {
    return res.status(400).json({ error: 'treatment_id and message are required' });
  }

  let hours = 24;
  if (send_after_hours !== undefined && send_after_hours !== null) hours = Number(send_after_hours);
  else if (timing_days !== undefined && timing_days !== null) hours = Number(timing_days) * 24;
  if (!Number.isFinite(hours) || hours < 0) {
    return res.status(400).json({ error: 'send_after_hours / timing_days must be a non-negative number' });
  }

  // The backend uses the service key, so RLS is bypassed and this check is
  // the only thing stopping a foreign id from being accepted. 404, not 403.
  if (!await requireOwned(req, res, [
    { table: 'treatments', id: treatment_id },
  ])) return;

  // aftercare_messages.name is NOT NULL with no default, so the handler has to
  // supply one. The treatment this card belongs to is the only label we
  // already have, and it is what the list needs to read as.
  let label = typeof name === 'string' && name.trim() ? name.trim() : '';
  if (!label) {
    const { data: treatment } = await supabase
      .from('treatments')
      .select('name')
      .eq('id', treatment_id)
      .eq('beautician_id', req.beautician.id)
      .maybeSingle();
    label = treatment?.name ? `${treatment.name} aftercare` : 'Aftercare message';
  }

  const row = {
    beautician_id: req.beautician.id,
    treatment_id,
    name: label,
    message: text,
    send_after_hours: Math.round(hours),
  };
  if (channel !== undefined) row.channel = channel;
  if (is_active !== undefined) row.is_active = is_active;

  const { data, error } = await supabase
    .from('aftercare_messages')
    .insert(row)
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ aftercareMessage: aftercareOut(data) });
});

/**
 * PATCH /api/features/aftercare-messages/:id
 */
router.patch('/aftercare-messages/:id', requireAuth, async (req, res) => {
  const { name, message, message_text, timing_days, send_after_hours, channel, is_active } = req.body;
  const updates = {};

  if (message !== undefined) updates.message = message;
  else if (message_text !== undefined) updates.message = message_text;

  if (send_after_hours !== undefined) updates.send_after_hours = Math.round(Number(send_after_hours));
  else if (timing_days !== undefined) updates.send_after_hours = Math.round(Number(timing_days) * 24);
  if (updates.send_after_hours !== undefined
      && (!Number.isFinite(updates.send_after_hours) || updates.send_after_hours < 0)) {
    return res.status(400).json({ error: 'send_after_hours / timing_days must be a non-negative number' });
  }

  if (name !== undefined) updates.name = name;
  if (channel !== undefined) updates.channel = channel;
  if (is_active !== undefined) updates.is_active = is_active;

  const { data, error } = await supabase
    .from('aftercare_messages')
    .update(updates)
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ aftercareMessage: aftercareOut(data) });
});

/**
 * DELETE /api/features/aftercare-messages/:id
 */
router.delete('/aftercare-messages/:id', requireAuth, async (req, res) => {
  const { error } = await supabase
    .from('aftercare_messages')
    .delete()
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id);

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ success: true });
});

// PACKAGES

/**
 * packages is `price_cents` + `treatment_ids`
 * (supabase/migrations/007_all_features.sql). `price` and `treatments` are not
 * columns, so every create and every edit was rejected whole. Both spellings
 * are accepted in and echoed out so an existing caller keeps working.
 */
const packageOut = (row) => (row ? {
  ...row,
  price: row.price_cents,
  treatments: row.treatment_ids,
} : row);

/**
 * GET /api/features/packages
 */
router.get('/packages', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('packages')
    .select('*')
    .eq('beautician_id', req.beautician.id)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ packages: (data || []).map(packageOut) });
});

/**
 * POST /api/features/packages
 */
router.post('/packages', requireAuth, async (req, res) => {
  const {
    name, description, price, price_cents, treatments, treatment_ids,
    sessions_total, saving_cents, validity_days, is_active,
  } = req.body;

  const cents = price_cents ?? price;
  if (!name || !cents) {
    return res.status(400).json({ error: 'name and price are required' });
  }
  if (!Number.isFinite(Number(cents))) {
    return res.status(400).json({ error: 'price must be a number of pence' });
  }

  const row = {
    beautician_id: req.beautician.id,
    name,
    description: description || null,
    price_cents: Math.round(Number(cents)),
    treatment_ids: treatment_ids ?? treatments ?? [],
  };
  if (sessions_total !== undefined) row.sessions_total = sessions_total;
  if (saving_cents !== undefined) row.saving_cents = saving_cents;
  if (validity_days !== undefined) row.validity_days = validity_days;
  if (is_active !== undefined) row.is_active = is_active;

  const { data, error } = await supabase
    .from('packages')
    .insert(row)
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ package: packageOut(data) });
});

/**
 * PATCH /api/features/packages/:id
 */
router.patch('/packages/:id', requireAuth, async (req, res) => {
  const {
    name, description, price, price_cents, treatments, treatment_ids,
    sessions_total, saving_cents, validity_days, is_active,
  } = req.body;
  const updates = {};

  if (name !== undefined) updates.name = name;
  if (description !== undefined) updates.description = description;
  if (price_cents !== undefined) updates.price_cents = Math.round(Number(price_cents));
  else if (price !== undefined) updates.price_cents = Math.round(Number(price));
  if (updates.price_cents !== undefined && !Number.isFinite(updates.price_cents)) {
    return res.status(400).json({ error: 'price must be a number of pence' });
  }
  if (treatment_ids !== undefined) updates.treatment_ids = treatment_ids;
  else if (treatments !== undefined) updates.treatment_ids = treatments;
  if (sessions_total !== undefined) updates.sessions_total = sessions_total;
  if (saving_cents !== undefined) updates.saving_cents = saving_cents;
  if (validity_days !== undefined) updates.validity_days = validity_days;
  if (is_active !== undefined) updates.is_active = is_active;

  const { data, error } = await supabase
    .from('packages')
    .update(updates)
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ package: packageOut(data) });
});

/**
 * DELETE /api/features/packages/:id
 */
router.delete('/packages/:id', requireAuth, async (req, res) => {
  const { error } = await supabase
    .from('packages')
    .delete()
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id);

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ success: true });
});

// CLIENT PACKAGES

/**
 * GET /api/features/client-packages
 */
router.get('/client-packages', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('client_packages')
    .select('*, clients(first_name, last_name, email), packages(name, price_cents)')
    .eq('beautician_id', req.beautician.id)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ clientPackages: data });
});

/**
 * POST /api/features/client-packages
 */
router.post('/client-packages', requireAuth, async (req, res) => {
  const { client_id, package_id, purchased_at } = req.body;

  if (!client_id || !package_id) {
    return res.status(400).json({ error: 'client_id and package_id are required' });
  }

  // The backend uses the service key, so RLS is bypassed and this check is
  // the only thing stopping a foreign id from being accepted. 404, not 403.
  if (!await requireOwned(req, res, [
    { table: 'clients', id: client_id },
    { table: 'packages', id: package_id },
  ])) return;

  const { data, error } = await supabase
    .from('client_packages')
    .insert({
      beautician_id: req.beautician.id,
      client_id,
      package_id,
      purchased_at: purchased_at || new Date().toISOString()
    })
    .select('*, clients(first_name, last_name, email), packages(name, price_cents)')
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ clientPackage: data });
});

/**
 * PATCH /api/features/client-packages/:id
 */
router.patch('/client-packages/:id', requireAuth, async (req, res) => {
  const { status, sessions_used } = req.body;
  const updates = {};

  if (status !== undefined) updates.status = status;
  if (sessions_used !== undefined) updates.sessions_used = sessions_used;

  const { data, error } = await supabase
    .from('client_packages')
    .update(updates)
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .select('*, clients(first_name, last_name, email), packages(name, price_cents)')
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ clientPackage: data });
});

// ADD-ONS

/**
 * GET /api/features/add-ons
 */
router.get('/add-ons', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('add_ons')
    .select('*')
    .eq('beautician_id', req.beautician.id)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ addOns: data });
});

/**
 * POST /api/features/add-ons
 */
router.post('/add-ons', requireAuth, async (req, res) => {
  const { name, description, price, price_cents, category, duration_minutes, suggest_with, auto_suggest, is_active } = req.body;

  const cents = price_cents ?? price;
  if (!name || !cents) {
    return res.status(400).json({ error: 'name and price are required' });
  }

  const { data, error } = await supabase
    .from('add_ons')
    .insert({
      beautician_id: req.beautician.id,
      name,
      // `price` is not a column: 007_all_features.sql creates add_ons with
      // price_cents only. Sending both meant PostgREST rejected the whole row,
      // so no add-on could ever be created. The API still ACCEPTS `price` in
      // the body (see `cents` above); it just no longer writes a column that
      // does not exist.
      description: description || null,
      price_cents: cents,
      category: category || 'treatment',
      duration_minutes: duration_minutes || 0,
      suggest_with: suggest_with || [],
      auto_suggest: auto_suggest !== false,
      is_active: is_active !== false,
    })
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ addOn: data });
});

/**
 * PATCH /api/features/add-ons/:id
 */
router.patch('/add-ons/:id', requireAuth, async (req, res) => {
  const { name, description, price, price_cents, category, duration_minutes, suggest_with, auto_suggest, is_active } = req.body;
  const updates = {};

  if (name !== undefined) updates.name = name;
  if (description !== undefined) updates.description = description;
  // price_cents only. See the note on the insert above.
  if (price_cents !== undefined) updates.price_cents = price_cents;
  else if (price !== undefined) updates.price_cents = price;
  if (category !== undefined) updates.category = category;
  if (duration_minutes !== undefined) updates.duration_minutes = duration_minutes;
  if (suggest_with !== undefined) updates.suggest_with = suggest_with;
  if (auto_suggest !== undefined) updates.auto_suggest = auto_suggest;
  if (is_active !== undefined) updates.is_active = is_active;

  const { data, error } = await supabase
    .from('add_ons')
    .update(updates)
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ addOn: data });
});

/**
 * DELETE /api/features/add-ons/:id
 */
router.delete('/add-ons/:id', requireAuth, async (req, res) => {
  const { error } = await supabase
    .from('add_ons')
    .delete()
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id);

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ success: true });
});

// GIFT VOUCHERS

/**
 * GET /api/features/gift-vouchers
 */
router.get('/gift-vouchers', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('gift_vouchers')
    .select('*')
    .eq('beautician_id', req.beautician.id)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ giftVouchers: data });
});

/**
 * POST /api/features/gift-vouchers
 */
router.post('/gift-vouchers', requireAuth, async (req, res) => {
  const { code, amount, recipient_name, recipient_email } = req.body;

  if (!code || !amount) {
    return res.status(400).json({ error: 'code and amount are required' });
  }

  const { data, error } = await supabase
    .from('gift_vouchers')
    .insert({
      beautician_id: req.beautician.id,
      code,
      amount,
      status: 'active',
      recipient_name: recipient_name || null,
      recipient_email: recipient_email || null
    })
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ giftVoucher: data });
});

/**
 * PATCH /api/features/gift-vouchers/:id
 * Handle redeem and cancel operations
 */
router.patch('/gift-vouchers/:id', requireAuth, async (req, res) => {
  const { action, used_by_client_id, appointment_id } = req.body;

  // Redeeming a voucher against somebody else's client or booking. The service
  // key bypasses RLS, so this is the tenant check. Both ids are optional, so
  // requireOwned skips whichever was not sent. 404, not 403.
  if (!await requireOwned(req, res, [
    { table: 'clients', id: used_by_client_id },
    { table: 'appointments', id: appointment_id },
  ])) return;

  const updates = {};

  if (action === 'redeem') {
    updates.status = 'redeemed';
    updates.redeemed_at = new Date().toISOString();
    updates.used_by_client_id = used_by_client_id || null;
    updates.appointment_id = appointment_id || null;
  } else if (action === 'cancel') {
    updates.status = 'cancelled';
  }

  const { data, error } = await supabase
    .from('gift_vouchers')
    .update(updates)
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ giftVoucher: data });
});

/**
 * DELETE /api/features/gift-vouchers/:id
 */
router.delete('/gift-vouchers/:id', requireAuth, async (req, res) => {
  const { error } = await supabase
    .from('gift_vouchers')
    .delete()
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id);

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ success: true });
});

// CLIENT MEMBERSHIPS

/**
 * GET /api/features/client-memberships
 */
router.get('/client-memberships', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('client_memberships')
    .select('*')
    .eq('beautician_id', req.beautician.id)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ clientMemberships: data });
});

/**
 * POST /api/features/client-memberships
 *
 * client_memberships holds the PLANS she offers: name, description,
 * price_cents, benefits, is_active. It is not the enrolments table, however
 * much the name suggests otherwise, and both
 * supabase/migrations/007_all_features.sql and the catch-up
 * 20260712_backend013_memberships_catchup.sql say so in as many words.
 *
 * This handler used to insert client_id / membership_id / status / starts_at
 * here. None of the four is a column on this table, so the row was rejected
 * whole and no membership could be created or joined. Those fields describe an
 * ENROLMENT, which is membership_subscriptions, so rather than drop them
 * silently the handler now says where they belong.
 */
router.post('/client-memberships', requireAuth, async (req, res) => {
  const { name, description, price, price_cents, benefits, is_active, client_id, membership_id } = req.body;

  if (client_id !== undefined || membership_id !== undefined) {
    return res.status(400).json({
      error: 'client_memberships holds the plans you offer. To sign a client up to a plan, POST /api/features/membership-subscriptions with client_id and membership_id.',
    });
  }

  const cents = price_cents ?? price;
  if (!name || cents === undefined || cents === null) {
    return res.status(400).json({ error: 'name and price_cents are required' });
  }
  if (!Number.isFinite(Number(cents))) {
    return res.status(400).json({ error: 'price_cents must be a number of pence' });
  }

  const row = {
    beautician_id: req.beautician.id,
    name,
    description: description || null,
    price_cents: Math.round(Number(cents)),
  };
  if (benefits !== undefined) row.benefits = benefits;
  if (is_active !== undefined) row.is_active = is_active;

  const { data, error } = await supabase
    .from('client_memberships')
    .insert(row)
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ clientMembership: data });
});

/**
 * PATCH /api/features/client-memberships/:id
 *
 * Edits a PLAN. See the note on the POST: status and ends_at belong to an
 * enrolment, which lives in membership_subscriptions.
 */
router.patch('/client-memberships/:id', requireAuth, async (req, res) => {
  const { name, description, price, price_cents, benefits, is_active, status, ends_at } = req.body;
  const updates = {};

  if (status !== undefined || ends_at !== undefined) {
    return res.status(400).json({
      error: 'client_memberships holds the plans you offer. To change a client\'s membership, PATCH /api/features/membership-subscriptions/:id.',
    });
  }

  if (name !== undefined) updates.name = name;
  if (description !== undefined) updates.description = description;
  if (price_cents !== undefined) updates.price_cents = Math.round(Number(price_cents));
  else if (price !== undefined) updates.price_cents = Math.round(Number(price));
  if (updates.price_cents !== undefined && !Number.isFinite(updates.price_cents)) {
    return res.status(400).json({ error: 'price_cents must be a number of pence' });
  }
  if (benefits !== undefined) updates.benefits = benefits;
  if (is_active !== undefined) updates.is_active = is_active;

  const { data, error } = await supabase
    .from('client_memberships')
    .update(updates)
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ clientMembership: data });
});

/**
 * DELETE /api/features/client-memberships/:id
 */
router.delete('/client-memberships/:id', requireAuth, async (req, res) => {
  const { error } = await supabase
    .from('client_memberships')
    .delete()
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id);

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ success: true });
});

// MEMBERSHIP SUBSCRIPTIONS

/**
 * membership_subscriptions is `membership_id` + `status` + `next_billing_at`
 * (007_all_features.sql, restated in 20260712_backend013_memberships_catchup).
 * The API called them client_membership_id / subscription_status /
 * next_billing_date, none of which is a column, and never sent client_id at
 * all even though it is NOT NULL. Old spellings are accepted in and echoed out.
 */
const subscriptionOut = (row) => (row ? {
  ...row,
  client_membership_id: row.membership_id,
  subscription_status: row.status,
  next_billing_date: row.next_billing_at,
} : row);

/**
 * GET /api/features/membership-subscriptions
 */
router.get('/membership-subscriptions', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('membership_subscriptions')
    .select('*, clients(first_name, last_name, email), client_memberships(name, price_cents)')
    .eq('beautician_id', req.beautician.id)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ membershipSubscriptions: (data || []).map(subscriptionOut) });
});

/**
 * POST /api/features/membership-subscriptions
 */
router.post('/membership-subscriptions', requireAuth, async (req, res) => {
  const {
    client_id, membership_id, client_membership_id,
    status, subscription_status, next_billing_at, next_billing_date, started_at,
  } = req.body;

  const plan = membership_id ?? client_membership_id;
  if (!client_id || !plan) {
    return res.status(400).json({ error: 'client_id and membership_id are required' });
  }

  // The backend uses the service key, so RLS is bypassed and this check is
  // the only thing stopping a foreign id from being accepted. 404, not 403.
  if (!await requireOwned(req, res, [
    { table: 'clients', id: client_id },
    { table: 'client_memberships', id: plan },
  ])) return;

  const { data, error } = await supabase
    .from('membership_subscriptions')
    .insert({
      beautician_id: req.beautician.id,
      client_id,
      membership_id: plan,
      status: status ?? subscription_status ?? 'active',
      started_at: started_at || new Date().toISOString(),
      next_billing_at: next_billing_at ?? next_billing_date ?? null,
    })
    .select('*, clients(first_name, last_name, email), client_memberships(name, price_cents)')
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ membershipSubscription: subscriptionOut(data) });
});

/**
 * PATCH /api/features/membership-subscriptions/:id
 */
router.patch('/membership-subscriptions/:id', requireAuth, async (req, res) => {
  const {
    status, subscription_status, next_billing_at, next_billing_date, cancelled_at,
  } = req.body;
  const updates = {};

  if (status !== undefined) updates.status = status;
  else if (subscription_status !== undefined) updates.status = subscription_status;
  if (next_billing_at !== undefined) updates.next_billing_at = next_billing_at;
  else if (next_billing_date !== undefined) updates.next_billing_at = next_billing_date;
  if (cancelled_at !== undefined) updates.cancelled_at = cancelled_at;

  const { data, error } = await supabase
    .from('membership_subscriptions')
    .update(updates)
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .select('*, clients(first_name, last_name, email), client_memberships(name, price_cents)')
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ membershipSubscription: subscriptionOut(data) });
});

// LOYALTY CONFIG

/**
 * GET /api/features/loyalty-config
 * Get single loyalty config row for beautician
 */
/**
 * loyalty_config is points_per_pound / reward_threshold / reward_type /
 * reward_value_cents / reward_name / is_active (007_all_features.sql plus
 * 058_loyalty_reward.sql). `min_points_redeem` is reward_threshold under
 * another name and is renamed here; `redemption_rate` has no column at all and
 * is refused loudly rather than dropped, because a silently discarded
 * redemption rate is a loyalty scheme that pays out the wrong amount.
 */
const loyaltyConfigOut = (row) => (row ? {
  ...row,
  min_points_redeem: row.reward_threshold,
} : row);

router.get('/loyalty-config', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('loyalty_config')
    .select('*')
    .eq('beautician_id', req.beautician.id)
    .single();

  if (error && error.code !== 'PGRST116') {
    logger.error({ err: error }, 'Failed to fetch loyalty config');
    return res.status(500).json({ error: 'Something went wrong' });
  }

  res.json({ loyaltyConfig: loyaltyConfigOut(data) || null });
});

/**
 * POST /PUT /api/features/loyalty-config
 * Upsert loyalty config
 */
router.post('/loyalty-config', requireAuth, async (req, res) => {
  const {
    points_per_pound, redemption_rate, min_points_redeem, reward_threshold,
    reward_type, reward_value_cents, reward_name, is_active,
  } = req.body;

  if (redemption_rate !== undefined) {
    return res.status(400).json({
      error: 'redemption_rate is not stored yet. loyalty_config has reward_threshold (points needed) and reward_value_cents (what the reward is worth); a points-to-pounds rate needs a new column before it can be saved.',
    });
  }

  const threshold = reward_threshold ?? min_points_redeem;

  const row = {
    beautician_id: req.beautician.id,
    points_per_pound: points_per_pound || 1,
    reward_threshold: threshold ?? 100,
  };
  if (reward_type !== undefined) row.reward_type = reward_type;
  if (reward_value_cents !== undefined) row.reward_value_cents = reward_value_cents;
  if (reward_name !== undefined) row.reward_name = reward_name;
  if (is_active !== undefined) row.is_active = is_active;

  const { data, error } = await supabase
    .from('loyalty_config')
    .upsert(row, { onConflict: 'beautician_id' })
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ loyaltyConfig: loyaltyConfigOut(data) });
});

// LOYALTY POINTS

/**
 * GET /api/features/loyalty-points
 * Get points by client_id (required ?client_id=...)
 */
router.get('/loyalty-points', requireAuth, async (req, res) => {
  if (!req.query.client_id) {
    return res.status(400).json({ error: 'client_id is required' });
  }

  const { data, error } = await supabase
    .from('loyalty_points')
    .select('*')
    .eq('beautician_id', req.beautician.id)
    .eq('client_id', req.query.client_id)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ loyaltyPoints: data });
});

/**
 * POST /api/features/loyalty-points
 */
router.post('/loyalty-points', requireAuth, async (req, res) => {
  const { client_id, points, reason } = req.body;

  if (!client_id || points === undefined) {
    return res.status(400).json({ error: 'client_id and points are required' });
  }
  if (!Number.isFinite(Number(points))) {
    return res.status(400).json({ error: 'points must be a number' });
  }

  // The backend uses the service key, so RLS is bypassed and this check is
  // the only thing stopping a foreign id from being accepted. 404, not 403.
  if (!await requireOwned(req, res, [
    { table: 'clients', id: client_id },
  ])) return;

  // loyalty_points has no transaction_date. The column that records when a
  // movement happened is created_at, and it defaults to now(), so the write
  // simply stops naming a column that does not exist.
  //
  // balance_after is NOT NULL and is what every reader treats as the running
  // total (services/loyalty.js, frontend Loyalty.jsx). Leaving it at its zero
  // default would have made a manual award read as "balance nil" ever after,
  // so it is computed from the ledger the same way the accrual service does.
  const { data: ledger, error: ledgerError } = await supabase
    .from('loyalty_points')
    .select('points')
    .eq('beautician_id', req.beautician.id)
    .eq('client_id', client_id);

  if (ledgerError) {
    logger.error({ err: ledgerError }, 'Loyalty: could not read the current balance');
    return res.status(500).json({ error: 'Something went wrong' });
  }

  const delta = Math.round(Number(points));
  const balance = (ledger || []).reduce((sum, row) => sum + (row.points || 0), 0);

  const { data, error } = await supabase
    .from('loyalty_points')
    .insert({
      beautician_id: req.beautician.id,
      client_id,
      points: delta,
      reason: reason || 'manual',
      balance_after: balance + delta,
    })
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ loyaltyPoints: data });
});

// REFERRALS

/**
 * referrals is referrer_id / referred_id / referrer_reward_cents /
 * referred_reward_cents (supabase/migrations/007_all_features.sql, which
 * creates the table; 023_referrals.sql is a second CREATE TABLE IF NOT EXISTS
 * for the same name and is therefore a no-op, see the note in the report).
 *
 * The API called them referrer_client_id / referred_client_id and had a single
 * `reward` field with no column behind it at all. The id spellings are
 * accepted in and echoed out. `reward` is taken as the REFERRER's reward in
 * pence, which is the one a referral list means by "reward", and anything that
 * is not a number is refused rather than dropped.
 */
const referralOut = (row) => (row ? {
  ...row,
  referrer_client_id: row.referrer_id,
  referred_client_id: row.referred_id,
  reward: row.referrer_reward_cents,
} : row);

/**
 * GET /api/features/referrals
 */
router.get('/referrals', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('referrals')
    .select('*')
    .eq('beautician_id', req.beautician.id)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ referrals: (data || []).map(referralOut) });
});

/**
 * POST /api/features/referrals
 */
const REFERRAL_STATUSES = ['pending', 'booked', 'completed', 'rewarded'];

/** `reward` in pence, or an error string naming what is wrong with it. */
function referrerRewardCents(reward) {
  if (reward === undefined || reward === null) return { cents: undefined };
  const cents = Number(reward);
  if (!Number.isFinite(cents) || cents < 0) {
    return { error: 'reward must be the referrer reward in pence. There is no free-text reward column; use referrer_reward_cents and referred_reward_cents.' };
  }
  return { cents: Math.round(cents) };
}

router.post('/referrals', requireAuth, async (req, res) => {
  const {
    referrer_client_id, referrer_id, referred_client_id, referred_id,
    referred_name, referred_email, referred_phone,
    status, reward, referrer_reward_cents, referred_reward_cents,
  } = req.body;

  const referrer = referrer_id ?? referrer_client_id;
  const referred = referred_id ?? referred_client_id;

  if (!referrer || !referred) {
    return res.status(400).json({ error: 'referrer_client_id and referred_client_id are required' });
  }
  if (status !== undefined && !REFERRAL_STATUSES.includes(status)) {
    return res.status(400).json({ error: `status must be one of: ${REFERRAL_STATUSES.join(', ')}` });
  }

  const legacyReward = referrerRewardCents(reward);
  if (legacyReward.error) return res.status(400).json({ error: legacyReward.error });

  // The backend uses the service key, so RLS is bypassed and this check is
  // the only thing stopping a foreign id from being accepted. 404, not 403.
  if (!await requireOwned(req, res, [
    { table: 'clients', id: referrer },
    { table: 'clients', id: referred },
  ])) return;

  const row = {
    beautician_id: req.beautician.id,
    referrer_id: referrer,
    referred_id: referred,
    status: status || 'pending',
  };
  if (referred_name !== undefined) row.referred_name = referred_name;
  if (referred_email !== undefined) row.referred_email = referred_email;
  if (referred_phone !== undefined) row.referred_phone = referred_phone;
  if (referrer_reward_cents !== undefined) row.referrer_reward_cents = referrer_reward_cents;
  else if (legacyReward.cents !== undefined) row.referrer_reward_cents = legacyReward.cents;
  if (referred_reward_cents !== undefined) row.referred_reward_cents = referred_reward_cents;

  const { data, error } = await supabase
    .from('referrals')
    .insert(row)
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ referral: referralOut(data) });
});

/**
 * PATCH /api/features/referrals/:id
 */
router.patch('/referrals/:id', requireAuth, async (req, res) => {
  const { status, reward, referrer_reward_cents, referred_reward_cents, completed_at } = req.body;
  const updates = {};

  if (status !== undefined) {
    if (!REFERRAL_STATUSES.includes(status)) {
      return res.status(400).json({ error: `status must be one of: ${REFERRAL_STATUSES.join(', ')}` });
    }
    updates.status = status;
  }

  const legacyReward = referrerRewardCents(reward);
  if (legacyReward.error) return res.status(400).json({ error: legacyReward.error });

  if (referrer_reward_cents !== undefined) updates.referrer_reward_cents = referrer_reward_cents;
  else if (legacyReward.cents !== undefined) updates.referrer_reward_cents = legacyReward.cents;
  if (referred_reward_cents !== undefined) updates.referred_reward_cents = referred_reward_cents;
  if (completed_at !== undefined) updates.completed_at = completed_at;

  const { data, error } = await supabase
    .from('referrals')
    .update(updates)
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ referral: referralOut(data) });
});

// REVENUE GOALS
//
// REMOVED 2026-08-03. Four handlers, none of which could ever have worked and
// none of which anything called.
//
// The real revenue_goals table (supabase/migrations/007_all_features.sql) is
// period / target_cents / start_date / end_date, and all four of those are NOT
// NULL. These routes read and wrote target_month and target_amount, which do
// not exist in production: the GET ordered by target_month so it always 500'd,
// the POST supplied none of the NOT NULL columns so it could never have
// inserted a row even with the names fixed, and the PATCH set target_amount.
// Nothing in frontend/src, ios-widget or landing ever called any of them.
//
// Adding target_month and target_amount would have been adding columns to prop
// up an endpoint with no caller and no UI. Rewriting them onto period /
// target_cents / start_date / end_date would have meant inventing an API
// contract for a feature that does not exist yet. So: deleted. If revenue goals
// are ever built, build them against the columns that are really there.

// MESSAGE TEMPLATES

/**
 * GET /api/features/message-templates
 */
router.get('/message-templates', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('message_templates')
    .select('*')
    .eq('beautician_id', req.beautician.id)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ messageTemplates: data });
});

/**
 * POST /api/features/message-templates
 */
router.post('/message-templates', requireAuth, async (req, res) => {
  const { name, template_text, category } = req.body;

  if (!name || !template_text) {
    return res.status(400).json({ error: 'name and template_text are required' });
  }

  const { data, error } = await supabase
    .from('message_templates')
    .insert({
      beautician_id: req.beautician.id,
      name,
      template_text,
      category: category || 'general'
    })
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ messageTemplate: data });
});

/**
 * PATCH /api/features/message-templates/:id
 */
router.patch('/message-templates/:id', requireAuth, async (req, res) => {
  const { name, template_text, category } = req.body;
  const updates = {};

  if (name !== undefined) updates.name = name;
  if (template_text !== undefined) updates.template_text = template_text;
  if (category !== undefined) updates.category = category;

  const { data, error } = await supabase
    .from('message_templates')
    .update(updates)
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ messageTemplate: data });
});

/**
 * DELETE /api/features/message-templates/:id
 */
router.delete('/message-templates/:id', requireAuth, async (req, res) => {
  const { error } = await supabase
    .from('message_templates')
    .delete()
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id);

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ success: true });
});

// AUTOMATION RULES

/**
 * GET /api/features/automation-rules
 */
router.get('/automation-rules', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('automation_rules')
    .select('*')
    .eq('beautician_id', req.beautician.id)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ automationRules: data });
});

/**
 * POST /api/features/automation-rules
 */
router.post('/automation-rules', requireAuth, async (req, res) => {
  const { name, trigger_type, action_type, config, trigger_config, action_config, enabled } = req.body;

  if (!name || !trigger_type || !action_type) {
    return res.status(400).json({ error: 'name, trigger_type, and action_type are required' });
  }

  // The real columns are is_active, trigger_config and action_config
  // (supabase/migrations/007_all_features.sql). `enabled` and a single merged
  // `config` have never existed, so this insert was rejected whole and no rule
  // could ever be created through the API. `config` is still accepted as a
  // legacy body field and lands in action_config, because every action handler
  // in services/automations.js reads its settings from there.
  const { data, error } = await supabase
    .from('automation_rules')
    .insert({
      beautician_id: req.beautician.id,
      name,
      trigger_type,
      action_type,
      trigger_config: trigger_config || {},
      action_config: action_config || config || {},
      is_active: enabled !== undefined ? enabled : true
    })
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ automationRule: data });
});

/**
 * PATCH /api/features/automation-rules/:id
 */
router.patch('/automation-rules/:id', requireAuth, async (req, res) => {
  const { name, trigger_type, action_type, config, trigger_config, action_config, enabled } = req.body;
  const updates = {};

  if (name !== undefined) updates.name = name;
  if (trigger_type !== undefined) updates.trigger_type = trigger_type;
  if (action_type !== undefined) updates.action_type = action_type;
  // Same rename as the POST above: is_active / trigger_config / action_config
  // are the columns that exist.
  if (trigger_config !== undefined) updates.trigger_config = trigger_config;
  if (action_config !== undefined) updates.action_config = action_config;
  else if (config !== undefined) updates.action_config = config;
  if (enabled !== undefined) updates.is_active = enabled;

  const { data, error } = await supabase
    .from('automation_rules')
    .update(updates)
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ automationRule: data });
});

/**
 * DELETE /api/features/automation-rules/:id
 */
router.delete('/automation-rules/:id', requireAuth, async (req, res) => {
  const { error } = await supabase
    .from('automation_rules')
    .delete()
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id);

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ success: true });
});

// POLICIES

/**
 * policies is `type` + `title` + `content`
 * (supabase/migrations/007_all_features.sql). The API called them category /
 * name / policy_text, so all three names were wrong and every write was
 * rejected whole. Old spellings are accepted in and echoed out.
 *
 * `type` carries a CHECK constraint, so a bad one is a 400 here rather than a
 * 500 from the database. There is no 'general' type, which is what the handler
 * used to default to; 'custom' is the catch-all the constraint actually allows.
 */
const POLICY_TYPES = ['cancellation', 'no_show', 'deposit', 'late', 'health', 'privacy', 'custom'];

const policyOut = (row) => (row ? {
  ...row,
  name: row.title,
  policy_text: row.content,
  category: row.type,
} : row);

/**
 * GET /api/features/policies
 */
router.get('/policies', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('policies')
    .select('*')
    .eq('beautician_id', req.beautician.id)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ policies: (data || []).map(policyOut) });
});

/**
 * POST /api/features/policies
 */
router.post('/policies', requireAuth, async (req, res) => {
  const {
    name, title, policy_text, content, category, type,
    is_active, show_on_booking, require_acceptance,
  } = req.body;

  const heading = title ?? name;
  const body = content ?? policy_text;
  const kind = type ?? category ?? 'custom';

  if (!heading || !body) {
    return res.status(400).json({ error: 'name and policy_text are required' });
  }
  if (!POLICY_TYPES.includes(kind)) {
    return res.status(400).json({ error: `category must be one of: ${POLICY_TYPES.join(', ')}` });
  }

  const row = {
    beautician_id: req.beautician.id,
    type: kind,
    title: heading,
    content: body,
  };
  if (is_active !== undefined) row.is_active = is_active;
  if (show_on_booking !== undefined) row.show_on_booking = show_on_booking;
  if (require_acceptance !== undefined) row.require_acceptance = require_acceptance;

  const { data, error } = await supabase
    .from('policies')
    .insert(row)
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ policy: policyOut(data) });
});

/**
 * PATCH /api/features/policies/:id
 */
router.patch('/policies/:id', requireAuth, async (req, res) => {
  const {
    name, title, policy_text, content, category, type,
    is_active, show_on_booking, require_acceptance,
  } = req.body;
  const updates = {};

  if (title !== undefined) updates.title = title;
  else if (name !== undefined) updates.title = name;
  if (content !== undefined) updates.content = content;
  else if (policy_text !== undefined) updates.content = policy_text;

  const kind = type ?? category;
  if (kind !== undefined) {
    if (!POLICY_TYPES.includes(kind)) {
      return res.status(400).json({ error: `category must be one of: ${POLICY_TYPES.join(', ')}` });
    }
    updates.type = kind;
  }
  if (is_active !== undefined) updates.is_active = is_active;
  if (show_on_booking !== undefined) updates.show_on_booking = show_on_booking;
  if (require_acceptance !== undefined) updates.require_acceptance = require_acceptance;

  const { data, error } = await supabase
    .from('policies')
    .update(updates)
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ policy: policyOut(data) });
});

/**
 * DELETE /api/features/policies/:id
 */
router.delete('/policies/:id', requireAuth, async (req, res) => {
  const { error } = await supabase
    .from('policies')
    .delete()
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id);

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ success: true });
});

// INTAKE FORMS

/**
 * GET /api/features/intake-forms
 */
router.get('/intake-forms', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('intake_forms')
    .select('*')
    .eq('beautician_id', req.beautician.id)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ intakeForms: data });
});

/**
 * POST /api/features/intake-forms
 */
router.post('/intake-forms', requireAuth, async (req, res) => {
  const { name, form_schema } = req.body;

  if (!name || !form_schema) {
    return res.status(400).json({ error: 'name and form_schema are required' });
  }

  const { data, error } = await supabase
    .from('intake_forms')
    .insert({
      beautician_id: req.beautician.id,
      name,
      form_schema
    })
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ intakeForm: data });
});

/**
 * PATCH /api/features/intake-forms/:id
 */
router.patch('/intake-forms/:id', requireAuth, async (req, res) => {
  const { name, form_schema } = req.body;
  const updates = {};

  if (name !== undefined) updates.name = name;
  if (form_schema !== undefined) updates.form_schema = form_schema;

  const { data, error } = await supabase
    .from('intake_forms')
    .update(updates)
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ intakeForm: data });
});

/**
 * DELETE /api/features/intake-forms/:id
 */
router.delete('/intake-forms/:id', requireAuth, async (req, res) => {
  const { error } = await supabase
    .from('intake_forms')
    .delete()
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id);

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ success: true });
});

// FORM SUBMISSIONS

/**
 * GET /api/features/form-submissions
 * Get by form_id or client_id (?form_id=... or ?client_id=...)
 */
router.get('/form-submissions', requireAuth, async (req, res) => {
  let query = supabase
    .from('form_submissions')
    .select('*')
    .eq('beautician_id', req.beautician.id)
    .order('created_at', { ascending: false });

  if (req.query.form_id) {
    query = query.eq('form_id', req.query.form_id);
  }

  if (req.query.client_id) {
    query = query.eq('client_id', req.query.client_id);
  }

  const { data, error } = await query;
  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ formSubmissions: data });
});

/**
 * POST /api/features/form-submissions
 */
router.post('/form-submissions', requireAuth, async (req, res) => {
  const { form_id, client_id, submission_data } = req.body;

  if (!form_id || !client_id || !submission_data) {
    return res.status(400).json({ error: 'form_id, client_id, and submission_data are required' });
  }

  // The backend uses the service key, so RLS is bypassed and this check is
  // the only thing stopping a foreign id from being accepted. 404, not 403.
  if (!await requireOwned(req, res, [
    { table: 'intake_forms', id: form_id },
    { table: 'clients', id: client_id },
  ])) return;

  const { data, error } = await supabase
    .from('form_submissions')
    .insert({
      beautician_id: req.beautician.id,
      form_id,
      client_id,
      submission_data
    })
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ formSubmission: data });
});

// HOURS EXCEPTIONS

/**
 * GET /api/features/hours-exceptions
 * Get by date range (?from=YYYY-MM-DD&to=YYYY-MM-DD)
 */
router.get('/hours-exceptions', requireAuth, async (req, res) => {
  let query = supabase
    .from('hours_exceptions')
    .select('*')
    .eq('beautician_id', req.beautician.id)
    .order('date', { ascending: true });

  if (req.query.from) {
    query = query.gte('date', req.query.from);
  }

  if (req.query.to) {
    query = query.lte('date', req.query.to);
  }

  const { data, error } = await query;
  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ hoursExceptions: data });
});

/**
 * POST /api/features/hours-exceptions
 */
/**
 * hours_exceptions is `type` plus flat columns: end_date, start_time, end_time,
 * reason, note, notify_clients, is_closed, location_id
 * (007_all_features.sql, 008_hours_exceptions_updates.sql, 027_multi_location).
 * There is no `exception_type` and no JSONB `details` bag, so this insert was
 * rejected whole and no closure could be saved from here.
 *
 * `details` is still accepted, and its keys are spread onto the real columns
 * rather than thrown away. A key with no column behind it is a 400 naming it:
 * losing a day she meant to block, quietly, is worse than refusing the write.
 */
const EXCEPTION_TYPES = ['closed', 'amended', 'extended'];
const EXCEPTION_DETAIL_COLUMNS = [
  'end_date', 'start_time', 'end_time', 'reason', 'note',
  'notify_clients', 'is_closed', 'custom_start', 'custom_end', 'location_id',
];

/**
 * TWO DOORS INTO ONE TABLE, AND ONLY ONE OF THEM WAS LOCKED.
 *
 * A closure is a RANGE, date..end_date, and lib/free-slots.js blockEndDate
 * falls back to `date` when end_date does not read as a later day. So a
 * holiday entered end-first, 30 Aug to 24 Aug, is stored happily and closes
 * exactly one day: the 30th. The other six stay bookable on the public page
 * and the first Ellie hears of it is a client turning up while she is away.
 * That is the bug commit ede39ba closed on POST /api/hours-exceptions, and
 * this route writes the same columns to the same table.
 *
 * Exported so there is one answer to "is this range the right way round"
 * rather than two copies to keep in step. routes/hours-exceptions.js still
 * carries its own inline copy of this check and should import this instead;
 * that file is outside this change.
 *
 * @returns {string|null} the refusal to send back, or null if the range is fine
 */
// Re-exported so existing importers keep working. The rule itself lives in
// lib/ because the other door into this table needs the identical answer.
export { exceptionRangeError };

router.post('/hours-exceptions', requireAuth, async (req, res) => {
  const { date, exception_type, type, details, ...rest } = req.body;

  const kind = type ?? exception_type;
  if (!date || !kind) {
    return res.status(400).json({ error: 'date and exception_type are required' });
  }
  if (!EXCEPTION_TYPES.includes(kind)) {
    return res.status(400).json({ error: `exception_type must be one of: ${EXCEPTION_TYPES.join(', ')}` });
  }

  const flat = { ...rest, ...(details && typeof details === 'object' ? details : {}) };
  const unknown = Object.keys(flat).filter(k => !EXCEPTION_DETAIL_COLUMNS.includes(k));
  if (unknown.length) {
    return res.status(400).json({
      error: `hours_exceptions has no column for: ${unknown.join(', ')}. Supported: ${EXCEPTION_DETAIL_COLUMNS.join(', ')}.`,
    });
  }

  // Same check the other door does, from the same function. A range stored
  // back to front closes one day and quietly leaves the rest bookable.
  const rangeError = exceptionRangeError(date, flat.end_date);
  if (rangeError) return res.status(400).json({ error: rangeError });

  const row = {
    beautician_id: req.beautician.id,
    date,
    type: kind,
    is_closed: kind === 'closed',
  };
  for (const key of EXCEPTION_DETAIL_COLUMNS) {
    if (flat[key] !== undefined) row[key] = flat[key];
  }
  // A blank end_date is a single day, not an empty range, and an empty string
  // in a DATE column is a 22007 rejection of the whole insert.
  if (row.end_date !== undefined && !String(row.end_date || '').trim()) delete row.end_date;

  const { data, error } = await supabase
    .from('hours_exceptions')
    .insert(row)
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ hoursException: data });
});

/**
 * DELETE /api/features/hours-exceptions/:id
 */
router.delete('/hours-exceptions/:id', requireAuth, async (req, res) => {
  const { error } = await supabase
    .from('hours_exceptions')
    .delete()
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id);

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ success: true });
});

// CLIENT TAGS

/**
 * GET /api/features/client-tags
 */
router.get('/client-tags', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('client_tags')
    .select('*')
    .eq('beautician_id', req.beautician.id)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ clientTags: data });
});

/**
 * POST /api/features/client-tags
 */
router.post('/client-tags', requireAuth, async (req, res) => {
  const { tag_name, color } = req.body;

  if (!tag_name) {
    return res.status(400).json({ error: 'tag_name is required' });
  }

  const { data, error } = await supabase
    .from('client_tags')
    .insert({
      beautician_id: req.beautician.id,
      tag_name,
      color: color || 'gray'
    })
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ clientTag: data });
});

/**
 * DELETE /api/features/client-tags/:id
 */
router.delete('/client-tags/:id', requireAuth, async (req, res) => {
  const { error } = await supabase
    .from('client_tags')
    .delete()
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id);

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ success: true });
});

// CLIENT TAG ASSIGNMENTS

/**
 * GET /api/features/client-tag-assignments
 * Get by client_id (?client_id=...)
 *
 * client_tag_assignments is client_id + tag_id and nothing else
 * (supabase/migrations/007_all_features.sql). It has no beautician_id, so
 * filtering on one made PostgREST reject the request and this list has always
 * been a 500. The POST was fixed for the same reason; the read was not, which
 * is how a fixed write can still look broken.
 *
 * Tenancy therefore has to come from the ends: either the client asked for
 * (checked), or the beautician's own tags.
 */
router.get('/client-tag-assignments', requireAuth, async (req, res) => {
  let query = supabase
    .from('client_tag_assignments')
    .select('*')
    .order('created_at', { ascending: false });

  if (req.query.client_id) {
    if (!await requireOwned(req, res, [
      { table: 'clients', id: req.query.client_id },
    ])) return;
    query = query.eq('client_id', req.query.client_id);
  } else {
    const { data: tags, error: tagError } = await supabase
      .from('client_tags')
      .select('id')
      .eq('beautician_id', req.beautician.id);

    if (tagError) {
      logger.error({ err: tagError }, 'Database operation failed');
      return res.status(500).json({ error: 'Something went wrong' });
    }
    const tagIds = (tags || []).map(t => t.id);
    if (!tagIds.length) return res.json({ clientTagAssignments: [] });
    query = query.in('tag_id', tagIds);
  }

  const { data, error } = await query;
  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ clientTagAssignments: data });
});

/**
 * POST /api/features/client-tag-assignments
 */
router.post('/client-tag-assignments', requireAuth, async (req, res) => {
  const { client_id, client_tag_id } = req.body;

  if (!client_id || !client_tag_id) {
    return res.status(400).json({ error: 'client_id and client_tag_id are required' });
  }

  // client_tag_assignments has no beautician_id column of its own (see
  // migration 007), so verifying both ends IS the tenant check. The service
  // key bypasses RLS, so nothing else would stop it.
  if (!await requireOwned(req, res, [
    { table: 'clients', id: client_id },
    { table: 'client_tags', id: client_tag_id },
  ])) return;

  const { data, error } = await supabase
    .from('client_tag_assignments')
    .insert({
      // table has client_id + tag_id only; beautician_id/client_tag_id were
      // phantoms and the insert always failed
      client_id,
      tag_id: client_tag_id,
    })
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ clientTagAssignment: data });
});

/**
 * DELETE /api/features/client-tag-assignments/:id
 */
router.delete('/client-tag-assignments/:id', requireAuth, async (req, res) => {
  // Same missing beautician_id as the GET above. The row has to be read first
  // so the tag it points at can be checked, or the delete is either a 500 or,
  // with the filter simply removed, a cross-tenant delete.
  const { data: row, error: readError } = await supabase
    .from('client_tag_assignments')
    .select('id, tag_id')
    .eq('id', req.params.id)
    .maybeSingle();

  if (readError) {
    logger.error({ err: readError }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  if (!row) return res.status(404).json({ error: 'Not found' });

  if (!await requireOwned(req, res, [
    { table: 'client_tags', id: row.tag_id },
  ])) return;

  const { error } = await supabase
    .from('client_tag_assignments')
    .delete()
    .eq('id', req.params.id);

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ success: true });
});

// REVIEWS

/**
 * GET /api/features/reviews
 */
router.get('/reviews', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('reviews')
    .select('*')
    .eq('beautician_id', req.beautician.id)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ reviews: data });
});

/**
 * POST /api/features/reviews
 */
router.post('/reviews', requireAuth, async (req, res) => {
  const { client_id, rating, review_text, platform } = req.body;

  if (!client_id || rating === undefined) {
    return res.status(400).json({ error: 'client_id and rating are required' });
  }

  // The backend uses the service key, so RLS is bypassed and this check is
  // the only thing stopping a foreign id from being accepted. 404, not 403.
  if (!await requireOwned(req, res, [
    { table: 'clients', id: client_id },
  ])) return;

  const { data, error } = await supabase
    .from('reviews')
    .insert({
      beautician_id: req.beautician.id,
      client_id,
      rating,
      // the column is 'comment' and 'website' fails the platform CHECK -
      // this insert never once succeeded
      comment: review_text || null,
      platform: platform || 'manual'
    })
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ review: data });
});

/**
 * PATCH /api/features/reviews/:id
 * Add response to review
 */
router.patch('/reviews/:id', requireAuth, async (req, res) => {
  const { response_text } = req.body;
  const updates = {};

  if (response_text !== undefined) updates.response_text = response_text;

  const { data, error } = await supabase
    .from('reviews')
    .update(updates)
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ review: data });
});

// END OF DAY REPORTS

/**
 * GET /api/features/end-of-day-reports
 * Get by date (?date=YYYY-MM-DD)
 *
 * The column is `date`, not `report_date` (007_all_features.sql, and it is what
 * the live EndOfDay page reads and writes). Ordering by a column that is not
 * there made PostgREST reject the whole query, so this route only ever 500'd.
 */
router.get('/end-of-day-reports', requireAuth, async (req, res) => {
  let query = supabase
    .from('end_of_day_reports')
    .select('*')
    .eq('beautician_id', req.beautician.id)
    .order('date', { ascending: false });

  if (req.query.date) {
    query = query.eq('date', req.query.date);
  }

  const { data, error } = await query;
  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ endOfDayReports: data });
});

// POST /api/features/end-of-day-reports REMOVED 2026-08-03.
//
// It upserted report_date, summary, revenue and appointments_count. Not one of
// those four is a real column: the date column is `date`, and 007 defines
// cash_total_cents / card_total_cents / total_clients / total_appointments /
// tips_cents / notes. The onConflict target named report_date too, so even the
// conflict clause pointed at nothing. It has never written a row.
//
// It is not rewritten here because the live end-of-day feature
// (frontend/src/pages/EndOfDay.jsx) writes a THIRD set of names again
// (total_revenue_cents, appointments_total, appointments_completed,
// appointments_noshow, appointments_cancelled, cash_expected_cents,
// cash_counted_cents, card_taken_cents, closing_notes) which appears in no
// migration in this directory, so production has clearly been extended by hand
// and the true shape cannot be read off the repo. Nothing called this route.
// Rebuilding it needs a look at the live table first, and guessing would have
// put a second, conflicting write path over Ellie's real takings figures.

// PORTAL SETTINGS

/**
 * GET /api/features/portal-settings
 * Get single row for beautician
 */
const portalSettingsOut = (row) => (row ? {
  ...row,
  show_online_booking: row.allow_self_booking,
} : row);

router.get('/portal-settings', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('portal_settings')
    .select('*')
    .eq('beautician_id', req.beautician.id)
    .single();

  if (error && error.code !== 'PGRST116') {
    logger.error({ err: error }, 'Failed to fetch portal settings');
    return res.status(500).json({ error: 'Something went wrong' });
  }

  res.json({ portalSettings: portalSettingsOut(data) || null });
});

/**
 * POST/PUT /api/features/portal-settings
 * Upsert
 */
router.post('/portal-settings', requireAuth, async (req, res) => {
  const {
    show_online_booking, allow_self_booking, allow_rescheduling, allow_cancellation,
    cancellation_window_hours, show_prices, show_reviews, custom_welcome,
    booking_buffer_minutes, max_bookings_per_day, theme,
  } = req.body;

  // portal_settings is allow_self_booking / allow_rescheduling /
  // allow_cancellation / cancellation_window_hours / show_prices /
  // show_reviews / custom_welcome (supabase/migrations/007_all_features.sql).
  // Every one of the four names this handler used to write was wrong, so the
  // upsert was rejected whole and no portal setting has ever saved.
  //
  // show_online_booking is allow_self_booking under another name and is
  // renamed. The other three have no column anywhere in the migrations, so
  // they are refused with their names in the message rather than dropped on
  // the floor. The SQL to add them is in the report; inventing them here would
  // mean writing to columns that do not exist, which is this bug again.
  const missing = [];
  if (booking_buffer_minutes !== undefined) missing.push('booking_buffer_minutes');
  if (max_bookings_per_day !== undefined) missing.push('max_bookings_per_day');
  if (theme !== undefined) missing.push('theme');
  if (missing.length) {
    return res.status(400).json({
      error: `portal_settings has no column for: ${missing.join(', ')}. These need a migration before they can be saved.`,
    });
  }

  const row = { beautician_id: req.beautician.id };
  const selfBooking = allow_self_booking ?? show_online_booking;
  if (selfBooking !== undefined) row.allow_self_booking = selfBooking;
  if (allow_rescheduling !== undefined) row.allow_rescheduling = allow_rescheduling;
  if (allow_cancellation !== undefined) row.allow_cancellation = allow_cancellation;
  if (cancellation_window_hours !== undefined) row.cancellation_window_hours = cancellation_window_hours;
  if (show_prices !== undefined) row.show_prices = show_prices;
  if (show_reviews !== undefined) row.show_reviews = show_reviews;
  if (custom_welcome !== undefined) row.custom_welcome = custom_welcome;

  const { data, error } = await supabase
    .from('portal_settings')
    .upsert(row, { onConflict: 'beautician_id' })
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ portalSettings: portalSettingsOut(data) });
});

// REBOOK REMINDERS

/**
 * GET /api/features/rebook-reminders
 */
router.get('/rebook-reminders', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('rebook_reminders')
    .select('*')
    .eq('beautician_id', req.beautician.id)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ rebookReminders: data });
});

/**
 * POST /api/features/rebook-reminders
 */
router.post('/rebook-reminders', requireAuth, async (req, res) => {
  const { client_id, appointment_id, reminder_date, message } = req.body;

  if (!client_id || !reminder_date) {
    return res.status(400).json({ error: 'client_id and reminder_date are required' });
  }

  // Service key bypasses RLS, so this is the tenant check. appointment_id is
  // optional and requireOwned skips a missing id.
  if (!await requireOwned(req, res, [
    { table: 'clients', id: client_id },
    { table: 'appointments', id: appointment_id },
  ])) return;

  const { data, error } = await supabase
    .from('rebook_reminders')
    .insert({
      beautician_id: req.beautician.id,
      client_id,
      appointment_id: appointment_id || null,
      reminder_date,
      message: message || null,
      sent: false
    })
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ rebookReminder: data });
});

/**
 * PATCH /api/features/rebook-reminders/:id
 */
router.patch('/rebook-reminders/:id', requireAuth, async (req, res) => {
  const { message, sent } = req.body;
  const updates = {};

  if (message !== undefined) updates.message = message;
  if (sent !== undefined) updates.sent = sent;

  const { data, error } = await supabase
    .from('rebook_reminders')
    .update(updates)
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ rebookReminder: data });
});

/**
 * DELETE /api/features/rebook-reminders/:id
 */
router.delete('/rebook-reminders/:id', requireAuth, async (req, res) => {
  const { error } = await supabase
    .from('rebook_reminders')
    .delete()
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id);

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ success: true });
});

// WAITLIST (existing table without backend routes)

// Shared join shape so every response carries the client + treatment a row points at.
const WAITLIST_SELECT =
  '*, clients(id, first_name, last_name, email, phone), treatments(id, name, duration_minutes, price_cents)';

// Whitelist of statuses the canonical waitlist table accepts (see migration 070).
const WAITLIST_STATUSES = ['waiting', 'active', 'notified', 'offered', 'booked', 'expired'];
const WAITLIST_PRIORITIES = ['vip', 'regular', 'flexible'];

/**
 * GET /api/features/waitlist
 * Returns every waitlist row for the signed-in beautician, newest first,
 * with the joined client and treatment so the UI never has to look them up.
 */
router.get('/waitlist', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('waitlist')
    .select(WAITLIST_SELECT)
    .eq('beautician_id', req.beautician.id)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ waitlist: data });
});

/**
 * POST /api/features/waitlist
 * Adds a client to the waitlist. client_id and treatment_id are real foreign
 * keys (both NOT NULL on the table), so the picker must send IDs, not names.
 */
router.post('/waitlist', requireAuth, async (req, res) => {
  const {
    client_id,
    treatment_id,
    priority,
    preferred_days,
    preferred_time,
    notes,
    max_wait_days,
    deposit_held,
    deposit_amount_cents,
  } = req.body;

  if (!client_id || !treatment_id) {
    return res.status(400).json({ error: 'client_id and treatment_id are required' });
  }

  // This one returned the other tenant's client phone in the joined select.
  // The service key bypasses RLS, so this check is the only guard. 404.
  if (!await requireOwned(req, res, [
    { table: 'clients', id: client_id },
    { table: 'treatments', id: treatment_id },
  ])) return;

  const row = {
    beautician_id: req.beautician.id,
    client_id,
    treatment_id,
    status: 'waiting',
    priority: WAITLIST_PRIORITIES.includes(priority) ? priority : 'regular',
    preferred_days: Array.isArray(preferred_days) ? preferred_days : [],
    preferred_time: preferred_time || 'any',
    notes: notes || null,
    max_wait_days: Number.isInteger(max_wait_days) ? max_wait_days : 14,
    deposit_held: deposit_held === true,
    deposit_amount_cents: Number.isInteger(deposit_amount_cents) ? deposit_amount_cents : 0,
    notify_count: 0,
  };

  const { data, error } = await supabase
    .from('waitlist')
    .insert(row)
    .select(WAITLIST_SELECT)
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ waitlistEntry: data });
});

/**
 * PATCH /api/features/waitlist/:id
 * Edits status, priority, preferences or deposit details on a single row.
 */
router.patch('/waitlist/:id', requireAuth, async (req, res) => {
  const b = req.body || {};
  const updates = {};

  if (b.status !== undefined) {
    if (!WAITLIST_STATUSES.includes(b.status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }
    updates.status = b.status;
  }
  if (b.priority !== undefined) {
    if (!WAITLIST_PRIORITIES.includes(b.priority)) {
      return res.status(400).json({ error: 'Invalid priority' });
    }
    updates.priority = b.priority;
  }
  if (Array.isArray(b.preferred_days)) updates.preferred_days = b.preferred_days;
  if (b.preferred_time !== undefined) updates.preferred_time = b.preferred_time;
  if (b.notes !== undefined) updates.notes = b.notes;
  if (Number.isInteger(b.max_wait_days)) updates.max_wait_days = b.max_wait_days;
  if (b.deposit_held !== undefined) updates.deposit_held = b.deposit_held === true;
  if (Number.isInteger(b.deposit_amount_cents)) updates.deposit_amount_cents = b.deposit_amount_cents;
  if (b.offer_expires_at !== undefined) updates.offer_expires_at = b.offer_expires_at;

  const { data, error } = await supabase
    .from('waitlist')
    .update(updates)
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .select(WAITLIST_SELECT)
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ waitlistEntry: data });
});

/**
 * POST /api/features/waitlist/:id/notify
 * Messages the waitlisted client that a slot may be free, on their preferred
 * channel (SMS if we have a number, email otherwise), then records the nudge.
 */
router.post('/waitlist/:id/notify', requireAuth, async (req, res) => {
  const { data: entry, error: loadErr } = await supabase
    .from('waitlist')
    .select(WAITLIST_SELECT)
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .single();

  if (loadErr || !entry) {
    return res.status(404).json({ error: 'Waitlist entry not found' });
  }

  const client = entry.clients || {};
  const treatmentName = entry.treatments?.name || 'your treatment';
  const firstName = client.first_name || 'there';
  const msg = `Hi ${firstName}, a slot for ${treatmentName} may have just opened up. Reply to grab it before it goes.`;

  let delivered = false;
  try {
    const { sendSMS, sendEmail } = await import('../services/notifications.js');
    if (client.phone) {
      await sendSMS({ to: client.phone, body: msg, beauticianId: req.beautician.id, messageType: 'waitlist_alert' });
      delivered = true;
    } else if (client.email) {
      await sendEmail({ to: client.email, subject: 'A slot may have opened up', html: `<p>${msg}</p>`, text: msg });
      delivered = true;
    }
  } catch (err) {
    logger.error({ err }, 'Waitlist notify send failed');
  }

  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from('waitlist')
    .update({
      status: 'notified',
      notify_count: (entry.notify_count || 0) + 1,
      notified_at: nowIso,
      last_notified_at: nowIso,
    })
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .select(WAITLIST_SELECT)
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ waitlistEntry: data, delivered });
});

/**
 * DELETE /api/features/waitlist/:id
 */
router.delete('/waitlist/:id', requireAuth, async (req, res) => {
  const { error } = await supabase
    .from('waitlist')
    .delete()
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id);

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ success: true });
});

// GAP-FILL SUGGESTIONS

/**
 * GET /api/features/gap-fill-suggestions
 * Returns proactive gap-fill suggestions for SmartSchedule page.
 * Read-only — does not send any messages.
 */
router.get('/gap-fill-suggestions', requireAuth, async (req, res) => {
  try {
    const { getGapFillSuggestions } = await import('../services/gap-fill-engine.js');
    const suggestions = await getGapFillSuggestions(req.beautician.id);
    res.json({ suggestions });
  } catch (err) {
    logger.error({ err }, 'Gap-fill suggestions failed');
    res.status(500).json({ error: 'Something went wrong' });
  }
});

// MESSAGES (INBOX)

/**
 * GET /api/features/messages
 */
router.get('/messages', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('messages')
    .select('*, clients(first_name, last_name, email)')
    .eq('beautician_id', req.beautician.id)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ messages: data });
});

/**
 * POST /api/features/messages
 */
router.post('/messages', requireAuth, async (req, res) => {
  const { client_id, message_text, direction } = req.body;

  if (!client_id || !message_text) {
    return res.status(400).json({ error: 'client_id and message_text are required' });
  }

  // The backend uses the service key, so RLS is bypassed and this check is
  // the only thing stopping a foreign id from being accepted. 404, not 403.
  if (!await requireOwned(req, res, [
    { table: 'clients', id: client_id },
  ])) return;

  const { data, error } = await supabase
    .from('messages')
    .insert({
      beautician_id: req.beautician.id,
      client_id,
      // The column is `content`. `message_text` belongs to aftercare_messages,
      // and messages.content is NOT NULL, so every call to this endpoint has
      // failed on a constraint violation since it was written. Found while
      // sweeping every writer to messages for authorship.
      content: message_text,
      channel: 'internal',
      direction: direction || 'outbound',
      ...authorship((direction || 'outbound') === 'inbound' ? 'client' : 'human'),
    })
    .select('*, clients(first_name, last_name, email)')
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ message: data });
});

// CAMPAIGNS

/**
 * campaigns is `type` + `message_template`
 * (supabase/migrations/001_initial_schema.sql). campaign_type and content are
 * not columns, which is why creating a campaign through this route always
 * failed, and it is the same file's own send handler at
 * POST /campaigns/:id/send that proves the real names: it reads
 * campaign.type and campaign.message_template.
 *
 * Both old spellings are accepted in and echoed out. `type` carries a CHECK,
 * so a bad one is a 400 here rather than a 500 out of the database, and
 * message_template is NOT NULL, so an object where text belongs is refused.
 */
const CAMPAIGN_TYPES = ['reactivation', 'rescue', 'weather', 'bank_holiday', 'event', 'custom'];

const campaignOut = (row) => (row ? {
  ...row,
  campaign_type: row.type,
  content: row.message_template,
} : row);

/**
 * GET /api/features/campaigns
 */
router.get('/campaigns', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('campaigns')
    .select('*')
    .eq('beautician_id', req.beautician.id)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ campaigns: (data || []).map(campaignOut) });
});

/**
 * POST /api/features/campaigns
 */
router.post('/campaigns', requireAuth, async (req, res) => {
  const {
    name, campaign_type, type, content, message_template, status,
    trigger_reason, target_client_ids,
  } = req.body;

  const kind = type ?? campaign_type;
  const body = message_template ?? content;

  if (!name || !kind) {
    return res.status(400).json({ error: 'name and campaign_type are required' });
  }
  if (!CAMPAIGN_TYPES.includes(kind)) {
    return res.status(400).json({ error: `campaign_type must be one of: ${CAMPAIGN_TYPES.join(', ')}` });
  }
  if (typeof body !== 'string' || !body.trim()) {
    return res.status(400).json({ error: 'content must be the message text to send' });
  }

  const row = {
    beautician_id: req.beautician.id,
    name,
    type: kind,
    message_template: body,
    status: status || 'draft',
  };
  if (trigger_reason !== undefined) row.trigger_reason = trigger_reason;
  if (target_client_ids !== undefined) {
    row.target_client_ids = target_client_ids;
    row.target_count = Array.isArray(target_client_ids) ? target_client_ids.length : 0;
  }

  const { data, error } = await supabase
    .from('campaigns')
    .insert(row)
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ campaign: campaignOut(data) });
});

/**
 * PATCH /api/features/campaigns/:id
 */
router.patch('/campaigns/:id', requireAuth, async (req, res) => {
  const { name, content, message_template, status, campaign_type, type, target_client_ids } = req.body;
  const updates = {};

  if (name !== undefined) updates.name = name;

  const body = message_template ?? content;
  if (body !== undefined) {
    if (typeof body !== 'string' || !body.trim()) {
      return res.status(400).json({ error: 'content must be the message text to send' });
    }
    updates.message_template = body;
  }

  const kind = type ?? campaign_type;
  if (kind !== undefined) {
    if (!CAMPAIGN_TYPES.includes(kind)) {
      return res.status(400).json({ error: `campaign_type must be one of: ${CAMPAIGN_TYPES.join(', ')}` });
    }
    updates.type = kind;
  }
  if (target_client_ids !== undefined) {
    updates.target_client_ids = target_client_ids;
    updates.target_count = Array.isArray(target_client_ids) ? target_client_ids.length : 0;
  }
  if (status !== undefined) updates.status = status;

  const { data, error } = await supabase
    .from('campaigns')
    .update(updates)
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ campaign: campaignOut(data) });
});

/**
 * POST /api/features/campaigns/:id/send
 *
 * Dispatch an approved campaign. Marketing campaigns are PROACTIVE, so every
 * single recipient goes through the one outbound gate (guardedSend): consent
 * (PECR, fail closed), the known-client hold (regulars are held for the
 * beautician's yes/no), the cross-engine 7-day frequency cap, the monthly-4
 * per-client cap and the transactional allowance reserve. We never send
 * directly. A regular who is held lands in the daily outbox as pending_approval,
 * which is exactly what we want.
 *
 * The response is an honest tally: sent, held (waiting for her yes/no), blocked
 * (consent / cap / allowance / quiet hours), skipped (no reachable channel).
 */
router.post('/campaigns/:id/send', requireAuth, async (req, res) => {
  const beauticianId = req.beautician.id;

  const { data: campaign, error: cErr } = await supabase
    .from('campaigns')
    .select('*')
    .eq('id', req.params.id)
    .eq('beautician_id', beauticianId)
    .maybeSingle();

  if (cErr) {
    logger.error({ err: cErr }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  if (!campaign) return res.status(404).json({ error: 'Campaign not found' });
  if (!['draft', 'approved'].includes(campaign.status)) {
    return res.status(409).json({ error: `Campaign is ${campaign.status}, nothing to send` });
  }

  const { data: bPrefs } = await supabase
    .from('beauticians')
    .select('whatsapp_phone_id, client_reminder_prefs')
    .eq('id', beauticianId)
    .maybeSingle();
  const beauticianPrefs = {
    whatsapp_connected: !!bPrefs?.whatsapp_phone_id,
    ...(bPrefs?.client_reminder_prefs || {}),
  };

  // Resolve the audience. If the campaign pinned specific client ids use those;
  // otherwise derive from the campaign type the same way the page does.
  const audienceCols = 'id, first_name, last_name, phone, email, whatsapp_id, preferred_channel, status, last_visit_at, is_regular, vip, marketing_opted_out_at';
  let clients = [];
  if (Array.isArray(campaign.target_client_ids) && campaign.target_client_ids.length) {
    const { data } = await supabase
      .from('clients')
      .select(audienceCols)
      .eq('beautician_id', beauticianId)
      .in('id', campaign.target_client_ids);
    clients = data || [];
  } else {
    const { data } = await supabase
      .from('clients')
      .select(audienceCols)
      .eq('beautician_id', beauticianId);
    const all = data || [];
    if (campaign.type === 'reactivation') {
      const cutoff = Date.now() - 30 * 86400000;
      clients = all.filter(c =>
        c.status === 'dormant' || c.status === 'lost' ||
        (c.last_visit_at && new Date(c.last_visit_at).getTime() < cutoff)
      );
    } else {
      // Broadcast types (weather, bank_holiday, event, custom) reach the active base.
      clients = all.filter(c => c.status !== 'lost');
    }
  }

  if (!clients.length) {
    return res.status(409).json({ error: 'No recipients match this campaign' });
  }

  // Mark sending so a double-tap cannot fire it twice.
  await supabase.from('campaigns').update({ status: 'sending' })
    .eq('id', campaign.id).eq('beautician_id', beauticianId);

  let sent = 0, held = 0, blocked = 0, skipped = 0;

  for (const client of clients) {
    const firstName = client.first_name || 'there';
    const days = client.last_visit_at
      ? Math.max(0, Math.round((Date.now() - new Date(client.last_visit_at).getTime()) / 86400000))
      : '';
    const message = (campaign.message_template || '')
      .replace(/\{name\}/g, firstName)
      .replace(/\{days\}/g, String(days))
      .replace(/\{day\}/g, 'this week');

    // Pick the client's preferred reachable channel for the audit row. sendNudge
    // itself cascades WhatsApp -> SMS -> email, so this is the recorded intent.
    let channel = client.preferred_channel || 'whatsapp';
    if (channel === 'whatsapp' && !(client.whatsapp_id && beauticianPrefs.whatsapp_connected)) {
      channel = client.phone ? 'sms' : (client.email ? 'email' : 'whatsapp');
    }
    if (channel === 'sms' && !client.phone) channel = client.email ? 'email' : 'sms';

    if (!client.phone && !client.email && !client.whatsapp_id) {
      skipped++;
      continue;
    }

    try {
      let delivery = null;
      const verdict = await guardedSend({
        beauticianId,
        clientId: client.id,
        messageType: 'campaign',
        channel,
        client,
        body: message,
        send: async () => {
          delivery = await sendNudge({ client, body: message, beauticianId, beauticianPrefs });
          return delivery && !delivery.skipped ? delivery : null;
        },
      });

      if (verdict.delivered) sent++;
      else if (verdict.decision === 'approve') held++;
      else if (verdict.decision === 'block') blocked++;
      else skipped++;
    } catch (err) {
      logger.warn({ err, clientId: client.id, campaignId: campaign.id }, 'Campaign recipient failed');
      blocked++;
    }
  }

  const finalStatus = sent > 0 ? 'sent' : 'approved';
  await supabase.from('campaigns').update({
    status: finalStatus,
    sent_at: sent > 0 ? new Date().toISOString() : null,
    delivered_count: sent,
    target_count: clients.length,
  }).eq('id', campaign.id).eq('beautician_id', beauticianId);

  logger.info({ campaignId: campaign.id, sent, held, blocked, skipped }, 'Campaign dispatched');

  res.json({
    campaign_id: campaign.id,
    status: finalStatus,
    audience: clients.length,
    sent,
    held,
    blocked,
    skipped,
  });
});

// CONTENT POSTS

/**
 * GET /api/features/content-posts
 */
router.get('/content-posts', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('content_posts')
    .select('*')
    .eq('beautician_id', req.beautician.id)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ contentPosts: data });
});

/**
 * POST /api/features/content-posts
 */
router.post('/content-posts', requireAuth, async (req, res) => {
  const { title, content, post_type } = req.body;

  if (!title || !content) {
    return res.status(400).json({ error: 'title and content are required' });
  }

  const { data, error } = await supabase
    .from('content_posts')
    .insert({
      beautician_id: req.beautician.id,
      title,
      content,
      post_type: post_type || 'blog'
    })
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ contentPost: data });
});

/**
 * PATCH /api/features/content-posts/:id
 */
router.patch('/content-posts/:id', requireAuth, async (req, res) => {
  const { title, content, post_type } = req.body;
  const updates = {};

  if (title !== undefined) updates.title = title;
  if (content !== undefined) updates.content = content;
  if (post_type !== undefined) updates.post_type = post_type;

  const { data, error } = await supabase
    .from('content_posts')
    .update(updates)
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ contentPost: data });
});

/**
 * DELETE /api/features/content-posts/:id
 */
router.delete('/content-posts/:id', requireAuth, async (req, res) => {
  const { error } = await supabase
    .from('content_posts')
    .delete()
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id);

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ success: true });
});

// TEAM MEMBERS

/**
 * GET /api/features/team-members
 */
router.get('/team-members', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('team_members')
    .select('*')
    .eq('beautician_id', req.beautician.id)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ teamMembers: data });
});

/**
 * POST /api/features/team-members
 */
router.post('/team-members', requireAuth, async (req, res) => {
  const { name, email, role, phone } = req.body;

  if (!name || !email || !role) {
    return res.status(400).json({ error: 'name, email, and role are required' });
  }

  const { data, error } = await supabase
    .from('team_members')
    .insert({
      beautician_id: req.beautician.id,
      name,
      email,
      role,
      phone: phone || null
    })
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ teamMember: data });
});

/**
 * PATCH /api/features/team-members/:id
 */
router.patch('/team-members/:id', requireAuth, async (req, res) => {
  const { name, email, role, phone } = req.body;
  const updates = {};

  if (name !== undefined) updates.name = name;
  if (email !== undefined) updates.email = email;
  if (role !== undefined) updates.role = role;
  if (phone !== undefined) updates.phone = phone;

  const { data, error } = await supabase
    .from('team_members')
    .update(updates)
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ teamMember: data });
});

/**
 * DELETE /api/features/team-members/:id
 */
router.delete('/team-members/:id', requireAuth, async (req, res) => {
  const { error } = await supabase
    .from('team_members')
    .delete()
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id);

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ success: true });
});

// BOOKING SUGGESTIONS (suggest-and-confirm from AI Front Desk / Voice)

/**
 * GET /api/features/booking-suggestions
 * Pending booking suggestions for the beautician's dashboard
 */
router.get('/booking-suggestions', requireAuth, async (req, res) => {
  const status = req.query.status || 'pending';
  const { data, error } = await supabase
    .from('booking_suggestions')
    .select('*, clients(first_name, last_name, phone, email)')
    .eq('beautician_id', req.beautician.id)
    .eq('status', status)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ bookingSuggestions: data });
});

/**
 * PATCH /api/features/booking-suggestions/:id
 * Approve or dismiss a booking suggestion
 * Body: { status: 'approved' | 'dismissed' }
 */
router.patch('/booking-suggestions/:id', requireAuth, async (req, res) => {
  const { status } = req.body;
  if (!['approved', 'dismissed'].includes(status)) {
    return res.status(400).json({ error: 'Status must be approved or dismissed' });
  }

  const { data, error } = await supabase
    .from('booking_suggestions')
    .update({ status, reviewed_at: new Date().toISOString() })
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ bookingSuggestion: data });
});

export default router;
