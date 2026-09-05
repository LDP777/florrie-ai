import { useState, useEffect, useRef } from 'react';
import { useBeautician, supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';
import { todayLocal } from '../lib/dates.js';
import Icon, { iconName } from '../components/ui/Icon';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Button from '../components/ui/Button.jsx';
import CareNav from '../components/CareNav.jsx';
import ClientLookup from '../components/ClientLookup.jsx';
import PageHeader from '../components/ui/PageHeader.jsx';
/**
 * Patch Test Tracker - the salon's own record, and the page that asks her.
 *
 * WHY THIS PAGE WAS REWRITTEN. On 26 August a client, Sophie, moved her
 * appointment on the manage page and was told she needed a patch test. She
 * booked one. Ellie had to message her, cancel it by hand, and explain: "she's
 * been to me before". Ellie patch tests people in the chair and always has,
 * and this app had no way for her to write that down.
 *
 * It looked as though it did. That is the worse part. "Record a test" wrote
 * client_name and notes, two columns patch_tests has never had, with
 * client_id NULL against a NOT NULL constraint. PostgREST rejects the whole
 * statement for one unknown column and reports it by RESOLVING with
 * { data: null, error }; insertRow throws, and the throw went into an empty
 * `catch {}`. The row was then pushed into local state, so it appeared in the
 * list, and vanished on refresh. No patch test has ever been logged by hand.
 *
 * The Alerts tab was wrong in a different way: it decided which treatments
 * need a test by looking for 'tint' and 'lamination' in the NAME, ignoring
 * treatments.requires_patch_test which exists for exactly that, and then
 * matched clients to their tests on patch_tests.client_name, the column that
 * does not exist. So it alerted on the wrong bookings and never found a test.
 *
 * WHAT IS AND IS NOT CLAIMED HERE. Nothing on this page says a client passed,
 * is cleared, or is patch tested. The data does not know: not one of the 22
 * rows in production has ever carried a result. What it says is what somebody
 * actually did - the salon recorded one on a date, a slot is booked, a client
 * came in - and what that means against Ellie's own expiry setting, which is
 * arithmetic on her own rule rather than a verdict on anybody's skin.
 *
 * Tabs:
 *   Alerts    - upcoming bookings needing a test, with what the record says
 *   All records - every patch test on file
 *   Settings  - expiry period, auto-remind, block-booking
 */

/* The age of a record against her own window. Deliberately not "Valid" and
 * "Expired": nothing here knows whether a client passed, so a word that sounds
 * like a verdict on the client is the wrong word. These describe the DATE. */
const PATCH_STATUS = {
  current: { label: 'On record', color: 'var(--success)', bg: 'var(--success-bg)', icon: 'check-circle' },
  ageing: { label: 'Due again soon', color: 'var(--warning)', bg: 'var(--warning-bg)', icon: 'alert-triangle' },
  old: { label: 'Older than your window', color: 'var(--danger)', bg: 'var(--danger-bg)', icon: 'x' },
  none: { label: 'Nothing on record', color: 'var(--text-muted)', bg: 'var(--bg-subtle)', icon: 'info' },
};

/* Why the ask is being made, in the backend's words. Never a claim about the
 * client: "nothing written down" is a fact about our records, not about her. */
const ALERT_REASON = {
  // 'never_been_in' used to fire on Florrie-era completed appointments alone,
  // which is why 673 clients imported from Timely with a real visit count read
  // as brand new. One of them asked at 01:18 on 27 August 2026 whether she
  // needed to book a patch test. It now means what it says.
  never_been_in: 'New to you - no visits on record at all',
  been_in_but_nothing_on_record: 'Been to you before, but no patch test written down',
  booked_not_attended: 'Patch test booked, not marked as done',
  reaction_on_record: 'A reaction is noted on her last patch test',
  could_not_check: 'Could not check just now - worth a look yourself',
};

function getStatus(testDate, expiryMonths) {
  if (!testDate) return 'none';
  const test = new Date(`${String(testDate).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(test.getTime())) return 'none';
  const expiry = new Date(test);
  expiry.setUTCMonth(expiry.getUTCMonth() + expiryMonths);
  const daysLeft = Math.round((expiry - new Date()) / 86400000);
  if (daysLeft < 0) return 'old';
  if (daysLeft < 14) return 'ageing';
  return 'current';
}

function daysUntilExpiry(testDate, expiryMonths) {
  if (!testDate) return null;
  const expiry = new Date(`${String(testDate).slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(expiry.getTime())) return null;
  expiry.setUTCMonth(expiry.getUTCMonth() + expiryMonths);
  return Math.round((expiry - new Date()) / 86400000);
}

/* What one row actually attests to. Not a result unless a person wrote one:
 * `result` defaults to 'pending' on every insert, so treating 'pending' as an
 * outcome would put "Pending" against every test Ellie has ever done. */
function attests(t) {
  if (t.result === 'pass') return 'No reaction recorded';
  if (t.result === 'fail' || t.result === 'reaction') return 'Reaction recorded';
  if (t.status === 'recorded_by_owner') return 'You recorded this one';
  if (t.confirmed_at && t.appointment_id) return 'Slot booked';
  return 'No slot booked yet';
}

const clientLabel = (t) => (
  `${t.clients?.first_name || ''} ${t.clients?.last_name || ''}`.trim() || 'Client'
);

export default function PatchTests() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const filterClientId = params.get('clientId') || '';
  const { beautician, loading: bLoading } = useBeautician();
  const [tests, setTests] = useState([]);
  const [upcomingAlerts, setUpcomingAlerts] = useState([]);
  const [tab, setTab] = useState(filterClientId ? 'all' : 'alerts');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showAdd, setShowAdd] = useState(params.get('log') === '1');
  const [reminded, setReminded] = useState({});

  const [reminderError, setReminderError] = useState('');
  const [reminding, setReminding] = useState({});
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  /* result starts EMPTY, not 'pass'. A form that defaults to pass records a
   * pass the salon never gave it, for every test she logs without thinking
   * about the dropdown. Absent is the honest default and the honest value. */
  const [form, setForm] = useState({
    client_id: filterClientId, test_date: todayLocal(),
    result: '', notes: '', treatment_id: '',
  });

  // Settings - seeded from beautician profile, saved back on change
  const [settings, setSettings] = useState({
    expiry_months: 6,
    auto_remind: true,
    remind_days_before: 7,
    block_booking_without_test: false,
    duration_minutes: 10,
    price_pounds: 0,
  });
  const [settingsSaved, setSettingsSaved] = useState(false);
  const [settingsSaving, setSettingsSaving] = useState(false);
  const [settingsError, setSettingsError] = useState('');
  const savedSettings = useRef(settings);
  const savingSettingsRef = useRef(false);

  // Seed settings from beautician profile once loaded
  useEffect(() => {
    if (!beautician) return;
    const s = savedSettings.current;
    const seeded = {
      ...s,
      expiry_months: beautician.patch_test_expiry_months ?? s.expiry_months,
      auto_remind: beautician.patch_test_auto_remind ?? s.auto_remind,
      remind_days_before: beautician.patch_test_remind_days_before ?? s.remind_days_before,
      block_booking_without_test: beautician.patch_test_block_booking ?? s.block_booking_without_test,
      duration_minutes: beautician.patch_test_duration_minutes ?? s.duration_minutes,
      price_pounds: beautician.patch_test_price_cents != null ? beautician.patch_test_price_cents / 100 : s.price_pounds,
    };
    savedSettings.current = seeded;
    setSettings(seeded);
  }, [beautician]);

  const SETTING_KEYS = { patch_test_expiry_months: 'expiry_months', patch_test_auto_remind: 'auto_remind', patch_test_remind_days_before: 'remind_days_before', patch_test_block_booking: 'block_booking_without_test', patch_test_duration_minutes: 'duration_minutes', patch_test_price_cents: 'price_pounds' };
  async function saveReminderSettings(patch) {
    if (!beautician || savingSettingsRef.current) return;
    savingSettingsRef.current = true;
    setSettingsSaving(true); setSettingsSaved(false); setSettingsError('');
    try {
      const { error } = await supabase.from('beauticians').update(patch).eq('id', beautician.id);
      if (error) throw error;
      const updated = Object.fromEntries(Object.entries(patch).map(([key, value]) => [SETTING_KEYS[key], key === 'patch_test_price_cents' ? value / 100 : value]));
      savedSettings.current = { ...savedSettings.current, ...updated };
      setSettings(savedSettings.current);
      setSettingsSaved(true);
    } catch (err) {
      setSettings(savedSettings.current);
      setSettingsError('The setting was not saved. Your previous setting is still in place. Try again.');
      logger.error({ err }, 'Failed to save patch-test settings');
    } finally { savingSettingsRef.current = false; setSettingsSaving(false); }
  }
  const saveExpiryMonths = months => saveReminderSettings({ patch_test_expiry_months: months });

  useEffect(() => { loadData(); }, [beautician, bLoading]);

  async function loadData() {
    setLoading(true);
    setError(null);
    if (bLoading) return;
    if (!beautician) {
      setError('Your salon profile could not be loaded. Please sign in again.');
      setLoading(false);
      return;
    }
    try {
      /* THE ALERTS COME FROM THE BACKEND NOW, and so does the rule behind
       * them. It is the same evidence rule the client's manage page uses
       * (backend/src/lib/patch-test-status.js), which is the point: a second
       * copy of "does she owe a patch test" living in a React component is
       * how the client and the owner end up being told opposite things. It
       * also knows what this page could not - a completed appointment for a
       * treatment that required a test is itself the evidence - and it reads
       * requires_patch_test rather than hunting for 'tint' in a name.
       *
       * The rows come back with the client joined on, because patch_tests has
       * a client_id and has never had a client_name. */
      const session = await supabase.auth.getSession();
      const jwt = session.data.session?.access_token;

      const [{ data: rows, error: rowsErr }, alertRes] = await Promise.all([
        supabase
          .from('patch_tests')
          .select('id, client_id, test_date, result, status, confirmed_at, appointment_id, product_used, reaction_notes, clients(id, first_name, last_name), treatments(name)')
          .eq('beautician_id', beautician.id)
          .order('test_date', { ascending: false }),
        fetch(`${API_BASE}/api/appointments/patch-test-alerts?days=21`, {
          headers: { Authorization: `Bearer ${jwt}` },
        }),
      ]);

      // A silent empty list on the page that exists to catch this is the one
      // outcome worth shouting about, so a failed read is an error here, not
      // a quiet nothing.
      if (rowsErr) throw rowsErr;
      if (!alertRes.ok) throw new Error('alerts');
      const alertBody = await alertRes.json();

      if (!Array.isArray(rows) || !Array.isArray(alertBody.alerts)) throw new Error('Could not read the patch-test records.');
      setTests(rows);
      setUpcomingAlerts(alertBody.alerts);
      // The backend read her window off her own profile. Keep the page's copy
      // in step with it rather than letting two answers drift apart.
      if (alertBody.expiryMonths) {
        savedSettings.current = { ...savedSettings.current, expiry_months: alertBody.expiryMonths };
        setSettings(prev => ({ ...prev, expiry_months: alertBody.expiryMonths }));
      }

    } catch (err) {
      logger.error({ err }, 'Failed to load patch tests');
      setError('Could not load patch-test records and upcoming checks. Please try again.');
    }
    setLoading(false);
  }

  /**
   * Record a patch test Ellie did herself, on a date she picks, with no slot.
   *
   * This is the thing the app has never been able to do, and the reason a
   * client who had been tested in the chair was asked for another one forever.
   *
   * It goes through the backend rather than straight at the table, so the
   * write path is one honest place: it stamps status 'recorded_by_owner',
   * leaves result at the column default unless a person actually states an
   * outcome, and leaves expires_at alone because validity is a calculation
   * from the date and her own setting, not a column to freeze a second answer
   * into. See backend/src/routes/appointments.js.
   *
   * And it no longer pretends. The old version put the row into local state
   * whether or not the insert worked - it never worked - so the list showed a
   * test that did not exist until the next refresh.
   */
  async function handleSave() {
    if (!form.client_id || !form.test_date) return;
    setSaving(true);
    setSaveError(null);
    try {
      const session = await supabase.auth.getSession();
      const jwt = session.data.session?.access_token;
      const res = await fetch(`${API_BASE}/api/appointments/patch-test-records`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({
          client_id: form.client_id,
          test_date: form.test_date,
          treatment_id: form.treatment_id || undefined,
          // Only sent when she actually chose one. Empty means nobody stated
          // an outcome, and nothing is written for it.
          result: form.result || undefined,
          notes: form.notes.trim() || undefined,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Could not save that just then.');

      setForm({ client_id: filterClientId, test_date: todayLocal(), result: '', notes: '', treatment_id: '' });
      setShowAdd(false);
      // Reload rather than guess: the alert this clears is computed server
      // side, and a list that disagrees with it is worse than a short wait.
      await loadData();
    } catch (err) {
      logger.error({ err }, 'Failed to record the patch test');
      setSaveError(err.message || 'Could not save that just then. Please try again.');
    }
    setSaving(false);
  }

  /**
   * Ask the client to book one. Keyed on client_id now, because two clients
   * called Sophie are two people and the reminded map was keyed on a name.
   *
   * The message says she needs one, so it is only ever sent by Ellie tapping
   * it, about a client Ellie has decided does need one. That is the whole
   * difference between this and the sentence the manage page used to put in
   * front of everybody.
   */
  async function handleRemind(clientId, clientName) {
    if (!clientId || reminding[clientId] || reminded[clientId]) return;
    setReminding(prev => ({ ...prev, [clientId]: true }));
    setReminderError('');
    try {
      const session = await supabase.auth.getSession();
      const token = session.data.session?.access_token;
      if (!token) throw new Error('Please sign in again.');
      const res = await fetch(`${API_BASE}/api/notifications/send-reminder`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ type: 'patch_test_reminder', client_id: clientId, message: `Hi ${clientName}, just a quick reminder - you need a patch test before your next treatment. Pop in or reply to book one in!` }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || data.success !== true) throw new Error(data.error || 'The reminder was not accepted. Please try again.');
      setReminded(prev => ({ ...prev, [clientId]: true }));
    } catch (err) {
      logger.error({ err }, 'Failed to send patch test reminder');
      setReminderError(`${clientName}: ${err.message}`);
    } finally { setReminding(prev => ({ ...prev, [clientId]: false })); }
  }

  // Compute statuses
  const testsWithStatus = tests.filter(t => !filterClientId || (t.client_id || t.clients?.id) === filterClientId).map(t => ({
    ...t,
    ageStatus: getStatus(t.test_date, settings.expiry_months),
    daysLeft: daysUntilExpiry(t.test_date, settings.expiry_months),
  }));

  const currentCount = testsWithStatus.filter(t => t.ageStatus === 'current').length;
  const ageingCount = testsWithStatus.filter(t => t.ageStatus === 'ageing').length;
  const oldCount = testsWithStatus.filter(t => t.ageStatus === 'old').length;
  const visibleAlerts = upcomingAlerts.filter(a => !filterClientId || a.client_id === filterClientId);
  const alertCount = visibleAlerts.length;

  if (bLoading || loading) {
    return <PageLoader />;
  }

  if (error) {
    return <div style={styles.page}><CareNav /><PageHeader title="Patch tests" /><ErrorCard message={error} /><Button onClick={loadData}>Try again</Button></div>;
  }

  return (
    <div style={styles.page}>
      <CareNav />
      <PageHeader title="Patch tests" subtitle="Your records and the visits that need a closer look" />
      {filterClientId && <div style={{ ...styles.formCard, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', justifyContent: 'space-between' }}><span style={{ fontSize: 13 }}>Showing one client’s checks and records</span><Button variant="secondary" onClick={() => navigate('/clients', { state: { clientId: filterClientId } })}>Client profile</Button><Button variant="quiet" onClick={() => { setParams({}); setTab('all'); }}>Show all clients</Button></div>}
      {reminderError && <div role="alert"><ErrorCard message={reminderError} /></div>}
      {settingsError && <div role="alert"><ErrorCard message={settingsError} /></div>}

      {/* Status summary */}
      <div style={styles.summaryRow}>
        <div style={{ ...styles.summaryChip, background: 'var(--success-bg)' }}>
          <span style={{ color: 'var(--success)', fontWeight: 700 }}>{currentCount}</span>
          <span style={{ fontSize: 10, color: 'var(--success)' }}>On record</span>
        </div>
        <div style={{ ...styles.summaryChip, background: 'var(--warning-bg)' }}>
          <span style={{ color: 'var(--warning)', fontWeight: 700 }}>{ageingCount}</span>
          <span style={{ fontSize: 10, color: 'var(--warning)' }}>Due again</span>
        </div>
        <div style={{ ...styles.summaryChip, background: 'var(--danger-bg)' }}>
          <span style={{ color: 'var(--danger)', fontWeight: 700 }}>{oldCount}</span>
          <span style={{ fontSize: 10, color: 'var(--danger)' }}>Out of window</span>
        </div>
        {alertCount > 0 && (
          <div style={{ ...styles.summaryChip, background: 'var(--accent-light)' }}>
            <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{alertCount}</span>
            <span style={{ fontSize: 10, color: 'var(--accent)' }}>To check</span>
          </div>
        )}
      </div>

      {/* Said once, at the top, so none of the numbers above can be read as a
          verdict on anybody. Nothing in this app records a pass or a fail
          unless a person types one, and these are dates against her window. */}
      <p style={{ fontSize: 11, lineHeight: 1.5, color: 'var(--text-muted)', margin: '0 0 12px' }}>
        These are dates measured against your {settings.expiry_months} month window.
        Florrie never decides that a client passed or failed a patch test - only you do.
      </p>

      <Button onClick={() => setShowAdd(!showAdd)} style={styles.addBtn}>+ Record a test</Button>

      {/* Add form */}
      {showAdd && (
        <div style={styles.formCard}>
          <h3 style={styles.formTitle}>Record a patch test you did</h3>
          <p style={{ fontSize: 12, lineHeight: 1.5, color: 'var(--text-muted)', margin: '0 0 14px' }}>
            For a test you did in the salon, with no slot booked for it. Pick the day it
            actually happened. This is what stops the booking page asking a client for
            another one she has already had.
          </p>
          <div style={{ ...styles.formRow, flexDirection: 'column' }}>
            <div style={{ flex: 1 }}>
              <ClientLookup value={form.client_id} onChange={client => setForm(p => ({ ...p, client_id: client.id }))} />
            </div>
            <div style={{ flex: 1 }}>
              <label style={styles.formLabel}>Date it was done</label>
              <input
                type="date" value={form.test_date} max={todayLocal()}
                onChange={e => setForm(p => ({ ...p, test_date: e.target.value }))}
                style={styles.formInput}
              />
            </div>
          </div>

          <div style={styles.formGroup}>
            <label style={styles.formLabel}>Outcome (only if you want to note one)</label>
            {/* Nothing is preselected. A dropdown that starts on "Pass" writes
                a pass for every test she logs without looking at it, and this
                app does not get to decide that about anybody's skin. The two
                values are the schema's own words, from
                CHECK (result IN ('pending','pass','fail','reaction')). */}
            <div style={styles.resultRow}>
              {[
                { value: '', label: 'Not noted', icon: 'info' },
                { value: 'pass', label: 'No reaction', icon: 'check-circle' },
                { value: 'reaction', label: 'Reaction', icon: 'x' },
              ].map(r => (
                <Button
                  key={r.value || 'none'}
                  onClick={() => setForm(p => ({ ...p, result: r.value }))}
                  style={{ ...styles.resultBtn,
                    background: form.result === r.value ? (r.value === 'pass' ? 'var(--success-bg)' : r.value === 'reaction' ? 'var(--danger-bg)' : 'var(--bg-hover)') : 'var(--bg-card)',
                    borderColor: form.result === r.value ? (r.value === 'pass' ? 'var(--success)' : r.value === 'reaction' ? 'var(--danger)' : 'var(--text-muted)') : 'var(--border)',
                  }}
                >
                  <span><Icon name={iconName(r.icon)} inline /></span>
                  <span style={{ fontSize: 11 }}>{r.label}</span>
                </Button>
              ))}
            </div>
          </div>

          <div style={styles.formGroup}>
            <label style={styles.formLabel}>Notes (optional)</label>
            <input
              type="text" placeholder="e.g. Slight redness, gone by 48h"
              value={form.notes}
              onChange={e => setForm(p => ({ ...p, notes: e.target.value }))}
              style={styles.formInput}
            />
          </div>

          {saveError && (
            <p style={{ fontSize: 12, color: 'var(--danger)', margin: '0 0 10px' }}>{saveError}</p>
          )}
          <div style={styles.formActions}>
            <Button
              onClick={handleSave}
              disabled={saving || !form.client_id || !form.test_date}
              style={{ ...styles.saveBtn, opacity: (saving || !form.client_id || !form.test_date) ? 0.5 : 1 }}
            >
              {saving ? 'Saving...' : 'Record it'}
            </Button>
            <Button onClick={() => { setShowAdd(false); setSaveError(null); }} style={styles.cancelBtn}>Cancel</Button>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div style={styles.tabs}>
        {['alerts', 'all', 'settings'].map(t => (
          <Button
            key={t}
            onClick={() => setTab(t)}
            style={{ ...styles.tab,
              borderBottomColor: tab === t ? 'var(--accent)' : 'transparent',
              color: tab === t ? 'var(--accent)' : 'var(--text-muted)',
            }}
          >
            {t === 'alerts' ? `Alerts (${alertCount})` : t === 'all' ? 'All records' : 'Settings'}
          </Button>
        ))}
      </div>

      {/* === ALERTS TAB === */}
      {tab === 'alerts' && (
        <div>
          {alertCount === 0 ? (
            <div style={styles.emptyState}>
              <span style={{ fontSize: 32, display: 'block', marginBottom: 8 }}><Icon name="check-circle" size={32} /></span>
              <p style={styles.emptyTitle}>No checks in this window</p>
              <p style={styles.emptyDesc}>
                No patch-test records need review for bookings in the next 21 days.
                You can still open a client’s profile or record a test you did.
              </p>
            </div>
          ) : (
            <div style={styles.alertList}>
              {/* THE ASK. This is the half of the fix the client never sees.
                  Sophie was told flatly that she needed a patch test and
                  booked a slot she did not need. When our records are simply
                  silent about a client who has been here before, she is not
                  the person to ask: Ellie was in the room, and Ellie can
                  settle it in one tap from this card. */}
              <p style={styles.alertIntro}>
                Review the evidence for these upcoming visits. If you did a test in the salon,
                record the date and any result you observed.
              </p>
              {visibleAlerts.map((alert) => (
                <div key={alert.client_id} style={styles.alertCard}>
                  <div style={styles.alertTop}>
                    <div style={styles.alertAvatar}>{(alert.client_name || 'C')[0]}</div>
                    <div style={styles.alertInfo}>
                      <Button variant="quiet" onClick={() => navigate('/clients', { state: { clientId: alert.client_id } })} style={{ ...styles.alertName, justifyContent: 'flex-start', padding: 0, whiteSpace: 'normal' }}>{alert.client_name}<Icon name="chevron-right" size={16} /></Button>
                      <span style={styles.alertDetail}>
                        {alert.treatment ? `${alert.treatment} - ` : ''}
                        {alert.appointment_date
                          ? new Date(`${alert.appointment_date}T12:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' })
                          : 'Date TBC'}
                        {alert.bookings > 1 ? ` (+${alert.bookings - 1} more)` : ''}
                      </span>
                    </div>
                  </div>
                  <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '6px 0 10px', lineHeight: 1.5 }}>
                    {ALERT_REASON[alert.reason] || 'No patch test on record'}
                    {/* What her old system knew, so "been to you before" is a
                        fact you can check rather than something to take on
                        trust. Nothing here claims she has had a patch test. */}
                    {alert.prior_visits > 0 && (
                      <>
                        <br />
                        {alert.prior_visits} visit{alert.prior_visits === 1 ? '' : 's'} on her imported history
                        {alert.prior_last_visit
                          ? `, last one ${new Date(`${alert.prior_last_visit}T12:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}`
                          : ', no date recorded'}
                      </>
                    )}
                  </p>
                  {reminded[alert.client_id] ? (
                    <span style={styles.sentLabel}>Reminder accepted ✓</span>
                  ) : (
                    <div style={styles.alertActions}>
                      <Button disabled={reminding[alert.client_id]} onClick={() => handleRemind(alert.client_id, alert.client_name)} style={styles.remindBtn}>
                        {reminding[alert.client_id] ? 'Sending…' : 'Ask her to book one'}
                      </Button>
                      <Button
                        onClick={() => {
                          setForm(p => ({ ...p, client_id: alert.client_id }));
                          setSaveError(null);
                          setShowAdd(true);
                          document.getElementById('app-scroll')?.scrollTo({ top: 0, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' });
                        }}
                        style={styles.logBtn}
                      >
                        I did one
                      </Button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}

          {/* Coming up to her window again */}
          {testsWithStatus.filter(t => t.ageStatus === 'ageing').length > 0 && (
            <div style={{ marginTop: 20 }}>
              <h3 style={styles.sectionTitle}>Due again soon</h3>
              {testsWithStatus.filter(t => t.ageStatus === 'ageing').map(t => (
                <div key={t.id} style={styles.testRow}>
                  <div style={styles.testAvatar}>{clientLabel(t)[0]}</div>
                  <div style={styles.testInfo}>
                    <span style={styles.testName}>{clientLabel(t)}</span>
                    <span style={styles.testMeta}>{t.daysLeft} days left of your {settings.expiry_months} month window</span>
                  </div>
                  <Button disabled={reminding[t.clients?.id] || reminded[t.clients?.id]} onClick={() => handleRemind(t.clients?.id, clientLabel(t))} style={styles.smallRemindBtn}>
                    {reminding[t.clients?.id] ? 'Sending…' : reminded[t.clients?.id] ? 'Accepted ✓' : 'Remind'}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* === ALL TESTS TAB === */}
      {tab === 'all' && (
        <div>
          {testsWithStatus.length === 0 ? (
            <EmptyState title="No patch tests on file" subtitle='Tap "+ Record a test" to record one you did.' />
          ) : (
            <div style={styles.testList}>
              {testsWithStatus.map(t => {
                const status = PATCH_STATUS[t.ageStatus];
                return (
                  <div key={t.id} style={styles.testCard}>
                    <div style={styles.testCardTop}>
                      <div style={{ ...styles.testStatusIcon, background: status.bg }}>
                        <span><Icon name={iconName(status.icon)} inline /></span>
                      </div>
                      <div style={styles.testCardInfo}>
                        {/* clientLabel, not t.client_name. That column does
                            not exist, so every card was blank and the avatar
                            beside it threw on undefined[0]. */}
                        <Button variant="quiet" onClick={() => navigate('/clients', { state: { clientId: t.client_id || t.clients?.id } })} style={{ ...styles.testCardName, justifyContent: 'flex-start', padding: 0, whiteSpace: 'normal' }}>{clientLabel(t)}<Icon name="chevron-right" size={16} /></Button>
                        <span style={styles.testCardDate}>
                          {t.test_date
                            ? `Done ${new Date(`${String(t.test_date).slice(0, 10)}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })}`
                            : 'No date on this one'}
                        </span>
                      </div>
                      <div style={{ ...styles.statusBadge, background: status.bg, color: status.color }}>
                        {status.label}
                      </div>
                    </div>
                    <div style={styles.testCardBody}>
                      {/* What the row attests to. It used to print "Pending"
                          for anything that was not 'pass' or 'fail', which is
                          every row in production, so a page about compliance
                          told her that every test she had ever done was
                          unfinished. */}
                      <span style={styles.testResult}>{attests(t)}</span>
                      {t.daysLeft !== null && t.ageStatus === 'current' && (
                        <span style={styles.testExpiry}>{t.daysLeft} days left of your window</span>
                      )}
                    </div>
                    {t.reaction_notes && <p style={styles.testNotes}>{t.reaction_notes}</p>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* === SETTINGS TAB === */}
      {tab === 'settings' && (
        <div>
          <div style={styles.settingsCard}>
            <h3 style={styles.settingsSectionTitle}>Expiry</h3>
            <div style={styles.settingsRow}>
              <div>
                <span style={styles.settingsLabel}>Record window</span>
                <span style={styles.settingsHint}>How recent the recorded evidence needs to be for booking checks</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                {settingsSaved && <span style={{ fontSize: 11, color: 'var(--success)', fontWeight: 600 }}>Saved ✓</span>}
                <select
                  disabled={settingsSaving}
                value={settings.expiry_months}
                  onChange={e => {
                    const months = parseInt(e.target.value);
                    setSettings(p => ({ ...p, expiry_months: months }));
                    saveExpiryMonths(months);
                  }}
                  style={styles.settingsSelect}
                >
                  <option value={3}>3 months</option>
                  <option value={6}>6 months</option>
                  <option value={12}>12 months</option>
                </select>
              </div>
            </div>
          </div>

          <div style={styles.settingsCard}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <h3 style={{ ...styles.settingsSectionTitle, margin: 0 }}>Reminders</h3>
              {settingsSaved && <span style={{ fontSize: 11, color: 'var(--success)', fontWeight: 600 }}>Saved ✓</span>}
            </div>
            <div style={styles.settingsRow}>
              <div>
                <span style={styles.settingsLabel}>Auto-remind clients</span>
                <span style={styles.settingsHint}>Florrie messages clients when their patch test is about to expire</span>
              </div>
              <Button variant="quiet" role="switch" disabled={settingsSaving}
                onClick={() => {
                  const next = !settings.auto_remind;
                  setSettings(p => ({ ...p, auto_remind: next }));
                  saveReminderSettings({ patch_test_auto_remind: next });
                }}
                aria-label="Auto-remind clients" aria-checked={settings.auto_remind}
                style={{ ...styles.toggle, background: settings.auto_remind ? 'var(--accent)' : 'var(--border)', cursor: 'pointer' }}
              >
                <div style={{ ...styles.toggleDot, transform: settings.auto_remind ? 'translateX(20px)' : 'translateX(2px)' }} />
              </Button>
            </div>
            <div style={{ ...styles.settingsRow, borderBottom: 'none' }}>
              <div>
                <span style={styles.settingsLabel}>Remind how many days before?</span>
              </div>
              <select
                disabled={settingsSaving}
                value={settings.remind_days_before}
                onChange={e => {
                  const days = parseInt(e.target.value);
                  setSettings(p => ({ ...p, remind_days_before: days }));
                  saveReminderSettings({ patch_test_remind_days_before: days });
                }}
                style={styles.settingsSelect}
              >
                <option value={3}>3 days</option>
                <option value={7}>7 days</option>
                <option value={14}>14 days</option>
              </select>
            </div>
          </div>

          <div style={styles.settingsCard}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <h3 style={{ ...styles.settingsSectionTitle, margin: 0 }}>Booking protection</h3>
            </div>
            <div style={{ ...styles.settingsRow, borderBottom: 'none' }}>
              <div>
                <span style={styles.settingsLabel}>Require a patch-test review</span>
                <span style={styles.settingsHint}>Apply your patch-test requirement when clients manage a booking that needs one</span>
              </div>
              <Button variant="quiet" role="switch" disabled={settingsSaving}
                onClick={() => {
                  const next = !settings.block_booking_without_test;
                  setSettings(p => ({ ...p, block_booking_without_test: next }));
                  saveReminderSettings({ patch_test_block_booking: next });
                }}
                aria-label="Require a patch-test review" aria-checked={settings.block_booking_without_test}
                style={{ ...styles.toggle, background: settings.block_booking_without_test ? 'var(--accent)' : 'var(--border)', cursor: 'pointer' }}
              >
                <div style={{ ...styles.toggleDot, transform: settings.block_booking_without_test ? 'translateX(20px)' : 'translateX(2px)' }} />
              </Button>
            </div>
          </div>

          <div style={styles.settingsCard}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <h3 style={{ ...styles.settingsSectionTitle, margin: 0 }}>The patch test appointment</h3>
              {settingsSaved && <span style={{ fontSize: 11, color: 'var(--success)', fontWeight: 600 }}>Saved ✓</span>}
            </div>
            <div style={styles.settingsRow}>
              <div>
                <span style={styles.settingsLabel}>How long is a patch test?</span>
                <span style={styles.settingsHint}>The length of the slot Florrie books for the client</span>
              </div>
              <select
                disabled={settingsSaving}
                value={settings.duration_minutes}
                onChange={e => {
                  const mins = parseInt(e.target.value);
                  setSettings(p => ({ ...p, duration_minutes: mins }));
                  saveReminderSettings({ patch_test_duration_minutes: mins });
                }}
                style={styles.settingsSelect}
              >
                <option value={5}>5 min</option>
                <option value={10}>10 min</option>
                <option value={15}>15 min</option>
                <option value={20}>20 min</option>
                <option value={30}>30 min</option>
              </select>
            </div>
            <div style={{ ...styles.settingsRow, borderBottom: 'none' }}>
              <div>
                <span style={styles.settingsLabel}>Patch test price</span>
                <span style={styles.settingsHint}>Leave at 0 for free. Recorded on the appointment, not charged automatically.</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
                <span style={{ fontSize: 14, color: 'var(--text-secondary)' }}>£</span>
                <input
                  type="number" min="0" step="0.50"
                  disabled={settingsSaving}
                value={settings.price_pounds}
                  onChange={e => setSettings(p => ({ ...p, price_pounds: e.target.value }))}
                  onBlur={e => {
                    const pounds = Math.max(0, parseFloat(e.target.value) || 0);
                    setSettings(p => ({ ...p, price_pounds: pounds }));
                    saveReminderSettings({ patch_test_price_cents: Math.round(pounds * 100) });
                  }}
                  style={{ ...styles.settingsSelect, width: 80, textAlign: 'right' }}
                />
              </div>
            </div>
          </div>

          <div style={styles.settingsCard}>
            <h3 style={styles.settingsSectionTitle}>Treatments requiring patch test</h3>
            <p style={styles.treatmentNote}>Toggle "Patch test required" on individual treatments in your <strong>Treatments</strong> page. That flag is what drives the compliance check on the client booking portal.</p>
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  page: {
    minHeight: 'var(--shell-viewport)', background: 'var(--bg)',
    fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif",
    padding: '20px 20px var(--scroll-pad-bottom)', maxWidth: 820, margin: '0 auto', color: 'var(--text-primary)',
  },

  summaryRow: { display: 'flex', gap: 8, marginBottom: 12 },
  summaryChip: {
    flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
    padding: '10px 0', borderRadius: 10, gap: 2,
  },

  addBtn: {
    width: '100%', padding: '12px 0', borderRadius: 10, border: 'none',
    background: 'var(--accent)', color: '#fff', fontSize: 14, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit', marginBottom: 16,
  },

  tabs: { display: 'flex', gap: 16, borderBottom: '1px solid var(--border-light)', marginBottom: 16 },
  tab: {
    padding: '10px 0', background: 'none', border: 'none',
    borderBottom: '2px solid transparent', fontSize: 14, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },

  // Form
  formCard: { background: 'var(--bg-card)', borderRadius: 16, padding: 16, boxShadow: 'var(--shadow-xs)', marginBottom: 16 },
  formTitle: { fontSize: 16, fontWeight: 600, margin: '0 0 14px', color: 'var(--text-primary)' },
  formGroup: { marginBottom: 14 },
  formLabel: { display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 6, fontWeight: 500 },
  formInput: { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1.5px solid var(--border)', fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' },
  formRow: { display: 'flex', gap: 10, marginBottom: 14 },
  resultRow: { display: 'flex', gap: 6 },
  resultBtn: {
    flex: 1, padding: '8px 4px', borderRadius: 10, border: '1.5px solid var(--border)',
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  formActions: { display: 'flex', gap: 8 },
  saveBtn: { flex: 1, padding: '10px 0', borderRadius: 10, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  cancelBtn: { padding: '10px 16px', borderRadius: 10, border: 'none', background: 'var(--bg-subtle)', color: 'var(--text-secondary)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' },

  // Alerts
  alertList: { display: 'flex', flexDirection: 'column', gap: 10 },
  alertIntro: { fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 10px', lineHeight: 1.4 },
  alertCard: { background: 'var(--bg-card)', borderRadius: 16, padding: 14, boxShadow: 'var(--shadow-xs)', borderLeft: '3px solid var(--danger)' },
  alertTop: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 },
  alertAvatar: { width: 34, height: 34, borderRadius: 16, background: 'var(--accent-light)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 600, color: 'var(--accent)', flexShrink: 0 },
  alertInfo: { flex: 1, display: 'flex', flexDirection: 'column', gap: 2 },
  alertName: { fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' },
  alertDetail: { fontSize: 11, color: 'var(--text-muted)' },
  alertBadge: { padding: '3px 8px', borderRadius: 'var(--radius-xs)', fontSize: 10, fontWeight: 600, flexShrink: 0 },
  alertActions: { display: 'flex', gap: 8 },
  remindBtn: { flex: 1, padding: '8px 0', borderRadius: 10, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  logBtn: { padding: '8px 14px', borderRadius: 10, border: '1.5px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-secondary)', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  sentLabel: { fontSize: 12, color: 'var(--success)', fontWeight: 600 },

  sectionTitle: { fontSize: 14, fontWeight: 600, margin: '0 0 10px', color: 'var(--text-primary)' },

  testRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: '1px solid var(--border-light)' },
  testAvatar: { width: 30, height: 30, borderRadius: 16, background: 'var(--warning-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600, color: 'var(--warning)', flexShrink: 0 },
  testInfo: { flex: 1, display: 'flex', flexDirection: 'column', gap: 1 },
  testName: { fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' },
  testMeta: { fontSize: 11, color: 'var(--warning)' },
  smallRemindBtn: { padding: '5px 10px', borderRadius: 'var(--radius-xs)', border: 'none', background: 'var(--warning-bg)', color: 'var(--warning)', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },

  // All tests
  testList: { display: 'flex', flexDirection: 'column', gap: 10 },
  testCard: { background: 'var(--bg-card)', borderRadius: 16, padding: 14, boxShadow: 'var(--shadow-xs)' },
  testCardTop: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 },
  testStatusIcon: { width: 34, height: 34, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0 },
  testCardInfo: { flex: 1, display: 'flex', flexDirection: 'column', gap: 1 },
  testCardName: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' },
  testCardDate: { fontSize: 11, color: 'var(--text-muted)' },
  statusBadge: { padding: '3px 8px', borderRadius: 'var(--radius-xs)', fontSize: 10, fontWeight: 600, flexShrink: 0 },
  testCardBody: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  testResult: { fontSize: 12, color: 'var(--text-secondary)' },
  testExpiry: { fontSize: 11, color: 'var(--text-muted)' },
  testNotes: { fontSize: 12, color: 'var(--text-secondary)', fontStyle: 'italic', margin: '4px 0 0', lineHeight: 1.4 },

  // Settings
  settingsCard: { background: 'var(--bg-card)', borderRadius: 16, padding: 16, boxShadow: 'var(--shadow-xs)', marginBottom: 12 },
  settingsSectionTitle: { fontSize: 14, fontWeight: 600, margin: '0 0 14px', color: 'var(--text-primary)' },
  settingsRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--border-light)' },
  settingsLabel: { display: 'block', fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' },
  settingsHint: { display: 'block', fontSize: 11, color: 'var(--text-muted)', marginTop: 2 },
  settingsSelect: { padding: '6px 10px', borderRadius: 10, border: '1.5px solid var(--border)', fontSize: 12, fontFamily: 'inherit', background: 'var(--bg-card)', color: 'var(--text-secondary)' },
  toggle: { width: 44, height: 26, borderRadius: 16, border: 'none', cursor: 'pointer', position: 'relative', flexShrink: 0, transition: 'background 0.2s' },
  toggleDot: { width: 22, height: 22, borderRadius: 10, background: 'var(--bg-card, #FFFCF9)', position: 'absolute', top: 2, transition: 'transform 0.2s', boxShadow: 'var(--elev-1)' },
  treatmentNote: { fontSize: 12, color: 'var(--text-muted)', padding: '8px 0' },

  // Empty
  loadingText: { textAlign: 'center', color: 'var(--text-muted)', padding: 40, fontSize: 14 },
  emptyState: { textAlign: 'center', padding: '40px 20px' },
  emptyTitle: { fontSize: 16, fontWeight: 600, margin: '0 0 4px', color: 'var(--text-primary)' },
  emptyDesc: { fontSize: 13, color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 },
};
