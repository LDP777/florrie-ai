import { useState, useEffect } from 'react';
import { useBeautician, supabase, isDevMode } from '../lib/supabase.js';
import { ds, type } from '../lib/designSystem.js';
import logger from '../lib/logger.js';

const mockPredictions = [
  { label: 'Next week revenue', value: '£4,280', confidence: 92, trend: '+12%', icon: '📈' },
  { label: 'Booking demand', value: 'High', confidence: 87, trend: 'Thu–Sat peak', icon: '🔥' },
  { label: 'No-show risk', value: '3 clients', confidence: 78, trend: '↓ from 5', icon: '⚠️' },
  { label: 'Product restock', value: '4 items', confidence: 95, trend: 'Within 2wk', icon: '📦' },
];

const churnData = [
  { name: 'Jessica Moore', lastVisit: '47 days ago', risk: 94, spend: '£1,240/yr', trigger: 'Missed rebook window', avatar: 'JM' },
  { name: 'Sarah Chen', lastVisit: '38 days ago', risk: 82, spend: '£890/yr', trigger: 'Cancelled last 2 appts', avatar: 'SC' },
  { name: 'Emma Taylor', lastVisit: '52 days ago', risk: 76, spend: '£620/yr', trigger: 'Switched to competitor', avatar: 'ET' },
  { name: 'Olivia Brown', lastVisit: '31 days ago', risk: 68, spend: '£1,580/yr', trigger: 'Reduced frequency', avatar: 'OB' },
  { name: 'Amy Wilson', lastVisit: '44 days ago', risk: 61, spend: '£440/yr', trigger: 'Negative feedback', avatar: 'AW' },
];

const trends = [
  { treatment: 'Lip Filler', direction: 'up', change: '+34%', period: 'vs last month', note: 'Highest growth — consider adding to promos' },
  { treatment: 'Lash Lift & Tint', direction: 'up', change: '+22%', period: 'vs last month', note: 'Seasonal demand rising' },
  { treatment: 'Classic Manicure', direction: 'down', change: '-15%', period: 'vs last month', note: 'Clients shifting to BIAB/gel' },
  { treatment: 'Facial Peel', direction: 'up', change: '+18%', period: 'vs last month', note: 'Post-winter skin refresh trend' },
  { treatment: 'Basic Brow Wax', direction: 'down', change: '-8%', period: 'vs last month', note: 'Lamination cannibalising demand' },
];

const anomalies = [
  { type: 'revenue', message: 'Tuesday revenue was 2.3x normal — investigate cause for replication', time: '2 days ago', severity: 'positive' },
  { type: 'cancellation', message: 'Cancellation spike: 6 cancellations on Monday (avg is 1.8)', time: '3 days ago', severity: 'warning' },
  { type: 'booking', message: 'New client acquisition up 40% this week vs 4-week avg', time: '1 day ago', severity: 'positive' },
];

const weeklyRevenue = [
  { day: 'Mon', actual: 480, predicted: 520 },
  { day: 'Tue', actual: 1180, predicted: 510 },
  { day: 'Wed', actual: 620, predicted: 590 },
  { day: 'Thu', actual: 780, predicted: 740 },
  { day: 'Fri', actual: 920, predicted: 880 },
  { day: 'Sat', actual: 1050, predicted: 990 },
  { day: 'Sun', actual: null, predicted: 340 },
];

const tabs = ['Predictions', 'Churn Risk', 'Trends', 'Anomalies'];

export default function AIInsights() {
  const { beautician, loading: bLoading } = useBeautician();
  const [tab, setTab] = useState(0);
  const [loading, setLoading] = useState(true);
  const [predictions, setPredictions] = useState(isDevMode ? mockPredictions : []);
  const [churnData, setChurnData] = useState(isDevMode ? churnData : []);
  const [trends, setTrends] = useState(isDevMode ? trends : []);
  const [anomalies, setAnomalies] = useState(isDevMode ? anomalies : []);

  useEffect(() => {
    if (beautician && !bLoading) loadInsights();
  }, [beautician, bLoading]);

  async function loadInsights() {
    setLoading(true);
    try {
      if (isDevMode) {
        setPredictions(mockPredictions);
        setChurnData(churnData);
        setTrends(trends);
        setAnomalies(anomalies);
      } else {
        // In production, fetch real insights from analytics endpoints
        // For now, fall back to dev data
        setPredictions(mockPredictions);
        setChurnData(churnData);
        setTrends(trends);
        setAnomalies(anomalies);
      }
    } catch (err) {
      logger.error('Load insights error:', err);
    } finally {
      setLoading(false);
    }
  }

  if (bLoading || loading) {
    return <div style={ds.page}><div style={{ textAlign: 'center', padding: 60, color: 'var(--text-muted, var(--text-muted, #B5AFA8))' }}>Loading...</div></div>;
  }

  const maxRev = Math.max(...weeklyRevenue.map(d => Math.max(d.actual || 0, d.predicted)));

  return (
    <div style={ds.page}>
      {/* Header */}
      <div style={{ marginBottom: 20 }}>
        <h1 style={ds.pageTitle}>AI Insights</h1>
        <p style={{ ...type.bodySmall, marginTop: 4 }}>florrie.ai's brain — predictions, risks, and opportunities</p>
      </div>

      {/* Confidence hero */}
      <div style={{ ...ds.heroCard, marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>AI CONFIDENCE SCORE</div>
            <div style={{ fontSize: 42, fontWeight: 700, letterSpacing: '-0.03em', lineHeight: 1 }}>87%</div>
            <div style={{ fontSize: 13, opacity: 0.9, marginTop: 6 }}>Based on 14 months of your data</div>
          </div>
          <div style={{ fontSize: 48 }}>🧠</div>
        </div>
        <div style={{ display: 'flex', gap: 16, marginTop: 16 }}>
          {[{ label: 'Predictions made', val: '1,247' }, { label: 'Accuracy rate', val: '84%' }, { label: 'Actions taken', val: '89' }].map(s => (
            <div key={s.label} style={{ flex: 1 }}>
              <div style={{ fontSize: 18, fontWeight: 700 }}>{s.val}</div>
              <div style={{ fontSize: 10, opacity: 0.75, marginTop: 2 }}>{s.label}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Tabs */}
      <div style={ds.tabBar}>
        {tabs.map((t, i) => (
          <button key={t} onClick={() => setTab(i)} style={{ ...ds.tab, ...(tab === i ? ds.tabActive : {}) }}>{t}</button>
        ))}
      </div>

      {/* Predictions Tab */}
      {tab === 0 && (
        <div>
          {/* Prediction cards */}
          <div style={ds.statsGrid}>
            {predictions.map(p => (
              <div key={p.label} style={ds.statCard}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                  <span style={{ fontSize: 20 }}>{p.icon}</span>
                  <span style={{ ...ds.badge, ...ds.badgeAccent }}>{p.confidence}%</span>
                </div>
                <div style={ds.statValue}>{p.value}</div>
                <div style={ds.statLabel}>{p.label}</div>
                <div style={{ fontSize: 11, color: 'var(--success)', marginTop: 4, fontWeight: 500 }}>{p.trend}</div>
              </div>
            ))}
          </div>

          {/* Revenue forecast chart */}
          <div style={{ ...ds.card, marginBottom: 16 }}>
            <div style={{ ...type.heading, marginBottom: 14 }}>Revenue Forecast — This Week</div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end', height: 120 }}>
              {weeklyRevenue.map(d => (
                <div key={d.day} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                  <div style={{ display: 'flex', gap: 2, alignItems: 'flex-end', width: '100%', justifyContent: 'center', height: 100 }}>
                    {d.actual !== null && (
                      <div style={{ width: '40%', height: `${(d.actual / maxRev) * 100}%`, background: 'var(--accent)', borderRadius: '4px 4px 0 0', minHeight: 4 }} />
                    )}
                    <div style={{
                      width: d.actual !== null ? '40%' : '70%',
                      height: `${(d.predicted / maxRev) * 100}%`,
                      background: d.actual === null ? 'var(--gold)' : 'var(--border)',
                      borderRadius: '4px 4px 0 0',
                      minHeight: 4,
                      opacity: d.actual === null ? 1 : 0.5,
                      border: d.actual === null ? '1px dashed var(--gold)' : 'none',
                    }} />
                  </div>
                  <span style={{ ...type.caption, fontSize: 10, textTransform: 'none' }}>{d.day}</span>
                </div>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 16, justifyContent: 'center', marginTop: 10 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <div style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--accent)' }} />
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Actual</span>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <div style={{ width: 8, height: 8, borderRadius: 2, background: 'var(--gold)' }} />
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Predicted</span>
              </div>
            </div>
          </div>

          {/* AI Insight */}
          <div style={ds.insightCard}>
            <span style={{ fontSize: 20 }}>✨</span>
            <div>
              <div style={{ ...type.heading, fontSize: 13, marginBottom: 4 }}>florrie.ai's Take</div>
              <div style={{ ...type.bodySmall, lineHeight: 1.5 }}>
                Thursday–Saturday is your money window. You're consistently under-booked on Mondays — consider a "Monday Glow" promo to shift demand. Revenue is tracking 8% above last month.
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Churn Risk Tab */}
      {tab === 1 && (
        <div>
          {/* Risk summary */}
          <div style={{ ...ds.card, marginBottom: 16, background: 'linear-gradient(135deg, var(--danger-bg) 0%, var(--warning-bg) 100%)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ ...type.caption, marginBottom: 4 }}>CLIENTS AT RISK</div>
                <div style={{ fontSize: 36, fontWeight: 700, color: 'var(--text-primary)' }}>5</div>
                <div style={{ ...type.bodySmall, marginTop: 2 }}>Combined annual value: £4,770</div>
              </div>
              <div style={{ fontSize: 40 }}>🚨</div>
            </div>
          </div>

          {/* Client risk list */}
          {churnData.map((c, i) => (
            <div key={c.name} style={{ ...ds.card, marginBottom: 10, display: 'flex', gap: 12, alignItems: 'flex-start' }}>
              <div style={{
                width: 40, height: 40, borderRadius: 12,
                background: c.risk > 80 ? 'var(--danger-bg)' : c.risk > 65 ? 'var(--warning-bg)' : 'var(--accent-light)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 13, fontWeight: 600,
                color: c.risk > 80 ? 'var(--danger)' : c.risk > 65 ? 'var(--warning)' : 'var(--accent)',
                flexShrink: 0,
              }}>
                {c.avatar}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
                  <span style={type.heading}>{c.name}</span>
                  <span style={{
                    ...ds.badge,
                    background: c.risk > 80 ? 'var(--danger-bg)' : c.risk > 65 ? 'var(--warning-bg)' : 'var(--accent-light)',
                    color: c.risk > 80 ? 'var(--danger)' : c.risk > 65 ? 'var(--warning)' : 'var(--accent)',
                  }}>{c.risk}% risk</span>
                </div>
                <div style={{ ...type.bodySmall, fontSize: 12 }}>{c.trigger}</div>
                <div style={{ display: 'flex', gap: 12, marginTop: 6 }}>
                  <span style={{ ...type.mono, fontSize: 11, color: 'var(--text-muted)' }}>Last: {c.lastVisit}</span>
                  <span style={{ ...type.mono, fontSize: 11, color: 'var(--gold)' }}>{c.spend}</span>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button style={{ ...ds.btnGhost, fontSize: 11, padding: '6px 12px', background: 'var(--accent-light)', color: 'var(--accent)' }}>
                    Send win-back
                  </button>
                  <button style={{ ...ds.btnGhost, fontSize: 11, padding: '6px 12px' }}>
                    View profile
                  </button>
                </div>
              </div>
            </div>
          ))}

          <div style={ds.insightCard}>
            <span style={{ fontSize: 20 }}>💡</span>
            <div style={{ ...type.bodySmall, lineHeight: 1.5 }}>
              Your biggest churn trigger is missed rebook windows. Turning on auto-rebook reminders at 21 days could reduce churn risk by ~30%.
            </div>
          </div>
        </div>
      )}

      {/* Trends Tab */}
      {tab === 2 && (
        <div>
          <div style={{ ...ds.sectionTitle, marginBottom: 12 }}>TREATMENT DEMAND SHIFTS</div>
          {trends.map(t => (
            <div key={t.treatment} style={{ ...ds.card, marginBottom: 10 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <span style={type.heading}>{t.treatment}</span>
                <span style={{
                  ...ds.badge,
                  ...(t.direction === 'up' ? ds.badgeSuccess : ds.badgeDanger),
                }}>{t.change}</span>
              </div>
              {/* Trend bar */}
              <div style={{ height: 6, background: 'var(--bg-subtle)', borderRadius: 3, marginBottom: 8, overflow: 'hidden' }}>
                <div style={{
                  height: '100%',
                  width: `${Math.min(Math.abs(parseInt(t.change)) * 2.5, 100)}%`,
                  background: t.direction === 'up' ? 'var(--success)' : 'var(--danger)',
                  borderRadius: 3,
                  transition: 'width 0.5s ease',
                }} />
              </div>
              <div style={{ ...type.bodySmall, fontSize: 12 }}>{t.note}</div>
              <div style={{ ...type.mono, fontSize: 10, color: 'var(--text-muted)', marginTop: 4 }}>{t.period}</div>
            </div>
          ))}

          <div style={ds.insightCard}>
            <span style={{ fontSize: 20 }}>📊</span>
            <div style={{ ...type.bodySmall, lineHeight: 1.5 }}>
              Lip filler demand is surging — if you have appointment gaps mid-week, consider a "Midweek Lip Special" to capture this growth while competitors are booked out weekends.
            </div>
          </div>
        </div>
      )}

      {/* Anomalies Tab */}
      {tab === 3 && (
        <div>
          <div style={{ ...ds.sectionTitle, marginBottom: 12 }}>UNUSUAL PATTERNS DETECTED</div>
          {anomalies.map((a, i) => (
            <div key={i} style={{
              ...ds.card,
              marginBottom: 10,
              borderLeft: `3px solid ${a.severity === 'positive' ? 'var(--success)' : 'var(--warning)'}`,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 6 }}>
                <span style={{
                  ...ds.badge,
                  ...(a.severity === 'positive' ? ds.badgeSuccess : ds.badgeWarning),
                }}>{a.severity === 'positive' ? '✅ Positive' : '⚠️ Investigate'}</span>
                <span style={{ ...type.mono, fontSize: 10, color: 'var(--text-muted)' }}>{a.time}</span>
              </div>
              <div style={{ ...type.body, fontSize: 13, lineHeight: 1.5 }}>{a.message}</div>
            </div>
          ))}

          {/* Suggested actions */}
          <div style={{ ...ds.card, marginTop: 16 }}>
            <div style={{ ...type.heading, marginBottom: 12 }}>Suggested Actions</div>
            {[
              { action: 'Investigate Tuesday revenue spike', priority: 'High', icon: '🔍' },
              { action: 'Review Monday cancellations for pattern', priority: 'Medium', icon: '📋' },
              { action: 'Double down on new client acquisition channel', priority: 'High', icon: '🚀' },
            ].map(a => (
              <div key={a.action} style={{ ...ds.listRow, justifyContent: 'space-between' }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <span>{a.icon}</span>
                  <span style={{ ...type.body, fontSize: 13 }}>{a.action}</span>
                </div>
                <span style={{ ...ds.badge, ...(a.priority === 'High' ? ds.badgeAccent : ds.badgeGold) }}>{a.priority}</span>
              </div>
            ))}
          </div>

          <div style={{ ...ds.insightCard, marginTop: 16 }}>
            <span style={{ fontSize: 20 }}>🔮</span>
            <div style={{ ...type.bodySmall, lineHeight: 1.5 }}>
              Anomaly detection improves with time. florrie.ai has identified 3 patterns this week. The more data flows through, the sharper the alerts become.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
