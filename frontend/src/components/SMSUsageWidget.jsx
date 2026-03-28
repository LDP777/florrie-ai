import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase.js';
import logger from '../lib/logger.js';

const BRAND_COLOR = '#C4A882'; // dusty rose accent

export default function SMSUsageWidget() {
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchUsage();
    // Refresh every 30 seconds (user might send SMS from elsewhere)
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
        // No usage yet this week
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
        <h3 style={styles.title}>SMS This Week</h3>
        <span style={styles.badge}>{usage.messagesSent}/{usage.freeLimit}</span>
      </div>

      {/* Progress bar */}
      <div style={styles.progressContainer}>
        <div style={styles.progressBg}>
          <div
            style={{
              ...styles.progressFill,
              width: `${usage.percentUsed}%`,
              backgroundColor: isSurplus ? '#EF4444' : BRAND_COLOR,
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
          <div style={styles.warnStatus}>
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
          <span style={styles.detailLabel}>Free limit:</span>
          <span style={styles.detailValue}>50/week (resets Mon)</span>
        </div>
        <div style={styles.detailRow}>
          <span style={styles.detailLabel}>Surplus rate:</span>
          <span style={styles.detailValue}>2p per text</span>
        </div>
      </div>
    </div>
  );
}

const styles = {
  widget: {
    backgroundColor: '#ffffff',
    border: `1px solid #E5E7EB`,
    borderRadius: '10px',
    padding: '16px',
    marginBottom: '16px',
    boxShadow: '0 1px 2px rgba(0,0,0,0.05)',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '12px',
  },
  title: {
    margin: '0',
    fontSize: '14px',
    fontWeight: '600',
    color: '#1F2937',
  },
  badge: {
    fontSize: '13px',
    fontWeight: '600',
    color: BRAND_COLOR,
    backgroundColor: 'rgba(196, 168, 130, 0.1)',
    padding: '4px 8px',
    borderRadius: '6px',
  },
  progressContainer: {
    marginBottom: '12px',
  },
  progressBg: {
    height: '8px',
    backgroundColor: '#F3F4F6',
    borderRadius: '4px',
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    transition: 'width 0.3s ease',
  },
  status: {
    marginBottom: '12px',
  },
  goodStatus: {
    margin: '0',
    fontSize: '13px',
    color: '#059669',
    fontWeight: '500',
  },
  warnStatus: {
    margin: '0',
  },
  warnText: {
    margin: '0 0 4px 0',
    fontSize: '13px',
    color: '#DC2626',
    fontWeight: '600',
  },
  costText: {
    margin: '0',
    fontSize: '12px',
    color: '#7F1D1D',
  },
  details: {
    borderTop: '1px solid #F3F4F6',
    paddingTop: '12px',
    fontSize: '12px',
  },
  detailRow: {
    display: 'flex',
    justifyContent: 'space-between',
    marginBottom: '6px',
    color: '#6B7280',
  },
  detailLabel: {
    fontWeight: '500',
  },
  detailValue: {
    color: '#1F2937',
  },
  skeleton: {
    backgroundColor: '#ffffff',
    border: `1px solid #E5E7EB`,
    borderRadius: '10px',
    padding: '16px',
    marginBottom: '16px',
  },
  skeletonBar: {
    height: '12px',
    backgroundColor: '#F3F4F6',
    borderRadius: '6px',
    animation: 'pulse 2s infinite',
  },
};
