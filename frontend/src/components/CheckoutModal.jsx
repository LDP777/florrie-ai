/**
 * CheckoutModal - Stripe Payment Element embedded in a modal.
 *
 * Uses the Payment Element (not Checkout Sessions) for a fully native,
 * Florrie-styled card form. No iframes from Stripe's hosted UI, no
 * page redirects for card payments.
 *
 * Flow:
 *   1. Backend creates subscription in 'default_incomplete' state
 *   2. Backend returns clientSecret from latest_invoice.payment_intent
 *   3. We mount stripe.elements({ clientSecret }).create('payment')
 *   4. User fills in card / Apple Pay / Google Pay
 *   5. stripe.confirmPayment() → subscription goes active
 *   6. Webhook updates beautician's plan in DB
 *
 * Props:
 *   plan        - 'florrie' | 'florrie_team'
 *   interval    - 'monthly' | 'annual'
 *   authToken   - JWT from Supabase session
 *   onClose     - called when modal dismissed
 *   onSuccess   - called after successful payment
 */
import { useState, useEffect, useRef } from 'react';

const STRIPE_PK = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY;
const API = import.meta.env.VITE_API_URL || '';
const APP_URL = import.meta.env.VITE_APP_URL || 'https://app.florrie.ai';

// Wait for Stripe.js CDN script to load
function waitForStripe(timeout = 8000) {
  return new Promise((resolve, reject) => {
    if (window.Stripe) return resolve(window.Stripe);
    const start = Date.now();
    const id = setInterval(() => {
      if (window.Stripe) { clearInterval(id); resolve(window.Stripe); }
      else if (Date.now() - start > timeout) { clearInterval(id); reject(new Error('Stripe.js failed to load.')); }
    }, 50);
  });
}

const PLAN_LABELS = {
  florrie: 'Florrie',
  florrie_team: 'Florrie for Teams',
};

const PRICE_LABELS = {
  florrie_monthly: '£29/month',
  florrie_annual: '£290/year',
  florrie_team_monthly: '£44/month',
  florrie_team_annual: '£440/year',
};

export default function CheckoutModal({ plan, interval, authToken, onClose, onSuccess }) {
  const mountRef = useRef(null);
  const stripeRef = useRef(null);
  const elementsRef = useRef(null);

  const [stage, setStage] = useState('loading'); // loading | ready | submitting | success | error
  const [errorMsg, setErrorMsg] = useState(null);

  const priceLabel = PRICE_LABELS[`${plan}_${interval}`] || '';
  const planLabel = PLAN_LABELS[plan] || plan;

  // Initialise Payment Element
  useEffect(() => {
    let mounted = true;

    async function init() {
      if (!STRIPE_PK) {
        setErrorMsg('Stripe is not configured (missing VITE_STRIPE_PUBLISHABLE_KEY).');
        setStage('error');
        return;
      }

      try {
        // 1. Load Stripe.js
        const StripeConstructor = await waitForStripe();
        stripeRef.current = StripeConstructor(STRIPE_PK);

        // 2. Create subscription intent on backend
        const res = await fetch(`${API}/api/billing/create-subscription-intent`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${authToken}`,
          },
          body: JSON.stringify({ plan, interval }),
        });

        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'Failed to set up billing');
        if (!data.clientSecret) throw new Error('No clientSecret returned from server');

        if (!mounted) return;

        // 3. Create Elements with Florrie's appearance
        elementsRef.current = stripeRef.current.elements({
          clientSecret: data.clientSecret,
          appearance: {
            theme: 'stripe',
            variables: {
              colorPrimary: '#92405e',
              colorBackground: '#ffffff',
              colorText: '#1d1b19',
              colorTextSecondary: '#534247',
              colorTextPlaceholder: '#867277',
              colorDanger: '#ba1a1a',
              colorSuccess: '#5BA97B',
              colorWarning: '#D4943A',
              fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
              fontSizeBase: '14px',
              fontWeightNormal: '500',
              fontWeightMedium: '600',
              spacingUnit: '4px',
              borderRadius: '10px',
              focusBoxShadow: '0 0 0 3px rgba(146, 64, 94, 0.15)',
              focusOutline: 'none',
            },
            rules: {
              '.Input': {
                border: '1.5px solid #d8c1c6',
                boxShadow: 'none',
                padding: '12px 14px',
                fontSize: '14px',
                transition: 'border-color 0.15s ease',
              },
              '.Input:focus': {
                border: '1.5px solid #92405e',
                boxShadow: '0 0 0 3px rgba(146, 64, 94, 0.12)',
              },
              '.Input--invalid': {
                border: '1.5px solid #ba1a1a',
                boxShadow: 'none',
              },
              '.Label': {
                fontSize: '12px',
                fontWeight: '600',
                color: '#534247',
                letterSpacing: '0.04em',
                textTransform: 'uppercase',
                marginBottom: '6px',
              },
              '.Error': {
                color: '#ba1a1a',
                fontSize: '12px',
                marginTop: '4px',
              },
              '.Tab': {
                border: '1.5px solid #d8c1c6',
                boxShadow: 'none',
                borderRadius: '10px',
              },
              '.Tab:hover': {
                border: '1.5px solid #92405e',
              },
              '.Tab--selected': {
                border: '1.5px solid #92405e',
                boxShadow: '0 0 0 3px rgba(146, 64, 94, 0.1)',
              },
              '.TabIcon--selected': {
                fill: '#92405e',
              },
              '.TabLabel--selected': {
                color: '#92405e',
              },
            },
          },
        });

        // 4. Mount Payment Element
        const paymentEl = elementsRef.current.create('payment', {
          layout: { type: 'tabs', defaultCollapsed: false },
          wallets: { applePay: 'auto', googlePay: 'auto' },
        });

        if (mountRef.current) {
          paymentEl.mount(mountRef.current);
        }

        if (mounted) setStage('ready');
      } catch (err) {
        if (mounted) {
          setErrorMsg(err.message || 'Failed to load payment form');
          setStage('error');
        }
      }
    }

    init();

    return () => {
      mounted = false;
      // Unmount payment element on cleanup
      if (elementsRef.current) {
        try { elementsRef.current.getElement('payment')?.unmount(); } catch (_) {}
      }
    };
  }, [plan, interval, authToken]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keyboard + scroll lock
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && stage !== 'submitting') onClose(); };
    window.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose, stage]);

  async function handleSubmit(e) {
    e.preventDefault();
    if (!stripeRef.current || !elementsRef.current || stage !== 'ready') return;

    setStage('submitting');
    setErrorMsg(null);

    const { error } = await stripeRef.current.confirmPayment({
      elements: elementsRef.current,
      confirmParams: {
        return_url: `${APP_URL}/pricing?success=1`,
      },
      // Don't redirect for card payments - handle inline
      redirect: 'if_required',
    });

    if (error) {
      // Show error inline, don't close modal
      setErrorMsg(
        error.type === 'card_error' || error.type === 'validation_error'
          ? error.message
          : 'Payment failed. Please try a different card or contact support.'
      );
      setStage('ready');
    } else {
      // Payment confirmed - subscription is now active
      setStage('success');
      setTimeout(() => onSuccess?.(), 1200);
    }
  }

  const canClose = stage !== 'submitting';

  return (
    <div
      style={S.overlay}
      onClick={(e) => { if (e.target === e.currentTarget && canClose) onClose(); }}
    >
      <div style={S.modal} role="dialog" aria-modal="true" aria-label="Subscribe to Florrie">

        {/* Header */}
        <div style={S.header}>
          <div style={S.headerLeft}>
            <div style={S.logo}>✦</div>
            <div>
              <div style={S.headerTitle}>Subscribe to {planLabel}</div>
              <div style={S.headerSub}>{priceLabel} · Cancel anytime</div>
            </div>
          </div>
          {canClose && (
            <button onClick={onClose} style={S.closeBtn} aria-label="Close">✕</button>
          )}
        </div>

        {/* Loading */}
        {stage === 'loading' && (
          <div style={S.centreWrap}>
            <div style={S.spinner} />
            <div style={S.dimText}>Setting up secure payment…</div>
          </div>
        )}

        {/* Error */}
        {stage === 'error' && (
          <div style={S.centreWrap}>
            <div style={S.errorIcon}>⚠</div>
            <div style={S.errorBig}>{errorMsg}</div>
            <button onClick={onClose} style={S.ghostBtn}>Close</button>
          </div>
        )}

        {/* Success */}
        {stage === 'success' && (
          <div style={S.centreWrap}>
            <div style={S.successIcon}>✓</div>
            <div style={S.successText}>You're subscribed!</div>
            <div style={S.dimText}>Setting up your account…</div>
          </div>
        )}

        {/* Payment form - always rendered so Stripe can mount, hidden when not needed */}
        <form
          onSubmit={handleSubmit}
          style={{ display: stage === 'loading' || stage === 'error' || stage === 'success' ? 'none' : 'block', padding: '0 20px 20px' }}
        >
          {/* Payment Element mounts here */}
          <div ref={mountRef} style={S.elementMount} />

          {/* Inline error */}
          {errorMsg && stage === 'ready' && (
            <div style={S.inlineError}>{errorMsg}</div>
          )}

          {/* Submit */}
          <button
            type="submit"
            disabled={stage === 'submitting'}
            style={{ ...S.payBtn, opacity: stage === 'submitting' ? 0.7 : 1 }}
          >
            {stage === 'submitting' ? (
              <span style={S.btnInner}>
                <span style={S.btnSpinner} />
                Processing…
              </span>
            ) : (
              `Pay ${priceLabel}`
            )}
          </button>

          <p style={S.secureNote}>
            🔒 Secured by Stripe. Your card details never touch our servers.
          </p>
        </form>

      </div>
    </div>
  );
}

const S = {
  overlay: {
    position: 'fixed', inset: 0,
    background: 'rgba(29, 27, 25, 0.65)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    zIndex: 9999,
    padding: '16px',
    animation: 'fadeIn 0.2s ease',
  },
  modal: {
    background: '#fff',
    borderRadius: 20,
    width: '100%', maxWidth: 480,
    maxHeight: '92vh', overflowY: 'auto',
    boxShadow: '0 24px 64px rgba(146, 64, 94, 0.15), 0 4px 16px rgba(0,0,0,0.1)',
    animation: 'scaleIn 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)',
  },
  header: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    padding: '18px 20px 16px',
    borderBottom: '1px solid #ede7e3',
  },
  headerLeft: { display: 'flex', alignItems: 'center', gap: 12 },
  logo: {
    width: 36, height: 36,
    background: 'linear-gradient(135deg, #c76b8a 0%, #92405e 100%)',
    borderRadius: 10,
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: '#fff', fontSize: 16, fontWeight: 700, flexShrink: 0,
  },
  headerTitle: { fontSize: 15, fontWeight: 700, color: '#1d1b19' },
  headerSub: { fontSize: 12, color: '#867277', marginTop: 2 },
  closeBtn: {
    background: 'none', border: 'none', cursor: 'pointer',
    fontSize: 14, color: '#867277', padding: '6px 8px',
    borderRadius: 8, fontFamily: 'inherit', lineHeight: 1,
  },

  centreWrap: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    padding: '48px 24px', gap: 12, textAlign: 'center',
  },
  spinner: {
    width: 36, height: 36, borderRadius: '50%',
    border: '3px solid #ede7e3', borderTopColor: '#92405e',
    animation: 'spin 0.75s linear infinite',
  },
  dimText: { fontSize: 13, color: '#867277' },
  errorIcon: { fontSize: 28, color: '#ba1a1a' },
  errorBig: { fontSize: 14, color: '#ba1a1a', lineHeight: 1.5, maxWidth: 320 },
  successIcon: {
    width: 52, height: 52, borderRadius: '50%',
    background: 'linear-gradient(135deg, #5BA97B, #3d8a5e)',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
    color: '#fff', fontSize: 22, fontWeight: 700,
  },
  successText: { fontSize: 18, fontWeight: 700, color: '#1d1b19' },
  ghostBtn: {
    marginTop: 8, padding: '10px 28px', borderRadius: 10,
    border: '1px solid #d8c1c6', background: '#fff',
    cursor: 'pointer', fontSize: 14, fontWeight: 600,
    fontFamily: 'inherit', color: '#1d1b19',
  },

  elementMount: { margin: '20px 0 16px', minHeight: 200 },

  inlineError: {
    background: '#ffdad6', color: '#ba1a1a',
    padding: '10px 14px', borderRadius: 10,
    fontSize: 13, marginBottom: 14, lineHeight: 1.4,
  },

  payBtn: {
    width: '100%', padding: '14px 0',
    borderRadius: 12, border: 'none',
    background: 'linear-gradient(135deg, #c76b8a 0%, #92405e 100%)',
    color: '#fff', fontSize: 15, fontWeight: 700,
    cursor: 'pointer', fontFamily: 'inherit',
    boxShadow: '0 4px 16px rgba(146, 64, 94, 0.3)',
    transition: 'opacity 0.15s ease, transform 0.15s ease',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },
  btnInner: { display: 'flex', alignItems: 'center', gap: 8 },
  btnSpinner: {
    width: 16, height: 16, borderRadius: '50%',
    border: '2px solid rgba(255,255,255,0.3)',
    borderTopColor: '#fff',
    animation: 'spin 0.75s linear infinite',
    display: 'inline-block',
  },

  secureNote: {
    textAlign: 'center', fontSize: 11, color: '#B5AFA8',
    marginTop: 12, lineHeight: 1.4,
  },
};
