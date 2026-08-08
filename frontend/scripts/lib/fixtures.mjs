/**
 * Plausible API responses, so a screen can be checked in the state Ellie sees.
 *
 * Every visual check so far renders through react-dom/server, which runs one
 * pass and never runs an effect — so every data-driven screen is measured in
 * its LOADING state. That hole is not theoretical. The booking page's prices
 * were rendering in Playfair with old-style figures, on the public page Ellie's
 * clients pay through, and check-numerals reported all 79 pages clean: the
 * price list only exists after a fetch resolves, so the check never saw a
 * single price. Levi found it by looking at his phone.
 *
 * These are matched to the real response shapes, read off the routes in
 * backend/src/routes and the setState calls that consume them. Deliberately
 * awkward data — a long treatment name, a £1,225.30, a zero — because the
 * defects worth catching live in the awkward cases, not the tidy ones.
 */

const NOW = new Date('2026-08-08T09:00:00Z');
const at = (h, m = 0) => new Date(Date.UTC(2026, 7, 8, h, m)).toISOString();

export const SALON = {
  id: 'b1', slug: 'ellindigo', business_name: 'Ellindigo', first_name: 'Ellie',
  brand_colour: '#92405e', deposit_percent: 30, currency: 'GBP',
};

export const TREATMENTS = [
  { id: 't1', name: 'Signature brows', duration_minutes: 30, price_cents: 3000, category: 'Brows' },
  { id: 't2', name: 'Brow wax', duration_minutes: 20, price_cents: 1250, category: 'Brows' },
  // The long one. A name that wraps is where a price ends up misaligned.
  { id: 't3', name: 'Brow lamination maintenance – Hybrid dye', duration_minutes: 45, price_cents: 3500, category: 'Brows' },
  { id: 't4', name: 'Lash lift & tint', duration_minutes: 60, price_cents: 4500, category: 'Lashes' },
  // The four-figure one. Thousands separators and tabular alignment only go
  // wrong once a figure is wide enough to disagree with its neighbours.
  { id: 't5', name: 'Full set + aftercare bundle', duration_minutes: 120, price_cents: 122530, category: 'Lashes' },
  { id: 't6', name: 'Consultation', duration_minutes: 15, price_cents: 0, category: 'Lashes' },
];

const CLIENTS = [
  { first_name: 'Sarah', last_name: 'M', phone: '07700900001' },
  { first_name: 'Priya', last_name: 'K', phone: '07700900002' },
  { first_name: 'Jo', last_name: 'Whitfield-Barrowman', phone: '07700900003' },   // the long one
];

export const APPOINTMENTS = [
  { id: 'a1', starts_at: at(9, 30), status: 'completed', price_cents: 3000, clients: CLIENTS[0], treatments: TREATMENTS[0] },
  { id: 'a2', starts_at: at(11, 0), status: 'confirmed', price_cents: 4500, clients: CLIENTS[1], treatments: TREATMENTS[3] },
  { id: 'a3', starts_at: at(14, 30), status: 'confirmed', price_cents: 122530, clients: CLIENTS[2], treatments: TREATMENTS[4] },
];

const ROWS = [
  { id: 'r1', created_at: at(8, 10), kind: 'rebook_nudge', summary: 'Nudged Priya to rebook', client_name: 'Priya K' },
  { id: 'r2', created_at: at(8, 40), kind: 'gap_fill', summary: 'Offered Tuesday 2pm to 3 clients', client_name: null },
];

/**
 * URL -> body. Matched loosely on path so query strings and slugs do not have
 * to be spelled out. Anything unmatched returns {} rather than 404, because a
 * page should be checkable even when a fixture for one of its calls is missing.
 */
const ROUTES = [
  [/\/api\/booking\/[^/]+\/page/, () => ({ salon: SALON, treatments: TREATMENTS, addOns: [] })],
  [/\/api\/products\/public/, () => ({ products: [] })],
  [/\/api\/appointments/, () => ({ data: APPOINTMENTS, count: APPOINTMENTS.length })],
  [/\/api\/agents\/counts/, () => ({ approvals: 2, inbox: 1, handledToday: 4 })],
  [/\/api\/activity\/feed/, () => ({ rows: ROWS })],
  [/\/api\/activity\/stats/, () => ({ handled_total: 128, hours_saved: 9 })],
  [/\/api\/outbound\/pending/, () => ({ pending: [{ id: 'p1', body: 'Hi Sarah, fancy your usual Thursday?' }] })],
  [/\/api\/escalations/, () => ({ escalations: [] })],
  [/\/api\/florrie-thinks/, () => ({ cards: [] })],
  // The tax-year card. Deliberately wide values: a four-figure income against a
  // two-figure expense is the exact pair that collided on Ellie's screen, and a
  // six-figure income is what a fixed gap tuned to today's numbers would fail on.
  [/\/api\/money\/year-to-date/, () => ({
    income_cents: 1000960, expenses_cents: 6571, profit_cents: 994389,
    prior: { income_cents: 0, expenses_cents: 0, profit_cents: 0 },
    tax_year: '2026-27', from: '2026-04-06', to: '2026-08-08',
  })],
  [/\/api\/money\/reports/, () => ({ rows: [], totals: { income_cents: 1000960, expenses_cents: 6571 } })],
  [/\/api\/money\/ledger/, () => ({ rows: [
    { id: 'l1', date: '2026-08-07', kind: 'income', amount_cents: 3000, vendor: null, description: 'Signature brows' },
    { id: 'l2', date: '2026-08-06', kind: 'expense', amount_cents: 1899, vendor: 'Salon Supplies Ltd', category: 'products' },
  ] })],
  [/\/api\/money/, () => ({ takings_cents: 122530, expenses_cents: 1899, profit_cents: 120631 })],
  [/\/api\/treatments/, () => ({ data: TREATMENTS })],
  [/\/api\/clients/, () => ({ data: CLIENTS.map((c, i) => ({ id: `c${i}`, ...c, total_spend_cents: 12000 * (i + 1) })) })],
];

export function bodyFor(url) {
  for (const [re, make] of ROUTES) if (re.test(url)) return make();
  return FALLBACK;
}

/**
 * The catch-all used to be `{}`, and that is worse than useless: a page that
 * does `data.rows.filter(...)` on it dies with "C.filter is not a function"
 * before it renders a pixel, so a missing fixture looks exactly like a broken
 * screen. Supabase REST returns an ARRAY, and most of this app's own routes
 * return { data } or { rows }. Answering with all three shapes at once means an
 * unmatched call renders empty rather than throwing.
 */
const FALLBACK = Object.assign([], { data: [], rows: [], items: [], count: 0 });

/** Installed inside the page, so the app's own fetch calls resolve. */
export function fetchStubSource() {
  return `
    const ROUTES = ${JSON.stringify(ROUTES.map(([re]) => re.source))};
    const BODIES = ${JSON.stringify(ROUTES.map(([, make]) => make()))};
    window.fetch = (input) => {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      // Same reasoning as FALLBACK above: an unmatched call must render empty,
      // not throw, or a missing fixture is indistinguishable from a bug.
      let body = { data: [], rows: [], items: [], count: 0 };
      for (let i = 0; i < ROUTES.length; i++) {
        if (new RegExp(ROUTES[i]).test(url)) { body = BODIES[i]; break; }
      }
      return Promise.resolve(new Response(JSON.stringify(body), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    };
  `;
}

export const FIXTURE_NOW = NOW;
