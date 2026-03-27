/**
 * Price List Generator — Create & share a client-facing treatment menu.
 *
 * Every beautician needs a clean, shareable price list. This page
 * pulls from treatments, lets them customise the look, and generates
 * a link or image they can send to clients or embed on socials.
 */
import { useState } from 'react';
import { isDevMode, DEV_TREATMENTS } from '../lib/supabase.js';

const fmt = (cents) => `£${(cents / 100).toFixed(0)}`;

const CATEGORIES = [
  { key: 'brows', label: 'Brows', icon: '✨' },
  { key: 'lashes', label: 'Lashes', icon: '👁️' },
  { key: 'semi', label: 'Semi-Permanent', icon: '💎' },
  { key: 'waxing', label: 'Waxing', icon: '🍯' },
  { key: 'other', label: 'Other', icon: '💆' },
];

const DEV_PRICE_LIST = [
  { id: 'pl1', name: 'Brow Shape & Tidy', category: 'brows', price: 1500, duration: 15, description: 'Wax, tweeze & trim to your natural arch', popular: false },
  { id: 'pl2', name: 'Brow Lamination', category: 'brows', price: 3500, duration: 45, description: 'Fluffy, brushed-up brows that last 6 weeks', popular: true },
  { id: 'pl3', name: 'HD Brows', category: 'brows', price: 3000, duration: 40, description: 'Custom colour, shape & design', popular: true },
  { id: 'pl4', name: 'Brow Tint Only', category: 'brows', price: 1000, duration: 10, description: 'Colour refresh between shaping appointments', popular: false },
  { id: 'pl5', name: 'Lash Lift & Tint', category: 'lashes', price: 4000, duration: 60, description: 'Natural lash lift with a semi-permanent tint', popular: true },
  { id: 'pl6', name: 'Lash Tint Only', category: 'lashes', price: 1200, duration: 15, description: 'Quick colour boost for natural lashes', popular: false },
  { id: 'pl7', name: 'Ombre Brows (Semi-Permanent)', category: 'semi', price: 25000, duration: 150, description: 'Soft powder-fill effect lasting 1-3 years', popular: true },
  { id: 'pl8', name: 'Combination Brows', category: 'semi', price: 28000, duration: 180, description: 'Hair strokes + powder fill for a natural look', popular: false },
  { id: 'pl9', name: 'Lip Wax', category: 'waxing', price: 800, duration: 10, description: 'Quick upper lip tidy', popular: false },
  { id: 'pl10', name: 'Chin Wax', category: 'waxing', price: 800, duration: 10, description: null, popular: false },
  { id: 'pl11', name: 'Full Face Wax', category: 'waxing', price: 2000, duration: 25, description: 'Lip, chin, sides & brow area', popular: false },
];

const THEMES = [
  { key: 'rose', label: 'Rose', accent: '#C76B8A', bg: '#FAF8F5' },
  { key: 'dark', label: 'Midnight', accent: '#D4A574', bg: '#1A1A2E' },
  { key: 'sage', label: 'Sage', accent: '#7D9D74', bg: '#F5F7F3' },
  { key: 'mono', label: 'Mono', accent: '#333', bg: '#fff' },
];

export default function PriceList({ token }) {
  const [tab, setTab] = useState('preview');
  const [selectedCat, setSelectedCat] = useState('all');
  const [theme, setTheme] = useState('rose');
  const [showNotes, setShowNotes] = useState(true);

  const items = DEV_PRICE_LIST;
  const filtered = selectedCat === 'all' ? items : items.filter(i => i.category === selectedCat);
  const grouped = CATEGORIES.map(cat => ({
    ...cat,
    items: filtered.filter(i => i.category === cat.key),
  })).filter(g => g.items.length > 0);

  const currentTheme = THEMES.find(t => t.key === theme) || THEMES[0];

  return (
    <div style={S.page}>
      <h1 style={S.title}>Price List</h1>

      {/* Tabs */}
      <div style={S.tabs}>
        {['preview', 'customise', 'share'].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ ...S.tab, ...(tab === t ? S.tabActive : {}) }}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* Preview tab */}
      {tab === 'preview' && (
        <div style={{ ...S.previewCard, background: currentTheme.bg, color: currentTheme.bg === '#1A1A2E' ? '#eee' : '#2D2A26' }}>
          {/* Header */}
          <div style={S.previewHeader}>
            <h2 style={{ ...S.previewBrand, color: currentTheme.accent }}>Ellindigo</h2>
            <p style={{ ...S.previewSub, color: currentTheme.bg === '#1A1A2E' ? '#999' : '#AAA5A0' }}>Brows & Beauty · Sheffield</p>
          </div>

          {/* Category filter inside preview */}
          <div style={S.catFilterRow}>
            <button onClick={() => setSelectedCat('all')} style={{ ...S.catChip, ...(selectedCat === 'all' ? { background: currentTheme.accent, color: '#fff' } : {}) }}>All</button>
            {CATEGORIES.map(c => (
              <button key={c.key} onClick={() => setSelectedCat(c.key)} style={{ ...S.catChip, ...(selectedCat === c.key ? { background: currentTheme.accent, color: '#fff' } : {}) }}>
                {c.icon} {c.label}
              </button>
            ))}
          </div>

          {/* Grouped items */}
          {grouped.map(group => (
            <div key={group.key} style={S.previewGroup}>
              <h3 style={{ ...S.groupTitle, color: currentTheme.accent }}>{group.icon} {group.label}</h3>
              {group.items.map(item => (
                <div key={item.id} style={{ ...S.priceRow, borderBottom: `1px solid ${currentTheme.bg === '#1A1A2E' ? '#333' : '#F0ECE8'}` }}>
                  <div style={S.priceLeft}>
                    <div style={S.priceNameRow}>
                      <span style={S.priceName}>{item.name}</span>
                      {item.popular && <span style={{ ...S.popularBadge, background: currentTheme.accent + '20', color: currentTheme.accent }}>Popular</span>}
                    </div>
                    {item.description && showNotes && <span style={{ ...S.priceDesc, color: currentTheme.bg === '#1A1A2E' ? '#888' : '#AAA5A0' }}>{item.description}</span>}
                  </div>
                  <div style={S.priceRight}>
                    <span style={{ ...S.priceAmount, color: currentTheme.accent }}>{fmt(item.price)}</span>
                    <span style={{ ...S.priceDuration, color: currentTheme.bg === '#1A1A2E' ? '#777' : '#AAA5A0' }}>{item.duration} min</span>
                  </div>
                </div>
              ))}
            </div>
          ))}

          {/* Footer */}
          <div style={S.previewFooter}>
            <p style={{ ...S.footerText, color: currentTheme.bg === '#1A1A2E' ? '#666' : '#AAA5A0' }}>
              Patch test required 48hrs before semi-permanent treatments. Prices valid as of March 2026.
            </p>
            <p style={{ ...S.footerBrand, color: currentTheme.accent }}>Powered by Florrie</p>
          </div>
        </div>
      )}

      {/* Customise tab */}
      {tab === 'customise' && (
        <div style={S.section}>
          <h3 style={S.sectionTitle}>Theme</h3>
          <div style={S.themeRow}>
            {THEMES.map(t => (
              <button key={t.key} onClick={() => setTheme(t.key)} style={{
                ...S.themeBtn,
                background: t.bg,
                border: theme === t.key ? `2px solid ${t.accent}` : '2px solid #F0ECE8',
              }}>
                <div style={{ width: 16, height: 16, borderRadius: 8, background: t.accent }} />
                <span style={{ fontSize: 11, fontWeight: 600, color: t.bg === '#1A1A2E' ? '#eee' : '#2D2A26' }}>{t.label}</span>
              </button>
            ))}
          </div>

          <h3 style={S.sectionTitle}>Options</h3>
          <div style={S.optionRow} onClick={() => setShowNotes(!showNotes)}>
            <span style={S.optionLabel}>Show treatment descriptions</span>
            <div style={{ ...S.toggle, background: showNotes ? '#C76B8A' : '#D0CBC5' }}>
              <div style={{ ...S.toggleDot, transform: showNotes ? 'translateX(18px)' : 'translateX(2px)' }} />
            </div>
          </div>

          <h3 style={S.sectionTitle}>Treatments ({items.length})</h3>
          <p style={S.hint}>Tap a treatment to hide/show it on your price list.</p>
          {items.map(item => (
            <div key={item.id} style={S.treatmentToggle}>
              <span style={S.treatmentToggleName}>{item.name}</span>
              <span style={{ ...S.treatmentTogglePrice, color: '#C76B8A' }}>{fmt(item.price)}</span>
            </div>
          ))}
        </div>
      )}

      {/* Share tab */}
      {tab === 'share' && (
        <div style={S.section}>
          <h3 style={S.sectionTitle}>Share Your Price List</h3>

          <div style={S.shareCard}>
            <span style={S.shareIcon}>🔗</span>
            <div style={S.shareInfo}>
              <span style={S.shareLabel}>Shareable Link</span>
              <span style={S.shareLink}>florrie.ai/prices/ellindigo</span>
            </div>
            <button style={S.copyBtn}>Copy</button>
          </div>

          <div style={S.shareCard}>
            <span style={S.shareIcon}>📱</span>
            <div style={S.shareInfo}>
              <span style={S.shareLabel}>WhatsApp</span>
              <span style={S.shareSub}>Send to a client or group</span>
            </div>
            <button style={S.copyBtn}>Send</button>
          </div>

          <div style={S.shareCard}>
            <span style={S.shareIcon}>📸</span>
            <div style={S.shareInfo}>
              <span style={S.shareLabel}>Save as Image</span>
              <span style={S.shareSub}>Perfect for Instagram stories</span>
            </div>
            <button style={S.copyBtn}>Save</button>
          </div>

          <div style={S.shareCard}>
            <span style={S.shareIcon}>🌐</span>
            <div style={S.shareInfo}>
              <span style={S.shareLabel}>Embed on Website</span>
              <span style={S.shareSub}>Copy embed code</span>
            </div>
            <button style={S.copyBtn}>Copy</button>
          </div>

          <div style={S.tipCard}>
            <span style={S.tipIcon}>💡</span>
            <span style={S.tipText}>Your price list auto-updates when you edit treatments or prices. No need to reshare.</span>
          </div>
        </div>
      )}
    </div>
  );
}

const S = {
  page: { padding: '20px 16px 100px', fontFamily: '"DM Sans", -apple-system, sans-serif', maxWidth: 480, margin: '0 auto' },
  title: { fontSize: 22, fontWeight: 700, color: 'var(--text, #2D2A26)', margin: '0 0 16px' },
  tabs: { display: 'flex', gap: 8, marginBottom: 16 },
  tab: { flex: 1, padding: '10px 0', border: 'none', borderRadius: 10, background: 'var(--card, #fff)', color: '#AAA5A0', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  tabActive: { background: '#C76B8A', color: '#fff' },

  previewCard: { borderRadius: 16, padding: 20, marginBottom: 16, border: '1px solid #F0ECE8' },
  previewHeader: { textAlign: 'center', marginBottom: 20 },
  previewBrand: { fontSize: 24, fontWeight: 700, margin: '0 0 4px', fontFamily: 'inherit' },
  previewSub: { fontSize: 13, margin: 0 },
  catFilterRow: { display: 'flex', gap: 6, overflowX: 'auto', marginBottom: 16, paddingBottom: 4 },
  catChip: { padding: '5px 12px', borderRadius: 20, border: '1px solid #F0ECE8', background: 'transparent', fontSize: 11, fontWeight: 600, color: '#AAA5A0', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
  previewGroup: { marginBottom: 16 },
  groupTitle: { fontSize: 14, fontWeight: 700, margin: '0 0 8px' },
  priceRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', padding: '10px 0' },
  priceLeft: { flex: 1, display: 'flex', flexDirection: 'column', gap: 3 },
  priceNameRow: { display: 'flex', alignItems: 'center', gap: 8 },
  priceName: { fontSize: 14, fontWeight: 500 },
  popularBadge: { padding: '2px 8px', borderRadius: 6, fontSize: 10, fontWeight: 600 },
  priceDesc: { fontSize: 12, lineHeight: 1.3 },
  priceRight: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 2, flexShrink: 0 },
  priceAmount: { fontSize: 16, fontWeight: 700 },
  priceDuration: { fontSize: 11 },
  previewFooter: { paddingTop: 16, borderTop: '1px solid #F0ECE8', textAlign: 'center' },
  footerText: { fontSize: 11, margin: '0 0 8px', lineHeight: 1.3 },
  footerBrand: { fontSize: 11, fontWeight: 600, margin: 0 },

  section: { marginBottom: 16 },
  sectionTitle: { fontSize: 14, fontWeight: 700, color: 'var(--text, #2D2A26)', margin: '0 0 12px' },
  themeRow: { display: 'flex', gap: 8, marginBottom: 20 },
  themeBtn: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, padding: '12px 8px', borderRadius: 12, cursor: 'pointer', fontFamily: 'inherit' },
  optionRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: 'var(--card, #fff)', borderRadius: 12, padding: '12px 14px', marginBottom: 16, cursor: 'pointer' },
  optionLabel: { fontSize: 14, fontWeight: 500, color: 'var(--text, #2D2A26)' },
  toggle: { width: 42, height: 24, borderRadius: 12, position: 'relative', transition: 'background .2s' },
  toggleDot: { width: 20, height: 20, borderRadius: 10, background: '#fff', position: 'absolute', top: 2, transition: 'transform .2s', boxShadow: '0 1px 3px rgba(0,0,0,.2)' },
  hint: { fontSize: 12, color: '#AAA5A0', margin: '0 0 8px' },
  treatmentToggle: { display: 'flex', justifyContent: 'space-between', background: 'var(--card, #fff)', borderRadius: 10, padding: '10px 12px', marginBottom: 4 },
  treatmentToggleName: { fontSize: 13, color: 'var(--text, #2D2A26)' },
  treatmentTogglePrice: { fontSize: 13, fontWeight: 600 },

  shareCard: { display: 'flex', gap: 12, alignItems: 'center', background: 'var(--card, #fff)', borderRadius: 12, padding: '12px 14px', marginBottom: 8 },
  shareIcon: { fontSize: 22 },
  shareInfo: { flex: 1, display: 'flex', flexDirection: 'column', gap: 2 },
  shareLabel: { fontSize: 14, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  shareLink: { fontSize: 12, color: '#C76B8A', fontWeight: 500 },
  shareSub: { fontSize: 12, color: '#AAA5A0' },
  copyBtn: { padding: '8px 16px', borderRadius: 8, border: 'none', background: '#C76B8A', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },

  tipCard: { background: '#F9F7F4', borderRadius: 12, padding: 14, display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 12 },
  tipIcon: { fontSize: 16, flexShrink: 0 },
  tipText: { fontSize: 12, color: '#8B6F5E', lineHeight: 1.4, margin: 0 },
};
