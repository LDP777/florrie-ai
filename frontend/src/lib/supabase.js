/**
 * Supabase client + React helpers for florrie.ai.
 *
 * Centralises the client so every page imports from here
 * instead of creating its own. Provides hooks for common patterns:
 *   useBeautician()  — current user's profile + beautician_id
 *   useSupabase()    — raw client
 */
import { createClient } from '@supabase/supabase-js';
import { isIOSNative } from './platform.js';
import { useState, useEffect, useCallback } from 'react';
import logger from './logger.js';
import { API_BASE } from './config.js';
import { readAuthenticatedJson } from './authenticated-json.js';

const url = import.meta.env?.VITE_SUPABASE_URL || '';
const key = import.meta.env?.VITE_SUPABASE_ANON_KEY || '';

export const supabase = url ? createClient(url, key, isIOSNative() ? {
  auth: { flowType: 'pkce', detectSessionInUrl: false },
} : undefined) : null;

// Fetches (and caches) the current beautician row.
// The server creates a missing profile only for an approved invitation.
//
// PERFORMANCE: this hook is used by ~62 components, and several mount at once
// on a single screen. It used to call supabase.auth.getUser() per component,
// which is a real HTTP round trip to /auth/v1/user held under supabase-js's
// navigator.locks lock (5s acquire timeout). Concurrent mounts therefore
// SERIALISED behind that lock, which is the likely cause of Ellie's "takes a
// long time to load", and a lock timeout throws, which used to leave the
// calendar stuck. Two changes fix it:
//   1. getSession() instead of getUser(): reads the cached session locally and
//      only hits the network when the token actually needs refreshing.
//   2. one shared in-flight promise + a short cache, so N concurrent mounts
//      cost ONE lookup instead of N serialised ones.

let beauticianCache = null;   // last resolved row
let beauticianCacheAt = 0;
let beauticianInFlight = null;
let beauticianGeneration = 0;
const BEAUTICIAN_CACHE_MS = 30000;

// A sign-in/sign-out must not serve the previous user's row.
if (supabase) {
  supabase.auth.onAuthStateChange(() => {
    beauticianGeneration++;
    readAuthenticatedJson.invalidateSession(supabase.auth);
    beauticianCache = null;
    beauticianCacheAt = 0;
    beauticianInFlight = null;
  });
}

/**
 * Create the beauticians row on the first sign-in of a new account.
 *
 * Asking the API to do it, rather than inserting from here, is the whole point:
 * signup is the moment the welcome email sequence is supposed to start, and the
 * only code that can start it lives on the server. This insert used to happen
 * straight from the browser, so `triggerSequence('welcome', ...)` in
 * routes/auth.js sat behind an endpoint nothing has ever called and not one
 * real signup has ever had a welcome email.
 *
 * POST /api/auth/ensure-profile is idempotent: it returns the existing row for
 * anyone who already has one and only sends the welcome sequence when it
 * genuinely creates a row. So calling it on every "no row yet" path is safe.
 *
 * Profile creation goes through the server so billing and trial fields cannot
 * be supplied by a browser. A failed request remains retryable.
 */
async function createProfile(session, _user) {
  if (!session?.access_token) throw new Error('Sign in to create your profile.');
  const response = await fetch(`${API_BASE}/api/auth/ensure-profile`, {
    method: 'POST', headers: { Authorization: `Bearer ${session.access_token}`, 'Content-Type': 'application/json' },
  });
  const body = await response.json();
  if (response.status === 409 && body.code === 'ACCOUNT_DELETION_REQUESTED') return { account_deletion: body.deletion };
  if (response.status === 403 && body.code === 'SALON_ACCESS_REQUIRED') return { owner_access_approved: false };
  if (!response.ok || !body.beautician) throw new Error('Could not create your profile. Please try again.');
  // Billing/trial fields are server-owned. Never fall back to a browser insert.
  return body.beautician;
}

async function loadBeauticianOnce({ force = false, authUserId } = {}) {
  if (authUserId === null) return null;
  const generation = beauticianGeneration;
  if (!force) {
    if (beauticianCache && Date.now() - beauticianCacheAt < BEAUTICIAN_CACHE_MS) return beauticianCache;
    if (beauticianInFlight) return beauticianInFlight;
  }

  const run = (async () => {
    // supabase-js serialises auth calls behind a navigator.locks lock; under
    // concurrent load a request can have its lock STOLEN and throw AbortError.
    // Transient by definition, so retry once rather than sticking on a splash.
    let session = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        ({ data: { session } } = await supabase.auth.getSession());
        break;
      } catch (err) {
        const lockStolen = err?.name === 'AbortError' || /lock/i.test(String(err?.message || ''));
        if (lockStolen && attempt === 0) {
          await new Promise(r => setTimeout(r, 350 + Math.random() * 250));
          continue;
        }
        throw err;
      }
    }
    const user = session?.user || null;
    if (!user) return null;
    if (authUserId !== undefined && user.id !== authUserId) throw new Error('Your sign-in changed. Please try again.');

    let { data, error } = await supabase
      .from('beauticians')
      .select('*')
      .eq('auth_id', user.id)
      .maybeSingle();

    // First login after signup, create the row.
    if (!data && !error) {
      data = await createProfile(session, user);
    }
    if (error) throw error;
    return data || null;
  })();

  if (!force) beauticianInFlight = run;
  try {
    const row = await run;
    if (generation === beauticianGeneration) {
      beauticianCache = row;
      beauticianCacheAt = Date.now();
    }
    return row;
  } finally {
    if (beauticianInFlight === run) beauticianInFlight = null;
  }
}

export function useBeautician({ authUserId } = {}) {
  // Seed from the cache so a second component mounting on the same screen
  // renders immediately instead of flashing a spinner.
  const [beautician, setBeautician] = useState(beauticianCache);
  const [loading, setLoading] = useState(!beauticianCache);
  const [error, setError] = useState(null);
  const [resolvedAuthId, setResolvedAuthId] = useState(undefined);
  const waitingForIdentity = authUserId !== undefined && resolvedAuthId !== authUserId;

  const refresh = useCallback(async ({ force = true } = {}) => {
    if (authUserId !== undefined) setLoading(true);
    setError(null);
    try {
      const row = await loadBeauticianOnce({ force, authUserId });
      setBeautician(row);
      setResolvedAuthId(authUserId);
    } catch (err) {
      setError(err);
      logger.error('useBeautician error:', err);
    } finally {
      setLoading(false);
    }
  }, [authUserId]);

  useEffect(() => {
    let cancelled = false;
    if (authUserId !== undefined) setLoading(true);
    setError(null);
    (async () => {
      try {
        const row = await loadBeauticianOnce({ force: authUserId !== undefined, authUserId });
        if (!cancelled) { setBeautician(row); setResolvedAuthId(authUserId); }
      } catch (err) {
        if (!cancelled) { setError(err); setResolvedAuthId(authUserId); setBeautician(null); }
        logger.error('useBeautician error:', err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [authUserId]);

  return { beautician: waitingForIdentity ? null : beautician, loading: loading || waitingForIdentity, error, refresh };
}

// Thin wrappers so pages don't repeat beautician_id filtering.
// RLS already filters by auth, but explicit filtering is clearer
// for reads and required for inserts.

export async function fetchRows(table, beauticianId, opts = {}) {
  let q = supabase.from(table).select(opts.select || '*').eq('beautician_id', beauticianId);
  if (opts.order) q = q.order(opts.order, { ascending: opts.ascending ?? true });
  if (opts.eq) Object.entries(opts.eq).forEach(([k, v]) => { q = q.eq(k, v); });
  if (opts.limit) q = q.limit(opts.limit);
  const { data, error } = await q;
  if (error) logger.error(`fetchRows(${table}):`, error);
  return data || [];
}

// Use when an empty result must not stand in for a failed read.
export async function fetchRowsStrict(table, beauticianId, opts = {}) {
  let q = supabase.from(table).select(opts.select || '*').eq('beautician_id', beauticianId);
  if (opts.order) q = q.order(opts.order, { ascending: opts.ascending ?? true });
  if (opts.eq) Object.entries(opts.eq).forEach(([k, v]) => { q = q.eq(k, v); });
  if (opts.limit) q = q.limit(opts.limit);
  const { data, error } = await q;
  if (error) throw error;
  return data || [];
}

export async function insertRow(table, row) {
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) { logger.error(`insertRow(${table}):`, error); throw error; }
  return data;
}

export async function updateRow(table, id, updates) {
  const { data, error } = await supabase.from(table).update(updates).eq('id', id).select().single();
  if (error) { logger.error(`updateRow(${table}):`, error); throw error; }
  return data;
}

export async function deleteRow(table, id) {
  const { error } = await supabase.from(table).delete().eq('id', id);
  if (error) { logger.error(`deleteRow(${table}):`, error); throw error; }
  return true;
}
