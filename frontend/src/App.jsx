import { useState, useEffect, lazy, Suspense } from 'react';
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { supabase, isDevMode } from './lib/supabase.js';
import { useTheme } from './lib/theme.jsx';
import { useBeautician } from './lib/supabase.js';
import QuickBook from './components/QuickBook.jsx';
import ErrorBoundary from './components/ErrorBoundary.jsx';

// Lazy-loaded pages (code splitting — each becomes its own chunk)
const Dashboard = lazy(() => import('./pages/Dashboard.jsx'));
const CalendarView = lazy(() => import('./pages/CalendarView.jsx'));
const Escalations = lazy(() => import('./pages/Escalations.jsx'));
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
const SupplierOrders = lazy(() => import('./pages/SupplierOrders.jsx'));
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

  const token = session?.access_token;
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
          token={token}
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
        <div style={styles.pageContainer}>
          <Suspense fallback={<PageLoader />}>
            <Routes>
            <Route path="/" element={<Dashboard token={token} />} />
            <Route path="/calendar" element={<CalendarView token={token} />} />
            <Route path="/escalations" element={<Escalations />} />
            <Route path="/content" element={<ContentAutopilot />} />
            <Route path="/money" element={<MoneyTracker />} />
            <Route path="/clients" element={<Clients token={token} />} />
            <Route path="/treatments" element={<Treatments token={token} />} />
            <Route path="/settings" element={<Settings token={token} supabase={supabase} onLogout={async () => { if (supabase) await supabase.auth.signOut(); setSession(null); }} />} />
            <Route path="/team" element={<Team token={token} />} />
            <Route path="/analytics" element={<Analytics token={token} />} />
            <Route path="/waitlist" element={<Waitlist token={token} />} />
            <Route path="/digest" element={<WeeklyDigest token={token} />} />
            <Route path="/campaigns" element={<Campaigns token={token} />} />
            <Route path="/voice" element={<VoiceCommander token={token} />} />
            <Route path="/reviews" element={<Reviews token={token} />} />
            <Route path="/import" element={<ClientImport token={token} />} />
            <Route path="/loyalty" element={<Loyalty token={token} />} />
            <Route path="/aftercare" element={<Aftercare token={token} />} />
            <Route path="/smart-schedule" element={<SmartSchedule token={token} />} />
            <Route path="/vouchers" element={<GiftVouchers token={token} />} />
            <Route path="/notifications" element={<Notifications token={token} />} />
            <Route path="/hours" element={<HoursExceptions token={token} />} />
            <Route path="/patch-tests" element={<PatchTests token={token} />} />
            {/* /forms removed — use /consultation-forms instead */}
            <Route path="/reports" element={<Reports token={token} />} />
            <Route path="/policies" element={<Policies token={token} />} />
            <Route path="/business" element={<BusinessProfile token={token} />} />
            <Route path="/rebook" element={<RebookReminders token={token} />} />
            <Route path="/inbox" element={<Inbox token={token} />} />
            <Route path="/packages" element={<Packages token={token} />} />
            <Route path="/templates" element={<MessageTemplates token={token} />} />
            <Route path="/referrals" element={<Referrals token={token} />} />
            <Route path="/portfolio" element={<Portfolio token={token} />} />
            <Route path="/notes" element={<AppointmentNotes token={token} />} />
            <Route path="/feedback" element={<Feedback token={token} />} />
            <Route path="/expenses" element={<ExpensesPage token={token} />} />
            <Route path="/consultations" element={<Consultations token={token} />} />
            <Route path="/consultation-forms" element={<ConsultationFormBuilder />} />
            <Route path="/consultation-forms/:id" element={<ConsultationFormBuilder />} />
            <Route path="/sequences" element={<FollowUpSequences token={token} />} />
            <Route path="/photo-consent" element={<PhotoConsent token={token} />} />
            <Route path="/waitlist-pro" element={<WaitlistPro token={token} />} />
            <Route path="/client-timeline" element={<ClientTimeline token={token} />} />
            <Route path="/rota" element={<StaffRota token={token} />} />
            <Route path="/deposits" element={<DepositTracker token={token} />} />
            <Route path="/addons" element={<AddOns token={token} />} />
            <Route path="/cancellations" element={<CancellationLog token={token} />} />
            <Route path="/tags" element={<ClientTags token={token} />} />
            <Route path="/promos" element={<PromoCodes token={token} />} />
            <Route path="/checklist" element={<DailyChecklist token={token} />} />
            <Route path="/inventory" element={<ProductInventory token={token} />} />
            <Route path="/goals" element={<RevenueGoals token={token} />} />
            <Route path="/price-list" element={<PriceList token={token} />} />
            <Route path="/treatment-stats" element={<TreatmentStats token={token} />} />
            <Route path="/staff-performance" element={<StaffPerformance token={token} />} />
            <Route path="/supplier-orders" element={<SupplierOrders token={token} />} />
            <Route path="/memberships" element={<ClientMemberships token={token} />} />
            <Route path="/comms" element={<CommsLog token={token} />} />
            <Route path="/end-of-day" element={<EndOfDay token={token} />} />
            <Route path="/automations" element={<AutomationRules token={token} />} />
            <Route path="/whatsapp" element={<WhatsAppConfig token={token} />} />
            <Route path="/portal" element={<ClientPortal token={token} />} />
            <Route path="/ai-insights" element={<AIInsights token={token} />} />
            <Route path="/segments" element={<ClientSegments token={token} />} />
            <Route path="/churn" element={<ChurnPrevention token={token} />} />
            <Route path="/demand" element={<DemandForecast token={token} />} />
            <Route path="/locations" element={<MultiLocation token={token} />} />
            <Route path="/integrations" element={<Integrations token={token} />} />
            <Route path="/sms" element={<SMSConfig token={token} />} />
            <Route path="/api-settings" element={<APISettings token={token} />} />
            <Route path="/hub" element={<Hub token={token} />} />
            <Route path="/onboarding" element={
              <Onboarding token={token} onComplete={() => navigate('/')} />
            } />
            <Route path="/login" element={<Navigate to="/" replace />} />
            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </div>

      {showNav && <QuickBook />}
      {showNav && <BottomNav current={location.pathname} />}
      </div>
    </ErrorBoundary>
  );
}

/**
 * Mobile bottom navigation — 5 tabs. "Hub" navigates to categorised hub page.
 */
function BottomNav({ current }) {
  const navigate = useNavigate();

  // Hub is active when on /hub or any sub-page that lives inside the hub
  const hubPaths = ['/hub', '/money', '/analytics', '/clients', '/treatments', '/team', '/waitlist', '/digest', '/campaigns', '/reviews', '/loyalty', '/aftercare', '/import', '/smart-schedule', '/vouchers', '/notifications', '/hours', '/patch-tests', '/reports', '/policies', '/business', '/rebook', '/inbox', '/packages', '/templates', '/referrals', '/portfolio', '/notes', '/feedback', '/expenses', '/consultations', '/sequences', '/photo-consent', '/waitlist-pro', '/client-timeline', '/rota', '/deposits', '/addons', '/cancellations', '/tags', '/promos', '/checklist', '/inventory', '/goals', '/price-list', '/treatment-stats', '/staff-performance', '/supplier-orders', '/memberships', '/comms', '/end-of-day', '/automations', '/whatsapp', '/portal', '/ai-insights', '/segments', '/churn', '/demand', '/locations', '/integrations', '/sms', '/api-settings', '/escalations', '/settings'];
  const isHubActive = hubPaths.includes(current);

  const tabs = [
    { path: '/', label: 'Home', icon: '🏠' },
    { path: '/calendar', label: 'Calendar', icon: '📅' },
    { path: '/voice', label: 'florrie.ai', icon: null, isPetal: true },
    { path: '/money', label: 'Money', icon: '💰' },
    { path: '/hub', label: 'Hub', icon: '🧭' }
  ];

  return (
    <nav style={styles.nav}>
      {tabs.map(tab => {
        const active = tab.path === '/hub' ? isHubActive : current === tab.path;
        return (
          <button
            key={tab.path}
            onClick={() => navigate(tab.path)}
            style={{
              ...styles.navItem,
              color: active ? 'var(--accent, #C76B8A)' : 'var(--text-muted, #B5AFA8)'
            }}
          >
            {tab.isPetal ? (
              <img src="/florrie-petal.svg" alt="florrie" style={{ width: 22, height: 22 }} />
            ) : (
              <span style={styles.navIcon}>{tab.icon}</span>
            )}
            <span style={{
              ...styles.navLabel,
              fontWeight: active ? 600 : 400
            }}>
              {tab.label}
            </span>
            {active && <div style={styles.navDot} />}
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
    background: 'var(--bg, #FAF8F5)',
    gap: 8,
    animation: 'fadeIn 0.6s ease',
  },
  loadingLogo: {
    fontSize: 30,
    fontWeight: 600,
    color: 'var(--accent, #C76B8A)',
    fontFamily: "'Playfair Display', Georgia, serif",
    letterSpacing: '-0.03em',
  },
  appShell: {
    display: 'flex',
    flexDirection: 'column',
    minHeight: '100vh',
    background: 'var(--bg, #FAF8F5)',
  },
  pageContainer: {
    flex: 1,
    paddingBottom: 76,
  },

  // Bottom nav — frosted glass
  nav: {
    position: 'fixed',
    bottom: 0,
    left: 0,
    right: 0,
    display: 'flex',
    justifyContent: 'space-around',
    alignItems: 'center',
    background: 'var(--nav-bg, rgba(255,255,255,0.92))',
    backdropFilter: 'blur(20px) saturate(180%)',
    WebkitBackdropFilter: 'blur(20px) saturate(180%)',
    borderTop: '1px solid var(--nav-border, #EDE9E4)',
    padding: '5px 0 env(safe-area-inset-bottom, 8px)',
    zIndex: 100,
    fontFamily: "'DM Sans', -apple-system, sans-serif",
    boxShadow: '0 -1px 12px rgba(0,0,0,0.03)',
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
  navIcon: { fontSize: 20, lineHeight: 1 },
  navLabel: { fontSize: 10, lineHeight: 1, letterSpacing: '0.01em' },
  navDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    background: 'var(--accent, #C76B8A)',
    position: 'absolute',
    bottom: -1,
  },

  devModeBanner: {
    background: 'linear-gradient(135deg, #2D2A26, #3D3A36)',
    color: '#fff',
    padding: '10px 16px',
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    fontSize: 12,
    fontFamily: "'DM Sans', -apple-system, sans-serif",
    borderBottom: '1px solid rgba(255,255,255,0.1)',
  },

};
