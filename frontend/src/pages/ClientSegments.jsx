import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBeautician, supabase } from '../lib/supabase.js';
import { ds, type } from '../lib/designSystem.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';

// ── Segment definitions — the buckets clients get sorted into ──
const SEGMENT_DEFS = [
  {
    key: 'vip', name: 'VIP Regulars', icon: '👑',
    description: 'Visit 2+ times/month, spend above average',
    color: 'var(--gold)', bgColor: 'var(--gold-light)',
    actions: ['Exclusive early access', 'VIP loyalty tier', 'Birthday premium gift'],
    match: (c) => c.rfm.recency >= 8 && c.rfm.frequency >= 7 && c.rfm.monetary >= 7,
  },
  {
    key: 'loyal', name: 'Loyal Mid-Tier', icon: '💎',
    description: 'Visit monthly, consistent spend',
    color: 'var(--accent)', bgColor: 'var(--accent-light)',
    actions: ['Upsell to premium', 'Membership offer', 'Referral incentive'],
    match: (c) => c.rfm.recency >= 5 && c.rfm.frequency >= 4 && c.rfm.monetary >= 3,
  },
  {
    key: 'new', name: 'New & Promising', icon: '🌱',
    description: 'First visited in last 60 days, booked 2+ appts',
    color: 'var(--success)', bgColor: 'var(--success-bg)',
    actions: ['Welcome sequence', 'Loyalty enrollment', '3rd visit incentive'],
    match: (c) => c.daysSinceFirst <= 60 && c.totalVisits >= 2,
  },
  {
    key: 'declining', name: 'Declining', icon: '📉',
    description: 'Were regular, now 45+ days since last visit',
    color: 'var(--warning)', bgColor: 'var(--warning-bg)',
    actions: ['Win-back campaign', 'Personalised offer', 'Feedback request'],
    match: (c) => c.rfm.frequency >= 4 && c.daysSinceLast >= 45,
  },
  {
    key: 'dormant_hv', name: 'Dormant High-Value', icon: '💤',
    description: 'Previously spent above average, inactive 90+ days',
    color: 'var(--danger)', bgColor: 'var(--danger-bg)',
    actions: ['Personal call/text', 'Exclusive return offer', 'VIP comeback package'],
    match: (c) => c.daysSinceLast >= 90 && c.rfm.monetary >= 5,
  },
  {
    key: 'one_timer', name: 'One-Timers', icon: '👋',
    description: 'Single visit, no rebook',
    color: 'var(--text-muted)', bgColor: 'var(--bg-subtle)',
    actions: ['Re-engagement email', '2nd visit discount', 'Survey why'],
    match: (c) => c.totalVisits <= 1,
  },
];

// ── RFM scoring engine ──────────────────────────────────────
function computeRFMSegments(clients) {
  const now = new Date();
  // Score each client on R/F/M (1-10 scale)
  const scored = clients.map(c => {
    const appts = (c.appointments || [])
      .map(a => new Date(a.created_at || a.starts_at || a.start_time))
      .filter(d => !isNaN(d))
      .sort((a, b) => b - a);
    const lastVisit = appts[0] || new Date(c.last_visit_at || c.created_at || now);
    const firstVisit = appts[appts.length - 1] || lastVisit;
    const daysSinceLast = Math.floor((now - lastVisit) / 86400000);
    const daysSinceFirst = Math.floor((now - firstVisit) / 86400000);
    const totalVisits = appts.length || c.total_visits || 1;
    const totalSpend = (c.total_spend_cents || 0) / 100;

    return {
      id: c.id,
      name: `${c.first_name || ''} ${c.last_name || ''}`.trim(),
      daysSinceLast,
      daysSinceFirst,
      totalVisits,
      totalSpend,
      lastTreatment: c.appointments?.[0]?.treatment_name || 'Treatment',
      topTreatments: [...new Set((c.appointments || []).map(a => a.treatment_name).filter(Boolean))].slice(0, 3),
      rfm: { recency: 5, frequency: 5, monetary: 5 }, // placeholder, scored below
    };
  });

  // Compute percentile-based scores (relative to this beautician's clients)
  if (scored.length > 0) {
    const recencies = scored.map(c => c.daysSinceLast).sort((a, b) => a - b);
    const frequencies = scored.map(c => c.totalVisits).sort((a, b) => a - b);
    const monetaries = scored.map(c => c.totalSpend).sort((a, b) => a - b);

    scored.forEach(c => {
      c.rfm.recency = Math.max(1, Math.min(10, 10 - Math.round((recencies.indexOf(c.daysSinceLast) / Math.max(1, recencies.length - 1)) * 9)));
      c.rfm.frequency = Math.max(1, Math.min(10, 1 + Math.round((frequencies.indexOf(c.totalVisits) / Math.max(1, frequencies.length - 1)) * 9)));
      c.rfm.monetary = Math.max(1, Math.min(10, 1 + Math.round((monetaries.indexOf(c.totalSpend) / Math.max(1, monetaries.length - 1)) * 9)));
    });
  }

  // Bucket clients into segments (first match wins, order matters)
  const buckets = {};
  SEGMENT_DEFS.forEach(s => { buckets[s.key] = []; });
  const unmatched = [];

  scored.forEach(c => {
    let placed = false;
    for (const def of SEGMENT_DEFS) {
      if (def.match(c)) {
        buckets[def.key].push(c);
        placed = true;
        break;
      }
    }
    if (!placed) unmatched.push(c);
  });
  // Drop unmatched into the closest-fit bucket (one-timer fallback)
  unmatched.forEach(c => buckets.one_timer.push(c));

  // Build segment objects for the UI
  return SEGMENT_DEFS.map(def => {
    const members = buckets[def.key];
    const totalRevenue = members.reduce((s, c) => s + c.totalSpend, 0);
    const avgR = members.length ? Math.round(members.reduce((s, c) => s + c.rfm.recency, 0) / members.length) : 0;
    const avgF = members.length ? Math.round(members.reduce((s, c) => s + c.rfm.frequency, 0) / members.length) : 0;
    const avgM = members.length ? Math.round(members.reduce((s, c) => s + c.rfm.monetary, 0) / members.length) : 0;
    const topTreatments = [...new Set(members.flatMap(c => c.topTreatments))].slice(0, 3);

    return {
      name: def.name,
      icon: def.icon,
      count: members.length,
      revenue: `£${Math.round(totalRevenue).toLocaleString()}`,
      avgSpend: members.length ? `£${Math.round(totalRevenue / members.length).toLocaleString()}` : '£0',
      description: def.description,
      growth: '', // would need historical data to compute
      color: def.color,
      bgColor: def.bgColor,
      rfm: { recency: avgR, frequency: avgF, monetary: avgM },
      topTreatments: topTreatments.length ? topTreatments : ['No data yet'],
      actions: def.actions,
    };
  }).filter(s => s.count > 0);
}

// ── Dev mode: synthetic clients with appointment history ────
function generateDevClients() {
  const now = new Date();
  const names = [
    'Shauna', 'Daisy S', 'Jasmin', 'Sophie', 'Grace', 'Beth', 'Amy', 'Chloe',
    'Laura', 'Megan', 'Katie', 'Ellie M', 'Poppy', 'Ruby', 'Charlotte',
    'Holly', 'Freya', 'Isla', 'Lucy', 'Molly', 'Emily', 'Amber', 'Zara',
  ];
  const treatments = [
    'Lamination & Hybrid Dye', 'Lamination & Tint', 'HD Brows', 'Lash Lift & Tint',
    'Hybrid Brows', 'Lamination Maintenance / Tint', 'Brow Jelly Mask', 'Ombre Brows',
  ];
  const prices = [4500, 4000, 2500, 4000, 3000, 2500, 700, 25000];

  return names.map((name, i) => {
    // Vary patterns: VIPs visit often & recently, dormants haven't been in ages, etc.
    const isVip = i < 4;
    const isLoyal = i >= 4 && i < 10;
    const isNew = i >= 10 && i < 14;
    const isDeclining = i >= 14 && i < 17;
    const isDormant = i >= 17 && i < 20;
    // rest are one-timers

    const visitCount = isVip ? 12 + i : isLoyal ? 6 + (i % 3) : isNew ? 2 + (i % 2) : isDeclining ? 8 : isDormant ? 5 : 1;
    const lastDaysAgo = isVip ? 3 + i : isLoyal ? 14 + i : isNew ? 5 + i : isDeclining ? 50 + i : isDormant ? 100 + i : 45 + (i * 3);
    const treatIdx = i % treatments.length;
    const pricePerVisit = prices[treatIdx];

    const appts = [];
    for (let v = 0; v < visitCount; v++) {
      const d = new Date(now);
      d.setDate(d.getDate() - lastDaysAgo - (v * (isVip ? 14 : isLoyal ? 28 : 35)));
      appts.push({ created_at: d.toISOString(), treatment_name: treatments[treatIdx], price_cents: pricePerVisit });
    }

    return {
      id: `dev-seg-${i}`,
      first_name: name,
      last_name: '',
      total_visits: visitCount,
      total_spend_cents: visitCount * pricePerVisit,
      last_visit_at: appts[0]?.created_at,
      created_at: appts[appts.length - 1]?.created_at || now.toISOString(),
      appointments: appts,
    };
  });
}

export default function ClientSegments() {
  const { beautician, loading: bLoading } = useBeautician();
  const navigate = useNavigate();
  const [expanded, setExpanded] = useState(null);
  const [view, setView] = useState(0);
  const [loading, setLoading] = useState(true);
  const [segments, setSegments] = useState([]);

  useEffect(() => {
    if (beautician && !bLoading) loadSegments();
  }, [beautician, bLoading]);

  async function loadSegments() {
    setLoading(true);
    try {
      const { data: clients } = await supabase
        .from('clients')
        .select('*, appointments(created_at, treatment_name, price_cents, starts_at)')
        .eq('beautician_id', beautician.id);

      if (clients && clients.length > 0) {
        setSegments(computeRFMSegments(clients));
      } else {
        setSegments([]);
      }
    } catch (err) {
      logger.error('Load segments error:', err);
      setSegments([]);
    } finally {
      setLoading(false);
    }
  }

  if (bLoading || loading) {
    return <div style={ds.page}><PageLoader /></div>;
  }

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
                      <button
                        key={a}
                        style={{ ...ds.btnGhost, fontSize: 11, padding: '6px 12px', background: seg.bgColor, color: seg.color }}
                        onClick={() => navigate('/campaigns', { state: { segment: seg.name, action: a } })}
                      >
                        {a} →
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

          {(() => {
            const dormant = segments.find(s => s.name === 'Dormant High-Value');
            const declining = segments.find(s => s.name === 'Declining');
            const target = dormant || declining;
            if (!target || target.count === 0) return null;
            const lostRevenue = target.count * (parseInt(target.avgSpend?.replace(/[^0-9]/g, '') || 0));
            return (
              <div style={ds.insightCard}>
                <span style={{ fontSize: 20 }}>🎯</span>
                <div style={{ ...type.bodySmall, lineHeight: 1.5 }}>
                  Your "{target.name}" segment ({target.count} client{target.count !== 1 ? 's' : ''}) represents {target.revenue} in potentially recoverable revenue. A personal outreach campaign to this group typically has 3× the ROI of broad marketing.{' '}
                  <span
                    style={{ color: 'var(--accent)', cursor: 'pointer', textDecoration: 'underline' }}
                    onClick={() => navigate('/campaigns', { state: { segment: target.name } })}
                  >
                    Create a campaign →
                  </span>
                </div>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
