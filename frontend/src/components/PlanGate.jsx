/**
 * PlanGate — wraps a page component and blocks access if the user's plan
 * doesn't include the required feature. Shows an upgrade prompt instead.
 *
 * Usage:
 *   <PlanGate feature="ai_front_desk">
 *     <AIInsights />
 *   </PlanGate>
 *
 * Or as a route wrapper:
 *   <Route path="/ai-insights" element={<PlanGate feature="ai_insights"><AIInsights /></PlanGate>} />
 */
import { useNavigate } from 'react-router-dom';
import { useBeautician } from '../lib/supabase.js';
import { hasFeature, getRequiredPlan, PLAN, TEAM_ADDON, getPlanName } from '../lib/subscription.js';
import { ds, type } from '../lib/designSystem.js';
import { isIOSNative } from '../lib/platform.js';

export default function PlanGate({ feature, children }) {
  const { beautician } = useBeautician();
  const navigate = useNavigate();
  const currentPlan = beautician?.subscription_plan || 'trial';
  const iosNative = isIOSNative();

  // If the user has access, render the page normally
  if (hasFeature(currentPlan, feature)) {
    return children;
  }

  const requiredPlan = getRequiredPlan(feature);
  // Only team features are gated now — everything else is available to all
  const isTeamFeature = requiredPlan === 'florrie_team';
  const planName = isTeamFeature ? TEAM_ADDON.name : PLAN.name;
  const planPrice = isTeamFeature ? TEAM_ADDON.seatMonthlyLabel : PLAN.monthlyLabel;

  // Feature display names for the prompt
  const featureNames = {
    ai_front_desk: 'Florrie Auto-Reply',
    whatsapp: 'WhatsApp Automation',
    smart_schedule: "Florrie's Schedule",
    content_autopilot: 'Florrie Content',
    campaigns: 'Campaigns',
    ai_insights: "Florrie's Insights",
    churn_prevention: 'Client Retention',
    demand_forecast: 'Demand Forecast',
    client_segments: 'Client Segments',
    sms: 'SMS Reminders',
    reports: 'Reports',
    receipt_scanning: 'Receipt Scanning',
    loyalty: 'Loyalty Programme',
    aftercare: 'Aftercare Follow-ups',
    multi_location: 'Multi-location',
    staff_rota: 'Staff Rota',
    staff_performance: 'Staff Performance',
    team_management: 'Team Management',
  };

  const featureName = featureNames[feature] || feature;

  // iOS App Store compliance (Guideline 3.1.3(b)): never offer a path to
  // pricing or external purchase from a gated screen on native iOS.
  if (iosNative) {
    return (
      <div style={styles.container}>
        <div style={styles.card}>
          <div style={styles.iconWrap}>
            <span className="material-symbols-outlined" style={styles.icon}>lock</span>
          </div>

          <h2 style={styles.title}>{featureName}</h2>
          <p style={styles.subtitle}>
            This feature isn't part of your current plan.
          </p>

          <button
            onClick={() => navigate(-1)}
            style={styles.backBtn}
          >
            Go Back
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <div style={styles.card}>
        <div style={styles.iconWrap}>
          <span className="material-symbols-outlined" style={styles.icon}>lock</span>
        </div>

        <h2 style={styles.title}>{featureName}</h2>
        <p style={styles.subtitle}>
          This feature is available on the <strong>{planName}</strong> plan{planPrice ? ` (${planPrice})` : ''}.
        </p>

        <div style={styles.featureList}>
          {(isTeamFeature ? TEAM_ADDON.extras : PLAN.features).map((f, i) => (
            <div key={i} style={styles.featureItem}>
              <span className="material-symbols-outlined" style={styles.checkIcon}>check_circle</span>
              <span>{f}</span>
            </div>
          ))}
        </div>

        <button
          onClick={() => navigate('/pricing')}
          style={styles.upgradeBtn}
        >
          View Plans
        </button>

        <button
          onClick={() => navigate(-1)}
          style={styles.backBtn}
        >
          Go Back
        </button>
      </div>
    </div>
  );
}

const styles = {
  container: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: '70vh',
    padding: '24px 16px',
  },
  card: {
    background: 'var(--surface, #fff)',
    borderRadius: 20,
    padding: '40px 28px 32px',
    maxWidth: 380,
    width: '100%',
    textAlign: 'center',
    boxShadow: '0 2px 20px rgba(146, 64, 94, 0.08)',
    border: '1px solid var(--border, #EDE9E4)',
  },
  iconWrap: {
    width: 64,
    height: 64,
    borderRadius: '50%',
    background: 'linear-gradient(135deg, rgba(146, 64, 94, 0.1), rgba(201, 169, 110, 0.1))',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    margin: '0 auto 20px',
  },
  icon: {
    fontSize: 28,
    color: 'var(--accent, #92405e)',
    fontVariationSettings: "'FILL' 0, 'wght' 300",
  },
  title: {
    fontSize: 22,
    fontWeight: 600,
    color: 'var(--text, #3d2e33)',
    fontFamily: "var(--font-heading, 'Playfair Display', Georgia, serif)",
    margin: '0 0 8px',
  },
  subtitle: {
    fontSize: 14,
    color: 'var(--text-secondary, #6b5a5f)',
    lineHeight: 1.5,
    margin: '0 0 24px',
    fontFamily: "var(--font-body, 'DM Sans', sans-serif)",
  },
  featureList: {
    display: 'flex',
    flexDirection: 'column',
    gap: 10,
    textAlign: 'left',
    marginBottom: 28,
  },
  featureItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    fontSize: 13,
    color: 'var(--text-secondary, #6b5a5f)',
    fontFamily: "var(--font-body, 'DM Sans', sans-serif)",
  },
  checkIcon: {
    fontSize: 18,
    color: 'var(--success, #4caf50)',
    fontVariationSettings: "'FILL' 1, 'wght' 300",
  },
  upgradeBtn: {
    width: '100%',
    padding: '14px 24px',
    background: 'linear-gradient(135deg, #c76b8a 0%, #92405e 100%)',
    color: '#fff',
    border: 'none',
    borderRadius: 12,
    fontSize: 15,
    fontWeight: 600,
    cursor: 'pointer',
    fontFamily: "var(--font-body, 'DM Sans', sans-serif)",
    letterSpacing: '0.01em',
    marginBottom: 12,
  },
  backBtn: {
    width: '100%',
    padding: '12px 24px',
    background: 'transparent',
    color: 'var(--text-muted, #B5AFA8)',
    border: '1px solid var(--border, #EDE9E4)',
    borderRadius: 12,
    fontSize: 14,
    cursor: 'pointer',
    fontFamily: "var(--font-body, 'DM Sans', sans-serif)",
  },
};
