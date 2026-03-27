import { useState, useEffect } from 'react';
import { useBeautician, fetchRows, isDevMode } from '../lib/supabase.js';

const DEV_SUPPLIERS = [
  { id: 1, name: 'Beauty Pro Wholesale', contact: 'Sarah M.', email: 'orders@beautypro.co.uk', phone: '0118 496 2200', leadTime: '3-5 days' },
  { id: 2, name: 'Lash & Brow Direct', contact: 'Tom H.', email: 'trade@lashandbrow.com', phone: '020 7946 0958', leadTime: '5-7 days' },
  { id: 3, name: 'SkinSafe UK', contact: 'Nina P.', email: 'wholesale@skinsafe.co.uk', phone: '0161 496 1234', leadTime: '2-3 days' },
];

const DEV_PRODUCTS = [
  { id: 1, name: 'Brow Tint — Dark Brown', supplier: 1, sku: 'BT-DB-50', stock: 3, reorderAt: 5, unit: 'tubes', unitCost: 4.20, lastOrdered: '2026-03-10' },
  { id: 2, name: 'Lash Lift Lotion (Step 1)', supplier: 2, sku: 'LL-S1-15', stock: 8, reorderAt: 4, unit: 'sachets', unitCost: 2.80, lastOrdered: '2026-03-18' },
  { id: 3, name: 'Patch Test Strips (100pk)', supplier: 3, sku: 'PT-100', stock: 1, reorderAt: 2, unit: 'packs', unitCost: 12.50, lastOrdered: '2026-02-28' },
  { id: 4, name: 'Brow Wax Strips — Small', supplier: 1, sku: 'BW-SM-200', stock: 12, reorderAt: 5, unit: 'boxes', unitCost: 8.90, lastOrdered: '2026-03-15' },
  { id: 5, name: 'Microblading Needles (10pk)', supplier: 2, sku: 'MN-10', stock: 2, reorderAt: 3, unit: 'packs', unitCost: 18.00, lastOrdered: '2026-03-05' },
  { id: 6, name: 'Aftercare Balm — 30ml', supplier: 3, sku: 'AC-30', stock: 15, reorderAt: 6, unit: 'jars', unitCost: 3.40, lastOrdered: '2026-03-20' },
];

const DEV_ORDERS = [
  { id: 'ORD-041', date: '2026-03-20', supplier: 3, items: [{ name: 'Aftercare Balm — 30ml', qty: 20, cost: 3.40 }], status: 'delivered', total: 68.00 },
  { id: 'ORD-040', date: '2026-03-18', supplier: 2, items: [{ name: 'Lash Lift Lotion (Step 1)', qty: 12, cost: 2.80 }, { name: 'Microblading Needles (10pk)', qty: 5, cost: 18.00 }], status: 'in_transit', total: 123.60 },
  { id: 'ORD-039', date: '2026-03-15', supplier: 1, items: [{ name: 'Brow Wax Strips — Small', qty: 10, cost: 8.90 }], status: 'delivered', total: 89.00 },
  { id: 'ORD-038', date: '2026-03-10', supplier: 1, items: [{ name: 'Brow Tint — Dark Brown', qty: 8, cost: 4.20 }], status: 'delivered', total: 33.60 },
];

const STATUS_STYLES = {
  delivered: { bg: '#E8F5E9', color: '#2E7D32', label: 'Delivered' },
  in_transit: { bg: '#FFF3E0', color: '#E65100', label: 'In Transit' },
  ordered: { bg: '#E3F2FD', color: '#1565C0', label: 'Ordered' },
  cancelled: { bg: '#FFEBEE', color: '#C62828', label: 'Cancelled' },
};

export default function SupplierOrders() {
  const { beautician, loading: bLoading } = useBeautician();
  const [tab, setTab] = useState('stock');
  const [expandedOrder, setExpandedOrder] = useState(null);
  const [showSupplier, setShowSupplier] = useState(null);
  const [showNewOrder, setShowNewOrder] = useState(false);
  const [suppliers, setSuppliers] = useState([]);
  const [products, setProducts] = useState([]);
  const [orders, setOrders] = useState([]);

  useEffect(() => {
    if (bLoading) return;
    if (isDevMode || !beautician) {
      setSuppliers(DEV_SUPPLIERS);
      setProducts(DEV_PRODUCTS);
      setOrders(DEV_ORDERS);
      return;
    }
    Promise.all([
      fetchRows('suppliers', beautician.id, { order: 'name', ascending: true }),
      fetchRows('products', beautician.id, { order: 'name', ascending: true }),
      fetchRows('supplier_orders', beautician.id, { order: 'created_at', ascending: false }),
    ]).then(([s, p, o]) => {
      setSuppliers(s.length ? s : DEV_SUPPLIERS);
      setProducts(p.length ? p : DEV_PRODUCTS);
      setOrders(o.length ? o : DEV_ORDERS);
    });
  }, [beautician, bLoading]);

  if (bLoading) return <div style={{ padding: 40, textAlign: 'center', color: '#AAA5A0' }}>Loading...</div>;

  const lowStock = products.filter(p => p.stock <= p.reorderAt);
  const totalStockValue = products.reduce((s, p) => s + (p.stock * p.unitCost), 0);

  return (
    <div style={s.page}>
      <div style={s.header}>
        <h1 style={s.title}>Supplier Orders</h1>
        <p style={s.subtitle}>Stock levels, reorder alerts, and order history</p>
      </div>

      {/* Summary row */}
      <div style={s.summaryRow}>
        <div style={s.summaryCard}>
          <span style={{ fontSize: 18, fontWeight: 700, color: lowStock.length > 0 ? '#E57373' : '#4CAF50' }}>{lowStock.length}</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted, #AAA5A0)' }}>Low Stock</span>
        </div>
        <div style={s.summaryCard}>
          <span style={{ fontSize: 18, fontWeight: 700, color: 'var(--text, #2D2A26)' }}>{products.length}</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted, #AAA5A0)' }}>Products</span>
        </div>
        <div style={s.summaryCard}>
          <span style={{ fontSize: 18, fontWeight: 700, color: '#C76B8A' }}>£{totalStockValue.toFixed(0)}</span>
          <span style={{ fontSize: 11, color: 'var(--text-muted, #AAA5A0)' }}>Stock Value</span>
        </div>
      </div>

      {/* Tabs */}
      <div style={s.tabRow}>
        {['stock', 'orders', 'suppliers'].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ ...s.tab, ...(tab === t ? s.tabActive : {}) }}>
            {t === 'stock' ? 'Stock Levels' : t === 'orders' ? 'Orders' : 'Suppliers'}
          </button>
        ))}
      </div>

      {/* Low stock alert */}
      {tab === 'stock' && lowStock.length > 0 && (
        <div style={s.alertBanner}>
          <span style={{ fontSize: 14 }}>⚠️</span>
          <span style={{ fontSize: 13, fontWeight: 500 }}>{lowStock.length} product{lowStock.length > 1 ? 's' : ''} below reorder level</span>
        </div>
      )}

      {/* Stock tab */}
      {tab === 'stock' && (
        <div style={s.list}>
          {products.map(p => {
            const isLow = p.stock <= p.reorderAt;
            const supplier = suppliers.find(s => s.id === p.supplier);
            return (
              <div key={p.id} style={{ ...s.productCard, borderLeft: isLow ? '3px solid #E57373' : '3px solid transparent' }}>
                <div style={s.productTop}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text, #2D2A26)' }}>{p.name}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-muted, #AAA5A0)' }}>{supplier?.name} · SKU: {p.sku}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontWeight: 700, fontSize: 16, color: isLow ? '#E57373' : '#4CAF50' }}>{p.stock}</div>
                    <div style={{ fontSize: 10, color: 'var(--text-muted, #AAA5A0)' }}>{p.unit}</div>
                  </div>
                </div>
                <div style={s.productMeta}>
                  <span style={{ fontSize: 11, color: 'var(--text-muted, #AAA5A0)' }}>Reorder at {p.reorderAt} · £{p.unitCost.toFixed(2)}/unit · Last: {p.lastOrdered}</span>
                  {isLow && <button style={s.reorderBtn}>Reorder →</button>}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Orders tab */}
      {tab === 'orders' && (
        <div style={s.list}>
          <button onClick={() => setShowNewOrder(!showNewOrder)} style={s.addBtn}>+ New Order</button>

          {showNewOrder && (
            <div style={s.formCard}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Create Order</div>
              <select style={s.input}>
                <option>Select supplier...</option>
                {suppliers.map(sup => <option key={sup.id} value={sup.id}>{sup.name}</option>)}
              </select>
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <select style={{ ...s.input, flex: 1 }}>
                  <option>Select product...</option>
                  {products.map(p => <option key={p.id}>{p.name}</option>)}
                </select>
                <input type="number" placeholder="Qty" style={{ ...s.input, width: 60 }} />
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button style={s.primaryBtn}>Place Order</button>
                <button onClick={() => setShowNewOrder(false)} style={s.ghostBtn}>Cancel</button>
              </div>
            </div>
          )}

          {orders.map(order => {
            const supplier = suppliers.find(s => s.id === order.supplier);
            const status = STATUS_STYLES[order.status];
            const expanded = expandedOrder === order.id;
            return (
              <button key={order.id} onClick={() => setExpandedOrder(expanded ? null : order.id)} style={s.orderCard}>
                <div style={s.orderTop}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text, #2D2A26)' }}>{order.id}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted, #AAA5A0)' }}>{supplier?.name} · {order.date}</div>
                  </div>
                  <div style={{ textAlign: 'right' }}>
                    <span style={{ padding: '3px 10px', borderRadius: 12, fontSize: 11, fontWeight: 600, background: status.bg, color: status.color }}>{status.label}</span>
                    <div style={{ fontSize: 14, fontWeight: 700, marginTop: 4, color: 'var(--text, #2D2A26)' }}>£{order.total.toFixed(2)}</div>
                  </div>
                </div>
                {expanded && (
                  <div style={s.orderItems}>
                    {order.items.map((item, i) => (
                      <div key={i} style={s.orderItem}>
                        <span style={{ fontSize: 13, color: 'var(--text, #2D2A26)' }}>{item.name}</span>
                        <span style={{ fontSize: 12, color: 'var(--text-muted, #AAA5A0)' }}>x{item.qty} @ £{item.cost.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Suppliers tab */}
      {tab === 'suppliers' && (
        <div style={s.list}>
          {suppliers.map(sup => {
            const supplierProducts = products.filter(p => p.supplier === sup.id);
            const expanded = showSupplier === sup.id;
            return (
              <button key={sup.id} onClick={() => setShowSupplier(expanded ? null : sup.id)} style={s.supplierCard}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontWeight: 600, fontSize: 15, color: 'var(--text, #2D2A26)' }}>{sup.name}</div>
                    <div style={{ fontSize: 12, color: 'var(--text-muted, #AAA5A0)' }}>{sup.contact} · Lead time: {sup.leadTime}</div>
                  </div>
                  <span style={{ fontSize: 12, fontWeight: 600, color: '#C76B8A' }}>{supplierProducts.length} products</span>
                </div>
                {expanded && (
                  <div style={{ marginTop: 12, borderTop: '1px solid var(--card-border, #F0ECE8)', paddingTop: 10 }}>
                    <div style={{ fontSize: 12, color: 'var(--text-muted, #AAA5A0)', marginBottom: 6 }}>📧 {sup.email} · 📞 {sup.phone}</div>
                    {supplierProducts.map(p => (
                      <div key={p.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', fontSize: 13 }}>
                        <span>{p.name}</span>
                        <span style={{ color: p.stock <= p.reorderAt ? '#E57373' : '#4CAF50', fontWeight: 600 }}>{p.stock} {p.unit}</span>
                      </div>
                    ))}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

const s = {
  page: { padding: '20px 16px 40px', fontFamily: '"DM Sans", -apple-system, sans-serif', maxWidth: 480, margin: '0 auto' },
  header: { marginBottom: 16 },
  title: { fontSize: 22, fontWeight: 700, margin: 0, color: 'var(--text, #2D2A26)' },
  subtitle: { fontSize: 13, color: 'var(--text-muted, #AAA5A0)', margin: '4px 0 0' },
  summaryRow: { display: 'flex', gap: 10, marginBottom: 16 },
  summaryCard: { flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, padding: '12px 8px', borderRadius: 12, background: 'var(--card-bg, #fff)', border: '1px solid var(--card-border, #F0ECE8)' },
  tabRow: { display: 'flex', gap: 0, marginBottom: 16, borderRadius: 10, overflow: 'hidden', border: '1px solid var(--card-border, #F0ECE8)' },
  tab: { flex: 1, padding: '10px 0', border: 'none', background: 'none', fontSize: 13, fontWeight: 500, cursor: 'pointer', color: 'var(--text-muted, #AAA5A0)', fontFamily: 'inherit' },
  tabActive: { background: '#C76B8A', color: '#fff' },
  alertBanner: { display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', borderRadius: 10, background: '#FFF3E0', marginBottom: 12 },
  list: { display: 'flex', flexDirection: 'column', gap: 10 },
  productCard: { padding: '14px 12px', borderRadius: 12, background: 'var(--card-bg, #fff)', border: '1px solid var(--card-border, #F0ECE8)' },
  productTop: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 },
  productMeta: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  reorderBtn: { background: 'none', border: 'none', color: '#C76B8A', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  orderCard: { padding: '14px 12px', borderRadius: 12, background: 'var(--card-bg, #fff)', border: '1px solid var(--card-border, #F0ECE8)', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', width: '100%' },
  orderTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' },
  orderItems: { marginTop: 10, borderTop: '1px solid var(--card-border, #F0ECE8)', paddingTop: 8 },
  orderItem: { display: 'flex', justifyContent: 'space-between', padding: '4px 0' },
  supplierCard: { padding: '14px 12px', borderRadius: 12, background: 'var(--card-bg, #fff)', border: '1px solid var(--card-border, #F0ECE8)', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', width: '100%' },
  addBtn: { padding: '12px', borderRadius: 10, border: '2px dashed var(--card-border, #F0ECE8)', background: 'none', fontSize: 14, fontWeight: 600, color: '#C76B8A', cursor: 'pointer', fontFamily: 'inherit' },
  formCard: { padding: 16, borderRadius: 12, background: 'var(--card-bg, #fff)', border: '1px solid var(--card-border, #F0ECE8)' },
  input: { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--card-border, #F0ECE8)', fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box', background: 'var(--card-bg, #fff)', color: 'var(--text, #2D2A26)' },
  primaryBtn: { padding: '10px 20px', borderRadius: 8, border: 'none', background: '#C76B8A', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  ghostBtn: { padding: '10px 20px', borderRadius: 8, border: '1px solid var(--card-border, #F0ECE8)', background: 'none', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-muted, #AAA5A0)' },
};
