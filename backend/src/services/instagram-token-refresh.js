/**
 * Instagram token refresh
 *
 * Instagram Business Login issues long-lived user tokens that expire after
 * 60 days. Meta refreshes them via graph.instagram.com/refresh_access_token,
 * valid on any token older than 24 hours. Running daily keeps every
 * connected account permanently fresh; a token younger than 24h just errors
 * quietly and succeeds on a later run.
 *
 * Runs daily from index.js. Fail-soft per beautician.
 */
import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import { fetchInstagramProfile } from '../routes/instagram-webhooks.js';

export async function refreshInstagramTokens() {
  const { data: rows, error } = await supabase
    .from('beauticians')
    .select('id, instagram_page_token')
    .not('instagram_page_token', 'is', null);

  if (error) {
    logger.warn({ err: error }, 'IG token refresh: beautician list failed');
    return { refreshed: 0, failed: 0 };
  }

  let refreshed = 0;
  let failed = 0;

  for (const b of rows || []) {
    try {
      const res = await fetch(
        `https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token&access_token=${encodeURIComponent(b.instagram_page_token)}`
      );
      const d = await res.json().catch(() => ({}));

      if (res.ok && d.access_token) {
        const { error: upErr } = await supabase
          .from('beauticians')
          .update({ instagram_page_token: d.access_token })
          .eq('id', b.id);
        if (upErr) {
          failed++;
          logger.warn({ err: upErr, beauticianId: b.id }, 'IG token refresh: save failed');
        } else {
          refreshed++;
        }
      } else {
        // Common quiet case: token under 24h old. Real failures (expired,
        // revoked) also land here and matter, so keep them visible.
        failed++;
        logger.info({ beauticianId: b.id, err: d?.error?.message || res.status }, 'IG token refresh: not refreshed');
      }
    } catch (err) {
      failed++;
      logger.warn({ err, beauticianId: b.id }, 'IG token refresh: request threw');
    }
  }

  // While we have each beautician's fresh token, fix any client still stuck on
  // the "Instagram User" placeholder (their name lookup failed when they first
  // messaged). Cheap, self-correcting, no manual DB work.
  await backfillInstagramNames(rows || []);

  return { refreshed, failed, total: (rows || []).length };
}

/**
 * Re-resolve real names for IG clients still named "Instagram User".
 * Runs daily off the token-refresh job. Fail-soft, capped per run.
 */
export async function backfillInstagramNames(beauticians) {
  let fixed = 0;
  for (const b of beauticians) {
    if (!b.instagram_page_token) continue;
    const { data: stuck } = await supabase
      .from('clients')
      .select('id, instagram_id')
      .eq('beautician_id', b.id)
      .eq('first_name', 'Instagram User')
      .not('instagram_id', 'is', null)
      .limit(50);

    for (const c of stuck || []) {
      try {
        const name = await fetchInstagramProfile(c.instagram_id, b.instagram_page_token);
        if (name && name !== 'Instagram User') {
          await supabase.from('clients').update({ first_name: name }).eq('id', c.id);
          fixed++;
        }
      } catch (err) {
        logger.warn({ err, clientId: c.id }, 'IG name backfill: one client failed');
      }
    }
  }
  if (fixed) logger.info({ fixed }, 'IG name backfill: renamed placeholder clients');
  return { fixed };
}
