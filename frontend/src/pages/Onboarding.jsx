import { useState } from 'react';
import { useBeautician, updateRow, insertRow, isDevMode } from '../lib/supabase.js';
import logger from '../lib/logger.js';

/**
 * Onboarding — first-run wizard after signup.
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

  // Step 3: Working hours
  const [hours, setHours] = useState(DEFAULT_HOURS);

  // Step 4: Booking slug
  const [slug, setSlug] = useState('');

  // Step 5: Client import
  const [importFile, setImportFile] = useState(null);
  const [importStatus, setImportStatus] = useState(null);

  const totalSteps = 5;
  const progress = (step / totalSteps) * 100;

  if (bLoading) {
    return <p style={styles.loadingText}>Setting up your account...</p>;
  }

  // === Step handlers ===

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
      await updateRow('beauticians', beautician.id, {
        first_name: firstName.trim(),
        business_name: businessName.trim()
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
      for (const t of valid) {
        await insertRow('treatments', {
          beautician_id: beautician.id,
          name: t.name.trim(),
          duration_minutes: parseInt(t.duration_minutes) || 60,
          price_cents: Math.round(parseFloat(t.price_cents) * 100) || 0,
          category: t.category,
          is_active: true
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
      await updateRow('beauticians', beautician.id, {
        booking_slug: cleanSlug,
        onboarding_completed_at: new Date().toISOString()
      });
      await refresh();
      setStep(5);
    } catch (err) {
      logger.error('Slug save error:', err);
      setError('Failed to save booking link. Please try again.');
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

      // Simple CSV parsing — expects header row with first_name, last_name, email, phone
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
      setError('Import failed — check the file format');
    } finally {
      setSaving(false);
    }
  }

  function finishOnboarding() {
    if (onComplete) onComplete();
  }

  function skipStep() {
    setError(null);
    if (step < 5) {
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
              <span style={{ fontSize: 13, color: 'var(--danger-text)', fontWeight: 500 }}>⚠ {error}</span>
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

          <button
            onClick={saveBusinessInfo}
            disabled={!firstName.trim() || saving}
            style={{
              ...styles.primaryBtn,
              opacity: !firstName.trim() ? 0.5 : 1
            }}
          >
            {saving ? 'Saving...' : 'Next'}
          </button>
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
              <span style={{ fontSize: 13, color: 'var(--danger-text)', fontWeight: 500 }}>⚠ {error}</span>
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

          <button
            onClick={saveTreatments}
            disabled={!treatments.some(t => t.name.trim()) || saving}
            style={{
              ...styles.primaryBtn,
              opacity: !treatments.some(t => t.name.trim()) ? 0.5 : 1,
              marginTop: 8
            }}
          >
            {saving ? 'Saving...' : 'Next'}
          </button>
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
              <span style={{ fontSize: 13, color: 'var(--danger-text)', fontWeight: 500 }}>⚠ {error}</span>
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
                <span style={{
                  ...styles.dayName,
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

          <button
            onClick={saveHours}
            disabled={saving}
            style={styles.primaryBtn}
          >
            {saving ? 'Saving...' : 'Next'}
          </button>
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
              <span style={{ fontSize: 13, color: 'var(--danger-text)', fontWeight: 500 }}>⚠ {error}</span>
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

          <button
            onClick={saveSlug}
            disabled={!slug.trim() || saving}
            style={{
              ...styles.primaryBtn,
              opacity: !slug.trim() ? 0.5 : 1
            }}
          >
            {saving ? 'Saving...' : 'Next'}
          </button>
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
              <span style={{ fontSize: 13, color: 'var(--danger-text)', fontWeight: 500 }}>⚠ {error}</span>
            </div>
          )}

          {/* Import from Timely — branded */}
          <div style={styles.importGuide}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <span style={{ fontSize: 20 }}>⏱️</span>
              <span style={{ fontSize: 15, fontWeight: 600 }}>Import from Timely</span>
            </div>
            <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.8 }}>
              <li>In Timely, go to <b>Clients → Export</b></li>
              <li>Download the CSV file</li>
              <li>Upload it below — we'll match the columns automatically</li>
            </ol>
          </div>

          {/* Import from Fresha */}
          <div style={{ ...styles.importGuide, borderColor: '#E8E4E0' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
              <span style={{ fontSize: 20 }}>🟢</span>
              <span style={{ fontSize: 15, fontWeight: 600 }}>Import from Fresha</span>
            </div>
            <ol style={{ margin: 0, paddingLeft: 20, fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.8 }}>
              <li>In Fresha, go to <b>Clients → Export to CSV</b></li>
              <li>Upload it here — same thing, we sort the columns</li>
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

          <button
            onClick={finishOnboarding}
            style={styles.primaryBtn}
          >
            {importStatus ? 'Done — Go to Dashboard' : 'Skip — Go to Dashboard'}
          </button>
          {!importStatus && (
            <button onClick={skipStep} style={styles.skipBtn}>
              Skip this step
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const styles = {
  page: {
    minHeight: '100vh',
    background: 'var(--bg)',
    fontFamily: "var(--font-body, 'DM Sans', -apple-system, sans-serif)",
    padding: '0 20px 60px',
    maxWidth: 480,
    margin: '0 auto',
    color: 'var(--text-primary)',
    animation: 'fadeIn 0.25s cubic-bezier(0.16, 1, 0.3, 1)'
  },
  loadingText: { textAlign: 'center', color: 'var(--text-muted)', padding: 60, fontSize: 14, fontFamily: "var(--font-body, 'DM Sans', sans-serif)" },
  progressBar: {
    height: 4,
    background: 'var(--border)',
    borderRadius: 2,
    marginTop: 20,
    marginBottom: 8,
    overflow: 'hidden'
  },
  progressFill: {
    height: '100%',
    background: 'var(--accent)',
    borderRadius: 2,
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
  primaryBtn: {
    width: '100%',
    padding: '14px 0',
    borderRadius: 12,
    border: 'none',
    background: 'var(--accent)',
    color: '#fff',
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    marginTop: 12
  },
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
    borderRadius: 14,
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
    borderRadius: 6,
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
    borderRadius: 6,
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
    borderRadius: 12,
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
    borderRadius: 12,
    padding: 16,
    marginBottom: 10,
    border: '1.5px solid rgba(199, 107, 138, 0.19)',
  },
  importArea: {
    background: 'var(--bg-card)',
    borderRadius: 14,
    padding: 20,
    textAlign: 'center',
    marginBottom: 12,
    border: '1.5px dashed var(--border)'
  },
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
  }
};
