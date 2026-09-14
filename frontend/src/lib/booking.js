/**
 * Canonical public base for client-facing links. ALWAYS use this for shareable
 * booking links — never window.location.origin, which is capacitor://localhost
 * inside the iOS app and produces a dead link the client can't open.
 */
export const PUBLIC_BASE = import.meta.env.VITE_PUBLIC_URL || 'https://florrie.ai';

export function bookingUrl(slug) {
  return slug ? `${PUBLIC_BASE}/book/${slug}` : PUBLIC_BASE;
}
