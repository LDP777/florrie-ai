/**
 * Add-ons & Upsells - Bolt-on extras to boost average order value.
 *
 * Lip wax, brow jelly mask, aftercare kit - small items the beautician can
 * suggest at booking or during the appointment. This page manages
 * the add-on menu and tracks upsell performance.
 */
import { useState, useEffect } from 'react';
import { useBeautician, fetchRows, insertRow, updateRow, deleteRow } from '../lib/supabase.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';

const fmt = (cents) => `£${(cents / 100).toFixed(2)}`;

const CATEGORIES = [
  { value: 'treatment', label: 'Treatment', colour: 'var(--accent, #C76B8A)' },
  { value: 'waxing', label: 'Waxing', colour: 'var(--text-secondary, #8B6F5E)' },
  { value: 'retail', label: 'Retail Product', colour: 'var(--success, #6B8F7B)' },
];

const EMPTY_FORM = { name: '', price: '', duration: '', category: 'treatment', suggestWith: [], autoSuggest: true };

export default function AddOns() {
  const { beautician, loading: bLoading } = useBeautician();
  const [tab, setTab] = useState('addons');
  const [expanded, setExpanded] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState({ ...EMPTY_FORM });
  const [addons, setAddons] = useState([]);
  const [treatments, setTreatments] = useState([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);

  // Fetch add-ons + treatments on mount
  useEffect(() => {
    if (bLoading) return;
    if (!beautician) { setLoading(false); return; }
    setLoading(true);
    Promise.all([
      fetchRows('add_ons', beautician.id, { order: 'created_at', ascending: false })
        .then(rows => setAddons(rows))
        .catch(err => logger.error('Failed to load add-ons:', err)),
      fetchRows('treatments', beautician.id, { eq: { is_active: true } })
        .then(rows => setTreatments(rows))
        .catch(err => logger.error('Failed to load treatments:', err)),
    ]).finally(() => setLoading(false));
  }, [beautician, bLoading]);

  const active = addons.filter(a => a.is_active);

  const toggleSuggestWith = (treatmentName) => {
    setForm(f => ({
      ...f,
      suggestWith: f.suggestWith.includes(treatmentName)
        ? f.suggestWith.filter(t => t !== treatmentName)
        : [...f.suggestWith, treatmentName],
    }));
  };

  const openCreate = () => {
    setEditingId(null);
    setForm({ ...EMPTY_FORM });
    setError(null);
    setShowCreate(true);
  };

  const openEdit = (addon, e) => {
    e.stopPropagation();
    setEditingId(addon.id);
    setForm({
      name: addon.name,
      price: ((addon.price_cents || addon.price || 0) / 100).toFixed(2),
      duration: String(addon.duration_minutes || 0),
      category: addon.category || 'treatment',
      suggestWith: addon.suggest_with || [],
      autoSuggest: addon.auto_suggest !== false,
    });
    setError(null);
    setShowCreate(true);
  };

  const handleSave = async () => {
    if (!form.name.trim()) { setError('Name is required'); return; }
    const pricePounds = parseFloat(form.price);
    if (isNaN(pricePounds) || pricePounds < 0) { setError('Valid price is required'); return; }

    setSaving(true);
    setError(null);

    const payload = {
      name: form.name.trim(),
      price_cents: Math.round(pricePounds * 100),
      category: form.category,
      duration_minutes: parseInt(form.duration) || 0,
      suggest_with: form.suggestWith,
      auto_suggest: form.autoSuggest,
      is_active: true,
    };

    try {
      if (editingId) {
        // Update existing
        const updated = await updateRow('add_ons', editingId, payload);
        setAddons(prev => prev.map(a => a.id === editingId ? { ...a, ...updated } : a));
      } else {
        // Create new
        const created = await insertRow('add_ons', {
          ...payload,
          beautician_id: beautician.id,
        });
        setAddons(prev => [created, ...prev]);
      }
      setShowCreate(false);
      setForm({ ...EMPTY_FORM });
      setEditingId(null);
    } catch (err) {
      logger.error('Failed to save add-on:', err);
      setError(err.message || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (addon, e) => {
    e.stopPropagation();
    const newActive = !addon.is_active;
    try {
      await updateRow('add_ons', addon.id, { is_active: newActive });
      setAddons(prev => prev.map(a => a.id === addon.id ? { ...a, is_active: newActive } : a));
    } catch (err) {
      logger.error('Failed to toggle add-on:', err);
    }
  };

  const handleDelete = async (addon, e) => {
    e.stopPropagation();
    if (!window.confirm(`Delete "${addon.name}"? This can't be undone.`)) return;
    try {
      await deleteRow('add_ons', addon.id);
      setAddons(prev => prev.filter(a => a.id !== addon.id));
      if (expanded === addon.id) setExpanded(null);
    } catch (err) {
      logger.error('Failed to delete add-on:', err);
    }
  };

  if (bLoading || loading) return <PageLoader />;

  return (
    <div style={S.page}>
      <div style={S.header}>
        <h1 style={S.title}>Add-ons & Upsells</h1>
        <button style={S.createBtn} onClick={openCreate}>+ Add</button>
      </div>

      {/* Stats */}
      <div style={S.statsRow}>
        {[
          { label: 'Total', value: addons.length, colour: 'var(--text-secondary, #8B6F5E)' },
          { label: 'Active', value: active.length, colour: 'var(--accent, #C76B8A)' },
          { label: 'Categories', value: [...new Set(addons.map(a => a.category))].length, colour: 'var(--success, #6B8F7B)' },
        ].map(s => (
          <div key={s.label} style={S.statCard}>
            <span style={{ ...S.statValue, color: s.colour }}>{s.value}</span>
            <span style={S.statLabel}>{s.label}</span>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={S.tabs}>
        {['addons', 'performance'].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ ...S.tab, ...(tab === t ? S.tabActive : {}) }}>
            {t === 'addons' ? 'Add-ons' : 'Performance'}
          </button>
        ))}
      </div>

      {/* Add-ons list */}
      {tab === 'addons' && (
        <div style={S.list}>
          {addons.length === 0 && (
            <div style={S.emptyState}>
              <span style={S.emptyTitle}>No add-ons yet</span>
              <span style={S.emptyText}>Create your first add-on to boost average order value</span>
            </div>
          )}
          {addons.map(addon => {
            const cat = CATEGORIES.find(c => c.value === addon.category);
            const isExp = expanded === addon.id;
            const priceCents = addon.price_cents || addon.price || 0;
            return (
              <div key={addon.id} style={{ ...S.addonCard, opacity: addon.is_active ? 1 : 0.55 }} onClick={() => setExpanded(isExp ? null : addon.id)}>
                <div style={S.addonHeader}>
                  <div style={S.addonLeft}>
                    <div style={{ ...S.catDot, background: cat?.colour || 'var(--text-muted, #AAA5A0)' }} />
                    <div style={S.addonInfo}>
                      <span style={S.addonName}>{addon.name}</span>
                      <span style={S.addonMeta}>
                        {cat?.label || 'Other'} {(addon.duration_minutes || 0) > 0 ? `· ${addon.duration_minutes} min` : '· Product'}
                      </span>
                    </div>
                  </div>
                  <div style={S.addonRight}>
                    <span style={S.addonPrice}>{fmt(priceCents)}</span>
                    {addon.auto_suggest && <span style={S.autoTag}>Auto</span>}
                  </div>
                </div>

                {isExp && (
                  <div style={S.expandedSection}>
                    {/* Suggested with */}
                    {(addon.suggest_with || []).length > 0 && (
                      <>
                        <span style={S.sectionLabel}>Suggest with</span>
                        <div style={S.treatmentTags}>
                          {addon.suggest_with.map((t, i) => (
                            <span key={i} style={S.treatmentTag}>{t}</span>
                          ))}
                        </div>
                      </>
                    )}

                    <div style={S.actionRow}>
                      <button style={S.actionBtn} onClick={(e) => openEdit(addon, e)}>Edit</button>
                      <button style={S.actionBtn} onClick={(e) => handleToggleActive(addon, e)}>
                        {addon.is_active ? 'Disable' : 'Enable'}
                      </button>
                      <button style={{ ...S.actionBtn, color: 'var(--accent, #C76B8A)', borderColor: 'var(--accent-light, #FFF0F3)' }} onClick={(e) => handleDelete(addon, e)}>
                        Delete
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Performance */}
      {tab === 'performance' && (
        <div style={S.perfContainer}>
          <div style={S.card}>
            <h3 style={S.cardTitle}>Add-on Menu</h3>
            {addons.length === 0 && <p style={S.emptyText}>Create some add-ons to see performance data</p>}
            {[...addons].sort((a, b) => (b.price_cents || b.price || 0) - (a.price_cents || a.price || 0)).map((addon, i) => {
              const maxPrice = Math.max(...addons.map(a => a.price_cents || a.price || 0), 1);
              const pct = Math.round(((addon.price_cents || addon.price || 0) / maxPrice) * 100);
              const cat = CATEGORIES.find(c => c.value === addon.category);
              return (
                <div key={addon.id} style={S.rankRow}>
                  <span style={S.rankNum}>{i + 1}</span>
                  <div style={S.rankInfo}>
                    <span style={S.rankName}>{addon.name}</span>
                    <div style={S.rankBarBg}>
                      <div style={{ ...S.rankBarFill, width: `${pct}%`, background: cat?.colour || 'var(--accent, #C76B8A)' }} />
                    </div>
                  </div>
                  <span style={S.rankValue}>{fmt(addon.price_cents || addon.price || 0)}</span>
                </div>
              );
            })}
          </div>

          <div style={S.tipCard}>
            <span style={S.tipTitle}>💡 Upsell Tip</span>
            <p style={S.tipText}>
              Add-ons with "auto-suggest" enabled will appear on your booking page when a client selects a matching treatment.
            </p>
          </div>
        </div>
      )}

      {/* Create / Edit modal */}
      {showCreate && (
        <div style={S.overlay} onClick={() => { setShowCreate(false); setEditingId(null); }}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <h2 style={S.modalTitle}>{editingId ? 'Edit Add-on' : 'New Add-on'}</h2>

            {error && <div style={S.errorBanner}>{error}</div>}

            <div style={S.fieldLabel}>Name</div>
            <input style={S.input} placeholder="e.g. Lip Wax, Aftercare Kit" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />

            <div style={S.fieldLabel}>Price (£)</div>
            <input style={S.input} type="number" step="0.01" placeholder="0.00" value={form.price} onChange={e => setForm(f => ({ ...f, price: e.target.value }))} />

            <div style={S.fieldLabel}>Duration (minutes, 0 for products)</div>
            <input style={S.input} type="number" placeholder="0" value={form.duration} onChange={e => setForm(f => ({ ...f, duration: e.target.value }))} />

            <div style={S.fieldLabel}>Category</div>
            <div style={S.chipRow}>
              {CATEGORIES.map(c => (
                <button key={c.value} onClick={() => setForm(f => ({ ...f, category: c.value }))} style={{ ...S.chip, ...(form.category === c.value ? { background: c.colour, color: '#fff', border: `1px solid ${c.colour}` } : {}) }}>
                  {c.label}
                </button>
              ))}
            </div>

            <div style={S.fieldLabel}>Auto-suggest with treatments</div>
            <div style={S.treatmentPicker}>
              {treatments.slice(0, 12).map(t => {
                const selected = form.suggestWith.includes(t.name);
                return (
                  <button key={t.id} onClick={() => toggleSuggestWith(t.name)} style={{ ...S.treatmentPickChip, ...(selected ? S.treatmentPickActive : {}) }}>
                    {t.name}
                  </button>
                );
              })}
            </div>

            <div style={S.toggleRow}>
              <span style={S.toggleLabel}>Auto-suggest at booking</span>
              <button style={{ ...S.toggle, background: form.autoSuggest ? 'var(--accent, #C76B8A)' : 'var(--border, #E0DCD8)' }} onClick={() => setForm(f => ({ ...f, autoSuggest: !f.autoSuggest }))}>
                <div style={{ ...S.toggleDot, transform: form.autoSuggest ? 'translateX(18px)' : 'translateX(2px)' }} />
              </button>
            </div>

            <button style={{ ...S.saveBtn, opacity: saving ? 0.6 : 1 }} onClick={handleSave} disabled={saving}>
              {saving ? 'Saving…' : editingId ? 'Save Changes' : 'Create Add-on'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

const S = {
  page: { padding: '20px 16px 32px', fontFamily: '"DM Sans", -apple-system, sans-serif', maxWidth: 480, margin: '0 auto', animation: 'fadeIn 0.25s cubic-bezier(0.16, 1, 0.3, 1)' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  title: { fontSize: 22, fontWeight: 700, color: 'var(--text, #2D2A26)', margin: 0, fontFamily: 'var(--font-display, "Playfair Display", Georgia, serif)' },
  createBtn: { background: 'var(--accent, #C76B8A)', color: '#fff', border: 'none', borderRadius: 20, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },

  statsRow: { display: 'flex', gap: 10, marginBottom: 16 },
  statCard: { flex: 1, background: 'var(--card, #fff)', borderRadius: 12, padding: '12px 8px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 },
  statValue: { fontSize: 17, fontWeight: 700 },
  statLabel: { fontSize: 11, color: 'var(--text-muted, #AAA5A0)' },

  tabs: { display: 'flex', gap: 8, marginBottom: 16 },
  tab: { flex: 1, padding: '10px 0', border: 'none', borderRadius: 10, background: 'var(--card, #fff)', color: 'var(--text-muted, #AAA5A0)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  tabActive: { background: 'var(--accent, #C76B8A)', color: '#fff' },

  list: { display: 'flex', flexDirection: 'column', gap: 10 },
  emptyState: { textAlign: 'center', padding: '40px 20px', background: 'var(--card, #fff)', borderRadius: 14 },
  emptyTitle: { display: 'block', fontSize: 16, fontWeight: 600, color: 'var(--text, #2D2A26)', marginBottom: 6 },
  emptyText: { fontSize: 13, color: 'var(--text-muted, #AAA5A0)' },
  addonCard: { background: 'var(--card, #fff)', borderRadius: 14, padding: 14, cursor: 'pointer', transition: 'opacity 0.2s' },
  addonHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  addonLeft: { display: 'flex', gap: 10, alignItems: 'center' },
  catDot: { width: 10, height: 10, borderRadius: 5, flexShrink: 0 },
  addonInfo: { display: 'flex', flexDirection: 'column', gap: 2 },
  addonName: { fontSize: 14, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  addonMeta: { fontSize: 12, color: 'var(--text-muted, #AAA5A0)' },
  addonRight: { display: 'flex', alignItems: 'center', gap: 8 },
  addonPrice: { fontSize: 15, fontWeight: 700, color: 'var(--accent, #C76B8A)' },
  autoTag: { padding: '2px 6px', borderRadius: 4, background: 'var(--success-bg, #E8F5E9)', color: 'var(--success, #4CAF50)', fontSize: 10, fontWeight: 600 },

  expandedSection: { marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border, #F0ECE8)' },
  sectionLabel: { fontSize: 11, fontWeight: 700, color: 'var(--text-muted, #AAA5A0)', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 },
  treatmentTags: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
  treatmentTag: { padding: '3px 8px', borderRadius: 6, background: 'var(--accent-light, #FFF0F3)', color: 'var(--accent, #C76B8A)', fontSize: 11 },
  actionRow: { display: 'flex', gap: 8 },
  actionBtn: { flex: 1, padding: '9px 0', borderRadius: 8, border: '1px solid var(--border, #F0ECE8)', background: 'var(--card, #fff)', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text, #2D2A26)' },

  // Performance
  perfContainer: { display: 'flex', flexDirection: 'column', gap: 12 },
  card: { background: 'var(--card, #fff)', borderRadius: 14, padding: 16 },
  cardTitle: { fontSize: 15, fontWeight: 700, color: 'var(--text, #2D2A26)', margin: '0 0 12px' },
  rankRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
  rankNum: { fontSize: 14, fontWeight: 700, color: 'var(--text-muted, #AAA5A0)', width: 20, textAlign: 'center' },
  rankInfo: { flex: 1 },
  rankName: { fontSize: 13, fontWeight: 600, color: 'var(--text, #2D2A26)', display: 'block', marginBottom: 3 },
  rankBarBg: { height: 6, borderRadius: 3, background: 'var(--border, #F0ECE8)' },
  rankBarFill: { height: 6, borderRadius: 3 },
  rankValue: { fontSize: 13, fontWeight: 700, color: 'var(--text, #2D2A26)', width: 55, textAlign: 'right' },
  tipCard: { background: 'var(--gold-light, #FFF9F0)', borderRadius: 12, padding: 14 },
  tipTitle: { fontSize: 13, fontWeight: 600, color: 'var(--gold-text, #B8860B)' },
  tipText: { fontSize: 12, color: 'var(--text-secondary, #8B6F5E)', lineHeight: 1.4, margin: '6px 0 0' },

  // Modal
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 200, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' },
  modal: { background: 'var(--bg-card, #fff)', borderRadius: '16px 16px 0 0', padding: '20px 20px 32px', width: '100%', maxWidth: 480, maxHeight: '85vh', overflowY: 'auto' },
  modalTitle: { fontSize: 18, fontWeight: 700, color: 'var(--text, #2D2A26)', margin: '0 0 16px' },
  errorBanner: { background: 'var(--danger-bg, #FDF0EF)', color: 'var(--accent, #C76B8A)', padding: '8px 12px', borderRadius: 8, fontSize: 13, marginBottom: 12 },
  fieldLabel: { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary, #8B6F5E)', marginBottom: 6, marginTop: 12 },
  input: { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border, #F0ECE8)', fontSize: 14, fontFamily: 'inherit', color: 'var(--text, #2D2A26)', outline: 'none', boxSizing: 'border-box' },
  chipRow: { display: 'flex', gap: 8 },
  chip: { flex: 1, padding: '8px 0', borderRadius: 10, border: '1px solid var(--border, #F0ECE8)', background: 'var(--bg-card, #fff)', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text, #2D2A26)', textAlign: 'center' },
  treatmentPicker: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  treatmentPickChip: { padding: '5px 10px', borderRadius: 8, border: '1px solid var(--border, #F0ECE8)', background: 'var(--bg-card, #fff)', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-secondary, #8B6F5E)' },
  treatmentPickActive: { background: 'var(--accent, #C76B8A)', color: '#fff', border: '1px solid var(--accent, #C76B8A)' },
  toggleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14 },
  toggleLabel: { fontSize: 14, fontWeight: 500, color: 'var(--text, #2D2A26)' },
  toggle: { width: 44, height: 26, borderRadius: 13, border: 'none', padding: 0, cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0 },
  toggleDot: { width: 22, height: 22, borderRadius: 11, background: 'var(--bg-card, #fff)', position: 'absolute', top: 2, transition: 'transform 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.15)' },
  saveBtn: { width: '100%', padding: '14px 0', borderRadius: 12, border: 'none', background: 'var(--accent, #C76B8A)', color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', marginTop: 20, transition: 'opacity 0.2s' },
};
