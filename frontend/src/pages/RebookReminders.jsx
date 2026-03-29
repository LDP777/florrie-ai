/**
 * RebookReminders — Automated rebook nudges & dormant client rescue.
 *
 * Tabs:
 *   Due Soon    — clients approaching rebook window
 *   Overdue     — clients past their usual interval
 *   Dormant     — haven't been in 60+ days
 *   Settings    — rebook intervals, message templates, auto-send
 *
 * Uses DEV_CLIENTS + synthetic appointment data in dev mode.
 */
import { useState, useMemo, useEffect } from 'react';
import { useBeautician, supabase, isDevMode, fetchRows, DEV_CLIENTS, DEV_TREATMENTS } from '../lib/supabase.js';
import { useTheme } from '../lib/theme.jsx';
import logger from '../lib/logger.js';

// ── Mock rebook data ───────────────────────────────────────

const today = new Date();
const daysAgo = d => Math.floor((today - new Date(d)) / 86400000);

const DEV_REBOOK_CLIENTS = [
  { id: 'rb-1', name: 'Shauna', lastVisit: '2026-03-10', treatment: 'Lamination & Hybrid Dye', avgInterval: 28, phone: true, status: 'due' },
  { id: 'rb-2', name: 'Daisy S', lastVisit: '2026-02-17', treatment: 'Lamination & Tint', avgInterval: 35, phone: true, status: 'overdue' },
  { id: 'rb-3', name: 'Jasmin', lastVisit: '2026-03-02', treatment: 'HD Brows', avgInterval: 21, phone: true, status: 'overdue' },
  { id: 'rb-4', name: 'Sophie', lastVisit: '2026-01-15', treatment: 'Lash Lift & Tint', avgInterval: 42, phone: true, status: 'dormant' },
  { id: 'rb-5', name: 'Grace', lastVisit: '2025-12-20', treatment: 'Lamination & Hybrid Dye', avgInterval: 30, phone: true, status: 'dormant' },
  { id: 'rb-6', name: 'Beth', lastVisit: '2026-03-18', treatment: 'Hybrid Brows', avgInterval: 28, phone: false, status: 'due' },
  { id: 'rb-7', name: 'Amy', lastVisit: '2026-02-28', treatment: 'Lamination Maintenance / Tint', avgInterval: 28, phone: true, status: 'due' },
  { id: 'rb-8', name: 'Chloe', lastVisit: '2025-11-10', treatment: 'Ombre Brows (Semi-Permanent)', avgInterval: 90, phone: true, status: 'dormant' },
  { id: 'rb-9', name: 'Laura', lastVisit: '2026-03-05', treatment: 'Brow Jelly Mask', avgInterval: 14, phone: true, status: 'overdue' },
  { id: 'rb-10', name: 'Megan', lastVisit: '2026-02-10', treatment: 'HD Brows', avgInterval: 28, phone: true, status: 'overdue' },
];

const MESSAGE_TEMPLATES = [
  {
    id: 'gentle',
    name: 'Gentle nudge',
    body: "Hey {name}, hope you're well! It's been a little while since your last {treatment} — fancy getting booked in? I've got some lovely slots this week xx",
  },
  {
    id: 'comeback',
    name: 'Comeback offer',
    body: "Hey {name}! I've missed you 🥺 I've got 10% off your next {treatment} if you book this week — just my way of saying I'd love to see you again xx",
  },
  {
    id: 'direct',
    name: 'Direct rebook',
    body: "Hey {name}! Your {treatment} is due for a top-up. Want me to pop you in? I've got a few slots free this week xx",
  },
];

// ── Helpers ────────────────────────────────────────────────

function dueDate(client) {
  const last = new Date(client.lastVisit);
  last.setDate(last.getDate() + client.avgInterval);
  return last;
}

function urgencyColor(days) {
  if (days < 0) return '#4CAF50'; // not yet due
  if (days < 7) return '#F5A623';
  if (days < 21) return '#E57373';
  return '#C62828';
}

function daysSinceLabel(dateStr) {
  const d = daysAgo(dateStr);
  if (d === 0) return 'Today';
  if (d === 1) return 'Yesterday';
  return `${d} days ago`;
}

// ── Component ──────────────────────────────────────────────

export default function RebookReminders({ token }) {
  const { dark } = useTheme();
  const { beautician, loading: bLoading } = useBeautician();
  const [tab, setTab] = useState('due');
  const [loading, setLoading] = useState(true);
  const [clients, setClients] = useState(isDevMode ? DEV_REBOOK_CLIENTS : []);
  const [sentIds, setSentIds] = useState(new Set());
  const [selectedTemplate, setSelectedTemplate] = useState('gentle');

  useEffect(() => {
    if (beautician && !bLoading) loadRebookData();
  }, [beautician, bLoading]);

  async function loadRebookData() {
    setLoading(true);
    try {
      if (isDevMode) {
        setClients(DEV_REBOOK_CLIENTS);
      } else {
        // Fetch clients with last appointment date
        const { data } = await supabase
          .from('clients')
          .select('*, appointments(created_at, treatment_name)')
          .eq('beautician_id', beautician.id)
          .order('created_at', { ascending: false });

        const processedClients = (data || []).map(c => ({
          id: c.id,
          name: c.first_name,
          lastVisit: c.appointments?.[0]?.created_at || c.created_at,
          treatment: c.appointments?.[0]?.treatment_name || 'Treatment',
          avgInterval: 28, // Default, could be computed from history
          phone: !!c.phone_number,
          status: c.status || 'due',
        }));
        setClients(processedClients);
      }
    } catch (err) {
      logger.error('Load rebook data error:', err);
      setClients(DEV_REBOOK_CLIENTS);
    } finally {
      setLoading(false);
    }
  }
  const [previewClient, setPreviewClient] = useState(null);

  // Settings state
  const [autoSend, setAutoSend] = useState(false);
  const [defaultInterval, setDefaultInterval] = useState(28);
  const [sendChannel, setSendChannel] = useState('whatsapp');
  const [remindDaysBefore, setRemindDaysBefore] = useState(3);

  const due = clients.filter(c => c.status === 'due');
  const overdue = clients.filter(c => c.status === 'overdue');
  const dormant = clients.filter(c => c.status === 'dormant');

  const activeList = tab === 'due' ? due : tab === 'overdue' ? overdue : tab === 'dormant' ? dormant : [];

  if (bLoading || loading) {
    return <div style={s.page}><div style={{ textAlign: 'center', padding: 60, color: 'var(--text-muted, #AAA5A0)' }}>Loading...</div></div>;
  }

  function handleSend(clientId) {
    setSentIds(prev => new Set([...prev, clientId]));
  }

  function renderMessage(client) {
    const tmpl = MESSAGE_TEMPLATES.find(t => t.id === selectedTemplate) || MESSAGE_TEMPLATES[0];
    return tmpl.body.replace('{name}', client.name).replace('{treatment}', client.treatment);
  }

  const tabs = [
    { key: 'due', label: 'Due Soon', count: due.length },
    { key: 'overdue', label: 'Overdue', count: overdue.length },
    { key: 'dormant', label: 'Dormant', count: dormant.length },
    { key: 'settings', label: 'Settings', count: null },
  ];

  return (
    <div style={s.page}>
      <div style={s.header}>
        <h1 style={s.title}>Rebook Reminders</h1>
        <p style={s.sub}>Keep your clients coming back</p>
      </div>

      {/* Summary stats */}
      <div style={s.statsRow}>
        <div style={{ ...s.statCard, borderLeft: '3px solid var(--warning, #D4943A)' }}>
          <span style={s.statValue}>{due.length}</span>
          <span style={s.statLabel}>Due soon</span>
        </div>
        <div style={{ ...s.statCard, borderLeft: '3px solid var(--danger, #D4605C)' }}>
          <span style={s.statValue}>{overdue.length}</span>
          <span style={s.statLabel}>Overdue</span>
        </div>
        <div style={{ ...s.statCard, borderLeft: '3px solid var(--text-muted, #9E9E9E)' }}>
          <span style={s.statValue}>{dormant.length}</span>
          <span style={s.statLabel}>Dormant</span>
        </div>
      </div>

      {/* Tab bar */}
      <div style={s.tabBar}>
        {tabs.map(t => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              ...s.tab,
              color: tab === t.key ? '#C76B8A' : 'var(--text-muted, #AAA5A0)',
              borderBottom: tab === t.key ? '2px solid #C76B8A' : '2px solid transparent',
              fontWeight: tab === t.key ? 600 : 400,
            }}
          >
            {t.label}
            {t.count !== null && <span style={s.tabBadge}>{t.count}</span>}
          </button>
        ))}
      </div>

      {/* Client lists */}
      {tab !== 'settings' && (
        <>
          {/* Template selector */}
          <div style={s.templateRow}>
            <span style={s.templateLabel}>Message:</span>
            <div style={s.templateChips}>
              {MESSAGE_TEMPLATES.map(t => (
                <button
                  key={t.id}
                  onClick={() => setSelectedTemplate(t.id)}
                  style={{
                    ...s.templateChip,
                    background: selectedTemplate === t.id ? 'var(--accent, #C76B8A)' : 'var(--card-bg, #fff)',
                    color: selectedTemplate === t.id ? '#fff' : 'var(--text, #2D2A26)',
                    border: selectedTemplate === t.id ? '1px solid var(--accent, #C76B8A)' : '1px solid var(--border, #E8E4E0)',
                  }}
                >
                  {t.name}
                </button>
              ))}
            </div>
          </div>

          {activeList.length === 0 ? (
            <div style={s.empty}>
              <p style={s.emptyText}>No clients in this category right now</p>
            </div>
          ) : (
            <div style={s.clientList}>
              {activeList.map(c => {
                const daysSince = daysAgo(c.lastVisit);
                const daysOverdue = daysSince - c.avgInterval;
                const sent = sentIds.has(c.id);

                return (
                  <div key={c.id} style={s.clientCard}>
                    <div style={s.clientTop}>
                      <div style={s.clientLeft}>
                        <div style={s.avatar}>{c.name[0]}</div>
                        <div>
                          <span style={s.clientName}>{c.name}</span>
                          <span style={s.clientMeta}>{c.treatment}</span>
                          <span style={s.clientMeta}>Last visit: {daysSinceLabel(c.lastVisit)}</span>
                        </div>
                      </div>
                      <div style={s.clientRight}>
                        <span style={{
                          ...s.urgencyBadge,
                          background: urgencyColor(daysOverdue) + '18',
                          color: urgencyColor(daysOverdue),
                        }}>
                          {daysOverdue > 0 ? `${daysOverdue}d overdue` : `${Math.abs(daysOverdue)}d until due`}
                        </span>
                      </div>
                    </div>

                    {/* Message preview */}
                    <div style={s.messagePreview}>
                      <p style={s.messageText}>{renderMessage(c)}</p>
                    </div>

                    {/* Actions */}
                    <div style={s.cardActions}>
                      {sent ? (
                        <span style={s.sentBadge}>✓ Sent</span>
                      ) : (
                        <>
                          <button
                            onClick={() => handleSend(c.id)}
                            style={s.sendBtn}
                            disabled={!c.phone}
                          >
                            Send nudge
                          </button>
                          <button
                            onClick={() => setPreviewClient(previewClient === c.id ? null : c.id)}
                            style={s.editBtn}
                          >
                            Edit
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {/* Bulk action */}
          {activeList.length > 0 && (
            <button
              onClick={() => activeList.forEach(c => handleSend(c.id))}
              style={s.bulkBtn}
            >
              Send to all {activeList.length} clients
            </button>
          )}
        </>
      )}

      {/* Settings tab */}
      {tab === 'settings' && (
        <div style={s.settingsSection}>
          <div style={s.toggleRow}>
            <div>
              <span style={s.toggleLabel}>Auto-send reminders</span>
              <span style={s.toggleDesc}>florrie.ai sends rebook nudges automatically</span>
            </div>
            <button
              onClick={() => setAutoSend(!autoSend)}
              style={{ ...s.toggle, background: autoSend ? 'var(--accent, #C76B8A)' : 'var(--border, #E8E4E0)' }}
            >
              <div style={{ ...s.toggleThumb, transform: autoSend ? 'translateX(18px)' : 'translateX(2px)' }} />
            </button>
          </div>

          <div style={s.settingCard}>
            <span style={s.settingLabel}>Default rebook interval</span>
            <div style={s.chipRow}>
              {[14, 21, 28, 42, 56].map(v => (
                <button
                  key={v}
                  onClick={() => setDefaultInterval(v)}
                  style={{
                    ...s.intervalChip,
                    background: defaultInterval === v ? 'var(--accent, #C76B8A)' : 'var(--card-bg, #fff)',
                    color: defaultInterval === v ? '#fff' : 'var(--text, #2D2A26)',
                    border: defaultInterval === v ? '1px solid var(--accent, #C76B8A)' : '1px solid var(--border, #E8E4E0)',
                  }}
                >
                  {v} days
                </button>
              ))}
            </div>
          </div>

          <div style={s.settingCard}>
            <span style={s.settingLabel}>Remind X days before due</span>
            <div style={s.chipRow}>
              {[1, 3, 5, 7].map(v => (
                <button
                  key={v}
                  onClick={() => setRemindDaysBefore(v)}
                  style={{
                    ...s.intervalChip,
                    background: remindDaysBefore === v ? 'var(--accent, #C76B8A)' : 'var(--card-bg, #fff)',
                    color: remindDaysBefore === v ? '#fff' : 'var(--text, #2D2A26)',
                    border: remindDaysBefore === v ? '1px solid var(--accent, #C76B8A)' : '1px solid var(--border, #E8E4E0)',
                  }}
                >
                  {v} day{v !== 1 ? 's' : ''}
                </button>
              ))}
            </div>
          </div>

          <div style={s.settingCard}>
            <span style={s.settingLabel}>Send via</span>
            <div style={s.chipRow}>
              {[
                { key: 'whatsapp', label: 'WhatsApp' },
                { key: 'sms', label: 'SMS' },
                { key: 'email', label: 'Email' },
              ].map(ch => (
                <button
                  key={ch.key}
                  onClick={() => setSendChannel(ch.key)}
                  style={{
                    ...s.intervalChip,
                    background: sendChannel === ch.key ? 'var(--accent, #C76B8A)' : 'var(--card-bg, #fff)',
                    color: sendChannel === ch.key ? '#fff' : 'var(--text, #2D2A26)',
                    border: sendChannel === ch.key ? '1px solid var(--accent, #C76B8A)' : '1px solid var(--border, #E8E4E0)',
                  }}
                >
                  {ch.label}
                </button>
              ))}
            </div>
          </div>

          <div style={s.settingCard}>
            <span style={s.settingLabel}>Message templates</span>
            <span style={s.settingDesc}>Customise the messages florrie.ai sends on your behalf</span>
            {MESSAGE_TEMPLATES.map(t => (
              <div key={t.id} style={s.templatePreview}>
                <span style={s.templatePreviewName}>{t.name}</span>
                <p style={s.templatePreviewBody}>{t.body}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

const s = {
  page: {
    padding: '16px 16px 32px',
    maxWidth: 480,
    margin: '0 auto',
    fontFamily: '"DM Sans", -apple-system, sans-serif',
  },
  header: { marginBottom: 16 },
  title: { fontSize: 24, fontWeight: 700, color: 'var(--text, #2D2A26)', margin: 0 },
  sub: { fontSize: 13, color: 'var(--text-muted, #AAA5A0)', margin: '4px 0 0' },
  statsRow: { display: 'flex', gap: 8, marginBottom: 16 },
  statCard: {
    flex: 1,
    background: 'var(--card-bg, #fff)',
    borderRadius: 12,
    padding: '12px 10px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 2,
  },
  statValue: { fontSize: 20, fontWeight: 700, color: 'var(--text, #2D2A26)' },
  statLabel: { fontSize: 10, color: 'var(--text-muted, #AAA5A0)', textTransform: 'uppercase', letterSpacing: '0.03em' },
  tabBar: { display: 'flex', borderBottom: '1px solid var(--border, #F0ECE8)', marginBottom: 14 },
  tab: {
    flex: 1, padding: '10px 0', background: 'none', border: 'none',
    cursor: 'pointer', fontSize: 12, fontFamily: 'inherit', textAlign: 'center',
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
  },
  tabBadge: {
    fontSize: 10, fontWeight: 700, background: 'var(--border, #F0ECE8)',
    borderRadius: 8, padding: '1px 6px',
  },
  templateRow: {
    display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap',
  },
  templateLabel: { fontSize: 12, color: 'var(--text-muted, #AAA5A0)', fontWeight: 500 },
  templateChips: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  templateChip: {
    padding: '5px 12px', borderRadius: 16, fontSize: 12, fontWeight: 500,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  clientList: { display: 'flex', flexDirection: 'column', gap: 10 },
  clientCard: {
    background: 'var(--card-bg, #fff)', borderRadius: 14, padding: 14,
    border: '1px solid var(--border, #F0ECE8)',
  },
  clientTop: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10,
  },
  clientLeft: { display: 'flex', gap: 10, alignItems: 'center' },
  avatar: {
    width: 38, height: 38, borderRadius: 19,
    background: 'linear-gradient(135deg, #C76B8A22, #C76B8A44)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 14, fontWeight: 700, color: '#C76B8A', flexShrink: 0,
  },
  clientName: { display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  clientMeta: { display: 'block', fontSize: 11, color: 'var(--text-muted, #AAA5A0)' },
  clientRight: {},
  urgencyBadge: {
    fontSize: 10, fontWeight: 600, padding: '3px 8px', borderRadius: 6,
  },
  messagePreview: {
    padding: '10px 12px', borderRadius: 10,
    background: 'var(--bg, #FAF8F5)', marginBottom: 10,
  },
  messageText: {
    fontSize: 12, color: 'var(--text, #5A5550)', lineHeight: 1.5, margin: 0,
  },
  cardActions: { display: 'flex', gap: 8 },
  sendBtn: {
    flex: 1, padding: '9px 0', borderRadius: 10, border: 'none',
    background: 'var(--accent, #C76B8A)', color: '#fff', fontSize: 13, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  editBtn: {
    padding: '9px 16px', borderRadius: 10, border: '1px solid var(--border, #E8E4E0)',
    background: 'var(--card-bg, #fff)', color: 'var(--text, #2D2A26)',
    fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
  },
  sentBadge: {
    fontSize: 13, fontWeight: 600, color: 'var(--success, #5BA97B)',
    display: 'flex', alignItems: 'center', gap: 4,
  },
  bulkBtn: {
    width: '100%', padding: '13px 0', marginTop: 16, borderRadius: 12,
    border: 'none', background: 'linear-gradient(135deg, var(--accent, #C76B8A), var(--accent-hover, #B85D7B))',
    color: '#fff', fontSize: 14, fontWeight: 700, cursor: 'pointer',
    fontFamily: 'inherit', boxShadow: '0 4px 14px rgba(199,107,138,0.3)',
  },
  empty: { textAlign: 'center', padding: '32px 20px' },
  emptyText: { fontSize: 13, color: 'var(--text-muted, #AAA5A0)' },
  // Settings
  settingsSection: { display: 'flex', flexDirection: 'column', gap: 12 },
  toggleRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '14px 16px', background: 'var(--card-bg, #fff)', borderRadius: 14,
    border: '1px solid var(--border, #F0ECE8)',
  },
  toggleLabel: { display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  toggleDesc: { display: 'block', fontSize: 12, color: 'var(--text-muted, #AAA5A0)', marginTop: 2 },
  toggle: {
    width: 44, height: 26, borderRadius: 13, border: 'none',
    cursor: 'pointer', position: 'relative', flexShrink: 0, transition: 'background 0.2s', background: 'var(--accent, #C76B8A)',
  },
  toggleThumb: {
    width: 22, height: 22, borderRadius: 11, background: '#fff',
    position: 'absolute', top: 2, transition: 'transform 0.2s',
    boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
  },
  settingCard: {
    background: 'var(--card-bg, #fff)', borderRadius: 14, padding: 16,
    border: '1px solid var(--border, #F0ECE8)',
  },
  settingLabel: { display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--text, #2D2A26)', marginBottom: 4 },
  settingDesc: { display: 'block', fontSize: 12, color: 'var(--text-muted, #AAA5A0)', marginBottom: 10 },
  chipRow: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 },
  intervalChip: {
    padding: '8px 14px', borderRadius: 10, fontSize: 13, fontWeight: 500,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  templatePreview: {
    padding: '10px 0', borderBottom: '1px solid var(--border, #F0ECE8)',
  },
  templatePreviewName: { display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--accent, #C76B8A)', marginBottom: 4 },
  templatePreviewBody: { fontSize: 12, color: 'var(--text, #5A5550)', lineHeight: 1.5, margin: 0 },
};
