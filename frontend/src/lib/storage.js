/**
 * Supabase Storage: one place that knows which bucket a file belongs in, how to
 * put it there, and how to read it back.
 *
 * Why this file exists
 * -------------------
 * Four screens each rolled their own upload, and all four handled failure by
 * ignoring it. Two of them fell back to `URL.createObjectURL(file)`, which
 * renders perfectly on screen and points at nothing the moment the tab reloads.
 * So a salon could scan a receipt, watch the thumbnail appear, save the expense,
 * and have stored a dead reference. Nobody noticed for as long as the app has
 * existed, because a silent failure that looks like success is invisible.
 *
 * Buckets
 * -------
 *   content-images   PUBLIC.  Only for images that get PUBLISHED to Instagram.
 *                             Instagram fetches the image server side when a
 *                             post goes out, so an outside party has to be able
 *                             to reach it. Nothing else belongs here.
 *   florrie-private  PRIVATE. Receipts (financial documents) and before/after
 *                             treatment photos (someone else's face, taken in a
 *                             salon). Readable only through a signed URL.
 *   logos            PUBLIC.  Business logo, shown on the public booking page.
 *
 * Paths
 * -----
 * Every object is `{beauticianId}/{kind}/{file}`. The storage.objects RLS
 * policies match `(storage.foldername(name))[1]` against the caller's own
 * beautician id, so the first segment is load bearing, not decoration. Build
 * paths with objectPath() rather than by hand.
 *
 * Storing a reference
 * -------------------
 * For a PRIVATE object, store the PATH in the database column, never a URL.
 * A signed URL carries an expiry inside it: sign for an hour, write that string
 * into `expenses.receipt_url`, read the row back next week and you have a long
 * dead link with no way to renew it. The path never expires, and signing is a
 * local call against a bucket the caller already has rights to. So: store the
 * path, sign on read.
 *
 * Rows written before this change may hold a full public URL (or a `blob:` URL,
 * from the fallbacks described above). resolveRef() understands all three, so a
 * legacy row that points at a real object still resolves, and one that points
 * at a blob resolves to null instead of rendering a broken image.
 */
import { supabase } from './supabase.js';
import logger from './logger.js';

/** Published to Instagram. Public on purpose. */
export const PUBLIC_BUCKET = 'content-images';
/** Receipts and client treatment photos. Signed URLs only. */
export const PRIVATE_BUCKET = 'florrie-private';
/** Business logo, shown on the public booking page. */
export const LOGO_BUCKET = 'logos';

const KNOWN_BUCKETS = new Set([PUBLIC_BUCKET, PRIVATE_BUCKET, LOGO_BUCKET]);

/** How long a signed URL lives. Long enough to browse a screen, short enough to matter. */
export const SIGNED_URL_SECONDS = 60 * 60;

/**
 * A filename safe to put in a storage key.
 *
 * Supabase rejects some characters outright and silently mangles others, and
 * the original name comes straight off a phone camera roll. Nothing here is a
 * secret: the path already contains a timestamp and the user's own id.
 */
function safeName(name) {
  const cleaned = String(name || 'file')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+/, '')
    .slice(-80);
  return cleaned || 'file';
}

/**
 * Build an RLS-compatible object path.
 *
 * @param {string} beauticianId  first segment, matched by the storage policies
 * @param {string} kind          folder: 'receipts', 'before-after', 'gallery'
 * @param {string} fileName      original filename, sanitised here
 */
export function objectPath(beauticianId, kind, fileName) {
  return `${beauticianId}/${kind}/${Date.now()}-${safeName(fileName)}`;
}

/**
 * Turn a storage error into something worth showing a salon owner.
 *
 * The raw messages are things like "new row violates row-level security
 * policy", which tells her nothing she can act on.
 */
function friendlyMessage(err) {
  const raw = String(err?.message || err || '');
  if (/maximum allowed size|payload too large|entity too large|413/i.test(raw)) {
    return 'That image is too large. Keep it under 20MB and try again.';
  }
  if (/row-level security|unauthor|forbidden|jwt|401|403/i.test(raw)) {
    return 'Could not save that photo, your session may have expired. Sign out, sign back in, and try again.';
  }
  if (/bucket not found|not found|404/i.test(raw)) {
    return 'Could not save that photo, storage is not set up correctly. Please contact support.';
  }
  if (/already exists|duplicate|409/i.test(raw)) {
    return 'A file with that name is already saved. Rename it and try again.';
  }
  if (/failed to fetch|network|timeout|offline/i.test(raw)) {
    return 'Could not reach storage. Check your connection and try again.';
  }
  return 'Could not save that photo. Please try again.';
}

/**
 * Upload a file and return the path it landed at.
 *
 * Throws on failure, deliberately. Every caller used to swallow this, so the
 * only way to make a failure visible is to make ignoring it take effort.
 *
 * @returns {Promise<{ bucket: string, path: string }>}
 */
export async function uploadFile({ bucket, path, file, upsert = false }) {
  if (!KNOWN_BUCKETS.has(bucket)) {
    throw new Error(`Unknown storage bucket: ${bucket}`);
  }
  if (!supabase) {
    throw new Error('Not connected. Check your internet connection and try again.');
  }
  const { error } = await supabase.storage.from(bucket).upload(path, file, {
    contentType: file?.type || undefined,
    upsert,
  });
  if (error) {
    logger.error('Storage upload failed', { bucket, path, message: error.message });
    const wrapped = new Error(friendlyMessage(error));
    wrapped.cause = error;
    throw wrapped;
  }
  return { bucket, path };
}

/**
 * Work out what a stored value actually points at.
 *
 * Handles, in order:
 *   - a bare object path, which is what everything written from now on stores
 *   - a full Supabase storage URL, public or signed, from a row written by the
 *     old code. The bucket named in the URL wins, because that is where the
 *     object would be if it exists.
 *   - a `blob:` or `data:` URL, which is a row the old fallback poisoned. There
 *     is no object behind it, so this returns null rather than a broken image.
 *   - any other absolute URL, which is not ours to sign.
 *
 * @returns {{ bucket: string, path: string } | null}
 */
export function resolveRef(value, defaultBucket) {
  if (!value || typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw) return null;
  if (/^(blob:|data:)/i.test(raw)) return null;

  if (!/^https?:\/\//i.test(raw)) {
    const path = raw.replace(/^\/+/, '');
    if (!path) return null;
    return { bucket: defaultBucket, path };
  }

  let pathname;
  try {
    pathname = new URL(raw).pathname;
  } catch {
    return null;
  }
  const marker = '/storage/v1/object/';
  const at = pathname.indexOf(marker);
  if (at === -1) return null;

  let rest = pathname.slice(at + marker.length).replace(/^(public|sign|authenticated)\//, '');
  const slash = rest.indexOf('/');
  if (slash === -1) return null;

  const bucket = decodeURIComponent(rest.slice(0, slash));
  const path = decodeURIComponent(rest.slice(slash + 1));
  if (!bucket || !path) return null;
  return { bucket, path };
}

/**
 * A URL that will render a PRIVATE object in an <img>, or null.
 *
 * Never throws. A thumbnail that cannot be signed is a thumbnail that does not
 * appear, which is the correct outcome and not worth breaking a screen over.
 * The reason still reaches the log.
 */
export async function signedUrl(value, { bucket = PRIVATE_BUCKET, expiresIn = SIGNED_URL_SECONDS } = {}) {
  const ref = resolveRef(value, bucket);
  if (!ref || !supabase) return null;
  try {
    const { data, error } = await supabase.storage
      .from(ref.bucket)
      .createSignedUrl(ref.path, expiresIn);
    if (error) {
      logger.warn('Could not sign storage URL', { bucket: ref.bucket, path: ref.path, message: error.message });
      return null;
    }
    return data?.signedUrl || null;
  } catch (err) {
    logger.warn('Could not sign storage URL', { bucket: ref.bucket, path: ref.path, err });
    return null;
  }
}

/**
 * Sign several stored references at once.
 *
 * @param {Array<[string, string]>} entries pairs of [key, storedValue]
 * @returns {Promise<Record<string, string>>} key to signed URL, missing where signing failed
 */
export async function signedUrlMap(entries, opts) {
  const results = await Promise.all(
    entries.map(async ([key, value]) => [key, await signedUrl(value, opts)])
  );
  const out = {};
  for (const [key, url] of results) if (url) out[key] = url;
  return out;
}

/**
 * A URL for a PUBLIC object. Used for the two things that genuinely are public:
 * an image Instagram has to fetch, and the logo on the booking page.
 */
export function publicUrl(value, { bucket = PUBLIC_BUCKET } = {}) {
  const ref = resolveRef(value, bucket);
  if (!ref || !supabase) return null;
  const { data } = supabase.storage.from(ref.bucket).getPublicUrl(ref.path);
  return data?.publicUrl || null;
}
