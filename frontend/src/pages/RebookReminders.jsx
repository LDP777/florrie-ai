/**
 * RebookReminders - Automated rebook nudges & dormant client rescue.
 *
 * Tabs:
 *   Due Soon    - clients approaching rebook window
 *   Overdue     - clients past their usual interval
 *   Dormant     - haven't been in 60+ days
 *
 * Sends go out manually from the lists. The send channel sits inline
 * with the message picker so it takes effect on the next send. There
 * is no separate Settings tab: the auto-send / interval / lead-time
 * preferences had no backing store, so they were removed rather than
 * implying they persist.
 */
import { useState, useMemo, useEffect } from 'react';
import { useBeautician, supabase, fetchRows } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import { useTheme } from '../lib/theme.jsx';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import PageHeader from '../components/ui/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';

const daysAgo = d => Math.floor((new Date() - new Date(d)) / 86400000);

const MESSAGE_TEMPLATES = [
  {
    id: 'gentle',
    name: 'Gentle nudge',
    body: "Hey {name}, hope you're well! It's been a little while since your last {treatment} - fancy getting booked in? I've got some lovely slots this week xx",
  },
  {
    id: 'comeback',
    name: 'Comeback offer',
    body: "Hey {name}! I've missed you 🥺 I've got 10% off your next {treatment} if you book this week - just my way of saying I'd love to see you again xx",
  },
  {
    id: 'direct',
    name: 'Direct rebook',
    body: "Hey {name}! Your {treatment} is due for a top-up. Want me to pop you in? I've got a few slots free this week xx",
  },
];

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

export default function RebookReminders() {
  const { dark } = useTheme();
  const { beautician, loading: bLoading } = useBeautician();
  const [tab, setTab] = useState('due');
  const [loading, setLoading] = useState(true);
  const [clients, setClients] = useState([]);
  const [sentIds, setSentIds] = useState(new Set());
  const [selectedTemplate, setSelectedTemplate] = useState('gentle');

  useEffect(() => {
    if (beautician && !bLoading) loadRebookData();
  }, [beautician, bLoading]);

  async function loadRebookData() {
    setLoading(true);
    try {
      // Fetch clients with last appointment date
      const { data } = await supabase
        .from('clients')
        .select('*, appointments(created_at, treatment_name)')
        .eq('beautician_id', beautician.id)
        .order('created_at', { ascending: false });

      const now = new Date();
      const processedClients = (data || []).map(c => {
        const appts = (c.appointments || [])
          .map(a => new Date(a.created_at))
          .filter(d => !isNaN(d))
          .sort((a, b) => b - a);
        const lastVisit = appts[0] || new Date(c.created_at);
        const daysSince = Math.floor((now - lastVisit) / 86400000);

        // Compute real average interval from history
        let avgInterval = 28;
        if (appts.length >= 2) {
          const intervals = [];
          for (let i = 0; i < appts.length - 1; i++) {
            intervals.push(Math.floor((appts[i] - appts[i + 1]) / 86400000));
          }
          avgInterval = Math.round(intervals.reduce((s, v) => s + v, 0) / intervals.length) || 28;
        }

        // Determine status from actual visit pattern
        let status = 'due';
        if (daysSince >= 60) status = 'dormant';
        else if (daysSince > avgInterval) status = 'overdue';
        else if (daysSince >= avgInterval - 7) status = 'due';
        else return null; // Not due yet

        return {
          id: c.id,
          name: `${c.first_name || ''} ${c.last_name || ''}`.trim(),
          lastVisit: lastVisit.toISOString().slice(0, 10),
          treatment: c.appointments?.[0]?.treatment_name || 'Treatment',
          avgInterval,
          phone: !!c.phone_number,
          status,
        };
      }).filter(Boolean);
      setClients(processedClients);
    } catch (err) {
      logger.error({ err }, 'Load rebook data error');
      setClients([]);
    } finally {
      setLoading(false);
    }
  }
  const [previewClient, setPreviewClient] = useState(null);

  // Send channel - takes effect immediately on the next manual send.
  const [sendChannel, setSendChannel] = useState('whatsapp');

  const due = clients.filter(c => c.status === 'due');
  const overdue = clients.filter(c => c.status === 'overdue');
  const dormant = clients.filter(c => c.status === 'dormant');

  const activeList = tab === 'due' ? due : tab === 'overdue' ? overdue : tab === 'dormant' ? dormant : [];

  if (bLoading || loading) {
    return <PageLoader />;
  }

  async function handleSend(clientId) {
    const client = clients.find(c => c.id === clientId);
    if (!client) return;

    const message = renderMessage(client);

    try {
      const session = await supabase.auth.getSession();
      const token = session.data.session?.access_token;

      if (sendChannel === 'email') {
        const res = await fetch(`${API_BASE}/api/notifications/send-email`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ client_id: clientId, subject: `Time to rebook your ${client.treatment}!`, text: message }),
        });
        if (!res.ok) throw new Error('Email send failed');
      } else {
        // SMS covers both sms and whatsapp channels
        const res = await fetch(`${API_BASE}/api/notifications/send-sms`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ client_id: clientId, message }),
        });
        if (!res.ok) throw new Error('SMS send failed');
      }

      setSentIds(prev => new Set([...prev, clientId]));
    } catch (err) {
      logger.error({ err }, 'Failed to send rebook nudge');
      alert(`Failed to send nudge to ${client.name}. Check their contact details.`);
    }
  }

  function renderMessage(client) {
    const tmpl = MESSAGE_TEMPLATES.find(t => t.id === selectedTemplate) || MESSAGE_TEMPLATES[0];
    return tmpl.body.replace('{name}', client.name).replace('{treatment}', client.treatment);
  }

  const tabs = [
    { key: 'due', label: 'Due Soon', count: due.length },
    { key: 'overdue', label: 'Overdue', count: overdue.length },
    { key: 'dormant', label: 'Dormant', count: dormant.length },
  ];

  return (
    <div style={s.page}>
      <PageHeader title="Rebook Reminders" subtitle="Keep your clients coming back" />

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
              color: tab === t.key ? 'var(--accent, #C76B8A)' : 'var(--text-muted, #7a7470)',
              borderBottom: tab === t.key ? '2px solid var(--accent)' : '2px solid transparent',
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
                    color: selectedTemplate === t.id ? 'var(--bg-card, #fff)' : 'var(--text, #2D2A26)',
                    border: selectedTemplate === t.id ? '1px solid var(--accent, #C76B8A)' : '1px solid var(--border, #E8E4E0)',
                  }}
                >
                  {t.name}
                </button>
              ))}
            </div>
          </div>

          {/* Send channel - applies to the next send */}
          <div style={s.templateRow}>
            <span style={s.templateLabel}>Send via:</span>
            <div style={s.templateChips}>
              {[
                { key: 'whatsapp', label: 'WhatsApp' },
                { key: 'sms', label: 'SMS' },
                { key: 'email', label: 'Email' },
              ].map(ch => (
                <button
                  key={ch.key}
                  onClick={() => setSendChannel(ch.key)}
                  style={{
                    ...s.templateChip,
                    background: sendChannel === ch.key ? 'var(--accent, #C76B8A)' : 'var(--card-bg, #fff)',
                    color: sendChannel === ch.key ? 'var(--bg-card, #fff)' : 'var(--text, #2D2A26)',
                    border: sendChannel === ch.key ? '1px solid var(--accent, #C76B8A)' : '1px solid var(--border, #E8E4E0)',
                  }}
                >
                  {ch.label}
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
              onClick={async () => { for (const c of activeList) await handleSend(c.id); }}
              style={s.bulkBtn}
            >
              Send to all {activeList.length} clients
            </button>
          )}
        </>
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
  sub: { fontSize: 13, color: 'var(--text-muted, #7a7470)', margin: '4px 0 0' },
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
  statLabel: { fontSize: 10, color: 'var(--text-muted, #7a7470)', textTransform: 'uppercase', letterSpacing: '0.03em' },
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
  templateLabel: { fontSize: 12, color: 'var(--text-muted, #7a7470)', fontWeight: 500 },
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
    fontSize: 14, fontWeight: 700, color: 'var(--accent, #C76B8A)', flexShrink: 0,
  },
  clientName: { display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  clientMeta: { display: 'block', fontSize: 11, color: 'var(--text-muted, #7a7470)' },
  clientRight: {},
  urgencyBadge: {
    fontSize: 10, fontWeight: 600, padding: '3px 8px', borderRadius: 6,
  },
  messagePreview: {
    padding: '10px 12px', borderRadius: 10,
    background: 'var(--bg, var(--bg, #FAF8F5))', marginBottom: 10,
  },
  messageText: {
    fontSize: 12, color: 'var(--text, #5A5550)', lineHeight: 1.5, margin: 0,
  },
  cardActions: { display: 'flex', gap: 8 },
  sendBtn: {
    flex: 1, padding: '9px 0', borderRadius: 10, border: 'none',
    background: 'var(--accent, #C76B8A)', color: 'var(--bg-card, #fff)', fontSize: 13, fontWeight: 600,
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
    color: 'var(--bg-card, #fff)', fontSize: 14, fontWeight: 700, cursor: 'pointer',
    fontFamily: 'inherit', boxShadow: '0 4px 14px rgba(199,107,138,0.3)',
  },
  empty: { textAlign: 'center', padding: '32px 20px' },
  emptyText: { fontSize: 13, color: 'var(--text-muted, #7a7470)' },
  // Settings
  settingsSection: { display: 'flex', flexDirection: 'column', gap: 12 },
  toggleRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '14px 16px', background: 'var(--card-bg, #fff)', borderRadius: 14,
    border: '1px solid var(--border, #F0ECE8)',
  },
  toggleLabel: { display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--text, #2D2A26)' },
  toggleDesc: { display: 'block', fontSize: 12, color: 'var(--text-muted, #7a7470)', marginTop: 2 },
  toggle: {
    width: 44, height: 26, borderRadius: 13, border: 'none',
    cursor: 'pointer', position: 'relative', flexShrink: 0, transition: 'background 0.2s', background: 'var(--accent, #C76B8A)',
  },
  toggleThumb: {
    width: 22, height: 22, borderRadius: 11, background: 'var(--bg-card, #fff)',
    position: 'absolute', top: 2, transition: 'transform 0.2s',
    boxShadow: '0 1px 3px rgba(0,0,0,0.15)',
  },
  settingCard: {
    background: 'var(--card-bg, #fff)', borderRadius: 14, padding: 16,
    border: '1px solid var(--border, #F0ECE8)',
  },
  settingLabel: { display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--text, #2D2A26)', marginBottom: 4 },
  settingDesc: { display: 'block', fontSize: 12, color: 'var(--text-muted, #7a7470)', marginBottom: 10 },
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
