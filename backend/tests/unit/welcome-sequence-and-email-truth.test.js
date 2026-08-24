/**
 * THE WELCOME EMAIL THAT HAS NEVER BEEN SENT, AND THE ONE THAT WAS WRONG.
 *
 * routes/auth.js has always called triggerSequence('welcome', ...) from
 * POST /api/auth/signup. Nothing has ever called POST /api/auth/signup: the
 * browser creates the beauticians row itself, straight through Supabase, from
 * lib/supabase.js. So the trigger sat behind a door with no handle and not one
 * real signup has ever received a welcome email.
 *
 * The fix is POST /api/auth/ensure-profile: the browser asks the API for its
 * row on first sign-in, the API creates it if it is genuinely new, and the
 * welcome sequence starts there. The three properties that matter are pinned
 * below, because each of them is a way this goes wrong in production:
 *
 *   fires at all         a new account gets welcome_day0 immediately
 *   fires exactly once   a second call schedules nothing new
 *   never for an existing user  an account that already has a row gets no email,
 *                        including when it lost an insert race (23505)
 *
 * The rest of the file grades what the emails actually SAY, because the one
 * email that did fire was wrong in ways a customer can see: a price of £19 for
 * a £29 product, a "choose a plan" button pointing at /settings#billing (not a
 * route: Settings reads ?section= and has no billing tab), a welcome button
 * pointing at /dashboard (not a route: the app home is "/"), a testimonial
 * attributed to the pilot user in mail to other customers, and a list of what
 * the paywall pauses that left out most of what it pauses.
 */
process.env.APP_URL = 'https://app.florrie.test';

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import { createServer } from 'http';

/* ------------------------------------------------------------------- fake --
 * Enough PostgREST to run the two modules under test. Errors are RESOLVED,
 * never thrown, exactly as postgrest-js does it.
 */
const db = { beauticians: [], email_sends: [] };
let nextId = 1;
/** Set to make the next beauticians insert lose a race, like a unique index. */
let insertConflict = false;

function builder(table) {
  const filters = [];
  let pending = null;
  let limit = null;
  const rows = () => (db[table] || []).filter(r => filters.every(f => f(r)));
  const settle = () => {
    if (pending?.op === 'insert') {
      if (table === 'beauticians' && insertConflict) {
        // The other tab won between our lookup and our insert: its row lands
        // now, and the unique index on auth_id rejects ours.
        insertConflict = false;
        db.beauticians.push({ id: 'beauticians_race', created_at: new Date().toISOString(), ...pending.payload });
        return { data: null, error: { code: '23505', message: 'duplicate key value violates unique constraint "beauticians_auth_id_key"' } };
      }
      const row = { id: `${table}_${nextId++}`, created_at: new Date().toISOString(), ...pending.payload };
      db[table].push(row);
      return { data: [row], error: null };
    }
    if (pending?.op === 'update') {
      const hit = rows();
      for (const r of hit) Object.assign(r, pending.payload);
      return { data: hit, error: null };
    }
    const out = rows();
    return { data: limit ? out.slice(0, limit) : out, error: null };
  };
  const b = {
    select() { return b; },
    insert(p) { pending = { op: 'insert', payload: p }; return b; },
    update(p) { pending = { op: 'update', payload: p }; return b; },
    eq(c, v) { filters.push(r => r[c] === v); return b; },
    in(c, vals) { filters.push(r => vals.includes(r[c])); return b; },
    lte(c, v) { filters.push(r => String(r[c] ?? '') <= String(v)); return b; },
    gte(c, v) { filters.push(r => String(r[c] ?? '') >= String(v)); return b; },
    lt(c, v) { filters.push(r => String(r[c] ?? '') < String(v)); return b; },
    order() { return b; },
    limit(n) { limit = n; return b; },
    single() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: (o.data || []).length ? null : { code: 'PGRST116', message: 'no rows' } }); },
    maybeSingle() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    then(res, rej) { return Promise.resolve(settle()).then(res, rej); },
  };
  return b;
}

/** Whoever the next Authorization header will resolve to. */
let authUser = null;

vi.mock('../../src/config.js', () => ({
  supabase: {
    from: builder,
    auth: { admin: { createUser: async () => ({ data: null, error: { message: 'not used here' } }), deleteUser: async () => ({}) } },
  },
  supabaseAnon: {
    auth: {
      getUser: async (token) => (token === 'good-token' && authUser)
        ? { data: { user: authUser }, error: null }
        : { data: {}, error: { message: 'invalid token' } },
    },
  },
}));

const sent = [];
vi.mock('../../src/services/notifications.js', () => ({
  sendEmail: async (payload) => { sent.push(payload); return true; },
  sendMessage: async () => ({ channel: 'sms' }),
}));

const { default: authRouter } = await import('../../src/routes/auth.js');
const { triggerSequence, processEmailQueue } = await import('../../src/services/email-sequences.js');

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);
const server = createServer(app);
await new Promise(r => server.listen(0, r));
const base = `http://127.0.0.1:${server.address().port}`;

const ensureProfile = (token) => fetch(`${base}/api/auth/ensure-profile`, {
  method: 'POST',
  headers: token ? { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } : { 'Content-Type': 'application/json' },
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

const NEW_USER = {
  id: 'auth-uuid-1',
  email: 'jo@newsalon.co.uk',
  user_metadata: { first_name: 'Jo', last_name: 'Barnes' },
};

beforeEach(() => {
  db.beauticians = [];
  db.email_sends = [];
  sent.length = 0;
  nextId = 1;
  insertConflict = false;
  authUser = NEW_USER;
});

/** Let the fire-and-forget triggerSequence() finish. */
const settle = () => new Promise(r => setTimeout(r, 30));

describe('the welcome sequence fires on a real signup', () => {
  it('creates the profile the browser used to create itself', async () => {
    const res = await ensureProfile('good-token');

    expect(res.status).toBe(201);
    expect(res.body.created).toBe(true);
    expect(db.beauticians).toHaveLength(1);
    expect(db.beauticians[0].auth_id).toBe('auth-uuid-1');
    expect(db.beauticians[0].email).toBe('jo@newsalon.co.uk');
    // The trial clock has to start here, or the account is on a trial that
    // never ends and is never asked to pay.
    expect(db.beauticians[0].trial_ends_at).toBeTruthy();
  });

  it('sends welcome_day0 and schedules the rest', async () => {
    await ensureProfile('good-token');
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('jo@newsalon.co.uk');
    // Every email in the sequence is on the books, not just the one that went.
    const keys = db.email_sends.map(e => e.email_key.replace(/_beauticians_\d+$/, ''));
    expect(keys).toContain('welcome_day0');
    expect(keys).toContain('welcome_day3');
    expect(keys).toContain('welcome_day7');
    expect(db.email_sends.find(e => e.email_key.startsWith('welcome_day0')).status).toBe('sent');
  });

  it('never sends a second welcome to the same account', async () => {
    await ensureProfile('good-token');
    await settle();
    const first = db.email_sends.length;

    const again = await ensureProfile('good-token');
    await settle();

    expect(again.status).toBe(200);
    expect(again.body.created).toBe(false);
    expect(db.beauticians).toHaveLength(1);
    expect(db.email_sends).toHaveLength(first);
    expect(sent).toHaveLength(1);
  });

  it('sends nothing to an account that already existed before this endpoint did', async () => {
    // Ellie: signed up long before ensure-profile, row created by the browser.
    db.beauticians.push({ id: 'beauticians_99', auth_id: 'auth-uuid-1', email: 'ellie@ellindigo.co.uk', first_name: 'Ellie' });

    const res = await ensureProfile('good-token');
    await settle();

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);
    expect(sent).toHaveLength(0);
    expect(db.email_sends).toHaveLength(0);
  });

  it('loses an insert race without welcoming the winner twice', async () => {
    // Two tabs open on the same brand new account. Both look, both see
    // nothing, both insert. The lookup below misses, the insert loses.
    insertConflict = true;

    const res = await ensureProfile('good-token');
    await settle();

    // A success for the caller, and silent: the tab that WON the race is the
    // one that owns the welcome email, and it is not this one.
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(false);
    expect(res.body.beautician.email).toBe('jo@newsalon.co.uk');
    expect(db.beauticians).toHaveLength(1);
    expect(sent).toHaveLength(0);
    expect(db.email_sends).toHaveLength(0);
  });

  it('refuses a request with no token, and one with a bad token', async () => {
    expect((await ensureProfile(null)).status).toBe(401);
    expect((await ensureProfile('nonsense')).status).toBe(401);
    expect(db.beauticians).toHaveLength(0);
  });
});

/* ------------------------------------------------------- what they say ---- */

async function bodyOf(subjectMatch) {
  const hit = sent.find(e => subjectMatch.test(e.subject));
  expect(hit, `no email matching ${subjectMatch}`).toBeTruthy();
  return `${hit.html}\n${hit.text}`;
}

describe('the emails point at routes that exist', () => {
  beforeEach(async () => {
    db.beauticians.push({
      id: 'b1', auth_id: 'a1', email: 'jo@newsalon.co.uk', first_name: 'Jo',
      business_name: 'Jo Brows', booking_slug: 'jo-brows',
      subscription_plan: 'trial',
      trial_ends_at: new Date(Date.now() + 3 * 864e5).toISOString(),
    });
  });

  it('the welcome button opens the app, not /dashboard', async () => {
    await triggerSequence('welcome', 'b1');
    const body = await bodyOf(/welcome to florrie/i);

    expect(body).not.toContain('/dashboard');
    expect(body).toContain('https://app.florrie.test/');
  });

  it('the trial reminder quotes the real price and links to the real plans page', async () => {
    await triggerSequence('trial_expiring', 'b1');
    const body = await bodyOf(/ends in 3 days/i);

    expect(body).not.toContain('£19');
    expect(body).toContain('£29');
    // /settings#billing was read by nobody: Settings switches on ?section=,
    // and it has no billing section to switch to.
    expect(body).not.toContain('settings#billing');
    expect(body).toContain('https://app.florrie.test/pricing');
  });

  it('the trial reminder does not promise that only the AI pauses', async () => {
    await triggerSequence('trial_expiring', 'b1');
    const body = await bodyOf(/ends in 3 days/i);

    // The paywall (index.js) sits in front of clients, appointments, inbox,
    // money and the rest of her working surface, not just the AI.
    for (const surface of ['diary', 'clients', 'inbox', 'money']) {
      expect(body.toLowerCase()).toContain(surface);
    }
  });

  it('the trial-ended email says what is actually locked', async () => {
    await triggerSequence('trial_expiring', 'b1');
    // trial_expired is scheduled 72h out. Pretend those hours passed.
    const later = db.email_sends.find(e => e.email_key.startsWith('trial_expired'));
    later.send_at = new Date(Date.now() - 60_000).toISOString();
    await processEmailQueue();

    const body = await bodyOf(/trial has ended/i);
    expect(body).not.toContain('settings#billing');
    expect(body).toContain('https://app.florrie.test/pricing');
    for (const surface of ['diary', 'clients', 'inbox', 'money']) {
      expect(body.toLowerCase()).toContain(surface);
    }
    // The one thing that genuinely keeps working.
    expect(body.toLowerCase()).toContain('book');
  });

  it('every link in every welcome email is a route the app has', async () => {
    // The routes App.jsx serves that these emails are allowed to name.
    const REAL = ['https://app.florrie.test/', 'https://app.florrie.test/pricing',
      'https://app.florrie.test/settings?section=notifications', 'https://florrie.ai/book/'];
    await triggerSequence('welcome', 'b1');
    for (const email of db.email_sends) {
      email.send_at = new Date(Date.now() - 60_000).toISOString();
      email.status = 'pending';
    }
    await processEmailQueue();

    const hrefs = sent.flatMap(e => [...String(e.html).matchAll(/href="([^"]+)"/g)].map(m => m[1]))
      .filter(h => !h.startsWith('mailto:'));
    expect(hrefs.length).toBeGreaterThan(0);
    for (const href of hrefs) {
      expect(REAL.some(r => href.startsWith(r)), `${href} is not a route this app serves`).toBe(true);
    }
  });
});

describe('no testimonial we cannot stand behind', () => {
  it('the day 7 email carries no quote attributed to a named customer', async () => {
    db.beauticians.push({
      id: 'b1', auth_id: 'a1', email: 'jo@newsalon.co.uk', first_name: 'Jo',
      booking_slug: 'jo-brows', subscription_plan: 'trial',
    });
    await triggerSequence('welcome', 'b1');
    for (const email of db.email_sends) {
      email.send_at = new Date(Date.now() - 60_000).toISOString();
      email.status = 'pending';
    }
    await processEmailQueue();

    const all = sent.map(e => `${e.html}\n${e.text}`).join('\n');
    // The pilot user, quoted to other customers in a product email.
    expect(all).not.toMatch(/Ellie, Brow & Lash Specialist/i);
    expect(all).not.toMatch(/-\s*\w+,\s*(Manchester|Leeds|London)/);
    expect(all).not.toContain('what beauticians are saying');
  });
});
