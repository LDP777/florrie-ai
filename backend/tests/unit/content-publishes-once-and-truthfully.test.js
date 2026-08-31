/**
 * WHAT THE CONTENT STUDIO IS ALLOWED TO PUT ON A PUBLIC INSTAGRAM GRID.
 *
 * 31 August 2026, the night @ellindigo connected Instagram for the first time.
 * Everything on this page stopped being a mock-up that evening. Three of these
 * defects publish something wrong or something twice, and none of them is
 * recoverable by us: she has to go to Instagram and delete it herself.
 *
 *   1. NOTHING STOPPED THE SAME POST PUBLISHING TWICE. publishPost never
 *      looked at post.status or post.external_post_id, and the update that
 *      marks a post 'posted' had its error unread. A failed update, a restart
 *      mid-publish or a double tap left the row on 'approved', which the
 *      Drafts tab renders with a live "Approve & Post" button under it.
 *
 *   2. A PRIVATE REVIEW COULD BE QUOTED AS A TESTIMONIAL. planWeek selected
 *      five star reviews with no is_public filter, and the column has existed
 *      since migration 007. A review a client left privately, or one Ellie had
 *      deliberately unpublished, could be quoted in a caption by a machine.
 *
 *   3. DEAD PROMOS WERE BROADCAST. The promo query filtered on is_active only:
 *      an offer that expired in June, one that does not start until October
 *      and one whose last use was claimed on Tuesday were all equally eligible
 *      to be posted to her whole following. lib/promos.js has had
 *      getActivePromos, which gets this right, since Wire 5.
 *
 * The fake Supabase resolves with { data: null, error } for an unknown column,
 * exactly as PostgREST does, because two of the columns this file touches
 * arrive in migrations applied by hand.
 */
process.env.TZ = 'UTC';
process.env.ANTHROPIC_API_KEY = 'sk-test';

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';

// The night in question. planWeek reads the wall clock to build its suggested
// slots and getActivePromos reads it to decide what is live, so it is fixed.
const NOW = new Date('2026-08-31T21:40:00.000Z');   // Monday, in BST (22:40 local)
vi.useFakeTimers({ toFake: ['Date'] });
vi.setSystemTime(NOW);

/* ------------------------------------------------------------------ schema --
 *   content_posts  001, 035_content_streams,
 *                  20260831_backend025 (media_kind, failure_reason,
 *                  publish_claimed_at), 20260831_backend026 (gallery pair)
 *   reviews        007_all_features (is_public)
 *   promo_codes    011_promo_codes
 */
const BASE_COLUMNS = {
  beauticians: [
    'id', 'first_name', 'business_name', 'timezone', 'booking_slug',
    'tone_model', 'voice_profile', 'brand_color',
    'instagram_page_id', 'instagram_page_token',
  ],
  content_posts: [
    'id', 'beautician_id', 'image_url', 'caption', 'hashtags', 'platform',
    'post_type', 'status', 'approved_at', 'scheduled_for', 'posted_at',
    'likes', 'comments', 'shares', 'bookings_attributed', 'external_post_id',
    'created_at', 'stream_id',
    'media_kind', 'failure_reason', 'publish_claimed_at',
    'before_url', 'after_url', 'treatment_name',
  ],
  reviews: ['id', 'beautician_id', 'client_id', 'rating', 'comment', 'is_public', 'created_at'],
  promo_codes: [
    'id', 'beautician_id', 'code', 'discount_type', 'discount_value',
    'max_uses', 'current_uses', 'valid_from', 'valid_until', 'is_active', 'created_at',
  ],
  appointments: ['id', 'beautician_id', 'treatment_id', 'status', 'starts_at'],
  ai_actions: [
    'id', 'beautician_id', 'action_type', 'digital_employee', 'summary',
    'details', 'confidence', 'autonomous', 'client_id', 'outcome',
    'notification_sent', 'notification_text', 'created_at',
  ],
};

let COLUMNS = {};
const resetSchema = () => {
  COLUMNS = Object.fromEntries(Object.entries(BASE_COLUMNS).map(([t, c]) => [t, [...c]]));
};
resetSchema();

const db = { beauticians: [], content_posts: [], reviews: [], promo_codes: [], appointments: [], ai_actions: [] };
let idCounter = 0;
const nextId = (p) => `${p}_${++idCounter}`;

const undefinedColumn = (t, c) => ({ code: '42703', message: `column ${t}.${c} does not exist` });
const unknownWriteColumn = (t, c) => ({ code: 'PGRST204', message: `Could not find the '${c}' column of '${t}' in the schema cache` });

function splitTop(spec) {
  const out = [];
  let depth = 0, cur = '';
  for (const ch of String(spec)) {
    if (ch === '(') depth += 1;
    if (ch === ')') depth -= 1;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim()).filter(Boolean);
}
function parseSelect(table, spec) {
  if (!spec || spec === '*') return null;
  const known = COLUMNS[table];
  if (!known) return null;
  for (const item of splitTop(spec)) {
    const col = item.includes(':') ? item.split(':').pop().trim() : item;
    if (col === '*' || col.includes('(')) continue;
    if (!known.includes(col)) return undefinedColumn(table, col);
  }
  return null;
}
function parseWrite(table, payload) {
  const known = COLUMNS[table];
  if (!known) return null;
  for (const row of (Array.isArray(payload) ? payload : [payload])) {
    for (const col of Object.keys(row || {})) {
      if (!known.includes(col)) return unknownWriteColumn(table, col);
    }
  }
  return null;
}

function makeBuilder(table) {
  const filters = [];
  let pending = null, selectError = null, writeError = null;
  const matching = () => (db[table] || []).filter(r => filters.every(f => f(r)));
  const settle = () => {
    if (writeError) return { data: null, error: writeError, count: null };
    if (selectError) return { data: null, error: selectError, count: null };
    if (pending?.op === 'insert') {
      const payload = Array.isArray(pending.payload) ? pending.payload : [pending.payload];
      const created = payload.map(p => ({ id: nextId(table), created_at: new Date().toISOString(), ...p }));
      db[table].push(...created);
      return { data: created, error: null, count: created.length };
    }
    if (pending?.op === 'update') {
      const rows = matching();
      for (const r of rows) Object.assign(r, pending.payload);
      return { data: rows.map(r => ({ ...r })), error: null, count: rows.length };
    }
    const rows = matching();
    return { data: rows.map(r => ({ ...r })), error: null, count: rows.length };
  };
  const b = {
    select(spec = '*') { selectError = parseSelect(table, spec); return b; },
    insert(p) { pending = { op: 'insert', payload: p }; writeError = parseWrite(table, p); return b; },
    update(p) { pending = { op: 'update', payload: p }; writeError = parseWrite(table, p); return b; },
    eq(c, v) { filters.push(r => r[c] === v); return b; },
    neq(c, v) { filters.push(r => r[c] !== v); return b; },
    in(c, v) { filters.push(r => v.map(String).includes(String(r[c]))); return b; },
    is(c, v) { filters.push(r => (r[c] ?? null) === v); return b; },
    not(c) { filters.push(r => (r[c] ?? null) !== null); return b; },
    // PostgREST's `or(a.is.null,a.lt.X)`. Parsed rather than waved through,
    // because the publish claim IS an or() and a fake that ignores it would
    // report a claim working when it does not.
    or(expr) {
      const clauses = String(expr).split(',').map(part => {
        const [col, op, val] = part.split('.');
        if (op === 'is') return (r) => (r[col] ?? null) === (val === 'null' ? null : val);
        if (op === 'lt') return (r) => r[col] != null && String(r[col]) < val;
        if (op === 'gt') return (r) => r[col] != null && String(r[col]) > val;
        return () => false;
      });
      filters.push(r => clauses.some(fn => fn(r)));
      return b;
    },
    gte(c, v) { filters.push(r => String(r[c]) >= String(v)); return b; },
    lte(c, v) { filters.push(r => String(r[c]) <= String(v)); return b; },
    order() { return b; },
    limit() { return b; },
    maybeSingle() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    single() { const o = settle(); return Promise.resolve(o.error ? o : { data: (o.data || [])[0] || null, error: null }); },
    then(res, rej) { return Promise.resolve(settle()).then(res, rej); },
    catch(rej) { return Promise.resolve(settle()).catch(rej); },
  };
  return b;
}

vi.mock('../../src/config.js', () => ({ supabase: { from: (t) => makeBuilder(t) } }));

const logs = { warn: [], error: [], info: [] };
vi.mock('../../src/lib/logger.js', () => {
  const rec = (level) => (a, b) => { logs[level].push({ ctx: typeof a === 'object' ? a : {}, msg: typeof a === 'string' ? a : b }); };
  return { default: { warn: rec('warn'), error: rec('error'), info: rec('info'), debug: () => {} } };
});

/* ------------------------------------------------------------------ claude --
 * Every request is captured. What planWeek is ALLOWED TO SEE is the assertion
 * for two of the three defects here: a caption cannot quote a review the model
 * was never shown.
 */
const claudeCalls = [];
let claudeReply = '[]';
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    constructor() {
      this.messages = {
        create: async (req) => {
          claudeCalls.push(req);
          return { content: [{ text: typeof claudeReply === 'function' ? claudeReply(req) : claudeReply }] };
        },
      };
    }
  },
}));
vi.mock('../../src/lib/anti-slop.js', () => ({ ensureNoSlop: async (t) => t }));
vi.mock('../../src/services/voice-profile.js', () => ({ buildVoiceGuide: () => '' }));

/* ------------------------------------------------------------------- fetch -- */
const graphCalls = [];
let graph = {};
const ok = (body) => ({ ok: true, status: 200, json: async () => body });
vi.stubGlobal('fetch', async (input, init) => {
  const url = typeof input === 'string' ? input : input.url;
  graphCalls.push({ url, method: init?.method || 'GET' });
  for (const pattern of Object.keys(graph).sort((a, b) => b.length - a.length)) {
    if (url.includes(pattern)) { const r = await graph[pattern](url, init); return { ok: r.ok !== false, status: r.status || 200, json: async () => r.json ? r.json() : r.body }; }
  }
  return { ok: false, status: 404, json: async () => ({ error: { message: `no stub for ${url}` } }) };
});

const { publishPost, planWeek, generateCaption } = await import('../../src/services/content-autopilot.js');

afterAll(() => { vi.useRealTimers(); });

const IG_ID = '17841426032033812';
const PUBLIC_IMG = 'https://xyz.supabase.co/storage/v1/object/public/content-images/b-ellie/1.jpg';

function seedSalon(over = {}) {
  db.beauticians = [{
    id: 'b-ellie',
    first_name: 'Ellie',
    business_name: 'Ellindigo',
    timezone: 'Europe/London',
    booking_slug: 'ellindigo',
    instagram_page_id: IG_ID,
    instagram_page_token: 'IGQVJ-long-lived',
    ...over,
  }];
}
function seedPost(over = {}) {
  db.content_posts = [{
    id: 'post-1',
    beautician_id: 'b-ellie',
    caption: 'Fresh set of lashes on Sophie today.',
    hashtags: ['#lashlift'],
    image_url: PUBLIC_IMG,
    platform: 'instagram',
    post_type: 'before_after',
    status: 'draft',
    media_kind: 'feed',
    publish_claimed_at: null,
    external_post_id: null,
    ...over,
  }];
  return db.content_posts[0];
}
function stubHappyPublish(containerId = 'container-1', postId = 'ig-post-77') {
  graph[`${IG_ID}/media`] = () => ok({ id: containerId });
  graph[`graph.instagram.com/v21.0/${containerId}`] = () => ok({ status_code: 'FINISHED' });
  graph[`${IG_ID}/media_publish`] = () => ok({ id: postId });
}

beforeEach(() => {
  resetSchema();
  for (const k of Object.keys(db)) db[k] = [];
  logs.warn.length = 0; logs.error.length = 0; logs.info.length = 0;
  claudeCalls.length = 0;
  graphCalls.length = 0;
  graph = {};
  claudeReply = '[]';
  idCounter = 0;
  vi.setSystemTime(NOW);
});

/* =========================================================================== */
describe('a post reaches the grid once, or not at all', () => {
  it('does not call Meta at all for a post that is already posted', async () => {
    seedSalon();
    seedPost({ status: 'posted', external_post_id: 'ig-post-77', posted_at: '2026-08-30T18:30:00.000Z' });
    stubHappyPublish();

    const result = await publishPost('b-ellie', 'post-1');

    // Not one request. Not a container, not a status poll, not a publish.
    expect(graphCalls).toHaveLength(0);
    expect(result.already_posted).toBe(true);
    expect(result.instagramId).toBe('ig-post-77');
    // And the row is untouched: no second posted_at, no second approval.
    expect(db.content_posts[0].posted_at).toBe('2026-08-30T18:30:00.000Z');
  });

  it('refuses a post that carries an external id even when the status lagged', async () => {
    // The exact shape the unread error left behind: media_publish succeeded,
    // the status update did not, so the row says 'approved' and the Drafts tab
    // shows a live "Approve & Post" button over a post that is already live.
    seedSalon();
    seedPost({ status: 'approved', external_post_id: 'ig-post-88' });
    stubHappyPublish();

    const result = await publishPost('b-ellie', 'post-1');

    expect(graphCalls).toHaveLength(0);
    expect(result.published).toBe(true);
    expect(result.already_posted).toBe(true);
  });

  it('claims the post before it touches Meta, so a second run publishes nothing', async () => {
    seedSalon();
    seedPost();
    stubHappyPublish();

    const [first, second] = await Promise.all([
      publishPost('b-ellie', 'post-1'),
      publishPost('b-ellie', 'post-1'),
    ]);

    const publishes = graphCalls.filter(c => c.url.includes('media_publish'));
    expect(publishes).toHaveLength(1);
    expect([first.published, second.published].filter(Boolean)).toHaveLength(1);
    expect(db.content_posts[0].status).toBe('posted');
    expect(db.content_posts[0].external_post_id).toBe('ig-post-77');
  });

  it('shouts when the post is live and the row could not be told', async () => {
    // The one unread error on this page that leaves a duplicate waiting to
    // happen. The claim is deliberately NOT released here.
    seedSalon();
    const post = seedPost();
    stubHappyPublish();
    graph[`${IG_ID}/media_publish`] = () => {
      // Drop the column the success update needs, at the moment it is needed.
      COLUMNS.content_posts = COLUMNS.content_posts.filter(c => c !== 'external_post_id');
      return ok({ id: 'ig-post-99' });
    };

    const result = await publishPost('b-ellie', 'post-1');

    expect(result.published).toBe(true);
    expect(logs.error.some(l => /PUBLISHED TO INSTAGRAM BUT COULD NOT MARK THE POST POSTED/i.test(l.msg || ''))).toBe(true);
    expect(post.publish_claimed_at).not.toBeNull();
  });

  it('hands the claim back when the publish fails, so a fixed post can be retried', async () => {
    seedSalon();
    seedPost();
    graph[`${IG_ID}/media`] = () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Media could not be fetched' } }) });
    graph['me/media'] = () => ({ ok: false, status: 400, json: async () => ({ error: { message: 'Media could not be fetched' } }) });

    const result = await publishPost('b-ellie', 'post-1');

    expect(result.published).toBe(false);
    expect(db.content_posts[0].status).toBe('failed');
    expect(db.content_posts[0].failure_reason).toMatch(/could not be fetched/i);
    expect(db.content_posts[0].publish_claimed_at).toBeNull();
  });
});

/* =========================================================================== */
describe('plan-my-week only ever quotes things that are real and public', () => {
  const PLAN = JSON.stringify([
    { day: 'tue', post_type: 'testimonial', caption: 'A kind word from a client.', hashtags: ['#brows'] },
  ]);

  function seedReviews() {
    db.reviews = [
      { id: 'r-public', beautician_id: 'b-ellie', rating: 5, is_public: true,
        comment: 'Ellie is honestly the best brow tech in the city, I will never go anywhere else.' },
      { id: 'r-private', beautician_id: 'b-ellie', rating: 5, is_public: false,
        comment: 'I only came because my wedding is off and I needed cheering up, thank you so much.' },
    ];
  }

  it('never shows the model a review the client kept private', async () => {
    seedSalon();
    seedReviews();
    claudeReply = PLAN;

    await planWeek('b-ellie');

    const prompt = JSON.stringify(claudeCalls[0]);
    expect(prompt).toContain('best brow tech in the city');
    // The one that must never reach a public caption. There is no undo for
    // quoting this on Instagram.
    expect(prompt).not.toContain('my wedding is off');
  });

  it('says there are no reviews when the only five star one is private', async () => {
    seedSalon();
    db.reviews = [{ id: 'r-private', beautician_id: 'b-ellie', rating: 5, is_public: false, comment: 'A long private note about a difficult week, thank you.' }];
    claudeReply = PLAN;

    await planWeek('b-ellie');

    expect(JSON.stringify(claudeCalls[0])).toContain('Real reviews available: none');
  });

  it('never broadcasts an expired promo, one that has not started, or one that is used up', async () => {
    seedSalon();
    db.promo_codes = [
      { id: 'p-live', beautician_id: 'b-ellie', code: 'AUGUST20', discount_type: 'percentage', discount_value: 20,
        is_active: true, valid_from: '2026-08-01T00:00:00.000Z', valid_until: '2026-09-30T00:00:00.000Z',
        max_uses: 50, current_uses: 3 },
      { id: 'p-expired', beautician_id: 'b-ellie', code: 'JUNEFLASH', discount_type: 'percentage', discount_value: 30,
        is_active: true, valid_from: '2026-06-01T00:00:00.000Z', valid_until: '2026-06-30T00:00:00.000Z',
        max_uses: null, current_uses: 0 },
      { id: 'p-future', beautician_id: 'b-ellie', code: 'OCTOBER10', discount_type: 'percentage', discount_value: 10,
        is_active: true, valid_from: '2026-10-01T00:00:00.000Z', valid_until: '2026-10-31T00:00:00.000Z',
        max_uses: null, current_uses: 0 },
      { id: 'p-usedup', beautician_id: 'b-ellie', code: 'FIRSTTEN', discount_type: 'fixed', discount_value: 500,
        is_active: true, valid_from: '2026-08-01T00:00:00.000Z', valid_until: '2026-09-30T00:00:00.000Z',
        max_uses: 10, current_uses: 10 },
    ];
    claudeReply = PLAN;

    await planWeek('b-ellie');

    const prompt = JSON.stringify(claudeCalls[0]);
    expect(prompt).toContain('AUGUST20');
    expect(prompt).not.toContain('JUNEFLASH');
    expect(prompt).not.toContain('OCTOBER10');
    expect(prompt).not.toContain('FIRSTTEN');
  });

  it('suggests 18:30 in the salon clock, not 18:30 in the container', async () => {
    // 31 August 2026 is BST, one hour ahead of UTC. The old code called
    // setHours(18, 30) in container time, so every suggestion was really 19:30
    // to her, and between midnight and 01:00 local the weekday slipped a day.
    seedSalon();
    claudeReply = JSON.stringify([{ day: 'thu', post_type: 'general', caption: 'A tip.', hashtags: [] }]);

    const created = await planWeek('b-ellie');

    expect(created).toHaveLength(1);
    const when = new Date(created[0].scheduled_for);
    const wall = new Intl.DateTimeFormat('en-GB', {
      timeZone: 'Europe/London', weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).format(when);
    expect(wall).toContain('18:30');
    expect(wall).toContain('Thu');
  });

  it('fails loudly instead of reporting "0 posts drafted" as a success', async () => {
    seedSalon();
    claudeReply = PLAN;
    // What an unapplied migration looks like: the insert is rejected whole.
    COLUMNS.content_posts = COLUMNS.content_posts.filter(c => c !== 'scheduled_for');

    await expect(planWeek('b-ellie')).rejects.toThrow(/could not save/i);

    const action = db.ai_actions.find(a => a.action_type === 'content_drafted');
    expect(action.outcome).toBe('failed');
    expect(logs.error.some(l => /could not save a drafted post/i.test(l.msg || ''))).toBe(true);
  });
});

/* =========================================================================== */
describe('a caption is written by something that has seen the photo', () => {
  it('sends the image to the model when the url is one Anthropic can fetch', async () => {
    seedSalon();
    claudeReply = 'Crisp, fluffy and exactly what she asked for.';

    await generateCaption('b-ellie', PUBLIC_IMG, 'brow lamination', null);

    const content = claudeCalls[0].messages[0].content;
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toEqual({ type: 'image', source: { type: 'url', url: PUBLIC_IMG } });
  });

  it('writes the caption anyway when the photo is a link nobody else can reach', async () => {
    // A blob: url only exists in her browser. Anthropic fetches the image from
    // its own servers, exactly as Meta does at publish time, so the same check
    // that guards publishing guards this.
    seedSalon();
    claudeReply = 'A caption written from the treatment name alone.';

    const out = await generateCaption('b-ellie', 'blob:https://app.florrie.ai/9c1', 'lash lift', null);

    const content = claudeCalls[0].messages[0].content;
    expect(content.some(part => part.type === 'image')).toBe(false);
    expect(out.caption).toBeTruthy();
  });
});
