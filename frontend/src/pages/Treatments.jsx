import { useState, useEffect } from 'react';
import { useBeautician, fetchRows, insertRow, updateRow, isDevMode, DEV_TREATMENTS } from '../lib/supabase.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';

/**
 * Treatments — manage treatment menu.
 * Wired to Supabase. Dev mode shows Ellie's real menu.
 */

const CATEGORIES = [
  { value: 'brows', label: 'Brows', emoji: '🪮' },
  { value: 'lashes', label: 'Lashes', emoji: '👁️' },
  { value: 'nails', label: 'Nails', emoji: '💅' },
  { value: 'skin', label: 'Skin', emoji: '✨' },
  { value: 'waxing', label: 'Waxing', emoji: '🍯' },
  { value: 'makeup', label: 'Makeup', emoji: '💄' },
  { value: 'hair', label: 'Hair', emoji: '💇' },
  { value: 'other', label: 'Other', emoji: '🌸' }
];

const catEmoji = (cat) => CATEGORIES.find(c => c.value === cat)?.emoji || '🌸';
const catLabel = (cat) => CATEGORIES.find(c => c.value === cat)?.label || cat;
const fmt = (cents) => `£${(cents / 100).toFixed(2)}`;

export default function Treatments() {
  const { beautician, loading: bLoading } = useBeautician();
  const [treatments, setTreatments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showInactive, setShowInactive] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  const blank = {
    name: '', duration_minutes: 60, price_cents: '', deposit_cents: '', deposit_percent: '',
    category: 'brows', description: '', buffer_minutes: 0,
    requires_consultation: false, no_show_fee: '', booking_enabled: true
  };
  const [form, setForm] = useState(blank);

  useEffect(() => {
    if (beautician) loadTreatments();
  }, [beautician]);

  async function loadTreatments() {
    try {
      if (isDevMode) {
        setTreatments(DEV_TREATMENTS);
      } else {
        const data = await fetchRows('treatments', beautician.id, { order: 'sort_order' });
        setTreatments(data);
      }
    } catch (err) {
      logger.error('Load treatments error:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleSave() {
    if (!form.name.trim() || !beautician) return;
    setSaving(true);

    const body = {
      name: form.name.trim(),
      duration_minutes: parseInt(form.duration_minutes) || 60,
      price_cents: Math.round(parseFloat(form.price_cents) * 100) || 0,
      deposit_cents: form.deposit_cents ? Math.round(parseFloat(form.deposit_cents) * 100) : 0,
      deposit_percent: form.deposit_percent ? parseInt(form.deposit_percent) : 0,
      category: form.category,
      description: form.description,
      buffer_minutes: parseInt(form.buffer_minutes) || 0,
      requires_consultation: form.requires_consultation || false,
      booking_enabled: form.booking_enabled !== false,
    };

    try {
      setSaveError(null);
      if (editing) {
        await updateRow('treatments', editing, body);
      } else {
        await insertRow('treatments', { ...body, beautician_id: beautician.id });
      }
      setForm(blank);
      setEditing(null);
      setShowAdd(false);
      loadTreatments();
    } catch (err) {
      logger.error('Save treatment error:', err);
      setSaveError(err.message || 'Failed to save treatment');
    } finally {
      setSaving(false);
    }
  }

  async function handleToggleActive(id, currentlyActive) {
    try {
      await updateRow('treatments', id, { is_active: !currentlyActive });
      loadTreatments();
    } catch (err) {
      logger.error('Toggle error:', err);
    }
  }

  function startEdit(t) {
    setForm({
      name: t.name,
      duration_minutes: t.duration_minutes,
      price_cents: (t.price_cents / 100).toFixed(2),
      deposit_cents: t.deposit_cents ? (t.deposit_cents / 100).toFixed(2) : '',
      deposit_percent: t.deposit_percent || '',
      category: t.category || 'other',
      description: t.description || '',
      buffer_minutes: t.buffer_minutes || 0,
      requires_consultation: t.requires_consultation || false,
      no_show_fee: t.no_show_fee_cents ? (t.no_show_fee_cents / 100).toFixed(2) : '',
      booking_enabled: t.booking_enabled !== false
    });
    setEditing(t.id);
    setShowAdd(true);
  }

  // Group by category
  const active = treatments.filter(t => t.is_active !== false);
  const inactive = treatments.filter(t => t.is_active === false);

  const grouped = {};
  active.forEach(t => {
    const cat = t.category || 'other';
    if (!grouped[cat]) grouped[cat] = [];
    grouped[cat].push(t);
  });

  const sortedCategories = Object.keys(grouped).sort((a, b) => {
    const ai = CATEGORIES.findIndex(c => c.value === a);
    const bi = CATEGORIES.findIndex(c => c.value === b);
    return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
  });

  if (bLoading || loading) return <p style={styles.loadingText}>Loading treatments...</p>;

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <h1 style={styles.title}>Treatments</h1>
        <button onClick={() => { setShowAdd(!showAdd); setEditing(null); setForm(blank); }} style={styles.addBtn}>
          + Add
        </button>
      </div>

      {/* Add / Edit form */}
      {showAdd && (
        <div style={styles.addForm}>
          <h3 style={styles.formTitle}>{editing ? 'Edit Treatment' : 'New Treatment'}</h3>

          <div style={styles.formGroup}>
            <label style={styles.formLabel}>Name</label>
            <input
              type="text"
              value={form.name}
              onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
              placeholder="e.g. Brow Lamination"
              style={styles.formInput}
              autoFocus
            />
          </div>

          <div style={styles.formRow}>
            <div style={styles.formGroup}>
              <label style={styles.formLabel}>Price (£)</label>
              <input
                type="number"
                step="0.01"
                value={form.price_cents}
                onChange={e => setForm(p => ({ ...p, price_cents: e.target.value }))}
                placeholder="0.00"
                style={styles.formInput}
              />
            </div>
            <div style={styles.formGroup}>
              <label style={styles.formLabel}>Duration (mins)</label>
              <input
                type="number"
                value={form.duration_minutes}
                onChange={e => setForm(p => ({ ...p, duration_minutes: e.target.value }))}
                style={styles.formInput}
              />
            </div>
          </div>

          <div style={styles.formRow}>
            <div style={styles.formGroup}>
              <label style={styles.formLabel}>Deposit %</label>
              <input
                type="number"
                min="0"
                max="100"
                value={form.deposit_percent}
                onChange={e => setForm(p => ({ ...p, deposit_percent: e.target.value, deposit_cents: '' }))}
                placeholder="e.g. 50"
                style={styles.formInput}
              />
            </div>
            <div style={styles.formGroup}>
              <label style={styles.formLabel}>or Flat (£)</label>
              <input
                type="number"
                step="0.01"
                value={form.deposit_cents}
                onChange={e => setForm(p => ({ ...p, deposit_cents: e.target.value, deposit_percent: '' }))}
                placeholder="e.g. 20"
                style={styles.formInput}
              />
            </div>
          </div>
          <div style={styles.formRow}>
            <div style={styles.formGroup}>
              <label style={styles.formLabel}>Category</label>
              <select
                value={form.category}
                onChange={e => setForm(p => ({ ...p, category: e.target.value }))}
                style={styles.formSelect}
              >
                {CATEGORIES.map(c => (
                  <option key={c.value} value={c.value}>{c.emoji} {c.label}</option>
                ))}
              </select>
            </div>
          </div>

          <div style={styles.formRow}>
            <div style={styles.formGroup}>
              <label style={styles.formLabel}>Buffer time (mins)</label>
              <input
                type="number"
                value={form.buffer_minutes}
                onChange={e => setForm(p => ({ ...p, buffer_minutes: e.target.value }))}
                placeholder="0"
                style={styles.formInput}
              />
              <span style={styles.formHint}>Cleanup/prep time after this treatment</span>
            </div>
            <div style={styles.formGroup}>
              <label style={styles.formLabel}>Consultation form</label>
              <button
                type="button"
                onClick={() => setForm(p => ({ ...p, requires_consultation: !p.requires_consultation }))}
                style={{
                  ...styles.toggleBtn,
                  background: form.requires_consultation ? 'var(--accent)' : 'var(--border)',
                  color: form.requires_consultation ? '#fff' : '#888'
                }}
              >
                {form.requires_consultation ? 'Required' : 'Not needed'}
              </button>
              <span style={styles.formHint}>Send questions before appointment</span>
            </div>
          </div>

          <div style={styles.formGroup}>
            <label style={styles.formLabel}>Description</label>
            <input
              type="text"
              value={form.description}
              onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
              placeholder="Optional — shown on booking page"
              style={styles.formInput}
            />
          </div>

          <div style={styles.formRow}>
            <div style={styles.formGroup}>
              <label style={styles.formLabel}>No-show fee (£)</label>
              <input
                type="number"
                step="0.01"
                value={form.no_show_fee || ''}
                onChange={e => setForm(p => ({ ...p, no_show_fee: e.target.value }))}
                placeholder="Optional"
                style={styles.formInput}
              />
              <span style={styles.formHint}>Charged if client doesn't show up</span>
            </div>
            <div style={styles.formGroup}>
              <label style={styles.formLabel}>Show on booking page</label>
              <button
                type="button"
                onClick={() => setForm(p => ({ ...p, booking_enabled: !p.booking_enabled }))}
                style={{
                  ...styles.toggleBtn,
                  background: form.booking_enabled !== false ? 'var(--accent)' : 'var(--border)',
                  color: form.booking_enabled !== false ? '#fff' : '#888'
                }}
              >
                {form.booking_enabled !== false ? 'Visible' : 'Hidden'}
              </button>
              <span style={styles.formHint}>Hide from public booking page</span>
            </div>
          </div>

          <div style={styles.formActions}>
            <button onClick={handleSave} disabled={!form.name.trim() || saving} style={styles.saveBtn}>
              {saving ? 'Saving...' : editing ? 'Update' : 'Add Treatment'}
            </button>
            <button onClick={() => { setShowAdd(false); setEditing(null); setForm(blank); }} style={styles.cancelBtn}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Treatment list */}
      {active.length === 0 && inactive.length === 0 ? (
        <div style={styles.emptyState}>
          <p style={styles.emptyTitle}>No treatments yet</p>
          <p style={styles.emptyDesc}>Add the services you offer so clients can book them.</p>
        </div>
      ) : (
        <>
          {sortedCategories.map(cat => (
            <div key={cat} style={styles.categorySection}>
              <h3 style={styles.categoryTitle}>
                {catEmoji(cat)} {catLabel(cat)}
              </h3>
              {grouped[cat].map(t => (
                <div key={t.id} style={styles.treatmentCard}>
                  <div style={styles.treatmentInfo}>
                    <span style={styles.treatmentName}>{t.name}</span>
                    <span style={styles.treatmentMeta}>
                      {t.duration_minutes} min{t.buffer_minutes > 0 && ` + ${t.buffer_minutes} buffer`} · {fmt(t.price_cents)}
                      {t.deposit_percent > 0 ? ` · ${t.deposit_percent}% deposit` : t.deposit_cents > 0 ? ` · ${fmt(t.deposit_cents)} deposit` : ''}
                    </span>
                    {t.requires_consultation && (
                      <span style={styles.consultBadge}>📋 Consultation required</span>
                    )}
                    {t.description && (
                      <span style={styles.treatmentDesc}>{t.description}</span>
                    )}
                  </div>
                  <div style={styles.treatmentActions}>
                    <button onClick={() => startEdit(t)} style={styles.editBtn}>Edit</button>
                    <button
                      onClick={() => handleToggleActive(t.id, true)}
                      style={styles.deactivateBtn}
                    >
                      Hide
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ))}

          {/* Inactive treatments */}
          {inactive.length > 0 && (
            <div style={styles.inactiveSection}>
              <button
                onClick={() => setShowInactive(!showInactive)}
                style={styles.inactiveToggle}
              >
                {showInactive ? 'Hide' : 'Show'} {inactive.length} hidden treatment{inactive.length !== 1 ? 's' : ''}
              </button>

              {showInactive && inactive.map(t => (
                <div key={t.id} style={{ ...styles.treatmentCard, opacity: 0.6 }}>
                  <div style={styles.treatmentInfo}>
                    <span style={styles.treatmentName}>{t.name}</span>
                    <span style={styles.treatmentMeta}>
                      {t.duration_minutes} min · {fmt(t.price_cents)}
                    </span>
                  </div>
                  <button
                    onClick={() => handleToggleActive(t.id, false)}
                    style={styles.reactivateBtn}
                  >
                    Restore
                  </button>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

const styles = {
  page: {
    minHeight: '100vh', background: 'var(--bg)',
    fontFamily: "var(--font-body, 'DM Sans', -apple-system, sans-serif)",
    padding: '0 16px 40px', maxWidth: 480, margin: '0 auto', color: 'var(--text-primary)',
    animation: 'fadeIn 0.25s cubic-bezier(0.16, 1, 0.3, 1)'
  },
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    paddingTop: 28, paddingBottom: 12
  },
  title: { fontSize: 22, fontWeight: 700, margin: 0, fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)" },
  addBtn: {
    padding: '8px 16px', borderRadius: 10, border: 'none',
    background: 'var(--accent)', color: '#fff', fontSize: 13, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit'
  },
  addForm: {
    background: 'var(--bg-card)', borderRadius: 14, padding: 16, marginBottom: 14,
    boxShadow: 'var(--shadow-xs, 0 1px 3px rgba(0,0,0,0.04))'
  },
  formTitle: { fontSize: 14, fontWeight: 600, margin: '0 0 14px', color: 'var(--accent)' },
  formRow: { display: 'flex', gap: 10 },
  formGroup: { flex: 1, marginBottom: 10 },
  formLabel: { display: 'block', fontSize: 12, color: 'var(--text-muted)', marginBottom: 4, fontWeight: 500 },
  formInput: {
    width: '100%', padding: '10px 12px', borderRadius: 8,
    border: '1.5px solid var(--border)', fontSize: 14, fontFamily: 'inherit',
    outline: 'none', boxSizing: 'border-box'
  },
  formSelect: {
    width: '100%', padding: '10px 12px', borderRadius: 8,
    border: '1.5px solid var(--border)', fontSize: 14, fontFamily: 'inherit',
    outline: 'none', background: 'var(--bg-card)', boxSizing: 'border-box'
  },
  formHint: { display: 'block', fontSize: 11, color: 'var(--text-muted)', marginTop: 4 },
  toggleBtn: {
    width: '100%', padding: '10px 12px', borderRadius: 8, border: 'none',
    fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
    transition: 'all 0.2s'
  },
  consultBadge: {
    fontSize: 11, color: 'var(--accent)', fontWeight: 500, marginTop: 2
  },
  formActions: { display: 'flex', gap: 8, marginTop: 4 },
  saveBtn: {
    flex: 1, padding: '10px 0', borderRadius: 10, border: 'none',
    background: 'var(--accent)', color: '#fff', fontSize: 13, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit'
  },
  cancelBtn: {
    padding: '10px 16px', borderRadius: 10, border: 'none',
    background: 'var(--border-light)', color: 'var(--text-secondary)', fontSize: 13,
    cursor: 'pointer', fontFamily: 'inherit'
  },
  categorySection: { marginBottom: 16 },
  categoryTitle: { fontSize: 14, fontWeight: 600, margin: '0 0 8px', color: 'var(--text-secondary)' },
  treatmentCard: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    background: 'var(--bg-card)', borderRadius: 12, padding: '12px 14px', marginBottom: 6,
    boxShadow: 'var(--shadow-xs, 0 1px 3px rgba(0,0,0,0.04))'
  },
  treatmentInfo: { flex: 1, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
  treatmentName: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' },
  treatmentMeta: { fontSize: 12, color: 'var(--text-muted)' },
  treatmentDesc: { fontSize: 11, color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  treatmentActions: { display: 'flex', gap: 6, marginLeft: 10, flexShrink: 0 },
  editBtn: {
    padding: '5px 10px', borderRadius: 6, border: 'none',
    background: 'var(--accent-light)', color: 'var(--accent)', fontSize: 11, fontWeight: 500,
    cursor: 'pointer', fontFamily: 'inherit'
  },
  deactivateBtn: {
    padding: '5px 10px', borderRadius: 6, border: 'none',
    background: 'var(--border-light)', color: 'var(--text-secondary)', fontSize: 11, fontWeight: 500,
    cursor: 'pointer', fontFamily: 'inherit'
  },
  reactivateBtn: {
    padding: '5px 10px', borderRadius: 6, border: 'none',
    background: 'var(--success-bg)', color: 'var(--success)', fontSize: 11, fontWeight: 500,
    cursor: 'pointer', fontFamily: 'inherit'
  },
  inactiveSection: { marginTop: 20 },
  inactiveToggle: {
    width: '100%', padding: '10px 0', background: 'none', border: 'none',
    color: 'var(--text-muted)', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit'
  },
  loadingText: { textAlign: 'center', color: 'var(--text-muted)', padding: 40, fontSize: 14 },
  emptyState: { textAlign: 'center', padding: '40px 20px' },
  emptyTitle: { fontSize: 16, fontWeight: 600, margin: '0 0 6px' },
  emptyDesc: { fontSize: 13, color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 }
};
