import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../lib/logger.js';

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
 */
router.post('/daily-checklists', requireAuth, async (req, res) => {
  const { date, items } = req.body;

  if (!date) {
    return res.status(400).json({ error: 'Date is required' });
  }

  const { data, error } = await supabase
    .from('daily_checklists')
    .insert({
      beautician_id: req.beautician.id,
      date,
      items: items || [],
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
 * Toggle done or update items
 */
router.patch('/daily-checklists/:id', requireAuth, async (req, res) => {
  const { done, items } = req.body;
  const updates = {};

  if (done !== undefined) updates.done = done;
  if (items !== undefined) updates.items = items;

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
  res.json({ aftercareMessages: data });
});

/**
 * POST /api/features/aftercare-messages
 */
router.post('/aftercare-messages', requireAuth, async (req, res) => {
  const { treatment_id, message_text, timing_days } = req.body;

  if (!treatment_id || !message_text) {
    return res.status(400).json({ error: 'treatment_id and message_text are required' });
  }

  const { data, error } = await supabase
    .from('aftercare_messages')
    .insert({
      beautician_id: req.beautician.id,
      treatment_id,
      message_text,
      timing_days: timing_days || 0
    })
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ aftercareMessage: data });
});

/**
 * PATCH /api/features/aftercare-messages/:id
 */
router.patch('/aftercare-messages/:id', requireAuth, async (req, res) => {
  const { message_text, timing_days } = req.body;
  const updates = {};

  if (message_text !== undefined) updates.message_text = message_text;
  if (timing_days !== undefined) updates.timing_days = timing_days;

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
  res.json({ aftercareMessage: data });
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
  res.json({ packages: data });
});

/**
 * POST /api/features/packages
 */
router.post('/packages', requireAuth, async (req, res) => {
  const { name, description, price, treatments } = req.body;

  if (!name || !price) {
    return res.status(400).json({ error: 'name and price are required' });
  }

  const { data, error } = await supabase
    .from('packages')
    .insert({
      beautician_id: req.beautician.id,
      name,
      description: description || null,
      price,
      treatments: treatments || []
    })
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ package: data });
});

/**
 * PATCH /api/features/packages/:id
 */
router.patch('/packages/:id', requireAuth, async (req, res) => {
  const { name, description, price, treatments } = req.body;
  const updates = {};

  if (name !== undefined) updates.name = name;
  if (description !== undefined) updates.description = description;
  if (price !== undefined) updates.price = price;
  if (treatments !== undefined) updates.treatments = treatments;

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
  res.json({ package: data });
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
    .select('*, clients(first_name, last_name, email), packages(name, price)')
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

  const { data, error } = await supabase
    .from('client_packages')
    .insert({
      beautician_id: req.beautician.id,
      client_id,
      package_id,
      purchased_at: purchased_at || new Date().toISOString()
    })
    .select('*, clients(first_name, last_name, email), packages(name, price)')
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
    .select('*, clients(first_name, last_name, email), packages(name, price)')
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
      description: description || null,
      price: cents,
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
  if (price_cents !== undefined) { updates.price_cents = price_cents; updates.price = price_cents; }
  else if (price !== undefined) { updates.price = price; updates.price_cents = price; }
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
 */
router.post('/client-memberships', requireAuth, async (req, res) => {
  const { client_id, membership_id, starts_at } = req.body;

  if (!client_id || !membership_id) {
    return res.status(400).json({ error: 'client_id and membership_id are required' });
  }

  const { data, error } = await supabase
    .from('client_memberships')
    .insert({
      beautician_id: req.beautician.id,
      client_id,
      membership_id,
      status: 'active',
      starts_at: starts_at || new Date().toISOString()
    })
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
 */
router.patch('/client-memberships/:id', requireAuth, async (req, res) => {
  const { status, ends_at } = req.body;
  const updates = {};

  if (status !== undefined) updates.status = status;
  if (ends_at !== undefined) updates.ends_at = ends_at;

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
 * GET /api/features/membership-subscriptions
 */
router.get('/membership-subscriptions', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('membership_subscriptions')
    .select('*, clients(first_name, last_name, email), client_memberships(membership_id)')
    .eq('beautician_id', req.beautician.id)
    .order('created_at', { ascending: false });

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ membershipSubscriptions: data });
});

/**
 * POST /api/features/membership-subscriptions
 */
router.post('/membership-subscriptions', requireAuth, async (req, res) => {
  const { client_membership_id, subscription_status, next_billing_date } = req.body;

  if (!client_membership_id) {
    return res.status(400).json({ error: 'client_membership_id is required' });
  }

  const { data, error } = await supabase
    .from('membership_subscriptions')
    .insert({
      beautician_id: req.beautician.id,
      client_membership_id,
      subscription_status: subscription_status || 'active',
      next_billing_date: next_billing_date || null
    })
    .select('*, clients(first_name, last_name, email), client_memberships(membership_id)')
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ membershipSubscription: data });
});

/**
 * PATCH /api/features/membership-subscriptions/:id
 */
router.patch('/membership-subscriptions/:id', requireAuth, async (req, res) => {
  const { subscription_status, next_billing_date } = req.body;
  const updates = {};

  if (subscription_status !== undefined) updates.subscription_status = subscription_status;
  if (next_billing_date !== undefined) updates.next_billing_date = next_billing_date;

  const { data, error } = await supabase
    .from('membership_subscriptions')
    .update(updates)
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .select('*, clients(first_name, last_name, email), client_memberships(membership_id)')
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ membershipSubscription: data });
});

// LOYALTY CONFIG

/**
 * GET /api/features/loyalty-config
 * Get single loyalty config row for beautician
 */
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

  res.json({ loyaltyConfig: data || null });
});

/**
 * POST /PUT /api/features/loyalty-config
 * Upsert loyalty config
 */
router.post('/loyalty-config', requireAuth, async (req, res) => {
  const { points_per_pound, redemption_rate, min_points_redeem } = req.body;

  const { data, error } = await supabase
    .from('loyalty_config')
    .upsert({
      beautician_id: req.beautician.id,
      points_per_pound: points_per_pound || 1,
      redemption_rate: redemption_rate || 100,
      min_points_redeem: min_points_redeem || 50
    }, { onConflict: 'beautician_id' })
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ loyaltyConfig: data });
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

  const { data, error } = await supabase
    .from('loyalty_points')
    .insert({
      beautician_id: req.beautician.id,
      client_id,
      points,
      reason: reason || 'manual',
      transaction_date: new Date().toISOString()
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
  res.json({ referrals: data });
});

/**
 * POST /api/features/referrals
 */
router.post('/referrals', requireAuth, async (req, res) => {
  const { referrer_client_id, referred_client_id, status, reward } = req.body;

  if (!referrer_client_id || !referred_client_id) {
    return res.status(400).json({ error: 'referrer_client_id and referred_client_id are required' });
  }

  const { data, error } = await supabase
    .from('referrals')
    .insert({
      beautician_id: req.beautician.id,
      referrer_client_id,
      referred_client_id,
      status: status || 'pending',
      reward: reward || null
    })
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ referral: data });
});

/**
 * PATCH /api/features/referrals/:id
 */
router.patch('/referrals/:id', requireAuth, async (req, res) => {
  const { status, reward } = req.body;
  const updates = {};

  if (status !== undefined) updates.status = status;
  if (reward !== undefined) updates.reward = reward;

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
  res.json({ referral: data });
});

// REVENUE GOALS

/**
 * GET /api/features/revenue-goals
 */
router.get('/revenue-goals', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('revenue_goals')
    .select('*')
    .eq('beautician_id', req.beautician.id)
    .order('target_month', { ascending: false });

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ revenueGoals: data });
});

/**
 * POST /api/features/revenue-goals
 */
router.post('/revenue-goals', requireAuth, async (req, res) => {
  const { target_month, target_amount, notes } = req.body;

  if (!target_month || !target_amount) {
    return res.status(400).json({ error: 'target_month and target_amount are required' });
  }

  const { data, error } = await supabase
    .from('revenue_goals')
    .insert({
      beautician_id: req.beautician.id,
      target_month,
      target_amount,
      notes: notes || null
    })
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ revenueGoal: data });
});

/**
 * PATCH /api/features/revenue-goals/:id
 */
router.patch('/revenue-goals/:id', requireAuth, async (req, res) => {
  const { target_amount, notes } = req.body;
  const updates = {};

  if (target_amount !== undefined) updates.target_amount = target_amount;
  if (notes !== undefined) updates.notes = notes;

  const { data, error } = await supabase
    .from('revenue_goals')
    .update(updates)
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ revenueGoal: data });
});

/**
 * DELETE /api/features/revenue-goals/:id
 */
router.delete('/revenue-goals/:id', requireAuth, async (req, res) => {
  const { error } = await supabase
    .from('revenue_goals')
    .delete()
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id);

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ success: true });
});

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
  const { name, trigger_type, action_type, config, enabled } = req.body;

  if (!name || !trigger_type || !action_type) {
    return res.status(400).json({ error: 'name, trigger_type, and action_type are required' });
  }

  const { data, error } = await supabase
    .from('automation_rules')
    .insert({
      beautician_id: req.beautician.id,
      name,
      trigger_type,
      action_type,
      config: config || {},
      enabled: enabled !== undefined ? enabled : true
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
  const { name, trigger_type, action_type, config, enabled } = req.body;
  const updates = {};

  if (name !== undefined) updates.name = name;
  if (trigger_type !== undefined) updates.trigger_type = trigger_type;
  if (action_type !== undefined) updates.action_type = action_type;
  if (config !== undefined) updates.config = config;
  if (enabled !== undefined) updates.enabled = enabled;

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
  res.json({ policies: data });
});

/**
 * POST /api/features/policies
 */
router.post('/policies', requireAuth, async (req, res) => {
  const { name, policy_text, category } = req.body;

  if (!name || !policy_text) {
    return res.status(400).json({ error: 'name and policy_text are required' });
  }

  const { data, error } = await supabase
    .from('policies')
    .insert({
      beautician_id: req.beautician.id,
      name,
      policy_text,
      category: category || 'general'
    })
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ policy: data });
});

/**
 * PATCH /api/features/policies/:id
 */
router.patch('/policies/:id', requireAuth, async (req, res) => {
  const { name, policy_text, category } = req.body;
  const updates = {};

  if (name !== undefined) updates.name = name;
  if (policy_text !== undefined) updates.policy_text = policy_text;
  if (category !== undefined) updates.category = category;

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
  res.json({ policy: data });
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
router.post('/hours-exceptions', requireAuth, async (req, res) => {
  const { date, exception_type, details } = req.body;

  if (!date || !exception_type) {
    return res.status(400).json({ error: 'date and exception_type are required' });
  }

  const { data, error } = await supabase
    .from('hours_exceptions')
    .insert({
      beautician_id: req.beautician.id,
      date,
      exception_type,
      details: details || {}
    })
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
 */
router.get('/client-tag-assignments', requireAuth, async (req, res) => {
  let query = supabase
    .from('client_tag_assignments')
    .select('*')
    .eq('beautician_id', req.beautician.id)
    .order('created_at', { ascending: false });

  if (req.query.client_id) {
    query = query.eq('client_id', req.query.client_id);
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

  const { data, error } = await supabase
    .from('client_tag_assignments')
    .insert({
      beautician_id: req.beautician.id,
      client_id,
      client_tag_id
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
  const { error } = await supabase
    .from('client_tag_assignments')
    .delete()
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id);

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

  const { data, error } = await supabase
    .from('reviews')
    .insert({
      beautician_id: req.beautician.id,
      client_id,
      rating,
      review_text: review_text || null,
      platform: platform || 'website'
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
 */
router.get('/end-of-day-reports', requireAuth, async (req, res) => {
  let query = supabase
    .from('end_of_day_reports')
    .select('*')
    .eq('beautician_id', req.beautician.id)
    .order('report_date', { ascending: false });

  if (req.query.date) {
    query = query.eq('report_date', req.query.date);
  }

  const { data, error } = await query;
  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ endOfDayReports: data });
});

/**
 * POST/PUT /api/features/end-of-day-reports
 * Upsert by date
 */
router.post('/end-of-day-reports', requireAuth, async (req, res) => {
  const { report_date, summary, revenue, appointments_count, notes } = req.body;

  if (!report_date) {
    return res.status(400).json({ error: 'report_date is required' });
  }

  const { data, error } = await supabase
    .from('end_of_day_reports')
    .upsert({
      beautician_id: req.beautician.id,
      report_date,
      summary: summary || null,
      revenue: revenue || 0,
      appointments_count: appointments_count || 0,
      notes: notes || null
    }, { onConflict: 'beautician_id,report_date' })
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ endOfDayReport: data });
});

// PORTAL SETTINGS

/**
 * GET /api/features/portal-settings
 * Get single row for beautician
 */
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

  res.json({ portalSettings: data || null });
});

/**
 * POST/PUT /api/features/portal-settings
 * Upsert
 */
router.post('/portal-settings', requireAuth, async (req, res) => {
  const { show_online_booking, booking_buffer_minutes, max_bookings_per_day, theme } = req.body;

  const { data, error } = await supabase
    .from('portal_settings')
    .upsert({
      beautician_id: req.beautician.id,
      show_online_booking: show_online_booking !== undefined ? show_online_booking : true,
      booking_buffer_minutes: booking_buffer_minutes || 15,
      max_bookings_per_day: max_bookings_per_day || 10,
      theme: theme || 'light'
    }, { onConflict: 'beautician_id' })
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ portalSettings: data });
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

/**
 * GET /api/features/waitlist
 */
router.get('/waitlist', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('waitlist')
    .select('*, clients(first_name, last_name, email), treatments(name)')
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
 */
router.post('/waitlist', requireAuth, async (req, res) => {
  const { client_id, treatment_id, preferred_dates } = req.body;

  if (!client_id || !treatment_id) {
    return res.status(400).json({ error: 'client_id and treatment_id are required' });
  }

  const { data, error } = await supabase
    .from('waitlist')
    .insert({
      beautician_id: req.beautician.id,
      client_id,
      treatment_id,
      preferred_dates: preferred_dates || [],
      status: 'active'
    })
    .select('*, clients(first_name, last_name, email), treatments(name)')
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ waitlistEntry: data });
});

/**
 * PATCH /api/features/waitlist/:id
 */
router.patch('/waitlist/:id', requireAuth, async (req, res) => {
  const { status, preferred_dates } = req.body;
  const updates = {};

  if (status !== undefined) updates.status = status;
  if (preferred_dates !== undefined) updates.preferred_dates = preferred_dates;

  const { data, error } = await supabase
    .from('waitlist')
    .update(updates)
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .select('*, clients(first_name, last_name, email), treatments(name)')
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.json({ waitlistEntry: data });
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

  const { data, error } = await supabase
    .from('messages')
    .insert({
      beautician_id: req.beautician.id,
      client_id,
      message_text,
      direction: direction || 'outbound'
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
  res.json({ campaigns: data });
});

/**
 * POST /api/features/campaigns
 */
router.post('/campaigns', requireAuth, async (req, res) => {
  const { name, campaign_type, content, status } = req.body;

  if (!name || !campaign_type) {
    return res.status(400).json({ error: 'name and campaign_type are required' });
  }

  const { data, error } = await supabase
    .from('campaigns')
    .insert({
      beautician_id: req.beautician.id,
      name,
      campaign_type,
      content: content || {},
      status: status || 'draft'
    })
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Database operation failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  res.status(201).json({ campaign: data });
});

/**
 * PATCH /api/features/campaigns/:id
 */
router.patch('/campaigns/:id', requireAuth, async (req, res) => {
  const { name, content, status } = req.body;
  const updates = {};

  if (name !== undefined) updates.name = name;
  if (content !== undefined) updates.content = content;
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
  res.json({ campaign: data });
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
