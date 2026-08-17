/**
 * Where this API is reachable from the outside.
 *
 * routes/calendar.js could always work this out from the request it was
 * answering. notifications.js cannot: it builds links inside a background send
 * with no request anywhere near it, so the address has to come from the
 * environment.
 *
 * It matters more than a helper usually does. If none of these is set, the
 * confirmation quietly falls back to the old "Manage or reschedule" wording
 * and the calendar link disappears — the exact failure that is invisible
 * until a client says she could not find her booking. So it says so at boot,
 * once, rather than waiting to be discovered.
 */
import logger from './logger.js';

const ENV_NAMES = ['PUBLIC_API_URL', 'API_BASE_URL', 'BACKEND_URL'];

/** The configured public base, or null. No trailing slash. */
export function apiPublicBase() {
  for (const name of ENV_NAMES) {
    const v = process.env[name];
    if (v) return v.replace(/\/$/, '');
  }
  return null;
}

/** The same thing, but falling back to the request when one is to hand. */
export function publicBaseFor(req) {
  const env = apiPublicBase();
  if (env) return env;
  const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'https').split(',')[0];
  const host = req.headers['x-forwarded-host'] || req.get('host');
  return `${proto}://${host}`;
}

if (!apiPublicBase()) {
  logger.warn(
    { need: ENV_NAMES },
    'No public API url configured. Booking confirmations will go out without an "add to your calendar" link. Set PUBLIC_API_URL to this API\'s https address.',
  );
}
