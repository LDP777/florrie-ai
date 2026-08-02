import { supabase, supabaseAnon } from '../config.js';
import logger from '../lib/logger.js';

/**
 * Fields that are safe to expose to the frontend.
 *
 * NEVER include OAuth tokens, Stripe IDs, or internal backend fields here.
 * These are fetched server-side only when the relevant route needs them.
 */
const SAFE_BEAUTICIAN_FIELDS = [
  'id',
  'first_name',
  'last_name',
  'email',
  'phone',
  'business_name',
  'avatar_url',
  'booking_slug',
  'timezone',
  'currency',
  'locale',
  'working_hours',
  'tone_model',
  'confidence_threshold',
  'auto_reply_enabled',
  'subscription_status',
  'subscription_plan',
  'trial_ends_at',
  'subscription_current_period_end',
  'stripe_onboarding_complete',  // boolean only — not the account/customer ID
  'brand_color',
  'brand_font',
  'logo_url',
  'tagline',
  'address',
  'social_links',
  'google_place_id',
  'notification_prefs',
  'client_reminder_prefs',
  'onboarding_completed_at',
  'booking_policy',
  'deposit_required',
  'deposit_percentage',
  'cancellation_policy',
  'no_show_fee_enabled',
  'no_show_fee_percent',
  'payment_settings',
  'calendar_settings',
  'google_calendar_connected',  // boolean only — not the tokens
  'google_calendar_id',
  'xero_connected',             // boolean only
  'quickbooks_connected',       // boolean only
  'whatsapp_phone_id',          // public phone ID (not the token)
  'instagram_page_id',          // public page ID (not the token)
  'instagram_dm_mode',
  'instagram_auto_redirect_message',
  'sms_enabled',
  'sms_originator',
  'ai_chats_this_month',
  'ai_chats_reset_at',
  'created_at',
  'updated_at',
];

/**
 * Strip all sensitive / backend-only fields from a beautician record
 * before it leaves the server. Called before any res.json() that includes
 * the beautician object.
 *
 * Sensitive fields stripped:
 *   whatsapp_token, instagram_token,
 *   google_calendar_tokens, xero_tokens, quickbooks_tokens (OAuth tokens)
 *   stripe_account_id, stripe_customer_id, subscription_stripe_id (Stripe IDs)
 *   auth_id (internal Supabase link — frontend never needs this)
 */
export function sanitizeBeautician(b) {
  if (!b) return null;
  const safe = {};
  for (const field of SAFE_BEAUTICIAN_FIELDS) {
    if (field in b) safe[field] = b[field];
  }
  return safe;
}

/** Length of the free trial, in days. Matches TIERS.trial.trial_days. */
const TRIAL_DAYS = 14;

/**
 * Fill in a missing trial_ends_at before any route or middleware sees the row.
 *
 * WHY this exists: the live signup path creates the beauticians row from the
 * browser on first login, and for a long time that insert wrote no
 * trial_ends_at at all. isTrialExpired() reads a null as "there is no trial to
 * expire", so every one of those accounts had a trial that never ended and was
 * never asked to pay. The insert is fixed, but a one-off backfill would only
 * clean up today's rows: any future code path that creates a beautician and
 * forgets the column would silently hand out a free-forever account again.
 *
 * So we derive the window here instead, in the single place every
 * authenticated request already loads the row: a trial with no recorded end
 * date is treated as a trial that started when the account was created.
 *
 * This is read-only on purpose. We never write the derived date back, so a
 * genuine backfill by hand always wins, and an account on a real paid plan is
 * left alone entirely.
 */
export function withTrialWindow(beautician) {
  if (!beautician || beautician.trial_ends_at) return beautician;

  // A live paid subscription has no trial window worth enforcing.
  const plan = beautician.subscription_plan;
  if (beautician.subscription_status === 'active' && (plan === 'florrie' || plan === 'florrie_team')) {
    return beautician;
  }

  const createdAt = beautician.created_at ? new Date(beautician.created_at) : null;
  if (!createdAt || Number.isNaN(createdAt.getTime())) {
    // Nothing to anchor the window to, so we leave the row alone and the
    // paywall treats it as expired. Be clear that this DOES lock the account
    // out: it should be unreachable (created_at defaults to now() and no
    // insert path sets it), so if this ever fires the row itself is broken and
    // needs a human, not a silently extended free trial. Logged at error level
    // for exactly that reason.
    logger.error({ beauticianId: beautician.id }, 'Beautician has neither trial_ends_at nor a usable created_at; the account will read as expired until the row is repaired');
    return beautician;
  }

  return {
    ...beautician,
    trial_ends_at: new Date(createdAt.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000).toISOString(),
  };
}

/**
 * Resolve the signed-in beautician for a request WITHOUT sending a response.
 *
 * requireAuth wraps this and turns a failure into the right status code. The
 * paywall middleware also uses it, because it needs to know who is calling
 * without taking over the decision to reject: some routers behind the paywall
 * still expose one public endpoint, and only the router itself knows that.
 *
 * Result: { ok: true, user, beautician } or { ok: false, reason }.
 * On success req.user and req.beautician are populated, so a later requireAuth
 * on the same request is free.
 */
export async function resolveBeautician(req) {
  if (req.user && req.beautician) {
    return { ok: true, user: req.user, beautician: req.beautician };
  }

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return { ok: false, reason: 'missing_token' };

  const { data: { user } = {}, error } = await supabaseAnon.auth.getUser(token);
  if (error || !user) return { ok: false, reason: 'invalid_token' };

  // Get the full beautician record. Routes that need tokens (e.g. Google Calendar)
  // read from req.beautician directly. Never forward the full object to res.json().
  //
  // IMPORTANT: must use service-role client here because migration 047 revoked
  // anon SELECT on beauticians. Anon can still validate the user's JWT (above),
  // but anon cannot read the beauticians row. Service role bypasses RLS; this
  // is safe because we've already verified the user via the JWT and gate the
  // query on auth_id = user.id (so a user can only ever fetch their own row).
  const { data: beautician, error: bError } = await supabase
    .from('beauticians')
    .select('*')
    .eq('auth_id', user.id)
    .single();

  if (bError || !beautician) return { ok: false, reason: 'no_profile' };

  req.user = user;
  req.beautician = withTrialWindow(beautician);
  return { ok: true, user, beautician: req.beautician };
}

/**
 * Auth middleware — extracts the Supabase JWT from Authorization header,
 * verifies it, and attaches the beautician record to req.
 *
 * req.beautician = full record (for internal route logic — e.g. checking tokens)
 * Use sanitizeBeautician(req.beautician) before sending to client.
 */
export async function requireAuth(req, res, next) {
  try {
    const result = await resolveBeautician(req);
    if (result.ok) return next();

    if (result.reason === 'missing_token') {
      return res.status(401).json({ error: 'Missing authorization token' });
    }
    if (result.reason === 'invalid_token') {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }
    return res.status(403).json({ error: 'No beautician profile found. Complete onboarding first.' });
  } catch (err) {
    logger.error({ err }, 'Auth middleware error');
    return res.status(500).json({ error: 'Authentication failed' });
  }
}
