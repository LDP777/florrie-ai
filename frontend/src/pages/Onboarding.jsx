import { useState, useEffect } from 'react';
import { track } from '../lib/analytics.js';
import { useBeautician, updateRow, insertRow, supabase } from '../lib/supabase.js'
import { PLAN } from '../lib/subscription.js';
import { registerPush, getPushStatus } from '../lib/push.js';
import logger from '../lib/logger.js';
import { isIOSNative, isNativeApp } from '../lib/platform.js';
import Icon from '../components/ui/Icon';
import Button from '../components/ui/Button';

/** The zone the browser is running in, or null if it cannot say. */
function detectBrowserTimezone() {
  try {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return typeof zone === 'string' && zone.includes('/') ? zone : null;
  } catch {
    return null;
  }
}

const API = import.meta.env.VITE_API_URL;
async function getAuthToken() {
  const key = Object.keys(localStorage).find(k => /^sb-.+-auth-token$/.test(k));
  if (!key) return null;
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try { const p = JSON.parse(raw); return p?.access_token || p?.session?.access_token || raw; }
  catch { return raw; }
}
// Phone-sender detection - matches SMSConfig. Numbers with + or 7-15 digits = 2-way.
function isPhoneSender(value) {
  if (!value) return false;
  const trimmed = value.toString().trim();
  if (trimmed.startsWith('+')) return /^\+[0-9]{7,15}$/.test(trimmed);
  return /^[0-9]{7,15}$/.test(trimmed);
}
/**
 * Onboarding - first-run wizard after signup.
 *
 * Steps:
 * 1. Welcome + business name
 * 2. Add treatments (at least one)
 * 3. Set working hours
 * 4. Create booking link (slug)
 * 5. Import clients (optional, skip-able)
 *
 * Wired to Supabase via useBeautician + shared helpers.
 * Target: under 3 minutes to a working booking page.
 */
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DEFAULT_HOURS = {
  mon: { enabled: true, start: '09:00', end: '17:00' },
  tue: { enabled: true, start: '09:00', end: '17:00' },
  wed: { enabled: true, start: '09:00', end: '17:00' },
  thu: { enabled: true, start: '09:00', end: '17:00' },
  fri: { enabled: true, start: '09:00', end: '17:00' },
  sat: { enabled: false, start: '10:00', end: '16:00' },
  sun: { enabled: false, start: '', end: '' }
};
/**
 * How far through the wizard this account already is, read from its own data.
 *
 * Deliberately does NOT look at working_hours: that column has a Mon-Fri 9-5
 * database default, so it is populated from the moment the row is created and
 * proves nothing about whether she has been through step 3.
 */
async function resolveResumeStep(beautician) {
  if (beautician.booking_slug) return 5;   // step 4 is the only thing that sets it
  if (!beautician.first_name) return 1;
  const { count, error } = await supabase
    .from('treatments')
    .select('id', { count: 'exact', head: true })
    .eq('beautician_id', beautician.id);
  if (!error && (count || 0) > 0) return 3;
  return 2;
}

export default function Onboarding({ onComplete }) {
  const { beautician, loading: bLoading, refresh } = useBeautician();
  const [step, setStep] = useState(1);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  // Step 1: Business info
  const [businessName, setBusinessName] = useState('');
  const [firstName, setFirstName] = useState('');
  // Step 2: Treatments
  const [treatments, setTreatments] = useState([
    { name: '', duration_minutes: 60, price_cents: 0, category: 'brows' }
  ]);
  // Tracks whether the user has been warned that 0-price treatments will not
  // appear on their public booking page. The second Next press then proceeds.
  const [pricelessAck, setPricelessAck] = useState(false);
  // Step 3: Working hours
  const [hours, setHours] = useState(DEFAULT_HOURS);
  // Step 4: Booking slug
  const [slug, setSlug] = useState('');
  const [linkCopied, setLinkCopied] = useState(false);
  // Step 5: Client import
  const [importFile, setImportFile] = useState(null);
  const [importStatus, setImportStatus] = useState(null);
  // Step 6: Push notifications
  const [pushGranted, setPushGranted] = useState(false);
  const [pushLoading, setPushLoading] = useState(false);
  // Step 6: SMS fork (for users who don't have WhatsApp)
  const [smsForkOpen, setSmsForkOpen] = useState(false);
  // Empty on purpose. This used to be pre-filled with the SHARED platform long
  // code and hinted "leave it as-is", so every salon that took the SMS fork
  // claimed the same inbound number. The second one to do it made the inbound
  // lookup ambiguous and dropped every inbound SMS for BOTH of them. Most
  // salons have no number of their own, and empty is the correct answer for
  // them: outbound still works, replies just are not routed.
  const [smsOriginator, setSmsOriginator] = useState('');
  const [smsTestPhone, setSmsTestPhone] = useState('');
  const [smsTestMsg, setSmsTestMsg] = useState('');
  const [smsTesting, setSmsTesting] = useState(false);
  const [smsSaving, setSmsSaving] = useState(false);
  const [smsError, setSmsError] = useState(null);
  // Card capture (step 6): starts the 14-day trial with a card on file
  const [billingLoading, setBillingLoading] = useState(false);
  const [billingError, setBillingError] = useState(null);
  const totalSteps = 6;
  const progress = (step / totalSteps) * 100;

  // Funnel telemetry: one event per step reached (advance or skip), so the
  // signup funnel is measurable and stalls are visible in PostHog. Deliberate
  // events only, no autocapture.
  useEffect(() => {
    try { track('onboarding_step_viewed', { step, total_steps: totalSteps }); } catch { /* never block signup */ }
  }, [step]);

  // Pick up where she left off.
  //
  // The wizard used to hold all its progress in component state, so a signup
  // interrupted at step 3 restarted at step 1 on the next load and added a
  // second copy of every treatment. Her own row already records how far she
  // got, so read it from there: a booking slug can only have been set on step
  // 4, a treatment can only have been added on step 2, a first name on step 1.
  const [resumed, setResumed] = useState(false);
  useEffect(() => {
    if (resumed || bLoading || !beautician) return;
    setResumed(true);

    setFirstName(prev => prev || beautician.first_name || '');
    setBusinessName(prev => prev || beautician.business_name || '');
    setSlug(prev => prev || beautician.booking_slug || '');
    const saved = beautician.working_hours;
    if (saved && typeof saved === 'object') {
      setHours(prev => {
        const next = { ...prev };
        DAY_KEYS.forEach(day => {
          const day_hours = saved[day];
          next[day] = day_hours?.start && day_hours?.end
            ? { enabled: true, start: day_hours.start, end: day_hours.end }
            : { ...prev[day], enabled: false };
        });
        return next;
      });
    }

    (async () => {
      try {
        const resumeStep = await resolveResumeStep(beautician);
        if (resumeStep > 1) setStep(resumeStep);
      } catch (err) {
        logger.warn('Could not work out the resume step, starting at 1:', err);
      }
    })();
  }, [beautician, bLoading, resumed]);

  if (bLoading) {
    return <p style={styles.loadingText}>Setting up your account...</p>;
  }
  async function saveBusinessInfo() {
    if (!beautician) return;
    setSaving(true);
    setError(null);
    try {
      if (!firstName.trim()) {
        setError('First name is required');
        setSaving(false);
        return;
      }
      // The timezone was never collected, so every salon sat on the column
      // default of Europe/London and a Dublin or Sydney owner got reminders
      // on London time. The browser knows where she is; take that as the
      // default unless she has already chosen something other than the
      // default herself (Settings lets her change it later).
      const browserZone = detectBrowserTimezone();
      const untouched = !beautician.timezone || beautician.timezone === 'Europe/London';
      await updateRow('beauticians', beautician.id, {
        first_name: firstName.trim(),
        business_name: businessName.trim(),
        ...(browserZone && untouched ? { timezone: browserZone } : {}),
      });
      await refresh();
      setStep(2);
    } catch (err) {
      logger.error('Save error:', err);
      setError('Failed to save. Please try again.');
    } finally {
      setSaving(false);
    }
  }
  async function saveTreatments() {
    if (!beautician) return;
    setSaving(true);
    setError(null);
    try {
      const valid = treatments.filter(t => t.name.trim());
      if (valid.length === 0) {
        setError('Please add at least one treatment');
        setSaving(false);
        return;
      }
      // Clients can only book treatments that have a price. If every treatment is
      // still 0, warn once before saving so the booking page is not empty. The
      // next tap proceeds, so prices can still be set later.
      const anyPriced = valid.some(t => parseFloat(t.price_cents) > 0);
      if (!anyPriced && !pricelessAck) {
        setPricelessAck(true);
        setError('Add a price to at least one treatment so clients can book it. Tap Next again to carry on and set prices later.');
        setSaving(false);
        return;
      }
      let idx = 0;
      for (const t of valid) {
        await insertRow('treatments', {
          beautician_id: beautician.id,
          name: t.name.trim(),
          duration_minutes: parseInt(t.duration_minutes) || 60,
          price_cents: Math.round(parseFloat(t.price_cents) * 100) || 0,
          category: t.category,
          is_active: true,
          booking_enabled: true,
          sort_order: idx++
        });
      }
      setStep(3);
    } catch (err) {
      logger.error('Treatment save error:', err);
      setError('Failed to save treatments. Please try again.');
    } finally {
      setSaving(false);
    }
  }
  async function saveHours() {
    if (!beautician) return;
    setSaving(true);
    setError(null);
    try {
      const workingHours = {};
      DAY_KEYS.forEach(day => {
        if (hours[day].enabled && hours[day].start && hours[day].end) {
          workingHours[day] = { start: hours[day].start, end: hours[day].end };
        } else {
          workingHours[day] = null;
        }
      });
      await updateRow('beauticians', beautician.id, { working_hours: workingHours });
      await refresh();
      setStep(4);
    } catch (err) {
      logger.error('Hours save error:', err);
      setError('Failed to save hours. Please try again.');
    } finally {
      setSaving(false);
    }
  }
  async function saveSlug() {
    if (!beautician) return;
    setSaving(true);
    setError(null);
    try {
      const cleanSlug = slug.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
      if (!cleanSlug) {
        setError('Booking link cannot be empty');
        setSaving(false);
        return;
      }
      // onboarding_completed_at is NOT written here.
      //
      // It used to be, at step 4 of 6, which meant every exit from steps 5 and
      // 6 was final: App.jsx only shows this wizard while the column is null,
      // so a beautician who closed the tab on the import step never saw the
      // card step, the Instagram connect or the push opt-in again, and had no
      // way back to any of them. The flag now moves at the actual end of the
      // wizard (markOnboardingComplete), and the step she left off at is
      // worked out from her own row when she comes back.
      await updateRow('beauticians', beautician.id, {
        booking_slug: cleanSlug,
      });
      await refresh();
      setStep(5);
    } catch (err) {
      logger.error('Slug save error:', err);
      // 23505 = Postgres unique violation. booking_slug is UNIQUE, so this means
      // another beautician already has this link. Tell the user plainly so they
      // can pick a different one instead of hitting a generic dead end.
      const code = err?.code || err?.details || '';
      const msg = (err?.message || '').toLowerCase();
      if (code === '23505' || msg.includes('duplicate') || msg.includes('unique')) {
        setError('That link is already taken. Try adding your town or a number, like your-name-leeds.');
      } else {
        setError('Could not save your booking link. Please try again.');
      }
    } finally {
      setSaving(false);
    }
  }
  async function handleImport() {
    if (!importFile || !beautician) return;
    setSaving(true);
    setImportStatus(null);
    setError(null);
    try {
      const text = await importFile.text();
      const lines = text.trim().split('\n');
      if (lines.length < 2) {
        setImportStatus('No data rows found');
        setSaving(false);
        return;
      }
      // Simple CSV parsing - expects header row with first_name, last_name, email, phone
      const headerRow = lines[0].toLowerCase();
      const headers = headerRow.split(',').map(h => h.trim());
      const firstIdx = headers.findIndex(h => h.includes('first'));
      const lastIdx = headers.findIndex(h => h.includes('last') || h.includes('surname'));
      const emailIdx = headers.findIndex(h => h.includes('email'));
      const phoneIdx = headers.findIndex(h => h.includes('phone') || h.includes('mobile'));
      let imported = 0;
      for (let i = 1; i < lines.length; i++) {
        const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
        const fName = firstIdx >= 0 ? cols[firstIdx] : cols[0];
        if (!fName) continue;
        try {
          await insertRow('clients', {
            beautician_id: beautician.id,
            first_name: fName,
            last_name: lastIdx >= 0 ? (cols[lastIdx] || '') : '',
            email: emailIdx >= 0 ? (cols[emailIdx] || '') : '',
            phone: phoneIdx >= 0 ? (cols[phoneIdx] || '') : '',
            status: 'active'
          });
          imported++;
        } catch (e) {
          logger.warn('Row import failed:', e);
        }
      }
      setImportStatus(`Imported ${imported} client${imported !== 1 ? 's' : ''}`);
    } catch (err) {
      setError('Import failed. Check the file format.');
    } finally {
      setSaving(false);
    }
  }
  /**
   * The one place onboarding is marked done.
   *
   * Every way out of the last step goes through here: the dashboard button,
   * the WhatsApp and SMS forks, and the hop to Stripe. Anything that does NOT
   * go through here leaves the wizard open, which is the point: an abandoned
   * signup is resumable rather than silently finished.
   */
  async function markOnboardingComplete() {
    if (!beautician || beautician.onboarding_completed_at) return;
    try {
      await updateRow('beauticians', beautician.id, {
        onboarding_completed_at: new Date().toISOString(),
      });
      try { track('onboarding_completed', { total_steps: totalSteps }); } catch { /* noop */ }
      await refresh();
    } catch (err) {
      // Never trap her in the wizard over a failed write. She lands in the app
      // and the resume logic puts her back on the last step next time.
      logger.error('Could not mark onboarding complete:', err);
    }
  }

  async function finishOnboarding(destination) {
    await markOnboardingComplete();
    if (onComplete) onComplete(destination);
  }
  async function startCardCapture() {
    setBillingError(null);
    setBillingLoading(true);
    try {
      const token = await getAuthToken();
      if (!token) {
        setBillingError('Session expired. Please refresh and try again.');
        setBillingLoading(false);
        return;
      }
      const res = await fetch(`${API}/api/billing/create-checkout`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ plan: PLAN.id, interval: 'monthly', trial: true }),
      });
      const data = await res.json();
      if (data.url) {
        // Stripe's hosted page collects the card. On success Stripe sends the
        // beautician back to /?billing=success and the trialing subscription is live.
        //
        // Marked done BEFORE we leave: Stripe returns to "/", and an account
        // still flagged incomplete would drop the person who has just entered
        // her card back into the wizard.
        await markOnboardingComplete();
        window.location.href = data.url;
        return;
      }
      setBillingError(data.error || 'Could not start card setup. Try again shortly.');
    } catch (err) {
      logger.error('Card capture error:', err);
      setBillingError('Could not connect to billing. Try again shortly.');
    } finally {
      setBillingLoading(false);
    }
  }
  async function enableNotifications() {
    setPushLoading(true);
    try {
      const granted = await registerPush();
      setPushGranted(!!granted);
    } catch (err) {
      logger.warn('Push enable failed:', err);
    } finally {
      setPushLoading(false);
    }
  }
  async function sendSMSTest() {
    const phone = smsTestPhone.trim();
    if (!phone) {
      setSmsTestMsg('Enter your mobile number first');
      return;
    }
    setSmsTesting(true);
    setSmsTestMsg('');
    try {
      const token = await getAuthToken();
      const res = await fetch(`${API}/api/notifications/sms/test`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Send failed');
      setSmsTestMsg(`Sent. Check ${phone}.`);
    } catch (err) {
      setSmsTestMsg(err.message || 'Could not send test');
    } finally {
      setSmsTesting(false);
    }
  }
  async function useSMSOnly() {
    // Blank is valid and is the common case: she has no number of her own, so
    // SMS goes out from the shared Florrie number and replies are not routed.
    // Sending null CLEARS any inbound number rather than claiming a shared one.
    const originator = smsOriginator.trim();
    setSmsSaving(true);
    setSmsError(null);
    try {
      const token = await getAuthToken();
      const res = await fetch(`${API}/api/notifications/sms/config`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sms_inbound_number: originator || null,
          sms_enabled: true,
          channel: 'sms',
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not save SMS settings');
      finishOnboarding('/');
    } catch (err) {
      setSmsError(err.message || 'Could not save SMS settings');
    } finally {
      setSmsSaving(false);
    }
  }
  // Instagram-first channel connect (Levi, 9 Jul): DMs are where brow
  // clients already live and the OAuth flow has zero telecom pain. Honest
  // states: not-configured shows a plain "soon" note, never a dead end.
  const [igNote, setIgNote] = useState(null);
  async function connectInstagram() {
    try {
      try { track('onboarding_instagram_connect_tapped', { step }); } catch { /* noop */ }
      // Instagram will not render its login inside the app's WKWebView — it
      // hangs on a half-drawn page with no way back. On native the url has to
      // leave the app, and the backend needs ?platform=native so the callback
      // ends on its own "go back to Florrie" page rather than a redirect into
      // a browser tab with no session.
      const native = isNativeApp();
      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch(`${API}/api/instagram/connect${native ? '?platform=native' : ''}`, {
        headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
      });
      const d = await res.json().catch(() => ({}));
      if (res.ok && d.url) {
        if (native) {
          window.open(d.url, '_blank');
          setIgNote('Finish in the browser, then come back here. We will pick it up.');
        } else {
          window.location.href = d.url;
        }
        return;
      }
      setIgNote('Instagram connect is switching on very soon. You can finish setup now and connect from Settings when it is ready.');
    } catch {
      setIgNote('Could not reach Instagram just now. Finish setup and connect from Settings any time.');
    }
  }

  function skipStep() {
    try { track('onboarding_step_skipped', { step }); } catch { /* noop */ }
    setError(null);
    if (step < totalSteps) {
      setStep(step + 1);
    }
  }
  // Treatment helpers
  function addTreatment() {
    setTreatments(prev => [...prev, { name: '', duration_minutes: 60, price_cents: 0, category: 'brows' }]);
  }
  function updateTreatment(idx, field, value) {
    setTreatments(prev => prev.map((t, i) => i === idx ? { ...t, [field]: value } : t));
  }
  function removeTreatment(idx) {
    if (treatments.length <= 1) return;
    setTreatments(prev => prev.filter((_, i) => i !== idx));
  }
  // Hours helper
  function toggleDay(day) {
    setHours(prev => ({
      ...prev,
      [day]: { ...prev[day], enabled: !prev[day].enabled }
    }));
  }
  function updateHour(day, field, value) {
    setHours(prev => ({
      ...prev,
      [day]: { ...prev[day], [field]: value }
    }));
  }
  return (
    <div style={styles.page}>
      {/* Progress bar */}
      <div style={styles.progressBar}>
        <div style={{ ...styles.progressFill, width: `${progress}%` }} />
      </div>
      <div style={styles.stepIndicator}>Step {step} of {totalSteps}</div>
      {/* === STEP 1: Welcome === */}
      {step === 1 && (
        <div style={styles.stepContent}>
          <h1 style={styles.stepTitle}>Welcome to florrie.ai</h1>
          <p style={styles.stepDesc}>
            Let's get your business set up. This takes about 2 minutes.
          </p>
          {error && (
            <div style={styles.errorBanner}>
              <span style={{ fontSize: 13, color: 'var(--danger-text)', fontWeight: 500 }}>{<Icon name="alert-triangle" inline />} {error}</span>
            </div>
          )}
          <div style={styles.formGroup}>
            <label style={styles.formLabel}>Your first name</label>
            <input
              type="text"
              placeholder="e.g. Ellie"
              value={firstName}
              onChange={e => setFirstName(e.target.value)}
              style={styles.formInput}
              autoFocus
            />
          </div>
          <div style={styles.formGroup}>
            <label style={styles.formLabel}>Business name</label>
            <input
              type="text"
              placeholder="e.g. Ellie Brows"
              value={businessName}
              onChange={e => {
                setBusinessName(e.target.value);
                if (!slug) {
                  setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+/g, '-'));
                }
              }}
              style={styles.formInput}
            />
          </div>
          <Button
            variant="primary"
            size="lg"
            fullWidth
            onClick={saveBusinessInfo}
            disabled={!firstName.trim() || saving}
            style={{ marginTop: 12, opacity: !firstName.trim() ? 0.5 : 1 }}
          >
            {saving ? 'Saving...' : 'Next'}
          </Button>
          {/* UK GDPR art 13: a Google or Apple sign-in never passes the
              signup form on Login.jsx, so this is the first screen some
              owners see where their details are about to be stored. Plain
              anchors so the policy opens as a page rather than a route the
              onboarding wizard would have to give up its state for. */}
          <p style={styles.legalNote}>
            By continuing you agree to our{' '}
            <a href="/terms" style={styles.legalLink} target="_blank" rel="noopener noreferrer">Terms</a>
            {' '}and{' '}
            <a href="/privacy" style={styles.legalLink} target="_blank" rel="noopener noreferrer">Privacy Policy</a>.
          </p>
        </div>
      )}
      {/* === STEP 2: Treatments === */}
      {step === 2 && (
        <div style={styles.stepContent}>
          <h1 style={styles.stepTitle}>Your treatments</h1>
          <p style={styles.stepDesc}>
            Add the services you offer. You can always add more later.
          </p>
          {error && (
            <div style={styles.errorBanner}>
              <span style={{ fontSize: 13, color: 'var(--danger-text)', fontWeight: 500 }}>{<Icon name="alert-triangle" inline />} {error}</span>
            </div>
          )}
          {treatments.map((t, idx) => (
            <div key={idx} style={styles.treatmentCard}>
              <div style={styles.treatmentHeader}>
                <span style={styles.treatmentNum}>Treatment {idx + 1}</span>
                {treatments.length > 1 && (
                  <button onClick={() => removeTreatment(idx)} style={styles.removeBtn}>Remove</button>
                )}
              </div>
              <div style={styles.formGroup}>
                <label style={styles.formLabel}>Name</label>
                <input
                  type="text"
                  placeholder="e.g. Brow Lamination"
                  value={t.name}
                  onChange={e => updateTreatment(idx, 'name', e.target.value)}
                  style={styles.formInput}
                />
              </div>
              <div style={styles.formRow}>
                <div style={styles.formGroup}>
                  <label style={styles.formLabel}>Duration (mins)</label>
                  <input
                    type="number"
                    value={t.duration_minutes}
                    onChange={e => updateTreatment(idx, 'duration_minutes', e.target.value)}
                    style={styles.formInput}
                  />
                </div>
                <div style={styles.formGroup}>
                  <label style={styles.formLabel}>Price (£)</label>
                  <input
                    type="number"
                    step="0.01"
                    placeholder="0.00"
                    value={t.price_cents}
                    onChange={e => updateTreatment(idx, 'price_cents', e.target.value)}
                    style={styles.formInput}
                  />
                </div>
              </div>
              <p style={styles.priceHint}>Clients can only book treatments that have a price set.</p>
              <div style={styles.formGroup}>
                <label style={styles.formLabel}>Category</label>
                <select
                  value={t.category}
                  onChange={e => updateTreatment(idx, 'category', e.target.value)}
                  style={styles.formSelect}
                >
                  <option value="brows">Brows</option>
                  <option value="lashes">Lashes</option>
                  <option value="nails">Nails</option>
                  <option value="skin">Skin</option>
                  <option value="waxing">Waxing</option>
                  <option value="makeup">Makeup</option>
                  <option value="hair">Hair</option>
                  <option value="other">Other</option>
                </select>
              </div>
            </div>
          ))}
          <button onClick={addTreatment} style={styles.secondaryBtn}>
            + Add another treatment
          </button>
          <Button
            variant="primary"
            size="lg"
            fullWidth
            onClick={saveTreatments}
            disabled={!treatments.some(t => t.name.trim()) || saving}
            style={{ marginTop: 8, opacity: !treatments.some(t => t.name.trim()) ? 0.5 : 1 }}
          >
            {saving ? 'Saving...' : 'Next'}
          </Button>
          <button onClick={skipStep} style={styles.skipBtn}>
            Skip for now
          </button>
        </div>
      )}
      {/* === STEP 3: Working Hours === */}
      {step === 3 && (
        <div style={styles.stepContent}>
          <h1 style={styles.stepTitle}>Working hours</h1>
          <p style={styles.stepDesc}>
            When are you available for bookings?
          </p>
          {error && (
            <div style={styles.errorBanner}>
              <span style={{ fontSize: 13, color: 'var(--danger-text)', fontWeight: 500 }}>{<Icon name="alert-triangle" inline />} {error}</span>
            </div>
          )}
          {DAY_KEYS.map((day, idx) => (
            <div key={day} style={styles.dayRow}>
              <label style={styles.dayToggle}>
                <input
                  type="checkbox"
                  checked={hours[day].enabled}
                  onChange={() => toggleDay(day)}
                />
                <span style={{ ...styles.dayName,
                  color: hours[day].enabled ? 'var(--text-primary)' : 'var(--text-muted)'
                }}>
                  {DAYS[idx]}
                </span>
              </label>
              {hours[day].enabled && (
                <div style={styles.timeInputs}>
                  <input
                    type="time"
                    value={hours[day].start}
                    onChange={e => updateHour(day, 'start', e.target.value)}
                    style={styles.timeInput}
                  />
                  <span style={styles.timeSep}>to</span>
                  <input
                    type="time"
                    value={hours[day].end}
                    onChange={e => updateHour(day, 'end', e.target.value)}
                    style={styles.timeInput}
                  />
                </div>
              )}
            </div>
          ))}
          <Button
            variant="primary"
            size="lg"
            fullWidth
            onClick={saveHours}
            disabled={saving}
            style={{ marginTop: 12 }}
          >
            {saving ? 'Saving...' : 'Next'}
          </Button>
          <button onClick={skipStep} style={styles.skipBtn}>
            Skip for now
          </button>
        </div>
      )}
      {/* === STEP 4: Booking Link === */}
      {step === 4 && (
        <div style={styles.stepContent}>
          <h1 style={styles.stepTitle}>Your booking link</h1>
          <p style={styles.stepDesc}>
            Clients will use this link to book with you.
          </p>
          {error && (
            <div style={styles.errorBanner}>
              <span style={{ fontSize: 13, color: 'var(--danger-text)', fontWeight: 500 }}>{<Icon name="alert-triangle" inline />} {error}</span>
            </div>
          )}
          <div style={styles.slugPreview}>
            <span style={styles.slugPrefix}>florrie.ai/book/</span>
            <input
              type="text"
              value={slug}
              onChange={e => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
              placeholder="your-name"
              style={styles.slugInput}
            />
          </div>
          <Button
            variant="primary"
            size="lg"
            fullWidth
            onClick={saveSlug}
            disabled={!slug.trim() || saving}
            style={{ marginTop: 12, opacity: !slug.trim() ? 0.5 : 1 }}
          >
            {saving ? 'Saving...' : 'Next'}
          </Button>
        </div>
      )}
      {/* === STEP 5: Import Clients === */}
      {step === 5 && (
        <div style={styles.stepContent}>
          <h1 style={styles.stepTitle}>Bring your clients over</h1>
          <p style={styles.stepDesc}>
            Switching takes 2 minutes. Export your client list and upload it here.
          </p>
          {error && (
            <div style={styles.errorBanner}>
              <span style={{ fontSize: 13, color: 'var(--danger-text)', fontWeight: 500 }}>{<Icon name="alert-triangle" inline />} {error}</span>
            </div>
          )}
          {/* Import from Timely - branded */}
          <div style={styles.importGuide}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <span style={{ fontSize: 20 }}>{<Icon name="clock" inline />}</span>
              <span style={{ fontSize: 15, fontWeight: 600 }}>Import from Timely</span>
            </div>
            <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.8 }}>
              <li>In Timely, go to <b>Clients → Export</b></li>
              <li>Download the CSV file</li>
              <li>Upload it below and we'll match the columns automatically</li>
            </ol>
          </div>
          {/* Import from Fresha */}
          <div style={{ ...styles.importGuide, borderColor: '#E8E4E0' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <span style={{ fontSize: 20 }}><Icon name="dot" size={15} /></span>
              <span style={{ fontSize: 15, fontWeight: 600 }}>Import from Fresha</span>
            </div>
            <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.8 }}>
              <li>In Fresha, go to <b>Clients → Export to CSV</b></li>
              <li>Upload it here. Same thing, we sort the columns.</li>
            </ol>
          </div>
          <p style={{ fontSize: 12, color: 'var(--text-muted)', textAlign: 'center', margin: '8px 0 12px' }}>
            Works with any CSV that has name, email, or phone columns
          </p>
          <div style={styles.importArea}>
            <input
              type="file"
              accept=".csv"
              onChange={e => setImportFile(e.target.files?.[0] || null)}
              style={styles.fileInput}
            />
            {importFile && (
              <button
                onClick={handleImport}
                disabled={saving}
                style={styles.secondaryBtn}
              >
                {saving ? 'Importing...' : `Import ${importFile.name}`}
              </button>
            )}
            {importStatus && (
              <p style={styles.importResult}>{importStatus}</p>
            )}
          </div>
          <Button
            variant="primary"
            size="lg"
            fullWidth
            onClick={() => setStep(6)}
            style={{ marginTop: 12 }}
          >
            {importStatus ? 'Next' : 'Skip for now'}
          </Button>
          {!importStatus && (
            <button onClick={skipStep} style={styles.skipBtn}>
              Skip this step
            </button>
          )}
        </div>
      )}
      {/* === STEP 6: You're All Set === */}
      {step === 6 && (
        <div style={styles.stepContent}>
          <h1 style={styles.stepTitle}>You're all set</h1>
          <p style={styles.stepDesc}>
            Your booking page is live. Share this link and clients can book you in seconds.
          </p>
          <div style={{ background: 'var(--tone-1, #fbf1ea)', borderRadius: 16, padding: '14px 16px', margin: '0 0 14px', textAlign: 'left' }}>
            <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--text-primary, #241B17)', margin: '0 0 4px' }}>
              Connect Instagram (recommended)
            </p>
            <p style={{ fontSize: 12.5, color: 'var(--text-secondary, #574A42)', margin: '0 0 10px', lineHeight: 1.45 }}>
              Most booking chats start in your DMs. Connect and Florrie answers them,
              takes bookings, and posts for you. WhatsApp can come later, no phone
              number wrangling needed today.
            </p>
            <Button
              variant="primary"
              size="sm"
              onClick={connectInstagram}
            >
              Connect Instagram
            </Button>
            {igNote && <p style={{ fontSize: 12, color: 'var(--text-secondary, #574A42)', margin: '8px 0 0' }}>{igNote}</p>}
          </div>
          {(() => {
            const bookingSlug = (slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
            const bookingUrl = `https://florrie.ai/book/${bookingSlug}`;
            const copy = async () => {
              try { await navigator.clipboard?.writeText?.(bookingUrl); setLinkCopied(true); setTimeout(() => setLinkCopied(false), 1800); } catch {}
            };
            const share = async () => {
              if (navigator.share) { try { await navigator.share({ title: 'Book with me', url: bookingUrl }); return; } catch {} }
              copy();
            };
            return (
              <div style={{ background: 'var(--gradient-hero)', borderRadius: 16, padding: 18, color: '#fff', marginBottom: 16, boxShadow: 'var(--elev-2)' }}>
                <div style={{ fontSize: 12, fontWeight: 700, letterSpacing: '0.06em', textTransform: 'uppercase', opacity: 0.85, marginBottom: 6 }}>Your booking link is live</div>
                <div style={{ fontSize: 15, fontWeight: 700, wordBreak: 'break-all', marginBottom: 12 }}>florrie.ai/book/{bookingSlug}</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="fl-tap" onClick={copy} style={{ flex: 1, padding: '11px 0', borderRadius: 10, border: 'none', background: 'rgba(255,255,255,0.18)', color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
                    {linkCopied ? 'Copied' : 'Copy link'}
                  </button>
                  <button className="fl-tap" onClick={share} style={{ flex: 1, padding: '11px 0', borderRadius: 10, border: 'none', background: '#fff', color: 'var(--accent)', fontSize: 14, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
                    Share
                  </button>
                </div>
              </div>
            );
          })()}
          <p style={styles.trialNote}>
            Your 14 day trial is already running, with everything switched on and
            no card needed. Add a card now and Florrie carries straight on when
            it ends, or leave it and we will ask you nearer the time.
          </p>
          <div style={{ ...styles.planCard,
            border: '1.5px solid var(--accent, #92405e)',
            boxShadow: 'var(--elev-2)',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={styles.planName}>{PLAN.name}</div>
              <div style={{ fontSize: 16, fontWeight: 700, color: 'var(--accent, #92405e)' }}>{PLAN.monthlyLabel}</div>
            </div>
            <ul style={styles.planFeatures}>
              {PLAN.features.map((f, i) => (
                <li key={i} style={styles.planFeature}>
                  <span style={{ color: 'var(--success, #386F52)' }}><Icon name="check" size={15} /></span> {f}
                </li>
              ))}
            </ul>
          </div>
          {billingError && (
            <div style={styles.errorBanner}>
              <span style={{ fontSize: 13, color: 'var(--danger-text)', fontWeight: 500 }}>{<Icon name="alert-triangle" inline />} {billingError}</span>
            </div>
          )}
          {isIOSNative() ? (
            <>
              {/* No purchase CTA and no link out to a payment page on native
                  iOS, per App Store Guideline 3.1.3(b). The old copy here told
                  her to go to florrie.ai and add a card "to start your 14 day
                  trial", which was both a steer to an external purchase and
                  untrue: the trial starts at signup either way. */}
              <div style={styles.messagingCard}>
                <p style={{ fontSize: 14, color: 'var(--text)', margin: 0, lineHeight: 1.5 }}>
                  Your 14 day trial is running, with every feature switched on.
                  Nothing to set up and nothing to pay today.
                </p>
              </div>
            </>
          ) : (
            <>
              <Button
                variant="primary"
                size="lg"
                fullWidth
                onClick={startCardCapture}
                disabled={billingLoading}
                style={{ marginTop: 12, opacity: billingLoading ? 0.6 : 1 }}
              >
                {billingLoading ? 'Opening secure checkout...' : 'Add a card now'}
              </Button>
              <p style={styles.trialNote}>
                Nothing to pay today. From day 15 it is {PLAN.monthlyLabel}, or {PLAN.annualLabel} on annual billing, and you can cancel before then from Settings. Card details are handled securely by Stripe, we never see them.
              </p>
            </>
          )}
          {/* WhatsApp-first connect card. SMS is already live so it sits below as reassurance. */}
          <div style={styles.messagingCard}>
            <div style={styles.channelRow}>
              <span style={styles.waIcon}><Icon name="message" size={15} /></span>
              <div style={styles.channelCopy}>
                <div style={styles.waTitleRow}>
                  <span style={styles.channelTitle}>WhatsApp: your AI receptionist</span>
                  <span style={styles.waRecommend}>Recommended</span>
                </div>
                <div style={styles.channelDesc}>Books, reschedules, answers questions. 24/7, in your voice.</div>
                <div style={styles.waMeta}>~15 min. Spare number needed.</div>
              </div>
            </div>
            <div style={styles.waButtonRow}>
              <button onClick={() => finishOnboarding('/whatsapp')} style={styles.waPrimaryBtn}>
                Connect WhatsApp →
              </button>
              <button onClick={() => finishOnboarding('/')} style={styles.waSkipBtn}>
                Skip for now
              </button>
            </div>
            <div style={styles.channelDivider} />
            {!smsForkOpen ? (
              <button
                type="button"
                onClick={() => setSmsForkOpen(true)}
                style={styles.smsForkToggle}
              >
                <span style={styles.smsForkToggleIcon}><Icon name="mail" size={18} /></span>
                <span style={styles.smsForkToggleText}>
                  <span style={styles.smsForkToggleTitle}>No WhatsApp? Use SMS instead</span>
                  <span style={styles.smsForkToggleHint}>Text only. Works on any UK number.</span>
                </span>
                <span style={styles.smsForkToggleArrow}>→</span>
              </button>
            ) : (
              <div style={styles.smsForkPanel}>
                <div style={styles.smsForkHeadRow}>
                  <div style={styles.smsForkHead}>
                    <div style={styles.smsForkTitle}>Set up SMS</div>
                    <div style={styles.smsForkSub}>Texts go out from our shared UK number. Replies need your own.</div>
                  </div>
                  <Button
                    variant="secondary"
                    icon
                    onClick={() => {
                      setSmsForkOpen(false);
                      setSmsError(null);
                      setSmsTestMsg('');
                    }}
                    style={{ color: 'var(--text-secondary)', flexShrink: 0 }}
                    aria-label="Close SMS setup"
                  >
                    ×
                  </Button>
                </div>
                <div style={styles.smsFieldBlock}>
                  <label style={styles.smsFieldLabel}>Your own number, for replies (optional)</label>
                  <input
                    type="text"
                    value={smsOriginator}
                    onChange={e => setSmsOriginator(e.target.value.replace(/[^0-9+ ]/g, '').substring(0, 20))}
                    style={styles.smsFieldInput}
                    placeholder="Leave empty if you haven't got one"
                    inputMode="tel"
                  />
                  <div style={styles.smsFieldHint}>
                    Only fill this in if you have bought your own Bird number. Leave it empty and your texts still go out on our shared number, clients just cannot reply to them. Our shared number is not an option here: every salon sends from it, so a reply to it would not say which salon it was meant for.
                  </div>
                </div>
                <div style={styles.smsFieldBlock}>
                  <label style={styles.smsFieldLabel}>Send a test to yourself</label>
                  <div style={styles.smsTestRow}>
                    <input
                      type="tel"
                      value={smsTestPhone}
                      onChange={e => setSmsTestPhone(e.target.value)}
                      style={styles.smsFieldInput}
                      placeholder="+44 7..."
                      inputMode="tel"
                    />
                    <button
                      type="button"
                      onClick={sendSMSTest}
                      disabled={smsTesting || !smsTestPhone.trim()}
                      style={{ ...styles.smsTestBtn,
                        opacity: (smsTesting || !smsTestPhone.trim()) ? 0.5 : 1,
                      }}
                    >
                      {smsTesting ? 'Sending…' : 'Send test'}
                    </button>
                  </div>
                  {smsTestMsg && (
                    <div style={styles.smsTestNote}>{smsTestMsg}</div>
                  )}
                </div>
                {smsError && (
                  <div style={styles.smsForkError}>{smsError}</div>
                )}
                <div style={styles.smsForkActions}>
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={useSMSOnly}
                    disabled={smsSaving}
                    style={{ flex: 1, opacity: smsSaving ? 0.6 : 1 }}
                  >
                    {smsSaving ? 'Saving…' : 'Use SMS only'}
                  </Button>
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => {
                      setSmsForkOpen(false);
                      setSmsError(null);
                      setSmsTestMsg('');
                    }}
                  >
                    Back
                  </Button>
                </div>
                <div style={styles.smsForkFootnote}>
                  You can switch on WhatsApp later from Settings → Messaging channels.
                </div>
              </div>
            )}
          </div>
          {/* Push notification opt-in */}
          <div style={styles.pushCard}>
            <div style={styles.pushCardTop}>
              <span style={styles.pushIcon}><Icon name="bell" size={15} /></span>
              <div>
                <div style={styles.pushTitle}>
                  {pushGranted ? 'Notifications active' : 'Get notified when your AI acts'}
                </div>
                <div style={styles.pushDesc}>
                  {pushGranted
                    ? 'You\'ll hear from Florrie when something happens. Review requests sent, nudges fired, messages handled.'
                    : 'Know the moment Florrie sends a review request, spots a lapsed client, or handles a message. No need to open the app.'}
                </div>
              </div>
            </div>
            {pushGranted ? (
              <div style={styles.pushGrantedRow}>
                <span style={{ color: 'var(--success, #386F52)', fontSize: 16 }}><Icon name="check" size={15} /></span>
                <span style={{ fontSize: 13, color: 'var(--success, #386F52)', fontWeight: 600 }}>Notifications on</span>
              </div>
            ) : (
              <Button
                variant="secondary"
                size="sm"
                fullWidth
                onClick={enableNotifications}
                disabled={pushLoading}
                style={{ border: '1.5px solid var(--accent, #92405e)' }}
              >
                {pushLoading ? 'Enabling…' : 'Turn on notifications'}
              </Button>
            )}
          </div>
          <Button
            variant="secondary"
            size="lg"
            fullWidth
            onClick={() => finishOnboarding('/')}
            style={{ marginTop: 12 }}
          >
            Go to my dashboard
          </Button>
          <p style={{ textAlign: 'center', fontSize: 11, color: 'var(--text-muted)', marginTop: 8 }}>
            {isIOSNative()
              ? 'You can turn on notifications later in Settings.'
              : 'You can add a card, or turn on notifications, any time in Settings.'}
          </p>
        </div>
      )}
    </div>
  );
}
const styles = {
  page: {
    minHeight: 'var(--shell-viewport)',
    background: 'var(--bg)',
    fontFamily: "var(--font-body, 'Plus Jakarta Sans', -apple-system, sans-serif)",
    padding: '0 20px 60px',
    maxWidth: 480,
    margin: '0 auto',
    color: 'var(--text-primary)',
    animation: 'fadeIn 0.25s cubic-bezier(0.16, 1, 0.3, 1)'
  },
  loadingText: { textAlign: 'center', color: 'var(--text-muted)', padding: 60, fontSize: 14, fontFamily: "var(--font-body, 'Plus Jakarta Sans', sans-serif)" },
  progressBar: {
    height: 4,
    background: 'var(--border)',
    borderRadius: 'var(--radius-xs)',
    marginTop: 20,
    marginBottom: 8,
    overflow: 'hidden'
  },
  progressFill: {
    height: '100%',
    background: 'var(--accent)',
    borderRadius: 'var(--radius-xs)',
    transition: 'width 0.3s ease'
  },
  stepIndicator: {
    fontSize: 12,
    color: 'var(--text-muted)',
    marginBottom: 24,
    textAlign: 'right'
  },
  stepContent: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4
  },
  stepTitle: {
    fontSize: 24,
    fontWeight: 700,
    margin: '0 0 4px',
    color: 'var(--text-primary)',
    fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)",
    letterSpacing: '-0.02em'
  },
  stepDesc: {
    fontSize: 14,
    color: 'var(--text-secondary)',
    margin: '0 0 20px',
    lineHeight: 1.5
  },
  // Forms
  formGroup: { marginBottom: 14 },
  formRow: { display: 'flex', gap: 10 },
  formLabel: { display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, fontWeight: 500 },
  formInput: {
    width: '100%',
    padding: '12px 14px',
    borderRadius: 10,
    border: '1.5px solid var(--border)',
    fontSize: 15,
    fontFamily: 'inherit',
    outline: 'none',
    boxSizing: 'border-box',
    transition: 'border-color 0.2s'
  },
  formSelect: {
    width: '100%',
    padding: '12px 14px',
    borderRadius: 10,
    border: '1.5px solid var(--border)',
    fontSize: 15,
    fontFamily: 'inherit',
    outline: 'none',
    background: 'var(--bg-card)',
    boxSizing: 'border-box'
  },
  // Buttons
  secondaryBtn: {
    width: '100%',
    padding: '12px 0',
    borderRadius: 10,
    border: '1.5px dashed var(--border)',
    background: 'transparent',
    color: 'var(--text-secondary)',
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
    fontFamily: 'inherit'
  },
  // Treatments
  treatmentCard: {
    background: 'var(--bg-card)',
    borderRadius: 16,
    padding: 16,
    marginBottom: 10,
    boxShadow: 'var(--shadow-sm)'
  },
  treatmentHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12
  },
  treatmentNum: { fontSize: 12, fontWeight: 600, color: 'var(--accent)', textTransform: 'uppercase', letterSpacing: '0.04em' },
  removeBtn: {
    padding: '4px 10px',
    borderRadius: 'var(--radius-xs)',
    border: 'none',
    background: 'var(--danger-bg)',
    color: 'var(--danger)',
    fontSize: 11,
    cursor: 'pointer',
    fontFamily: 'inherit'
  },
  // Hours
  dayRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '10px 0',
    borderBottom: '1px solid var(--border-light)'
  },
  dayToggle: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    cursor: 'pointer'
  },
  dayName: { fontSize: 14, fontWeight: 500 },
  timeInputs: { display: 'flex', alignItems: 'center', gap: 6 },
  timeInput: {
    padding: '6px 8px',
    borderRadius: 'var(--radius-xs)',
    border: '1.5px solid var(--border)',
    fontSize: 13,
    fontFamily: 'inherit',
    outline: 'none',
    width: 90
  },
  timeSep: { fontSize: 12, color: 'var(--text-muted)' },
  // Slug
  slugPreview: {
    display: 'flex',
    alignItems: 'center',
    background: 'var(--bg-card)',
    borderRadius: 10,
    padding: '4px 4px 4px 14px',
    border: '1.5px solid var(--border)'
  },
  slugPrefix: { fontSize: 14, color: 'var(--text-muted)', whiteSpace: 'nowrap' },
  slugInput: {
    flex: 1,
    border: 'none',
    outline: 'none',
    fontSize: 15,
    fontWeight: 600,
    fontFamily: 'inherit',
    padding: '10px 10px',
    color: 'var(--text-primary)'
  },
  // Import
  importGuide: {
    background: 'var(--bg-card)',
    borderRadius: 10,
    padding: 16,
    marginBottom: 10,
    border: '1.5px solid rgba(199, 107, 138, 0.19)',
  },
  importArea: {
    background: 'var(--bg-card)',
    borderRadius: 16,
    padding: 20,
    textAlign: 'center',
    marginBottom: 12,
    border: '1.5px dashed var(--border)'
  },
  priceHint: { fontSize: 11, color: 'var(--text-muted)', margin: '2px 0 0' },
  legalNote: { textAlign: 'center', fontSize: 12, color: 'var(--text-muted)', margin: '12px 0 0' },
  legalLink: { color: 'var(--accent)', textDecoration: 'underline' },
  fileInput: { marginBottom: 12, fontSize: 13 },
  importResult: { fontSize: 13, color: 'var(--success)', marginTop: 10, fontWeight: 500 },
  // Error and skip
  errorBanner: {
    background: 'var(--danger-bg)',
    border: '1px solid var(--danger-bg)',
    borderRadius: 10,
    padding: '12px 14px',
    marginBottom: 16,
  },
  skipBtn: {
    width: '100%',
    padding: '12px 0',
    borderRadius: 10,
    border: 'none',
    background: 'transparent',
    color: 'var(--text-muted)',
    fontSize: 13,
    fontWeight: 500,
    cursor: 'pointer',
    fontFamily: 'inherit',
    marginTop: 8,
    textDecoration: 'underline',
  },
  // Plan selection (step 6)
  planGrid: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    marginBottom: 16,
  },
  planCard: {
    background: 'var(--bg-card, #FFFCF9)',
    border: '1.5px solid var(--border)',
    borderRadius: 16,
    padding: '16px 18px',
    position: 'relative',
  },
  planCardPopular: {
    border: '1.5px solid var(--accent, #92405e)',
    boxShadow: 'var(--elev-2)',
  },
  popularBadge: {
    position: 'absolute',
    top: -10,
    right: 14,
    background: 'var(--accent, #92405e)',
    color: '#fff',
    fontSize: 10,
    fontWeight: 600,
    padding: '3px 10px',
    borderRadius: 'var(--radius-xs)',
    letterSpacing: '0.02em',
  },
  planName: {
    fontSize: 16,
    fontWeight: 700,
    color: 'var(--text-primary)',
    marginBottom: 2,
  },
  planPrice: {
    fontSize: 13,
    color: 'var(--text-secondary)',
    marginBottom: 8,
  },
  planFeatures: {
    listStyle: 'none',
    padding: 0,
    margin: 0,
    display: 'flex',
    flexWrap: 'wrap',
    gap: '4px 14px',
  },
  planFeature: {
    fontSize: 11,
    color: 'var(--text-secondary)',
    display: 'flex',
    alignItems: 'center',
    gap: 4,
  },
  trialNote: {
    fontSize: 12,
    color: 'var(--accent, #92405e)',
    textAlign: 'center',
    margin: '0 0 16px',
    fontWeight: 500,
  },
  // Push notification card (step 6)
  pushCard: {
    background: 'var(--bg-card, #FFFCF9)',
    border: '1.5px solid var(--border)',
    borderRadius: 16,
    padding: '16px 18px',
    marginBottom: 16,
    marginTop: 4,
  },
  pushCardTop: {
    display: 'flex',
    gap: 12,
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  pushIcon: {
    fontSize: 22,
    lineHeight: 1,
    flexShrink: 0,
    marginTop: 2,
  },
  pushTitle: {
    fontSize: 14,
    fontWeight: 700,
    color: 'var(--text-primary)',
    marginBottom: 3,
  },
  pushDesc: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    lineHeight: 1.5,
  },
  pushGrantedRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    justifyContent: 'center',
  },
  // Messaging card (step 6). WhatsApp-first with inline Connect button. SMS sits below as reassurance.
  messagingCard: {
    background: 'linear-gradient(180deg, rgba(37, 211, 102, 0.06) 0%, var(--bg-card, #FFFCF9) 60%)',
    border: '1.5px solid rgba(37, 211, 102, 0.25)',
    borderRadius: 16,
    padding: '16px 18px',
    marginBottom: 16,
    marginTop: 4,
  },
  channelRow: {
    display: 'flex',
    gap: 12,
    alignItems: 'flex-start',
  },
  channelCheck: {
    fontSize: 16,
    lineHeight: 1,
    color: 'var(--success, #386F52)',
    flexShrink: 0,
    marginTop: 2,
    fontWeight: 700,
  },
  channelCopy: {
    flex: 1,
    minWidth: 0,
  },
  channelTitle: {
    fontSize: 14,
    fontWeight: 700,
    color: 'var(--text-primary)',
    marginBottom: 3,
  },
  channelDesc: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    lineHeight: 1.5,
  },
  channelBadgeOn: {
    fontSize: 10,
    fontWeight: 700,
    color: 'var(--success, #386F52)',
    background: 'rgba(91, 169, 123, 0.12)',
    padding: '3px 8px',
    borderRadius: 'var(--radius-xs)',
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    alignSelf: 'flex-start',
    flexShrink: 0,
  },
  channelDivider: {
    height: 1,
    background: 'var(--border-light, rgba(0,0,0,0.06))',
    margin: '14px 0',
  },
  // WhatsApp connect row (step 6)
  waIcon: {
    fontSize: 18,
    lineHeight: 1,
    flexShrink: 0,
    marginTop: 1,
  },
  waTitleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    flexWrap: 'wrap',
    marginBottom: 3,
  },
  waRecommend: {
    fontSize: 10,
    fontWeight: 700,
    color: '#065F46',
    background: 'rgba(37, 211, 102, 0.18)',
    padding: '2px 8px',
    borderRadius: 999,
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
  },
  waMeta: {
    fontSize: 11,
    color: 'var(--text-muted)',
    marginTop: 6,
  },
  waButtonRow: {
    display: 'flex',
    gap: 8,
    marginTop: 12,
  },
  waPrimaryBtn: {
    flex: 1,
    padding: '11px 14px',
    borderRadius: 10,
    border: 'none',
    background: '#25D366',
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
    letterSpacing: '0.01em',
  },
  waSkipBtn: {
    padding: '11px 14px',
    borderRadius: 10,
    border: '1px solid var(--border)',
    background: 'transparent',
    color: 'var(--text-primary)',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  // SMS fork (step 6) - collapsed pill
  smsForkToggle: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    width: '100%',
    padding: '12px 14px',
    borderRadius: 10,
    border: '1px solid var(--border)',
    background: 'var(--bg, #FBF6F1)',
    color: 'var(--text-primary)',
    cursor: 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left',
  },
  smsForkToggleIcon: {
    fontSize: 16,
    lineHeight: 1,
    color: 'var(--text-secondary)',
    flexShrink: 0,
  },
  smsForkToggleText: {
    flex: 1,
    minWidth: 0,
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  smsForkToggleTitle: {
    fontSize: 13,
    fontWeight: 700,
    color: 'var(--text-primary)',
    lineHeight: 1.3,
  },
  smsForkToggleHint: {
    fontSize: 11,
    color: 'var(--text-muted)',
    lineHeight: 1.4,
  },
  smsForkToggleArrow: {
    fontSize: 14,
    color: 'var(--text-muted)',
    flexShrink: 0,
  },
  // SMS fork (step 6) - expanded panel
  smsForkPanel: {
    background: 'var(--bg-card, #FFFCF9)',
    border: '1px solid var(--border)',
    borderRadius: 10,
    padding: '14px 14px 16px',
  },
  smsForkHeadRow: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 8,
    marginBottom: 12,
  },
  smsForkHead: {
    flex: 1,
    minWidth: 0,
  },
  smsForkTitle: {
    fontSize: 14,
    fontWeight: 700,
    color: 'var(--text-primary)',
    marginBottom: 2,
  },
  smsForkSub: {
    fontSize: 12,
    color: 'var(--text-secondary)',
    lineHeight: 1.45,
  },
  smsFieldBlock: {
    marginBottom: 12,
  },
  smsFieldLabel: {
    display: 'block',
    fontSize: 11,
    fontWeight: 700,
    color: 'var(--text-secondary)',
    letterSpacing: '0.04em',
    textTransform: 'uppercase',
    marginBottom: 6,
  },
  smsFieldInput: {
    flex: 1,
    width: '100%',
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid var(--border)',
    background: 'var(--bg, #FBF6F1)',
    color: 'var(--text-primary)',
    fontSize: 13,
    fontFamily: 'inherit',
    boxSizing: 'border-box',
  },
  smsFieldHint: {
    fontSize: 11,
    color: 'var(--text-muted)',
    marginTop: 6,
    lineHeight: 1.45,
  },
  smsTestRow: {
    display: 'flex',
    gap: 8,
    alignItems: 'stretch',
  },
  smsTestBtn: {
    padding: '10px 12px',
    borderRadius: 10,
    border: '1px solid var(--border)',
    background: 'var(--bg, #FBF6F1)',
    color: 'var(--text-primary)',
    fontSize: 12,
    fontWeight: 700,
    cursor: 'pointer',
    fontFamily: 'inherit',
    whiteSpace: 'nowrap',
    flexShrink: 0,
  },
  smsTestNote: {
    fontSize: 11,
    color: 'var(--text-secondary)',
    marginTop: 6,
    lineHeight: 1.45,
  },
  smsForkError: {
    fontSize: 12,
    color: 'var(--danger-text, #9E2B32)',
    background: 'var(--danger-bg, rgba(180, 60, 60, 0.08))',
    border: '1px solid var(--danger-border, rgba(180, 60, 60, 0.25))',
    borderRadius: 10,
    padding: '8px 10px',
    marginBottom: 10,
  },
  smsForkActions: {
    display: 'flex',
    gap: 8,
    marginTop: 4,
  },
  smsForkFootnote: {
    fontSize: 11,
    color: 'var(--text-muted)',
    marginTop: 10,
    textAlign: 'center',
    lineHeight: 1.4,
  },
};
