/**
 * Retail Products routes.
 *
 * Public:
 *   GET /api/products/public/:beauticianId — list active products (for booking page)
 *
 * Authenticated:
 *   GET    /api/products     — list all products for current beautician
 *   POST   /api/products     — create product
 *   PATCH  /api/products/:id — update product
 *   DELETE /api/products/:id — delete product
 *   GET    /api/products/orders — list order items
 */
import { Router } from 'express';
import { supabase } from '../index.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../lib/logger.js';

const router = Router();

/**
 * GET /api/products/public/:beauticianId — public product listing for booking page
 */
router.get('/public/:beauticianId', async (req, res) => {
  const { beauticianId } = req.params;

  const { data, error } = await supabase
    .from('retail_products')
    .select('id, name, description, price_cents, image_url, category, max_per_order, stock_qty')
    .eq('beautician_id', beauticianId)
    .eq('active', true)
    .order('sort_order', { ascending: true });

  if (error) {
    logger.warn({ error }, 'Failed to fetch public products');
    return res.status(500).json({ error: 'Failed to load products' });
  }

  // Filter out out-of-stock items (stock_qty 0 = unlimited, stock_qty > 0 = tracked)
  const available = (data || []).filter(p => p.stock_qty === 0 || p.stock_qty > 0);
  res.json(available);
});

/**
 * GET /api/products — list all products for authenticated beautician
 */
router.get('/', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('retail_products')
    .select('*')
    .eq('beautician_id', req.beautician.id)
    .order('sort_order', { ascending: true });

  if (error) return res.status(500).json({ error: 'Failed to load products' });
  res.json(data || []);
});

/**
 * POST /api/products — create a new product
 */
router.post('/', requireAuth, async (req, res) => {
  const { name, description, price_cents, image_url, category, stock_qty, max_per_order, sort_order } = req.body;

  if (!name || !price_cents) {
    return res.status(400).json({ error: 'Name and price are required' });
  }

  const { data, error } = await supabase
    .from('retail_products')
    .insert({
      beautician_id: req.beautician.id,
      name,
      description: description || null,
      price_cents,
      image_url: image_url || null,
      category: category || 'general',
      stock_qty: stock_qty ?? 0,
      max_per_order: max_per_order ?? 5,
      sort_order: sort_order ?? 0,
    })
    .select()
    .single();

  if (error) {
    logger.warn({ error }, 'Failed to create product');
    return res.status(500).json({ error: 'Failed to create product' });
  }

  res.status(201).json(data);
});

/**
 * PATCH /api/products/:id — update a product
 */
router.patch('/:id', requireAuth, async (req, res) => {
  const allowed = ['name', 'description', 'price_cents', 'image_url', 'category', 'active', 'stock_qty', 'max_per_order', 'sort_order'];
  const updates = {};
  for (const key of allowed) {
    if (req.body[key] !== undefined) updates[key] = req.body[key];
  }

  if (Object.keys(updates).length === 0) {
    return res.status(400).json({ error: 'No valid fields to update' });
  }

  const { data, error } = await supabase
    .from('retail_products')
    .update(updates)
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .select()
    .single();

  if (error) return res.status(500).json({ error: 'Failed to update product' });
  if (!data) return res.status(404).json({ error: 'Product not found' });
  res.json(data);
});

/**
 * DELETE /api/products/:id — soft-delete (deactivate) a product
 */
router.delete('/:id', requireAuth, async (req, res) => {
  const { error } = await supabase
    .from('retail_products')
    .update({ active: false })
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id);

  if (error) return res.status(500).json({ error: 'Failed to delete product' });
  res.json({ deleted: true });
});

/**
 * GET /api/products/orders — list order items for current beautician
 */
router.get('/orders', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('order_items')
    .select('*, retail_products(name, image_url), clients(first_name, last_name)')
    .eq('beautician_id', req.beautician.id)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) return res.status(500).json({ error: 'Failed to load orders' });
  res.json(data || []);
});

export default router;
