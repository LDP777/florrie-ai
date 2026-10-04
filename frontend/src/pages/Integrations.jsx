import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBeautician, supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import { ds, type } from '../lib/designSystem.js';

import { isNativeApp } from '../lib/platform.js';
import { startInstagramConnection } from '../lib/instagram-connect.js';
import { readAuthenticatedJson } from '../lib/authenticated-json.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import logger from '../lib/logger.js';
import Icon, { iconName } from '../components/ui/Icon';
import PageHeader from '../components/ui/PageHeader.jsx';
import Button from '../components/ui/Button.jsx';
// Static integration catalog - connection status is computed dynamically from real data
const CATALOG = [
  {
    id: 'stripe',
    name: 'Stripe',
    icon: 'card',
    category: 'Payments',
    description: 'Accept card payments, deposits, and tap-to-pay',
    features: ['Card payments', 'Deposit collection', 'Automatic payouts', 'No-show charges'],
    settingsPath: '/settings',
    connectPath: '/settings',
  },
  {
    id: 'google-cal',
    name: 'Google Calendar',
    icon: 'calendar',
    category: 'Calendar',
    description: 'Two-way sync between florrie.ai and Google Calendar',
    features: ['Two-way sync', 'Block personal events', 'Real-time availability', 'No double-bookings'],
    settingsPath: '/settings',
    connectPath: '/settings',
  },
  {
    id: 'instagram',
    name: 'Instagram',
    icon: 'camera',
    category: 'Social',
    description: 'Auto-post content and monitor DM booking requests',
    features: ['Auto-post content', 'DM monitoring', 'Booking link in bio', 'AI draft replies'],
    settingsPath: '/settings?section=connections',
    connectPath: '/integrations',
  },
  {
    id: 'xero',
    name: 'Xero',
    icon: 'chart',
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
    icon: 'file',
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
    icon: 'star',
    category: 'Reviews',
    description: 'Your review link and Google Business Profile connection',
    features: ['Google review link', 'Connection status', 'Review replies'],
    settingsPath: '/reviews',
    connectPath: '/reviews',
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

function getIntegrationStatus(id, beautician, smsConfig, igStatus, igChecking) {
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
    case 'google-reviews':
      // Reviews owns the live availability check. A saved review link alone
      // does not establish a Google Business Profile connection.
      return 'details';
    case 'instagram':
      if (!beautician?.instagram_page_id) return 'available';
      // THE HONEST LADDER, the same one Settings.jsx shows.
      //
      // 31 August 2026. This line said "stay optimistic": anything that was
      // not an explicit needs_reconnect read as Connected, including the whole
      // second before the status call comes back and every case where it never
      // comes back at all (offline, API down, a 500). So an account with a
      // dead token said "Connected" in green on the one screen whose entire
      // job is to tell her what is working. An id in the database proves she
      // connected once. Only a live check proves it still works.
      if (igChecking || !igStatus) return 'checking';
      if (igStatus.needs_reconnect) return 'needs_reconnect';
      // Instagram Login has no separate owner-echo subscription to verify.
      if (igStatus.token_valid && igStatus.webhook_subscribed === false) return 'needs_attention';
      if (igStatus.token_valid && igStatus.webhook_subscribed === true) return 'connected';
      return 'unknown';
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
  const { beautician, loading: bLoading, refresh } = useBeautician();
  const navigate = useNavigate();
  const [filter, setFilter] = useState('All');
  const [expanded, setExpanded] = useState(null);
  const [smsConfig, setSmsConfig] = useState(null);
  // Storing an Instagram id is not the same as being connected. Ask the API
  // whether the token still works, so an expired one stops showing "Connected".
  const [igStatus, setIgStatus] = useState(null);
  // "Not checked yet" and "checked, and it failed" are different answers and
  // the card has to be able to tell them apart. Before 31 August 2026 both
  // left igStatus null and both rendered as Connected.
  const [igChecking, setIgChecking] = useState(true);
  const igStatusRequest = useRef(0);

  useEffect(() => {
    if (beautician) { fetchSmsConfig(); fetchIgStatus(); }
    return () => { igStatusRequest.current++; };
  }, [beautician]);

  // Closing the native browser does not navigate this screen. Re-read the
  // saved account and connection when the owner returns, including cancellation.
  useEffect(() => {
    if (!isNativeApp()) return;
    let cancelled = false, listener;
    const checkReturn = () => { if (!cancelled) { void refresh(); void fetchIgStatus(); } };
    const visible = () => { if (document.visibilityState === 'visible') checkReturn(); };
    document.addEventListener('visibilitychange', visible);
    import('@capacitor/browser').then(async ({ Browser }) => {
      listener = await Browser.addListener('browserFinished', checkReturn);
      if (cancelled) await listener.remove();
    }).catch(() => {});
    return () => { cancelled = true; document.removeEventListener('visibilitychange', visible); void listener?.remove(); };
  }, [refresh]); // eslint-disable-line react-hooks/exhaustive-deps

  async function fetchIgStatus() {
    const request = ++igStatusRequest.current;
    setIgChecking(true);
    try {
      const status = await readAuthenticatedJson({ auth: supabase.auth, url: `${API_BASE}/api/instagram/status` });
      if (request === igStatusRequest.current) setIgStatus(status || { check_failed: true });
    } catch (err) {
      logger.debug('IG status fetch failed:', err);
      if (request === igStatusRequest.current) setIgStatus({ check_failed: true });
    } finally {
      if (request === igStatusRequest.current) setIgChecking(false);
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
  // A failed connect used to write to console.error and nothing else, so the
  // button just went back to "Connect" and the screen said nothing at all.
  // That is the whole of "connecting Instagram doesn't work" from her side.
  const [igError, setIgError] = useState(null);

  async function handleConnect(integId) {
    if (integId === 'instagram') {
      if (connecting === 'instagram') return;
      setConnecting('instagram');
      setIgError(null);
      try {
        await startInstagramConnection({
          api: API_BASE, native: isNativeApp(),
          getToken: async () => (await supabase.auth.getSession()).data.session?.access_token,
        });
      } catch (err) {
        setIgError(err.message || 'Could not start the connection. Try again.');
      } finally {
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
    status: item.comingSoon ? 'coming_soon' : getIntegrationStatus(item.id, beautician, smsConfig, igStatus, igChecking),
    stats: getConnectedStats(item.id, beautician, smsConfig),
  }));

  const filtered = filter === 'All' ? integrations : integrations.filter(i => i.category === filter);
  const connectedCount = integrations.filter(i => i.status === 'connected').length;
  const connectedItems = integrations.filter(i => i.status === 'connected');

  const statusConfig = {
    connected: { bg: 'var(--success-bg)', color: 'var(--success)', label: 'Connected' },
    available: { bg: 'var(--accent-light)', color: 'var(--accent)', label: 'Available' },
    coming_soon: { bg: 'var(--bg-subtle)', color: 'var(--text-muted)', label: 'Coming Soon' },
    needs_attention: { bg: 'var(--warning-bg)', color: 'var(--warning-text)', label: 'Setup incomplete' },
    needs_reconnect: { bg: 'var(--danger-bg, #F7E4E4)', color: 'var(--danger)', label: 'Reconnect needed' },
    // Neither of these is a failure. They are the two ways of saying "we do
    // not know yet", which is a thing this screen has to be able to say.
    checking: { bg: 'var(--bg-subtle)', color: 'var(--text-muted)', label: 'Checking…' },
    unknown: { bg: 'var(--bg-subtle)', color: 'var(--text-muted)', label: 'Could not check' },
    details: { bg: 'var(--bg-subtle)', color: 'var(--text-secondary)', label: 'In Reviews' },
  };

  return (
    <div style={ds.page}>
      <PageHeader
        title="Integrations"
        subtitle={`${connectedCount} connected · ${integrations.length} integrations`}
      />

      {/* WhatsApp + SMS moved to their own home at /messaging */}
      <button
        type="button"
        onClick={() => navigate('/messaging')}
        style={{ display: 'flex',
          alignItems: 'center',
          gap: 12,
          width: '100%',
          padding: '14px 16px',
          borderRadius: 10,
          border: '1px solid var(--border)',
          background: 'var(--bg-card, #FFFCF9)',
          color: 'var(--text-primary)',
          cursor: 'pointer',
          fontFamily: 'inherit',
          textAlign: 'left',
          marginBottom: 16,
        }}
      >
        <span style={{ fontSize: 20, flexShrink: 0 }} aria-hidden><Icon name="message" size={15} /></span>
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
          <div style={{ fontSize: 40 }}><Icon name="link" size={40} /></div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 16, flexWrap: 'wrap' }}>
          {connectedItems.map(i => (
            <div key={i.id} style={{ width: 36, height: 36, borderRadius: 10,
              background: 'rgba(255,255,255,0.2)',
              display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18,
            }} title={i.name}><Icon name={iconName(i.icon)} inline /></div>
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
          <button className="fl-tap" key={c} onClick={() => setFilter(c)} style={{ ...ds.btnGhost, fontSize: 11, padding: '6px 12px', whiteSpace: 'nowrap',
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
                <div style={{ width: 44, height: 44, borderRadius: 10,
                  background: integ.status === 'connected' ? 'var(--success-bg)' : 'var(--bg-subtle)',
                  display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, flexShrink: 0,
                }}><Icon name={iconName(integ.icon)} inline /></div>
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
                    <button className="fl-tap"
                      style={{ ...ds.btnPrimary, padding: '10px 0', fontSize: 13 }}
                      onClick={e => { e.stopPropagation(); handleConnect(integ.id); }}
                      disabled={connecting === integ.id}
                    >{connecting === integ.id ? 'Connecting…' : `Connect ${integ.name} →`}</button>
                  )}

                  {integ.status === 'details' && integ.connectPath && (
                    <>
                      <p style={{ ...type.bodySmall, fontSize: 12, lineHeight: 1.5, margin: '0 0 10px' }}>
                        Check Google availability, manage your connection and save your review request link in Reviews.
                      </p>
                      <Button fullWidth onClick={e => { e.stopPropagation(); handleConnect(integ.id); }}>Open Reviews</Button>
                    </>
                  )}

                  {integ.status === 'needs_attention' && (
                    <>
                      <p role="status" style={{ ...type.bodySmall, fontSize: 12, lineHeight: 1.5, margin: '0 0 10px' }}>
                        Your Instagram account is saved, but messages are not reaching Florrie yet.
                        {' '}Review the connection in Settings, then check again.
                      </p>
                      <Button variant="secondary" fullWidth onClick={e => { e.stopPropagation(); fetchIgStatus(); }}>Retry connection check</Button>
                      <Button variant="secondary" fullWidth onClick={e => { e.stopPropagation(); navigate('/settings?section=connections'); }}>Review Instagram connection</Button>
                    </>
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
                      <button className="fl-tap"
                        style={{ ...ds.btnPrimary, padding: '10px 0', fontSize: 13 }}
                        onClick={e => { e.stopPropagation(); handleConnect(integ.id); }}
                        disabled={connecting === integ.id}
                      >{connecting === integ.id ? 'Reconnecting…' : `Reconnect ${integ.name} →`}</button>
                    </>
                  )}

                  {/* We could not reach the status check. Say that, rather
                      than guessing in either direction, and still offer the
                      button that would fix it if the token really is dead. */}
                  {integ.status === 'unknown' && (
                    <>
                      <p style={{ ...type.bodySmall, fontSize: 12, lineHeight: 1.5, margin: '0 0 10px' }}>
                        We could not check {integ.name} just now, so we cannot tell you whether
                        it is still working. Retry the check, or reconnect if Instagram has signed you out.
                      </p>
                      <Button
                        variant="secondary"
                        fullWidth
                        onClick={e => { e.stopPropagation(); fetchIgStatus(); }}
                      >Retry connection check</Button>
                      <Button
                        variant="secondary"
                        fullWidth
                        onClick={e => { e.stopPropagation(); handleConnect(integ.id); }}
                        disabled={connecting === integ.id}
                      >{connecting === integ.id ? 'Reconnecting…' : `Reconnect ${integ.name} →`}</Button>
                    </>
                  )}

                  {integ.status === 'checking' && (
                    <div style={{ ...type.bodySmall, fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', padding: '8px 0' }}>
                      Checking whether {integ.name} is still connected…
                    </div>
                  )}

                  {/* Say it out loud when the connect could not even start. */}
                  {integ.id === 'instagram' && igError && (
                    <p role="alert" style={{ ...type.bodySmall, fontSize: 12, lineHeight: 1.5, color: 'var(--danger)', margin: '10px 0 0' }}>
                      {igError}
                    </p>
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
