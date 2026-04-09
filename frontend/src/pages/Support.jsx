import { useState } from 'react';
import { useTheme } from '../lib/theme.jsx';

/**
 * Support — Help & FAQ page.
 * Route: /support
 */
export default function Support() {
  const { dark } = useTheme();
  const [expandedFaq, setExpandedFaq] = useState(null);

  const faqs = [
    {
      id: 'cancel',
      q: 'How do I cancel my appointment?',
      a: 'You can cancel directly from your booking confirmation link. Look for the "Cancel Appointment" button. There may be a late cancellation fee if you cancel within 24 hours of your appointment.',
    },
    {
      id: 'reschedule',
      q: 'Can I reschedule my appointment?',
      a: 'Yes! From your booking confirmation link, click "Reschedule Appointment" to pick a new date and time. You can reschedule up to 48 hours before your appointment.',
    },
    {
      id: 'payment',
      q: 'Can I update my payment method?',
      a: 'You can resend the payment link from your booking confirmation page. If you need to use a different card, just request a new link and pay with your preferred method.',
    },
    {
      id: 'details',
      q: 'How do I update my contact details?',
      a: 'From your booking confirmation link, you can update your phone number and email. Changes take effect immediately.',
    },
    {
      id: 'forms',
      q: 'Do I need to fill out forms before my appointment?',
      a: 'Some appointments require intake forms (for new clients) or patch tests (for certain brow treatments). You'll see a link in your confirmation — fill it out at your convenience, ideally before arriving.',
    },
    {
      id: 'deposit',
      q: 'What\'s a deposit?',
      a: 'A deposit is a partial payment that secures your booking. You\'ll pay the remaining balance on the day of your appointment, or through a payment link if you prefer.',
    },
  ];

  return (
    <div style={s.container}>
      <article style={s.article}>
        <h1 style={s.h1}>Support</h1>
        <p style={s.subtitle}>We're here to help. Find answers to common questions below, or reach out directly.</p>

        <section style={s.section}>
          <h2 style={s.h2}>Frequently Asked Questions</h2>
          <div style={s.faqList}>
            {faqs.map(faq => (
              <div
                key={faq.id}
                style={{
                  ...s.faqItem,
                  borderBottom: '1px solid var(--border, #EDE9E4)',
                }}
              >
                <button
                  onClick={() => setExpandedFaq(expandedFaq === faq.id ? null : faq.id)}
                  style={s.faqButton}
                >
                  <span style={s.faqQ}>{faq.q}</span>
                  <span style={{
                    ...s.faqToggle,
                    transform: expandedFaq === faq.id ? 'rotate(180deg)' : 'rotate(0deg)',
                  }}>▼</span>
                </button>
                {expandedFaq === faq.id && (
                  <p style={s.faqA}>{faq.a}</p>
                )}
              </div>
            ))}
          </div>
        </section>

        <section style={s.section}>
          <h2 style={s.h2}>Didn't find what you're looking for?</h2>
          <p style={s.p}>
            Email us at <a href="mailto:hello@florrie.ai" style={s.link}>hello@florrie.ai</a> and we'll get back to you as soon as possible.
          </p>
        </section>

        <section style={s.section}>
          <h2 style={s.h2}>Privacy & Terms</h2>
          <p style={s.p}>
            <a href="/privacy" style={s.link}>Privacy Policy</a>
          </p>
        </section>
      </article>
    </div>
  );
}

const s = {
  container: {
    padding: '20px 16px 40px',
    maxWidth: 720,
    margin: '0 auto',
    fontFamily: '"DM Sans", -apple-system, sans-serif',
  },
  article: {
    lineHeight: 1.6,
  },
  h1: {
    fontSize: 28,
    fontWeight: 700,
    color: 'var(--text, #2D2A26)',
    margin: '0 0 8px',
  },
  subtitle: {
    fontSize: 15,
    color: 'var(--text-secondary, #7A756F)',
    margin: '0 0 32px',
  },
  section: {
    marginBottom: 32,
  },
  h2: {
    fontSize: 18,
    fontWeight: 600,
    color: 'var(--text, #2D2A26)',
    margin: '0 0 16px',
  },
  p: {
    fontSize: 15,
    color: 'var(--text-secondary, #7A756F)',
    margin: '0 0 12px',
  },
  faqList: {
    background: 'var(--card, #fff)',
    borderRadius: 12,
    overflow: 'hidden',
  },
  faqItem: {
    padding: '0',
  },
  faqButton: {
    width: '100%',
    padding: '14px 16px',
    border: 'none',
    background: 'none',
    fontSize: 15,
    fontWeight: 600,
    color: 'var(--text, #2D2A26)',
    cursor: 'pointer',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    fontFamily: 'inherit',
    textAlign: 'left',
  },
  faqQ: {
    flex: 1,
  },
  faqToggle: {
    fontSize: 10,
    color: 'var(--text-muted, #B5AFA8)',
    marginLeft: 12,
    flexShrink: 0,
    transition: 'transform 0.2s',
  },
  faqA: {
    padding: '0 16px 14px',
    fontSize: 14,
    color: 'var(--text-secondary, #7A756F)',
    margin: 0,
    lineHeight: 1.5,
  },
  link: {
    color: 'var(--accent, #C76B8A)',
    textDecoration: 'none',
    fontWeight: 500,
  },
};
