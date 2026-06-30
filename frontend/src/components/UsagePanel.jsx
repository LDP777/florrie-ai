import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { API_BASE } from '../lib/config.js';

/**
 * UsagePanel, Day 5 of the 2026-05-28 refactor sprint.
 *
 * One slim line: "47 of 120 messages used this month." Sits just under
 * TodaySummary on Hub. Tap to open Settings > Payments for the plan + message allowance detail. Builds
 * trust on the cost side without taking a whole card.
 *
 * Fresh tenant: shows 0 of 120 (the plan default).
 */

function getToken() {
  const key = Object.keys(localStorage).find(k => /^sb-.+-auth-token$/.test(k));
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    const parsed = JSON.parse(raw);
    return parsed?.access_token || parsed?.session?.access_token || raw;
  } catch { return null; }
}

export default function UsagePanel() {
  const navigate = useNavigate();
  const [used, setUsed] = useState(null);
  const [limit, setLimit] = useState(120);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const token = getToken();
      if (!token) { setError(true); return; }
      try {
        const res = await fetch(`${API_BASE}/api/usage/messages`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          if (!cancelled) setError(true);
          return;
        }
        const json = await res.json();
        if (cancelled) return;
        setUsed(typeof json.used === 'number' ? json.used : 0);
        setLimit(typeof json.limit === 'number' && json.limit > 0 ? json.limit : 120);
      } catch {
        if (!cancelled) setError(true);
      }
    }
    load();
    return () => { cancelled = true; };
  }, []);

  if (error && used === null) {
    // Stay quiet on errors. The panel is supportive, not a blocker.
    return null;
  }

  const safeUsed = used ?? 0;
  const pct = Math.min(100, Math.round((safeUsed / Math.max(1, limit)) * 100));
  const near = pct >= 80;
  const over = pct >= 100;

  const fillColor = over ? '#D4605C' : near ? '#E0A554' : '#C76B8A';
  const trackColor = '#F5E7EC';

  return (
    <button
      type="button"
      onClick={() => navigate('/settings?section=payments')}
      style={S.row}
      aria-label={`${safeUsed} of ${limit} messages used this month`}
    >
      <span className="material-symbols-outlined" style={S.icon}>auto_awesome_motion</span>
      <span style={S.label}>
        <strong style={S.count}>{safeUsed}</strong>
        <span style={S.muted}> of {limit} messages this month</span>
      </span>
      <span style={{ ...S.bar, background: trackColor }}>
        <span style={{ ...S.fill, width: `${pct}%`, background: fillColor }} />
      </span>
    </button>
  );
}

const S = {
  row: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    background: '#fff',
    border: '1px solid rgba(146,64,94,0.08)',
    borderRadius: 14,
    padding: '10px 14px',
    margin: '8px 0 6px',
    cursor: 'pointer',
    fontFamily: "'Plus Jakarta Sans', 'DM Sans', sans-serif",
    textAlign: 'left',
    boxShadow: '0 1px 3px rgba(146,64,94,0.05)',
    WebkitTapHighlightColor: 'transparent',
  },
  icon: {
    fontSize: 18,
    color: '#92405e',
    flexShrink: 0,
  },
  label: {
    fontSize: 12.5,
    color: '#534247',
    flex: 1,
    minWidth: 0,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  count: { color: '#1d1b19', fontWeight: 700 },
  muted: { color: '#9B8A8E' },
  bar: {
    position: 'relative',
    height: 6,
    width: 64,
    borderRadius: 999,
    overflow: 'hidden',
    flexShrink: 0,
  },
  fill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    borderRadius: 999,
    transition: 'width 0.4s ease',
  },
};
