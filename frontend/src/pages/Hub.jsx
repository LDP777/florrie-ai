import { useState, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { ds, type } from '../lib/designSystem.js';
import { useBeautician } from '../lib/supabase.js';
import { hasFeature } from '../lib/subscription.js';

// ─── Navigation categories ────────────────────────────────
const CATEGORIES = [
  {
    id: 'daily',
    label: 'Your Day',
    description: 'Daily ops and schedule',
    accent: '#C76B8A',
    items: [
      { path: '/calendar', label: 'Calendar', desc: 'View and manage appointments', icon: '📅' },
      { path: '/smart-schedule', label: 'Smart Schedule', desc: 'AI-optimised time slots', icon: '🧠', gate: 'smart_schedule' },
      { path: '/checklist', label: 'Daily Checklist', desc: 'Opening and closing tasks', icon: '☑️' },
      { path: '/end-of-day', label: 'End of Day', desc: 'Cash-up and close', icon: '🌙' },
      { path: '/notifications', label: 'Notifications', desc: 'Alerts and reminders', icon: '🔔' },
    ]
  },
  {
    id: 'clients',
    label: 'Clients',
    description: 'Relationships and records',
    accent: '#7B9E6B',
    items: [
      { path: '/clients', label: 'All Clients', desc: 'Client list and profiles', icon: '👤' },
      { path: '/client-timeline', label: 'Client Timeline', desc: 'Full history per client', icon: '📜' },
      { path: '/tags', label: 'Tags & Groups', desc: 'Organise and segment', icon: '🏷️' },
      { path: '/import', label: 'Import Clients', desc: 'CSV and bulk import', icon: '📥' },
      { path: '/waitlist', label: 'Waitlist', desc: 'Manage waiting clients', icon: '📋' },
      { path: '/waitlist-pro', label: 'Smart Waitlist', desc: 'Priority and auto-notify', icon: '⏳' },
    ]
  },
  {
    id: 'treatments',
    label: 'Treatments & Services',
    description: 'What you offer',
    accent: '#C9A96E',
    items: [
      { path: '/treatments', label: 'Treatments', desc: 'Manage your services', icon: '💅' },
      { path: '/price-list', label: 'Price List', desc: 'Pricing and durations', icon: '💲' },
      { path: '/packages', label: 'Packages', desc: 'Bundle deals', icon: '📦' },
      { path: '/addons', label: 'Add-ons & Upsells', desc: 'Bolt-on extras', icon: '✨' },
      { path: '/treatment-stats', label: 'Treatment Stats', desc: 'Popularity and revenue', icon: '📊' },
      { path: '/consultations', label: 'Consultations', desc: 'Pre-treatment bookings', icon: '🩺' },
      { path: '/patch-tests', label: 'Patch Tests', desc: 'Allergy test tracking', icon: '🩹' },
      { path: '/aftercare', label: 'Aftercare', desc: 'Post-treatment messages', icon: '💆' },
    ]
  },
  {
    id: 'money',
    label: 'Money',
    description: 'Revenue and expenses',
    accent: '#6B9BC7',
    items: [
      { path: '/money', label: 'Money Tracker', desc: 'Revenue dashboard', icon: '💰' },
      { path: '/goals', label: 'Revenue Goals', desc: 'Targets and progress', icon: '🎯' },
      { path: '/expenses', label: 'Expenses', desc: 'Track outgoings', icon: '💳' },
      { path: '/deposits', label: 'Deposits', desc: 'Held payments', icon: '🔒' },
      { path: '/vouchers', label: 'Gift Vouchers', desc: 'Create and track', icon: '🎁' },
      { path: '/promos', label: 'Promo Codes', desc: 'Discounts and offers', icon: '🎟️' },
      { path: '/memberships', label: 'Memberships', desc: 'Recurring packages', icon: '💎' },
      { path: '/cancellations', label: 'Cancellations', desc: 'No-shows and late cancels', icon: '❌' },
    ]
  },
  {
    id: 'marketing',
    label: 'Marketing & Growth',
    description: 'Attract and retain',
    accent: '#B85D7B',
    items: [
      { path: '/content', label: 'Content Autopilot', desc: 'AI-written captions', icon: '📸', gate: 'content_autopilot' },
      { path: '/campaigns', label: 'Campaigns', desc: 'Email and SMS blasts', icon: '💌', gate: 'campaigns' },
      { path: '/reviews', label: 'Reviews', desc: 'Collect and respond', icon: '⭐' },
      { path: '/referrals', label: 'Referrals', desc: 'Word-of-mouth tracking', icon: '🤝' },
      { path: '/loyalty', label: 'Loyalty', desc: 'Points and rewards', icon: '🏆' },
      { path: '/portfolio', label: 'Portfolio', desc: 'Before & after gallery', icon: '📸' },
      { path: '/feedback', label: 'Feedback', desc: 'Client satisfaction', icon: '💬' },
      { path: '/rebook', label: 'Rebook Reminders', desc: 'Bring clients back', icon: '🔄' },
    ]
  },
  {
    id: 'comms',
    label: 'Communications',
    description: 'Messages and channels',
    accent: '#8B7BC7',
    items: [
      { path: '/inbox', label: 'Inbox', desc: 'All messages in one place', icon: '💬' },
      { path: '/escalations', label: 'Escalations', desc: 'AI-flagged messages', icon: '🚨' },
      { path: '/whatsapp', label: 'WhatsApp', desc: 'Business messaging', icon: '💬', gate: 'whatsapp' },
      { path: '/sms', label: 'SMS Config', desc: 'Text message gateway', icon: '📱', gate: 'sms' },
      { path: '/sequences', label: 'Follow-up Sequences', desc: 'Automated flows', icon: '🔄' },
      { path: '/templates', label: 'Message Templates', desc: 'Reusable messages', icon: '📋' },
      { path: '/comms', label: 'Comms Log', desc: 'Full message history', icon: '📨' },
      { path: '/automations', label: 'Automations', desc: 'If-this-then-that rules', icon: '⚡' },
    ]
  },
  {
    id: 'ai',
    label: 'AI & Intelligence',
    description: 'Florrie\'s brain',
    accent: '#C76B8A',
    items: [
      { path: '/voice', label: 'Florrie AI', desc: 'Your AI assistant', icon: '✨' },
      { path: '/ai-insights', label: 'AI Insights', desc: 'Predictions and trends', icon: '🧠', gate: 'ai_insights' },
      { path: '/segments', label: 'Client Segments', desc: 'Smart grouping', icon: '🎯', gate: 'client_segments' },
      { path: '/churn', label: 'Churn Prevention', desc: 'At-risk clients', icon: '🛡️', gate: 'churn_prevention' },
      { path: '/demand', label: 'Demand Forecast', desc: 'Capacity planning', icon: '📊', gate: 'demand_forecast' },
    ]
  },
  {
    id: 'team',
    label: 'Team',
    description: 'Staff management',
    accent: '#6BB5A0',
    items: [
      { path: '/team', label: 'Team Members', desc: 'Staff profiles', icon: '👥' },
      { path: '/rota', label: 'Staff Rota', desc: 'Weekly schedule', icon: '🗓️' },
      { path: '/staff-performance', label: 'Staff KPIs', desc: 'Performance metrics', icon: '🏅' },
      { path: '/hours', label: 'Hours & Closures', desc: 'Working hours and holidays', icon: '🏖️' },
    ]
  },
  {
    id: 'reports',
    label: 'Reports & Analytics',
    description: 'Numbers and trends',
    accent: '#C9A96E',
    items: [
      { path: '/analytics', label: 'Analytics', desc: 'Business overview', icon: '📊' },
      { path: '/reports', label: 'Reports', desc: 'Detailed breakdowns', icon: '📈' },
      { path: '/digest', label: 'Weekly Digest', desc: 'Week-in-review summary', icon: '📬' },
    ]
  },
  {
    id: 'settings',
    label: 'Settings',
    description: 'Configure your account',
    accent: '#AAA5A0',
    items: [
      { path: '/settings', label: 'Settings', desc: 'Account preferences', icon: '⚙️' },
      { path: '/business', label: 'Business Profile', desc: 'Name, logo, details', icon: '🏪' },
      { path: '/policies', label: 'Policies', desc: 'Cancellation and terms', icon: '📜' },
      { path: '/forms', label: 'Consent Forms', desc: 'Client intake forms', icon: '📝' },
      { path: '/photo-consent', label: 'Photo Consent', desc: 'GDPR compliance', icon: '📋' },
      { path: '/notes', label: 'Appointment Notes', desc: 'Treatment notes setup', icon: '📝' },
      { path: '/portal', label: 'Client Portal', desc: 'Self-service settings', icon: '🌐' },
      { path: '/locations', label: 'Multi-Location', desc: 'Branch management', icon: '🏢', gate: 'multi_location' },
      { path: '/integrations', label: 'Integrations', desc: 'Connected apps', icon: '🔌' },
      { path: '/inventory', label: 'Product Inventory', desc: 'Stock management', icon: '📦' },
      { path: '/supplier-orders', label: 'Supplier Orders', desc: 'Restock and orders', icon: '📦' },
      { path: '/api-settings', label: 'API & Webhooks', desc: 'Developer tools', icon: '⚡' },
    ]
  },
];

export default function Hub() {
  const [search, setSearch] = useState('');
  const [expandedCat, setExpandedCat] = useState(null);
  const navigate = useNavigate();
  const location = useLocation();
  const { beautician } = useBeautician();
  const plan = beautician?.subscription_plan || 'free';

  // Filter items by search
  const filtered = useMemo(() => {
    if (!search.trim()) return CATEGORIES;
    const q = search.toLowerCase();
    return CATEGORIES.map(cat => ({
      ...cat,
      items: cat.items.filter(i =>
        i.label.toLowerCase().includes(q) ||
        i.desc.toLowerCase().includes(q) ||
        cat.label.toLowerCase().includes(q)
      )
    })).filter(cat => cat.items.length > 0);
  }, [search]);

  const handleNav = (path) => {
    navigate(path);
  };

  return (
    <div style={S.page}>
      {/* Header */}
      <div style={S.header}>
        <h1 style={S.title}>Hub</h1>
        <p style={S.subtitle}>Everything in one place</p>
      </div>

      {/* Search */}
      <div style={S.searchWrap}>
        <span style={S.searchIcon}>🔍</span>
        <input
          type="text"
          placeholder="Search features..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={S.searchInput}
        />
        {search && (
          <button onClick={() => setSearch('')} style={S.searchClear}>✕</button>
        )}
      </div>

      {/* Quick access row */}
      {!search && (
        <div style={S.quickRow}>
          {[
            { path: '/money', icon: '💰', label: 'Money' },
            { path: '/clients', icon: '👤', label: 'Clients' },
            { path: '/analytics', icon: '📊', label: 'Analytics' },
            { path: '/inbox', icon: '💬', label: 'Inbox' },
          ].map(q => (
            <button key={q.path} onClick={() => handleNav(q.path)} style={S.quickBtn}>
              <span style={S.quickIcon}>{q.icon}</span>
              <span style={S.quickLabel}>{q.label}</span>
            </button>
          ))}
        </div>
      )}

      {/* Categories */}
      <div style={S.categories}>
        {filtered.map(cat => {
          const isExpanded = expandedCat === cat.id || search.trim().length > 0;
          const visibleItems = isExpanded ? cat.items : cat.items.slice(0, 3);
          const hasMore = cat.items.length > 3;

          return (
            <div key={cat.id} style={S.category}>
              {/* Category header */}
              <button
                onClick={() => setExpandedCat(expandedCat === cat.id ? null : cat.id)}
                style={S.catHeader}
              >
                <div>
                  <div style={{ ...S.catLabel, color: cat.accent }}>{cat.label}</div>
                  <div style={S.catDesc}>{cat.description}</div>
                </div>
                <div style={S.catCount}>
                  {cat.items.length}
                  <span style={{ ...S.catArrow, transform: isExpanded ? 'rotate(180deg)' : 'rotate(0)' }}>▾</span>
                </div>
              </button>

              {/* Items grid */}
              <div style={S.itemGrid}>
                {visibleItems.map(item => {
                  const locked = item.gate && !hasFeature(plan, item.gate);
                  const isActive = location.pathname === item.path;
                  return (
                    <button
                      key={item.path}
                      onClick={() => !locked && handleNav(item.path)}
                      style={{
                        ...S.item,
                        ...(isActive ? S.itemActive : {}),
                        ...(locked ? S.itemLocked : {}),
                      }}
                    >
                      <div style={S.itemTop}>
                        <span style={S.itemIcon}>{item.icon}</span>
                        {locked && <span style={S.lockBadge}>PRO</span>}
                      </div>
                      <div style={S.itemLabel}>{item.label}</div>
                      <div style={S.itemDesc}>{item.desc}</div>
                    </button>
                  );
                })}
              </div>

              {/* Show more / less */}
              {hasMore && !search && (
                <button
                  onClick={() => setExpandedCat(expandedCat === cat.id ? null : cat.id)}
                  style={S.showMore}
                >
                  {isExpanded ? 'Show less' : `Show all ${cat.items.length}`}
                </button>
              )}
            </div>
          );
        })}
      </div>

      {/* Empty search */}
      {search && filtered.length === 0 && (
        <div style={S.emptySearch}>
          <span style={{ fontSize: 32 }}>🔍</span>
          <p style={{ margin: '8px 0 0', color: 'var(--text-muted)' }}>No features match "{search}"</p>
        </div>
      )}
    </div>
  );
}

// ─── Styles ───────────────────────────────────────────────
const S = {
  page: {
    ...ds.page,
    paddingTop: 20,
  },
  header: {
    marginBottom: 20,
  },
  title: {
    ...type.displayLg,
    margin: 0,
  },
  subtitle: {
    ...type.bodySmall,
    marginTop: 4,
  },

  // Search
  searchWrap: {
    position: 'relative',
    marginBottom: 20,
  },
  searchIcon: {
    position: 'absolute',
    left: 14,
    top: '50%',
    transform: 'translateY(-50%)',
    fontSize: 14,
    pointerEvents: 'none',
  },
  searchInput: {
    width: '100%',
    padding: '12px 40px 12px 40px',
    borderRadius: 14,
    border: '1px solid var(--border, #EDE9E4)',
    background: 'var(--bg-card, #fff)',
    fontSize: 14,
    fontFamily: "var(--font-body, 'DM Sans', sans-serif)",
    color: 'var(--text-primary, #2D2A26)',
    outline: 'none',
    boxSizing: 'border-box',
    transition: 'border-color 0.15s',
  },
  searchClear: {
    position: 'absolute',
    right: 12,
    top: '50%',
    transform: 'translateY(-50%)',
    background: 'var(--bg-subtle, #F5F2EF)',
    border: 'none',
    borderRadius: 10,
    width: 22,
    height: 22,
    fontSize: 10,
    color: 'var(--text-muted)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },

  // Quick access
  quickRow: {
    display: 'flex',
    gap: 10,
    marginBottom: 24,
  },
  quickBtn: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 6,
    padding: '14px 8px',
    borderRadius: 16,
    border: '1px solid var(--border, #EDE9E4)',
    background: 'var(--bg-card, #fff)',
    cursor: 'pointer',
    fontFamily: "var(--font-body, 'DM Sans', sans-serif)",
    transition: 'transform 0.1s, box-shadow 0.15s',
    boxShadow: 'var(--shadow-xs, 0 1px 3px rgba(0,0,0,0.04))',
    WebkitTapHighlightColor: 'transparent',
  },
  quickIcon: {
    fontSize: 22,
    lineHeight: 1,
  },
  quickLabel: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--text-secondary, #7A756F)',
    letterSpacing: '0.02em',
  },

  // Categories
  categories: {
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  },
  category: {
    background: 'var(--bg-card, #fff)',
    borderRadius: 18,
    border: '1px solid var(--border, #EDE9E4)',
    padding: '14px 14px 10px',
    boxShadow: 'var(--shadow-xs, 0 1px 3px rgba(0,0,0,0.04))',
  },
  catHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    width: '100%',
    background: 'none',
    border: 'none',
    cursor: 'pointer',
    padding: '0 0 10px',
    fontFamily: "var(--font-body, 'DM Sans', sans-serif)",
    textAlign: 'left',
    WebkitTapHighlightColor: 'transparent',
  },
  catLabel: {
    fontSize: 15,
    fontWeight: 700,
    letterSpacing: '-0.01em',
  },
  catDesc: {
    fontSize: 12,
    color: 'var(--text-muted, #B5AFA8)',
    marginTop: 1,
  },
  catCount: {
    display: 'flex',
    alignItems: 'center',
    gap: 4,
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--text-muted, #B5AFA8)',
    fontFamily: "var(--font-body, 'DM Sans', sans-serif)",
  },
  catArrow: {
    fontSize: 14,
    transition: 'transform 0.2s ease',
    display: 'inline-block',
  },

  // Item grid
  itemGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 8,
  },
  item: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    padding: '12px 10px 10px',
    borderRadius: 14,
    border: 'none',
    background: 'var(--bg-subtle, #F9F7F4)',
    cursor: 'pointer',
    fontFamily: "var(--font-body, 'DM Sans', sans-serif)",
    textAlign: 'left',
    transition: 'background 0.12s, transform 0.1s',
    WebkitTapHighlightColor: 'transparent',
    minHeight: 80,
  },
  itemActive: {
    background: 'var(--accent-light, #FFF0F3)',
    boxShadow: 'inset 0 0 0 1.5px var(--accent, #C76B8A)',
  },
  itemLocked: {
    opacity: 0.55,
    cursor: 'default',
  },
  itemTop: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    width: '100%',
    marginBottom: 6,
  },
  itemIcon: {
    fontSize: 20,
    lineHeight: 1,
  },
  lockBadge: {
    fontSize: 8,
    fontWeight: 700,
    background: 'linear-gradient(135deg, #C9A96E, #B8953E)',
    color: '#fff',
    padding: '2px 5px',
    borderRadius: 6,
    letterSpacing: '0.05em',
  },
  itemLabel: {
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--text-primary, #2D2A26)',
    lineHeight: 1.2,
  },
  itemDesc: {
    fontSize: 10,
    color: 'var(--text-muted, #B5AFA8)',
    lineHeight: 1.3,
    marginTop: 2,
  },

  // Show more
  showMore: {
    width: '100%',
    padding: '8px 0 4px',
    background: 'none',
    border: 'none',
    fontSize: 12,
    fontWeight: 600,
    color: 'var(--accent, #C76B8A)',
    cursor: 'pointer',
    fontFamily: "var(--font-body, 'DM Sans', sans-serif)",
    WebkitTapHighlightColor: 'transparent',
  },

  // Empty search
  emptySearch: {
    textAlign: 'center',
    padding: '40px 0',
  },
};
