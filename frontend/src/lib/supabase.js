/**
 * Supabase client + React helpers for florrie.ai.
 *
 * Centralises the client so every page imports from here
 * instead of creating its own. Provides hooks for common patterns:
 *   useBeautician()  — current user's profile + beautician_id
 *   useSupabase()    — raw client
 */
import { createClient } from '@supabase/supabase-js';
import { useState, useEffect, useCallback } from 'react';
import logger from './logger.js';

const url = import.meta.env?.VITE_SUPABASE_URL || '';
const key = import.meta.env?.VITE_SUPABASE_ANON_KEY || '';

export const supabase = url ? createClient(url, key) : null;

// Fetches (and caches) the current beautician row.
// On first signup the row won't exist yet — `ensureProfile`
// creates it from auth metadata.

export function useBeautician() {
  const [beautician, setBeautician] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) { setLoading(false); return; }

      let { data, error } = await supabase
        .from('beauticians')
        .select('*')
        .eq('auth_id', user.id)
        .maybeSingle();

      // First login after signup — create the row
      if (!data && !error) {
        const { data: created, error: createErr } = await supabase
          .from('beauticians')
          .insert({
            auth_id: user.id,
            email: user.email,
            first_name: user.user_metadata?.first_name || '',
            last_name: user.user_metadata?.last_name || '',
          })
          .select()
          .single();
        if (createErr) logger.error('Failed to create beautician profile:', createErr);
        data = created;
      }

      setBeautician(data);
    } catch (err) {
      logger.error('useBeautician error:', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { refresh(); }, [refresh]);

  return { beautician, loading, refresh };
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
