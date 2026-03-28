import { useState, useEffect } from 'react';
import { useBeautician, supabase, fetchRows, updateRow, isDevMode } from '../lib/supabase.js';
import logger from '../lib/logger.js';

const mockPortalConfig = {
  enabled: true,
  url: 'https://app.florrie.ai/portal/ellies-brows',
  features: {
    viewBookings: true,
    bookOnline: true,
    cancelReschedule: true,
    viewHistory: true,
    viewLoyalty: true,
    downloadReceipts: true,
    updateProfile: true,
    referFriend: true,
    leaveReview: true,
    viewAftercare: true,
    messageTherapist: false,
    viewPhotos: false,
  },
  branding: {
    welcomeMessage: "Welcome back, gorgeous! 💕",
    accentColour: '#C76B8A',
    showLogo: true,
    showTestimonials: true,
  },
  clientStats: {
    totalRegistered: 142,
    activeThisMonth: 67,
    usedBooking: 89,
    usedLoyalty: 34,
    usedReferral: 12,
  }
};

const mockRecentActivity = [
  { client: 'Sarah M.', action: 'Booked online', detail: 'Brow Lamination — Fri 28 Mar, 10:00', time: '2 hours ago' },
  { client: 'Katie L.', action: 'Checked loyalty', detail: 'Viewed points balance (Silver tier)', time: '4 hours ago' },
  { client: 'Jess P.', action: 'Downloaded receipt', detail: 'Invoice #FL-0456 — £28.00', time: '5 hours ago' },
  { client: 'Lauren T.', action: 'Updated profile', detail: 'Changed phone number', time: 'Yesterday' },
  { client: 'Amy R.', action: 'Left review', detail: '⭐⭐⭐⭐⭐ "Absolutely love my brows!"', time: 'Yesterday' },
  { client: 'Megan K.', action: 'Referred friend', detail: 'Shared referral link via WhatsApp', time: '2 days ago' },
  { client: 'Rachel S.', action: 'Cancelled appointment', detail: 'Lash Lift — Mon 24 Mar (within policy)', time: '3 days ago' },
];

export default function ClientPortal({ token }) {
  const [activeTab, setActiveTab] = useState('overview');
  const [config, setConfig] = useState(mockPortalConfig);
  const { beautician, loading: bLoading, refresh } = useBeautician();
  const [activity, setActivity] = useState(mockRecentActivity);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (bLoading || !beautician) return;
    loadPortalData();
  }, [beautician, bLoading]);

  async function loadPortalData() {
    setLoading(true);
    try {
      if (isDevMode) {
        setConfig(mockPortalConfig);
        setActivity(mockRecentActivity);
      } else {
        if (beautician.portal_config) {
          setConfig(prev => ({ ...prev, ...beautician.portal_config }));
        }
        if (beautician.booking_slug) {
          setConfig(prev => ({ ...prev, url: `https://app.florrie.ai/portal/${beautician.booking_slug}` }));
        }
        const rows = await fetchRows('portal_activity', beautician.id, { order: 'created_at', ascending: false, limit: 10 });
        if (rows.length) setActivity(rows);
      }
    } catch (err) {
      logger.error('Load portal data error:', err);
    } finally {
      setLoading(false);
    }
  }

  if (bLoading || loading) return <div style={{ padding: 40, textAlign: 'center', color: '#AAA5A0' }}>Loading...</div>;

  const c = config;
  const features = c.features;

  const toggleFeature = (key) => {
    setConfig({
      ...c,
      features: { ...features, [key]: !features[key] }
    });
  };

  const featureList = [
    { key: 'viewBookings', label: 'View upcoming bookings', icon: '📅', desc: 'Clients see their confirmed appointments' },
    { key: 'bookOnline', label: 'Book online', icon: '🗓️', desc: 'Self-service booking through your portal' },
    { key: 'cancelReschedule', label: 'Cancel / reschedule', icon: '🔄', desc: 'Clients can change bookings within your policy' },
    { key: 'viewHistory', label: 'Appointment history', icon: '📋', desc: 'See past visits, treatments, and notes' },
    { key: 'viewLoyalty', label: 'Loyalty & rewards', icon: '🏆', desc: 'Check points balance, tier, and rewards' },
    { key: 'downloadReceipts', label: 'Download receipts', icon: '🧾', desc: 'Access and download payment receipts' },
    { key: 'updateProfile', label: 'Update profile', icon: '👤', desc: 'Edit contact details and preferences' },
    { key: 'referFriend', label: 'Refer a friend', icon: '🤝', desc: 'Share referral link to earn rewards' },
    { key: 'leaveReview', label: 'Leave review', icon: '⭐', desc: 'Submit feedback after appointments' },
    { key: 'viewAftercare', label: 'View aftercare', icon: '💆', desc: 'Access aftercare instructions anytime' },
    { key: 'messageTherapist', label: 'Message therapist', icon: '💬', desc: 'Send messages directly through the portal' },
    { key: 'viewPhotos', label: 'View before/after photos', icon: '📸', desc: 'See their treatment photo history' },
  ];

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'features', label: 'Features' },
    { id: 'branding', label: 'Branding' },
    { id: 'activity', label: 'Activity' },
  ];

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div>
          <h1 style={styles.title}>Client Portal</h1>
          <div style={styles.subtitle}>Self-service for your clients</div>
        </div>
        <button
          onClick={() => setConfig({ ...c, enabled: !c.enabled })}
          style={{
            ...styles.toggle,
            background: c.enabled ? '#C76B8A' : '#E8E4E0'
          }}
        >
          <div style={{
            ...styles.toggleDot,
            transform: c.enabled ? 'translateX(18px)' : 'translateX(0)'
          }} />
        </button>
      </div>

      {/* Portal link */}
      {c.enabled && (
        <div style={styles.linkCard}>
          <div style={styles.linkLabel}>Your portal URL</div>
          <div style={styles.linkRow}>
            <div style={styles.linkUrl}>{c.url}</div>
            <button style={styles.copyBtn}>📋 Copy</button>
          </div>
          <div style={styles.shareRow}>
            <button style={styles.shareBtn}>💬 WhatsApp</button>
            <button style={styles.shareBtn}>📧 Email</button>
            <button style={styles.shareBtn}>🔗 QR Code</button>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div style={styles.tabs}>
        {tabs.map(tab => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{ ...styles.tab, ...(activeTab === tab.id ? styles.tabActive : {}) }}
          >{tab.label}</button>
        ))}
      </div>

      {/* Overview */}
      {activeTab === 'overview' && (
        <div>
          <div style={styles.statsGrid}>
            <div style={styles.statCard}>
              <div style={styles.statValue}>{c.clientStats.totalRegistered}</div>
              <div style={styles.statLabel}>Registered</div>
            </div>
            <div style={styles.statCard}>
              <div style={styles.statValue}>{c.clientStats.activeThisMonth}</div>
              <div style={styles.statLabel}>Active this month</div>
            </div>
            <div style={styles.statCard}>
              <div style={styles.statValue}>{c.clientStats.usedBooking}</div>
              <div style={styles.statLabel}>Booked online</div>
            </div>
            <div style={styles.statCard}>
              <div style={styles.statValue}>{c.clientStats.usedReferral}</div>
              <div style={styles.statLabel}>Referred</div>
            </div>
          </div>

          <div style={styles.adoptionCard}>
            <div style={styles.adoptionTitle}>Adoption rate</div>
            <div style={styles.adoptionRow}>
              <div style={styles.adoptionLabel}>Online booking</div>
              <div style={styles.adoptionBarBg}>
                <div style={{ ...styles.adoptionBarFill, width: `${(c.clientStats.usedBooking / c.clientStats.totalRegistered * 100).toFixed(0)}%` }} />
              </div>
              <div style={styles.adoptionPct}>{(c.clientStats.usedBooking / c.clientStats.totalRegistered * 100).toFixed(0)}%</div>
            </div>
            <div style={styles.adoptionRow}>
              <div style={styles.adoptionLabel}>Loyalty</div>
              <div style={styles.adoptionBarBg}>
                <div style={{ ...styles.adoptionBarFill, width: `${(c.clientStats.usedLoyalty / c.clientStats.totalRegistered * 100).toFixed(0)}%` }} />
              </div>
              <div style={styles.adoptionPct}>{(c.clientStats.usedLoyalty / c.clientStats.totalRegistered * 100).toFixed(0)}%</div>
            </div>
            <div style={styles.adoptionRow}>
              <div style={styles.adoptionLabel}>Referrals</div>
              <div style={styles.adoptionBarBg}>
                <div style={{ ...styles.adoptionBarFill, width: `${(c.clientStats.usedReferral / c.clientStats.totalRegistered * 100).toFixed(0)}%` }} />
              </div>
              <div style={styles.adoptionPct}>{(c.clientStats.usedReferral / c.clientStats.totalRegistered * 100).toFixed(0)}%</div>
            </div>
          </div>

          <div style={styles.insightCard}>
            <span style={{ fontSize: 16 }}>🧠</span>
            <div style={{ fontSize: 13, color: '#6B6560', lineHeight: 1.5 }}>
              63% of clients have booked online — that's saving you roughly 4 hours a week in
              back-and-forth messages. Consider enabling the message feature for VIP clients to
              boost engagement further.
            </div>
          </div>
        </div>
      )}

      {/* Features */}
      {activeTab === 'features' && (
        <div>
          <div style={styles.featuresHint}>Toggle what clients can do in their portal</div>
          {featureList.map(f => (
            <div key={f.key} style={styles.featureRow}>
              <span style={{ fontSize: 18 }}>{f.icon}</span>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 14, fontWeight: 500, color: '#2D2A26' }}>{f.label}</div>
                <div style={{ fontSize: 12, color: '#AAA5A0' }}>{f.desc}</div>
              </div>
              <button
                onClick={() => toggleFeature(f.key)}
                style={{
                  ...styles.toggle,
                  background: features[f.key] ? '#C76B8A' : '#E8E4E0'
                }}
              >
                <div style={{
                  ...styles.toggleDot,
                  transform: features[f.key] ? 'translateX(18px)' : 'translateX(0)'
                }} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Branding */}
      {activeTab === 'branding' && (
        <div>
          <div style={styles.brandingCard}>
            <div style={styles.inputGroup}>
              <label style={styles.inputLabel}>Welcome message</label>
              <input
                type="text"
                value={c.branding.welcomeMessage}
                onChange={e => setConfig({ ...c, branding: { ...c.branding, welcomeMessage: e.target.value } })}
                style={styles.textInput}
              />
            </div>

            <div style={styles.inputGroup}>
              <label style={styles.inputLabel}>Accent colour</label>
              <div style={styles.colourRow}>
                {['#C76B8A', '#6B8AC7', '#8AC76B', '#C7A86B', '#8B6BC7', '#2D2A26'].map(col => (
                  <button
                    key={col}
                    onClick={() => setConfig({ ...c, branding: { ...c.branding, accentColour: col } })}
                    style={{
                      ...styles.colourChip,
                      background: col,
                      border: c.branding.accentColour === col ? '3px solid #2D2A26' : '3px solid transparent'
                    }}
                  />
                ))}
              </div>
            </div>

            <div style={styles.toggleRow}>
              <span style={{ fontSize: 14, color: '#2D2A26' }}>Show logo</span>
              <button
                onClick={() => setConfig({ ...c, branding: { ...c.branding, showLogo: !c.branding.showLogo } })}
                style={{ ...styles.toggle, background: c.branding.showLogo ? '#C76B8A' : '#E8E4E0' }}
              >
                <div style={{ ...styles.toggleDot, transform: c.branding.showLogo ? 'translateX(18px)' : 'translateX(0)' }} />
              </button>
            </div>

            <div style={styles.toggleRow}>
              <span style={{ fontSize: 14, color: '#2D2A26' }}>Show testimonials</span>
              <button
                onClick={() => setConfig({ ...c, branding: { ...c.branding, showTestimonials: !c.branding.showTestimonials } })}
                style={{ ...styles.toggle, background: c.branding.showTestimonials ? '#C76B8A' : '#E8E4E0' }}
              >
                <div style={{ ...styles.toggleDot, transform: c.branding.showTestimonials ? 'translateX(18px)' : 'translateX(0)' }} />
              </button>
            </div>
          </div>

          {/* Live preview */}
          <div style={styles.previewSection}>
            <div style={styles.previewTitle}>Portal preview</div>
            <div style={styles.phoneFrame}>
              <div style={styles.phoneScreen}>
                <div style={{ textAlign: 'center', padding: '20px 16px' }}>
                  {c.branding.showLogo && (
                    <div style={{ fontSize: 22, fontWeight: 700, color: c.branding.accentColour, marginBottom: 4 }}>florrie</div>
                  )}
                  <div style={{ fontSize: 14, color: '#2D2A26', marginBottom: 16 }}>{c.branding.welcomeMessage}</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8, marginBottom: 16 }}>
                    {[
                      { icon: '📅', label: 'My Bookings' },
                      { icon: '🗓️', label: 'Book Now' },
                      { icon: '🏆', label: 'Loyalty' },
                      { icon: '🤝', label: 'Refer' },
                    ].map((item, i) => (
                      <div key={i} style={{ background: '#fff', borderRadius: 10, padding: '14px 8px', border: '1px solid #F0ECE8', textAlign: 'center' }}>
                        <div style={{ fontSize: 20, marginBottom: 4 }}>{item.icon}</div>
                        <div style={{ fontSize: 11, fontWeight: 500, color: '#2D2A26' }}>{item.label}</div>
                      </div>
                    ))}
                  </div>
                  <div style={{ background: '#fff', borderRadius: 10, padding: 12, border: '1px solid #F0ECE8', textAlign: 'left' }}>
                    <div style={{ fontSize: 12, fontWeight: 600, color: '#2D2A26', marginBottom: 6 }}>Next appointment</div>
                    <div style={{ fontSize: 13, color: '#6B6560' }}>Brow Lamination</div>
                    <div style={{ fontSize: 12, color: '#AAA5A0' }}>Fri 28 Mar · 10:00</div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Activity */}
      {activeTab === 'activity' && (
        <div>
          <div style={styles.activityHint}>Recent client portal activity</div>
          {activity.map((item, i) => (
            <div key={i} style={styles.activityRow}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600, color: '#2D2A26' }}>{item.client} <span style={{ fontWeight: 400, color: '#6B6560' }}>{item.action}</span></div>
                <div style={{ fontSize: 12, color: '#AAA5A0', marginTop: 2 }}>{item.detail}</div>
              </div>
              <div style={{ fontSize: 11, color: '#AAA5A0', flexShrink: 0 }}>{item.time}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const styles = {
  page: { padding: '16px 16px 100px', fontFamily: '"DM Sans", -apple-system, sans-serif', maxWidth: 480, margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  title: { fontSize: 22, fontWeight: 700, color: '#2D2A26', margin: 0 },
  subtitle: { fontSize: 13, color: '#AAA5A0', marginTop: 2 },

  linkCard: { background: 'linear-gradient(135deg, #C76B8A 0%, #A85575 100%)', borderRadius: 14, padding: 16, marginBottom: 16, color: '#fff' },
  linkLabel: { fontSize: 11, opacity: 0.8, marginBottom: 6 },
  linkRow: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 10 },
  linkUrl: { flex: 1, fontSize: 12, background: 'rgba(255,255,255,0.15)', borderRadius: 8, padding: '8px 10px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  copyBtn: { padding: '8px 12px', borderRadius: 8, border: 'none', background: 'rgba(255,255,255,0.2)', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 },
  shareRow: { display: 'flex', gap: 8 },
  shareBtn: { flex: 1, padding: '8px 0', borderRadius: 8, border: '1px solid rgba(255,255,255,0.3)', background: 'rgba(255,255,255,0.1)', color: '#fff', fontSize: 11, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' },

  tabs: { display: 'flex', gap: 4, marginBottom: 16, background: '#F0ECE8', borderRadius: 12, padding: 4 },
  tab: { flex: 1, padding: '8px 0', fontSize: 12, fontWeight: 500, border: 'none', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit', background: 'none', color: '#6B6560' },
  tabActive: { background: '#fff', color: '#2D2A26', boxShadow: '0 1px 3px rgba(0,0,0,0.08)' },

  statsGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 16 },
  statCard: { background: '#fff', borderRadius: 12, padding: 14, border: '1px solid #F0ECE8', textAlign: 'center' },
  statValue: { fontSize: 22, fontWeight: 700, color: '#2D2A26' },
  statLabel: { fontSize: 11, color: '#AAA5A0', marginTop: 2 },

  adoptionCard: { background: '#fff', borderRadius: 14, padding: 16, border: '1px solid #F0ECE8', marginBottom: 16 },
  adoptionTitle: { fontSize: 13, fontWeight: 600, color: '#2D2A26', marginBottom: 12 },
  adoptionRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
  adoptionLabel: { fontSize: 12, color: '#6B6560', width: 90 },
  adoptionBarBg: { flex: 1, height: 8, background: '#F0ECE8', borderRadius: 4 },
  adoptionBarFill: { height: '100%', background: '#C76B8A', borderRadius: 4, transition: 'width 0.5s' },
  adoptionPct: { fontSize: 12, fontWeight: 600, color: '#2D2A26', width: 32, textAlign: 'right' },

  insightCard: { display: 'flex', gap: 10, background: '#FFF8F0', border: '1px solid #FFE8CC', borderRadius: 12, padding: 14, marginBottom: 16 },

  featuresHint: { fontSize: 13, color: '#AAA5A0', marginBottom: 12 },
  featureRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid #F0ECE8' },

  toggle: { width: 42, height: 24, borderRadius: 12, border: 'none', cursor: 'pointer', position: 'relative', flexShrink: 0, transition: 'background 0.2s' },
  toggleDot: { width: 20, height: 20, borderRadius: 10, background: '#fff', position: 'absolute', top: 2, left: 2, transition: 'transform 0.2s', boxShadow: '0 1px 2px rgba(0,0,0,0.15)' },

  brandingCard: { background: '#fff', borderRadius: 14, padding: 16, border: '1px solid #F0ECE8', marginBottom: 16 },
  inputGroup: { marginBottom: 16 },
  inputLabel: { fontSize: 12, fontWeight: 600, color: '#6B6560', display: 'block', marginBottom: 6 },
  textInput: { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1.5px solid #E8E4E0', fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', background: '#FAF8F5', color: '#2D2A26' },
  colourRow: { display: 'flex', gap: 8 },
  colourChip: { width: 32, height: 32, borderRadius: 8, cursor: 'pointer' },
  toggleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid #F0ECE8' },

  previewSection: { marginTop: 16 },
  previewTitle: { fontSize: 13, fontWeight: 600, color: '#2D2A26', marginBottom: 10 },
  phoneFrame: { background: '#2D2A26', borderRadius: 24, padding: '8px', maxWidth: 280, margin: '0 auto' },
  phoneScreen: { background: '#FAF8F5', borderRadius: 18, minHeight: 340, overflow: 'hidden' },

  activityHint: { fontSize: 13, color: '#AAA5A0', marginBottom: 12 },
  activityRow: { display: 'flex', gap: 10, padding: '12px 0', borderBottom: '1px solid #F0ECE8' },
};
