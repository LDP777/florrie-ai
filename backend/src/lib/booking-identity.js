import { supabaseAnon } from '../config.js';

export function exactEmailPattern(email) {
  return String(email || '').trim().toLowerCase().replace(/[\\%_]/g, character => `\\${character}`);
}

/** Public booking identities never create or resolve a beautician profile. */
export async function requireBookingIdentity(req, res, next) {
  res.set('Cache-Control', 'no-store');
  const token = /^Bearer\s+(.+)$/i.exec(req.headers.authorization || '')?.[1];
  if (!token) return res.status(401).json({ code: 'booking_verification_required', error: 'Verify your email before continuing.' });
  try {
    const { data, error } = await supabaseAnon.auth.getUser(token);
    const user = data?.user;
    if (error || !user?.email || !user.email_confirmed_at) {
      return res.status(401).json({ code: 'booking_verification_required', error: 'Verify your email before continuing.' });
    }
    const email = user.email.trim().toLowerCase();
    req.bookingIdentity = { email, authId: user.id };
    // Only a verified address can identify the client or receive their records.
    req.body = { ...(req.body || {}), email, client_email: email };
    next();
  } catch {
    return res.status(503).json({ error: 'Email verification could not be checked. Please try again.' });
  }
}
