import { useState, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useBeautician } from '../lib/supabase.js';
import { hasFeature, getRequiredPlan } from '../lib/subscription.js';

/**
 * Hub — Stitch reference rebuild.
 *
 * Matches the Stitch screen:
 *   - Search bar with Material icon
 *   - Quick access 4-up row
 *   - Category sections with 2-col grids of emoji + label + desc cards
 *   - Expand/collapse per category
 *   - Gated features show plan badge
 */

// ─── Navigation categories ────────────────────────────────
const CATEGORIES = [
  {
    id: 'daily',
    label: 'Your Day',
    description: 'Daily ops and schedule',
    items: [
      { path: '/calendar', label: 'Calendar', desc: 'View and manage appointments', icon: '📅' },
      { path: '/smart-schedule', label: 'Smart Schedule', desc: 'AI-optimised time slots', icon: '🧠' },
      { path: '/checklist', label: 'Daily Checklist', desc: 'Opening and closing tasks', icon: '☑️' },
      { path: '/end-of-day', label: 'End of Day', desc: 'Cash-up and close', icon: '🌙' },
      { path: '/notifications', label: 'Notifications', desc: 'Alerts and reminders', icon: '🔔' },
    ]
  },
  {
    id: 'clients',
    label: 'Clients',
    description: 'Relationships and records',
    items: [
      { path: '/clients', label: 'All Clients', desc: 'Client list and profiles', icon: '👤' },
      { path: '/import', label: 'Import Clients', desc: 'CSV and bulk import', icon: '📥' },
      { path: '/client-timeline', label: 'Client Timeline', desc: 'Full history per client', icon: '📜' },
      { path: '/tags', label: 'Tags & Groups', desc: 'Organise and segment', icon: '🏷️' },
      { path: '/waitlist', label: 'Waitlist', desc: 'Manage waiting clients', icon: '📋' },
      { path: '/segments', label: 'Client Segments', desc: 'Smart grouping', icon: '🎯' },
      { path: '/churn', label: 'Churn Prevention', desc: 'At-risk clients', icon: '🛡️' },
      { path: '/comms', label: 'Comms Log', desc: 'Message history', icon: '📨' },
      { path: '/memberships', label: 'Client Memberships', desc: 'Recurring packages', icon: '💎' },
      { path: '/waitlist-pro', label: 'Waitlist Pro', desc: 'Advanced waitlist', icon: '📋' },
      { path: '/photo-consent', label: 'Photo Consent', desc: 'Before/after consent', icon: '📷' },
    ]
  },
  {
    id: 'treatments',
    label: 'Treatments & Services',
    description: 'What you offer',
    items: [
      { path: '/treatments', label: 'Treatments', desc: 'Manage your services', icon: '💅' },
      { path: '/consultations', label: 'Consultations', desc: 'Pre-treatment bookings', icon: '🩺' },
      { path: '/consultation-forms', label: 'Form Builder', desc: 'Build consultation & consent forms', icon: '📋' },
      { path: '/patch-tests', label: 'Patch Tests', desc: 'Allergy test tracking', icon: '🩹' },
      { path: '/aftercare', label: 'Aftercare', desc: 'Post-treatment messages', icon: '💆' },
      { path: '/packages', label: 'Packages', desc: 'Bundle deals and courses', icon: '📦' },
      { path: '/addons', label: 'Add-ons', desc: 'Bolt-on extras', icon: '✨' },
      { path: '/price-list', label: 'Price List', desc: 'Public pricing page', icon: '💲' },
      { path: '/notes', label: 'Appointment Notes', desc: 'Notes per appointment', icon: '📝' },
    ]
  },
  {
    id: 'money',
    label: 'Money',
    description: 'Revenue and expenses',
    items: [
      { path: '/money', label: 'Money Tracker', desc: 'Revenue dashboard', icon: '💰' },
      { path: '/expenses', label: 'Expenses', desc: 'Track outgoings', icon: '💳' },
      { path: '/deposits', label: 'Deposits', desc: 'Held payments', icon: '🔒' },
      { path: '/cancellations', label: 'Cancellations', desc: 'No-shows and late cancels', icon: '❌' },
      { path: '/goals', label: 'Revenue Goals', desc: 'Targets and progress', icon: '🎯' },
      { path: '/vouchers', label: 'Gift Vouchers', desc: 'Create and track', icon: '🎁' },
      { path: '/analytics', label: 'Analytics', desc: 'Performance metrics', icon: '📈' },
      { path: '/reports', label: 'Reports', desc: 'Business reports', icon: '📊' },
    ]
  },
  {
    id: 'marketing',
    label: 'Marketing & Growth',
    description: 'Attract and retain',
    items: [
      { path: '/content', label: 'Content Autopilot', desc: 'AI-written captions', icon: '📸' },
      { path: '/reviews', label: 'Reviews', desc: 'Collect and respond', icon: '⭐' },
      { path: '/referrals', label: 'Referrals', desc: 'Word-of-mouth tracking', icon: '🤝' },
      { path: '/loyalty', label: 'Loyalty', desc: 'Points and rewards', icon: '🏆' },
      { path: '/rebook', label: 'Rebook Reminders', desc: 'Bring clients back', icon: '🔄' },
      { path: '/campaigns', label: 'Campaigns', desc: 'Email and SMS blasts', icon: '💌' },
      { path: '/digest', label: 'Weekly Digest', desc: 'Weekly summary email', icon: '📧' },
      { path: '/promos', label: 'Promo Codes', desc: 'Discount codes', icon: '🏷️' },
      { path: '/portfolio', label: 'Portfolio', desc: 'Showcase your work', icon: '🖼️' },
    ]
  },
  {
    id: 'comms',
    label: 'Communications',
    description: 'Messages and channels',
    items: [
      { path: '/inbox', label: 'Inbox', desc: 'All messages in one place', icon: '💬' },
      { path: '/whatsapp', label: 'WhatsApp', desc: 'Business messaging', icon: '📱' },
      { path: '/templates', label: 'Message Templates', desc: 'Reusable messages', icon: '💬' },
      { path: '/automations', label: 'Automations', desc: 'If-this-then-that rules', icon: '⚡' },
    ]
  },
  {
    id: 'ai',
    label: 'AI & Intelligence',
    description: 'florrie.ai\'s brain',
    items: [
      { path: '/voice', label: 'florrie.ai', desc: 'Your AI assistant', icon: '✨' },
      { path: '/ai-insights', label: 'AI Insights', desc: 'Predictions and trends', icon: '🧠' },
      { path: '/segments', label: 'Client Segments', desc: 'Smart grouping', icon: '🎯' },
      { path: '/churn', label: 'Churn Prevention', desc: 'At-risk clients', icon: '🛡️' },
      { path: '/demand', label: 'Demand Forecast', desc: 'Capacity planning', icon: '📊' },
      { path: '/escalations', label: 'Escalations', desc: 'AI-flagged messages', icon: '🚨' },
      { path: '/sequences', label: 'Follow-up Sequences', desc: 'Automated follow-ups', icon: '🔁' },
    ]
  },
  {
    id: 'team',
    label: 'Team',
    description: 'Staff management',
    items: [
      { path: '/team', label: 'Team Members', desc: 'Staff profiles', icon: '👥', gate: 'team_management' },
      { path: '/rota', label: 'Staff Rota', desc: 'Weekly schedule', icon: '🗓️', gate: 'staff_rota' },
      { path: '/hours', label: 'Hours & Closures', desc: 'Working hours and holidays', icon: '🏖️', gate: 'team_management' },
      { path: '/staff-performance', label: 'Staff Performance', desc: 'Team analytics', icon: '📈', gate: 'staff_performance' },
    ]
  },
  {
    id: 'business',
    label: 'Business Operations',
    description: 'Inventory and analytics',
    items: [
      { path: '/inventory', label: 'Product Inventory', desc: 'Stock management', icon: '📦' },
      { path: '/treatment-stats', label: 'Treatment Stats', desc: 'Service analytics', icon: '📊' },
    ]
  },
  {
    id: 'settings',
    label: 'Settings',
    description: 'Configure your account',
    items: [
      { path: '/settings', label: 'Settings', desc: 'Account preferences', icon: '⚙️' },
      { path: '/pricing', label: 'Plans & Billing', desc: 'Subscription and payments', icon: '💳' },
      { path: '/business', label: 'Business Profile', desc: 'Name, logo, details', icon: '🏪' },
      { path: '/integrations', label: 'Integrations', desc: 'Connected apps', icon: '🔌' },
      { path: '/api-settings', label: 'API & Webhooks', desc: 'Developer tools', icon: '⚡' },
      { path: '/policies', label: 'Policies', desc: 'Cancellation and terms', icon: '📜' },
      { path: '/portal', label: 'Client Portal', desc: 'Self-service settings', icon: '🌐' },
      { path: '/locations', label: 'Multi-Location', desc: 'Branch management', icon: '🏢', gate: 'multi_location' },
      { path: '/sms', label: 'SMS Config', desc: 'SMS settings', icon: '📲' },
    ]
  },
];

function MIcon({ name, fill, size, style }) {
  return (
    <span className="material-symbols-outlined" style={{
      fontSize: size || 24,
      fontVariationSettings: fill ? "'FILL' 1, 'wght' 300" : undefined,
      ...style,
    }}>{name}</span>
  );
}

export default function Hub() {
  const [search, setSearch] = useState('');
  const [expandedCat, setExpandedCat] = useState(null);
  const navigate = useNavigate();
  const location = useLocation();
  const { beautician } = useBeautician();
  const plan = beautician?.subscription_plan || 'free';

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
      {/* ─── Header ─── */}
      <h1 style={S.title}>Hub</h1>
      <p style={S.subtitle}>Everything in one place</p>

      {/* ─── Search ─── */}
      <div style={S.searchWrap}>
        <MIcon name="search" size={18} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: '#6b5a5f', pointerEvents: 'none' }} />
        <input
          type="text"
          placeholder="Search features..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={S.searchInput}
        />
        {search && (
          <button onClick={() => setSearch('')} style={S.searchClear}>
            <MIcon name="close" size={14} />
          </button>
        )}
      </div>

      {/* ─── Quick Access ─── */}
      {!search && (
        <div style={S.quickRow}>
          {[
            { path: '/money', icon: '💰', label: 'Money' },
            { path: '/clients', icon: '👤', label: 'Clients' },
            { path: '/treatments', icon: '💅', label: 'Treats' },
            { path: '/expenses', icon: '💳', label: 'Expenses' },
          ].map(q => (
            <button key={q.path} onClick={() => handleNav(q.path)} style={S.quickBtn}>
              <span style={S.quickIcon}>{q.icon}</span>
              <span style={S.quickLabel}>{q.label}</span>
            </button>
          ))}
        </div>
      )}

      {/* ─── Categories ─── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
        {filtered.map(cat => {
          const isExpanded = expandedCat === cat.id || search.trim().length > 0;
          const visibleItems = isExpanded ? cat.items : cat.items.slice(0, 4);
          const hasMore = cat.items.length > 4;

          return (
            <div key={cat.id} style={S.catCard}>
              {/* Category header */}
              <button
                onClick={() => setExpandedCat(expandedCat === cat.id ? null : cat.id)}
                style={S.catHeader}
              >
                <div>
                  <div style={S.catLabel}>{cat.label}</div>
                  <div style={S.catDesc}>{cat.description}</div>
                </div>
                <div style={S.catRight}>
                  <span style={S.catCount}>{cat.items.length}</span>
                  <MIcon
                    name="expand_more"
                    size={18}
                    style={{
                      color: '#6b5a5f',
                      transition: 'transform 0.2s ease',
                      transform: isExpanded ? 'rotate(180deg)' : 'rotate(0)',
                    }}
                  />
                </div>
              </button>

              {/* Items — 2-col grid */}
              <div style={S.itemGrid}>
                {visibleItems.map(item => {
                  const locked = item.gate && !hasFeature(plan, item.gate);
                  const isActive = !locked && location.pathname === item.path;
                  return (
                    <button
                      key={item.path}
                      onClick={() => !locked && handleNav(item.path)}
                      style={{
                        ...S.item,
                        ...(isActive ? S.itemActive : {}),
                        ...(locked ? { opacity: 0.5, cursor: 'default' } : {}),
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', width: '100%', marginBottom: 4 }}>
                        <span style={{ fontSize: 22, lineHeight: 1 }}>{item.icon}</span>
                        {locked && (
                          <span style={S.lockBadge}>
                            {(getRequiredPlan(item.gate) || 'PRO').toUpperCase()}
                          </span>
                        )}
                      </div>
                      <span style={S.itemLabel}>{item.label}</span>
                      <span style={S.itemDesc}>{item.desc}</span>
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
        <div style={{ textAlign: 'center', padding: '48px 0' }}>
          <MIcon name="search_off" size={40} style={{ color: '#d8c1c6' }} />
          <p style={{ margin: '12px 0 0', color: '#6b5a5f', fontSize: 14 }}>No features match "{search}"</p>
        </div>
      )}
    </div>
  );
}

// ─── Styles — Stitch "Hub" reference ───
const S = {
  page: {
    minHeight: '100vh',
    background: '#fef8f4',
    fontFamily: "var(--font-body, 'Plus Jakarta Sans', sans-serif)",
    padding: '16px 24px 120px',
    maxWidth: 480,
    margin: '0 auto',
    color: '#1d1b19',
    animation: 'fadeIn 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
  },
  title: {
    fontFamily: "var(--font-display, 'Playfair Display', serif)",
    fontSize: 28, fontStyle: 'italic', fontWeight: 700,
    letterSpacing: '-0.02em', color: '#92405e', margin: 0,
  },
  subtitle: {
    fontSize: 13, color: '#6b5a5f', marginTop: 4, marginBottom: 20,
  },

  // Search
  searchWrap: {
    position: 'relative', marginBottom: 20,
  },
  searchInput: {
    width: '100%',
    padding: '12px 40px 12px 42px',
    borderRadius: 14,
    border: '1px solid #d8c1c6',
    background: '#fff',
    fontSize: 14,
    fontFamily: "var(--font-body, 'Plus Jakarta Sans', sans-serif)",
    color: '#1d1b19',
    outline: 'none',
    boxSizing: 'border-box',
    transition: 'border-color 0.2s ease, box-shadow 0.2s ease',
  },
  searchClear: {
    position: 'absolute', right: 12, top: '50%',
    transform: 'translateY(-50%)',
    background: '#f3ede9', border: 'none', borderRadius: 10,
    width: 24, height: 24,
    color: '#6b5a5f', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },

  // Quick access
  quickRow: {
    display: 'flex', gap: 10, marginBottom: 24,
  },
  quickBtn: {
    flex: 1,
    display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
    padding: '14px 8px', borderRadius: 16,
    border: '1px solid rgba(146, 64, 94, 0.05)',
    background: '#fff', cursor: 'pointer',
    fontFamily: 'inherit',
    boxShadow: '0 1px 3px rgba(146, 64, 94, 0.04)',
    transition: 'transform 0.1s, box-shadow 0.15s',
    WebkitTapHighlightColor: 'transparent',
  },
  quickIcon: { fontSize: 22, lineHeight: 1 },
  quickLabel: {
    fontSize: 11, fontWeight: 600, color: '#534247',
    letterSpacing: '0.02em',
  },

  // Category card
  catCard: {
    background: '#fff', borderRadius: 20,
    border: '1px solid rgba(146, 64, 94, 0.05)',
    padding: '16px 14px 12px',
    boxShadow: '0 1px 3px rgba(146, 64, 94, 0.04)',
  },
  catHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    width: '100%', background: 'none', border: 'none',
    cursor: 'pointer', padding: '0 0 12px',
    fontFamily: 'inherit', textAlign: 'left',
    WebkitTapHighlightColor: 'transparent',
  },
  catLabel: {
    fontSize: 15, fontWeight: 700, color: '#92405e',
    letterSpacing: '-0.01em',
  },
  catDesc: {
    fontSize: 11, color: '#6b5a5f', marginTop: 1,
  },
  catRight: {
    display: 'flex', alignItems: 'center', gap: 4,
  },
  catCount: {
    fontSize: 11, fontWeight: 600, color: '#6b5a5f',
    background: '#f3ede9', padding: '2px 7px', borderRadius: 8,
  },

  // Item grid — 2 columns
  itemGrid: {
    display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8,
  },
  item: {
    display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
    padding: '12px 12px 10px', borderRadius: 14,
    border: 'none', background: '#f8f2ef',
    cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
    transition: 'background 0.12s, transform 0.1s',
    WebkitTapHighlightColor: 'transparent',
    minHeight: 76,
  },
  itemActive: {
    background: '#ffd9e2',
    boxShadow: 'inset 0 0 0 1.5px #92405e',
  },
  itemLabel: {
    fontSize: 13, fontWeight: 600, color: '#1d1b19', lineHeight: 1.2,
  },
  itemDesc: {
    fontSize: 10, color: '#6b5a5f', lineHeight: 1.3, marginTop: 2,
  },
  lockBadge: {
    fontSize: 8, fontWeight: 700,
    background: 'linear-gradient(135deg, #745a27, #fedb9b)',
    color: '#fff', padding: '2px 6px', borderRadius: 6,
    letterSpacing: '0.05em',
  },

  // Show more
  showMore: {
    width: '100%', padding: '10px 0 4px',
    background: 'none', border: 'none',
    fontSize: 12, fontWeight: 600, color: '#92405e',
    cursor: 'pointer', fontFamily: 'inherit',
    WebkitTapHighlightColor: 'transparent',
  },
};
