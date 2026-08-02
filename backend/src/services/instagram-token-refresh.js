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
import * as Sentry from '@sentry/node';
import { supabase } from '../config.js';
import logger from '../lib/logger.js';
import { fetchInstagramIdentity } from '../routes/instagram-webhooks.js';

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
        // These two cases used to share one logger.info line, which is how a
        // DEAD token looked identical to a perfectly healthy one. Ellie's
        // token expired on 21 June; outbound Instagram was dead for five weeks
        // while the app said "Connected" and this line said "not refreshed"
        // at info level every single night. Split them.
        failed++;
        const message = d?.error?.message || '';
        const code = d?.error?.code;
        const type = d?.error?.type || '';

        // Benign: Meta refuses to refresh a token younger than 24 hours. It
        // succeeds on a later run and needs no attention at all.
        const tooNew = /24 hours|too new|not .*old enough/i.test(message);

        // Real death: Meta reports OAuthException / code 190 for an expired,
        // revoked or invalidated token. Nothing here can fix it. Only the
        // beautician reconnecting Instagram can, so a human has to be told.
        const dead = !tooNew && (code === 190 || /OAuthException/i.test(type) || res.status === 401);

        if (tooNew) {
          logger.info({ beauticianId: b.id, reason: message }, 'IG token refresh: skipped, token under 24h old');
        } else if (dead) {
          logger.error({ beauticianId: b.id, code, type, reason: message },
            'INSTAGRAM TOKEN DEAD: refresh rejected, this account cannot send until she reconnects');
          Sentry.captureMessage('Instagram token dead, reconnection required', {
            level: 'error',
            tags: { area: 'instagram', check: 'token_refresh' },
            extra: { beauticianId: b.id, metaCode: code, metaType: type, metaMessage: message, httpStatus: res.status },
          });
        } else {
          // Unknown refusal. Not provably fatal, but not routine either.
          logger.warn({ beauticianId: b.id, code, type, reason: message || res.status },
            'IG token refresh: not refreshed, unrecognised response');
        }
      }
    } catch (err) {
      failed++;
      logger.warn({ err, beauticianId: b.id }, 'IG token refresh: request threw');
    }
  }

  // While we have each beautician's fresh token, fix any client still stuck on
  // the "Instagram User" placeholder, and pick up the @handles we never had a
  // working token to fetch. Cheap, self-correcting, no manual DB work.
  await backfillInstagramNames(rows || []);

  return { refreshed, failed, total: (rows || []).length };
}

/**
 * Re-resolve identities for Instagram clients we could not name at the time.
 *
 * Two gaps get filled: clients still called "Instagram User" (their lookup
 * failed when they first messaged) and clients with no @handle on file (the
 * handle was only ever used as a fallback display name and then discarded).
 *
 * Runs daily off the token-refresh job. Fail-soft, capped per run. While a
 * beautician's token is expired every lookup returns nothing and this loop
 * quietly does nothing, then starts working on the first run after she
 * reconnects. That is the whole design: no manual catch-up step.
 */
export async function backfillInstagramNames(beauticians) {
  let fixed = 0;
  let handled = 0;
  for (const b of beauticians) {
    if (!b.instagram_page_token) continue;

    // Anyone missing a real name OR missing a handle, in one query. If
    // migration 016 has not been applied the username half is not there yet,
    // so fall back to the original name-only sweep rather than stopping.
    let { data: stuck, error } = await supabase
      .from('clients')
      .select('id, instagram_id, first_name, instagram_username')
      .eq('beautician_id', b.id)
      .not('instagram_id', 'is', null)
      .or('first_name.eq."Instagram User",instagram_username.is.null')
      .limit(50);

    if (error) {
      logger.warn({ err: error, beauticianId: b.id }, 'IG backfill: falling back to names only (migration 016 applied?)');
      ({ data: stuck, error } = await supabase
        .from('clients')
        .select('id, instagram_id, first_name')
        .eq('beautician_id', b.id)
        .eq('first_name', 'Instagram User')
        .not('instagram_id', 'is', null)
        .limit(50));
    }
    if (error) {
      logger.warn({ err: error, beauticianId: b.id }, 'IG backfill: client query failed');
      continue;
    }

    for (const c of stuck || []) {
      try {
        const { name, username } = await fetchInstagramIdentity(c.instagram_id, b.instagram_page_token);
        const patch = {};
        if (name && name !== 'Instagram User' && c.first_name === 'Instagram User') patch.first_name = name;
        if (username && !c.instagram_username) patch.instagram_username = username;
        if (!Object.keys(patch).length) continue;

        const { error: upErr } = await supabase.from('clients').update(patch).eq('id', c.id);
        if (upErr) {
          logger.warn({ err: upErr, clientId: c.id }, 'IG backfill: update failed');
          continue;
        }
        if (patch.first_name) fixed++;
        if (patch.instagram_username) handled++;
      } catch (err) {
        logger.warn({ err, clientId: c.id }, 'IG backfill: one client failed');
      }
    }
  }
  if (fixed || handled) logger.info({ fixed, handled }, 'IG backfill: filled in names and handles');
  return { fixed, handled };
}
