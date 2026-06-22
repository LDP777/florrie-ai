/**
 * Compliance - landing page for Guardian agent.
 *
 * Covers the two pillars of compliance for UK beauty professionals:
 *   1. Patch tests  - legally required 48h before chemical treatments
 *   2. Consultation forms - informed consent for all treatments
 *
 * Relevant for all treatment types: brows, lashes, nails, waxing, facials, etc.
 * Shows live stats + links to full management pages for each pillar.
 */
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBeautician, fetchRows } from '../lib/supabase.js';

// Guardian avatar (inline, no external deps)
function GuardianAvatar({ size = 52 }) {
  return (
    <svg viewBox="0 0 56 56" width={size} height={size}>
      <circle cx="28" cy="28" r="28" fill="#C9A96E"/>
      <circle cx="28" cy="27" r="13" fill="#FFD5B0"/>
      <circle cx="24.5" cy="25" r="1.8" fill="#3D2B1A"/>
      <circle cx="31.5" cy="25" r="1.8" fill="#3D2B1A"/>
      <circle cx="25.2" cy="24.2" r="0.6" fill="#fff"/>
      <circle cx="32.2" cy="24.2" r="0.6" fill="#fff"/>
      <path d="M23 29 Q28 33.5 33 29" stroke="#3D2B1A" strokeWidth="1.4" fill="none" strokeLinecap="round"/>
      <path d="M42 6 L50 9 L50 16 Q50 22 42 25 Q34 22 34 16 L34 9 Z" fill="#fff" opacity="0.9"/>
      <path d="M42 8 L48 10.5 L48 16 Q48 21 42 23.5 Q36 21 36 16 L36 10.5 Z" fill="#C9A96E" opacity="0.3"/>
      <path d="M38 16 L41 19 L46 13" stroke="#5BA97B" strokeWidth="2" fill="none" strokeLinecap="round" strokeLinejoin="round"/>
      <path d="M9 10 L10 13 L13 13 L10.5 15 L11.5 18 L9 16 L6.5 18 L7.5 15 L5 13 L8 13Z" fill="#fff" opacity="0.9"/>
      <path d="M6 5 L6.5 6.5 L8 6.5 L7 7.5 L7.5 9 L6 8 L4.5 9 L5 7.5 L4 6.5 L5.5 6.5Z" fill="#fff" opacity="0.7"/>
    </svg>
  );
}

function MIcon({ name, size = 20, color, style: s }) {
  return (
    <span className="material-symbols-outlined" style={{ fontSize: size, color, ...s }}>
      {name}
    </span>
  );
}

export default function Compliance() {
  const navigate = useNavigate();
  const { beautician, loading } = useBeautician();

  const [patchStats, setPatchStats] = useState(null);
  const [formStats,  setFormStats]  = useState(null);
  const [fetching,   setFetching]   = useState(true);

  useEffect(() => {
    if (loading) return;
    if (!beautician) {
      setFetching(false);
      return;
    }
    async function load() {
      // The /api/patch-tests/stats and /api/consultation-forms/stats endpoints
      // were never shipped; compute the figures directly from Supabase below.
      const pt = null;
      const cf = null;
      // Fallback: count rows directly from Supabase if stats endpoint doesn't exist
      if (!pt) {
        const rows = await fetchRows('patch_tests', beautician.id, {}).catch(() => []);
        const now  = new Date();
        setPatchStats({
          pending:           rows.filter(r => r.status === 'pending' || r.status === 'needs_test').length,
          done_this_month:   rows.filter(r => r.status === 'completed' && new Date(r.updated_at).getMonth() === now.getMonth()).length,
          expired:           rows.filter(r => r.status === 'expired').length,
          total:             rows.length,
        });
      } else {
        setPatchStats(pt);
      }
      if (!cf) {
        const rows = await fetchRows('consultation_forms', beautician.id, {}).catch(() => []);
        // Only the form count is reliably derivable here. Signature/response
        // tracking lives elsewhere, so don't fabricate those figures.
        setFormStats({
          total_forms: rows.length,
        });
      } else {
        setFormStats(cf);
      }
      setFetching(false);
    }
    load();
  }, [beautician, loading]);

  const totalPending = (patchStats?.pending || 0) + (formStats?.pending_signatures || 0);

  return (
    <div style={S.page}>
      {/* Hero */}
      <div style={S.hero}>
        <GuardianAvatar size={52} />
        <div style={S.heroText}>
          <h1 style={S.heroTitle}>Compliance</h1>
          <p style={S.heroSub}>Patch tests &amp; consultation forms, keeping you and your clients protected.</p>
        </div>
        {totalPending > 0 && (
          <span style={S.pendingBadge}>{totalPending} pending</span>
        )}
      </div>

      {/* What this covers */}
      <div style={S.explainerCard}>
        <MIcon name="info" size={16} color="#C9A96E" />
        <p style={S.explainerText}>
          Required for <strong>all beauty professionals</strong> - whether you do brows, lashes, nails, waxing, facials or anything else. UK law requires patch tests 48h before chemical treatments. Consultation forms protect you legally for every client.
        </p>
      </div>

      {/* Patch Tests card */}
      <button style={S.pillarCard} onClick={() => navigate('/patch-tests')}>
        <div style={S.pillarHeader}>
          <div style={{ ...S.pillarIcon, background: 'var(--success-bg, #EDF7F0)' }}>
            <MIcon name="vaccines" size={22} color="#5BA97B" />
          </div>
          <div style={S.pillarInfo}>
            <div style={S.pillarTitle}>Patch Tests</div>
            <div style={S.pillarDesc}>48h allergy checks before chemical treatments</div>
          </div>
          <MIcon name="chevron_right" size={20} color="#C5B8B2" />
        </div>

        {fetching ? (
          <div style={S.statsLoading}>Loading…</div>
        ) : (
          <div style={S.statsRow}>
            <div style={S.statItem}>
              <span style={{ ...S.statNum, color: patchStats?.pending > 0 ? '#E85D75' : 'var(--success, #5BA97B)' }}>
                {patchStats?.pending ?? '-'}
              </span>
              <span style={S.statLabel}>Pending</span>
            </div>
            <div style={S.statDivider} />
            <div style={S.statItem}>
              <span style={S.statNum}>{patchStats?.done_this_month ?? '-'}</span>
              <span style={S.statLabel}>Done this month</span>
            </div>
            <div style={S.statDivider} />
            <div style={S.statItem}>
              <span style={{ ...S.statNum, color: patchStats?.expired > 0 ? '#F59E0B' : 'var(--success, #5BA97B)' }}>
                {patchStats?.expired ?? '-'}
              </span>
              <span style={S.statLabel}>Expired</span>
            </div>
          </div>
        )}

        {patchStats?.pending > 0 && (
          <div style={S.alertBanner}>
            <MIcon name="warning" size={14} color="#E85D75" />
            <span style={S.alertText}>{patchStats.pending} client{patchStats.pending > 1 ? 's' : ''} need a patch test before their next appointment</span>
          </div>
        )}
      </button>

      {/* Consultation Forms card */}
      <button style={S.pillarCard} onClick={() => navigate('/consultation-forms')}>
        <div style={S.pillarHeader}>
          <div style={{ ...S.pillarIcon, background: '#F3F0FA' }}>
            <MIcon name="assignment" size={22} color="#7B6BA8" />
          </div>
          <div style={S.pillarInfo}>
            <div style={S.pillarTitle}>Consultation Forms</div>
            <div style={S.pillarDesc}>Informed consent for every treatment type</div>
          </div>
          <MIcon name="chevron_right" size={20} color="#C5B8B2" />
        </div>

        {fetching ? (
          <div style={S.statsLoading}>Loading…</div>
        ) : (
          <div style={S.statsRow}>
            <div style={S.statItem}>
              <span style={S.statNum}>{formStats?.total_forms ?? '-'}</span>
              <span style={S.statLabel}>
                {(formStats?.total_forms || 0) === 1 ? 'Form created' : 'Forms created'}
              </span>
            </div>
          </div>
        )}
      </button>

      {/* Quick-build tip */}
      <div style={S.tipCard}>
        <MIcon name="lightbulb" size={16} color="#C9A96E" />
        <p style={S.tipText}>
          <strong>Tip:</strong> Build a consultation form for each treatment category - one for chemical treatments, one for facials, one for nails. Clients complete it once and it's saved to their profile.
        </p>
      </div>
    </div>
  );
}

const S = {
  page: {
    padding: '16px 16px 24px',
    maxWidth: 480, margin: '0 auto',
    fontFamily: "'Plus Jakarta Sans', 'DM Sans', sans-serif",
    color: 'var(--text-primary, #1d1b19)',
    minHeight: '100vh',
    background: 'var(--bg, #fef8f4)',
  },

  hero: {
    display: 'flex', alignItems: 'flex-start', gap: 14,
    background: 'linear-gradient(135deg, #fdf5e8 0%, #fff 70%)',
    borderRadius: 20, padding: '16px 14px',
    border: '1px solid rgba(201,169,110,0.2)',
    marginBottom: 14,
    position: 'relative',
  },
  heroText: { flex: 1 },
  heroTitle: {
    fontSize: 22, fontWeight: 700, margin: '0 0 4px',
    fontFamily: "'Noto Serif', Georgia, serif", fontStyle: 'italic',
    color: 'var(--text-primary, #1d1b19)',
  },
  heroSub: { fontSize: 13, color: 'var(--text-muted, #867277)', margin: 0, lineHeight: 1.5 },
  pendingBadge: {
    position: 'absolute', top: 14, right: 14,
    fontSize: 11, fontWeight: 700, color: '#fff',
    background: '#E85D75', padding: '4px 10px', borderRadius: 20,
  },

  explainerCard: {
    display: 'flex', gap: 10, alignItems: 'flex-start',
    background: '#fffbf2', borderRadius: 14,
    border: '1px solid rgba(201,169,110,0.2)',
    padding: '12px 14px', marginBottom: 14,
  },
  explainerText: { margin: 0, fontSize: 12, color: 'var(--text-muted, #867277)', lineHeight: 1.55 },

  pillarCard: {
    width: '100%', textAlign: 'left',
    background: 'var(--bg-card, #fff)', borderRadius: 18,
    border: '1px solid rgba(199,107,138,0.1)',
    padding: '16px 14px', marginBottom: 12,
    cursor: 'pointer', fontFamily: 'inherit',
    WebkitTapHighlightColor: 'transparent',
    boxShadow: '0 2px 12px rgba(0,0,0,0.04)',
    boxSizing: 'border-box',
    display: 'block',
  },
  pillarHeader: {
    display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14,
  },
  pillarIcon: {
    width: 44, height: 44, borderRadius: 12,
    display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0,
  },
  pillarInfo: { flex: 1 },
  pillarTitle: { fontSize: 15, fontWeight: 700, color: 'var(--text-primary, #1d1b19)', marginBottom: 2 },
  pillarDesc:  { fontSize: 12, color: 'var(--text-muted, #B5AFA8)', lineHeight: 1.4 },

  statsRow: { display: 'flex', alignItems: 'center', gap: 0, marginBottom: 4 },
  statItem: { flex: 1, textAlign: 'center' },
  statNum:  { display: 'block', fontSize: 22, fontWeight: 700, color: 'var(--text-primary, #1d1b19)', lineHeight: 1.1 },
  statLabel:{ display: 'block', fontSize: 10, color: 'var(--text-muted, #B5AFA8)', marginTop: 3, lineHeight: 1.3 },
  statDivider: { width: 1, height: 36, background: 'var(--border-light, #EDE9E4)', flexShrink: 0 },
  statsLoading: { fontSize: 12, color: 'var(--text-muted, #B5AFA8)', padding: '8px 0' },

  alertBanner: {
    display: 'flex', alignItems: 'center', gap: 8,
    background: '#FFF0F3', borderRadius: 10, padding: '9px 12px', marginTop: 10,
  },
  alertText: { fontSize: 12, color: '#E85D75', fontWeight: 500 },

  tipCard: {
    display: 'flex', gap: 10, alignItems: 'flex-start',
    background: '#fffbf2', borderRadius: 14,
    border: '1px solid rgba(201,169,110,0.15)',
    padding: '12px 14px', marginTop: 4,
  },
  tipText: { margin: 0, fontSize: 12, color: 'var(--text-muted, #867277)', lineHeight: 1.55 },
};
