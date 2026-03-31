import { useState, useEffect } from 'react';
import { useBeautician, supabase, isDevMode, fetchRows } from '../lib/supabase.js';
import { ds, type } from '../lib/designSystem.js';
import logger from '../lib/logger.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';

// ── Churn risk scoring engine ───────────────────────────────
function computeChurnRisk(clients) {
  const now = new Date();
  const scored = [];

  clients.forEach(c => {
    const appts = (c.appointments || [])
      .map(a => ({ date: new Date(a.created_at || a.start_time || a.starts_at), treatment: a.treatment_name, status: a.status, price: a.price_cents || 0 }))
      .filter(a => !isNaN(a.date))
      .sort((a, b) => b.date - a.date);

    if (appts.length === 0) return; // skip clients with no appointments at all

    const lastVisit = appts[0].date;
    const daysSince = Math.floor((now - lastVisit) / 86400000);
    const totalSpend = appts.reduce((s, a) => s + a.price, 0) / 100;
    const name = `${c.first_name || ''} ${c.last_name || ''}`.trim();
    const initials = (c.first_name?.[0] || '') + (c.last_name?.[0] || '');

    // Compute average visit interval from appointment history
    let avgInterval = 28; // default
    if (appts.length >= 2) {
      const intervals = [];
      for (let i = 0; i < appts.length - 1; i++) {
        intervals.push(Math.floor((appts[i].date - appts[i + 1].date) / 86400000));
      }
      avgInterval = Math.round(intervals.reduce((s, v) => s + v, 0) / intervals.length);
    }

    // Cancellation count in last 60 days
    const recentCancels = appts.filter(a => a.status === 'cancelled' && (now - a.date) / 86400000 <= 60).length;

    // Determine churn trigger (most relevant reason)
    let trigger = '';
    let riskScore = 0;

    if (daysSince > avgInterval + 21) {
      trigger = 'Missed rebook window';
      riskScore += 40 + Math.min(30, (daysSince - avgInterval) / 2);
    } else if (daysSince > avgInterval) {
      trigger = 'Overdue for rebook';
      riskScore += 25 + Math.min(20, (daysSince - avgInterval));
    }

    if (recentCancels >= 2) {
      trigger = trigger || `Cancelled ${recentCancels} recent appts`;
      riskScore += 25;
    }

    if (daysSince >= 90) {
      trigger = 'Extended absence (90+ days)';
      riskScore += 30;
    } else if (daysSince >= 45) {
      trigger = trigger || 'Extended absence (45+ days)';
      riskScore += 15;
    }

    // Frequency decline: compare recent 3 months vs prior 3 months
    const threeMonthsAgo = new Date(now); threeMonthsAgo.setMonth(now.getMonth() - 3);
    const sixMonthsAgo = new Date(now); sixMonthsAgo.setMonth(now.getMonth() - 6);
    const recentVisits = appts.filter(a => a.date >= threeMonthsAgo).length;
    const priorVisits = appts.filter(a => a.date >= sixMonthsAgo && a.date < threeMonthsAgo).length;
    if (priorVisits > 0 && recentVisits < priorVisits * 0.5) {
      trigger = trigger || 'Reduced visit frequency';
      riskScore += 15;
    }

    riskScore = Math.min(99, Math.max(0, Math.round(riskScore)));

    // Only flag clients with meaningful risk
    if (riskScore >= 30) {
      scored.push({
        name,
        avatar: initials || name[0] || '?',
        risk: riskScore,
        daysSince,
        ltv: `£${Math.round(totalSpend).toLocaleString()}`,
        trigger: trigger || 'Below expected visit cadence',
        lastTreatment: appts[0]?.treatment || 'Treatment',
        status: c.churn_status || 'no-action',
        email: c.email || '',
      });
    }
  });

  return scored.sort((a, b) => b.risk - a.risk);
}

// ── Dev-mode synthetic clients ──────────────────────────────
function generateDevChurnClients() {
  const now = new Date();
  const clients = [
    { first_name: 'Sophie', last_name: 'L', email: 'sophie@email.com', appointments: [] },
    { first_name: 'Grace', last_name: 'K', email: 'grace@email.com', appointments: [] },
    { first_name: 'Beth', last_name: 'W', email: 'beth@email.com', appointments: [] },
    { first_name: 'Chloe', last_name: 'R', email: 'chloe@email.com', appointments: [] },
    { first_name: 'Megan', last_name: 'T', email: 'megan@email.com', appointments: [] },
    { first_name: 'Katie', last_name: 'P', email: 'katie@email.com', appointments: [] },
    { first_name: 'Amber', last_name: 'J', email: 'amber@email.com', appointments: [] },
    { first_name: 'Zara', last_name: 'H', email: 'zara@email.com', appointments: [] },
  ];
  const treatments = ['Lamination & Hybrid Dye', 'HD Brows', 'Lash Lift & Tint', 'Hybrid Brows', 'Lamination & Tint', 'Brow Jelly Mask', 'Ombre Brows', 'Lamination Maintenance / Tint'];
  // Generate varied appointment histories that create churn signals
  const patterns = [
    { visits: 8, lastDaysAgo: 55, interval: 21, cancels: 0 },   // missed rebook + extended absence
    { visits: 6, lastDaysAgo: 95, interval: 28, cancels: 0 },   // dormant
    { visits: 4, lastDaysAgo: 40, interval: 14, cancels: 2 },   // cancellations
    { visits: 10, lastDaysAgo: 48, interval: 21, cancels: 0 },  // was regular, now absent
    { visits: 3, lastDaysAgo: 32, interval: 14, cancels: 1 },   // overdue
    { visits: 12, lastDaysAgo: 60, interval: 28, cancels: 0 },  // declining frequency
    { visits: 5, lastDaysAgo: 70, interval: 21, cancels: 0 },   // missed window
    { visits: 7, lastDaysAgo: 110, interval: 35, cancels: 0 },  // long dormant
  ];

  clients.forEach((c, i) => {
    const p = patterns[i];
    for (let v = 0; v < p.visits; v++) {
      const d = new Date(now);
      d.setDate(d.getDate() - p.lastDaysAgo - (v * p.interval));
      c.appointments.push({
        created_at: d.toISOString(),
        treatment_name: treatments[i % treatments.length],
        price_cents: 3000 + (i * 500),
        status: v < p.cancels ? 'cancelled' : 'completed',
      });
    }
  });

  return clients;
}

const DEV_CAMPAIGNS = [
  { name: 'We miss you — 20% off', sent: 23, opened: 18, rebooked: 7, revenue: '£840', status: 'active' },
  { name: 'VIP comeback package', sent: 8, opened: 6, rebooked: 4, revenue: '£1,200', status: 'active' },
  { name: 'Personal text from stylist', sent: 12, opened: 12, rebooked: 5, revenue: '£620', status: 'paused' },
  { name: 'Birthday month return', sent: 5, opened: 4, rebooked: 2, revenue: '£280', status: 'scheduled' },
];

const triggers = [
  { name: 'Missed rebook window', threshold: '21 days past usual interval', clients: 14, icon: '📅' },
  { name: 'Consecutive cancellations', threshold: '2+ cancellations in 30 days', clients: 6, icon: '❌' },
  { name: 'Treatment downgrade', threshold: 'Lower-value service vs history', clients: 8, icon: '⬇️' },
  { name: 'Negative feedback', threshold: 'Rating ≤ 3 or complaint filed', clients: 3, icon: '😞' },
  { name: 'Extended absence', threshold: '45+ days since last visit', clients: 11, icon: '👻' },
  { name: 'Competitor mention', threshold: 'Mentioned competitor in notes/review', clients: 2, icon: '🔄' },
];

const statusColors = {
  'no-action': { bg: 'var(--danger-bg)', color: 'var(--danger)', label: 'No action' },
  'contacted': { bg: 'var(--accent-light)', color: 'var(--accent)', label: 'Contacted' },
  'win-back-sent': { bg: 'var(--gold-light)', color: 'var(--gold)', label: 'Win-back sent' },
  'recovered': { bg: 'var(--success-bg)', color: 'var(--success)', label: 'Recovered' },
};

const tabs = ['At Risk', 'Campaigns', 'Triggers', 'Recovery'];

export default function ChurnPrevention() {
  const { beautician, loading: bLoading } = useBeautician();
  const [tab, setTab] = useState(0);
  const [loading, setLoading] = useState(true);
  const [riskClients, setRiskClients] = useState(isDevMode ? DEV_RISK_CLIENTS : []);
  const [churnCampaigns, setChurnCampaigns] = useState(isDevMode ? DEV_CAMPAIGNS : []);

  useEffect(() => {
    if (beautician && !bLoading) loadChurnData();
  }, [beautician, bLoading]);

  async function loadChurnData() {
    setLoading(true);
    try {
      if (isDevMode) {
        const devClients = generateDevChurnClients();
        setRiskClients(computeChurnRisk(devClients));
        setChurnCampaigns(DEV_CAMPAIGNS);
      } else {
        const { data: clients } = await supabase
          .from('clients')
          .select('*, appointments(created_at, treatment_name, price_cents, start_time, status)')
          .eq('beautician_id', beautician.id);

        if (clients && clients.length > 0) {
          setRiskClients(computeChurnRisk(clients));
        } else {
          setRiskClients([]);
        }

        // Fetch real campaigns if they exist
        const campaigns = await fetchRows('churn_campaigns', beautician.id);
        setChurnCampaigns(campaigns.length > 0 ? campaigns : DEV_CAMPAIGNS);
      }
    } catch (err) {
      logger.error('Load churn data error:', err);
      setRiskClients([]);
      setChurnCampaigns(DEV_CAMPAIGNS);
    } finally {
      setLoading(false);
    }
  }

  if (bLoading || loading) {
    return <div style={ds.page}><PageLoader /></div>;
  }

  const totalAtRisk = riskClients.length;
  const totalLTV = riskClients.reduce((s, c) => s + parseInt(c.ltv.replace(/[£,]/g, '')), 0);
  const contacted = riskClients.filter(c => c.status !== 'no-action').length;

  return (
    <div style={ds.page}>
      <div style={{ marginBottom: 20 }}>
        <h1 style={ds.pageTitle}>Churn Prevention</h1>
        <p style={{ ...type.bodySmall, marginTop: 4 }}>Catch at-risk clients before they leave</p>
      </div>

      {/* Hero */}
      <div style={{ ...ds.heroCard, marginBottom: 20, background: 'linear-gradient(135deg, #C76B8A 0%, #D4738F 40%, #E8A87C 100%)' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 12, opacity: 0.85, marginBottom: 4 }}>REVENUE AT RISK</div>
            <div style={{ fontSize: 36, fontWeight: 700, letterSpacing: '-0.02em' }}>£{totalLTV.toLocaleString()}</div>
            <div style={{ fontSize: 13, opacity: 0.9, marginTop: 4 }}>{totalAtRisk} clients flagged · {contacted} contacted</div>
          </div>
          <div style={{ fontSize: 40 }}>🛡️</div>
        </div>
        <div style={{ display: 'flex', gap: 16, marginTop: 16 }}>
          {[
            { label: 'Recovered (30d)', val: '£2,740' },
            { label: 'Win rate', val: '34%' },
            { label: 'Avg days to save', val: '6.2' },
          ].map(s => (
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

      {/* At Risk Tab */}
      {tab === 0 && (
        <div>
          {riskClients.map(c => {
            const st = statusColors[c.status];
            return (
              <div key={c.name} style={{ ...ds.card, marginBottom: 10 }}>
                <div style={{ display: 'flex', gap: 12 }}>
                  {/* Avatar with risk ring */}
                  <div style={{ position: 'relative', flexShrink: 0 }}>
                    <div style={{
                      width: 44, height: 44, borderRadius: 14,
                      background: c.risk > 80 ? 'var(--danger-bg)' : c.risk > 60 ? 'var(--warning-bg)' : 'var(--accent-light)',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      fontSize: 13, fontWeight: 600,
                      color: c.risk > 80 ? 'var(--danger)' : c.risk > 60 ? 'var(--warning)' : 'var(--accent)',
                    }}>{c.avatar}</div>
                    {/* Risk indicator */}
                    <div style={{
                      position: 'absolute', top: -4, right: -4, width: 20, height: 20, borderRadius: 10,
                      background: c.risk > 80 ? 'var(--danger)' : c.risk > 60 ? 'var(--warning)' : 'var(--accent)',
                      color: 'var(--bg-card, #fff)', fontSize: 9, fontWeight: 700,
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                      border: '2px solid var(--bg-card)',
                    }}>{c.risk}</div>
                  </div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <span style={type.heading}>{c.name}</span>
                      <span style={{ ...ds.badge, background: st.bg, color: st.color }}>{st.label}</span>
                    </div>
                    <div style={{ ...type.bodySmall, fontSize: 12, marginTop: 2 }}>{c.trigger}</div>
                    <div style={{ display: 'flex', gap: 10, marginTop: 6, flexWrap: 'wrap' }}>
                      <span style={{ ...type.mono, fontSize: 10, color: 'var(--text-muted)' }}>{c.daysSince}d ago</span>
                      <span style={{ ...type.mono, fontSize: 10, color: 'var(--gold)' }}>LTV {c.ltv}</span>
                      <span style={{ ...type.mono, fontSize: 10, color: 'var(--text-muted)' }}>{c.lastTreatment}</span>
                    </div>

                    {/* Action buttons */}
                    <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
                      <button style={{ ...ds.btnGhost, fontSize: 11, padding: '6px 10px', background: 'var(--accent-light)', color: 'var(--accent)' }}>💬 Text</button>
                      <button style={{ ...ds.btnGhost, fontSize: 11, padding: '6px 10px', background: 'var(--gold-light)', color: 'var(--gold)' }}>🎁 Offer</button>
                      <button style={{ ...ds.btnGhost, fontSize: 11, padding: '6px 10px' }}>📋 Notes</button>
                      <button style={{ ...ds.btnGhost, fontSize: 11, padding: '6px 10px' }}>📅 Book</button>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Campaigns Tab */}
      {tab === 1 && (
        <div>
          {churnCampaigns.map(c => {
            const convRate = c.sent > 0 ? ((c.rebooked / c.sent) * 100).toFixed(0) : 0;
            return (
              <div key={c.name} style={{ ...ds.card, marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                  <span style={type.heading}>{c.name}</span>
                  <span style={{
                    ...ds.badge,
                    ...(c.status === 'active' ? ds.badgeSuccess : c.status === 'paused' ? ds.badgeWarning : ds.badgeGold),
                  }}>{c.status}</span>
                </div>

                {/* Funnel */}
                <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
                  {[
                    { label: 'Sent', val: c.sent, pct: 100 },
                    { label: 'Opened', val: c.opened, pct: (c.opened / c.sent) * 100 },
                    { label: 'Rebooked', val: c.rebooked, pct: (c.rebooked / c.sent) * 100 },
                  ].map(step => (
                    <div key={step.label} style={{ flex: 1, textAlign: 'center' }}>
                      <div style={{ height: 6, background: 'var(--bg-subtle)', borderRadius: 3, overflow: 'hidden', marginBottom: 4 }}>
                        <div style={{ height: '100%', width: `${step.pct}%`, background: 'var(--accent)', borderRadius: 3 }} />
                      </div>
                      <div style={{ ...type.mono, fontSize: 11 }}>{step.val}</div>
                      <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{step.label}</div>
                    </div>
                  ))}
                </div>

                <div style={{ ...ds.divider }} />
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span style={{ ...type.bodySmall, fontSize: 12 }}>Conv. rate: <strong>{convRate}%</strong></span>
                  <span style={{ ...type.mono, fontSize: 12, color: 'var(--success)' }}>{c.revenue} recovered</span>
                </div>
              </div>
            );
          })}

          <button style={{ ...ds.btnPrimary, marginTop: 8 }}>+ Create Win-Back Campaign</button>
        </div>
      )}

      {/* Triggers Tab */}
      {tab === 2 && (
        <div>
          <div style={{ ...ds.sectionTitle, marginBottom: 12 }}>CHURN TRIGGERS</div>
          {triggers.map(t => (
            <div key={t.name} style={{ ...ds.card, marginBottom: 10, display: 'flex', gap: 12, alignItems: 'center' }}>
              <div style={{ fontSize: 24, flexShrink: 0 }}>{t.icon}</div>
              <div style={{ flex: 1 }}>
                <div style={type.heading}>{t.name}</div>
                <div style={{ ...type.bodySmall, fontSize: 12, marginTop: 2 }}>{t.threshold}</div>
              </div>
              <div style={{ textAlign: 'right', flexShrink: 0 }}>
                <div style={{ ...ds.statValue, fontSize: 18 }}>{t.clients}</div>
                <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>clients</div>
              </div>
            </div>
          ))}

          <div style={ds.insightCard}>
            <span style={{ fontSize: 20 }}>💡</span>
            <div style={{ ...type.bodySmall, lineHeight: 1.5 }}>
              "Missed rebook window" is your #1 churn trigger — 14 clients right now. Auto-rebook reminders at day 21 would catch most of these before they drift.
            </div>
          </div>
        </div>
      )}

      {/* Recovery Tab */}
      {tab === 3 && (
        <div>
          <div style={{ ...ds.card, marginBottom: 16 }}>
            <div style={{ ...type.heading, marginBottom: 12 }}>Recovery Scorecard — Last 90 Days</div>
            <div style={ds.statsGrid}>
              {[
                { label: 'Total at risk', val: '42', icon: '⚠️' },
                { label: 'Recovered', val: '14', icon: '✅' },
                { label: 'Revenue saved', val: '£8,400', icon: '💰' },
                { label: 'Win rate', val: '33%', icon: '📈' },
              ].map(s => (
                <div key={s.label} style={ds.statCard}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                    <span style={{ fontSize: 16 }}>{s.icon}</span>
                  </div>
                  <div style={ds.statValue}>{s.val}</div>
                  <div style={ds.statLabel}>{s.label}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Recovery timeline */}
          <div style={{ ...ds.card, marginBottom: 16 }}>
            <div style={{ ...type.heading, marginBottom: 12 }}>Recent Recoveries</div>
            {[
              { name: 'Lisa Park', method: 'Personal text', days: 3, spend: '£180', date: 'Mar 24' },
              { name: 'Kate Adams', method: 'VIP comeback offer', days: 5, spend: '£240', date: 'Mar 22' },
              { name: 'Mia Roberts', method: 'Birthday return promo', days: 8, spend: '£95', date: 'Mar 19' },
              { name: 'Sophie Lee', method: '20% win-back email', days: 4, spend: '£120', date: 'Mar 17' },
            ].map(r => (
              <div key={r.name} style={ds.listRow}>
                <div style={{ flex: 1 }}>
                  <div style={{ ...type.body, fontSize: 13 }}>{r.name}</div>
                  <div style={{ ...type.bodySmall, fontSize: 11 }}>{r.method} · {r.days} days to convert</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ ...type.mono, fontSize: 12, color: 'var(--success)' }}>{r.spend}</div>
                  <div style={{ fontSize: 10, color: 'var(--text-muted)' }}>{r.date}</div>
                </div>
              </div>
            ))}
          </div>

          {/* Best performing method */}
          <div style={ds.insightCard}>
            <span style={{ fontSize: 20 }}>🏆</span>
            <div style={{ ...type.bodySmall, lineHeight: 1.5 }}>
              Personal texts from the stylist who last treated the client have the highest win rate (42%) — nearly double automated emails. Worth the extra 2 minutes.
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
