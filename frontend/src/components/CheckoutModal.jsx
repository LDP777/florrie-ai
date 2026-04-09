/**
 * CheckoutModal — Stripe Embedded Checkout, rendered in a modal overlay.
 *
 * Uses Stripe.js loaded via CDN (window.Stripe) to init an embedded checkout
 * session. The backend must return `clientSecret` when called with `embedded: true`.
 *
 * Props:
 *   plan        — 'florrie' | 'florrie_team'
 *   interval    — 'monthly' | 'annual'
 *   authToken   — JWT from Supabase session
 *   onClose     — called when user dismisses the modal
 *   onSuccess   — called after successful payment
 */
import { useState, useEffect, useRef } from 'react';

const STRIPE_PK = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY;
const API = import.meta.env.VITE_API_URL || '';

// Wait for Stripe.js to load (it's async on the CDN script tag)
function waitForStripe(timeout = 8000) {
  return new Promise((resolve, reject) => {
    if (window.Stripe) return resolve(window.Stripe);
    const start = Date.now();
    const interval = setInterval(() => {
      if (window.Stripe) {
        clearInterval(interval);
        resolve(window.Stripe);
      } else if (Date.now() - start > timeout) {
        clearInterval(interval);
        reject(new Error('Stripe.js failed to load. Check your internet connection.'));
      }
    }, 50);
  });
}

export default function CheckoutModal({ plan, interval, authToken, onClose, onSuccess }) {
  const containerRef = useRef(null);
  const checkoutRef = useRef(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    let mounted = true;

    async function init() {
      if (!STRIPE_PK) {
        setError('Stripe publishable key is not configured. Add VITE_STRIPE_PUBLISHABLE_KEY to your .env.');
        setLoading(false);
        return;
      }

      try {
        const StripeConstructor = await waitForStripe();
        const stripe = StripeConstructor(STRIPE_PK);

        const checkout = await stripe.initEmbeddedCheckout({
          fetchClientSecret: async () => {
            const res = await fetch(`${API}/api/billing/create-checkout`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${authToken}`,
              },
              body: JSON.stringify({ plan, interval, embedded: true }),
            });

            const data = await res.json();
            if (!res.ok || data.error) {
              throw new Error(data.error || 'Failed to create checkout session');
            }
            return data.clientSecret;
          },
          onComplete: () => {
            if (mounted) {
              onSuccess?.();
            }
          },
        });

        if (!mounted) {
          checkout.destroy();
          return;
        }

        checkoutRef.current = checkout;

        if (containerRef.current) {
          checkout.mount(containerRef.current);
        }

        setLoading(false);
      } catch (err) {
        if (mounted) {
          setError(err.message || 'Failed to load checkout');
          setLoading(false);
        }
      }
    }

    init();

    return () => {
      mounted = false;
      if (checkoutRef.current) {
        checkoutRef.current.destroy();
        checkoutRef.current = null;
      }
    };
  }, [plan, interval, authToken]); // eslint-disable-line react-hooks/exhaustive-deps

  // Close on Escape key
  useEffect(() => {
    const handler = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [onClose]);

  // Prevent body scroll while modal is open
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = ''; };
  }, []);

  return (
    <div style={S.overlay} onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={S.modal} role="dialog" aria-modal="true" aria-label="Subscribe to Florrie">

        {/* Header */}
        <div style={S.header}>
          <div style={S.headerLeft}>
            <div style={S.headerLogo}>✦</div>
            <div>
              <div style={S.headerTitle}>Subscribe to Florrie</div>
              <div style={S.headerSub}>Secure checkout powered by Stripe</div>
            </div>
          </div>
          <button onClick={onClose} style={S.closeBtn} aria-label="Close">✕</button>
        </div>

        {/* Loading state */}
        {loading && (
          <div style={S.loadingWrap}>
            <div style={S.spinner} />
            <div style={S.loadingText}>Loading secure checkout…</div>
          </div>
        )}

        {/* Error state */}
        {error && !loading && (
          <div style={S.errorWrap}>
            <div style={S.errorIcon}>⚠</div>
            <div style={S.errorText}>{error}</div>
            <button onClick={onClose} style={S.fallbackBtn}>Close</button>
          </div>
        )}

        {/* Stripe mounts here */}
        <div
          ref={containerRef}
          id="stripe-checkout-container"
          style={{ display: loading || error ? 'none' : 'block' }}
        />
      </div>
    </div>
  );
}

const S = {
  overlay: {
    position: 'fixed',
    inset: 0,
    background: 'rgba(29, 27, 25, 0.65)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9999,
    backdropFilter: 'blur(6px)',
    WebkitBackdropFilter: 'blur(6px)',
    padding: '16px',
    animation: 'fadeIn 0.2s ease',
  },
  modal: {
    background: '#fff',
    borderRadius: 20,
    width: '100%',
    maxWidth: 520,
    maxHeight: '92vh',
    overflowY: 'auto',
    boxShadow: '0 24px 64px rgba(0, 0, 0, 0.18)',
    animation: 'scaleIn 0.25s cubic-bezier(0.34, 1.56, 0.64, 1)',
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: '16px 20px',
    borderBottom: '1px solid #ede7e3',
    position: 'sticky',
    top: 0,
    background: '#fff',
    borderRadius: '20px 20px 0 0',
    zIndex: 1,
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  headerLogo: {
    width: 32,
    height: 32,
    background: 'linear-gradient(135deg, #c76b8a 0%, #92405e 100%)',
    borderRadius: 8,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#fff',
    fontSize: 14,
    fontWeight: 700,
  },
  headerTitle: {
    fontSize: 14,
    fontWeight: 700,
    color: '#1d1b19',
    lineHeight: 1.3,
  },
  headerSub: {
    fontSize: 11,
    color: '#867277',
    marginTop: 1,
  },
  closeBtn: {
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    fontSize: 14,
    color: '#867277',
    padding: '6px 10px',
    borderRadius: 8,
    fontFamily: 'inherit',
    lineHeight: 1,
    transition: 'background 0.15s ease',
  },
  loadingWrap: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    padding: '52px 20px',
    gap: 14,
  },
  spinner: {
    width: 36,
    height: 36,
    borderRadius: '50%',
    border: '3px solid #ede7e3',
    borderTopColor: '#92405e',
    animation: 'spin 0.75s linear infinite',
  },
  loadingText: {
    fontSize: 13,
    color: '#867277',
    fontFamily: '"DM Sans", sans-serif',
  },
  errorWrap: {
    padding: '40px 24px',
    textAlign: 'center',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 12,
  },
  errorIcon: {
    fontSize: 28,
    color: '#ba1a1a',
  },
  errorText: {
    fontSize: 14,
    color: '#ba1a1a',
    lineHeight: 1.5,
    maxWidth: 340,
  },
  fallbackBtn: {
    marginTop: 8,
    padding: '10px 28px',
    borderRadius: 10,
    border: '1px solid #d8c1c6',
    background: '#fff',
    cursor: 'pointer',
    fontSize: 14,
    fontWeight: 600,
    fontFamily: 'inherit',
    color: '#1d1b19',
  },
};
