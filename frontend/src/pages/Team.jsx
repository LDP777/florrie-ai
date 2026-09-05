import { useState, useEffect } from 'react';
import { useBeautician, fetchRowsStrict, insertRow, updateRow, deleteRow } from '../lib/supabase.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';
import { isIOSNative } from '../lib/platform.js';
import Icon from '../components/ui/Icon';
import { PLAN, TEAM_ADDON } from '../lib/subscription.js';
import { Link } from 'react-router-dom';
import Button from '../components/ui/Button.jsx';
import PageHeader from '../components/ui/PageHeader.jsx';

const ROLES = [
  { key: 'stylist', label: 'Stylist', desc: 'Treatment team member' },
  { key: 'assistant', label: 'Assistant', desc: 'Salon support role' },
  { key: 'admin', label: 'Admin', desc: 'Administrative role' },
];

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

export default function Team() {
  const { beautician, loading: bLoading } = useBeautician();
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [selectedMember, setSelectedMember] = useState(null);
  const [form, setForm] = useState(blankForm());
  const [pending, setPending] = useState(null);
  const [error, setError] = useState(null);
  const [loadError, setLoadError] = useState(null);

  function blankForm() {
    return { first_name: '', last_name: '', email: '', phone: '', role: 'stylist' };
  }

  useEffect(() => {
    if (bLoading) return;
    loadTeam();
  }, [beautician, bLoading]);

  async function loadTeam() {
    if (!beautician) { setLoading(false); return; }
    setLoading(true); setLoadError(null);
    try { setMembers(await fetchRowsStrict('team_members', beautician.id, { order: 'created_at' })); }
    catch { setLoadError('Could not load your team. Try again.'); }
    finally { setLoading(false); }
  }
  async function handleAdd() {
    if (!form.first_name.trim() || !beautician || pending) return;
    if (form.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email.trim())) { setError('Enter a valid email address.'); return; }
    setPending('add'); setError(null);
    try {
      const created = await insertRow('team_members', {
        beautician_id: beautician.id, first_name: form.first_name.trim(), last_name: form.last_name.trim(),
        email: form.email.trim() || null, phone: form.phone.trim() || null, role: form.role,
        price_per_month_cents: TEAM_ADDON.seatMonthlyPence, is_active: true,
      });
      if (!created?.id) throw new Error('No saved member returned');
      setMembers(prev => [...prev, created]); setForm(blankForm()); setShowAdd(false);
    } catch { setError('Could not add this team member. Your details are still here; try again.'); }
    finally { setPending(null); }
  }
  async function handleToggleActive(member) {
    if (pending) return;
    setPending(member.id); setError(null);
    try {
      const updated = await updateRow('team_members', member.id, { is_active: !member.is_active });
      if (!updated?.id) throw new Error('No saved member returned');
      setMembers(prev => prev.map(m => m.id === member.id ? { ...m, ...updated } : m));
      setSelectedMember(prev => prev?.id === member.id ? { ...prev, ...updated } : prev);
    } catch { setError('Could not update this member. Try again.'); }
    finally { setPending(null); }
  }
  async function handleRemove(member) {
    if (pending || !window.confirm(`Remove ${member.first_name} from your team?`)) return;
    setPending(member.id); setError(null);
    try { await deleteRow('team_members', member.id); setMembers(prev => prev.filter(m => m.id !== member.id)); setSelectedMember(null); }
    catch { setError('Could not remove this member. Try again.'); }
    finally { setPending(null); }
  }

  const activeCount = members.filter(m => m.is_active).length;
  const monthlyCost = activeCount * TEAM_ADDON.seatMonthlyPence / 100;

  if (loading) {
    return <PageLoader />;
  }

  return (
    <div style={styles.page}>
      <PageHeader
        title="Team"
        subtitle={activeCount === 0 ? 'Just you for now' : `${activeCount} team member${activeCount !== 1 ? 's' : ''}`}
        action={(
          <button onClick={() => { setError(null); setForm(blankForm()); setShowAdd(true); }} style={styles.addBtn}>
            + Add
          </button>
        )}
      />

      {loadError && <div role="alert"><ErrorCard message={loadError} /><Button variant="secondary" onClick={loadTeam}>Retry</Button></div>}
      {!beautician && <ErrorCard message="Your business profile is unavailable. Reload to try again." />}
      {error && !showAdd && !selectedMember && <div role="alert"><ErrorCard message={error} /></div>}
      <p style={{ fontSize: 12, color: 'var(--text-secondary)', lineHeight: 1.6 }}>Manage staff profiles and availability. <Link to="/rota" style={{ color: 'var(--accent)' }}>Open staff rota</Link></p>
      {/* Pricing summary */}
      {!isIOSNative() && !loadError && activeCount > 0 && (
        <div style={styles.pricingCard}>
          <p style={{ fontSize: 12, lineHeight: 1.6, color: 'var(--text-secondary)', margin: '0 0 12px' }}>Monthly list-price estimate. Check Plans & billing for your subscription details.</p>
          <div style={styles.pricingRow}>
            <span style={styles.pricingLabel}>Monthly list price</span>
            <span style={styles.pricingValue}>{PLAN.monthlyLabel}</span>
          </div>
          <div style={styles.pricingRow}>
            <span style={styles.pricingLabel}>{activeCount} team seat{activeCount !== 1 ? 's' : ''}</span>
            <span style={styles.pricingValue}>£{monthlyCost}/mo</span>
          </div>
          <div style={{ ...styles.pricingRow, borderBottom: 'none', paddingTop: 10 }}>
            <span style={{ ...styles.pricingLabel, fontWeight: 700, color: 'var(--text-primary, #241B17)' }}>Monthly estimate</span>
            <span style={{ ...styles.pricingValue, fontWeight: 700, color: 'var(--accent, #92405e)', fontSize: 18 }}>
              £{PLAN.monthlyPence / 100 + monthlyCost}/mo
            </span>
          </div>
        </div>
      )}

      {/* Team list */}
      {!loadError && (members.length === 0 ? (
        <div style={styles.emptyState}>
          <div style={styles.emptyIcon}><Icon name="users" size={32} /></div>
          <p style={styles.emptyTitle}>No team members yet</p>
          <p style={styles.emptyDesc}>
            Add the people who work with you and record their working hours.{!isIOSNative() && ' Each seat is £15/mo.'}
          </p>
          <button onClick={() => setShowAdd(true)} style={styles.emptyBtn}>Add your first team member</button>
        </div>
      ) : (
        <div style={styles.memberList}>
          {members.map(member => (
            <button
              key={member.id}
              onClick={() => { setError(null); setSelectedMember(member); }}
              style={styles.memberCard}
            >
              <div style={styles.memberAvatar}>
                {member.first_name.charAt(0).toUpperCase()}
              </div>
              <div style={styles.memberInfo}>
                <span style={styles.memberName}>
                  {member.first_name} {member.last_name || ''}
                </span>
                <span style={styles.memberRole}>
                  {ROLES.find(r => r.key === member.role)?.label || member.role}
                </span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ ...styles.statusDot,
                  background: member.is_active ? 'var(--success, #386F52)' : '#E0DBD5'
                }} />
                <span style={styles.chevron}>›</span>
              </div>
            </button>
          ))}
        </div>
      ))}

      {/* Add member modal */}
      {showAdd && (
        <div style={styles.overlay} onClick={() => { if (!pending) setShowAdd(false); }}>
          <div role="dialog" aria-modal="true" aria-label="Team member details" style={styles.modal} onClick={e => e.stopPropagation()}>
            {error && <div role="alert"><ErrorCard message={error} /></div>}
            <div style={styles.modalHeader}>
              <h2 style={styles.modalTitle}>Add team member</h2>
              <button onClick={() => { if (!pending) setShowAdd(false); }} aria-label="Close" disabled={Boolean(pending)} style={styles.closeBtn}><Icon name="x" size={15} /></button>
            </div>

            <div style={styles.formGroup}>
              <label style={styles.label}>First name *</label>
              <input
                value={form.first_name}
                onChange={e => setForm({ ...form, first_name: e.target.value })}
                style={styles.input}
                placeholder="e.g. Sophie"
                autoFocus
              />
            </div>

            <div style={styles.formGroup}>
              <label style={styles.label}>Last name</label>
              <input
                value={form.last_name}
                onChange={e => setForm({ ...form, last_name: e.target.value })}
                style={styles.input}
                placeholder="Optional"
              />
            </div>

            <div style={styles.formGroup}>
              <label style={styles.label}>Email</label>
              <input
                value={form.email}
                onChange={e => setForm({ ...form, email: e.target.value })}
                style={styles.input}
                placeholder="sophie@example.com"
                type="email"
              />
            </div>

            <div style={styles.formGroup}>
              <label style={styles.label}>Phone</label>
              <input
                value={form.phone}
                onChange={e => setForm({ ...form, phone: e.target.value })}
                style={styles.input}
                placeholder="07700..."
                type="tel"
              />
            </div>

            <div style={styles.formGroup}>
              <label style={styles.label}>Role</label>
              <div style={styles.roleGrid}>
                {ROLES.map(r => (
                  <button
                    key={r.key}
                    onClick={() => setForm({ ...form, role: r.key })}
                    style={{ ...styles.roleCard,
                      borderColor: form.role === r.key ? 'var(--accent, #92405e)' : 'var(--border, var(--border, #E8DDD4))',
                      background: form.role === r.key ? 'var(--accent-light, #F6E7EC)' : 'var(--bg-card, #FFFCF9)'
                    }}
                  >
                    <span style={{ fontSize: 13, fontWeight: 600, color: form.role === r.key ? 'var(--accent, #92405e)' : 'var(--text-primary, #241B17)' }}>
                      {r.label}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted, var(--text-muted, #6B5D54))' }}>{r.desc}</span>
                  </button>
                ))}
              </div>
            </div>

            <p style={styles.pricingNote}>
              {!isIOSNative() && 'The monthly team seat list price is £15. '}Adding a profile does not send an invitation or confirm a billing change.
            </p>

            <button
              onClick={handleAdd}
              disabled={!form.first_name.trim() || Boolean(pending) || !beautician}
              style={{ ...styles.saveBtn,
                opacity: form.first_name.trim() ? 1 : 0.5
              }}
            >
              {pending === 'add' ? 'Adding…' : 'Add to team'}
            </button>
          </div>
        </div>
      )}

      {/* Member detail modal */}
      {selectedMember && (
        <div style={styles.overlay} onClick={() => { if (!pending) setSelectedMember(null); }}>
          <div role="dialog" aria-modal="true" aria-label="Team member details" style={styles.modal} onClick={e => e.stopPropagation()}>
            {error && <div role="alert"><ErrorCard message={error} /></div>}
            <div style={styles.modalHeader}>
              <h2 style={styles.modalTitle}>
                {selectedMember.first_name} {selectedMember.last_name || ''}
              </h2>
              <button onClick={() => { if (!pending) setSelectedMember(null); }} aria-label="Close" disabled={Boolean(pending)} style={styles.closeBtn}><Icon name="x" size={15} /></button>
            </div>

            <div style={styles.detailSection}>
              <span style={styles.detailLabel}>Role</span>
              <span style={styles.detailValue}>
                {ROLES.find(r => r.key === selectedMember.role)?.label}
              </span>
            </div>

            {selectedMember.email && (
              <div style={styles.detailSection}>
                <span style={styles.detailLabel}>Email</span>
                <span style={styles.detailValue}>{selectedMember.email}</span>
              </div>
            )}

            {selectedMember.phone && (
              <div style={styles.detailSection}>
                <span style={styles.detailLabel}>Phone</span>
                <span style={styles.detailValue}>{selectedMember.phone}</span>
              </div>
            )}

            <div style={styles.detailSection}>
              <span style={styles.detailLabel}>Status</span>
              <span style={{ ...styles.detailValue,
                color: selectedMember.is_active ? 'var(--success, #386F52)' : '#E57373'
              }}>
                {selectedMember.is_active ? 'Active' : 'Inactive'}
              </span>
            </div>

            {/* Working hours summary */}
            {selectedMember.working_hours && (
              <div style={{ marginTop: 12 }}>
                <span style={{ ...styles.detailLabel, display: 'block', marginBottom: 8 }}>Working hours</span>
                <div style={styles.hoursGrid}>
                  {DAY_KEYS.map((dk, i) => {
                    const h = selectedMember.working_hours[dk];
                    return (
                      <div key={dk} style={styles.hourRow}>
                        <span style={{ fontSize: 12, fontWeight: 600, color: h ? 'var(--text-primary, #241B17)' : '#756A5F', width: 32 }}>
                          {DAYS[i]}
                        </span>
                        <span style={{ fontSize: 12, color: h ? '#8A8580' : '#756A5F' }}>
                          {h ? `${h.start} – ${h.end}` : 'Off'}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Permissions */}
            <div style={{ marginTop: 16 }}>
              <span style={{ ...styles.detailLabel, display: 'block', marginBottom: 8 }}>Permissions</span>
              <div style={styles.permList}>
                <PermBadge label="Manage bookings" on={selectedMember.can_manage_bookings} />
                <PermBadge label="View clients" on={selectedMember.can_view_clients} />
                <PermBadge label="Manage treatments" on={selectedMember.can_manage_treatments} />
                <PermBadge label="View money" on={selectedMember.can_view_money} />
              </div>
            </div>

            <div style={styles.detailActions}>
              <button
                disabled={Boolean(pending)} onClick={() => handleToggleActive(selectedMember)}
                style={{ ...styles.actionBtn,
                  background: selectedMember.is_active ? '#FFF3E0' : 'var(--success-bg, #E9F0EB)',
                  color: selectedMember.is_active ? '#a35300' : 'var(--success, #386F52)',
                  borderColor: selectedMember.is_active ? '#FFCC80' : '#A5D6A7'
                }}
              >
                {pending === selectedMember.id ? 'Saving…' : selectedMember.is_active ? 'Mark inactive' : 'Reactivate'}
              </button>
              <button
                disabled={Boolean(pending)} onClick={() => handleRemove(selectedMember)}
                style={{ ...styles.actionBtn, background: 'var(--danger-bg, #F7E4E4)', color: '#bb2323', borderColor: '#FFCDD2' }}
              >
                Remove from team
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function PermBadge({ label, on }) {
  return (
    <span style={{ ...styles.permBadge,
      background: on ? 'var(--success-bg, #E9F0EB)' : 'var(--bg-hover, #f3ede9)',
      color: on ? 'var(--success, #386F52)' : 'var(--text-muted, #6B5D54)'
    }}>
      {on ? '✓' : '✕'} {label}
    </span>
  );
}

function SkeletonCard() {
  return (
    <div style={styles.skeleton}>
      <div style={{ ...styles.skeletonLine, width: '40%' }} />
      <div style={{ ...styles.skeletonLine, width: '70%' }} />
    </div>
  );
}

const styles = {
  page: { minHeight: 'var(--shell-viewport)', background: 'var(--bg, #FBF6F1)', fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif", padding: '0 16px var(--scroll-pad-bottom)', maxWidth: 760, margin: '0 auto', color: 'var(--text-primary, #241B17)' },
  addBtn: { padding: '8px 16px', borderRadius: 10, border: 'none', background: 'var(--accent, #92405e)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },

  // Pricing summary
  pricingCard: { background: 'var(--bg-card, #FFFCF9)', borderRadius: 16, padding: 16, marginBottom: 16, boxShadow: 'var(--elev-1)' },
  pricingRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--bg, #FBF6F1)' },
  pricingLabel: { fontSize: 13, color: 'var(--text-muted)' },
  pricingValue: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary, #241B17)' },

  // Empty state
  emptyState: { textAlign: 'center', padding: '40px 20px' },
  emptyIcon: { fontSize: 48, marginBottom: 12 },
  emptyTitle: { fontSize: 16, fontWeight: 600, margin: '0 0 8px', color: 'var(--text-primary, #241B17)' },
  emptyDesc: { fontSize: 13, color: 'var(--text-muted, var(--text-muted, #6B5D54))', lineHeight: 1.5, margin: '0 0 20px' },
  emptyBtn: { padding: '12px 24px', borderRadius: 10, border: 'none', background: 'var(--accent, #92405e)', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },

  // Member list
  memberList: { display: 'flex', flexDirection: 'column', gap: 8 },
  memberCard: { display: 'flex', alignItems: 'center', gap: 12, padding: 14, borderRadius: 16, background: 'var(--bg-card, #FFFCF9)', border: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', boxShadow: 'var(--elev-1)', width: '100%' },
  memberAvatar: { width: 42, height: 42, borderRadius: 22, background: 'linear-gradient(135deg, var(--accent, #92405e) 0%, #bb4668 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: 16, flexShrink: 0 },
  memberInfo: { flex: 1, display: 'flex', flexDirection: 'column', gap: 2 },
  memberName: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary, #241B17)' },
  memberRole: { fontSize: 12, color: 'var(--text-muted, var(--text-muted, #6B5D54))' },
  statusDot: { width: 8, height: 8, borderRadius: 'var(--radius-xs)' },
  chevron: { fontSize: 18, color: '#756A5F', fontWeight: 300 },

  // Modal
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 960, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' },
  modal: { background: 'var(--bg-card, #FFFCF9)', borderRadius: '20px 20px 0 0', padding: '20px 20px 32px', paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 20px)', width: '100%', maxWidth: 760, maxHeight: '85vh', overflowY: 'auto' },
  modalHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  modalTitle: { fontSize: 18, fontWeight: 700, margin: 0 },
  closeBtn: { width: 32, height: 32, borderRadius: 16, border: 'none', background: 'var(--bg-hover, #f3ede9)', cursor: 'pointer', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)' },

  // Form
  formGroup: { marginBottom: 16 },
  label: { display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.03em' },
  input: { width: '100%', padding: '12px 14px', borderRadius: 10, border: '1.5px solid var(--border, var(--border, #E8DDD4))', fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', background: '#FAFAFA', transition: 'border-color 0.2s' },
  roleGrid: { display: 'flex', flexDirection: 'column', gap: 8 },
  roleCard: { display: 'flex', flexDirection: 'column', gap: 2, padding: '12px 14px', borderRadius: 10, border: '1.5px solid var(--border, var(--border, #E8DDD4))', cursor: 'pointer', textAlign: 'left', background: 'var(--bg-card, #FFFCF9)', fontFamily: 'inherit' },
  pricingNote: { fontSize: 12, color: 'var(--text-muted, var(--text-muted, #6B5D54))', textAlign: 'center', margin: '12px 0 16px', lineHeight: 1.5 },
  saveBtn: { width: '100%', padding: '14px 0', borderRadius: 10, border: 'none', background: 'var(--accent, #92405e)', color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },

  // Detail modal
  detailSection: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--bg, #FBF6F1)' },
  detailLabel: { fontSize: 12, color: 'var(--text-muted, var(--text-muted, #6B5D54))', fontWeight: 500 },
  detailValue: { fontSize: 14, fontWeight: 500, color: 'var(--text-primary, #241B17)' },
  hoursGrid: { display: 'flex', flexDirection: 'column', gap: 4 },
  hourRow: { display: 'flex', gap: 12, alignItems: 'center' },
  permList: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  permBadge: { padding: '4px 10px', borderRadius: 'var(--radius-xs)', fontSize: 11, fontWeight: 600 },
  detailActions: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 20 },
  actionBtn: { width: '100%', padding: '12px 0', borderRadius: 10, border: '1.5px solid', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },

  // Skeleton
  skeleton: { background: 'var(--bg-card, #FFFCF9)', borderRadius: 16, padding: 20, marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 10 },
  skeletonLine: { height: 14, borderRadius: 10, background: 'linear-gradient(90deg, var(--bg-hover, #f3ede9) 25%, var(--bg, #FBF6F1) 50%, var(--bg-hover, #f3ede9) 75%)', backgroundSize: '200% 100%', animation: 'shimmer 1.5s infinite' },
};
