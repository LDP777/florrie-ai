/**
 * Feedback — Client satisfaction surveys & NPS tracking.
 *
 * After each appointment, florrie.ai can auto-send a quick survey.
 * This page shows results, trends, and lets Ellie manage her
 * feedback settings. Happy clients get nudged to leave a Google review.
 */
import { useState, useEffect } from 'react';
import { useBeautician, fetchRows, updateRow } from '../lib/supabase.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';

const QUESTIONS_PREVIEW = [
  'How would you rate your experience? (1-5 stars)',
  'Any comments or feedback?',
  'How likely are you to recommend us? (0-10)',
];

export default function Feedback() {
  const { beautician, loading: bLoading } = useBeautician();
  const [tab, setTab] = useState('overview');
  const [responses, setResponses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [settings, setSettings] = useState({
    autoSend: true,
    sendAfter: '2h',
    channel: 'whatsapp',
    askReview: true,
    reviewThreshold: 4,
    reviewLink: 'https://g.page/ellindigo/review',
  });
  const [settingsDirty, setSettingsDirty] = useState(false);

  // Fetch feedback responses
  useEffect(() => {
    if (bLoading || !beautician) return;
    setLoading(true);
    fetchRows('feedback_responses', beautician.id, { order: 'date', ascending: false })
      .then(rows => {
        if (rows && rows.length > 0) {
          setResponses(rows);
        } else {
          setResponses([]);
        }
      })
      .catch(err => {
        logger.error({ err }, 'Failed to load feedback');
        setError('Failed to load feedback data');
      })
      .finally(() => setLoading(false));
  }, [beautician, bLoading]);

  // Load feedback settings from beautician config
  useEffect(() => {
    if (!beautician) return;
    if (beautician.feedback_settings) {
      setSettings(prev => ({ ...prev, ...beautician.feedback_settings }));
    }
  }, [beautician]);

  // Save settings when changed
  async function saveSettings() {
    if (!beautician) { setSettingsDirty(false); return; }
    try {
      await updateRow('beauticians', beautician.id, { feedback_settings: settings });
      setSettingsDirty(false);
    } catch (err) {
      logger.error({ err }, 'Failed to save feedback settings');
    }
  }

  function updateSetting(key, value) {
    setSettings(prev => ({ ...prev, [key]: value }));
    setSettingsDirty(true);
  }

  if (bLoading || loading) return <PageLoader />;
  if (error) return <ErrorCard message={error} />;
  const avgRating = (responses.reduce((s, r) => s + r.rating, 0) / responses.length).toFixed(1);
  const avgNps = (responses.reduce((s, r) => s + r.nps, 0) / responses.length).toFixed(1);
  const responseRate = 82; // mock
  const reviewCount = responses.filter(r => r.reviewed).length;

  // NPS breakdown
  const promoters = responses.filter(r => r.nps >= 9).length;
  const passives = responses.filter(r => r.nps >= 7 && r.nps <= 8).length;
  const detractors = responses.filter(r => r.nps <= 6).length;
  const npsScore = Math.round(((promoters - detractors) / responses.length) * 100);

  // Rating distribution
  const ratingDist = [5, 4, 3, 2, 1].map(r => ({
    stars: r,
    count: responses.filter(resp => resp.rating === r).length,
    pct: Math.round((responses.filter(resp => resp.rating === r).length / responses.length) * 100),
  }));

  return (
    <div style={S.page}>
      <h1 style={S.title}>Client Feedback</h1>

      {/* Tabs */}
      <div style={S.tabs}>
        {['overview', 'responses', 'settings'].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ ...S.tab, ...(tab === t ? S.tabActive : {}) }}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* Overview */}
      {tab === 'overview' && responses.length === 0 && (
        <EmptyState title="No feedback yet" description="Responses will appear here once clients complete their surveys." />
      )}
      {tab === 'overview' && responses.length > 0 && (
        <>
          {/* Stats */}
          <div style={S.statsGrid}>
            <div style={S.statCard}>
              <span style={{ ...S.statValue, color: 'var(--accent, #C76B8A)' }}>⭐ {avgRating}</span>
              <span style={S.statLabel}>Avg Rating</span>
            </div>
            <div style={S.statCard}>
              <span style={{ ...S.statValue, color: npsScore >= 50 ? 'var(--success, #5BA97B)' : 'var(--gold-text, #8A7245)' }}>{npsScore}</span>
              <span style={S.statLabel}>NPS Score</span>
            </div>
            <div style={S.statCard}>
              <span style={{ ...S.statValue, color: 'var(--text-secondary, #7A756F)' }}>{responseRate}%</span>
              <span style={S.statLabel}>Response Rate</span>
            </div>
            <div style={S.statCard}>
              <span style={{ ...S.statValue, color: 'var(--success, #5BA97B)' }}>{reviewCount}</span>
              <span style={S.statLabel}>Google Reviews</span>
            </div>
          </div>

          {/* Rating distribution */}
          <div style={S.card}>
            <h3 style={S.cardTitle}>Rating Distribution</h3>
            {ratingDist.map(r => (
              <div key={r.stars} style={S.distRow}>
                <span style={S.distStars}>{r.stars}★</span>
                <div style={S.distBarBg}>
                  <div style={{ ...S.distBarFill, width: `${r.pct}%`, background: r.stars >= 4 ? 'var(--accent, #C76B8A)' : r.stars === 3 ? 'var(--gold, #C9A96E)' : 'var(--accent, #C76B8A)' }} />
                </div>
                <span style={S.distCount}>{r.count}</span>
              </div>
            ))}
          </div>

          {/* NPS breakdown */}
          <div style={S.card}>
            <h3 style={S.cardTitle}>NPS Breakdown</h3>
            <div style={S.npsRow}>
              {[
                { label: 'Promoters (9-10)', count: promoters, colour: 'var(--success, #5BA97B)' },
                { label: 'Passives (7-8)', count: passives, colour: 'var(--gold, #C9A96E)' },
                { label: 'Detractors (0-6)', count: detractors, colour: 'var(--accent, #C76B8A)' },
              ].map(g => (
                <div key={g.label} style={S.npsSegment}>
                  <div style={{ ...S.npsDot, background: g.colour }} />
                  <div style={S.npsInfo}>
                    <span style={S.npsCount}>{g.count}</span>
                    <span style={S.npsLabel}>{g.label}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Recent highlights */}
          <div style={S.card}>
            <h3 style={S.cardTitle}>Recent Comments</h3>
            {responses.filter(r => r.comment).slice(0, 3).map(r => (
              <div key={r.id} style={S.commentCard}>
                <div style={S.commentHeader}>
                  <span style={S.commentClient}>{r.client_name}</span>
                  <span style={S.commentRating}>{'★'.repeat(r.rating)}</span>
                </div>
                <p style={S.commentText}>"{r.comment}"</p>
                <span style={S.commentMeta}>{r.treatment_name} · {formatDate(r.date)}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Responses */}
      {tab === 'responses' && (
        <div style={S.responsesList}>
          {responses.map(r => (
            <div key={r.id} style={S.responseCard}>
              <div style={S.responseHeader}>
                <div style={S.responseLeft}>
                  <div style={S.avatar}>{r.client_name[0]}</div>
                  <div style={S.responseInfo}>
                    <span style={S.responseClient}>{r.client_name}</span>
                    <span style={S.responseTreatment}>{r.treatment_name}</span>
                  </div>
                </div>
                <div style={S.responseRight}>
                  <span style={S.responseStars}>{'★'.repeat(r.rating)}{'☆'.repeat(5 - r.rating)}</span>
                  <span style={S.responseDate}>{formatDate(r.date)}</span>
                </div>
              </div>
              {r.comment && <p style={S.responseComment}>{r.comment}</p>}
              <div style={S.responseMeta}>
                <span style={S.npsTag}>NPS: {r.nps}</span>
                {r.reviewed && <span style={S.reviewedTag}>✓ Left Google review</span>}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Settings */}
      {tab === 'settings' && (
        <div style={S.settingsContainer}>
          <div style={S.card}>
            <h3 style={S.cardTitle}>Survey Settings</h3>

            <div style={S.settingRow}>
              <div style={S.settingInfo}>
                <span style={S.settingLabel}>Auto-send surveys</span>
                <span style={S.settingDesc}>Send feedback request after each appointment</span>
              </div>
              <button style={{ ...S.toggle, background: settings.autoSend ? 'var(--accent, #C76B8A)' : '#E0DCD8' }} onClick={() => updateSetting('autoSend', !settings.autoSend)}>
                <div style={{ ...S.toggleDot, transform: settings.autoSend ? 'translateX(18px)' : 'translateX(2px)' }} />
              </button>
            </div>

            <div style={S.fieldLabel}>Send After</div>
            <div style={S.chipRow}>
              {['1h', '2h', '24h', '48h'].map(t => (
                <button key={t} onClick={() => updateSetting('sendAfter', t)} style={{ ...S.chip, ...(settings.sendAfter === t ? S.chipActive : {}) }}>
                  {t === '1h' ? '1 hour' : t === '2h' ? '2 hours' : t === '24h' ? '24 hours' : '48 hours'}
                </button>
              ))}
            </div>

            <div style={S.fieldLabel}>Channel</div>
            <div style={S.chipRow}>
              {['whatsapp', 'sms', 'email'].map(ch => (
                <button key={ch} onClick={() => updateSetting('channel', ch)} style={{ ...S.chip, ...(settings.channel === ch ? S.chipActive : {}) }}>
                  {ch === 'whatsapp' ? '💬 WhatsApp' : ch === 'sms' ? '📱 SMS' : '✉️ Email'}
                </button>
              ))}
            </div>
          </div>

          <div style={S.card}>
            <h3 style={S.cardTitle}>Google Review Nudge</h3>

            <div style={S.settingRow}>
              <div style={S.settingInfo}>
                <span style={S.settingLabel}>Ask happy clients to review</span>
                <span style={S.settingDesc}>Clients who rate {settings.reviewThreshold}+ stars get a Google Review link</span>
              </div>
              <button style={{ ...S.toggle, background: settings.askReview ? 'var(--accent, #C76B8A)' : '#E0DCD8' }} onClick={() => updateSetting('askReview', !settings.askReview)}>
                <div style={{ ...S.toggleDot, transform: settings.askReview ? 'translateX(18px)' : 'translateX(2px)' }} />
              </button>
            </div>

            <div style={S.fieldLabel}>Minimum rating to nudge</div>
            <div style={S.chipRow}>
              {[3, 4, 5].map(r => (
                <button key={r} onClick={() => updateSetting('reviewThreshold', r)} style={{ ...S.chip, ...(settings.reviewThreshold === r ? S.chipActive : {}) }}>
                  {r}+ stars
                </button>
              ))}
            </div>

            <div style={S.fieldLabel}>Google Review Link</div>
            <input style={S.input} value={settings.reviewLink} onChange={e => updateSetting('reviewLink', e.target.value)} placeholder="https://g.page/your-business/review" />
          </div>

          {settingsDirty && (
            <button onClick={saveSettings} style={{ width: '100%', padding: '12px 0', background: 'var(--accent, #C76B8A)', color: '#fff', border: 'none', borderRadius: 12, fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', marginBottom: 12 }}>
              Save Settings
            </button>
          )}

          {/* Survey preview */}
          <div style={S.card}>
            <h3 style={S.cardTitle}>Survey Preview</h3>
            <div style={S.previewCard}>
              <p style={S.previewGreeting}>Hey Shauna! 💕</p>
              <p style={S.previewText}>Thanks for coming in today! Would love to know how your Lamination & Hybrid Dye went:</p>
              {QUESTIONS_PREVIEW.map((q, i) => (
                <div key={i} style={S.previewQ}>
                  <span style={S.previewQNum}>{i + 1}.</span>
                  <span style={S.previewQText}>{q}</span>
                </div>
              ))}
              <span style={S.previewSignoff}>— Ellie xx</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function formatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

const S = {
  page: { padding: '20px 16px 32px', fontFamily: '"DM Sans", -apple-system, sans-serif', maxWidth: 480, margin: '0 auto' },
  title: { fontSize: 22, fontWeight: 700, color: 'var(--text, #2D2A26)', margin: '0 0 16px' },

  tabs: { display: 'flex', gap: 8, marginBottom: 16 },
  tab: { flex: 1, padding: '10px 0', border: 'none', borderRadius: 10, background: 'var(--card, #fff)', color: 'var(--text-muted, #B5AFA8)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  tabActive: { background: 'var(--accent, #C76B8A)', color: 'var(--bg-card, #fff)' },

  // Stats
  statsGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 16 },
  statCard: { background: 'var(--card, #fff)', borderRadius: 12, padding: '14px 10px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4 },
  statValue: { fontSize: 22, fontWeight: 700 },
  statLabel: { fontSize: 11, color: 'var(--text-muted, #B5AFA8)' },

  // Cards
  card: { background: 'var(--card, #fff)', borderRadius: 14, padding: 16, marginBottom: 12 },
  cardTitle: { fontSize: 15, fontWeight: 700, color: 'var(--text, #2D2A26)', margin: '0 0 12px' },

  // Rating distribution
  distRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 },
  distStars: { fontSize: 13, fontWeight: 600, color: 'var(--accent, #C76B8A)', width: 28 },
  distBarBg: { flex: 1, height: 8, borderRadius: 4, background: 'var(--border, var(--border, #EDE9E4))' },
  distBarFill: { height: 8, borderRadius: 4, transition: 'width 0.3s' },
  distCount: { fontSize: 12, color: 'var(--text-muted, #B5AFA8)', width: 20, textAlign: 'right' },

  // NPS
  npsRow: { display: 'flex', gap: 12 },
  npsSegment: { flex: 1, display: 'flex', alignItems: 'center', gap: 8 },
  npsDot: { width: 10, height: 10, borderRadius: 5, flexShrink: 0 },
  npsInfo: { display: 'flex', flexDirection: 'column', gap: 1 },
  npsCount: { fontSize: 16, fontWeight: 700, color: 'var(--text, #2D2A26)' },
  npsLabel: { fontSize: 10, color: 'var(--text-muted, #B5AFA8)' },

  // Comments
  commentCard: { padding: '10px 0', borderBottom: '1px solid var(--border, var(--border, #EDE9E4))' },
  commentHeader: { display: 'flex', justifyContent: 'space-between', marginBottom: 4 },
  commentClient: { fontSize: 13, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  commentRating: { fontSize: 12, color: 'var(--accent, #C76B8A)' },
  commentText: { fontSize: 13, color: 'var(--text-secondary, #7A756F)', lineHeight: 1.4, margin: '4px 0', fontStyle: 'italic' },
  commentMeta: { fontSize: 11, color: 'var(--text-muted, #B5AFA8)' },

  // Responses
  responsesList: { display: 'flex', flexDirection: 'column', gap: 10 },
  responseCard: { background: 'var(--card, #fff)', borderRadius: 14, padding: 14 },
  responseHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' },
  responseLeft: { display: 'flex', gap: 10, alignItems: 'center' },
  avatar: { width: 32, height: 32, borderRadius: 16, background: 'var(--accent-light, #FFF0F3)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 600, color: 'var(--accent, #C76B8A)', flexShrink: 0 },
  responseInfo: { display: 'flex', flexDirection: 'column', gap: 2 },
  responseClient: { fontSize: 14, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  responseTreatment: { fontSize: 12, color: 'var(--text-muted, #B5AFA8)' },
  responseRight: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2 },
  responseStars: { fontSize: 13, color: 'var(--accent, #C76B8A)' },
  responseDate: { fontSize: 11, color: 'var(--text-muted, #B5AFA8)' },
  responseComment: { fontSize: 13, color: 'var(--text-secondary, #7A756F)', lineHeight: 1.4, margin: '8px 0', fontStyle: 'italic' },
  responseMeta: { display: 'flex', gap: 8, marginTop: 4 },
  npsTag: { padding: '3px 8px', borderRadius: 6, background: 'var(--border, var(--border, #EDE9E4))', color: 'var(--text-secondary, #7A756F)', fontSize: 11, fontWeight: 500 },
  reviewedTag: { padding: '3px 8px', borderRadius: 6, background: 'var(--success-bg, #EDF7F0)', color: 'var(--success, #5BA97B)', fontSize: 11, fontWeight: 500 },

  // Settings
  settingsContainer: { display: 'flex', flexDirection: 'column', gap: 0 },
  settingRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderBottom: '1px solid var(--border, var(--border, #EDE9E4))' },
  settingInfo: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1, marginRight: 12 },
  settingLabel: { fontSize: 14, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  settingDesc: { fontSize: 12, color: 'var(--text-muted, #B5AFA8)' },
  toggle: { width: 44, height: 26, borderRadius: 13, border: 'none', padding: 0, cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0 },
  toggleDot: { width: 22, height: 22, borderRadius: 11, background: 'var(--bg-card, #fff)', position: 'absolute', top: 2, transition: 'transform 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.15)' },

  fieldLabel: { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary, #7A756F)', marginBottom: 6, marginTop: 14 },
  chipRow: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  chip: { padding: '8px 14px', borderRadius: 10, border: '1px solid var(--border, var(--border, #EDE9E4))', background: 'var(--card, #fff)', color: 'var(--text-secondary, #7A756F)', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' },
  chipActive: { background: 'var(--accent, #C76B8A)', color: 'var(--bg-card, #fff)', border: '1px solid var(--accent, #C76B8A)' },
  input: { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border, var(--border, #EDE9E4))', fontSize: 14, fontFamily: 'inherit', color: 'var(--text, #2D2A26)', outline: 'none', boxSizing: 'border-box', marginTop: 4 },

  // Survey preview
  previewCard: { background: 'var(--bg-hover, var(--bg-subtle, #F5F2EF))', borderRadius: 12, padding: 16 },
  previewGreeting: { fontSize: 15, fontWeight: 600, color: 'var(--accent, #C76B8A)', margin: '0 0 6px' },
  previewText: { fontSize: 13, color: 'var(--text, #2D2A26)', lineHeight: 1.4, margin: '0 0 12px' },
  previewQ: { display: 'flex', gap: 8, marginBottom: 8 },
  previewQNum: { fontSize: 13, fontWeight: 600, color: 'var(--accent, #C76B8A)' },
  previewQText: { fontSize: 13, color: 'var(--text-secondary, #7A756F)' },
  previewSignoff: { fontSize: 13, color: 'var(--text-muted, #B5AFA8)', fontStyle: 'italic' },
};
