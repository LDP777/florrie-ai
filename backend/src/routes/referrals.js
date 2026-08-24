/**
 * REFER A FRIEND, WRITTEN AGAINST THE TABLE THAT ACTUALLY EXISTS.
 *
 * This whole file was written against `023_referrals.sql`. That migration is a
 * second `CREATE TABLE IF NOT EXISTS referrals` for a table `007_all_features
 * .sql` had already created, so it was a no-op and 007 won. Every column this
 * route named (referrer_client_id, referred_client_id, referral_code,
 * reward_type, reward_value_cents, appointment_id, source, reward_issued_at)
 * is absent from the live table. PostgREST rejects the WHOLE select when one
 * column is unknown and reports it by RESOLVING with an error rather than
 * throwing, so the list read as empty and the writes 500'd: this route has
 * never worked once.
 *
 * The live shape, checked against the database and against 007:
 *   id, beautician_id, referrer_id (NOT NULL, clients), referred_id (clients),
 *   referred_name, referred_email, referred_phone, status, referrer_reward_cents,
 *   referred_reward_cents, created_at, completed_at
 *
 * HOW A REFERRAL IS IDENTIFIED, end to end.
 *
 * It used to be a beautician-level `referral_code`, minted once per salon and
 * written onto every referral row. Three things were wrong with that at once:
 *
 *   1. It cannot identify a referrer. `florrie.ai/book/{slug}?ref={salon code}`
 *      says which SALON, which the slug in the same URL already said. Nothing in
 *      the link says which client did the referring, and `referrals.referrer_id`
 *      is NOT NULL, so there was never a legal row to insert.
 *   2. 023 also put a UNIQUE index on referrals.referral_code while /track
 *      inserted the same salon-level code on every row, so the SECOND referral
 *      any salon ever took would have violated it even on the 023 shape.
 *   3. There is no referral_code column on the live table at all.
 *
 * So the identifier is the REFERRER CLIENT. The link is per client:
 *
 *   https://florrie.ai/book/{booking_slug}?ref={referrer client id}
 *
 * which is exactly the fact a referral row needs and cannot be derived any other
 * way. GET /links hands the salon one of these per client. POST /track resolves
 * `ref` to a client of THAT salon and refuses anything else, so the public
 * endpoint cannot be used to attach a referral to a stranger or to fish for
 * whether an id exists.
 *
 * `beauticians.referral_code` is left alone: unused by this route, not read, not
 * written, not minted. Nothing else in the codebase reads it.
 */
import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import logger from '../lib/logger.js';
import { referralConfigSchema } from '../lib/schemas.js';
import { selectable, writable } from '../lib/schema-probe.js';

const router = Router();

const FRONTEND_URL = (process.env.FRONTEND_URL || 'https://florrie.ai').replace(/\/$/, '');

/** 007's CHECK constraint. There is no 'expired' and no 'converted'. */
const REFERRAL_STATUSES = ['pending', 'booked', 'completed', 'rewarded'];

/** Program settings on beauticians. Added by 023, which aborted partway. */
const CONFIG_COLUMNS = ['referral_enabled', 'referral_reward_type', 'referral_reward_value_cents'];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const clientName = (c) => (c ? [c.first_name, c.last_name].filter(Boolean).join(' ').trim() : '');

/** The share link for one client of one salon. */
const shareLinkFor = (slug, clientId) =>
  (slug && clientId ? `${FRONTEND_URL}/book/${slug}?ref=${clientId}` : null);

/**
 * Read the salon's program settings, asking only for columns this database
 * really has. 023 errored on `CREATE UNIQUE INDEX ... ON referrals
 * (referral_code)` (no such column), so everything after that statement,
 * possibly including the ALTER that adds these three, may never have applied.
 * Missing settings degrade to the defaults instead of 500ing the page.
 */
async function readConfig(beauticianId) {
  const cols = await selectable(supabase, 'beauticians', ['id', 'booking_slug'], CONFIG_COLUMNS);
  const { data, error } = await supabase
    .from('beauticians')
    .select(cols)
    .eq('id', beauticianId)
    .maybeSingle();

  if (error) {
    logger.error({ err: error }, 'Failed to read referral config');
    return null;
  }
  return {
    booking_slug: data?.booking_slug || null,
    // Defaults match 023's column defaults, so a salon whose settings columns
    // are missing sees the same program a salon with them sees.
    referral_enabled: data?.referral_enabled ?? false,
    referral_reward_type: data?.referral_reward_type || 'discount',
    referral_reward_value_cents: data?.referral_reward_value_cents ?? 500,
    // Tells the UI whether the settings it shows can actually be saved.
    settings_persisted: CONFIG_COLUMNS.every(c => c in (data || {})),
  };
}

/**
 * Attach the referrer's and the referred party's names.
 *
 * Deliberately two follow-up queries rather than a PostgREST embed: `referrals`
 * has TWO foreign keys to `clients`, so `clients(...)` is ambiguous and errors,
 * and disambiguating it means hard-coding constraint names that this schema's
 * two rival migrations do not agree on.
 */
async function withNames(rows) {
  const ids = [...new Set(rows.flatMap(r => [r.referrer_id, r.referred_id]).filter(Boolean))];
  let byId = new Map();
  if (ids.length) {
    const { data, error } = await supabase
      .from('clients')
      .select('id, first_name, last_name')
      .in('id', ids);
    if (error) logger.warn({ err: error }, 'Referral name lookup failed; showing rows without names');
    else byId = new Map((data || []).map(c => [c.id, c]));
  }
  return rows.map(r => ({
    ...r,
    // Not columns on referrals. Derived, and named so the UI can show a person
    // rather than a uuid.
    referrer_name: clientName(byId.get(r.referrer_id)) || 'Client',
    referred_name: r.referred_name || clientName(byId.get(r.referred_id)) || null,
    referred_contact: r.referred_email || r.referred_phone || null,
  }));
}

/**
 * GET /api/referrals
 * List all referrals for the current beautician.
 */
router.get('/', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('referrals')
    .select('*')
    .eq('beautician_id', req.beautician.id)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) {
    logger.error({ err: error }, 'Failed to fetch referrals');
    return res.status(500).json({ error: 'Something went wrong' });
  }

  res.json({ referrals: await withNames(data || []) });
});

/**
 * GET /api/referrals/stats
 * Aggregated referral stats for the dashboard.
 */
router.get('/stats', requireAuth, async (req, res) => {
  const { data, error } = await supabase
    .from('referrals')
    // Was `status, reward_value_cents`. There is no reward_value_cents, so this
    // select failed as a whole and the stats were zeros for everybody.
    .select('status, referrer_reward_cents, referred_reward_cents')
    .eq('beautician_id', req.beautician.id);

  if (error) {
    logger.error({ err: error }, 'Failed to fetch referral stats');
    return res.status(500).json({ error: 'Something went wrong' });
  }

  const rows = data || [];
  const rewarded = rows.filter(r => r.status === 'rewarded');
  res.json({
    stats: {
      total: rows.length,
      pending: rows.filter(r => r.status === 'pending').length,
      booked: rows.filter(r => r.status === 'booked').length,
      completed: rows.filter(r => ['completed', 'rewarded'].includes(r.status)).length,
      totalRewardsCents: rewarded.reduce(
        (s, r) => s + (r.referrer_reward_cents || 0) + (r.referred_reward_cents || 0), 0,
      ),
    },
  });
});

/**
 * GET /api/referrals/config
 * The salon's referral program settings, and how its links are built.
 */
router.get('/config', requireAuth, async (req, res) => {
  const config = await readConfig(req.beautician.id);
  if (!config) return res.status(500).json({ error: 'Something went wrong' });

  res.json({
    config,
    // No single salon-level share link, because a salon-level link cannot say
    // who did the referring. One link per client, from /links below.
    linkTemplate: config.booking_slug
      ? `${FRONTEND_URL}/book/${config.booking_slug}?ref={client_id}`
      : null,
    bookingLink: config.booking_slug ? `${FRONTEND_URL}/book/${config.booking_slug}` : null,
  });
});

/**
 * PATCH /api/referrals/config
 * Update referral program settings.
 */
router.patch('/config', requireAuth, validate(referralConfigSchema), async (req, res) => {
  const updates = await writable(supabase, 'beauticians', { ...req.body }, CONFIG_COLUMNS);

  if (Object.keys(updates).length === 0) {
    // Every field asked for is missing from this database. Saying "saved" here
    // is the lie that makes a settings page untrustworthy.
    return res.status(503).json({
      error: 'Referral settings cannot be saved on this database yet: the beauticians.referral_* columns are missing. Apply the referral settings migration.',
    });
  }

  const { error } = await supabase
    .from('beauticians')
    .update(updates)
    .eq('id', req.beautician.id);

  if (error) {
    logger.error({ err: error }, 'Failed to update referral config');
    return res.status(500).json({ error: 'Failed to update config' });
  }

  const config = await readConfig(req.beautician.id);
  res.json({ config, saved: Object.keys(updates) });
});

/**
 * GET /api/referrals/links
 * One share link per client, because the referrer IS the identifier.
 */
router.get('/links', requireAuth, async (req, res) => {
  const config = await readConfig(req.beautician.id);
  if (!config) return res.status(500).json({ error: 'Something went wrong' });

  if (!config.booking_slug) {
    return res.json({ links: [], bookingLink: null, reason: 'no_booking_slug' });
  }

  const { data, error } = await supabase
    .from('clients')
    .select('id, first_name, last_name')
    .eq('beautician_id', req.beautician.id)
    .order('first_name', { ascending: true })
    .limit(500);

  if (error) {
    logger.error({ err: error }, 'Failed to list clients for referral links');
    return res.status(500).json({ error: 'Something went wrong' });
  }

  res.json({
    bookingLink: `${FRONTEND_URL}/book/${config.booking_slug}`,
    links: (data || []).map(c => ({
      client_id: c.id,
      name: clientName(c) || 'Client',
      share_link: shareLinkFor(config.booking_slug, c.id),
    })),
  });
});

/**
 * POST /api/referrals/track
 * Called from the public booking page when it was opened with ?ref=<client id>.
 * Public: no auth, so it says as little as possible about what it did or did
 * not find.
 *
 * Body: { beautician_id, ref, client_id?, referred_name?, referred_email?,
 *         referred_phone? }
 */
router.post('/track', async (req, res) => {
  const {
    beautician_id, ref, referral_code,
    client_id, referred_id, client_name, referred_name,
    referred_email, referred_phone,
  } = req.body || {};

  // `referral_code` is the name the old booking page would have used. Accepted
  // as an alias so a page that has not been redeployed still reaches this
  // handler, but it is read as a client id like everything else, because that
  // is the only thing that can identify a referrer.
  const referrerId = ref || referral_code;
  const referredId = client_id || referred_id || null;
  const referredName = referred_name || client_name || null;

  if (!referrerId || !beautician_id) {
    return res.status(400).json({ error: 'beautician_id and ref are required' });
  }
  if (!UUID_RE.test(String(referrerId)) || !UUID_RE.test(String(beautician_id))) {
    return res.status(404).json({ error: 'Invalid referral link' });
  }
  if (referredId && !UUID_RE.test(String(referredId))) {
    return res.status(400).json({ error: 'client_id must be a client id' });
  }
  if (referredId && referredId === referrerId) {
    return res.status(400).json({ error: 'A client cannot refer herself' });
  }

  const config = await readConfig(beautician_id);
  if (!config || !config.referral_enabled) {
    // Same 404 for "no such salon" and "program off", on purpose: a public
    // endpoint that distinguishes them is an existence oracle.
    return res.status(404).json({ error: 'Invalid referral link' });
  }

  // The referrer must be a client OF THIS SALON. This is the whole tenancy
  // check: without it the link would attach one salon's client to another's.
  const { data: referrer, error: referrerErr } = await supabase
    .from('clients')
    .select('id')
    .eq('id', referrerId)
    .eq('beautician_id', beautician_id)
    .maybeSingle();

  if (referrerErr) {
    logger.error({ err: referrerErr }, 'Referral referrer lookup failed');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  if (!referrer) return res.status(404).json({ error: 'Invalid referral link' });

  // Same check for the referred client, when the booking page knows one.
  if (referredId) {
    const { data: referred } = await supabase
      .from('clients')
      .select('id')
      .eq('id', referredId)
      .eq('beautician_id', beautician_id)
      .maybeSingle();
    if (!referred) return res.status(404).json({ error: 'Invalid referral link' });
  }

  // Idempotence, in code, because there is no unique index to lean on. A
  // booking page that retries, or a client who reloads the confirmation, must
  // not mint a second referral for the same pair.
  let existing = supabase
    .from('referrals')
    .select('*')
    .eq('beautician_id', beautician_id)
    .eq('referrer_id', referrerId);
  if (referredId) existing = existing.eq('referred_id', referredId);
  else if (referred_email) existing = existing.is('referred_id', null).eq('referred_email', referred_email);
  else if (referred_phone) existing = existing.is('referred_id', null).eq('referred_phone', referred_phone);
  // Nothing identifies the friend yet: the link has only been followed. Match
  // the one open row for this referrer, so a reload does not mint a new one.
  else existing = existing.is('referred_id', null).eq('status', 'pending');

  const { data: existingRows } = await existing.limit(1);

  if (existingRows?.length) {
    return res.status(200).json({ referral: (await withNames(existingRows))[0], created: false });
  }

  const row = {
    beautician_id,
    referrer_id: referrerId,          // NOT NULL on the live table.
    referred_id: referredId,
    referred_name: referredName,
    referred_email: referred_email || null,
    referred_phone: referred_phone || null,
    // 'booked' once we know who the friend is, 'pending' while the link has
    // only been followed. Both are in 007's CHECK list.
    status: referredId ? 'booked' : 'pending',
    referrer_reward_cents: config.referral_reward_value_cents,
    // The UI has always shown "friend gets" the same amount, so store it rather
    // than leaving a number on screen with nothing behind it.
    referred_reward_cents: config.referral_reward_value_cents,
  };

  const { data, error } = await supabase
    .from('referrals')
    .insert(row)
    .select()
    .single();

  if (error) {
    logger.error({ err: error, beautician_id }, 'Failed to track referral');
    return res.status(500).json({ error: 'Something went wrong' });
  }

  res.status(201).json({ referral: (await withNames([data]))[0], created: true });
});

/**
 * POST /api/referrals/:id/complete
 * Mark a referral rewarded.
 */
router.post('/:id/complete', requireAuth, async (req, res) => {
  const { data: referral, error: readErr } = await supabase
    .from('referrals')
    .select('*')
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .maybeSingle();

  if (readErr) {
    logger.error({ err: readErr }, 'Failed to read referral');
    return res.status(500).json({ error: 'Something went wrong' });
  }
  if (!referral) return res.status(404).json({ error: 'Referral not found' });
  if (referral.status === 'rewarded') {
    return res.status(409).json({ error: 'That referral has already been rewarded' });
  }

  const { data, error } = await supabase
    .from('referrals')
    .update({
      status: 'rewarded',
      // There is no reward_issued_at column. 007 calls it completed_at.
      completed_at: new Date().toISOString(),
    })
    .eq('id', req.params.id)
    .eq('beautician_id', req.beautician.id)
    .select()
    .single();

  if (error) {
    logger.error({ err: error }, 'Failed to complete referral');
    return res.status(500).json({ error: 'Failed to complete referral' });
  }

  const [enriched] = await withNames([data]);

  // Log AI action. Best effort: a failed activity-feed write must not turn a
  // reward that HAS been issued into an error the salon will retry.
  try {
    await supabase.from('ai_actions').insert({
      beautician_id: req.beautician.id,
      action_type: 'referral_rewarded',
      digital_employee: 'marketing',
      summary: `Referral reward issued: £${((data.referrer_reward_cents || 0) / 100).toFixed(2)} for ${enriched.referrer_name}`,
      details: {
        referral_id: data.id,
        referrer_reward_cents: data.referrer_reward_cents,
        referred_reward_cents: data.referred_reward_cents,
      },
      confidence: 1.0,
      autonomous: true,
      outcome: 'success',
    });
  } catch (err) {
    logger.warn({ err, referral_id: data.id }, 'Referral rewarded but the activity log entry failed');
  }

  res.json({ referral: enriched });
});

export default router;
