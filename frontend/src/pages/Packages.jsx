/**
 * Packages — Treatment bundles and course packages.
 *
 * Features:
 *   - Create bundles (e.g. "Brow Bundle" = Lamination + Tint at discount)
 *   - Course packages (e.g. "6x HD Brows" pay upfront, save 15%)
 *   - Active packages with sessions remaining
 *   - Package stats (sold, revenue, redemption rate)
 *
 * Dev-mode mock data. Supabase wiring later.
 */
import { useState, useEffect } from 'react';
import { useBeautician, fetchRows, insertRow, updateRow, deleteRow, isDevMode, DEV_TREATMENTS } from '../lib/supabase.js';
import { useTheme } from '../lib/theme.jsx';
import logger from '../lib/logger.js';

const pence = v => `£${(v / 100).toFixed(2)}`;
const pounds = v => `£${Math.round(v / 100)}`;

const DEV_PACKAGES = [
  {
    id: 'pkg-1',
    name: 'Brow Bundle',
    type: 'bundle',
    description: 'Lamination & Hybrid Dye + Brow Jelly Mask',
    treatments: ['dev-t1', 'dev-t15'],
    fullPrice: 5200,
    price: 4500,
    sold: 12,
    active: 3,
  },
  {
    id: 'pkg-2',
    name: 'Lash & Brow Combo',
    type: 'bundle',
    description: 'Lash Lift & Tint + Lamination & Tint',
    treatments: ['dev-t13', 'dev-t2'],
    fullPrice: 8000,
    price: 7000,
    sold: 8,
    active: 2,
  },
  {
    id: 'pkg-3',
    name: '6x HD Brows Course',
    type: 'course',
    description: '6 sessions of HD Brows — save 15%',
    treatments: ['dev-t5'],
    sessions: 6,
    fullPrice: 15000,
    price: 12750,
    sold: 5,
    active: 4,
  },
  {
    id: 'pkg-4',
    name: '4x Lamination Maintenance',
    type: 'course',
    description: '4 sessions of Lamination Maintenance / Tint',
    treatments: ['dev-t3'],
    sessions: 4,
    fullPrice: 10000,
    price: 8500,
    sold: 6,
    active: 3,
  },
];

const DEV_CLIENT_PACKAGES = [
  { id: 'cp-1', client: 'Shauna', package: '6x HD Brows Course', sessionsUsed: 3, sessionsTotal: 6, purchasedAt: '2026-02-10' },
  { id: 'cp-2', client: 'Daisy S', package: '4x Lamination Maintenance', sessionsUsed: 1, sessionsTotal: 4, purchasedAt: '2026-03-05' },
  { id: 'cp-3', client: 'Jasmin', package: 'Brow Bundle', sessionsUsed: 0, sessionsTotal: 1, purchasedAt: '2026-03-20' },
  { id: 'cp-4', client: 'Beth', package: '6x HD Brows Course', sessionsUsed: 5, sessionsTotal: 6, purchasedAt: '2025-12-15' },
];

export default function Packages({ token }) {
  const { beautician, loading: bLoading } = useBeautician();
  const { dark } = useTheme();
  const [tab, setTab] = useState('packages');
  const [showCreate, setShowCreate] = useState(false);
  const [packages, setPackages] = useState([]);
  const [clientPackages, setClientPackages] = useState([]);
  const [saving, setSaving] = useState(false);
  const [treatments, setTreatments] = useState([]);

  // Load packages on mount
  useEffect(() => {
    if (bLoading || !beautician) return;
    if (isDevMode) {
      setPackages(DEV_PACKAGES);
      setClientPackages(DEV_CLIENT_PACKAGES);
      return;
    }
    Promise.all([
      fetchRows('packages', beautician.id),
      fetchRows('client_packages', beautician.id),
      fetchRows('treatments', beautician.id, { eq: { is_active: true } }),
    ]).then(([pkgs, cpkgs, trts]) => {
      setPackages(pkgs);
      setClientPackages(cpkgs);
      setTreatments(trts);
    }).catch(err => logger.error('Failed to load packages:', err));
  }, [beautician, bLoading]);

  // Create form state
  const [newType, setNewType] = useState('bundle');
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [selectedTreatments, setSelectedTreatments] = useState([]);
  const [newSessions, setNewSessions] = useState(4);
  const [discountPercent, setDiscountPercent] = useState(15);

  const activeTreatments = (treatments.length > 0 ? treatments : DEV_TREATMENTS).filter(t => t.is_active);

  function toggleTreatment(id) {
    setSelectedTreatments(prev =>
      prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]
    );
  }

  const selectedTotal = selectedTreatments.reduce((sum, id) => {
    const t = activeTreatments.find(x => x.id === id);
    return sum + (t?.price_cents || 0);
  }, 0);

  const courseBase = selectedTreatments.length === 1
    ? (activeTreatments.find(x => x.id === selectedTreatments[0])?.price_cents || 0) * newSessions
    : 0;

  const totalBeforeDiscount = newType === 'bundle' ? selectedTotal : courseBase;
  const discountedPrice = Math.round(totalBeforeDiscount * (1 - discountPercent / 100));
  const savings = totalBeforeDiscount - discountedPrice;

  const totalRevenue = packages.reduce((s, p) => s + (p.price_cents || p.price || 0) * (p.sold || 0), 0);
  const totalSold = packages.reduce((s, p) => s + (p.sold || 0), 0);

  const handleCreatePackage = async () => {
    if (!newName || selectedTreatments.length === 0) return;
    setSaving(true);
    try {
      const treatment_names = selectedTreatments.map(id => {
        const t = activeTreatments.find(x => x.id === id);
        return t?.name || id;
      });
      const created = await insertRow('packages', {
        beautician_id: beautician.id,
        name: newName,
        description: newDesc,
        type: newType,
        treatment_ids: selectedTreatments,
        treatment_names,
        sessions: newType === 'course' ? newSessions : selectedTreatments.length,
        full_price_cents: totalBeforeDiscount,
        price_cents: discountedPrice,
        discount_percent: discountPercent,
        is_active: true,
      });
      setPackages(prev => [created, ...prev]);
      setShowCreate(false);
      setNewName(''); setNewDesc(''); setSelectedTreatments([]);
    } catch (err) {
      logger.error('Failed to create package:', err);
    } finally {
      setSaving(false);
    }
  };

  const tabs = [
    { key: 'packages', label: 'Packages' },
    { key: 'active', label: 'Active' },
  ];

  return (
    <div style={s.page}>
      <div style={s.header}>
        <div>
          <h1 style={s.title}>Packages</h1>
          <p style={s.sub}>Bundles & course packages</p>
        </div>
        <button onClick={() => setShowCreate(!showCreate)} style={s.addBtn}>
          {showCreate ? '×' : '+ Create'}
        </button>
      </div>

      {/* Stats */}
      <div style={s.statsRow}>
        <div style={s.statCard}>
          <span style={s.statValue}>{packages.length}</span>
          <span style={s.statLabel}>Packages</span>
        </div>
        <div style={s.statCard}>
          <span style={s.statValue}>{totalSold}</span>
          <span style={s.statLabel}>Sold</span>
        </div>
        <div style={s.statCard}>
          <span style={s.statValue}>{pounds(totalRevenue)}</span>
          <span style={s.statLabel}>Revenue</span>
        </div>
      </div>

      {/* Create form */}
      {showCreate && (
        <div style={s.createForm}>
          <span style={s.formTitle}>New package</span>

          {/* Type */}
          <div style={s.chipRow}>
            <button
              onClick={() => setNewType('bundle')}
              style={{ ...s.typeChip, background: newType === 'bundle' ? '#C76B8A' : 'var(--card-bg, #fff)', color: newType === 'bundle' ? '#fff' : 'var(--text, #2D2A26)', border: newType === 'bundle' ? '1px solid #C76B8A' : '1px solid var(--border, #E8E4E0)' }}
            >
              Bundle
            </button>
            <button
              onClick={() => setNewType('course')}
              style={{ ...s.typeChip, background: newType === 'course' ? '#C76B8A' : 'var(--card-bg, #fff)', color: newType === 'course' ? '#fff' : 'var(--text, #2D2A26)', border: newType === 'course' ? '1px solid #C76B8A' : '1px solid var(--border, #E8E4E0)' }}
            >
              Course
            </button>
          </div>

          <input type="text" value={newName} onChange={e => setNewName(e.target.value)} placeholder="Package name" style={s.input} />
          <input type="text" value={newDesc} onChange={e => setNewDesc(e.target.value)} placeholder="Short description" style={s.input} />

          {/* Treatment picker */}
          <span style={s.fieldLabel}>
            {newType === 'bundle' ? 'Select treatments in this bundle' : 'Select treatment for course'}
          </span>
          <div style={s.treatmentPicker}>
            {activeTreatments.map(t => (
              <button
                key={t.id}
                onClick={() => {
                  if (newType === 'course') setSelectedTreatments([t.id]);
                  else toggleTreatment(t.id);
                }}
                style={{
                  ...s.treatmentChip,
                  background: selectedTreatments.includes(t.id) ? '#FBF0F3' : 'transparent',
                  border: selectedTreatments.includes(t.id) ? '1px solid #C76B8A' : '1px solid var(--border, #F0ECE8)',
                  color: selectedTreatments.includes(t.id) ? '#C76B8A' : 'var(--text, #2D2A26)',
                }}
              >
                <span style={s.treatmentChipName}>{t.name}</span>
                <span style={s.treatmentChipPrice}>{pence(t.price_cents)}</span>
              </button>
            ))}
          </div>

          {/* Sessions (course only) */}
          {newType === 'course' && (
            <div style={s.fieldGroup}>
              <span style={s.fieldLabel}>Sessions</span>
              <div style={s.chipRow}>
                {[3, 4, 6, 8, 10].map(v => (
                  <button
                    key={v}
                    onClick={() => setNewSessions(v)}
                    style={{
                      ...s.numChip,
                      background: newSessions === v ? '#C76B8A' : 'var(--card-bg, #fff)',
                      color: newSessions === v ? '#fff' : 'var(--text, #2D2A26)',
                      border: newSessions === v ? '1px solid #C76B8A' : '1px solid var(--border, #E8E4E0)',
                    }}
                  >
                    {v}x
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Discount */}
          <div style={s.fieldGroup}>
            <span style={s.fieldLabel}>Discount</span>
            <div style={s.chipRow}>
              {[5, 10, 15, 20, 25].map(v => (
                <button
                  key={v}
                  onClick={() => setDiscountPercent(v)}
                  style={{
                    ...s.numChip,
                    background: discountPercent === v ? '#C76B8A' : 'var(--card-bg, #fff)',
                    color: discountPercent === v ? '#fff' : 'var(--text, #2D2A26)',
                    border: discountPercent === v ? '1px solid #C76B8A' : '1px solid var(--border, #E8E4E0)',
                  }}
                >
                  {v}%
                </button>
              ))}
            </div>
          </div>

          {/* Price preview */}
          {selectedTreatments.length > 0 && (
            <div style={s.pricePreview}>
              <div style={s.priceRow}>
                <span style={s.priceLabel}>Full price</span>
                <span style={s.priceStrike}>{pence(totalBeforeDiscount)}</span>
              </div>
              <div style={s.priceRow}>
                <span style={s.priceLabel}>Package price</span>
                <span style={s.priceValue}>{pence(discountedPrice)}</span>
              </div>
              <div style={s.priceRow}>
                <span style={s.priceLabel}>Client saves</span>
                <span style={s.priceSave}>{pence(savings)}</span>
              </div>
            </div>
          )}

          <button
            style={{ ...s.saveBtn, opacity: newName && selectedTreatments.length > 0 && !saving ? 1 : 0.4 }}
            disabled={!newName || selectedTreatments.length === 0 || saving}
            onClick={handleCreatePackage}
          >
            {saving ? 'Creating…' : 'Create package'}
          </button>
        </div>
      )}

      {/* Tab bar */}
      <div style={s.tabBar}>
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              ...s.tab,
              color: tab === t.key ? '#C76B8A' : 'var(--text-muted, #AAA5A0)',
              borderBottom: tab === t.key ? '2px solid #C76B8A' : '2px solid transparent',
              fontWeight: tab === t.key ? 600 : 400,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* Packages list */}
      {tab === 'packages' && (
        <div style={s.list}>
          {packages.length === 0 && <p style={{ textAlign: 'center', color: '#AAA5A0', fontSize: 14, padding: 32 }}>No packages yet. Create your first one above.</p>}
          {packages.map(pkg => {
            const fullP = pkg.full_price_cents || pkg.fullPrice || 0;
            const pkgP = pkg.price_cents || pkg.price || 0;
            return (
              <div key={pkg.id} style={s.pkgCard}>
                <div style={s.pkgTop}>
                  <div>
                    <span style={s.pkgName}>{pkg.name}</span>
                    <span style={s.pkgDesc}>{pkg.description}</span>
                  </div>
                  <span style={{
                    ...s.typeBadge,
                    background: pkg.type === 'bundle' ? '#E8F5E9' : '#E3F2FD',
                    color: pkg.type === 'bundle' ? '#2E7D32' : '#1565C0',
                  }}>{pkg.type}</span>
                </div>
                <div style={s.pkgPriceRow}>
                  {fullP > pkgP && <span style={s.pkgFullPrice}>{pence(fullP)}</span>}
                  <span style={s.pkgPrice}>{pence(pkgP)}</span>
                  {fullP > pkgP && <span style={s.pkgSave}>Save {pence(fullP - pkgP)}</span>}
                </div>
                <div style={s.pkgStats}>
                  <span style={s.pkgStat}>{pkg.sold || 0} sold</span>
                  <span style={s.pkgStatDot}>·</span>
                  <span style={s.pkgStat}>{pkg.sessions || 1} session{(pkg.sessions || 1) > 1 ? 's' : ''}</span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Active client packages */}
      {tab === 'active' && (
        <div style={s.list}>
          {clientPackages.length === 0 && <p style={{ textAlign: 'center', color: '#AAA5A0', fontSize: 14, padding: 32 }}>No active client packages.</p>}
          {clientPackages.map(cp => {
            const pct = (cp.sessionsUsed / cp.sessionsTotal) * 100;
            return (
              <div key={cp.id} style={s.activeCard}>
                <div style={s.activeTop}>
                  <div style={s.activeAvatar}>{cp.client[0]}</div>
                  <div style={s.activeInfo}>
                    <span style={s.activeName}>{cp.client}</span>
                    <span style={s.activePkg}>{cp.package}</span>
                  </div>
                  <span style={s.activeCount}>{cp.sessionsUsed}/{cp.sessionsTotal}</span>
                </div>
                <div style={s.progressBar}>
                  <div style={{ ...s.progressFill, width: `${pct}%` }} />
                </div>
                <span style={s.activeDate}>Purchased {new Date(cp.purchasedAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}</span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const s = {
  page: { padding: '16px 16px 32px', maxWidth: 480, margin: '0 auto', fontFamily: '"DM Sans", -apple-system, sans-serif' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 },
  title: { fontSize: 24, fontWeight: 700, color: 'var(--text, #2D2A26)', margin: 0 },
  sub: { fontSize: 13, color: 'var(--text-muted, #AAA5A0)', margin: '4px 0 0' },
  addBtn: { padding: '8px 16px', borderRadius: 10, border: 'none', background: '#C76B8A', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  statsRow: { display: 'flex', gap: 8, marginBottom: 16 },
  statCard: { flex: 1, background: 'var(--card-bg, #fff)', borderRadius: 12, padding: '12px 10px', textAlign: 'center', border: '1px solid var(--border, #F0ECE8)' },
  statValue: { display: 'block', fontSize: 20, fontWeight: 700, color: 'var(--text, #2D2A26)' },
  statLabel: { display: 'block', fontSize: 10, color: 'var(--text-muted, #AAA5A0)', textTransform: 'uppercase', letterSpacing: '0.03em' },
  createForm: { background: 'var(--card-bg, #fff)', borderRadius: 14, padding: 16, marginBottom: 16, border: '1px solid var(--border, #F0ECE8)' },
  formTitle: { display: 'block', fontSize: 16, fontWeight: 700, color: 'var(--text, #2D2A26)', marginBottom: 12 },
  chipRow: { display: 'flex', gap: 8, marginBottom: 12 },
  typeChip: { padding: '8px 20px', borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  input: { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1.5px solid var(--border, #F0ECE8)', fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', marginBottom: 10, background: 'var(--bg, #FAF8F5)', color: 'var(--text, #2D2A26)' },
  fieldLabel: { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-muted, #AAA5A0)', marginBottom: 6 },
  fieldGroup: { marginBottom: 12 },
  treatmentPicker: { display: 'flex', flexDirection: 'column', gap: 4, maxHeight: 200, overflowY: 'auto', marginBottom: 12 },
  treatmentChip: { display: 'flex', justifyContent: 'space-between', padding: '10px 12px', borderRadius: 8, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left', width: '100%' },
  treatmentChipName: { fontSize: 13, fontWeight: 500 },
  treatmentChipPrice: { fontSize: 13, fontWeight: 600, flexShrink: 0 },
  numChip: { padding: '8px 14px', borderRadius: 10, fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  pricePreview: { background: 'var(--bg, #FAF8F5)', borderRadius: 10, padding: 12, marginBottom: 12 },
  priceRow: { display: 'flex', justifyContent: 'space-between', padding: '4px 0' },
  priceLabel: { fontSize: 13, color: 'var(--text-muted, #AAA5A0)' },
  priceStrike: { fontSize: 13, color: 'var(--text-muted, #AAA5A0)', textDecoration: 'line-through' },
  priceValue: { fontSize: 15, fontWeight: 700, color: 'var(--text, #2D2A26)' },
  priceSave: { fontSize: 13, fontWeight: 600, color: '#4CAF50' },
  saveBtn: { width: '100%', padding: '12px 0', borderRadius: 12, border: 'none', background: '#C76B8A', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  tabBar: { display: 'flex', borderBottom: '1px solid var(--border, #F0ECE8)', marginBottom: 14 },
  tab: { flex: 1, padding: '10px 0', background: 'none', border: 'none', cursor: 'pointer', fontSize: 13, fontFamily: 'inherit', textAlign: 'center' },
  list: { display: 'flex', flexDirection: 'column', gap: 10 },
  pkgCard: { background: 'var(--card-bg, #fff)', borderRadius: 14, padding: 14, border: '1px solid var(--border, #F0ECE8)' },
  pkgTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 },
  pkgName: { display: 'block', fontSize: 15, fontWeight: 700, color: 'var(--text, #2D2A26)' },
  pkgDesc: { display: 'block', fontSize: 12, color: 'var(--text-muted, #AAA5A0)', marginTop: 2 },
  typeBadge: { fontSize: 10, fontWeight: 600, padding: '3px 8px', borderRadius: 6, textTransform: 'uppercase', letterSpacing: '0.03em' },
  pkgPriceRow: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 },
  pkgFullPrice: { fontSize: 13, color: 'var(--text-muted, #AAA5A0)', textDecoration: 'line-through' },
  pkgPrice: { fontSize: 16, fontWeight: 700, color: '#C76B8A' },
  pkgSave: { fontSize: 11, fontWeight: 600, color: '#4CAF50', background: '#E8F5E9', padding: '2px 6px', borderRadius: 4 },
  pkgStats: { display: 'flex', alignItems: 'center', gap: 4 },
  pkgStat: { fontSize: 11, color: 'var(--text-muted, #AAA5A0)' },
  pkgStatDot: { fontSize: 11, color: 'var(--text-muted, #AAA5A0)' },
  activeCard: { background: 'var(--card-bg, #fff)', borderRadius: 14, padding: 14, border: '1px solid var(--border, #F0ECE8)' },
  activeTop: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 },
  activeAvatar: { width: 36, height: 36, borderRadius: 18, background: 'linear-gradient(135deg, #C76B8A22, #C76B8A44)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 14, fontWeight: 700, color: '#C76B8A', flexShrink: 0 },
  activeInfo: { flex: 1 },
  activeName: { display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  activePkg: { display: 'block', fontSize: 12, color: 'var(--text-muted, #AAA5A0)' },
  activeCount: { fontSize: 16, fontWeight: 700, color: '#C76B8A' },
  progressBar: { height: 6, borderRadius: 3, background: 'var(--border, #F0ECE8)', overflow: 'hidden', marginBottom: 6 },
  progressFill: { height: '100%', borderRadius: 3, background: '#C76B8A', transition: 'width 0.3s' },
  activeDate: { fontSize: 11, color: 'var(--text-muted, #AAA5A0)' },
};
