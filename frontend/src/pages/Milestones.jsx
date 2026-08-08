/**
 * Milestones - the moments worth a screenshot.
 *
 * Landed from a milestone push (first £1k week, client 100, fully booked
 * day). Florrie-branded cards with a bloom on arrival; each is built to be
 * screenshotted into a group chat.
 */
import { useState, useEffect } from 'react';
import { useBeautician, supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import { bloom } from '../lib/bloom.js';
import Icon from '../components/ui/Icon';

function describe(m) {
  const key = m.key || '';
  if (key === 'first_1k_week') {
    const pounds = m.payload?.pence ? `£${Math.floor(m.payload.pence / 100).toLocaleString('en-GB')}` : '£1,000+';
    return { big: pounds, label: 'your first £1,000 week' };
  }
  const clientMatch = key.match(/^clients_(\d+)$/);
  if (clientMatch) return { big: clientMatch[1], label: 'clients on your books' };
  if (key.startsWith('fully_booked:')) {
    const day = key.slice('fully_booked:'.length);
    const label = day ? new Date(`${day}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long' }) : 'a full day';
    return { big: '100%', label: `fully booked, ${label}` };
  }
  return { big: '🌸', label: key.replace(/[_:]/g, ' ') };
}

export default function Milestones() {
  const { beautician, loading: bLoading } = useBeautician();
  const [milestones, setMilestones] = useState(null);
  const [error, setError] = useState(false);
  const [shared, setShared] = useState(null);

  useEffect(() => {
    if (bLoading || !beautician) return;
    let cancelled = false;
    (async () => {
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const res = await fetch(`${API_BASE}/api/activity/milestones`, {
          headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
        });
        if (!res.ok) throw new Error(`milestones ${res.status}`);
        const d = await res.json();
        if (cancelled) return;
        setMilestones(d.milestones || []);
        if ((d.milestones || []).length > 0) {
          // The bloom: this page only opens on good news.
          try { bloom(); } catch { /* decorative only */ }
        }
      } catch (err) {
        logger.error('milestones load failed:', err);
        if (!cancelled) setError(true);
      }
    })();
    return () => { cancelled = true; };
  }, [beautician, bLoading]);

  async function share(m, i) {
    const d = describe(m);
    const text = `${d.big} ${d.label} 🌸 kept by florrie.ai`;
    try {
      if (navigator.share) await navigator.share({ text });
      else await navigator.clipboard?.writeText(text);
      setShared(i);
    } catch { /* sheet closed */ }
  }

  if (bLoading || (milestones === null && !error)) return <PageLoader />;

  return (
    <div style={S.page}>
      <h1 style={S.title}>Milestones</h1>
      <p style={S.sub}>The moments worth telling the group chat about.</p>

      {error && <div style={S.errorCard}>Could not load milestones just now.</div>}

      {milestones?.length === 0 && !error && (
        <div style={S.emptyCard}>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--text-secondary, #574A42)', lineHeight: 1.5 }}>
            Nothing yet, and that is exactly right: milestones only count from the
            moment Florrie started watching. The first £1,000 week, the first fully
            booked day, client number 100. They land here, with a push, as they happen.
          </p>
        </div>
      )}

      {(milestones || []).map((m, i) => {
        const d = describe(m);
        return (
          <div key={`${m.key}-${i}`} style={S.card}>
            <div style={S.bloomRow}>
              <span style={{ fontSize: 18 }}><Icon name="flower" size={15} /></span>
              <span style={S.cardBrand}>Florrie</span>
              <span style={S.cardDate}>
                {new Date(m.at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
              </span>
            </div>
            <div style={S.big}>{d.big}</div>
            <div style={S.label}>{d.label}</div>
            <div style={S.cardFooter}>
              <span style={{ fontSize: 10.5, color: 'rgba(255,255,255,0.6)', letterSpacing: '0.04em' }}>florrie.ai</span>
              <button onClick={() => share(m, i)} style={S.shareBtn}>
                {shared === i ? 'Shared 🌸' : 'Share'}
              </button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

const S = {
  page: {
    padding: '20px 16px var(--scroll-pad-bottom)', maxWidth: 480, margin: '0 auto',
    fontFamily: "var(--font-body, 'Plus Jakarta Sans', sans-serif)",
  },
  title: {
    fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)",
    fontSize: 26, fontWeight: 600, color: 'var(--text-primary, #241B17)', margin: '40px 0 4px',
  },
  sub: { fontSize: 13.5, color: 'var(--text-secondary, #574A42)', margin: '0 0 18px' },
  errorCard: { background: 'var(--danger-bg, #F7E4E4)', color: 'var(--danger-text, #9E2B32)', borderRadius: 12, padding: 14, fontSize: 13.5 },
  emptyCard: { background: 'var(--tone-1, #fbf1ea)', borderRadius: 20, padding: 18 },
  card: {
    background: 'linear-gradient(150deg, #9b4d6e 0%, #7c3350 55%, #5f2038 100%)',
    borderRadius: 24, padding: '18px 20px 14px', color: '#fff', marginBottom: 14,
    boxShadow: '0 8px 28px rgba(124,51,80,0.30)',
  },
  bloomRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 },
  cardBrand: { fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)", fontSize: 15, fontWeight: 600 },
  cardDate: { marginLeft: 'auto', fontSize: 11, color: 'rgba(255,255,255,0.6)' },
  big: {
    fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)",
    fontSize: 44, fontWeight: 700, lineHeight: 1.05, letterSpacing: '-0.01em',
  },
  label: { fontSize: 14.5, color: 'rgba(255,255,255,0.85)', margin: '4px 0 14px' },
  cardFooter: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between',
    paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.14)',
  },
  shareBtn: {
    padding: '7px 18px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.4)',
    background: 'rgba(255,255,255,0.12)', color: '#fff', fontSize: 12.5, fontWeight: 700,
    cursor: 'pointer', fontFamily: 'inherit',
  },
};
