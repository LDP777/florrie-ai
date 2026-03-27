import { useState } from 'react';
import { ds, type } from '../lib/designSystem.js';

const atRisk = [
  { name: 'Jessica Moore', avatar: 'JM', risk: 94, daysSince: 47, ltv: '£1,240', trigger: 'Missed rebook window', lastTreatment: 'Full Set Lashes', status: 'no-action', email: 'jessica@email.com' },
  { name: 'Sarah Chen', avatar: 'SC', risk: 82, daysSince: 38, trigger: 'Cancelled last 2 appts', ltv: '£890', lastTreatment: 'Lip Filler', status: 'contacted', email: 'sarah.c@email.com' },
  { name: 'Emma Taylor', avatar: 'ET', risk: 76, daysSince: 52, trigger: 'Competitor check-in detected', ltv: '£620', lastTreatment: 'Gel Manicure', status: 'no-action', email: 'emma.t@email.com' },
  { name: 'Olivia Brown', avatar: 'OB', risk: 68, daysSince: 31, trigger: 'Reduced visit frequency', ltv: '£1,580', lastTreatment: 'Facial Package', status: 'win-back-sent', email: 'olivia@email.com' },
  { name: 'Amy Wilson', avatar: 'AW', risk: 61, daysSince: 44, trigger: 'Left negative review', ltv: '£440', lastTreatment: 'Brow Lamination', status: 'no-action', email: 'amy.w@email.com' },
  { name: 'Rachel Green', avatar: 'RG', risk: 55, daysSince: 28, trigger: 'Downgraded treatments', ltv: '£720', lastTreatment: 'Basic Mani → Gel', status: 'contacted', email: 'rach@email.com' },
];

const campaigns = [
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
  const [tab, setTab] = useState(0);

  const totalAtRisk = atRisk.length;
  const totalLTV = atRisk.reduce((s, c) => s + parseInt(c.ltv.replace(/[£,]/g, '')), 0);
  const contacted = atRisk.filter(c => c.status !== 'no-action').length;

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
          {atRisk.map(c => {
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
                      color: '#fff', fontSize: 9, fontWeight: 700,
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
          {campaigns.map(c => {
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
