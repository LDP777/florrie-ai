import { useState, useMemo, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useBeautician } from '../lib/supabase.js';
import { hasFeature, getRequiredPlan } from '../lib/subscription.js';
import { API_BASE } from '../lib/config.js';

// ─── Agent definitions ────────────────────────────────────
const AGENTS = [
  { id: 'front_desk', name: 'Front Desk', avatar: '💬', colour: '#C76B8A' },
  { id: 'calendar',   name: 'Calendar',   avatar: '📅', colour: '#7B68EE' },
  { id: 'comeback',   name: 'Comeback',   avatar: '🔄', colour: '#F59E0B' },
  { id: 'content',    name: 'Content',    avatar: '📸', colour: '#10B981' },
  { id: 'money',      name: 'Money',      avatar: '💰', colour: '#3B82F6' },
  { id: 'scout',      name: 'Scout',      avatar: '🔍', colour: '#8B5CF6' },
];

function getToken() {
  const key = Object.keys(localStorage).find(k => /^sb-.+-auth-token$/.test(k));
  if (!key) return null;
  try {
    const raw = localStorage.getItem(key);
    const parsed = JSON.parse(raw);
    return parsed?.access_token || parsed?.session?.access_token || raw;
  } catch { return null; }
}

// ─── Agent strip — compact horizontal bar with cycling ticker ────
function AgentStrip() {
  const [agentData, setAgentData] = useState({});
  const [tickerIdx, setTickerIdx] = useState(0);
  const [tickerVisible, setTickerVisible] = useState(true);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const popRef = useRef(null);

  useEffect(() => {
    fetchAgents();
    const refresh = setInterval(fetchAgents, 60_000);
    return () => clearInterval(refresh);
  }, []);

  // Close popover on outside tap
  useEffect(() => {
    function handleClick(e) {
      if (popRef.current && !popRef.current.contains(e.target)) setSelected(null);
    }
    if (selected !== null) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [selected]);

  // Cycle ticker through agents that have recent actions
  const activeAgents = AGENTS.filter(a => agentData[a.id]?.latest);
  useEffect(() => {
    if (activeAgents.length < 2) return;
    const cycle = setInterval(() => {
      setTickerVisible(false);
      setTimeout(() => {
        setTickerIdx(i => (i + 1) % activeAgents.length);
        setTickerVisible(true);
      }, 350);
    }, 4000);
    return () => clearInterval(cycle);
  }, [activeAgents.length]);

  async function fetchAgents() {
    try {
      const token = getToken();
      const res = await fetch(`${API_BASE}/api/agents/status`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) throw new Error();
      const data = await res.json();
      // Map response into agentData by id
      const mapped = {};
      if (data.agents) {
        data.agents.forEach(a => { mapped[a.id] = a; });
      }
      // Fallback: if API returns countByEmployee shape
      if (data.countByEmployee) {
        Object.entries(data.countByEmployee).forEach(([id, val]) => {
          if (!mapped[id]) mapped[id] = {};
          mapped[id].actionsToday = val?.today || 0;
        });
      }
      if (data.latestByEmployee) {
        Object.entries(data.latestByEmployee).forEach(([id, val]) => {
          if (!mapped[id]) mapped[id] = {};
          mapped[id].latest = val?.summary || val?.action_type || null;
          mapped[id].isActive = true;
        });
      }
      setAgentData(mapped);
    } catch {
      // silent — not critical
    }
    setLoading(false);
  }

  const tickerAgent = activeAgents[tickerIdx % Math.max(1, activeAgents.length)];

  return (
    <div style={SS.strip}>
      {/* Header row */}
      <div style={SS.stripHeader}>
        <span style={SS.stripTitle}>✦ Your AI Team</span>
        <span style={SS.stripMeta}>
          {loading ? '…' : `${activeAgents.length}/${AGENTS.length} active`}
        </span>
      </div>

      {/* Agent avatars — horizontal scroll */}
      <div style={SS.avatarRow}>
        {AGENTS.map((agent, i) => {
          const d = agentData[agent.id] || {};
          const isActive = !loading && (d.isActive || (d.actionsToday || 0) > 0);
          const count = d.actionsToday || 0;

          return (
            <button
              key={agent.id}
              style={SS.agentBtn}
              onClick={() => setSelected(selected === i ? null : i)}
            >
              {/* Pulse ring */}
              {isActive && (
                <span style={{ ...SS.pulse, borderColor: agent.colour }} />
              )}
              {/* Avatar */}
              <span style={{
                ...SS.avatar,
                background: isActive ? `${agent.colour}18` : '#F5F2EF',
                borderColor: isActive ? agent.colour : 'transparent',
              }}>
                {agent.avatar}
              </span>
              {/* Count badge */}
              {count > 0 && (
                <span style={{ ...SS.badge, background: agent.colour }}>{count}</span>
              )}
              {/* Name */}
              <span style={{
                ...SS.agentName,
                color: isActive ? '#2D2A26' : '#B5AFA8',
              }}>
                {agent.name}
              </span>
            </button>
          );
        })}
      </div>

      {/* Cycling action ticker */}
      {tickerAgent && (
        <div style={SS.ticker}>
          <span
            style={{
              ...SS.tickerText,
              opacity: tickerVisible ? 1 : 0,
              transition: 'opacity 0.35s ease',
            }}
          >
            {tickerAgent.avatar}{' '}
            <span style={{ fontWeight: 600, color: AGENTS.find(a => a.id === tickerAgent.id)?.colour || 'var(--accent)' }}>
              {tickerAgent.name}
            </span>
            {' → '}
            {agentData[tickerAgent.id]?.latest || 'Working…'}
          </span>
        </div>
      )}

      {/* Popover */}
      {selected !== null && (
        <div ref={popRef} style={SS.popover}>
          <div style={SS.popRow}>
            <span style={{ fontSize: 28 }}>{AGENTS[selected].avatar}</span>
            <div>
              <div style={SS.popName}>{AGENTS[selected].name}</div>
              <div style={SS.popStatus}>
                {agentData[AGENTS[selected].id]?.latest || 'No recent activity'}
              </div>
            </div>
          </div>
          <div style={SS.popStats}>
            <div style={SS.popStat}>
              <span style={SS.popNum}>{agentData[AGENTS[selected].id]?.actionsToday || 0}</span>
              <span style={SS.popLabel}>today</span>
            </div>
            <div style={SS.popDivider} />
            <div style={SS.popStat}>
              <span style={SS.popNum}>{agentData[AGENTS[selected].id]?.actionsThisWeek || 0}</span>
              <span style={SS.popLabel}>this week</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Navigation categories (6, from 10) ──────────────────
const CATEGORIES = [
  {
    id: 'daily',
    label: 'Your Day',
    icon: '☀️',
    items: [
      { path: '/calendar',      label: 'Calendar',        desc: 'Appointments & schedule', icon: '📅' },
      { path: '/smart-schedule',label: "Florrie's Schedule", desc: 'AI-optimised slots',   icon: '🧠' },
      { path: '/checklist',     label: 'Daily Checklist', desc: 'Opening & closing tasks',  icon: '☑️' },
      { path: '/end-of-day',    label: 'End of Day',      desc: 'Cash-up and close',        icon: '🌙' },
      { path: '/notifications', label: 'Notifications',   desc: 'Alerts & reminders',       icon: '🔔' },
      { path: '/hours',         label: 'Hours & Closures',desc: 'Time off & exceptions',    icon: '🏖️' },
    ],
  },
  {
    id: 'clients',
    label: 'Clients',
    icon: '👥',
    items: [
      { path: '/clients',        label: 'All Clients',      desc: 'Client list & profiles',    icon: '👤' },
      { path: '/client-timeline',label: 'Client Timeline',  desc: 'Full history per client',   icon: '📜' },
      { path: '/comms',          label: 'Comms Log',        desc: 'Message history',            icon: '📨' },
      { path: '/tags',           label: 'Tags & Groups',    desc: 'Organise & segment',         icon: '🏷️' },
      { path: '/waitlist-pro',   label: 'Waitlist',         desc: 'Manage waiting clients',     icon: '📋' },
      { path: '/segments',       label: 'Client Segments',  desc: 'Smart RFM grouping',         icon: '🎯' },
      { path: '/churn',          label: 'Client Retention', desc: 'At-risk clients',            icon: '🛡️' },
      { path: '/memberships',    label: 'Memberships',      desc: 'Recurring packages',         icon: '💎' },
      { path: '/photo-consent',  label: 'Photo Consent',    desc: 'Before/after consent',       icon: '📷' },
      { path: '/import',         label: 'Import Clients',   desc: 'CSV & bulk import',          icon: '📥' },
    ],
  },
  {
    id: 'treatments',
    label: 'Treatments',
    icon: '💅',
    items: [
      { path: '/treatments',          label: 'Treatments',     desc: 'Manage your services',           icon: '💅' },
      { path: '/consultations',       label: 'Consultations',  desc: 'Pre-treatment bookings',         icon: '🩺' },
      { path: '/consultation-forms',  label: 'Form Builder',   desc: 'Consultation & consent forms',   icon: '📋' },
      { path: '/patch-tests',         label: 'Patch Tests',    desc: 'Allergy test tracking',          icon: '🩹' },
      { path: '/aftercare',           label: 'Aftercare',      desc: 'Post-treatment messages',        icon: '💆' },
      { path: '/packages',            label: 'Packages',       desc: 'Bundle deals & courses',         icon: '📦' },
      { path: '/addons',              label: 'Add-ons',        desc: 'Bolt-on extras',                 icon: '✨' },
      { path: '/price-list',          label: 'Price List',     desc: 'Public pricing page',            icon: '💲' },
      { path: '/notes',               label: 'Appt Notes',     desc: 'Notes per appointment',          icon: '📝' },
    ],
  },
  {
    id: 'money',
    label: 'Money',
    icon: '💰',
    items: [
      { path: '/money',        label: 'Money Tracker',   desc: 'Revenue dashboard',         icon: '💰' },
      { path: '/analytics',    label: 'Analytics',       desc: 'Performance & reports',      icon: '📈' },
      { path: '/expenses',     label: 'Expenses',        desc: 'Track outgoings',            icon: '💳' },
      { path: '/deposits',     label: 'Deposits',        desc: 'Held payments',              icon: '🔒' },
      { path: '/goals',        label: 'Revenue Goals',   desc: 'Targets & progress',         icon: '🎯' },
      { path: '/cancellations',label: 'Cancellations',   desc: 'No-shows & late cancels',    icon: '❌' },
      { path: '/vouchers',     label: 'Gift Vouchers',   desc: 'Create & track',             icon: '🎁' },
      { path: '/promos',       label: 'Promo Codes',     desc: 'Discount codes',             icon: '🏷️' },
      { path: '/inventory',    label: 'Inventory',       desc: 'Product stock',              icon: '📦' },
    ],
  },
  {
    id: 'marketing',
    label: 'Marketing & Comms',
    icon: '📣',
    items: [
      { path: '/inbox',      label: 'Inbox',            desc: 'All messages in one place',  icon: '💬' },
      { path: '/content',    label: 'Florrie Content',  desc: 'AI-written captions',        icon: '📸' },
      { path: '/campaigns',  label: 'Campaigns',        desc: 'Email & SMS blasts',         icon: '💌' },
      { path: '/reviews',    label: 'Reviews',          desc: 'Collect & respond',          icon: '⭐' },
      { path: '/referrals',  label: 'Referrals',        desc: 'Word-of-mouth tracking',     icon: '🤝' },
      { path: '/loyalty',    label: 'Loyalty',          desc: 'Points & rewards',           icon: '🏆' },
      { path: '/rebook',     label: 'Rebook Reminders', desc: 'Bring clients back',         icon: '🔄' },
      { path: '/automations',label: 'Automations',      desc: 'If-this-then-that rules',    icon: '⚡' },
      { path: '/templates',  label: 'Templates',        desc: 'Reusable messages',          icon: '📝' },
      { path: '/sequences',  label: 'Follow-up Flows',  desc: 'Automated follow-ups',       icon: '🔁' },
      { path: '/portfolio',  label: 'Portfolio',        desc: 'Showcase your work',         icon: '🖼️' },
      { path: '/whatsapp',   label: 'WhatsApp',         desc: 'Business messaging',         icon: '📱' },
      { path: '/digest',     label: 'Weekly Digest',    desc: 'Weekly summary',             icon: '📧' },
    ],
  },
  {
    id: 'settings',
    label: 'Settings & Team',
    icon: '⚙️',
    items: [
      { path: '/settings',      label: 'Settings',        desc: 'Account preferences',          icon: '⚙️' },
      { path: '/business',      label: 'Business Profile', desc: 'Name, logo & details',        icon: '🏪' },
      { path: '/integrations',  label: 'Integrations',    desc: 'Connected apps',               icon: '🔌' },
      { path: '/pricing',       label: 'Plans & Billing', desc: 'Subscription & payments',      icon: '💳' },
      { path: '/policies',      label: 'Policies',        desc: 'Cancellation & terms',         icon: '📜' },
      { path: '/portal',        label: 'Client Portal',   desc: 'Self-service settings',        icon: '🌐' },
      { path: '/sms',           label: 'SMS Config',      desc: 'SMS settings',                 icon: '📲' },
      { path: '/api-settings',  label: 'API & Webhooks',  desc: 'Developer tools',              icon: '⚡' },
      { path: '/team',          label: 'Team',            desc: 'Staff profiles', gate: 'team_management', icon: '👥' },
      { path: '/rota',          label: 'Staff Rota',      desc: 'Weekly schedule', gate: 'staff_rota', icon: '🗓️' },
      { path: '/staff-performance', label: 'Performance', desc: 'Team analytics', gate: 'staff_performance', icon: '📈' },
      { path: '/locations',     label: 'Multi-Location',  desc: 'Branch management', gate: 'multi_location', icon: '🏢' },
    ],
  },
];

// Track recent pages in sessionStorage
const RECENT_KEY = 'florrie_recent_pages';
const RECENT_MAX = 6;

function getRecents() {
  try {
    return JSON.parse(sessionStorage.getItem(RECENT_KEY) || '[]');
  } catch { return []; }
}

function recordVisit(path, label, icon) {
  try {
    const recents = getRecents().filter(r => r.path !== path);
    recents.unshift({ path, label, icon });
    sessionStorage.setItem(RECENT_KEY, JSON.stringify(recents.slice(0, RECENT_MAX)));
  } catch {}
}

function MIcon({ name, size, style }) {
  return (
    <span className="material-symbols-outlined" style={{ fontSize: size || 24, ...style }}>
      {name}
    </span>
  );
}

export default function Hub() {
  const [search, setSearch] = useState('');
  const [expandedCat, setExpandedCat] = useState(null);
  const [recents, setRecents] = useState(getRecents);
  const navigate = useNavigate();
  const location = useLocation();
  const { beautician } = useBeautician();
  const plan = beautician?.subscription_plan || 'trial';

  const allItems = useMemo(() =>
    CATEGORIES.flatMap(c => c.items.map(i => ({ ...i, category: c.label }))),
    []
  );

  const filtered = useMemo(() => {
    if (!search.trim()) return CATEGORIES;
    const q = search.toLowerCase();
    return CATEGORIES.map(cat => ({
      ...cat,
      items: cat.items.filter(i =>
        i.label.toLowerCase().includes(q) ||
        i.desc.toLowerCase().includes(q) ||
        cat.label.toLowerCase().includes(q)
      ),
    })).filter(cat => cat.items.length > 0);
  }, [search]);

  function handleNav(path, label, icon) {
    recordVisit(path, label, icon);
    setRecents(getRecents());
    navigate(path);
  }

  return (
    <div style={S.page}>
      {/* ─── Agent strip ─── */}
      <AgentStrip />

      {/* ─── Title ─── */}
      <h1 style={S.title}>Hub</h1>
      <p style={S.subtitle}>Find anything, fast</p>

      {/* ─── Search ─── */}
      <div style={S.searchWrap}>
        <MIcon name="search" size={18} style={S.searchIcon} />
        <input
          type="text"
          placeholder="Search features…"
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

      {/* ─── Recents ─── */}
      {!search && recents.length > 0 && (
        <div>
          <div style={S.sectionLabel}>Recently visited</div>
          <div style={S.recentRow}>
            {recents.map(r => (
              <button
                key={r.path}
                onClick={() => handleNav(r.path, r.label, r.icon)}
                style={S.recentChip}
              >
                <span style={{ fontSize: 14 }}>{r.icon}</span>
                <span style={S.recentLabel}>{r.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ─── Search results: flat list ─── */}
      {search && (
        <div style={{ marginBottom: 8 }}>
          {filtered.length === 0 ? (
            <div style={S.emptySearch}>
              <MIcon name="search_off" size={36} style={{ color: '#d8c1c6', display: 'block', marginBottom: 8 }} />
              <p style={{ margin: 0, color: '#867277', fontSize: 14 }}>No results for "{search}"</p>
            </div>
          ) : (
            filtered.map(cat => (
              <div key={cat.id} style={{ marginBottom: 16 }}>
                <div style={S.sectionLabel}>{cat.label}</div>
                <div style={S.itemGrid}>
                  {cat.items.map(item => {
                    const locked = item.gate && !hasFeature(plan, item.gate);
                    return (
                      <ItemCard
                        key={item.path}
                        item={item}
                        locked={locked}
                        isActive={location.pathname === item.path}
                        plan={plan}
                        onNav={() => handleNav(item.path, item.label, item.icon)}
                      />
                    );
                  })}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* ─── Category cards ─── */}
      {!search && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {CATEGORIES.map(cat => {
            const isExpanded = expandedCat === cat.id;
            const visibleItems = isExpanded ? cat.items : cat.items.slice(0, 4);
            const hasMore = cat.items.length > 4;

            return (
              <div key={cat.id} style={S.catCard}>
                <button
                  onClick={() => setExpandedCat(isExpanded ? null : cat.id)}
                  style={S.catHeader}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={S.catIcon}>{cat.icon}</span>
                    <div>
                      <div style={S.catLabel}>{cat.label}</div>
                      <div style={S.catMeta}>{cat.items.length} features</div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <MIcon
                      name="expand_more"
                      size={20}
                      style={{
                        color: '#867277',
                        transition: 'transform 0.22s ease',
                        transform: isExpanded ? 'rotate(180deg)' : 'rotate(0)',
                      }}
                    />
                  </div>
                </button>

                <div style={S.itemGrid}>
                  {visibleItems.map(item => {
                    const locked = item.gate && !hasFeature(plan, item.gate);
                    return (
                      <ItemCard
                        key={item.path}
                        item={item}
                        locked={locked}
                        isActive={location.pathname === item.path}
                        plan={plan}
                        onNav={() => handleNav(item.path, item.label, item.icon)}
                      />
                    );
                  })}
                </div>

                {hasMore && (
                  <button
                    onClick={() => setExpandedCat(isExpanded ? null : cat.id)}
                    style={S.showMore}
                  >
                    {isExpanded
                      ? 'Show less'
                      : `${cat.items.length - 4} more`}
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ItemCard({ item, locked, isActive, plan, onNav }) {
  return (
    <button
      onClick={onNav}
      style={{
        ...S.item,
        ...(isActive ? S.itemActive : {}),
        ...(locked ? { opacity: 0.6 } : {}),
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', marginBottom: 6 }}>
        <span style={{ fontSize: 20, lineHeight: 1 }}>{item.icon}</span>
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
}

// ─── Agent strip styles ───────────────────────────────────
const SS = {
  strip: {
    position: 'relative',
    background: 'linear-gradient(135deg, #fff5f7 0%, #fff 60%)',
    borderRadius: 20,
    border: '1px solid rgba(199,107,138,0.12)',
    padding: '14px 14px 12px',
    marginBottom: 20,
    boxShadow: '0 2px 12px rgba(199,107,138,0.06)',
  },
  stripHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 12,
  },
  stripTitle: {
    fontSize: 13,
    fontWeight: 700,
    color: '#92405e',
    fontFamily: "var(--font-display, 'Playfair Display', Georgia, serif)",
    fontStyle: 'italic',
    letterSpacing: '-0.01em',
  },
  stripMeta: {
    fontSize: 11,
    color: '#B5AFA8',
    fontWeight: 500,
  },
  avatarRow: {
    display: 'flex',
    gap: 4,
    overflowX: 'auto',
    scrollbarWidth: 'none',
    paddingBottom: 2,
  },
  agentBtn: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 5,
    padding: '6px 8px',
    border: 'none',
    background: 'none',
    cursor: 'pointer',
    position: 'relative',
    borderRadius: 12,
    flexShrink: 0,
    fontFamily: 'inherit',
    WebkitTapHighlightColor: 'transparent',
    minWidth: 52,
  },
  pulse: {
    position: 'absolute',
    top: 4,
    left: '50%',
    transform: 'translateX(-50%)',
    width: 38,
    height: 38,
    borderRadius: '50%',
    border: '2px solid',
    opacity: 0.35,
    animation: 'agentPulse 2.2s ease-in-out infinite',
    pointerEvents: 'none',
  },
  avatar: {
    width: 34,
    height: 34,
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 16,
    border: '2px solid',
    transition: 'all 0.2s',
    flexShrink: 0,
  },
  badge: {
    position: 'absolute',
    top: 2,
    right: 4,
    minWidth: 15,
    height: 15,
    borderRadius: 8,
    fontSize: 9,
    fontWeight: 700,
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0 3px',
  },
  agentName: {
    fontSize: 10,
    fontWeight: 600,
    textAlign: 'center',
    lineHeight: 1,
    transition: 'color 0.2s',
  },
  ticker: {
    marginTop: 10,
    padding: '7px 10px',
    borderRadius: 10,
    background: 'rgba(199,107,138,0.05)',
    minHeight: 28,
    display: 'flex',
    alignItems: 'center',
  },
  tickerText: {
    fontSize: 11.5,
    color: '#534247',
    lineHeight: 1.4,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    width: '100%',
  },
  popover: {
    position: 'absolute',
    left: 12,
    right: 12,
    top: '100%',
    marginTop: 8,
    background: '#fff',
    borderRadius: 16,
    border: '1px solid rgba(199,107,138,0.15)',
    boxShadow: '0 8px 28px rgba(0,0,0,0.1)',
    padding: 16,
    zIndex: 20,
    animation: 'fadeIn 0.15s ease-out',
  },
  popRow: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 },
  popName: { fontSize: 15, fontWeight: 700, color: '#1d1b19', fontFamily: "var(--font-display, 'Playfair Display', serif)" },
  popStatus: { fontSize: 12, color: '#867277', marginTop: 2, lineHeight: 1.4 },
  popStats: { display: 'flex', alignItems: 'center', gap: 16, paddingTop: 12, borderTop: '1px solid #F3EDE9' },
  popStat: { display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1 },
  popNum: { fontSize: 20, fontWeight: 700, color: '#1d1b19' },
  popLabel: { fontSize: 11, color: '#B5AFA8', marginTop: 2 },
  popDivider: { width: 1, height: 32, background: '#EDE9E4' },
};

// ─── Hub page styles ──────────────────────────────────────
const S = {
  page: {
    minHeight: '100vh',
    background: '#fef8f4',
    fontFamily: "var(--font-body, 'DM Sans', sans-serif)",
    padding: '16px 16px 120px',
    maxWidth: 480,
    margin: '0 auto',
    color: '#1d1b19',
  },
  title: {
    fontFamily: "var(--font-display, 'Playfair Display', serif)",
    fontSize: 26,
    fontStyle: 'italic',
    fontWeight: 700,
    letterSpacing: '-0.02em',
    color: '#92405e',
    margin: '0 0 2px',
  },
  subtitle: {
    fontSize: 13,
    color: '#867277',
    margin: '0 0 18px',
  },

  // Search
  searchWrap: { position: 'relative', marginBottom: 20 },
  searchIcon: {
    position: 'absolute', left: 13, top: '50%',
    transform: 'translateY(-50%)', color: '#867277', pointerEvents: 'none',
  },
  searchInput: {
    width: '100%',
    padding: '11px 36px 11px 40px',
    borderRadius: 14,
    border: '1px solid #d8c1c6',
    background: '#fff',
    fontSize: 14,
    fontFamily: 'inherit',
    color: '#1d1b19',
    outline: 'none',
    boxSizing: 'border-box',
  },
  searchClear: {
    position: 'absolute', right: 10, top: '50%',
    transform: 'translateY(-50%)',
    background: '#f3ede9', border: 'none', borderRadius: 8,
    width: 22, height: 22, color: '#867277', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },

  // Recents
  sectionLabel: {
    fontSize: 11, fontWeight: 700, color: '#B5AFA8',
    textTransform: 'uppercase', letterSpacing: '0.06em',
    marginBottom: 8,
  },
  recentRow: {
    display: 'flex', gap: 8, overflowX: 'auto',
    scrollbarWidth: 'none', marginBottom: 20, paddingBottom: 2,
  },
  recentChip: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '7px 12px', borderRadius: 10,
    border: '1px solid #EDE9E4', background: '#fff',
    cursor: 'pointer', fontFamily: 'inherit',
    flexShrink: 0, whiteSpace: 'nowrap',
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
  },
  recentLabel: {
    fontSize: 12, fontWeight: 600, color: '#534247',
  },

  // Categories
  catCard: {
    background: '#fff', borderRadius: 18,
    border: '1px solid rgba(146,64,94,0.06)',
    padding: '14px 12px 10px',
    boxShadow: '0 1px 4px rgba(146,64,94,0.04)',
  },
  catHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    width: '100%', background: 'none', border: 'none',
    cursor: 'pointer', padding: '0 0 12px',
    fontFamily: 'inherit', textAlign: 'left',
    WebkitTapHighlightColor: 'transparent',
  },
  catIcon: { fontSize: 22, lineHeight: 1 },
  catLabel: { fontSize: 14, fontWeight: 700, color: '#92405e', letterSpacing: '-0.01em' },
  catMeta: { fontSize: 11, color: '#B5AFA8', marginTop: 1 },

  // Item grid
  itemGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 8 },
  item: {
    display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
    padding: '11px 11px 9px', borderRadius: 13,
    border: 'none', background: '#f8f2ef',
    cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
    transition: 'background 0.12s, transform 0.1s',
    WebkitTapHighlightColor: 'transparent',
    minHeight: 72,
  },
  itemActive: {
    background: '#ffd9e2',
    boxShadow: 'inset 0 0 0 1.5px #92405e',
  },
  itemLabel: { fontSize: 12, fontWeight: 700, color: '#1d1b19', lineHeight: 1.2 },
  itemDesc:  { fontSize: 10, color: '#867277', lineHeight: 1.3, marginTop: 3 },
  lockBadge: {
    fontSize: 8, fontWeight: 700,
    background: 'linear-gradient(135deg, #745a27, #fedb9b)',
    color: '#fff', padding: '2px 5px', borderRadius: 5,
    letterSpacing: '0.05em',
  },

  showMore: {
    width: '100%', padding: '10px 0 2px',
    background: 'none', border: 'none',
    fontSize: 12, fontWeight: 600, color: '#92405e',
    cursor: 'pointer', fontFamily: 'inherit',
    WebkitTapHighlightColor: 'transparent',
  },

  emptySearch: { textAlign: 'center', padding: '48px 0' },
};

// Inject keyframes
if (typeof document !== 'undefined' && !document.getElementById('hub-keyframes')) {
  const style = document.createElement('style');
  style.id = 'hub-keyframes';
  style.textContent = `
    @keyframes agentPulse {
      0%, 100% { transform: translateX(-50%) scale(1); opacity: 0.35; }
      50% { transform: translateX(-50%) scale(1.18); opacity: 0.08; }
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to { opacity: 1; transform: translateY(0); }
    }
  `;
  document.head.appendChild(style);
}
