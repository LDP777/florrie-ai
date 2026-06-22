import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { API_BASE } from '../lib/config.js';
import { deDash } from '../lib/text.js';

/**
 * ActivityFeed , Day 1 of the 2026-05-28 refactor.
 *
 * Pulls /api/activity/feed and groups rows into Today / Yesterday / Earlier
 * buckets. Each row taps through to its link_to if present.
 *
 * Brand match: cream card, mauve accents, serif italic section labels,
 * same border-radius and shadow language as Hub's existing cards.
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

const TYPE_ICONS = {
  message_replied:         '💬',
  message_escalated:       '⚠️',
  booking_created:         '📅',
  booking_rescheduled:     '🔄',
  cancellation_filled:     '✨',
  waitlist_offered:        '🎟️',
  client_reactivated:      '💕',
  content_drafted:         '✍️',
  content_posted:          '📣',
  expense_logged:          '🧾',
  review_requested:        '⭐',
  campaign_drafted:        '📝',
  campaign_sent:           '📨',
  price_suggestion:        '💷',
  voice_note_processed:    '🎙️',
  client_profile_updated:  '👤',
  dormant_detected:        '👀',
  quiet_week_detected:     '🌙',
  contraindication_flagged:'🚨',
  appointment_padded:      '⏱️',
  bundle_suggested:        '🎁',
};

function iconFor(type) {
  return TYPE_ICONS[type] || '🌷';
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function bucketFor(when, now = new Date()) {
  const t = new Date(when).getTime();
  // Anything within the last 12h reads as "just happened", so keep it under
  // Today even if it crossed midnight - otherwise a "6h ago" row sits under a
  // Yesterday header and looks broken.
  if (now.getTime() - t < 12 * 60 * 60 * 1000) return 'today';
  const today = startOfDay(now).getTime();
  const yesterday = today - 24 * 60 * 60 * 1000;
  if (t >= today) return 'today';
  if (t >= yesterday) return 'yesterday';
  return 'earlier';
}

function relativeTime(when, now = new Date()) {
  const t = new Date(when);
  const diffSec = Math.round((now - t) / 1000);
  if (diffSec < 60) return 'just now';
  const diffMin = Math.round(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.round(diffMin / 60);
  if (diffHr < 12) return `${diffHr}h ago`;

  // Older than ~half a day, show day + time
  const sameYear = t.getFullYear() === now.getFullYear();
  const bucket = bucketFor(when, now);
  const time = t.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (bucket === 'yesterday') return `Yesterday at ${time}`;
  if (bucket === 'today')     return time;
  const date = t.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  });
  return `${date}, ${time}`;
}

export default function ActivityFeed({ limit = 50 }) {
  const [state, setState] = useState({ status: 'loading', rows: [] });
  // Keep the feed glanceable: show Today + Yesterday, tuck the long tail of
  // history behind a "Show earlier" toggle instead of one endless list.
  const [showEarlier, setShowEarlier] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const token = getToken();
      if (!token) { setState({ status: 'ready', rows: [] }); return; }
      try {
        const res = await fetch(`${API_BASE}/api/activity/feed?limit=${limit}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!res.ok) {
          if (!cancelled) setState({ status: 'error', rows: [] });
          return;
        }
        const json = await res.json();
        if (!cancelled) setState({ status: 'ready', rows: json.rows || [] });
      } catch {
        if (!cancelled) setState({ status: 'error', rows: [] });
      }
    }
    load();
    return () => { cancelled = true; };
  }, [limit]);

  if (state.status === 'loading') {
    return (
      <section style={F.card} aria-busy="true">
        <div style={F.header}>
          <span style={F.title}>What Florrie did</span>
        </div>
        <SkeletonRow />
        <SkeletonRow />
        <SkeletonRow />
      </section>
    );
  }

  if (state.status === 'error') {
    return (
      <section style={F.card}>
        <div style={F.header}>
          <span style={F.title}>What Florrie did</span>
        </div>
        <p style={F.errorText}>
          Couldn't load activity. Pull down to refresh, or check back in a bit.
        </p>
      </section>
    );
  }

  if (!state.rows.length) {
    return (
      <section style={F.card}>
        <div style={F.header}>
          <span style={F.title}>What Florrie did</span>
        </div>
        <div style={F.emptyState}>
          <div style={F.emptyIcon}>🌷</div>
          <p style={F.emptyText}>
            Florrie just started. Once she sends a message or spots a gap,
            you'll see it here.
          </p>
        </div>
      </section>
    );
  }

  const now = new Date();
  const groups = { today: [], yesterday: [], earlier: [] };
  state.rows.forEach(r => groups[bucketFor(r.created_at, now)].push(r));

  return (
    <section style={F.card}>
      <div style={F.header}>
        <span style={F.title}>What Florrie did</span>
        <span style={F.count}>{state.rows.length}</span>
      </div>

      {renderGroup('Today',     groups.today,     navigate, now)}
      {renderGroup('Yesterday', groups.yesterday, navigate, now)}
      {showEarlier
        ? renderGroup('Earlier', groups.earlier, navigate, now)
        : groups.earlier.length > 0 && (
            <button
              onClick={() => setShowEarlier(true)}
              style={{ width: '100%', padding: '11px 0', marginTop: 4, background: 'none', border: 'none', borderTop: '1px solid var(--border-light, #F0E8EC)', color: 'var(--accent, #92405e)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' }}
            >
              Show {groups.earlier.length} earlier
            </button>
          )}
    </section>
  );
}

function renderGroup(label, rows, navigate, now) {
  if (!rows.length) return null;
  return (
    <div style={F.group}>
      <div style={F.groupLabel}>{label}</div>
      <ul style={F.list}>
        {rows.map(r => (
          <ActivityRow key={r.id} row={r} now={now} navigate={navigate} />
        ))}
      </ul>
    </div>
  );
}

function ActivityRow({ row, now, navigate }) {
  const clickable = !!row.link_to;
  const onClick = () => { if (clickable) navigate(row.link_to); };

  return (
    <li>
      <button
        onClick={onClick}
        disabled={!clickable}
        style={{
          ...F.row,
          cursor: clickable ? 'pointer' : 'default',
          opacity: clickable ? 1 : 0.95,
        }}
      >
        <span style={F.icon} aria-hidden>{iconFor(row.type)}</span>
        <span style={F.summary}>{deDash(row.summary)}</span>
        <span style={F.time}>{relativeTime(row.created_at, now)}</span>
        {clickable && (
          <span className="material-symbols-outlined" style={F.chev} aria-hidden>
            chevron_right
          </span>
        )}
      </button>
    </li>
  );
}

function SkeletonRow() {
  return (
    <div style={{ ...F.row, cursor: 'default' }}>
      <span style={{ ...F.icon, background: '#f3ede9' }} aria-hidden />
      <span style={F.skelLine} />
      <span style={F.skelTime} />
    </div>
  );
}

const F = {
  card: {
    background: '#fff',
    borderRadius: 20,
    border: '1px solid rgba(146,64,94,0.07)',
    boxShadow: '0 1px 4px rgba(146,64,94,0.05)',
    padding: '14px 14px 8px',
    marginBottom: 16,
  },
  header: {
    display: 'flex',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    marginBottom: 10,
  },
  title: {
    fontSize: 14,
    fontWeight: 700,
    color: '#92405e',
    fontFamily: "'Noto Serif', Georgia, serif",
    fontStyle: 'italic',
  },
  count: {
    fontSize: 11,
    fontWeight: 700,
    color: '#92405e',
    background: '#ffd9e2',
    padding: '2px 8px',
    borderRadius: 20,
    letterSpacing: '0.04em',
  },
  group: { marginBottom: 6 },
  groupLabel: {
    fontSize: 10,
    fontWeight: 700,
    color: '#B5AFA8',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    margin: '8px 4px 6px',
  },
  list: {
    listStyle: 'none',
    margin: 0,
    padding: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  row: {
    width: '100%',
    display: 'grid',
    gridTemplateColumns: '24px 1fr auto 14px',
    alignItems: 'flex-start',
    gap: 10,
    padding: '10px 6px',
    background: 'none',
    border: 'none',
    borderRadius: 10,
    fontFamily: 'inherit',
    textAlign: 'left',
    color: '#1d1b19',
    WebkitTapHighlightColor: 'transparent',
  },
  icon: {
    width: 24, height: 24,
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 16,
    lineHeight: 1,
    borderRadius: 8,
  },
  summary: {
    fontSize: 13,
    fontWeight: 500,
    color: '#1d1b19',
    lineHeight: 1.35,
    minWidth: 0,
    overflowWrap: 'anywhere',
  },
  time: {
    fontSize: 11,
    color: '#9B8A8E',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  chev: {
    fontSize: 14,
    color: '#C5B8B2',
  },
  emptyState: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '20px 14px 26px',
    textAlign: 'center',
    gap: 10,
  },
  emptyIcon: { fontSize: 28, lineHeight: 1 },
  emptyText: {
    fontSize: 13,
    color: '#867277',
    lineHeight: 1.45,
    margin: 0,
    maxWidth: 280,
  },
  errorText: {
    fontSize: 13,
    color: '#9B8A8E',
    margin: '6px 4px 10px',
  },
  skelLine: {
    height: 12,
    borderRadius: 6,
    background: '#f3ede9',
    display: 'block',
    width: '78%',
  },
  skelTime: {
    height: 10,
    width: 42,
    borderRadius: 5,
    background: '#f3ede9',
    display: 'block',
  },
};
