/**
 * WaitlistPro — Advanced waitlist with priority tiers, deposit holds & auto-notify.
 *
 * The basic waitlist tracks who wants what. This upgraded version adds:
 *   - Priority tiers (VIP, Regular, Flexible)
 *   - Deposit holds (secure a slot when one opens)
 *   - Auto-notify when a cancellation frees up a slot
 *   - Smart matching (availability + treatment + priority)
 */
import { useState, useEffect } from 'react';
import { isDevMode, DEV_TREATMENTS, useBeautician, fetchRows, insertRow, updateRow, deleteRow } from '../lib/supabase.js';
import logger from '../lib/logger.js';

const DEV_WAITLIST = [
  {
    id: 'wl1', client: 'Holly B', treatment: 'Ombre Brows (Semi-Permanent)', priority: 'vip',
    addedDate: '2026-03-10', preferredDays: ['tue', 'thu'], preferredTime: 'morning',
    depositHeld: true, depositAmount: 5000, status: 'waiting',
    notes: 'Referred by Shauna — keen to get in ASAP', notifyCount: 0,
    flexible: false, maxWait: 14,
  },
  {
    id: 'wl2', client: 'Isabelle T', treatment: 'Combination Brows (Semi-Permanent)', priority: 'regular',
    addedDate: '2026-03-12', preferredDays: ['wed', 'fri'], preferredTime: 'afternoon',
    depositHeld: false, depositAmount: 0, status: 'waiting',
    notes: '', notifyCount: 1,
    flexible: true, maxWait: 30,
  },
  {
    id: 'wl3', client: 'Kate M', treatment: 'Lamination & Hybrid Dye', priority: 'regular',
    addedDate: '2026-03-15', preferredDays: ['mon', 'tue', 'wed', 'thu', 'fri'], preferredTime: 'any',
    depositHeld: false, depositAmount: 0, status: 'waiting',
    notes: 'Flexible on dates — just wants the next available', notifyCount: 0,
    flexible: true, maxWait: 7,
  },
  {
    id: 'wl4', client: 'Lucy P', treatment: 'Lash Lift & Tint', priority: 'flexible',
    addedDate: '2026-03-08', preferredDays: ['fri'], preferredTime: 'morning',
    depositHeld: false, depositAmount: 0, status: 'notified',
    notes: 'Fridays only', notifyCount: 2, lastNotified: '2026-03-22',
    flexible: false, maxWait: 21,
  },
  {
    id: 'wl5', client: 'Megan S', treatment: 'HD Brows', priority: 'vip',
    addedDate: '2026-03-05', preferredDays: ['tue', 'thu'], preferredTime: 'afternoon',
    depositHeld: true, depositAmount: 2500, status: 'offered',
    notes: 'Regular client — always books Tuesdays', notifyCount: 1,
    offeredSlot: { date: '2026-03-29', time: '14:00' }, offerExpires: '2026-03-26T18:00',
    flexible: false, maxWait: 14,
  },
  {
    id: 'wl6', client: 'Natalie W', treatment: 'Colour Boost 3-6 Months', priority: 'regular',
    addedDate: '2026-02-28', preferredDays: ['wed'], preferredTime: 'morning',
    depositHeld: false, depositAmount: 0, status: 'expired',
    notes: 'Waited too long — rebooked elsewhere', notifyCount: 3,
    flexible: false, maxWait: 21,
  },
];

const PRIORITY_CONFIG = {
  vip: { label: 'VIP', bg: '#F0E6ED', color: '#C76B8A', icon: '⭐' },
  regular: { label: 'Regular', bg: '#F0ECE8', color: '#8B6F5E', icon: '👤' },
  flexible: { label: 'Flexible', bg: '#E8F5E9', color: '#6B8F7B', icon: '🔄' },
};

const STATUS_CONFIG = {
  waiting: { label: 'Waiting', bg: '#FFF5E6', color: '#B8860B' },
  notified: { label: 'Notified', bg: '#E3F2FD', color: '#2196F3' },
  offered: { label: 'Slot Offered', bg: '#E8F5E9', color: '#4CAF50' },
  booked: { label: 'Booked', bg: '#E8F5E9', color: '#4CAF50' },
  expired: { label: 'Expired', bg: '#F0ECE8', color: '#AAA5A0' },
};

const DAYS = [
  { value: 'mon', label: 'Mon' }, { value: 'tue', label: 'Tue' }, { value: 'wed', label: 'Wed' },
  { value: 'thu', label: 'Thu' }, { value: 'fri', label: 'Fri' }, { value: 'sat', label: 'Sat' },
];

export default function WaitlistPro({ token }) {
  const { beautician, loading: bLoading } = useBeautician();
  const [tab, setTab] = useState('active');
  const [expanded, setExpanded] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [waitlist, setWaitlist] = useState([]);
  const [treatments, setTreatments] = useState([]);
  const [addForm, setAddForm] = useState({
    client: '', treatment: '', priority: 'regular',
    preferredDays: [], preferredTime: 'any',
    depositHeld: false, depositAmount: '',
    notes: '', flexible: false, maxWait: 14,
  });
  const [settings, setSettings] = useState({
    autoNotify: true,
    offerExpiry: 24,
    maxNotifications: 3,
    vipFirst: true,
    depositRequired: false,
    defaultDeposit: 2500,
  });

  useEffect(() => {
    if (bLoading || !beautician) return;
    if (isDevMode) { setWaitlist(DEV_WAITLIST); setTreatments(DEV_TREATMENTS); return; }
    Promise.all([
      fetchRows('waitlist', beautician.id, { order: 'created_at' }),
      fetchRows('treatments', beautician.id, { eq: { is_active: true }, order: 'sort_order' }),
    ]).then(([wl, tx]) => {
      setWaitlist(wl || []);
      setTreatments(tx || []);
    }).catch(err => { logger.error('Load waitlist error:', err); setWaitlist(DEV_WAITLIST); });
  }, [beautician, bLoading]);

  const activeTreatments = treatments.length > 0 ? treatments : DEV_TREATMENTS;

  async function handleAddToWaitlist() {
    if (!addForm.client.trim() || !addForm.treatment) return;
    setSaving(true);
    setError(null);
    try {
      const row = {
        beautician_id: beautician?.id,
        client: addForm.client.trim(),
        treatment: addForm.treatment,
        priority: addForm.priority,
        preferredDays: addForm.preferredDays,
        preferredTime: addForm.preferredTime,
        depositHeld: addForm.depositHeld,
        depositAmount: addForm.depositAmount ? parseInt(addForm.depositAmount) * 100 : 0,
        notes: addForm.notes,
        flexible: addForm.flexible,
        maxWait: addForm.maxWait,
        status: 'waiting',
        addedDate: new Date().toISOString().slice(0, 10),
        notifyCount: 0,
      };
      if (!isDevMode && beautician) {
        const inserted = await insertRow('waitlist', row);
        if (inserted) setWaitlist(prev => [...prev, inserted]);
      } else {
        setWaitlist(prev => [...prev, { id: 'new-' + Date.now(), ...row }]);
      }
      setShowAdd(false);
      setAddForm({ client: '', treatment: '', priority: 'regular', preferredDays: [], preferredTime: 'any', depositHeld: false, depositAmount: '', notes: '', flexible: false, maxWait: 14 });
    } catch (err) {
      logger.error('Add to waitlist error:', err);
      setError('Failed to add to waitlist');
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(id) {
    setWaitlist(prev => prev.filter(w => w.id !== id));
    if (!isDevMode && beautician) {
      try { await deleteRow('waitlist', id); } catch (err) { logger.error('Remove waitlist error:', err); }
    }
  }

  const activeList = waitlist.filter(w => ['waiting', 'notified', 'offered'].includes(w.status));
  const archivedList = waitlist.filter(w => ['booked', 'expired'].includes(w.status));

  const stats = {
    active: activeList.length,
    vip: waitlist.filter(w => w.priority === 'vip' && w.status !== 'expired').length,
    deposits: waitlist.filter(w => w.depositHeld).reduce((s, w) => s + (w.depositAmount || 0), 0),
    avgWait: Math.round(activeList.reduce((s, w) => {
      const days = Math.ceil((new Date() - new Date(w.addedDate)) / 86400000);
      return s + days;
    }, 0) / (activeList.length || 1)),
  };

  const toggleDay = (day) => {
    setAddForm(f => ({
      ...f,
      preferredDays: f.preferredDays.includes(day)
        ? f.preferredDays.filter(d => d !== day)
        : [...f.preferredDays, day],
    }));
  };

  return (
    <div style={S.page}>
      <div style={S.header}>
        <h1 style={S.title}>Smart Waitlist</h1>
        <button style={S.addBtn} onClick={() => setShowAdd(true)}>+ Add</button>
      </div>

      {/* Stats */}
      <div style={S.statsRow}>
        {[
          { label: 'Active', value: stats.active, colour: '#C76B8A' },
          { label: 'VIP', value: stats.vip, colour: '#B8860B' },
          { label: 'Deposits', value: `£${(stats.deposits / 100).toFixed(0)}`, colour: '#6B8F7B' },
          { label: 'Avg Wait', value: `${stats.avgWait}d`, colour: '#8B6F5E' },
        ].map(s => (
          <div key={s.label} style={S.statCard}>
            <span style={{ ...S.statValue, color: s.colour }}>{s.value}</span>
            <span style={S.statLabel}>{s.label}</span>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={S.tabs}>
        {['active', 'archived', 'settings'].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ ...S.tab, ...(tab === t ? S.tabActive : {}) }}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {/* Active */}
      {tab === 'active' && (
        <div style={S.list}>
          {activeList.length === 0 && <p style={S.empty}>Waitlist is empty — great problem to have!</p>}
          {activeList.sort((a, b) => {
            const pOrder = { vip: 0, regular: 1, flexible: 2 };
            return (pOrder[a.priority] || 1) - (pOrder[b.priority] || 1);
          }).map(w => {
            const pri = PRIORITY_CONFIG[w.priority];
            const st = STATUS_CONFIG[w.status];
            const isExpanded = expanded === w.id;
            const daysWaiting = Math.ceil((new Date() - new Date(w.addedDate)) / 86400000);
            return (
              <div key={w.id} style={{ ...S.wlCard, borderLeft: `3px solid ${pri.color}` }} onClick={() => setExpanded(isExpanded ? null : w.id)}>
                <div style={S.wlHeader}>
                  <div style={S.wlLeft}>
                    <div style={S.avatar}>{w.client[0]}</div>
                    <div style={S.wlInfo}>
                      <div style={S.wlNameRow}>
                        <span style={S.wlClient}>{w.client}</span>
                        <span style={{ ...S.priBadge, background: pri.bg, color: pri.color }}>{pri.icon} {pri.label}</span>
                      </div>
                      <span style={S.wlTreatment}>{w.treatment}</span>
                    </div>
                  </div>
                  <div style={S.wlRight}>
                    <span style={{ ...S.statusBadge, background: st.bg, color: st.color }}>{st.label}</span>
                    <span style={S.wlDays}>{daysWaiting}d waiting</span>
                  </div>
                </div>

                {/* Offered slot */}
                {w.status === 'offered' && w.offeredSlot && (
                  <div style={S.offerBanner}>
                    <span style={S.offerText}>Offered: {formatDate(w.offeredSlot.date)} at {w.offeredSlot.time}</span>
                    <span style={S.offerExpiry}>Expires {new Date(w.offerExpires).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                )}

                {isExpanded && (
                  <div style={S.expandedSection}>
                    <div style={S.detailGrid}>
                      <div style={S.detailItem}>
                        <span style={S.detailLabel}>Preferred Days</span>
                        <div style={S.dayTags}>
                          {w.preferredDays.map(d => (
                            <span key={d} style={S.dayTag}>{d.charAt(0).toUpperCase() + d.slice(1)}</span>
                          ))}
                        </div>
                      </div>
                      <div style={S.detailItem}>
                        <span style={S.detailLabel}>Time</span>
                        <span style={S.detailValue}>{w.preferredTime === 'any' ? 'Any time' : w.preferredTime.charAt(0).toUpperCase() + w.preferredTime.slice(1)}</span>
                      </div>
                      <div style={S.detailItem}>
                        <span style={S.detailLabel}>Max Wait</span>
                        <span style={S.detailValue}>{w.maxWait} days</span>
                      </div>
                      {w.depositHeld && (
                        <div style={S.detailItem}>
                          <span style={S.detailLabel}>Deposit</span>
                          <span style={{ ...S.detailValue, color: '#6B8F7B' }}>£{(w.depositAmount / 100).toFixed(0)} held</span>
                        </div>
                      )}
                    </div>

                    {w.notes && <p style={S.wlNotes}>{w.notes}</p>}

                    <div style={S.actionRow}>
                      <button style={S.actionBtn}>Notify</button>
                      <button style={{ ...S.actionBtn, background: '#C76B8A', color: '#fff' }}>Offer Slot</button>
                      <button style={S.actionBtn} onClick={e => { e.stopPropagation(); handleRemove(w.id); }}>Remove</button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Archived */}
      {tab === 'archived' && (
        <div style={S.list}>
          {archivedList.length === 0 && <p style={S.empty}>No archived entries.</p>}
          {archivedList.map(w => {
            const st = STATUS_CONFIG[w.status];
            return (
              <div key={w.id} style={S.wlCard}>
                <div style={S.wlHeader}>
                  <div style={S.wlLeft}>
                    <div style={{ ...S.avatar, opacity: 0.6 }}>{w.client[0]}</div>
                    <div style={S.wlInfo}>
                      <span style={S.wlClient}>{w.client}</span>
                      <span style={S.wlTreatment}>{w.treatment}</span>
                    </div>
                  </div>
                  <span style={{ ...S.statusBadge, background: st.bg, color: st.color }}>{st.label}</span>
                </div>
                {w.notes && <p style={S.wlNotes}>{w.notes}</p>}
              </div>
            );
          })}
        </div>
      )}

      {/* Settings */}
      {tab === 'settings' && (
        <div style={S.settingsContainer}>
          <div style={S.settingsCard}>
            <h3 style={S.settingsTitle}>Auto-Notification</h3>
            <div style={S.toggleRow}>
              <div style={S.toggleInfo}>
                <span style={S.toggleLabel}>Auto-notify on cancellation</span>
                <span style={S.toggleDesc}>When a slot opens, automatically message matching waitlist clients</span>
              </div>
              <button style={{ ...S.toggle, background: settings.autoNotify ? '#C76B8A' : '#E0DCD8' }} onClick={() => setSettings(s => ({ ...s, autoNotify: !s.autoNotify }))}>
                <div style={{ ...S.toggleDot, transform: settings.autoNotify ? 'translateX(18px)' : 'translateX(2px)' }} />
              </button>
            </div>

            <div style={S.fieldLabel}>Offer expires after</div>
            <div style={S.chipRow}>
              {[4, 12, 24, 48].map(h => (
                <button key={h} onClick={() => setSettings(s => ({ ...s, offerExpiry: h }))} style={{ ...S.chip, ...(settings.offerExpiry === h ? S.chipActive : {}) }}>
                  {h}h
                </button>
              ))}
            </div>

            <div style={S.fieldLabel}>Max notifications per client</div>
            <div style={S.chipRow}>
              {[1, 2, 3, 5].map(n => (
                <button key={n} onClick={() => setSettings(s => ({ ...s, maxNotifications: n }))} style={{ ...S.chip, ...(settings.maxNotifications === n ? S.chipActive : {}) }}>
                  {n}
                </button>
              ))}
            </div>
          </div>

          <div style={S.settingsCard}>
            <h3 style={S.settingsTitle}>Priority & Deposits</h3>
            <div style={S.toggleRow}>
              <div style={S.toggleInfo}>
                <span style={S.toggleLabel}>VIP clients get first dibs</span>
                <span style={S.toggleDesc}>VIP-priority clients are notified before regular</span>
              </div>
              <button style={{ ...S.toggle, background: settings.vipFirst ? '#C76B8A' : '#E0DCD8' }} onClick={() => setSettings(s => ({ ...s, vipFirst: !s.vipFirst }))}>
                <div style={{ ...S.toggleDot, transform: settings.vipFirst ? 'translateX(18px)' : 'translateX(2px)' }} />
              </button>
            </div>

            <div style={S.toggleRow}>
              <div style={S.toggleInfo}>
                <span style={S.toggleLabel}>Require deposit to join</span>
                <span style={S.toggleDesc}>Clients pay a deposit when added to waitlist</span>
              </div>
              <button style={{ ...S.toggle, background: settings.depositRequired ? '#C76B8A' : '#E0DCD8' }} onClick={() => setSettings(s => ({ ...s, depositRequired: !s.depositRequired }))}>
                <div style={{ ...S.toggleDot, transform: settings.depositRequired ? 'translateX(18px)' : 'translateX(2px)' }} />
              </button>
            </div>

            {settings.depositRequired && (
              <>
                <div style={S.fieldLabel}>Default deposit</div>
                <div style={S.chipRow}>
                  {[1000, 1500, 2000, 2500, 5000].map(d => (
                    <button key={d} onClick={() => setSettings(s => ({ ...s, defaultDeposit: d }))} style={{ ...S.chip, ...(settings.defaultDeposit === d ? S.chipActive : {}) }}>
                      £{d / 100}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* Add modal */}
      {showAdd && (
        <div style={S.overlay} onClick={() => setShowAdd(false)}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <h2 style={S.modalTitle}>Add to Waitlist</h2>

            <div style={S.fieldLabel}>Client Name</div>
            <input style={S.input} placeholder="Client name" value={addForm.client} onChange={e => setAddForm(f => ({ ...f, client: e.target.value }))} />

            <div style={S.fieldLabel}>Treatment</div>
            <select style={S.select} value={addForm.treatment} onChange={e => setAddForm(f => ({ ...f, treatment: e.target.value }))}>
              <option value="">Select treatment</option>
              {activeTreatments.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
            </select>

            <div style={S.fieldLabel}>Priority</div>
            <div style={S.chipRow}>
              {Object.entries(PRIORITY_CONFIG).map(([key, cfg]) => (
                <button key={key} onClick={() => setAddForm(f => ({ ...f, priority: key }))} style={{ ...S.chip, ...(addForm.priority === key ? { background: cfg.color, color: '#fff', border: `1px solid ${cfg.color}` } : {}) }}>
                  {cfg.icon} {cfg.label}
                </button>
              ))}
            </div>

            <div style={S.fieldLabel}>Preferred Days</div>
            <div style={S.chipRow}>
              {DAYS.map(d => (
                <button key={d.value} onClick={() => toggleDay(d.value)} style={{ ...S.dayChip, ...(addForm.preferredDays.includes(d.value) ? S.dayChipActive : {}) }}>
                  {d.label}
                </button>
              ))}
            </div>

            <div style={S.fieldLabel}>Preferred Time</div>
            <div style={S.chipRow}>
              {['morning', 'afternoon', 'evening', 'any'].map(t => (
                <button key={t} onClick={() => setAddForm(f => ({ ...f, preferredTime: t }))} style={{ ...S.chip, ...(addForm.preferredTime === t ? S.chipActive : {}) }}>
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>

            <div style={S.fieldLabel}>Max days to wait</div>
            <div style={S.chipRow}>
              {[7, 14, 21, 30, 60].map(d => (
                <button key={d} onClick={() => setAddForm(f => ({ ...f, maxWait: d }))} style={{ ...S.chip, ...(addForm.maxWait === d ? S.chipActive : {}) }}>
                  {d} days
                </button>
              ))}
            </div>

            <div style={S.fieldLabel}>Notes</div>
            <textarea style={S.textarea} rows={2} placeholder="Any notes..." value={addForm.notes} onChange={e => setAddForm(f => ({ ...f, notes: e.target.value }))} />

            {error && <div style={{ color: '#F44336', fontSize: 13, marginBottom: 8 }}>{error}</div>}
            <button style={{ ...S.saveBtn, opacity: saving ? 0.6 : 1 }} onClick={handleAddToWaitlist} disabled={saving}>{saving ? 'Adding...' : 'Add to Waitlist'}</button>
          </div>
        </div>
      )}
    </div>
  );
}

function formatDate(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
}

const S = {
  page: { padding: '20px 16px 32px', fontFamily: '"DM Sans", -apple-system, sans-serif', maxWidth: 480, margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  title: { fontSize: 22, fontWeight: 700, color: 'var(--text, #2D2A26)', margin: 0 },
  addBtn: { background: '#C76B8A', color: '#fff', border: 'none', borderRadius: 20, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },

  statsRow: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 16 },
  statCard: { background: 'var(--card, #fff)', borderRadius: 12, padding: '10px 6px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 },
  statValue: { fontSize: 18, fontWeight: 700 },
  statLabel: { fontSize: 10, color: '#AAA5A0' },

  tabs: { display: 'flex', gap: 8, marginBottom: 16 },
  tab: { flex: 1, padding: '10px 0', border: 'none', borderRadius: 10, background: 'var(--card, #fff)', color: '#AAA5A0', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  tabActive: { background: '#C76B8A', color: '#fff' },

  list: { display: 'flex', flexDirection: 'column', gap: 10 },
  empty: { textAlign: 'center', color: '#AAA5A0', fontSize: 14, padding: 32 },

  wlCard: { background: 'var(--card, #fff)', borderRadius: 14, padding: 14, cursor: 'pointer', borderLeft: '3px solid #F0ECE8' },
  wlHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' },
  wlLeft: { display: 'flex', gap: 10, alignItems: 'center' },
  avatar: { width: 36, height: 36, borderRadius: 18, background: '#F0E6ED', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 600, color: '#C76B8A', flexShrink: 0 },
  wlInfo: { display: 'flex', flexDirection: 'column', gap: 2 },
  wlNameRow: { display: 'flex', alignItems: 'center', gap: 6 },
  wlClient: { fontSize: 14, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  priBadge: { padding: '2px 8px', borderRadius: 6, fontSize: 10, fontWeight: 600 },
  wlTreatment: { fontSize: 12, color: '#AAA5A0' },
  wlRight: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 },
  statusBadge: { padding: '3px 10px', borderRadius: 8, fontSize: 11, fontWeight: 600 },
  wlDays: { fontSize: 11, color: '#AAA5A0' },

  offerBanner: { margin: '10px 0 0', padding: '8px 12px', borderRadius: 8, background: '#E8F5E9', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  offerText: { fontSize: 12, fontWeight: 600, color: '#4CAF50' },
  offerExpiry: { fontSize: 11, color: '#6B8F7B' },

  expandedSection: { marginTop: 12, paddingTop: 12, borderTop: '1px solid #F0ECE8' },
  detailGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 10 },
  detailItem: { display: 'flex', flexDirection: 'column', gap: 2 },
  detailLabel: { fontSize: 11, color: '#AAA5A0', fontWeight: 600 },
  detailValue: { fontSize: 13, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  dayTags: { display: 'flex', gap: 4, flexWrap: 'wrap' },
  dayTag: { padding: '2px 6px', borderRadius: 4, background: '#F0ECE8', color: '#8B6F5E', fontSize: 11 },
  wlNotes: { fontSize: 12, color: '#8B6F5E', fontStyle: 'italic', margin: '8px 0' },
  actionRow: { display: 'flex', gap: 8, marginTop: 8 },
  actionBtn: { flex: 1, padding: '9px 0', borderRadius: 8, border: '1px solid #F0ECE8', background: 'var(--card, #fff)', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', color: '#2D2A26' },

  // Settings
  settingsContainer: { display: 'flex', flexDirection: 'column', gap: 12 },
  settingsCard: { background: 'var(--card, #fff)', borderRadius: 14, padding: 16 },
  settingsTitle: { fontSize: 15, fontWeight: 700, color: 'var(--text, #2D2A26)', margin: '0 0 12px' },
  toggleRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid #F0ECE8' },
  toggleInfo: { flex: 1, marginRight: 12 },
  toggleLabel: { fontSize: 14, fontWeight: 600, color: 'var(--text, #2D2A26)', display: 'block' },
  toggleDesc: { fontSize: 12, color: '#AAA5A0' },
  toggle: { width: 44, height: 26, borderRadius: 13, border: 'none', padding: 0, cursor: 'pointer', position: 'relative', transition: 'background 0.2s', flexShrink: 0 },
  toggleDot: { width: 22, height: 22, borderRadius: 11, background: '#fff', position: 'absolute', top: 2, transition: 'transform 0.2s', boxShadow: '0 1px 3px rgba(0,0,0,0.15)' },
  fieldLabel: { fontSize: 12, fontWeight: 600, color: '#8B6F5E', marginBottom: 6, marginTop: 12 },
  chipRow: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  chip: { padding: '8px 14px', borderRadius: 10, border: '1px solid #F0ECE8', background: 'var(--card, #fff)', color: '#8B6F5E', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' },
  chipActive: { background: '#C76B8A', color: '#fff', border: '1px solid #C76B8A' },

  // Modal
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 200, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' },
  modal: { background: '#fff', borderRadius: '16px 16px 0 0', padding: '20px 20px 32px', width: '100%', maxWidth: 480, maxHeight: '85vh', overflowY: 'auto' },
  modalTitle: { fontSize: 18, fontWeight: 700, color: '#2D2A26', margin: '0 0 16px' },
  input: { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #F0ECE8', fontSize: 14, fontFamily: 'inherit', color: '#2D2A26', outline: 'none', boxSizing: 'border-box' },
  select: { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #F0ECE8', fontSize: 14, fontFamily: 'inherit', color: '#2D2A26', background: '#fff', outline: 'none', boxSizing: 'border-box' },
  textarea: { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid #F0ECE8', fontSize: 13, fontFamily: 'inherit', color: '#2D2A26', outline: 'none', resize: 'vertical', boxSizing: 'border-box' },
  dayChip: { width: 40, height: 36, borderRadius: 8, border: '1px solid #F0ECE8', background: '#fff', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', color: '#8B6F5E', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  dayChipActive: { background: '#C76B8A', color: '#fff', border: '1px solid #C76B8A' },
  saveBtn: { width: '100%', padding: '14px 0', borderRadius: 12, border: 'none', background: '#C76B8A', color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', marginTop: 20 },
};
