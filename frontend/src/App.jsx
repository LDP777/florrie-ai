import { useState, useEffect, lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { supabase, isDevMode } from './lib/supabase.js';
import { useTheme } from './lib/theme.jsx';
import { useBeautician } from './lib/supabase.js';
import ErrorBoundary from './components/ErrorBoundary.jsx';
import PlanGate from './components/PlanGate.jsx';
import InstallPrompt from './components/InstallPrompt.jsx';

// Lazy-loaded pages (code splitting — each becomes its own chunk)
const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const CalendarView = lazy(() => import('./pages/CalendarView.jsx'));
const Escalations = lazy(() => import('./pages/Escalations.jsx'));
const ApprovalQueue = lazy(() => import('./pages/ApprovalQueue.jsx'));
const ContentAutopilot = lazy(() => import('./pages/ContentAutopilot.jsx'));
const MoneyTracker = lazy(() => import('./pages/MoneyTracker.jsx'));
const BookingPage = lazy(() => import('./pages/BookingPage.jsx'));
const ConsultationFormPublic = lazy(() => import('./pages/ConsultationFormPublic.jsx'));
const ConsultationFormBuilder = lazy(() => import('./pages/ConsultationFormBuilder.jsx'));
const Onboarding = lazy(() => import('./pages/Onboarding.jsx'));
const Login = lazy(() => import('./pages/Login.jsx'));
const Clients = lazy(() => import('./pages/Clients.jsx'));
const Treatments = lazy(() => import('./pages/Treatments.jsx'));
const Settings = lazy(() => import('./pages/Settings.jsx'));
const Team = lazy(() => import('./pages/Team.jsx'));
const Analytics = lazy(() => import('./pages/Analytics.jsx'));
const Waitlist = lazy(() => import('./pages/Waitlist.jsx'));
const WeeklyDigest = lazy(() => import('./pages/WeeklyDigest.jsx'));
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
const PatchTests = lazy(() => import('./pages/PatchTests.jsx'));
// IntakeForms removed — duplicate of ConsultationFormBuilder (/consultation-forms)
const Reports = lazy(() => import('./pages/Reports.jsx'));
const Policies = lazy(() => import('./pages/Policies.jsx'));
const BusinessProfile = lazy(() => import('./pages/BusinessProfile.jsx'));
const RebookReminders = lazy(() => import('./pages/RebookReminders.jsx'));
const Inbox = lazy(() => import('./pages/Inbox.jsx'));
const Packages = lazy(() => import('./pages/Packages.jsx'));
const MessageTemplates = lazy(() => import('./pages/MessageTemplates.jsx'));
const Referrals = lazy(() => import('./pages/Referrals.jsx'));
const Portfolio = lazy(() => import('./pages/Portfolio.jsx'));
const AppointmentNotes = lazy(() => import('./pages/AppointmentNotes.jsx'));
const Feedback = lazy(() => import('./pages/Feedback.jsx'));
const ExpensesPage = lazy(() => import('./pages/Expenses.jsx'));
const Consultations = lazy(() => import('./pages/Consultations.jsx'));
const FollowUpSequences = lazy(() => import('./pages/FollowUpSequences.jsx'));
const PhotoConsent = lazy(() => import('./pages/PhotoConsent.jsx'));
const WaitlistPro = lazy(() => import('./pages/WaitlistPro.jsx'));
const ClientTimeline = lazy(() => import('./pages/ClientTimeline.jsx'));
const StaffRota = lazy(() => import('./pages/StaffRota.jsx'));
const DepositTracker = lazy(() => import('./pages/DepositTracker.jsx'));
const AddOns = lazy(() => import('./pages/AddOns.jsx'));
const CancellationLog = lazy(() => import('./pages/CancellationLog.jsx'));
const ClientTags = lazy(() => import('./pages/ClientTags.jsx'));
const PromoCodes = lazy(() => import('./pages/PromoCodes.jsx'));
const DailyChecklist = lazy(() => import('./pages/DailyChecklist.jsx'));
const ProductInventory = lazy(() => import('./pages/ProductInventory.jsx'));
const RevenueGoals = lazy(() => import('./pages/RevenueGoals.jsx'));
const PriceList = lazy(() => import('./pages/PriceList.jsx'));
const TreatmentStats = lazy(() => import('./pages/TreatmentStats.jsx'));
const StaffPerformance = lazy(() => import('./pages/StaffPerformance.jsx'));

const ClientMemberships = lazy(() => import('./pages/ClientMemberships.jsx'));
const CommsLog = lazy(() => import('./pages/CommsLog.jsx'));
const EndOfDay = lazy(() => import('./pages/EndOfDay.jsx'));
const AutomationRules = lazy(() => import('./pages/AutomationRules.jsx'));
const WhatsAppConfig = lazy(() => import('./pages/WhatsAppConfig.jsx'));
const ClientPortal = lazy(() => import('./pages/ClientPortal.jsx'));
const AIInsights = lazy(() => import('./pages/AIInsights.jsx'));
const ClientSegments = lazy(() => import('./pages/ClientSegments.jsx'));
const ChurnPrevention = lazy(() => import('./pages/ChurnPrevention.jsx'));
const DemandForecast = lazy(() => import('./pages/DemandForecast.jsx'));
const MultiLocation = lazy(() => import('./pages/MultiLocation.jsx'));
const Integrations = lazy(() => import('./pages/Integrations.jsx'));
const SMSConfig = lazy(() => import('./pages/SMSConfig.jsx'));
const APISettings = lazy(() => import('./pages/APISettings.jsx'));
const Pricing = lazy(() => import('./pages/Pricing.jsx'));
const Hub = lazy(() => import('./pages/Hub.jsx'));
const NotFound = lazy(() => import('./pages/NotFound.jsx'));

function PageLoader() {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '40vh',
      gap: 12,
      animation: 'fadeIn 0.3s ease'
    }}>
      <div style={{
        width: 32,
        height: 32,
        border: '2.5px solid var(--border, #EDE9E4)',
        borderTopColor: 'var(--accent, #C76B8A)',
        borderRadius: '50%',
        animation: 'spin 0.8s linear infinite',
      }} />
      <span style={{
        fontSize: 12,
        color: 'var(--text-muted, #B5AFA8)',
        fontFamily: "var(--font-body, 'DM Sans', sans-serif)",
        letterSpacing: '0.04em',
      }}>Loading...</span>
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
    if (isDevMode) {
      // Dev mode — no Supabase configured, use mock session
      setSession({ access_token: 'dev-token' });
      setLoading(false);
      return;
    }

    supabase.auth.getSession().then(({ data: { session: s } }) => {
      setSession(s);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, s) => {
      setSession(s);
    });

    return () => subscription.unsubscribe();
  }, []);

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

  const isPublicRoute = location.pathname.startsWith('/book/') || location.pathname.startsWith('/form/');
  const isAuthRoute = location.pathname === '/login';

  if (loading) {
    return (
      <div style={styles.loadingScreen}>
        <img src="/florrie-petal.svg" alt="" style={{ width: 48, height: 48, animation: 'spin 2.5s ease-in-out infinite' }} />
        <span style={styles.loadingLogo}>florrie<span style={{ color: 'var(--gold, #C9A96E)', fontFamily: "'DM Sans', sans-serif", fontWeight: 500 }}>.ai</span></span>
        <span style={{ fontSize: 11, color: 'var(--text-muted, #B5AFA8)', fontFamily: "'DM Sans', sans-serif", letterSpacing: '0.08em', textTransform: 'uppercase' }}>your AI team</span>
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
          <Route path="/form/:token" element={<ConsultationFormPublic />} />
        </Routes>
      </Suspense>
    );
  }

  // Not logged in → login
  if (!session) {
    return (
      <Suspense fallback={<PageLoader />}>
        <Routes>
          <Route path="/login" element={<Login supabase={supabase} />} />
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
          onComplete={() => {
            setNeedsOnboarding(false);
            navigate('/');
          }}
        />
      </Suspense>
    );
  }

  // Authenticated app
  const showNav = !isAuthRoute && !location.pathname.startsWith('/onboarding');

  return (
    <ErrorBoundary>
      <div style={styles.appShell}>
        {isDevMode && (
          <div style={styles.devModeBanner}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>🔧 Running in demo mode</span>
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.85)' }}>— Connect Supabase to see real data</span>
          </div>
        )}
        <InstallPrompt />
        <div style={styles.pageContainer}>
          <Suspense fallback={<PageLoader />}>
            <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/calendar" element={<CalendarView />} />
            <Route path="/escalations" element={<Escalations />} />
            <Route path="/approval-queue" element={<ApprovalQueue />} />
            <Route path="/content" element={<PlanGate feature="content_autopilot"><ContentAutopilot /></PlanGate>} />
            <Route path="/money" element={<MoneyTracker />} />
            <Route path="/clients" element={<Clients />} />
            <Route path="/treatments" element={<Treatments />} />
            <Route path="/settings" element={<Settings supabase={supabase} onLogout={async () => { if (supabase) await supabase.auth.signOut(); setSession(null); }} />} />
            <Route path="/team" element={<PlanGate feature="team_management"><Team /></PlanGate>} />
            <Route path="/analytics" element={<Analytics />} />
            <Route path="/waitlist" element={<Waitlist />} />
            <Route path="/digest" element={<WeeklyDigest />} />
            <Route path="/campaigns" element={<PlanGate feature="campaigns"><Campaigns /></PlanGate>} />
            <Route path="/voice" element={<VoiceCommander />} />
            <Route path="/reviews" element={<Reviews />} />
            <Route path="/import" element={<ClientImport />} />
            <Route path="/loyalty" element={<PlanGate feature="loyalty"><Loyalty /></PlanGate>} />
            <Route path="/aftercare" element={<PlanGate feature="aftercare"><Aftercare /></PlanGate>} />
            <Route path="/smart-schedule" element={<PlanGate feature="smart_schedule"><SmartSchedule /></PlanGate>} />
            <Route path="/vouchers" element={<GiftVouchers />} />
            <Route path="/notifications" element={<Notifications />} />
            <Route path="/hours" element={<HoursExceptions />} />
            <Route path="/patch-tests" element={<PatchTests />} />
            {/* /forms removed — use /consultation-forms instead */}
            <Route path="/reports" element={<PlanGate feature="reports"><Reports /></PlanGate>} />
            <Route path="/policies" element={<Policies />} />
            <Route path="/business" element={<BusinessProfile />} />
            <Route path="/rebook" element={<RebookReminders />} />
            <Route path="/inbox" element={<Inbox />} />
            <Route path="/packages" element={<Packages />} />
            <Route path="/templates" element={<MessageTemplates />} />
            <Route path="/referrals" element={<Referrals />} />
            <Route path="/portfolio" element={<Portfolio />} />
            <Route path="/notes" element={<AppointmentNotes />} />
            <Route path="/feedback" element={<Feedback />} />
            <Route path="/expenses" element={<ExpensesPage />} />
            <Route path="/consultations" element={<Consultations />} />
            <Route path="/consultation-forms" element={<ConsultationFormBuilder />} />
            <Route path="/consultation-forms/:id" element={<ConsultationFormBuilder />} />
            <Route path="/sequences" element={<FollowUpSequences />} />
            <Route path="/photo-consent" element={<PhotoConsent />} />
            <Route path="/waitlist-pro" element={<WaitlistPro />} />
            <Route path="/client-timeline" element={<ClientTimeline />} />
            <Route path="/rota" element={<PlanGate feature="staff_rota"><StaffRota /></PlanGate>} />
            <Route path="/deposits" element={<DepositTracker />} />
            <Route path="/addons" element={<AddOns />} />
            <Route path="/cancellations" element={<CancellationLog />} />
            <Route path="/tags" element={<ClientTags />} />
            <Route path="/promos" element={<PromoCodes />} />
            <Route path="/checklist" element={<DailyChecklist />} />
            <Route path="/inventory" element={<ProductInventory />} />
            <Route path="/goals" element={<RevenueGoals />} />
            <Route path="/price-list" element={<PriceList />} />
            <Route path="/treatment-stats" element={<TreatmentStats />} />
            <Route path="/staff-performance" element={<PlanGate feature="staff_performance"><StaffPerformance /></PlanGate>} />

            <Route path="/memberships" element={<ClientMemberships />} />
            <Route path="/comms" element={<CommsLog />} />
            <Route path="/end-of-day" element={<EndOfDay />} />
            <Route path="/automations" element={<AutomationRules />} />
            <Route path="/whatsapp" element={<PlanGate feature="whatsapp"><WhatsAppConfig /></PlanGate>} />
            <Route path="/portal" element={<ClientPortal />} />
            <Route path="/ai-insights" element={<PlanGate feature="ai_insights"><AIInsights /></PlanGate>} />
            <Route path="/segments" element={<PlanGate feature="client_segments"><ClientSegments /></PlanGate>} />
            <Route path="/churn" element={<PlanGate feature="churn_prevention"><ChurnPrevention /></PlanGate>} />
            <Route path="/demand" element={<PlanGate feature="demand_forecast"><DemandForecast /></PlanGate>} />
            <Route path="/locations" element={<PlanGate feature="multi_location"><MultiLocation /></PlanGate>} />
            <Route path="/integrations" element={<Integrations />} />
            <Route path="/sms" element={<PlanGate feature="sms"><SMSConfig /></PlanGate>} />
            <Route path="/api-settings" element={<APISettings />} />
            <Route path="/pricing" element={<Pricing />} />
            <Route path="/hub" element={<Hub />} />
            <Route path="/onboarding" element={
              <Onboarding onComplete={() => navigate('/')} />
            } />
            <Route path="/login" element={<Navigate to="/" replace />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </div>

      {showNav && <BottomNav current={location.pathname} />}
      </div>
    </ErrorBoundary>
  );
}

/**
 * Mobile bottom navigation — Stitch BottomNavBar reference.
 * 5 tabs: Home, Calendar, florrie.ai (raised centre), Money, Hub.
 * Uses Material Symbols Outlined. Active state = filled icon + accent color + dot.
 */
function BottomNav({ current }) {
  const navigate = useNavigate();

  const hubPaths = ['/hub', '/money', '/analytics', '/clients', '/treatments', '/team', '/waitlist', '/digest', '/campaigns', '/reviews', '/loyalty', '/aftercare', '/import', '/smart-schedule', '/vouchers', '/notifications', '/hours', '/patch-tests', '/reports', '/policies', '/business', '/rebook', '/inbox', '/packages', '/templates', '/referrals', '/portfolio', '/notes', '/feedback', '/expenses', '/consultations', '/sequences', '/photo-consent', '/waitlist-pro', '/client-timeline', '/rota', '/deposits', '/addons', '/cancellations', '/tags', '/promos', '/checklist', '/inventory', '/goals', '/price-list', '/treatment-stats', '/staff-performance', '/memberships', '/comms', '/end-of-day', '/automations', '/whatsapp', '/portal', '/ai-insights', '/segments', '/churn', '/demand', '/locations', '/integrations', '/sms', '/api-settings', '/escalations', '/settings'];
  const isHubActive = hubPaths.includes(current);

  const tabs = [
    { path: '/', label: 'Home', icon: 'home', isPetal: false },
    { path: '/calendar', label: 'Calendar', icon: 'calendar_today', isPetal: false },
    { path: '/voice', label: 'florrie.ai', icon: 'auto_awesome', isPetal: true },
    { path: '/money', label: 'Money', icon: 'payments', isPetal: false },
    { path: '/hub', label: 'Hub', icon: 'explore', isPetal: false }
  ];

  return (
    <nav style={styles.nav}>
      {tabs.map(tab => {
        const active = tab.path === '/hub' ? isHubActive : current === tab.path;
        const color = active ? '#92405e' : '#867277';
        return (
          <button
            key={tab.path}
            onClick={() => navigate(tab.path)}
            style={styles.navItem}
          >
            {tab.isPetal ? (
              /* Raised centre button — Stitch FAB style */
              <div style={{
                width: 52, height: 52, borderRadius: '50%',
                background: 'linear-gradient(135deg, #c76b8a 0%, #92405e 100%)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                boxShadow: '0 4px 16px rgba(146, 64, 94, 0.35)',
                marginTop: -24,
                border: '3px solid #fef8f4',
              }}>
                <span className="material-symbols-outlined" style={{
                  fontSize: 24, color: '#fff',
                  fontVariationSettings: "'FILL' 1, 'wght' 300",
                }}>{tab.icon}</span>
              </div>
            ) : (
              <span className="material-symbols-outlined" style={{
                fontSize: 22, color,
                fontVariationSettings: active ? "'FILL' 1, 'wght' 300" : "'FILL' 0, 'wght' 300",
                transition: 'color 0.15s ease',
              }}>{tab.icon}</span>
            )}
            <span style={{
              fontSize: 10, lineHeight: 1, letterSpacing: '0.01em',
              fontWeight: active ? 600 : 400,
              color,
              fontFamily: tab.isPetal ? "'Playfair Display', Georgia, serif" : 'inherit',
              fontStyle: tab.isPetal ? 'italic' : 'normal',
            }}>
              {tab.label}
            </span>
            {active && !tab.isPetal && <div style={styles.navDot} />}
          </button>
        );
      })}
    </nav>
  );
}

const styles = {
  loadingScreen: {
    display: 'flex',
    flexDirection: 'column',
    justifyContent: 'center',
    alignItems: 'center',
    minHeight: '100vh',
    background: '#fef8f4',
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
    display: 'flex',
    flexDirection: 'column',
    minHeight: '100vh',
    background: 'var(--bg, #fef8f4)',
  },
  pageContainer: {
    flex: 1,
    paddingBottom: 76,
  },

  // Bottom nav — Stitch glass morphism
  nav: {
    position: 'fixed',
    bottom: 0,
    left: 0,
    right: 0,
    display: 'flex',
    justifyContent: 'space-around',
    alignItems: 'center',
    background: 'rgba(254, 248, 244, 0.9)',
    backdropFilter: 'blur(20px) saturate(180%)',
    WebkitBackdropFilter: 'blur(20px) saturate(180%)',
    borderTop: '1px solid rgba(146, 64, 94, 0.1)',
    padding: '5px 0 env(safe-area-inset-bottom, 8px)',
    zIndex: 100,
    fontFamily: "var(--font-body, 'Plus Jakarta Sans', sans-serif)",
    boxShadow: '0 -1px 12px rgba(146, 64, 94, 0.04)',
  },
  navItem: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 3,
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: '6px 14px',
    position: 'relative',
    fontFamily: 'inherit',
    WebkitTapHighlightColor: 'transparent',
    transition: 'color 0.15s ease',
  },
  navDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    background: '#92405e',
    position: 'absolute',
    bottom: -1,
  },

  devModeBanner: {
    background: 'linear-gradient(135deg, #1d1b19, #2d2a26)',
    color: '#fff',
    padding: '10px 16px',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 12,
    fontFamily: "var(--font-body, 'Plus Jakarta Sans', sans-serif)",
    borderBottom: '1px solid rgba(255,255,255,0.1)',
  },

};
