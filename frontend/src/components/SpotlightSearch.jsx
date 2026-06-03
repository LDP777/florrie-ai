import { useState, useRef, useEffect, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';

const FEATURES = [
  // Your Day
  { path: '/calendar', name: 'Calendar', desc: 'View and manage appointments', icon: '📅', cat: 'Your Day' },
  { path: '/smart-schedule', name: "Florrie's Schedule", desc: 'AI-optimised time slots', icon: '🧠', cat: 'Your Day' },
  { path: '/checklist', name: 'Daily Checklist', desc: 'Opening and closing tasks', icon: '☑️', cat: 'Your Day' },
  { path: '/end-of-day', name: 'End of Day', desc: 'Cash-up and close', icon: '🌙', cat: 'Your Day' },
  { path: '/notifications', name: 'Notifications', desc: 'Alerts and reminders', icon: '🔔', cat: 'Your Day' },
  { path: '/digest', name: 'Weekly Digest', desc: 'Weekly summary email', icon: '📧', cat: 'Your Day' },

  // Clients
  { path: '/clients', name: 'All Clients', desc: 'Client list and profiles', icon: '👤', cat: 'Clients' },
  { path: '/import', name: 'Import Clients', desc: 'CSV and bulk import', icon: '📥', cat: 'Clients' },
  { path: '/client-timeline', name: 'Client Timeline', desc: 'Full history per client', icon: '📜', cat: 'Clients' },
  { path: '/tags', name: 'Tags & Groups', desc: 'Organise and segment', icon: '🏷️', cat: 'Clients' },
  { path: '/waitlist', name: 'Waitlist', desc: 'Manage waiting clients', icon: '📋', cat: 'Clients' },
  { path: '/segments', name: 'Client Segments', desc: 'Smart grouping', icon: '🎯', cat: 'Clients' },
  { path: '/churn', name: 'Client Retention', desc: 'At-risk clients', icon: '🛡️', cat: 'Clients' },
  { path: '/waitlist-pro', name: 'Waitlist Pro', desc: 'Advanced waitlist', icon: '📋', cat: 'Clients' },
  { path: '/photo-consent', name: 'Photo Consent', desc: 'Before/after consent', icon: '📷', cat: 'Clients' },

  // Treatments
  { path: '/treatments', name: 'Treatments', desc: 'Manage your services', icon: '💅', cat: 'Treatments' },
  { path: '/consultation-forms', name: 'Form Builder', desc: 'Build custom consultation and consent forms', icon: '📋', cat: 'Treatments' },
  { path: '/patch-tests', name: 'Patch Tests', desc: 'Allergy test tracking', icon: '🩹', cat: 'Treatments' },
  { path: '/aftercare', name: 'Aftercare', desc: 'Post-treatment messages', icon: '💆', cat: 'Treatments' },
  { path: '/packages', name: 'Courses', desc: 'Training & masterclasses', icon: '🎓', cat: 'Treatments' },
  { path: '/addons', name: 'Add-ons', desc: 'Bolt-on extras', icon: '✨', cat: 'Treatments' },
  { path: '/price-list', name: 'Price List', desc: 'Public pricing page', icon: '💲', cat: 'Treatments' },
  { path: '/notes', name: 'Appointment Notes', desc: 'Notes per appointment', icon: '📝', cat: 'Treatments' },

  // Money
  { path: '/money', name: 'Money Tracker', desc: 'Revenue dashboard', icon: '💰', cat: 'Money' },
  { path: '/expenses', name: 'Expenses', desc: 'Track outgoings', icon: '💳', cat: 'Money' },
  { path: '/deposits', name: 'Deposits', desc: 'Held payments', icon: '🔒', cat: 'Money' },
  { path: '/cancellations', name: 'Cancellations', desc: 'No-shows and late cancels', icon: '❌', cat: 'Money' },
  { path: '/goals', name: 'Revenue Goals', desc: 'Targets and progress', icon: '🎯', cat: 'Money' },
  { path: '/vouchers', name: 'Gift Vouchers', desc: 'Create and track', icon: '🎁', cat: 'Money' },
  { path: '/memberships', name: 'Client Memberships', desc: 'Recurring packages', icon: '💎', cat: 'Clients' },
  { path: '/reports', name: 'Reports', desc: 'Business reports', icon: '📊', cat: 'Money' },
  { path: '/analytics', name: 'Analytics', desc: 'Performance metrics', icon: '📈', cat: 'Money' },

  // Marketing
  { path: '/content', name: 'Florrie Content', desc: 'AI-written captions', icon: '📸', cat: 'Marketing' },
  { path: '/reviews', name: 'Reviews', desc: 'Collect and respond', icon: '⭐', cat: 'Marketing' },
  { path: '/referrals', name: 'Referrals', desc: 'Word-of-mouth tracking', icon: '🤝', cat: 'Marketing' },
  { path: '/loyalty', name: 'Loyalty', desc: 'Points and rewards', icon: '🏆', cat: 'Marketing' },
  { path: '/rebook', name: 'Rebook Reminders', desc: 'Bring clients back', icon: '🔄', cat: 'Marketing' },
  { path: '/campaigns', name: 'Campaigns', desc: 'Email and SMS blasts', icon: '💌', cat: 'Marketing' },
  { path: '/promos', name: 'Promo Codes', desc: 'Discount codes', icon: '🏷️', cat: 'Marketing' },
  { path: '/portfolio', name: 'Portfolio', desc: 'Showcase your work', icon: '🖼️', cat: 'Marketing' },

  // Communications
  { path: '/inbox', name: 'Inbox', desc: 'All messages in one place', icon: '💬', cat: 'Comms' },
  { path: '/escalations', name: 'Florrie Needs You', desc: 'Messages Florrie flagged', icon: '🚨', cat: 'AI' },
  { path: '/approval-queue', name: "Florrie's Queue", desc: 'Actions awaiting your sign-off', icon: '✅', cat: 'AI' },
  { path: '/whatsapp', name: 'WhatsApp', desc: 'Business messaging', icon: '📱', cat: 'Comms' },
  { path: '/templates', name: 'Message Templates', desc: 'Reusable messages', icon: '💬', cat: 'Comms' },
  { path: '/automations', name: 'Automations', desc: 'If-this-then-that rules', icon: '⚡', cat: 'Comms' },
  { path: '/comms', name: 'Comms Log', desc: 'Message history', icon: '📨', cat: 'Comms' },

  // AI
  { path: '/voice', name: 'florrie.ai', desc: 'Your AI assistant', icon: '✨', cat: 'AI' },
  { path: '/ai-insights', name: "Florrie's Insights", desc: 'Predictions and trends', icon: '🧠', cat: 'AI' },
  { path: '/demand', name: 'Demand Forecast', desc: 'Capacity planning', icon: '📊', cat: 'AI' },
  { path: '/sequences', name: 'Follow-up Sequences', desc: 'Automated follow-ups', icon: '🔁', cat: 'AI' },

  // Team
  { path: '/team', name: 'Team Members', desc: 'Staff profiles', icon: '👥', cat: 'Team' },
  { path: '/rota', name: 'Staff Rota', desc: 'Weekly schedule', icon: '🗓️', cat: 'Team' },
  { path: '/hours', name: 'Hours & Closures', desc: 'Working hours and holidays', icon: '🏖️', cat: 'Team' },
  { path: '/staff-performance', name: 'Staff Performance', desc: 'Team analytics', icon: '📈', cat: 'Team' },

  // Settings
  { path: '/settings', name: 'Settings', desc: 'Account preferences', icon: '⚙️', cat: 'Settings' },
  { path: '/business', name: 'Business Profile', desc: 'Name, logo, details', icon: '🏪', cat: 'Settings' },
  { path: '/integrations', name: 'Integrations', desc: 'Connected apps', icon: '🔌', cat: 'Settings' },
  { path: '/api-settings', name: 'API & Webhooks', desc: 'Developer tools', icon: '⚡', cat: 'Settings' },
  { path: '/policies', name: 'Policies', desc: 'Cancellation and terms', icon: '📜', cat: 'Settings' },
  { path: '/portal', name: 'Client Portal', desc: 'Self-service settings', icon: '🌐', cat: 'Settings' },
  { path: '/locations', name: 'Multi-Location', desc: 'Branch management', icon: '🏢', cat: 'Settings' },
  { path: '/sms', name: 'SMS Config', desc: 'SMS settings', icon: '📲', cat: 'Settings' },
  { path: '/inventory', name: 'Product Inventory', desc: 'Stock management', icon: '📦', cat: 'Business' },

  { path: '/treatment-stats', name: 'Treatment Stats', desc: 'Service analytics', icon: '📊', cat: 'Business' },
];

function search(query) {
  if (!query.trim()) return [];
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);

  const scored = FEATURES
    .map(f => {
      const name = f.name.toLowerCase();
      const desc = f.desc.toLowerCase();
      const cat = f.cat.toLowerCase();
      const all = `${name} ${desc} ${cat}`;

      // Every word must match somewhere
      const allMatch = words.every(w => all.includes(w));
      if (!allMatch) return null;

      // Score: exact name start > name contains > desc/cat
      let score = 0;
      for (const w of words) {
        if (name.startsWith(w)) score += 10;
        else if (name.includes(w)) score += 5;
        else if (desc.includes(w)) score += 2;
        else score += 1;
      }
      return { ...f, score };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score);

  return scored;
}

function groupByCategory(results) {
  const groups = [];
  const seen = new Set();
  for (const r of results) {
    if (!seen.has(r.cat)) {
      seen.add(r.cat);
      groups.push({ cat: r.cat, items: [] });
    }
    groups.find(g => g.cat === r.cat).items.push(r);
  }
  return groups;
}

/**
 * SpotlightSearch — inline search bar for the Dashboard.
 *
 * Renders a tappable search bar. When focused, expands into
 * a full-screen overlay with live results. Tap a result to navigate.
 */
export default function SpotlightSearch() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef(null);
  const navigate = useNavigate();

  const results = useMemo(() => search(query), [query]);
  const grouped = useMemo(() => groupByCategory(results), [results]);

  // Focus input when overlay opens
  useEffect(() => {
    if (open && inputRef.current) {
      // Small delay so the animation starts first
      const t = setTimeout(() => inputRef.current.focus(), 80);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Lock body scroll when open
  useEffect(() => {
    if (open) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    return () => { document.body.style.overflow = ''; };
  }, [open]);

  function handleSelect(path) {
    setOpen(false);
    setQuery('');
    navigate(path);
  }

  function handleClose() {
    setOpen(false);
    setQuery('');
  }

  if (!open) {
    return (
      <button onClick={() => setOpen(true)} style={S.trigger}>
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted, #B5AFA8)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="11" cy="11" r="8" />
          <line x1="21" y1="21" x2="16.65" y2="16.65" />
        </svg>
        <span style={S.triggerText}>Search features...</span>
      </button>
    );
  }

  return (
    <div style={S.overlay} onClick={handleClose}>
      <div style={S.modal} onClick={e => e.stopPropagation()}>

        {/* Search input row */}
        <div style={S.inputRow}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted, #B5AFA8)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
            <circle cx="11" cy="11" r="8" />
            <line x1="21" y1="21" x2="16.65" y2="16.65" />
          </svg>
          <input
            ref={inputRef}
            type="text"
            placeholder="Search 60+ features..."
            value={query}
            onChange={e => setQuery(e.target.value)}
            style={S.input}
          />
          <button onClick={handleClose} style={S.closeBtn}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>

        {/* Results */}
        <div style={S.results}>
          {!query.trim() && (
            <div style={S.hint}>
              <span style={S.hintIcon}>✨</span>
              <span style={S.hintText}>Type to find any feature — calendar, expenses, rebook, anything.</span>
            </div>
          )}

          {query.trim() && results.length === 0 && (
            <div style={S.empty}>
              <span style={{ fontSize: 28, display: 'block', marginBottom: 8 }}>🔍</span>
              <span style={S.emptyText}>Nothing matches "{query}"</span>
              <span style={S.emptyHint}>Try a different word — e.g. "clients", "money", "reviews"</span>
            </div>
          )}

          {grouped.map(group => (
            <div key={group.cat} style={S.group}>
              <div style={S.groupLabel}>{group.cat}</div>
              {group.items.map(item => (
                <button
                  key={item.path}
                  onClick={() => handleSelect(item.path)}
                  style={S.resultRow}
                  onTouchStart={e => e.currentTarget.style.background = 'var(--bg-hover, #F5F2EF)'}
                  onTouchEnd={e => e.currentTarget.style.background = 'none'}
                  onMouseDown={e => e.currentTarget.style.background = 'var(--bg-hover, #F5F2EF)'}
                  onMouseUp={e => e.currentTarget.style.background = 'none'}
                >
                  <span style={S.resultIcon}>{item.icon}</span>
                  <div style={S.resultInfo}>
                    <span style={S.resultName}>{item.name}</span>
                    <span style={S.resultDesc}>{item.desc}</span>
                  </div>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted, #B5AFA8)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
                    <polyline points="9 18 15 12 9 6" />
                  </svg>
                </button>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

const S = {
  // Inline trigger bar (sits on Dashboard)
  trigger: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    width: '100%',
    padding: '13px 16px',
    borderRadius: 14,
    border: '1px solid var(--border, #EDE9E4)',
    background: 'var(--bg-card, #fff)',
    cursor: 'pointer',
    fontFamily: "var(--font-body, 'DM Sans', sans-serif)",
    boxShadow: 'var(--shadow-xs, 0 1px 2px rgba(0,0,0,0.04))',
    WebkitTapHighlightColor: 'transparent',
    transition: 'border-color 0.15s, box-shadow 0.15s',
  },
  triggerText: {
    fontSize: 14,
    color: 'var(--text-muted, #B5AFA8)',
    fontWeight: 400,
  },

  // Overlay
  overlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 200,
    background: 'rgba(45, 42, 38, 0.4)',
    display: 'flex',
    flexDirection: 'column',
    animation: 'fadeIn 0.15s ease',
  },

  // Modal
  modal: {
    display: 'flex',
    flexDirection: 'column',
    width: '100%',
    maxWidth: 480,
    margin: '0 auto',
    height: '100%',
    background: 'var(--bg, #FAF8F5)',
    animation: 'slideUp 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
  },

  // Input row
  inputRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '16px 16px 12px',
    borderBottom: '1px solid var(--border, #EDE9E4)',
    background: 'var(--bg-card, #fff)',
  },
  input: {
    flex: 1,
    border: 'none',
    outline: 'none',
    fontSize: 17,
    fontFamily: "var(--font-body, 'DM Sans', sans-serif)",
    color: 'var(--text-primary, #2D2A26)',
    background: 'transparent',
    padding: 0,
  },
  closeBtn: {
    width: 32,
    height: 32,
    borderRadius: 10,
    border: 'none',
    background: 'var(--bg-hover, #F5F2EF)',
    color: 'var(--text-muted, #B5AFA8)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
    WebkitTapHighlightColor: 'transparent',
  },

  // Results area
  results: {
    flex: 1,
    overflowY: 'auto',
    padding: '8px 0',
    WebkitOverflowScrolling: 'touch',
  },

  // Hint (empty query)
  hint: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 10,
    padding: '20px 16px',
  },
  hintIcon: {
    fontSize: 18,
    flexShrink: 0,
    lineHeight: 1,
  },
  hintText: {
    fontSize: 14,
    color: 'var(--text-secondary, #7A756F)',
    lineHeight: 1.5,
  },

  // Empty (no results)
  empty: {
    textAlign: 'center',
    padding: '48px 24px',
  },
  emptyText: {
    display: 'block',
    fontSize: 15,
    color: 'var(--text-secondary, #7A756F)',
    fontWeight: 500,
  },
  emptyHint: {
    display: 'block',
    fontSize: 13,
    color: 'var(--text-muted, #B5AFA8)',
    marginTop: 6,
  },

  // Category group
  group: {
    padding: '4px 0',
  },
  groupLabel: {
    fontSize: 11,
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
    color: 'var(--text-muted, #B5AFA8)',
    padding: '10px 16px 6px',
    fontFamily: "var(--font-body, 'DM Sans', sans-serif)",
  },

  // Result row
  resultRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    width: '100%',
    padding: '12px 16px',
    border: 'none',
    background: 'none',
    cursor: 'pointer',
    fontFamily: "var(--font-body, 'DM Sans', sans-serif)",
    textAlign: 'left',
    WebkitTapHighlightColor: 'transparent',
    transition: 'background 0.12s',
  },
  resultIcon: {
    fontSize: 20,
    lineHeight: 1,
    flexShrink: 0,
    width: 28,
    textAlign: 'center',
  },
  resultInfo: {
    flex: 1,
    display: 'flex',
    flexDirection: 'column',
    gap: 1,
    minWidth: 0,
  },
  resultName: {
    fontSize: 14,
    fontWeight: 600,
    color: 'var(--text-primary, #2D2A26)',
    lineHeight: 1.3,
  },
  resultDesc: {
    fontSize: 12,
    color: 'var(--text-muted, #B5AFA8)',
    lineHeight: 1.3,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
};
