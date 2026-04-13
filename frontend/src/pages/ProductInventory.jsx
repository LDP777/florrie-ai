/**
 * Product Inventory — Track stock, reorder points & supplier info.
 *
 * Beauticians bleed money on last-minute supply runs and expired stock.
 * This page makes product management dead simple: quantities, alerts,
 * cost-per-use, and one-tap reorder reminders.
 */
import { useState, useEffect } from 'react';
import { useBeautician, fetchRows, insertRow, updateRow } from '../lib/supabase.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';

const fmt = (cents) => `£${(cents / 100).toFixed(2)}`;

const CATEGORIES = [
  { key: 'all', label: 'All' },
  { key: 'tint', label: 'Tint & Colour' },
  { key: 'wax', label: 'Wax' },
  { key: 'aftercare', label: 'Aftercare' },
  { key: 'tools', label: 'Tools' },
  { key: 'retail', label: 'Retail' },
];

const STATUS_CFG = {
  ok: { label: 'In Stock', bg: 'var(--success-bg, #E8F5E9)', color: 'var(--success, #5BA97B)' },
  low: { label: 'Low Stock', bg: '#FFF5E6', color: '#FF9800' },
  out: { label: 'Out of Stock', bg: 'var(--danger-bg, #FDF0EF)', color: '#F44336' },
};

export default function ProductInventory() {
  const { beautician, loading: bLoading } = useBeautician();
  const [catFilter, setCatFilter] = useState('all');
  const [expanded, setExpanded] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [sortBy, setSortBy] = useState('status'); // status | name | qty
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);

  // New product form state
  const [newProduct, setNewProduct] = useState({ name: '', category: 'tint', qty: 0, unit: '', reorderAt: 5, costPer: 0, usesPerUnit: 1, supplier: '' });

  useEffect(() => {
    if (bLoading || !beautician) return;
    setLoading(true);
    fetchRows('product_inventory', beautician.id, { order: 'name', ascending: true })
      .then(rows => {
        if (rows && rows.length > 0) {
          // Compute status from qty vs reorderAt
          const withStatus = rows.map(p => ({
            ...p,
            status: p.qty <= 0 ? 'out' : p.qty <= (p.reorder_at || 0) ? 'low' : 'ok',
            reorderAt: p.reorder_at,
            costPer: p.cost_per_unit_cents,
            usesPerUnit: p.uses_per_unit,
            lastOrdered: p.last_ordered,
            retailPrice: p.retail_price_cents,
          }));
          setProducts(withStatus);
        } else {
          setProducts([]);
        }
      })
      .catch(err => {
        logger.error({ err }, 'Failed to load inventory');
        setProducts([]);
      })
      .finally(() => setLoading(false));
  }, [beautician, bLoading]);

  async function handleAddProduct() {
    const product = {
      beautician_id: beautician.id,
      name: newProduct.name,
      category: newProduct.category,
      qty: Number(newProduct.qty) || 0,
      unit: newProduct.unit,
      reorder_at: Number(newProduct.reorderAt) || 5,
      cost_per_unit_cents: Math.round(Number(newProduct.costPer) * 100) || 0,
      uses_per_unit: Number(newProduct.usesPerUnit) || 1,
      supplier: newProduct.supplier,
    };
    try {
      const created = await insertRow('product_inventory', product);
      const withStatus = {
        ...created,
        status: created.qty <= 0 ? 'out' : created.qty <= (created.reorder_at || 0) ? 'low' : 'ok',
        reorderAt: created.reorder_at,
        costPer: created.cost_per_unit_cents,
        usesPerUnit: created.uses_per_unit,
        lastOrdered: created.last_ordered,
      };
      setProducts(prev => [...prev, withStatus]);
      setShowAdd(false);
      setNewProduct({ name: '', category: 'tint', qty: 0, unit: '', reorderAt: 5, costPer: 0, usesPerUnit: 1, supplier: '' });
    } catch (err) {
      logger.error({ err }, 'Failed to add product');
    }
  }

  if (bLoading || loading) return <PageLoader />;
  if (products.length === 0) return <EmptyState title="No products yet" description="Add your first product to start tracking inventory." />;
  const filtered = catFilter === 'all' ? products : products.filter(p => p.category === catFilter);

  const sorted = [...filtered].sort((a, b) => {
    if (sortBy === 'status') {
      const order = { out: 0, low: 1, ok: 2 };
      return order[a.status] - order[b.status];
    }
    if (sortBy === 'qty') return a.qty - b.qty;
    return a.name.localeCompare(b.name);
  });

  const lowCount = products.filter(p => p.status === 'low').length;
  const outCount = products.filter(p => p.status === 'out').length;
  const totalValue = products.reduce((s, p) => s + (p.qty * p.costPer), 0);

  return (
    <div style={S.page}>
      <h1 style={S.title}>Inventory</h1>

      {/* Summary */}
      <div style={S.summaryRow}>
        <div style={S.summaryCard}>
          <span style={S.summaryNum}>{products.length}</span>
          <span style={S.summaryLabel}>Products</span>
        </div>
        <div style={{ ...S.summaryCard, ...(lowCount > 0 ? { border: '1px solid var(--warning, #FF9800)' } : {}) }}>
          <span style={{ ...S.summaryNum, color: 'var(--warning, #FF9800)' }}>{lowCount}</span>
          <span style={S.summaryLabel}>Low Stock</span>
        </div>
        <div style={{ ...S.summaryCard, ...(outCount > 0 ? { border: '1px solid var(--danger, #F44336)' } : {}) }}>
          <span style={{ ...S.summaryNum, color: 'var(--danger, #F44336)' }}>{outCount}</span>
          <span style={S.summaryLabel}>Out</span>
        </div>
        <div style={S.summaryCard}>
          <span style={S.summaryNum}>{fmt(totalValue)}</span>
          <span style={S.summaryLabel}>Value</span>
        </div>
      </div>

      {/* Alerts */}
      {(lowCount > 0 || outCount > 0) && (
        <div style={S.alertCard}>
          <span style={S.alertIcon}>⚠️</span>
          <div style={S.alertText}>
            {outCount > 0 && <span style={{ color: 'var(--danger, #F44336)', fontWeight: 600, fontSize: 13 }}>{outCount} product{outCount !== 1 ? 's' : ''} out of stock. </span>}
            {lowCount > 0 && <span style={{ color: 'var(--warning, #FF9800)', fontWeight: 600, fontSize: 13 }}>{lowCount} running low.</span>}
          </div>
        </div>
      )}

      {/* Category filter */}
      <div style={S.filterRow}>
        {CATEGORIES.map(c => (
          <button key={c.key} onClick={() => setCatFilter(c.key)} style={{ ...S.filterChip, ...(catFilter === c.key ? S.filterChipActive : {}) }}>
            {c.label}
          </button>
        ))}
      </div>

      {/* Sort */}
      <div style={S.sortRow}>
        <span style={S.sortLabel}>Sort:</span>
        {['status', 'name', 'qty'].map(s => (
          <button key={s} onClick={() => setSortBy(s)} style={{ ...S.sortBtn, ...(sortBy === s ? S.sortBtnActive : {}) }}>
            {s === 'status' ? 'Urgency' : s === 'name' ? 'Name' : 'Quantity'}
          </button>
        ))}
      </div>

      {/* Product list */}
      <div style={S.list}>
        {sorted.map(prod => {
          const isExp = expanded === prod.id;
          const st = STATUS_CFG[prod.status];
          const costPerUse = prod.usesPerUnit > 0 ? Math.round(prod.costPer / prod.usesPerUnit) : prod.costPer;
          return (
            <div key={prod.id} style={{ ...S.card, borderLeft: `3px solid ${st.color}` }} onClick={() => setExpanded(isExp ? null : prod.id)}>
              <div style={S.cardHeader}>
                <div style={S.cardLeft}>
                  <div style={S.cardInfo}>
                    <span style={S.cardName}>{prod.name}</span>
                    <span style={S.cardMeta}>{prod.qty} {prod.unit} · {fmt(costPerUse)}/use</span>
                  </div>
                </div>
                <span style={{ ...S.statusBadge, background: st.bg, color: st.color }}>{st.label}</span>
              </div>

              {isExp && (
                <div style={S.expandedSection}>
                  <div style={S.detailGrid}>
                    <div style={S.detailItem}>
                      <span style={S.detailLabel}>In Stock</span>
                      <span style={S.detailValue}>{prod.qty} {prod.unit}</span>
                    </div>
                    <div style={S.detailItem}>
                      <span style={S.detailLabel}>Reorder At</span>
                      <span style={S.detailValue}>{prod.reorderAt} {prod.unit}</span>
                    </div>
                    <div style={S.detailItem}>
                      <span style={S.detailLabel}>Cost/Unit</span>
                      <span style={S.detailValue}>{fmt(prod.costPer)}</span>
                    </div>
                    <div style={S.detailItem}>
                      <span style={S.detailLabel}>Uses/Unit</span>
                      <span style={S.detailValue}>{prod.usesPerUnit}</span>
                    </div>
                    <div style={S.detailItem}>
                      <span style={S.detailLabel}>Supplier</span>
                      <span style={S.detailValue}>{prod.supplier}</span>
                    </div>
                    <div style={S.detailItem}>
                      <span style={S.detailLabel}>Last Ordered</span>
                      <span style={S.detailValue}>{formatDate(prod.lastOrdered)}</span>
                    </div>
                    {prod.retailPrice && (
                      <div style={S.detailItem}>
                        <span style={S.detailLabel}>Retail Price</span>
                        <span style={{ ...S.detailValue, color: 'var(--accent, #C76B8A)' }}>{fmt(prod.retailPrice)}</span>
                      </div>
                    )}
                    {prod.retailPrice && (
                      <div style={S.detailItem}>
                        <span style={S.detailLabel}>Margin</span>
                        <span style={{ ...S.detailValue, color: 'var(--success, #5BA97B)' }}>{Math.round(((prod.retailPrice - prod.costPer) / prod.retailPrice) * 100)}%</span>
                      </div>
                    )}
                  </div>

                  {/* Stock bar */}
                  <div style={S.stockBar}>
                    <div style={S.stockTrack}>
                      <div style={{ ...S.stockFill, width: `${Math.min(100, (prod.qty / (prod.reorderAt * 2)) * 100)}%`, background: st.color }} />
                    </div>
                  </div>

                  <div style={S.actionRow}>
                    <button style={{ ...S.actionBtn, background: 'var(--accent, #C76B8A)', color: '#fff' }}>Restock</button>
                    <button style={S.actionBtn}>Adjust Qty</button>
                    <button style={S.actionBtn}>Edit</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* FAB */}
      {!showAdd && <button style={S.fab} onClick={() => setShowAdd(true)}>+</button>}

      {/* Add modal */}
      {showAdd && (
        <div style={S.overlay} onClick={() => setShowAdd(false)}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <div style={S.modalHeader}>
              <h2 style={S.modalTitle}>Add Product</h2>
              <button style={S.closeBtn} onClick={() => setShowAdd(false)}>✕</button>
            </div>
            <div style={S.formBody}>
              <label style={S.fLabel}>Product Name</label>
              <input style={S.input} placeholder="e.g. HD Brows Tint – Blonde" value={newProduct.name} onChange={e => setNewProduct(p => ({ ...p, name: e.target.value }))} />
              <label style={S.fLabel}>Category</label>
              <div style={S.catGrid}>
                {CATEGORIES.filter(c => c.key !== 'all').map(c => (
                  <button key={c.key} style={{ ...S.catBtn, ...(newProduct.category === c.key ? { background: 'var(--accent, #C76B8A)', color: '#fff' } : {}) }} onClick={() => setNewProduct(p => ({ ...p, category: c.key }))}>{c.label}</button>
                ))}
              </div>
              <label style={S.fLabel}>Current Quantity</label>
              <input style={S.input} type="number" placeholder="0" value={newProduct.qty || ''} onChange={e => setNewProduct(p => ({ ...p, qty: e.target.value }))} />
              <label style={S.fLabel}>Unit</label>
              <input style={S.input} placeholder="e.g. tubes, bottles, pcs" value={newProduct.unit} onChange={e => setNewProduct(p => ({ ...p, unit: e.target.value }))} />
              <label style={S.fLabel}>Reorder Point</label>
              <input style={S.input} type="number" placeholder="5" value={newProduct.reorderAt || ''} onChange={e => setNewProduct(p => ({ ...p, reorderAt: e.target.value }))} />
              <label style={S.fLabel}>Cost per Unit (£)</label>
              <input style={S.input} type="number" step="0.01" placeholder="8.50" value={newProduct.costPer || ''} onChange={e => setNewProduct(p => ({ ...p, costPer: e.target.value }))} />
              <label style={S.fLabel}>Uses per Unit</label>
              <input style={S.input} type="number" placeholder="12" value={newProduct.usesPerUnit || ''} onChange={e => setNewProduct(p => ({ ...p, usesPerUnit: e.target.value }))} />
              <label style={S.fLabel}>Supplier</label>
              <input style={S.input} placeholder="e.g. HD Brows Direct" value={newProduct.supplier} onChange={e => setNewProduct(p => ({ ...p, supplier: e.target.value }))} />
            </div>
            <button style={S.saveBtn} onClick={handleAddProduct} disabled={!newProduct.name}>Add Product</button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatDate(d) {
  return new Date(d + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

const S = {
  page: { padding: '20px 16px 100px', fontFamily: '"DM Sans", -apple-system, sans-serif', maxWidth: 480, margin: '0 auto' },
  title: { fontSize: 22, fontWeight: 700, color: 'var(--text, var(--text-primary, #2D2A26))', margin: '0 0 16px' },
  summaryRow: { display: 'flex', gap: 6, marginBottom: 12 },
  summaryCard: { flex: 1, background: 'var(--card, #fff)', borderRadius: 12, padding: '12px 6px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 },
  summaryNum: { fontSize: 18, fontWeight: 700, color: 'var(--accent, #C76B8A)' },
  summaryLabel: { fontSize: 10, color: 'var(--text-muted, var(--text-muted, #B5AFA8))', fontWeight: 500 },
  alertCard: { background: 'var(--warning-bg, #FFF5E6)', borderRadius: 12, padding: '12px 14px', display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 },
  alertIcon: { fontSize: 18 },
  alertText: { flex: 1 },
  filterRow: { display: 'flex', gap: 6, overflowX: 'auto', marginBottom: 10, paddingBottom: 4 },
  filterChip: { padding: '7px 14px', borderRadius: 20, border: '1px solid var(--border, var(--border, #EDE9E4))', background: 'var(--card, #fff)', fontSize: 12, fontWeight: 600, color: 'var(--text-muted, var(--text-muted, #B5AFA8))', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
  filterChipActive: { background: 'var(--accent, #C76B8A)', color: '#fff', border: '1px solid var(--accent, #C76B8A)' },
  sortRow: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 },
  sortLabel: { fontSize: 12, color: 'var(--text-muted, var(--text-muted, #B5AFA8))', fontWeight: 600 },
  sortBtn: { padding: '5px 12px', borderRadius: 8, border: '1px solid var(--border, var(--border, #EDE9E4))', background: 'var(--card, #fff)', fontSize: 11, fontWeight: 600, color: 'var(--text-muted, var(--text-muted, #B5AFA8))', cursor: 'pointer', fontFamily: 'inherit' },
  sortBtnActive: { background: '#F0E6ED', color: 'var(--accent, #C76B8A)', border: '1px solid var(--accent, #C76B8A)20' },
  list: { display: 'flex', flexDirection: 'column', gap: 8 },
  card: { background: 'var(--card, #fff)', borderRadius: 14, padding: 14, cursor: 'pointer' },
  cardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  cardLeft: { display: 'flex', gap: 10, alignItems: 'center', flex: 1, minWidth: 0 },
  cardInfo: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
  cardName: { fontSize: 14, fontWeight: 600, color: 'var(--text, var(--text-primary, #2D2A26))', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  cardMeta: { fontSize: 12, color: 'var(--text-muted, var(--text-muted, #B5AFA8))' },
  statusBadge: { padding: '3px 10px', borderRadius: 8, fontSize: 10, fontWeight: 600, flexShrink: 0 },
  expandedSection: { marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border, var(--border, #EDE9E4))' },
  detailGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 10 },
  detailItem: { display: 'flex', flexDirection: 'column', gap: 2 },
  detailLabel: { fontSize: 11, color: 'var(--text-muted, var(--text-muted, #B5AFA8))', fontWeight: 600 },
  detailValue: { fontSize: 13, fontWeight: 600, color: 'var(--text, var(--text-primary, #2D2A26))' },
  stockBar: { marginBottom: 10 },
  stockTrack: { height: 6, borderRadius: 3, background: 'var(--border, var(--border, #EDE9E4))', overflow: 'hidden' },
  stockFill: { height: '100%', borderRadius: 3, transition: 'width .3s' },
  actionRow: { display: 'flex', gap: 8 },
  actionBtn: { flex: 1, padding: '9px 0', borderRadius: 8, border: '1px solid var(--border, var(--border, #EDE9E4))', background: 'var(--card, #fff)', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-primary, #2D2A26)' },
  fab: { position: 'fixed', bottom: 80, right: 20, width: 52, height: 52, borderRadius: 26, background: 'var(--accent, #C76B8A)', color: '#fff', fontSize: 26, border: 'none', cursor: 'pointer', boxShadow: '0 4px 12px rgba(199,107,138,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'inherit', zIndex: 50 },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 100, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' },
  modal: { background: 'var(--bg, var(--bg, #FAF8F5))', borderRadius: '18px 18px 0 0', width: '100%', maxWidth: 480, maxHeight: '85vh', overflow: 'auto', padding: '20px 16px 32px' },
  modalHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  modalTitle: { fontSize: 18, fontWeight: 700, color: 'var(--text, var(--text-primary, #2D2A26))', margin: 0 },
  closeBtn: { background: 'none', border: 'none', fontSize: 18, color: 'var(--text-muted, var(--text-muted, #B5AFA8))', cursor: 'pointer' },
  formBody: { display: 'flex', flexDirection: 'column', gap: 10 },
  fLabel: { fontSize: 12, fontWeight: 600, color: 'var(--text-muted, var(--text-muted, #B5AFA8))', marginTop: 4 },
  input: { padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border, var(--border, #EDE9E4))', fontSize: 14, fontFamily: 'inherit', color: 'var(--text, var(--text-primary, #2D2A26))', background: 'var(--card, #fff)' },
  catGrid: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  catBtn: { padding: '7px 14px', borderRadius: 8, border: '1px solid var(--border, var(--border, #EDE9E4))', background: 'var(--card, #fff)', fontSize: 12, fontWeight: 600, color: 'var(--text-muted, var(--text-muted, #B5AFA8))', cursor: 'pointer', fontFamily: 'inherit' },
  saveBtn: { marginTop: 16, width: '100%', padding: '14px 0', borderRadius: 12, border: 'none', background: 'var(--accent, #C76B8A)', color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
};
