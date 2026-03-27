/**
 * Add-ons & Upsells — Bolt-on extras to boost average order value.
 *
 * Lip wax, brow jelly mask, aftercare kit — small items Ellie can
 * suggest at booking or during the appointment. This page manages
 * the add-on menu and tracks upsell performance.
 */
import { useState } from 'react';
import { isDevMode, DEV_TREATMENTS } from '../lib/supabase.js';

const fmt = (cents) => `£${(cents / 100).toFixed(2)}`;

const DEV_ADDONS = [
  { id: 'a1', name: 'Lip Wax', price: 600, duration: 10, category: 'waxing', active: true, suggestWith: ['Lamination & Hybrid Dye', 'HD Brows', 'Lamination & Tint'], autoSuggest: true, stats: { offered: 45, accepted: 28, revenue: 16800 } },
  { id: 'a2', name: 'Brow Jelly Mask', price: 700, duration: 15, category: 'treatment', active: true, suggestWith: ['Lamination & Hybrid Dye', 'HD Brows', 'Lamination & Tint', 'Lamination Maintenance / Tint'], autoSuggest: true, stats: { offered: 38, accepted: 22, revenue: 15400 } },
  { id: 'a3', name: 'Aftercare Kit', price: 1500, duration: 0, category: 'retail', active: true, suggestWith: ['Ombre Brows (Semi-Permanent)', 'Combination Brows (Semi-Permanent)'], autoSuggest: true, stats: { offered: 12, accepted: 10, revenue: 15000 } },
  { id: 'a4', name: 'Brow Lamination Booster Oil', price: 1200, duration: 0, category: 'retail', active: true, suggestWith: ['Lamination & Hybrid Dye', 'Lamination & Tint'], autoSuggest: false, stats: { offered: 20, accepted: 8, revenue: 9600 } },
  { id: 'a5', name: 'Extra Numbing (Semi-Perm)', price: 500, duration: 10, category: 'treatment', active: true, suggestWith: ['Ombre Brows (Semi-Permanent)', 'Combination Brows (Semi-Permanent)'], autoSuggest: true, stats: { offered: 8, accepted: 6, revenue: 3000 } },
  { id: 'a6', name: 'Lash Serum Sample', price: 800, duration: 0, category: 'retail', active: false, suggestWith: ['Lash Lift & Tint'], autoSuggest: false, stats: { offered: 5, accepted: 2, revenue: 1600 } },
];

const CATEGORIES = [
  { value: 'treatment', label: 'Treatment', colour: '#C76B8A' },
  { value: 'waxing', label: 'Waxing', colour: '#8B6F5E' },
  { value: 'retail', label: 'Retail Product', colour: '#6B8F7B' },
];

export default function AddOns({ token }) {
  const [tab, setTab] = useState('addons');
  const [expanded, setExpanded] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: '', price: '', duration: '', category: 'treatment', suggestWith: [], autoSuggest: true });

  const addons = DEV_ADDONS;
  const active = addons.filter(a => a.active);
  const totalRevenue = addons.reduce((s, a) => s + a.stats.revenue, 0);
  const avgAcceptRate = addons.length > 0 ? Math.round(addons.reduce((s, a) => s + (a.stats.offered > 0 ? (a.stats.accepted / a.stats.offered) * 100 : 0), 0) / addons.length) : 0;
  const avgRevenuePerAddon = active.length > 0 ? Math.round(totalRevenue / active.length) : 0;

  const toggleSuggestWith = (treatment) => {
    setForm(f => ({
      ...f,
      suggestWith: f.suggestWith.includes(treatment) ? f.suggestWith.filter(t => t !== treatment) : [...f.suggestWith, treatment],
    }));
  };

  return (
    <div style={S.page}>
      <div style={S.header}>
        <h1 style={S.title}>Add-ons & Upsells</h1>
        <button style={S.createBtn} onClick={() => setShowCreate(true)}>+ Add</button>
      </div>

      {/* Stats */}
      <div style={S.statsRow}>
        {[
          { label: 'Active', value: active.length, colour: '#C76B8A' },
          { label: 'Revenue', value: fmt(totalRevenue), colour: '#6B8F7B' },
          { label: 'Accept Rate', value: `${avgAcceptRate}%`, colour: '#8B6F5E' },
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
          {addons.map(addon => {
            const cat = CATEGORIES.find(c => c.value === addon.category);
            const isExp = expanded === addon.id;
            const acceptRate = addon.stats.offered > 0 ? Math.round((addon.stats.accepted / addon.stats.offered) * 100) : 0;
            return (
              <div key={addon.id} style={{ ...S.addonCard, opacity: addon.active ? 1 : 0.6 }} onClick={() => setExpanded(isExp ? null : addon.id)}>
                <div style={S.addonHeader}>
                  <div style={S.addonLeft}>
                    <div style={{ ...S.catDot, background: cat?.colour || '#AAA5A0' }} />
                    <div style={S.addonInfo}>
                      <span style={S.addonName}>{addon.name}</span>
                      <span style={S.addonMeta}>
                        {cat?.label} {addon.duration > 0 ? `· ${addon.duration} min` : '· Product'}
                      </span>
                    </div>
                  </div>
                  <div style={S.addonRight}>
                    <span style={S.addonPrice}>{fmt(addon.price)}</span>
                    {addon.autoSuggest && <span style={S.autoTag}>Auto</span>}
                  </div>
                </div>

                {isExp && (
                  <div style={S.expandedSection}>
                    {/* Quick stats */}
                    <div style={S.miniStats}>
                      <div style={S.miniStat}>
                        <span style={S.miniStatVal}>{addon.stats.offered}</span>
                        <span style={S.miniStatLabel}>Offered</span>
                      </div>
                      <div style={S.miniStat}>
                        <span style={S.miniStatVal}>{addon.stats.accepted}</span>
                        <span style={S.miniStatLabel}>Accepted</span>
                      </div>
                      <div style={S.miniStat}>
                        <span style={{ ...S.miniStatVal, color: '#6B8F7B' }}>{acceptRate}%</span>
                        <span style={S.miniStatLabel}>Rate</span>
                      </div>
                      <div style={S.miniStat}>
                        <span style={{ ...S.miniStatVal, color: '#C76B8A' }}>{fmt(addon.stats.revenue)}</span>
                        <span style={S.miniStatLabel}>Revenue</span>
                      </div>
                    </div>

                    {/* Suggested with */}
                    {addon.suggestWith.length > 0 && (
                      <>
                        <span style={S.sectionLabel}>Suggest with</span>
                        <div style={S.treatmentTags}>
                          {addon.suggestWith.map((t, i) => (
                            <span key={i} style={S.treatmentTag}>{t}</span>
                          ))}
                        </div>
                      </>
                    )}

                    <div style={S.actionRow}>
                      <button style={S.actionBtn}>Edit</button>
                      <button style={S.actionBtn}>{addon.active ? 'Disable' : 'Enable'}</button>
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
          {/* Ranking by revenue */}
          <div style={S.card}>
            <h3 style={S.cardTitle}>Revenue Ranking</h3>
            {[...addons].sort((a, b) => b.stats.revenue - a.stats.revenue).map((addon, i) => {
              const maxRev = addons[0] ? Math.max(...addons.map(a => a.stats.revenue)) : 1;
              const pct = Math.round((addon.stats.revenue / maxRev) * 100);
              const cat = CATEGORIES.find(c => c.value === addon.category);
              return (
                <div key={addon.id} style={S.rankRow}>
                  <span style={S.rankNum}>{i + 1}</span>
                  <div style={S.rankInfo}>
                    <span style={S.rankName}>{addon.name}</span>
                    <div style={S.rankBarBg}>
                      <div style={{ ...S.rankBarFill, width: `${pct}%`, background: cat?.colour || '#C76B8A' }} />
                    </div>
                  </div>
                  <span style={S.rankValue}>{fmt(addon.stats.revenue)}</span>
                </div>
              );
            })}
          </div>

          {/* Accept rate ranking */}
          <div style={S.card}>
            <h3 style={S.cardTitle}>Acceptance Rate</h3>
            {[...addons].sort((a, b) => {
              const aRate = a.stats.offered > 0 ? a.stats.accepted / a.stats.offered : 0;
              const bRate = b.stats.offered > 0 ? b.stats.accepted / b.stats.offered : 0;
              return bRate - aRate;
            }).map(addon => {
              const rate = addon.stats.offered > 0 ? Math.round((addon.stats.accepted / addon.stats.offered) * 100) : 0;
              return (
                <div key={addon.id} style={S.rateRow}>
                  <span style={S.rateName}>{addon.name}</span>
                  <div style={S.rateBarBg}>
                    <div style={{ ...S.rateBarFill, width: `${rate}%`, background: rate >= 60 ? '#6B8F7B' : rate >= 40 ? '#B8860B' : '#C76B8A' }} />
                  </div>
                  <span style={S.rateValue}>{rate}%</span>
                </div>
              );
            })}
          </div>

          {/* Tip */}
          <div style={S.tipCard}>
            <span style={S.tipTitle}>💡 Upsell Tip</span>
            <p style={S.tipText}>
              Aftercare Kit has your highest accept rate at 83%. Consider creating a bundle with brow treatments to boost average order value.
            </p>
          </div>
        </div>
      )}

      {/* Create modal */}
      {showCreate && (
        <div style={S.overlay} onClick={() => setShowCreate(false)}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <h2 style={S.modalTitle}>New Add-on</h2>

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
              {DEV_TREATMENTS.slice(0, 8).map(t => {
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
              <button style={{ ...S.toggle, background: form.autoSuggest ? '#C76B8A' : '#E0DCD8' }} onClick={() => setForm(f => ({ ...f, autoSuggest: !f.autoSuggest }))}>
                <div style={{ ...S.toggleDot, transform: form.autoSuggest ? 'translateX(18px)' : 'translateX(2px)' }} />
              </button>
            </div>

            <button style={S.saveBtn} onClick={() => setShowCreate(false)}>Create Add-on</button>
          </div>
        </div>
      )}
    </div>
  );
}

const S = {
  page: { padding: '20px 16px 32px', fontFamily: '"DM Sans", -apple-system, sans-serif', maxWidth: 480, margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  title: { fontSize: 22, fontWeight: 700, color: 'var(--text, #2D2A26)', margin: 0 },
  createBtn: { background: '#C76B8A', color: '#fff', border: 'none', borderRadius: 20, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },

  statsRow: { display: 'flex', gap: 10, marginBottom: 16 },
  statCard: { flex: 1, background: 'var(--card, #fff)', borderRadius: 12, padding: '12px 8px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 },
  statValue: { fontSize: 17, fontWeight: 700 },
  statLabel: { fontSize: 11, color: '#AAA5A0' },

  tabs: { display: 'flex', gap: 8, marginBottom: 16 },
  tab: { flex: 1, padding: '10px 0', border: 'none', borderRadius: 10, background: 'var(--card, #fff)', color: '#AAA5A0', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  tabActive: { background: '#C76B8A', color: '#fff' },

  list: { display: 'flex', flexDirection: 'column', gap: 10 },
  addonCard: { background: 'var(--card, #fff)', borderRadius: 14, padding: 14, cursor: 'pointer' },
  addonHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  addonLeft: { display: 'flex', gap: 10, alignItems: 'center' },
  catDot: { width: 10, height: 10, borderRadius: 5, flexShrink: 0 },
  addonInfo: { display: 'flex', flexDirection: 'column', gap: 2 },
  addonName: { fontSize: 14, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  addonMeta: { fontSize: 12, color: '#AAA5A0' },
  addonRight: { display: 'flex', alignItems: 'center', gap: 8 },
  addonPrice: { fontSize: 15, fontWeight: 700, color: '#C76B8A' },
  autoTag: { padding: '2px 6px', borderRadius: 4, background: '#E8F5E9', color: '#4CAF50', fontSize: 10, fontWeight: 600 },

  expandedSection: { marginTop: 12, paddingTop: 12, borderTop: '1px solid #F0ECE8' },
  miniStats: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 12 },
  miniStat: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 },
  miniStatVal: { fontSize: 15, fontWeight: 700, color: 'var(--text, #2D2A26)' },
  miniStatLabel: { fontSize: 10, color: '#AAA5A0' },
  sectionLabel: { fontSize: 11, fontWeight: 700, color: '#AAA5A0', textTransform: 'uppercase', letterSpacing: '0.05em', display: 'block', marginBottom: 6 },
  treatmentTags: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
  treatmentTag: { padding: '3px 8px', borderRadius: 6, background: '#F0E6ED', color: '#C76B8A', fontSize: 11 },
  actionRow: { display: 'flex', gap: 8 },
  actionBtn: { flex: 1, padding: '9px 0', borderRadius: 8, border: '1px solid #F0ECE8', background: 'var(--card, #fff)', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', color: '#2D2A26' },

  // Performance
  perfContainer: { display: 'flex', flexDirection: 'column', gap: 12 },
  card: { background: 'var(--card, #fff)', borderRadius: 14, padding: 16 },
  cardTitle: { fontSize: 15, fontWeight: 700, color: 'var(--text, #2D2A26)', margin: '0 0 12px' },
  rankRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
  rankNum: { fontSize: 14, fontWeight: 700, color: '#AAA5A0', width: 20, textAlign: 'center' },
  rankInfo: { flex: 1 },
  rankName: { fontSize: 13, fontWeight: 600, color: 'var(--text, #2D2A26)', display: 'block', marginBottom: 3 },
  rankBarBg: { height: 6, borderRadius: 3, background: '#F0ECE8' },
  rankBarFill: { height: 6, borderRadius: 3 },
  rankValue: { fontSize: 13, fontWeight: 700, color: 'var(--text, #2D2A26)', width: 55, textAlign: 'right' },
  rateRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
  rateName: { fontSize: 12, fontWeight: 500, color: 'var(--text, #2D2A26)', width: 100, flexShrink: 0 },
  rateBarBg: { flex: 1, height: 6, borderRadius: 3, background: '#F0ECE8' },
  rateBarFill: { height: 6, borderRadius: 3 },
  rateValue: { fontSize: 13, fontWeight: 700, color: 'var(--text, #2D2A26)', width: 36, textAlign: 'right' },
  tipCard: { background: '#FFF9F0', borderRadius: 12, padding: 14 },
  tipTitle: { fontSize: 13, fontWeight: 600, color: '#B8860B' },
  tipText: { fontSize: 12, color: '#8B6F5E', lineHeight: 1.4, margin: '6px 0 0' },

  // Modal
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 200, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' },
  modal: { background: '#fff', borderRadius: '16px 16px 0 0', padding: '20px 20px 32px', width: '100%', maxWidth: 480, maxHeight: '85vh', overflowY: 'auto' },
  modalTitle: { fontSize: 18, fontWeight: 700, color: '#2D2A26', margin: '0 0 16px' },
  fieldLabel: { fontSize: 12, fontWeight: 600, color: '#8B6F5E', marginBottom: 6, marginTop: 12 },
  input: { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #F0ECE8', fontSize: 14, fontFamily: 'inherit', color: '#2D2A26', outline: 'none', boxSizing: 'border-box' },
  chipRow: { display: 'flex', gap: 8 },
  chip: { flex: 1, padding: '8px 0', borderRadius: 10, border: '1px solid #F0ECE8', background: '#fff', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', color: '#2D2A26', textAlign: 'center' },
  treatmentPicker: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  treatmentPickChip: { padding: '5px 10px', borderRadius: 8, border: '1px solid #F0ECE8', background: '#fff', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit', color: '#8B6F5E' },
  treatmentPickActive: { background: '#C76B8A', color: '#fff', border: '1px solid #C76B8A' },
  toggleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: 14 },
  toggleLabel: { fontSize: 14, fontWeight: 500, color: 'var(--text, #2D2A26)' },
  toggle: { width: 44, height: 26, borderRadius: 13, border: 'none', padding: 0, cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0 },
  toggleDot: { width: 22, height: 22, borderRadius: 11, background: '#fff', position: 'absolute', top: 2, transition: 'transform 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.15)' },
  saveBtn: { width: '100%', padding: '14px 0', borderRadius: 12, border: 'none', background: '#C76B8A', color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', marginTop: 20 },
};
