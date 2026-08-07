/**
 * Knowledge - the salon's own notes, the only things Florrie may quote.
 *
 * Anything saved here (aftercare, policies, treatment explainers, prep) is
 * retrieved at reply time and pinned into the AI front desk prompt with a
 * hard "answer ONLY from this" instruction. No entry, no answer: Florrie
 * says she will check and come back rather than guess.
 *
 * Talks to backend/src/routes/knowledge.js. Before migration 019 is run the
 * API answers { needs_migration: true } and this page shows a quiet
 * "not switched on yet" note instead of an error.
 */
import { useState, useEffect, useCallback } from 'react';
import { useBeautician, supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import Icon, { iconName } from '../components/ui/Icon';

const CATEGORIES = [
  { key: 'aftercare', label: 'Aftercare', matIcon: 'self_care' },
  { key: 'policy',    label: 'Policies',  matIcon: 'gavel' },
  { key: 'treatment', label: 'Treatments', matIcon: 'spa' },
  { key: 'prep',      label: 'Prep',      matIcon: 'checklist' },
  { key: 'faq',       label: 'FAQs',      matIcon: 'help' },
  { key: 'general',   label: 'General',   matIcon: 'notes' },
];

const CATEGORY_LABELS = Object.fromEntries(CATEGORIES.map(c => [c.key, c.label]));

// Empty-state starters: one tap prefills the form so the first save is easy.
const STARTERS = [
  { category: 'aftercare', title: 'Lash lift aftercare', hint: 'What to avoid and for how long' },
  { category: 'policy',    title: 'Cancellation policy', hint: 'Notice needed, what happens to deposits' },
  { category: 'prep',      title: 'Patch test explainer', hint: 'Why it matters and when to come in' },
];


export default function Knowledge() {
  const { beautician, loading: bLoading } = useBeautician();
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [needsMigration, setNeedsMigration] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState(null);

  // Add / edit form. editingId null = closed, 'new' = adding, else entry id.
  const [editingId, setEditingId] = useState(null);
  const [formCategory, setFormCategory] = useState('aftercare');
  const [formTitle, setFormTitle] = useState('');
  const [formContent, setFormContent] = useState('');

  const authedFetch = useCallback(async (path, options = {}) => {
    const session = await supabase.auth.getSession();
    const token = session.data.session?.access_token;
    return fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
        ...(options.headers || {}),
      },
    });
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await authedFetch('/api/knowledge');
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || 'Failed to load');
      setNeedsMigration(Boolean(body.needs_migration));
      setEntries((body.entries || []).filter(e => e.is_active));
    } catch (err) {
      logger.error({ err }, 'Load knowledge error');
      setError('Could not load your notes. Pull to refresh or try again shortly.');
    } finally {
      setLoading(false);
    }
  }, [authedFetch]);

  useEffect(() => {
    if (beautician && !bLoading) load();
  }, [beautician, bLoading, load]);

  function openAdd(starter) {
    setEditingId('new');
    setFormCategory(starter?.category || 'aftercare');
    setFormTitle(starter?.title || '');
    setFormContent('');
  }

  function openEdit(entry) {
    setEditingId(entry.id);
    setFormCategory(entry.category);
    setFormTitle(entry.title);
    setFormContent(entry.content);
  }

  function closeForm() {
    setEditingId(null);
    setFormTitle('');
    setFormContent('');
  }

  async function handleSave() {
    if (!formTitle.trim() || !formContent.trim() || saving) return;
    setSaving(true);
    setError(null);
    try {
      const isNew = editingId === 'new';
      const res = await authedFetch(isNew ? '/api/knowledge' : `/api/knowledge/${editingId}`, {
        method: isNew ? 'POST' : 'PATCH',
        body: JSON.stringify({ category: formCategory, title: formTitle.trim(), content: formContent.trim() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body?.error || 'Save failed');
      if (isNew) setEntries(prev => [body.entry, ...prev]);
      else setEntries(prev => prev.map(e => (e.id === editingId ? body.entry : e)));
      closeForm();
    } catch (err) {
      logger.error({ err }, 'Save knowledge error');
      setError(String(err.message || 'Could not save that. Try again.'));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete(id) {
    setDeletingId(id);
    try {
      const res = await authedFetch(`/api/knowledge/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error('Delete failed');
      setEntries(prev => prev.filter(e => e.id !== id));
      if (editingId === id) closeForm();
    } catch (err) {
      logger.error({ err }, 'Delete knowledge error');
      setError('Could not remove that. Try again.');
    } finally {
      setDeletingId(null);
    }
  }

  if (bLoading || loading) return <PageLoader />;

  const grouped = CATEGORIES
    .map(cat => ({ ...cat, items: entries.filter(e => e.category === cat.key) }))
    .filter(cat => cat.items.length > 0);

  return (
    <div style={S.page}>
      <h1 style={S.heading}>Florrie's knowledge</h1>
      <p style={S.intro}>
        Anything you save here, Florrie can use to answer clients. Aftercare, policies, prep, the lot.
        If it is not written down here, she says she will check with you rather than guess.
      </p>

      {needsMigration && (
        <div style={S.quietNote}>
          <Icon name={iconName('hourglass_empty')} size={18} inline color="#92405e" />
          <span>Not switched on yet for your account. It will appear here as soon as it is.</span>
        </div>
      )}

      {error && <div style={S.errorNote}>{error}</div>}

      {!needsMigration && editingId === null && (
        <button style={S.addButton} onClick={() => openAdd()}>
          <Icon name={iconName('add')} size={20} inline color="#fff" />
          <span>Add a note</span>
        </button>
      )}

      {editingId !== null && (
        <div style={S.formCard}>
          <div style={S.formTitleRow}>
            <span style={S.formHeading}>{editingId === 'new' ? 'New note' : 'Edit note'}</span>
            <button style={S.iconButton} onClick={closeForm} aria-label="Close">
              <Icon name={iconName('close')} size={18} inline color="#867277" />
            </button>
          </div>

          <label style={S.label}>Category</label>
          <select value={formCategory} onChange={e => setFormCategory(e.target.value)} style={S.select}>
            {CATEGORIES.map(c => (
              <option key={c.key} value={c.key}>{c.label}</option>
            ))}
          </select>

          <label style={S.label}>Title</label>
          <input
            type="text"
            value={formTitle}
            maxLength={120}
            onChange={e => setFormTitle(e.target.value)}
            placeholder="Lash lift aftercare"
            style={S.input}
          />

          <label style={S.label}>What Florrie should know</label>
          <textarea
            value={formContent}
            maxLength={5000}
            onChange={e => setFormContent(e.target.value)}
            placeholder="Keep lashes dry for 24 hours, no mascara or steam. After that, brush through daily."
            rows={6}
            style={S.textarea}
          />

          <button
            style={{ ...S.saveButton, opacity: (!formTitle.trim() || !formContent.trim() || saving) ? 0.5 : 1 }}
            disabled={!formTitle.trim() || !formContent.trim() || saving}
            onClick={handleSave}
          >
            {saving ? 'Saving' : 'Save note'}
          </button>
        </div>
      )}

      {!needsMigration && entries.length === 0 && editingId === null && (
        <div style={S.emptyCard}>
          <Icon name={iconName('menu_book')} size={36} inline color="#d8c1c6" style={{ display: 'block', margin: '0 auto 10px' }} />
          <p style={S.emptyText}>
            Nothing saved yet. Start with the three questions clients ask most:
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {STARTERS.map(st => (
              <button key={st.title} style={S.starterButton} onClick={() => openAdd(st)}>
                <div style={{ textAlign: 'left' }}>
                  <div style={S.starterTitle}>{st.title}</div>
                  <div style={S.starterHint}>{st.hint}</div>
                </div>
                <Icon name={iconName('add_circle')} size={20} inline color="#92405e" />
              </button>
            ))}
          </div>
        </div>
      )}

      {grouped.map(cat => (
        <div key={cat.key} style={{ marginBottom: 18 }}>
          <div style={S.sectionLabel}>
            <Icon name={iconName(cat.matIcon)} size={16} inline color="rgba(146,64,94,0.65)" />
            <span>{cat.label}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {cat.items.map(entry => (
              <div key={entry.id} style={S.entryCard}>
                <div style={S.entryTop}>
                  <span style={S.entryTitle}>{entry.title}</span>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <button style={S.iconButton} onClick={() => openEdit(entry)} aria-label={`Edit ${entry.title}`}>
                      <Icon name={iconName('edit')} size={18} inline color="#92405e" />
                    </button>
                    <button
                      style={{ ...S.iconButton, opacity: deletingId === entry.id ? 0.4 : 1 }}
                      disabled={deletingId === entry.id}
                      onClick={() => handleDelete(entry.id)}
                      aria-label={`Remove ${entry.title}`}
                    >
                      <Icon name={iconName('delete')} size={18} inline color="#867277" />
                    </button>
                  </div>
                </div>
                <p style={S.entryContent}>{entry.content}</p>
                <span style={S.entryBadge}>{CATEGORY_LABELS[entry.category] || entry.category}</span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

const S = {
  page: {
    minHeight: '100vh',
    background: 'var(--bg, #FBF6F1)',
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    padding: '16px 16px var(--scroll-pad-bottom)',
    maxWidth: 480,
    margin: '0 auto',
    color: '#1d1b19',
  },
  heading: {
    fontSize: 26,
    fontWeight: 600,
    fontFamily: "'Playfair Display', Georgia, serif",
    fontStyle: 'italic',
    color: 'var(--text-primary, #241B17)',
    margin: '12px 0 8px',
    letterSpacing: '-0.01em',
  },
  intro: {
    fontSize: 13.5,
    color: 'var(--text-secondary, #574A42)',
    lineHeight: 1.5,
    margin: '0 0 16px',
  },
  quietNote: {
    display: 'flex', alignItems: 'center', gap: 8,
    background: 'var(--tone-2, #f6e7dd)',
    borderRadius: 14, padding: '12px 14px',
    fontSize: 13, color: 'var(--text-secondary, #574A42)',
    marginBottom: 16,
  },
  errorNote: {
    background: 'var(--danger-bg, #F7E4E4)',
    color: '#B4443C', borderRadius: 14,
    padding: '12px 14px', fontSize: 13, marginBottom: 16,
  },
  addButton: {
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
    width: '100%', minHeight: 44, borderRadius: 16, border: 'none',
    background: 'var(--accent, #92405e)', color: '#fff',
    fontSize: 14, fontWeight: 700, fontFamily: 'inherit',
    cursor: 'pointer', marginBottom: 16,
    WebkitTapHighlightColor: 'transparent',
  },
  formCard: {
    background: 'var(--tone-1, #fbf1ea)',
    borderRadius: 20, padding: 16, marginBottom: 16,
  },
  formTitleRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    marginBottom: 10,
  },
  formHeading: { fontSize: 14, fontWeight: 700, color: 'var(--text-primary, #241B17)' },
  label: {
    display: 'block', fontSize: 10, fontWeight: 700, color: 'var(--text-muted)',
    textTransform: 'uppercase', letterSpacing: '0.08em',
    margin: '10px 0 6px',
  },
  select: {
    width: '100%', minHeight: 44, padding: '10px 12px',
    borderRadius: 14, border: 'none',
    background: 'var(--bg, #FBF6F1)', fontSize: 14,
    fontFamily: 'inherit', color: 'var(--text-primary, #241B17)',
    outline: 'none', boxSizing: 'border-box',
  },
  input: {
    width: '100%', minHeight: 44, padding: '10px 12px',
    borderRadius: 14, border: 'none',
    background: 'var(--bg, #FBF6F1)', fontSize: 14,
    fontFamily: 'inherit', color: 'var(--text-primary, #241B17)',
    outline: 'none', boxSizing: 'border-box',
  },
  textarea: {
    width: '100%', padding: '10px 12px',
    borderRadius: 14, border: 'none',
    background: 'var(--bg, #FBF6F1)', fontSize: 14,
    fontFamily: 'inherit', color: 'var(--text-primary, #241B17)',
    outline: 'none', boxSizing: 'border-box', resize: 'vertical',
    lineHeight: 1.5,
  },
  saveButton: {
    width: '100%', minHeight: 44, marginTop: 14,
    borderRadius: 16, border: 'none',
    background: 'var(--accent, #92405e)', color: '#fff',
    fontSize: 14, fontWeight: 700, fontFamily: 'inherit',
    cursor: 'pointer',
    WebkitTapHighlightColor: 'transparent',
  },
  emptyCard: {
    background: 'var(--tone-1, #fbf1ea)',
    borderRadius: 20, padding: '20px 16px',
    textAlign: 'center', marginBottom: 16,
  },
  emptyText: {
    fontSize: 13.5, color: 'var(--text-secondary, #574A42)',
    lineHeight: 1.5, margin: '0 0 14px',
  },
  starterButton: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    gap: 10, width: '100%', minHeight: 44,
    padding: '12px 14px', borderRadius: 14, border: 'none',
    background: 'var(--bg, #FBF6F1)', cursor: 'pointer',
    fontFamily: 'inherit',
    WebkitTapHighlightColor: 'transparent',
  },
  starterTitle: { fontSize: 13, fontWeight: 700, color: 'var(--text-primary, #241B17)' },
  starterHint: { fontSize: 11.5, color: 'var(--text-muted, #6B5D54)', marginTop: 2 },
  sectionLabel: {
    display: 'flex', alignItems: 'center', gap: 6,
    fontSize: 10, fontWeight: 700, color: 'var(--text-muted)',
    textTransform: 'uppercase', letterSpacing: '0.08em',
    marginBottom: 8,
  },
  entryCard: {
    background: 'var(--tone-1, #fbf1ea)',
    borderRadius: 16, padding: '14px 14px 12px',
    position: 'relative',
  },
  entryTop: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start',
    gap: 8, marginBottom: 6,
  },
  entryTitle: {
    fontSize: 14, fontWeight: 700, color: 'var(--text-primary, #241B17)',
    lineHeight: 1.35, paddingTop: 4,
  },
  entryContent: {
    fontSize: 13, color: 'var(--text-secondary, #574A42)',
    lineHeight: 1.5, margin: '0 0 8px', whiteSpace: 'pre-wrap',
    overflowWrap: 'break-word',
  },
  entryBadge: {
    display: 'inline-block',
    fontSize: 10, fontWeight: 700, color: '#92405e',
    background: 'var(--accent-wash, #FBF2F5)',
    padding: '3px 8px', borderRadius: 999,
    letterSpacing: '0.04em',
  },
  iconButton: {
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    minWidth: 44, minHeight: 44, borderRadius: 12,
    border: 'none', background: 'transparent', cursor: 'pointer',
    WebkitTapHighlightColor: 'transparent',
  },
};
