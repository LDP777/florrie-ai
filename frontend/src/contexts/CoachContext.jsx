/**
 * CoachContext - Global Biz Coach nudge system.
 *
 * Provides useCoach() hook that any page can call to trigger a contextual
 * insight. Shows one nudge at a time, never repeats the same trigger type
 * in a session, and auto-dismisses after 12 seconds.
 *
 * Usage:
 *   const { triggerNudge } = useCoach();
 *   triggerNudge('price_edit', { treatment_name: 'Lash Lift', price_cents: 4000 });
 */

import { createContext, useContext, useState, useCallback, useRef } from 'react';
import { API_BASE } from '../lib/config.js';
import { supabase } from '../lib/supabase.js';
import logger from '../lib/logger.js';

const CoachContext = createContext(null);

// Track which triggers have already fired this session (per page load)
const shownTriggers = new Set();

export function CoachProvider({ children }) {
  const [nudge, setNudge] = useState(null); // current visible nudge
  const [loading, setLoading] = useState(false);
  const dismissTimer = useRef(null);
  const inflightTrigger = useRef(null);

  const dismiss = useCallback(() => {
    if (dismissTimer.current) clearTimeout(dismissTimer.current);
    setNudge(null);
  }, []);

  const triggerNudge = useCallback(async (trigger, context = {}) => {
    // Dedupe: don't fire same trigger type twice in one session
    const dedupKey = `${trigger}-${JSON.stringify(context).slice(0, 40)}`;
    if (shownTriggers.has(dedupKey)) return;
    if (inflightTrigger.current === dedupKey) return;
    inflightTrigger.current = dedupKey;

    try {
      setLoading(true);

      const session = await supabase?.auth?.getSession();
      const token = session?.data?.session?.access_token;
      if (!token) return;

      const res = await fetch(`${API_BASE}/api/coach/nudge`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ trigger, context }),
      });

      if (res.status === 204 || res.status === 429) return; // No nudge / rate limited
      if (!res.ok) return;

      const data = await res.json();
      if (!data.headline) return;

      shownTriggers.add(dedupKey);

      // Dismiss any current nudge, then show new one
      if (dismissTimer.current) clearTimeout(dismissTimer.current);
      setNudge(data);

      // Auto-dismiss after 12 seconds
      dismissTimer.current = setTimeout(() => {
        setNudge(null);
      }, 12000);
    } catch (err) {
      logger.error({ err }, 'Coach nudge request failed');
    } finally {
      setLoading(false);
      inflightTrigger.current = null;
    }
  }, []);

  return (
    <CoachContext.Provider value={{ nudge, loading, triggerNudge, dismiss }}>
      {children}
    </CoachContext.Provider>
  );
}

export function useCoach() {
  const ctx = useContext(CoachContext);
  if (!ctx) throw new Error('useCoach must be used inside CoachProvider');
  return ctx;
}
