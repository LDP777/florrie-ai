import { useState, useEffect } from 'react';
import { useBeautician, fetchRows, isDevMode } from '../lib/supabase.js';

const DEV_PLANS = [
  { id: 1, name: 'Brow Babe', price: 39, interval: 'month', perks: ['1 brow treatment/month', '10% off retail', 'Priority booking'], color: '#E8A838', members: 12, active: true },
  { id: 2, name: 'Lash Queen', price: 59, interval: 'month', perks: ['1 lash treatment/month', '15% off add-ons', 'Free aftercare kit', 'Priority booking'], color: '#C76B8A', members: 8, active: true },
  { id: 3, name: 'VIP All Access', price: 99, interval: 'month', perks: ['Any 2 treatments/month', '20% off everything', 'Free birthday treatment', 'Priority booking', 'Exclusive previews'], color: '#7C4DFF', members: 4, active: true },
  { id: 4, name: 'Annual Brow', price: 399, interval: 'year', perks: ['12 brow treatments', '15% off retail', 'Priority booking', '1 free upgrade'], color: '#26A69A', members: 3, active: true },
];

const DEV_MEMBERS = [
  { id: 1, name: 'Jessica R.', plan: 2, started: '2026-01-15', nextBill: '2026-04-15', status: 'active', usedThisMonth: 1, payments: 3, totalPaid: 177 },
  { id: 2, name: 'Amy K.', plan: 1, started: '2025-12-01', nextBill: '2026-04-01', status: 'active', usedThisMonth: 0, payments: 4, totalPaid: 156 },
  { id: 3, name: 'Charlotte B.', plan: 3, started: '2026-02-10', nextBill: '2026-04-10', status: 'active', usedThisMonth: 2, payments: 2, totalPaid: 198 },
  { id: 4, name: 'Emma L.', plan: 1, started: '2026-03-01', nextBill: '2026-04-01', status: 'active', usedThisMonth: 1, payments: 1, totalPaid: 39 },
  { id: 5, name: 'Sophie T.', plan: 2, started: '2025-11-20', nextBill: null, status: 'cancelled', usedThisMonth: 0, payments: 4, totalPaid: 236 },
  { id: 6, name: 'Megan W.', plan: 4, started: '2026-01-01', nextBill: '2027-01-01', status: 'active', usedThisMonth: 1, payments: 1, totalPaid: 399 },
  { id: 7, name: 'Hannah D.', plan: 1, started: '2026-02-15', nextBill: '2026-04-15', status: 'paused', usedThisMonth: 0, payments: 1, totalPaid: 39 },
];

const STATUS_COLORS = {
  active: { bg: 'var(--success-bg, #E8F5E9)', color: 'var(--success, #5BA97B)' },
  paused: { bg: '#FFF3E0', color: '#E65100' },
  cancelled: { bg: 'var(--danger-bg, #FDF0EF)', color: 'var(--danger, #D4605C)' },
};

export default function ClientMemberships() {
  const [tab, setTab] = useState('plans');
  const [showCreate, setShowCreate] = useState(false);
  const [expandedMember, setExpandedMember] = useState(null);
  const { beautician, loading: bLoading } = useBeautician();
  const [plans, setPlans] = useState([]);
  const [members, setMembers] = useState([]);

  useEffect(() => {
    if (bLoading) return;
    if (isDevMode || !beautician) { setPlans(DEV_PLANS); setMembers(DEV_MEMBERS); return; }
    Promise.all([
      fetchRows('membership_plans', beautician.id, { order: 'price', ascending: true }),
      fetchRows('memberships', beautician.id, { order: 'created_at', ascending: false }),
    ]).then(([p, m]) => {
      setPlans(p.length ? p : DEV_PLANS);
      setMembers(m.length ? m : DEV_MEMBERS);
    });
  }, [beautician, bLoading]);

  if (bLoading) return <div style={{ padding: 40, textAlign: 'center', color: '#AAA5A0' }}>Loading...</div>;

  const activeMembers = members.filter(m => m.status === 'active').length;
  const monthlyRecurring = members.filter(m => m.status === 'active').reduce((s, m) => {
    const plan = plans.find(p => p.id === m.plan);
    return s + (plan?.interval === 'month' ? plan.price : (plan?.price || 0) / 12);
  }, 0);
  const totalLifetime = members.reduce((s, m) => s + m.totalPaid, 0);

  return (
    <div style={s.page}>
      <div style={s.header}>
        <h1 style={s.title}>Memberships</h1>
        <p style={s.subtitle}>Subscription plans and recurring revenue</p>
      </div>

      {/* Revenue hero */}
      <div style={s.heroCard}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end' }}>
          <div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', marginBottom: 4 }}>Monthly Recurring</div>
            <div style={{ fontSize: 28, fontWeight: 700, color: '#fff' }}>£{Math.round(monthlyRecurring)}<span style={{ fontSize: 14, fontWeight: 400, opacity: 0.7 }}>/mo</span></div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: '#fff' }}>{activeMembers}</div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>active members</div>
          </div>
        </div>
        <div style={{ marginTop: 12, fontSize: 12, color: 'rgba(255,255,255,0.6)' }}>Lifetime value: £{totalLifetime.toLocaleString()}</div>
      </div>

      {/* Tabs */}
      <div style={s.tabRow}>
        {['plans', 'members', 'settings'].map(t => (
          <button key={t} onClick={() => setTab(t)} style={{ ...s.tab, ...(tab === t ? s.tabActive : {}) }}>
            {t === 'plans' ? 'Plans' : t === 'members' ? 'Members' : 'Settings'}
          </button>
        ))}
      </div>

      {/* Plans tab */}
      {tab === 'plans' && (
        <div style={s.planList}>
          {plans.map(plan => (
            <div key={plan.id} style={{ ...s.planCard, borderTop: `3px solid ${plan.color}` }}>
              <div style={s.planHeader}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 17, color: 'var(--text, #2D2A26)' }}>{plan.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted, #AAA5A0)' }}>{plan.members} members</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <span style={{ fontSize: 24, fontWeight: 700, color: plan.color }}>£{plan.price}</span>
                  <span style={{ fontSize: 12, color: 'var(--text-muted, #AAA5A0)' }}>/{plan.interval}</span>
                </div>
              </div>
              <div style={s.perkList}>
                {plan.perks.map((perk, i) => (
                  <div key={i} style={s.perkItem}>
                    <span style={{ color: plan.color }}>✓</span>
                    <span style={{ fontSize: 13, color: 'var(--text, #2D2A26)' }}>{perk}</span>
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
                <button style={{ ...s.editBtn, color: plan.color }}>Edit Plan</button>
                <button style={s.editBtn}>Share Link</button>
              </div>
            </div>
          ))}

          <button onClick={() => setShowCreate(!showCreate)} style={s.addBtn}>+ Create New Plan</button>

          {showCreate && (
            <div style={s.formCard}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>New Membership Plan</div>
              <input type="text" placeholder="Plan name" style={s.input} />
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <input type="number" placeholder="Price" style={{ ...s.input, flex: 1 }} />
                <select style={{ ...s.input, width: 120 }}>
                  <option value="month">Monthly</option>
                  <option value="year">Annual</option>
                </select>
              </div>
              <textarea placeholder="Perks (one per line)" rows={3} style={{ ...s.input, marginTop: 8, resize: 'vertical' }} />
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button style={s.primaryBtn}>Create Plan</button>
                <button onClick={() => setShowCreate(false)} style={s.ghostBtn}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Members tab */}
      {tab === 'members' && (
        <div style={s.memberList}>
          {members.map(member => {
            const plan = plans.find(p => p.id === member.plan);
            const sc = STATUS_COLORS[member.status];
            const expanded = expandedMember === member.id;
            return (
              <button key={member.id} onClick={() => setExpandedMember(expanded ? null : member.id)} style={s.memberCard}>
                <div style={s.memberTop}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text, #2D2A26)' }}>{member.name}</div>
                    <div style={{ fontSize: 12, color: plan?.color || 'var(--text-muted, #AAA5A0)', fontWeight: 600 }}>{plan?.name}</div>
                  </div>
                  <span style={{ padding: '3px 10px', borderRadius: 12, fontSize: 11, fontWeight: 600, background: sc.bg, color: sc.color }}>
                    {member.status}
                  </span>
                </div>
                {expanded && (
                  <div style={{ marginTop: 10, borderTop: '1px solid var(--card-border, #F0ECE8)', paddingTop: 10, fontSize: 13 }}>
                    <div style={s.detailRow}><span style={s.detailLabel}>Started</span><span>{member.started}</span></div>
                    <div style={s.detailRow}><span style={s.detailLabel}>Next bill</span><span>{member.nextBill || '—'}</span></div>
                    <div style={s.detailRow}><span style={s.detailLabel}>Used this month</span><span>{member.usedThisMonth} treatment{member.usedThisMonth !== 1 ? 's' : ''}</span></div>
                    <div style={s.detailRow}><span style={s.detailLabel}>Payments made</span><span>{member.payments}</span></div>
                    <div style={s.detailRow}><span style={s.detailLabel}>Total paid</span><span style={{ fontWeight: 700, color: 'var(--accent, #C76B8A)' }}>£{member.totalPaid}</span></div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                      {member.status === 'active' && <button style={s.smallBtn}>Pause</button>}
                      {member.status === 'paused' && <button style={{ ...s.smallBtn, color: 'var(--success, #5BA97B)' }}>Resume</button>}
                      {member.status !== 'cancelled' && <button style={{ ...s.smallBtn, color: 'var(--danger, #D4605C)' }}>Cancel</button>}
                      <button style={s.smallBtn}>Message</button>
                    </div>
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}

      {/* Settings tab */}
      {tab === 'settings' && (
        <div style={s.settingsList}>
          <div style={s.settingCard}>
            <div style={s.settingRow}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>Auto-renewal</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted, #AAA5A0)' }}>Automatically renew memberships on billing date</div>
              </div>
              <div style={s.toggle}><div style={s.toggleDot} /></div>
            </div>
          </div>
          <div style={s.settingCard}>
            <div style={s.settingRow}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>Payment reminders</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted, #AAA5A0)' }}>Send reminder 3 days before billing</div>
              </div>
              <div style={s.toggle}><div style={s.toggleDot} /></div>
            </div>
          </div>
          <div style={s.settingCard}>
            <div style={s.settingRow}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>Failed payment retries</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted, #AAA5A0)' }}>Retry up to 3 times over 7 days</div>
              </div>
              <div style={s.toggle}><div style={s.toggleDot} /></div>
            </div>
          </div>
          <div style={s.settingCard}>
            <div style={s.settingRow}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>Cancellation grace period</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted, #AAA5A0)' }}>Allow reactivation within 7 days of cancellation</div>
              </div>
              <select style={{ ...s.input, width: 80 }}>
                <option>3 days</option>
                <option>7 days</option>
                <option>14 days</option>
                <option>30 days</option>
              </select>
            </div>
          </div>
          <div style={s.settingCard}>
            <div style={s.settingRow}>
              <div>
                <div style={{ fontWeight: 600, fontSize: 14 }}>Welcome message</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted, #AAA5A0)' }}>Send automatic welcome when someone joins</div>
              </div>
              <div style={s.toggle}><div style={s.toggleDot} /></div>
            </div>
          </div>

          {/* AI insight */}
          <div style={s.aiCard}>
            <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--accent, #C76B8A)', marginBottom: 6 }}>💡 Membership Tip</div>
            <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: 'var(--text, #2D2A26)' }}>
              Your VIP All Access plan has the highest retention — 100% of members are still active. Consider promoting it as a "founding member" offer with a small discount to grow that tier.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

const s = {
  page: { padding: '20px 16px 40px', fontFamily: '"DM Sans", -apple-system, sans-serif', maxWidth: 480, margin: '0 auto' },
  header: { marginBottom: 16 },
  title: { fontSize: 22, fontWeight: 700, margin: 0, color: 'var(--text, #2D2A26)' },
  subtitle: { fontSize: 13, color: 'var(--text-muted, #AAA5A0)', margin: '4px 0 0' },
  heroCard: { padding: 20, borderRadius: 16, background: 'linear-gradient(135deg, var(--accent, #C76B8A), var(--accent-hover, #B85D7B))', marginBottom: 16 },
  tabRow: { display: 'flex', gap: 0, marginBottom: 16, borderRadius: 10, overflow: 'hidden', border: '1px solid var(--card-border, #F0ECE8)' },
  tab: { flex: 1, padding: '10px 0', border: 'none', background: 'none', fontSize: 13, fontWeight: 500, cursor: 'pointer', color: 'var(--text-muted, #AAA5A0)', fontFamily: 'inherit' },
  tabActive: { background: 'var(--accent, #C76B8A)', color: '#fff' },
  planList: { display: 'flex', flexDirection: 'column', gap: 12 },
  planCard: { padding: 16, borderRadius: 14, background: 'var(--card-bg, #fff)', border: '1px solid var(--card-border, #F0ECE8)' },
  planHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  perkList: { display: 'flex', flexDirection: 'column', gap: 6 },
  perkItem: { display: 'flex', alignItems: 'center', gap: 8 },
  editBtn: { background: 'none', border: 'none', fontSize: 12, fontWeight: 600, cursor: 'pointer', color: 'var(--text-muted, #AAA5A0)', fontFamily: 'inherit', padding: '4px 0' },
  addBtn: { padding: '14px', borderRadius: 10, border: '2px dashed var(--card-border, #F0ECE8)', background: 'none', fontSize: 14, fontWeight: 600, color: 'var(--accent, #C76B8A)', cursor: 'pointer', fontFamily: 'inherit' },
  formCard: { padding: 16, borderRadius: 12, background: 'var(--card-bg, #fff)', border: '1px solid var(--card-border, #F0ECE8)' },
  input: { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--card-border, #F0ECE8)', fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box', background: 'var(--card-bg, #fff)', color: 'var(--text, #2D2A26)' },
  primaryBtn: { padding: '10px 20px', borderRadius: 8, border: 'none', background: 'var(--accent, #C76B8A)', color: '#fff', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  ghostBtn: { padding: '10px 20px', borderRadius: 8, border: '1px solid var(--card-border, #F0ECE8)', background: 'none', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-muted, #AAA5A0)' },
  memberList: { display: 'flex', flexDirection: 'column', gap: 10 },
  memberCard: { padding: '14px 12px', borderRadius: 12, background: 'var(--card-bg, #fff)', border: '1px solid var(--card-border, #F0ECE8)', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', width: '100%' },
  memberTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  detailRow: { display: 'flex', justifyContent: 'space-between', padding: '4px 0', color: 'var(--text, #2D2A26)' },
  detailLabel: { color: 'var(--text-muted, #AAA5A0)' },
  smallBtn: { background: 'none', border: '1px solid var(--card-border, #F0ECE8)', borderRadius: 6, padding: '6px 12px', fontSize: 12, fontWeight: 500, cursor: 'pointer', color: 'var(--accent, #C76B8A)', fontFamily: 'inherit' },
  settingsList: { display: 'flex', flexDirection: 'column', gap: 10 },
  settingCard: { padding: '14px 12px', borderRadius: 12, background: 'var(--card-bg, #fff)', border: '1px solid var(--card-border, #F0ECE8)' },
  settingRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  toggle: { width: 44, height: 24, borderRadius: 12, background: 'var(--accent, #C76B8A)', padding: 2, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', flexShrink: 0 },
  toggleDot: { width: 20, height: 20, borderRadius: 10, background: '#fff' },
  aiCard: { padding: 14, borderRadius: 12, background: 'linear-gradient(135deg, rgba(199,107,138,0.06), rgba(232,168,56,0.06))', border: '1px solid rgba(199,107,138,0.15)', marginTop: 4 },
};
