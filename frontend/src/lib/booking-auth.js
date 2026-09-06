import { createBookingAuthFetch } from './booking-auth-fetch.js';
import { createClient } from '@supabase/supabase-js';
// Separate storage and session from the salon owner's application login.
export const bookingAuth = createClient(import.meta.env.VITE_SUPABASE_URL, import.meta.env.VITE_SUPABASE_ANON_KEY, {
  global: { fetch: createBookingAuthFetch() },
  auth: { storageKey: 'florrie-booking-auth', detectSessionInUrl: false, persistSession: true },
});
export async function bookingHeaders() {
  const { data, error } = await bookingAuth.auth.getSession();
  if (error || !data.session?.access_token) return { 'Content-Type': 'application/json' };
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${data.session.access_token}` };
}
