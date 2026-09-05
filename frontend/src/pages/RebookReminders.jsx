import { rebookClients } from './more-reliability.js';
import { todayLocal } from '../lib/dates.js';
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
import { useState, useMemo, useEffect, useRef } from 'react';
import { useBeautician, supabase, fetchRows } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import { useTheme } from '../lib/theme.jsx';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import PageHeader from '../components/ui/PageHeader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';
import Icon from '../components/ui/Icon';

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
    body: "Hey {name}! I've missed you 🥺 Would you like to book your next {treatment}? It would be lovely to see you again xx",
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
  if (days < 0) return '#306F33'; // not yet due
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
  const [error, setError] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [sending, setSending] = useState(false);
  const sendingIds = useRef(new Set());
  const [drafts, setDrafts] = useState({});

  useEffect(() => {
    if (beautician && !bLoading) loadRebookData();
  }, [beautician, bLoading]);

  async function loadRebookData() {
    setLoading(true); setError(null); setLoadFailed(false);
    try {
      // Fetch clients with last appointment date
      const { data, error: readError } = await supabase
        .from('clients')
        .select('*, appointments(starts_at, status, treatments(name))')
        .eq('beautician_id', beautician.id)
        .order('created_at', { ascending: false });

      if (readError) throw readError;
      const processedClients = rebookClients(data || [], todayLocal());
      setClients(processedClients);
    } catch (err) {
      logger.error({ err }, 'Load rebook data error');
      setLoadFailed(true); setError('Could not load rebooking history. Try again.');
      setClients([]);
    } finally {
      setLoading(false);
    }
  }
  const [previewClient, setPreviewClient] = useState(null);

  // Send channel - takes effect immediately on the next manual send.
  const [sendChannel, setSendChannel] = useState('sms');

  const due = clients.filter(c => c.status === 'due');
  const overdue = clients.filter(c => c.status === 'overdue');
  const dormant = clients.filter(c => c.status === 'dormant');

  const activeList = tab === 'due' ? due : tab === 'overdue' ? overdue : tab === 'dormant' ? dormant : [];

  if (bLoading || loading) {
    return <PageLoader />;
  }

  async function handleSend(clientId) {
    const client = clients.find(c => c.id === clientId);
    if (!client || sentIds.has(clientId) || sendingIds.current.has(clientId) || !(sendChannel === 'email' ? client.email : client.phone)) return;
    sendingIds.current.add(clientId); setSending(true); setError(null);

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
        const result = await res.json().catch(() => ({}));
        if (!res.ok || result.success !== true) throw new Error(result.error || 'Email was not sent');
      } else {
        // This endpoint sends SMS only.
        const res = await fetch(`${API_BASE}/api/notifications/send-sms`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
          body: JSON.stringify({ client_id: clientId, message }),
        });
        const result = await res.json().catch(() => ({}));
        if (!res.ok || result.success !== true) throw new Error(result.error || 'SMS was not sent');
      }

      setSentIds(prev => new Set([...prev, clientId]));
    } catch (err) {
      logger.error({ err }, 'Failed to send rebook nudge');
      setError(`Could not send to ${client.name}. ${err.message}`);
    } finally { sendingIds.current.delete(clientId); setSending(sendingIds.current.size > 0); }
  }

  function renderMessage(client) {
    const tmpl = MESSAGE_TEMPLATES.find(t => t.id === selectedTemplate) || MESSAGE_TEMPLATES[0];
    if (drafts[client.id] !== undefined) return drafts[client.id];
    return tmpl.body.replace('{name}', client.name).replace('{treatment}', client.treatment);
  }

  if (loadFailed) return <div style={s.page}><PageHeader title="Rebook Reminders" /><ErrorCard message={error} /><button className="fl-tap" onClick={loadRebookData}>Try again</button></div>;

  const tabs = [
    { key: 'due', label: 'Due Soon', count: due.length },
    { key: 'overdue', label: 'Overdue', count: overdue.length },
    { key: 'dormant', label: 'Dormant', count: dormant.length },
  ];

  return (
    <div style={s.page}>
      <PageHeader title="Rebook Reminders" subtitle="Clients due for their next visit" />
      {error && <ErrorCard message={error} onDismiss={() => setError(null)} />}

      {/* Summary stats */}
      <div style={s.statsRow}>
        <div style={{ ...s.statCard, borderLeft: '3px solid var(--warning, #79581C)' }}>
          <span style={s.statValue}>{due.length}</span>
          <span style={s.statLabel}>Due soon</span>
        </div>
        <div style={{ ...s.statCard, borderLeft: '3px solid var(--danger, #9E2B32)' }}>
          <span style={s.statValue}>{overdue.length}</span>
          <span style={s.statLabel}>Overdue</span>
        </div>
        <div style={{ ...s.statCard, borderLeft: '3px solid var(--text-muted, #6B5D54)' }}>
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
            style={{ ...s.tab,
              color: tab === t.key ? 'var(--accent, #92405e)' : 'var(--text-muted, #6B5D54)',
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
                  style={{ ...s.templateChip,
                    background: selectedTemplate === t.id ? 'var(--accent, #92405e)' : 'var(--card-bg, #FFFCF9)',
                    color: selectedTemplate === t.id ? 'var(--bg-card, #FFFCF9)' : 'var(--text, #241B17)',
                    border: selectedTemplate === t.id ? '1px solid var(--accent, #92405e)' : '1px solid var(--border, #E8DDD4)',
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
                { key: 'sms', label: 'SMS' },
                { key: 'email', label: 'Email' },
              ].map(ch => (
                <button
                  key={ch.key}
                  onClick={() => setSendChannel(ch.key)}
                  style={{ ...s.templateChip,
                    background: sendChannel === ch.key ? 'var(--accent, #92405e)' : 'var(--card-bg, #FFFCF9)',
                    color: sendChannel === ch.key ? 'var(--bg-card, #FFFCF9)' : 'var(--text, #241B17)',
                    border: sendChannel === ch.key ? '1px solid var(--accent, #92405e)' : '1px solid var(--border, #E8DDD4)',
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
                        <div style={s.avatar}>{(c.name || '?').charAt(0).toUpperCase()}</div>
                        <div>
                          <span style={s.clientName}>{c.name}</span>
                          <span style={s.clientMeta}>{c.treatment}</span>
                          <span style={s.clientMeta}>Last visit: {daysSinceLabel(c.lastVisit)}</span>
                        </div>
                      </div>
                      <div style={s.clientRight}>
                        <span style={{ ...s.urgencyBadge,
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
                      {previewClient === c.id && <textarea aria-label={`Message for ${c.name}`} value={renderMessage(c)} onChange={e => setDrafts(prev => ({ ...prev, [c.id]: e.target.value }))} style={{ width: '100%', minHeight: 100, boxSizing: 'border-box', font: 'inherit' }} />}
                    </div>

                    {/* Actions */}
                    <div style={s.cardActions}>
                      {sent ? (
                        <span style={s.sentBadge}><Icon name="check" size={14} inline /> Sent</span>
                      ) : (
                        <>
                          <button
                            onClick={() => handleSend(c.id)}
                            style={s.sendBtn}
                            disabled={sending || !(sendChannel === 'email' ? c.email : c.phone)}
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
              disabled={sending}
              onClick={async () => { for (const c of activeList.filter(c => !sentIds.has(c.id))) await handleSend(c.id); }}
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
    fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif",
  },
  header: { marginBottom: 16 },
  title: { fontSize: 24, fontWeight: 700, color: 'var(--text, #241B17)', margin: 0 },
  sub: { fontSize: 13, color: 'var(--text-muted, #6B5D54)', margin: '4px 0 0' },
  statsRow: { display: 'flex', gap: 8, marginBottom: 16 },
  statCard: {
    flex: 1,
    background: 'var(--card-bg, #FFFCF9)',
    borderRadius: 10,
    padding: '12px 10px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 2,
  },
  statValue: { fontSize: 20, fontWeight: 700, color: 'var(--text, #241B17)' },
  statLabel: { fontSize: 10, color: 'var(--text-muted, #6B5D54)', textTransform: 'uppercase', letterSpacing: '0.03em' },
  tabBar: { display: 'flex', borderBottom: '1px solid var(--border, #E8DDD4)', marginBottom: 14 },
  tab: {
    flex: 1, padding: '10px 0', background: 'none', border: 'none',
    cursor: 'pointer', fontSize: 12, fontFamily: 'inherit', textAlign: 'center',
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
  },
  tabBadge: {
    fontSize: 10, fontWeight: 700, background: 'var(--border, #E8DDD4)',
    borderRadius: 10, padding: '1px 6px',
  },
  templateRow: {
    display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap',
  },
  templateLabel: { fontSize: 12, color: 'var(--text-muted, #6B5D54)', fontWeight: 500 },
  templateChips: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  templateChip: {
    padding: '5px 12px', borderRadius: 16, fontSize: 12, fontWeight: 500,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  clientList: { display: 'flex', flexDirection: 'column', gap: 10 },
  clientCard: {
    background: 'var(--card-bg, #FFFCF9)', borderRadius: 16, padding: 14,
    border: '1px solid var(--border, #E8DDD4)',
  },
  clientTop: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 10,
  },
  clientLeft: { display: 'flex', gap: 10, alignItems: 'center' },
  avatar: {
    width: 38, height: 38, borderRadius: 22,
    background: 'linear-gradient(135deg, #B9466D22, #B9466D44)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    fontSize: 14, fontWeight: 700, color: 'var(--accent, #92405e)', flexShrink: 0,
  },
  clientName: { display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--text, #241B17)' },
  clientMeta: { display: 'block', fontSize: 11, color: 'var(--text-muted, #6B5D54)' },
  clientRight: {},
  urgencyBadge: {
    fontSize: 10, fontWeight: 600, padding: '3px 8px', borderRadius: 'var(--radius-xs)',
  },
  messagePreview: {
    padding: '10px 12px', borderRadius: 10,
    background: 'var(--bg, var(--bg, #FBF6F1))', marginBottom: 10,
  },
  messageText: {
    fontSize: 12, color: 'var(--text, #241B17)', lineHeight: 1.5, margin: 0,
  },
  cardActions: { display: 'flex', gap: 8 },
  sendBtn: {
    flex: 1, padding: '9px 0', borderRadius: 10, border: 'none',
    background: 'var(--accent, #92405e)', color: 'var(--bg-card, #FFFCF9)', fontSize: 13, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  editBtn: {
    padding: '9px 16px', borderRadius: 10, border: '1px solid var(--border, #E8DDD4)',
    background: 'var(--card-bg, #FFFCF9)', color: 'var(--text, #241B17)',
    fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit',
  },
  sentBadge: {
    fontSize: 13, fontWeight: 600, color: 'var(--success, #386F52)',
    display: 'flex', alignItems: 'center', gap: 4,
  },
  bulkBtn: {
    width: '100%', padding: '13px 0', marginTop: 16, borderRadius: 10,
    border: 'none', background: 'linear-gradient(135deg, var(--accent, #92405e), var(--accent-hover, #782b49))',
    color: 'var(--bg-card, #FFFCF9)', fontSize: 14, fontWeight: 700, cursor: 'pointer',
    fontFamily: 'inherit', boxShadow: 'var(--elev-2)',
  },
  empty: { textAlign: 'center', padding: '32px 20px' },
  emptyText: { fontSize: 13, color: 'var(--text-muted, #6B5D54)' },
  // Settings
  settingsSection: { display: 'flex', flexDirection: 'column', gap: 12 },
  toggleRow: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '14px 16px', background: 'var(--card-bg, #FFFCF9)', borderRadius: 16,
    border: '1px solid var(--border, #E8DDD4)',
  },
  toggleLabel: { display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--text, #241B17)' },
  toggleDesc: { display: 'block', fontSize: 12, color: 'var(--text-muted, #6B5D54)', marginTop: 2 },
  toggle: {
    width: 44, height: 26, borderRadius: 16, border: 'none',
    cursor: 'pointer', position: 'relative', flexShrink: 0, transition: 'background 0.2s', background: 'var(--accent, #92405e)',
  },
  toggleThumb: {
    width: 22, height: 22, borderRadius: 10, background: 'var(--bg-card, #FFFCF9)',
    position: 'absolute', top: 2, transition: 'transform 0.2s',
    boxShadow: 'var(--elev-1)',
  },
  settingCard: {
    background: 'var(--card-bg, #FFFCF9)', borderRadius: 16, padding: 16,
    border: '1px solid var(--border, #E8DDD4)',
  },
  settingLabel: { display: 'block', fontSize: 14, fontWeight: 600, color: 'var(--text, #241B17)', marginBottom: 4 },
  settingDesc: { display: 'block', fontSize: 12, color: 'var(--text-muted, #6B5D54)', marginBottom: 10 },
  chipRow: { display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 8 },
  intervalChip: {
    padding: '8px 14px', borderRadius: 10, fontSize: 13, fontWeight: 500,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  templatePreview: {
    padding: '10px 0', borderBottom: '1px solid var(--border, #E8DDD4)',
  },
  templatePreviewName: { display: 'block', fontSize: 13, fontWeight: 600, color: 'var(--accent, #92405e)', marginBottom: 4 },
  templatePreviewBody: { fontSize: 12, color: 'var(--text, #241B17)', lineHeight: 1.5, margin: 0 },
};
