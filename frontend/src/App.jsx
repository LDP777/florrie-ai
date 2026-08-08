import { useState, useEffect, useRef, lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { supabase } from './lib/supabase.js';
import { API_BASE } from './lib/config.js';
import { useTheme } from './lib/theme.jsx';
import { useBeautician } from './lib/supabase.js';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import PlanGate from './components/PlanGate.jsx';
import InstallPrompt from './components/InstallPrompt.jsx';
import CoachNudge from './components/CoachNudge.jsx';
import FloatingMic from './components/FloatingMic.jsx';
import { isVoiceEnabled } from './lib/voicePref.js';
import { CoachProvider } from './contexts/CoachContext.jsx';
import { isIOSNative } from './lib/platform.js';
import { hapticTap } from './lib/native.js';
import Icon, { iconName } from './components/ui/Icon';

// Lazy-loaded pages (code splitting , each becomes its own chunk)
const CalendarView = lazy(() => import('./pages/CalendarView.jsx'));
const CalendarFull = lazy(() => import('./pages/CalendarFull.jsx'));
const ValueBreakdown = lazy(() => import('./pages/ValueBreakdown.jsx'));
const Escalations = lazy(() => import('./pages/Escalations.jsx'));
const ContentAutopilot = lazy(() => import('./pages/ContentAutopilot.jsx'));
const MoneyTracker = lazy(() => import('./pages/MoneyTracker.jsx'));
const BookingPage = lazy(() => import('./pages/BookingPage.jsx'));
const TrainingBooking = lazy(() => import('./pages/TrainingBooking.jsx'));
const ConsultationFormPublic = lazy(() => import('./pages/ConsultationFormPublic.jsx'));
const ConsultationFormBuilder = lazy(() => import('./pages/ConsultationFormBuilder.jsx'));
const Onboarding = lazy(() => import('./pages/Onboarding.jsx'));
const Login = lazy(() => import('./pages/Login.jsx'));
const Clients = lazy(() => import('./pages/Clients.jsx'));
const Treatments = lazy(() => import('./pages/Treatments.jsx'));
const Settings = lazy(() => import('./pages/Settings.jsx'));
const SetupHub = lazy(() => import('./pages/SetupHub.jsx'));
const Team = lazy(() => import('./pages/Team.jsx'));
const Analytics = lazy(() => import('./pages/Analytics.jsx'));
// Waitlist removed , use WaitlistPro (/waitlist-pro) instead
const Campaigns = lazy(() => import('./pages/Campaigns.jsx'));
const VoiceCommander = lazy(() => import('./pages/VoiceCommander.jsx'));
const Reviews = lazy(() => import('./pages/Reviews.jsx'));
const ClientImport = lazy(() => import('./pages/ClientImport.jsx'));
const Loyalty = lazy(() => import('./pages/Loyalty.jsx'));
const Aftercare = lazy(() => import('./pages/Aftercare.jsx'));
const SmartSchedule = lazy(() => import('./pages/SmartSchedule.jsx'));
const GiftVouchers = lazy(() => import('./pages/GiftVouchers.jsx'));
const Notifications = lazy(() => import('./pages/Notifications.jsx'));
const HoursExceptions = lazy(() => import('./pages/HoursExceptions.jsx'));
const Knowledge = lazy(() => import('./pages/Knowledge.jsx'));
const PatchTests = lazy(() => import('./pages/PatchTests.jsx'));
// IntakeForms removed , duplicate of ConsultationFormBuilder (/consultation-forms)
// Reports removed , merged into Analytics (/analytics → Export tab)
// Policies page retired (redirects to Settings > Policy). Import removed.
const BusinessProfile = lazy(() => import('./pages/BusinessProfile.jsx'));
const RebookReminders = lazy(() => import('./pages/RebookReminders.jsx'));
const Inbox = lazy(() => import('./pages/Inbox.jsx'));
const Packages = lazy(() => import('./pages/Packages.jsx'));
const MessageTemplates = lazy(() => import('./pages/MessageTemplates.jsx'));
const Referrals = lazy(() => import('./pages/Referrals.jsx'));
const Portfolio = lazy(() => import('./pages/Portfolio.jsx'));
const AppointmentNotes = lazy(() => import('./pages/AppointmentNotes.jsx'));
const ExpensesPage = lazy(() => import('./pages/Expenses.jsx'));
const PhotoConsent = lazy(() => import('./pages/PhotoConsent.jsx'));
const WaitlistPro = lazy(() => import('./pages/WaitlistPro.jsx'));
const ClientTimeline = lazy(() => import('./pages/ClientTimeline.jsx'));
const StaffRota = lazy(() => import('./pages/StaffRota.jsx'));
const DepositTracker = lazy(() => import('./pages/DepositTracker.jsx'));
const WeekReview = lazy(() => import('./pages/WeekReview.jsx'));
const Milestones = lazy(() => import('./pages/Milestones.jsx'));
const AddOns = lazy(() => import('./pages/AddOns.jsx'));
const CancellationLog = lazy(() => import('./pages/CancellationLog.jsx'));
const ClientTags = lazy(() => import('./pages/ClientTags.jsx'));
const PromoCodes = lazy(() => import('./pages/PromoCodes.jsx'));
const DailyChecklist = lazy(() => import('./pages/DailyChecklist.jsx'));
const ProductInventory = lazy(() => import('./pages/ProductInventory.jsx'));
const PriceList = lazy(() => import('./pages/PriceList.jsx'));
// TreatmentStats removed , merged into Analytics (/analytics → Treatments tab)
const StaffPerformance = lazy(() => import('./pages/StaffPerformance.jsx'));

const ClientMemberships = lazy(() => import('./pages/ClientMemberships.jsx'));
const EndOfDay = lazy(() => import('./pages/EndOfDay.jsx'));
const AutomationRules = lazy(() => import('./pages/AutomationRules.jsx'));
const WhatsAppConfig = lazy(() => import('./pages/WhatsAppConfig.jsx'));
const WhatsAppTemplates = lazy(() => import('./pages/WhatsAppTemplates.jsx'));
const ClientPortal = lazy(() => import('./pages/ClientPortal.jsx'));
const Compliance = lazy(() => import('./pages/Compliance.jsx'));
const MultiLocation = lazy(() => import('./pages/MultiLocation.jsx'));
const Integrations = lazy(() => import('./pages/Integrations.jsx'));
const SMSConfig = lazy(() => import('./pages/SMSConfig.jsx'));
const Messaging = lazy(() => import('./pages/Messaging.jsx'));
const APISettings = lazy(() => import('./pages/APISettings.jsx'));
const Pricing = lazy(() => import('./pages/Pricing.jsx'));
const Hub = lazy(() => import('./pages/Hub.jsx'));
const More = lazy(() => import('./pages/More.jsx'));
const Outbox = lazy(() => import('./pages/Outbox.jsx'));
const ClientManagePage = lazy(() => import('./pages/ClientManagePage.jsx'));
// LandingPage.jsx removed , landing.html (in public/) is the single source of truth.
// All unauthenticated visitors are redirected to /landing.html below.
const TermsPage = lazy(() => import('./pages/TermsPage.jsx'));
const PrivacyPage = lazy(() => import('./pages/PrivacyPage.jsx'));
const DataDeletionPage = lazy(() => import('./pages/DataDeletionPage.jsx'));
const PrivacyPolicy = lazy(() => import('./pages/PrivacyPolicy.jsx'));
const Support = lazy(() => import('./pages/Support.jsx'));
const NotFound = lazy(() => import('./pages/NotFound.jsx'));
const StatusPage = lazy(() => import('./pages/StatusPage.jsx'));
const UpdatePassword = lazy(() => import('./pages/UpdatePassword.jsx'));

function PageLoader() {
  return (
    <div style={{ display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '40vh',
      gap: 12,
      animation: 'fadeIn 0.3s ease'
    }}>
      <div style={{ width: 32,
        height: 32,
        border: '2.5px solid var(--border, #E8DDD4)',
        borderTopColor: 'var(--accent, #92405e)',
        borderRadius: '50%',
        animation: 'spin 0.8s linear infinite',
      }} />
      <span style={{ fontSize: 12,
        color: 'var(--text-muted, #6B5D54)',
        fontFamily: "var(--font-body, 'Plus Jakarta Sans', sans-serif)",
        letterSpacing: '0.04em',
      }}>Loading...</span>
    </div>
  );
}

/** Length of the free trial, in days. Matches the backend TIERS.trial. */
const TRIAL_DAYS = 14;

/**
 * Work out when this account's trial ends.
 *
 * New accounts get trial_ends_at written at signup. Older rows were created
 * without it, and a null used to read as "this trial never ends", which is why
 * nobody was ever asked to pay. If the column is empty we fall back to the
 * account's creation date plus the trial length, exactly as the backend does
 * in middleware/auth.js withTrialWindow. Keep the two in step.
 *
 * Returns a Date, or null when there is nothing sensible to anchor to. Null
 * means we do not lock anyone out, because a wrong lockout costs a customer.
 */
function resolveTrialEndsAt(beautician) {
  if (!beautician) return null;
  if (beautician.trial_ends_at) return new Date(beautician.trial_ends_at);
  if (!beautician.created_at) return null;
  const createdAt = new Date(beautician.created_at);
  if (Number.isNaN(createdAt.getTime())) return null;
  return new Date(createdAt.getTime() + TRIAL_DAYS * 24 * 60 * 60 * 1000);
}

/**
 * The screen a beautician sees once the trial is over and there is no active
 * subscription.
 *
 * On native iOS there is deliberately NO purchase CTA and no link out to a
 * payment page: App Store Guideline 3.1.3(b) forbids steering to an external
 * purchase from inside the app. That branch is unchanged, it just explains the
 * state and offers sign out.
 *
 * On the web she can pay right here. It used to be a mailto to hello@, which
 * meant the only way to give us money was to write us an email and wait.
 */
function TrialExpiredScreen({ onSignOut }) {
  const iosNative = isIOSNative();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState(null);

  async function startCheckout() {
    setError(null);
    setStarting(true);
    try {
      const token = (await supabase.auth.getSession()).data.session?.access_token;
      if (!token) {
        setError('Your session has expired. Refresh the page and try again.');
        return;
      }
      const res = await fetch(`${API_BASE}/api/billing/create-checkout`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ plan: 'florrie', interval: 'monthly' }),
      });
      const data = await res.json().catch(() => ({}));
      if (data?.url) {
        window.location.href = data.url;
        return;
      }
      setError(data?.error || 'Could not open checkout. Try again in a moment.');
    } catch {
      setError('Could not reach billing. Check your connection and try again.');
    } finally {
      setStarting(false);
    }
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg, #FBF6F1)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
      <div style={{ maxWidth: 440, width: '100%', background: '#fff', borderRadius: 22, padding: '48px 40px', textAlign: 'center', boxShadow: 'var(--elev-3)' }}>
        <div style={{ marginBottom: 16, display: 'flex', justifyContent: 'center', color: 'var(--accent, #92405E)' }}>
          <Icon name="flower" size={44} strokeWidth={1.3} />
        </div>
        <h1 style={{ fontFamily: "'Playfair Display', serif", fontSize: 26, fontWeight: 700, color: 'var(--text-primary, #241B17)', marginBottom: 8 }}>
          Your free trial has ended
        </h1>
        <p style={{ color: 'var(--text-secondary, #574A42)', fontSize: 15, lineHeight: 1.6, marginBottom: 32 }}>
          {iosNative
            ? 'Your trial is no longer active on this account.'
            : 'Your diary, your clients and your messages are all still here. Start your plan and pick up where you left off.'}
        </p>
        {!iosNative && (
          <>
            <button
              onClick={startCheckout}
              disabled={starting}
              style={{ display: 'block', width: '100%', background: 'var(--accent, #92405e)', color: '#fff', border: 'none', borderRadius: 10, padding: '14px 24px', fontSize: 15, fontWeight: 600, cursor: starting ? 'default' : 'pointer', opacity: starting ? 0.7 : 1, marginBottom: 12 }}
            >
              {starting ? 'Opening checkout...' : 'Continue for £29 a month'}
            </button>
            {error && (
              <p style={{ color: 'var(--danger, #9E2B32)', fontSize: 13, lineHeight: 1.5, marginBottom: 12 }}>{error}</p>
            )}
            <a href="/pricing" style={{ display: 'block', color: 'var(--text-secondary, #574A42)', fontSize: 13, textDecoration: 'underline', marginBottom: 12 }}>
              See all plans
            </a>
          </>
        )}
        <button
          onClick={onSignOut}
          style={{ background: 'none', border: 'none', color: 'var(--text-muted, #6B5D54)', fontSize: 13, cursor: 'pointer', padding: 8 }}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState(null);
  const [loading, setLoading] = useState(true);
  const [needsOnboarding, setNeedsOnboarding] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const { beautician } = useBeautician();

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });

    return () => subscription.unsubscribe();
  }, []);

  // Monzo-style launch feel: a single gentle haptic the moment the app
  // finishes loading and the home is about to show (native only; no-ops on web).
  const launchBuzzed = useRef(false);
  useEffect(() => {
    if (loading || launchBuzzed.current) return;
    launchBuzzed.current = true;
    hapticTap();
  }, [loading]);

  // Check onboarding status when session is established and beautician data is available
  useEffect(() => {
    if (session && beautician) {
      if (!beautician.onboarding_completed_at) {
        setNeedsOnboarding(true);
      } else {
        setNeedsOnboarding(false);
      }
    }
  }, [session, beautician]);

  // Native app (iOS): register for real APNs push once signed in, and send
  // the device token to the backend. Web push stays on its existing
  // onboarding flow; this only runs inside the Capacitor shell.
  useEffect(() => {
    if (!session) return;
    import('./lib/platform.js').then(({ isNativeApp }) => {
      if (!isNativeApp()) return;
      import('./lib/push.js')
        .then(({ registerNativePushToken }) => registerNativePushToken())
        .catch(() => {});
    }).catch(() => {});
  }, [session]);

  // Native app (iOS): start the "Florrie on the desk" Live Activity once signed
  // in, so the lock-screen / Dynamic Island strip is live through the day.
  useEffect(() => {
    if (!session || !beautician) return;
    import('./lib/platform.js').then(({ isNativeApp }) => {
      if (!isNativeApp()) return;
      import('./lib/liveActivity.js')
        .then(({ startDeskActivity }) => startDeskActivity(beautician.business_name || beautician.first_name || 'Florrie'))
        .catch(() => {});
    }).catch(() => {});
  }, [session, beautician]);

  // Warm the main route chunks in the background once signed in, so tapping a
  // tab navigates instantly instead of showing the lazy-load spinner each time.
  useEffect(() => {
    if (!session) return;
    const warm = () => {
      import('./pages/Hub.jsx');
      import('./pages/CalendarView.jsx');
      import('./pages/SmartSchedule.jsx');
      import('./pages/Inbox.jsx');
      import('./pages/MoneyTracker.jsx');
      import('./pages/VoiceCommander.jsx');
      import('./pages/Clients.jsx');
      import('./pages/Settings.jsx');
      import('./pages/Escalations.jsx');
    };
    const ric = typeof window !== 'undefined' ? window.requestIdleCallback : null;
    const id = ric ? ric(warm, { timeout: 2500 }) : setTimeout(warm, 1500);
    return () => {
      if (ric && window.cancelIdleCallback) window.cancelIdleCallback(id);
      else clearTimeout(id);
    };
  }, [session]);

  // Reset scroll to the top on every route change - otherwise the document keeps
  // the previous page's scroll position, so pages like Inbox/Money open part-way down.
  useEffect(() => {
    window.scrollTo(0, 0);
    if (document.scrollingElement) document.scrollingElement.scrollTop = 0;
    // The page now scrolls inside #app-scroll (not the body), so reset that too.
    const sc = document.getElementById('app-scroll');
    if (sc) sc.scrollTop = 0;
  }, [location.pathname]);

  const isPublicRoute = location.pathname.startsWith('/book/') || location.pathname.startsWith('/form/') || location.pathname.includes('/manage/') || location.pathname === '/privacy' || location.pathname === '/support';
  const isAuthRoute = location.pathname === '/login' || location.pathname === '/update-password';
  const isLandingRoute = location.pathname === '/';

  if (loading) {
    return (
      <div style={styles.loadingScreen}>
        <img src="/florrie-petal.svg" alt="" style={{ width: 48, height: 48, animation: 'spin 2.5s ease-in-out infinite' }} />
        <span style={styles.loadingLogo}>florrie<span style={{ color: 'var(--gold, #8A6420)', fontFamily: "'Plus Jakarta Sans', sans-serif", fontWeight: 500 }}>.ai</span></span>
        <span style={{ fontSize: 11, color: 'var(--text-muted, #6B5D54)', fontFamily: "'Plus Jakarta Sans', sans-serif", letterSpacing: '0.08em', textTransform: 'uppercase' }}>your AI team</span>
      </div>
    );
  }

  // Public routes don't need auth
  if (isPublicRoute) {
    return (
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/book/:slug" element={<BookingPage />} />
          <Route path="/book/:slug/confirmed" element={<BookingPage />} />
          <Route path="/book/:slug/manage/:token" element={<ClientManagePage />} />
          <Route path="/training/:slug/:courseId" element={<TrainingBooking />} />
          <Route path="/form/:token" element={<ConsultationFormPublic />} />
          <Route path="/privacy" element={<PrivacyPolicy />} />
          <Route path="/support" element={<Support />} />
        </Routes>
      </Suspense>
    );
  }

  // Not logged in → static landing page or login
  if (!session) {
    // All unauthenticated root hits → static landing.html (faster load, better SEO, single source of truth)
    if (isLandingRoute) {
      // Native app has no marketing site bundled -> go straight to login.
      if (isIOSNative()) {
        return <Navigate to="/login" replace />;
      }
      window.location.replace('/landing.html');
      return null;
    }
    return (
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/login" element={<Login supabase={supabase} />} />
          <Route path="/update-password" element={<UpdatePassword supabase={supabase} />} />
          <Route path="/terms" element={<TermsPage />} />
          <Route path="/privacy" element={<PrivacyPage />} />
          <Route path="/data-deletion" element={<DataDeletionPage />} />
          <Route path="/help/data-deletion" element={<DataDeletionPage />} />
          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </Suspense>
    );
  }

  // Needs onboarding
  if (needsOnboarding) {
    return (
      <Suspense fallback={<PageLoader />}>
        <Onboarding
          onComplete={(destination) => {
            setNeedsOnboarding(false);
            navigate(destination || '/');
          }}
        />
      </Suspense>
    );
  }

  // Authenticated app
  const showNav = !isAuthRoute && !location.pathname.startsWith('/onboarding');

  const trialEndsAt = resolveTrialEndsAt(beautician);
  const now = new Date();
  const daysLeft = trialEndsAt ? Math.ceil((trialEndsAt - now) / (1000 * 60 * 60 * 24)) : null;
  const trialExpired = trialEndsAt ? now > trialEndsAt : false;
  const subActive = beautician?.subscription_status === 'active';
  const showTrialWarning = !subActive && daysLeft !== null && daysLeft <= 5 && daysLeft > 0;
  const showTrialExpired = !subActive && trialExpired;

  // Soft paywall, expired trial and no active subscription.
  // On native iOS we show a benign read-only state with no purchase CTA,
  // per App Store Guideline 3.1.3(b) Multiplatform Services.
  if (showTrialExpired) {
    return (
      <TrialExpiredScreen
        onSignOut={async () => { if (supabase) await supabase.auth.signOut(); setSession(null); }}
      />
    );
  }

  return (
    <ErrorBoundary>
      <CoachProvider>
      <div style={styles.appShell} className="app-shell">
        {showTrialWarning && !isIOSNative() && (
          <div style={{ background: 'var(--gold, #8A6420)', color: '#fff', textAlign: 'center', padding: '8px 16px', fontSize: 13, fontWeight: 500 }}>
            ⏳ Your free trial ends in {daysLeft} day{daysLeft === 1 ? '' : 's'}.{' '}
            {/* Points at the real checkout, not a mailto. A beautician who
                wants to keep Florrie should be able to pay in two taps. */}
            <a href="/pricing" style={{ color: '#fff', fontWeight: 700, textDecoration: 'underline' }}>
              pick a plan to keep going
            </a>
          </div>
        )}
        <InstallPrompt />
        {/* Reserve what actually floats here. FloatingMic hides itself on the
            Inbox thread, so reserving its lane there left a band of dead cream
            under the composer. */}
        <div
          style={{ ...styles.pageContainer,
            paddingBottom: (location.pathname === '/inbox' && /[?&]client=/.test(location.search || ''))
              ? 'var(--shell-bottom-nav)'
              : 'var(--shell-bottom)',
          }}
          id="app-scroll"
        >
          <Suspense fallback={<PageLoader />}>
            <Routes>
            <Route path="/" element={<Hub />} />
            <Route path="/calendar" element={<Hub />} />
            <Route path="/calendar/week" element={<Hub />} />
            <Route path="/calendar/full" element={<CalendarFull />} />
            <Route path="/value" element={<ValueBreakdown />} />
            <Route path="/today" element={<Hub />} />
            <Route path="/escalations" element={<Escalations />} />
            <Route path="/approval-queue" element={<Navigate to="/outbox" replace />} />
            <Route path="/content" element={<PlanGate feature="content_autopilot"><ContentAutopilot /></PlanGate>} />
            <Route path="/money" element={<MoneyTracker />} />
            <Route path="/clients" element={<Clients />} />
            <Route path="/treatments" element={<Treatments />} />
            <Route path="/settings" element={<Settings supabase={supabase} onLogout={async () => { if (supabase) await supabase.auth.signOut(); setSession(null); }} />} />
            <Route path="/setup" element={<SetupHub />} />
            <Route path="/team" element={<PlanGate feature="team_management"><Team /></PlanGate>} />
            <Route path="/analytics" element={<Analytics />} />
            <Route path="/waitlist" element={<Navigate to="/waitlist-pro" replace />} />
            <Route path="/digest" element={<Navigate to="/analytics" replace />} />
            <Route path="/campaigns" element={<PlanGate feature="campaigns"><Campaigns /></PlanGate>} />
            <Route path="/voice" element={<VoiceCommander />} />
            <Route path="/reviews" element={<Reviews />} />
            <Route path="/import" element={<ClientImport />} />
            <Route path="/loyalty" element={<PlanGate feature="loyalty"><Loyalty /></PlanGate>} />
            <Route path="/aftercare" element={<PlanGate feature="aftercare"><Aftercare /></PlanGate>} />
            <Route path="/smart-schedule" element={<PlanGate feature="smart_schedule"><Hub /></PlanGate>} />
            <Route path="/vouchers" element={<GiftVouchers />} />
            <Route path="/notifications" element={<Notifications />} />
            <Route path="/hours" element={<HoursExceptions />} />
            <Route path="/knowledge" element={<Knowledge />} />
            <Route path="/compliance" element={<Compliance />} />
            <Route path="/patch-tests" element={<PatchTests />} />
            {/* /forms removed , use /consultation-forms instead */}
            <Route path="/reports" element={<Navigate to="/analytics" replace />} />
            {/* Policies page retired: it wrote to a `policies` table the booking
                engine never read. Booking rules live in Settings (booking_policy). */}
            <Route path="/policies" element={<Navigate to="/settings?section=policy" replace />} />
            <Route path="/business" element={<BusinessProfile />} />
            <Route path="/rebook" element={<RebookReminders />} />
            <Route path="/inbox" element={<Inbox />} />
            <Route path="/packages" element={<Packages />} />
            <Route path="/templates" element={<MessageTemplates />} />
            <Route path="/referrals" element={<Referrals />} />
            <Route path="/portfolio" element={<Portfolio />} />
            <Route path="/notes" element={<AppointmentNotes />} />
            <Route path="/expenses" element={<ExpensesPage />} />
            <Route path="/consultation-forms" element={<ConsultationFormBuilder />} />
            <Route path="/consultation-forms/:id" element={<ConsultationFormBuilder />} />
            <Route path="/sequences" element={<Navigate to="/automations" replace />} />
            <Route path="/photo-consent" element={<PhotoConsent />} />
            <Route path="/waitlist-pro" element={<WaitlistPro />} />
            <Route path="/client-timeline" element={<ClientTimeline />} />
            <Route path="/rota" element={<PlanGate feature="staff_rota"><StaffRota /></PlanGate>} />
            <Route path="/deposits" element={<DepositTracker />} />
            <Route path="/week-review" element={<WeekReview />} />
            <Route path="/milestones" element={<Milestones />} />
            <Route path="/addons" element={<AddOns />} />
            <Route path="/cancellations" element={<CancellationLog />} />
            <Route path="/tags" element={<ClientTags />} />
            <Route path="/promos" element={<PromoCodes />} />
            <Route path="/checklist" element={<DailyChecklist />} />
            <Route path="/inventory" element={<ProductInventory />} />
            <Route path="/price-list" element={<PriceList />} />
            <Route path="/treatment-stats" element={<Navigate to="/analytics" replace />} />
            <Route path="/staff-performance" element={<PlanGate feature="staff_performance"><StaffPerformance /></PlanGate>} />

            <Route path="/memberships" element={<ClientMemberships />} />
            <Route path="/comms" element={<Navigate to="/inbox" replace />} />
            <Route path="/end-of-day" element={<EndOfDay />} />
            <Route path="/automations" element={<AutomationRules />} />
            <Route path="/whatsapp" element={<PlanGate feature="whatsapp"><WhatsAppConfig /></PlanGate>} />
            <Route path="/whatsapp/templates" element={<PlanGate feature="whatsapp"><WhatsAppTemplates /></PlanGate>} />
            <Route path="/portal" element={<ClientPortal />} />
            {/* Client-intelligence stack (ai-insights, client-intel, segments, churn, demand)
                hidden 2026-06-16: orphaned + mock-heavy. Files kept, restore routes to revive. */}
            <Route path="/locations" element={<PlanGate feature="multi_location"><MultiLocation /></PlanGate>} />
            <Route path="/integrations" element={<Integrations />} />
            <Route path="/sms" element={<PlanGate feature="sms"><SMSConfig /></PlanGate>} />
            {/* /messaging kept: it is the target of Clients "Message all" + Integrations, not a true orphan */}
            <Route path="/messaging" element={<Messaging />} />
            <Route path="/api-settings" element={<APISettings />} />
            <Route path="/pricing" element={<Pricing />} />
            <Route path="/hub" element={<Hub />} />
            <Route path="/more" element={<More />} />
            <Route path="/outbox" element={<Outbox />} />
            <Route path="/onboarding" element={
              <Onboarding onComplete={(destination) => navigate(destination || '/')} />
            } />
            <Route path="/login" element={<Navigate to="/" replace />} />
            <Route path="/update-password" element={<UpdatePassword supabase={supabase} />} />
            <Route path="/terms" element={<TermsPage />} />
            <Route path="/privacy" element={<PrivacyPage />} />
            <Route path="/data-deletion" element={<DataDeletionPage />} />
            <Route path="/help/data-deletion" element={<DataDeletionPage />} />
            {/* Stripe redirect landings. These were handed to Stripe as return
                URLs but had no route, so a client who had just entered their
                card details was dropped on a Not Found page. */}
            <Route path="/card/saved" element={<StatusPage kind="card_saved" />} />
            <Route path="/card/cancelled" element={<StatusPage kind="card_cancelled" />} />
            <Route path="/pay/success" element={<StatusPage kind="pay_success" />} />
            <Route path="/pay/cancelled" element={<StatusPage kind="pay_cancelled" />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </div>

      {showNav && <BottomNav current={location.pathname} session={session} />}
      {showNav && location.pathname !== '/calendar/full' && <FloatingBack current={location.pathname} />}
      {showNav && location.pathname !== '/calendar/full'
        && !(location.pathname === '/inbox' && location.search.includes('client='))
        && <FloatingMore current={location.pathname} />}
      {showNav && <FloatingMic />}
      <CoachNudge />
      </div>
      </CoachProvider>
    </ErrorBoundary>
  );
}

/**
 * Mobile bottom navigation , Day 3 of the refactor sprint.
 *
 * Three tabs only: Today, Inbox, Money. A decorative florrie petal sits in
 * the middle for brand presence (no tap behaviour). The Inbox badge stays
 * because unread message counts are the one number the salon owner needs
 * at a glance. Everything else lives behind the FloatingMore affordance
 * above the strip.
 */
function BottomNav({ current, session }) {
  const navigate = useNavigate();
  const [inboxCount, setInboxCount] = useState(0);
  const [approvalsCount, setApprovalsCount] = useState(0);
  const intervalRef = useRef(null);
  // Hold-to-speak on the centre petal. A deliberate long press (~700ms) opens Florrie
  // already listening; a plain tap opens her quietly. The didHold ref stops
  // the click that fires after a long press from double-navigating.
  const holdTimerRef = useRef(null);
  const didHoldRef = useRef(false);

  function startHold() {
    if (!isVoiceEnabled()) return; // voice off: petal never starts listening
    didHoldRef.current = false;
    clearTimeout(holdTimerRef.current);
    holdTimerRef.current = setTimeout(() => {
      didHoldRef.current = true;
      try { hapticTap(); } catch {}
      navigate('/voice', { state: { autoListen: true } });
    }, 700);
  }
  function cancelHold() {
    clearTimeout(holdTimerRef.current);
  }
  function handlePetalClick() {
    if (didHoldRef.current) {
      // The long press already navigated. Swallow this click and reset.
      didHoldRef.current = false;
      return;
    }
    navigate('/voice');
  }

  useEffect(() => {
    if (!session) return;
    async function fetchCounts() {
      try {
        const key = Object.keys(localStorage).find(k => /^sb-.+-auth-token$/.test(k));
        let token = null;
        if (key) {
          const raw = localStorage.getItem(key);
          try { const p = JSON.parse(raw); token = p?.access_token || p?.session?.access_token || raw; } catch { token = raw; }
        }
        const headers = token ? { Authorization: `Bearer ${token}` } : {};
        const res = await fetch(`${API_BASE}/api/agents/counts`, { headers });
        if (!res.ok) return;
        const d = await res.json();
        setInboxCount(d.inbox || 0);
        setApprovalsCount(d.approvals || 0);
      } catch { /* silent , badges are non-critical */ }
    }
    fetchCounts();
    intervalRef.current = setInterval(fetchCounts, 60_000);
    // Refresh the badges the moment Ellie acts, so reviewing a message visibly
    // drops the Today count instead of waiting up to a minute for the next poll.
    const onFocus = () => { if (document.visibilityState !== 'hidden') fetchCounts(); };
    window.addEventListener('florrie:refresh-counts', fetchCounts);
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      clearInterval(intervalRef.current);
      window.removeEventListener('florrie:refresh-counts', fetchCounts);
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [session]);

  // Paths that count as the Today tab being active.
  const todayPaths = ['/', '/hub', '/today', '/calendar', '/calendar/week', '/smart-schedule'];
  const isTodayActive = todayPaths.includes(current);
  const isInboxActive = current === '/inbox';
  const isContentActive = current === '/content';
  const isMoneyActive = current === '/money';

  const leftTabs = [
    { path: '/today', label: 'Today', icon: 'today', active: isTodayActive, badge: approvalsCount },
    { path: '/inbox', label: 'Inbox', icon: 'forum', active: isInboxActive, badge: inboxCount },
  ];
  const rightTabs = [
    { path: '/content', label: 'Content', icon: 'auto_fix_high', active: isContentActive, badge: 0 },
    { path: '/money',   label: 'Money',   icon: 'payments',      active: isMoneyActive,   badge: 0 },
  ];

  return (
    <nav style={styles.nav}>
      {leftTabs.map(tab => (
        <NavTab key={tab.path} tab={tab} onNav={() => navigate(tab.path)} />
      ))}

      {/* Centre petal: tap = open Florrie, hold = open her already listening.
          The brand mark itself is the way to reach Florrie; Today is the left tab. */}
      <button
        type="button"
        aria-label="Talk to Florrie, hold to speak"
        onClick={handlePetalClick}
        onTouchStart={startHold}
        onTouchEnd={cancelHold}
        onTouchMove={cancelHold}
        onMouseDown={startHold}
        onMouseUp={cancelHold}
        onMouseLeave={cancelHold}
        style={styles.navPetalWrap}
      >
        <div style={styles.navPetal}>
          <img src="/florrie-petal.svg" alt="" style={{ width: 24, height: 24, filter: 'brightness(0) invert(1)' }} />
        </div>
        <span style={styles.navPetalLabel}>Florrie</span>
      </button>

      {rightTabs.map(tab => (
        <NavTab key={tab.path} tab={tab} onNav={() => navigate(tab.path)} />
      ))}
    </nav>
  );
}

function NavTab({ tab, onNav }) {
  const color = tab.active ? '#92405e' : '#867277';
  const showBadge = tab.badge > 0;
  return (
    <button onClick={onNav} style={styles.navItem} aria-label={tab.label} aria-current={tab.active ? 'page' : undefined}>
      <div style={{ position: 'relative', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Icon
          name={iconName(tab.icon)}
          size={24}
          filled={tab.active}
          style={{ color, transition: 'color 0.15s ease' }}
        />
        {showBadge && (
          <span style={{ position: 'absolute', top: -4, right: -6,
            minWidth: 16, height: 16, borderRadius: 10,
            background: '#E85D75', color: '#fff',
            fontSize: 9, fontWeight: 700, lineHeight: '16px',
            textAlign: 'center', padding: '0 3px',
            border: '1.5px solid #FBF6F1',
            fontFamily: 'inherit',
          }}>
            {tab.badge > 99 ? '99+' : tab.badge}
          </span>
        )}
      </div>
      <span style={{ fontSize: 10, lineHeight: 1, letterSpacing: '0.01em',
        fontWeight: tab.active ? 600 : 500,
        color,
      }}>
        {tab.label}
      </span>
      {tab.active && <div style={styles.navDot} />}
    </button>
  );
}

/**
 * FloatingBack , a consistent back affordance for every secondary page.
 *
 * Mirrors FloatingMore but sits top-left. Hidden on the primary tab/home
 * destinations (which are roots, nothing to go back to) and on /more. One
 * component covers every pushed page without touching 80 files.
 */
/**
 * Compact-on-scroll for the floating pills. The moment the page scrolls the
 * Back/More pills shrink to icon-only circles and go slightly translucent,
 * so they read as chrome instead of sitting on top of content. Expanded
 * again at the top of the page. The app scrolls inside #app-scroll (the
 * shell is fixed), so that's the element we watch; re-bound per route since
 * the scroller can remount.
 */
function useScrolledDown(current, threshold = 20) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const el = document.getElementById('app-scroll');
    if (!el) { setScrolled(false); return; }
    const onScroll = () => setScrolled(el.scrollTop > threshold);
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [current, threshold]);
  return scrolled;
}

const ROOT_PATHS = new Set([
  '/', '/hub', '/today', '/calendar', '/calendar/week', '/smart-schedule',
  '/inbox', '/money', '/content', '/voice', '/more',
]);
function FloatingBack({ current }) {
  const navigate = useNavigate();
  const compact = useScrolledDown(current);
  if (ROOT_PATHS.has(current)) return null;

  return (
    <button
      onClick={() => {
        // Go back if there's history, otherwise fall back to the home tab.
        if (window.history.length > 1) navigate(-1);
        else navigate('/');
      }}
      aria-label="Back"
      style={{ position: 'fixed',
        top: 'calc(env(safe-area-inset-top, 0px) + 12px)',
        left: 14,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: compact ? 0 : 4,
        height: 44,
        width: compact ? 44 : 'auto',
        padding: compact ? 0 : '0 12px 0 8px',
        borderRadius: 999,
        background: compact ? 'rgba(255,255,255,0.72)' : 'rgba(255,255,255,0.98)',
        backdropFilter: compact ? 'blur(6px)' : 'none',
        WebkitBackdropFilter: compact ? 'blur(6px)' : 'none',
        border: '1px solid rgba(146,64,94,0.12)',
        boxShadow: compact ? '0 1px 5px rgba(146,64,94,0.08)' : '0 2px 8px rgba(146,64,94,0.1)',
        cursor: 'pointer',
        zIndex: 900,
        fontFamily: 'inherit',
        WebkitTapHighlightColor: 'transparent',
        transition: 'width 0.18s ease, padding 0.18s ease, background 0.18s ease, box-shadow 0.18s ease',
      }}
    >
      <Icon name={iconName('arrow_back_ios_new')} size={20} inline style={{ color: '#92405e' }} />
      {!compact && <span style={{ fontSize: 12, fontWeight: 600, color: '#92405e', letterSpacing: '0.01em' }}>Back</span>}
    </button>
  );
}

/**
 * FloatingMore , the discoverability backstop above the 3-tab nav.
 *
 * Small pill, top-right of the safe-area. Opens /more, where every
 * secondary page is indexed and searchable. Hidden when already on /more.
 */
function FloatingMore({ current }) {
  const navigate = useNavigate();
  const compact = useScrolledDown(current);
  if (current === '/more') return null;

  return (
    <button
      onClick={() => navigate('/more')}
      aria-label="More features"
      style={{ position: 'fixed',
        top: 'calc(env(safe-area-inset-top, 0px) + 12px)',
        right: 14,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: compact ? 0 : 6,
        height: 44,
        width: compact ? 44 : 'auto',
        padding: compact ? 0 : '0 12px 0 10px',
        borderRadius: 999,
        background: compact ? 'rgba(255,255,255,0.72)' : 'rgba(255,255,255,0.98)',
        backdropFilter: compact ? 'blur(6px)' : 'none',
        WebkitBackdropFilter: compact ? 'blur(6px)' : 'none',
        border: '1px solid rgba(146,64,94,0.12)',
        boxShadow: compact ? '0 1px 5px rgba(146,64,94,0.08)' : '0 2px 8px rgba(146,64,94,0.1)',
        cursor: 'pointer',
        zIndex: 900,
        fontFamily: 'inherit',
        WebkitTapHighlightColor: 'transparent',
        transition: 'width 0.18s ease, padding 0.18s ease, background 0.18s ease, box-shadow 0.18s ease',
      }}
    >
      <Icon name={iconName('apps')} size={18} inline style={{ color: '#92405e' }} />
      {!compact && <span style={{ fontSize: 12, fontWeight: 600, color: '#92405e', letterSpacing: '0.01em' }}>More</span>}
    </button>
  );
}

const styles = {
  loadingScreen: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: '100vh',
    background: '#FBF6F1',
    gap: 8,
    animation: 'fadeIn 0.6s ease',
  },
  loadingLogo: {
    fontSize: 30,
    fontWeight: 600,
    color: '#92405e',
    fontFamily: "'Playfair Display', Georgia, serif",
    letterSpacing: '-0.03em',
  },
  appShell: {
    // Height lives in the .app-shell CSS class (100vh with a 100dvh override) so
    // the fallback cascade works - an inline height would block the dvh override.
    // overflow:hidden makes the SHELL the fixed frame and the page scroll inside
    // it, so the body itself never scrolls. That stops the fixed bottom nav and
    // mic drifting up the page on iOS (a body-scroll repaint bug in WKWebView).
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
    background: 'var(--bg, #FBF6F1)',
  },
  pageContainer: {
    flex: 1,
    minHeight: 0, // let the flex child shrink so it scrolls instead of growing
    overflowY: 'auto',
    overflowX: 'hidden',
    WebkitOverflowScrolling: 'touch',
    // The shell owns the notch: with ios contentInset 'never', pages start
    // at y=0 and custom headers (Hub greeting) sat under the front camera.
    paddingTop: 'var(--shell-top)',
    // The shell also owns bottom clearance, for every page, in one place.
    // 80px cleared the nav but not the mic, which floats to safe+130 (and its
    // satellites to safe+194 when open), so the last row of a page sat under it.
    paddingBottom: 'var(--shell-bottom)',
  },

  // Bottom nav , Stitch glass morphism
  nav: {
    position: 'fixed',
    bottom: 'calc(env(safe-area-inset-bottom, 8px) + 10px)',
    left: '50%',
    transform: 'translateX(-50%)',
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'flex-end',
    gap: 2,
    maxWidth: 'calc(100vw - 24px)',
    background: 'rgba(255, 255, 255, 0.88)',
    backdropFilter: 'blur(16px) saturate(1.3)',
    WebkitBackdropFilter: 'blur(16px) saturate(1.3)',
    border: '1px solid rgba(146, 64, 94, 0.10)',
    borderRadius: 22,
    padding: '6px 8px',
    zIndex: 100,
    fontFamily: "var(--font-body, 'Plus Jakarta Sans', sans-serif)",
    boxShadow: 'var(--elev-3)',
  },
  navItem: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 3,
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: '5px 11px',
    position: 'relative',
    fontFamily: 'inherit',
    WebkitTapHighlightColor: 'transparent',
    transition: 'color 0.15s ease',
  },
  navDot: {
    width: 4,
    height: 4,
    borderRadius: 6,
    background: '#92405e',
    position: 'absolute',
    bottom: -1,
  },

  navPetalWrap: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'flex-end',
    gap: 2,
    background: 'transparent',
    border: 'none',
    padding: '0 6px',
    cursor: 'pointer',
    WebkitTapHighlightColor: 'transparent',
  },
  navPetal: {
    width: 48,
    height: 48,
    borderRadius: '50%',
    background: 'linear-gradient(135deg, #c76b8a 0%, #92405e 100%)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    boxShadow: 'var(--elev-2)',
    border: '3px solid #FBF6F1',
    marginTop: -20,
  },
  navPetalLabel: {
    fontSize: 10,
    lineHeight: 1,
    letterSpacing: '0.01em',
    fontWeight: 500,
    color: 'var(--text-muted)',
  },

};
