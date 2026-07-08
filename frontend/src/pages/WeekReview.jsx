/**
 * Week in Review - the story-shaped, screenshot-worthy card.
 *
 * Landed from the Sunday-evening push. One Florrie-branded card (maroon,
 * Playfair, bloom mark, florrie.ai footer) built to be screenshotted into a
 * beautician group chat, which is the point: every share is an advert.
 */
import { useState, useEffect } from 'react';
import { useBeautician, supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';

const fmtGbp = pence => {
  const pounds = pence / 100;
  return Number.isInteger(pounds) ? `£${pounds.toLocaleString('en-GB')}` : `£${pounds.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

export default function WeekReview() {
  const { beautician, loading: bLoading } = useBeautician();
  const [stats, setStats] = useState(null);
  const [error, setError] = useState(false);
  const [shared, setShared] = useState(false);

  useEffect(() => {
    if (bLoading || !beautician) return;
    let cancelled = false;
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const res = await fetch(`${API_BASE}/api/activity/week-review`, {
          headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
        });
        if (!res.ok) throw new Error(`week-review ${res.status}`);
        const d = await res.json();
        if (!cancelled) setStats(d);
      } catch (err) {
        logger.error('week review load failed:', err);
        if (!cancelled) setError(true);
      }
    })();
    return () => { cancelled = true; };
  }, [beautician, bLoading]);

  async function share() {
    const text = stats
      ? `My week with Florrie: ${stats.messages_answered} messages answered, ${stats.gaps_filled} gaps filled, about ${stats.hours_saved} hours saved 🌸 florrie.ai`
      : 'My week with Florrie 🌸 florrie.ai';
    try {
      if (navigator.share) {
        await navigator.share({ text });
        setShared(true);
      } else {
        await navigator.clipboard?.writeText(text);
        setShared(true);
      }
    } catch { /* user closed the sheet, fine */ }
  }

  if (bLoading || (!stats && !error)) return <PageLoader />;

  const rows = stats ? [
    { n: stats.messages_answered, label: 'messages answered for you' },
    { n: stats.gaps_filled, label: 'calendar gaps filled' },
    { n: stats.brought_back, label: 'clients brought back' },
    { n: stats.bookings_taken, label: 'bookings taken on your page' },
  ].filter(r => r.n > 0) : [];

  return (
    <div style={S.page}>
      <h1 style={S.title}>Your week</h1>
      <p style={S.sub}>Screenshot it. Send it to the group chat. We don't mind.</p>

      {error && (
        <div style={S.errorCard}>Could not load your week just now. Try again in a moment.</div>
      )}

      {stats && (
        <div style={S.card}>
          <div style={S.bloomRow}>
            <span style={S.bloom}>🌸</span>
            <span style={S.cardBrand}>Florrie</span>
          </div>
          <p style={S.cardKicker}>WEEK WITH FLORRIE · {stats.from.slice(8)}–{stats.to.slice(8, 10)}</p>
          <h2 style={S.cardHeadline}>
            {stats.total_handled > 0
              ? `${stats.total_handled} things handled while you did the brows`
              : 'A quiet week on the front desk'}
          </h2>

          <div style={S.statList}>
            {rows.map(r => (
              <div key={r.label} style={S.statRow}>
                <span style={S.statNum}>{r.n}</span>
                <span style={S.statLabel}>{r.label}</span>
              </div>
            ))}
            {stats.takings_pence > 0 && (
              <div style={S.statRow}>
                <span style={S.statNum}>{fmtGbp(stats.takings_pence)}</span>
                <span style={S.statLabel}>taken this week</span>
              </div>
            )}
            <div style={{ ...S.statRow, borderBottom: 'none' }}>
              <span style={S.statNum}>~{stats.hours_saved}h</span>
              <span style={S.statLabel}>of admin you never had to do</span>
            </div>
          </div>

          <div style={S.cardFooter}>florrie.ai · the AI front desk for beauty pros</div>
        </div>
      )}

      {stats && (
        <button onClick={share} style={S.shareBtn}>
          {shared ? 'Shared 🌸' : 'Share your week'}
        </button>
      )}
    </div>
  );
}

const S = {
  page: {
    padding: '20px 16px var(--scroll-pad-bottom)', maxWidth: 480, margin: '0 auto',
    fontFamily: "var(--font-body, 'Plus Jakarta Sans', 'DM Sans', sans-serif)",
  },
  title: {
    fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)",
    fontSize: 26, fontWeight: 600, color: 'var(--text-primary, #241B17)', margin: '40px 0 4px',
  },
  sub: { fontSize: 13.5, color: 'var(--text-secondary, #8B6F5E)', margin: '0 0 18px' },
  errorCard: {
    background: 'var(--danger-bg, #FDF0EF)', color: 'var(--danger-text, #C62828)',
    borderRadius: 12, padding: 14, fontSize: 13.5,
  },
  card: {
    background: 'linear-gradient(150deg, #9b4d6e 0%, #7c3350 55%, #5f2038 100%)',
    borderRadius: 24, padding: '22px 22px 16px', color: '#fff',
    boxShadow: '0 10px 34px rgba(124,51,80,0.35)',
  },
  bloomRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 14 },
  bloom: { fontSize: 20 },
  cardBrand: {
    fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)",
    fontSize: 17, fontWeight: 600, letterSpacing: '0.01em',
  },
  cardKicker: {
    fontSize: 10.5, fontWeight: 700, letterSpacing: '0.14em',
    color: 'rgba(255,255,255,0.65)', margin: '0 0 6px',
  },
  cardHeadline: {
    fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)",
    fontSize: 24, fontWeight: 600, lineHeight: 1.22, margin: '0 0 18px',
  },
  statList: { display: 'flex', flexDirection: 'column' },
  statRow: {
    display: 'flex', alignItems: 'baseline', gap: 12,
    padding: '11px 0', borderBottom: '1px solid rgba(255,255,255,0.14)',
  },
  statNum: {
    fontSize: 22, fontWeight: 800, fontVariantNumeric: 'tabular-nums',
    minWidth: 64, textAlign: 'right',
  },
  statLabel: { fontSize: 13.5, color: 'rgba(255,255,255,0.85)' },
  cardFooter: {
    marginTop: 16, paddingTop: 12, borderTop: '1px solid rgba(255,255,255,0.14)',
    fontSize: 11, color: 'rgba(255,255,255,0.6)', textAlign: 'center', letterSpacing: '0.04em',
  },
  shareBtn: {
    width: '100%', marginTop: 16, padding: '15px 0', borderRadius: 14, border: 'none',
    background: 'var(--accent, #92405E)', color: '#fff', fontSize: 15, fontWeight: 700,
    cursor: 'pointer', fontFamily: 'inherit',
  },
};
