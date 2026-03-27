import { useState, useEffect } from 'react';
import { useBeautician, fetchRows, insertRow, updateRow, deleteRow, isDevMode, DEV_CLIENTS, DEV_TREATMENTS } from '../lib/supabase.js';

/**
 * Waitlist — clients waiting for a cancellation slot.
 *
 * When someone cancels, the Calendar agent checks this list and
 * auto-offers the slot to the highest-priority match. The beautician
 * can also manually add people here.
 *
 * Priority score is AI-calculated based on likelihood to accept.
 */

const DAY_OPTIONS = [
  { key: 'mon', label: 'Mon' }, { key: 'tue', label: 'Tue' },
  { key: 'wed', label: 'Wed' }, { key: 'thu', label: 'Thu' },
  { key: 'fri', label: 'Fri' }, { key: 'sat', label: 'Sat' },
];

const DEV_WAITLIST = [
  {
    id: 'dev-wl1', client_id: 'dev-c1', treatment_id: 'dev-t1',
    preferred_days: ['tue', 'thu'], preferred_time_start: '11:00', preferred_time_end: '15:00',
    status: 'waiting', priority_score: 0.92, created_at: '2026-03-22T10:00:00Z',
    client: { first_name: 'Shauna', last_name: '' },
    treatment: { name: 'Lamination & Hybrid Dye' },
  },
  {
    id: 'dev-wl2', client_id: 'dev-c3', treatment_id: 'dev-t13',
    preferred_days: ['wed', 'fri'], preferred_time_start: '10:00', preferred_time_end: '14:00',
    status: 'waiting', priority_score: 0.74, created_at: '2026-03-23T16:00:00Z',
    client: { first_name: 'Jasmin', last_name: '' },
    treatment: { name: 'Lash Lift & Tint' },
  },
  {
    id: 'dev-wl3', client_id: 'dev-c2', treatment_id: 'dev-t2',
    preferred_days: ['mon', 'tue', 'wed', 'thu', 'fri'], preferred_time_start: null, preferred_time_end: null,
    status: 'offered', priority_score: 0.85, created_at: '2026-03-20T09:00:00Z',
    offered_at: '2026-03-24T11:00:00Z',
    client: { first_name: 'Daisy', last_name: 'S' },
    treatment: { name: 'Lamination & Tint' },
  },
];

export default function Waitlist() {
  const { beautician } = useBeautician();
  const [entries, setEntries] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [clients, setClients] = useState([]);
  const [treatments, setTreatments] = useState([]);

  // Add form state
  const [form, setForm] = useState({
    client_id: '', treatment_id: '', preferred_days: [], time_start: '', time_end: ''
  });

  useEffect(() => { if (beautician) loadAll(); }, [beautician]);

  async function loadAll() {
    setLoading(true);
    if (isDevMode) {
      setEntries(DEV_WAITLIST);
      setClients(DEV_CLIENTS);
      setTreatments(DEV_TREATMENTS);
      setLoading(false);
      return;
    }
    try {
      const [wl, cl, tr] = await Promise.all([
        fetchRows('waitlist', beautician.id, { order: 'priority_score', ascending: false }),
        fetchRows('clients', beautician.id),
        fetchRows('treatments', beautician.id, { eq: { is_active: true } }),
      ]);
      // Enrich waitlist with client/treatment names
      const enriched = wl.map(w => ({
        ...w,
        client: cl.find(c => c.id === w.client_id),
        treatment: tr.find(t => t.id === w.treatment_id),
      }));
      setEntries(enriched);
      setClients(cl);
      setTreatments(tr);
    } catch (err) {
      console.error('Waitlist load error:', err);
    }
    setLoading(false);
  }

  async function handleAdd() {
    if (!form.client_id || !form.treatment_id) return;
    const row = {
      beautician_id: beautician.id,
      client_id: form.client_id,
      treatment_id: form.treatment_id,
      preferred_days: form.preferred_days.length > 0 ? form.preferred_days : ['mon', 'tue', 'wed', 'thu', 'fri'],
      preferred_time_start: form.time_start || null,
      preferred_time_end: form.time_end || null,
      priority_score: 0.50,
    };
    const created = await insertRow('waitlist', row);
    const client = clients.find(c => c.id === form.client_id);
    const treatment = treatments.find(t => t.id === form.treatment_id);
    setEntries(prev => [{ ...created, client, treatment }, ...prev]);
    setForm({ client_id: '', treatment_id: '', preferred_days: [], time_start: '', time_end: '' });
    setShowAdd(false);
  }

  async function handleRemove(id) {
    await deleteRow('waitlist', id);
    setEntries(prev => prev.filter(e => e.id !== id));
  }

  async function handleMarkBooked(id) {
    await updateRow('waitlist', id, { status: 'booked' });
    setEntries(prev => prev.filter(e => e.id !== id));
  }

  function toggleDay(day) {
    setForm(prev => ({
      ...prev,
      preferred_days: prev.preferred_days.includes(day)
        ? prev.preferred_days.filter(d => d !== day)
        : [...prev.preferred_days, day]
    }));
  }

  const waiting = entries.filter(e => e.status === 'waiting');
  const offered = entries.filter(e => e.status === 'offered');

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div>
          <h1 style={styles.title}>Waitlist</h1>
          <p style={styles.subtitle}>{waiting.length} waiting · {offered.length} offered</p>
        </div>
        <button onClick={() => setShowAdd(true)} style={styles.addBtn}>+ Add</button>
      </div>

      {/* How it works */}
      <div style={styles.infoCard}>
        <span style={styles.infoIcon}>🔔</span>
        <span style={styles.infoText}>
          When a slot opens up, the AI automatically contacts the best match from this list based on their preferences and likelihood to accept.
        </span>
      </div>

      {loading ? (
        <div style={styles.loadingWrap}>
          <SkeletonCard /><SkeletonCard />
        </div>
      ) : entries.length === 0 ? (
        <div style={styles.emptyState}>
          <div style={styles.emptyIcon}>📋</div>
          <p style={styles.emptyTitle}>Waitlist is empty</p>
          <p style={styles.emptyDesc}>
            When a client wants a slot that's full, add them here. They'll be first in line when a cancellation opens up.
          </p>
          <button onClick={() => setShowAdd(true)} style={styles.emptyBtn}>Add to waitlist</button>
        </div>
      ) : (
        <>
          {/* Offered section */}
          {offered.length > 0 && (
            <div style={{ marginBottom: 16 }}>
              <span style={styles.sectionLabel}>Offered a slot</span>
              {offered.map(entry => (
                <WaitlistCard
                  key={entry.id}
                  entry={entry}
                  isOffered
                  onBook={() => handleMarkBooked(entry.id)}
                  onRemove={() => handleRemove(entry.id)}
                />
              ))}
            </div>
          )}

          {/* Waiting section */}
          {waiting.length > 0 && (
            <div>
              <span style={styles.sectionLabel}>Waiting</span>
              {waiting.map(entry => (
                <WaitlistCard
                  key={entry.id}
                  entry={entry}
                  onRemove={() => handleRemove(entry.id)}
                />
              ))}
            </div>
          )}
        </>
      )}

      {/* Add modal */}
      {showAdd && (
        <div style={styles.overlay} onClick={() => setShowAdd(false)}>
          <div style={styles.modal} onClick={e => e.stopPropagation()}>
            <div style={styles.modalHeader}>
              <h2 style={styles.modalTitle}>Add to waitlist</h2>
              <button onClick={() => setShowAdd(false)} style={styles.closeBtn}>✕</button>
            </div>

            <div style={styles.formGroup}>
              <label style={styles.label}>Client</label>
              <select
                value={form.client_id}
                onChange={e => setForm({ ...form, client_id: e.target.value })}
                style={styles.select}
              >
                <option value="">Select client...</option>
                {clients.map(c => (
                  <option key={c.id} value={c.id}>{c.first_name} {c.last_name || ''}</option>
                ))}
              </select>
            </div>

            <div style={styles.formGroup}>
              <label style={styles.label}>Treatment</label>
              <select
                value={form.treatment_id}
                onChange={e => setForm({ ...form, treatment_id: e.target.value })}
                style={styles.select}
              >
                <option value="">Select treatment...</option>
                {treatments.map(t => (
                  <option key={t.id} value={t.id}>{t.name} — £{(t.price_cents / 100).toFixed(0)}</option>
                ))}
              </select>
            </div>

            <div style={styles.formGroup}>
              <label style={styles.label}>Preferred days</label>
              <div style={styles.dayGrid}>
                {DAY_OPTIONS.map(d => (
                  <button
                    key={d.key}
                    onClick={() => toggleDay(d.key)}
                    style={{
                      ...styles.dayChip,
                      background: form.preferred_days.includes(d.key) ? '#C76B8A' : '#F5F2EF',
                      color: form.preferred_days.includes(d.key) ? '#fff' : '#8A8580'
                    }}
                  >
                    {d.label}
                  </button>
                ))}
              </div>
              <span style={styles.hint}>Leave blank for any day</span>
            </div>

            <div style={styles.formGroup}>
              <label style={styles.label}>Preferred time range (optional)</label>
              <div style={styles.timeRow}>
                <input type="time" value={form.time_start} onChange={e => setForm({ ...form, time_start: e.target.value })} style={styles.timeInput} />
                <span style={styles.timeSep}>to</span>
                <input type="time" value={form.time_end} onChange={e => setForm({ ...form, time_end: e.target.value })} style={styles.timeInput} />
              </div>
            </div>

            <button
              onClick={handleAdd}
              disabled={!form.client_id || !form.treatment_id}
              style={{ ...styles.saveBtn, opacity: form.client_id && form.treatment_id ? 1 : 0.5 }}
            >
              Add to waitlist
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function WaitlistCard({ entry, isOffered, onBook, onRemove }) {
  const priorityColor = entry.priority_score >= 0.8 ? '#4CAF50'
    : entry.priority_score >= 0.6 ? '#F57C00' : '#AAA5A0';
  const priorityLabel = entry.priority_score >= 0.8 ? 'High'
    : entry.priority_score >= 0.6 ? 'Medium' : 'Low';

  const daysLabel = (entry.preferred_days || []).length >= 5
    ? 'Any weekday'
    : (entry.preferred_days || []).map(d => d.charAt(0).toUpperCase() + d.slice(1)).join(', ');

  const timeLabel = entry.preferred_time_start && entry.preferred_time_end
    ? `${entry.preferred_time_start} – ${entry.preferred_time_end}`
    : 'Any time';

  const daysAgo = Math.floor((Date.now() - new Date(entry.created_at).getTime()) / 86400000);

  return (
    <div style={{
      ...styles.card,
      borderLeftColor: isOffered ? '#F57C00' : 'transparent'
    }}>
      <div style={styles.cardTop}>
        <div style={styles.cardInfo}>
          <span style={styles.cardName}>
            {entry.client?.first_name || 'Unknown'} {entry.client?.last_name || ''}
          </span>
          <span style={styles.cardTreatment}>{entry.treatment?.name || 'Treatment'}</span>
        </div>
        <div style={styles.priorityBadge}>
          <div style={{ ...styles.priorityDot, background: priorityColor }} />
          <span style={{ ...styles.priorityText, color: priorityColor }}>{priorityLabel}</span>
        </div>
      </div>

      <div style={styles.cardPrefs}>
        <span style={styles.prefChip}>{daysLabel}</span>
        <span style={styles.prefChip}>{timeLabel}</span>
        <span style={styles.prefChip}>{daysAgo === 0 ? 'Today' : `${daysAgo}d ago`}</span>
      </div>

      {isOffered && (
        <div style={styles.offeredBanner}>
          Slot offered {entry.offered_at ? new Date(entry.offered_at).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : ''} — waiting for response
        </div>
      )}

      <div style={styles.cardActions}>
        {isOffered && (
          <button onClick={onBook} style={styles.bookBtn}>Mark booked</button>
        )}
        <button onClick={onRemove} style={styles.removeBtn}>Remove</button>
      </div>
    </div>
  );
}

function SkeletonCard() {
  return (
    <div style={{ ...styles.card, height: 80, display: 'flex', flexDirection: 'column', gap: 10, justifyContent: 'center' }}>
      <div style={{ height: 14, width: '50%', borderRadius: 7, background: '#F0ECE8' }} />
      <div style={{ height: 12, width: '70%', borderRadius: 6, background: '#F5F2EF' }} />
    </div>
  );
}

const styles = {
  page: { minHeight: '100vh', background: '#FAF8F5', fontFamily: '"DM Sans", -apple-system, sans-serif', padding: '0 16px 40px', maxWidth: 480, margin: '0 auto', color: '#2D2A26' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', paddingTop: 28, paddingBottom: 12 },
  title: { fontSize: 22, fontWeight: 700, margin: 0 },
  subtitle: { fontSize: 13, color: '#AAA5A0', margin: '4px 0 0' },
  addBtn: { padding: '8px 16px', borderRadius: 10, border: 'none', background: '#C76B8A', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },

  infoCard: { display: 'flex', gap: 10, padding: 14, borderRadius: 12, background: '#EEF4FC', marginBottom: 16, alignItems: 'flex-start' },
  infoIcon: { fontSize: 18, flexShrink: 0, marginTop: 1 },
  infoText: { fontSize: 12, color: '#4A6B8A', lineHeight: 1.5 },

  sectionLabel: { display: 'block', fontSize: 11, fontWeight: 600, color: '#AAA5A0', textTransform: 'uppercase', letterSpacing: '0.04em', marginBottom: 8 },

  card: { background: '#fff', borderRadius: 14, padding: 16, marginBottom: 8, boxShadow: '0 1px 3px rgba(0,0,0,0.04)', borderLeft: '3px solid transparent' },
  cardTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 8 },
  cardInfo: { display: 'flex', flexDirection: 'column', gap: 2 },
  cardName: { fontSize: 14, fontWeight: 600, color: '#2D2A26' },
  cardTreatment: { fontSize: 12, color: '#AAA5A0' },
  priorityBadge: { display: 'flex', alignItems: 'center', gap: 4 },
  priorityDot: { width: 8, height: 8, borderRadius: 4 },
  priorityText: { fontSize: 11, fontWeight: 600 },

  cardPrefs: { display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10 },
  prefChip: { padding: '3px 8px', borderRadius: 6, background: '#F5F2EF', fontSize: 11, color: '#8A8580' },

  offeredBanner: { padding: '8px 12px', borderRadius: 8, background: '#FFF3E0', color: '#F57C00', fontSize: 12, fontWeight: 500, marginBottom: 10 },

  cardActions: { display: 'flex', gap: 8 },
  bookBtn: { flex: 1, padding: '8px 0', borderRadius: 8, border: 'none', background: '#C76B8A', color: '#fff', fontSize: 12, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  removeBtn: { padding: '8px 14px', borderRadius: 8, border: 'none', background: '#F5F2EF', color: '#AAA5A0', fontSize: 12, cursor: 'pointer', fontFamily: 'inherit' },

  // Empty state
  emptyState: { textAlign: 'center', padding: '40px 20px' },
  emptyIcon: { fontSize: 48, marginBottom: 12 },
  emptyTitle: { fontSize: 16, fontWeight: 600, margin: '0 0 8px' },
  emptyDesc: { fontSize: 13, color: '#AAA5A0', lineHeight: 1.5, margin: '0 0 20px' },
  emptyBtn: { padding: '12px 24px', borderRadius: 12, border: 'none', background: '#C76B8A', color: '#fff', fontSize: 14, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },

  loadingWrap: { display: 'flex', flexDirection: 'column', gap: 8 },

  // Modal
  overlay: { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.3)', zIndex: 200, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' },
  modal: { background: '#fff', borderRadius: '20px 20px 0 0', padding: '20px 20px 32px', width: '100%', maxWidth: 480, maxHeight: '85vh', overflowY: 'auto' },
  modalHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 },
  modalTitle: { fontSize: 18, fontWeight: 700, margin: 0 },
  closeBtn: { width: 32, height: 32, borderRadius: 16, border: 'none', background: '#F5F2EF', cursor: 'pointer', fontSize: 14, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#8A8580' },

  formGroup: { marginBottom: 16 },
  label: { display: 'block', fontSize: 12, fontWeight: 600, color: '#8A8580', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '0.03em' },
  select: { width: '100%', padding: '12px 14px', borderRadius: 10, border: '1.5px solid #F0ECE8', fontSize: 14, fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box', background: '#FAFAFA', appearance: 'none' },
  dayGrid: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  dayChip: { padding: '8px 14px', borderRadius: 8, border: 'none', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  hint: { display: 'block', fontSize: 11, color: '#C4BDB6', marginTop: 6 },
  timeRow: { display: 'flex', alignItems: 'center', gap: 8 },
  timeInput: { flex: 1, padding: '10px 12px', borderRadius: 10, border: '1.5px solid #F0ECE8', fontSize: 13, fontFamily: 'inherit', outline: 'none' },
  timeSep: { fontSize: 12, color: '#AAA5A0' },
  saveBtn: { width: '100%', padding: '14px 0', borderRadius: 12, border: 'none', background: '#C76B8A', color: '#fff', fontSize: 15, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
};
