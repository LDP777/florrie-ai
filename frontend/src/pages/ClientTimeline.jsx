/**
 * Client Timeline — Full chronological history per client.
 *
 * Everything that's happened with a client in one scroll:
 * appointments, messages, notes, payments, feedback, consent —
 * so Ellie never walks into an appointment blind.
 */
import { useState } from 'react';
import { isDevMode } from '../lib/supabase.js';

const DEV_CLIENTS_FULL = [
  { id: 'c1', name: 'Shauna', visits: 8, totalSpent: 32000, since: '2025-09-15', tags: ['VIP', 'Regular'] },
  { id: 'c2', name: 'Daisy S', visits: 12, totalSpent: 54000, since: '2025-06-22', tags: ['VIP', 'Semi-perm client'] },
  { id: 'c3', name: 'Jasmin', visits: 5, totalSpent: 22500, since: '2025-11-10', tags: ['Regular'] },
];

const DEV_EVENTS = {
  c1: [
    { id: 'e1', type: 'appointment', date: '2026-03-18T14:00', title: 'Lamination & Hybrid Dye', detail: 'Medium brown hybrid dye. 8 min processing.', amount: 4500, status: 'completed' },
    { id: 'e2', type: 'note', date: '2026-03-18T14:50', title: 'Appointment Note', detail: 'Client using castor oil at home — brows in great condition. Shorter processing time worked well.' },
    { id: 'e3', type: 'feedback', date: '2026-03-18T18:00', title: 'Feedback: 5★', detail: 'Absolutely love my brows! Ellie always gets them perfect.' },
    { id: 'e4', type: 'payment', date: '2026-03-18T14:55', title: 'Payment Received', detail: 'Card payment', amount: 4500 },
    { id: 'e5', type: 'message', date: '2026-03-18T16:00', title: 'Aftercare Sent', detail: 'Automated aftercare message via WhatsApp', channel: 'whatsapp' },
    { id: 'e6', type: 'appointment', date: '2026-02-28T15:00', title: 'HD Brows', detail: 'Threaded and tinted. Mentioned wedding in April.', amount: 2500, status: 'completed' },
    { id: 'e7', type: 'payment', date: '2026-02-28T15:40', title: 'Payment Received', detail: 'Cash payment', amount: 2500 },
    { id: 'e8', type: 'feedback', date: '2026-02-28T19:00', title: 'Feedback: 5★', detail: '' },
    { id: 'e9', type: 'consent', date: '2026-02-15T10:00', title: 'Photo Consent Granted', detail: 'Portfolio + Instagram + Booking page. Expires Feb 2027.' },
    { id: 'e10', type: 'appointment', date: '2026-02-01T14:00', title: 'Lamination & Tint', detail: 'Standard lamination. Warm brown tint.', amount: 4000, status: 'completed' },
    { id: 'e11', type: 'message', date: '2026-01-25T11:00', title: 'Rebook Nudge Sent', detail: 'Hey Shauna, fancy getting booked in again?', channel: 'whatsapp' },
    { id: 'e12', type: 'referral', date: '2025-12-10T10:00', title: 'Referred Holly B', detail: 'Holly booked Ombre Brows consultation.' },
  ],
  c2: [
    { id: 'e20', type: 'appointment', date: '2026-03-12T11:00', title: 'Ombre Brows (Semi-Permanent)', detail: 'Session 1 of 2. Soft brown pigment. Top-up booked 6 weeks.', amount: 25000, status: 'completed' },
    { id: 'e21', type: 'note', date: '2026-03-12T14:00', title: 'Appointment Note', detail: 'Mapped shape together — wanted slightly thicker tails. Healing instructions given.' },
    { id: 'e22', type: 'payment', date: '2026-03-12T14:10', title: 'Deposit Taken', detail: '50% deposit for semi-permanent', amount: 12500 },
    { id: 'e23', type: 'appointment', date: '2026-02-20T11:00', title: 'Combination Brows', detail: 'Session 1 of 2. Hair strokes at front, shading body and tail.', amount: 30000, status: 'completed' },
    { id: 'e24', type: 'note', date: '2026-02-20T14:00', title: 'Flag: Blood Thinners', detail: 'Client on Warfarin — used extra care, minimal bleeding. Note for all future sessions.' },
    { id: 'e25', type: 'consent', date: '2026-01-20T10:00', title: 'Photo Consent Granted', detail: 'Portfolio + Booking page only. No social media.' },
  ],
  c3: [
    { id: 'e30', type: 'appointment', date: '2026-03-08T10:00', title: 'Lash Lift & Tint', detail: 'Medium shields. Blue-black tint.', amount: 4000, status: 'completed' },
    { id: 'e31', type: 'note', date: '2026-03-08T11:00', title: 'Appointment Note', detail: 'Naturally long lashes — reduced setting time. Wants brown-black tint next time.' },
    { id: 'e32', type: 'feedback', date: '2026-03-08T15:00', title: 'Feedback: 4★', detail: 'Great result, lasted really well this time.' },
    { id: 'e33', type: 'appointment', date: '2026-02-14T10:00', title: 'Lamination Maintenance / Tint', detail: 'Quick session. Previous lamination held well.', amount: 2500, status: 'completed' },
  ],
};

const TYPE_CONFIG = {
  appointment: { icon: '📅', colour: '#C76B8A', bg: '#F0E6ED' },
  note: { icon: '📝', colour: '#8B6F5E', bg: '#F0ECE8' },
  feedback: { icon: '⭐', colour: '#B8860B', bg: '#FFF5E6' },
  payment: { icon: '💰', colour: '#6B8F7B', bg: '#E8F5E9' },
  message: { icon: '💬', colour: '#2196F3', bg: '#E3F2FD' },
  consent: { icon: '📋', colour: '#7B6B8F', bg: '#F0E6F4' },
  referral: { icon: '🤝', colour: '#5E8B8B', bg: '#E0F2F1' },
};

const fmt = (cents) => `£${(cents / 100).toFixed(2)}`;

export default function ClientTimeline({ token }) {
  const [selectedClient, setSelectedClient] = useState('c1');
  const [filterType, setFilterType] = useState('all');
  const [expanded, setExpanded] = useState(null);

  const client = DEV_CLIENTS_FULL.find(c => c.id === selectedClient);
  const allEvents = (DEV_EVENTS[selectedClient] || []).sort((a, b) => new Date(b.date) - new Date(a.date));
  const events = filterType === 'all' ? allEvents : allEvents.filter(e => e.type === filterType);

  // Client stats
  const appointments = allEvents.filter(e => e.type === 'appointment');
  const totalPaid = allEvents.filter(e => e.type === 'payment').reduce((s, e) => s + (e.amount || 0), 0);
  const avgRating = (() => {
    const fb = allEvents.filter(e => e.type === 'feedback');
    if (fb.length === 0) return null;
    const stars = fb.map(f => { const m = f.title.match(/(\d)★/); return m ? parseInt(m[1]) : 0; }).filter(Boolean);
    return stars.length ? (stars.reduce((a, b) => a + b, 0) / stars.length).toFixed(1) : null;
  })();

  // Group events by month
  const grouped = {};
  events.forEach(e => {
    const d = new Date(e.date);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(e);
  });

  return (
    <div style={S.page}>
      <h1 style={S.title}>Client Timeline</h1>

      {/* Client selector */}
      <div style={S.clientRow}>
        {DEV_CLIENTS_FULL.map(c => (
          <button key={c.id} onClick={() => { setSelectedClient(c.id); setExpanded(null); }} style={{ ...S.clientChip, ...(selectedClient === c.id ? S.clientActive : {}) }}>
            <div style={{ ...S.clientAvatar, background: selectedClient === c.id ? '#fff' : '#F0E6ED', color: selectedClient === c.id ? '#C76B8A' : '#C76B8A' }}>{c.name[0]}</div>
            <span>{c.name}</span>
          </button>
        ))}
      </div>

      {/* Client card */}
      {client && (
        <div style={S.profileCard}>
          <div style={S.profileTop}>
            <div style={S.profileAvatar}>{client.name[0]}</div>
            <div style={S.profileInfo}>
              <span style={S.profileName}>{client.name}</span>
              <span style={S.profileSince}>Client since {formatDate(client.since)}</span>
              <div style={S.tagRow}>
                {client.tags.map(t => <span key={t} style={S.tag}>{t}</span>)}
              </div>
            </div>
          </div>
          <div style={S.profileStats}>
            <div style={S.profileStat}>
              <span style={S.profileStatVal}>{client.visits}</span>
              <span style={S.profileStatLabel}>Visits</span>
            </div>
            <div style={S.profileStat}>
              <span style={S.profileStatVal}>{fmt(totalPaid || client.totalSpent)}</span>
              <span style={S.profileStatLabel}>Total Spent</span>
            </div>
            {avgRating && (
              <div style={S.profileStat}>
                <span style={S.profileStatVal}>⭐ {avgRating}</span>
                <span style={S.profileStatLabel}>Avg Rating</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Type filter */}
      <div style={S.filterRow}>
        {[{ v: 'all', l: 'All' }, { v: 'appointment', l: '📅 Appts' }, { v: 'note', l: '📝 Notes' }, { v: 'payment', l: '💰 Payments' }, { v: 'message', l: '💬 Messages' }, { v: 'feedback', l: '⭐ Feedback' }].map(f => (
          <button key={f.v} onClick={() => setFilterType(f.v)} style={{ ...S.filterChip, ...(filterType === f.v ? S.filterActive : {}) }}>
            {f.l}
          </button>
        ))}
      </div>

      {/* Timeline */}
      <div style={S.timeline}>
        {Object.entries(grouped).sort(([a], [b]) => b.localeCompare(a)).map(([month, evts]) => {
          const [y, m] = month.split('-').map(Number);
          const monthLabel = new Date(y, m - 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
          return (
            <div key={month}>
              <div style={S.monthHeader}>{monthLabel}</div>
              {evts.map(evt => {
                const cfg = TYPE_CONFIG[evt.type] || TYPE_CONFIG.note;
                const isExp = expanded === evt.id;
                const time = new Date(evt.date).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
                const day = new Date(evt.date).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' });
                return (
                  <div key={evt.id} style={S.eventRow} onClick={() => setExpanded(isExp ? null : evt.id)}>
                    <div style={S.eventLeft}>
                      <div style={S.eventDate}>
                        <span style={S.eventDay}>{day}</span>
                        <span style={S.eventTime}>{time}</span>
                      </div>
                      <div style={S.dotCol}>
                        <div style={{ ...S.dot, background: cfg.colour }} />
                        <div style={S.line} />
                      </div>
                    </div>
                    <div style={{ ...S.eventCard, borderLeft: `3px solid ${cfg.colour}` }}>
                      <div style={S.eventHeader}>
                        <span style={S.eventIcon}>{cfg.icon}</span>
                        <span style={S.eventTitle}>{evt.title}</span>
                        {evt.amount && <span style={{ ...S.eventAmount, color: cfg.colour }}>{fmt(evt.amount)}</span>}
                      </div>
                      {(isExp || !evt.detail) ? null : (
                        <p style={S.eventPreview}>{evt.detail.slice(0, 60)}{evt.detail.length > 60 ? '...' : ''}</p>
                      )}
                      {isExp && evt.detail && (
                        <p style={S.eventDetail}>{evt.detail}</p>
                      )}
                      {evt.status && (
                        <span style={{ ...S.eventStatus, background: evt.status === 'completed' ? '#E8F5E9' : '#FFF5E6', color: evt.status === 'completed' ? '#4CAF50' : '#B8860B' }}>
                          {evt.status}
                        </span>
                      )}
                      {evt.channel && (
                        <span style={S.channelTag}>{evt.channel === 'whatsapp' ? '💬 WhatsApp' : evt.channel === 'sms' ? '📱 SMS' : '✉️ Email'}</span>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
        {events.length === 0 && <p style={S.empty}>No events for this filter.</p>}
      </div>
    </div>
  );
}

function formatDate(dateStr) {
  return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}

const S = {
  page: { padding: '20px 16px 32px', fontFamily: '"DM Sans", -apple-system, sans-serif', maxWidth: 480, margin: '0 auto' },
  title: { fontSize: 22, fontWeight: 700, color: 'var(--text, #2D2A26)', margin: '0 0 16px' },

  clientRow: { display: 'flex', gap: 8, marginBottom: 16, overflowX: 'auto' },
  clientChip: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 12px 6px 6px', borderRadius: 20, border: '1px solid #F0ECE8', background: 'var(--card, #fff)', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', color: '#2D2A26', whiteSpace: 'nowrap' },
  clientActive: { background: '#C76B8A', color: '#fff', border: '1px solid #C76B8A' },
  clientAvatar: { width: 26, height: 26, borderRadius: 13, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 600, flexShrink: 0 },

  profileCard: { background: 'var(--card, #fff)', borderRadius: 14, padding: 16, marginBottom: 16 },
  profileTop: { display: 'flex', gap: 12, alignItems: 'center', marginBottom: 12 },
  profileAvatar: { width: 44, height: 44, borderRadius: 22, background: '#F0E6ED', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18, fontWeight: 700, color: '#C76B8A', flexShrink: 0 },
  profileInfo: { display: 'flex', flexDirection: 'column', gap: 3 },
  profileName: { fontSize: 17, fontWeight: 700, color: 'var(--text, #2D2A26)' },
  profileSince: { fontSize: 12, color: '#AAA5A0' },
  tagRow: { display: 'flex', gap: 6 },
  tag: { padding: '2px 8px', borderRadius: 6, background: '#F0E6ED', color: '#C76B8A', fontSize: 10, fontWeight: 600 },
  profileStats: { display: 'flex', gap: 12 },
  profileStat: { flex: 1, background: '#F9F7F4', borderRadius: 10, padding: '8px 6px', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 },
  profileStatVal: { fontSize: 15, fontWeight: 700, color: 'var(--text, #2D2A26)' },
  profileStatLabel: { fontSize: 10, color: '#AAA5A0' },

  filterRow: { display: 'flex', gap: 6, marginBottom: 16, overflowX: 'auto', paddingBottom: 2 },
  filterChip: { padding: '6px 12px', borderRadius: 16, border: '1px solid #F0ECE8', background: 'var(--card, #fff)', color: '#8B6F5E', fontSize: 12, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' },
  filterActive: { background: '#2D2A26', color: '#fff', border: '1px solid #2D2A26' },

  timeline: {},
  monthHeader: { fontSize: 13, fontWeight: 700, color: '#AAA5A0', textTransform: 'uppercase', letterSpacing: '0.05em', padding: '12px 0 8px' },

  eventRow: { display: 'flex', gap: 0, marginBottom: 2, cursor: 'pointer' },
  eventLeft: { display: 'flex', gap: 8, width: 80, flexShrink: 0 },
  eventDate: { display: 'flex', flexDirection: 'column', alignItems: 'flex-end', width: 50 },
  eventDay: { fontSize: 11, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  eventTime: { fontSize: 10, color: '#AAA5A0' },
  dotCol: { display: 'flex', flexDirection: 'column', alignItems: 'center', width: 12, paddingTop: 4 },
  dot: { width: 8, height: 8, borderRadius: 4, flexShrink: 0 },
  line: { width: 2, flex: 1, background: '#F0ECE8', marginTop: 2 },

  eventCard: { flex: 1, background: 'var(--card, #fff)', borderRadius: 10, padding: '10px 12px', marginBottom: 6 },
  eventHeader: { display: 'flex', alignItems: 'center', gap: 6 },
  eventIcon: { fontSize: 14 },
  eventTitle: { fontSize: 13, fontWeight: 600, color: 'var(--text, #2D2A26)', flex: 1 },
  eventAmount: { fontSize: 13, fontWeight: 700 },
  eventPreview: { fontSize: 12, color: '#8B6F5E', margin: '4px 0 0', lineHeight: 1.3 },
  eventDetail: { fontSize: 13, color: '#8B6F5E', margin: '6px 0 0', lineHeight: 1.5 },
  eventStatus: { display: 'inline-block', padding: '2px 8px', borderRadius: 6, fontSize: 10, fontWeight: 600, marginTop: 6, textTransform: 'capitalize' },
  channelTag: { display: 'inline-block', padding: '2px 8px', borderRadius: 6, background: '#E3F2FD', color: '#2196F3', fontSize: 10, fontWeight: 500, marginTop: 6 },

  empty: { textAlign: 'center', color: '#AAA5A0', fontSize: 14, padding: 32 },
};
