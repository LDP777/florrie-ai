import { useState, useEffect, useRef } from 'react';
import { useBeautician, supabase, fetchRows, updateRow } from '../lib/supabase.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import ErrorCard from '../components/ErrorCard.jsx';

/**
 * ClientPortal — Booking page settings + share tools.
 *
 * Tabs: Overview (real stats), Branding (saves to booking_policy.portal), Features (saves too)
 * URL is florrie.ai/book/{slug} — the actual public booking page.
 * Config is persisted in beautician.booking_policy.portal JSONB key.
 */

const FEATURE_LIST = [
  { key: 'bookOnline', label: 'Online booking', icon: '🗓️', desc: 'Clients can book appointments from your page' },
  { key: 'cancelReschedule', label: 'Cancel / reschedule', icon: '🔄', desc: 'Clients can manage bookings via their confirmation link' },
  { key: 'viewLoyalty', label: 'Loyalty & rewards', icon: '🏆', desc: 'Loyalty points and tier shown on booking confirmation' },
  { key: 'referFriend', label: 'Refer a friend', icon: '🤝', desc: 'Clients can share your referral link to earn rewards' },
  { key: 'leaveReview', label: 'Leave a review', icon: '⭐', desc: 'Post-appointment review request sent automatically' },
  { key: 'viewAftercare', label: 'Aftercare instructions', icon: '💆', desc: 'Aftercare docs sent after treatment' },
];

const ACCENT_COLOURS = [
  '#C76B8A', '#6B8AC7', '#8AC76B', '#C7A86B', '#8B6BC7', '#2D2A26',
];

const DEFAULT_PORTAL = {
  enabled: true,
  welcomeMessage: 'Book your next appointment',
  accentColour: '#C76B8A',
  showLogo: true,
  features: {
    bookOnline: true,
    cancelReschedule: true,
    viewLoyalty: true,
    referFriend: true,
    leaveReview: true,
    viewAftercare: true,
  },
};

export default function ClientPortal() {
  const [activeTab, setActiveTab] = useState('overview');
  const { beautician, loading: bLoading, refresh } = useBeautician();

  const [portal, setPortal] = useState(DEFAULT_PORTAL);
  const [clientCount, setClientCount] = useState(null);
  const [apptCount, setApptCount] = useState(null);
  const [recentAppts, setRecentAppts] = useState([]);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (bLoading || !beautician) return;
    // Hydrate portal config from booking_policy.portal
    const saved = beautician.booking_policy?.portal;
    if (saved) setPortal(p => ({ ...DEFAULT_PORTAL, ...saved, features: { ...DEFAULT_PORTAL.features, ...saved.features } }));
    loadStats();
  }, [beautician, bLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadStats() {
    setLoading(true);
    try {
      const { data: clients } = await supabase
        .from('clients')
        .select('id', { count: 'exact', head: true })
        .eq('beautician_id', beautician.id);
      setClientCount(clients ?? 0);

      const { data: appts, count } = await supabase
        .from('appointments')
        .select('id, starts_at, status, treatments(name), clients(first_name, last_name)', { count: 'exact' })
        .eq('beautician_id', beautician.id)
        .order('created_at', { ascending: false })
        .limit(5);
      setApptCount(count ?? 0);
      setRecentAppts(appts || []);
    } catch (err) {
      logger.error('Portal stats error:', err);
    } finally {
      setLoading(false);
    }
  }

  async function savePortal(updates) {
    if (!beautician) return;
    const next = { ...portal, ...updates };
    setPortal(next);
    setSaving(true);
    try {
      await updateRow('beauticians', beautician.id, {
        booking_policy: { ...(beautician.booking_policy || {}), portal: next },
      });
      await refresh();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      logger.error('Save portal error:', err);
    } finally {
      setSaving(false);
    }
  }

  function toggleFeature(key) {
    savePortal({ features: { ...portal.features, [key]: !portal.features[key] } });
  }

  const bookingUrl = `https://florrie.ai/book/${beautician?.booking_slug || ''}`;

  function handleCopy() {
    navigator.clipboard?.writeText(bookingUrl);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  function handleWhatsApp() {
    const msg = encodeURIComponent(`Book your next appointment with me here: ${bookingUrl}`);
    window.open(`https://wa.me/?text=${msg}`, '_blank');
  }

  function handleEmail() {
    const subject = encodeURIComponent('Book an appointment');
    const body = encodeURIComponent(`Hi,\n\nYou can book your next appointment here:\n${bookingUrl}\n\nLooking forward to seeing you!`);
    window.location.href = `mailto:?subject=${subject}&body=${body}`;
  }

  function handleQR() {
    window.open(`https://api.qrserver.com/v1/create-qr-code/?data=${encodeURIComponent(bookingUrl)}&size=300x300`, '_blank');
  }

  if (bLoading || loading) return <PageLoader />;
  if (!beautician) return <ErrorCard message="Could not load profile." onDismiss={() => {}} />;

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'branding', label: 'Branding' },
    { id: 'features', label: 'Features' },
  ];

  return (
    <div style={s.page}>
      <div style={s.header}>
        <div>
          <h1 style={s.title}>Client Portal</h1>
          <div style={s.subtitle}>Your public booking page</div>
        </div>
        <button
          onClick={() => savePortal({ enabled: !portal.enabled })}
          style={{ ...s.toggle, background: portal.enabled ? 'var(--accent, #C76B8A)' : '#E8E4E0' }}
        >
          <div style={{ ...s.toggleDot, transform: portal.enabled ? 'translateX(18px)' : 'translateX(0)' }} />
        </button>
      </div>

      {saved && <div style={s.savedBanner}>Saved ✓</div>}

      {/* Booking link card */}
      <div style={s.linkCard}>
        <div style={s.linkLabel}>Your booking page</div>
        <div style={s.linkRow}>
          <div style={s.linkUrl}>{bookingUrl}</div>
          <button onClick={handleCopy} style={s.copyBtn}>{copied ? '✓ Copied' : '📋 Copy'}</button>
        </div>
        <div style={s.shareRow}>
          <button onClick={handleWhatsApp} style={s.shareBtn}>💬 WhatsApp</button>
          <button onClick={handleEmail} style={s.shareBtn}>📧 Email</button>
          <button onClick={handleQR} style={s.shareBtn}>🔗 QR Code</button>
        </div>
      </div>

      {/* Tabs */}
      <div style={s.tabs}>
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{ ...s.tab, ...(activeTab === tab.id ? s.tabActive : {}) }}
          >{tab.label}</button>
        ))}
      </div>

      {/* Overview */}
      {activeTab === 'overview' && (
        <div>
          <div style={s.statsGrid}>
            <div style={s.statCard}>
              <div style={s.statValue}>{clientCount ?? '—'}</div>
              <div style={s.statLabel}>Total clients</div>
            </div>
            <div style={s.statCard}>
              <div style={s.statValue}>{apptCount ?? '—'}</div>
              <div style={s.statLabel}>Appointments</div>
            </div>
          </div>

          <div style={s.card}>
            <div style={s.cardTitle}>Recent bookings</div>
            {recentAppts.length === 0 ? (
              <p style={{ fontSize: 13, color: 'var(--text-muted)', margin: '8px 0 0' }}>
                No bookings yet. Share your link to get your first one.
              </p>
            ) : (
              recentAppts.map((a, i) => (
                <div key={i} style={s.apptRow}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>
                      {a.clients?.first_name} {a.clients?.last_name}
                    </div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                      {a.treatments?.name} · {new Date(a.starts_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}
                    </div>
                  </div>
                  <div style={{ ...s.statusChip, background: a.status === 'confirmed' ? '#E8F5E9' : '#FFF8E1', color: a.status === 'confirmed' ? '#388E3C' : '#F57C00' }}>
                    {a.status}
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      {/* Branding */}
      {activeTab === 'branding' && (
        <div>
          <div style={s.card}>
            <div style={s.cardTitle}>Welcome message</div>
            <input
              type="text"
              value={portal.welcomeMessage}
              onChange={e => setPortal(p => ({ ...p, welcomeMessage: e.target.value }))}
              onBlur={() => savePortal({})}
              style={s.textInput}
              placeholder="Book your next appointment"
            />
          </div>

          <div style={s.card}>
            <div style={s.cardTitle}>Accent colour</div>
            <div style={s.colourRow}>
              {ACCENT_COLOURS.map(col => (
                <button
                  key={col}
                  onClick={() => savePortal({ accentColour: col })}
                  style={{ ...s.colourChip, background: col, border: portal.accentColour === col ? '3px solid var(--text-primary)' : '3px solid transparent' }}
                />
              ))}
            </div>
          </div>

          <div style={s.card}>
            <div style={s.toggleRow}>
              <span style={{ fontSize: 14, color: 'var(--text-primary)' }}>Show logo on booking page</span>
              <button
                onClick={() => savePortal({ showLogo: !portal.showLogo })}
                style={{ ...s.toggle, background: portal.showLogo ? 'var(--accent, #C76B8A)' : '#E8E4E0' }}
              >
                <div style={{ ...s.toggleDot, transform: portal.showLogo ? 'translateX(18px)' : 'translateX(0)' }} />
              </button>
            </div>
          </div>

          {/* Live preview */}
          <div style={s.previewLabel}>Preview</div>
          <div style={s.phoneFrame}>
            <div style={s.phoneScreen}>
              <div style={{ textAlign: 'center', padding: '20px 16px' }}>
                {portal.showLogo && beautician.logo_url && (
                  <img src={beautician.logo_url} alt="Logo" style={{ width: 48, height: 48, borderRadius: 10, objectFit: 'cover', marginBottom: 8 }} />
                )}
                {portal.showLogo && !beautician.logo_url && (
                  <div style={{ fontSize: 20, fontWeight: 700, color: portal.accentColour, marginBottom: 8 }}>{beautician.business_name || 'florrie'}</div>
                )}
                <div style={{ fontSize: 13, color: 'var(--text-primary, #2D2A26)', marginBottom: 16 }}>{portal.welcomeMessage}</div>
                <div style={{ background: portal.accentColour, color: '#fff', padding: '12px 24px', borderRadius: 10, fontSize: 13, fontWeight: 600 }}>Book Now</div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Features */}
      {activeTab === 'features' && (
        <div>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 12, marginTop: 0 }}>
            Control what clients can do from your booking page and confirmation links.
          </p>
          {FEATURE_LIST.map(f => (
            <div key={f.key} style={s.featureRow}>
              <span style={{ fontSize: 18 }}>{f.icon}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 500, color: 'var(--text-primary)' }}>{f.label}</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>{f.desc}</div>
              </div>
              <button
                onClick={() => toggleFeature(f.key)}
                style={{ ...s.toggle, background: portal.features[f.key] ? 'var(--accent, #C76B8A)' : '#E8E4E0' }}
              >
                <div style={{ ...s.toggleDot, transform: portal.features[f.key] ? 'translateX(18px)' : 'translateX(0)' }} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const s = {
  page: { padding: '16px 16px 24px', fontFamily: '"DM Sans", -apple-system, sans-serif', maxWidth: 480, margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  title: { fontSize: 22, fontWeight: 700, color: 'var(--text-primary)', margin: 0 },
  subtitle: { fontSize: 13, color: 'var(--text-muted)', marginTop: 2 },
  savedBanner: { background: 'var(--success, #4CAF50)', color: '#fff', borderRadius: 10, padding: '8px 14px', fontSize: 13, fontWeight: 600, marginBottom: 12, textAlign: 'center' },

  linkCard: { background: 'linear-gradient(135deg, #C76B8A 0%, #A85575 100%)', borderRadius: 14, padding: 16, marginBottom: 16, color: '#fff' },
  linkLabel: { fontSize: 11, opacity: 0.8, marginBottom: 6 },
  linkRow: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 },
  linkUrl: { flex: 1, fontSize: 12, background: 'rgba(255,255,255,0.15)', borderRadius: 8, padding: '8px 10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  copyBtn: { padding: '8px 12px', borderRadius: 8, border: 'none', background: 'rgba(255,255,255,0.25)', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 },
  shareRow: { display: 'flex', gap: 8 },
  shareBtn: { flex: 1, padding: '8px 0', borderRadius: 8, border: '1px solid rgba(255,255,255,0.3)', background: 'rgba(255,255,255,0.1)', color: '#fff', fontSize: 11, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' },

  tabs: { display: 'flex', gap: 4, marginBottom: 16, background: '#F0ECE8', borderRadius: 12, padding: 4 },
  tab: { flex: 1, padding: '8px 0', fontSize: 12, fontWeight: 500, border: 'none', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit', background: 'none', color: '#6B6560' },
  tabActive: { background: 'var(--bg-card, #fff)', color: 'var(--text-primary)', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' },

  statsGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 16 },
  statCard: { background: 'var(--bg-card, #fff)', borderRadius: 12, padding: 16, border: '1px solid var(--border, #F0ECE8)', textAlign: 'center' },
  statValue: { fontSize: 28, fontWeight: 700, color: 'var(--text-primary)' },
  statLabel: { fontSize: 11, color: 'var(--text-muted)', marginTop: 2 },

  card: { background: 'var(--bg-card, #fff)', borderRadius: 14, padding: 16, border: '1px solid var(--border, #F0ECE8)', marginBottom: 12 },
  cardTitle: { fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 10 },
  apptRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: '1px solid var(--border-light, #F5F2EF)' },
  statusChip: { fontSize: 11, fontWeight: 600, padding: '3px 8px', borderRadius: 6, textTransform: 'capitalize' },

  textInput: { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1.5px solid var(--border, #E8E4E0)', fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', background: 'var(--bg, #FAF8F5)', color: 'var(--text-primary)' },
  colourRow: { display: 'flex', gap: 8 },
  colourChip: { width: 32, height: 32, borderRadius: 8, cursor: 'pointer', flexShrink: 0 },
  toggleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },

  toggle: { width: 42, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer', position: 'relative', flexShrink: 0, transition: 'background 0.2s' },
  toggleDot: { width: 20, height: 20, borderRadius: 10, background: '#fff', position: 'absolute', top: 2, left: 2, transition: 'transform 0.2s', boxShadow: '0 1px 2px rgba(0,0,0,0.15)' },

  previewLabel: { fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 10, marginTop: 4 },
  phoneFrame: { background: 'var(--text-primary, #2D2A26)', borderRadius: 24, padding: 8, maxWidth: 240, margin: '0 auto 16px' },
  phoneScreen: { background: 'var(--bg, #FAF8F5)', borderRadius: 18, minHeight: 220, overflow: 'hidden' },

  featureRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--border-light, #F0ECE8)' },
};
