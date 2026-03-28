/**
 * Supabase client + React helpers for Florrie.
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

/** Is this a dev/demo session with no Supabase? */
export const isDevMode = !supabase;

// ── useBeautician ──────────────────────────────────────────
// Fetches (and caches) the current beautician row.
// On first signup the row won't exist yet — `ensureProfile`
// creates it from auth metadata.

export function useBeautician() {
  const [beautician, setBeautician] = useState(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    if (isDevMode) {
      setBeautician(DEV_BEAUTICIAN);
      setLoading(false);
      return;
    }
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

// ── Quick query helpers ────────────────────────────────────
// Thin wrappers so pages don't repeat beautician_id filtering.
// RLS already filters by auth, but explicit filtering is clearer
// for reads and required for inserts.

export async function fetchRows(table, beauticianId, opts = {}) {
  if (isDevMode) return [];
  let q = supabase.from(table).select(opts.select || '*').eq('beautician_id', beauticianId);
  if (opts.order) q = q.order(opts.order, { ascending: opts.ascending ?? true });
  if (opts.eq) Object.entries(opts.eq).forEach(([k, v]) => { q = q.eq(k, v); });
  if (opts.limit) q = q.limit(opts.limit);
  const { data, error } = await q;
  if (error) logger.error(`fetchRows(${table}):`, error);
  return data || [];
}

export async function insertRow(table, row) {
  if (isDevMode) return { ...row, id: crypto.randomUUID() };
  const { data, error } = await supabase.from(table).insert(row).select().single();
  if (error) { logger.error(`insertRow(${table}):`, error); throw error; }
  return data;
}

export async function updateRow(table, id, updates) {
  if (isDevMode) return updates;
  const { data, error } = await supabase.from(table).update(updates).eq('id', id).select().single();
  if (error) { logger.error(`updateRow(${table}):`, error); throw error; }
  return data;
}

export async function deleteRow(table, id) {
  if (isDevMode) return true;
  const { error } = await supabase.from(table).delete().eq('id', id);
  if (error) { logger.error(`deleteRow(${table}):`, error); throw error; }
  return true;
}

// ── Dev mode mock data (seeded from Ellie's real data) ─────
const DEV_BEAUTICIAN = {
  id: 'dev-beautician-id',
  auth_id: 'dev-auth-id',
  first_name: 'Ellie',
  last_name: '',
  business_name: 'Ellindigo Brows & Beauty',
  email: 'demo@florrie.ai',
  booking_slug: 'ellindigo',
  onboarding_completed_at: '2026-03-01T12:00:00Z',
  working_hours: {
    mon: { start: '11:00', end: '15:00' },
    tue: { start: '11:00', end: '19:00' },
    wed: { start: '11:00', end: '18:00' },
    thu: { start: '11:00', end: '19:00' },
    fri: { start: '10:00', end: '17:00' },
    sat: null,
    sun: null,
  },
  tone_model: {
    greeting_style: 'Hey girl, / Hey lovely, / Morning girl,',
    sign_off_style: 'xx / xxx',
    emoji_usage: 'Light — one heart emoji max, at end of message',
    formality: 'Very casual, warm, breezy',
    key_phrases: ['no worries', 'yes please if you can', "I've moved this for you"],
    avoid: ['Hi there', 'Hello', 'Best regards', 'Absolutely!', "I'd be happy to"],
    max_sentences: 2,
    corrections_count: 0,
  },
  confidence_threshold: 0.85,
  auto_reply_enabled: true,
  subscription_status: 'trial',
  trial_ends_at: new Date(Date.now() + 14 * 86400000).toISOString(),
  brand_color: '#C4A882',
  notification_prefs: {
    booking_confirmed: { email: true, push: true },
    booking_cancelled: { email: true, push: true },
    ai_escalation: { email: true, push: true },
    payment_received: { email: true, push: true },
    weekly_digest: { email: true, push: false },
  },
  client_reminder_prefs: {
    booking_confirmation: true,
    reminder_24h: true,
    reminder_1h: false,
    aftercare_followup: true,
    rebook_nudge: true,
    rebook_nudge_days: 7,
    channel: 'whatsapp',
    fallback_channel: 'email',
  },
};

// Ellie's real treatment menu for dev mode
export const DEV_TREATMENTS = [
  { id: 'dev-t1', name: 'Lamination & Hybrid Dye', price_cents: 4500, duration_minutes: 60, category: 'brows', is_active: true },
  { id: 'dev-t2', name: 'Lamination & Tint', price_cents: 4000, duration_minutes: 60, category: 'brows', is_active: true },
  { id: 'dev-t3', name: 'Lamination Maintenance / Tint', price_cents: 2500, duration_minutes: 45, category: 'brows', is_active: true },
  { id: 'dev-t4', name: 'Lamination Maintenance / Hybrid Dye', price_cents: 3000, duration_minutes: 45, category: 'brows', is_active: true },
  { id: 'dev-t5', name: 'HD Brows', price_cents: 2500, duration_minutes: 45, category: 'brows', is_active: true },
  { id: 'dev-t6', name: 'Hybrid Brows', price_cents: 3000, duration_minutes: 45, category: 'brows', is_active: true },
  { id: 'dev-t7', name: 'Ombre Brows (Semi-Permanent)', price_cents: 25000, duration_minutes: 180, category: 'brows', is_active: true, description: 'Includes 6-week top up' },
  { id: 'dev-t8', name: 'Combination Brows (Semi-Permanent)', price_cents: 30000, duration_minutes: 180, category: 'brows', is_active: true, description: 'Includes 6-week top up' },
  { id: 'dev-t9', name: 'Colour Boost 3-6 Months', price_cents: 5000, duration_minutes: 120, category: 'brows', is_active: true },
  { id: 'dev-t10', name: 'Colour Boost 8 Months', price_cents: 8000, duration_minutes: 120, category: 'brows', is_active: true },
  { id: 'dev-t11', name: 'Colour Boost 12 Months', price_cents: 10000, duration_minutes: 120, category: 'brows', is_active: true },
  { id: 'dev-t12', name: 'Colour Boost 18 Months', price_cents: 15000, duration_minutes: 120, category: 'brows', is_active: true },
  { id: 'dev-t13', name: 'Lash Lift & Tint', price_cents: 4000, duration_minutes: 60, category: 'lashes', is_active: true },
  { id: 'dev-t14', name: 'Lip Wax', price_cents: 600, duration_minutes: 10, category: 'other', is_active: true },
  { id: 'dev-t15', name: 'Brow Jelly Mask', price_cents: 700, duration_minutes: 15, category: 'brows', is_active: true },
];

// Mock clients for dev mode
export const DEV_CLIENTS = [
  { id: 'dev-c1', first_name: 'Shauna', last_name: '', email: '', phone: '', status: 'active', total_visits: 8, total_spend_cents: 32000, last_visit_at: '2026-03-10T14:00:00Z' },
  { id: 'dev-c2', first_name: 'Daisy', last_name: 'S', email: '', phone: '', status: 'active', total_visits: 12, total_spend_cents: 54000, last_visit_at: '2026-02-17T11:00:00Z' },
  { id: 'dev-c3', first_name: 'Jasmin', last_name: '', email: '', phone: '', status: 'active', total_visits: 5, total_spend_cents: 22500, last_visit_at: '2026-03-02T10:00:00Z' },
];
