import { useState } from 'react';
import { ds, type } from '../lib/designSystem.js';

const segments = [
  {
    name: 'VIP Regulars', icon: '👑', count: 34, revenue: '£48,200', avgSpend: '£1,418',
    description: 'Visit 2+ times/month, spend above £100/visit',
    growth: '+3 this month', color: 'var(--gold)', bgColor: 'var(--gold-light)',
    rfm: { recency: 9, frequency: 9, monetary: 9 },
    topTreatments: ['Lip Filler', 'Full Set Lashes', 'Facial Peel'],
    actions: ['Exclusive early access', 'VIP loyalty tier', 'Birthday premium gift'],
  },
  {
    name: 'Loyal Mid-Tier', icon: '💎', count: 87, revenue: '£62,400', avgSpend: '£717',
    description: 'Visit monthly, consistent spend £40–100',
    growth: '+8 this month', color: 'var(--accent)', bgColor: 'var(--accent-light)',
    rfm: { recency: 7, frequency: 7, monetary: 6 },
    topTreatments: ['Gel Manicure', 'Brow Lamination', 'Lash Lift'],
    actions: ['Upsell to premium', 'Membership offer', 'Referral incentive'],
  },
  {
    name: 'Declining', icon: '📉', count: 23, revenue: '£8,900', avgSpend: '£387',
    description: 'Were regular, now 45+ days since last visit',
    growth: '-2 this month', color: 'var(--warning)', bgColor: 'var(--warning-bg)',
    rfm: { recency: 3, frequency: 6, monetary: 5 },
    topTreatments: ['Classic Manicure', 'Brow Wax', 'Tint'],
    actions: ['Win-back campaign', 'Personalised offer', 'Feedback request'],
  },
  {
    name: 'New & Promising', icon: '🌱', count: 41, revenue: '£12,300', avgSpend: '£300',
    description: 'First visited in last 60 days, booked 2nd appt',
    growth: '+12 this month', color: 'var(--success)', bgColor: 'var(--success-bg)',
    rfm: { recency: 8, frequency: 3, monetary: 4 },
    topTreatments: ['Gel Manicure', 'Lash Lift & Tint', 'Facial'],
    actions: ['Welcome sequence', 'Loyalty enrollment', '3rd visit incentive'],
  },
  {
    name: 'One-Timers', icon: '👋', count: 156, revenue: '£9,400', avgSpend: '£60',
    description: 'Single visit, no rebook',
    growth: '+18 this month', color: 'var(--text-muted)', bgColor: 'var(--bg-subtle)',
    rfm: { recency: 4, frequency: 1, monetary: 2 },
    topTreatments: ['Basic Manicure', 'Brow Wax', 'Blow Dry'],
    actions: ['Re-engagement email', '2nd visit discount', 'Survey why'],
  },
  {
    name: 'Dormant High-Value', icon: '💤', count: 15, revenue: '£0', avgSpend: '£980',
    description: 'Previously spent £500+/yr, inactive 90+ days',
    growth: '+1 this month', color: 'var(--danger)', bgColor: 'var(--danger-bg)',
    rfm: { recency: 1, frequency: 5, monetary: 8 },
    topTreatments: ['Dermal Filler', 'Full Set', 'Facial Package'],
    actions: ['Personal call/text', 'Exclusive return offer', 'VIP comeback package'],
  },
];

export default function ClientSegments() {
  const [expanded, setExpanded] = useState(null);
  const [view, setView] = useState(0); // 0=segments, 1=rfm matrix

  const totalClients = segments.reduce((s, g) => s + g.count, 0);

  return (
    <div style={ds.page}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={ds.pageTitle}>Client Segments</h1>
        <p style={{ ...type.bodySmall, marginTop: 4 }}>AI-powered grouping based on behaviour, spend, and engagement</p>
      </div>

      {/* Overview bar */}
      <div style={{ ...ds.heroCard, marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>TOTAL SEGMENTED</div>
            <div style={{ fontSize: 36, fontWeight: 700 }}>{totalClients}</div>
            <div style={{ fontSize: 13, opacity: 0.9, marginTop: 4 }}>across {segments.length} segments</div>
          </div>
          <div style={{ fontSize: 40 }}>🎯</div>
        </div>
        {/* Segment bar */}
        <div style={{ display: 'flex', height: 8, borderRadius: 4, overflow: 'hidden', marginTop: 16, gap: 2 }}>
          {segments.map(s => (
            <div key={s.name} style={{ flex: s.count, background: s.color, opacity: 0.9, borderRadius: 2 }} title={`${s.name}: ${s.count}`} />
          ))}
        </div>
      </div>

      {/* View toggle */}
      <div style={{ ...ds.tabBar, marginBottom: 16 }}>
        {['Segments', 'RFM Matrix'].map((t, i) => (
          <button key={t} onClick={() => setView(i)} style={{ ...ds.tab, ...(view === i ? ds.tabActive : {}) }}>{t}</button>
        ))}
      </div>

      {view === 0 && (
        <div>
          {segments.map((seg, i) => (
            <div key={seg.name} style={{ ...ds.card, marginBottom: 12, cursor: 'pointer' }} onClick={() => setExpanded(expanded === i ? null : i)}>
              {/* Segment header */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  <div style={{
                    width: 40, height: 40, borderRadius: 12,
                    background: seg.bgColor, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20,
                  }}>{seg.icon}</div>
                  <div>
                    <div style={type.heading}>{seg.name}</div>
                    <div style={{ ...type.bodySmall, fontSize: 12 }}>{seg.count} clients · {seg.revenue}</div>
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ ...ds.badge, background: seg.bgColor, color: seg.color }}>{seg.growth}</span>
                  <span style={{ fontSize: 14, color: 'var(--text-muted)', transform: expanded === i ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }}>▼</span>
                </div>
              </div>

              {/* Expanded details */}
              {expanded === i && (
                <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border-light)' }}>
                  <div style={{ ...type.bodySmall, marginBottom: 12 }}>{seg.description}</div>

                  {/* RFM scores */}
                  <div style={{ ...ds.sectionTitle, marginBottom: 8 }}>RFM SCORES</div>
                  <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
                    {Object.entries(seg.rfm).map(([k, v]) => (
                      <div key={k} style={{ flex: 1, textAlign: 'center' }}>
                        <div style={{ height: 6, background: 'var(--bg-subtle)', borderRadius: 3, overflow: 'hidden', marginBottom: 4 }}>
                          <div style={{ height: '100%', width: `${v * 10}%`, background: seg.color, borderRadius: 3 }} />
                        </div>
                        <div style={{ ...type.mono, fontSize: 10, color: 'var(--text-muted)' }}>{k.charAt(0).toUpperCase() + k.slice(1)}: {v}/10</div>
                      </div>
                    ))}
                  </div>

                  {/* Top treatments */}
                  <div style={{ ...ds.sectionTitle, marginBottom: 8 }}>TOP TREATMENTS</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 14 }}>
                    {seg.topTreatments.map(t => (
                      <span key={t} style={{ ...ds.badge, background: 'var(--bg-subtle)', color: 'var(--text-secondary)' }}>{t}</span>
                    ))}
                  </div>

                  {/* Suggested actions */}
                  <div style={{ ...ds.sectionTitle, marginBottom: 8 }}>SUGGESTED ACTIONS</div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {seg.actions.map(a => (
                      <button key={a} style={{ ...ds.btnGhost, fontSize: 11, padding: '6px 12px', background: seg.bgColor, color: seg.color }}>
                        {a}
                      </button>
                    ))}
                  </div>

                  {/* Stats row */}
                  <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
                    <div style={{ flex: 1, ...ds.statCard, padding: 10, textAlign: 'center' }}>
                      <div style={{ ...ds.statValue, fontSize: 16 }}>{seg.avgSpend}</div>
                      <div style={ds.statLabel}>Avg lifetime</div>
                    </div>
                    <div style={{ flex: 1, ...ds.statCard, padding: 10, textAlign: 'center' }}>
                      <div style={{ ...ds.statValue, fontSize: 16 }}>{seg.count}</div>
                      <div style={ds.statLabel}>Clients</div>
                    </div>
                    <div style={{ flex: 1, ...ds.statCard, padding: 10, textAlign: 'center' }}>
                      <div style={{ ...ds.statValue, fontSize: 16 }}>{seg.revenue}</div>
                      <div style={ds.statLabel}>Revenue</div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {view === 1 && (
        <div>
          {/* RFM Matrix visualization */}
          <div style={{ ...ds.card, marginBottom: 16 }}>
            <div style={{ ...type.heading, marginBottom: 4 }}>Recency × Frequency Matrix</div>
            <div style={{ ...type.bodySmall, marginBottom: 16, fontSize: 12 }}>Bubble size = monetary value</div>

            {/* Grid */}
            <div style={{ position: 'relative', height: 220, marginBottom: 8 }}>
              {/* Y-axis label */}
              <div style={{ position: 'absolute', left: -4, top: '50%', transform: 'rotate(-90deg) translateX(50%)', ...type.caption, fontSize: 9 }}>FREQUENCY →</div>

              {/* Grid lines */}
              <div style={{ position: 'absolute', left: 28, right: 0, top: 0, bottom: 20, border: '1px solid var(--border-light)', borderRadius: 8, overflow: 'hidden' }}>
                {[0.25, 0.5, 0.75].map(p => (
                  <div key={p} style={{ position: 'absolute', left: 0, right: 0, top: `${p * 100}%`, height: 1, background: 'var(--border-light)' }} />
                ))}
                {[0.25, 0.5, 0.75].map(p => (
                  <div key={p} style={{ position: 'absolute', top: 0, bottom: 0, left: `${p * 100}%`, width: 1, background: 'var(--border-light)' }} />
                ))}

                {/* Segments as bubbles */}
                {segments.map(seg => {
                  const x = (seg.rfm.recency / 10) * 100;
                  const y = 100 - (seg.rfm.frequency / 10) * 100;
                  const size = Math.max(20, (seg.rfm.monetary / 10) * 40);
                  return (
                    <div key={seg.name} style={{
                      position: 'absolute',
                      left: `calc(${x}% - ${size / 2}px)`,
                      top: `calc(${y}% - ${size / 2}px)`,
                      width: size, height: size, borderRadius: '50%',
                      background: seg.color, opacity: 0.7,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: size > 25 ? 14 : 10, cursor: 'pointer',
                      boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
                      transition: 'transform 0.2s',
                    }} title={`${seg.name}: R${seg.rfm.recency} F${seg.rfm.frequency} M${seg.rfm.monetary}`}>
                      {seg.icon}
                    </div>
                  );
                })}
              </div>

              {/* X-axis label */}
              <div style={{ position: 'absolute', bottom: 0, left: '50%', transform: 'translateX(-50%)', ...type.caption, fontSize: 9 }}>RECENCY →</div>
            </div>

            {/* Legend */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 12 }}>
              {segments.map(seg => (
                <div key={seg.name} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: seg.color }} />
                  <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{seg.name}</span>
                </div>
              ))}
            </div>
          </div>

          <div style={ds.insightCard}>
            <span style={{ fontSize: 20 }}>🎯</span>
            <div style={{ ...type.bodySmall, lineHeight: 1.5 }}>
              Your "Dormant High-Value" segment (15 clients) represents £14,700 in lost annual revenue. A personal outreach campaign to this group has 3x the ROI of broad marketing.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
