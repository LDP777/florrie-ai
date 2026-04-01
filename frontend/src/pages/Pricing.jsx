/**
 * Pricing — Plans & Billing page.
 *
 * Shows the four tiers (Free, Starter, Pro, Team), current plan status,
 * and handles Stripe Checkout redirect for upgrades. Also shows billing
 * history and manage-subscription link.
 */
import { useState } from 'react';
import { useBeautician, supabase } from '../lib/supabase.js';
import { PLANS } from '../lib/subscription.js';
import { ds, type } from '../lib/designSystem.js';

const API = import.meta.env.VITE_API_URL || '';

export default function Pricing() {
  const { beautician } = useBeautician();
  const currentPlan = beautician?.subscription_plan || 'free';
  const status = beautician?.subscription_status || 'trial';
  const trialEnd = beautician?.trial_ends_at ? new Date(beautician.trial_ends_at) : null;
  const [loading, setLoading] = useState(null); // planId being loaded
  const [error, setError] = useState(null);
  const [interval, setInterval] = useState('monthly'); // 'monthly' | 'annual'

  const daysLeft = trialEnd ? Math.max(0, Math.ceil((trialEnd - Date.now()) / 86400000)) : 0;

  async function handleUpgrade(planId) {
    if (planId === currentPlan) return;
    setLoading(planId);
    setError(null);
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      const res = await fetch(`${API}/api/billing/create-checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ plan: planId, interval }),
      });
      const data = await res.json();
      if (data.url) {
        window.location.href = data.url;
      } else {
        setError(data.error || 'Failed to start checkout');
      }
    } catch (err) {
      setError('Could not connect to billing. Try again shortly.');
    } finally {
      setLoading(null);
    }
  }

  async function handleManage() {
    setError(null);
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      const res = await fetch(`${API}/api/billing/portal`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
        },
      });
      const data = await res.json();
      if (data.url) {
        try {
          const redirectUrl = new URL(data.url);
          if (redirectUrl.hostname.endsWith('stripe.com')) {
            window.location.href = data.url;
          } else {
            setError('Invalid portal redirect');
          }
        } catch {
          setError('Invalid portal URL');
        }
      } else {
        setError(data.error || 'Failed to open billing portal');
      }
    } catch {
      setError('Could not connect to billing. Try again shortly.');
    }
  }

  return (
    <div style={S.page}>
      <h1 style={S.title}>Plans & Billing</h1>
      <p style={S.subtitle}>Choose the plan that fits your business</p>

      {/* Current plan banner */}
      <div style={S.banner}>
        <div>
          <div style={S.bannerLabel}>CURRENT PLAN</div>
          <div style={S.bannerPlan}>{PLANS.find(p => p.id === currentPlan)?.name || 'Free'}</div>
          {status === 'trial' && trialEnd && (
            <div style={S.bannerTrial}>
              {daysLeft > 0 ? `${daysLeft} day${daysLeft !== 1 ? 's' : ''} left on trial` : 'Trial expired'}
            </div>
          )}
          {status === 'active' && (
            <div style={S.bannerActive}>Active subscription</div>
          )}
        </div>
        {status === 'active' && (
          <button onClick={handleManage} style={S.manageBtn}>Manage</button>
        )}
      </div>

      {error && (
        <div style={S.error}>{error}</div>
      )}

      {/* Monthly / Annual toggle */}
      <div style={S.toggleWrap}>
        <button
          onClick={() => setInterval('monthly')}
          style={{ ...S.toggleBtn, ...(interval === 'monthly' ? S.toggleActive : {}) }}
        >Monthly</button>
        <button
          onClick={() => setInterval('annual')}
          style={{ ...S.toggleBtn, ...(interval === 'annual' ? S.toggleActive : {}) }}
        >Annual <span style={S.saveBadge}>Save 17%</span></button>
      </div>

      {/* Plan cards */}
      <div style={S.plans}>
        {PLANS.map(plan => {
          const isCurrent = plan.id === currentPlan;
          const isPopular = plan.popular;
          const showPrice = interval === 'annual' && plan.annualPriceLabel
            ? plan.annualPriceLabel
            : plan.priceLabel;
          return (
            <div key={plan.id} style={{ ...S.card, ...(isPopular ? S.cardPopular : {}), ...(isCurrent ? S.cardCurrent : {}) }}>
              {isPopular && <div style={S.popularBadge}>Most Popular</div>}
              <div style={S.cardHeader}>
                <div style={S.planName}>{plan.name}</div>
                <div style={S.planPrice}>{showPrice}</div>
              </div>
              {interval === 'annual' && plan.annualSaving && (
                <div style={S.annualSaving}>{plan.annualSaving}</div>
              )}
              <div style={S.featureList}>
                {plan.features.map(f => (
                  <div key={f} style={S.feature}>
                    <span style={S.featureCheck}>✓</span>
                    <span style={S.featureText}>{f}</span>
                  </div>
                ))}
              </div>
              {isCurrent ? (
                <div style={S.currentLabel}>Current Plan</div>
              ) : (
                <button
                  onClick={() => handleUpgrade(plan.id)}
                  disabled={loading === plan.id}
                  style={{
                    ...S.upgradeBtn,
                    ...(plan.price === 0 ? S.downgradeBtnStyle : {}),
                    opacity: loading === plan.id ? 0.6 : 1,
                  }}
                >
                  {loading === plan.id ? 'Loading...' : plan.price === 0 ? 'Downgrade' : (
                    PLANS.findIndex(p => p.id === currentPlan) > PLANS.findIndex(p => p.id === plan.id) ? 'Downgrade' : 'Upgrade'
                  )}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* FAQ-style info */}
      <div style={S.faq}>
        <div style={S.faqItem}>
          <div style={S.faqQ}>Can I change plans later?</div>
          <div style={S.faqA}>Yes, upgrade or downgrade any time. Changes take effect immediately and billing is prorated.</div>
        </div>
        <div style={S.faqItem}>
          <div style={S.faqQ}>What payment methods do you accept?</div>
          <div style={S.faqA}>All major cards via Stripe. Direct debit available on annual plans.</div>
        </div>
        <div style={S.faqItem}>
          <div style={S.faqQ}>Is there a contract?</div>
          <div style={S.faqA}>No lock-in. Monthly plans cancel any time. Annual plans save 20%.</div>
        </div>
      </div>
    </div>
  );
}

const S = {
  page: { padding: '20px 16px 100px', fontFamily: '"DM Sans", -apple-system, sans-serif', maxWidth: 480, margin: '0 auto' },
  title: { fontSize: 22, fontWeight: 700, color: 'var(--text, #2D2A26)', margin: '0 0 4px' },
  subtitle: { fontSize: 13, color: 'var(--text-muted, #B5AFA8)', margin: '0 0 20px' },

  banner: {
    background: 'linear-gradient(135deg, #2D2D3F 0%, #1A1A2E 40%, #C76B8A 100%)',
    borderRadius: 16, padding: '18px 16px', marginBottom: 20, color: '#fff',
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  },
  bannerLabel: { fontSize: 10, letterSpacing: '0.08em', opacity: 0.8, marginBottom: 4 },
  bannerPlan: { fontSize: 24, fontWeight: 700 },
  bannerTrial: { fontSize: 12, opacity: 0.9, marginTop: 4 },
  bannerActive: { fontSize: 12, opacity: 0.9, marginTop: 4 },
  manageBtn: {
    padding: '10px 20px', borderRadius: 10, border: '1px solid rgba(255,255,255,0.3)',
    background: 'rgba(255,255,255,0.1)', color: '#fff', fontSize: 13, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },

  error: {
    background: 'var(--danger-bg, #FDF0EF)', color: 'var(--danger, #D4605C)',
    padding: '10px 14px', borderRadius: 10, fontSize: 13, marginBottom: 16,
  },

  toggleWrap: {
    display: 'flex', gap: 0, marginBottom: 16,
    background: 'var(--bg-subtle, #F5F2EF)', borderRadius: 12, padding: 3,
  },
  toggleBtn: {
    flex: 1, padding: '10px 0', borderRadius: 10, border: 'none',
    background: 'transparent', color: 'var(--text-muted, #B5AFA8)',
    fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  },
  toggleActive: {
    background: 'var(--card, #fff)', color: 'var(--text, #2D2A26)',
    boxShadow: '0 1px 4px rgba(0,0,0,0.08)',
  },
  saveBadge: {
    background: 'var(--success, #5BA97B)', color: '#fff',
    fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 6,
  },
  annualSaving: {
    fontSize: 11, fontWeight: 600, color: 'var(--success, #5BA97B)',
    marginTop: -8, marginBottom: 8,
  },

  plans: { display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 24 },
  card: {
    background: 'var(--card, #fff)', borderRadius: 16, padding: 18,
    border: '1px solid var(--border, #EDE9E4)', position: 'relative',
  },
  cardPopular: {
    border: '2px solid var(--accent, #C76B8A)',
    boxShadow: '0 4px 16px rgba(199,107,138,0.15)',
  },
  cardCurrent: {
    background: 'var(--bg-subtle, #F9F7F4)',
  },
  popularBadge: {
    position: 'absolute', top: -10, right: 16,
    background: 'var(--accent, #C76B8A)', color: '#fff',
    fontSize: 10, fontWeight: 700, padding: '3px 10px', borderRadius: 8,
    letterSpacing: '0.03em',
  },
  cardHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14,
  },
  planName: { fontSize: 18, fontWeight: 700, color: 'var(--text, #2D2A26)' },
  planPrice: { fontSize: 18, fontWeight: 700, color: 'var(--accent, #C76B8A)' },

  featureList: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16 },
  feature: { display: 'flex', alignItems: 'center', gap: 8 },
  featureCheck: { color: 'var(--success, #5BA97B)', fontSize: 13, fontWeight: 700, flexShrink: 0 },
  featureText: { fontSize: 13, color: 'var(--text-secondary, #7A756F)' },

  currentLabel: {
    textAlign: 'center', padding: '10px 0', fontSize: 13, fontWeight: 600,
    color: 'var(--text-muted, #B5AFA8)', borderTop: '1px solid var(--border, #EDE9E4)',
  },
  upgradeBtn: {
    width: '100%', padding: '12px 0', borderRadius: 12, border: 'none',
    background: 'var(--accent, #C76B8A)', color: '#fff', fontSize: 14, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },
  downgradeBtnStyle: {
    background: 'var(--bg-subtle, #F5F2EF)', color: 'var(--text-muted, #B5AFA8)',
    border: '1px solid var(--border, #EDE9E4)',
  },

  faq: { display: 'flex', flexDirection: 'column', gap: 12 },
  faqItem: {
    background: 'var(--card, #fff)', borderRadius: 12, padding: 14,
  },
  faqQ: { fontSize: 14, fontWeight: 600, color: 'var(--text, #2D2A26)', marginBottom: 4 },
  faqA: { fontSize: 13, color: 'var(--text-secondary, #7A756F)', lineHeight: 1.4 },
};
