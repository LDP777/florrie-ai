import { Router } from 'express';
import { z } from 'zod';
import { supabase } from '../index.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import logger from '../lib/logger.js';

const router = Router();

const signupSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  firstName: z.string().min(1).max(100).trim(),
  lastName: z.string().max(100).trim().optional().default(''),
  businessName: z.string().max(200).trim().optional().nullable(),
});

const profileUpdateSchema = z.object({
  first_name: z.string().min(1).max(100).trim().optional(),
  last_name: z.string().max(100).trim().optional(),
  business_name: z.string().max(200).trim().optional().nullable(),
  phone: z.string().max(30).trim().optional().nullable(),
  avatar_url: z.string().url().optional().nullable(),
  booking_slug: z.string().min(2).max(60).regex(/^[a-z0-9-]+$/, 'Slug must be lowercase alphanumeric with dashes').optional(),
  working_hours: z.record(z.any()).optional(),
  brand_color: z.string().max(20).optional(),
  brand_font: z.string().max(50).optional(),
  logo_url: z.string().url().optional().nullable(),
  confidence_threshold: z.number().min(0).max(1).optional(),
  auto_reply_enabled: z.boolean().optional(),
}).strict();

/**
 * POST /api/auth/signup
 * Creates a Supabase auth user + beautician profile in one step.
 */
router.post('/signup', validate(signupSchema), async (req, res) => {
  const { email, password, firstName, lastName, businessName } = req.body;

  // Create auth user
  const { data: authData, error: authError } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true
  });

  if (authError) {
    return res.status(400).json({ error: authError.message });
  }

  // Create beautician profile
  const { data: beautician, error: profileError } = await supabase
    .from('beauticians')
    .insert({
      auth_id: authData.user.id,
      email,
      first_name: firstName,
      last_name: lastName || '',
      business_name: businessName || null,
      trial_ends_at: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString() // 14-day trial
    })
    .select()
    .single();

  if (profileError) {
    // Rollback: delete the auth user
    await supabase.auth.admin.deleteUser(authData.user.id);
    return res.status(500).json({ error: 'Failed to create profile' });
  }

  res.status(201).json({ user: authData.user, beautician });
});

/**
 * GET /api/auth/me
 * Returns the current beautician's profile.
 */
router.get('/me', requireAuth, (req, res) => {
  res.json({ beautician: req.beautician });
});

/**
 * PATCH /api/auth/me
 * Updates the current beautician's profile.
 */
router.patch('/me', requireAuth, validate(profileUpdateSchema), async (req, res) => {
  const updates = { ...req.body };

  const { data, error } = await supabase
    .from('beauticians')
    .update(updates)
    .eq('id', req.beautician.id)
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Failed to update beautician profile');
    return res.status(500).json({ error: 'Something went wrong' });
  }

  res.json({ beautician: data });
});

export default router;
