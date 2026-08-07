/**
 * MessageTemplates - Reusable message templates for client comms.
 *
 * Categories:
 *   Booking    - confirmation, reminder, follow-up
 *   Marketing  - promos, seasonal offers, new treatments
 *   Care       - aftercare, rebook nudge, birthday
 *   Custom     - user-created templates
 *
 * Each template supports {name}, {treatment}, {date}, {time}, {link} variables.
 * Preview with mock data. Tone matches Ellie's voice model.
 */
import { useState, useEffect } from 'react';
import { useBeautician, supabase, fetchRows, insertRow, updateRow, deleteRow } from '../lib/supabase.js';
import { useTheme } from '../lib/theme.jsx';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';

const CATEGORIES = [
  { key: 'booking', label: 'Booking', icon: '📅', color: '#4A90D9' },
  { key: 'marketing', label: 'Marketing', icon: '💌', color: 'var(--accent, #C76B8A)' },
  { key: 'care', label: 'Care', icon: '💆', color: '#7B9E89' },
  { key: 'custom', label: 'Custom', icon: '✏️', color: '#F5A623' },
];

const VARIABLES = ['{name}', '{treatment}', '{date}', '{time}', '{link}'];

const TRIGGERS = [
  { key: 'manual', label: 'Manual send' },
  { key: 'on_booking', label: 'On booking' },
  { key: '24h_before', label: '24h before' },
  { key: '2h_before', label: '2h before' },
  { key: 'after_appointment', label: 'After appointment' },
  { key: '2h_after', label: '2h after' },
  { key: 'on_birthday', label: 'On birthday' },
];

const MOCK_DATA = { name: 'Shauna', treatment: 'Lamination & Hybrid Dye', date: 'Friday 28th March', time: '2:00pm', link: 'florrie.ai/book/ellindigo' };

function previewMessage(body) {
  let result = body;
  Object.entries(MOCK_DATA).forEach(([k, v]) => {
    result = result.replace(new RegExp(`\\{${k}\\}`, 'g'), v);
  });
  return result;
}

import MessagePreview from '../components/MessagePreview.jsx';

export default function MessageTemplates() {
  const { dark } = useTheme();
  const { beautician, loading: bLoading } = useBeautician();
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [filter, setFilter] = useState('all');
  const [expandedId, setExpandedId] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [previewId, setPreviewId] = useState(null);
  const [deleting, setDeleting] = useState(null);

  // Create form
  const [newCategory, setNewCategory] = useState('custom');
  const [newName, setNewName] = useState('');
  const [newBody, setNewBody] = useState('');
  const [newTrigger, setNewTrigger] = useState('manual');
  const [newAutoSend, setNewAutoSend] = useState(false);

  useEffect(() => {
    if (beautician && !bLoading) loadTemplates();
  }, [beautician, bLoading]);

  async function loadTemplates() {
    setLoading(true);
    setError(null);
    try {
      const data = await fetchRows('message_templates', beautician.id, { order: 'created_at', ascending: false });
      setTemplates(data || []);
    } catch (err) {
      logger.error({ err }, 'Load templates error');
      setError('Something went wrong');
      setTemplates([]);
    } finally {
      setLoading(false);
    }
  }

  const filtered = filter === 'all' ? templates : templates.filter(t => t.category === filter);

  async function handleCreate() {
    if (!newName || !newBody) return;
    const tmpl = {
      beautician_id: beautician?.id,
      category: newCategory,
      name: newName,
      body: newBody,
      auto_send: newAutoSend,
      trigger: newTrigger,
    };
    try {
      const created = await insertRow('message_templates', tmpl);
      setTemplates(prev => [created, ...prev]);
      setNewName('');
      setNewBody('');
      setShowCreate(false);
    } catch (err) {
      logger.error({ err }, 'Create template error');
    }
  }

  async function handleDelete(id) {
    setDeleting(id);
    try {
      await deleteRow('message_templates', id);
      setTemplates(prev => prev.filter(t => t.id !== id));
      setExpandedId(null);
    } catch (err) {
      logger.error({ err }, 'Delete template error');
    } finally {
      setDeleting(null);
    }
  }

  function insertVariable(variable) {
    setNewBody(prev => prev + variable);
  }

  if (bLoading || loading) {
    return <PageLoader />;
  }

  if (error) {
    return <ErrorCard message={error} onDismiss={() => setError(null)} />;
  }

  return (
    <div style={s.page}>
      <div style={s.header}>
        <div>
          <h1 style={s.title}>Templates</h1>
          <p style={s.sub}>Reusable message templates</p>
        </div>
        <button onClick={() => setShowCreate(!showCreate)} style={s.addBtn}>
          {showCreate ? '×' : '+ New'}
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div style={s.createCard}>
          {/* Category */}
          <div style={s.catRow}>
            {CATEGORIES.map(c => (
              <button
                key={c.key}
                onClick={() => setNewCategory(c.key)}
                style={{ ...s.catChip,
                  background: newCategory === c.key ? c.color + '18' : 'transparent',
                  border: newCategory === c.key ? `1px solid ${c.color}` : '1px solid var(--border, var(--border, var(--border, var(--border, #EDE9E4))))',
                  color: newCategory === c.key ? c.color : 'var(--text, var(--text-primary, #2D2A26))',
                }}
              >
                {c.icon} {c.label}
              </button>
            ))}
          </div>

          <input type="text" value={newName} onChange={e => setNewName(e.target.value)} placeholder="Template name" style={s.input} />

          <textarea
            value={newBody}
            onChange={e => setNewBody(e.target.value)}
            placeholder="Message body - use variables like {name}, {treatment}..."
            style={s.textarea}
            rows={4}
          />

          {/* Variable chips */}
          <div style={s.varRow}>
            <span style={s.varLabel}>Insert:</span>
            {VARIABLES.map(v => (
              <button key={v} onClick={() => insertVariable(v)} style={s.varChip}>{v}</button>
            ))}
          </div>

          {/* Trigger */}
          <span style={s.fieldLabel}>Send when</span>
          <div style={s.triggerRow}>
            {TRIGGERS.map(t => (
              <button
                key={t.key}
                onClick={() => setNewTrigger(t.key)}
                style={{ ...s.triggerChip,
                  background: newTrigger === t.key ? 'var(--accent, #C76B8A)' : 'var(--card-bg, #fff)',
                  color: newTrigger === t.key ? 'var(--bg-card, #fff)' : 'var(--text, var(--text-primary, #2D2A26))',
                  border: newTrigger === t.key ? '1px solid var(--accent, #C76B8A)' : '1px solid var(--border, var(--border, var(--border, var(--border, #EDE9E4))))',
                }}
              >
                {t.label}
              </button>
            ))}
          </div>

          {/* Auto-send toggle */}
          <div style={s.toggleRow}>
            <span style={s.toggleLabel}>Auto-send</span>
            <button
              onClick={() => setNewAutoSend(!newAutoSend)}
              style={{ ...s.toggle, background: newAutoSend ? 'var(--accent, #C76B8A)' : 'var(--border, var(--border, var(--border, #EDE9E4)))' }}
            >
              <div style={{ ...s.toggleThumb, transform: newAutoSend ? 'translateX(18px)' : 'translateX(2px)' }} />
            </button>
          </div>

          {/* Preview */}
          {newBody && (
            <div style={s.previewBox}>
              <span style={s.previewLabel}>How your client sees it</span>
              <MessagePreview text={previewMessage(newBody)} salonName={beautician?.business_name || 'Your salon'} />
            </div>
          )}

          <button onClick={handleCreate} disabled={!newName || !newBody} style={{ ...s.saveBtn, opacity: newName && newBody ? 1 : 0.4 }}>
            Save template
          </button>
        </div>
      )}

      {/* Category filter */}
      <div style={s.filterRow}>
        <button
          onClick={() => setFilter('all')}
          style={{ ...s.filterChip, background: filter === 'all' ? 'var(--accent, #C76B8A)' : 'var(--card-bg, #fff)', color: filter === 'all' ? 'var(--bg-card, #fff)' : 'var(--text, var(--text-primary, #2D2A26))', border: filter === 'all' ? '1px solid var(--accent, #C76B8A)' : '1px solid var(--border, var(--border, var(--border, var(--border, #EDE9E4))))' }}
        >
          All
        </button>
        {CATEGORIES.map(c => (
          <button
            key={c.key}
            onClick={() => setFilter(c.key)}
            style={{ ...s.filterChip, background: filter === c.key ? c.color + '18' : 'var(--card-bg, #fff)', color: filter === c.key ? c.color : 'var(--text, var(--text-primary, #2D2A26))', border: filter === c.key ? `1px solid ${c.color}` : '1px solid var(--border, var(--border, var(--border, var(--border, #EDE9E4))))' }}
          >
            {c.icon}
          </button>
        ))}
      </div>

      {/* Template list */}
      <div style={s.list}>
        {filtered.length === 0 ? (
          <EmptyState title="No templates found" description="Create a template to get started with reusable messages." />
        ) : (
          filtered.map(t => {
          const cat = CATEGORIES.find(c => c.key === t.category);
          const expanded = expandedId === t.id;
          const previewing = previewId === t.id;

          return (
            <div key={t.id} style={s.tmplCard}>
              <button onClick={() => setExpandedId(expanded ? null : t.id)} style={s.tmplHeader}>
                <span style={{ ...s.catDot, background: cat?.color || 'var(--text-muted)' }} />
                <div style={s.tmplInfo}>
                  <span style={s.tmplName}>{t.name}</span>
                  <span style={s.tmplMeta}>
                    {cat?.label} · {TRIGGERS.find(tr => tr.key === t.trigger)?.label}
                    {t.autoSend && ' · Auto'}
                  </span>
                </div>
                <span style={s.chevron}>{expanded ? '▾' : '›'}</span>
              </button>

              {expanded && (
                <div style={s.tmplBody}>
                  <p style={s.tmplText}>{t.body}</p>
                  <div style={s.tmplActions}>
                    <button
                      onClick={() => setPreviewId(previewing ? null : t.id)}
                      style={s.actionBtn}
                    >
                      {previewing ? 'Hide preview' : 'Preview'}
                    </button>
                    <button style={s.actionBtn}>Edit</button>
                    <button
                      onClick={() => handleDelete(t.id)}
                      disabled={deleting === t.id}
                      style={{ ...s.actionBtn, color: '#E57373', opacity: deleting === t.id ? 0.5 : 1 }}
                    >
                      {deleting === t.id ? '...' : 'Delete'}
                    </button>
                  </div>
                  {previewing && (
                    <div style={s.previewBox}>
                      <span style={s.previewLabel}>How it looks</span>
                      <p style={s.previewText}>{previewMessage(t.body)}</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
          })
        )}
      </div>
    </div>
  );
}

const s = {
  page: { padding: '16px 16px 32px', maxWidth: 480, margin: '0 auto', fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif" },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 },
  title: { fontSize: 24, fontWeight: 700, color: 'var(--text, var(--text-primary, #2D2A26))', margin: 0 },
  sub: { fontSize: 13, color: 'var(--text-muted, var(--text-muted, var(--text-muted, #B5AFA8)))', margin: '4px 0 0' },
  addBtn: { padding: '8px 16px', borderRadius: 10, border: 'none', background: 'var(--accent, #C76B8A)', color: 'var(--bg-card, #fff)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  createCard: { background: 'var(--card-bg, #fff)', borderRadius: 14, padding: 16, marginBottom: 16, border: '1px solid var(--border, var(--border, var(--border, var(--border, #EDE9E4))))' },
  catRow: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 },
  catChip: { padding: '6px 12px', borderRadius: 8, fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' },
  input: { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1.5px solid var(--border, var(--border, var(--border, var(--border, #EDE9E4))))', fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', marginBottom: 10, background: 'var(--bg, var(--bg, var(--bg, #FAF8F5)))', color: 'var(--text, var(--text-primary, #2D2A26))' },
  textarea: { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1.5px solid var(--border, var(--border, var(--border, var(--border, #EDE9E4))))', fontSize: 13, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', resize: 'vertical', marginBottom: 8, background: 'var(--bg, var(--bg, var(--bg, #FAF8F5)))', color: 'var(--text, var(--text-primary, #2D2A26))', lineHeight: 1.5 },
  varRow: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 12 },
  varLabel: { fontSize: 11, color: 'var(--text-muted, var(--text-muted, var(--text-muted, #B5AFA8)))', fontWeight: 500 },
  varChip: { padding: '3px 8px', borderRadius: 6, border: '1px solid var(--border, var(--border, var(--border, var(--border, #EDE9E4))))', background: 'var(--bg, var(--bg, var(--bg, #FAF8F5)))', fontSize: 11, fontFamily: 'monospace', cursor: 'pointer', color: 'var(--accent, #C76B8A)' },
  fieldLabel: { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-muted, var(--text-muted, var(--text-muted, #B5AFA8)))', marginBottom: 6 },
  triggerRow: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 },
  triggerChip: { padding: '6px 12px', borderRadius: 8, fontSize: 11, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' },
  toggleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 },
  toggleLabel: { fontSize: 14, fontWeight: 600, color: 'var(--text, var(--text-primary, #2D2A26))' },
  toggle: { width: 44, height: 26, borderRadius: 13, border: 'none', cursor: 'pointer', position: 'relative', flexShrink: 0, transition: 'background 0.2s' },
  toggleThumb: { width: 22, height: 22, borderRadius: 11, background: 'var(--bg-card, #fff)', position: 'absolute', top: 2, transition: 'transform 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.15)' },
  previewBox: { background: 'var(--bg, var(--bg, var(--bg, #FAF8F5)))', borderRadius: 10, padding: 12, marginBottom: 10 },
  previewLabel: { display: 'block', fontSize: 10, fontWeight: 600, color: 'var(--text-muted, var(--text-muted, var(--text-muted, #B5AFA8)))', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 4 },
  previewText: { fontSize: 13, lineHeight: 1.5, color: 'var(--text, #5A5550)', margin: 0 },
  saveBtn: { width: '100%', padding: '12px 0', borderRadius: 12, border: 'none', background: 'var(--accent, #C76B8A)', color: 'var(--bg-card, #fff)', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  filterRow: { display: 'flex', gap: 6, marginBottom: 14 },
  filterChip: { padding: '6px 12px', borderRadius: 16, fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' },
  list: { display: 'flex', flexDirection: 'column', gap: 6 },
  tmplCard: { background: 'var(--card-bg, #fff)', borderRadius: 12, border: '1px solid var(--border, var(--border, var(--border, var(--border, #EDE9E4))))', overflow: 'hidden' },
  tmplHeader: { display: 'flex', alignItems: 'center', gap: 10, padding: '12px 14px', border: 'none', background: 'transparent', cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', width: '100%' },
  catDot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  tmplInfo: { flex: 1, minWidth: 0 },
  tmplName: { display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--text, var(--text-primary, #2D2A26))' },
  tmplMeta: { display: 'block', fontSize: 11, color: 'var(--text-muted, var(--text-muted, var(--text-muted, #B5AFA8)))' },
  chevron: { fontSize: 14, color: 'var(--text-muted, #D5D0CB)', flexShrink: 0 },
  tmplBody: { padding: '0 14px 14px' },
  tmplText: { fontSize: 13, lineHeight: 1.5, color: 'var(--text, #5A5550)', margin: '0 0 10px', background: 'var(--bg, var(--bg, var(--bg, #FAF8F5)))', padding: '10px 12px', borderRadius: 8 },
  tmplActions: { display: 'flex', gap: 8 },
  actionBtn: { padding: '6px 14px', borderRadius: 8, border: '1px solid var(--border, var(--border, var(--border, var(--border, #EDE9E4))))', background: 'transparent', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text, var(--text-primary, #2D2A26))' },
};
