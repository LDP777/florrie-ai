import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabase.js';
import { useBeautician } from '../lib/supabase.js';
import logger from '../lib/logger.js';
import { localDateStr } from '../lib/dates.js';

const MONTHLY_LIMIT = 120;
const SURPLUS_RATE_PENCE = 7;

function getMonthBounds() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const start = localDateStr(new Date(year, month, 1));
  const end = localDateStr(new Date(year, month + 1, 0));
  const name = now.toLocaleString('en-GB', { month: 'long' });
  return { start, end, name };
}

export default function SMSUsageWidget() {
  const { beautician } = useBeautician();
  const [usage, setUsage] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (beautician?.id) {
      fetchUsage();
      const interval = setInterval(fetchUsage, 30000);
      return () => clearInterval(interval);
    }
  }, [beautician?.id]);

  async function fetchUsage() {
    try {
      const { start, end } = getMonthBounds();

      const { data, error } = await supabase
        .from('sms_usage')
        .select('messages_sent, surplus_count, surplus_total_pence')
        .eq('beautician_id', beautician.id)
        .gte('week_start', start)
        .lte('week_start', end);

      if (error) {
        logger.warn({ error }, 'Failed to fetch SMS usage');
        setLoading(false);
        return;
      }

      const rows = data || [];
      const messagesSent = rows.reduce((sum, r) => sum + (r.messages_sent || 0), 0);
      const surplusCount = rows.reduce((sum, r) => sum + (r.surplus_count || 0), 0);
      const surplusTotalPence = rows.reduce((sum, r) => sum + (r.surplus_total_pence || 0), 0);
      const freeRemaining = Math.max(0, MONTHLY_LIMIT - messagesSent);
      const percentUsed = Math.min(100, (messagesSent / MONTHLY_LIMIT) * 100);

      setUsage({
        messagesSent,
        freeRemaining,
        surplusCount,
        surplusTotalPence,
        percentUsed,
        isSurplus: messagesSent > MONTHLY_LIMIT,
      });

      setLoading(false);
    } catch (err) {
      logger.error({ err }, 'SMS usage widget error');
      setLoading(false);
    }
  }

  if (loading) {
    return (
      <div style={styles.widget}>
        <div style={styles.skeletonBar} />
      </div>
    );
  }

  if (!usage) return null;

  const { name: monthName } = getMonthBounds();
  const surplusStr = usage.surplusTotalPence > 0
    ? `£${(usage.surplusTotalPence / 100).toFixed(2)}`
    : '£0.00';

  return (
    <div style={styles.widget}>
      <div style={styles.header}>
        <h3 style={styles.title}>SMS this month</h3>
        <span style={{ ...styles.badge,
          color: usage.isSurplus ? 'var(--danger)' : 'var(--accent)',
          background: usage.isSurplus ? 'var(--danger-light, #fee2e2)' : 'var(--accent-light)',
        }}>
          {usage.messagesSent}/{MONTHLY_LIMIT}
        </span>
      </div>

      <div style={styles.progressContainer}>
        <div style={styles.progressBg}>
          <div
            style={{ ...styles.progressFill,
              width: `${usage.percentUsed}%`,
              backgroundColor: usage.isSurplus ? 'var(--danger)' : 'var(--accent)',
            }}
          />
        </div>
      </div>

      <div style={styles.status}>
        {!usage.isSurplus ? (
          <p style={styles.goodStatus}>
            {usage.freeRemaining} of {MONTHLY_LIMIT} messages remaining in {monthName}
          </p>
        ) : (
          <div>
            <p style={styles.warnText}>
              {usage.surplusCount} surplus messages this month
            </p>
            <p style={styles.costText}>
              Overage charges: {surplusStr}
            </p>
          </div>
        )}
      </div>

      <div style={styles.details}>
        <div style={styles.detailRow}>
          <span style={styles.detailLabel}>Plan includes</span>
          <span style={styles.detailValue}>120 SMS/month</span>
        </div>
        <div style={styles.detailRow}>
          <span style={styles.detailLabel}>Resets</span>
          <span style={styles.detailValue}>1st of each month</span>
        </div>
        <div style={styles.detailRow}>
          <span style={styles.detailLabel}>Surplus rate</span>
          <span style={styles.detailValue}>{SURPLUS_RATE_PENCE}p per message</span>
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
  skeletonBar: {
    height: 12,
    background: 'var(--border-light)',
    borderRadius: 6,
    animation: 'shimmer 1.5s infinite',
  },
};
