/**
 * Pricing - Plans & Billing page.
 *
 * Single plan (Florrie £29/mo), with team add-on option.
 * Monthly/annual toggle. Stripe Checkout for upgrades, portal for management.
 */
import { useState } from 'react';
import { useBeautician, supabase } from '../lib/supabase.js';
import { PLAN, TEAM_ADDON, getPlanName, isPaidPlan } from '../lib/subscription.js';
import { ds, type } from '../lib/designSystem.js';
import CheckoutModal from '../components/CheckoutModal.jsx';
import { isIOSNative } from '../lib/platform.js';
import Icon from '../components/ui/Icon';

const API = import.meta.env.VITE_API_URL || '';

export default function Pricing() {
  // iOS App Store compliance (Guideline 3.1.3(b) Multiplatform Services):
  // We must not show pricing, signup CTAs, or links to external purchase flows
  // inside the native iOS app. Render a benign placeholder instead.
  if (isIOSNative()) {
    return (
      <div style={S.iosWrap}>
        <div style={S.iosCard}>
          <div style={S.iosTitle}>Plans &amp; Billing</div>
          <p style={S.iosBody}>
            To view plans or manage your subscription, visit florrie.ai on the web.
          </p>
        </div>
      </div>
    );
  }

  const { beautician } = useBeautician();
  const currentPlan = beautician?.subscription_plan || 'trial';
  const status = beautician?.subscription_status || 'trial';
  const trialEnd = beautician?.trial_ends_at ? new Date(beautician.trial_ends_at) : null;
  const [loading, setLoading] = useState(null);
  const [error, setError] = useState(null);
  const [interval, setInterval] = useState('monthly');
  const [modal, setModal] = useState(null); // { plan, token } | null

  const daysLeft = trialEnd ? Math.max(0, Math.ceil((trialEnd - Date.now()) / 86400000)) : 0;
  const trialExpired = currentPlan === 'trial' && trialEnd && daysLeft === 0;
  const isActive = status === 'active' && isPaidPlan(currentPlan);

  async function handleUpgrade(planId) {
    setLoading(planId);
    setError(null);
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      if (!token) {
        setError('Session expired. Please refresh and try again.');
        return;
      }

      // If Stripe publishable key is available, open Payment Element modal.
      // Otherwise fall back to Stripe Checkout redirect.
      if (import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY) {
        setModal({ plan: planId, token });
      } else {
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
      }
    } catch {
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
        headers: { 'Authorization': `Bearer ${token}` },
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

  const showPrice = interval === 'annual' ? PLAN.annualLabel : PLAN.monthlyLabel;
  const seatPrice = interval === 'annual' ? TEAM_ADDON.seatAnnualLabel : TEAM_ADDON.seatMonthlyLabel;

  function handleCheckoutSuccess() {
    setModal(null);
    // Reload so the current-plan banner reflects the new subscription
    window.location.reload();
  }

  return (
    <div style={S.page}>
      <h1 style={S.title}>Plans & Billing</h1>
      <p style={S.subtitle}>One plan. Everything included.</p>

      {/* Current plan banner */}
      <div style={S.banner}>
        <div>
          <div style={S.bannerLabel}>CURRENT PLAN</div>
          <div style={S.bannerPlan}>{getPlanName(currentPlan)}</div>
          {currentPlan === 'trial' && trialEnd && (
            <div style={S.bannerTrial}>
              {daysLeft > 0
                ? `${daysLeft} day${daysLeft !== 1 ? 's' : ''} left on trial`
                : 'Trial expired - subscribe to keep your data'}
            </div>
          )}
          {isActive && (
            <div style={S.bannerActive}>Active subscription</div>
          )}
        </div>
        {isActive && (
          <button onClick={handleManage} style={S.manageBtn}>Manage</button>
        )}
      </div>

      {error && <div style={S.error}>{error}</div>}

      {/* Monthly / Annual toggle */}
      <div style={S.toggleWrap}>
        <button
          onClick={() => setInterval('monthly')}
          style={{ ...S.toggleBtn, ...(interval === 'monthly' ? S.toggleActive : {}) }}
        >Monthly</button>
        <button
          onClick={() => setInterval('annual')}
          style={{ ...S.toggleBtn, ...(interval === 'annual' ? S.toggleActive : {}) }}
        >Annual <span style={S.saveBadge}>{PLAN.annualSaving}</span></button>
      </div>

      {/* Main plan card */}
      <div style={S.card}>
        <div style={S.cardHeader}>
          <div style={S.planName}>{PLAN.name}</div>
          <div style={S.planPrice}>{showPrice}</div>
        </div>
        {interval === 'annual' && (
          <div style={S.annualNote}>Billed annually at £290</div>
        )}
        <div style={S.featureList}>
          {PLAN.features.map(f => (
            <div key={f} style={S.feature}>
              <span style={S.featureCheck}><Icon name="check" size={15} /></span>
              <span style={S.featureText}>{f}</span>
            </div>
          ))}
        </div>
        {currentPlan === 'florrie' || currentPlan === 'florrie_team' ? (
          <div style={S.currentLabel}>
            {currentPlan === 'florrie' ? 'Current Plan' : 'Included in your plan'}
          </div>
        ) : (
          <button
            onClick={() => handleUpgrade('florrie')}
            disabled={loading === 'florrie'}
            style={{ ...S.upgradeBtn, opacity: loading === 'florrie' ? 0.6 : 1 }}
          >
            {loading === 'florrie' ? 'Loading...' : trialExpired ? 'Subscribe now' : 'Start subscription'}
          </button>
        )}
      </div>

      {/* Team add-on card */}
      <div style={S.teamCard}>
        <div style={S.teamHeader}>
          <div style={S.teamTitle}>Got a team?</div>
          <div style={S.teamPrice}>{seatPrice}</div>
        </div>
        <div style={S.teamDesc}>
          Everything in Florrie, plus tools for managing multiple staff and locations.
        </div>
        <div style={S.featureList}>
          {TEAM_ADDON.extras.map(f => (
            <div key={f} style={S.feature}>
              <span style={S.featureCheck}><Icon name="check" size={15} /></span>
              <span style={S.featureText}>{f}</span>
            </div>
          ))}
        </div>
        {currentPlan === 'florrie_team' ? (
          <div style={S.currentLabel}>Current Plan</div>
        ) : isPaidPlan(currentPlan) ? (
          <button
            onClick={() => handleUpgrade('florrie_team')}
            disabled={loading === 'florrie_team'}
            style={{ ...S.upgradeBtn, ...S.teamBtn, opacity: loading === 'florrie_team' ? 0.6 : 1 }}
          >
            {loading === 'florrie_team' ? 'Loading...' : 'Add team features'}
          </button>
        ) : (
          <div style={S.teamNote}>Available after subscribing to Florrie</div>
        )}
      </div>

      {/* Trial urgency nudge */}
      {currentPlan === 'trial' && daysLeft > 0 && daysLeft <= 3 && (
        <div style={S.urgency}>
          Your trial ends in {daysLeft} day{daysLeft !== 1 ? 's' : ''}. Subscribe to keep everything - your data, clients, and settings stay exactly as they are.
        </div>
      )}

      {/* Embedded Stripe Checkout Modal */}
      {modal && (
        <CheckoutModal
          plan={modal.plan}
          interval={interval}
          authToken={modal.token}
          onClose={() => setModal(null)}
          onSuccess={handleCheckoutSuccess}
        />
      )}

      {/* FAQ */}
      <div style={S.faq}>
        <div style={S.faqItem}>
          <div style={S.faqQ}>What happens when my trial ends?</div>
          <div style={S.faqA}>Your account goes read-only. All your data is safe - subscribe any time to pick up where you left off.</div>
        </div>
        <div style={S.faqItem}>
          <div style={S.faqQ}>What about messages over 120/month?</div>
          <div style={S.faqA}>Any messages over 120/month are billed at 6p (SMS) or 5p (WhatsApp) each. Most solo beauticians stay well within the limit.</div>
        </div>
        <div style={S.faqItem}>
          <div style={S.faqQ}>Can I cancel any time?</div>
          <div style={S.faqA}>Yes, no lock-in. Monthly plans cancel instantly. Annual plans run to the end of the billing period.</div>
        </div>
        <div style={S.faqItem}>
          <div style={S.faqQ}>What payment methods do you accept?</div>
          <div style={S.faqA}>All major cards via Stripe. Direct debit available on annual plans.</div>
        </div>
      </div>
    </div>
  );
}

const S = {
  page: { padding: '20px 16px 100px', fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif", maxWidth: 480, margin: '0 auto' },
  title: { fontSize: 22, fontWeight: 700, color: 'var(--text, #241B17)', margin: '0 0 4px' },
  subtitle: { fontSize: 13, color: 'var(--text-muted, #6B5D54)', margin: '0 0 20px' },

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
    background: 'var(--danger-bg, #F7E4E4)', color: 'var(--danger, #9E2B32)',
    padding: '10px 14px', borderRadius: 10, fontSize: 13, marginBottom: 16,
  },

  toggleWrap: {
    display: 'flex', gap: 0, marginBottom: 16,
    background: 'var(--bg-subtle, #ede7e3)', borderRadius: 10, padding: 3,
  },
  toggleBtn: {
    flex: 1, padding: '10px 0', borderRadius: 10, border: 'none',
    background: 'transparent', color: 'var(--text-muted, #6B5D54)',
    fontSize: 13, fontWeight: 600, cursor: 'pointer', fontFamily: 'inherit',
    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
  },
  toggleActive: {
    background: 'var(--card, #FFFCF9)', color: 'var(--text, #241B17)',
    boxShadow: 'var(--elev-1)',
  },
  saveBadge: {
    background: 'var(--success, #386F52)', color: '#fff',
    fontSize: 10, fontWeight: 700, padding: '2px 6px', borderRadius: 6,
  },

  card: {
    background: 'var(--card, #FFFCF9)', borderRadius: 16, padding: 18,
    border: '2px solid var(--accent, #92405e)', marginBottom: 12,
    boxShadow: 'var(--elev-2)',
  },
  cardHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4,
  },
  planName: { fontSize: 20, fontWeight: 700, color: 'var(--text, #241B17)' },
  planPrice: { fontSize: 20, fontWeight: 700, color: 'var(--accent, #92405e)' },
  annualNote: {
    fontSize: 11, color: 'var(--text-muted, #6B5D54)', marginBottom: 14,
  },

  featureList: { display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 16, marginTop: 14 },
  feature: { display: 'flex', alignItems: 'center', gap: 8 },
  featureCheck: { color: 'var(--success, #386F52)', fontSize: 13, fontWeight: 700, flexShrink: 0 },
  featureText: { fontSize: 13, color: 'var(--text-secondary, #574A42)' },

  currentLabel: {
    textAlign: 'center', padding: '10px 0', fontSize: 13, fontWeight: 600,
    color: 'var(--text-muted, #6B5D54)', borderTop: '1px solid var(--border, #E8DDD4)',
  },
  upgradeBtn: {
    width: '100%', padding: '12px 0', borderRadius: 10, border: 'none',
    background: 'var(--accent, #92405e)', color: '#fff', fontSize: 14, fontWeight: 600,
    cursor: 'pointer', fontFamily: 'inherit',
  },

  teamCard: {
    background: 'var(--card, #FFFCF9)', borderRadius: 16, padding: 18,
    border: '1px solid var(--border, #E8DDD4)', marginBottom: 20,
  },
  teamHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6,
  },
  teamTitle: { fontSize: 16, fontWeight: 700, color: 'var(--text, #241B17)' },
  teamPrice: { fontSize: 13, fontWeight: 600, color: 'var(--accent, #92405e)' },
  teamDesc: {
    fontSize: 13, color: 'var(--text-secondary, #574A42)', lineHeight: 1.4, marginBottom: 4,
  },
  teamBtn: {
    background: 'var(--bg-subtle, #ede7e3)', color: 'var(--text, #241B17)',
    border: '1px solid var(--border, #E8DDD4)',
  },
  teamNote: {
    textAlign: 'center', padding: '10px 0', fontSize: 12,
    color: 'var(--text-muted, #6B5D54)', fontStyle: 'italic',
  },

  urgency: {
    background: 'linear-gradient(135deg, rgba(199,107,138,0.08), rgba(199,107,138,0.15))',
    borderRadius: 10, padding: 14, marginBottom: 20,
    fontSize: 13, color: 'var(--text, #241B17)', lineHeight: 1.4,
    border: '1px solid rgba(199,107,138,0.2)',
  },

  faq: { display: 'flex', flexDirection: 'column', gap: 12 },
  faqItem: { background: 'var(--card, #FFFCF9)', borderRadius: 10, padding: 14 },
  faqQ: { fontSize: 14, fontWeight: 600, color: 'var(--text, #241B17)', marginBottom: 4 },
  faqA: { fontSize: 13, color: 'var(--text-secondary, #574A42)', lineHeight: 1.4 },

  // iOS-only placeholder styles (App Store Guideline 3.1.3(b) compliant)
  iosWrap: {
    padding: '60px 20px',
    fontFamily: "'Plus Jakarta Sans', -apple-system, sans-serif",
    maxWidth: 480,
    margin: '0 auto',
    minHeight: '60vh',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  iosCard: {
    background: 'var(--card, #FFFCF9)',
    borderRadius: 16,
    padding: '32px 24px',
    textAlign: 'center',
    border: '1px solid var(--border, #E8DDD4)',
    width: '100%',
  },
  iosTitle: {
    fontSize: 20,
    fontWeight: 700,
    color: 'var(--text, #241B17)',
    marginBottom: 12,
    fontFamily: '"Playfair Display", Georgia, serif',
  },
  iosBody: {
    fontSize: 14,
    color: 'var(--text-secondary, #574A42)',
    lineHeight: 1.5,
    margin: 0,
  },
};
