/**
 * WaitlistPro - the salon waitlist for treatment slots.
 *
 * Reads and writes the canonical `waitlist` table through the authed backend
 * (/api/features/waitlist), so every row is a real client_id + treatment_id
 * pair the gap-fill engine and reschedule notifier already understand. The page
 * adds the soft layer on top: priority tiers, preferred days/times, a deposit
 * flag and a one-tap "a slot opened" nudge.
 */
import { useState, useEffect, useCallback } from 'react';
import { useBeautician, fetchRows, supabase } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';
import Icon, { iconName } from '../components/ui/Icon';

const PRIORITY_CONFIG = {
  vip: { label: 'VIP', bg: '#F0E6ED', color: 'var(--accent, #92405e)', icon: 'star' },
  regular: { label: 'Regular', bg: '#F0ECE8', color: '#8B6F5E', icon: 'person' },
  flexible: { label: 'Flexible', bg: '#E8F5E9', color: '#6B8F7B', icon: 'autorenew' },
};
const STATUS_CONFIG = {
  waiting: { label: 'Waiting', bg: '#FFF5E6', color: '#B8860B' },
  active: { label: 'Waiting', bg: '#FFF5E6', color: '#B8860B' },
  notified: { label: 'Notified', bg: '#E3F2FD', color: '#2196F3' },
  offered: { label: 'Slot offered', bg: '#E8F5E9', color: '#4CAF50' },
  booked: { label: 'Booked', bg: '#E8F5E9', color: '#4CAF50' },
  expired: { label: 'Expired', bg: '#F0ECE8', color: 'var(--text-muted, #6B5D54)' },
};
const ACTIVE_STATUSES = ['waiting', 'active', 'notified', 'offered'];
const DAYS = [
  { value: 'mon', label: 'Mon' }, { value: 'tue', label: 'Tue' }, { value: 'wed', label: 'Wed' },
  { value: 'thu', label: 'Thu' }, { value: 'fri', label: 'Fri' }, { value: 'sat', label: 'Sat' },
];

const EMPTY_FORM = {
  client_id: '', treatment_id: '', priority: 'regular',
  preferred_days: [], preferred_time: 'any',
  deposit_held: false, deposit_amount: '',
  notes: '', max_wait_days: 14,
};

async function authedFetch(path, opts = {}) {
  const token = (await supabase?.auth.getSession())?.data?.session?.access_token;
  if (!token) throw new Error('Not signed in');
  const res = await fetch(`${API_BASE}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
      ...(opts.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `Request failed (${res.status})`);
  }
  return res.json();
}

export default function WaitlistPro() {
  const { beautician, loading: bLoading } = useBeautician();
  const [tab, setTab] = useState('active');
  const [expanded, setExpanded] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState(null);
  const [error, setError] = useState(null);
  const [waitlist, setWaitlist] = useState([]);
  const [treatments, setTreatments] = useState([]);
  const [clients, setClients] = useState([]);
  const [addForm, setAddForm] = useState(EMPTY_FORM);

  const load = useCallback(async () => {
    if (!beautician) return;
    setLoading(true);
    setError(null);
    try {
      const [wlRes, tx, cl] = await Promise.all([
        authedFetch('/api/features/waitlist'),
        fetchRows('treatments', beautician.id, { eq: { is_active: true }, order: 'sort_order' }),
        fetchRows('clients', beautician.id, { order: 'first_name' }),
      ]);
      setWaitlist(wlRes.waitlist || []);
      setTreatments(tx || []);
      setClients(cl || []);
    } catch (err) {
      logger.error('Load waitlist error:', err);
      setError('Could not load the waitlist. Pull to refresh or try again.');
      setWaitlist([]);
    } finally {
      setLoading(false);
    }
  }, [beautician]);

  useEffect(() => {
    if (bLoading) return;
    if (!beautician) { setLoading(false); return; }
    load();
  }, [beautician, bLoading, load]);

  function clientName(w) {
    const c = w.clients || {};
    return [c.first_name, c.last_name].filter(Boolean).join(' ') || 'Client';
  }
  function treatmentName(w) {
    return w.treatments?.name || 'Treatment';
  }

  async function handleAddToWaitlist() {
    if (!addForm.client_id || !addForm.treatment_id) {
      setError('Pick a client and a treatment first.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const { waitlistEntry } = await authedFetch('/api/features/waitlist', {
        method: 'POST',
        body: JSON.stringify({
          client_id: addForm.client_id,
          treatment_id: addForm.treatment_id,
          priority: addForm.priority,
          preferred_days: addForm.preferred_days,
          preferred_time: addForm.preferred_time,
          notes: addForm.notes.trim() || null,
          max_wait_days: addForm.max_wait_days,
          deposit_held: addForm.deposit_held,
          deposit_amount_cents: addForm.deposit_amount
            ? Math.round(parseFloat(addForm.deposit_amount) * 100)
            : 0,
        }),
      });
      setWaitlist(prev => [waitlistEntry, ...prev]);
      setShowAdd(false);
      setAddForm(EMPTY_FORM);
    } catch (err) {
      logger.error('Add to waitlist error:', err);
      setError(err.message || 'Failed to add to waitlist');
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove(id) {
    setBusyId(id);
    setError(null);
    try {
      await authedFetch(`/api/features/waitlist/${id}`, { method: 'DELETE' });
      setWaitlist(prev => prev.filter(w => w.id !== id));
    } catch (err) {
      logger.error('Remove waitlist error:', err);
      setError(err.message || 'Failed to remove from waitlist');
    } finally {
      setBusyId(null);
    }
  }

  async function handleNotify(id) {
    setBusyId(id);
    setError(null);
    try {
      const { waitlistEntry } = await authedFetch(`/api/features/waitlist/${id}/notify`, { method: 'POST' });
      setWaitlist(prev => prev.map(w => (w.id === id ? waitlistEntry : w)));
    } catch (err) {
      logger.error('Notify error:', err);
      setError(err.message || 'Failed to notify client');
    } finally {
      setBusyId(null);
    }
  }

  async function handleOfferSlot(id) {
    setBusyId(id);
    setError(null);
    try {
      const expires = new Date();
      expires.setHours(expires.getHours() + 24);
      const { waitlistEntry } = await authedFetch(`/api/features/waitlist/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'offered', offer_expires_at: expires.toISOString() }),
      });
      setWaitlist(prev => prev.map(w => (w.id === id ? waitlistEntry : w)));
    } catch (err) {
      logger.error('Offer slot error:', err);
      setError(err.message || 'Failed to offer slot');
    } finally {
      setBusyId(null);
    }
  }

  const activeList = waitlist.filter(w => ACTIVE_STATUSES.includes(w.status));
  const archivedList = waitlist.filter(w => ['booked', 'expired'].includes(w.status));
  const stats = {
    active: activeList.length,
    vip: waitlist.filter(w => w.priority === 'vip' && w.status !== 'expired').length,
    deposits: waitlist.filter(w => w.deposit_held).reduce((s, w) => s + (w.deposit_amount_cents || 0), 0),
    avgWait: Math.round(activeList.reduce((s, w) => s + daysWaiting(w), 0) / (activeList.length || 1)),
  };

  const toggleDay = (day) => {
    setAddForm(f => ({
      ...f,
      preferred_days: f.preferred_days.includes(day)
        ? f.preferred_days.filter(d => d !== day)
        : [...f.preferred_days, day],
    }));
  };

  if (bLoading || loading) {
    return <div style={S.page}><PageLoader message="Loading waitlist..." /></div>;
  }

  return (
    <div style={S.page}>
      <div style={S.header}>
        <h1 style={S.title}>Smart waitlist</h1>
        <button style={S.addBtn} onClick={() => { setError(null); setShowAdd(true); }}>+ Add</button>
      </div>

      {error && <ErrorCard message={error} onDismiss={() => setError(null)} />}

      <div style={S.statsRow}>
        {[
          { label: 'Active', value: stats.active, colour: 'var(--accent, #92405e)' },
          { label: 'VIP', value: stats.vip, colour: '#B8860B' },
          { label: 'Deposits', value: `£${(stats.deposits / 100).toFixed(0)}`, colour: '#6B8F7B' },
          { label: 'Avg wait', value: `${stats.avgWait}d`, colour: '#8B6F5E' },
        ].map(s => (
          <div key={s.label} style={S.statCard}>
            <span style={{ ...S.statValue, color: s.colour }}>{s.value}</span>
            <span style={S.statLabel}>{s.label}</span>
          </div>
        ))}
      </div>

      <div style={S.tabs}>
        {['active', 'archived'].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ ...S.tab, ...(tab === t ? S.tabActive : {}) }}>
            {t.charAt(0).toUpperCase() + t.slice(1)}
          </button>
        ))}
      </div>

      {tab === 'active' && (
        <div style={S.list}>
          {activeList.length === 0 && (
            <EmptyState
              icon="⏳"
              title="No one waiting yet"
              subtitle="Add a client who wants a slot and Florrie will nudge them the moment one frees up."
              actionLabel="Add to waitlist"
              onAction={() => setShowAdd(true)}
            />
          )}
          {[...activeList].sort((a, b) => {
            const pOrder = { vip: 0, regular: 1, flexible: 2 };
            return (pOrder[a.priority] ?? 1) - (pOrder[b.priority] ?? 1);
          }).map(w => {
            const pri = PRIORITY_CONFIG[w.priority] || PRIORITY_CONFIG.regular;
            const st = STATUS_CONFIG[w.status] || STATUS_CONFIG.waiting;
            const isExpanded = expanded === w.id;
            const isBusy = busyId === w.id;
            const name = clientName(w);
            return (
              <div key={w.id} style={{ ...S.wlCard, borderLeft: `3px solid ${pri.color}` }} onClick={() => setExpanded(isExpanded ? null : w.id)}>
                <div style={S.wlHeader}>
                  <div style={S.wlLeft}>
                    <div style={S.avatar}>{name.charAt(0)}</div>
                    <div style={S.wlInfo}>
                      <div style={S.wlNameRow}>
                        <span style={S.wlClient}>{name}</span>
                        <span style={{ ...S.priBadge, background: pri.bg, color: pri.color }}>
                          <Icon name={iconName(pri.icon)} inline style={S.priIcon} />
                          {pri.label}
                        </span>
                      </div>
                      <span style={S.wlTreatment}>{treatmentName(w)}</span>
                    </div>
                  </div>
                  <div style={S.wlRight}>
                    <span style={{ ...S.statusBadge, background: st.bg, color: st.color }}>{st.label}</span>
                    <span style={S.wlDays}>{daysWaiting(w)}d waiting</span>
                  </div>
                </div>

                {w.status === 'offered' && w.offer_expires_at && (
                  <div style={S.offerBanner}>
                    <span style={S.offerText}>Slot offered</span>
                    <span style={S.offerExpiry}>Expires {formatDateTime(w.offer_expires_at)}</span>
                  </div>
                )}

                {isExpanded && (
                  <div style={S.expandedSection}>
                    <div style={S.detailGrid}>
                      <div style={S.detailItem}>
                        <span style={S.detailLabel}>Preferred days</span>
                        <div style={S.dayTags}>
                          {(w.preferred_days || []).length === 0
                            ? <span style={S.detailValue}>Any</span>
                            : w.preferred_days.map(d => (
                                <span key={d} style={S.dayTag}>{d.charAt(0).toUpperCase() + d.slice(1)}</span>
                              ))}
                        </div>
                      </div>
                      <div style={S.detailItem}>
                        <span style={S.detailLabel}>Time</span>
                        <span style={S.detailValue}>{!w.preferred_time || w.preferred_time === 'any' ? 'Any time' : w.preferred_time.charAt(0).toUpperCase() + w.preferred_time.slice(1)}</span>
                      </div>
                      <div style={S.detailItem}>
                        <span style={S.detailLabel}>Max wait</span>
                        <span style={S.detailValue}>{w.max_wait_days || 14} days</span>
                      </div>
                      {w.deposit_held && (
                        <div style={S.detailItem}>
                          <span style={S.detailLabel}>Deposit</span>
                          <span style={{ ...S.detailValue, color: '#6B8F7B' }}>£{((w.deposit_amount_cents || 0) / 100).toFixed(0)} held</span>
                        </div>
                      )}
                    </div>
                    {w.notes && <p style={S.wlNotes}>{w.notes}</p>}
                    <div style={S.actionRow}>
                      <button style={S.actionBtn} disabled={isBusy} onClick={e => { e.stopPropagation(); handleNotify(w.id); }}>
                        {isBusy ? '...' : 'Notify'}
                      </button>
                      <button style={{ ...S.actionBtn, background: 'var(--accent, #92405e)', color: 'var(--bg-card, #FFFCF9)' }} disabled={isBusy} onClick={e => { e.stopPropagation(); handleOfferSlot(w.id); }}>
                        Offer slot
                      </button>
                      <button style={S.actionBtn} disabled={isBusy} onClick={e => { e.stopPropagation(); handleRemove(w.id); }}>
                        Remove
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {tab === 'archived' && (
        <div style={S.list}>
          {archivedList.length === 0 && (
            <EmptyState icon="box" title="Nothing archived" subtitle="Booked and expired waitlist entries land here." />
          )}
          {archivedList.map(w => {
            const st = STATUS_CONFIG[w.status] || STATUS_CONFIG.expired;
            const name = clientName(w);
            return (
              <div key={w.id} style={S.wlCard}>
                <div style={S.wlHeader}>
                  <div style={S.wlLeft}>
                    <div style={{ ...S.avatar, opacity: 0.6 }}>{name.charAt(0)}</div>
                    <div style={S.wlInfo}>
                      <span style={S.wlClient}>{name}</span>
                      <span style={S.wlTreatment}>{treatmentName(w)}</span>
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

      {showAdd && (
        <div style={S.overlay} onClick={() => setShowAdd(false)}>
          <div style={S.modal} onClick={e => e.stopPropagation()}>
            <h2 style={S.modalTitle}>Add to waitlist</h2>

            <div style={S.fieldLabel}>Client</div>
            <select style={S.select} value={addForm.client_id} onChange={e => setAddForm(f => ({ ...f, client_id: e.target.value }))}>
              <option value="">Select client</option>
              {clients.map(c => (
                <option key={c.id} value={c.id}>{[c.first_name, c.last_name].filter(Boolean).join(' ')}</option>
              ))}
            </select>
            {clients.length === 0 && <p style={S.hint}>No clients yet. Add a client first, then waitlist them.</p>}

            <div style={S.fieldLabel}>Treatment</div>
            <select style={S.select} value={addForm.treatment_id} onChange={e => setAddForm(f => ({ ...f, treatment_id: e.target.value }))}>
              <option value="">Select treatment</option>
              {treatments.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
            </select>

            <div style={S.fieldLabel}>Priority</div>
            <div style={S.chipRow}>
              {Object.entries(PRIORITY_CONFIG).map(([key, cfg]) => (
                <button key={key} onClick={() => setAddForm(f => ({ ...f, priority: key }))} style={{ ...S.chip, ...(addForm.priority === key ? { background: cfg.color, color: 'var(--bg-card, #FFFCF9)', border: `1px solid ${cfg.color}` } : {}) }}>
                  {cfg.label}
                </button>
              ))}
            </div>

            <div style={S.fieldLabel}>Preferred days</div>
            <div style={S.chipRow}>
              {DAYS.map(d => (
                <button key={d.value} onClick={() => toggleDay(d.value)} style={{ ...S.dayChip, ...(addForm.preferred_days.includes(d.value) ? S.dayChipActive : {}) }}>
                  {d.label}
                </button>
              ))}
            </div>

            <div style={S.fieldLabel}>Preferred time</div>
            <div style={S.chipRow}>
              {['morning', 'afternoon', 'evening', 'any'].map(t => (
                <button key={t} onClick={() => setAddForm(f => ({ ...f, preferred_time: t }))} style={{ ...S.chip, ...(addForm.preferred_time === t ? S.chipActive : {}) }}>
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>

            <div style={S.fieldLabel}>Max days to wait</div>
            <div style={S.chipRow}>
              {[7, 14, 21, 30, 60].map(d => (
                <button key={d} onClick={() => setAddForm(f => ({ ...f, max_wait_days: d }))} style={{ ...S.chip, ...(addForm.max_wait_days === d ? S.chipActive : {}) }}>
                  {d} days
                </button>
              ))}
            </div>

            <div style={S.fieldLabel}>Notes</div>
            <textarea style={S.textarea} rows={2} placeholder="Any notes..." value={addForm.notes} onChange={e => setAddForm(f => ({ ...f, notes: e.target.value }))} />

            {error && <div style={{ color: 'var(--danger, #9E2B32)', fontSize: 13, marginBottom: 8 }}>{error}</div>}
            <button style={{ ...S.saveBtn, opacity: saving ? 0.6 : 1 }} onClick={handleAddToWaitlist} disabled={saving}>
              {saving ? 'Adding...' : 'Add to waitlist'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function daysWaiting(w) {
  const added = w.created_at ? new Date(w.created_at) : null;
  if (!added || isNaN(added)) return 0;
  return Math.max(0, Math.ceil((new Date() - added) / 86400000));
}

function formatDateTime(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

const S = {
  page: { padding: '20px 16px 32px', fontFamily: "var(--font-body, 'Plus Jakarta Sans', sans-serif)", maxWidth: 480, margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 },
  title: { fontSize: 22, fontWeight: 700, color: 'var(--text-primary, #241B17)', margin: 0, fontFamily: "var(--font-heading, 'Playfair Display', serif)" },
  addBtn: { background: 'var(--accent, #92405e)', color: 'var(--bg-card, #FFFCF9)', border: 'none', borderRadius: 20, padding: '8px 16px', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  statsRow: { display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 16 },
  statCard: { background: 'var(--card, #FFFCF9)', borderRadius: 12, padding: '10px 6px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 },
  statValue: { fontSize: 18, fontWeight: 700 },
  statLabel: { fontSize: 10, color: 'var(--text-muted, #6B5D54)' },
  tabs: { display: 'flex', gap: 8, marginBottom: 16 },
  tab: { flex: 1, padding: '10px 0', border: 'none', borderRadius: 10, background: 'var(--bg-card, #FFFCF9)', color: 'var(--text-muted, #6B5D54)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  tabActive: { background: 'var(--accent, #92405e)', color: 'var(--bg-card, #FFFCF9)' },
  list: { display: 'flex', flexDirection: 'column', gap: 10 },
  wlCard: { background: 'var(--bg-card, #FFFCF9)', borderRadius: 14, padding: 14, cursor: 'pointer', borderLeft: '3px solid var(--border, #E8DDD4)' },
  wlHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' },
  wlLeft: { display: 'flex', gap: 10, alignItems: 'center' },
  avatar: { width: 36, height: 36, borderRadius: 18, background: '#F0E6ED', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 15, fontWeight: 600, color: 'var(--accent, #92405e)', flexShrink: 0 },
  wlInfo: { display: 'flex', flexDirection: 'column', gap: 2 },
  wlNameRow: { display: 'flex', alignItems: 'center', gap: 6 },
  wlClient: { fontSize: 14, fontWeight: 600, color: 'var(--text-primary, #241B17)' },
  priBadge: { display: 'inline-flex', alignItems: 'center', gap: 3, padding: '2px 8px', borderRadius: 6, fontSize: 10, fontWeight: 600 },
  priIcon: { fontSize: 12 },
  wlTreatment: { fontSize: 12, color: 'var(--text-muted, #6B5D54)' },
  wlRight: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 },
  statusBadge: { padding: '3px 10px', borderRadius: 8, fontSize: 11, fontWeight: 600 },
  wlDays: { fontSize: 11, color: 'var(--text-muted, #6B5D54)' },
  offerBanner: { margin: '10px 0 0', padding: '8px 12px', borderRadius: 8, background: 'var(--success-bg, #E9F0EB)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  offerText: { fontSize: 12, fontWeight: 600, color: 'var(--success, #3F7D5C)' },
  offerExpiry: { fontSize: 11, color: 'var(--success, #3F7D5C)' },
  expandedSection: { marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border, #E8DDD4)' },
  detailGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 10, marginBottom: 10 },
  detailItem: { display: 'flex', flexDirection: 'column', gap: 2 },
  detailLabel: { fontSize: 11, color: 'var(--text-muted, #6B5D54)', fontWeight: 600 },
  detailValue: { fontSize: 13, fontWeight: 600, color: 'var(--text-primary, #241B17)' },
  dayTags: { display: 'flex', gap: 4, flexWrap: 'wrap' },
  dayTag: { padding: '2px 6px', borderRadius: 4, background: 'var(--border, #E8DDD4)', color: 'var(--text-secondary, #574A42)', fontSize: 11 },
  wlNotes: { fontSize: 12, color: 'var(--text-secondary, #574A42)', fontStyle: 'italic', margin: '8px 0' },
  actionRow: { display: 'flex', gap: 8, marginTop: 8 },
  actionBtn: { flex: 1, padding: '9px 0', borderRadius: 8, border: '1px solid var(--border, #E8DDD4)', background: 'var(--bg-card, #FFFCF9)', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-primary, #241B17)' },
  fieldLabel: { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary, #574A42)', marginBottom: 6, marginTop: 12 },
  hint: { fontSize: 12, color: 'var(--text-muted, #6B5D54)', margin: '6px 0 0' },
  chipRow: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  chip: { padding: '8px 14px', borderRadius: 10, border: '1px solid var(--border, #E8DDD4)', background: 'var(--bg-card, #FFFCF9)', color: 'var(--text-secondary, #574A42)', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit' },
  chipActive: { background: 'var(--accent, #92405e)', color: 'var(--bg-card, #FFFCF9)', border: '1px solid var(--accent, #92405e)' },
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 960, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' },
  modal: { background: 'var(--bg-card, #FFFCF9)', borderRadius: '16px 16px 0 0', padding: '20px 20px 32px', width: '100%', maxWidth: 480, maxHeight: '85vh', overflowY: 'auto' },
  modalTitle: { fontSize: 18, fontWeight: 700, color: 'var(--text-primary, #241B17)', margin: '0 0 16px', fontFamily: "var(--font-heading, 'Playfair Display', serif)" },
  select: { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border, #E8DDD4)', fontSize: 14, fontFamily: 'inherit', color: 'var(--text-primary, #241B17)', background: 'var(--bg-card, #FFFCF9)', outline: 'none', boxSizing: 'border-box' },
  textarea: { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--border, #E8DDD4)', fontSize: 13, fontFamily: 'inherit', color: 'var(--text-primary, #241B17)', outline: 'none', resize: 'vertical', boxSizing: 'border-box' },
  dayChip: { width: 40, height: 36, borderRadius: 8, border: '1px solid var(--border, #E8DDD4)', background: 'var(--bg-card, #FFFCF9)', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-secondary, #574A42)', display: 'flex', alignItems: 'center', justifyContent: 'center' },
  dayChipActive: { background: 'var(--accent, #92405e)', color: 'var(--bg-card, #FFFCF9)', border: '1px solid var(--accent, #92405e)' },
  saveBtn: { width: '100%', padding: '14px 0', borderRadius: 12, border: 'none', background: 'var(--accent, #92405e)', color: 'var(--bg-card, #FFFCF9)', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit', marginTop: 20 },
};
