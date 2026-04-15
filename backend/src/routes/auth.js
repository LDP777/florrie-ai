import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth, sanitizeBeautician } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { triggerSequence } from '../services/email-sequences.js';
import logger from '../lib/logger.js';
import {
  signupSchema,
  profileUpdateSchema
} from '../lib/schemas.js';

const router = Router();

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
    logger.error({ err: authError }, 'Signup failed');
    // Return generic message — never expose whether an email already exists
    return res.status(400).json({ error: 'Signup failed. Please try again.' });
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

  // Fire welcome email sequence (async, don't block signup response)
  triggerSequence('welcome', beautician.id).catch(err =>
    logger.warn({ err, beauticianId: beautician.id }, 'Welcome sequence trigger failed')
  );

  res.status(201).json({ user: authData.user, beautician: sanitizeBeautician(beautician) });
});

/**
 * GET /api/auth/me
 * Returns the current beautician's profile.
 */
router.get('/me', requireAuth, (req, res) => {
  res.json({ beautician: sanitizeBeautician(req.beautician) });
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

  res.json({ beautician: sanitizeBeautician(data) });
});

export default router;
