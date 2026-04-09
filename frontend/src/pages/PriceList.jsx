/**
 * Price List Generator — Create & share a client-facing treatment menu.
 *
 * Pulls real treatments from Supabase, lets the beautician customise
 * the look (theme, descriptions, visibility), and generates share options.
 */
import { useState, useEffect, useCallback } from 'react';
import { useBeautician, supabase, isDevMode } from '../lib/supabase.js';
import PageLoader from '../components/PageLoader.jsx';
import ErrorCard from '../components/ErrorCard.jsx';

const fmt = (cents) => `£${(cents / 100).toFixed(0)}`;

const CATEGORIES = [
  { key: 'brows', label: 'Brows', icon: '✨' },
  { key: 'lashes', label: 'Lashes', icon: '👁️' },
  { key: 'semi', label: 'Semi-Permanent', icon: '💎' },
  { key: 'waxing', label: 'Waxing', icon: '🍯' },
  { key: 'other', label: 'Other', icon: '💆' },
];

const DEV_PRICE_LIST = [
  { id: 'pl1', name: 'Brow Shape & Tidy', category: 'brows', price_cents: 1500, duration_minutes: 15, description: 'Wax, tweeze & trim to your natural arch', popular: false },
  { id: 'pl2', name: 'Brow Lamination', category: 'brows', price_cents: 3500, duration_minutes: 45, description: 'Fluffy, brushed-up brows that last 6 weeks', popular: true },
  { id: 'pl3', name: 'HD Brows', category: 'brows', price_cents: 3000, duration_minutes: 40, description: 'Custom colour, shape & design', popular: true },
  { id: 'pl4', name: 'Brow Tint Only', category: 'brows', price_cents: 1000, duration_minutes: 10, description: 'Colour refresh between shaping appointments', popular: false },
  { id: 'pl5', name: 'Lash Lift & Tint', category: 'lashes', price_cents: 4000, duration_minutes: 60, description: 'Natural lash lift with a semi-permanent tint', popular: true },
  { id: 'pl6', name: 'Lash Tint Only', category: 'lashes', price_cents: 1200, duration_minutes: 15, description: 'Quick colour boost for natural lashes', popular: false },
  { id: 'pl7', name: 'Ombre Brows (Semi-Permanent)', category: 'semi', price_cents: 25000, duration_minutes: 150, description: 'Soft powder-fill effect lasting 1-3 years', popular: true },
  { id: 'pl8', name: 'Combination Brows', category: 'semi', price_cents: 28000, duration_minutes: 180, description: 'Hair strokes + powder fill for a natural look', popular: false },
  { id: 'pl9', name: 'Lip Wax', category: 'waxing', price_cents: 800, duration_minutes: 10, description: 'Quick upper lip tidy', popular: false },
  { id: 'pl10', name: 'Chin Wax', category: 'waxing', price_cents: 800, duration_minutes: 10, description: null, popular: false },
  { id: 'pl11', name: 'Full Face Wax', category: 'waxing', price_cents: 2000, duration_minutes: 25, description: 'Lip, chin, sides & brow area', popular: false },
];

const THEMES = [
  { key: 'rose', label: 'Rose', accent: '#C76B8A', bg: '#FAF8F5', text: '#2D2A26', muted: '#AAA5A0', border: '#F0ECE8' },
  { key: 'dark', label: 'Midnight', accent: '#D4A574', bg: '#1A1A2E', text: '#EEEEEE', muted: '#888888', border: '#333333' },
  { key: 'sage', label: 'Sage', accent: '#7D9D74', bg: '#F5F7F3', text: '#2D2A26', muted: '#AAA5A0', border: '#E0E8DC' },
  { key: 'mono', label: 'Mono', accent: '#333333', bg: '#FFFFFF', text: '#2D2A26', muted: '#AAA5A0', border: '#EEEEEE' },
];

// Map treatment names to categories by keyword
function guessCategory(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('brow') || n.includes('hd brow') || n.includes('lamination')) return 'brows';
  if (n.includes('lash') || n.includes('lift')) return 'lashes';
  if (n.includes('semi') || n.includes('ombre') || n.includes('microblad') || n.includes('combination')) return 'semi';
  if (n.includes('wax')) return 'waxing';
  return 'other';
}

export default function PriceList() {
  const { beautician, loading: bLoading } = useBeautician();
  const [tab, setTab] = useState('preview');
  const [selectedCat, setSelectedCat] = useState('all');
  const [theme, setTheme] = useState('rose');
  const [showNotes, setShowNotes] = useState(true);
  const [hiddenIds, setHiddenIds] = useState(new Set());
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    loadTreatments();
  }, [beautician]);

  async function loadTreatments() {
    if (isDevMode) {
      setItems(DEV_PRICE_LIST);
      setLoading(false);
      return;
    }
    if (!beautician) return;
    setLoading(true);
    try {
      const { data, error: fetchErr } = await supabase
        .from('treatments')
        .select('id, name, price_cents, duration_minutes, description, category, is_popular')
        .eq('beautician_id', beautician.id)
        .eq('active', true)
        .order('name');

      if (fetchErr) throw fetchErr;

      setItems((data || []).map(t => ({
        id: t.id,
        name: t.name,
        category: t.category || guessCategory(t.name),
        price_cents: t.price_cents || 0,
        duration_minutes: t.duration_minutes || 0,
        description: t.description || null,
        popular: t.is_popular || false,
      })));
    } catch (err) {
      setError('Could not load treatments');
    } finally {
      setLoading(false);
    }
  }

  const toggleHidden = useCallback((id) => {
    setHiddenIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const visibleItems = items.filter(i => !hiddenIds.has(i.id));
  const filtered = selectedCat === 'all' ? visibleItems : visibleItems.filter(i => i.category === selectedCat);
  const grouped = CATEGORIES.map(cat => ({
    ...cat,
    items: filtered.filter(i => i.category === cat.key),
  })).filter(g => g.items.length > 0);

  const currentTheme = THEMES.find(t => t.key === theme) || THEMES[0];
  const brandName = beautician?.business_name || beautician?.first_name || 'Your Business';
  const location = beautician?.location || '';
  const slug = beautician?.booking_slug || 'your-link';
  const shareUrl = `${window.location.origin}/book/${slug}`;

  // Toast helper
  function showToast(message) {
    setToast(message);
    setTimeout(() => setToast(null), 2500);
  }

  // Share handlers
  function copyLink() {
    navigator.clipboard.writeText(shareUrl).then(() => {
      showToast('Link copied to clipboard');
    }).catch(() => {
      showToast('Could not copy — try again');
    });
  }

  function sendWhatsApp() {
    const text = encodeURIComponent(`Check out my treatment menu & book online:\n${shareUrl}`);
    window.open(`https://wa.me/?text=${text}`, '_blank');
    showToast('Opening WhatsApp...');
  }

  function copyEmbed() {
    const code = `<iframe src="${shareUrl}?embed=true" width="100%" height="600" frameborder="0" style="border-radius:12px;"></iframe>`;
    navigator.clipboard.writeText(code).then(() => {
      showToast('Embed code copied');
    }).catch(() => {
      showToast('Could not copy — try again');
    });
  }

  function saveAsImage() {
    window.print();
    showToast('Print dialog opened');
  }

  if (loading || bLoading) return <PageLoader />;

  return (
    <div style={S.page}>
      {error && <ErrorCard message={error} onDismiss={() => setError(null)} />}

      {/* Toast notification */}
      {toast && (
        <div style={S.toast}>
          <span style={S.toastIcon}>✓</span>
          <span style={S.toastText}>{toast}</span>
        </div>
      )}

      <h1 style={S.title}>Price List</h1>

      {items.length === 0 && !loading && (
        <div style={S.emptyWrap}>
          <span style={{ fontSize: 32 }}>💅</span>
          <p style={S.emptyText}>No treatments yet. Add some in the Treatments page and they'll appear here automatically.</p>
        </div>
      )}

      {items.length > 0 && (
        <>
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
            <div style={{ ...S.previewCard, background: currentTheme.bg, color: currentTheme.text }}>
              <div style={S.previewHeader}>
                <h2 style={{ ...S.previewBrand, color: currentTheme.accent }}>{brandName}</h2>
                {location && <p style={{ ...S.previewSub, color: currentTheme.muted }}>{location}</p>}
              </div>

              {/* Category filter */}
              <div style={S.catFilterRow}>
                <button onClick={() => setSelectedCat('all')} style={{ ...S.catChip, ...(selectedCat === 'all' ? { background: currentTheme.accent, color: '#fff' } : { color: currentTheme.muted, borderColor: currentTheme.border }) }}>All</button>
                {CATEGORIES.filter(c => visibleItems.some(i => i.category === c.key)).map(c => (
                  <button key={c.key} onClick={() => setSelectedCat(c.key)} style={{ ...S.catChip, ...(selectedCat === c.key ? { background: currentTheme.accent, color: '#fff' } : { color: currentTheme.muted, borderColor: currentTheme.border }) }}>
                    {c.icon} {c.label}
                  </button>
                ))}
              </div>

              {/* Grouped items */}
              {grouped.map(group => (
                <div key={group.key} style={S.previewGroup}>
                  <h3 style={{ ...S.groupTitle, color: currentTheme.accent }}>{group.icon} {group.label}</h3>
                  {group.items.map(item => (
                    <div key={item.id} style={{ ...S.priceRow, borderBottom: `1px solid ${currentTheme.border}` }}>
                      <div style={S.priceLeft}>
                        <div style={S.priceNameRow}>
                          <span style={{ ...S.priceName, color: currentTheme.text }}>{item.name}</span>
                          {item.popular && <span style={{ ...S.popularBadge, background: currentTheme.accent + '20', color: currentTheme.accent }}>Popular</span>}
                        </div>
                        {item.description && showNotes && <span style={{ ...S.priceDesc, color: currentTheme.muted }}>{item.description}</span>}
                      </div>
                      <div style={S.priceRight}>
                        <span style={{ ...S.priceAmount, color: currentTheme.accent }}>{fmt(item.price_cents)}</span>
                        <span style={{ ...S.priceDuration, color: currentTheme.muted }}>{item.duration_minutes} min</span>
                      </div>
                    </div>
                  ))}
                </div>
              ))}

              {grouped.length === 0 && (
                <p style={{ textAlign: 'center', color: currentTheme.muted, fontSize: 13, padding: '20px 0' }}>
                  No treatments in this category.
                </p>
              )}

              <div style={{ ...S.previewFooter, borderTopColor: currentTheme.border }}>
                <p style={{ ...S.footerText, color: currentTheme.muted }}>
                  Prices valid as of {new Date().toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}.
                </p>
                <p style={{ ...S.footerBrand, color: currentTheme.accent }}>Powered by florrie.ai</p>
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
                    border: theme === t.key ? `2px solid ${t.accent}` : `2px solid ${t.border}`,
                  }}>
                    <div style={{ width: 16, height: 16, borderRadius: 8, background: t.accent }} />
                    <span style={{ fontSize: 11, fontWeight: 600, color: t.text }}>{t.label}</span>
                  </button>
                ))}
              </div>

              <h3 style={S.sectionTitle}>Options</h3>
              <div style={S.optionRow} onClick={() => setShowNotes(!showNotes)}>
                <span style={S.optionLabel}>Show treatment descriptions</span>
                <div style={{ ...S.toggle, background: showNotes ? 'var(--accent, #C76B8A)' : '#D0CBC5' }}>
                  <div style={{ ...S.toggleDot, transform: showNotes ? 'translateX(18px)' : 'translateX(2px)' }} />
                </div>
              </div>

              <h3 style={S.sectionTitle}>
                Treatments ({visibleItems.length} of {items.length} showing)
              </h3>
              <p style={S.hint}>Tap a treatment to hide or show it on your price list.</p>
              {items.map(item => {
                const isHidden = hiddenIds.has(item.id);
                return (
                  <button
                    key={item.id}
                    onClick={() => toggleHidden(item.id)}
                    style={{
                      ...S.treatmentToggle,
                      opacity: isHidden ? 0.4 : 1,
                      textDecoration: isHidden ? 'line-through' : 'none',
                    }}
                  >
                    <span style={S.treatmentToggleName}>{item.name}</span>
                    <div style={S.treatmentToggleRight}>
                      <span style={{ ...S.treatmentTogglePrice, color: 'var(--accent, #C76B8A)' }}>{fmt(item.price_cents)}</span>
                      <span style={{ fontSize: 14 }}>{isHidden ? '👁️‍🗨️' : '✓'}</span>
                    </div>
                  </button>
                );
              })}
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
                  <span style={S.shareLink}>{shareUrl.replace(/https?:\/\//, '')}</span>
                </div>
                <button onClick={copyLink} style={S.copyBtn}>Copy</button>
              </div>

              <div style={S.shareCard}>
                <span style={S.shareIcon}>📱</span>
                <div style={S.shareInfo}>
                  <span style={S.shareLabel}>WhatsApp</span>
                  <span style={S.shareSub}>Send to a client or group</span>
                </div>
                <button onClick={sendWhatsApp} style={S.copyBtn}>Send</button>
              </div>

              <div style={S.shareCard}>
                <span style={S.shareIcon}>📸</span>
                <div style={S.shareInfo}>
                  <span style={S.shareLabel}>Save as Image</span>
                  <span style={S.shareSub}>Print or save for Instagram</span>
                </div>
                <button onClick={saveAsImage} style={S.copyBtn}>Save</button>
              </div>

              <div style={S.shareCard}>
                <span style={S.shareIcon}>🌐</span>
                <div style={S.shareInfo}>
                  <span style={S.shareLabel}>Embed on Website</span>
                  <span style={S.shareSub}>Copy embed code</span>
                </div>
                <button onClick={copyEmbed} style={S.copyBtn}>Copy</button>
              </div>

              <div style={S.tipCard}>
                <span style={S.tipIcon}>💡</span>
                <span style={S.tipText}>Your price list auto-updates when you edit treatments or prices. No need to reshare.</span>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

const S = {
  page: {
    padding: '20px 16px 100px',
    fontFamily: "var(--font-body, 'DM Sans', -apple-system, sans-serif)",
    maxWidth: 480, margin: '0 auto',
    color: 'var(--text-primary, #2D2A26)',
  },
  title: {
    fontSize: 22, fontWeight: 700,
    color: 'var(--text-primary, #2D2A26)',
    margin: '0 0 16px',
    fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)",
  },

  // Empty state
  emptyWrap: { textAlign: 'center', padding: '48px 20px' },
  emptyText: { fontSize: 14, color: 'var(--text-muted, #AAA5A0)', lineHeight: 1.5, maxWidth: 280, margin: '12px auto 0' },

  // Tabs
  tabs: { display: 'flex', gap: 8, marginBottom: 16 },
  tab: {
    flex: 1, padding: '10px 0', border: 'none', borderRadius: 10,
    background: 'var(--bg-card, #fff)', color: 'var(--text-muted, #AAA5A0)',
    fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
    boxShadow: 'var(--shadow-xs)',
  },
  tabActive: { background: 'var(--accent, #C76B8A)', color: '#fff' },

  // Preview
  previewCard: { borderRadius: 16, padding: 20, marginBottom: 16, border: '1px solid var(--border, #EDE9E4)' },
  previewHeader: { textAlign: 'center', marginBottom: 20 },
  previewBrand: {
    fontSize: 24, fontWeight: 700, margin: '0 0 4px',
    fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)",
  },
  previewSub: { fontSize: 13, margin: 0 },
  catFilterRow: { display: 'flex', gap: 6, overflowX: 'auto', marginBottom: 16, paddingBottom: 4 },
  catChip: {
    padding: '5px 12px', borderRadius: 20, border: '1px solid var(--border, #EDE9E4)',
    background: 'transparent', fontSize: 11, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
  },
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
  previewFooter: { paddingTop: 16, borderTop: '1px solid var(--border, #EDE9E4)', textAlign: 'center' },
  footerText: { fontSize: 11, margin: '0 0 8px', lineHeight: 1.3 },
  footerBrand: { fontSize: 11, fontWeight: 600, margin: 0 },

  // Customise
  section: { marginBottom: 16 },
  sectionTitle: {
    fontSize: 14, fontWeight: 700, color: 'var(--text-primary, #2D2A26)', margin: '0 0 12px',
    fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)",
  },
  themeRow: { display: 'flex', gap: 8, marginBottom: 20 },
  themeBtn: {
    flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
    padding: '12px 8px', borderRadius: 12, cursor: 'pointer', fontFamily: 'inherit',
  },
  optionRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    background: 'var(--bg-card, #fff)', borderRadius: 12, padding: '12px 14px',
    marginBottom: 16, cursor: 'pointer',
    border: '1px solid var(--border, #EDE9E4)',
  },
  optionLabel: { fontSize: 14, fontWeight: 500, color: 'var(--text-primary, #2D2A26)' },
  toggle: { width: 42, height: 24, borderRadius: 12, position: 'relative', transition: 'background .2s' },
  toggleDot: {
    width: 20, height: 20, borderRadius: 10, background: '#fff',
    position: 'absolute', top: 2, transition: 'transform .2s',
    boxShadow: '0 1px 3px rgba(0,0,0,.2)',
  },
  hint: { fontSize: 12, color: 'var(--text-muted, #AAA5A0)', margin: '0 0 8px' },
  treatmentToggle: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    background: 'var(--bg-card, #fff)', borderRadius: 10, padding: '10px 12px',
    marginBottom: 4, cursor: 'pointer', border: '1px solid var(--border, #EDE9E4)',
    width: '100%', fontFamily: 'inherit', textAlign: 'left',
    transition: 'opacity 0.15s',
    WebkitTapHighlightColor: 'transparent',
  },
  treatmentToggleName: { fontSize: 13, color: 'var(--text-primary, #2D2A26)' },
  treatmentToggleRight: { display: 'flex', alignItems: 'center', gap: 8 },
  treatmentTogglePrice: { fontSize: 13, fontWeight: 600 },

  // Share
  shareCard: {
    display: 'flex', gap: 12, alignItems: 'center',
    background: 'var(--bg-card, #fff)', borderRadius: 12, padding: '12px 14px',
    marginBottom: 8, border: '1px solid var(--border, #EDE9E4)',
  },
  shareIcon: { fontSize: 22 },
  shareInfo: { flex: 1, display: 'flex', flexDirection: 'column', gap: 2 },
  shareLabel: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary, #2D2A26)' },
  shareLink: { fontSize: 12, color: 'var(--accent, #C76B8A)', fontWeight: 500 },
  shareSub: { fontSize: 12, color: 'var(--text-muted, #AAA5A0)' },
  copyBtn: {
    padding: '8px 16px', borderRadius: 8, border: 'none',
    background: 'var(--accent, #C76B8A)', color: '#fff',
    fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
    minWidth: 64, transition: 'opacity 0.15s',
  },

  tipCard: {
    background: 'var(--bg-subtle, #F9F7F4)', borderRadius: 12, padding: 14,
    display: 'flex', gap: 10, alignItems: 'flex-start', marginTop: 12,
    border: '1px solid var(--border, #EDE9E4)',
  },
  tipIcon: { fontSize: 16, flexShrink: 0 },
  tipText: { fontSize: 12, color: 'var(--text-secondary, #8B6F5E)', lineHeight: 1.4, margin: 0 },

  // Toast
  toast: {
    position: 'fixed', bottom: 90, left: '50%', transform: 'translateX(-50%)',
    display: 'flex', alignItems: 'center', gap: 8,
    background: 'var(--text-primary, #2D2A26)', color: '#fff',
    padding: '10px 20px', borderRadius: 12,
    boxShadow: '0 8px 24px rgba(0,0,0,0.2)',
    zIndex: 9999, fontSize: 13, fontWeight: 500,
    animation: 'slideUp 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
    fontFamily: "var(--font-body, 'DM Sans', sans-serif)",
  },
  toastIcon: { fontSize: 14, color: 'var(--success, #4CAF50)' },
  toastText: { whiteSpace: 'nowrap' },
};
