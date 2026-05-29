import { useState, useMemo, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useBeautician } from '../lib/supabase.js';
import { hasFeature, getRequiredPlan } from '../lib/subscription.js';
import { isIOSNative } from '../lib/platform.js';

/**
 * More , the back-of-house catalogue of every secondary page.
 *
 * Before the 2026-05-28 refactor this lived on Hub. Now Hub does one job
 * (Today + activity feed + Ask Florrie) and More holds the rest:
 * search, recently visited, full category accordion of every page,
 * and the AI team agent strip.
 *
 * Day 3 of the sprint will wire this into the bottom nav.
 */

const CATEGORIES = [
  {
    id: 'ai-team',
    label: 'AI team',
    matIcon: 'auto_awesome',
    items: [
      { path: '/inbox',       label: 'Front Desk',  matIcon: 'forum',         desc: 'Handles every message'        },
      { path: '/content',     label: 'Content',     matIcon: 'auto_fix_high', desc: 'Captions and posts',           gate: 'content_autopilot' },
      { path: '/money',       label: 'Bookkeeper',  matIcon: 'account_balance_wallet', desc: 'Tracks revenue and expenses' },
      { path: '/ai-insights', label: 'Biz',         matIcon: 'psychology',    desc: 'Spots trends and risks',       gate: 'ai_insights' },
      { path: '/compliance',  label: 'Guardian',    matIcon: 'verified_user', desc: 'Patch tests and consent'      },
      { path: '/client-intel',label: 'Client',      matIcon: 'diversity_3',   desc: 'Knows every client'           },
    ],
  },
  {
    id: 'daily',
    label: 'Your Day',
    matIcon: 'wb_sunny',
    items: [
      { path: '/calendar/week',  label: 'Week view',       matIcon: 'calendar_view_week',   desc: 'Whole week at a glance'        },
      { path: '/smart-schedule', label: 'Smart Schedule',  matIcon: 'schedule_send',        desc: 'AI-optimised slots',            gate: 'smart_schedule' },
      { path: '/waitlist-pro',   label: 'Waitlist',        matIcon: 'history',              desc: 'Manage waiting clients'        },
      { path: '/checklist',      label: 'Checklist',       matIcon: 'checklist',            desc: 'Daily opening and closing'     },
      { path: '/end-of-day',     label: 'End of Day',      matIcon: 'nightlight',           desc: 'Cash-up and close'             },
      { path: '/notifications',  label: 'Notifications',   matIcon: 'notifications',        desc: 'Alerts and reminders'          },
      { path: '/hours',          label: 'Hours and Time Off', matIcon: 'beach_access',      desc: 'Exceptions and closures'       },
    ],
  },
  {
    id: 'clients',
    label: 'Clients',
    matIcon: 'people',
    items: [
      { path: '/clients',        label: 'Directory',       matIcon: 'people',               desc: 'All client profiles'           },
      { path: '/churn',          label: 'Churn Risk',      matIcon: 'person_off',           desc: 'At-risk clients',               gate: 'churn_prevention' },
      { path: '/segments',       label: 'Segments',        matIcon: 'workspaces',           desc: 'Smart RFM grouping',            gate: 'client_segments' },
      { path: '/loyalty',        label: 'Loyalty',         matIcon: 'loyalty',              desc: 'Points & rewards',              gate: 'loyalty' },
      { path: '/reviews',        label: 'Feedback',        matIcon: 'reviews',              desc: 'Reviews & responses'           },
      { path: '/memberships',    label: 'Memberships',     matIcon: 'card_membership',      desc: 'Recurring packages'            },
      { path: '/tags',           label: 'Tags & Groups',   matIcon: 'label',                desc: 'Organise & segment'            },
      { path: '/photo-consent',  label: 'Photo Consent',   matIcon: 'photo_camera',         desc: 'Before/after consent'          },
      { path: '/import',         label: 'Import',          matIcon: 'upload',               desc: 'CSV & bulk import'             },
    ],
  },
  {
    id: 'treatments',
    label: 'Treatments',
    matIcon: 'spa',
    items: [
      { path: '/treatments',     label: 'Treatments',      matIcon: 'spa',                  desc: 'Manage services'               },
      { path: '/aftercare',      label: 'Aftercare',       matIcon: 'self_care',            desc: 'Post-treatment messages',       gate: 'aftercare' },
      { path: '/packages',       label: 'Courses',         matIcon: 'school',               desc: 'Training & masterclasses'      },
      { path: '/addons',         label: 'Add-ons',         matIcon: 'add_circle',           desc: 'Bolt-on extras'                },
      { path: '/price-list',     label: 'Price List',      matIcon: 'format_list_bulleted', desc: 'Public pricing page'           },
      { path: '/notes',          label: 'Appt Notes',      matIcon: 'sticky_note_2',        desc: 'Notes per appointment'         },
    ],
  },
  {
    id: 'compliance',
    label: 'Compliance',
    matIcon: 'verified_user',
    items: [
      { path: '/compliance',          label: 'Compliance',   matIcon: 'verified_user', desc: 'Patch tests & consent forms' },
      { path: '/patch-tests',         label: 'Patch Tests',  matIcon: 'vaccines',      desc: 'UK compliance tracking'      },
      { path: '/consultation-forms',  label: 'Form Builder', matIcon: 'assignment',    desc: 'Consent & intake forms'      },
    ],
  },
  {
    id: 'money',
    label: 'Money',
    matIcon: 'payments',
    items: [
      { path: '/money',         label: 'Money Tracker',    matIcon: 'account_balance_wallet', desc: 'Revenue dashboard'         },
      { path: '/ai-insights',   label: 'AI Insights',      matIcon: 'psychology',             desc: 'AI business analysis',      gate: 'ai_insights' },
      { path: '/analytics',     label: 'Analytics',        matIcon: 'analytics',              desc: 'Performance & reports'     },
      { path: '/expenses',      label: 'Expenses',         matIcon: 'receipt_long',           desc: 'Track outgoings'           },
      { path: '/deposits',      label: 'Deposits',         matIcon: 'savings',                desc: 'Held payments'             },
      { path: '/goals',         label: 'Goals',            matIcon: 'flag',                   desc: 'Revenue targets'           },
      { path: '/vouchers',      label: 'Vouchers',         matIcon: 'card_giftcard',          desc: 'Gift vouchers'             },
      { path: '/promos',        label: 'Promo Codes',      matIcon: 'local_offer',            desc: 'Discount codes'            },
      { path: '/inventory',     label: 'Inventory',        matIcon: 'category',               desc: 'Product stock'             },
      { path: '/cancellations', label: 'Cancellations',    matIcon: 'event_busy',             desc: 'No-shows & late cancels'   },
    ],
  },
  {
    id: 'marketing',
    label: 'Marketing',
    matIcon: 'campaign',
    items: [
      { path: '/content',     label: 'Content Autopilot', matIcon: 'auto_fix_high',  desc: 'AI-written captions',       gate: 'content_autopilot' },
      { path: '/campaigns',   label: 'Campaigns',         matIcon: 'mail',           desc: 'Email & SMS blasts',        gate: 'campaigns' },
      { path: '/rebook',      label: 'Rebook',            matIcon: 'replay',         desc: 'Bring clients back'        },
      { path: '/referrals',   label: 'Referrals',         matIcon: 'group_add',      desc: 'Word-of-mouth tracking'    },
      { path: '/automations', label: 'Automations',       matIcon: 'bolt',           desc: 'If-this-then-that rules'   },
      { path: '/templates',   label: 'Templates',         matIcon: 'description',    desc: 'Reusable messages'         },
      { path: '/portfolio',   label: 'Portfolio',         matIcon: 'photo_library',  desc: 'Showcase your work'        },
    ],
  },
  {
    id: 'messaging',
    label: 'Messaging',
    matIcon: 'forum',
    items: [
      { path: '/messaging', label: 'Overview',  matIcon: 'forum',      desc: 'WhatsApp + SMS in one place'  },
      { path: '/whatsapp',  label: 'WhatsApp',  matIcon: 'smartphone', desc: 'Business messaging',            gate: 'whatsapp' },
      { path: '/sms',       label: 'SMS',       matIcon: 'sms',        desc: 'Text reminders + replies'      },
    ],
  },
  {
    id: 'settings',
    label: 'Settings & Team',
    matIcon: 'settings',
    items: [
      { path: '/settings',          label: 'Settings',        matIcon: 'settings',           desc: 'Account preferences'          },
      { path: '/business',          label: 'Business',        matIcon: 'storefront',         desc: 'Name, logo & details'         },
      { path: '/integrations',      label: 'Integrations',    matIcon: 'extension',          desc: 'Connected apps'               },
      { path: '/pricing',           label: 'Plans',           matIcon: 'workspace_premium',  desc: 'Subscription & billing'       },
      { path: '/policies',          label: 'Policies',        matIcon: 'policy',             desc: 'Cancellation & terms'         },
      { path: '/portal',            label: 'Booking Page',    matIcon: 'open_in_browser',    desc: 'Public booking & magic links' },
      { path: '/team',              label: 'Team',            matIcon: 'group',              desc: 'Staff profiles',               gate: 'team_management' },
      { path: '/rota',              label: 'Staff Rota',      matIcon: 'calendar_view_week', desc: 'Weekly schedule',              gate: 'staff_rota' },
      { path: '/staff-performance', label: 'Performance',     matIcon: 'trending_up',        desc: 'Team analytics',               gate: 'staff_performance' },
      { path: '/locations',         label: 'Multi-Location',  matIcon: 'location_city',      desc: 'Branch management',            gate: 'multi_location' },
    ],
  },
];

const RECENT_KEY = 'florrie_recent_pages';
const RECENT_MAX = 6;

function getRecents() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); }
  catch { return []; }
}

function recordVisit(path, label, matIcon) {
  try {
    const recents = getRecents().filter(r => r.path !== path);
    recents.unshift({ path, label, matIcon });
    localStorage.setItem(RECENT_KEY, JSON.stringify(recents.slice(0, RECENT_MAX)));
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

export default function More() {
  const [search, setSearch] = useState('');
  const [expandedCats, setExpandedCats] = useState(new Set(['ai-team', 'daily', 'clients', 'messaging']));
  const [recents, setRecents] = useState(getRecents);
  const navigate = useNavigate();
  const location = useLocation();
  const { beautician } = useBeautician();
  const plan = beautician?.subscription_plan || 'trial';

  // iOS App Store compliance: strip /pricing from More on native iOS.
  const visibleCategories = useMemo(() => {
    if (!isIOSNative()) return CATEGORIES;
    return CATEGORIES.map(cat => ({
      ...cat,
      items: cat.items.filter(i => i.path !== '/pricing'),
    })).filter(cat => cat.items.length > 0);
  }, []);

  const filtered = useMemo(() => {
    if (!search.trim()) return visibleCategories;
    const q = search.toLowerCase();
    return visibleCategories.map(cat => ({
      ...cat,
      items: cat.items.filter(i =>
        i.label.toLowerCase().includes(q) ||
        (i.desc || '').toLowerCase().includes(q) ||
        cat.label.toLowerCase().includes(q)
      ),
    })).filter(cat => cat.items.length > 0);
  }, [search, visibleCategories]);

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
      <h1 style={S.heading}>More</h1>

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

      {!search && recents.length > 0 && (
        <div style={{ marginBottom: 20 }}>
          <div style={S.sectionLabel}>Recently visited</div>
          <div style={S.recentRow}>
            {recents.filter(r => r.path !== '/settings').map(r => (
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
                      onNav={() => handleNav(item.path, item.label, item.matIcon)}
                    />
                  ))}
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {!search && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {visibleCategories.map(cat => {
            const isExpanded = expandedCats.has(cat.id);

            return (
              <div key={cat.id} style={S.catCard}>
                <button onClick={() => toggleCat(cat.id)} style={S.catHeader}>
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

                {isExpanded && (
                  <div style={S.expandedBody}>
                    <div style={S.itemGrid}>
                      {cat.items.map(item => (
                        <ItemCard
                          key={item.path}
                          item={item}
                          locked={item.gate && !hasFeature(plan, item.gate)}
                          isActive={location.pathname === item.path}
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

function ItemCard({ item, locked, isActive, onNav }) {
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
        <MIcon name={item.matIcon} size={22} color={'#92405e'} style={{ opacity: isActive ? 1 : 0.75 }} />
        {locked && (
          <span style={S.lockBadge}>
            {(getRequiredPlan(item.gate) || 'PRO').toUpperCase()}
          </span>
        )}
      </div>
      <span style={S.itemLabel}>{item.label}</span>
      {item.desc && <span style={S.itemDesc}>{item.desc}</span>}
    </button>
  );
}

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
  heading: {
    fontSize: 22,
    fontWeight: 700,
    fontFamily: "'Noto Serif', Georgia, serif",
    fontStyle: 'italic',
    color: '#92405e',
    margin: '4px 0 16px',
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
    fontSize: 11, fontWeight: 700, color: '#1d1b19', lineHeight: 1.3, marginBottom: 2,
  },
  itemDesc: {
    fontSize: 9.5, color: '#B5AFA8', lineHeight: 1.35, fontWeight: 400,
  },
  lockBadge: {
    fontSize: 8, fontWeight: 700,
    background: 'linear-gradient(135deg, #745a27, #fedb9b)',
    color: '#fff', padding: '2px 5px', borderRadius: 5,
    letterSpacing: '0.05em',
  },
};
