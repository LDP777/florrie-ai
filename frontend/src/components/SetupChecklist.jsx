import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBeautician, supabase, fetchRows } from '../lib/supabase.js'
/**
 * SetupChecklist — persistent post-onboarding progress tracker.
 *
 * Shows on the Dashboard until every step is done. Checks real data
 * (treatments, clients, working hours, booking slug, Stripe, first booking)
 * so it auto-completes as the beautician uses the product.
 *
 * Once all steps are done, the card shows a celebration and can be dismissed.
 */
const STEPS = [
  {
    key: 'treatments',
    label: 'Add your first treatment',
    desc: 'Clients need something to book',
    path: '/treatments',
    check: (data) => data.treatmentCount > 0,
  },
  {
    key: 'hours',
    label: 'Set your working hours',
    desc: 'So Florrie knows when you\'re available',
    path: '/settings',
    check: (data) => data.hasHours,
  },
  {
    key: 'booking_link',
    label: 'Share your booking link',
    desc: 'Send it to a client or add it to your Instagram bio',
    path: '/settings',
    check: (data) => !!data.bookingSlug,
  },
  {
    key: 'first_client',
    label: 'Get your first client',
    desc: 'Add one manually or wait for a booking',
    path: '/clients',
    check: (data) => data.clientCount > 0,
  },
  {
    key: 'stripe',
    label: 'Connect payments',
    desc: 'Accept deposits and get paid for no-shows',
    path: '/settings',
    check: (data) => data.stripeConnected,
  },
  {
    key: 'first_booking',
    label: 'Your first booking',
    desc: 'When a client books through your link',
    path: '/calendar',
    check: (data) => data.appointmentCount > 0,
  },
];
export default function SetupChecklist() {
  const navigate = useNavigate();
  const { beautician } = useBeautician();
  const [data, setData] = useState(null);
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => {
    if (!beautician) return;
    loadProgress();
    // Re-check whenever the user returns to the page (e.g. after setting hours in Settings)
    window.addEventListener('focus', loadProgress);
    return () => window.removeEventListener('focus', loadProgress);
  }, [beautician]);
  async function loadProgress() {
    try {
      // Fetch fresh beautician data — don't rely on the cached hook value,
      // which won't reflect hours/slug/stripe changes made in Settings
      const [treatments, clients, appointments, freshB] = await Promise.all([
        fetchRows('treatments', beautician.id, {}),
        fetchRows('clients', beautician.id, {}),
        fetchRows('appointments', beautician.id, {}),
        supabase
          .from('beauticians')
          .select('working_hours, booking_slug, stripe_account_id')
          .eq('id', beautician.id)
          .single()
          .then(r => r.data || {}),
      ]);
      setData({
        treatmentCount: treatments?.length || 0,
        hasHours: !!freshB.working_hours && Object.values(freshB.working_hours).some(d => d?.enabled),
        bookingSlug: freshB.booking_slug || null,
        clientCount: clients?.length || 0,
        stripeConnected: !!freshB.stripe_account_id,
        appointmentCount: appointments?.length || 0,
      });
    } catch {
      setData(null);
    }
  }
  if (!data || dismissed) return null;
  const completed = STEPS.filter(s => s.check(data));
  const progress = completed.length / STEPS.length;
  // Hide if all done and dismissed previously
  if (progress === 1) {
    // Show celebration briefly, then allow dismiss
  }
  // Don't show if they've completed everything and already have 3+ bookings (established user)
  if (progress === 1 && data.appointmentCount > 3) return null;
  return (
    <div style={s.card}>
      <div style={s.header}>
        <div>
          <h3 style={s.title}>
            {progress === 1 ? 'You\'re all set!' : 'Get started with Florrie'}
          </h3>
          <p style={s.sub}>
            {progress === 1
              ? 'Your account is fully set up. Time to let Florrie work her magic.'
              : `${completed.length} of ${STEPS.length} steps done`}
          </p>
        </div>
        {progress === 1 && (
          <button onClick={() => setDismissed(true)} style={s.dismissBtn}>Done</button>
        )}
      </div>
      {/* Progress bar */}
      <div style={s.progressTrack}>
        <div style={{ ...s.progressFill, width: `${progress * 100}%` }} />
      </div>
      {/* Steps */}
      {progress < 1 && (
        <div style={s.steps}>
          {STEPS.map((step) => {
            const done = step.check(data);
            return (
              <button
                key={step.key}
                onClick={() => !done && navigate(step.path)}
                style={{
                  ...s.step,
                  opacity: done ? 0.6 : 1,
                  cursor: done ? 'default' : 'pointer',
                }}
              >
                <span style={{
                  ...s.check,
                  background: done ? 'var(--success, #5BA97B)' : 'var(--bg-hover, #F5F2EF)',
                  color: done ? '#fff' : 'var(--text-muted, #B5AFA8)',
                }}>
                  {done ? '✓' : step.key === STEPS.find(st => !st.check(data))?.key ? '→' : ''}
                </span>
                <div style={s.stepInfo}>
                  <span style={{
                    ...s.stepLabel,
                    textDecoration: done ? 'line-through' : 'none',
                  }}>{step.label}</span>
                  {!done && <span style={s.stepDesc}>{step.desc}</span>}
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
const s = {
  card: {
    background: 'var(--bg-card, #fff)',
    borderRadius: 16,
    padding: '20px 22px',
    border: '1px solid var(--border, #EDE9E4)',
    marginBottom: 16,
  },
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    marginBottom: 12,
  },
  title: {
    margin: 0,
    fontSize: 16,
    fontWeight: 700,
    color: 'var(--text-primary, #2D2A26)',
    fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)",
  },
  sub: {
    margin: '2px 0 0',
    fontSize: 13,
    color: 'var(--text-muted, #B5AFA8)',
  },
  dismissBtn: {
    padding: '6px 14px',
    borderRadius: 8,
    border: '1px solid var(--border, #EDE9E4)',
    background: 'var(--bg-card, #fff)',
    color: 'var(--text-secondary, #8B6F5E)',
    fontSize: 12,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: 'inherit',
  },
  progressTrack: {
    height: 4,
    borderRadius: 2,
    background: 'var(--bg-hover, #F5F2EF)',
    marginBottom: 14,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    borderRadius: 2,
    background: 'var(--accent, #C76B8A)',
    transition: 'width 0.4s ease',
  },
  steps: {
    display: 'flex',
    flexDirection: 'column',
    gap: 2,
  },
  step: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '8px 6px',
    borderRadius: 10,
    border: 'none',
    background: 'transparent',
    fontFamily: 'inherit',
    textAlign: 'left',
    width: '100%',
  },
  check: {
    width: 24,
    height: 24,
    borderRadius: 12,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 12,
    fontWeight: 700,
    flexShrink: 0,
  },
  stepInfo: {
    display: 'flex',
    flexDirection: 'column',
  },
  stepLabel: {
    fontSize: 13,
    fontWeight: 600,
    color: 'var(--text-primary, #2D2A26)',
  },
  stepDesc: {
    fontSize: 11,
    color: 'var(--text-muted, #B5AFA8)',
    marginTop: 1,
  },
};
