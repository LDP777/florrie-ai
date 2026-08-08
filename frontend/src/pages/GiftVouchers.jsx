import { useState, useEffect } from 'react';
import { useBeautician, fetchRows, insertRow, updateRow } from '../lib/supabase.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';
import Icon from '../components/ui/Icon';

/**
 * Gift Vouchers - Create, send & redeem digital gift vouchers.
 *
 * Tabs:
 *   Active   - vouchers in circulation (not yet redeemed/expired)
 *   Create   - make a new voucher (amount or treatment-specific)
 *   History  - redeemed + expired vouchers
 */

const fmt = (cents) => `£${(cents / 100).toFixed(2)}`;
const AMOUNTS = [2000, 2500, 3000, 4000, 5000, 7500, 10000];

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = 'GIFT-';
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

export default function GiftVouchers() {
  const { beautician, loading: bLoading } = useBeautician();
  const [vouchers, setVouchers] = useState([]);
  const [treatments, setTreatments] = useState([]);
  const [tab, setTab] = useState('active');
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [showRedeem, setShowRedeem] = useState(null);
  const [redeemCode, setRedeemCode] = useState('');
  const [redeemSearch, setRedeemSearch] = useState(null);

  // Create form
  const [form, setForm] = useState({
    type: 'amount', amount_cents: 5000, treatment_id: '',
    buyer_name: '', recipient_name: '', recipient_email: '',
    message: '', expires_months: 6,
  });

  useEffect(() => { loadData(); }, [beautician, bLoading]);

  async function loadData() {
    setLoading(true);
    if (bLoading || !beautician) {
      setLoading(false);
      return;
    }
    try {
      const [rows, txRows] = await Promise.all([
        fetchRows('gift_vouchers', beautician.id, { order: 'created_at', ascending: false }),
        fetchRows('treatments', beautician.id, { order: 'name', ascending: true }),
      ]);
      setVouchers(rows || []);
      setTreatments((txRows || []).filter(t => t.is_active));
    } catch (err) {
      logger.error('Failed to load gift vouchers:', err);
    }
    setLoading(false);
  }

  async function handleCreate() {
    if (!form.buyer_name.trim() || !form.recipient_name.trim()) return;
    if (form.type === 'amount' && !form.amount_cents) return;
    if (form.type === 'treatment' && !form.treatment_id) return;

    const treatment = form.type === 'treatment'
      ? treatments.find(t => t.id === form.treatment_id)
      : null;

    const voucher = {
      id: crypto.randomUUID(),
      code: generateCode(),
      type: form.type,
      amount_cents: form.type === 'treatment' ? (treatment?.price_cents || 0) : form.amount_cents,
      treatment_id: form.type === 'treatment' ? form.treatment_id : null,
      treatment_name: treatment?.name || null,
      buyer_name: form.buyer_name.trim(),
      recipient_name: form.recipient_name.trim(),
      recipient_email: form.recipient_email.trim(),
      message: form.message.trim(),
      status: 'active',
      created_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + form.expires_months * 30 * 86400000).toISOString(),
      redeemed_at: null,
      redeemed_by: null,
    };

    if (beautician) {
      try {
        const saved = await insertRow('gift_vouchers', { beautician_id: beautician.id, ...voucher });
        voucher.id = saved.id;
      } catch (err) {
        logger.error('Failed to save gift voucher:', err);
      }
    }

    setVouchers(prev => [voucher, ...prev]);
    setForm({
      type: 'amount', amount_cents: 5000, treatment_id: '',
      buyer_name: '', recipient_name: '', recipient_email: '',
      message: '', expires_months: 6,
    });
    setShowCreate(false);
    setTab('active');
  }

  function handleRedeemSearch() {
    const found = vouchers.find(v => v.code.toLowerCase() === redeemCode.trim().toLowerCase() && v.status === 'active');
    setRedeemSearch(found || 'not_found');
  }

  async function handleRedeem(voucher) {
    const updated = { ...voucher, status: 'redeemed', redeemed_at: new Date().toISOString(), redeemed_by: voucher.recipient_name };
    setVouchers(prev => prev.map(v => v.id === voucher.id ? updated : v));
    try {
      await updateRow('gift_vouchers', voucher.id, { status: 'redeemed', redeemed_at: updated.redeemed_at });
    } catch (err) {
      logger.error('Failed to redeem gift voucher:', err);
    }
    setRedeemCode('');
    setRedeemSearch(null);
    setShowRedeem(null);
  }

  const isExpired = (v) => v.expires_at && new Date(v.expires_at) < new Date();
  const active = vouchers.filter(v => v.status === 'active' && !isExpired(v));
  const history = vouchers.filter(v => v.status !== 'active' || isExpired(v));
  const totalActive = active.reduce((sum, v) => sum + (v.amount_cents || 0), 0);

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div>
          <h1 style={styles.title}>Gift Vouchers</h1>
          <p style={styles.subtitle}>Create, send & redeem</p>
        </div>
      </div>

      {/* Stats bar */}
      <div style={styles.statsBar}>
        <div style={styles.statItem}>
          <span style={styles.statNum}>{active.length}</span>
          <span style={styles.statLabel}>Active</span>
        </div>
        <div style={styles.statDivider} />
        <div style={styles.statItem}>
          <span style={styles.statNum}>{fmt(totalActive)}</span>
          <span style={styles.statLabel}>Outstanding</span>
        </div>
        <div style={styles.statDivider} />
        <div style={styles.statItem}>
          <span style={styles.statNum}>{history.length}</span>
          <span style={styles.statLabel}>Redeemed</span>
        </div>
      </div>

      {/* Quick actions */}
      <div style={styles.quickActions}>
        <button onClick={() => { setShowCreate(true); setTab('create'); }} style={styles.createBtn}>
          + Create Voucher
        </button>
        <button onClick={() => setShowRedeem(true)} style={styles.redeemBtn}><Icon name="tag" size={14} inline /> Redeem
        </button>
      </div>

      {/* Tabs */}
      <div style={styles.tabs}>
        {['active', 'create', 'history'].map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{ ...styles.tab,
              borderBottomColor: tab === t ? 'var(--accent, #92405e)' : 'transparent',
              color: tab === t ? 'var(--accent, #92405e)' : 'var(--text-muted, #6B5D54)',
            }}
          >
            {t === 'active' ? `Active (${active.length})` : t === 'create' ? 'Create' : 'History'}
          </button>
        ))}
      </div>

      {/* === ACTIVE TAB === */}
      {tab === 'active' && (
        <div>
          {loading ? (
            <p style={styles.loadingText}>Loading vouchers...</p>
          ) : active.length === 0 ? (
            <div style={styles.emptyState}>
              <span style={{ fontSize: 32, display: 'block', marginBottom: 8 }}><Icon name="gift" size={32} /></span>
              <p style={styles.emptyTitle}>No active vouchers</p>
              <p style={styles.emptyDesc}>Create your first gift voucher and start earning.</p>
            </div>
          ) : (
            <div style={styles.voucherList}>
              {active.map(v => (
                <VoucherCard key={v.id} voucher={v} onRedeem={() => handleRedeem(v)} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* === CREATE TAB === */}
      {tab === 'create' && (
        <div style={styles.formCard}>
          <div style={styles.formGroup}>
            <label style={styles.formLabel}>Voucher type</label>
            <div style={styles.typeRow}>
              <button
                onClick={() => setForm(p => ({ ...p, type: 'amount' }))}
                style={{ ...styles.typeBtn,
                  background: form.type === 'amount' ? 'var(--accent-light, #F6E7EC)' : 'var(--bg-card, #FFFCF9)',
                  borderColor: form.type === 'amount' ? 'var(--accent, #92405e)' : 'var(--border, #E8DDD4)',
                }}
              >
                <span style={{ fontSize: 20 }}><Icon name="pound" size={15} /></span>
                <span style={styles.typeBtnLabel}>Amount</span>
              </button>
              <button
                onClick={() => setForm(p => ({ ...p, type: 'treatment' }))}
                style={{ ...styles.typeBtn,
                  background: form.type === 'treatment' ? 'var(--accent-light, #F6E7EC)' : 'var(--bg-card, #FFFCF9)',
                  borderColor: form.type === 'treatment' ? 'var(--accent, #92405e)' : 'var(--border, #E8DDD4)',
                }}
              >
                <span style={{ fontSize: 20 }}><Icon name="sparkles" size={15} /></span>
                <span style={styles.typeBtnLabel}>Treatment</span>
              </button>
            </div>
          </div>

          {form.type === 'amount' && (
            <div style={styles.formGroup}>
              <label style={styles.formLabel}>Amount</label>
              <div style={styles.amountGrid}>
                {AMOUNTS.map(amt => (
                  <button
                    key={amt}
                    onClick={() => setForm(p => ({ ...p, amount_cents: amt }))}
                    style={{ ...styles.amountChip,
                      background: form.amount_cents === amt ? 'var(--accent, #92405e)' : 'var(--bg-card, #FFFCF9)',
                      color: form.amount_cents === amt ? '#fff' : 'var(--text-primary, #241B17)',
                      borderColor: form.amount_cents === amt ? 'var(--accent, #92405e)' : 'var(--border, #E8DDD4)',
                    }}
                  >
                    {fmt(amt)}
                  </button>
                ))}
              </div>
            </div>
          )}

          {form.type === 'treatment' && (
            <div style={styles.formGroup}>
              <label style={styles.formLabel}>Treatment</label>
              <select
                value={form.treatment_id}
                onChange={e => setForm(p => ({ ...p, treatment_id: e.target.value }))}
                style={styles.formSelect}
              >
                <option value="">Choose a treatment...</option>
                {treatments.map(t => (
                  <option key={t.id} value={t.id}>{t.name} - {fmt(t.price_cents)}</option>
                ))}
              </select>
            </div>
          )}

          <div style={styles.formRow}>
            <div style={{ flex: 1 }}>
              <label style={styles.formLabel}>Buyer name</label>
              <input
                type="text" placeholder="Who's buying?"
                value={form.buyer_name}
                onChange={e => setForm(p => ({ ...p, buyer_name: e.target.value }))}
                style={styles.formInput}
              />
            </div>
            <div style={{ flex: 1 }}>
              <label style={styles.formLabel}>Recipient name</label>
              <input
                type="text" placeholder="Who's it for?"
                value={form.recipient_name}
                onChange={e => setForm(p => ({ ...p, recipient_name: e.target.value }))}
                style={styles.formInput}
              />
            </div>
          </div>

          <div style={styles.formGroup}>
            <label style={styles.formLabel}>Recipient email (optional)</label>
            <input
              type="email" placeholder="To send the voucher directly"
              value={form.recipient_email}
              onChange={e => setForm(p => ({ ...p, recipient_email: e.target.value }))}
              style={styles.formInput}
            />
          </div>

          <div style={styles.formGroup}>
            <label style={styles.formLabel}>Personal message</label>
            <textarea
              placeholder="Happy birthday! Treat yourself..."
              value={form.message}
              onChange={e => setForm(p => ({ ...p, message: e.target.value }))}
              rows={2}
              style={styles.formTextarea}
            />
          </div>

          <div style={styles.formGroup}>
            <label style={styles.formLabel}>Expires in</label>
            <div style={styles.expiryRow}>
              {[3, 6, 12].map(m => (
                <button
                  key={m}
                  onClick={() => setForm(p => ({ ...p, expires_months: m }))}
                  style={{ ...styles.expiryChip,
                    background: form.expires_months === m ? 'var(--accent, #92405e)' : 'var(--bg-card, #FFFCF9)',
                    color: form.expires_months === m ? '#fff' : 'var(--text-secondary, #574A42)',
                    borderColor: form.expires_months === m ? 'var(--accent, #92405e)' : 'var(--border, #E8DDD4)',
                  }}
                >
                  {m} months
                </button>
              ))}
            </div>
          </div>

          {/* Preview */}
          <div style={styles.previewCard}>
            <div style={styles.previewBrand}>{<Icon name="gift" inline />} {beautician?.business_name || 'Ellindigo Brows & Beauty'}</div>
            <div style={styles.previewAmount}>
              {form.type === 'treatment'
                ? (treatments.find(t => t.id === form.treatment_id)?.name || 'Treatment voucher')
                : fmt(form.amount_cents)
              }
            </div>
            <div style={styles.previewFor}>For: {form.recipient_name || '...'}</div>
            {form.message && <div style={styles.previewMsg}>"{form.message}"</div>}
            <div style={styles.previewCode}>GIFT-XXXXX</div>
          </div>

          <button onClick={handleCreate} style={styles.createVoucherBtn}>
            Create & Send Voucher
          </button>
        </div>
      )}

      {/* === HISTORY TAB === */}
      {tab === 'history' && (
        <div>
          {history.length === 0 ? (
            <div style={styles.emptyState}>
              <p style={styles.emptyTitle}>No redeemed vouchers yet</p>
              <p style={styles.emptyDesc}>Redeemed and expired vouchers will show here.</p>
            </div>
          ) : (
            <div style={styles.voucherList}>
              {history.map(v => (
                <VoucherCard key={v.id} voucher={v} />
              ))}
            </div>
          )}
        </div>
      )}

      {/* === REDEEM MODAL === */}
      {showRedeem && (
        <div style={styles.modalOverlay} onClick={() => { setShowRedeem(null); setRedeemSearch(null); setRedeemCode(''); }}>
          <div style={styles.modalContent} onClick={e => e.stopPropagation()}>
            <h3 style={styles.modalTitle}>Redeem Voucher</h3>
            <div style={styles.redeemInputRow}>
              <input
                type="text" placeholder="Enter voucher code"
                value={redeemCode}
                onChange={e => setRedeemCode(e.target.value.toUpperCase())}
                style={{ ...styles.formInput, flex: 1, textTransform: 'uppercase', letterSpacing: '0.1em' }}
              />
              <button onClick={handleRedeemSearch} style={styles.searchBtn}>Find</button>
            </div>

            {redeemSearch === 'not_found' && (
              <div style={styles.redeemNotFound}>
                <span style={{ fontSize: 20 }}>{<Icon name="search-off" inline />}</span>
                <span>No active voucher found with that code</span>
              </div>
            )}

            {redeemSearch && redeemSearch !== 'not_found' && (
              <div style={styles.redeemFound}>
                <div style={styles.redeemFoundHeader}>
                  <span style={styles.redeemFoundCode}>{redeemSearch.code}</span>
                  <span style={styles.redeemFoundAmount}>{fmt(redeemSearch.amount_cents)}</span>
                </div>
                <p style={styles.redeemFoundDetail}>
                  For: {redeemSearch.recipient_name} · From: {redeemSearch.buyer_name}
                </p>
                {redeemSearch.treatment_name && (
                  <p style={styles.redeemFoundDetail}>Treatment: {redeemSearch.treatment_name}</p>
                )}
                <button onClick={() => handleRedeem(redeemSearch)} style={styles.redeemConfirmBtn}>
                  Mark as Redeemed
                </button>
              </div>
            )}

            <button onClick={() => { setShowRedeem(null); setRedeemSearch(null); setRedeemCode(''); }} style={styles.cancelBtn}>
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function VoucherCard({ voucher, onRedeem }) {
  const expiredByDate = voucher.expires_at && new Date(voucher.expires_at) < new Date();
  const isActive = voucher.status === 'active' && !expiredByDate;
  const daysLeft = isActive
    ? Math.max(0, Math.round((new Date(voucher.expires_at) - new Date()) / 86400000))
    : 0;

  return (
    <div style={styles.voucherCard}>
      <div style={styles.voucherTop}>
        <div style={styles.voucherIcon}>
          {voucher.type === 'treatment' ? '💅' : 'pound'}
        </div>
        <div style={styles.voucherInfo}>
          <span style={styles.voucherAmount}>
            {voucher.type === 'treatment' ? voucher.treatment_name : fmt(voucher.amount_cents)}
          </span>
          <span style={styles.voucherFor}>
            For {voucher.recipient_name} · from {voucher.buyer_name}
          </span>
        </div>
        <div style={{ ...styles.statusBadge,
          background: isActive ? 'var(--success-bg, #E9F0EB)' : 'var(--bg-hover, #f3ede9)',
          color: isActive ? 'var(--success, #386F52)' : 'var(--text-muted, #6B5D54)',
        }}>
          {isActive ? 'Active' : voucher.status === 'redeemed' ? 'Used' : 'Expired'}
        </div>
      </div>

      <div style={styles.voucherCode}>{voucher.code}</div>

      {voucher.message && (
        <p style={styles.voucherMsg}>"{voucher.message}"</p>
      )}

      <div style={styles.voucherFooter}>
        <span style={styles.voucherDate}>
          {isActive
            ? `${daysLeft} days left`
            : voucher.redeemed_at
              ? `Used ${new Date(voucher.redeemed_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}`
              : 'Expired'
          }
        </span>
        {isActive && onRedeem && (
          <button onClick={onRedeem} style={styles.redeemSmallBtn}>Redeem</button>
        )}
      </div>
    </div>
  );
}

const styles = {
  page: {
    minHeight: 'var(--shell-viewport)', background: 'var(--bg, #FBF6F1)',
    fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif",
    padding: '0 16px var(--scroll-pad-bottom)', maxWidth: 480, margin: '0 auto', color: 'var(--text-primary, #241B17)',
  },
  header: { paddingTop: 8, paddingBottom: 8 },
  title: { fontSize: 22, fontWeight: 700, margin: '0 0 2px' },
  subtitle: { fontSize: 13, color: 'var(--accent, #92405e)', margin: 0, fontWeight: 500 },

  // Stats
  statsBar: {
    display: 'flex', alignItems: 'center', justifyContent: 'space-around',
    background: 'var(--bg-card, #FFFCF9)', borderRadius: 16, padding: '14px 0',
    boxShadow: 'var(--elev-1)', marginBottom: 12,
  },
  statItem: { display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 },
  statNum: { fontSize: 18, fontWeight: 700, color: 'var(--accent, #92405e)' },
  statLabel: { fontSize: 10, color: 'var(--text-muted, #6B5D54)', textTransform: 'uppercase', letterSpacing: '0.04em' },
  statDivider: { width: 1, height: 28, background: 'var(--border, #E8DDD4)' },

  // Quick actions
  quickActions: { display: 'flex', gap: 8, marginBottom: 16 },
  createBtn: {
    flex: 1, padding: '11px 0', borderRadius: 10, border: 'none',
    background: 'var(--accent, #92405e)', color: '#fff', fontSize: 13, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  redeemBtn: {
    flex: 1, padding: '11px 0', borderRadius: 10, border: '1.5px solid var(--border, #E8DDD4)',
    background: 'var(--bg-card, #FFFCF9)', color: 'var(--text-secondary, #574A42)', fontSize: 13, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },

  tabs: { display: 'flex', gap: 16, borderBottom: '1px solid var(--border, #E8DDD4)', marginBottom: 16 },
  tab: {
    padding: '10px 0', background: 'none', border: 'none',
    borderBottom: '2px solid transparent', fontSize: 14, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },

  // Voucher cards
  voucherList: { display: 'flex', flexDirection: 'column', gap: 10 },
  voucherCard: {
    background: 'var(--bg-card, #FFFCF9)', borderRadius: 16, padding: 14,
    boxShadow: 'var(--elev-1)',
  },
  voucherTop: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 8 },
  voucherIcon: {
    width: 38, height: 38, borderRadius: 10, background: 'var(--accent-light, #F6E7EC)',
    display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, flexShrink: 0,
  },
  voucherInfo: { flex: 1, display: 'flex', flexDirection: 'column', gap: 2 },
  voucherAmount: { fontSize: 15, fontWeight: 700, color: 'var(--text-primary, #241B17)' },
  voucherFor: { fontSize: 11, color: 'var(--text-muted, #6B5D54)' },
  statusBadge: { padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600, flexShrink: 0 },
  voucherCode: {
    padding: '8px 12px', borderRadius: 10, background: 'var(--bg, #FBF6F1)',
    fontSize: 14, fontWeight: 700, letterSpacing: '0.12em', color: 'var(--accent, #92405e)',
    textAlign: 'center', marginBottom: 6,
  },
  voucherMsg: { fontSize: 12, color: 'var(--text-secondary, #574A42)', fontStyle: 'italic', margin: '4px 0 8px', lineHeight: 1.4 },
  voucherFooter: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  voucherDate: { fontSize: 11, color: 'var(--text-muted, #6B5D54)' },
  redeemSmallBtn: {
    padding: '6px 14px', borderRadius: 6, border: 'none',
    background: 'var(--accent-light, #F6E7EC)', color: 'var(--accent, #92405e)', fontSize: 11, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },

  // Create form
  formCard: {
    background: 'var(--bg-card, #FFFCF9)', borderRadius: 16, padding: 16,
    boxShadow: 'var(--elev-1)',
  },
  formGroup: { marginBottom: 14 },
  formLabel: { display: 'block', fontSize: 12, color: 'var(--text-muted, #6B5D54)', marginBottom: 6, fontWeight: 500 },
  formInput: {
    width: '100%', padding: '10px 12px', borderRadius: 10,
    border: '1.5px solid var(--border, #E8DDD4)', fontSize: 14, fontFamily: 'inherit',
    outline: 'none', boxSizing: 'border-box',
  },
  formTextarea: {
    width: '100%', padding: '10px 12px', borderRadius: 10,
    border: '1.5px solid var(--border, #E8DDD4)', fontSize: 14, fontFamily: 'inherit',
    outline: 'none', boxSizing: 'border-box', resize: 'vertical',
  },
  formSelect: {
    width: '100%', padding: '10px 12px', borderRadius: 10,
    border: '1.5px solid var(--border, #E8DDD4)', fontSize: 14, fontFamily: 'inherit',
    outline: 'none', background: 'var(--bg-card, #FFFCF9)', boxSizing: 'border-box',
  },
  formRow: { display: 'flex', gap: 10, marginBottom: 14 },
  typeRow: { display: 'flex', gap: 10 },
  typeBtn: {
    flex: 1, padding: '12px 0', borderRadius: 10, border: '1.5px solid var(--border, #E8DDD4)',
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  typeBtnLabel: { fontSize: 12, fontWeight: 600, color: 'var(--text-primary, #241B17)' },
  amountGrid: { display: 'flex', flexWrap: 'wrap', gap: 8 },
  amountChip: {
    padding: '8px 14px', borderRadius: 10, border: '1.5px solid var(--border, #E8DDD4)',
    fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
  },
  expiryRow: { display: 'flex', gap: 8 },
  expiryChip: {
    flex: 1, padding: '8px 0', borderRadius: 10, border: '1.5px solid var(--border, #E8DDD4)',
    fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', textAlign: 'center',
  },

  // Preview
  previewCard: {
    background: 'linear-gradient(135deg, var(--accent, #92405e) 0%, #c9315d 100%)',
    borderRadius: 16, padding: 20, marginBottom: 14, textAlign: 'center', color: '#fff',
  },
  previewBrand: { fontSize: 12, opacity: 0.9, marginBottom: 12 },
  previewAmount: { fontSize: 24, fontWeight: 700, marginBottom: 6 },
  previewFor: { fontSize: 13, opacity: 0.85, marginBottom: 4 },
  previewMsg: { fontSize: 12, opacity: 0.8, fontStyle: 'italic', marginBottom: 8 },
  previewCode: {
    display: 'inline-block', padding: '6px 16px', borderRadius: 6,
    background: 'rgba(255,255,255,0.2)', fontSize: 14, fontWeight: 700,
    letterSpacing: '0.12em',
  },

  createVoucherBtn: {
    width: '100%', padding: '12px 0', borderRadius: 10, border: 'none',
    background: 'var(--accent, #92405e)', color: '#fff', fontSize: 14, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },

  // Redeem modal
  modalOverlay: {
    position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)',
    zIndex: 960, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
  },
  modalContent: {
    background: 'var(--bg-card, #FFFCF9)', borderRadius: 16, padding: 20, width: '100%', maxWidth: 360,
  },
  modalTitle: { fontSize: 16, fontWeight: 600, margin: '0 0 14px', color: 'var(--text-primary, #241B17)' },
  redeemInputRow: { display: 'flex', gap: 8, marginBottom: 14 },
  searchBtn: {
    padding: '10px 16px', borderRadius: 10, border: 'none',
    background: 'var(--accent, #92405e)', color: '#fff', fontSize: 13, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  redeemNotFound: {
    display: 'flex', alignItems: 'center', gap: 8, padding: 14,
    background: 'var(--danger-bg, #F7E4E4)', borderRadius: 10, fontSize: 13, color: 'var(--danger, #9E2B32)', marginBottom: 14,
  },
  redeemFound: {
    background: 'var(--bg, #FBF6F1)', borderRadius: 10, padding: 14, marginBottom: 14,
  },
  redeemFoundHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  redeemFoundCode: { fontSize: 14, fontWeight: 700, letterSpacing: '0.1em', color: 'var(--accent, #92405e)' },
  redeemFoundAmount: { fontSize: 16, fontWeight: 700, color: 'var(--text-primary, #241B17)' },
  redeemFoundDetail: { fontSize: 12, color: 'var(--text-secondary, #574A42)', margin: '2px 0' },
  redeemConfirmBtn: {
    width: '100%', padding: '10px 0', borderRadius: 10, border: 'none',
    background: 'var(--success, #386F52)', color: '#fff', fontSize: 13, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit', marginTop: 10,
  },
  cancelBtn: {
    width: '100%', padding: '10px 0', borderRadius: 10, border: 'none',
    background: 'var(--bg-hover, #f3ede9)', color: 'var(--text-secondary, #574A42)', fontSize: 13,
    cursor: 'pointer', fontFamily: 'inherit',
  },

  // Empty
  loadingText: { textAlign: 'center', color: 'var(--text-muted, #6B5D54)', padding: 40, fontSize: 14 },
  emptyState: { textAlign: 'center', padding: '40px 20px' },
  emptyTitle: { fontSize: 16, fontWeight: 600, margin: '0 0 4px', color: 'var(--text-primary, #241B17)' },
  emptyDesc: { fontSize: 13, color: 'var(--text-muted, #6B5D54)', margin: 0, lineHeight: 1.5 },
};
