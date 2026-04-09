import { useState, useEffect } from 'react';
import { useBeautician, supabase, isDevMode, updateRow } from '../lib/supabase.js';
import { API_BASE } from '../lib/config.js';
import logger from '../lib/logger.js';

/**
 * Approval Queue — actions Florrie queued because confidence was below threshold.
 *
 * Reads from `ai_actions` where status = 'pending_approval'.
 * Each card shows what Florrie wants to do + why, with Approve / Edit / Dismiss.
 *
 * Action types:
 *   rebook_nudge — SMS nudge to an overdue client
 *   gap_post     — social media availability post
 *   auto_reply   — message Florrie drafted but wasn't confident enough to send
 */

const ACTION_META = {
  rebook_nudge:     { label: 'Rebook Nudge', icon: '🔄', color: 'var(--accent)' },
  predictive_nudge: { label: 'Smart Nudge', icon: '🔮', color: 'var(--gold)' },
  gap_post:         { label: 'Availability Post', icon: '📅', color: 'var(--gold)' },
  auto_reply:       { label: 'Auto Reply', icon: '💬', color: 'var(--success)' },
  message:          { label: 'Message', icon: '✉️', color: 'var(--text-secondary)' },
};

export default function ApprovalQueue() {
  const { beautician, loading: bLoading } = useBeautician();
  const [actions, setActions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(null);

  useEffect(() => {
    if (beautician) loadQueue();
  }, [beautician]);

  async function loadQueue() {
    setLoading(true);
    try {
      if (isDevMode) {
        setActions(DEV_QUEUE);
        setLoading(false);
        return;
      }

      const { data, error } = await supabase
        .from('ai_actions')
        .select('*, clients(first_name, last_name, phone)')
        .eq('beautician_id', beautician.id)
        .eq('status', 'pending_approval')
        .order('created_at', { ascending: false })
        .limit(30);

      if (error) logger.error('ApprovalQueue load error:', error);
      setActions(data || []);
    } catch (err) {
      logger.error('Failed to load approval queue:', err);
    } finally {
      setLoading(false);
    }
  }

  async function handleAction(actionId, decision) {
    setProcessing(actionId);
    try {
      const newStatus = decision === 'approve' ? 'executed'
        : decision === 'dismiss' ? 'dismissed'
        : 'executed';

      await updateRow('ai_actions', actionId, {
        status: newStatus,
        resolved_at: new Date().toISOString(),
      });

      // If approved, trigger the actual action via API
      if (decision === 'approve') {
        try {
          await fetch(`${API_BASE}/api/ai-actions/` + actionId + '/execute', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
          });
        } catch (err) {
          logger.warn('Execute API call failed (action still marked executed):', err);
        }
      }

      setActions(prev => prev.filter(a => a.id !== actionId));
    } catch (err) {
      logger.error('Failed to process action:', err);
    } finally {
      setProcessing(null);
    }
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

  function confidenceLabel(score) {
    if (score >= 0.85) return { text: 'High', color: 'var(--success)' };
    if (score >= 0.70) return { text: 'Medium', color: 'var(--gold)' };
    return { text: 'Low', color: 'var(--danger)' };
  }

  if (bLoading || loading) {
    return <div style={styles.page}><div style={styles.loading}>Loading...</div></div>;
  }

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div>
          <h1 style={styles.title}>Florrie's Queue</h1>
          <p style={styles.subtitle}>Actions waiting for your approval</p>
        </div>
        {actions.length > 0 && (
          <span style={styles.badge}>{actions.length}</span>
        )}
      </div>

      {actions.length === 0 ? (
        <div style={styles.emptyState}>
          <span style={{ fontSize: 36, marginBottom: 12, display: 'block' }}>✅</span>
          <p style={styles.emptyTitle}>Queue's clear</p>
          <p style={styles.emptyDesc}>
            Florrie's handled everything herself. When she's unsure, actions will appear here for your sign-off.
          </p>
        </div>
      ) : (
        <div style={styles.list}>
          {actions.map(action => {
            const meta = ACTION_META[action.action_type] || ACTION_META.message;
            const conf = confidenceLabel(action.confidence || 0);
            const clientName = action.clients
              ? `${action.clients.first_name || ''} ${action.clients.last_name || ''}`.trim()
              : null;

            return (
              <div key={action.id} style={styles.card}>
                {/* Top row: type + time */}
                <div style={styles.cardTop}>
                  <div style={styles.typeBadge}>
                    <span style={{ marginRight: 6 }}>{meta.icon}</span>
                    <span style={{ color: meta.color, fontWeight: 600, fontSize: 12 }}>{meta.label}</span>
                  </div>
                  <span style={styles.time}>{timeAgo(action.created_at)}</span>
                </div>

                {/* Client name if present */}
                {clientName && (
                  <p style={styles.clientName}>{clientName}</p>
                )}

                {/* Summary */}
                <p style={styles.summary}>{action.summary}</p>

                {/* Confidence bar */}
                <div style={styles.confRow}>
                  <span style={styles.confLabel}>Confidence</span>
                  <div style={styles.confBarBg}>
                    <div style={{
                      ...styles.confBarFill,
                      width: `${(action.confidence || 0) * 100}%`,
                      background: conf.color,
                    }} />
                  </div>
                  <span style={{ ...styles.confValue, color: conf.color }}>
                    {Math.round((action.confidence || 0) * 100)}%
                  </span>
                </div>

                {/* Actions */}
                <div style={styles.actions}>
                  <button
                    onClick={() => handleAction(action.id, 'approve')}
                    disabled={processing === action.id}
                    style={styles.approveBtn}
                  >
                    {processing === action.id ? '...' : 'Approve'}
                  </button>
                  <button
                    onClick={() => handleAction(action.id, 'dismiss')}
                    disabled={processing === action.id}
                    style={styles.dismissBtn}
                  >
                    Dismiss
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Dev sample data ──
const DEV_QUEUE = [
  {
    id: 'aq-1',
    action_type: 'rebook_nudge',
    summary: 'Daisy S is 8 days overdue for her usual lash infill. Send a nudge SMS?',
    confidence: 0.78,
    status: 'pending_approval',
    digital_employee: 'comeback',
    created_at: new Date(Date.now() - 35 * 60000).toISOString(),
    clients: { first_name: 'Daisy', last_name: 'S', phone: '+447700123456' },
  },
  {
    id: 'aq-2',
    action_type: 'gap_post',
    summary: 'Wednesday has 3 hours of gaps. Draft an availability post for Instagram?',
    confidence: 0.72,
    status: 'pending_approval',
    digital_employee: 'calendar',
    created_at: new Date(Date.now() - 90 * 60000).toISOString(),
    clients: null,
  },
  {
    id: 'aq-3',
    action_type: 'rebook_nudge',
    summary: 'Chloe B hasn\'t been in for 6 weeks (usually every 4). Send a rebook reminder?',
    confidence: 0.82,
    status: 'pending_approval',
    digital_employee: 'comeback',
    created_at: new Date(Date.now() - 150 * 60000).toISOString(),
    clients: { first_name: 'Chloe', last_name: 'B', phone: '+447700654321' },
  },
];

const styles = {
  page: {
    minHeight: '100vh',
    background: 'var(--bg)',
    fontFamily: '"DM Sans", -apple-system, sans-serif',
    padding: '0 16px 40px',
    maxWidth: 480,
    margin: '0 auto',
    color: 'var(--text-primary)',
    animation: 'fadeIn 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    paddingTop: 28,
    paddingBottom: 16,
  },
  title: {
    fontSize: 22,
    fontWeight: 700,
    margin: 0,
    fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)",
  },
  subtitle: {
    fontSize: 13,
    color: 'var(--text-secondary)',
    margin: '4px 0 0',
  },
  badge: {
    background: 'var(--accent)',
    color: '#fff',
    fontSize: 13,
    fontWeight: 700,
    minWidth: 26,
    height: 26,
    borderRadius: 13,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0 8px',
    marginTop: 4,
  },
  loading: { textAlign: 'center', padding: 60, color: 'var(--text-muted)' },
  list: { display: 'flex', flexDirection: 'column', gap: 12 },
  card: {
    background: 'var(--bg-card)',
    borderRadius: 14,
    padding: 18,
    boxShadow: 'var(--shadow-xs)',
  },
  cardTop: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 10,
  },
  typeBadge: {
    display: 'flex',
    alignItems: 'center',
    padding: '3px 10px',
    borderRadius: 6,
    background: 'var(--bg-hover)',
    fontSize: 12,
  },
  time: { fontSize: 12, color: 'var(--text-muted)' },
  clientName: {
    fontSize: 15,
    fontWeight: 600,
    margin: '0 0 6px',
  },
  summary: {
    fontSize: 14,
    lineHeight: 1.55,
    margin: '0 0 14px',
    color: 'var(--text-primary)',
  },
  confRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    marginBottom: 14,
  },
  confLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    flexShrink: 0,
  },
  confBarBg: {
    flex: 1,
    height: 6,
    borderRadius: 3,
    background: 'var(--border)',
    overflow: 'hidden',
  },
  confBarFill: {
    height: '100%',
    borderRadius: 3,
    transition: 'width 0.3s ease',
  },
  confValue: {
    fontSize: 12,
    fontWeight: 700,
    flexShrink: 0,
    minWidth: 36,
    textAlign: 'right',
  },
  actions: { display: 'flex', gap: 8 },
  approveBtn: {
    flex: 1,
    padding: '10px 0',
    borderRadius: 10,
    border: 'none',
    background: 'var(--success)',
    color: '#fff',
    fontSize: 13,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  dismissBtn: {
    padding: '10px 16px',
    borderRadius: 10,
    border: 'none',
    background: 'var(--bg-hover)',
    color: 'var(--text-muted)',
    fontSize: 13,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  emptyState: { textAlign: 'center', padding: '60px 20px' },
  emptyTitle: { fontSize: 17, fontWeight: 600, margin: '0 0 6px' },
  emptyDesc: {
    fontSize: 13,
    color: 'var(--text-muted)',
    margin: 0,
    lineHeight: 1.5,
    maxWidth: 280,
    marginInline: 'auto',
  },
};
