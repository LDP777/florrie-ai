import { Router } from 'express';
import { supabase, supabaseAnon } from '../config.js';
import { requireAuth, sanitizeBeautician } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import { triggerSequence } from '../services/email-sequences.js';
import logger from '../lib/logger.js';
import {
  signupSchema,
  profileUpdateSchema
} from '../lib/schemas.js';

const router = Router();

/** Length of the free trial, in days. Matches TIERS.trial.trial_days. */
const TRIAL_DAYS = 14;

/**
 * Create the beauticians row for a brand new account, and start the welcome
 * sequence exactly once.
 *
 * This is the ONLY place a profile is created server side, and the only place
 * the welcome sequence is triggered, because the two have to happen together
 * or not at all. The sequence used to be fired from the signup handler below,
 * which no client has ever called: the browser creates the row itself through
 * Supabase, so in production not one welcome email has ever been sent.
 *
 * Fires exactly once, and never for an existing user, because the insert IS
 * the guard. If the row already exists the caller gets it back with
 * created:false and no email is scheduled. If two tabs race, the unique index
 * on auth_id makes one of them lose, and the loser takes the same
 * already-exists path. email_sends dedups on email_key as a second line of
 * defence, not as the first.
 */
async function createProfileWithWelcome(fields) {
  const { data: created, error } = await supabase
    .from('beauticians')
    .insert({
      ...fields,
      trial_ends_at: new Date(Date.now() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString(),
    })
    .select()
    .single();

  if (error) return { beautician: null, created: false, error };

  // Async on purpose: a slow or broken email provider must never be the
  // reason a signup fails.
  triggerSequence('welcome', created.id).catch(err =>
    logger.warn({ err, beauticianId: created.id }, 'Welcome sequence trigger failed')
  );

  return { beautician: created, created: true, error: null };
}

/**
 * POST /api/auth/ensure-profile
 *
 * Called by the browser straight after Supabase auth signs someone in for the
 * first time. Returns the caller's beautician row, creating it if this is a
 * genuinely new account.
 *
 * Deliberately NOT behind requireAuth: requireAuth 403s when there is no
 * profile, which is precisely the state this endpoint exists to resolve. It
 * verifies the JWT itself and only ever touches the row belonging to that
 * token's user, so it grants nothing extra.
 */
router.post('/ensure-profile', async (req, res) => {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Missing authorization token' });

  const { data: { user } = {}, error: authError } = await supabaseAnon.auth.getUser(token);
  if (authError || !user) return res.status(401).json({ error: 'Invalid or expired token' });

  const { data: existing, error: lookupError } = await supabase
    .from('beauticians')
    .select('*')
    .eq('auth_id', user.id)
    .maybeSingle();

  if (lookupError) {
    logger.error({ err: lookupError }, 'ensure-profile: lookup failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }

  if (existing) {
    return res.json({ beautician: sanitizeBeautician(existing), created: false });
  }

  const meta = user.user_metadata || {};
  const { beautician, created, error } = await createProfileWithWelcome({
    auth_id: user.id,
    email: user.email,
    first_name: meta.first_name || meta.given_name || (meta.full_name || meta.name || '').split(' ')[0] || '',
    last_name: meta.last_name || meta.family_name || '',
  });

  if (error) {
    // 23505: someone else won the race and the row now exists. That is a
    // success for the caller, and it must not send a second welcome email.
    if (error.code === '23505') {
      const { data: raced } = await supabase
        .from('beauticians')
        .select('*')
        .eq('auth_id', user.id)
        .maybeSingle();
      if (raced) return res.json({ beautician: sanitizeBeautician(raced), created: false });
    }
    logger.error({ err: error }, 'ensure-profile: insert failed');
    return res.status(500).json({ error: 'Failed to create profile' });
  }

  res.status(201).json({ beautician: sanitizeBeautician(beautician), created });
});

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

  // Create beautician profile. Same helper as /ensure-profile, so the welcome
  // sequence has exactly one trigger point whichever door the account came in.
  const { beautician, error: profileError } = await createProfileWithWelcome({
    auth_id: authData.user.id,
    email,
    first_name: firstName,
    last_name: lastName || '',
    business_name: businessName || null,
  });

  if (profileError) {
    // Rollback: delete the auth user
    await supabase.auth.admin.deleteUser(authData.user.id);
    return res.status(500).json({ error: 'Failed to create profile' });
  }

  res.status(201).json({ user: authData.user, beautician: sanitizeBeautician(beautician) });
});

/**
 * GET /api/auth/me
 * Returns the current beautician's profile.
 */
router.get('/me', requireAuth, (req, res) => {
  // Hit on every nav; a short private cache cuts redundant Supabase reads (L3).
  res.set('Cache-Control', 'private, max-age=30');
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


/**
 * DELETE /api/auth/account
 * Permanently delete the signed-in user's account and all their data.
 * Required by App Store Guideline 5.1.1(v). 63/64 child tables cascade from
 * beauticians(id), so deleting the row wipes the business data; we then remove
 * the Supabase auth user so the login can never be reused.
 */
router.delete('/account', requireAuth, async (req, res) => {
  try {
    const b = req.beautician;
    const { error: delErr } = await supabase.from('beauticians').delete().eq('id', b.id);
    if (delErr) {
      logger.error({ err: delErr, beauticianId: b.id }, 'account delete: beautician row failed');
      return res.status(500).json({ error: 'Failed to delete account' });
    }
    const authId = b.auth_id || req.user?.id;
    if (authId) {
      await supabase.auth.admin.deleteUser(authId).catch(err =>
        logger.warn({ err, beauticianId: b.id }, 'account delete: auth user removal failed'));
    }
    res.json({ success: true });
  } catch (err) {
    logger.error({ err }, 'account delete unexpected');
    res.status(500).json({ error: 'Something went wrong' });
  }
});


export default router;
