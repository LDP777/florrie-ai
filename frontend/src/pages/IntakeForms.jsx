import { useState, useEffect } from 'react';
import { useBeautician, supabase, isDevMode, insertRow } from '../lib/supabase.js';
import logger from '../lib/logger.js';

/**
 * Intake & Consent Forms — Pre-appointment questionnaires.
 *
 * Beauticians create form templates with different field types.
 * Forms are sent to clients before their appointment (or filled in-salon on a tablet).
 * Completed forms are stored and linked to the client.
 *
 * Tabs:
 *   Templates  — reusable form templates
 *   Responses  — completed forms from clients
 *   Create     — build a new form
 */

const FIELD_TYPES = [
  { type: 'text', label: 'Short answer', icon: '✏️' },
  { type: 'textarea', label: 'Long answer', icon: '📝' },
  { type: 'yes_no', label: 'Yes / No', icon: '✅' },
  { type: 'checkbox', label: 'Checkboxes', icon: '☑️' },
  { type: 'signature', label: 'Signature', icon: '🖊️' },
  { type: 'date', label: 'Date', icon: '📅' },
];

const DEV_TEMPLATES = [
  {
    id: 'form-1',
    name: 'Brow Treatment Consent',
    description: 'Consent + medical history for lamination and tinting',
    treatments: ['dev-t1', 'dev-t2', 'dev-t3', 'dev-t4', 'dev-t5', 'dev-t6'],
    auto_send: true,
    send_hours_before: 24,
    fields: [
      { id: 'f1', type: 'yes_no', label: 'Have you had a patch test in the last 6 months?', required: true },
      { id: 'f2', type: 'yes_no', label: 'Do you have any allergies to dyes or adhesives?', required: true },
      { id: 'f3', type: 'yes_no', label: 'Are you currently pregnant or breastfeeding?', required: true },
      { id: 'f4', type: 'yes_no', label: 'Have you used retinol or AHAs on your brows in the last 7 days?', required: true },
      { id: 'f5', type: 'textarea', label: 'Any skin conditions or medications we should know about?', required: false },
      { id: 'f6', type: 'text', label: 'Emergency contact name & number', required: true },
      { id: 'f7', type: 'signature', label: 'I consent to the treatment and confirm the above is accurate', required: true },
    ],
    created_at: '2026-01-10T10:00:00Z',
    response_count: 24,
  },
  {
    id: 'form-2',
    name: 'Semi-Permanent Brow Consent',
    description: 'Extended consent for ombre & combination brows',
    treatments: ['dev-t7', 'dev-t8'],
    auto_send: true,
    send_hours_before: 48,
    fields: [
      { id: 'f1', type: 'yes_no', label: 'Have you had a patch test in the last 6 months?', required: true },
      { id: 'f2', type: 'yes_no', label: 'Are you pregnant, breastfeeding, or planning to become pregnant?', required: true },
      { id: 'f3', type: 'yes_no', label: 'Do you have diabetes, auto-immune conditions, or take blood thinners?', required: true },
      { id: 'f4', type: 'yes_no', label: 'Have you had any cosmetic procedures on your brow area in the last 6 months?', required: true },
      { id: 'f5', type: 'checkbox', label: 'I understand:', options: ['Results vary per skin type', 'A top-up is included at 6 weeks', 'I must follow aftercare instructions', 'Colour will appear darker initially and lighten during healing'], required: true },
      { id: 'f6', type: 'textarea', label: 'Medical conditions, allergies, or medications', required: false },
      { id: 'f7', type: 'text', label: 'Emergency contact', required: true },
      { id: 'f8', type: 'text', label: 'GP name & surgery (for semi-permanent treatments)', required: true },
      { id: 'f9', type: 'signature', label: 'I consent to the treatment described above', required: true },
    ],
    created_at: '2026-01-15T10:00:00Z',
    response_count: 8,
  },
  {
    id: 'form-3',
    name: 'Lash Lift Consent',
    description: 'Quick consent for lash lift & tint',
    treatments: ['dev-t13'],
    auto_send: true,
    send_hours_before: 24,
    fields: [
      { id: 'f1', type: 'yes_no', label: 'Have you had a patch test in the last 6 months?', required: true },
      { id: 'f2', type: 'yes_no', label: 'Do you wear contact lenses? (Please remove before treatment)', required: false },
      { id: 'f3', type: 'yes_no', label: 'Any eye infections or sensitivity in the last 2 weeks?', required: true },
      { id: 'f4', type: 'yes_no', label: 'Are you pregnant or breastfeeding?', required: true },
      { id: 'f5', type: 'signature', label: 'I consent to the lash lift & tint treatment', required: true },
    ],
    created_at: '2026-02-01T10:00:00Z',
    response_count: 15,
  },
];

const DEV_RESPONSES = [
  { id: 'resp-1', form_id: 'form-1', form_name: 'Brow Treatment Consent', client_name: 'Shauna', submitted_at: '2026-03-24T09:00:00Z', status: 'complete', appointment_date: '2026-03-24' },
  { id: 'resp-2', form_id: 'form-1', form_name: 'Brow Treatment Consent', client_name: 'Daisy S', submitted_at: '2026-03-22T18:30:00Z', status: 'complete', appointment_date: '2026-03-23' },
  { id: 'resp-3', form_id: 'form-2', form_name: 'Semi-Permanent Brow Consent', client_name: 'Jasmin', submitted_at: '2026-03-20T10:00:00Z', status: 'complete', appointment_date: '2026-03-22' },
  { id: 'resp-4', form_id: 'form-3', form_name: 'Lash Lift Consent', client_name: 'Emma', submitted_at: null, status: 'pending', appointment_date: '2026-03-28' },
];

export default function IntakeForms() {
  const { beautician } = useBeautician();
  const [templates, setTemplates] = useState([]);
  const [responses, setResponses] = useState([]);
  const [tab, setTab] = useState('templates');
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [selectedTemplate, setSelectedTemplate] = useState(null);

  // Create form state
  const [form, setForm] = useState({
    name: '', description: '', auto_send: true, send_hours_before: 24,
    fields: [{ id: crypto.randomUUID(), type: 'yes_no', label: '', required: true, options: [] }],
  });

  useEffect(() => { if (beautician) loadData(); }, [beautician]);

  async function loadData() {
    setLoading(true);
    try {
      if (isDevMode) {
        setTemplates(DEV_TEMPLATES);
        setResponses(DEV_RESPONSES);
      } else {
        const { data: tmpl } = await supabase
          .from('intake_templates')
          .select('*')
          .eq('beautician_id', beautician.id)
          .order('created_at', { ascending: false });
        setTemplates(tmpl || []);

        const { data: resp } = await supabase
          .from('intake_responses')
          .select('*')
          .eq('beautician_id', beautician.id)
          .order('submitted_at', { ascending: false });
        setResponses(resp || []);
      }
    } catch (err) {
      logger.error('Load intake data error:', err);
      setTemplates(isDevMode ? DEV_TEMPLATES : []);
      setResponses(isDevMode ? DEV_RESPONSES : []);
    } finally {
      setLoading(false);
    }
  }

  function addField(type) {
    setForm(prev => ({
      ...prev,
      fields: [...prev.fields, { id: crypto.randomUUID(), type, label: '', required: false, options: type === 'checkbox' ? [''] : [] }],
    }));
  }

  function removeField(id) {
    setForm(prev => ({ ...prev, fields: prev.fields.filter(f => f.id !== id) }));
  }

  function updateField(id, key, value) {
    setForm(prev => ({
      ...prev,
      fields: prev.fields.map(f => f.id === id ? { ...f, [key]: value } : f),
    }));
  }

  function addOption(fieldId) {
    setForm(prev => ({
      ...prev,
      fields: prev.fields.map(f => f.id === fieldId ? { ...f, options: [...(f.options || []), ''] } : f),
    }));
  }

  function updateOption(fieldId, idx, value) {
    setForm(prev => ({
      ...prev,
      fields: prev.fields.map(f => f.id === fieldId ? { ...f, options: f.options.map((o, i) => i === idx ? value : o) } : f),
    }));
  }

  async function handleSaveTemplate() {
    if (!form.name.trim() || form.fields.some(f => !f.label.trim())) return;
    const template = {
      id: crypto.randomUUID(),
      name: form.name.trim(),
      description: form.description.trim(),
      treatments: [],
      auto_send: form.auto_send,
      send_hours_before: form.send_hours_before,
      fields: form.fields,
      created_at: new Date().toISOString(),
      response_count: 0,
    };

    if (!isDevMode && beautician) {
      try { const saved = await insertRow('intake_templates', { beautician_id: beautician.id, ...template }); template.id = saved.id; } catch {}
    }

    setTemplates(prev => [template, ...prev]);
    setForm({ name: '', description: '', auto_send: true, send_hours_before: 24, fields: [{ id: crypto.randomUUID(), type: 'yes_no', label: '', required: true, options: [] }] });
    setShowCreate(false);
    setTab('templates');
  }

  const pendingCount = responses.filter(r => r.status === 'pending').length;

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div>
          <h1 style={styles.title}>Forms</h1>
          <p style={styles.subtitle}>Intake & consent</p>
        </div>
      </div>

      {/* Stats */}
      <div style={styles.statsRow}>
        <div style={styles.statBox}>
          <span style={styles.statNum}>{templates.length}</span>
          <span style={styles.statLabel}>Templates</span>
        </div>
        <div style={styles.statBox}>
          <span style={styles.statNum}>{responses.filter(r => r.status === 'complete').length}</span>
          <span style={styles.statLabel}>Completed</span>
        </div>
        <div style={styles.statBox}>
          <span style={{ ...styles.statNum, color: pendingCount > 0 ? '#FF9800' : '#4CAF50' }}>{pendingCount}</span>
          <span style={styles.statLabel}>Pending</span>
        </div>
      </div>

      <div style={styles.tabs}>
        {['templates', 'responses', 'create'].map(t => (
          <button
            key={t}
            onClick={() => { setTab(t); if (t === 'create') setShowCreate(true); }}
            style={{
              ...styles.tab,
              borderBottomColor: tab === t ? '#C76B8A' : 'transparent',
              color: tab === t ? '#C76B8A' : '#AAA5A0',
            }}
          >
            {t === 'templates' ? 'Templates' : t === 'responses' ? `Responses${pendingCount > 0 ? ` (${pendingCount})` : ''}` : '+ Create'}
          </button>
        ))}
      </div>

      {/* === TEMPLATES TAB === */}
      {tab === 'templates' && (
        <div>
          {templates.length === 0 ? (
            <div style={styles.emptyState}>
              <span style={{ fontSize: 32, display: 'block', marginBottom: 8 }}>📋</span>
              <p style={styles.emptyTitle}>No form templates</p>
              <p style={styles.emptyDesc}>Create your first intake or consent form.</p>
            </div>
          ) : (
            <div style={styles.templateList}>
              {templates.map(t => (
                <div key={t.id} style={styles.templateCard} onClick={() => setSelectedTemplate(selectedTemplate?.id === t.id ? null : t)}>
                  <div style={styles.templateTop}>
                    <div>
                      <span style={styles.templateName}>{t.name}</span>
                      <span style={styles.templateDesc}>{t.description}</span>
                    </div>
                    {t.auto_send && <span style={styles.autoTag}>Auto-send</span>}
                  </div>
                  <div style={styles.templateMeta}>
                    <span>{t.fields.length} fields</span>
                    <span>·</span>
                    <span>{t.response_count} responses</span>
                    {t.auto_send && <><span>·</span><span>Sends {t.send_hours_before}h before</span></>}
                  </div>

                  {selectedTemplate?.id === t.id && (
                    <div style={styles.fieldPreview}>
                      {t.fields.map((f, i) => {
                        const fieldType = FIELD_TYPES.find(ft => ft.type === f.type);
                        return (
                          <div key={f.id} style={styles.fieldRow}>
                            <span style={styles.fieldIcon}>{fieldType?.icon || '?'}</span>
                            <span style={styles.fieldLabel}>{f.label}</span>
                            {f.required && <span style={styles.requiredDot}>*</span>}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* === RESPONSES TAB === */}
      {tab === 'responses' && (
        <div>
          {responses.length === 0 ? (
            <div style={styles.emptyState}>
              <p style={styles.emptyTitle}>No responses yet</p>
              <p style={styles.emptyDesc}>Completed forms from clients will show here.</p>
            </div>
          ) : (
            <div style={styles.responseList}>
              {responses.map(r => (
                <div key={r.id} style={styles.responseCard}>
                  <div style={styles.responseTop}>
                    <div style={styles.responseAvatar}>{r.client_name[0]}</div>
                    <div style={styles.responseInfo}>
                      <span style={styles.responseName}>{r.client_name}</span>
                      <span style={styles.responseForm}>{r.form_name}</span>
                    </div>
                    <div style={{
                      ...styles.responseBadge,
                      background: r.status === 'complete' ? '#E8F5E9' : '#FFF3E0',
                      color: r.status === 'complete' ? '#388E3C' : '#E65100',
                    }}>
                      {r.status === 'complete' ? 'Done' : 'Pending'}
                    </div>
                  </div>
                  <span style={styles.responseMeta}>
                    {r.status === 'complete'
                      ? `Submitted ${new Date(r.submitted_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`
                      : `Appointment ${new Date(r.appointment_date + 'T12:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })} — waiting for response`
                    }
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* === CREATE TAB === */}
      {tab === 'create' && (
        <div style={styles.createCard}>
          <div style={styles.formGroup}>
            <label style={styles.formLabel}>Form name</label>
            <input
              type="text" placeholder="e.g. Brow Treatment Consent"
              value={form.name}
              onChange={e => setForm(p => ({ ...p, name: e.target.value }))}
              style={styles.formInput}
            />
          </div>

          <div style={styles.formGroup}>
            <label style={styles.formLabel}>Description</label>
            <input
              type="text" placeholder="What this form is for"
              value={form.description}
              onChange={e => setForm(p => ({ ...p, description: e.target.value }))}
              style={styles.formInput}
            />
          </div>

          <div style={styles.formGroup}>
            <label style={styles.formLabel}>Fields</label>
            {form.fields.map((field, idx) => {
              const fieldType = FIELD_TYPES.find(ft => ft.type === field.type);
              return (
                <div key={field.id} style={styles.fieldEditCard}>
                  <div style={styles.fieldEditHeader}>
                    <span style={styles.fieldEditIcon}>{fieldType?.icon}</span>
                    <span style={styles.fieldEditType}>{fieldType?.label}</span>
                    <label style={styles.requiredToggle}>
                      <input
                        type="checkbox" checked={field.required}
                        onChange={e => updateField(field.id, 'required', e.target.checked)}
                      />
                      <span style={{ marginLeft: 4, fontSize: 11 }}>Required</span>
                    </label>
                    {form.fields.length > 1 && (
                      <button onClick={() => removeField(field.id)} style={styles.removeFieldBtn}>×</button>
                    )}
                  </div>
                  <input
                    type="text" placeholder="Question or label"
                    value={field.label}
                    onChange={e => updateField(field.id, 'label', e.target.value)}
                    style={styles.formInput}
                  />
                  {field.type === 'checkbox' && (
                    <div style={{ marginTop: 6 }}>
                      {(field.options || []).map((opt, oi) => (
                        <input
                          key={oi}
                          type="text" placeholder={`Option ${oi + 1}`}
                          value={opt}
                          onChange={e => updateOption(field.id, oi, e.target.value)}
                          style={{ ...styles.formInput, marginBottom: 4, fontSize: 12 }}
                        />
                      ))}
                      <button onClick={() => addOption(field.id)} style={styles.addOptionBtn}>+ option</button>
                    </div>
                  )}
                </div>
              );
            })}

            <div style={styles.addFieldRow}>
              {FIELD_TYPES.map(ft => (
                <button key={ft.type} onClick={() => addField(ft.type)} style={styles.addFieldBtn}>
                  <span>{ft.icon}</span>
                  <span style={{ fontSize: 10 }}>{ft.label}</span>
                </button>
              ))}
            </div>
          </div>

          <div style={styles.sendRow}>
            <div>
              <span style={styles.sendLabel}>Auto-send before appointments</span>
              <span style={styles.sendHint}>florrie.ai sends this form to the client automatically</span>
            </div>
            <button
              onClick={() => setForm(p => ({ ...p, auto_send: !p.auto_send }))}
              style={{ ...styles.toggle, background: form.auto_send ? '#C76B8A' : '#E8E4E0' }}
            >
              <div style={{ ...styles.toggleDot, transform: form.auto_send ? 'translateX(18px)' : 'translateX(2px)' }} />
            </button>
          </div>

          {form.auto_send && (
            <div style={styles.formGroup}>
              <label style={styles.formLabel}>Send how long before?</label>
              <div style={styles.timingRow}>
                {[12, 24, 48].map(h => (
                  <button
                    key={h}
                    onClick={() => setForm(p => ({ ...p, send_hours_before: h }))}
                    style={{
                      ...styles.timingChip,
                      background: form.send_hours_before === h ? '#C76B8A' : '#fff',
                      color: form.send_hours_before === h ? '#fff' : '#5A5550',
                    }}
                  >
                    {h}h before
                  </button>
                ))}
              </div>
            </div>
          )}

          <button onClick={handleSaveTemplate} style={styles.saveTemplateBtn}>
            Save Template
          </button>
        </div>
      )}
    </div>
  );
}

const styles = {
  page: { minHeight: '100vh', background: '#FAF8F5', fontFamily: '"DM Sans", -apple-system, sans-serif', padding: '0 16px 40px', maxWidth: 480, margin: '0 auto', color: '#2D2A26' },
  header: { paddingTop: 28, paddingBottom: 8 },
  title: { fontSize: 22, fontWeight: 700, margin: '0 0 2px' },
  subtitle: { fontSize: 13, color: '#C76B8A', margin: 0, fontWeight: 500 },

  statsRow: { display: 'flex', gap: 10, marginBottom: 16 },
  statBox: { flex: 1, background: '#fff', borderRadius: 12, padding: '12px 0', textAlign: 'center', boxShadow: '0 1px 3px rgba(0,0,0,0.04)' },
  statNum: { display: 'block', fontSize: 18, fontWeight: 700, color: '#C76B8A' },
  statLabel: { display: 'block', fontSize: 10, color: '#AAA5A0', textTransform: 'uppercase', letterSpacing: '0.04em', marginTop: 2 },

  tabs: { display: 'flex', gap: 16, borderBottom: '1px solid #F0ECE8', marginBottom: 16 },
  tab: { padding: '10px 0', background: 'none', border: 'none', borderBottom: '2px solid transparent', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },

  // Templates
  templateList: { display: 'flex', flexDirection: 'column', gap: 10 },
  templateCard: { background: '#fff', borderRadius: 14, padding: 14, boxShadow: '0 1px 3px rgba(0,0,0,0.04)', cursor: 'pointer' },
  templateTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 },
  templateName: { display: 'block', fontSize: 14, fontWeight: 600, color: '#2D2A26' },
  templateDesc: { display: 'block', fontSize: 12, color: '#8A8580', marginTop: 2 },
  autoTag: { padding: '3px 8px', borderRadius: 5, background: '#E8F5E9', color: '#388E3C', fontSize: 10, fontWeight: 600, flexShrink: 0 },
  templateMeta: { display: 'flex', gap: 6, fontSize: 11, color: '#AAA5A0' },
  fieldPreview: { marginTop: 10, paddingTop: 10, borderTop: '1px solid #F5F2EF', display: 'flex', flexDirection: 'column', gap: 6 },
  fieldRow: { display: 'flex', alignItems: 'center', gap: 8 },
  fieldIcon: { fontSize: 14, width: 20, textAlign: 'center' },
  fieldLabel: { fontSize: 12, color: '#5A5550', flex: 1 },
  requiredDot: { color: '#E57373', fontSize: 14, fontWeight: 700 },

  // Responses
  responseList: { display: 'flex', flexDirection: 'column', gap: 8 },
  responseCard: { background: '#fff', borderRadius: 12, padding: 12, boxShadow: '0 1px 3px rgba(0,0,0,0.04)' },
  responseTop: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 },
  responseAvatar: { width: 30, height: 30, borderRadius: 15, background: '#FBF0F3', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600, color: '#C76B8A', flexShrink: 0 },
  responseInfo: { flex: 1, display: 'flex', flexDirection: 'column', gap: 1 },
  responseName: { fontSize: 13, fontWeight: 600, color: '#2D2A26' },
  responseForm: { fontSize: 11, color: '#AAA5A0' },
  responseBadge: { padding: '3px 8px', borderRadius: 5, fontSize: 10, fontWeight: 600 },
  responseMeta: { fontSize: 11, color: '#AAA5A0' },

  // Create
  createCard: { background: '#fff', borderRadius: 14, padding: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.04)' },
  formGroup: { marginBottom: 14 },
  formLabel: { display: 'block', fontSize: 12, color: '#AAA5A0', marginBottom: 6, fontWeight: 500 },
  formInput: { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1.5px solid #F0ECE8', fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box' },
  fieldEditCard: { background: '#FAF8F5', borderRadius: 10, padding: 10, marginBottom: 8 },
  fieldEditHeader: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 },
  fieldEditIcon: { fontSize: 14 },
  fieldEditType: { fontSize: 11, color: '#AAA5A0', flex: 1 },
  requiredToggle: { display: 'flex', alignItems: 'center', fontSize: 11, color: '#8A8580', cursor: 'pointer' },
  removeFieldBtn: { width: 22, height: 22, borderRadius: 11, border: 'none', background: '#FEF2F2', color: '#E57373', fontSize: 13, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  addOptionBtn: { padding: '4px 10px', borderRadius: 5, border: '1px dashed #E8E4E0', background: 'transparent', color: '#AAA5A0', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit' },
  addFieldRow: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 8 },
  addFieldBtn: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, padding: '8px 10px', borderRadius: 8, border: '1.5px dashed #E8E4E0', background: '#fff', cursor: 'pointer', fontFamily: 'inherit', minWidth: 60 },

  sendRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', marginBottom: 14 },
  sendLabel: { display: 'block', fontSize: 13, fontWeight: 500, color: '#2D2A26' },
  sendHint: { display: 'block', fontSize: 11, color: '#AAA5A0', marginTop: 2 },
  toggle: { width: 44, height: 26, borderRadius: 13, border: 'none', cursor: 'pointer', position: 'relative', flexShrink: 0, transition: 'background 0.2s' },
  toggleDot: { width: 22, height: 22, borderRadius: 11, background: '#fff', position: 'absolute', top: 2, transition: 'transform 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.15)' },
  timingRow: { display: 'flex', gap: 8 },
  timingChip: { flex: 1, padding: '8px 0', borderRadius: 8, border: '1.5px solid #F0ECE8', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'center' },

  saveTemplateBtn: { width: '100%', padding: '12px 0', borderRadius: 10, border: 'none', background: '#C76B8A', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },

  // Empty
  emptyState: { textAlign: 'center', padding: '40px 20px' },
  emptyTitle: { fontSize: 16, fontWeight: 600, margin: '0 0 4px', color: '#2D2A26' },
  emptyDesc: { fontSize: 13, color: '#AAA5A0', margin: 0, lineHeight: 1.5 },
};
