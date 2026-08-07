/**
 * Where a client lands after saving a card or paying a link.
 *
 * These URLs (/card/saved, /pay/success and friends) were handed to Stripe as
 * redirect targets but had no route, so a client who had just typed their card
 * details was dropped on a Not Found page. Not the note to end on.
 */
export default function StatusPage({ kind = 'card_saved' }) {
  const COPY = {
    card_saved: {
      icon: '✓',
      title: 'Card saved',
      body: 'Thank you. Your card is safely stored with our payment provider and nothing has been charged. You are all set for your appointment.',
      tone: '#5BA67F',
    },
    card_cancelled: {
      icon: '•',
      title: 'No card saved',
      body: 'No problem, nothing has changed and you have not been charged. If you meant to add a card, just open the link again.',
      tone: '#8A8580',
    },
    pay_success: {
      icon: '✓',
      title: 'Payment received',
      body: 'Thank you. Your payment has gone through and a receipt is on its way to you by email.',
      tone: '#5BA67F',
    },
    pay_cancelled: {
      icon: '•',
      title: 'Payment cancelled',
      body: 'Nothing has been charged. If you meant to pay, open the link again whenever suits you.',
      tone: '#8A8580',
    },
  }[kind] || {};

  return (
    <div style={{ minHeight: 'var(--shell-viewport)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      background: '#FBF6F1', padding: 24, boxSizing: 'border-box',
      fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif",
    }}>
      <div style={{ maxWidth: 380, width: '100%', textAlign: 'center', background: '#fff',
        border: '1px solid #EFE7DA', borderRadius: 18, padding: '32px 26px',
        boxShadow: '0 12px 40px rgba(146,64,94,0.07)',
      }}>
        <div style={{ width: 52, height: 52, borderRadius: '50%', margin: '0 auto 16px',
          background: `${COPY.tone}1A`, color: COPY.tone,
          display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 24,
        }}>
          {COPY.icon}
        </div>
        <h1 style={{ fontFamily: "'Playfair Display', Georgia, serif", fontSize: 22,
          color: '#2D1B1B', margin: '0 0 10px', fontWeight: 600,
        }}>
          {COPY.title}
        </h1>
        <p style={{ fontSize: 14, lineHeight: 1.6, color: '#7A716A', margin: 0 }}>
          {COPY.body}
        </p>
        <p style={{ fontSize: 12, color: '#B3A890', margin: '22px 0 0' }}>
          You can close this page.
        </p>
      </div>
    </div>
  );
}
