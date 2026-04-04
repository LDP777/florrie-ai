import { useState, useEffect, useCallback } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { API_BASE } from '../lib/config.js';
import { type as t } from '../lib/designSystem.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';

/**
 * ConsultationFormBuilder — create and edit consultation/consent forms.
 * Beautician can add fields: text, yes_no, multi_select, single_select, checkbox, text_block, signature.
 * Drag-to-reorder via sort_order. Matches Timely's form builder quality.
 *
 * Routes:
 *   /consultation-forms         — list all forms
 *   /consultation-forms/new     — create new form
 *   /consultation-forms/:id     — edit existing form
 */

const FIELD_TYPES = [
  { value: 'text', label: 'Short Answer', icon: '✏️', desc: 'Free text input' },
  { value: 'yes_no', label: 'Yes / No', icon: '✓✗', desc: 'Single yes or no answer' },
  { value: 'checkbox', label: 'Checkbox', icon: '☑️', desc: 'Tick to confirm (e.g. consent)' },
  { value: 'single_select', label: 'Choose One', icon: '◉', desc: 'Pick one from a list' },
  { value: 'multi_select', label: 'Choose Multiple', icon: '☐☐', desc: 'Tick all that apply' },
  { value: 'text_block', label: 'Text Block', icon: '📄', desc: 'Static info or consent paragraph' },
  { value: 'signature', label: 'Signature', icon: '🖊️', desc: 'Ask for a digital signature' },
];

function getToken() {
  // Supabase stores session under sb-<project-ref>-auth-token — find it by pattern
  const key = Object.keys(localStorage).find(k => /^sb-.+-auth-token$/.test(k));
  if (!key) return null;
  const raw = localStorage.getItem(key);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed?.access_token || parsed?.session?.access_token || raw;
  } catch { return raw; }
}

function authHeaders() {
  const t = getToken();
  return t ? { 'Authorization': `Bearer ${t}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' };
}

// ── Form List View ──────────────────────────────────────
function FormList() {
  const navigate = useNavigate();
  const [forms, setForms] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    fetch(`${API_BASE}/api/consultation-forms`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => setForms(d.forms || []))
      .catch(err => {
        console.error('Failed to load forms:', err);
        setError(err.message || 'Failed to load consultation forms');
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div style={styles.page}>
      {error && <ErrorCard message={error} onDismiss={() => setError(null)} />}
      <div style={styles.header}>
        <h1 style={t.displayMd}>Consultation Forms</h1>
        <p style={styles.subtitle}>Build custom forms clients fill in before their appointment</p>
      </div>

      <button style={styles.createBtn} onClick={() => navigate('/consultation-forms/new')}>
        + New Form
      </button>

      {loading ? (
        <PageLoader message="Loading forms..." />
      ) : forms.length === 0 ? (
        <EmptyState
          icon="📋"
          title="No forms yet"
          subtitle="Create a consultation form to collect client info, medical history, and consent before appointments."
          actionLabel="Create Your First Form"
          onAction={() => navigate('/consultation-forms/new')}
        />
      ) : (
        <div style={styles.formList}>
          {forms.map(form => (
            <button
              key={form.id}
              style={styles.formCard}
              onClick={() => navigate(`/consultation-forms/${form.id}`)}
            >
              <div style={styles.formCardLeft}>
                <span style={styles.formName}>{form.name}</span>
                <span style={styles.formMeta}>
                  {form.consultation_form_fields?.[0]?.count || 0} fields
                  {form.is_default && <span style={styles.defaultBadge}>Default</span>}
                </span>
              </div>
              <span style={styles.chevron}>›</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Form Editor View ────────────────────────────────────
function FormEditor() {
  const { id } = useParams();
  const navigate = useNavigate();
  const isNew = id === 'new';

  const [formName, setFormName] = useState('');
  const [consentText, setConsentText] = useState('');
  const [isDefault, setIsDefault] = useState(false);
  const [fields, setFields] = useState([]);
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(!isNew);
  const [showAddField, setShowAddField] = useState(false);
  const [editingField, setEditingField] = useState(null); // index or null

  // Load existing form
  useEffect(() => {
    if (isNew) return;
    fetch(`${API_BASE}/api/consultation-forms/${id}`, { headers: authHeaders() })
      .then(r => r.json())
      .then(d => {
        if (d.form) {
          setFormName(d.form.name);
          setConsentText(d.form.consent_text || '');
          setIsDefault(d.form.is_default);
          setFields((d.form.consultation_form_fields || []).map(f => ({
            type: f.type,
            label: f.label,
            options: f.options || [],
            required: f.required,
            sort_order: f.sort_order,
          })));
        }
      })
      .finally(() => setLoading(false));
  }, [id, isNew]);

  // Save form
  async function handleSave() {
    if (!formName.trim()) return;
    setSaving(true);

    const body = {
      name: formName.trim(),
      consent_text: consentText.trim() || null,
      is_default: isDefault,
      fields: fields.map((f, i) => ({ ...f, sort_order: i })),
    };

    try {
      const url = isNew
        ? `${API_BASE}/api/consultation-forms`
        : `${API_BASE}/api/consultation-forms/${id}`;
      const method = isNew ? 'POST' : 'PATCH';

      const res = await fetch(url, {
        method,
        headers: authHeaders(),
        body: JSON.stringify(body),
      });

      if (res.ok) {
        navigate('/consultation-forms');
      }
    } finally {
      setSaving(false);
    }
  }

  // Delete form
  async function handleDelete() {
    if (!confirm('Remove this form? Existing responses will be kept.')) return;
    await fetch(`${API_BASE}/api/consultation-forms/${id}`, {
      method: 'DELETE',
      headers: authHeaders(),
    });
    navigate('/consultation-forms');
  }

  // Add a new field
  function addField(type) {
    const newField = {
      type,
      label: '',
      options: type === 'multi_select' || type === 'single_select' ? [''] : [],
      required: type !== 'text_block',
      sort_order: fields.length,
    };
    setFields([...fields, newField]);
    setEditingField(fields.length);
    setShowAddField(false);
  }

  // Update a field
  function updateField(index, updates) {
    setFields(prev => prev.map((f, i) => i === index ? { ...f, ...updates } : f));
  }

  // Remove a field
  function removeField(index) {
    setFields(prev => prev.filter((_, i) => i !== index));
    setEditingField(null);
  }

  // Move field up/down
  function moveField(index, dir) {
    const newIndex = index + dir;
    if (newIndex < 0 || newIndex >= fields.length) return;
    const newFields = [...fields];
    [newFields[index], newFields[newIndex]] = [newFields[newIndex], newFields[index]];
    setFields(newFields);
    setEditingField(newIndex);
  }

  if (loading) return <div style={styles.page}><div style={styles.loadingState}>Loading form...</div></div>;

  return (
    <div style={styles.page}>
      {/* Header */}
      <div style={styles.editorHeader}>
        <button style={styles.backBtn} onClick={() => navigate('/consultation-forms')}>
          ← Back
        </button>
        <button style={styles.saveBtn} onClick={handleSave} disabled={saving || !formName.trim()}>
          {saving ? 'Saving...' : 'Save'}
        </button>
      </div>

      {/* Form name */}
      <input
        style={styles.formNameInput}
        value={formName}
        onChange={e => setFormName(e.target.value)}
        placeholder="Form name (e.g. Brow Consultation)"
      />

      {/* Default toggle */}
      <label style={styles.toggleRow}>
        <input
          type="checkbox"
          checked={isDefault}
          onChange={e => setIsDefault(e.target.checked)}
          style={styles.checkbox}
        />
        <span style={styles.toggleLabel}>
          Default form — auto-sent to all new clients
        </span>
      </label>

      {/* Fields */}
      <div style={styles.fieldsSection}>
        <h3 style={styles.sectionLabel}>Form Fields</h3>

        {fields.length === 0 && (
          <div style={styles.noFields}>
            No fields yet — tap "Add element" below to start building your form.
          </div>
        )}

        {fields.map((field, index) => (
          <FieldCard
            key={index}
            field={field}
            index={index}
            isEditing={editingField === index}
            onEdit={() => setEditingField(editingField === index ? null : index)}
            onUpdate={(updates) => updateField(index, updates)}
            onRemove={() => removeField(index)}
            onMove={(dir) => moveField(index, dir)}
            isFirst={index === 0}
            isLast={index === fields.length - 1}
          />
        ))}

        {/* Add element button */}
        <button style={styles.addElementBtn} onClick={() => setShowAddField(!showAddField)}>
          {showAddField ? '✕ Cancel' : '+ Add element'}
        </button>

        {/* Element type picker */}
        {showAddField && (
          <div style={styles.fieldTypePicker}>
            {FIELD_TYPES.map(ft => (
              <button
                key={ft.value}
                style={styles.fieldTypeBtn}
                onClick={() => addField(ft.value)}
              >
                <span style={styles.fieldTypeIcon}>{ft.icon}</span>
                <div>
                  <div style={styles.fieldTypeName}>{ft.label}</div>
                  <div style={styles.fieldTypeDesc}>{ft.desc}</div>
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* Consent text */}
      <div style={styles.consentSection}>
        <h3 style={styles.sectionLabel}>Consent Text (Optional)</h3>
        <p style={styles.sectionHint}>
          This paragraph appears at the bottom of the form before the signature field.
        </p>
        <textarea
          style={styles.consentTextarea}
          value={consentText}
          onChange={e => setConsentText(e.target.value)}
          placeholder="I certify that I have read and fully understand the above paragraphs..."
          rows={5}
        />
      </div>

      {/* Delete button (edit mode only) */}
      {!isNew && (
        <button style={styles.deleteBtn} onClick={handleDelete}>
          Delete Form
        </button>
      )}
    </div>
  );
}

// ── Field Card Component ────────────────────────────────
function FieldCard({ field, index, isEditing, onEdit, onUpdate, onRemove, onMove, isFirst, isLast }) {
  const typeInfo = FIELD_TYPES.find(ft => ft.value === field.type);

  return (
    <div style={{
      ...styles.fieldCard,
      ...(isEditing ? styles.fieldCardEditing : {}),
    }}>
      {/* Preview / collapsed */}
      <button style={styles.fieldCardHeader} onClick={onEdit}>
        <div style={styles.fieldCardLeft}>
          <span style={styles.fieldTypeTag}>{typeInfo?.label || field.type}</span>
          <span style={styles.fieldLabel}>
            {field.label || '(no label set)'}
            {field.required && <span style={styles.requiredStar}> *</span>}
          </span>
        </div>
        <span style={styles.editIcon}>{isEditing ? '▾' : '▸'}</span>
      </button>

      {/* Expanded editor */}
      {isEditing && (
        <div style={styles.fieldEditor}>
          {/* Label */}
          {field.type !== 'signature' && (
            <input
              style={styles.fieldInput}
              value={field.label}
              onChange={e => onUpdate({ label: e.target.value })}
              placeholder={field.type === 'text_block' ? 'Enter your text paragraph...' : 'Question text...'}
            />
          )}

          {/* Options for select types */}
          {(field.type === 'multi_select' || field.type === 'single_select') && (
            <div style={styles.optionsSection}>
              <span style={styles.optionsLabel}>Options:</span>
              {(field.options || []).map((opt, oi) => (
                <div key={oi} style={styles.optionRow}>
                  <input
                    style={styles.optionInput}
                    value={opt}
                    onChange={e => {
                      const newOpts = [...field.options];
                      newOpts[oi] = e.target.value;
                      onUpdate({ options: newOpts });
                    }}
                    placeholder={`Option ${oi + 1}`}
                  />
                  <button
                    style={styles.optionRemoveBtn}
                    onClick={() => onUpdate({ options: field.options.filter((_, i) => i !== oi) })}
                  >
                    ✕
                  </button>
                </div>
              ))}
              <button
                style={styles.addOptionBtn}
                onClick={() => onUpdate({ options: [...(field.options || []), ''] })}
              >
                + Add option
              </button>
            </div>
          )}

          {/* Required toggle (not for text_block or signature) */}
          {field.type !== 'text_block' && field.type !== 'signature' && (
            <label style={styles.toggleRow}>
              <input
                type="checkbox"
                checked={field.required}
                onChange={e => onUpdate({ required: e.target.checked })}
                style={styles.checkbox}
              />
              <span style={styles.toggleLabel}>Required</span>
            </label>
          )}

          {/* Actions */}
          <div style={styles.fieldActions}>
            <button style={styles.moveBtn} onClick={() => onMove(-1)} disabled={isFirst}>↑</button>
            <button style={styles.moveBtn} onClick={() => onMove(1)} disabled={isLast}>↓</button>
            <button style={styles.removeBtn} onClick={onRemove}>Remove</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main Export ─────────────────────────────────────────
export default function ConsultationFormBuilder() {
  const { id } = useParams();
  if (!id) return <FormList />;
  return <FormEditor />;
}

// ── Styles ──────────────────────────────────────────────
const styles = {
  page: {
    maxWidth: 540,
    margin: '0 auto',
    padding: '24px 16px 120px',
    animation: 'fadeIn 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
  },
  header: {
    marginBottom: 24,
  },
  subtitle: {
    fontSize: 14,
    color: 'var(--text-muted)',
    marginTop: 4,
  },
  loadingState: {
    textAlign: 'center',
    padding: 48,
    color: 'var(--text-muted)',
    fontSize: 14,
  },
  emptyState: {
    textAlign: 'center',
    padding: '48px 24px',
    background: 'var(--surface)',
    borderRadius: 16,
    border: '1px solid var(--border)',
  },
  emptyIcon: {
    fontSize: 40,
    marginBottom: 12,
  },
  emptyTitle: {
    fontSize: 18,
    fontWeight: 600,
    color: 'var(--text-primary)',
    margin: '0 0 8px',
  },
  emptyDesc: {
    fontSize: 14,
    color: 'var(--text-muted)',
    lineHeight: 1.5,
    marginBottom: 20,
  },
  createBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    padding: '12px 24px',
    background: 'var(--accent)',
    color: 'var(--bg-card, #fff)',
    border: 'none',
    borderRadius: 12,
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    marginBottom: 20,
  },
  formList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  formCard: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    padding: '16px 20px',
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 12,
    cursor: 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left',
    WebkitTapHighlightColor: 'transparent',
    transition: 'background 0.15s',
  },
  formCardLeft: {
    display: 'flex',
    flexDirection: 'column',
    gap: 4,
  },
  formName: {
    fontSize: 16,
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  formMeta: {
    fontSize: 13,
    color: 'var(--text-muted)',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
  },
  defaultBadge: {
    background: 'var(--accent)',
    color: 'var(--bg-card, #fff)',
    fontSize: 11,
    fontWeight: 600,
    padding: '2px 8px',
    borderRadius: 6,
  },
  chevron: {
    fontSize: 20,
    color: 'var(--text-muted)',
  },

  // Editor
  editorHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 20,
  },
  backBtn: {
    background: 'none',
    border: 'none',
    fontSize: 15,
    color: 'var(--accent)',
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    padding: '8px 0',
  },
  saveBtn: {
    padding: '10px 24px',
    background: 'var(--accent)',
    color: 'var(--bg-card, #fff)',
    border: 'none',
    borderRadius: 10,
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  formNameInput: {
    width: '100%',
    fontSize: 22,
    fontWeight: 600,
    fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)",
    color: 'var(--text-primary)',
    background: 'none',
    border: 'none',
    borderBottom: '2px solid var(--border)',
    padding: '8px 0',
    marginBottom: 16,
    outline: 'none',
    boxSizing: 'border-box',
  },
  toggleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '8px 0',
    cursor: 'pointer',
  },
  checkbox: {
    width: 18,
    height: 18,
    accentColor: 'var(--accent)',
  },
  toggleLabel: {
    fontSize: 14,
    color: 'var(--text-secondary)',
  },

  // Fields section
  fieldsSection: {
    marginTop: 28,
  },
  sectionLabel: {
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    marginBottom: 12,
  },
  sectionHint: {
    fontSize: 13,
    color: 'var(--text-muted)',
    marginBottom: 8,
    lineHeight: 1.4,
  },
  noFields: {
    padding: 24,
    textAlign: 'center',
    color: 'var(--text-muted)',
    fontSize: 14,
    background: 'var(--surface)',
    borderRadius: 12,
    border: '1px dashed var(--border)',
    marginBottom: 12,
  },

  // Field card
  fieldCard: {
    background: 'var(--surface)',
    border: '1px solid var(--border)',
    borderRadius: 12,
    marginBottom: 8,
    overflow: 'hidden',
    transition: 'border-color 0.15s',
  },
  fieldCardEditing: {
    borderColor: 'var(--accent)',
    boxShadow: '0 0 0 1px var(--accent)',
  },
  fieldCardHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    width: '100%',
    padding: '14px 16px',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left',
    WebkitTapHighlightColor: 'transparent',
  },
  fieldCardLeft: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
    flex: 1,
    minWidth: 0,
  },
  fieldTypeTag: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--accent)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  fieldLabel: {
    fontSize: 14,
    color: 'var(--text-primary)',
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  requiredStar: {
    color: 'var(--danger, #e74c3c)',
    fontWeight: 700,
  },
  editIcon: {
    fontSize: 16,
    color: 'var(--text-muted)',
    marginLeft: 8,
  },

  // Field editor (expanded)
  fieldEditor: {
    padding: '0 16px 16px',
    borderTop: '1px solid var(--border)',
  },
  fieldInput: {
    width: '100%',
    fontSize: 14,
    padding: '10px 12px',
    border: '1px solid var(--border)',
    borderRadius: 8,
    marginTop: 12,
    fontFamily: 'inherit',
    background: 'var(--bg)',
    color: 'var(--text-primary)',
    boxSizing: 'border-box',
    outline: 'none',
  },
  optionsSection: {
    marginTop: 12,
  },
  optionsLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--text-muted)',
    display: 'block',
    marginBottom: 6,
  },
  optionRow: {
    display: 'flex',
    gap: 6,
    marginBottom: 6,
  },
  optionInput: {
    flex: 1,
    fontSize: 14,
    padding: '8px 10px',
    border: '1px solid var(--border)',
    borderRadius: 6,
    fontFamily: 'inherit',
    background: 'var(--bg)',
    color: 'var(--text-primary)',
    outline: 'none',
  },
  optionRemoveBtn: {
    padding: '8px 10px',
    background: 'none',
    border: '1px solid var(--border)',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 13,
    color: 'var(--text-muted)',
    fontFamily: 'inherit',
  },
  addOptionBtn: {
    fontSize: 13,
    color: 'var(--accent)',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontWeight: 600,
    fontFamily: 'inherit',
    padding: '4px 0',
  },
  fieldActions: {
    display: 'flex',
    gap: 8,
    marginTop: 12,
    paddingTop: 12,
    borderTop: '1px solid var(--border)',
  },
  moveBtn: {
    padding: '6px 14px',
    background: 'var(--bg)',
    border: '1px solid var(--border)',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 14,
    fontFamily: 'inherit',
    color: 'var(--text-primary)',
  },
  removeBtn: {
    padding: '6px 14px',
    background: 'none',
    border: '1px solid var(--danger, #e74c3c)',
    borderRadius: 6,
    cursor: 'pointer',
    fontSize: 13,
    fontWeight: 600,
    fontFamily: 'inherit',
    color: 'var(--danger, #e74c3c)',
    marginLeft: 'auto',
  },

  // Add element
  addElementBtn: {
    width: '100%',
    padding: 14,
    background: 'var(--accent)',
    color: 'var(--bg-card, #fff)',
    border: 'none',
    borderRadius: 12,
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    marginTop: 8,
  },
  fieldTypePicker: {
    display: 'flex',
    flexDirection: 'column',
    gap: 6,
    marginTop: 8,
    padding: 12,
    background: 'var(--surface)',
    borderRadius: 12,
    border: '1px solid var(--border)',
  },
  fieldTypeBtn: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '12px 14px',
    background: 'var(--bg)',
    border: '1px solid var(--border)',
    borderRadius: 8,
    cursor: 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left',
    WebkitTapHighlightColor: 'transparent',
    transition: 'border-color 0.15s',
  },
  fieldTypeIcon: {
    fontSize: 18,
    width: 28,
    textAlign: 'center',
  },
  fieldTypeName: {
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  fieldTypeDesc: {
    fontSize: 12,
    color: 'var(--text-muted)',
  },

  // Consent section
  consentSection: {
    marginTop: 32,
  },
  consentTextarea: {
    width: '100%',
    fontSize: 14,
    padding: '12px 14px',
    border: '1px solid var(--border)',
    borderRadius: 10,
    fontFamily: 'inherit',
    background: 'var(--surface)',
    color: 'var(--text-primary)',
    lineHeight: 1.6,
    resize: 'vertical',
    outline: 'none',
    boxSizing: 'border-box',
    minHeight: 120,
  },

  // Delete
  deleteBtn: {
    width: '100%',
    padding: 14,
    background: 'none',
    border: '1px solid var(--danger, #e74c3c)',
    borderRadius: 12,
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
    color: 'var(--danger, #e74c3c)',
    marginTop: 32,
  },
};
