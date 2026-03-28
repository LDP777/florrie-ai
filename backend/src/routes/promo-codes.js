import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../index.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';

const router = Router();

const createPromoCodeSchema = z.object({
  code: z.string().min(1, 'Code is required').max(50).toUpperCase(),
  discount_type: z.enum(['percentage', 'fixed'], { errorMap: () => ({ message: 'Must be percentage or fixed' }) }),
  discount_value: z.number().int().positive('Discount value must be positive'),
  max_uses: z.number().int().positive().optional().nullable(),
  valid_from: z.string().datetime('Invalid ISO datetime format'),
  valid_until: z.string().datetime('Invalid ISO datetime format'),
});

const updatePromoCodeSchema = z.object({
  is_active: z.boolean().optional(),
  discount_value: z.number().int().positive().optional(),
  max_uses: z.number().int().positive().optional().nullable(),
  valid_from: z.string().datetime().optional(),
  valid_until: z.string().datetime().optional(),
}).strict();

const validatePromoCodeSchema = z.object({
  code: z.string().min(1, 'Code is required').toUpperCase(),
});

/**
 * GET /api/promo-codes
 * List all promo codes for the beautician
 */
router.get('/', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('promo_codes')
      .select('*')
      .eq('beautician_id', req.beautician.id)
      .order('created_at', { ascending: false });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ data: data || [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/promo-codes
 * Create a new promo code
 */
router.post('/', requireAuth, validate(createPromoCodeSchema), async (req, res) => {
  try {
    const { code, discount_type, discount_value, max_uses, valid_from, valid_until } = req.body;

    // Validate that valid_until is after valid_from
    const from = new Date(valid_from);
    const until = new Date(valid_until);
    if (until <= from) {
      return res.status(400).json({ error: 'valid_until must be after valid_from' });
    }

    const { data, error } = await supabase
      .from('promo_codes')
      .insert({
        beautician_id: req.beautician.id,
        code,
        discount_type,
        discount_value,
        max_uses: max_uses || null,
        valid_from,
        valid_until,
        is_active: true,
      })
      .select()
      .single();

    if (error) {
      // Handle unique constraint violation
      if (error.code === '23505') {
        return res.status(400).json({ error: 'This code already exists for your account' });
      }
      return res.status(500).json({ error: error.message });
    }

    res.status(201).json({ data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/promo-codes/:id
 * Get a single promo code
 */
router.get('/:id', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('promo_codes')
      .select('*')
      .eq('id', req.params.id)
      .eq('beautician_id', req.beautician.id)
      .single();

    if (error) {
      return res.status(404).json({ error: 'Promo code not found' });
    }

    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * PATCH /api/promo-codes/:id
 * Update a promo code (toggle is_active, update fields)
 */
router.patch('/:id', requireAuth, validate(updatePromoCodeSchema), async (req, res) => {
  try {
    const updates = { ...req.body };

    // Always update the updated_at timestamp
    updates.updated_at = new Date().toISOString();

    // If valid_from and valid_until are both provided, validate they make sense
    if (req.body.valid_from && req.body.valid_until) {
      const from = new Date(req.body.valid_from);
      const until = new Date(req.body.valid_until);
      if (until <= from) {
        return res.status(400).json({ error: 'valid_until must be after valid_from' });
      }
    }

    const { data, error } = await supabase
      .from('promo_codes')
      .update(updates)
      .eq('id', req.params.id)
      .eq('beautician_id', req.beautician.id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    if (!data) {
      return res.status(404).json({ error: 'Promo code not found' });
    }

    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * DELETE /api/promo-codes/:id
 * Soft delete: sets is_active = false
 */
router.delete('/:id', requireAuth, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('promo_codes')
      .update({
        is_active: false,
        updated_at: new Date().toISOString(),
      })
      .eq('id', req.params.id)
      .eq('beautician_id', req.beautician.id)
      .select()
      .single();

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    if (!data) {
      return res.status(404).json({ error: 'Promo code not found' });
    }

    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/promo-codes/validate
 * PUBLIC endpoint: validate a promo code and return discount info if valid
 * Checks is_active, date range, and max_uses
 */
router.post('/validate', validate(validatePromoCodeSchema), async (req, res) => {
  try {
    const { code } = req.body;
    const now = new Date().toISOString();

    // Query with service role to bypass RLS for public validation
    const { data, error } = await supabase
      .from('promo_codes')
      .select('id, beautician_id, code, discount_type, discount_value, max_uses, current_uses, valid_from, valid_until, is_active')
      .eq('code', code)
      .single();

    if (error || !data) {
      return res.status(404).json({
        valid: false,
        error: 'Promo code not found'
      });
    }

    // Check if active
    if (!data.is_active) {
      return res.status(400).json({
        valid: false,
        error: 'This promo code is no longer active'
      });
    }

    // Check date range
    if (now < data.valid_from) {
      return res.status(400).json({
        valid: false,
        error: 'This promo code is not yet valid'
      });
    }

    if (now > data.valid_until) {
      return res.status(400).json({
        valid: false,
        error: 'This promo code has expired'
      });
    }

    // Check max uses
    if (data.max_uses && data.current_uses >= data.max_uses) {
      return res.status(400).json({
        valid: false,
        error: 'This promo code has reached its usage limit'
      });
    }

    // Valid! Return discount info
    res.json({
      valid: true,
      code: data.code,
      discount_type: data.discount_type,
      discount_value: data.discount_value,
      beautician_id: data.beautician_id
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
