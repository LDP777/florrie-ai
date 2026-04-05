import { useState, useMemo, useEffect, useRef } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useBeautician } from '../lib/supabase.js';
import { hasFeature, getRequiredPlan } from '../lib/subscription.js';
import { API_BASE } from '../lib/config.js';

// ─── Agent definitions ────────────────────────────────────────────────────────
const AGENTS = [
  { id: 'front_desk', name: 'Desk',    label: 'Front Desk', colour: '#C76B8A' },
  { id: 'calendar',   name: 'Sync',    label: 'Calendar',   colour: '#7B68EE' },
  { id: 'comeback',   name: 'Growth',  label: 'Comeback',   colour: '#F59E0B' },
  { id: 'content',    name: 'Studio',  label: 'Content',    colour: '#10B981' },
  { id: 'money',      name: 'Ledger',  label: 'Money',      colour: '#3B82F6' },
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

// ─── SVG Mini-character avatars ───────────────────────────────────────────────
// Each agent gets their own illustrated character, drawn in-code.
// No external image URLs — fully portable.

function AvatarDesk({ size = 56 }) {
  return (
    <svg viewBox="0 0 56 56" width={size} height={size}>
      <circle cx="28" cy="28" r="28" fill="#C76B8A"/>
      {/* Face */}
      <circle cx="28" cy="27" r="13" fill="#FFD5B0"/>
      {/* Eyes */}
      <circle cx="24.5" cy="25" r="1.8" fill="#3D2B1A"/>
      <circle cx="31.5" cy="25" r="1.8" fill="#3D2B1A"/>
      {/* Smile */}
      <path d="M23.5 29.5 Q28 33.5 32.5 29.5" stroke="#3D2B1A" strokeWidth="1.4" fill="none" strokeLinecap="round"/>
      {/* Headset arc */}
      <path d="M16.5 24 Q16 12 28 12 Q40 12 39.5 24" stroke="#fff" strokeWidth="2.5" fill="none" strokeLinecap="round"/>
      {/* Earpieces */}
      <rect x="13.5" y="22.5" width="4.5" height="7" rx="2.25" fill="#fff"/>
      <rect x="38" y="22.5" width="4.5" height="7" rx="2.25" fill="#fff"/>
      {/* Mic boom */}
      <path d="M39 27 Q43 30 40 34" stroke="#fff" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
      <circle cx="40" cy="34.5" r="1.5" fill="#fff"/>
    </svg>
  );
}

function AvatarCalendar({ size = 56 }) {
  return (
    <svg viewBox="0 0 56 56" width={size} height={size}>
      <circle cx="28" cy="28" r="28" fill="#7B68EE"/>
      {/* Face */}
      <circle cx="28" cy="26" r="13" fill="#FFD5B0"/>
      {/* Eyes - focused/studious */}
      <ellipse cx="24.5" cy="24" rx="2.2" ry="1.5" fill="#3D2B1A"/>
      <ellipse cx="31.5" cy="24" rx="2.2" ry="1.5" fill="#3D2B1A"/>
      {/* Smile - slight */}
      <path d="M24 29 Q28 32 32 29" stroke="#3D2B1A" strokeWidth="1.4" fill="none" strokeLinecap="round"/>
      {/* Mini calendar floating top-right */}
      <rect x="34" y="8" width="14" height="14" rx="2.5" fill="#fff" opacity="0.9"/>
      <line x1="34" y1="12.5" x2="48" y2="12.5" stroke="#7B68EE" strokeWidth="1.2"/>
      <rect x="37" y="9.5" width="1.5" height="4" rx="0.75" fill="#7B68EE"/>
      <rect x="43.5" y="9.5" width="1.5" height="4" rx="0.75" fill="#7B68EE"/>
      {/* Calendar dots */}
      <circle cx="37.5" cy="16" r="1" fill="#7B68EE"/>
      <circle cx="41" cy="16" r="1" fill="#7B68EE"/>
      <circle cx="44.5" cy="16" r="1" fill="#C76B8A"/>
      <circle cx="37.5" cy="19" r="1" fill="#7B68EE"/>
      <circle cx="41" cy="19" r="1" fill="#7B68EE"/>
    </svg>
  );
}

function AvatarComeback({ size = 56 }) {
  return (
    <svg viewBox="0 0 56 56" width={size} height={size}>
      <circle cx="28" cy="28" r="28" fill="#F59E0B"/>
      {/* Face */}
      <circle cx="28" cy="28" r="13" fill="#FFD5B0"/>
      {/* Happy eyes */}
      <path d="M23 25 Q24.5 22.5 26 25" stroke="#3D2B1A" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
      <path d="M30 25 Q31.5 22.5 33 25" stroke="#3D2B1A" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
      {/* Big smile */}
      <path d="M22 30 Q28 36.5 34 30" stroke="#3D2B1A" strokeWidth="1.5" fill="none" strokeLinecap="round"/>
      {/* Floating hearts */}
      <path d="M9 14 C9 11.5 12.5 11.5 12.5 14 C12.5 11.5 16 11.5 16 14 C16 16.5 12.5 20 12.5 20 C12.5 20 9 16.5 9 14Z" fill="#fff" opacity="0.9"/>
      <path d="M38 7 C38 5.5 40 5.5 40 7 C40 5.5 42 5.5 42 7 C42 8.5 40 10.5 40 10.5 C40 10.5 38 8.5 38 7Z" fill="#fff" opacity="0.75"/>
    </svg>
  );
}

function AvatarContent({ size = 56 }) {
  return (
    <svg viewBox="0 0 56 56" width={size} height={size}>
      <circle cx="28" cy="28" r="28" fill="#10B981"/>
      {/* Face */}
      <circle cx="28" cy="27" r="13" fill="#FFD5B0"/>
      {/* Cool/creative eyes */}
      <circle cx="24.5" cy="25" r="1.8" fill="#3D2B1A"/>
      <circle cx="31.5" cy="25" r="1.8" fill="#3D2B1A"/>
      {/* Glint in eyes */}
      <circle cx="25.3" cy="24.2" r="0.7" fill="#fff"/>
      <circle cx="32.3" cy="24.2" r="0.7" fill="#fff"/>
      {/* Smile */}
      <path d="M23.5 29.5 Q28 33.5 32.5 29.5" stroke="#3D2B1A" strokeWidth="1.4" fill="none" strokeLinecap="round"/>
      {/* Camera body */}
      <rect x="34" y="8" width="16" height="12" rx="2.5" fill="#fff" opacity="0.9"/>
      <circle cx="42" cy="14" r="3.5" fill="#10B981" opacity="0.8"/>
      <circle cx="42" cy="14" r="2" fill="#fff" opacity="0.6"/>
      <rect x="46" y="10" width="3" height="2.5" rx="1" fill="#10B981" opacity="0.7"/>
      <circle cx="36.5" cy="10" r="1.2" fill="#10B981" opacity="0.7"/>
      {/* Sparkle */}
      <path d="M8 10 L8 16 M5 13 L11 13" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" opacity="0.7"/>
    </svg>
  );
}

function AvatarMoney({ size = 56 }) {
  return (
    <svg viewBox="0 0 56 56" width={size} height={size}>
      <circle cx="28" cy="28" r="28" fill="#3B82F6"/>
      {/* Face */}
      <circle cx="28" cy="27" r="13" fill="#FFD5B0"/>
      {/* Focused eyes */}
      <circle cx="24.5" cy="25" r="1.8" fill="#3D2B1A"/>
      <circle cx="31.5" cy="25" r="1.8" fill="#3D2B1A"/>
      {/* Confident smile */}
      <path d="M24 29.5 Q28 33 32 29.5" stroke="#3D2B1A" strokeWidth="1.4" fill="none" strokeLinecap="round"/>
      {/* Coin */}
      <circle cx="42" cy="13" r="8" fill="#F59E0B" opacity="0.95"/>
      <circle cx="42" cy="13" r="6" fill="#F59E0B" stroke="#fff" strokeWidth="1"/>
      {/* £ symbol */}
      <text x="42" y="17" textAnchor="middle" fontSize="8" fontWeight="bold" fill="#fff" fontFamily="serif">£</text>
      {/* Small coins */}
      <circle cx="10" cy="12" r="5" fill="#F59E0B" opacity="0.8"/>
      <text x="10" y="15.5" textAnchor="middle" fontSize="6" fontWeight="bold" fill="#fff" fontFamily="serif">£</text>
    </svg>
  );
}

const AVATAR_COMPONENTS = {
  front_desk: AvatarDesk,
  calendar:   AvatarCalendar,
  comeback:   AvatarComeback,
  content:    AvatarContent,
  money:      AvatarMoney,
};

// ─── Agent strip ──────────────────────────────────────────────────────────────
function AgentStrip({ beautician }) {
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

  useEffect(() => {
    function handleClick(e) {
      if (popRef.current && !popRef.current.contains(e.target)) setSelected(null);
    }
    if (selected !== null) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [selected]);

  const activeAgents = AGENTS.filter(a => {
    const d = agentData[a.id] || {};
    return (d.actionsToday || 0) > 0 || d.isActive;
  });

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
      const mapped = {};
      if (data.agents) {
        data.agents.forEach(a => { mapped[a.id] = a; });
      }
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
      // silent
    }
    setLoading(false);
  }

  const tickerAgent = activeAgents[tickerIdx % Math.max(1, activeAgents.length)];

  // Beautician avatar (profile pic or initials)
  const bzInitials = beautician
    ? `${beautician.first_name?.[0] || ''}${beautician.last_name?.[0] || ''}`.toUpperCase()
    : '?';
  const bzPhoto = beautician?.avatar_url || beautician?.photo_url || null;

  return (
    <div style={SS.wrap}>
      {/* Card header */}
      <div style={SS.header}>
        <div style={SS.headerLeft}>
          {/* Beautician avatar */}
          <div style={SS.bzAvatar}>
            {bzPhoto
              ? <img src={bzPhoto} alt="Profile" style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
              : <span style={SS.bzInitials}>{bzInitials}</span>
            }
          </div>
          <h2 style={SS.title}>✦ Your AI Team</h2>
        </div>
        {!loading && (
          <span style={SS.activeBadge}>
            {activeAgents.length} ACTIVE
          </span>
        )}
      </div>

      {/* Agent avatars */}
      <div style={SS.avatarRow}>
        {AGENTS.map((agent, i) => {
          const d = agentData[agent.id] || {};
          const isActive = !loading && ((d.actionsToday || 0) > 0 || d.isActive);
          const count = d.actionsToday || 0;
          const AvatarComp = AVATAR_COMPONENTS[agent.id];

          return (
            <button
              key={agent.id}
              style={SS.agentBtn}
              onClick={() => setSelected(selected === i ? null : i)}
            >
              <div style={{
                ...SS.avatarRing,
                borderColor: isActive ? agent.colour : 'transparent',
                boxShadow: isActive ? `0 0 14px ${agent.colour}35` : 'none',
                opacity: isActive ? 1 : 0.45,
                filter: isActive ? 'none' : 'grayscale(100%)',
              }}>
                {/* Pulse ring — only when active */}
                {isActive && (
                  <span style={{ ...SS.pulseRing, borderColor: agent.colour }} />
                )}
                <div style={SS.avatarInner}>
                  {AvatarComp ? <AvatarComp size={50} /> : null}
                </div>
              </div>
              {/* Action count badge */}
              {count > 0 && (
                <span style={{ ...SS.badge, background: agent.colour }}>{count}</span>
              )}
              <span style={{
                ...SS.agentName,
                color: isActive ? '#1d1b19' : '#B5AFA8',
              }}>
                {agent.name}
              </span>
            </button>
          );
        })}
      </div>

      {/* Ticker */}
      <div style={SS.ticker}>
        <span className="material-symbols-outlined" style={{ fontSize: 14, color: '#92405e', flexShrink: 0 }}>auto_awesome</span>
        <p style={{
          ...SS.tickerText,
          opacity: tickerVisible ? 1 : 0,
          transition: 'opacity 0.35s ease',
        }}>
          {tickerAgent
            ? <>{AGENTS.find(a => a.id === tickerAgent.id)?.label || 'Agent'} → {agentData[tickerAgent.id]?.latest || 'Working…'}</>
            : 'Your AI team is standing by…'
          }
        </p>
      </div>

      {/* Tap popover */}
      {selected !== null && (
        <div ref={popRef} style={SS.popover}>
          <div style={SS.popRow}>
            <div style={{ width: 44, height: 44, borderRadius: 22, overflow: 'hidden', flexShrink: 0 }}>
              {AVATAR_COMPONENTS[AGENTS[selected].id]
                ? (() => { const C = AVATAR_COMPONENTS[AGENTS[selected].id]; return <C size={44} />; })()
                : null
              }
            </div>
            <div>
              <div style={SS.popName}>{AGENTS[selected].label}</div>
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

// ─── Navigation categories ────────────────────────────────────────────────────
const CATEGORIES = [
  {
    id: 'daily',
    label: 'Your Day',
    matIcon: 'wb_sunny',
    items: [
      { path: '/calendar',       label: "Today's List",   matIcon: 'event_note',    desc: 'Appointments & schedule'  },
      { path: '/waitlist-pro',   label: 'Waitlist',       matIcon: 'history',       desc: 'Manage waiting clients'   },
      { path: '/checklist',      label: 'Checklist',      matIcon: 'checklist',     desc: 'Daily opening & closing'  },
      { path: '/end-of-day',     label: 'End of Day',     matIcon: 'nightlight',    desc: 'Cash-up and close'        },
      { path: '/notifications',  label: 'Notifications',  matIcon: 'notifications', desc: 'Alerts & reminders'       },
      { path: '/hours',          label: 'Hours & Time Off',matIcon: 'beach_access',desc: 'Exceptions & closures'    },
    ],
  },
  {
    id: 'clients',
    label: 'Clients',
    matIcon: 'face_3',
    items: [
      { path: '/clients',        label: 'Directory',      matIcon: 'face_3',          desc: 'All client profiles'       },
      { path: '/inbox',          label: 'Inbox',          matIcon: 'chat_bubble',     desc: 'All messages'              },
      { path: '/loyalty',        label: 'Loyalty',        matIcon: 'loyalty',         desc: 'Points & rewards'          },
      { path: '/reviews',        label: 'Feedback',       matIcon: 'reviews',         desc: 'Reviews & responses'       },
      { path: '/tags',           label: 'Tags & Groups',  matIcon: 'label',           desc: 'Organise & segment'        },
      { path: '/segments',       label: 'Segments',       matIcon: 'group_work',      desc: 'Smart RFM grouping'        },
      { path: '/churn',          label: 'Retention',      matIcon: 'shield',          desc: 'At-risk clients'           },
      { path: '/memberships',    label: 'Memberships',    matIcon: 'card_membership', desc: 'Recurring packages'        },
      { path: '/photo-consent',  label: 'Photo Consent',  matIcon: 'photo_camera',    desc: 'Before/after consent'      },
      { path: '/import',         label: 'Import',         matIcon: 'upload',          desc: 'CSV & bulk import'         },
    ],
  },
  {
    id: 'treatments',
    label: 'Treatments',
    matIcon: 'content_cut',
    items: [
      { path: '/treatments',         label: 'Treatments',     matIcon: 'spa',           desc: 'Manage services'           },
      { path: '/consultations',      label: 'Consultations',  matIcon: 'medical_services',desc: 'Pre-treatment bookings' },
      { path: '/consultation-forms', label: 'Form Builder',   matIcon: 'assignment',    desc: 'Consent forms'             },
      { path: '/patch-tests',        label: 'Patch Tests',    matIcon: 'vaccines',      desc: 'Allergy test tracking'     },
      { path: '/aftercare',          label: 'Aftercare',      matIcon: 'self_care',     desc: 'Post-treatment messages'   },
      { path: '/packages',           label: 'Packages',       matIcon: 'inventory_2',   desc: 'Bundle deals & courses'    },
      { path: '/addons',             label: 'Add-ons',        matIcon: 'add_circle',    desc: 'Bolt-on extras'            },
      { path: '/price-list',         label: 'Price List',     matIcon: 'price_list',    desc: 'Public pricing page'       },
      { path: '/notes',              label: 'Appt Notes',     matIcon: 'sticky_note_2', desc: 'Notes per appointment'     },
    ],
  },
  {
    id: 'money',
    label: 'Money',
    matIcon: 'payments',
    items: [
      { path: '/money',         label: 'Money Tracker',  matIcon: 'account_balance_wallet', desc: 'Revenue dashboard'   },
      { path: '/analytics',     label: 'Analytics',      matIcon: 'analytics',         desc: 'Performance & reports'     },
      { path: '/expenses',      label: 'Expenses',       matIcon: 'receipt_long',      desc: 'Track outgoings'           },
      { path: '/deposits',      label: 'Deposits',       matIcon: 'savings',           desc: 'Held payments'             },
      { path: '/goals',         label: 'Goals',          matIcon: 'flag',              desc: 'Revenue targets'           },
      { path: '/vouchers',      label: 'Vouchers',       matIcon: 'card_giftcard',     desc: 'Gift vouchers'             },
      { path: '/promos',        label: 'Promo Codes',    matIcon: 'discount',          desc: 'Discount codes'            },
      { path: '/inventory',     label: 'Inventory',      matIcon: 'inventory',         desc: 'Product stock'             },
      { path: '/cancellations', label: 'Cancellations',  matIcon: 'event_busy',        desc: 'No-shows & late cancels'   },
    ],
  },
  {
    id: 'marketing',
    label: 'Marketing',
    matIcon: 'campaign',
    items: [
      { path: '/campaigns',   label: 'Campaigns',    matIcon: 'mail',          desc: 'Email & SMS blasts'        },
      { path: '/content',     label: 'Content',      matIcon: 'image',         desc: 'AI-written captions'       },
      { path: '/referrals',   label: 'Referrals',    matIcon: 'diversity_3',   desc: 'Word-of-mouth tracking'    },
      { path: '/rebook',      label: 'Rebook',       matIcon: 'replay',        desc: 'Bring clients back'        },
      { path: '/automations', label: 'Automations',  matIcon: 'bolt',          desc: 'If-this-then-that rules'   },
      { path: '/templates',   label: 'Templates',    matIcon: 'description',   desc: 'Reusable messages'         },
      { path: '/whatsapp',    label: 'WhatsApp',     matIcon: 'smartphone',    desc: 'Business messaging'        },
      { path: '/digest',      label: 'Weekly Digest',matIcon: 'newspaper',     desc: 'Weekly summary email'      },
      { path: '/portfolio',   label: 'Portfolio',    matIcon: 'photo_library', desc: 'Showcase your work'        },
    ],
  },
  {
    id: 'settings',
    label: 'Settings & Team',
    matIcon: 'settings',
    items: [
      { path: '/settings',     label: 'Settings',      matIcon: 'settings',       desc: 'Account preferences'       },
      { path: '/business',     label: 'Business',      matIcon: 'storefront',     desc: 'Name, logo & details'      },
      { path: '/integrations', label: 'Integrations',  matIcon: 'extension',      desc: 'Connected apps'            },
      { path: '/pricing',      label: 'Plans',         matIcon: 'workspace_premium',desc: 'Subscription & billing'  },
      { path: '/policies',     label: 'Policies',      matIcon: 'policy',         desc: 'Cancellation & terms'      },
      { path: '/portal',       label: 'Client Portal', matIcon: 'open_in_browser',desc: 'Self-service settings'    },
      { path: '/team',         label: 'Team',          matIcon: 'group',          desc: 'Staff profiles',           gate: 'team_management' },
      { path: '/rota',         label: 'Staff Rota',    matIcon: 'calendar_view_week',desc: 'Weekly schedule',       gate: 'staff_rota' },
      { path: '/staff-performance',label:'Performance',matIcon: 'trending_up',    desc: 'Team analytics',           gate: 'staff_performance' },
      { path: '/locations',    label: 'Multi-Location',matIcon: 'location_city',  desc: 'Branch management',        gate: 'multi_location' },
    ],
  },
];

// ─── Recents tracking ─────────────────────────────────────────────────────────
const RECENT_KEY = 'florrie_recent_pages';
const RECENT_MAX = 6;

function getRecents() {
  try { return JSON.parse(sessionStorage.getItem(RECENT_KEY) || '[]'); }
  catch { return []; }
}

function recordVisit(path, label, matIcon) {
  try {
    const recents = getRecents().filter(r => r.path !== path);
    recents.unshift({ path, label, matIcon });
    sessionStorage.setItem(RECENT_KEY, JSON.stringify(recents.slice(0, RECENT_MAX)));
  } catch {}
}

function MIcon({ name, size = 24, color, style }) {
  return (
    <span
      className="material-symbols-outlined"
      style={{ fontSize: size, color, ...style }}
    >
      {name}
    </span>
  );
}

// ─── Hub page ─────────────────────────────────────────────────────────────────
export default function Hub() {
  const [search, setSearch] = useState('');
  // First two categories expanded by default (Your Day + Clients)
  const [expandedCats, setExpandedCats] = useState(new Set(['daily', 'clients']));
  const [recents, setRecents] = useState(getRecents);
  const navigate = useNavigate();
  const location = useLocation();
  const { beautician } = useBeautician();
  const plan = beautician?.subscription_plan || 'trial';

  const filtered = useMemo(() => {
    if (!search.trim()) return CATEGORIES;
    const q = search.toLowerCase();
    return CATEGORIES.map(cat => ({
      ...cat,
      items: cat.items.filter(i =>
        i.label.toLowerCase().includes(q) ||
        (i.desc || '').toLowerCase().includes(q) ||
        cat.label.toLowerCase().includes(q)
      ),
    })).filter(cat => cat.items.length > 0);
  }, [search]);

  function toggleCat(id) {
    setExpandedCats(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function handleNav(path, label, matIcon) {
    recordVisit(path, label, matIcon);
    setRecents(getRecents());
    navigate(path);
  }

  return (
    <div style={S.page}>
      {/* ── Agent strip ── */}
      <AgentStrip beautician={beautician} />

      {/* ── Search ── */}
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

      {/* ── Recents row ── */}
      {!search && recents.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={S.sectionLabel}>Recently visited</div>
          <div style={S.recentRow}>
            {recents.map(r => (
              <button
                key={r.path}
                onClick={() => handleNav(r.path, r.label, r.matIcon)}
                style={S.recentChip}
              >
                <MIcon name={r.matIcon || 'star'} size={14} color="#92405e" />
                <span style={S.recentLabel}>{r.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* ── Search results ── */}
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
                  {cat.items.map(item => (
                    <ItemCard
                      key={item.path}
                      item={item}
                      locked={item.gate && !hasFeature(plan, item.gate)}
                      isActive={location.pathname === item.path}
                      plan={plan}
                      onNav={() => handleNav(item.path, item.label, item.matIcon)}
                    />
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {/* ── Category accordions ── */}
      {!search && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {CATEGORIES.map(cat => {
            const isExpanded = expandedCats.has(cat.id);
            // When collapsed, just show the header row
            // When expanded, show 2-col grid of square item cards

            return (
              <div key={cat.id} style={S.catCard}>
                {/* Header */}
                <button
                  onClick={() => toggleCat(cat.id)}
                  style={S.catHeader}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <MIcon name={cat.matIcon} size={20} color="rgba(146,64,94,0.65)" />
                    <span style={S.catLabel}>{cat.label}</span>
                  </div>
                  <MIcon
                    name={isExpanded ? 'expand_less' : 'expand_more'}
                    size={20}
                    color="#B5AFA8"
                  />
                </button>

                {/* Expanded grid */}
                {isExpanded && (
                  <div style={S.expandedBody}>
                    <div style={S.itemGrid}>
                      {cat.items.map(item => (
                        <ItemCard
                          key={item.path}
                          item={item}
                          locked={item.gate && !hasFeature(plan, item.gate)}
                          isActive={location.pathname === item.path}
                          plan={plan}
                          onNav={() => handleNav(item.path, item.label, item.matIcon)}
                        />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Item card ────────────────────────────────────────────────────────────────
function ItemCard({ item, locked, isActive, plan, onNav }) {
  return (
    <button
      onClick={onNav}
      style={{
        ...S.item,
        ...(isActive ? S.itemActive : {}),
        ...(locked ? { opacity: 0.55 } : {}),
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', marginBottom: 10 }}>
        <MIcon name={item.matIcon} size={22} color={isActive ? '#92405e' : '#92405e'} style={{ opacity: isActive ? 1 : 0.75 }} />
        {locked && (
          <span style={S.lockBadge}>
            {(getRequiredPlan(item.gate) || 'PRO').toUpperCase()}
          </span>
        )}
      </div>
      <span style={S.itemLabel}>{item.label}</span>
    </button>
  );
}

// ─── Agent strip styles ───────────────────────────────────────────────────────
const SS = {
  wrap: {
    position: 'relative',
    background: 'linear-gradient(135deg, #fff5f7 0%, #fff 70%)',
    borderRadius: 24,
    border: '1px solid rgba(199,107,138,0.12)',
    padding: '16px 16px 14px',
    marginBottom: 20,
    boxShadow: '0 2px 16px rgba(199,107,138,0.07)',
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  headerLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
  },
  bzAvatar: {
    width: 32,
    height: 32,
    borderRadius: 16,
    background: '#ffd9e2',
    border: '1.5px solid rgba(199,107,138,0.25)',
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  },
  bzInitials: {
    fontSize: 12,
    fontWeight: 700,
    color: '#92405e',
    letterSpacing: '-0.02em',
  },
  title: {
    fontSize: 14,
    fontWeight: 700,
    color: '#92405e',
    fontFamily: "'Noto Serif', Georgia, serif",
    fontStyle: 'italic',
  },
  activeBadge: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '0.08em',
    color: '#92405e',
    background: '#ffd9e2',
    padding: '3px 8px',
    borderRadius: 20,
  },
  avatarRow: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 4,
    marginBottom: 14,
  },
  agentBtn: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 6,
    border: 'none',
    background: 'none',
    cursor: 'pointer',
    position: 'relative',
    borderRadius: 12,
    padding: '4px 4px',
    flexShrink: 0,
    fontFamily: 'inherit',
    WebkitTapHighlightColor: 'transparent',
    flex: 1,
  },
  avatarRing: {
    width: 56,
    height: 56,
    borderRadius: 28,
    border: '2px solid',
    overflow: 'hidden',
    position: 'relative',
    transition: 'all 0.2s',
  },
  pulseRing: {
    position: 'absolute',
    inset: -5,
    borderRadius: '50%',
    border: '2px solid',
    opacity: 0.3,
    animation: 'agentPulse 2.2s ease-in-out infinite',
    pointerEvents: 'none',
    zIndex: 0,
  },
  avatarInner: {
    width: '100%',
    height: '100%',
    borderRadius: '50%',
    overflow: 'hidden',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    position: 'absolute',
    top: 0,
    right: 0,
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    fontSize: 10,
    fontWeight: 700,
    color: '#fff',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '0 4px',
    border: '2px solid #fff5f7',
  },
  agentName: {
    fontSize: 10,
    fontWeight: 600,
    textAlign: 'center',
    lineHeight: 1,
    transition: 'color 0.2s',
  },
  ticker: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    background: 'rgba(199,107,138,0.06)',
    borderRadius: 99,
    padding: '8px 12px',
  },
  tickerText: {
    fontSize: 11,
    color: '#534247',
    lineHeight: 1,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flex: 1,
    fontWeight: 500,
  },
  popover: {
    position: 'absolute',
    left: 12,
    right: 12,
    top: 'calc(100% + 8px)',
    background: '#fff',
    borderRadius: 18,
    border: '1px solid rgba(199,107,138,0.15)',
    boxShadow: '0 8px 32px rgba(0,0,0,0.1)',
    padding: 16,
    zIndex: 30,
    animation: 'fadeIn 0.15s ease-out',
  },
  popRow: { display: 'flex', alignItems: 'center', gap: 12, marginBottom: 14 },
  popName: { fontSize: 15, fontWeight: 700, color: '#1d1b19', fontFamily: "'Noto Serif', serif", fontStyle: 'italic' },
  popStatus: { fontSize: 12, color: '#867277', marginTop: 2, lineHeight: 1.4 },
  popStats: { display: 'flex', alignItems: 'center', gap: 16, paddingTop: 12, borderTop: '1px solid #F3EDE9' },
  popStat: { display: 'flex', flexDirection: 'column', alignItems: 'center', flex: 1 },
  popNum: { fontSize: 22, fontWeight: 700, color: '#1d1b19' },
  popLabel: { fontSize: 11, color: '#B5AFA8', marginTop: 2 },
  popDivider: { width: 1, height: 32, background: '#EDE9E4' },
};

// ─── Hub page styles ──────────────────────────────────────────────────────────
const S = {
  page: {
    minHeight: '100vh',
    background: '#fef8f4',
    fontFamily: "'Plus Jakarta Sans', 'DM Sans', sans-serif",
    padding: '16px 16px 120px',
    maxWidth: 480,
    margin: '0 auto',
    color: '#1d1b19',
  },

  searchWrap: { position: 'relative', marginBottom: 20 },
  searchIcon: {
    position: 'absolute', left: 14, top: '50%',
    transform: 'translateY(-50%)', color: '#B5AFA8', pointerEvents: 'none',
  },
  searchInput: {
    width: '100%',
    padding: '11px 36px 11px 42px',
    borderRadius: 99,
    border: 'none',
    background: '#fff',
    fontSize: 14,
    fontFamily: 'inherit',
    color: '#1d1b19',
    outline: 'none',
    boxSizing: 'border-box',
    boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
  },
  searchClear: {
    position: 'absolute', right: 10, top: '50%',
    transform: 'translateY(-50%)',
    background: '#f3ede9', border: 'none', borderRadius: 8,
    width: 22, height: 22, color: '#867277', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },

  sectionLabel: {
    fontSize: 10, fontWeight: 700, color: '#B5AFA8',
    textTransform: 'uppercase', letterSpacing: '0.08em',
    marginBottom: 8,
  },
  recentRow: {
    display: 'flex', gap: 8, overflowX: 'auto',
    scrollbarWidth: 'none', paddingBottom: 2,
  },
  recentChip: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '7px 13px', borderRadius: 99,
    border: '1px solid rgba(146,64,94,0.1)', background: '#fff',
    cursor: 'pointer', fontFamily: 'inherit',
    flexShrink: 0, whiteSpace: 'nowrap',
    boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
  },
  recentLabel: { fontSize: 12, fontWeight: 600, color: '#534247' },

  emptySearch: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    padding: '40px 16px', textAlign: 'center',
  },

  // Category cards
  catCard: {
    background: '#fff',
    borderRadius: 20,
    border: '1px solid rgba(146,64,94,0.07)',
    overflow: 'hidden',
    boxShadow: '0 1px 4px rgba(146,64,94,0.05)',
  },
  catHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    width: '100%', background: 'none', border: 'none',
    cursor: 'pointer', padding: '14px 16px',
    fontFamily: 'inherit', textAlign: 'left',
    WebkitTapHighlightColor: 'transparent',
  },
  catLabel: {
    fontSize: 14, fontWeight: 700, color: '#1d1b19',
  },
  expandedBody: {
    background: '#f8f2ef',
    padding: '12px 12px 14px',
    borderTop: '1px solid rgba(146,64,94,0.06)',
  },

  // Item grid — 2 columns of square cards
  itemGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: 8,
  },
  item: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    padding: '14px 12px 12px',
    borderRadius: 14,
    border: 'none',
    background: '#fff',
    cursor: 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left',
    transition: 'background 0.12s, transform 0.1s',
    WebkitTapHighlightColor: 'transparent',
    boxShadow: '0 1px 2px rgba(0,0,0,0.04)',
  },
  itemActive: {
    background: '#ffd9e2',
    boxShadow: 'inset 0 0 0 1.5px #92405e',
  },
  itemLabel: {
    fontSize: 11, fontWeight: 700, color: '#1d1b19', lineHeight: 1.3,
  },
  lockBadge: {
    fontSize: 8, fontWeight: 700,
    background: 'linear-gradient(135deg, #745a27, #fedb9b)',
    color: '#fff', padding: '2px 5px', borderRadius: 5,
    letterSpacing: '0.05em',
  },
};

// Inject keyframes
if (typeof document !== 'undefined' && !document.getElementById('hub-keyframes')) {
  const s = document.createElement('style');
  s.id = 'hub-keyframes';
  s.textContent = `
    @keyframes agentPulse {
      0%, 100% { transform: scale(1);   opacity: 0.3; }
      50%       { transform: scale(1.2); opacity: 0.12; }
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(4px); }
      to   { opacity: 1; transform: translateY(0); }
    }
  `;
  document.head.appendChild(s);
}
