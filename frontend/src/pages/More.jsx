import { useState, useMemo, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useBeautician } from '../lib/supabase.js';
import { hasFeature, getRequiredPlan } from '../lib/subscription.js';
import { isIOSNative } from '../lib/platform.js';
import Icon, { iconName } from '../components/ui/Icon';

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
    id: 'daily',
    label: 'Daily',
    matIcon: 'wb_sunny',
    items: [
      { path: '/inbox',          label: 'Inbox',            matIcon: 'forum',                  desc: 'Every client message'         },
      { path: '/outbox',         label: 'Outbox',           matIcon: 'outbox',                 desc: 'Waiting on your yes or no'    },
      { path: '/clients',        label: 'Clients',          matIcon: 'people',                 desc: 'All client profiles'          },
      { path: '/money',          label: 'Money',            matIcon: 'account_balance_wallet', desc: 'Revenue dashboard'            },
      { path: '/calendar/week',  label: 'Calendar',         matIcon: 'calendar_month',         desc: 'Your week and days'           },
      { path: '/waitlist-pro',   label: 'Waitlist',         matIcon: 'history',                desc: 'Manage waiting clients'       },
      { path: '/end-of-day',     label: 'End of Day',       matIcon: 'nightlight',             desc: 'Cash-up and close'            },
      { path: '/hours',          label: 'Hours and Time Off', matIcon: 'beach_access',         desc: 'Holidays and closures'        },
      { path: '/notifications',  label: 'Notifications',    matIcon: 'notifications',          desc: 'Alerts and reminders'         },
    ],
  },
  {
    id: 'setup',
    label: 'Setup',
    matIcon: 'checklist',
    items: [
      { path: '/setup',              label: 'Setup guide',       matIcon: 'checklist',       desc: 'Everything in one place'        },
      { path: '/settings',           label: 'Settings',          matIcon: 'settings',        desc: 'Hours, payments, preferences'   },
      { path: '/whatsapp',           label: 'WhatsApp',          matIcon: 'smartphone',      desc: 'Business messaging',            gate: 'whatsapp' },
      { path: '/sms',                label: 'SMS',               matIcon: 'sms',             desc: 'Text reminders and replies'     },
      { path: '/whatsapp/templates', label: 'Message templates', matIcon: 'description',     desc: 'What Florrie sends, signed as you' },
      { path: '/portal',             label: 'Booking Page',      matIcon: 'open_in_browser', desc: 'Your public booking link'       },
      { path: '/automations',        label: 'Automations',       matIcon: 'bolt',            desc: 'If-this-then-that rules'        },
      { path: '/knowledge',          label: "Florrie's knowledge", matIcon: 'menu_book',     desc: 'What Florrie can answer from your own notes' },
      { path: '/pricing',            label: 'Plans',             matIcon: 'workspace_premium', desc: 'Subscription and billing'     },
    ],
  },
  {
    id: 'clients',
    label: 'Clients',
    matIcon: 'people',
    items: [
      { path: '/import',         label: 'Import',          matIcon: 'upload',          desc: 'Bring your client list across' },
      { path: '/reviews',        label: 'Feedback',        matIcon: 'reviews',         desc: 'Reviews and responses'         },
      { path: '/memberships',    label: 'Memberships',     matIcon: 'card_membership', desc: 'Recurring packages'            },
      { path: '/loyalty',        label: 'Loyalty',         matIcon: 'loyalty',         desc: 'Points and rewards',            gate: 'loyalty' },
    ],
  },
  {
    id: 'treatments',
    label: 'Treatments',
    matIcon: 'spa',
    items: [
      { path: '/treatments',     label: 'Treatments',      matIcon: 'spa',                  desc: 'Services and prices'           },
      { path: '/addons',         label: 'Add-ons',         matIcon: 'add_circle',           desc: 'Bolt-on extras'                },
      { path: '/price-list',     label: 'Price List',      matIcon: 'format_list_bulleted', desc: 'Public pricing page'           },
      { path: '/aftercare',      label: 'Aftercare',       matIcon: 'self_care',            desc: 'Post-treatment messages',       gate: 'aftercare' },
    ],
  },
  {
    id: 'compliance',
    label: 'Protection',
    matIcon: 'verified_user',
    items: [
      { path: '/compliance',          label: 'Guardian',      matIcon: 'verified_user', desc: 'Patch tests and consent'     },
      { path: '/patch-tests',         label: 'Patch Tests',   matIcon: 'vaccines',      desc: 'UK compliance tracking'      },
      { path: '/consultation-forms',  label: 'Form Builder',  matIcon: 'assignment',    desc: 'Consent and intake forms'    },
      { path: '/photo-consent',       label: 'Photo Consent', matIcon: 'photo_camera',  desc: 'Before and after consent'    },
    ],
  },
  {
    id: 'money',
    label: 'Money',
    matIcon: 'payments',
    items: [
      { path: '/analytics',     label: 'Analytics',        matIcon: 'analytics',   desc: 'Performance and reports'   },
      { path: '/expenses',      label: 'Expenses',         matIcon: 'receipt_long', desc: 'Track outgoings'          },
      { path: '/packages',      label: 'Training',         matIcon: 'school',       desc: 'Sell courses and masterclasses' },
      { path: '/deposits',      label: 'Deposits',         matIcon: 'savings',     desc: 'Held payments'             },
      { path: '/vouchers',      label: 'Vouchers',         matIcon: 'card_giftcard', desc: 'Gift vouchers'           },
      { path: '/promos',        label: 'Promo Codes',      matIcon: 'local_offer', desc: 'Discount codes'            },
      { path: '/cancellations', label: 'Cancellations',    matIcon: 'event_busy',  desc: 'No-shows and late cancels' },
    ],
  },
  {
    id: 'marketing',
    label: 'Marketing',
    matIcon: 'campaign',
    items: [
      { path: '/content',     label: 'Content Autopilot', matIcon: 'auto_fix_high', desc: 'Captions in your voice',    gate: 'content_autopilot' },
      { path: '/campaigns',   label: 'Campaigns',         matIcon: 'mail',          desc: 'Email and SMS blasts',      gate: 'campaigns' },
      { path: '/rebook',      label: 'Rebook',            matIcon: 'replay',        desc: 'Bring clients back'         },
    ],
  },
  {
    id: 'team',
    label: 'Team',
    matIcon: 'group',
    items: [
      { path: '/team',              label: 'Team',            matIcon: 'group',              desc: 'Staff profiles',    gate: 'team_management' },
      { path: '/rota',              label: 'Staff Rota',      matIcon: 'calendar_view_week', desc: 'Weekly schedule',   gate: 'staff_rota' },
      { path: '/staff-performance', label: 'Performance',     matIcon: 'trending_up',        desc: 'Team analytics',    gate: 'staff_performance' },
      { path: '/locations',         label: 'Multi-Location',  matIcon: 'location_city',      desc: 'Branch management', gate: 'multi_location' },
    ],
  },
];

/*
 * PARKED from the menu 2026-06-10 (pages still live at their URLs, nothing
 * deleted; restore by adding the line back).
 *
 * Since Dashboard was archived these have NO inbound link anywhere in the app,
 * not even a search hit: the old SpotlightSearch index was the last thing
 * pointing at them and it went with Dashboard. They are reachable by typing the
 * URL and nothing else. That is fine for the ones whose job moved elsewhere
 * (/integrations is duplicated by the connection cards in Settings), but if any
 * of them is ever needed again, it needs a line in CATEGORIES above, not a
 * search index:
 *   /messaging (Overview), /business (Business), /templates (internal copy
 *   library, replaced by /whatsapp/templates in the menu), /integrations,
 *   /checklist (daily opening), /ai-insights (Biz), /client-intel (Client),
 *   /smart-schedule, /churn, /segments, /tags, /notes,
 *   /inventory, /referrals, /portfolio
 */

const RECENT_KEY = 'florrie_recent_pages';
const RECENT_MAX = 6;

// Only pages still in the catalogue count as recents - old localStorage
// entries otherwise resurrect parked pages (Integrations, Overview, Notes)
// as chips pointing at retired screens.
const CATALOGUE_PATHS = new Set(CATEGORIES.flatMap(c => c.items.map(i => i.path)));

function getRecents() {
  try {
    const all = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return all.filter(r => CATALOGUE_PATHS.has(r.path));
  }
  catch { return []; }
}

function recordVisit(path, label, matIcon) {
  try {
    const recents = getRecents().filter(r => r.path !== path);
    recents.unshift({ path, label, matIcon });
    localStorage.setItem(RECENT_KEY, JSON.stringify(recents.slice(0, RECENT_MAX)));
  } catch {}
}


export default function More() {
  const [search, setSearch] = useState('');
  const [expandedCats, setExpandedCats] = useState(new Set(['daily', 'setup']));
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
        <Icon name={iconName('search')} size={18} inline style={S.searchIcon} />
        <input
          type="text"
          placeholder="Search features…"
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={S.searchInput}
        />
        {search && (
          <button onClick={() => setSearch('')} style={S.searchClear}>
            <Icon name={iconName('close')} size={14} inline />
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
                <Icon name={iconName(r.matIcon || 'star')} size={14} inline color="#92405e" />
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
              <Icon name={iconName('search_off')} size={36} inline style={{ color: 'var(--border)', display: 'block', marginBottom: 8 }} />
              <p style={{ margin: 0, color: 'var(--text-muted)', fontSize: 14 }}>No results for "{search}"</p>
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
                    <Icon name={iconName(cat.matIcon)} size={20} inline color="rgba(146,64,94,0.65)" />
                    <span style={S.catLabel}>{cat.label}</span>
                  </div>
                  <Icon name={iconName(isExpanded ? 'expand_less' : 'expand_more')} size={20} inline color="#B5AFA8" />
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
      style={{ ...S.item,
        ...(isActive ? S.itemActive : {}),
        ...(locked ? { opacity: 0.55 } : {}),
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', width: '100%', marginBottom: 10 }}>
        <Icon name={iconName(item.matIcon)} size={22} inline color={'#92405e'} style={{ opacity: isActive ? 1 : 0.75 }} />
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
    minHeight: 'var(--shell-viewport)',
    background: 'var(--bg, #FBF6F1)',
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    padding: '16px 16px var(--scroll-pad-bottom)',
    maxWidth: 480,
    margin: '0 auto',
    color: '#1d1b19',
  },
  heading: {
    fontSize: 26,
    fontWeight: 600,
    fontFamily: "'Playfair Display', Georgia, serif",
    fontStyle: 'italic',
    color: 'var(--text-primary, #241B17)',
    margin: '12px 0 16px',
    letterSpacing: '-0.01em',
  },

  searchWrap: { position: 'relative', marginBottom: 20 },
  searchIcon: {
    position: 'absolute', left: 14, top: '50%',
    transform: 'translateY(-50%)', color: 'var(--text-muted)', pointerEvents: 'none',
  },
  searchInput: {
    width: '100%',
    padding: '12px 36px 12px 42px',
    borderRadius: 16,
    border: 'none',
    background: 'var(--tone-2, #f6e7dd)',
    fontSize: 14,
    fontFamily: 'inherit',
    color: 'var(--text-primary, #241B17)',
    outline: 'none',
    boxSizing: 'border-box',
  },
  searchClear: {
    position: 'absolute', right: 10, top: '50%',
    transform: 'translateY(-50%)',
    background: '#f3ede9', border: 'none', borderRadius: 8,
    width: 22, height: 22, color: 'var(--text-muted)', cursor: 'pointer',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  },

  sectionLabel: {
    fontSize: 10, fontWeight: 700, color: 'var(--text-muted)',
    textTransform: 'uppercase', letterSpacing: '0.08em',
    marginBottom: 8,
  },
  recentRow: {
    display: 'flex', gap: 8, overflowX: 'auto',
    scrollbarWidth: 'none', paddingBottom: 2,
  },
  recentChip: {
    display: 'flex', alignItems: 'center', gap: 6,
    padding: '8px 14px', minHeight: 34, borderRadius: 999,
    border: 'none', background: 'var(--tone-2, #f6e7dd)',
    cursor: 'pointer', fontFamily: 'inherit',
    flexShrink: 0, whiteSpace: 'nowrap',
    WebkitTapHighlightColor: 'transparent',
  },
  recentLabel: { fontSize: 12, fontWeight: 600, color: 'var(--text-secondary, #574A42)' },

  emptySearch: {
    display: 'flex', flexDirection: 'column', alignItems: 'center',
    padding: '40px 16px', textAlign: 'center',
  },

  catCard: {
    background: 'var(--tone-1, #fbf1ea)',
    borderRadius: 20,
    border: 'none',
    overflow: 'hidden',
  },
  catHeader: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
    width: '100%', background: 'none', border: 'none',
    cursor: 'pointer', padding: '14px 16px',
    fontFamily: 'inherit', textAlign: 'left',
    WebkitTapHighlightColor: 'transparent',
  },
  catLabel: {
    fontSize: 14, fontWeight: 700, color: 'var(--text-primary, #241B17)',
  },
  expandedBody: {
    padding: '2px 12px 14px',
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
    minHeight: 44,
    borderRadius: 14,
    border: 'none',
    background: 'var(--bg, #FBF6F1)',
    cursor: 'pointer',
    fontFamily: 'inherit',
    textAlign: 'left',
    transition: 'background 0.12s, transform 0.1s',
    WebkitTapHighlightColor: 'transparent',
  },
  itemActive: {
    background: 'var(--accent-wash, #FBF2F5)',
    boxShadow: 'inset 0 0 0 1.5px var(--accent, #92405e)',
  },
  itemLabel: {
    fontSize: 12.5, fontWeight: 700, color: 'var(--text-primary, #241B17)', lineHeight: 1.3, marginBottom: 2,
  },
  itemDesc: {
    fontSize: 11, color: 'var(--text-muted, #6B5D54)', lineHeight: 1.35, fontWeight: 400,
  },
  lockBadge: {
    fontSize: 9, fontWeight: 700,
    background: 'linear-gradient(135deg, #745a27, #fedb9b)',
    color: '#fff', padding: '2px 6px', borderRadius: 5,
    letterSpacing: '0.05em',
  },
};
