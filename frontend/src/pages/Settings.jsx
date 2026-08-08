import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBeautician, updateRow, supabase } from '../lib/supabase.js';
import { useTheme } from '../lib/theme.jsx';
import { API_BASE } from '../lib/config.js';
import { isNativeApp } from '../lib/platform.js';
import SMSUsageWidget from '../components/SMSUsageWidget.jsx';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';
import { isIOSNative } from '../lib/platform.js';
import Button from '../components/ui/Button.jsx';
import { isVoiceEnabled, setVoiceEnabled } from '../lib/voicePref.js';
import { celebrationsEnabled, setCelebrationsEnabled, bloom } from '../lib/bloom.js';

/**
 * Settings, beautician profile and app configuration.
 * Wired to Supabase via useBeautician. Ellie's real hours + tone model as defaults.
 */

const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export default function Settings({ onLogout }) {
  const { beautician, loading, refresh } = useBeautician();
  const { isDark, toggle: toggleDark } = useTheme();
  const navigate = useNavigate();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [section, setSection] = useState('profile');
  const [pendingCreditRules, setPendingCreditRules] = useState(null);
  const [pendingAutonomy, setPendingAutonomy] = useState(null);
  const [connectingStripe, setConnectingStripe] = useState(false);
  const [stripeError, setStripeError] = useState(null);
  const [gcalConnecting, setGcalConnecting] = useState(false);
  const [gcalBanner, setGcalBanner] = useState(null); // 'success' | 'error' | null
  const [stripeBanner, setStripeBanner] = useState(null); // 'success' | 'refresh' | 'pending' | null
  const [igConnecting, setIgConnecting] = useState(false);
  const [igBanner, setIgBanner] = useState(null); // 'success' | 'error' | 'no_page' | 'no_ig_account' | null
  // Native only: the OAuth is finishing in Safari, so this screen is waiting
  // for her to come back rather than for a redirect that will never arrive.
  const [igAwaitingReturn, setIgAwaitingReturn] = useState(false);
  // Bumping this re-runs the status check without touching the OAuth banner.
  const [igRecheck, setIgRecheck] = useState(0);
  // null = still checking; object = /api/instagram/status result;
  // { check_failed: true } = the check itself failed (network, 500).
  const [igStatus, setIgStatus] = useState(null);

  // Detect Google Calendar OAuth callback redirect (?gcal=success|error)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const gcalStatus = params.get('gcal');
    if (gcalStatus === 'success' || gcalStatus === 'error') {
      setGcalBanner(gcalStatus);
      setSection('calendar');
      window.history.replaceState({}, '', window.location.pathname);
      if (gcalStatus === 'success') refresh();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Detect Instagram OAuth callback (?ig=success|error|no_page|no_ig_account)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const igStatus = params.get('ig');
    // Honour ?section=<tab> so links (and the retired /policies redirect) open
    // the right tab, not just 'ai'.
    const sectionParam = params.get('section');
    const validSections = ['profile', 'hours', 'policy', 'payments', 'calendar', 'notifications', 'ai', 'account'];
    if (sectionParam && validSections.includes(sectionParam)) setSection(sectionParam);
    if (igStatus) {
      setIgBanner(igStatus);
      setSection('ai');
      window.history.replaceState({}, '', window.location.pathname);
      if (igStatus === 'success') refresh();
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Ask the API whether the Instagram token still WORKS. The stored id only
  // proves a past connection: Ellie's token expired on 21 June and the old
  // id-based check kept this card saying Connected while nothing went out.
  // Re-runs after the OAuth callback (igBanner) so a fresh reconnect turns
  // the card green without a manual reload.
  useEffect(() => {
    if (!beautician?.instagram_page_id) return;
    let cancelled = false;
    (async () => {
      try {
        const token = (await supabase.auth.getSession()).data.session?.access_token;
        const res = await fetch(`${API_BASE}/api/instagram/status`, {
          headers: { 'Authorization': `Bearer ${token}` },
        });
        if (!res.ok) throw new Error(`status ${res.status}`);
        const data = await res.json();
        if (!cancelled) setIgStatus(data);
      } catch (err) {
        logger.debug('Instagram status check failed:', err);
        // A failed check must read "could not check", never a false Connected.
        if (!cancelled) setIgStatus({ check_failed: true });
      }
    })();
    return () => { cancelled = true; };
  }, [beautician?.instagram_page_id, igBanner, igRecheck]); // eslint-disable-line react-hooks/exhaustive-deps

  // The native flow ends in Safari, so nothing navigates this screen when she
  // finishes. Coming back to the foreground is the only signal we get, and it
  // is enough: re-check then, and the card turns green on its own.
  useEffect(() => {
    if (!isNativeApp()) return;
    function onVisible() {
      if (document.visibilityState !== 'visible') return;
      setIgAwaitingReturn(false);
      setIgConnecting(false);
      setIgRecheck(n => n + 1);
      refresh();
    }
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Detect Stripe Connect return (?stripe=success|refresh)
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const stripeParam = params.get('stripe');
    if (stripeParam === 'success' || stripeParam === 'refresh') {
      setSection('payments');
      window.history.replaceState({}, '', window.location.pathname);
      if (stripeParam === 'success') {
        // Call status endpoint to sync charges_enabled / payouts_enabled into DB
        (async () => {
          try {
            const token = (await supabase.auth.getSession()).data.session?.access_token;
            const res = await fetch(`${API_BASE}/api/stripe/connect/status`, {
              headers: { 'Authorization': `Bearer ${token}` },
            });
            const data = await res.json();
            await refresh();
            if (data.onboarding_complete) {
              setStripeBanner('success');
            } else {
              // Stripe connected but not fully verified yet (can take a moment)
              setStripeBanner('pending');
            }
          } catch (err) {
            logger.error('Stripe status check on return:', err);
            await refresh();
            setStripeBanner('pending');
          }
        })();
      } else {
        setStripeBanner('refresh');
      }
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function saveProfile(updates) {
    if (!beautician) return;
    setSaving(true);
    setSaved(false);
    setSaveError(null);
    try {
      await updateRow('beauticians', beautician.id, updates);
      await refresh();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      logger.error('Save error:', err);
      setSaveError(err?.message || 'Save failed, please try again');
      setTimeout(() => setSaveError(null), 4000);
    } finally {
      setSaving(false);
    }
  }

  async function handleLogout() {
    if (supabase) await supabase.auth.signOut();
    if (onLogout) onLogout();
  }

  async function handleDeleteAccount() {
    if (!window.confirm('Delete your Florrie account?\n\nThis permanently erases your account and ALL your data \u2014 clients, messages, appointments, everything. This cannot be undone.')) return;
    if (window.prompt('This is permanent. Type DELETE to confirm.') !== 'DELETE') return;
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      const res = await fetch(`${API_BASE}/api/auth/account`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      });
      if (!res.ok) { window.alert('Could not delete your account. Please try again, or email hello@florrie.ai.'); return; }
      if (supabase) await supabase.auth.signOut();
      if (onLogout) onLogout();
    } catch {
      window.alert('Could not delete your account. Please try again, or email hello@florrie.ai.');
    }
  }

  async function handleConnectGoogleCal() {
    setGcalConnecting(true);
    setGcalBanner(null);
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      const res = await fetch(`${API_BASE}/api/gcal/connect`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        setGcalBanner('error');
        setGcalConnecting(false);
      }
    } catch (err) {
      logger.error('Google Cal connect error:', err);
      setGcalBanner('error');
      setGcalConnecting(false);
    }
  }

  async function handleDisconnectGoogleCal() {
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      await fetch(`${API_BASE}/api/gcal/disconnect`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      await refresh();
    } catch (err) {
      logger.error('Google Cal disconnect error:', err);
    }
  }

  /**
   * Start the Instagram OAuth.
   *
   * THIS IS WHY THE RECONNECT BUTTON DID NOTHING ON HER PHONE. It used to do
   * `window.location.href = data.url`, which points the app's own WKWebView at
   * instagram.com. Instagram refuses to render its login inside an embedded
   * webview: the page half draws, shows a "Loading" bar and a row of grey
   * placeholder cards, and stops there for ever. No error, no way back except
   * force quitting. That is exactly the screen Ellie sent.
   *
   * On native it has to leave the app. Capacitor's iOS shell hands a
   * `target="_blank"` window to the system browser, so this needs no new plugin
   * and no native rebuild. The callback then renders its own "you are done, go
   * back to Florrie" page, because that Safari tab has no Florrie session.
   */
  async function handleConnectInstagram() {
    const native = isNativeApp();
    setIgConnecting(true);
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      const res = await fetch(`${API_BASE}/api/instagram/connect${native ? '?platform=native' : ''}`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await res.json();
      if (!data.url) {
        setIgBanner('error');
        setIgConnecting(false);
        return;
      }
      if (native) {
        // Opened before any await returns elsewhere, so iOS still counts this
        // as a user gesture and does not swallow it as a popup.
        window.open(data.url, '_blank');
        setIgAwaitingReturn(true);
        setIgConnecting(false);
      } else {
        window.location.href = data.url;
      }
    } catch (err) {
      logger.error('Instagram connect error:', err);
      setIgBanner('error');
      setIgConnecting(false);
    }
  }

  async function handleDisconnectInstagram() {
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      await fetch(`${API_BASE}/api/instagram/disconnect`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
      });
      await refresh();
    } catch (err) {
      logger.error('Instagram disconnect error:', err);
    }
  }

  async function handleConnectStripe() {
    setConnectingStripe(true);
    setStripeError(null);
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      const response = await fetch(`${API_BASE}/api/stripe/connect/onboard`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
      });
      const data = await response.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        setStripeError(data.error || 'Failed to start Stripe setup');
      }
    } catch (err) {
      logger.error('Stripe connect error:', err);
      setStripeError('Network error. Please try again.');
    } finally {
      setConnectingStripe(false);
    }
  }

  if (loading) return <PageLoader />;
  if (!beautician) return <ErrorCard message="Could not load profile." onDismiss={() => {}} />;

  const hours = beautician.working_hours || {};
  const tone = beautician.tone_model || {};
  const confidence = beautician.confidence_threshold || 0.85;
  const calSettings = beautician.calendar_settings || { buffer_minutes: 10, block_personal: false, push_bookings: true, two_way_sync: false };
  const paySettings = beautician.payment_settings || { require_deposit: false, deposit_amount: '£10', no_show_fee: false, accepted_methods: ['cash'] };

  // Honest Instagram state for the card in the AI tab. An id in the database
  // only proves she connected once; the token behind it can be long dead.
  const igChecking = !!beautician.instagram_page_id && igStatus === null;
  const igNeedsReconnect = !!beautician.instagram_page_id && igStatus?.needs_reconnect === true;
  const igTokenValid = igStatus?.token_valid === true;

  return (
    <div style={{ ...styles.page, animation: 'fadeIn 0.25s cubic-bezier(0.16, 1, 0.3, 1)' }}>
      <div style={styles.header}>
        <h1 style={styles.title}>Settings</h1>
        {saved && <span style={styles.savedBadge}>Saved</span>}
        {saveError && <span style={{ ...styles.savedBadge, background: 'var(--danger, #9E2B32)', color: '#fff' }}>{saveError}</span>}
      </div>

      {/* Setup guide banner */}
      <button
        type="button"
        onClick={() => navigate('/setup')}
        style={{ display: 'flex', alignItems: 'center', gap: 8, width: '100%',
          background: 'rgba(146,64,94,0.06)',
          border: '1px solid rgba(146,64,94,0.12)',
          borderRadius: 10, padding: '11px 14px', marginBottom: 14, minHeight: 44, boxSizing: 'border-box',
          cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
          fontSize: 13, fontWeight: 600, color: 'var(--accent, #92405e)',
          WebkitTapHighlightColor: 'transparent',
        }}
      >
        New: the Setup guide shows everything in one place ›
      </button>

      {/* Section nav */}
      <div style={styles.sectionNav}>
        {[
          { key: 'profile', label: 'Profile' },
          { key: 'hours', label: 'Hours' },
          { key: 'policy', label: 'Policy' },
          { key: 'payments', label: 'Payments' },
          { key: 'calendar', label: 'Calendar' },
          { key: 'notifications', label: 'Alerts' },
          { key: 'ai', label: 'AI' },
          { key: 'account', label: 'Account' }
        ].map(s => (
          <Button
            key={s.key}
            variant="chip"
            size="sm"
            aria-pressed={section === s.key}
            onClick={() => setSection(s.key)}
            style={styles.sectionTab}
          >
            {s.label}
          </Button>
        ))}
      </div>

      {/* === PROFILE === */}
      {section === 'profile' && (
        <div style={styles.card}>
          <FieldEditor label="First name" value={beautician.first_name} onSave={v => saveProfile({ first_name: v })} />
          <FieldEditor label="Last name" value={beautician.last_name || ''} onSave={v => saveProfile({ last_name: v })} />
          <FieldEditor label="Business name" value={beautician.business_name || ''} onSave={v => saveProfile({ business_name: v })} />
          <FieldEditor label="Phone" value={beautician.phone || ''} onSave={v => saveProfile({ phone: v })} />
          <FieldEditor label="Salon address" value={beautician.address || ''} onSave={v => saveProfile({ address: v })} placeholder="e.g. 12 Bell Street, Henley-on-Thames, RG9 2BA" />

          {/* Booking link, shareable */}
          {beautician.booking_slug ? (
            <BookingLinkCard slug={beautician.booking_slug} />
          ) : (
            <div style={styles.fieldRow}>
              <span style={styles.fieldLabel}>Booking link</span>
              <span style={{ fontSize: 13, color: 'var(--text-muted)' }}>Set a booking slug below to get your link</span>
            </div>
          )}
          <FieldEditor
            label="Booking slug"
            value={beautician.booking_slug || ''}
            onSave={v => saveProfile({ booking_slug: v.toLowerCase().replace(/[^a-z0-9-]/g, '') })}
          />

          {/* Branding lives on the Business Profile page - link, don't duplicate */}
          <button
            type="button"
            onClick={() => navigate('/business')}
            style={styles.brandingLinkBtn}
          >
            <span style={styles.brandingLinkIcon}><Icon name="palette" size={19} /></span>
            <div style={{ flex: 1 }}>
              <span style={styles.brandingLinkTitle}>Branding &amp; business profile</span>
              <span style={styles.brandingLinkDesc}>Logo, brand colour, tagline, social links and email sign-off</span>
            </div>
            <span style={{ color: 'var(--text-muted)', fontSize: 18 }}>›</span>
          </button>
        </div>
      )}

      {section === 'profile' && (
        <div style={styles.card}>
          <div style={styles.cardTitle}>Tax profile</div>
          <p style={{ ...styles.cardDesc, marginBottom: 8 }}>Used to calculate your estimated liability correctly on the Tax tab.</p>

          {/* Business type */}
          <div style={{ ...styles.fieldRow, alignItems: 'flex-start', paddingTop: 12 }}>
            <span style={styles.fieldLabel}>Business type</span>
            <div style={{ display: 'flex', gap: 6 }}>
              {[
                { key: 'sole_trader', label: 'Sole trader' },
                { key: 'limited_co', label: 'Ltd company' },
              ].map(opt => {
                const active = (beautician.business_type || 'sole_trader') === opt.key;
                return (
                  <button className="fl-tap"
                    key={opt.key}
                    onClick={() => saveProfile({ business_type: opt.key })}
                    style={{ padding: '6px 12px', borderRadius: 10, border: 'none',
                      fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
                      background: active ? 'var(--accent)' : 'var(--border-light)',
                      color: active ? 'var(--bg-card)' : 'var(--text-secondary)',
                    }}
                  >
                    {opt.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* VAT registered */}
          <div style={styles.fieldRow}>
            <div>
              <span style={styles.fieldLabel}>VAT registered</span>
              <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>UK threshold: £90,000 rolling 12 months</span>
            </div>
            <button
              onClick={() => saveProfile({ vat_registered: !beautician.vat_registered })}
              style={{ ...styles.toggle, background: beautician.vat_registered ? 'var(--accent)' : 'var(--border)' }}
            >
              <div style={{ ...styles.toggleDot, transform: beautician.vat_registered ? 'translateX(20px)' : 'translateX(2px)' }} />
            </button>
          </div>

          {/* VAT number, only shown if registered */}
          {beautician.vat_registered && (
            <FieldEditor
              label="VAT number"
              value={beautician.vat_number || ''}
              onSave={v => saveProfile({ vat_number: v.toUpperCase().replace(/\s/g, '') })}
            />
          )}
        </div>
      )}

      {/* === WORKING HOURS === */}
      {section === 'hours' && (
        <div style={styles.card}>
          <p style={styles.cardDesc}>Set when clients can book appointments.</p>
          {DAY_KEYS.map((day, idx) => {
            const dayHours = hours[day];
            const enabled = !!dayHours;
            return (
              <div key={day} style={styles.dayRow}>
                <label style={styles.dayToggle}>
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={() => {
                      const newHours = { ...hours };
                      if (enabled) { newHours[day] = null; } else { newHours[day] = { start: '09:00', end: '17:00' }; }
                      saveProfile({ working_hours: newHours });
                    }}
                  />
                  <span style={{ ...styles.dayName, color: enabled ? 'var(--text-primary)' : 'var(--text-muted)' }}>
                    {DAYS[idx]}
                  </span>
                </label>
                {enabled && (
                  <div style={styles.timeInputs}>
                    <input type="time" value={dayHours?.start || '09:00'} onChange={e => { const nh = { ...hours, [day]: { ...hours[day], start: e.target.value } }; saveProfile({ working_hours: nh }); }} style={styles.timeInput} />
                    <span style={styles.timeSep}>to</span>
                    <input type="time" value={dayHours?.end || '17:00'} onChange={e => { const nh = { ...hours, [day]: { ...hours[day], end: e.target.value } }; saveProfile({ working_hours: nh }); }} style={styles.timeInput} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {section === 'hours' && (
        <div style={styles.card}>
          <h3 style={styles.cardTitle}>Block time off</h3>
          <p style={styles.cardDesc}>Need a day off, holiday, or a quick lunch break? Block time without changing your regular schedule.</p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            <button
              onClick={() => { window.location.href = '/hours'; }}
              style={styles.blockLinkBtn}
            >
              <span style={styles.blockLinkIcon}><Icon name="calendar" size={19} /></span>
              <div>
                <span style={styles.blockLinkTitle}>Full days &amp; exceptions</span>
                <span style={styles.blockLinkDesc}>Close for a holiday, change hours for a specific date</span>
              </div>
              <span style={{ color: 'var(--text-muted)', fontSize: 18 }}>›</span>
            </button>
            <button
              onClick={() => { window.location.href = '/calendar'; }}
              style={styles.blockLinkBtn}
            >
              <span style={styles.blockLinkIcon}><Icon name="x" size={19} /></span>
              <div>
                <span style={styles.blockLinkTitle}>Block a time slot</span>
                <span style={styles.blockLinkDesc}>Lunch break, rest of day, or any custom window</span>
              </div>
              <span style={{ color: 'var(--text-muted)', fontSize: 18 }}>›</span>
            </button>
          </div>
        </div>
      )}

      {/* === BOOKING POLICY === */}
      {section === 'policy' && (() => {
        const policy = beautician.booking_policy || {};
        const minHours = policy.min_booking_hours ?? 0;
        const bufferEnabled = policy.payment_buffer_enabled ?? false;
        const bufferMinutes = policy.payment_buffer_minutes ?? 10;
        const cancelHours = policy.cancellation_notice_hours ?? 48;
        const chargePercent = policy.late_cancel_charge_percent ?? 100;
        // A no-show is its own thing: it used to silently inherit the late-cancel
        // percent, so setting late-cancel to 0 (deposit kept, not 100%) also
        // silenced no-show charging entirely.
        const noShowPercent = policy.no_show_charge_percent ?? policy.late_cancel_charge_percent ?? 0;
        const requireReschedDeposit = policy.require_deposit_on_late_reschedule ?? false;
        const reschedOnce = policy.reschedule_once ?? false;
        const reschedBetween = policy.reschedule_between_only ?? false;

        function savePolicy(updates) {
          saveProfile({ booking_policy: { ...policy, ...updates } });
        }

        return (
          <div>
            {/* Advance booking */}
            <div style={styles.card}>
              <div style={styles.cardTitle}>Minimum notice</div>
              <p style={styles.cardDesc}>How far in advance must clients book? Set to 0 to allow same-day bookings.</p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
                <input
                  type="range"
                  min={0} max={72} step={1}
                  value={minHours}
                  onChange={e => savePolicy({ min_booking_hours: Number(e.target.value) })}
                  style={{ flex: 1, accentColor: 'var(--accent)' }}
                />
                <span style={{ minWidth: 80, fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', textAlign: 'right' }}>
                  {minHours === 0 ? 'Same day ok' : `${minHours}h notice`}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Same day</span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>72h</span>
              </div>
            </div>

            {/* How far ahead the diary is open */}
            <div style={styles.card}>
              <div style={styles.cardTitle}>How far ahead clients can book</div>
              <p style={styles.cardDesc}>Keep your diary from filling up too far in advance. Clients booking online can only choose dates inside this window.</p>
              <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                {[
                  { label: 'No limit', days: 0 },
                  { label: '1 month', days: 30 },
                  { label: '2 months', days: 60 },
                  { label: '3 months', days: 90 },
                ].map(opt => {
                  const active = (policy.max_advance_days ?? 0) === opt.days;
                  return (
                    <button className="fl-tap"
                      key={opt.days}
                      onClick={() => savePolicy({ max_advance_days: opt.days })}
                      style={{ flex: 1, padding: '9px 4px', borderRadius: 10, fontSize: 12.5, fontWeight: 600,
                        cursor: 'pointer', fontFamily: 'inherit',
                        border: active ? '1.5px solid var(--accent)' : '1.5px solid var(--border)',
                        background: active ? 'var(--accent)' : 'var(--bg-card)',
                        color: active ? '#fff' : 'var(--text-secondary)',
                      }}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Payment buffer */}
            <div style={styles.card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={styles.cardTitle}>Payment buffer</div>
                <button
                  onClick={() => savePolicy({ payment_buffer_enabled: !bufferEnabled })}
                  style={{ ...styles.toggle, background: bufferEnabled ? 'var(--accent)' : 'var(--border)' }}
                >
                  <div style={{ ...styles.toggleDot, transform: bufferEnabled ? 'translateX(20px)' : 'translateX(2px)' }} />
                </button>
              </div>
              <p style={styles.cardDesc}>
                Hold the slot while the client pays. If payment isn't received within the window, the slot is released automatically.
              </p>
              {bufferEnabled && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 }}>
                  <input
                    type="range"
                    min={5} max={60} step={5}
                    value={bufferMinutes}
                    onChange={e => savePolicy({ payment_buffer_minutes: Number(e.target.value) })}
                    style={{ flex: 1, accentColor: 'var(--accent)' }}
                  />
                  <span style={{ minWidth: 80, fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', textAlign: 'right' }}>
                    {bufferMinutes} min
                  </span>
                </div>
              )}
            </div>

            {/* Cancellation policy */}
            <div style={styles.card}>
              <div style={styles.cardTitle}>Cancellation notice</div>
              <p style={styles.cardDesc}>
                How many hours' notice is required to cancel without a fee? Clients who cancel inside this window can be charged.
              </p>
              <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
                <input
                  type="range"
                  min={0} max={168} step={4}
                  value={cancelHours}
                  onChange={e => savePolicy({ cancellation_notice_hours: Number(e.target.value) })}
                  style={{ flex: 1, accentColor: 'var(--accent)' }}
                />
                <span style={{ minWidth: 80, fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', textAlign: 'right' }}>
                  {cancelHours === 0 ? 'No policy' : cancelHours < 24 ? `${cancelHours}h` : `${cancelHours / 24}d`}
                </span>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>No policy</span>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>7 days</span>
              </div>

              {cancelHours > 0 && (
                <>
                  <div style={{ height: 1, background: 'var(--border-light)', margin: '14px 0' }} />
                  <div style={styles.cardTitle}>Late cancel charge</div>
                  <p style={styles.cardDesc}>Percentage of the appointment value charged when a client cancels late.</p>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
                    <input
                      type="range"
                      min={0} max={100} step={10}
                      value={chargePercent}
                      onChange={e => savePolicy({ late_cancel_charge_percent: Number(e.target.value) })}
                      style={{ flex: 1, accentColor: 'var(--accent)' }}
                    />
                    <span style={{ minWidth: 80, fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', textAlign: 'right' }}>
                      {chargePercent === 0 ? 'No charge' : `${chargePercent}%`}
                    </span>
                  </div>

                  <div style={{ height: 1, background: 'var(--border-light)', margin: '14px 0' }} />
                  <div style={styles.cardTitle}>No-show charge</div>
                  <p style={styles.cardDesc}>
                    Percentage charged when a client simply doesn't turn up. Set this separately from
                    late cancels, a no-show costs you the whole slot with no warning. You always
                    confirm each charge yourself before any money is taken.
                  </p>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 8 }}>
                    <input
                      type="range"
                      min={0} max={100} step={10}
                      value={noShowPercent}
                      onChange={e => savePolicy({ no_show_charge_percent: Number(e.target.value) })}
                      style={{ flex: 1, accentColor: 'var(--accent)' }}
                    />
                    <span style={{ minWidth: 80, fontSize: 14, fontWeight: 600, color: 'var(--text-primary)', textAlign: 'right' }}>
                      {noShowPercent === 0 ? 'No charge' : `${noShowPercent}%`}
                    </span>
                  </div>
                  {noShowPercent > 0 && !(beautician.payment_settings?.require_deposit || beautician.payment_settings?.deposit_required) && (
                    <p style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--warning-text, #8A6420)', background: 'var(--warning-bg, #F7EEDD)', border: '1px solid #F0D9A8', borderRadius: 10, padding: '8px 10px', margin: '10px 0 0' }}>
                      Heads up: you can only charge a card you actually hold. Cards are saved when
                      deposits are on (Settings &gt; Payments). With deposits off, a no-show fee has
                      nothing to charge against.
                    </p>
                  )}

                  <div style={{ height: 1, background: 'var(--border-light)', margin: '14px 0' }} />
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={styles.cardTitle}>New deposit on late reschedule</div>
                    <button
                      onClick={() => savePolicy({ require_deposit_on_late_reschedule: !requireReschedDeposit })}
                      style={{ ...styles.toggle, background: requireReschedDeposit ? 'var(--accent)' : 'var(--border)' }}
                    >
                      <div style={{ ...styles.toggleDot, transform: requireReschedDeposit ? 'translateX(20px)' : 'translateX(2px)' }} />
                    </button>
                  </div>
                  <p style={styles.cardDesc}>
                    If a client moves their appointment inside the notice window, charge the late-cancel fee for the original and take a fresh deposit for the new slot from their saved card. If there's no usable card, the move is blocked.
                  </p>
                </>
              )}
            </div>

            {/* Client reschedule controls , how much freedom clients get when
                moving their own appointment from the manage-booking link. */}
            <div style={styles.card}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={styles.cardTitle}>Only one reschedule</div>
                <button
                  onClick={() => savePolicy({ reschedule_once: !reschedOnce })}
                  style={{ ...styles.toggle, background: reschedOnce ? 'var(--accent)' : 'var(--border)' }}
                >
                  <div style={{ ...styles.toggleDot, transform: reschedOnce ? 'translateX(20px)' : 'translateX(2px)' }} />
                </button>
              </div>
              <p style={styles.cardDesc}>
                Clients can move a booking once from their manage link. After that they'll be asked to contact you directly, so nobody keeps shuffling the same appointment.
              </p>

              <div style={{ height: 1, background: 'var(--border-light)', margin: '14px 0' }} />

              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={styles.cardTitle}>Only offer times between existing bookings</div>
                <button
                  onClick={() => savePolicy({ reschedule_between_only: !reschedBetween })}
                  style={{ ...styles.toggle, background: reschedBetween ? 'var(--accent)' : 'var(--border)' }}
                >
                  <div style={{ ...styles.toggleDot, transform: reschedBetween ? 'translateX(20px)' : 'translateX(2px)' }} />
                </button>
              </div>
              <p style={styles.cardDesc}>
                When a client reschedules, only show times that sit right before or after another appointment that day. Keeps your diary tight so you're never coming in for one isolated client. With this off, clients pick any free time.
              </p>
            </div>

            {/* Custom client-facing cancellation note (migrated from the retired
                Policies page; saved to booking_policy so it's the real source). */}
            <div style={styles.card}>
              <div style={styles.cardTitle}>Cancellation note (optional)</div>
              <p style={styles.cardDesc}>A note in your own words, shown to clients on your booking page and their manage-booking link, under the cancellation policy.</p>
              <textarea
                defaultValue={policy.cancellation_message || ''}
                onBlur={e => savePolicy({ cancellation_message: e.target.value.trim() })}
                placeholder="e.g. Please give as much notice as you can if you need to rearrange, my slots book up fast 🌸"
                rows={3}
                style={{ minHeight: 44, width: '100%', marginTop: 8, padding: '10px 12px', borderRadius: 10, border: '1.5px solid var(--border)', fontSize: 14, fontFamily: 'inherit', resize: 'vertical', boxSizing: 'border-box', background: 'var(--bg-card)', color: 'var(--text-primary)' }}
              />
            </div>

            {/* Policy preview */}
            {(minHours > 0 || cancelHours > 0) && (
              <div style={{ ...styles.card, background: 'var(--accent-light)', border: '1.5px solid rgba(199, 107, 138, 0.2)' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
                  <Icon name={iconName('policy')} size={18} inline style={{ color: 'var(--accent)', }} />
                  <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>Your booking policy (as clients see it)</span>
                </div>
                <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55, margin: 0 }}>
                  {minHours > 0 && `Bookings must be made at least ${minHours < 24 ? `${minHours} hours` : `${minHours / 24} day${minHours / 24 !== 1 ? 's' : ''}`} in advance. `}
                  {cancelHours > 0 && `We require ${cancelHours < 24 ? `${cancelHours} hours` : `${cancelHours / 24} day${cancelHours / 24 !== 1 ? 's' : ''}`} notice to cancel or reschedule. `}
                  {cancelHours > 0 && chargePercent > 0 && `Late cancellations within this window may be charged ${chargePercent}% of the appointment value.`}
                  {cancelHours > 0 && chargePercent === 0 && `No charge applies for late cancellations.`}
                  {cancelHours > 0 && requireReschedDeposit && ` Rescheduling inside this window is charged for the original appointment, and the new appointment requires a fresh deposit.`}
                </p>
                {policy.cancellation_message && (
                  <p style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.55, margin: '8px 0 0', fontStyle: 'italic' }}>
                    "{policy.cancellation_message}"
                  </p>
                )}
              </div>
            )}
          </div>
        );
      })()}

      {/* === PAYMENTS (STRIPE) === */}
      {section === 'payments' && (
        <div>
          {/* Stripe return banners */}
          {stripeBanner === 'success' && (
            <div style={{ background: 'var(--success)', color: '#fff', borderRadius: 10, padding: '12px 16px', marginBottom: 12, fontSize: 13, fontWeight: 500 }}><Icon name="check" size={14} inline /> Stripe connected, you can now accept card payments and deposits.
            </div>
          )}
          {stripeBanner === 'pending' && (
            <div style={{ background: 'var(--warning)', color: '#fff', borderRadius: 10, padding: '12px 16px', marginBottom: 12, fontSize: 13, fontWeight: 500 }}>
              Stripe setup received, it may take a few minutes for your account to be fully verified. Refresh this page shortly.
            </div>
          )}
          {stripeBanner === 'refresh' && (
            <div style={{ background: 'var(--border)', color: 'var(--text-primary)', borderRadius: 10, padding: '12px 16px', marginBottom: 12, fontSize: 13 }}>
              Stripe setup wasn't completed. Click Connect Stripe to try again.
            </div>
          )}
          {/* Connection status */}
          <div style={styles.card}>
            <div style={styles.cardTitle}>Stripe Connect</div>
            <div style={styles.connectionStatus}>
              <div style={{ ...styles.statusDot,
                background: beautician.stripe_onboarding_complete ? 'var(--success)' : 'var(--warning)',
              }} />
              <span style={styles.connectionLabel}>
                {beautician.stripe_onboarding_complete ? 'Connected' : 'Not connected'}
              </span>
            </div>
            <p style={styles.cardHint}>
              {beautician.stripe_onboarding_complete
                ? 'Card payments are live. Clients can pay online and via Tap to Pay.'
                : 'Connect Stripe to accept card payments, deposits, and no-show fees.'}
            </p>
            {stripeError && (
              <p style={{ fontSize: 13, color: '#E57373', margin: '0 0 8px' }}>{stripeError}</p>
            )}
            {!beautician.stripe_onboarding_complete && (
              <Button
                size="sm"
                onClick={handleConnectStripe}
                disabled={connectingStripe}
              >
                {connectingStripe ? 'Setting up…' : 'Connect Stripe'}
              </Button>
            )}
          </div>

          {/* Subscription management, hidden on native iOS for App Store
              Guideline 3.1.3(b) compliance (no external purchasing surfaces). */}
          {beautician.stripe_customer_id && !isIOSNative() && (
            <SubscriptionManager beautician={beautician} />
          )}

          {/* Payment methods */}
          <div style={styles.card}>
            <div style={styles.cardTitle}>Accepted payment methods</div>
            {[
              { key: 'card_online', label: 'Card online', desc: 'Clients pay when booking', icon: 'card', requiresStripe: true },
              { key: 'tap_to_pay', label: 'Tap to Pay', desc: 'Use your phone as a card terminal', icon: 'phone', requiresStripe: true },
              { key: 'cash', label: 'Cash', desc: 'Record cash payments manually', icon: 'pound', requiresStripe: false },
              { key: 'bank_transfer', label: 'Bank transfer', desc: 'BACS or faster payment', icon: 'wallet', requiresStripe: false },
            ].map(method => {
              const isEnabled = (paySettings.accepted_methods || ['cash']).includes(method.key);
              const canToggle = !method.requiresStripe || beautician.stripe_onboarding_complete;
              return (
                <div key={method.key} style={styles.paymentMethodRow}>
                  <span style={{ fontSize: 18 }}><Icon name={iconName(method.icon)} inline /></span>
                  <div style={{ flex: 1 }}>
                    <span style={styles.methodLabel}>{method.label}</span>
                    <span style={styles.methodDesc}>
                      {method.desc}{method.requiresStripe && !beautician.stripe_onboarding_complete ? ' · Requires Stripe' : ''}
                    </span>
                  </div>
                  <button
                    disabled={!canToggle}
                    onClick={() => {
                      const methods = paySettings.accepted_methods || ['cash'];
                      const updated = isEnabled ? methods.filter(m => m !== method.key) : [...methods, method.key];
                      saveProfile({ payment_settings: { ...paySettings, accepted_methods: updated } });
                    }}
                    style={{ ...styles.toggle,
                      background: isEnabled && canToggle ? 'var(--accent-rose)' : '#E0DBD5',
                      opacity: canToggle ? 1 : 0.5,
                      cursor: canToggle ? 'pointer' : 'not-allowed',
                    }}
                  >
                    <div style={{ ...styles.toggleDot, transform: isEnabled && canToggle ? 'translateX(16px)' : 'translateX(0)' }} />
                  </button>
                </div>
              );
            })}
          </div>

          {/* Bank transfer details, shown to clients so they can pay the balance */}
          <div style={styles.card}>
            <div style={styles.cardTitle}>Bank transfer details</div>
            <p style={styles.cardDesc}>Shown to clients so they can transfer the balance after their deposit.</p>
            <FieldEditor
              label="Account name"
              value={beautician.payment_settings?.bank_details?.account_name || ''}
              onSave={v => saveProfile({ payment_settings: { ...(beautician.payment_settings || {}), bank_details: { ...(beautician.payment_settings?.bank_details || {}), account_name: v } } })}
            />
            <FieldEditor
              label="Sort code"
              value={beautician.payment_settings?.bank_details?.sort_code || ''}
              onSave={v => saveProfile({ payment_settings: { ...(beautician.payment_settings || {}), bank_details: { ...(beautician.payment_settings?.bank_details || {}), sort_code: v } } })}
            />
            <FieldEditor
              label="Account number"
              value={beautician.payment_settings?.bank_details?.account_number || ''}
              onSave={v => saveProfile({ payment_settings: { ...(beautician.payment_settings || {}), bank_details: { ...(beautician.payment_settings?.bank_details || {}), account_number: v } } })}
            />
            <FieldEditor
              label="Payment reference note (optional)"
              value={beautician.payment_settings?.bank_details?.reference_note || ''}
              onSave={v => saveProfile({ payment_settings: { ...(beautician.payment_settings || {}), bank_details: { ...(beautician.payment_settings?.bank_details || {}), reference_note: v } } })}
            />
          </div>

          {/* Payout info */}
          <div style={styles.card}>
            <div style={styles.cardTitle}>Payouts</div>
            <div style={styles.payoutRow}>
              <span style={styles.payoutLabel}>Schedule</span>
              <span style={styles.payoutValue}>Daily (arrives next business day)</span>
            </div>
            <div style={styles.payoutRow}>
              <span style={styles.payoutLabel}>Card processing</span>
              <span style={styles.payoutValue}>About 2.9% + 20p (Stripe 1.4% + 20p, Florrie 1.5%)</span>
            </div>
            <div style={styles.payoutRow}>
              <span style={styles.payoutLabel}>Account</span>
              <span style={styles.payoutValue}>{beautician.stripe_onboarding_complete ? 'Connected via Stripe' : 'Not linked'}</span>
            </div>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8, marginBottom: 8 }}>
              When a client pays by card through Florrie, two small fees come off before the
              money reaches you. Stripe takes 1.4% + 20p to process the card, and Florrie takes
              1.5% of the amount (at least 5p, never more than £5). Everything else lands in
              your bank on the next payout. On a £10 deposit that is 34p to Stripe and 15p to
              Florrie, so you keep £9.51. On a £45 balance you keep about £43.49. The app shows
              you this figure before every charge, so there are never surprises.
            </p>
            <p style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 0, marginBottom: 8 }}>
              Bank transfers and cash are always fee free. Add your bank details above and the
              booking page shows them, so clients can transfer the balance straight to you.
            </p>
            {beautician.stripe_onboarding_complete && (
              <a className="fl-tap"
                href="https://dashboard.stripe.com/express/login"
                target="_blank"
                rel="noopener noreferrer"
                style={{ display: 'inline-block', padding: '8px 16px', borderRadius: 10,
                  background: 'var(--bg-secondary, #f8f2ef)', border: '1px solid var(--border)',
                  fontSize: 13, fontWeight: 500, color: 'var(--text-primary)',
                  textDecoration: 'none',
                }}
              >
                View Stripe dashboard →
              </a>
            )}
            {!beautician.stripe_onboarding_complete && (
              <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: 0 }}>
                Connect Stripe above to start receiving card payments and deposits.
              </p>
            )}
          </div>
        </div>
      )}

      {/* === CALENDAR SYNC === */}
      {section === 'calendar' && (
        <div>
          <div style={styles.card}>
            <div style={styles.cardTitle}>Calendar sync</div>
            <p style={styles.cardHint}>
              Connect your calendar so florrie.ai can check availability and avoid double-bookings.
            </p>
          </div>

          {/* Google Calendar */}
          <div style={styles.card}>
            <div style={styles.calendarProviderRow}>
              <Icon name="calendar" size={21} style={{ color: 'var(--accent)' }} />
              <div style={{ flex: 1 }}>
                <span style={styles.calProviderLabel}>Google Calendar</span>
                <span style={{ ...styles.calProviderStatus,
                  color: beautician.google_calendar_connected ? 'var(--success)' : 'var(--text-muted)',
                }}>
                  {beautician.google_calendar_connected ? '● Connected' : 'Not connected'}
                </span>
              </div>
              {beautician.google_calendar_connected ? (
                <button
                  onClick={handleDisconnectGoogleCal}
                  style={{ ...styles.connectBtn, background: 'var(--bg-hover)', color: 'var(--text-secondary)', border: '1.5px solid var(--border)' }}
                >
                  Disconnect
                </button>
              ) : (
                <Button
                  size="sm"
                  onClick={handleConnectGoogleCal}
                  disabled={gcalConnecting}
                >
                  {gcalConnecting ? 'Connecting…' : 'Connect'}
                </Button>
              )}
            </div>
            {gcalBanner === 'success' && (
              <p style={{ fontSize: 12, color: 'var(--success)', marginTop: 8, marginBottom: 0 }}><Icon name="check" size={14} inline /> Google Calendar connected</p>
            )}
            {gcalBanner === 'error' && (
              <p style={{ fontSize: 12, color: 'var(--danger, #9E2B32)', marginTop: 8, marginBottom: 0 }}>Connection failed, check your Google credentials and try again</p>
            )}
          </div>

          {/* Apple / iPhone, use ICS feed */}
          <div style={styles.card}>
            <div style={styles.calendarProviderRow}>
              <Icon name="calendar" size={21} style={{ color: 'var(--accent)' }} />
              <div style={{ flex: 1 }}>
                <span style={styles.calProviderLabel}>Apple Calendar</span>
                <span style={styles.calProviderStatus}>Subscribe using the ICS feed below</span>
              </div>
              <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', background: 'var(--border-light)', padding: '4px 8px', borderRadius: 6 }}>
                ICS
              </span>
            </div>
          </div>

          {/* Sync settings */}
          <div style={styles.card}>
            <div style={styles.cardTitle}>Sync behaviour</div>

            {[
              { key: 'block_personal', label: 'Block personal events', hint: 'Personal calendar events block booking slots' },
              { key: 'push_bookings', label: 'Push bookings to calendar', hint: 'New bookings appear in your connected calendar' },
              { key: 'two_way_sync', label: 'Two-way sync', hint: 'Changes in either calendar stay in sync' },
            ].map(toggle => (
              <div key={toggle.key} style={styles.syncRow}>
                <div style={{ flex: 1 }}>
                  <span style={styles.syncLabel}>{toggle.label}</span>
                  <span style={styles.syncHint}>{toggle.hint}</span>
                </div>
                <button
                  onClick={() => saveProfile({ calendar_settings: { ...calSettings, [toggle.key]: !calSettings[toggle.key] } })}
                  style={{ ...styles.toggle, background: calSettings[toggle.key] ? 'var(--accent)' : 'var(--border)' }}
                >
                  <div style={{ ...styles.toggleDot, transform: calSettings[toggle.key] ? 'translateX(20px)' : 'translateX(2px)' }} />
                </button>
              </div>
            ))}
          </div>

          {/* Buffer time */}
          <div style={styles.card}>
            <div style={styles.cardTitle}>Buffer time</div>
            <p style={styles.cardHint}>Gap between appointments for cleanup and prep.</p>
            <div style={styles.bufferOptions}>
              {[{ label: 'None', mins: 0 }, { label: '5 min', mins: 5 }, { label: '10 min', mins: 10 }, { label: '15 min', mins: 15 }, { label: '30 min', mins: 30 }].map(opt => (
                <button
                  key={opt.label}
                  onClick={() => saveProfile({ calendar_settings: { ...calSettings, buffer_minutes: opt.mins } })}
                  style={{ ...styles.bufferChip,
                    background: (calSettings.buffer_minutes ?? 10) === opt.mins ? 'var(--accent-rose)' : '#F5F2EF',
                    color: (calSettings.buffer_minutes ?? 10) === opt.mins ? '#fff' : '#8A8580',
                  }}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* === NOTIFICATIONS === */}
      {section === 'notifications' && (
        <div>
          <div style={styles.card}>
            <h3 style={styles.cardTitle}>Your notifications</h3>
            <p style={styles.cardDesc}>Choose how you want to be notified about activity.</p>
            <NotificationToggle
              label="New bookings"
              desc="When a client books an appointment"
              prefs={beautician.notification_prefs?.booking_confirmed || { email: true, push: true }}
              onChange={v => {
                const np = { ...(beautician.notification_prefs || {}), booking_confirmed: v };
                saveProfile({ notification_prefs: np });
              }}
            />
            <NotificationToggle
              label="Cancellations"
              desc="When a client cancels"
              prefs={beautician.notification_prefs?.booking_cancelled || { email: true, push: true }}
              onChange={v => {
                const np = { ...(beautician.notification_prefs || {}), booking_cancelled: v };
                saveProfile({ notification_prefs: np });
              }}
            />
            <NotificationToggle
              label="AI escalations"
              desc="When the AI isn't sure and needs you"
              prefs={beautician.notification_prefs?.ai_escalation || { email: true, push: true }}
              onChange={v => {
                const np = { ...(beautician.notification_prefs || {}), ai_escalation: v };
                saveProfile({ notification_prefs: np });
              }}
            />
            <NotificationToggle
              label="Payment received"
              desc="When you get paid"
              prefs={beautician.notification_prefs?.payment_received || { email: true, push: true }}
              onChange={v => {
                const np = { ...(beautician.notification_prefs || {}), payment_received: v };
                saveProfile({ notification_prefs: np });
              }}
            />
            <NotificationToggle
              label="Weekly digest"
              desc="Summary of your week every Monday"
              prefs={beautician.notification_prefs?.weekly_digest || { email: true, push: false }}
              onChange={v => {
                const np = { ...(beautician.notification_prefs || {}), weekly_digest: v };
                saveProfile({ notification_prefs: np });
              }}
            />
            <NotificationToggle
              label="Daily takings"
              desc="Your evening money summary, with the good news called out"
              prefs={beautician.notification_prefs?.daily_summary || { email: false, push: true }}
              onChange={v => {
                const np = { ...(beautician.notification_prefs || {}), daily_summary: v };
                saveProfile({ notification_prefs: np });
              }}
            />
            <NotificationToggle
              label="Milestones"
              desc="First £1k week, fully booked days, client number 100"
              prefs={beautician.notification_prefs?.milestones || { email: false, push: true }}
              onChange={v => {
                const np = { ...(beautician.notification_prefs || {}), milestones: v };
                saveProfile({ notification_prefs: np });
              }}
            />
            <NotificationToggle
              label="Week in review"
              desc="Sunday evening: what Florrie handled for you this week"
              prefs={beautician.notification_prefs?.weekly_review || { email: false, push: true }}
              onChange={v => {
                const np = { ...(beautician.notification_prefs || {}), weekly_review: v };
                saveProfile({ notification_prefs: np });
              }}
            />
          </div>

          <div style={styles.card}>
            <h3 style={styles.cardTitle}>Quiet hours</h3>
            <p style={styles.cardDesc}>
              Off by default so you never miss Florrie working for you overnight.
              Turn on to hold non-urgent pings during the hours you choose
              (escalations always come through). Everything held still shows in the app.
            </p>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 0' }}>
              <span style={{ fontSize: 14, color: 'var(--text-primary)' }}>Hold pushes overnight</span>
              <button className="fl-tap"
                onClick={() => {
                  const qh = beautician.notification_prefs?.quiet_hours || {};
                  const np = { ...(beautician.notification_prefs || {}), quiet_hours: { ...qh, enabled: qh.enabled !== true } };
                  saveProfile({ notification_prefs: np });
                }}
                style={{ width: 48, height: 28, borderRadius: 16, border: 'none', cursor: 'pointer',
                  background: beautician.notification_prefs?.quiet_hours?.enabled === true ? 'var(--accent-rose, #C76B8A)' : '#E5E0DB',
                  position: 'relative', transition: 'background 0.15s ease',
                }}
                aria-label="Toggle quiet hours"
              >
                <span style={{ position: 'absolute', top: 3,
                  left: beautician.notification_prefs?.quiet_hours?.enabled === true ? 23 : 3,
                  width: 22, height: 22, borderRadius: 10, background: '#fff',
                  boxShadow: 'var(--elev-1)', transition: 'left 0.15s ease',
                }} />
              </button>
            </div>
            {beautician.notification_prefs?.quiet_hours?.enabled === true && (
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', paddingTop: 4 }}>
                <label style={{ fontSize: 13, color: 'var(--text-secondary)' }}>From</label>
                <input
                  type="time"
                  value={beautician.notification_prefs?.quiet_hours?.start || '21:00'}
                  onChange={e => {
                    const qh = beautician.notification_prefs?.quiet_hours || {};
                    const np = { ...(beautician.notification_prefs || {}), quiet_hours: { ...qh, enabled: true, start: e.target.value } };
                    saveProfile({ notification_prefs: np });
                  }}
                  style={{ minHeight: 44, padding: '6px 10px', borderRadius: 10, border: '1px solid var(--border, #E8DDD4)', fontFamily: 'inherit', fontSize: 13 }}
                />
                <label style={{ fontSize: 13, color: 'var(--text-secondary)' }}>to</label>
                <input
                  type="time"
                  value={beautician.notification_prefs?.quiet_hours?.end || '08:00'}
                  onChange={e => {
                    const qh = beautician.notification_prefs?.quiet_hours || {};
                    const np = { ...(beautician.notification_prefs || {}), quiet_hours: { ...qh, enabled: true, end: e.target.value } };
                    saveProfile({ notification_prefs: np });
                  }}
                  style={{ minHeight: 44, padding: '6px 10px', borderRadius: 10, border: '1px solid var(--border, #E8DDD4)', fontFamily: 'inherit', fontSize: 13 }}
                />
              </div>
            )}
          </div>

          <div style={styles.card}>
            <h3 style={styles.cardTitle}>Client reminders</h3>
            <p style={styles.cardDesc}>What your clients receive automatically.</p>

            {/* Master pause - one switch to stop everything going out on her behalf. */}
            {(() => {
              const paused = beautician.client_reminder_prefs?.paused === true;
              return (
                <div style={{ ...styles.pauseRow, ...(paused ? styles.pauseRowOn : {}) }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={styles.pauseTitle}>
                      {paused ? 'Messages paused' : 'Messages on'}
                    </div>
                    <div style={styles.pauseDesc}>
                      {paused
                        ? 'Nothing is being sent to clients right now. Turn back on when you’re ready.'
                        : 'Pause every automatic message to clients in one tap.'}
                    </div>
                  </div>
                  <button className="fl-tap"
                    onClick={() => {
                      const rp = { ...(beautician.client_reminder_prefs || {}), paused: !paused };
                      saveProfile({ client_reminder_prefs: rp });
                    }}
                    style={{ ...styles.toggle, background: paused ? '#D4605C' : 'var(--accent)', width: 44, height: 24 }}
                    aria-label={paused ? 'Resume client messages' : 'Pause client messages'}
                  >
                    <div style={{ ...styles.toggleDot, transform: paused ? 'translateX(20px)' : 'translateX(2px)' }} />
                  </button>
                </div>
              );
            })()}

            <ClientReminderRow
              label="Booking confirmation"
              enabled={beautician.client_reminder_prefs?.booking_confirmation !== false}
              onChange={v => {
                const rp = { ...(beautician.client_reminder_prefs || {}), booking_confirmation: v };
                saveProfile({ client_reminder_prefs: rp });
              }}
            />
            <ClientReminderRow
              label="24-hour reminder"
              enabled={beautician.client_reminder_prefs?.reminder_24h !== false}
              onChange={v => {
                const rp = { ...(beautician.client_reminder_prefs || {}), reminder_24h: v };
                saveProfile({ client_reminder_prefs: rp });
              }}
            />
            <ClientReminderRow
              label="1-hour reminder"
              enabled={beautician.client_reminder_prefs?.reminder_1h || false}
              onChange={v => {
                const rp = { ...(beautician.client_reminder_prefs || {}), reminder_1h: v };
                saveProfile({ client_reminder_prefs: rp });
              }}
            />
            <ClientReminderRow
              label="Aftercare follow-up"
              enabled={beautician.client_reminder_prefs?.aftercare_followup !== false}
              onChange={v => {
                const rp = { ...(beautician.client_reminder_prefs || {}), aftercare_followup: v };
                saveProfile({ client_reminder_prefs: rp });
              }}
            />
            <ClientReminderRow
              label="Smart rebook nudge"
              enabled={beautician.client_reminder_prefs?.rebook_nudge !== false}
              onChange={v => {
                const rp = { ...(beautician.client_reminder_prefs || {}), rebook_nudge: v };
                saveProfile({ client_reminder_prefs: rp });
              }}
            />
            <div style={styles.channelPicker}>
              <span style={styles.channelLabel}>Send via</span>
              <div style={styles.channelOptions}>
                {['whatsapp', 'email', 'sms'].map(ch => (
                  <button
                    key={ch}
                    onClick={() => {
                      const rp = { ...(beautician.client_reminder_prefs || {}), channel: ch };
                      saveProfile({ client_reminder_prefs: rp });
                    }}
                    style={{ ...styles.channelChip,
                      background: (beautician.client_reminder_prefs?.channel || 'whatsapp') === ch ? 'var(--accent-rose)' : '#F5F2EF',
                      color: (beautician.client_reminder_prefs?.channel || 'whatsapp') === ch ? '#fff' : '#8A8580'
                    }}
                  >
                    {ch === 'whatsapp' ? 'WhatsApp' : ch === 'email' ? 'Email' : 'SMS'}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {/* Messaging channels: connect and manage WhatsApp + SMS */}
          <div style={styles.card}>
            <h3 style={styles.cardTitle}>Messaging channels</h3>
            <p style={styles.cardDesc}>Connect the channels Florrie sends reminders and replies through.</p>

            {/* WhatsApp row */}
            <div style={styles.msgChannelRow}>
              <div style={styles.msgChannelInfo}>
                <span style={styles.msgChannelIcon} aria-hidden><Icon name="message" size={18} /></span>
                <div>
                  <div style={styles.msgChannelName}>WhatsApp Business</div>
                  <div style={{ ...styles.msgChannelStatus,
                    color: beautician.whatsapp_connected ? 'var(--success, #3F7D5C)' : 'var(--text-muted)',
                  }}>
                    {beautician.whatsapp_connected
                      ? `● Connected${beautician.whatsapp_phone ? ` · ${beautician.whatsapp_phone}` : ''}`
                      : 'Not connected'}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => navigate('/whatsapp')}
                style={{ ...styles.msgChannelBtn,
                  background: beautician.whatsapp_connected ? 'var(--bg-hover)' : 'var(--accent)',
                  color: beautician.whatsapp_connected ? 'var(--text-secondary)' : 'var(--bg-card)',
                  border: beautician.whatsapp_connected ? '1.5px solid var(--border)' : 'none',
                }}
              >
                {beautician.whatsapp_connected ? 'Manage' : 'Connect'}
              </button>
            </div>

            {/* SMS row */}
            <div style={{ ...styles.msgChannelRow, borderBottom: 'none' }}>
              <div style={styles.msgChannelInfo}>
                <span style={styles.msgChannelIcon} aria-hidden><Icon name="phone" size={15} /></span>
                <div>
                  <div style={styles.msgChannelName}>SMS</div>
                  <div style={{ ...styles.msgChannelStatus,
                    color: beautician.sms_enabled ? 'var(--success, #3F7D5C)' : 'var(--text-muted)',
                  }}>
                    {beautician.sms_enabled
                      ? `● On${beautician.sms_originator ? ` · sending from ${beautician.sms_originator}` : ''}`
                      : "Off. Turn on if your clients aren't on WhatsApp."}
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={() => navigate('/sms')}
                style={{ ...styles.msgChannelBtn,
                  background: beautician.sms_enabled ? 'var(--bg-hover)' : 'var(--accent)',
                  color: beautician.sms_enabled ? 'var(--text-secondary)' : 'var(--bg-card)',
                  border: beautician.sms_enabled ? '1.5px solid var(--border)' : 'none',
                }}
              >
                {beautician.sms_enabled ? 'Manage' : 'Turn on'}
              </button>
            </div>
          </div>

          {/* SMS Usage */}
          <SMSUsageWidget />

          {/* Florrie's autopilot: one control for what proactive messages Florrie
              sends and how. Each is Auto (sends for you), Ask first (waits in the
              outbox to approve), or Off (never). Transactional messages always go
              and are shown read-only. Writes beautician.autonomy. */}
          {(() => {
            const auto = pendingAutonomy ?? beautician.autonomy ?? {};

            // Always sent, never gated (see TRANSACTIONAL in outbound-guard.js).
            const ALWAYS = [
              'Booking confirmations',
              'Appointment reminders',
              'Payment & deposit requests',
              'Patch test & form requests',
              'Replies to clients who message you',
            ];

            // Proactive types Ellie controls. Keys match the message types the
            // engines pass to the outbound guard.
            const PROACTIVE = [
              { key: 'rebook_nudge',       label: 'Rebook nudges',          hint: 'Reminds clients to book their next appointment.' },
              { key: 'predictive_nudge',   label: 'Smart rebook reminders', hint: 'Nudges based on a client\'s usual rebooking pattern.' },
              { key: 'comeback',           label: 'Win-back messages',      hint: 'Reaches out to clients who have gone quiet.' },
              { key: 'review_request',     label: 'Review requests',        hint: 'Asks happy clients to leave a review.' },
              { key: 'aftercare_followup', label: 'Aftercare follow-ups',   hint: 'Checks in after a treatment with aftercare tips.' },
              { key: 'ai_checkin',         label: 'Proactive check-ins',    hint: 'Friendly check-ins Florrie thinks are worth sending.' },
              { key: 'gap_fill',           label: 'Gap-fill offers',        hint: 'Offers a freed-up slot to fill a last-minute gap.' },
              { key: 'waitlist_alert',     label: 'Waitlist alerts',        hint: 'Tells waitlisted clients when a slot opens.' },
              { key: 'marketing',          label: 'Marketing & promos',     hint: 'Offers and promotions, only to clients who opted in.' },
            ];

            const MODES = [
              { value: 'auto', label: 'Auto',      color: 'var(--success)' },
              { value: 'ask',  label: 'Ask first', color: '#f59e0b' },
              { value: 'off',  label: 'Off',       color: 'var(--danger)' },
            ];

            const modeOf = (key) => auto[key] || auto.proactive || 'ask';

            function setMode(key, value) {
              const next = { ...auto, [key]: value };
              setPendingAutonomy(next);   // optimistic, instant visual response
              saveProfile({ autonomy: next }).finally(() => setPendingAutonomy(null));
            }

            return (
              <div style={styles.card}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                  <Icon name={iconName('smart_toy')} size={18} inline style={{ color: 'var(--accent)', }} />
                  <h3 style={{ ...styles.cardTitle, margin: 0 }}>Florrie's autopilot</h3>
                </div>
                <p style={styles.cardDesc}>
                  Choose what Florrie sends on her own. Set each to Auto, Ask first (it waits in your outbox to approve), or Off. Anything you send by hand is never affected.
                </p>

                {/* Always sent (read-only) */}
                <div style={{ marginBottom: 18 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                    <div style={{ width: 8, height: 8, borderRadius: 6, background: 'var(--success)', flexShrink: 0 }} />
                    <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Always sent</span>
                  </div>
                  <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '0 0 8px 14px', lineHeight: 1.4 }}>
                    Time-sensitive or tied to a booking, so these always go.
                  </p>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, paddingLeft: 14 }}>
                    {ALWAYS.map(l => (
                      <span key={l} style={{ fontSize: 11.5, color: 'var(--text-secondary)', background: 'var(--bg-hover)', borderRadius: 999, padding: '4px 10px' }}>{l}</span>
                    ))}
                  </div>
                </div>

                {/* You choose */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                  <div style={{ width: 8, height: 8, borderRadius: 6, background: 'var(--accent)', flexShrink: 0 }} />
                  <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>You choose</span>
                </div>
                {PROACTIVE.map(item => {
                  const current = modeOf(item.key);
                  return (
                    <div key={item.key} style={{ padding: '10px 0', borderBottom: '1px solid var(--border-light)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                        <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>{item.label}</span>
                        <div style={{ display: 'flex', gap: 4, flexShrink: 0 }}>
                          {MODES.map(opt => (
                            <button className="fl-tap"
                              key={opt.value}
                              onClick={() => setMode(item.key, opt.value)}
                              style={{ padding: '4px 9px', borderRadius: 6, border: 'none', fontSize: 11, fontWeight: 600,
                                cursor: 'pointer', fontFamily: 'inherit',
                                background: current === opt.value ? opt.color : 'var(--border-light)',
                                color: current === opt.value ? '#fff' : 'var(--text-muted)',
                              }}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                      </div>
                      <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '4px 0 0', lineHeight: 1.4 }}>{item.hint}</p>
                    </div>
                  );
                })}

                {/* Clients you know: how many completed visits before Florrie
                    treats a client as known. Florrie always checks with Ellie
                    before messaging a known client, so this sets who counts.
                    Writes autonomy.known_client_min_visits, merged into the same
                    autonomy object as the modes above so per-type modes are kept.
                    Default 2 when unset (matches isKnownClient in outbound-guard.js). */}
                <div style={{ marginTop: 20, paddingTop: 18, borderTop: '1px solid var(--border-light)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
                    <div style={{ width: 8, height: 8, borderRadius: 6, background: 'var(--accent)', flexShrink: 0 }} />
                    <span style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>Clients you know</span>
                  </div>
                  <p style={{ fontSize: 11.5, color: 'var(--text-muted)', margin: '0 0 10px 14px', lineHeight: 1.5 }}>
                    Florrie always checks with you before messaging a client you know, so nothing lands out of context. Choose who counts.
                  </p>
                  <div style={{ paddingLeft: 14 }}>
                    <select
                      value={String(auto.known_client_min_visits ?? 2)}
                      onChange={(e) => {
                        const next = { ...auto, known_client_min_visits: Number(e.target.value) };
                        setPendingAutonomy(next);
                        saveProfile({ autonomy: next }).finally(() => setPendingAutonomy(null));
                      }}
                      style={{ minHeight: 44, width: '100%', padding: '10px 12px', borderRadius: 10,
                        border: '1.5px solid var(--border)', background: 'var(--bg-card)',
                        color: 'var(--text-primary)', fontSize: 13, fontWeight: 600,
                        fontFamily: 'inherit', cursor: 'pointer',
                      }}
                    >
                      <option value="1">After their first visit</option>
                      <option value="2">Once they have been twice</option>
                      <option value="3">Only regulars, three or more visits</option>
                    </select>
                  </div>
                </div>

                {/* Wire 5: add a live promo code to gap-fill offers. Off by
                    default. Writes autonomy.promos_in_offers, merged into the
                    same autonomy object so per-type modes are kept. */}
                <div style={{ marginTop: 20, paddingTop: 18, borderTop: '1px solid var(--border-light)' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <div>
                      <span style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' }}>Add a promo to gap offers</span>
                      <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '4px 0 0', lineHeight: 1.4 }}>
                        When you have a promo code running, Florrie can add it to a last-minute gap offer, like "use FLASH10 for 10% off". Off by default.
                      </p>
                    </div>
                    <button className="fl-tap"
                      onClick={() => {
                        const next = { ...auto, promos_in_offers: !auto.promos_in_offers };
                        setPendingAutonomy(next);
                        saveProfile({ autonomy: next }).finally(() => setPendingAutonomy(null));
                      }}
                      style={{ flexShrink: 0, padding: '5px 12px', borderRadius: 6, border: 'none', fontSize: 11, fontWeight: 600,
                        cursor: 'pointer', fontFamily: 'inherit',
                        background: auto.promos_in_offers ? 'var(--success)' : 'var(--border-light)',
                        color: auto.promos_in_offers ? '#fff' : 'var(--text-muted)',
                      }}
                    >
                      {auto.promos_in_offers ? 'On' : 'Off'}
                    </button>
                  </div>
                </div>

                <button className="fl-tap"
                  onClick={() => navigate('/outbox')}
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginTop: 14, background: 'none', border: 'none', padding: 0, fontSize: 13, fontWeight: 600, color: 'var(--accent)', cursor: 'pointer', fontFamily: 'inherit' }}
                >
                  <Icon name={iconName('outbox')} size={16} inline />
                  Review messages waiting to send
                </button>
              </div>
            );
          })()}
        </div>
      )}

      {/* === AI SETTINGS === */}
      {section === 'ai' && (
        <div>

          {/* ── Instagram Connect ── */}
          <div style={styles.card}>
            <div style={styles.calendarProviderRow}>
              <span style={{ fontSize: 22 }}><Icon name="camera" size={15} /></span>
              <div style={{ flex: 1 }}>
                <span style={styles.calProviderLabel}>Instagram</span>
                <span style={{ ...styles.calProviderStatus,
                  color: !beautician.instagram_page_id ? 'var(--text-muted)'
                    : igNeedsReconnect ? 'var(--danger)'
                    : igTokenValid ? 'var(--success)'
                    : 'var(--text-muted)',
                }}>
                  {/* Only say Connected once /api/instagram/status confirms the
                      token works. A failed or pending check reads as unknown,
                      never as a false Connected. */}
                  {!beautician.instagram_page_id ? 'Not connected'
                    : igChecking ? 'Checking…'
                    : igNeedsReconnect ? '● Needs reconnecting'
                    : igTokenValid ? `● Connected${beautician.instagram_page_name ? `, ${beautician.instagram_page_name}` : ''}`
                    : 'Could not check just now'}
                </span>
              </div>
              {beautician.instagram_page_id ? (
                <button
                  onClick={handleDisconnectInstagram}
                  style={{ ...styles.connectBtn, background: 'var(--bg-hover)', color: 'var(--text-secondary)', border: '1.5px solid var(--border)' }}
                >
                  Disconnect
                </button>
              ) : (
                <Button
                  size="sm"
                  onClick={handleConnectInstagram}
                  disabled={igConnecting}
                >
                  {igConnecting ? 'Connecting…' : 'Connect'}
                </Button>
              )}
            </div>
            {/* Expired token. The row above says so; this card explains what
                stopped and gives her the one button that fixes it. Same OAuth
                flow as first-time connect, so nothing new to learn. The 21 June
                date is Ellie's actual outage start (pilot-specific copy). */}
            {igNeedsReconnect && (
              <div style={{ marginTop: 12,
                padding: '12px 14px',
                borderRadius: 10,
                background: 'var(--danger-bg, #F7E4E4)',
              }}>
                <p style={{ fontSize: 13, fontWeight: 700, color: 'var(--danger)', margin: '0 0 4px' }}>
                  Instagram needs reconnecting
                </p>
                <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 10px', lineHeight: 1.5 }}>
                  Messages still arrive, but replies, posting and client names stopped going out on 21 June. Takes one tap.
                </p>
                <Button
                  variant="danger"
                  size="sm"
                  fullWidth
                  onClick={handleConnectInstagram}
                  disabled={igConnecting}
                  // sm is the size that matches this card (13px, 10px radius);
                  // the explicit 44 stays because this is the button that
                  // matters most and it gets a full thumb target, not the
                  // 38px sm floor plus an invisible ::after.
                  style={{ minHeight: 44 }}
                >
                  {igConnecting ? 'Reconnecting…' : 'Reconnect Instagram'}
                </Button>
              </div>
            )}
            {/* Hidden while broken: "reads and replies to your DMs" would
                contradict the reconnect card directly above it. */}
            {!igNeedsReconnect && (
              <p style={{ ...styles.cardHint, marginTop: 8, marginBottom: 0 }}>
                {beautician.instagram_page_id
                  ? 'Florrie reads and replies to your Instagram DMs in your voice, and Content Studio can post to your account.'
                  : 'Connect your Instagram so Florrie can read and reply to your DMs (and post for you). You just need a professional Instagram account, no Facebook Page required.'}
              </p>
            )}
            {/* Native only. Safari is in front of her now, so this card is what
                she comes back to. It exists because a screen that still says
                "Reconnect" after she has just reconnected reads as a failure. */}
            {igAwaitingReturn && (
              <div style={{ marginTop: 12, padding: '12px 14px', borderRadius: 10,
                background: 'var(--tone-1, #fbf1ea)', border: '1px solid var(--border)',
              }}>
                <p style={{ fontSize: 13, fontWeight: 700, margin: '0 0 4px' }}>
                  Finish in Safari
                </p>
                <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '0 0 10px', lineHeight: 1.5 }}>
                  Instagram will not let you log in inside an app, so it opened in your browser. Sign in, tap Allow, then come back here. This card updates on its own.
                </p>
                <button
                  onClick={() => { setIgAwaitingReturn(false); setIgRecheck(n => n + 1); refresh(); }}
                  style={{ ...styles.connectBtn, width: '100%', minHeight: 44, background: 'var(--bg-hover)', color: 'var(--text-primary)', border: '1.5px solid var(--border)' }}
                >
                  I have done it, check again
                </button>
              </div>
            )}
            {igBanner === 'success' && (
              <p style={{ fontSize: 12, color: 'var(--success)', marginTop: 8, marginBottom: 0 }}><Icon name="check" size={14} inline /> Instagram connected, Content Studio can now post directly</p>
            )}
            {igBanner === 'error' && (
              <p style={{ fontSize: 12, color: 'var(--danger, #9E2B32)', marginTop: 8, marginBottom: 0 }}>Connection failed, try again or contact support</p>
            )}
            {igBanner === 'no_page' && (
              <p style={{ fontSize: 12, color: 'var(--warning, #8A6420)', marginTop: 8, marginBottom: 0 }}>No Facebook Page found. You need a Facebook Page with an Instagram Business account connected.</p>
            )}
            {igBanner === 'no_ig_account' && (
              <p style={{ fontSize: 12, color: 'var(--warning, #8A6420)', marginTop: 8, marginBottom: 0 }}>Instagram Business account not found. Make sure your Instagram account is set to Business and linked to your Facebook Page.</p>
            )}
          </div>

          <div style={styles.card}>
            <h3 style={styles.cardTitle}>Auto-reply</h3>
            <p style={styles.cardDesc}>
              When enabled, Florrie answers messages automatically when she's confident enough.
              Messages below the confidence threshold get escalated to you.
            </p>

            <div style={styles.toggleRow}>
              <span style={styles.toggleLabel}>Auto-reply enabled</span>
              <button
                onClick={() => saveProfile({ auto_reply_enabled: !beautician.auto_reply_enabled })}
                style={{ ...styles.toggle, background: beautician.auto_reply_enabled ? 'var(--accent)' : 'var(--border)' }}
              >
                <div style={{ ...styles.toggleDot, transform: beautician.auto_reply_enabled ? 'translateX(20px)' : 'translateX(2px)' }} />
              </button>
            </div>

            <div style={styles.sliderSection}>
              <div style={styles.sliderHeader}>
                <span style={styles.sliderLabel}>Confidence threshold</span>
                <span style={styles.sliderValue}>{Math.round(confidence * 100)}%</span>
              </div>
              <input type="range" min="0.5" max="1.0" step="0.05" value={confidence} onChange={e => saveProfile({ confidence_threshold: parseFloat(e.target.value) })} style={styles.slider} />
              <div style={styles.sliderHints}>
                <span>More autonomous</span>
                <span>More cautious</span>
              </div>
            </div>
          </div>

          <div style={styles.card}>
            <h3 style={styles.cardTitle}>How much Florrie handles</h3>
            <p style={styles.cardDesc}>
              Let Florrie act on her own for clients you know, or check with you first. New clients are always double-checked either way.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
              {[
                { key: 'auto', label: 'Handle my regulars', hint: 'Florrie sends reminders, rebooks and gap offers to clients you know, then tells you. New clients still come to you.' },
                { key: 'ask', label: 'Check with me first', hint: 'Florrie drafts everything and waits for your yes or no. Nothing goes out without you.' },
                { key: 'off', label: 'Pause proactive messages', hint: 'Florrie stops reaching out for now. She still replies when a client messages first.' },
              ].map(opt => {
                const active = (beautician.autonomy?.proactive || 'ask') === opt.key;
                return (
                  <button
                    key={opt.key}
                    onClick={() => saveProfile({ autonomy: { ...(beautician.autonomy || {}), proactive: opt.key } })}
                    style={{ textAlign: 'left', padding: '12px 14px', borderRadius: 10, cursor: 'pointer', fontFamily: 'inherit',
                      border: active ? '1.5px solid var(--accent)' : '1.5px solid var(--border)',
                      background: active ? 'rgba(146,64,94,0.06)' : 'var(--bg-card)',
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <span style={{ width: 16, height: 16, borderRadius: 10, flexShrink: 0, boxSizing: 'border-box', border: active ? '5px solid var(--accent)' : '1.5px solid var(--border)' }} />
                      <span style={{ fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' }}>{opt.label}</span>
                    </div>
                    <p style={{ fontSize: 12, color: 'var(--text-secondary)', margin: '6px 0 0 24px', lineHeight: 1.4 }}>{opt.hint}</p>
                  </button>
                );
              })}
            </div>
          </div>

          <VoiceControlCard />
          <CelebrationsCard />

          <div style={styles.card}>
            <h3 style={styles.cardTitle}>Florrie's Voice</h3>
            <p style={styles.cardDesc}>
              {tone.corrections_count
                ? `Florrie has learned from ${tone.corrections_count} corrections.`
                : 'Teach Florrie how you talk. She uses your greetings, sign-offs, and emoji habits to sound like you.'}
            </p>
            <FieldEditor label="Greeting style" value={tone.greeting_style || ''} placeholder="e.g. Hey lovely! / Hiya babe! / Hi there!" onSave={v => saveProfile({ tone_model: { ...tone, greeting_style: v } })} />
            <FieldEditor label="Sign-off style" value={tone.sign_off_style || ''} placeholder="e.g. See you soon! xx / Thanks hun 💕" onSave={v => saveProfile({ tone_model: { ...tone, sign_off_style: v } })} />
            <div style={styles.fieldRow}>
              <span style={styles.fieldLabel}>Emoji usage</span>
              <div style={styles.chipRow}>
                {['none', 'light', 'moderate', 'heavy'].map(level => (
                  <button
                    key={level}
                    onClick={() => saveProfile({ tone_model: { ...tone, emoji_usage: level } })}
                    style={{ ...styles.chip,
                      background: (tone.emoji_usage || 'moderate') === level ? 'var(--accent)' : 'var(--bg-hover)',
                      color: (tone.emoji_usage || 'moderate') === level ? '#fff' : 'var(--text-secondary)',
                    }}
                  >
                    {level}
                  </button>
                ))}
              </div>
            </div>
            <div style={styles.fieldRow}>
              <span style={styles.fieldLabel}>Formality</span>
              <div style={styles.chipRow}>
                {['casual', 'friendly', 'professional', 'formal'].map(level => (
                  <button
                    key={level}
                    onClick={() => saveProfile({ tone_model: { ...tone, formality: level } })}
                    style={{ ...styles.chip,
                      background: (tone.formality || 'friendly') === level ? 'var(--accent)' : 'var(--bg-hover)',
                      color: (tone.formality || 'friendly') === level ? '#fff' : 'var(--text-secondary)',
                    }}
                  >
                    {level}
                  </button>
                ))}
              </div>
            </div>
            <FieldEditor label="Key phrases" value={(tone.key_phrases || []).join(', ')} placeholder="e.g. lovely, babe, hun, pop in" onSave={v => saveProfile({ tone_model: { ...tone, key_phrases: v.split(',').map(s => s.trim()).filter(Boolean) } })} />
            <FieldEditor label="Words to avoid" value={(tone.avoid || []).join(', ')} placeholder="e.g. dear, madam, sir" onSave={v => saveProfile({ tone_model: { ...tone, avoid: v.split(',').map(s => s.trim()).filter(Boolean) } })} />
          </div>

          <div style={styles.card}>
            <h3 style={styles.cardTitle}>Example messages</h3>
            <p style={styles.cardDesc}>
              Show Florrie exactly how you'd reply. She uses these as reference when writing on your behalf.
            </p>
            <FewShotExamples
              examples={tone.few_shot_examples || []}
              onSave={examples => saveProfile({ tone_model: { ...tone, few_shot_examples: examples } })}
            />
          </div>

          {/* Instagram DM control */}
          <div style={styles.card}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
              <span style={{ fontSize: 18 }}><Icon name="camera" size={15} /></span>
              <h3 style={{ ...styles.cardTitle, margin: 0 }}>Instagram DMs</h3>
            </div>
            <p style={styles.cardDesc}>Control what happens when clients message you on Instagram.</p>

            {/* Mode selector */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
              {[
                { key: 'redirect', label: 'Redirect to WhatsApp', desc: 'Send one auto-reply with your WhatsApp link, then stop', icon: 'message' },
                { key: 'off', label: 'Store only', desc: 'Log the message but don\'t reply at all', icon: 'bell' },
              ].map(opt => {
                // treat legacy 'ai' setting as 'redirect' since Instagram DM replies aren't supported
                const mode = ['ai', 'redirect'].includes(beautician.instagram_dm_mode) ? 'redirect' : (beautician.instagram_dm_mode || 'redirect');
                const active = mode === opt.key;
                return (
                  <button className="fl-tap"
                    key={opt.key}
                    onClick={() => saveProfile({ instagram_dm_mode: opt.key })}
                    style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '11px 14px',
                      borderRadius: 10, border: `1.5px solid ${active ? 'var(--accent)' : 'var(--border-light)'}`,
                      background: active ? 'var(--accent-light)' : 'var(--bg-hover, var(--bg))',
                      cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', width: '100%',
                    }}
                  >
                    <span style={{ fontSize: 20, flexShrink: 0 }}><Icon name={iconName(opt.icon)} inline /></span>
                    <div style={{ flex: 1 }}>
                      <span style={{ display: 'block', fontSize: 13, fontWeight: 600, color: active ? 'var(--accent)' : 'var(--text-primary)' }}>{opt.label}</span>
                      <span style={{ display: 'block', fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>{opt.desc}</span>
                    </div>
                    {active && (
                      <Icon name={iconName('check_circle')} size={18} inline style={{ color: 'var(--accent)', flexShrink: 0 }} />
                    )}
                  </button>
                );
              })}
            </div>

            {/* Redirect message editor, only shown in redirect mode */}
            {(['redirect', 'ai'].includes(beautician.instagram_dm_mode || 'redirect')) && (() => {
              const phone = beautician.phone || '';
              const digits = phone.replace(/\D/g, '');
              const waNumber = digits.startsWith('44') ? digits : digits.startsWith('0') ? `44${digits.slice(1)}` : digits;
              const waLink = waNumber ? `https://wa.me/${waNumber}` : null;
              const defaultMsg = waLink
                ? `Hey! ${beautician.first_name || 'I'} replies much faster on WhatsApp 💬 Message me here: ${waLink}`
                : `Hey! I reply much faster on WhatsApp, please message me there instead 💬`;

              return (
                <div>
                  <div style={{ height: 1, background: 'var(--border-light)', marginBottom: 14 }} />
                  <span style={styles.fieldLabel}>Redirect message</span>
                  <textarea
                    value={beautician.instagram_redirect_message || ''}
                    onChange={e => saveProfile({ instagram_redirect_message: e.target.value })}
                    placeholder={defaultMsg}
                    rows={3}
                    style={{ minHeight: 44, width: '100%', marginTop: 6, padding: '10px 12px', borderRadius: 10,
                      border: '1.5px solid var(--border)', background: 'var(--bg)', color: 'var(--text-primary)',
                      fontSize: 13, fontFamily: 'inherit', resize: 'none', outline: 'none', boxSizing: 'border-box',
                      lineHeight: 1.5,
                    }}
                  />
                  <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '4px 0 0' }}>
                    Leave blank to use the default. Sent once per client, then not again for 7 days.
                    {!waLink && <span style={{ color: 'var(--warning, #8A6420)', fontWeight: 500 }}> · Add your phone number in Profile to auto-include your WhatsApp link.</span>}
                  </p>
                  {/* Preview */}
                  <div style={{ marginTop: 12, background: 'var(--border-light)', borderRadius: 10, padding: '10px 12px' }}>
                    <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>Preview</span>
                    <p style={{ fontSize: 13, color: 'var(--text-primary)', margin: '4px 0 0', lineHeight: 1.5 }}>
                      {beautician.instagram_redirect_message || defaultMsg}
                    </p>
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* === ACCOUNT === */}
      {section === 'account' && (
        <div>
          <div style={styles.card}>
            <h3 style={styles.cardTitle}>Subscription</h3>
            <div style={styles.fieldRow}>
              <span style={styles.fieldLabel}>Plan</span>
              <span style={styles.fieldValue}>
                {beautician.subscription_plan === 'trial' || !beautician.subscription_plan ? '14-day free trial' :
                 beautician.subscription_plan === 'florrie' ? 'Florrie (£29/mo)' :
                 beautician.subscription_plan === 'florrie_team' ? 'Teams (£44/mo)' :
                 beautician.subscription_status === 'active' ? `Active (${beautician.subscription_plan})` :
                 beautician.subscription_status || 'Trial'}
              </span>
            </div>
            {beautician.trial_ends_at && (
              <div style={styles.fieldRow}>
                <span style={styles.fieldLabel}>Trial ends</span>
                <span style={styles.fieldValue}>
                  {new Date(beautician.trial_ends_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}
                </span>
              </div>
            )}
            <div style={styles.fieldRow}>
              <span style={styles.fieldLabel}>Email</span>
              <span style={styles.fieldValue}>{beautician.email}</span>
            </div>
          </div>
          <div style={styles.card}>
            <h3 style={styles.cardTitle}>Appearance</h3>
            <div style={styles.toggleRow}>
              <span style={styles.toggleLabel}>{isDark ? 'Dark mode' : 'Light mode'}</span>
              <button
                onClick={toggleDark}
                style={{ ...styles.toggle, background: isDark ? 'var(--accent)' : 'var(--border)' }}
              >
                <div style={{ ...styles.toggleDot, transform: isDark ? 'translateX(20px)' : 'translateX(2px)' }} />
              </button>
            </div>
          </div>
          <button onClick={handleLogout} style={styles.logoutBtn}>Sign out</button>
          <button onClick={handleDeleteAccount} style={styles.deleteAccountBtn}>Delete account</button>
        </div>
      )}
    </div>
  );
}

function FewShotExamples({ examples, onSave }) {
  const [items, setItems] = useState(examples.length ? examples : []);
  const [adding, setAdding] = useState(false);
  const [newQ, setNewQ] = useState('');
  const [newA, setNewA] = useState('');

  function addExample() {
    if (!newQ.trim() || !newA.trim()) return;
    const updated = [...items, { customer: newQ.trim(), reply: newA.trim() }];
    setItems(updated);
    onSave(updated);
    setNewQ('');
    setNewA('');
    setAdding(false);
  }

  function removeExample(idx) {
    const updated = items.filter((_, i) => i !== idx);
    setItems(updated);
    onSave(updated);
  }

  return (
    <div>
      {items.map((ex, i) => (
        <div key={i} style={styles.exampleCard}>
          <div style={styles.exampleBubble}>
            <span style={styles.exampleLabel}>Customer</span>
            <p style={styles.exampleText}>{ex.customer}</p>
          </div>
          <div style={{ ...styles.exampleBubble, background: 'var(--accent-light)', borderLeft: '3px solid var(--accent)' }}>
            <span style={styles.exampleLabel}>Your reply</span>
            <p style={styles.exampleText}>{ex.reply}</p>
          </div>
          <button onClick={() => removeExample(i)} style={styles.removeExBtn}>Remove</button>
        </div>
      ))}

      {adding ? (
        <div style={styles.addExForm}>
          <textarea
            value={newQ}
            onChange={e => setNewQ(e.target.value)}
            placeholder="What the customer says..."
            rows={2}
            style={styles.exTextarea}
          />
          <textarea
            value={newA}
            onChange={e => setNewA(e.target.value)}
            placeholder="How you'd reply..."
            rows={2}
            style={{ ...styles.exTextarea, borderColor: 'var(--accent)' }}
          />
          <div style={{ display: 'flex', gap: 8 }}>
            <Button size="sm" onClick={addExample} disabled={!newQ.trim() || !newA.trim()}>
              Save example
            </Button>
            <button onClick={() => { setAdding(false); setNewQ(''); setNewA(''); }} style={styles.addExCancelBtn}>
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} style={styles.addExBtn}>
          + Add example
        </button>
      )}
    </div>
  );
}

function ToneRow({ label, value }) {
  return (
    <div style={styles.toneItem}>
      <span style={styles.toneLabel}>{label}</span>
      <span style={styles.toneValue}>{value}</span>
    </div>
  );
}

function FieldEditor({ label, value, onSave, placeholder }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  function handleSave() {
    setEditing(false);
    if (draft !== value) onSave(draft);
  }

  return (
    <div style={styles.fieldRow}>
      <span style={styles.fieldLabel}>{label}</span>
      {editing ? (
        <input type="text" value={draft} onChange={e => setDraft(e.target.value)} onBlur={handleSave} onKeyDown={e => e.key === 'Enter' && handleSave()} placeholder={placeholder} style={styles.fieldInput} autoFocus />
      ) : (
        <button onClick={() => { setDraft(value); setEditing(true); }} style={styles.fieldValue}>
          {value || <span style={{ color: '#D5D0CB' }}>{placeholder || 'Tap to set'}</span>}
        </button>
      )}
    </div>
  );
}

function NotificationToggle({ label, desc, prefs, onChange }) {
  const [local, setLocal] = useState(prefs);
  // Sync from parent after a successful save/refresh
  useEffect(() => { setLocal(prefs); }, [prefs.email, prefs.push]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggle(key) {
    const next = { ...local, [key]: !local[key] };
    setLocal(next);   // optimistic, instant visual response
    onChange(next);   // async save
  }

  return (
    <div style={styles.notifRow}>
      <div style={styles.notifInfo}>
        <span style={styles.notifLabel}>{label}</span>
        <span style={styles.notifDesc}>{desc}</span>
      </div>
      <div style={styles.notifChannels}>
        <button
          onClick={() => toggle('email')}
          title={local.email ? 'Email on' : 'Email off'}
          style={{ ...styles.notifChip,
            background: local.email ? 'var(--success-bg)' : 'var(--border-light)',
            color: local.email ? 'var(--success)' : 'var(--text-muted)'
          }}
        ><Icon name="mail" size={15} /></button>
        <button
          onClick={() => toggle('push')}
          title={local.push ? 'Push on' : 'Push off'}
          style={{ ...styles.notifChip,
            background: local.push ? 'var(--success-bg)' : 'var(--border-light)',
            color: local.push ? 'var(--success)' : 'var(--text-muted)'
          }}
        ><Icon name="bell" size={15} /></button>
      </div>
    </div>
  );
}

function ClientReminderRow({ label, enabled, onChange }) {
  const [local, setLocal] = useState(enabled);
  useEffect(() => { setLocal(enabled); }, [enabled]);

  function handleToggle() {
    const next = !local;
    setLocal(next);   // optimistic
    onChange(next);
  }

  return (
    <div style={styles.reminderRow}>
      <span style={styles.reminderLabel}>{label}</span>
      <button className="fl-tap"
        onClick={handleToggle}
        style={{ ...styles.toggle, background: local ? 'var(--accent)' : 'var(--border)', width: 44, height: 24 }}
      >
        <div style={{ ...styles.toggleDot, transform: local ? 'translateX(20px)' : 'translateX(2px)' }} />
      </button>
    </div>
  );
}

import { bookingUrl as publicBookingUrl } from '../lib/booking.js';
import Icon, { iconName } from '../components/ui/Icon';

function BookingLinkCard({ slug }) {
  const [copied, setCopied] = useState(false);
  const url = publicBookingUrl(slug);

  function handleCopy() {
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {
      // Fallback for older browsers
      const ta = document.createElement('textarea');
      ta.value = url;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    });
  }

  function handleShare() {
    if (navigator.share) {
      navigator.share({
        title: 'Book an appointment',
        text: 'Book your next appointment with me!',
        url: url
      }).catch(() => {});
    } else {
      handleCopy();
    }
  }

  return (
    <div style={styles.bookingLinkCard}>
      <div style={styles.bookingLinkHeader}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>Your booking link</span>
      </div>
      <div style={styles.bookingLinkUrl}>
        <span style={{ fontSize: 14, color: 'var(--text-secondary)', wordBreak: 'break-all' }}>{url}</span>
      </div>
      <div style={styles.bookingLinkActions}>
        <button onClick={handleCopy} style={styles.bookingLinkBtn}>
          <Icon name={copied ? 'check' : 'copy'} size={16} />
          {copied ? 'Copied' : 'Copy link'}
        </button>
        <button onClick={handleShare} style={{ ...styles.bookingLinkBtn, background: 'var(--accent)', color: 'var(--bg-card)' }}>
          <Icon name="share" size={16} />
          Share
        </button>
      </div>
      <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 8, textAlign: 'center' }}>
        Add this link to your Instagram bio, WhatsApp status, or send it directly to clients
      </p>
    </div>
  );
}

const styles = {
  page: { minHeight: 'var(--shell-viewport)', background: 'var(--bg)', fontFamily: "var(--font-body, 'Plus Jakarta Sans', -apple-system, sans-serif)", padding: '0 16px var(--scroll-pad-bottom)', maxWidth: 480, margin: '0 auto', color: 'var(--text-primary)' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, paddingTop: 8, paddingBottom: 12 },
  title: { fontSize: 22, fontWeight: 700, margin: 0, fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)", letterSpacing: '-0.02em' },
  savedBadge: { padding: '4px 10px', borderRadius: 6, background: 'var(--success-bg)', color: 'var(--success)', fontSize: 12, fontWeight: 600 },
  loadingText: { textAlign: 'center', color: 'var(--text-muted)', padding: 60, fontSize: 14, fontFamily: "var(--font-body, 'Plus Jakarta Sans', sans-serif)" },
  sectionNav: { display: 'flex', gap: 6, marginBottom: 16, overflowX: 'auto', WebkitOverflowScrolling: 'touch', scrollbarWidth: 'none', msOverflowStyle: 'none', paddingBottom: 2 },
  // <Button variant="chip" size="sm"> owns the padding, radius, type scale and
  // the pressed/hover colours now. All this has to add is "don't let the flex
  // row squash me", which is the one thing the primitive cannot know.
  sectionTab: { flexShrink: 0 },
  card: { background: 'var(--bg-card)', borderRadius: 16, padding: 16, marginBottom: 12, boxShadow: 'var(--shadow-sm)' },
  cardTitle: { fontSize: 14, fontWeight: 600, margin: '0 0 6px', color: 'var(--text-primary)' },
  cardDesc: { fontSize: 13, color: 'var(--text-muted)', margin: '0 0 16px', lineHeight: 1.5 },
  pauseRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px', marginBottom: 14, borderRadius: 10, background: 'var(--accent-light)', border: '1px solid transparent' },
  pauseRowOn: { background: 'rgba(212,96,92,0.10)', border: '1px solid rgba(212,96,92,0.30)' },
  pauseTitle: { fontSize: 14, fontWeight: 700, color: 'var(--text-primary)' },
  pauseDesc: { fontSize: 12, color: 'var(--text-muted)', marginTop: 2, lineHeight: 1.4 },
  fieldRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--border-light)' },
  fieldLabel: { fontSize: 13, color: 'var(--text-secondary)', fontWeight: 500 },
  fieldValue: { fontSize: 13, color: 'var(--text-primary)', fontWeight: 500, background: 'none', border: 'none', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'right', padding: 0 },
  fieldInput: { fontSize: 13, fontWeight: 500, fontFamily: 'inherit', textAlign: 'right', border: 'none', borderBottom: '1.5px solid var(--accent)', outline: 'none', padding: '2px 0', background: 'transparent', color: 'var(--text-primary)' },
  bookingLinkCard: { background: 'linear-gradient(160deg, #ffffff, #fdf1ea)', borderRadius: 16, padding: 18, marginBottom: 8, border: '1px solid rgba(146,64,94,0.14)', boxShadow: 'var(--elev-1)' },
  bookingLinkHeader: { marginBottom: 8 },
  bookingLinkUrl: { background: 'var(--bg-card)', borderRadius: 10, padding: '10px 12px', marginBottom: 10 },
  bookingLinkActions: { display: 'flex', gap: 8 },
  bookingLinkBtn: { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 7, flex: 1, padding: '12px 0', minHeight: 44, borderRadius: 10, border: '1.5px solid rgba(146,64,94,0.35)', background: 'var(--bg-card)', color: 'var(--accent)', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  slugDisplay: { display: 'flex', alignItems: 'center', gap: 2 },
  slugPrefix: { fontSize: 12, color: 'var(--text-muted)' },
  slugValue: { fontSize: 13, fontWeight: 600, color: 'var(--accent)' },
  dayRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--border-light)' },
  dayToggle: { display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' },
  dayName: { fontSize: 14, fontWeight: 500 },
  timeInputs: { display: 'flex', alignItems: 'center', gap: 6 },
  timeInput: { padding: '5px 6px', borderRadius: 6, border: '1.5px solid var(--border)', fontSize: 12, fontFamily: 'inherit', outline: 'none', width: 80 },
  timeSep: { fontSize: 11, color: 'var(--text-muted)' },
  toggleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderBottom: '1px solid var(--border-light)' },
  toggleLabel: { fontSize: 13, fontWeight: 500 },
  toggle: { width: 44, height: 24, borderRadius: 10, border: 'none', cursor: 'pointer', position: 'relative', transition: 'background 0.2s', padding: 0 },
  toggleDot: { width: 20, height: 20, borderRadius: 10, background: 'var(--bg-card)', transition: 'transform 0.2s', position: 'absolute', top: 2 },
  sliderSection: { padding: '14px 0' },
  sliderHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  sliderLabel: { fontSize: 13, fontWeight: 500 },
  sliderValue: { fontSize: 14, fontWeight: 700, color: 'var(--accent)' },
  slider: { width: '100%', appearance: 'none', height: 4, borderRadius: 6, background: 'var(--border)', outline: 'none' },
  sliderHints: { display: 'flex', justifyContent: 'space-between', marginTop: 4, fontSize: 10, color: 'var(--text-muted)' },
  toneItem: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--border-light)' },
  toneLabel: { fontSize: 12, color: 'var(--text-muted)', fontWeight: 500 },
  toneValue: { fontSize: 13, color: 'var(--text-primary)', textAlign: 'right', maxWidth: '60%' },
  logoutBtn: { width: '100%', padding: '14px 0', borderRadius: 10, border: '1.5px solid var(--danger)', background: 'transparent', color: 'var(--danger)', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', marginTop: 8 },
  deleteAccountBtn: { width: '100%', padding: '10px 0', borderRadius: 10, border: 'none', background: 'transparent', color: 'var(--danger, #9E2B32)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', marginTop: 6, textDecoration: 'underline', textUnderlineOffset: 3 },

  // Notification styles
  notifRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderBottom: '1px solid var(--border-light)' },
  notifInfo: { display: 'flex', flexDirection: 'column', gap: 2, flex: 1 },
  notifLabel: { fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' },
  notifDesc: { fontSize: 11, color: 'var(--text-muted)' },
  notifChannels: { display: 'flex', gap: 4 },
  notifChip: { width: 32, height: 32, borderRadius: 10, border: 'none', cursor: 'pointer', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center' },
  reminderRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderBottom: '1px solid var(--border-light)' },
  reminderLabel: { fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' },
  channelPicker: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', paddingTop: 14, marginTop: 4 },
  channelLabel: { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' },
  channelOptions: { display: 'flex', gap: 6 },
  channelChip: { padding: '6px 12px', borderRadius: 10, border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },

  // Messaging channels card
  msgChannelRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 0', borderBottom: '1px solid var(--border-light)', gap: 12 },
  msgChannelInfo: { display: 'flex', alignItems: 'center', gap: 12, flex: 1, minWidth: 0 },
  msgChannelIcon: { fontSize: 22, flexShrink: 0 },
  msgChannelName: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' },
  msgChannelStatus: { fontSize: 12, color: 'var(--text-muted)', marginTop: 2 },
  msgChannelBtn: { padding: '8px 16px', borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0 },

  // Block time links
  blockLinkBtn: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '12px 14px', borderRadius: 10, border: '1px solid var(--border)',
    background: 'var(--bg-hover, var(--bg-subtle, #ede7e3))', cursor: 'pointer',
    fontFamily: 'inherit', textAlign: 'left', width: '100%',
  },
  blockLinkIcon: { fontSize: 22, flexShrink: 0 },
  blockLinkTitle: { display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 2 },
  blockLinkDesc: { display: 'block', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4 },

  brandingLinkBtn: {
    display: 'flex', alignItems: 'center', gap: 12,
    padding: '12px 14px', marginTop: 12, borderRadius: 10, border: '1px solid var(--border)',
    background: 'var(--bg-hover, var(--bg-subtle, #ede7e3))', cursor: 'pointer',
    fontFamily: 'inherit', textAlign: 'left', width: '100%',
  },
  brandingLinkIcon: { display: 'inline-flex', flexShrink: 0, color: 'var(--accent)' },
  brandingLinkTitle: { display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 2 },
  brandingLinkDesc: { display: 'block', fontSize: 11, color: 'var(--text-muted)', lineHeight: 1.4 },

  // Payments
  connectionStatus: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
  statusDot: { width: 8, height: 8, borderRadius: 6, flexShrink: 0 },
  connectionLabel: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' },
  connectBtn: { padding: '10px 20px', borderRadius: 10, border: 'none', background: 'var(--accent)', color: 'var(--bg-card)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  paymentMethodRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--border-light)' },
  methodLabel: { display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' },
  methodDesc: { display: 'block', fontSize: 11, color: 'var(--text-muted)', marginTop: 1 },
  depositRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--border-light)' },
  depositLabel: { display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' },
  depositHint: { display: 'block', fontSize: 11, color: 'var(--text-muted)', marginTop: 1 },
  depositAmountRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 0', borderBottom: '1px solid var(--border-light)' },
  depositAmountLabel: { fontSize: 13, fontWeight: 500, color: 'var(--text-secondary)' },
  depositOptions: { display: 'flex', gap: 6 },
  depositChip: { padding: '6px 14px', borderRadius: 10, border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  depositFooter: { fontSize: 11, color: 'var(--text-muted)', margin: '10px 0 0', lineHeight: 1.5 },
  payoutRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--border-light)' },
  payoutLabel: { fontSize: 12, color: 'var(--text-muted)' },
  payoutValue: { fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' },

  // Calendar sync
  calendarProviderRow: { display: 'flex', alignItems: 'center', gap: 12 },
  calProviderLabel: { display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' },
  calProviderStatus: { display: 'block', fontSize: 11, color: 'var(--text-muted)', marginTop: 2 },
  syncRow: { display: 'flex', alignItems: 'center', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--border-light)' },
  syncLabel: { display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' },
  syncHint: { display: 'block', fontSize: 11, color: 'var(--text-muted)', marginTop: 1 },
  bufferOptions: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  bufferChip: { padding: '8px 14px', borderRadius: 10, border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },

  // Florrie's Voice
  chipRow: { display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 },
  chip: { padding: '6px 14px', borderRadius: 10, border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', textTransform: 'capitalize' },
  exampleCard: { background: 'var(--bg-hover)', borderRadius: 10, padding: 12, marginBottom: 10 },
  exampleBubble: { background: 'var(--bg-card)', borderRadius: 10, padding: '8px 12px', marginBottom: 6 },
  exampleLabel: { fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em', display: 'block', marginBottom: 2 },
  exampleText: { fontSize: 13, lineHeight: 1.5, margin: 0, color: 'var(--text-primary)' },
  removeExBtn: { background: 'none', border: 'none', fontSize: 11, color: 'var(--danger)', cursor: 'pointer', padding: '4px 0', fontFamily: 'inherit' },
  addExForm: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 8 },
  exTextarea: { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1.5px solid var(--border)', fontSize: 13, fontFamily: 'inherit', resize: 'vertical', outline: 'none', lineHeight: 1.5, boxSizing: 'border-box', background: 'var(--bg-card)' },
  addExCancelBtn: { padding: '10px 14px', borderRadius: 10, border: 'none', background: 'var(--bg-hover)', color: 'var(--text-secondary)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' },
  addExBtn: { padding: '10px 0', background: 'none', border: 'none', color: 'var(--accent)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
};

/**
 * SubscriptionManager, Opens Stripe Customer Portal to manage subscription
 */
function SubscriptionManager({ beautician }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  async function handleManageSubscription() {
    setLoading(true);
    setError(null);
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      const response = await fetch(`${API_BASE}/api/stripe/portal`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
      });
      const data = await response.json();
      if (data.url) {
        try {
          const redirectUrl = new URL(data.url);
          if (redirectUrl.hostname.endsWith('stripe.com')) {
            window.location.href = data.url;
          } else {
            setError('Invalid portal redirect');
          }
        } catch {
          setError('Invalid portal URL');
        }
      } else {
        setError(data.error || 'Failed to open subscription portal');
      }
    } catch (err) {
      logger.error('Portal error:', err);
      setError('Network error. Please try again.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={styles.card}>
      <div style={styles.cardTitle}>Manage Subscription</div>
      <p style={styles.cardHint}>Update payment method, billing address, or cancel your subscription.</p>
      {error && <p style={{ ...styles.cardHint, color: '#E57373', marginTop: 8 }}>{error}</p>}
      <Button
        size="sm"
        onClick={handleManageSubscription}
        disabled={loading}
      >
        {loading ? 'Opening...' : 'Open Stripe Portal'}
      </Button>
    </div>
  );
}


function CelebrationsCard() {
  const [on, setOn] = useState(celebrationsEnabled());
  return (
    <div style={styles.card}>
      <h3 style={styles.cardTitle}>Celebrations</h3>
      <p style={styles.cardDesc}>
        A little petal bloom, chime and buzz whenever Florrie gets something
        done for you, like an offer sent or a gap filled. Turn it off any time.
      </p>
      <div style={styles.toggleRow}>
        <span style={styles.toggleLabel}>Bloom when Florrie delivers</span>
        <button
          onClick={() => { const next = !on; setCelebrationsEnabled(next); setOn(next); if (next) bloom(); }}
          aria-pressed={on}
          style={{ ...styles.toggle, background: on ? 'var(--accent)' : 'var(--border)' }}
        >
          <div style={{ ...styles.toggleDot, transform: on ? 'translateX(20px)' : 'translateX(2px)' }} />
        </button>
      </div>
    </div>
  );
}

function VoiceControlCard() {
  const [on, setOn] = useState(isVoiceEnabled());
  return (
    <div style={styles.card}>
      <h3 style={styles.cardTitle}>Voice button</h3>
      <p style={styles.cardDesc}>
        Shows the round microphone button for talking to Florrie. It is off by
        default. Turn it on only if you want to dictate by voice, and off any
        time to stop it appearing or making a sound.
      </p>
      <div style={styles.toggleRow}>
        <span style={styles.toggleLabel}>Show the voice button</span>
        <button
          onClick={() => { const next = !on; setVoiceEnabled(next); setOn(next); }}
          aria-pressed={on}
          style={{ ...styles.toggle, background: on ? 'var(--accent)' : 'var(--border)' }}
        >
          <div style={{ ...styles.toggleDot, transform: on ? 'translateX(20px)' : 'translateX(2px)' }} />
        </button>
      </div>
    </div>
  );
}
