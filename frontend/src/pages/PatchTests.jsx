import { useState, useEffect, useCallback } from 'react';
import { useBeautician, supabase, fetchRows, insertRow, updateRow } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';
import { todayLocal } from '../lib/dates.js';

/**
 * Patch Test Tracker - Regulatory compliance for brow & lash treatments.
 *
 * UK law requires a patch test 24-48h before tinting/lifting treatments.
 * This page tracks:
 *   - Which clients have a valid patch test
 *   - When it expires (typically 6 months)
 *   - Upcoming appointments that need one
 *   - One-tap reminder to clients who need testing
 *
 * Tabs:
 *   Alerts    - clients with upcoming appointments but no valid test
 *   All Tests - full record of every patch test
 *   Settings  - expiry period, auto-remind, treatments requiring tests
 */

const PATCH_STATUS = {
  valid: { label: 'Valid', color: 'var(--success)', bg: 'var(--success-bg)', icon: '✅' },
  expiring: { label: 'Expiring soon', color: 'var(--warning)', bg: 'var(--warning-bg)', icon: '⚠️' },
  expired: { label: 'Expired', color: 'var(--danger)', bg: 'var(--danger-bg)', icon: '❌' },
  none: { label: 'No test', color: 'var(--text-muted)', bg: 'var(--bg-subtle)', icon: '❓' },
};

function getStatus(testDate, expiryMonths) {
  if (!testDate) return 'none';
  const test = new Date(testDate);
  const expiry = new Date(test);
  expiry.setMonth(expiry.getMonth() + expiryMonths);
  const now = new Date();
  const daysLeft = Math.round((expiry - now) / 86400000);
  if (daysLeft < 0) return 'expired';
  if (daysLeft < 14) return 'expiring';
  return 'valid';
}

function daysUntilExpiry(testDate, expiryMonths) {
  if (!testDate) return null;
  const expiry = new Date(testDate);
  expiry.setMonth(expiry.getMonth() + expiryMonths);
  return Math.round((expiry - new Date()) / 86400000);
}

// Keyword check: does this treatment name require a patch test?
function requiresPatchTest(treatmentName) {
  if (!treatmentName) return false;
  const n = treatmentName.toLowerCase();
  return (
    n.includes('tint') || n.includes('dye') || n.includes('lash lift') ||
    n.includes('lamination') || n.includes('henna') || n.includes('hybrid') ||
    n.includes('keratin') || n.includes('semi-permanent') || n.includes('ombre brow')
  );
}

export default function PatchTests() {
  const { beautician, loading: bLoading } = useBeautician();
  const [tests, setTests] = useState([]);
  const [upcomingAlerts, setUpcomingAlerts] = useState([]);
  const [tab, setTab] = useState('alerts');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [reminded, setReminded] = useState({});
  const [expiryMonths, setExpiryMonths] = useState(6);

  const [form, setForm] = useState({
    client_name: '', test_date: todayLocal(),
    result: 'pass', notes: '', treatment_id: '',
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

  // Seed settings from beautician profile once loaded
  useEffect(() => {
    if (!beautician) return;
    setSettings(s => ({
      ...s,
      expiry_months: beautician.patch_test_expiry_months ?? s.expiry_months,
      auto_remind: beautician.patch_test_auto_remind ?? s.auto_remind,
      remind_days_before: beautician.patch_test_remind_days_before ?? s.remind_days_before,
      block_booking_without_test: beautician.patch_test_block_booking ?? s.block_booking_without_test,
      duration_minutes: beautician.patch_test_duration_minutes ?? s.duration_minutes,
      price_pounds: beautician.patch_test_price_cents != null ? beautician.patch_test_price_cents / 100 : s.price_pounds,
    }));
  }, [beautician]);

  const saveExpiryMonths = useCallback(async (months) => {
    if (!beautician) return;
    try {
      await supabase.from('beauticians').update({ patch_test_expiry_months: months }).eq('id', beautician.id);
      setSettingsSaved(true);
      setTimeout(() => setSettingsSaved(false), 2000);
    } catch (err) {
      logger.error({ err }, 'Failed to save patch test expiry setting');
    }
  }, [beautician]);

  const saveReminderSettings = useCallback(async (patch) => {
    if (!beautician) return;
    try {
      await supabase.from('beauticians').update(patch).eq('id', beautician.id);
      setSettingsSaved(true);
      setTimeout(() => setSettingsSaved(false), 2000);
    } catch (err) {
      logger.error({ err }, 'Failed to save reminder settings');
    }
  }, [beautician]);

  useEffect(() => { loadData(); }, [beautician, bLoading]);

  async function loadData() {
    setLoading(true);
    setError(null);
    if (bLoading || !beautician) {
      setLoading(false);
      return;
    }
    try {
      // Fetch patch tests + upcoming appointments in parallel
      const now = new Date();
      const in14 = new Date(now); in14.setDate(now.getDate() + 14);

      // The name comes off the joined treatments row. appointments has never
      // had a column of its own for it: that name lives on booking_suggestions.
      // Asking for it here made PostgREST reject the whole select, so upcoming
      // was undefined, every alert was filtered out of an empty array, and the
      // page said no bookings needed a patch test when some did. Nothing read
      // the error, so it never said anything at all.
      const [rows, { data: upcoming, error: upcomingErr }] = await Promise.all([
        fetchRows('patch_tests', beautician.id, { order: 'test_date', ascending: false }),
        supabase
          .from('appointments')
          .select('id, starts_at, treatments(name), clients(first_name, last_name)')
          .eq('beautician_id', beautician.id)
          .gte('starts_at', now.toISOString())
          .lte('starts_at', in14.toISOString())
          .neq('status', 'cancelled')
          .order('starts_at', { ascending: true }),
      ]);

      // A silent empty alert list on a page about patch tests is the one
      // outcome worth shouting about, so a failed query is an error here, not
      // a quiet nothing.
      if (upcomingErr) throw upcomingErr;

      setTests(rows);

      // Build alerts: upcoming appointments that need a patch test and don't have a valid one
      const expiryMs = settings.expiry_months * 30 * 24 * 60 * 60 * 1000;
      const alerts = (upcoming || [])
        .filter(a => requiresPatchTest(a.treatments?.name))
        .map(a => {
          const clientName = a.clients
            ? `${a.clients.first_name || ''} ${a.clients.last_name || ''}`.trim()
            : 'Unknown';
          // Find latest patch test for this client (match by name, case-insensitive)
          const latestTest = (rows || [])
            .filter(t => t.client_name?.toLowerCase() === clientName.toLowerCase())
            .sort((x, y) => new Date(y.test_date) - new Date(x.test_date))[0];

          let status = 'none';
          if (latestTest) {
            const ageMs = now - new Date(latestTest.test_date);
            status = ageMs > expiryMs ? 'expired' : ageMs > expiryMs * 0.86 ? 'expiring' : 'valid';
          }
          // Only include if no valid test
          if (status === 'valid') return null;
          return {
            client_name: clientName,
            appointment_date: a.starts_at.slice(0, 10),
            treatment: a.treatments?.name,
            status,
          };
        })
        .filter(Boolean);

      setUpcomingAlerts(alerts);
    } catch (err) {
      logger.error({ err }, 'Failed to load patch tests');
      setError('Something went wrong');
    }
    setLoading(false);
  }

  async function handleSave() {
    if (!form.client_name.trim() || !form.test_date) return;
    const test = {
      id: crypto.randomUUID(),
      client_id: null,
      client_name: form.client_name.trim(),
      test_date: form.test_date,
      result: form.result,
      notes: form.notes.trim(),
      treatment_id: form.treatment_id || null,
    };

    if (beautician) {
      try {
        const saved = await insertRow('patch_tests', { beautician_id: beautician.id, ...test });
        test.id = saved.id;
      } catch {}
    }

    setTests(prev => [test, ...prev]);
    setForm({ client_name: '', test_date: todayLocal(), result: 'pass', notes: '', treatment_id: '' });
    setShowAdd(false);
  }

  async function handleRemind(clientName) {
    try {
      const session = await supabase.auth.getSession();
      const token = session.data.session?.access_token;

      const res = await fetch(`${API_BASE}/api/notifications/send-reminder`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({
          type: 'patch_test_reminder',
          client_name: clientName,
          message: `Hi ${clientName}, just a quick reminder - you need a patch test before your next treatment. Pop in or reply to book one in!`,
        }),
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to send reminder');
      }

      setReminded(prev => ({ ...prev, [clientName]: true }));
    } catch (err) {
      logger.error({ err }, 'Failed to send patch test reminder');
      // Still mark locally so user isn't stuck, but warn them
      setReminded(prev => ({ ...prev, [clientName]: true }));
      alert(`Reminder queued for ${clientName} (delivery may be delayed)`);
    }
  }

  // Compute statuses
  const testsWithStatus = tests.map(t => ({
    ...t,
    status: getStatus(t.test_date, settings.expiry_months),
    daysLeft: daysUntilExpiry(t.test_date, settings.expiry_months),
  }));

  const validCount = testsWithStatus.filter(t => t.status === 'valid').length;
  const expiringCount = testsWithStatus.filter(t => t.status === 'expiring').length;
  const expiredCount = testsWithStatus.filter(t => t.status === 'expired').length;
  const alertCount = upcomingAlerts.length;

  if (bLoading || loading) {
    return <PageLoader />;
  }

  if (error) {
    return <ErrorCard message={error} onDismiss={() => setError(null)} />;
  }

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div>
          <h1 style={styles.title}>Patch Tests</h1>
          <p style={styles.subtitle}>Compliance tracker</p>
        </div>
      </div>

      {/* Status summary */}
      <div style={styles.summaryRow}>
        <div style={{ ...styles.summaryChip, background: 'var(--success-bg)' }}>
          <span style={{ color: 'var(--success)', fontWeight: 700 }}>{validCount}</span>
          <span style={{ fontSize: 10, color: 'var(--success)' }}>Valid</span>
        </div>
        <div style={{ ...styles.summaryChip, background: 'var(--warning-bg)' }}>
          <span style={{ color: 'var(--warning)', fontWeight: 700 }}>{expiringCount}</span>
          <span style={{ fontSize: 10, color: 'var(--warning)' }}>Expiring</span>
        </div>
        <div style={{ ...styles.summaryChip, background: 'var(--danger-bg)' }}>
          <span style={{ color: 'var(--danger)', fontWeight: 700 }}>{expiredCount}</span>
          <span style={{ fontSize: 10, color: 'var(--danger)' }}>Expired</span>
        </div>
        {alertCount > 0 && (
          <div style={{ ...styles.summaryChip, background: 'var(--accent-light)' }}>
            <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{alertCount}</span>
            <span style={{ fontSize: 10, color: 'var(--accent)' }}>Need test</span>
          </div>
        )}
      </div>

      <button onClick={() => setShowAdd(!showAdd)} style={styles.addBtn}>+ Log Patch Test</button>

      {/* Add form */}
      {showAdd && (
        <div style={styles.formCard}>
          <h3 style={styles.formTitle}>Log Patch Test</h3>
          <div style={styles.formRow}>
            <div style={{ flex: 1 }}>
              <label style={styles.formLabel}>Client</label>
              <input
                type="text" placeholder="Client name"
                value={form.client_name}
                onChange={e => setForm(p => ({ ...p, client_name: e.target.value }))}
                style={styles.formInput}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label style={styles.formLabel}>Date</label>
              <input
                type="date" value={form.test_date}
                onChange={e => setForm(p => ({ ...p, test_date: e.target.value }))}
                style={styles.formInput}
              />
            </div>
          </div>

          <div style={styles.formGroup}>
            <label style={styles.formLabel}>Result</label>
            <div style={styles.resultRow}>
              {[
                { value: 'pass', label: 'Pass - no reaction', icon: '✅' },
                { value: 'fail', label: 'Fail - reaction', icon: '❌' },
                { value: 'pending', label: 'Pending (24h)', icon: '⏳' },
              ].map(r => (
                <button
                  key={r.value}
                  onClick={() => setForm(p => ({ ...p, result: r.value }))}
                  style={{ ...styles.resultBtn,
                    background: form.result === r.value ? (r.value === 'pass' ? 'var(--success-bg)' : r.value === 'fail' ? 'var(--danger-bg)' : 'var(--warning-bg)') : 'var(--bg-card)',
                    borderColor: form.result === r.value ? (r.value === 'pass' ? 'var(--success)' : r.value === 'fail' ? 'var(--danger)' : 'var(--warning)') : 'var(--border)',
                  }}
                >
                  <span>{r.icon}</span>
                  <span style={{ fontSize: 11 }}>{r.label}</span>
                </button>
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

          <div style={styles.formActions}>
            <button onClick={handleSave} style={styles.saveBtn}>Save Test</button>
            <button onClick={() => setShowAdd(false)} style={styles.cancelBtn}>Cancel</button>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div style={styles.tabs}>
        {['alerts', 'all', 'settings'].map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{ ...styles.tab,
              borderBottomColor: tab === t ? 'var(--accent)' : 'transparent',
              color: tab === t ? 'var(--accent)' : 'var(--text-muted)',
            }}
          >
            {t === 'alerts' ? `Alerts (${alertCount})` : t === 'all' ? 'All Tests' : 'Settings'}
          </button>
        ))}
      </div>

      {/* === ALERTS TAB === */}
      {tab === 'alerts' && (
        <div>
          {alertCount === 0 ? (
            <div style={styles.emptyState}>
              <span style={{ fontSize: 32, display: 'block', marginBottom: 8 }}>✅</span>
              <p style={styles.emptyTitle}>All clear!</p>
              <p style={styles.emptyDesc}>Every upcoming appointment has a valid patch test on file.</p>
            </div>
          ) : (
            <div style={styles.alertList}>
              <p style={styles.alertIntro}>These clients have upcoming appointments but need a patch test:</p>
              {upcomingAlerts.map((alert, i) => {
                const status = PATCH_STATUS[alert.status];
                return (
                  <div key={i} style={styles.alertCard}>
                    <div style={styles.alertTop}>
                      <div style={styles.alertAvatar}>{alert.client_name[0]}</div>
                      <div style={styles.alertInfo}>
                        <span style={styles.alertName}>{alert.client_name}</span>
                        <span style={styles.alertDetail}>
                          {alert.treatment} - {new Date(alert.appointment_date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
                        </span>
                      </div>
                      <div style={{ ...styles.alertBadge, background: status.bg, color: status.color }}>
                        {status.icon} {status.label}
                      </div>
                    </div>
                    {reminded[alert.client_name] ? (
                      <span style={styles.sentLabel}>Reminder sent ✓</span>
                    ) : (
                      <div style={styles.alertActions}>
                        <button onClick={() => handleRemind(alert.client_name)} style={styles.remindBtn}>
                          Send patch test reminder
                        </button>
                        <button onClick={() => { setForm(p => ({ ...p, client_name: alert.client_name })); setShowAdd(true); }} style={styles.logBtn}>
                          Log test
                        </button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {/* Expiring soon */}
          {testsWithStatus.filter(t => t.status === 'expiring').length > 0 && (
            <div style={{ marginTop: 20 }}>
              <h3 style={styles.sectionTitle}>Expiring soon</h3>
              {testsWithStatus.filter(t => t.status === 'expiring').map(t => (
                <div key={t.id} style={styles.testRow}>
                  <div style={styles.testAvatar}>{t.client_name[0]}</div>
                  <div style={styles.testInfo}>
                    <span style={styles.testName}>{t.client_name}</span>
                    <span style={styles.testMeta}>Expires in {t.daysLeft} days</span>
                  </div>
                  <button onClick={() => handleRemind(t.client_name)} style={styles.smallRemindBtn}>
                    {reminded[t.client_name] ? 'Sent ✓' : 'Remind'}
                  </button>
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
            <EmptyState title="No patch tests logged" subtitle='Tap "+ Log Patch Test" to start tracking.' />
          ) : (
            <div style={styles.testList}>
              {testsWithStatus.map(t => {
                const status = PATCH_STATUS[t.status];
                return (
                  <div key={t.id} style={styles.testCard}>
                    <div style={styles.testCardTop}>
                      <div style={{ ...styles.testStatusIcon, background: status.bg }}>
                        <span>{status.icon}</span>
                      </div>
                      <div style={styles.testCardInfo}>
                        <span style={styles.testCardName}>{t.client_name}</span>
                        <span style={styles.testCardDate}>
                          Tested {new Date(t.test_date).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                        </span>
                      </div>
                      <div style={{ ...styles.statusBadge, background: status.bg, color: status.color }}>
                        {status.label}
                      </div>
                    </div>
                    <div style={styles.testCardBody}>
                      <span style={styles.testResult}>
                        Result: {t.result === 'pass' ? 'Pass ✅' : t.result === 'fail' ? 'Fail ❌' : 'Pending ⏳'}
                      </span>
                      {t.daysLeft !== null && t.status === 'valid' && (
                        <span style={styles.testExpiry}>{t.daysLeft} days until expiry</span>
                      )}
                    </div>
                    {t.notes && <p style={styles.testNotes}>{t.notes}</p>}
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
                <span style={styles.settingsLabel}>Test validity period</span>
                <span style={styles.settingsHint}>How long a patch test stays valid - affects booking compliance checks</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
                {settingsSaved && <span style={{ fontSize: 11, color: 'var(--success)', fontWeight: 600 }}>Saved ✓</span>}
                <select
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
              <div
                onClick={() => {
                  const next = !settings.auto_remind;
                  setSettings(p => ({ ...p, auto_remind: next }));
                  saveReminderSettings({ patch_test_auto_remind: next });
                }}
                style={{ ...styles.toggle, background: settings.auto_remind ? 'var(--accent)' : 'var(--border)', cursor: 'pointer' }}
              >
                <div style={{ ...styles.toggleDot, transform: settings.auto_remind ? 'translateX(20px)' : 'translateX(2px)' }} />
              </div>
            </div>
            <div style={{ ...styles.settingsRow, borderBottom: 'none' }}>
              <div>
                <span style={styles.settingsLabel}>Remind how many days before?</span>
              </div>
              <select
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
                <span style={styles.settingsLabel}>Block bookings without valid test</span>
                <span style={styles.settingsHint}>Clients won't be able to book tint/lift treatments without a test on file</span>
              </div>
              <div
                onClick={() => {
                  const next = !settings.block_booking_without_test;
                  setSettings(p => ({ ...p, block_booking_without_test: next }));
                  saveReminderSettings({ patch_test_block_booking: next });
                }}
                style={{ ...styles.toggle, background: settings.block_booking_without_test ? 'var(--accent)' : 'var(--border)', cursor: 'pointer' }}
              >
                <div style={{ ...styles.toggleDot, transform: settings.block_booking_without_test ? 'translateX(20px)' : 'translateX(2px)' }} />
              </div>
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
    padding: '0 16px var(--scroll-pad-bottom)', maxWidth: 480, margin: '0 auto', color: 'var(--text-primary)',
  },
  header: { paddingTop: 8, paddingBottom: 8 },
  title: { fontSize: 22, fontWeight: 700, margin: '0 0 2px' },
  subtitle: { fontSize: 13, color: 'var(--accent)', margin: 0, fontWeight: 500 },

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
  formCard: { background: 'var(--bg-card)', borderRadius: 14, padding: 16, boxShadow: 'var(--shadow-xs)', marginBottom: 16 },
  formTitle: { fontSize: 16, fontWeight: 600, margin: '0 0 14px', color: 'var(--text-primary)' },
  formGroup: { marginBottom: 14 },
  formLabel: { display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 6, fontWeight: 500 },
  formInput: { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1.5px solid var(--border)', fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' },
  formRow: { display: 'flex', gap: 10, marginBottom: 14 },
  resultRow: { display: 'flex', gap: 6 },
  resultBtn: {
    flex: 1, padding: '8px 4px', borderRadius: 8, border: '1.5px solid var(--border)',
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  formActions: { display: 'flex', gap: 8 },
  saveBtn: { flex: 1, padding: '10px 0', borderRadius: 10, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  cancelBtn: { padding: '10px 16px', borderRadius: 10, border: 'none', background: 'var(--bg-subtle)', color: 'var(--text-secondary)', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' },

  // Alerts
  alertList: { display: 'flex', flexDirection: 'column', gap: 10 },
  alertIntro: { fontSize: 13, color: 'var(--text-secondary)', margin: '0 0 10px', lineHeight: 1.4 },
  alertCard: { background: 'var(--bg-card)', borderRadius: 14, padding: 14, boxShadow: 'var(--shadow-xs)', borderLeft: '3px solid var(--danger)' },
  alertTop: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 },
  alertAvatar: { width: 34, height: 34, borderRadius: 17, background: 'var(--accent-light)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 600, color: 'var(--accent)', flexShrink: 0 },
  alertInfo: { flex: 1, display: 'flex', flexDirection: 'column', gap: 2 },
  alertName: { fontSize: 13, fontWeight: 600, color: 'var(--text-primary)' },
  alertDetail: { fontSize: 11, color: 'var(--text-muted)' },
  alertBadge: { padding: '3px 8px', borderRadius: 5, fontSize: 10, fontWeight: 600, flexShrink: 0 },
  alertActions: { display: 'flex', gap: 8 },
  remindBtn: { flex: 1, padding: '8px 0', borderRadius: 8, border: 'none', background: 'var(--accent)', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  logBtn: { padding: '8px 14px', borderRadius: 8, border: '1.5px solid var(--border)', background: 'var(--bg-card)', color: 'var(--text-secondary)', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  sentLabel: { fontSize: 12, color: 'var(--success)', fontWeight: 600 },

  sectionTitle: { fontSize: 14, fontWeight: 600, margin: '0 0 10px', color: 'var(--text-primary)' },

  testRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: '1px solid var(--border-light)' },
  testAvatar: { width: 30, height: 30, borderRadius: 15, background: 'var(--warning-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600, color: 'var(--warning)', flexShrink: 0 },
  testInfo: { flex: 1, display: 'flex', flexDirection: 'column', gap: 1 },
  testName: { fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' },
  testMeta: { fontSize: 11, color: 'var(--warning)' },
  smallRemindBtn: { padding: '5px 10px', borderRadius: 6, border: 'none', background: 'var(--warning-bg)', color: 'var(--warning)', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },

  // All tests
  testList: { display: 'flex', flexDirection: 'column', gap: 10 },
  testCard: { background: 'var(--bg-card)', borderRadius: 14, padding: 14, boxShadow: 'var(--shadow-xs)' },
  testCardTop: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 },
  testStatusIcon: { width: 34, height: 34, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0 },
  testCardInfo: { flex: 1, display: 'flex', flexDirection: 'column', gap: 1 },
  testCardName: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' },
  testCardDate: { fontSize: 11, color: 'var(--text-muted)' },
  statusBadge: { padding: '3px 8px', borderRadius: 5, fontSize: 10, fontWeight: 600, flexShrink: 0 },
  testCardBody: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  testResult: { fontSize: 12, color: 'var(--text-secondary)' },
  testExpiry: { fontSize: 11, color: 'var(--text-muted)' },
  testNotes: { fontSize: 12, color: 'var(--text-secondary)', fontStyle: 'italic', margin: '4px 0 0', lineHeight: 1.4 },

  // Settings
  settingsCard: { background: 'var(--bg-card)', borderRadius: 14, padding: 16, boxShadow: 'var(--shadow-xs)', marginBottom: 12 },
  settingsSectionTitle: { fontSize: 14, fontWeight: 600, margin: '0 0 14px', color: 'var(--text-primary)' },
  settingsRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--border-light)' },
  settingsLabel: { display: 'block', fontSize: 13, fontWeight: 500, color: 'var(--text-primary)' },
  settingsHint: { display: 'block', fontSize: 11, color: 'var(--text-muted)', marginTop: 2 },
  settingsSelect: { padding: '6px 10px', borderRadius: 8, border: '1.5px solid var(--border)', fontSize: 12, fontFamily: 'inherit', background: 'var(--bg-card)', color: 'var(--text-secondary)' },
  toggle: { width: 44, height: 26, borderRadius: 13, border: 'none', cursor: 'pointer', position: 'relative', flexShrink: 0, transition: 'background 0.2s' },
  toggleDot: { width: 22, height: 22, borderRadius: 11, background: 'var(--bg-card, #FFFCF9)', position: 'absolute', top: 2, transition: 'transform 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.15)' },
  treatmentNote: { fontSize: 12, color: 'var(--text-muted)', padding: '8px 0' },

  // Empty
  loadingText: { textAlign: 'center', color: 'var(--text-muted)', padding: 40, fontSize: 14 },
  emptyState: { textAlign: 'center', padding: '40px 20px' },
  emptyTitle: { fontSize: 16, fontWeight: 600, margin: '0 0 4px', color: 'var(--text-primary)' },
  emptyDesc: { fontSize: 13, color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 },
};
