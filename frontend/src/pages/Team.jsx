import { useState, useEffect } from 'react';
import { useBeautician, fetchRows, insertRow, updateRow, deleteRow, isDevMode } from '../lib/supabase.js';

const ROLES = [
  { key: 'stylist', label: 'Stylist', desc: 'Books & manages their own clients' },
  { key: 'assistant', label: 'Assistant', desc: 'Helps with bookings, can\'t change treatments' },
  { key: 'admin', label: 'Admin', desc: 'Full access to everything' },
];

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAY_KEYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];

const DEV_TEAM = [
  {
    id: 'dev-tm1', first_name: 'Sophie', last_name: 'K', role: 'stylist',
    email: 'sophie@demo.com', phone: '07700100200', is_active: true,
    can_manage_bookings: true, can_view_clients: true, can_manage_treatments: false, can_view_money: false,
    working_hours: { mon: { start: '10:00', end: '16:00' }, tue: { start: '10:00', end: '18:00' }, wed: null, thu: { start: '10:00', end: '18:00' }, fri: { start: '10:00', end: '16:00' }, sat: null, sun: null },
    price_per_month_cents: 2500, accepted_at: '2026-03-01T09:00:00Z'
  },
];

export default function Team() {
  const { beautician } = useBeautician();
  const [members, setMembers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [selectedMember, setSelectedMember] = useState(null);
  const [form, setForm] = useState(blankForm());

  function blankForm() {
    return { first_name: '', last_name: '', email: '', phone: '', role: 'stylist' };
  }

  useEffect(() => {
    loadTeam();
  }, [beautician]);

  async function loadTeam() {
    if (!beautician) return;
    if (isDevMode) {
      setMembers(DEV_TEAM);
      setLoading(false);
      return;
    }
    const rows = await fetchRows('team_members', beautician.id, { order: 'created_at' });
    setMembers(rows);
    setLoading(false);
  }

  async function handleAdd() {
    if (!form.first_name.trim()) return;
    const row = {
      beautician_id: beautician.id,
      first_name: form.first_name.trim(),
      last_name: form.last_name.trim(),
      email: form.email.trim(),
      phone: form.phone.trim(),
      role: form.role,
      price_per_month_cents: 2500,
      invited_at: new Date().toISOString(),
    };
    const created = await insertRow('team_members', row);
    setMembers(prev => [...prev, created]);
    setForm(blankForm());
    setShowAdd(false);
  }

  async function handleToggleActive(member) {
    const updated = await updateRow('team_members', member.id, { is_active: !member.is_active });
    setMembers(prev => prev.map(m => m.id === member.id ? { ...m, ...updated } : m));
  }

  async function handleRemove(member) {
    await deleteRow('team_members', member.id);
    setMembers(prev => prev.filter(m => m.id !== member.id));
    setSelectedMember(null);
  }

  const activeCount = members.filter(m => m.is_active).length;
  const monthlyCost = activeCount * 25; // £25 per seat

  if (loading) {
    return (
      <div style={styles.page}>
        <div style={styles.header}><h1 style={styles.title}>Team</h1></div>
        <SkeletonCard /><SkeletonCard />
      </div>
    );
  }

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div>
          <h1 style={styles.title}>Team</h1>
          <p style={styles.subtitle}>
            {activeCount === 0 ? 'Just you for now' : `${activeCount} team member${activeCount !== 1 ? 's' : ''}`}
          </p>
        </div>
        <button onClick={() => { setForm(blankForm()); setShowAdd(true); }} style={styles.addBtn}>
          + Add
        </button>
      </div>

      {/* Pricing summary */}
      {activeCount > 0 && (
        <div style={styles.pricingCard}>
          <div style={styles.pricingRow}>
            <span style={styles.pricingLabel}>Your plan</span>
            <span style={styles.pricingValue}>£50/mo</span>
          </div>
          <div style={styles.pricingRow}>
            <span style={styles.pricingLabel}>{activeCount} team seat{activeCount !== 1 ? 's' : ''}</span>
            <span style={styles.pricingValue}>£{monthlyCost}/mo</span>
          </div>
          <div style={{ ...styles.pricingRow, borderBottom: 'none', paddingTop: 10 }}>
            <span style={{ ...styles.pricingLabel, fontWeight: 700, color: 'var(--text-primary, #2D2A26)' }}>Total</span>
            <span style={{ ...styles.pricingValue, fontWeight: 700, color: 'var(--accent, #C76B8A)', fontSize: 18 }}>
              £{50 + monthlyCost}/mo
            </span>
          </div>
        </div>
      )}

      {/* Team list */}
      {members.length === 0 ? (
        <div style={styles.emptyState}>
          <div style={styles.emptyIcon}>👥</div>
          <p style={styles.emptyTitle}>No team members yet</p>
          <p style={styles.emptyDesc}>
            Add stylists or assistants who work with you. Each seat is £25/mo — they get their own calendar, client list, and bookings.
          </p>
          <button onClick={() => setShowAdd(true)} style={styles.emptyBtn}>Add your first team member</button>
        </div>
      ) : (
        <div style={styles.memberList}>
          {members.map(member => (
            <button
              key={member.id}
              onClick={() => setSelectedMember(member)}
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
                <span style={{
                  ...styles.statusDot,
                  background: member.is_active ? 'var(--success, #5BA97B)' : '#E0DBD5'
                }} />
                <span style={styles.chevron}>›</span>
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Add member modal */}
      {showAdd && (
        <div style={styles.overlay} onClick={() => setShowAdd(false)}>
          <div style={styles.modal} onClick={e => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <h2 style={styles.modalTitle}>Add team member</h2>
              <button onClick={() => setShowAdd(false)} style={styles.closeBtn}>✕</button>
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
                    style={{
                      ...styles.roleCard,
                      borderColor: form.role === r.key ? 'var(--accent, #C76B8A)' : 'var(--border, var(--border, #EDE9E4))',
                      background: form.role === r.key ? 'var(--accent-light, #FFF0F3)' : '#fff'
                    }}
                  >
                    <span style={{ fontSize: 13, fontWeight: 600, color: form.role === r.key ? 'var(--accent, #C76B8A)' : 'var(--text-primary, #2D2A26)' }}>
                      {r.label}
                    </span>
                    <span style={{ fontSize: 11, color: 'var(--text-muted, var(--text-muted, #B5AFA8))' }}>{r.desc}</span>
                  </button>
                ))}
              </div>
            </div>

            <p style={styles.pricingNote}>
              Each team seat adds £25/mo to your plan. They get their own calendar and client list.
            </p>

            <button
              onClick={handleAdd}
              disabled={!form.first_name.trim()}
              style={{
                ...styles.saveBtn,
                opacity: form.first_name.trim() ? 1 : 0.5
              }}
            >
              Add to team — £25/mo
            </button>
          </div>
        </div>
      )}

      {/* Member detail modal */}
      {selectedMember && (
        <div style={styles.overlay} onClick={() => setSelectedMember(null)}>
          <div style={styles.modal} onClick={e => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <h2 style={styles.modalTitle}>
                {selectedMember.first_name} {selectedMember.last_name || ''}
              </h2>
              <button onClick={() => setSelectedMember(null)} style={styles.closeBtn}>✕</button>
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
              <span style={{
                ...styles.detailValue,
                color: selectedMember.is_active ? 'var(--success, #5BA97B)' : '#E57373'
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
                        <span style={{ fontSize: 12, fontWeight: 600, color: h ? 'var(--text-primary, #2D2A26)' : '#D5D0CB', width: 32 }}>
                          {DAYS[i]}
                        </span>
                        <span style={{ fontSize: 12, color: h ? '#8A8580' : '#D5D0CB' }}>
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
                onClick={() => handleToggleActive(selectedMember)}
                style={{
                  ...styles.actionBtn,
                  background: selectedMember.is_active ? '#FFF3E0' : 'var(--success-bg, #E8F5E9)',
                  color: selectedMember.is_active ? '#F57C00' : 'var(--success, #5BA97B)',
                  borderColor: selectedMember.is_active ? '#FFCC80' : '#A5D6A7'
                }}
              >
                {selectedMember.is_active ? 'Pause seat' : 'Reactivate'}
              </button>
              <button
                onClick={() => handleRemove(selectedMember)}
                style={{ ...styles.actionBtn, background: 'var(--danger-bg, #FDF0EF)', color: '#E57373', borderColor: '#FFCDD2' }}
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
    <span style={{
      ...styles.permBadge,
      background: on ? 'var(--success-bg, #E8F5E9)' : 'var(--bg-hover, #F5F2EF)',
      color: on ? 'var(--success, #5BA97B)' : 'var(--text-muted, #B5AFA8)'
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
  page: { minHeight: '100vh', background: 'var(--bg, #FAF8F5)', fontFamily: '"DM Sans", -apple-system, sans-serif', padding: '0 16px 40px', maxWidth: 480, margin: '0 auto', color: 'var(--text-primary, #2D2A26)' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', paddingTop: 28, paddingBottom: 12 },
  title: { fontSize: 22, fontWeight: 700, margin: 0 },
  subtitle: { fontSize: 13, color: 'var(--text-muted, var(--text-muted, #B5AFA8))', margin: '4px 0 0' },
  addBtn: { padding: '8px 16px', borderRadius: 10, border: 'none', background: 'var(--accent, #C76B8A)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },

  // Pricing summary
  pricingCard: { background: '#fff', borderRadius: 14, padding: 16, marginBottom: 16, boxShadow: '0 1px 3px rgba(0,0,0,0.04)' },
  pricingRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid var(--bg, #FAF8F5)' },
  pricingLabel: { fontSize: 13, color: '#8A8580' },
  pricingValue: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary, #2D2A26)' },

  // Empty state
  emptyState: { textAlign: 'center', padding: '40px 20px' },
  emptyIcon: { fontSize: 48, marginBottom: 12 },
  emptyTitle: { fontSize: 16, fontWeight: 600, margin: '0 0 8px', color: 'var(--text-primary, #2D2A26)' },
  emptyDesc: { fontSize: 13, color: 'var(--text-muted, var(--text-muted, #B5AFA8))', lineHeight: 1.5, margin: '0 0 20px' },
  emptyBtn: { padding: '12px 24px', borderRadius: 12, border: 'none', background: 'var(--accent, #C76B8A)', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },

  // Member list
  memberList: { display: 'flex', flexDirection: 'column', gap: 8 },
  memberCard: { display: 'flex', alignItems: 'center', gap: 12, padding: 14, borderRadius: 14, background: '#fff', border: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', boxShadow: '0 1px 3px rgba(0,0,0,0.04)', width: '100%' },
  memberAvatar: { width: 42, height: 42, borderRadius: 21, background: 'linear-gradient(135deg, var(--accent, #C76B8A) 0%, #D4899F 100%)', display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#fff', fontWeight: 700, fontSize: 16, flexShrink: 0 },
  memberInfo: { flex: 1, display: 'flex', flexDirection: 'column', gap: 2 },
  memberName: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary, #2D2A26)' },
  memberRole: { fontSize: 12, color: 'var(--text-muted, var(--text-muted, #B5AFA8))' },
  statusDot: { width: 8, height: 8, borderRadius: 4 },
  chevron: { fontSize: 18, color: '#D5D0CB', fontWeight: 300 },

  // Modal
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 200, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' },
  modal: { background: '#fff', borderRadius: '20px 20px 0 0', padding: '20px 20px 32px', width: '100%', maxWidth: 480, maxHeight: '85vh', overflowY: 'auto' },
  modalHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  modalTitle: { fontSize: 18, fontWeight: 700, margin: 0 },
  closeBtn: { width: 32, height: 32, borderRadius: 16, border: 'none', background: 'var(--bg-hover, #F5F2EF)', cursor: 'pointer', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8A8580' },

  // Form
  formGroup: { marginBottom: 16 },
  label: { display: 'block', fontSize: 12, fontWeight: 600, color: '#8A8580', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.03em' },
  input: { width: '100%', padding: '12px 14px', borderRadius: 10, border: '1.5px solid var(--border, var(--border, #EDE9E4))', fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', background: '#FAFAFA', transition: 'border-color 0.2s' },
  roleGrid: { display: 'flex', flexDirection: 'column', gap: 8 },
  roleCard: { display: 'flex', flexDirection: 'column', gap: 2, padding: '12px 14px', borderRadius: 10, border: '1.5px solid var(--border, var(--border, #EDE9E4))', cursor: 'pointer', textAlign: 'left', background: '#fff', fontFamily: 'inherit' },
  pricingNote: { fontSize: 12, color: 'var(--text-muted, var(--text-muted, #B5AFA8))', textAlign: 'center', margin: '12px 0 16px', lineHeight: 1.5 },
  saveBtn: { width: '100%', padding: '14px 0', borderRadius: 12, border: 'none', background: 'var(--accent, #C76B8A)', color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },

  // Detail modal
  detailSection: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--bg, #FAF8F5)' },
  detailLabel: { fontSize: 12, color: 'var(--text-muted, var(--text-muted, #B5AFA8))', fontWeight: 500 },
  detailValue: { fontSize: 14, fontWeight: 500, color: 'var(--text-primary, #2D2A26)' },
  hoursGrid: { display: 'flex', flexDirection: 'column', gap: 4 },
  hourRow: { display: 'flex', gap: 12, alignItems: 'center' },
  permList: { display: 'flex', flexWrap: 'wrap', gap: 6 },
  permBadge: { padding: '4px 10px', borderRadius: 6, fontSize: 11, fontWeight: 600 },
  detailActions: { display: 'flex', flexDirection: 'column', gap: 8, marginTop: 20 },
  actionBtn: { width: '100%', padding: '12px 0', borderRadius: 10, border: '1.5px solid', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },

  // Skeleton
  skeleton: { background: '#fff', borderRadius: 14, padding: 20, marginBottom: 10, display: 'flex', flexDirection: 'column', gap: 10 },
  skeletonLine: { height: 14, borderRadius: 7, background: 'linear-gradient(90deg, var(--bg-hover, #F5F2EF) 25%, var(--bg, #FAF8F5) 50%, var(--bg-hover, #F5F2EF) 75%)', backgroundSize: '200% 100%', animation: 'shimmer 1.5s infinite' },
};
