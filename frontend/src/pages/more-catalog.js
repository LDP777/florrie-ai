// Shared catalogue keeps search, recent links and category navigation in sync.
export const MORE_CATEGORIES = [
  { id: 'appointments', label: 'Appointments', desc: 'Plan your diary and close your day', matIcon: 'calendar_month', items: [
    { path: '/calendar/week',  label: 'Calendar',         matIcon: 'calendar_month',         desc: 'Your week and days'           },
    { path: '/waitlist-pro',   label: 'Waitlist',         matIcon: 'history',                desc: 'Manage waiting clients'       },
    { path: '/hours',          label: 'Hours & time off', matIcon: 'beach_access',         desc: 'Manage holidays and closures'        , keywords: 'opening hours availability vacation' },
    { path: '/cancellations', label: 'Cancellations',    matIcon: 'event_busy',  desc: 'No-shows and late cancels' },
    { path: '/end-of-day',     label: 'End of Day',       matIcon: 'nightlight',             desc: 'Cash-up and close'            },
    { path: '/notifications',  label: 'Notifications',    matIcon: 'notifications',          desc: 'Alerts and reminders'         },
  ] },
  { id: 'care', label: 'Client care', desc: 'Profiles, forms and treatment checks', matIcon: 'verified_user', items: [
    { path: '/clients',        label: 'Clients',          matIcon: 'people',                 desc: 'All client profiles'          },
    { path: '/compliance',          label: 'Client checks',      matIcon: 'verified_user', desc: 'Review patch tests, forms and consent'     , keywords: 'guardian protection safety compliance' },
    { path: '/consultation-forms',  label: 'Consultation forms',  matIcon: 'assignment',    desc: 'Build and send intake and consent forms'    , keywords: 'form builder consultation questionnaire medical history' },
    { path: '/patch-tests',         label: 'Patch tests',   matIcon: 'vaccines',      desc: 'Record tests and review due dates'      , keywords: 'allergy reaction protection safety compliance' },
    { path: '/photo-consent',       label: 'Photo consent', matIcon: 'photo_camera',  desc: 'Record permission for client photos'    , keywords: 'photographs before after protection compliance' },
    { path: '/aftercare',      label: 'Aftercare',       matIcon: 'self_care',            desc: 'Manage post-treatment guidance',       gate: 'aftercare' , keywords: 'follow up treatment instructions' },
    { path: '/import',         label: 'Import clients',          matIcon: 'upload',          desc: 'Bring your client list across' , keywords: 'upload csv spreadsheet' },
  ] },
  { id: 'messages', label: 'Messages', desc: 'Conversations and sending preferences', matIcon: 'forum', items: [
    { path: '/inbox',          label: 'Inbox',            matIcon: 'forum',                  desc: 'Every client message'         },
    { path: '/outbox',         label: 'Drafts & approvals',           matIcon: 'outbox',                 desc: 'Review messages before they send'    , keywords: 'outbox pending yes no' },
    { path: '/whatsapp',           label: 'WhatsApp',          matIcon: 'smartphone',      desc: 'Business messaging',            gate: 'whatsapp' },
    { path: '/sms',                label: 'SMS',               matIcon: 'sms',             desc: 'Text reminders and replies'     , gate: 'sms' },
    { path: '/whatsapp/templates', label: 'Message templates', matIcon: 'description',     desc: 'Manage your WhatsApp templates' , keywords: 'whatsapp replies messages' , gate: 'whatsapp' },
  ] },
  { id: 'services', label: 'Services & sales', desc: 'Treatments, extras and client offers', matIcon: 'spa', items: [
    { path: '/treatments',     label: 'Treatments',      matIcon: 'spa',                  desc: 'Services and prices'           },
    { path: '/addons',         label: 'Add-ons',         matIcon: 'add_circle',           desc: 'Bolt-on extras'                },
    { path: '/price-list',     label: 'Price List',      matIcon: 'format_list_bulleted', desc: 'Public pricing page'           },
    { path: '/packages',      label: 'Training courses',         matIcon: 'school',       desc: 'Sell courses and masterclasses' , keywords: 'training packages education' },
    { path: '/memberships',    label: 'Memberships',     matIcon: 'card_membership', desc: 'Recurring packages'            },
    { path: '/vouchers',      label: 'Vouchers',         matIcon: 'card_giftcard', desc: 'Gift vouchers'           },
    { path: '/promos',        label: 'Promo Codes',      matIcon: 'local_offer', desc: 'Discount codes'            },
    { path: '/loyalty',        label: 'Loyalty',         matIcon: 'loyalty',         desc: 'Points and rewards',            gate: 'loyalty' },
  ] },
  { id: 'money', label: 'Money & reports', desc: 'Income, expenses and performance', matIcon: 'payments', items: [
    { path: '/money',          label: 'Money',            matIcon: 'account_balance_wallet', desc: 'Income and revenue dashboard'            },
    { path: '/analytics',     label: 'Analytics',        matIcon: 'analytics',   desc: 'Performance and reports'   },
    { path: '/expenses',      label: 'Expenses',         matIcon: 'receipt_long', desc: 'Track outgoings'          },
    { path: '/deposits',      label: 'Deposits',         matIcon: 'savings',     desc: 'Held payments'             },
  ] },
  { id: 'marketing', label: 'Marketing', desc: 'Content, campaigns and returning clients', matIcon: 'campaign', items: [
    { path: '/content',     label: 'Content Autopilot', matIcon: 'auto_fix_high', desc: 'Draft captions in your voice',    gate: 'content_autopilot' , keywords: 'social media instagram posts' },
    { path: '/campaigns',   label: 'Campaigns',         matIcon: 'mail',          desc: 'Email and SMS blasts',      gate: 'campaigns' },
    { path: '/rebook',      label: 'Rebook',            matIcon: 'replay',        desc: 'Bring clients back'         },
    { path: '/reviews',        label: 'Reviews & feedback',        matIcon: 'reviews',         desc: 'Read client reviews and responses'         , keywords: 'feedback reputation' },
  ] },
  { id: 'team', label: 'Team', desc: 'People, rotas and locations', matIcon: 'group', items: [
    { path: '/team',              label: 'Team members',            matIcon: 'group',              desc: 'Manage staff profiles',    gate: 'team_management' , keywords: 'people staff' },
    { path: '/rota',              label: 'Staff rota',      matIcon: 'calendar_view_week', desc: 'Plan your weekly staff schedule',   gate: 'staff_rota' , keywords: 'team availability' },
    { path: '/staff-performance', label: 'Team performance',     matIcon: 'trending_up',        desc: 'Report availability and team tools',    gate: 'staff_performance' , keywords: 'staff analytics' },
    { path: '/locations',         label: 'Locations',  matIcon: 'location_city',      desc: 'Manage your branches', gate: 'multi_location' , keywords: 'multi-location branch' },
  ] },
  { id: 'setup', label: 'Business setup', desc: 'Booking, automation and preferences', matIcon: 'settings', items: [
    { path: '/setup',              label: 'Setup guide',       matIcon: 'checklist',       desc: 'Everything in one place'        },
    { path: '/settings',           label: 'Settings',          matIcon: 'settings',        desc: 'Hours, payments, preferences'   },
    { path: '/portal',             label: 'Booking page',      matIcon: 'open_in_browser', desc: 'Manage your public booking link'       , keywords: 'portal online bookings' },
    { path: '/automations',        label: 'Automations',       matIcon: 'bolt',            desc: 'Appointment follow-up sequences'        },
    { path: '/knowledge',          label: 'Florrie’s knowledge', matIcon: 'menu_book',     desc: 'Add the notes Florrie uses to answer clients' , keywords: 'knowledge business information ai' },
    { path: '/pricing',            label: 'Plans & billing',             matIcon: 'workspace_premium', desc: 'Manage your subscription'     , keywords: 'pricing subscription account' },
  ] },
];

export function getVisibleCategories(nativeIOS = false) {
  return MORE_CATEGORIES.map(category => ({
    ...category,
    items: category.items.filter(item => !nativeIOS || item.path !== '/pricing'),
  })).filter(category => category.items.length);
}

export function searchCategories(categories, query) {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return categories;
  return categories.map(category => ({
    ...category,
    items: category.items.filter(item => {
      const text = `${category.label} ${item.label} ${item.desc} ${item.keywords || ''} ${item.path}`.toLocaleLowerCase();
      return terms.every(term => text.includes(term));
    }),
  })).filter(category => category.items.length);
}

export const RECENT_KEY = 'florrie_recent_pages';
export function readRecentPages(categories, storage) {
  try {
    storage ??= globalThis.localStorage;
    const saved = JSON.parse(storage.getItem(RECENT_KEY) || '[]');
    if (!Array.isArray(saved)) return [];
    const catalogue = new Map(categories.flatMap(category => category.items).map(item => [item.path, item]));
    const seen = new Set();
    return saved.flatMap(entry => {
      const item = catalogue.get(entry?.path);
      if (!item || seen.has(item.path)) return [];
      seen.add(item.path);
      return [item];
    }).slice(0, 6);
  } catch { return []; }
}
