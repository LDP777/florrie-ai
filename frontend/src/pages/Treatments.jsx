import { useState, useEffect, Fragment } from 'react';
import { useBeautician, fetchRows, insertRow, updateRow, supabase } from '../lib/supabase.js';
import { formatCurrency, formatDuration } from '../lib/formatting.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import PageHeader from '../components/ui/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import { TREATMENT_PALETTE, treatmentColor } from '../lib/treatmentColors.js';
import ErrorCard from '../components/ErrorCard.jsx';
import { API_BASE } from '../lib/config.js';
import Icon, { iconName } from '../components/ui/Icon';
import DragList, { DragHandle } from '../components/ui/DragList.jsx';

/**
 * Treatments - manage treatment menu.
 * Wired to Supabase.
 */

const CATEGORIES = [
  { value: 'brows', label: 'Brows', icon: 'scissors' },
  { value: 'lashes', label: 'Lashes', icon: 'eye' },
  { value: 'nails', label: 'Nails', icon: 'sparkles' },
  { value: 'skin', label: 'Skin', icon: 'sparkle' },
  { value: 'waxing', label: 'Waxing', icon: 'flower' },
  { value: 'makeup', label: 'Makeup', icon: 'palette' },
  { value: 'hair', label: 'Hair', icon: 'scissors' },
  { value: 'other', label: 'Other', icon: 'flower' }
];

const catIcon = (cat) => CATEGORIES.find(c => c.value === cat)?.icon || 'flower';
const catLabel = (cat) => CATEGORIES.find(c => c.value === cat)?.label || cat;

export default function Treatments() {
  const { beautician, loading: bLoading } = useBeautician();
  const [treatments, setTreatments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showInactive, setShowInactive] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [reordering, setReordering] = useState(false);
  const [reorderBusy, setReorderBusy] = useState(false);
  const [forms, setForms] = useState([]); // Ellie's built consultation forms

  const blank = {
    name: '', duration_minutes: 60, price_cents: '', deposit_cents: '', deposit_percent: '',
    category: 'brows', description: '', buffer_minutes: 0,
    requires_consultation: false, requires_patch_test: false, no_show_fee: '', booking_enabled: true,
    consultation_form_id: '',
    color: null,
  };
  const [form, setForm] = useState(blank);
  // "Preview as a new client" modal: loads the linked consultation form's real
  // questions via the same public endpoint the booking page uses, so Ellie sees
  // exactly what a new client gets.
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState(null);
  const [previewForm, setPreviewForm] = useState(null); // { name, consent_text, consultation_form_fields[] }

  async function openPreview() {
    setPreviewOpen(true);
    setPreviewError(null);
    setPreviewForm(null);
    const slug = beautician?.booking_slug;
    const formId = form.consultation_form_id;
    if (!slug || !formId) {
      setPreviewError('Add a booking link in Settings, then choose a form, to preview it.');
      return;
    }
    setPreviewLoading(true);
    try {
      // Identical call to BookingPage.jsx (public, slug-scoped). Faithful questions.
      const res = await fetch(`${API_BASE}/api/booking/${slug}/consultation-form/${formId}`);
      const data = await res.json();
      if (res.ok && data.form) {
        setPreviewForm(data.form);
      } else {
        setPreviewError("Couldn't load this form. Check it's active in Form Builder.");
      }
    } catch (err) {
      logger.error('Preview form error:', err);
      setPreviewError("Couldn't load this form right now.");
    } finally {
      setPreviewLoading(false);
    }
  }

  // Map stored fields to the same question shape BookingPage renders.
  const previewQuestions = (previewForm?.consultation_form_fields || []).map(f => ({
    key: f.id,
    label: f.label,
    type: f.type,
    options: f.options || [],
    required: f.required,
  }));

  useEffect(() => {
    if (beautician) loadTreatments();
  }, [beautician]);

  async function loadTreatments() {
    try {
      const data = await fetchRows('treatments', beautician.id, { order: 'sort_order' });
      setTreatments(data);
      // Ellie's consultation forms, so a treatment can be linked to the form she
      // built (otherwise the booking page falls back to generic questions).
      // Loaded through the backend (same as Form Builder) because RLS blocks a
      // direct table read from the browser - a direct read comes back empty and
      // the form picker silently never renders.
      try {
        const { data: { session } } = await supabase.auth.getSession();
        const res = await fetch(`${API_BASE}/api/consultation-forms`, {
          headers: session?.access_token ? { Authorization: `Bearer ${session.access_token}` } : {},
        });
        const body = await res.json().catch(() => ({}));
        setForms(res.ok ? (body.forms || []) : []);
      } catch { setForms([]); }
    } catch (err) {
      logger.error('Load treatments error:', err);
      setTreatments([]);
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
      requires_patch_test: form.requires_patch_test || false,
      booking_enabled: form.booking_enabled !== false,
      // Link the chosen form so the booking page shows Ellie's own questions.
      // Cleared when consultation isn't required.
      consultation_form_id: form.requires_consultation ? (form.consultation_form_id || null) : null,
      // null = auto-assigned from the palette in the UI.
      color: form.color || null,
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

  /**
   * Commit a reordered category.
   *
   * treatments.sort_order has existed since the initial schema, and both this
   * list and the public booking page already order by it. Nothing had ever
   * written it, so every row sat at the default 0 and the order was whatever
   * Postgres returned.
   *
   * Called once on release rather than on every row the finger passes, and it
   * rewrites the whole category so the indexes stay contiguous instead of
   * accumulating gaps. Local state is already showing the new order, so a
   * failed write reloads rather than leaving the screen disagreeing with the
   * database.
   */
  async function persistOrder(reordered) {
    const orderById = new Map(reordered.map((t, i) => [t.id, i]));
    setTreatments(prev => {
      const next = prev.map(t => orderById.has(t.id) ? { ...t, sort_order: orderById.get(t.id) } : t);
      return [...next].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    });
    setReorderBusy(true);
    try {
      await Promise.all(reordered.map((t, i) => updateRow('treatments', t.id, { sort_order: i })));
    } catch (err) {
      logger.error('Reorder error:', err);
      loadTreatments();
    } finally {
      setReorderBusy(false);
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
      requires_patch_test: t.requires_patch_test || false,
      no_show_fee: t.no_show_fee_cents ? (t.no_show_fee_cents / 100).toFixed(2) : '',
      booking_enabled: t.booking_enabled !== false,
      consultation_form_id: t.consultation_form_id || '',
      color: t.color || null,
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

  // One row definition, rendered either inside the drag list or on its own, so
  // the two can never drift apart.
  const renderRow = (t, handleProps) => (
    <div style={styles.treatmentCard}>
      {handleProps && <DragHandle handleProps={handleProps} label={`Reorder ${t.name}`} />}
      <div style={styles.treatmentInfo}>
        <span style={styles.treatmentNameRow}>
          <span style={{ ...styles.colorDot, background: treatmentColor(t) }} />
          <span style={styles.treatmentName}>{t.name}</span>
        </span>
        <span style={styles.treatmentMeta}>
          {t.duration_minutes} min{t.buffer_minutes > 0 && ` + ${t.buffer_minutes} buffer`} · {formatCurrency(t.price_cents)}
          {t.deposit_percent > 0 ? ` · ${t.deposit_percent}% deposit` : t.deposit_cents > 0 ? ` · ${formatCurrency(t.deposit_cents)} deposit` : ''}
        </span>
        {t.requires_consultation && (
          <span style={styles.consultBadge}>
            <Icon name="file" size={12} /> Consultation required
          </span>
        )}
        {t.requires_patch_test && (
          <span style={{ ...styles.consultBadge, background: 'rgba(201,169,110,0.12)', color: 'var(--gold, #8A6420)' }}>
            <Icon name="syringe" size={12} /> Patch test required
          </span>
        )}
        {t.description && <span style={styles.treatmentDesc}>{t.description}</span>}
      </div>
      {!handleProps && (
        <div style={styles.treatmentActions}>
          <button onClick={() => startEdit(t)} style={styles.editBtn}>Edit</button>
          <button onClick={() => handleToggleActive(t.id, true)} style={styles.deactivateBtn}>Hide</button>
        </div>
      )}
    </div>
  );

  if (bLoading || loading) return <p style={styles.loadingText}>Loading treatments...</p>;

  return (
    <div style={styles.page}>
      <PageHeader
        title="Treatments"
        action={(
          <>
          <button
            onClick={() => { setReordering(r => !r); setShowAdd(false); setEditing(null); }}
            style={reordering ? styles.reorderBtnOn : styles.reorderBtn}
          >
            {reordering ? 'Done' : 'Reorder'}
          </button>
          <button onClick={() => { setShowAdd(!showAdd); setEditing(null); setForm(blank); setReordering(false); }} style={styles.addBtn}>
            + Add
          </button>
          </>
        )}
      />

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
          <span style={{ ...styles.formHint, display: 'block', marginTop: -8, marginBottom: 8 }}>Overrides the default deposit set in Settings → Payments</span>
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

          <div style={styles.formGroup}>
            <label style={styles.formLabel}>Calendar colour</label>
            <div style={styles.swatchRow}>
              <button
                type="button"
                onClick={() => setForm(p => ({ ...p, color: null }))}
                style={{ ...styles.autoSwatch,
                  borderColor: !form.color ? 'var(--accent)' : 'var(--border)',
                  color: !form.color ? 'var(--accent)' : 'var(--text-muted)',
                }}
              >
                Auto
              </button>
              {TREATMENT_PALETTE.map(c => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setForm(p => ({ ...p, color: c }))}
                  aria-label={`Use colour ${c}`}
                  style={{ ...styles.swatch,
                    background: c,
                    outline: form.color === c ? '2px solid var(--accent)' : '2px solid transparent',
                    outlineOffset: 2,
                  }}
                />
              ))}
            </div>
            <span style={styles.formHint}>Auto picks a distinct colour for you. Pick one to set it yourself.</span>
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
                style={{ ...styles.toggleBtn,
                  background: form.requires_consultation ? 'var(--accent)' : 'var(--border)',
                  color: form.requires_consultation ? '#fff' : 'var(--text-secondary, #574A42)'
                }}
              >
                {form.requires_consultation ? 'Required' : 'Not needed'}
              </button>
              <span style={styles.formHint}>Send questions before appointment</span>
              {form.requires_consultation && (
                forms.length > 0 ? (
                  <select
                    value={form.consultation_form_id || ''}
                    onChange={e => setForm(p => ({ ...p, consultation_form_id: e.target.value }))}
                    style={{ ...styles.formInput, marginTop: 6 }}
                  >
                    <option value="">Default questions</option>
                    {forms.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
                  </select>
                ) : (
                  <span style={{ ...styles.formHint, marginTop: 6, display: 'block' }}>
                    Build a form in Form Builder to use your own questions.
                  </span>
                )
              )}
              {form.requires_consultation && (
                <div style={{ marginTop: 8, padding: '8px 10px', background: 'var(--accent-wash, #FBF2F5)', borderRadius: 8, display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                  <Icon name={iconName('verified')} size={16} inline style={{ color: 'var(--accent)', flexShrink: 0 }} />
                  <span style={{ fontSize: 12, color: 'var(--text, #241B17)', lineHeight: 1.45 }}>
                    New clients booking this online get {(() => { const n = forms.find(f => f.id === form.consultation_form_id)?.name; return n ? `the "${n}" form` : 'your questions'; })()} to complete first. Returning clients are not asked again.
                  </span>
                </div>
              )}
              {form.requires_consultation && form.consultation_form_id && (
                <button
                  type="button"
                  onClick={openPreview}
                  style={styles.previewBtn}
                >
                  <Icon name={iconName('visibility')} size={16} inline />
                  Preview as a new client
                </button>
              )}
            </div>
            <div style={styles.formGroup}>
              <label style={styles.formLabel}>Patch test</label>
              <button
                type="button"
                onClick={() => setForm(p => ({ ...p, requires_patch_test: !p.requires_patch_test }))}
                style={{ ...styles.toggleBtn,
                  background: form.requires_patch_test ? 'var(--accent)' : 'var(--border)',
                  color: form.requires_patch_test ? '#fff' : 'var(--text-secondary, #574A42)'
                }}
              >
                {form.requires_patch_test ? 'Required' : 'Not needed'}
              </button>
              <span style={styles.formHint}>For dye treatments - client must patch test 48h before</span>
            </div>
          </div>

          <div style={styles.formGroup}>
            <label style={styles.formLabel}>Description</label>
            <input
              type="text"
              value={form.description}
              onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
              placeholder="Optional - shown on booking page"
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
                style={{ ...styles.toggleBtn,
                  background: form.booking_enabled !== false ? 'var(--accent)' : 'var(--border)',
                  color: form.booking_enabled !== false ? '#fff' : 'var(--text-secondary, #574A42)'
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
                <Icon name={catIcon(cat)} size={15} />
                {catLabel(cat)}
              </h3>
              {reordering ? (
                <DragList
                  items={grouped[cat]}
                  getKey={t => t.id}
                  gap={8}
                  onReorder={persistOrder}
                  renderItem={(t, { handleProps }) => renderRow(t, handleProps)}
                />
              ) : grouped[cat].map(t => <Fragment key={t.id}>{renderRow(t)}</Fragment>)}
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
                    <span style={styles.treatmentNameRow}>
                      <span style={{ ...styles.colorDot, background: treatmentColor(t) }} />
                      <span style={styles.treatmentName}>{t.name}</span>
                    </span>
                    <span style={styles.treatmentMeta}>
                      {t.duration_minutes} min · {formatCurrency(t.price_cents)}
                    </span>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    {/* Imported treatments land here at £0. Let Ellie fix the price
                        (and duration) without restoring; editing keeps it hidden. */}
                    <button onClick={() => startEdit(t)} style={styles.editBtn}>Edit</button>
                    <button
                      onClick={() => handleToggleActive(t.id, false)}
                      style={styles.reactivateBtn}
                    >
                      Restore
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Preview as a new client: read-only render of the linked form's real
          questions, mirroring the booking page. Non-submitting, preview only. */}
      {previewOpen && (
        <div style={styles.previewOverlay} onClick={() => setPreviewOpen(false)}>
          <div style={styles.previewSheet} onClick={e => e.stopPropagation()}>
            <div style={styles.previewHeader}>
              <div>
                <h3 style={styles.previewTitle}>This is what a new client sees</h3>
                <p style={styles.previewSub}>
                  Returning clients skip this. They are never asked again.
                </p>
              </div>
              <button type="button" onClick={() => setPreviewOpen(false)} aria-label="Close" style={styles.previewClose}>
                <Icon name={iconName('close')} inline />
              </button>
            </div>

            <div style={styles.previewBody}>
              {previewLoading && (
                <p style={styles.previewMuted}>Loading the form...</p>
              )}
              {previewError && (
                <p style={styles.previewMuted}>{previewError}</p>
              )}
              {previewForm && !previewLoading && !previewError && (
                <>
                  <h4 style={styles.previewFormName}>{previewForm.name || 'Consultation form'}</h4>
                  {previewForm.consent_text && (
                    <p style={styles.previewConsent}>{previewForm.consent_text}</p>
                  )}
                  {previewQuestions.length === 0 && (
                    <p style={styles.previewMuted}>This form has no questions yet. Add some in Form Builder.</p>
                  )}
                  {previewQuestions.map(q => (
                    <div key={q.key} style={{ marginBottom: 16 }}>
                      <label style={styles.previewQLabel}>
                        {q.label}{q.required && <span style={{ color: 'var(--danger, #9E2B32)' }}> *</span>}
                      </label>

                      {/* Yes / No */}
                      {q.type === 'yes_no' && (
                        <div style={{ display: 'flex', gap: 8 }}>
                          {['Yes', 'No'].map(opt => (
                            <span key={opt} style={styles.previewChoice}>{opt}</span>
                          ))}
                        </div>
                      )}

                      {/* Single select */}
                      {q.type === 'single_select' && q.options?.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                          {q.options.map(opt => (
                            <span key={opt} style={styles.previewChoice}>{opt}</span>
                          ))}
                        </div>
                      )}

                      {/* Multi select */}
                      {q.type === 'multi_select' && q.options?.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                          {q.options.map(opt => (
                            <span key={opt} style={styles.previewChoice}>{opt}</span>
                          ))}
                        </div>
                      )}

                      {/* Checkbox */}
                      {q.type === 'checkbox' && (
                        <span style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: 'var(--text-secondary)' }}>
                          <span style={styles.previewCheckbox} />
                          I confirm
                        </span>
                      )}

                      {/* Text block */}
                      {q.type === 'text_block' && (
                        <div style={{ ...styles.previewInputGhost, minHeight: 64 }}>
                          <span style={styles.previewGhostText}>Type here...</span>
                        </div>
                      )}

                      {/* Signature */}
                      {q.type === 'signature' && (
                        <div>
                          <div style={styles.previewInputGhost}>
                            <span style={{ ...styles.previewGhostText, fontFamily: "'Brush Script MT', 'Segoe Script', cursive", fontSize: 18 }}>
                              Type your full name to sign
                            </span>
                          </div>
                          <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: '4px 0 0' }}>Typing their name here counts as their signature.</p>
                        </div>
                      )}

                      {/* Default: text input */}
                      {(q.type === 'text' || (!['yes_no', 'single_select', 'multi_select', 'checkbox', 'text_block', 'signature'].includes(q.type))) && (
                        <div style={styles.previewInputGhost}>
                          <span style={styles.previewGhostText}>Type here...</span>
                        </div>
                      )}
                    </div>
                  ))}
                </>
              )}
            </div>

            <div style={styles.previewFooter}>
              <span style={styles.previewMutedSmall}>Preview only. Nothing is sent or saved.</span>
              <button type="button" onClick={() => setPreviewOpen(false)} style={styles.previewDoneBtn}>Done</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const styles = {
  page: {
    minHeight: 'var(--shell-viewport)', background: 'var(--bg)',
    fontFamily: "var(--font-body, 'Plus Jakarta Sans', -apple-system, sans-serif)",
    padding: '0 16px var(--scroll-pad-bottom)', maxWidth: 480, margin: '0 auto', color: 'var(--text-primary)',
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
  categoryTitle: {
    display: 'flex', alignItems: 'center', gap: 7,
    fontSize: 14, fontWeight: 600, margin: '0 0 8px', color: 'var(--text-secondary)',
  },
  reorderBtn: {
    minHeight: 36, padding: '0 14px', marginRight: 8, borderRadius: 999,
    border: '1px solid var(--border)', background: 'var(--bg-card)',
    color: 'var(--accent)', fontSize: 13, fontWeight: 600,
    fontFamily: 'inherit', cursor: 'pointer',
  },
  reorderBtnOn: {
    minHeight: 36, padding: '0 14px', marginRight: 8, borderRadius: 999,
    border: '1px solid var(--accent)', background: 'var(--accent)',
    color: '#fff', fontSize: 13, fontWeight: 600,
    fontFamily: 'inherit', cursor: 'pointer',
  },
  treatmentCard: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    background: 'var(--bg-card)', borderRadius: 12, padding: '12px 14px', marginBottom: 6,
    boxShadow: 'var(--shadow-xs, 0 1px 3px rgba(0,0,0,0.04))'
  },
  treatmentInfo: { flex: 1, display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
  treatmentName: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary)' },
  treatmentNameRow: { display: 'flex', alignItems: 'center', gap: 8 },
  colorDot: { width: 10, height: 10, borderRadius: '50%', flexShrink: 0 },
  swatchRow: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  swatch: { width: 26, height: 26, borderRadius: '50%', border: 'none', cursor: 'pointer', padding: 0 },
  autoSwatch: { height: 26, padding: '0 12px', borderRadius: 13, border: '1.5px solid var(--border)', background: 'var(--bg-card)', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
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
  emptyDesc: { fontSize: 13, color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 },
  previewBtn: {
    marginTop: 8, width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center',
    gap: 6, padding: '9px 12px', borderRadius: 8,
    border: '1.5px solid var(--accent)', background: 'transparent', color: 'var(--accent)',
    fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit'
  },
  previewOverlay: {
    position: 'fixed', inset: 0, zIndex: 1000,
    background: 'rgba(29,27,25,0.45)', display: 'flex',
    alignItems: 'flex-end', justifyContent: 'center',
    animation: 'fadeIn 0.2s ease'
  },
  previewSheet: {
    width: '100%', maxWidth: 480, maxHeight: '88vh',
    background: 'var(--bg, #FBF6F1)', borderTopLeftRadius: 20, borderTopRightRadius: 20,
    display: 'flex', flexDirection: 'column', overflow: 'hidden',
    boxShadow: '0 -8px 40px rgba(0,0,0,0.18)',
    fontFamily: "var(--font-body, 'Plus Jakarta Sans', -apple-system, sans-serif)"
  },
  previewHeader: {
    display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
    gap: 12, padding: '18px 18px 14px', borderBottom: '1px solid var(--border-light)'
  },
  previewTitle: {
    margin: 0, fontSize: 18, fontWeight: 700, color: 'var(--text-primary, #241B17)',
    fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)"
  },
  previewSub: { margin: '4px 0 0', fontSize: 12, color: 'var(--text-muted)', lineHeight: 1.4 },
  previewClose: {
    flexShrink: 0, width: 32, height: 32, borderRadius: '50%', border: 'none',
    background: 'var(--border-light)', color: 'var(--text-secondary)',
    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0
  },
  previewBody: { padding: '16px 18px', overflowY: 'auto', flex: 1 },
  previewFormName: {
    margin: '0 0 12px', fontSize: 15, fontWeight: 700, color: 'var(--accent)',
    fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)"
  },
  previewConsent: {
    fontSize: 12, color: 'var(--text-secondary)', marginBottom: 16, lineHeight: 1.5,
    padding: '10px 12px', background: 'var(--bg-card, #FFFCF9)', borderRadius: 8,
    border: '1px solid var(--border-light)'
  },
  previewQLabel: { display: 'block', fontSize: 13, fontWeight: 500, color: 'var(--text-primary, #241B17)', marginBottom: 6 },
  previewChoice: {
    padding: '8px 14px', borderRadius: 8, background: 'var(--bg-card, #FFFCF9)',
    border: '1px solid var(--border)', fontSize: 13, color: 'var(--text-secondary)'
  },
  previewCheckbox: {
    width: 18, height: 18, borderRadius: 4, border: '1.5px solid var(--border)',
    background: 'var(--bg-card, #FFFCF9)', display: 'inline-block', flexShrink: 0
  },
  previewInputGhost: {
    width: '100%', padding: '10px 12px', borderRadius: 8,
    border: '1.5px solid var(--border)', background: 'var(--bg-card, #FFFCF9)',
    boxSizing: 'border-box', display: 'flex', alignItems: 'flex-start'
  },
  previewGhostText: { fontSize: 14, color: 'var(--text-muted, #6B5D54)' },
  previewMuted: { fontSize: 13, color: 'var(--text-muted)', textAlign: 'center', padding: '20px 0' },
  previewMutedSmall: { fontSize: 11, color: 'var(--text-muted)' },
  previewFooter: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
    padding: '14px 18px', borderTop: '1px solid var(--border-light)'
  },
  previewDoneBtn: {
    padding: '10px 22px', borderRadius: 10, border: 'none',
    background: 'var(--accent)', color: '#fff', fontSize: 14, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit'
  },
};
