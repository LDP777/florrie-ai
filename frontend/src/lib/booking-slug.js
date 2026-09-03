/**
 * The booking link, made the same way everywhere.
 *
 * Onboarding and Settings each had their own cleaner and they disagreed:
 * Settings kept leading and doubled dashes that onboarding stripped, so the
 * same typed name gave two different links. And nothing anywhere stopped a
 * salon claiming florrie.ai/book/admin, /book/florrie or /book/a.
 */
export const SLUG_MIN = 3;
export const SLUG_MAX = 40;

/** Paths and brand words no salon may take as its own link. */
export const RESERVED_SLUGS = new Set([
  'admin', 'api', 'app', 'book', 'booking', 'bookings', 'calendar', 'client', 'clients',
  'florrie', 'florrieai', 'florrie-ai', 'help', 'inbox', 'login', 'logout', 'manage',
  'me', 'new', 'null', 'onboarding', 'pricing', 'privacy', 'settings', 'signup', 'support',
  'terms', 'test', 'training', 'undefined', 'www',
]);

/** Lower case, letters, digits and single dashes, no dash at either end. */
export function cleanSlug(raw) {
  return String(raw || '')
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, SLUG_MAX)
    .replace(/-$/, '');
}

/**
 * Why a slug cannot be used, in the owner's words, or null when it can.
 * @param {string} raw as typed
 */
export function slugProblem(raw) {
  const slug = cleanSlug(raw);
  if (!slug) return 'Your booking link cannot be empty.';
  if (slug.length < SLUG_MIN) return `Your booking link needs at least ${SLUG_MIN} characters.`;
  if (RESERVED_SLUGS.has(slug)) return 'That word is reserved. Try your salon name or your name and town.';
  if (/^\d+$/.test(slug)) return 'Your booking link needs some letters in it, not just numbers.';
  return null;
}

/** A first suggestion from the business name, then the first name. */
export function suggestSlug({ businessName, firstName }) {
  const fromBusiness = cleanSlug(businessName);
  if (fromBusiness && !slugProblem(fromBusiness)) return fromBusiness;
  const fromName = cleanSlug(firstName ? `${firstName}-beauty` : '');
  if (fromName && !slugProblem(fromName)) return fromName;
  return '';
}

/** The same link with a short suffix, for when the first choice is taken. */
export function withSuffix(slug, n = 3) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  let tail = '';
  for (let i = 0; i < n; i++) tail += alphabet[Math.floor(Math.random() * alphabet.length)];
  return `${cleanSlug(slug).slice(0, SLUG_MAX - n - 1)}-${tail}`;
}

export function isUniqueViolation(err) {
  const code = err?.code || err?.details || '';
  const msg = String(err?.message || '').toLowerCase();
  return code === '23505' || msg.includes('duplicate') || msg.includes('unique');
}
