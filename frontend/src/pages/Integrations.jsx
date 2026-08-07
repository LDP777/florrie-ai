import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBeautician, supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import { ds, type } from '../lib/designSystem.js';

function getToken() {
  const key = Object.keys(localStorage).find(k => /^sb-.+-auth-token$/.test(k));
  if (!key) return null;
  const raw = localStorage.getItem(key);
  try { const parsed = JSON.parse(raw); return parsed?.access_token || parsed?.session?.access_token || null; }
  catch { return null; }
}
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import logger from '../lib/logger.js';

// Static integration catalog - connection status is computed dynamically from real data
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

const categories = ['All', 'Payments', 'Calendar', 'Social', 'Accounting', 'Reviews'];

function getIntegrationStatus(id, beautician, smsConfig, igStatus) {
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
      if (!beautician?.instagram_page_id) return 'available';
      // igStatus is passed in; null means we haven't checked yet, so stay optimistic.
      return igStatus?.needs_reconnect ? 'needs_reconnect' : 'connected';
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
  // Storing an Instagram id is not the same as being connected. Ask the API
  // whether the token still works, so an expired one stops showing "Connected".
  const [igStatus, setIgStatus] = useState(null);

  useEffect(() => {
    if (beautician) { fetchSmsConfig(); fetchIgStatus(); }
  }, [beautician]);

  async function fetchIgStatus() {
    try {
      const token = (await supabase.auth.getSession())?.data?.session?.access_token;
      const res = await fetch(`${API_BASE}/api/instagram/status`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (res.ok) setIgStatus(await res.json());
    } catch (err) {
      logger.debug('IG status fetch failed:', err);
    }
  }

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

  const [connecting, setConnecting] = useState(null);

  async function handleConnect(integId) {
    if (integId === 'instagram') {
      setConnecting('instagram');
      try {
        const token = getToken();
        const res = await fetch(`${API_BASE}/api/instagram/connect`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
        });
        const data = await res.json();
        if (data.url) {
          window.location.href = data.url; // Redirect to Meta OAuth
        } else {
          logger.error('Instagram connect: no URL returned', data);
          setConnecting(null);
        }
      } catch (err) {
        logger.error('Instagram connect failed:', err);
        setConnecting(null);
      }
      return;
    }
    // For other integrations, navigate to their connect page
    const integ = CATALOG.find(i => i.id === integId);
    if (integ?.connectPath) navigate(integ.connectPath);
  }

  if (bLoading) return <div style={ds.page}><PageLoader /></div>;

  const integrations = CATALOG.map(item => ({
    ...item,
    status: item.comingSoon ? 'coming_soon' : getIntegrationStatus(item.id, beautician, smsConfig, igStatus),
    stats: getConnectedStats(item.id, beautician, smsConfig),
  }));

  const filtered = filter === 'All' ? integrations : integrations.filter(i => i.category === filter);
  const connectedCount = integrations.filter(i => i.status === 'connected').length;
  const connectedItems = integrations.filter(i => i.status === 'connected');

  const statusConfig = {
    connected: { bg: 'var(--success-bg)', color: 'var(--success)', label: 'Connected' },
    available: { bg: 'var(--accent-light)', color: 'var(--accent)', label: 'Available' },
    coming_soon: { bg: 'var(--bg-subtle)', color: 'var(--text-muted)', label: 'Coming Soon' },
    needs_reconnect: { bg: 'var(--danger-bg, #F7E4E4)', color: 'var(--danger)', label: 'Reconnect needed' },
  };

  return (
    <div style={ds.page}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={ds.pageTitle}>Integrations</h1>
        <p style={{ ...type.bodySmall, marginTop: 4 }}>{connectedCount} connected · {integrations.length} available</p>
      </div>

      {/* WhatsApp + SMS moved to their own home at /messaging */}
      <button
        type="button"
        onClick={() => navigate('/messaging')}
        style={{ display: 'flex',
          alignItems: 'center',
          gap: 12,
          width: '100%',
          padding: '14px 16px',
          borderRadius: 12,
          border: '1px solid var(--border)',
          background: 'var(--bg-card, #FFFCF9)',
          color: 'var(--text-primary)',
          cursor: 'pointer',
          fontFamily: 'inherit',
          textAlign: 'left',
          marginBottom: 16,
        }}
      >
        <span style={{ fontSize: 20, flexShrink: 0 }} aria-hidden>💬</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 2 }}>
            Looking for WhatsApp or SMS?
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.45 }}>
            Messaging now lives in its own place. Connect, manage, and pick your channel there.
          </div>
        </div>
        <span style={{ fontSize: 14, color: 'var(--text-muted)', flexShrink: 0 }}>→</span>
      </button>

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
            <div key={i.id} style={{ width: 36, height: 36, borderRadius: 10,
              background: 'rgba(255,255,255,0.2)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
            }} title={i.name}>{i.icon}</div>
          ))}
          {connectedCount === 0 && (
            <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>
              No integrations connected yet - tap one below to get started
            </div>
          )}
        </div>
      </div>

      {/* Category filter */}
      <div style={{ display: 'flex', gap: 6, overflowX: 'auto', marginBottom: 16, paddingBottom: 4 }}>
        {categories.map(c => (
          <button key={c} onClick={() => setFilter(c)} style={{ ...ds.btnGhost, fontSize: 11, padding: '6px 12px', whiteSpace: 'nowrap',
            background: filter === c ? 'var(--accent)' : 'var(--bg-subtle)',
            color: filter === c ? 'var(--bg-card, #FFFCF9)' : 'var(--text-secondary)',
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
                <div style={{ width: 44, height: 44, borderRadius: 12,
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
                      onClick={e => { e.stopPropagation(); handleConnect(integ.id); }}
                      disabled={connecting === integ.id}
                    >{connecting === integ.id ? 'Connecting…' : `Connect ${integ.name} →`}</button>
                  )}

                  {/* Expired token. Say plainly what has stopped working and
                      give her the one button that fixes it. */}
                  {integ.status === 'needs_reconnect' && (
                    <>
                      <p style={{ ...type.bodySmall, fontSize: 12, lineHeight: 1.5, color: 'var(--danger)', margin: '0 0 10px' }}>
                        {integ.name} has signed you out, so Florrie can't reply to your DMs
                        or post for you. Messages still arrive, but nothing goes back out.
                        Reconnecting takes a few seconds and fixes it.
                      </p>
                      <button
                        style={{ ...ds.btnPrimary, padding: '10px 0', fontSize: 13 }}
                        onClick={e => { e.stopPropagation(); handleConnect(integ.id); }}
                        disabled={connecting === integ.id}
                      >{connecting === integ.id ? 'Reconnecting…' : `Reconnect ${integ.name} →`}</button>
                    </>
                  )}

                  {integ.status === 'coming_soon' && (
                    <div style={{ ...type.bodySmall, fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: '8px 0' }}>
                      Coming soon - we'll notify you when this is ready
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
