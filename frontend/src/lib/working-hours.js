import { supabase } from './supabase.js';
import { API_BASE } from './config.js';
import { readAuthenticatedJson } from './authenticated-json.js';
import { apiFetch, apiErrorMessage } from './api-fetch.js';
export { effectiveHours } from '../../../backend/src/lib/effective-hours.js';

export const hoursDateLabel = date => new Date(`${date}T12:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
export const readDateHours = (from, to = from) => readAuthenticatedJson({ auth: supabase.auth,
  url: `${API_BASE}/api/working-hours?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}` });
export async function changeDateHours(method, body, date) {
  let timer, session;
  try { session = await Promise.race([supabase.auth.getSession(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Could not check your sign-in. Please try again.')), 10000); })]); }
  finally { clearTimeout(timer); }
  if (!session.data?.session?.access_token) throw new Error('Please sign in again to save your hours.');
  const response = await apiFetch(`${API_BASE}/api/working-hours/dates${date ? `/${date}` : ''}`, {
    method, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${session.data.session.access_token}` },
    ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(15000),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(apiErrorMessage(response, data, 'Could not save your hours. Please try again.'));
  return data;
}
