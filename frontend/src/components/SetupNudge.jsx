import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import Icon, { iconName } from './ui/Icon';

/**
 * SetupNudge
 *
 * Slim card at the top of Hub pointing at /setup while setup is incomplete.
 * Renders nothing when everything is done, on error, or after the user
 * dismisses it for the session. Counts the checks the status endpoint can
 * answer on its own (the signed-messages check lives on the Setup page,
 * it needs a second WhatsApp call).
 */

const DISMISS_KEY = 'florrie_setup_nudge_dismissed';

async function authedGet(path) {
  const { data: { session } } = await supabase.auth.getSession();
  const res = await fetch(`${API_BASE}${path}`, {
    headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
  });
  if (!res.ok) throw new Error(`GET ${path} ${res.status}`);
  return res.json();
}

// The essentials only, matching SetupHub. Card payments, deposits and an
// imported list are extras: counting them meant "5 of 12 done" on the Today
// page forever for any salon without Stripe.
function countChecks(s) {
  const ch = s?.channels || {};
  const checks = [
    !!s?.business?.name,
    !!s?.business?.hours,
    !!s?.business?.booking_slug,
    (s?.services?.treatments_count || 0) > 0,
    !!s?.services?.has_prices,
    !!(ch.whatsapp || ch.instagram || ch.sms),
    !!ch.auto_reply,
    (s?.protection?.forms_built || 0) > 0,
    (s?.protection?.forms_attached || 0) > 0,
  ];
  return { done: checks.filter(Boolean).length, total: checks.length };
}

// Hidden for a week, not a session. Tapping the cross every morning is not a
// preference anybody expressed twice.
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

export default function SetupNudge() {
  const navigate = useNavigate();
  const [counts, setCounts] = useState(null);
  const [dismissed, setDismissed] = useState(() => {
    try {
      const until = Number(localStorage.getItem(DISMISS_KEY) || 0);
      return until > Date.now();
    } catch { return false; }
  });

  useEffect(() => {
    let cancelled = false;
    authedGet('/api/setup/status')
      .then((s) => { if (!cancelled) setCounts(countChecks(s)); })
      .catch(() => { /* quiet, the nudge just stays hidden */ });
    return () => { cancelled = true; };
  }, []);

  function dismiss(e) {
    e.stopPropagation();
    setDismissed(true);
    try { localStorage.setItem(DISMISS_KEY, String(Date.now() + SNOOZE_MS)); } catch { /* no-op */ }
  }

  if (dismissed || !counts || counts.done >= counts.total) return null;

  return (
    <div
      style={S.card}
      onClick={() => navigate('/setup')}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') navigate('/setup'); }}
      aria-label={`Setup: ${counts.done} of ${counts.total} done. Finish setting up.`}
    >
      <Icon name={iconName('checklist')} inline style={S.icon} />
      <span style={S.text}>
        Setup: {counts.done} of {counts.total} done
        <span style={S.cta}> · Finish setting up ›</span>
      </span>
      <button type="button" onClick={dismiss} style={S.close} aria-label="Hide for now">&times;</button>
    </div>
  );
}

const S = {
  card: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    background: 'var(--tone-1, #fbf1ea)',
    borderRadius: 22,
    padding: '11px 12px 11px 14px',
    marginBottom: 14,
    cursor: 'pointer',
    WebkitTapHighlightColor: 'transparent',
  },
  icon: {
    fontSize: 18,
    color: 'var(--accent, #92405e)',
    flexShrink: 0,
  },
  text: {
    flex: 1,
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text-secondary, #574A42)',
    minWidth: 0,
  },
  cta: {
    color: 'var(--accent, #92405e)',
    fontWeight: 700,
  },
  close: {
    border: 'none',
    background: 'none',
    fontSize: 20,
    lineHeight: 1,
    color: 'var(--text-muted, #6B5D54)',
    cursor: 'pointer',
    padding: '2px 6px',
    flexShrink: 0,
    fontFamily: 'inherit',
  },
};
