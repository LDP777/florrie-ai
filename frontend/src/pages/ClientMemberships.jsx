import { useState, useEffect } from 'react';
import { useBeautician, fetchRowsStrict, insertRow, updateRow } from '../lib/supabase.js';
import PageLoader from '../components/PageLoader.jsx';
import EmptyState from '../components/EmptyState.jsx';
import ErrorCard from '../components/ErrorCard.jsx';
import Icon from '../components/ui/Icon';
import PageHeader from '../components/ui/PageHeader.jsx';
import { readableOn } from '../lib/brand-colour.js';

const STATUS_COLORS = {
  active: { bg: 'var(--success-bg, #E9F0EB)', color: 'var(--success, #386F52)' },
  paused: { bg: 'var(--warning-bg, #F7EEDD)', color: 'var(--warning-text, #79581C)' },
  cancelled: { bg: 'var(--danger-bg, #F7E4E4)', color: 'var(--danger, #9E2B32)' },
  expired: { bg: 'var(--danger-bg, #F7E4E4)', color: 'var(--danger, #9E2B32)' },
  unknown: { bg: 'var(--bg, #FBF6F1)', color: 'var(--text-muted, #6B5D54)' },
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
    price: p.price_cents != null && Number.isFinite(Number(p.price_cents)) ? Number(p.price_cents) / 100 : null,
    perks: benefits.filter(Boolean),
    color: p.color || PLAN_COLORS[i % PLAN_COLORS.length],
    textColor: readableOn(p.color || PLAN_COLORS[i % PLAN_COLORS.length], '#FFFCF9'),
    active: p.is_active !== false,
  };
}

// Map a membership_subscriptions row to the shape this page renders.
function normaliseMember(m) {
  return {
    id: m.id,
    name: m.client_name || [m.clients?.first_name, m.clients?.last_name].filter(Boolean).join(' ') || 'Member',
    plan: m.membership_id,
    started: m.started_at ? new Date(m.started_at).toLocaleDateString() : 'Not set',
    nextPayment: m.next_billing_at ? new Date(m.next_billing_at).toLocaleDateString() : null,
    status: m.status || 'unknown',
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
  const [error, setError] = useState(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const [updatingMember, setUpdatingMember] = useState(null);
  const [form, setForm] = useState({ name: '', price: '', perks: '' });

  useEffect(() => {
    if (bLoading) return;
    if (!beautician) { setPlans([]); setMembers([]); setLoaded(true); return; }
    setLoaded(false); setLoadFailed(false); setError(null);
    Promise.all([
      fetchRowsStrict('client_memberships', beautician.id, { order: 'price_cents', ascending: true }),
      fetchRowsStrict('membership_subscriptions', beautician.id, { select: '*, clients(first_name, last_name)', order: 'created_at', ascending: false }),
    ]).then(([p, m]) => {
      setPlans((p || []).map(normalisePlan));
      setMembers((m || []).map(normaliseMember));
      setLoaded(true);
    }).catch(() => {
      setLoadFailed(true); setError('Could not load memberships. Try again.');
      // Never leave the page stuck on the loader if a fetch fails.
      setPlans([]);
      setMembers([]);
      setLoaded(true);
    });
  }, [beautician, bLoading, retry]);

  if (bLoading || !loaded) return <PageLoader />;

  if (loadFailed) return <div style={s.page}><PageHeader title="Memberships" /><ErrorCard message={error} /><button className="fl-tap" onClick={() => setRetry(n => n + 1)}>Try again</button></div>;

  const activeRecords = members.filter(m => m.status === 'active');
  const activeMembers = activeRecords.length;
  const activePrices = activeRecords.map(m => plans.find(p => p.id === m.plan)?.price);
  const hasMissingPrice = activePrices.some(price => price == null);
  const activePlanValue = activePrices.reduce((total, price) => total + (price ?? 0), 0);

  async function handleCreatePlan() {
    if (saving || !form.name.trim() || !form.price) return;
    if (!Number.isFinite(Number(form.price)) || Number(form.price) <= 0) { setError('Enter a price greater than £0.'); return; }
    setError(null);
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
      setForm({ name: '', price: '', perks: '' });
      setShowCreate(false);
    } catch (e) { setError('Could not create this plan. Your details are still here.'); }
    finally { setSaving(false); }
  }

  async function updateMemberStatus(id, status) {
    if (updatingMember) return;
    setUpdatingMember(id); setError(null);
    try {
      const updates = { status };
      if (status === 'cancelled') updates.cancelled_at = new Date().toISOString();
      await updateRow('membership_subscriptions', id, updates);
      setMembers(prev => prev.map(m => m.id === id ? { ...m, status } : m));
    } catch (e) { setError('Could not update this membership. Please try again.'); }
    finally { setUpdatingMember(null); }
  }

  return (
    <div style={s.page}>
      <PageHeader title="Memberships" subtitle="Plans and membership records" />
      {error && <ErrorCard message={error} onDismiss={() => setError(null)} />}

      <div style={s.notice}>
        <strong style={{ color: 'var(--text, #241B17)' }}>Arrange recurring payments separately</strong>
        <p style={s.noticeText}>Florrie stores your plans and member statuses here. It does not collect recurring membership payments.</p>
      </div>

      <div style={s.heroCard}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12 }}>
          <div>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.85)', marginBottom: 4 }}>Active plan value</div>
            <div style={{ fontSize: hasMissingPrice ? 20 : 28, fontWeight: 700, color: 'var(--bg-card, #FFFCF9)' }}>{hasMissingPrice ? 'Not available' : `£${activePlanValue.toFixed(2)}`}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 20, fontWeight: 700, color: 'var(--bg-card, #FFFCF9)' }}>{activeMembers}</div>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.85)' }}>active records</div>
          </div>
        </div>
        <p style={{ margin: '12px 0 0', fontSize: 12, lineHeight: 1.5, color: 'rgba(255,255,255,0.85)' }}>
          {hasMissingPrice ? 'A plan or price is missing from an active record.' : 'The sum of plan prices for active records. This does not show payments collected.'}
        </p>
      </div>

      {/* Tabs */}
      <div style={s.tabRow}>
        {['plans', 'members', 'about'].map(t => (
          <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)} style={{ ...s.tab, ...(tab === t ? s.tabActive : {}) }}>
            {t === 'plans' ? 'Plans' : t === 'members' ? 'Members' : 'How it works'}
          </button>
        ))}
      </div>

      {/* Plans tab */}
      {tab === 'plans' && (
        <div style={s.planList}>
          {plans.length === 0 && !showCreate && (
            <EmptyState
              icon="card"
              title="No membership plans yet"
              subtitle="Save a plan's price and perks. Arrange membership payments outside Florrie."
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
                  <div style={{ fontSize: plan.price == null ? 14 : 24, fontWeight: 700, color: plan.textColor }}>{plan.price == null ? 'Price not set' : `£${plan.price.toFixed(2)}`}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-muted, #6B5D54)' }}>Plan price</div>
                </div>
              </div>
              {plan.perks.length > 0 && (
                <div style={s.perkList}>
                  {plan.perks.map((perk, i) => (
                    <div key={i} style={s.perkItem}>
                      <span style={{ color: plan.textColor }}><Icon name="check" size={15} /></span>
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
              <input type="text" aria-label="Plan name" placeholder="Plan name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} style={s.input} />
              <input type="number" min="0.01" step="0.01" aria-label="Plan price in pounds" placeholder="Plan price (£)" value={form.price} onChange={e => setForm({ ...form, price: e.target.value })} style={{ ...s.input, marginTop: 8 }} />
              <textarea aria-label="Perks, one per line" placeholder="Perks (one per line)" rows={3} value={form.perks} onChange={e => setForm({ ...form, perks: e.target.value })} style={{ ...s.input, marginTop: 8, resize: 'vertical' }} />
              <p style={s.noticeText}>Saving a plan does not enrol clients or set up payments.</p>
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
              icon="users"
              title="No members yet"
              subtitle="Existing membership records will appear here. This page does not enrol clients or take membership payments."
            />
          )}
          {members.map(member => {
            const plan = plans.find(p => p.id === member.plan);
            const sc = STATUS_COLORS[member.status] || STATUS_COLORS.unknown;
            const expanded = expandedMember === member.id;
            return (
              <article key={member.id} style={s.memberCard}>
                <button aria-expanded={expanded} aria-controls={`membership-${member.id}`} onClick={() => setExpandedMember(expanded ? null : member.id)} style={s.memberTop}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 600, fontSize: 14, color: 'var(--text, #241B17)' }}>{member.name}</div>
                    <div style={{ fontSize: 12, color: plan?.textColor || 'var(--text-muted, #6B5D54)', fontWeight: 600 }}>{plan?.name || 'Unknown plan'}</div>
                  </div>
                  <span style={{ padding: '3px 10px', borderRadius: 10, fontSize: 11, fontWeight: 600, background: sc.bg, color: sc.color }}>
                    {member.status}
                  </span>
                </button>
                {expanded && (
                  <div id={`membership-${member.id}`} style={{ marginTop: 10, borderTop: '1px solid var(--card-border, #E8DDD4)', paddingTop: 10, fontSize: 13 }}>
                    <div style={s.detailRow}><span style={s.detailLabel}>Started</span><span>{member.started}</span></div>
                    <div style={s.detailRow}><span style={s.detailLabel}>Recorded next payment</span><span>{member.nextPayment || 'Not set'}</span></div>
                    <p style={s.noticeText}>These actions change the membership status in Florrie. Manage any payment arrangement with your payment provider separately.</p>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 10 }}>
                      {member.status === 'active' && <button disabled={!!updatingMember} onClick={() => updateMemberStatus(member.id, 'paused')} style={s.smallBtn}>Mark paused</button>}
                      {member.status === 'paused' && <button disabled={!!updatingMember} onClick={() => updateMemberStatus(member.id, 'active')} style={{ ...s.smallBtn, color: 'var(--success, #386F52)' }}>Mark active</button>}
                      {member.status !== 'cancelled' && <button disabled={!!updatingMember} onClick={() => updateMemberStatus(member.id, 'cancelled')} style={{ ...s.smallBtn, color: 'var(--danger, #9E2B32)' }}>Mark cancelled</button>}
                    </div>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}

      {tab === 'about' && (
        <section style={s.planCard}>
          <h2 style={{ fontSize: 17, margin: '0 0 12px' }}>Your membership records</h2>
          <p style={s.noticeText}>Create plan records with a price and perks, then review the member records already saved in Florrie.</p>
          <p style={s.noticeText}>Active records can identify a client as a member on your booking page. Marking a record paused or cancelled changes that membership status.</p>
          <p style={s.noticeText}>Florrie does not set up recurring charges, collect membership payments, or pause or cancel a payment arrangement. Arrange and manage those payments separately.</p>
          <p style={s.noticeText}>The total shows the saved plan prices for active records. A recorded payment date is a reference, not a scheduled charge.</p>
        </section>
      )}
    </div>
  );
}

const s = {
  page: { padding: '20px 16px 40px', fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif", maxWidth: 480, margin: '0 auto' },
  heroCard: { padding: 20, borderRadius: 16, background: 'linear-gradient(135deg, var(--accent, #92405e), var(--accent-hover, #782b49))', marginBottom: 16 },
  notice: { padding: '14px 16px', borderRadius: 14, background: 'var(--bg, #FBF6F1)', border: '1px solid var(--card-border, #E8DDD4)', fontSize: 13, marginBottom: 16 },
  noticeText: { color: 'var(--text-muted, #6B5D54)', fontSize: 13, lineHeight: 1.6, margin: '8px 0 0' },
  tabRow: { display: 'flex', gap: 0, marginBottom: 16, borderRadius: 10, overflow: 'hidden', border: '1px solid var(--card-border, #E8DDD4)' },
  tab: { flex: 1, padding: '10px 0', border: 'none', background: 'none', fontSize: 13, fontWeight: 500, cursor: 'pointer', color: 'var(--text-muted, #6B5D54)', fontFamily: 'inherit' },
  tabActive: { background: 'var(--accent, #92405e)', color: 'var(--bg-card, #FFFCF9)' },
  planList: { display: 'flex', flexDirection: 'column', gap: 12 },
  planCard: { padding: 16, borderRadius: 16, background: 'var(--card-bg, #FFFCF9)', border: '1px solid var(--card-border, #E8DDD4)' },
  planHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 },
  perkList: { display: 'flex', flexDirection: 'column', gap: 6 },
  perkItem: { display: 'flex', alignItems: 'center', gap: 8 },
  addBtn: { padding: '14px', borderRadius: 10, border: '2px dashed var(--card-border, #E8DDD4)', background: 'none', fontSize: 14, fontWeight: 600, color: 'var(--accent, #92405e)', cursor: 'pointer', fontFamily: 'inherit' },
  formCard: { padding: 16, borderRadius: 10, background: 'var(--card-bg, #FFFCF9)', border: '1px solid var(--card-border, #E8DDD4)' },
  input: { width: '100%', padding: '10px 12px', borderRadius: 10, border: '1px solid var(--card-border, #E8DDD4)', fontSize: 13, fontFamily: 'inherit', boxSizing: 'border-box', background: 'var(--card-bg, #FFFCF9)', color: 'var(--text, #241B17)' },
  primaryBtn: { padding: '10px 20px', borderRadius: 10, border: 'none', background: 'var(--accent, #92405e)', color: 'var(--bg-card, #FFFCF9)', fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit' },
  ghostBtn: { padding: '10px 20px', borderRadius: 10, border: '1px solid var(--card-border, #E8DDD4)', background: 'none', fontSize: 13, fontWeight: 500, cursor: 'pointer', fontFamily: 'inherit', color: 'var(--text-muted, #6B5D54)' },
  memberList: { display: 'flex', flexDirection: 'column', gap: 10 },
  memberCard: { padding: '8px 12px', borderRadius: 10, background: 'var(--card-bg, #FFFCF9)', border: '1px solid var(--card-border, #E8DDD4)', textAlign: 'left', fontFamily: 'inherit', width: '100%', boxSizing: 'border-box' },
  memberTop: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, width: '100%', minHeight: 48, padding: '6px 0', border: 'none', background: 'none', cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit' },
  detailRow: { display: 'flex', flexWrap: 'wrap', gap: 8, justifyContent: 'space-between', padding: '4px 0', color: 'var(--text, #241B17)' },
  detailLabel: { color: 'var(--text-muted, #6B5D54)' },
  smallBtn: { background: 'none', border: '1px solid var(--card-border, #E8DDD4)', borderRadius: 'var(--radius-xs)', padding: '8px 12px', minHeight: 44, fontSize: 12, fontWeight: 500, cursor: 'pointer', color: 'var(--accent, #92405e)', fontFamily: 'inherit' },
};
