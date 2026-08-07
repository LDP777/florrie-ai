import { useState, useEffect } from 'react';
import { useBeautician, fetchRows, insertRow, updateRow } from '../lib/supabase.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';

const STATUS_COLORS = {
  active: { bg: 'var(--success-bg, #E9F0EB)', color: 'var(--success, #3F7D5C)' },
  paused: { bg: 'var(--warning-bg, #F7EEDD)', color: 'var(--warning-text, #8A6420)' },
  cancelled: { bg: 'var(--danger-bg, #F7E4E4)', color: 'var(--danger, #9E2B32)' },
  expired: { bg: 'var(--danger-bg, #F7E4E4)', color: 'var(--danger, #9E2B32)' },
};

const PLAN_COLORS = ['#C76B8A', '#E8A838', '#7C4DFF', '#26A69A', '#5BA97B'];

// Map a client_memberships row to the shape this page renders.
function normalisePlan(p, i) {
  const benefits = Array.isArray(p.benefits)
    ? p.benefits.map(b => (typeof b === 'string' ? b : b.label || b.type || ''))
    : [];
  return {
    id: p.id,
    name: p.name,
    price: Math.round((p.price_cents || 0) / 100),
    interval: 'month', // client_memberships are billed monthly
    perks: benefits.filter(Boolean),
    color: p.color || PLAN_COLORS[i % PLAN_COLORS.length],
    active: p.is_active !== false,
  };
}

// Map a membership_subscriptions row to the shape this page renders.
function normaliseMember(m) {
  return {
    id: m.id,
    name: m.client_name || m.clients?.first_name || 'Member',
    plan: m.membership_id,
    started: m.started_at ? new Date(m.started_at).toLocaleDateString() : 'Not set',
    nextBill: m.next_billing_at ? new Date(m.next_billing_at).toLocaleDateString() : null,
    status: m.status || 'active',
  };
}

export default function ClientMemberships() {
  const [tab, setTab] = useState('plans');
  const [showCreate, setShowCreate] = useState(false);
  const [expandedMember, setExpandedMember] = useState(null);
  const { beautician, loading: bLoading } = useBeautician();
  const [plans, setPlans] = useState([]);
  const [members, setMembers] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState({ name: '', price: '', interval: 'month', perks: '' });

  useEffect(() => {
    if (bLoading) return;
    if (!beautician) { setPlans([]); setMembers([]); setLoaded(true); return; }
    Promise.all([
      fetchRows('client_memberships', beautician.id, { order: 'price_cents', ascending: true }),
      fetchRows('membership_subscriptions', beautician.id, { order: 'created_at', ascending: false }),
    ]).then(([p, m]) => {
      setPlans((p || []).map(normalisePlan));
      setMembers((m || []).map(normaliseMember));
      setLoaded(true);
    }).catch(() => {
      // Never leave the page stuck on the loader if a fetch fails.
      setPlans([]);
      setMembers([]);
      setLoaded(true);
    });
  }, [beautician, bLoading]);

  if (bLoading || !loaded) return <PageLoader />;

  const activeMembers = members.filter(m => m.status === 'active').length;
  const monthlyRecurring = members.filter(m => m.status === 'active').reduce((s, m) => {
    const plan = plans.find(p => p.id === m.plan);
    return s + (plan?.price || 0);
  }, 0);

  async function handleCreatePlan() {
    if (!form.name.trim() || !form.price) return;
    setSaving(true);
    const perks = form.perks.split('\n').map(x => x.trim()).filter(Boolean);
    const row = {
      beautician_id: beautician.id,
      name: form.name.trim(),
      price_cents: Math.round(parseFloat(form.price) * 100) || 0,
      benefits: perks.map(label => ({ type: 'perk', label })),
      is_active: true,
    };
    try {
      const saved = await insertRow('client_memberships', row);
      setPlans(prev => [...prev, normalisePlan(saved, prev.length)]);
      setForm({ name: '', price: '', interval: 'month', perks: '' });
      setShowCreate(false);
    } catch (e) { /* insertRow already logs */ }
    finally { setSaving(false); }
  }

  async function updateMemberStatus(id, status) {
    setMembers(prev => prev.map(m => m.id === id ? { ...m, status } : m));
    try {
      const updates = { status };
      if (status === 'cancelled') updates.cancelled_at = new Date().toISOString();
      await updateRow('membership_subscriptions', id, updates);
    } catch (e) { /* updateRow already logs */ }
  }

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
            <div style={{ fontSize: 28, fontWeight: 700, color: 'var(--bg-card, #FFFCF9)' }}>£{Math.round(monthlyRecurring)}<span style={{ fontSize: 14, fontWeight: 400, opacity: 0.7 }}>/mo</span></div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--bg-card, #FFFCF9)' }}>{activeMembers}</div>
            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.7)' }}>active members</div>
          </div>
        </div>
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
          {plans.length === 0 && !showCreate && (
            <EmptyState
              icon="💳"
              title="No membership plans yet"
              subtitle="Create a plan to offer clients recurring monthly perks and steady income."
              actionLabel="+ Create a plan"
              onAction={() => setShowCreate(true)}
            />
          )}
          {plans.map(plan => (
            <div key={plan.id} style={{ ...s.planCard, borderTop: `3px solid ${plan.color}` }}>
              <div style={s.planHeader}>
                <div>
                  <div style={{ fontWeight: 700, fontSize: 17, color: 'var(--text, #241B17)' }}>{plan.name}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted, #6B5D54)' }}>{members.filter(m => m.plan === plan.id && m.status === 'active').length} members</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <span style={{ fontSize: 24, fontWeight: 700, color: plan.color }}>£{plan.price}</span>
                  <span style={{ fontSize: 12, color: 'var(--text-muted, #6B5D54)' }}>/{plan.interval}</span>
                </div>
              </div>
              {plan.perks.length > 0 && (
                <div style={s.perkList}>
                  {plan.perks.map((perk, i) => (
                    <div key={i} style={s.perkItem}>
                      <span style={{ color: plan.color }}>✓</span>
                      <span style={{ fontSize: 13, color: 'var(--text, #241B17)' }}>{perk}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}

          {plans.length > 0 && (
            <button onClick={() => setShowCreate(!showCreate)} style={s.addBtn}>+ Create New Plan</button>
          )}

          {showCreate && (
            <div style={s.formCard}>
              <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>New Membership Plan</div>
              <input type="text" placeholder="Plan name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} style={s.input} />
              <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                <input type="number" placeholder="Price" value={form.price} onChange={e => setForm({ ...form, price: e.target.value })} style={{ ...s.input, flex: 1 }} />
                <select value={form.interval} onChange={e => setForm({ ...form, interval: e.target.value })} style={{ ...s.input, width: 120 }}>
                  <option value="month">Monthly</option>
                </select>
              </div>
              <textarea placeholder="Perks (one per line)" rows={3} value={form.perks} onChange={e => setForm({ ...form, perks: e.target.value })} style={{ ...s.input, marginTop: 8, resize: 'vertical' }} />
              <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                <button onClick={handleCreatePlan} disabled={saving || !form.name.trim() || !form.price} style={{ ...s.primaryBtn, opacity: saving || !form.name.trim() || !form.price ? 0.5 : 1 }}>{saving ? 'Saving...' : 'Create Plan'}</button>
                <button onClick={() => setShowCreate(false)} style={s.ghostBtn}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Members tab */}
      {tab === 'members' && (
        <div style={s.memberList}>
          {members.length === 0 && (
            <EmptyState
              icon="👥"
              title="No members yet"
              subtitle="When clients subscribe to one of your plans, they'll appear here."
            />
          )}
          {members.map(member => {
            const plan = plans.find(p => p.id === member.plan);
            const sc = STATUS_COLORS[member.status] || STATUS_COLORS.active;
            const expanded = expandedMember === member.id;
            return (
              <button key={member.id} onClick={() => setExpandedMember(expanded ? null : member.id)} style={s.memberCard}>
                <div style={s.memberTop}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text, #241B17)' }}>{member.name}</div>
                    <div style={{ fontSize: 12, color: plan?.color || 'var(--text-muted, #6B5D54)', fontWeight: 600 }}>{plan?.name || 'Unknown plan'}</div>
                  </div>
                  <span style={{ padding: '3px 10px', borderRadius: 12, fontSize: 11, fontWeight: 600, background: sc.bg, color: sc.color }}>
                    {member.status}
                  </span>
                </div>
                {expanded && (
                  <div style={{ marginTop: 10, borderTop: '1px solid var(--card-border, #E8DDD4)', paddingTop: 10, fontSize: 13 }}>
                    <div style={s.detailRow}><span style={s.detailLabel}>Started</span><span>{member.started}</span></div>
                    <div style={s.detailRow}><span style={s.detailLabel}>Next bill</span><span>{member.nextBill || 'Not set'}</span></div>
                    <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                      {member.status === 'active' && <button onClick={e => { e.stopPropagation(); updateMemberStatus(member.id, 'paused'); }} style={s.smallBtn}>Pause</button>}
                      {member.status === 'paused' && <button onClick={e => { e.stopPropagation(); updateMemberStatus(member.id, 'active'); }} style={{ ...s.smallBtn, color: 'var(--success, #3F7D5C)' }}>Resume</button>}
                      {member.status !== 'cancelled' && <button onClick={e => { e.stopPropagation(); updateMemberStatus(member.id, 'cancelled'); }} style={{ ...s.smallBtn, color: 'var(--danger, #9E2B32)' }}>Cancel</button>}
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
          <EmptyState
            icon="⚙️"
            title="Membership settings coming soon"
            subtitle="Auto-renewal, payment reminders and retry rules will live here. For now, plans bill monthly by default."
          />
        </div>
      )}
    </div>
  );
}

const s = {
  page: { padding: '20px 16px 40px', fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif", maxWidth: 480, margin: '0 auto' },
  header: { marginBottom: 16 },
  title: { fontSize: 22, fontWeight: 700, margin: 0, color: 'var(--text, #241B17)' },
  subtitle: { fontSize: 13, color: 'var(--text-muted, #6B5D54)', margin: '4px 0 0' },
  heroCard: { padding: 20, borderRadius: 16, background: 'linear-gradient(135deg, var(--accent, #92405e), var(--accent-hover, #782b49))', marginBottom: 16 },
  tabRow: { display: 'flex', gap: 0, marginBottom: 16, borderRadius: 10, overflow: 'hidden', border: '1px solid var(--card-border, #E8DDD4)' },
  tab: { flex: 1, padding: '10px 0', border: 'none', background: 'none', fontSize: 13, fontWeight: 500, cursor: 'pointer', color: 'var(--text-muted, #6B5D54)', fontFamily: 'inherit' },
  tabActive: { background: 'var(--accent, #92405e)', color: 'var(--bg-card, #FFFCF9)' },
  planList: { display: 'flex', flexDirection: 'column', gap: 12 },
  planCard: { padding: 16, borderRadius: 14, background: 'var(--card-bg, #FFFCF9)', border: '1px solid var(--card-border, #E8DDD4)' },
  planHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  perkList: { display: 'flex', flexDirection: 'column', gap: 6 },
  perkItem: { display: 'flex', alignItems: 'center', gap: 8 },
  addBtn: { padding: '14px', borderRadius: 10, border: '2px dashed var(--card-border, #E8DDD4)', background: 'none', fontSize: 14, fontWeight: 600, color: 'var(--accent, #92405e)', cursor: 'pointer', fontFamily: 'inherit' },
  formCard: { padding: 16, borderRadius: 12, background: 'var(--card-bg, #FFFCF9)', border: '1px solid var(--card-border, #E8DDD4)' },
  input: { width: '100%', padding: '10px 12px', borderRadius: 8, border: '1px solid var(--card-border, #E8DDD4)', fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box', background: 'var(--card-bg, #FFFCF9)', color: 'var(--text, #241B17)' },
  primaryBtn: { padding: '10px 20px', borderRadius: 8, border: 'none', background: 'var(--accent, #92405e)', color: 'var(--bg-card, #FFFCF9)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  ghostBtn: { padding: '10px 20px', borderRadius: 8, border: '1px solid var(--card-border, #E8DDD4)', background: 'none', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-muted, #6B5D54)' },
  memberList: { display: 'flex', flexDirection: 'column', gap: 10 },
  memberCard: { padding: '14px 12px', borderRadius: 12, background: 'var(--card-bg, #FFFCF9)', border: '1px solid var(--card-border, #E8DDD4)', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit', width: '100%' },
  memberTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  detailRow: { display: 'flex', justifyContent: 'space-between', padding: '4px 0', color: 'var(--text, #241B17)' },
  detailLabel: { color: 'var(--text-muted, #6B5D54)' },
  smallBtn: { background: 'none', border: '1px solid var(--card-border, #E8DDD4)', borderRadius: 6, padding: '6px 12px', fontSize: 12, fontWeight: 500, cursor: 'pointer', color: 'var(--accent, #92405e)', fontFamily: 'inherit' },
  settingsList: { display: 'flex', flexDirection: 'column', gap: 10 },
};
