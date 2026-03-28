import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase.js';
import logger from '../lib/logger.js';

export default function SMSUsageWidget() {
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchUsage();
    const interval = setInterval(fetchUsage, 30000);
    return () => clearInterval(interval);
  }, []);

  async function fetchUsage() {
    try {
      const { data, error } = await supabase
        .from('sms_usage')
        .select('*')
        .single();

      if (error && error.code !== 'PGRST116') {
        logger.warn({ error }, 'Failed to fetch SMS usage');
        setLoading(false);
        return;
      }

      if (data) {
        const freeRemaining = Math.max(0, data.free_limit - data.messages_sent);
        const percentUsed = (data.messages_sent / data.free_limit) * 100;

        setUsage({
          messagesSent: data.messages_sent,
          freeLimit: data.free_limit,
          freeRemaining,
          surplusCount: data.surplus_count,
          surplusTotalPence: data.surplus_total_pence,
          percentUsed: Math.min(100, percentUsed),
        });
      } else {
        setUsage({
          messagesSent: 0,
          freeLimit: 50,
          freeRemaining: 50,
          surplusCount: 0,
          surplusTotalPence: 0,
          percentUsed: 0,
        });
      }

      setLoading(false);
    } catch (err) {
      logger.error({ err }, 'SMS usage widget error');
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div style={styles.skeleton}>
        <div style={styles.skeletonBar} />
      </div>
    );
  }

  if (!usage) return null;

  const isSurplus = usage.messagesSent > usage.freeLimit;
  const surplusStr = usage.surplusTotalPence > 0
    ? `£${(usage.surplusTotalPence / 100).toFixed(2)}`
    : '£0.00';

  return (
    <div style={styles.widget}>
      <div style={styles.header}>
        <h3 style={styles.title}>SMS this week</h3>
        <span style={styles.badge}>{usage.messagesSent}/{usage.freeLimit}</span>
      </div>

      {/* Progress bar */}
      <div style={styles.progressContainer}>
        <div style={styles.progressBg}>
          <div
            style={{
              ...styles.progressFill,
              width: `${usage.percentUsed}%`,
              backgroundColor: isSurplus ? 'var(--danger)' : 'var(--accent)',
            }}
          />
        </div>
      </div>

      {/* Status text */}
      <div style={styles.status}>
        {!isSurplus ? (
          <p style={styles.goodStatus}>
            {usage.freeRemaining} free SMS remaining
          </p>
        ) : (
          <div>
            <p style={styles.warnText}>
              {usage.surplusCount} surplus texts
            </p>
            <p style={styles.costText}>
              Charges: {surplusStr} this week
            </p>
          </div>
        )}
      </div>

      {/* Details */}
      <div style={styles.details}>
        <div style={styles.detailRow}>
          <span style={styles.detailLabel}>Free limit</span>
          <span style={styles.detailValue}>50/week (resets Mon)</span>
        </div>
        <div style={styles.detailRow}>
          <span style={styles.detailLabel}>Surplus rate</span>
          <span style={styles.detailValue}>6p per text</span>
        </div>
      </div>
    </div>
  );
}

const styles = {
  widget: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
    boxShadow: 'var(--shadow-xs)',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 12,
  },
  title: {
    margin: 0,
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--text-primary)',
  },
  badge: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--accent)',
    background: 'var(--accent-light)',
    padding: '4px 10px',
    borderRadius: 8,
  },
  progressContainer: {
    marginBottom: 12,
  },
  progressBg: {
    height: 6,
    background: 'var(--border-light)',
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 3,
    transition: 'width 0.3s ease',
  },
  status: {
    marginBottom: 12,
  },
  goodStatus: {
    margin: 0,
    fontSize: 13,
    color: 'var(--success)',
    fontWeight: 500,
  },
  warnText: {
    margin: '0 0 4px',
    fontSize: 13,
    color: 'var(--danger)',
    fontWeight: 600,
  },
  costText: {
    margin: 0,
    fontSize: 12,
    color: 'var(--danger-text, var(--danger))',
  },
  details: {
    borderTop: '1px solid var(--border-light)',
    paddingTop: 12,
  },
  detailRow: {
    display: 'flex',
    justifyContent: 'space-between',
    marginBottom: 6,
    fontSize: 12,
    color: 'var(--text-muted)',
  },
  detailLabel: {
    fontWeight: 500,
  },
  detailValue: {
    color: 'var(--text-secondary)',
    fontWeight: 500,
  },
  skeleton: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border)',
    borderRadius: 14,
    padding: 16,
    marginBottom: 12,
  },
  skeletonBar: {
    height: 12,
    background: 'var(--border-light)',
    borderRadius: 6,
    animation: 'shimmer 1.5s infinite',
  },
};
