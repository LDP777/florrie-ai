import { useState, useEffect } from 'react';
import { useBeautician, fetchRows, isDevMode, insertRow, updateRow, DEV_CLIENTS, DEV_TREATMENTS } from '../lib/supabase.js';
import logger from '../lib/logger.js';

/**
 * Patch Test Tracker — Regulatory compliance for brow & lash treatments.
 *
 * UK law requires a patch test 24-48h before tinting/lifting treatments.
 * This page tracks:
 *   - Which clients have a valid patch test
 *   - When it expires (typically 6 months)
 *   - Upcoming appointments that need one
 *   - One-tap reminder to clients who need testing
 *
 * Tabs:
 *   Alerts    — clients with upcoming appointments but no valid test
 *   All Tests — full record of every patch test
 *   Settings  — expiry period, auto-remind, treatments requiring tests
 */

const PATCH_STATUS = {
  valid: { label: 'Valid', color: '#4CAF50', bg: '#E8F5E9', icon: '✅' },
  expiring: { label: 'Expiring soon', color: '#FF9800', bg: '#FFF3E0', icon: '⚠️' },
  expired: { label: 'Expired', color: '#E57373', bg: '#FEF2F2', icon: '❌' },
  none: { label: 'No test', color: '#AAA5A0', bg: '#F5F2EF', icon: '❓' },
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

// Treatments that require patch tests
const REQUIRES_TEST = ['dev-t1', 'dev-t2', 'dev-t3', 'dev-t4', 'dev-t5', 'dev-t6', 'dev-t13'];

const DEV_PATCH_TESTS = [
  { id: 'pt1', client_id: 'dev-c1', client_name: 'Shauna', test_date: '2026-03-01', result: 'pass', notes: 'No reaction', treatment_id: 'dev-t1' },
  { id: 'pt2', client_id: 'dev-c2', client_name: 'Daisy S', test_date: '2025-11-15', result: 'pass', notes: '', treatment_id: 'dev-t2' },
  { id: 'pt3', client_id: 'dev-c3', client_name: 'Jasmin', test_date: '2026-02-10', result: 'pass', notes: 'Slight redness at 24h, gone by 48h — OK to proceed', treatment_id: 'dev-t13' },
];

const DEV_UPCOMING_NEEDING_TEST = [
  { client_name: 'Emma', appointment_date: '2026-03-28', treatment: 'Lamination & Hybrid Dye', status: 'none' },
  { client_name: 'Daisy S', appointment_date: '2026-03-29', treatment: 'Lamination & Tint', status: 'expired' },
];

export default function PatchTests() {
  const { beautician, loading: bLoading } = useBeautician();
  const [tests, setTests] = useState(DEV_PATCH_TESTS);
  const [tab, setTab] = useState('alerts');
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [reminded, setReminded] = useState({});
  const [expiryMonths, setExpiryMonths] = useState(6);

  const [form, setForm] = useState({
    client_name: '', test_date: new Date().toISOString().split('T')[0],
    result: 'pass', notes: '', treatment_id: '',
  });

  // Settings
  const [settings, setSettings] = useState({
    expiry_months: 6,
    auto_remind: true,
    remind_days_before: 7,
    block_booking_without_test: false,
    require_for: REQUIRES_TEST,
  });

  useEffect(() => { loadData(); }, [beautician, bLoading]);

  async function loadData() {
    setLoading(true);
    if (bLoading || !beautician) {
      setLoading(false);
      return;
    }
    if (isDevMode) {
      setTests(DEV_PATCH_TESTS);
      setLoading(false);
      return;
    }
    try {
      const rows = await fetchRows('patch_tests', beautician.id, { order: 'test_date', ascending: false });
      setTests(rows);
    } catch (err) {
      logger.error('Failed to load patch tests:', err);
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

    if (!isDevMode && beautician) {
      try {
        const saved = await insertRow('patch_tests', { beautician_id: beautician.id, ...test });
        test.id = saved.id;
      } catch {}
    }

    setTests(prev => [test, ...prev]);
    setForm({ client_name: '', test_date: new Date().toISOString().split('T')[0], result: 'pass', notes: '', treatment_id: '' });
    setShowAdd(false);
  }

  function handleRemind(clientName) {
    setReminded(prev => ({ ...prev, [clientName]: true }));
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
  const alertCount = DEV_UPCOMING_NEEDING_TEST.length;

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
        <div style={{ ...styles.summaryChip, background: '#E8F5E9' }}>
          <span style={{ color: '#4CAF50', fontWeight: 700 }}>{validCount}</span>
          <span style={{ fontSize: 10, color: '#4CAF50' }}>Valid</span>
        </div>
        <div style={{ ...styles.summaryChip, background: '#FFF3E0' }}>
          <span style={{ color: '#FF9800', fontWeight: 700 }}>{expiringCount}</span>
          <span style={{ fontSize: 10, color: '#FF9800' }}>Expiring</span>
        </div>
        <div style={{ ...styles.summaryChip, background: '#FEF2F2' }}>
          <span style={{ color: '#E57373', fontWeight: 700 }}>{expiredCount}</span>
          <span style={{ fontSize: 10, color: '#E57373' }}>Expired</span>
        </div>
        {alertCount > 0 && (
          <div style={{ ...styles.summaryChip, background: '#FCE4EC' }}>
            <span style={{ color: '#C76B8A', fontWeight: 700 }}>{alertCount}</span>
            <span style={{ fontSize: 10, color: '#C76B8A' }}>Need test</span>
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
                { value: 'pass', label: 'Pass — no reaction', icon: '✅' },
                { value: 'fail', label: 'Fail — reaction', icon: '❌' },
                { value: 'pending', label: 'Pending (24h)', icon: '⏳' },
              ].map(r => (
                <button
                  key={r.value}
                  onClick={() => setForm(p => ({ ...p, result: r.value }))}
                  style={{
                    ...styles.resultBtn,
                    background: form.result === r.value ? (r.value === 'pass' ? '#E8F5E9' : r.value === 'fail' ? '#FEF2F2' : '#FFF3E0') : '#fff',
                    borderColor: form.result === r.value ? (r.value === 'pass' ? '#4CAF50' : r.value === 'fail' ? '#E57373' : '#FF9800') : '#F0ECE8',
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
            style={{
              ...styles.tab,
              borderBottomColor: tab === t ? '#C76B8A' : 'transparent',
              color: tab === t ? '#C76B8A' : '#AAA5A0',
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
              {DEV_UPCOMING_NEEDING_TEST.map((alert, i) => {
                const status = PATCH_STATUS[alert.status];
                return (
                  <div key={i} style={styles.alertCard}>
                    <div style={styles.alertTop}>
                      <div style={styles.alertAvatar}>{alert.client_name[0]}</div>
                      <div style={styles.alertInfo}>
                        <span style={styles.alertName}>{alert.client_name}</span>
                        <span style={styles.alertDetail}>
                          {alert.treatment} — {new Date(alert.appointment_date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })}
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
          {loading ? (
            <p style={styles.loadingText}>Loading tests...</p>
          ) : testsWithStatus.length === 0 ? (
            <div style={styles.emptyState}>
              <p style={styles.emptyTitle}>No patch tests logged</p>
              <p style={styles.emptyDesc}>Tap "+ Log Patch Test" to start tracking.</p>
            </div>
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
                <span style={styles.settingsHint}>How long before a patch test expires</span>
              </div>
              <select
                value={settings.expiry_months}
                onChange={e => setSettings(p => ({ ...p, expiry_months: parseInt(e.target.value) }))}
                style={styles.settingsSelect}
              >
                <option value={3}>3 months</option>
                <option value={6}>6 months</option>
                <option value={12}>12 months</option>
              </select>
            </div>
          </div>

          <div style={styles.settingsCard}>
            <h3 style={styles.settingsSectionTitle}>Reminders</h3>
            <div style={styles.settingsRow}>
              <div>
                <span style={styles.settingsLabel}>Auto-remind clients</span>
                <span style={styles.settingsHint}>Florrie messages clients when their test is expiring</span>
              </div>
              <button
                onClick={() => setSettings(p => ({ ...p, auto_remind: !p.auto_remind }))}
                style={{ ...styles.toggle, background: settings.auto_remind ? '#C76B8A' : '#E8E4E0' }}
              >
                <div style={{ ...styles.toggleDot, transform: settings.auto_remind ? 'translateX(18px)' : 'translateX(2px)' }} />
              </button>
            </div>
            <div style={styles.settingsRow}>
              <div>
                <span style={styles.settingsLabel}>Remind how many days before?</span>
              </div>
              <select
                value={settings.remind_days_before}
                onChange={e => setSettings(p => ({ ...p, remind_days_before: parseInt(e.target.value) }))}
                style={styles.settingsSelect}
              >
                <option value={3}>3 days</option>
                <option value={7}>7 days</option>
                <option value={14}>14 days</option>
              </select>
            </div>
          </div>

          <div style={styles.settingsCard}>
            <h3 style={styles.settingsSectionTitle}>Booking protection</h3>
            <div style={styles.settingsRow}>
              <div>
                <span style={styles.settingsLabel}>Block bookings without valid test</span>
                <span style={styles.settingsHint}>Clients can't book tint/lift treatments without a test on file</span>
              </div>
              <button
                onClick={() => setSettings(p => ({ ...p, block_booking_without_test: !p.block_booking_without_test }))}
                style={{ ...styles.toggle, background: settings.block_booking_without_test ? '#C76B8A' : '#E8E4E0' }}
              >
                <div style={{ ...styles.toggleDot, transform: settings.block_booking_without_test ? 'translateX(18px)' : 'translateX(2px)' }} />
              </button>
            </div>
          </div>

          <div style={styles.settingsCard}>
            <h3 style={styles.settingsSectionTitle}>Treatments requiring patch test</h3>
            {DEV_TREATMENTS.filter(t => ['brows', 'lashes'].includes(t.category)).map(t => {
              const isRequired = settings.require_for.includes(t.id);
              return (
                <div key={t.id} style={styles.treatmentRow}>
                  <span style={styles.treatmentName}>{t.name}</span>
                  <button
                    onClick={() => {
                      setSettings(p => ({
                        ...p,
                        require_for: isRequired
                          ? p.require_for.filter(id => id !== t.id)
                          : [...p.require_for, t.id],
                      }));
                    }}
                    style={{ ...styles.toggle, background: isRequired ? '#C76B8A' : '#E8E4E0', width: 38, height: 22 }}
                  >
                    <div style={{ ...styles.toggleDot, width: 18, height: 18, borderRadius: 9, transform: isRequired ? 'translateX(16px)' : 'translateX(2px)' }} />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  page: {
    minHeight: '100vh', background: '#FAF8F5',
    fontFamily: '"DM Sans", -apple-system, sans-serif',
    padding: '0 16px 40px', maxWidth: 480, margin: '0 auto', color: '#2D2A26',
  },
  header: { paddingTop: 28, paddingBottom: 8 },
  title: { fontSize: 22, fontWeight: 700, margin: '0 0 2px' },
  subtitle: { fontSize: 13, color: '#C76B8A', margin: 0, fontWeight: 500 },

  summaryRow: { display: 'flex', gap: 8, marginBottom: 12 },
  summaryChip: {
    flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center',
    padding: '10px 0', borderRadius: 10, gap: 2,
  },

  addBtn: {
    width: '100%', padding: '12px 0', borderRadius: 10, border: 'none',
    background: '#C76B8A', color: '#fff', fontSize: 14, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit', marginBottom: 16,
  },

  tabs: { display: 'flex', gap: 16, borderBottom: '1px solid #F0ECE8', marginBottom: 16 },
  tab: {
    padding: '10px 0', background: 'none', border: 'none',
    borderBottom: '2px solid transparent', fontSize: 14, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },

  // Form
  formCard: { background: '#fff', borderRadius: 14, padding: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.04)', marginBottom: 16 },
  formTitle: { fontSize: 16, fontWeight: 600, margin: '0 0 14px', color: '#2D2A26' },
  formGroup: { marginBottom: 14 },
  formLabel: { display: 'block', fontSize: 12, color: '#AAA5A0', marginBottom: 6, fontWeight: 500 },
  formInput: { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1.5px solid #F0ECE8', fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' },
  formRow: { display: 'flex', gap: 10, marginBottom: 14 },
  resultRow: { display: 'flex', gap: 6 },
  resultBtn: {
    flex: 1, padding: '8px 4px', borderRadius: 8, border: '1.5px solid #F0ECE8',
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  formActions: { display: 'flex', gap: 8 },
  saveBtn: { flex: 1, padding: '10px 0', borderRadius: 10, border: 'none', background: '#C76B8A', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  cancelBtn: { padding: '10px 16px', borderRadius: 10, border: 'none', background: '#F5F2EF', color: '#8A8580', fontSize: 13, cursor: 'pointer', fontFamily: 'inherit' },

  // Alerts
  alertList: { display: 'flex', flexDirection: 'column', gap: 10 },
  alertIntro: { fontSize: 13, color: '#8A8580', margin: '0 0 10px', lineHeight: 1.4 },
  alertCard: { background: '#fff', borderRadius: 14, padding: 14, boxShadow: '0 1px 3px rgba(0,0,0,0.04)', borderLeft: '3px solid #E57373' },
  alertTop: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 },
  alertAvatar: { width: 34, height: 34, borderRadius: 17, background: '#FBF0F3', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 600, color: '#C76B8A', flexShrink: 0 },
  alertInfo: { flex: 1, display: 'flex', flexDirection: 'column', gap: 2 },
  alertName: { fontSize: 13, fontWeight: 600, color: '#2D2A26' },
  alertDetail: { fontSize: 11, color: '#AAA5A0' },
  alertBadge: { padding: '3px 8px', borderRadius: 5, fontSize: 10, fontWeight: 600, flexShrink: 0 },
  alertActions: { display: 'flex', gap: 8 },
  remindBtn: { flex: 1, padding: '8px 0', borderRadius: 8, border: 'none', background: '#C76B8A', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  logBtn: { padding: '8px 14px', borderRadius: 8, border: '1.5px solid #F0ECE8', background: '#fff', color: '#5A5550', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  sentLabel: { fontSize: 12, color: '#4CAF50', fontWeight: 600 },

  sectionTitle: { fontSize: 14, fontWeight: 600, margin: '0 0 10px', color: '#2D2A26' },

  testRow: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 0', borderBottom: '1px solid #F5F2EF' },
  testAvatar: { width: 30, height: 30, borderRadius: 15, background: '#FFF3E0', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600, color: '#FF9800', flexShrink: 0 },
  testInfo: { flex: 1, display: 'flex', flexDirection: 'column', gap: 1 },
  testName: { fontSize: 13, fontWeight: 500, color: '#2D2A26' },
  testMeta: { fontSize: 11, color: '#FF9800' },
  smallRemindBtn: { padding: '5px 10px', borderRadius: 6, border: 'none', background: '#FFF3E0', color: '#FF9800', fontSize: 11, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },

  // All tests
  testList: { display: 'flex', flexDirection: 'column', gap: 10 },
  testCard: { background: '#fff', borderRadius: 14, padding: 14, boxShadow: '0 1px 3px rgba(0,0,0,0.04)' },
  testCardTop: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 },
  testStatusIcon: { width: 34, height: 34, borderRadius: 10, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16, flexShrink: 0 },
  testCardInfo: { flex: 1, display: 'flex', flexDirection: 'column', gap: 1 },
  testCardName: { fontSize: 14, fontWeight: 600, color: '#2D2A26' },
  testCardDate: { fontSize: 11, color: '#AAA5A0' },
  statusBadge: { padding: '3px 8px', borderRadius: 5, fontSize: 10, fontWeight: 600, flexShrink: 0 },
  testCardBody: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 },
  testResult: { fontSize: 12, color: '#5A5550' },
  testExpiry: { fontSize: 11, color: '#AAA5A0' },
  testNotes: { fontSize: 12, color: '#8A8580', fontStyle: 'italic', margin: '4px 0 0', lineHeight: 1.4 },

  // Settings
  settingsCard: { background: '#fff', borderRadius: 14, padding: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.04)', marginBottom: 12 },
  settingsSectionTitle: { fontSize: 14, fontWeight: 600, margin: '0 0 14px', color: '#2D2A26' },
  settingsRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid #FAF8F5' },
  settingsLabel: { display: 'block', fontSize: 13, fontWeight: 500, color: '#2D2A26' },
  settingsHint: { display: 'block', fontSize: 11, color: '#AAA5A0', marginTop: 2 },
  settingsSelect: { padding: '6px 10px', borderRadius: 8, border: '1.5px solid #F0ECE8', fontSize: 12, fontFamily: 'inherit', background: '#fff', color: '#5A5550' },
  toggle: { width: 44, height: 26, borderRadius: 13, border: 'none', cursor: 'pointer', position: 'relative', flexShrink: 0, transition: 'background 0.2s' },
  toggleDot: { width: 22, height: 22, borderRadius: 11, background: '#fff', position: 'absolute', top: 2, transition: 'transform 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.15)' },
  treatmentRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #FAF8F5' },
  treatmentName: { fontSize: 13, color: '#5A5550' },

  // Empty
  loadingText: { textAlign: 'center', color: '#AAA5A0', padding: 40, fontSize: 14 },
  emptyState: { textAlign: 'center', padding: '40px 20px' },
  emptyTitle: { fontSize: 16, fontWeight: 600, margin: '0 0 4px', color: '#2D2A26' },
  emptyDesc: { fontSize: 13, color: '#AAA5A0', margin: 0, lineHeight: 1.5 },
};
