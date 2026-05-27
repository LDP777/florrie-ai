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

/**
 * Auth middleware — extracts the Supabase JWT from Authorization header,
 * verifies it, and attaches the beautician record to req.
 *
 * req.beautician = full record (for internal route logic — e.g. checking tokens)
 * Use sanitizeBeautician(req.beautician) before sending to client.
 */
export async function requireAuth(req, res, next) {
  const token = req.headers.authorization?.replace('Bearer ', '');

  if (!token) {
    return res.status(401).json({ error: 'Missing authorization token' });
  }

  try {
    const { data: { user }, error } = await supabaseAnon.auth.getUser(token);

    if (error || !user) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Get the full beautician record — routes that need tokens (e.g. Google Calendar)
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

    if (bError || !beautician) {
      return res.status(403).json({ error: 'No beautician profile found. Complete onboarding first.' });
    }

    req.user = user;
    req.beautician = beautician;
    next();
  } catch (err) {
    logger.error({ err }, 'Auth middleware error');
    return res.status(500).json({ error: 'Authentication failed' });
  }
}
