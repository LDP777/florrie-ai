/**
 * Product Inventory - Track stock, reorder points & supplier info.
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
import { todayLocal } from '../lib/dates.js';
import Icon from '../components/ui/Icon';

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
  ok: { label: 'In Stock', bg: 'var(--success-bg, #E9F0EB)', color: 'var(--success, #3F7D5C)' },
  low: { label: 'Low Stock', bg: 'var(--warning-bg, #F7EEDD)', color: 'var(--warning, #8A6420)' },
  out: { label: 'Out of Stock', bg: 'var(--danger-bg, #F7E4E4)', color: 'var(--danger, #9E2B32)' },
};

export default function ProductInventory() {
  const { beautician, loading: bLoading } = useBeautician();
  const [catFilter, setCatFilter] = useState('all');
  const [expanded, setExpanded] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editingId, setEditingId] = useState(null);
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

  function decorate(row) {
    return {
      ...row,
      status: row.qty <= 0 ? 'out' : row.qty <= (row.reorder_at || 0) ? 'low' : 'ok',
      reorderAt: row.reorder_at,
      costPer: row.cost_per_unit_cents,
      usesPerUnit: row.uses_per_unit,
      lastOrdered: row.last_ordered,
      retailPrice: row.retail_price_cents,
    };
  }

  async function handleAddProduct() {
    const fields = {
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
      if (editingId) {
        const updated = await updateRow('product_inventory', editingId, fields);
        const decorated = decorate(updated);
        setProducts(prev => prev.map(p => (p.id === editingId ? decorated : p)));
      } else {
        const created = await insertRow('product_inventory', { beautician_id: beautician.id, ...fields });
        setProducts(prev => [...prev, decorate(created)]);
      }
      setShowAdd(false);
      setEditingId(null);
      setNewProduct({ name: '', category: 'tint', qty: 0, unit: '', reorderAt: 5, costPer: 0, usesPerUnit: 1, supplier: '' });
    } catch (err) {
      logger.error({ err }, 'Failed to save product');
    }
  }

  function openEdit(prod) {
    setNewProduct({
      name: prod.name || '',
      category: prod.category || 'tint',
      qty: prod.qty ?? 0,
      unit: prod.unit || '',
      reorderAt: prod.reorderAt ?? 5,
      costPer: prod.costPer ? (prod.costPer / 100) : 0,
      usesPerUnit: prod.usesPerUnit ?? 1,
      supplier: prod.supplier || '',
    });
    setEditingId(prod.id);
    setShowAdd(true);
  }

  async function handleRestock(prod) {
    const input = prompt(`How many ${prod.unit || 'units'} are you adding to stock?`, String(prod.reorderAt || 5));
    if (input === null) return;
    const add = Number(input);
    if (!Number.isFinite(add) || add <= 0) return;
    try {
      const updated = await updateRow('product_inventory', prod.id, {
        qty: (Number(prod.qty) || 0) + add,
        last_ordered: todayLocal(),
      });
      setProducts(prev => prev.map(p => (p.id === prod.id ? decorate(updated) : p)));
    } catch (err) {
      logger.error({ err }, 'Failed to restock');
    }
  }

  async function handleAdjustQty(prod) {
    const input = prompt(`Set current quantity (${prod.unit || 'units'})`, String(prod.qty ?? 0));
    if (input === null) return;
    const next = Number(input);
    if (!Number.isFinite(next) || next < 0) return;
    try {
      const updated = await updateRow('product_inventory', prod.id, { qty: next });
      setProducts(prev => prev.map(p => (p.id === prod.id ? decorate(updated) : p)));
    } catch (err) {
      logger.error({ err }, 'Failed to adjust quantity');
    }
  }

  if (bLoading || loading) return <PageLoader />;

  if (products.length === 0) return (
    <div style={S.page}>
      <h1 style={S.title}>Inventory</h1>
      <EmptyState title="No products yet" description="Add your first product to start tracking inventory." />
      <button style={S.fab} onClick={() => setShowAdd(true)}>+</button>
      {showAdd && (
        <div style={S.overlay} onClick={() => setShowAdd(false)}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <div style={S.modalHeader}>
              <h2 style={S.modalTitle}>Add Product</h2>
              <button style={S.closeBtn} onClick={() => setShowAdd(false)}><Icon name="x" size={15} /></button>
            </div>
            <div style={S.formBody}>
              <label style={S.fLabel}>Product Name</label>
              <input style={S.input} placeholder="e.g. HD Brows Tint – Blonde" value={newProduct.name} onChange={e => setNewProduct(p => ({ ...p, name: e.target.value }))} />
              <label style={S.fLabel}>Category</label>
              <div style={S.catGrid}>
                {CATEGORIES.filter(c => c.key !== 'all').map(c => (
                  <button key={c.key} style={{ ...S.catBtn, ...(newProduct.category === c.key ? { background: 'var(--accent, #92405e)', color: '#fff' } : {}) }} onClick={() => setNewProduct(p => ({ ...p, category: c.key }))}>{c.label}</button>
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
        <div style={{ ...S.summaryCard, ...(lowCount > 0 ? { border: '1px solid var(--warning, #8A6420)' } : {}) }}>
          <span style={{ ...S.summaryNum, color: 'var(--warning, #8A6420)' }}>{lowCount}</span>
          <span style={S.summaryLabel}>Low Stock</span>
        </div>
        <div style={{ ...S.summaryCard, ...(outCount > 0 ? { border: '1px solid var(--danger, #9E2B32)' } : {}) }}>
          <span style={{ ...S.summaryNum, color: 'var(--danger, #9E2B32)' }}>{outCount}</span>
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
          <span style={S.alertIcon}><Icon name="alert-triangle" size={15} /></span>
          <div style={S.alertText}>
            {outCount > 0 && <span style={{ color: 'var(--danger, #9E2B32)', fontWeight: 600, fontSize: 13 }}>{outCount} product{outCount !== 1 ? 's' : ''} out of stock. </span>}
            {lowCount > 0 && <span style={{ color: 'var(--warning, #8A6420)', fontWeight: 600, fontSize: 13 }}>{lowCount} running low.</span>}
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
                        <span style={{ ...S.detailValue, color: 'var(--accent, #92405e)' }}>{fmt(prod.retailPrice)}</span>
                      </div>
                    )}
                    {prod.retailPrice && (
                      <div style={S.detailItem}>
                        <span style={S.detailLabel}>Margin</span>
                        <span style={{ ...S.detailValue, color: 'var(--success, #3F7D5C)' }}>{Math.round(((prod.retailPrice - prod.costPer) / prod.retailPrice) * 100)}%</span>
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
                    <button style={{ ...S.actionBtn, background: 'var(--accent, #92405e)', color: '#fff' }} onClick={(e) => { e.stopPropagation(); handleRestock(prod); }}>Restock</button>
                    <button style={S.actionBtn} onClick={(e) => { e.stopPropagation(); handleAdjustQty(prod); }}>Adjust Qty</button>
                    <button style={S.actionBtn} onClick={(e) => { e.stopPropagation(); openEdit(prod); }}>Edit</button>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* FAB */}
      {!showAdd && <button style={S.fab} onClick={() => { setEditingId(null); setNewProduct({ name: '', category: 'tint', qty: 0, unit: '', reorderAt: 5, costPer: 0, usesPerUnit: 1, supplier: '' }); setShowAdd(true); }}>+</button>}

      {/* Add / edit modal */}
      {showAdd && (
        <div style={S.overlay} onClick={() => { setShowAdd(false); setEditingId(null); }}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <div style={S.modalHeader}>
              <h2 style={S.modalTitle}>{editingId ? 'Edit Product' : 'Add Product'}</h2>
              <button style={S.closeBtn} onClick={() => { setShowAdd(false); setEditingId(null); }}><Icon name="x" size={15} /></button>
            </div>
            <div style={S.formBody}>
              <label style={S.fLabel}>Product Name</label>
              <input style={S.input} placeholder="e.g. HD Brows Tint – Blonde" value={newProduct.name} onChange={e => setNewProduct(p => ({ ...p, name: e.target.value }))} />
              <label style={S.fLabel}>Category</label>
              <div style={S.catGrid}>
                {CATEGORIES.filter(c => c.key !== 'all').map(c => (
                  <button key={c.key} style={{ ...S.catBtn, ...(newProduct.category === c.key ? { background: 'var(--accent, #92405e)', color: '#fff' } : {}) }} onClick={() => setNewProduct(p => ({ ...p, category: c.key }))}>{c.label}</button>
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
            <button style={S.saveBtn} onClick={handleAddProduct} disabled={!newProduct.name}>{editingId ? 'Save Changes' : 'Add Product'}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatDate(d) {
  if (!d) return '-';
  const parsed = new Date(d + 'T00:00:00');
  if (isNaN(parsed)) return '-';
  return parsed.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

const S = {
  page: { padding: '20px 16px 100px', fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif", maxWidth: 480, margin: '0 auto' },
  title: { fontSize: 22, fontWeight: 700, color: 'var(--text, var(--text-primary, #241B17))', margin: '0 0 16px' },
  summaryRow: { display: 'flex', gap: 6, marginBottom: 12 },
  summaryCard: { flex: 1, background: 'var(--card, #FFFCF9)', borderRadius: 10, padding: '12px 6px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 },
  summaryNum: { fontSize: 18, fontWeight: 700, color: 'var(--accent, #92405e)' },
  summaryLabel: { fontSize: 10, color: 'var(--text-muted, var(--text-muted, #6B5D54))', fontWeight: 500 },
  alertCard: { background: 'var(--warning-bg, #F7EEDD)', borderRadius: 10, padding: '12px 14px', display: 'flex', gap: 10, alignItems: 'center', marginBottom: 12 },
  alertIcon: { fontSize: 18 },
  alertText: { flex: 1 },
  filterRow: { display: 'flex', gap: 6, overflowX: 'auto', marginBottom: 10, paddingBottom: 4 },
  filterChip: { padding: '7px 14px', borderRadius: 22, border: '1px solid var(--border, var(--border, #E8DDD4))', background: 'var(--card, #FFFCF9)', fontSize: 12, fontWeight: 600, color: 'var(--text-muted, var(--text-muted, #6B5D54))', cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
  filterChipActive: { background: 'var(--accent, #92405e)', color: '#fff', border: '1px solid var(--accent, #92405e)' },
  sortRow: { display: 'flex', alignItems: 'center', gap: 6, marginBottom: 12 },
  sortLabel: { fontSize: 12, color: 'var(--text-muted, var(--text-muted, #6B5D54))', fontWeight: 600 },
  sortBtn: { padding: '5px 12px', borderRadius: 10, border: '1px solid var(--border, var(--border, #E8DDD4))', background: 'var(--card, #FFFCF9)', fontSize: 11, fontWeight: 600, color: 'var(--text-muted, var(--text-muted, #6B5D54))', cursor: 'pointer', fontFamily: 'inherit' },
  sortBtnActive: { background: 'var(--accent-light, #F6E7EC)', color: 'var(--accent, #92405e)', border: '1px solid var(--accent, #92405e)20' },
  list: { display: 'flex', flexDirection: 'column', gap: 8 },
  card: { background: 'var(--card, #FFFCF9)', borderRadius: 16, padding: 14, cursor: 'pointer' },
  cardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  cardLeft: { display: 'flex', gap: 10, alignItems: 'center', flex: 1, minWidth: 0 },
  cardInfo: { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 },
  cardName: { fontSize: 14, fontWeight: 600, color: 'var(--text, var(--text-primary, #241B17))', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
  cardMeta: { fontSize: 12, color: 'var(--text-muted, var(--text-muted, #6B5D54))' },
  statusBadge: { padding: '3px 10px', borderRadius: 10, fontSize: 10, fontWeight: 600, flexShrink: 0 },
  expandedSection: { marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border, var(--border, #E8DDD4))' },
  detailGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 10 },
  detailItem: { display: 'flex', flexDirection: 'column', gap: 2 },
  detailLabel: { fontSize: 11, color: 'var(--text-muted, var(--text-muted, #6B5D54))', fontWeight: 600 },
  detailValue: { fontSize: 13, fontWeight: 600, color: 'var(--text, var(--text-primary, #241B17))' },
  stockBar: { marginBottom: 10 },
  stockTrack: { height: 6, borderRadius: 6, background: 'var(--border, var(--border, #E8DDD4))', overflow: 'hidden' },
  stockFill: { height: '100%', borderRadius: 6, transition: 'width .3s' },
  actionRow: { display: 'flex', gap: 8 },
  actionBtn: { flex: 1, padding: '9px 0', borderRadius: 10, border: '1px solid var(--border, var(--border, #E8DDD4))', background: 'var(--card, #FFFCF9)', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-primary, #241B17)' },
  fab: { position: 'fixed', bottom: 'calc(env(safe-area-inset-bottom, 0px) + 80px)', left: 20, width: 52, height: 52, borderRadius: 22, background: 'var(--accent, #92405e)', color: '#fff', fontSize: 26, border: 'none', cursor: 'pointer', boxShadow: 'var(--elev-2)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'inherit', zIndex: 50 },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 100, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' },
  modal: { background: 'var(--bg, var(--bg, #FBF6F1))', borderRadius: '18px 18px 0 0', width: '100%', maxWidth: 480, maxHeight: '85vh', overflow: 'auto', padding: '20px 16px 32px' },
  modalHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  modalTitle: { fontSize: 18, fontWeight: 700, color: 'var(--text, var(--text-primary, #241B17))', margin: 0 },
  closeBtn: { background: 'none', border: 'none', fontSize: 18, color: 'var(--text-muted, var(--text-muted, #6B5D54))', cursor: 'pointer' },
  formBody: { display: 'flex', flexDirection: 'column', gap: 10 },
  fLabel: { fontSize: 12, fontWeight: 600, color: 'var(--text-muted, var(--text-muted, #6B5D54))', marginTop: 4 },
  input: { padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border, var(--border, #E8DDD4))', fontSize: 14, fontFamily: 'inherit', color: 'var(--text, var(--text-primary, #241B17))', background: 'var(--card, #FFFCF9)' },
  catGrid: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  catBtn: { padding: '7px 14px', borderRadius: 10, border: '1px solid var(--border, var(--border, #E8DDD4))', background: 'var(--card, #FFFCF9)', fontSize: 12, fontWeight: 600, color: 'var(--text-muted, var(--text-muted, #6B5D54))', cursor: 'pointer', fontFamily: 'inherit' },
  saveBtn: { marginTop: 16, width: '100%', padding: '14px 0', borderRadius: 10, border: 'none', background: 'var(--accent, #92405e)', color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
};
