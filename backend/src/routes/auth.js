import { Router } from 'express';
import { supabase } from '../index.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

/**
 * POST /api/auth/signup
 * Creates a Supabase auth user + beautician profile in one step.
 */
router.post('/signup', async (req, res) => {
  const { email, password, firstName, lastName, businessName } = req.body;

  if (!email || !password || !firstName) {
    return res.status(400).json({ error: 'Email, password, and first name are required' });
  }

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
router.patch('/me', requireAuth, async (req, res) => {
  const allowedFields = [
    'first_name', 'last_name', 'business_name', 'phone', 'avatar_url',
    'booking_slug', 'working_hours', 'brand_color', 'brand_font', 'logo_url',
    'confidence_threshold', 'auto_reply_enabled'
  ];

  const updates = {};
  for (const field of allowedFields) {
    if (req.body[field] !== undefined) {
      updates[field] = req.body[field];
    }
  }

  const { data, error } = await supabase
    .from('beauticians')
    .update(updates)
    .eq('id', req.beautician.id)
    .select()
    .single();

  if (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json({ beautician: data });
});

export default router;
