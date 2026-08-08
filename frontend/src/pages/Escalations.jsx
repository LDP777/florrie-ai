import { useState, useEffect } from 'react';
import { useBeautician, supabase, updateRow } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import PageHeader from '../components/ui/PageHeader.jsx';
import Icon from '../components/ui/Icon';

/**
 * Escalations - the "needs your attention" inbox.
 *
 * When the AI Front Desk isn't confident enough (below threshold),
 * it drafts a suggested response and puts it here.
 *
 * Actions:
 *   Send as-is   - AI nailed it, one tap
 *   Edit & send  - correct tone/content (feeds into tone model)
 *   Dismiss      - ignore the message
 *
 * Reads from `messages` table where escalated=true, resolved=false.
 * Resolving updates the message row directly via Supabase.
 */

export default function Escalations() {
  const { beautician, loading: bLoading } = useBeautician();
  const [escalations, setEscalations] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState('');
  const [sending, setSending] = useState(null);

  useEffect(() => {
    if (beautician) loadEscalations();
  }, [beautician]);

  async function loadEscalations() {
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from('messages')
        .select('*, clients(first_name, last_name)')
        .eq('beautician_id', beautician.id)
        .eq('escalated', true)
        .eq('resolved', false)
        .eq('direction', 'inbound')
        .order('created_at', { ascending: false });

      if (error) logger.error('Escalations load error:', error);
      setEscalations(data || []);
    } catch (err) {
      logger.error('Failed to load escalations:', err);
    } finally {
      setLoading(false);
    }
  }

  async function resolve(messageId, action, editedResponse) {
    setSending(messageId);
    try {
      const updates = {
        resolved: true,
        resolved_at: new Date().toISOString(),
      };

      // If edited, store the correction for tone learning
      if (action === 'send_edited' && editedResponse) {
        updates.ai_response = editedResponse;
      }

      await updateRow('messages', messageId, updates);

      // Send the response via SMS (Twilio)
      if (action === 'send_as_is' || action === 'send_edited') {
        const message = action === 'send_edited' ? editedResponse :
          escalations.find(e => e.id === messageId)?.ai_response;

        if (message) {
          const response = await fetch(`${API_BASE}/api/escalations/${messageId}/resolve`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              response: message,
              action: action
            })
          });

          if (!response.ok) {
            logger.error('Failed to send message via API');
          }
        }
      }

      setEscalations(prev => prev.filter(e => e.id !== messageId));
      setEditingId(null);
    } catch (err) {
      logger.error('Resolve error:', err);
    } finally {
      setSending(null);
    }
  }

  function startEdit(msg) {
    setEditingId(msg.id);
    setEditText(msg.ai_response || '');
  }

  function timeAgo(dateStr) {
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    return `${Math.floor(hrs / 24)}d ago`;
  }

  if (bLoading || loading) {
    return <div style={styles.page}><div style={styles.loading}>Loading...</div></div>;
  }

  return (
    <div style={styles.page}>
      <PageHeader
        title="Needs Your Attention"
        action={escalations.length > 0 ? <span style={styles.badge}>{escalations.length}</span> : null}
      />

      {escalations.length === 0 ? (
        <div style={styles.emptyState}>
          <span style={{ fontSize: 36, marginBottom: 12, display: 'block' }}><Icon name="sparkles" size={36} /></span>
          <p style={styles.emptyTitle}>All clear</p>
          <p style={styles.emptyDesc}>
            Florrie is handling everything. You'll see messages here when she needs your input.
          </p>
        </div>
      ) : (
        <div style={styles.list}>
          {escalations.map(msg => (
            <div key={msg.id} style={styles.card}>
              {/* Client info + time */}
              <div style={styles.cardHeader}>
                <div style={styles.clientInfo}>
                  <span style={styles.clientName}>
                    {msg.clients?.first_name || 'Unknown'} {msg.clients?.last_name || ''}
                  </span>
                  <span style={styles.channel}>
                    {msg.channel === 'whatsapp' ? 'WhatsApp' : msg.channel === 'instagram' ? 'Instagram' : msg.channel}
                  </span>
                </div>
                <span style={styles.time}>{timeAgo(msg.created_at)}</span>
              </div>

              {/* Why it was escalated */}
              <div style={styles.reasonBadge}>
                {msg.escalated_reason || 'Needs review'}
              </div>

              {/* Their message */}
              <div style={styles.inboundBubble}>
                <span style={styles.bubbleLabel}>They said:</span>
                <p style={styles.bubbleText}>{msg.content}</p>
              </div>

              {/* AI suggestion */}
              {msg.ai_response && editingId !== msg.id && (
                <div style={styles.suggestionBubble}>
                  <span style={styles.bubbleLabel}>Florrie suggests:</span>
                  <p style={styles.bubbleText}>{msg.ai_response}</p>
                </div>
              )}

              {/* Editing mode */}
              {editingId === msg.id && (
                <div style={styles.editContainer}>
                  <textarea
                    value={editText}
                    onChange={e => setEditText(e.target.value)}
                    style={styles.editTextarea}
                    rows={3}
                    autoFocus
                  />
                  <div style={styles.editActions}>
                    <button
                      onClick={() => resolve(msg.id, 'send_edited', editText)}
                      disabled={sending === msg.id || !editText.trim()}
                      style={{ ...styles.sendBtn, opacity: sending === msg.id ? 0.5 : 1 }}
                    >
                      {sending === msg.id ? 'Sending...' : 'Send'}
                    </button>
                    <button onClick={() => setEditingId(null)} style={styles.cancelBtn}>
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* Action buttons */}
              {editingId !== msg.id && (
                <div style={styles.actions}>
                  {msg.ai_response && (
                    <button
                      onClick={() => resolve(msg.id, 'send_as_is')}
                      disabled={sending === msg.id}
                      style={styles.approveBtn}
                    >
                      {sending === msg.id ? '...' : 'Send as-is'}
                    </button>
                  )}
                  <button onClick={() => startEdit(msg)} style={styles.editBtn}>
                    Edit & send
                  </button>
                  <button onClick={() => resolve(msg.id, 'dismiss')} style={styles.dismissBtn}>
                    Dismiss
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const DEV_ESCALATIONS = [
  {
    id: 'dev-esc-1',
    content: "Hiya, do you do semi permanent brows? And how much roughly? Xx",
    ai_response: "Hey lovely! Yes I do ombre brows and combination brows - ombre is £250 and combo is £300, both include a 6-week top up. Want me to get you booked in? xx",
    ai_confidence: 0.72,
    escalated: true,
    escalated_reason: 'Low confidence - multi-question message',
    resolved: false,
    channel: 'instagram',
    direction: 'inbound',
    created_at: new Date(Date.now() - 25 * 60000).toISOString(),
    clients: { first_name: 'Sophie', last_name: 'M' },
  },
  {
    id: 'dev-esc-2',
    content: "Hi, I need to cancel my appointment tomorrow, something's come up. Sorry x",
    ai_response: null,
    ai_confidence: 0.45,
    escalated: true,
    escalated_reason: 'Cancellation - needs human review',
    resolved: false,
    channel: 'whatsapp',
    direction: 'inbound',
    created_at: new Date(Date.now() - 90 * 60000).toISOString(),
    clients: { first_name: 'Amy', last_name: '' },
  },
];

const styles = {
  page: {
    minHeight: 'var(--shell-viewport)',
    background: 'var(--bg)',
    fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif",
    padding: '0 16px var(--scroll-pad-bottom)',
    maxWidth: 480,
    margin: '0 auto',
    color: 'var(--text-primary)'
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    paddingTop: 28,
    paddingBottom: 16
  },
  title: { fontSize: 22, fontWeight: 700, margin: 0 },
  badge: {
    background: 'var(--danger)',
    color: 'var(--bg-card, #FFFCF9)',
    fontSize: 12,
    fontWeight: 700,
    width: 24,
    height: 24,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center'
  },
  loading: { textAlign: 'center', padding: 60, color: 'var(--text-muted)' },
  list: { display: 'flex', flexDirection: 'column', gap: 12 },
  card: {
    background: 'var(--bg-card)',
    borderRadius: 14,
    padding: 18,
    boxShadow: 'var(--shadow-xs)'
  },
  cardHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 8
  },
  clientInfo: { display: 'flex', flexDirection: 'column', gap: 2 },
  clientName: { fontSize: 15, fontWeight: 600 },
  channel: { fontSize: 11, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.04em' },
  time: { fontSize: 12, color: 'var(--text-secondary)' },
  reasonBadge: {
    display: 'inline-block',
    padding: '4px 10px',
    borderRadius: 6,
    fontSize: 11,
    fontWeight: 500,
    background: 'var(--warning-bg)',
    color: 'var(--warning-text)',
    marginBottom: 12
  },
  inboundBubble: {
    background: 'var(--bg-subtle)',
    borderRadius: 12,
    padding: '10px 14px',
    marginBottom: 8
  },
  suggestionBubble: {
    background: 'var(--bg-hover)',
    borderRadius: 12,
    padding: '10px 14px',
    marginBottom: 12,
    borderLeft: '3px solid var(--accent)'
  },
  bubbleLabel: {
    fontSize: 10,
    fontWeight: 600,
    color: 'var(--text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    display: 'block',
    marginBottom: 4
  },
  bubbleText: { fontSize: 14, lineHeight: 1.5, margin: 0 },
  editContainer: { marginBottom: 12 },
  editTextarea: {
    width: '100%',
    padding: '12px 14px',
    borderRadius: 10,
    border: '1.5px solid var(--gold)',
    fontSize: 14,
    fontFamily: 'inherit',
    resize: 'vertical',
    outline: 'none',
    lineHeight: 1.5,
    boxSizing: 'border-box',
    background: 'var(--bg-card)'
  },
  editActions: { display: 'flex', gap: 8, marginTop: 8 },
  sendBtn: {
    padding: '10px 20px',
    borderRadius: 10,
    border: 'none',
    background: 'var(--gold)',
    color: 'var(--bg-card, #FFFCF9)',
    fontSize: 14,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit'
  },
  cancelBtn: {
    padding: '10px 16px',
    borderRadius: 10,
    border: 'none',
    background: 'var(--bg-subtle)',
    color: 'var(--text-secondary)',
    fontSize: 14,
    cursor: 'pointer',
    fontFamily: 'inherit'
  },
  actions: { display: 'flex', gap: 8 },
  approveBtn: {
    flex: 1,
    padding: '10px 0',
    borderRadius: 10,
    border: 'none',
    background: 'var(--success)',
    color: 'var(--bg-card, #FFFCF9)',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit'
  },
  editBtn: {
    flex: 1,
    padding: '10px 0',
    borderRadius: 10,
    border: 'none',
    background: 'var(--bg-hover)',
    color: 'var(--accent)',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit'
  },
  dismissBtn: {
    padding: '10px 14px',
    borderRadius: 10,
    border: 'none',
    background: 'var(--bg-subtle)',
    color: 'var(--text-muted)',
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'inherit'
  },
  emptyState: { textAlign: 'center', padding: '60px 20px' },
  emptyTitle: { fontSize: 17, fontWeight: 600, margin: '0 0 6px' },
  emptyDesc: { fontSize: 13, color: 'var(--text-muted)', margin: 0, lineHeight: 1.5, maxWidth: 280, marginInline: 'auto' }
};
