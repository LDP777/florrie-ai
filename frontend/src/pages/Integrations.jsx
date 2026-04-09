import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBeautician, supabase, isDevMode } from '../lib/supabase.js';
import { ds, type } from '../lib/designSystem.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import logger from '../lib/logger.js';

// Static integration catalog — connection status is computed dynamically from real data
const CATALOG = [
  {
    id: 'stripe',
    name: 'Stripe',
    icon: '💳',
    category: 'Payments',
    description: 'Accept card payments, deposits, and tap-to-pay',
    features: ['Card payments', 'Deposit collection', 'Automatic payouts', 'No-show charges'],
    settingsPath: '/settings',
    connectPath: '/settings',
  },
  {
    id: 'whatsapp',
    name: 'WhatsApp Business',
    icon: '💬',
    category: 'Messaging',
    description: 'Send confirmations, reminders, and AI-powered replies via WhatsApp',
    features: ['Booking confirmations', '24h reminders', 'AI auto-replies', 'Campaign broadcasts'],
    settingsPath: '/whatsapp',
    connectPath: '/whatsapp',
  },
  {
    id: 'bird',
    name: 'Bird SMS',
    icon: '📱',
    category: 'Messaging',
    description: 'SMS for clients who aren\'t on WhatsApp — no regulatory bundle, works immediately',
    features: ['Booking confirmations', '24h reminders', 'Custom sender name', 'Auto-fallback from WhatsApp'],
    settingsPath: '/sms',
    connectPath: '/sms',
  },
  {
    id: 'google-cal',
    name: 'Google Calendar',
    icon: '📅',
    category: 'Calendar',
    description: 'Two-way sync between florrie.ai and Google Calendar',
    features: ['Two-way sync', 'Block personal events', 'Real-time availability', 'No double-bookings'],
    settingsPath: '/settings',
    connectPath: '/settings',
  },
  {
    id: 'instagram',
    name: 'Instagram',
    icon: '📸',
    category: 'Social',
    description: 'Auto-post content and monitor DM booking requests',
    features: ['Auto-post content', 'DM monitoring', 'Booking link in bio', 'AI draft replies'],
    settingsPath: '/integrations',
    connectPath: '/integrations',
  },
  {
    id: 'xero',
    name: 'Xero',
    icon: '📊',
    category: 'Accounting',
    description: 'Push income and expenses to Xero for self-assessment',
    features: ['Auto-push invoices', 'Expense sync', 'Tax report export', 'Bank reconciliation'],
    settingsPath: null,
    connectPath: null,
    comingSoon: true,
  },
  {
    id: 'quickbooks',
    name: 'QuickBooks',
    icon: '📒',
    category: 'Accounting',
    description: 'Sync financials to QuickBooks for your accountant',
    features: ['Invoice sync', 'Expense categories', 'P&L reports', 'VAT tracking'],
    settingsPath: null,
    connectPath: null,
    comingSoon: true,
  },
  {
    id: 'google-reviews',
    name: 'Google Reviews',
    icon: '⭐',
    category: 'Reviews',
    description: 'Monitor and respond to Google Business reviews',
    features: ['Review monitoring', 'AI-drafted responses', 'Review request automation', 'Rating tracker'],
    settingsPath: null,
    connectPath: null,
    comingSoon: true,
  },
  {
    id: 'tiktok',
    name: 'TikTok Business',
    icon: '🎵',
    category: 'Social',
    description: 'Schedule and post short-form video content',
    features: ['Video scheduling', 'Trend suggestions', 'Analytics', 'Booking link'],
    settingsPath: null,
    connectPath: null,
    comingSoon: true,
  },
];

const categories = ['All', 'Payments', 'Messaging', 'Calendar', 'Social', 'Accounting', 'Reviews'];

function getIntegrationStatus(id, beautician, smsConfig) {
  switch (id) {
    case 'stripe':
      return beautician?.stripe_account_id && beautician?.stripe_onboarding_complete
        ? 'connected'
        : 'available';
    case 'whatsapp':
      return beautician?.whatsapp_connected && beautician?.whatsapp_phone_id
        ? 'connected'
        : 'available';
    case 'bird':
      return smsConfig?.bird_configured
        ? 'connected'
        : 'available';
    case 'google-cal':
      return beautician?.google_calendar_connected
        ? 'connected'
        : 'available';
    case 'instagram':
      return beautician?.instagram_page_id
        ? 'connected'
        : 'available';
    default:
      return 'coming_soon';
  }
}

function getConnectedStats(id, beautician, smsConfig) {
  switch (id) {
    case 'stripe':
      return beautician?.stripe_account_id
        ? { label: 'Account', value: beautician.stripe_account_id.slice(0, 12) + '…' }
        : null;
    case 'whatsapp':
      return beautician?.whatsapp_phone
        ? { label: 'Number', value: beautician.whatsapp_phone }
        : null;
    case 'bird':
      return smsConfig?.sms_originator
        ? { label: 'Sender name', value: smsConfig.sms_originator }
        : null;
    case 'google-cal':
      return beautician?.google_calendar_id
        ? { label: 'Calendar', value: beautician.google_calendar_id }
        : null;
    case 'instagram':
      return beautician?.instagram_page_id
        ? { label: 'Page ID', value: beautician.instagram_page_id }
        : null;
    default:
      return null;
  }
}

export default function Integrations() {
  const { beautician, loading: bLoading } = useBeautician();
  const navigate = useNavigate();
  const [filter, setFilter] = useState('All');
  const [expanded, setExpanded] = useState(null);
  const [smsConfig, setSmsConfig] = useState(null);

  useEffect(() => {
    if (!isDevMode && beautician) fetchSmsConfig();
    else if (isDevMode) setSmsConfig({ bird_configured: true, sms_originator: 'Florrie' });
  }, [beautician]);

  async function fetchSmsConfig() {
    try {
      const token = Object.keys(localStorage).find(k => k.includes('auth-token') || k.includes('access_token'));
      const raw = token ? localStorage.getItem(token) : null;
      const parsed = raw ? JSON.parse(raw) : null;
      const jwt = parsed?.access_token || parsed?.session?.access_token;

      const res = await fetch('/api/notifications/sms/config', {
        headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
      });
      if (res.ok) setSmsConfig(await res.json());
    } catch (err) {
      logger.debug('SMS config fetch failed:', err);
    }
  }

  if (bLoading) return <div style={ds.page}><PageLoader /></div>;

  const integrations = CATALOG.map(item => ({
    ...item,
    status: item.comingSoon ? 'coming_soon' : getIntegrationStatus(item.id, beautician, smsConfig),
    stats: getConnectedStats(item.id, beautician, smsConfig),
  }));

  const filtered = filter === 'All' ? integrations : integrations.filter(i => i.category === filter);
  const connectedCount = integrations.filter(i => i.status === 'connected').length;
  const connectedItems = integrations.filter(i => i.status === 'connected');

  const statusConfig = {
    connected: { bg: 'var(--success-bg)', color: 'var(--success)', label: 'Connected' },
    available: { bg: 'var(--accent-light)', color: 'var(--accent)', label: 'Available' },
    coming_soon: { bg: 'var(--bg-subtle)', color: 'var(--text-muted)', label: 'Coming Soon' },
  };

  return (
    <div style={ds.page}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={ds.pageTitle}>Integrations</h1>
        <p style={{ ...type.bodySmall, marginTop: 4 }}>{connectedCount} connected · {integrations.length} available</p>
      </div>

      {/* Connected summary */}
      <div style={{ ...ds.heroCard, marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>INTEGRATION HUB</div>
            <div style={{ fontSize: 36, fontWeight: 700 }}>{connectedCount}/{integrations.length}</div>
            <div style={{ fontSize: 13, opacity: 0.9, marginTop: 4 }}>connected</div>
          </div>
          <div style={{ fontSize: 40 }}>🔌</div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
          {connectedItems.map(i => (
            <div key={i.id} style={{
              width: 36, height: 36, borderRadius: 10,
              background: 'rgba(255,255,255,0.2)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
            }} title={i.name}>{i.icon}</div>
          ))}
          {connectedCount === 0 && (
            <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>
              No integrations connected yet — tap one below to get started
            </div>
          )}
        </div>
      </div>

      {/* Category filter */}
      <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginBottom: 16, paddingBottom: 4 }}>
        {categories.map(c => (
          <button key={c} onClick={() => setFilter(c)} style={{
            ...ds.btnGhost, fontSize: 11, padding: '6px 12px', whiteSpace: 'nowrap',
            background: filter === c ? 'var(--accent)' : 'var(--bg-subtle)',
            color: filter === c ? 'var(--bg-card, #fff)' : 'var(--text-secondary)',
          }}>{c}</button>
        ))}
      </div>

      {/* Integration cards */}
      {filtered.length === 0 ? (
        <EmptyState title="No integrations found" description="No integrations match the selected category." />
      ) : (
        filtered.map((integ, i) => {
          const sc = statusConfig[integ.status];
          return (
            <div key={integ.id}
              style={{ ...ds.card, marginBottom: 10, cursor: 'pointer' }}
              onClick={() => setExpanded(expanded === i ? null : i)}
            >
              <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
                <div style={{
                  width: 44, height: 44, borderRadius: 12,
                  background: integ.status === 'connected' ? 'var(--success-bg)' : 'var(--bg-subtle)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, flexShrink: 0,
                }}>{integ.icon}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <span style={type.heading}>{integ.name}</span>
                    <span style={{ ...ds.badge, background: sc.bg, color: sc.color }}>{sc.label}</span>
                  </div>
                  <div style={{ ...type.bodySmall, fontSize: 12, marginTop: 2 }}>{integ.description}</div>
                </div>
              </div>

              {/* Real stats for connected integrations */}
              {integ.status === 'connected' && integ.stats && (
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 10, padding: '8px 12px', background: 'var(--bg-subtle)', borderRadius: 10 }}>
                  <span style={{ ...type.bodySmall, fontSize: 12 }}>{integ.stats.label}</span>
                  <span style={{ ...type.mono, fontSize: 13, fontWeight: 600, color: 'var(--accent)' }}>{integ.stats.value}</span>
                </div>
              )}

              {/* Expanded details */}
              {expanded === i && (
                <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border-light)' }}>
                  <div style={{ ...ds.sectionTitle, marginBottom: 8 }}>FEATURES</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 12 }}>
                    {integ.features.map(f => (
                      <span key={f} style={{ ...ds.badge, background: 'var(--bg-subtle)', color: 'var(--text-secondary)' }}>✓ {f}</span>
                    ))}
                  </div>

                  {integ.status === 'connected' && integ.settingsPath && (
                    <div style={{ display: 'flex', gap: 8 }}>
                      <button
                        style={{ ...ds.btnGhost, flex: 1, fontSize: 11, background: 'var(--accent-light)', color: 'var(--accent)' }}
                        onClick={e => { e.stopPropagation(); navigate(integ.settingsPath); }}
                      >Settings</button>
                    </div>
                  )}

                  {integ.status === 'available' && integ.connectPath && (
                    <button
                      style={{ ...ds.btnPrimary, padding: '10px 0', fontSize: 13 }}
                      onClick={e => { e.stopPropagation(); navigate(integ.connectPath); }}
                    >Connect {integ.name} →</button>
                  )}

                  {integ.status === 'coming_soon' && (
                    <div style={{ ...type.bodySmall, fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: '8px 0' }}>
                      Coming soon — we'll notify you when this is ready
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
