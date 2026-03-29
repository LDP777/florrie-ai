/**
 * Promo Codes — Create & track discount codes for marketing.
 *
 * Flash sales, referral rewards, birthday treats, influencer collabs —
 * every code is tracked here with usage stats and revenue impact.
 */
import { useState, useEffect } from 'react';
import { isDevMode, DEV_TREATMENTS, supabase } from '../lib/supabase.js';

const fmt = (cents) => `£${(Math.abs(cents) / 100).toFixed(2)}`;

const DEV_CODES = [
  { id: 'p1', code: 'WELCOME20', type: 'percent', value: 20, minSpend: 0, maxUses: 50, used: 12, revenue: 288000, status: 'active', treatments: [], expiresAt: '2026-06-01', createdAt: '2026-03-01', description: 'New client welcome offer' },
  { id: 'p2', code: 'BROWS10', type: 'fixed', value: 1000, minSpend: 5000, maxUses: 30, used: 8, revenue: 96000, status: 'active', treatments: ['Ombre Brows (Semi-Permanent)', 'Combination Brows'], expiresAt: '2026-04-30', createdAt: '2026-03-10', description: '£10 off any brow treatment over £50' },
  { id: 'p3', code: 'BDAY2026', type: 'percent', value: 15, minSpend: 0, maxUses: null, used: 3, revenue: 22500, status: 'active', treatments: [], expiresAt: null, createdAt: '2026-01-01', description: 'Birthday month treat — auto-sent via sequences' },
  { id: 'p4', code: 'REFER25', type: 'fixed', value: 2500, minSpend: 4000, maxUses: null, used: 5, revenue: 62500, status: 'active', treatments: [], expiresAt: null, createdAt: '2026-02-01', description: 'Referral reward code' },
  { id: 'p5', code: 'FLASH50', type: 'percent', value: 50, minSpend: 0, maxUses: 10, used: 10, revenue: 75000, status: 'expired', treatments: ['Lash Lift & Tint'], expiresAt: '2026-03-15', createdAt: '2026-03-14', description: '24hr flash sale — fully redeemed' },
  { id: 'p6', code: 'INFLUENCER', type: 'percent', value: 100, minSpend: 0, maxUses: 1, used: 1, revenue: 0, status: 'expired', treatments: ['Ombre Brows (Semi-Permanent)'], expiresAt: '2026-03-20', createdAt: '2026-03-18', description: 'Free treatment for @browqueen collab' },
];

const STATUS_CONFIG = {
  active: { label: 'Active', bg: 'var(--success-bg, #EDF7F0)', color: 'var(--success, #5BA97B)' },
  expired: { label: 'Expired', bg: 'var(--danger-bg, #FDF0EF)', color: 'var(--danger, #D4605C)' },
  paused: { label: 'Paused', bg: 'var(--gold-light, #FDF8EE)', color: 'var(--gold-text, #8A7245)' },
};

export default function PromoCodes({ token }) {
  const [tab, setTab] = useState('active');
  const [expanded, setExpanded] = useState(null);
  const [showCreate, setShowCreate] = useState(false);
  const [codes, setCodes] = useState([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [formData, setFormData] = useState({
    code: '',
    description: '',
    discount_type: 'percentage',
    discount_value: '',
    max_uses: '',
    valid_from: new Date().toISOString().split('T')[0],
    valid_until: ''
  });

  // Fetch promo codes
  useEffect(() => {
    const fetchCodes = async () => {
      if (isDevMode) {
        setCodes(DEV_CODES);
        setLoading(false);
        return;
      }

      try {
        const session = await supabase.auth.getSession();
        if (!session.data.session) return;

        const res = await fetch('/api/promo-codes', {
          headers: { 'Authorization': `Bearer ${session.data.session.access_token}` }
        });
        if (!res.ok) throw new Error('Failed to fetch codes');

        const { data } = await res.json();
        const transformed = data.map(code => ({
          id: code.id,
          code: code.code,
          type: code.discount_type === 'percentage' ? 'percent' : 'fixed',
          value: code.discount_value,
          maxUses: code.max_uses,
          used: code.current_uses || 0,
          revenue: 0,
          status: code.is_active ? 'active' : 'expired',
          treatments: [],
          expiresAt: code.valid_until,
          createdAt: code.created_at,
          description: ''
        }));
        setCodes(transformed);
      } catch (err) {
        console.error('Fetch error:', err);
        setCodes(DEV_CODES);
      } finally {
        setLoading(false);
      }
    };
    fetchCodes();
  }, []);

  const active = codes.filter(c => c.status === 'active');
  const inactive = codes.filter(c => c.status !== 'active');

  const totalRevenue = codes.reduce((s, c) => s + c.revenue, 0);
  const totalRedemptions = codes.reduce((s, c) => s + c.used, 0);
  const avgDiscount = codes.length > 0
    ? Math.round(codes.reduce((s, c) => s + c.value, 0) / codes.length)
    : 0;

  const filtered = tab === 'active' ? active : inactive;

  const handleCreateCode = async () => {
    if (!formData.code || !formData.discount_value || !formData.valid_until) {
      alert('Please fill in all required fields');
      return;
    }

    if (isDevMode) {
      alert('Cannot create codes in dev mode');
      return;
    }

    setCreating(true);
    try {
      const session = await supabase.auth.getSession();
      if (!session.data.session) return;

      const validFrom = new Date(formData.valid_from);
      validFrom.setHours(0, 0, 0, 0);
      const validUntil = new Date(formData.valid_until);
      validUntil.setHours(23, 59, 59, 999);

      const res = await fetch('/api/promo-codes', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.data.session.access_token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          code: formData.code,
          discount_type: formData.discount_type,
          discount_value: formData.discount_value,
          max_uses: formData.max_uses || null,
          valid_from: validFrom.toISOString(),
          valid_until: validUntil.toISOString()
        })
      });

      if (!res.ok) {
        const error = await res.json();
        alert(error.error || 'Failed to create code');
        return;
      }

      const { data: newCode } = await res.json();
      setCodes([...codes, {
        id: newCode.id,
        code: newCode.code,
        type: newCode.discount_type === 'percentage' ? 'percent' : 'fixed',
        value: newCode.discount_value,
        maxUses: newCode.max_uses,
        used: 0,
        revenue: 0,
        status: newCode.is_active ? 'active' : 'expired',
        treatments: [],
        expiresAt: newCode.valid_until,
        createdAt: newCode.created_at,
        description: ''
      }]);
      setShowCreate(false);
      setFormData({
        code: '',
        description: '',
        discount_type: 'percentage',
        discount_value: '',
        max_uses: '',
        valid_from: new Date().toISOString().split('T')[0],
        valid_until: ''
      });
    } catch (err) {
      console.error('Create error:', err);
      alert('Failed to create code');
    } finally {
      setCreating(false);
    }
  };

  const handleToggleActive = async (codeId, currentStatus) => {
    if (isDevMode) {
      alert('Cannot update codes in dev mode');
      return;
    }

    try {
      const session = await supabase.auth.getSession();
      if (!session.data.session) return;

      const res = await fetch(`/api/promo-codes/${codeId}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${session.data.session.access_token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ is_active: !currentStatus })
      });

      if (!res.ok) throw new Error('Failed to update');

      const { data: updated } = await res.json();
      setCodes(codes.map(c => c.id === codeId ? { ...c, status: updated.is_active ? 'active' : 'expired' } : c));
    } catch (err) {
      console.error('Update error:', err);
      alert('Failed to update code');
    }
  };

  return (
    <div style={S.page}>
      <h1 style={S.title}>Promo Codes</h1>

      {/* Summary */}
      <div style={S.summaryRow}>
        <div style={S.summaryCard}>
          <span style={S.summaryNum}>{active.length}</span>
          <span style={S.summaryLabel}>Active</span>
        </div>
        <div style={S.summaryCard}>
          <span style={S.summaryNum}>{totalRedemptions}</span>
          <span style={S.summaryLabel}>Redeemed</span>
        </div>
        <div style={S.summaryCard}>
          <span style={S.summaryNum}>{fmt(totalRevenue)}</span>
          <span style={S.summaryLabel}>Revenue</span>
        </div>
      </div>

      {/* Tabs */}
      <div style={S.tabs}>
        {['active', 'past'].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ ...S.tab, ...(tab === t ? S.tabActive : {}) }}>
            {t === 'active' ? `Active (${active.length})` : `Past (${inactive.length})`}
          </button>
        ))}
      </div>

      {/* Code list */}
      <div style={S.list}>
        {filtered.length === 0 && <p style={S.empty}>No codes here yet.</p>}
        {filtered.map(code => {
          const isExp = expanded === code.id;
          const st = STATUS_CONFIG[code.status];
          const usagePercent = code.maxUses ? Math.round((code.used / code.maxUses) * 100) : null;
          return (
            <div key={code.id} style={S.card} onClick={() => setExpanded(isExp ? null : code.id)}>
              <div style={S.cardHeader}>
                <div style={S.cardLeft}>
                  <div style={S.codeBox}>
                    <span style={S.codeText}>{code.code}</span>
                  </div>
                  <div style={S.cardInfo}>
                    <span style={S.cardDiscount}>
                      {code.type === 'percent' ? `${code.value}% off` : `${fmt(code.value)} off`}
                    </span>
                    <span style={S.cardMeta}>{code.used} used{code.maxUses ? ` / ${code.maxUses}` : ''}</span>
                  </div>
                </div>
                <span style={{ ...S.statusBadge, background: st.bg, color: st.color }}>{st.label}</span>
              </div>

              {isExp && (
                <div style={S.expandedSection}>
                  <p style={S.codeDesc}>{code.description}</p>

                  <div style={S.detailGrid}>
                    <div style={S.detailItem}>
                      <span style={S.detailLabel}>Type</span>
                      <span style={S.detailValue}>{code.type === 'percent' ? 'Percentage' : 'Fixed amount'}</span>
                    </div>
                    <div style={S.detailItem}>
                      <span style={S.detailLabel}>Revenue</span>
                      <span style={S.detailValue}>{fmt(code.revenue)}</span>
                    </div>
                    {code.minSpend > 0 && (
                      <div style={S.detailItem}>
                        <span style={S.detailLabel}>Min Spend</span>
                        <span style={S.detailValue}>{fmt(code.minSpend)}</span>
                      </div>
                    )}
                    <div style={S.detailItem}>
                      <span style={S.detailLabel}>Created</span>
                      <span style={S.detailValue}>{formatDate(code.createdAt)}</span>
                    </div>
                    {code.expiresAt && (
                      <div style={S.detailItem}>
                        <span style={S.detailLabel}>Expires</span>
                        <span style={S.detailValue}>{formatDate(code.expiresAt)}</span>
                      </div>
                    )}
                  </div>

                  {code.treatments.length > 0 && (
                    <div style={S.treatmentRow}>
                      <span style={S.detailLabel}>Valid for</span>
                      <div style={S.treatmentChips}>
                        {code.treatments.map(t => (
                          <span key={t} style={S.treatmentChip}>{t}</span>
                        ))}
                      </div>
                    </div>
                  )}

                  {usagePercent !== null && (
                    <div style={S.usageBar}>
                      <div style={S.usageTrack}>
                        <div style={{ ...S.usageFill, width: `${usagePercent}%`, background: usagePercent >= 100 ? 'var(--danger, #D4605C)' : 'var(--accent, #C76B8A)' }} />
                      </div>
                      <span style={S.usageText}>{usagePercent}% used</span>
                    </div>
                  )}

                  {code.status === 'active' && (
                    <div style={S.actionRow}>
                      <button style={S.actionBtn} onClick={() => navigator.clipboard.writeText(code.code)}>Copy Code</button>
                      <button style={S.actionBtn} onClick={() => alert('Share functionality coming soon')}>Share</button>
                      <button
                        style={{ ...S.actionBtn, color: 'var(--danger, #D4605C)' }}
                        onClick={() => handleToggleActive(code.id, true)}
                      >Pause</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Create button */}
      {!showCreate && (
        <button style={S.fab} onClick={() => setShowCreate(true)}>+</button>
      )}

      {/* Create modal */}
      {showCreate && (
        <div style={S.overlay} onClick={() => setShowCreate(false)}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <div style={S.modalHeader}>
              <h2 style={S.modalTitle}>Create Promo Code</h2>
              <button style={S.closeBtn} onClick={() => setShowCreate(false)}>✕</button>
            </div>

            <div style={S.formBody}>
              <label style={S.label}>Code</label>
              <input
                style={S.input}
                placeholder="e.g. SUMMER25"
                value={formData.code}
                onChange={(e) => setFormData({ ...formData, code: e.target.value.toUpperCase() })}
              />

              <label style={S.label}>Discount Type</label>
              <div style={S.typeToggle}>
                <button
                  style={{ ...S.typeBtn, ...(formData.discount_type === 'percentage' ? S.typeBtnActive : {}) }}
                  onClick={() => setFormData({ ...formData, discount_type: 'percentage' })}
                >% Percent</button>
                <button
                  style={{ ...S.typeBtn, ...(formData.discount_type === 'fixed' ? S.typeBtnActive : {}) }}
                  onClick={() => setFormData({ ...formData, discount_type: 'fixed' })}
                >£ Fixed</button>
              </div>

              <label style={S.label}>Value</label>
              <input
                style={S.input}
                type="number"
                placeholder="e.g. 20"
                value={formData.discount_value}
                onChange={(e) => setFormData({ ...formData, discount_value: parseInt(e.target.value) || '' })}
              />

              <label style={S.label}>Valid From</label>
              <input
                style={S.input}
                type="date"
                value={formData.valid_from}
                onChange={(e) => setFormData({ ...formData, valid_from: e.target.value })}
              />

              <label style={S.label}>Valid Until</label>
              <input
                style={S.input}
                type="date"
                value={formData.valid_until}
                onChange={(e) => setFormData({ ...formData, valid_until: e.target.value })}
              />

              <label style={S.label}>Max Uses (leave blank for unlimited)</label>
              <input
                style={S.input}
                type="number"
                placeholder="Unlimited"
                value={formData.max_uses}
                onChange={(e) => setFormData({ ...formData, max_uses: parseInt(e.target.value) || '' })}
              />
            </div>

            <button style={S.saveBtn} onClick={handleCreateCode} disabled={creating}>
              {creating ? 'Creating...' : 'Create Code'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatDate(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

const S = {
  page: { padding: '20px 16px 100px', fontFamily: '"DM Sans", -apple-system, sans-serif', maxWidth: 480, margin: '0 auto' },
  title: { fontSize: 22, fontWeight: 700, color: 'var(--text, #2D2A26)', margin: '0 0 16px' },

  summaryRow: { display: 'flex', gap: 8, marginBottom: 16 },
  summaryCard: { flex: 1, background: 'var(--card, #fff)', borderRadius: 12, padding: '14px 8px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 },
  summaryNum: { fontSize: 20, fontWeight: 700, color: 'var(--accent, #C76B8A)' },
  summaryLabel: { fontSize: 11, color: 'var(--text-muted, #B5AFA8)', fontWeight: 500 },

  tabs: { display: 'flex', gap: 8, marginBottom: 16 },
  tab: { flex: 1, padding: '10px 0', border: 'none', borderRadius: 10, background: 'var(--card, #fff)', color: 'var(--text-muted, #B5AFA8)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  tabActive: { background: 'var(--accent, #C76B8A)', color: '#fff' },

  list: { display: 'flex', flexDirection: 'column', gap: 10 },
  empty: { textAlign: 'center', color: 'var(--text-muted, #B5AFA8)', fontSize: 14, padding: 32 },

  card: { background: 'var(--card, #fff)', borderRadius: 14, padding: 14, cursor: 'pointer' },
  cardHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  cardLeft: { display: 'flex', gap: 10, alignItems: 'center' },
  codeBox: { background: 'var(--bg-hover, #F5F2EF)', borderRadius: 8, padding: '6px 10px', border: '1px dashed var(--text-muted, #B5AFA8)' },
  codeText: { fontSize: 13, fontWeight: 700, color: 'var(--accent, #C76B8A)', letterSpacing: 1, fontFamily: 'monospace' },
  cardInfo: { display: 'flex', flexDirection: 'column', gap: 2 },
  cardDiscount: { fontSize: 14, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  cardMeta: { fontSize: 12, color: 'var(--text-muted, #B5AFA8)' },
  statusBadge: { padding: '3px 10px', borderRadius: 8, fontSize: 11, fontWeight: 600 },

  expandedSection: { marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border, #EDE9E4)' },
  codeDesc: { fontSize: 13, color: 'var(--text-secondary, #7A756F)', margin: '0 0 10px', fontStyle: 'italic' },
  detailGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 10 },
  detailItem: { display: 'flex', flexDirection: 'column', gap: 2 },
  detailLabel: { fontSize: 11, color: 'var(--text-muted, #B5AFA8)', fontWeight: 600 },
  detailValue: { fontSize: 13, fontWeight: 600, color: 'var(--text, #2D2A26)' },

  treatmentRow: { marginBottom: 10 },
  treatmentChips: { display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  treatmentChip: { padding: '4px 10px', borderRadius: 8, background: 'var(--accent-light, #FFF0F3)', color: 'var(--accent, #C76B8A)', fontSize: 11, fontWeight: 500 },
  treatmentChipSelect: { padding: '5px 12px', borderRadius: 20, background: 'var(--border, #EDE9E4)', color: 'var(--text-secondary, #7A756F)', fontSize: 12, fontWeight: 500, cursor: 'pointer' },

  usageBar: { marginBottom: 10 },
  usageTrack: { height: 6, borderRadius: 3, background: 'var(--border, #EDE9E4)', overflow: 'hidden', marginBottom: 4 },
  usageFill: { height: '100%', borderRadius: 3, transition: 'width .3s' },
  usageText: { fontSize: 11, color: 'var(--text-muted, #B5AFA8)' },

  actionRow: { display: 'flex', gap: 8, marginTop: 8 },
  actionBtn: { flex: 1, padding: '9px 0', borderRadius: 8, border: '1px solid var(--border, #EDE9E4)', background: 'var(--card, #fff)', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text, #2D2A26)' },

  fab: { position: 'fixed', bottom: 80, right: 20, width: 52, height: 52, borderRadius: 26, background: 'var(--accent, #C76B8A)', color: '#fff', fontSize: 26, border: 'none', cursor: 'pointer', boxShadow: '0 4px 12px rgba(199,107,138,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: 'inherit', zIndex: 50 },

  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', zIndex: 100, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' },
  modal: { background: 'var(--bg, #FAF8F5)', borderRadius: '18px 18px 0 0', width: '100%', maxWidth: 480, maxHeight: '85vh', overflow: 'auto', padding: '20px 16px 32px' },
  modalHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  modalTitle: { fontSize: 18, fontWeight: 700, color: 'var(--text, #2D2A26)', margin: 0 },
  closeBtn: { background: 'none', border: 'none', fontSize: 18, color: 'var(--text-muted, #B5AFA8)', cursor: 'pointer' },

  formBody: { display: 'flex', flexDirection: 'column', gap: 10 },
  label: { fontSize: 12, fontWeight: 600, color: 'var(--text-muted, #B5AFA8)', marginTop: 4 },
  input: { padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border, #EDE9E4)', fontSize: 14, fontFamily: 'inherit', color: 'var(--text, #2D2A26)', background: 'var(--card, #fff)' },
  typeToggle: { display: 'flex', gap: 8 },
  typeBtn: { flex: 1, padding: '8px 0', borderRadius: 8, border: '1px solid var(--border, #EDE9E4)', background: 'var(--card, #fff)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-muted, #B5AFA8)' },
  typeBtnActive: { background: 'var(--accent, #C76B8A)', color: '#fff', border: '1px solid var(--accent, #C76B8A)' },

  saveBtn: { marginTop: 16, width: '100%', padding: '14px 0', borderRadius: 12, border: 'none', background: 'var(--accent, #C76B8A)', color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
};
