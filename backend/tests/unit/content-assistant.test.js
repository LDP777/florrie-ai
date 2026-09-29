import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../src/config.js', () => ({ supabase: {} }));
vi.mock('../../src/services/content-autopilot.js', () => ({ generateCaption: vi.fn(), imageUrlProblem: url => typeof url === 'string' && url.startsWith('https://') ? null : 'Invalid photo' }));
vi.mock('../../src/lib/gap-availability.js', () => ({ currentGapCalendar: vi.fn() }));
import { assistantPostId, assistantPrepareOptions, buildContentAssistant, prepareContentAssistant } from '../../src/services/content-assistant.js';

const OWNER = { id: 'owner', booking_slug: 'demo-salon' };
const NOW = new Date('2026-09-29T12:00:00Z');
let rows, calls, writes, fail, caption, calendar, deps, uncertain, upsertFailure;
function query(table) {
  const predicates = [], record = { table, filters: [] }; calls.push(record);
  let maximum = Infinity, single = false, operation, payload, countRequested = false;
  const q = {
    select(columns, options) { record.columns = columns; countRequested ||= options?.count === 'exact'; return q; },
    eq(key, value) { predicates.push(row => row[key] === value); record.filters.push([key, value]); return q; },
    neq(key, value) { predicates.push(row => row[key] !== value); return q; },
    not(key, operator, value) { expect(operator).toBe('is'); predicates.push(row => (row[key] ?? null) !== value); return q; },
    gte(key, value) { predicates.push(row => row[key] >= value); return q; },
    lte(key, value) { predicates.push(row => row[key] <= value); return q; },
    in(key, values) { predicates.push(row => values.includes(row[key])); record.filters.push([key, values]); return q; },
    or() { predicates.push(row => row.post_type !== 'gallery'); return q; },
    order() { return q; }, limit(value) { maximum = value; return q; }, abortSignal() { return q; },
    maybeSingle() { single = true; return q; },
    upsert(value, options) { expect(options).toEqual({ onConflict: 'id', ignoreDuplicates: true }); operation = 'upsert'; payload = value; return q; },
    insert(value) { operation = 'insert'; payload = value; return q; },
    then(resolve, reject) {
      let result;
      if (fail.has(table)) result = { data: null, error: { message: 'Synthetic read failure' }, count: null };
      else if (operation) {
        writes.push({ table, operation, payload });
        if (operation === 'upsert' && upsertFailure) result = { data: null, error: { message: 'Not saved' } };
        else {
          const exists = operation === 'upsert' && rows[table].some(row => row.id === payload.id);
          if (!exists) rows[table].push({ ...payload });
          result = { data: exists ? [] : [{ ...payload }], error: operation === 'upsert' && uncertain ? { message: 'Lost response after commit' } : null };
        }
      } else {
        const found = (rows[table] || []).filter(row => predicates.every(predicate => predicate(row)));
        result = { data: single ? found[0] || null : found.slice(0, maximum).map(row => ({ ...row })), error: null, ...(countRequested ? { count: found.length } : {}) };
      }
      return Promise.resolve(result).then(resolve, reject);
    },
  };
  return q;
}
beforeEach(() => {
  rows = { content_posts: [{ id: 'photo', beautician_id: 'owner', post_type: 'gallery', status: 'draft', after_url: 'https://media.example/salon/after.jpg', image_url: 'https://media.example/salon/after.jpg', treatment_name: 'Brows', caption: 'A soft shape.' }], knowledge_entries: [{ id: 'guide', beautician_id: 'owner', is_active: true, category: 'treatment', title: 'Brow consultation', content: 'A consultation is included before treatment.' }], treatments: [{ id: 'service', beautician_id: 'owner', is_active: true, name: 'Signature brows', description: 'A shape and tint appointment.', duration_minutes: 30, buffer_minutes: 15 }], ai_actions: [] };
  calls = []; writes = []; fail = new Set(); uncertain = false; upsertFailure = false;
  caption = vi.fn(async () => ({ caption: 'Your prepared post.', hashtags: ['#brows'] }));
  calendar = vi.fn(async () => ({ gaps: [{ duration_minutes: 60, date: '2026-09-30', start: '14:00', end: '15:00' }] }));
  deps = { db: { from: query, rpc(name, input) { calls.push({ rpc: name, input }); return { abortSignal() { return this; }, then(resolve, reject) { return Promise.resolve(fail.has('results') ? { error: {} } : { data: [{ post_id: 'measured', confirmed: 2, pending: 1, booking_value_cents: 6000 }], error: null }).then(resolve, reject); } }; } }, caption, calendar, now: () => NOW };
});

describe('Content assistant evidence and preparation', () => {
  it('reads a grounded board without AI or writes, and only reads the salon’s sources', async () => {
    rows.content_posts.push({ id: 'private', beautician_id: 'other', post_type: 'gallery', after_url: 'https://other.example/private.jpg' });
    rows.knowledge_entries.push({ id: 'unapproved', beautician_id: 'owner', is_active: false, category: 'treatment', title: 'Ignore me', content: 'Private' });
    const board = await buildContentAssistant(OWNER, deps);
    expect(board.unavailable).toEqual([]);
    expect(board.opportunities.map(source => source.type)).toEqual(['gallery', 'knowledge', 'booking', 'treatment']);
    expect(board.results).toMatchObject({ available: true, days: 90, campaigns: [{ confirmed: 2 }] });
    expect(JSON.stringify(board)).not.toMatch(/private.jpg|Ignore me|14:00/);
    expect(caption).not.toHaveBeenCalled(); expect(writes).toEqual([]);
    expect(calls.filter(call => call.table).every(call => call.filters.some(([key, value]) => key === 'beautician_id' && value === OWNER.id))).toBe(true);
    expect(calls.map(call => call.table)).not.toContain('messages');
    expect(calls.map(call => call.table)).not.toContain('reviews');
    expect(calls.map(call => call.table)).not.toContain('knowledge_suggestions');
    expect(calendar).toHaveBeenCalledWith('owner', NOW);
  });
  it('shows readiness from saved work and ranks a complete draft before missing assets', async () => {
    rows.content_posts.push({ id: 'needs-photo', beautician_id: 'owner', status: 'draft', caption: 'Waiting' }, { id: 'ready', beautician_id: 'owner', status: 'draft', image_url: 'https://photo.example/ready.jpg', caption: 'Ready', media_kind: 'story', stream_id: 'campaign-one' });
    const board = await buildContentAssistant(OWNER, deps);
    expect(board.prepared.map(post => post.post_id)).toEqual(['ready', 'needs-photo']);
    expect(board.prepared[1].needs).toEqual(['photo']);
    expect(board.prepared[0].post).toMatchObject({ media_kind: 'story', stream_id: 'campaign-one' });
    const postReads = calls.filter(call => call.table === 'content_posts' && call.columns?.includes('caption'));
    expect(postReads.filter(call => call.columns.includes('status')).every(call => call.columns.includes('media_kind') && call.columns.includes('stream_id'))).toBe(true);
  });
  it('preserves unknown sources and results as unavailable, never fictional zero performance', async () => {
    fail.add('knowledge_entries'); fail.add('results'); calendar.mockRejectedValue(new Error('Diary offline'));
    const board = await buildContentAssistant(OWNER, deps);
    expect(board.unavailable).toEqual(expect.arrayContaining(['knowledge', 'results', 'diary']));
    expect(board.results).toMatchObject({ available: false, campaigns: [] });
    expect(board.opportunities.map(source => source.type)).toEqual(['gallery', 'treatment']);
  });
  it('a stalled diary does not block the rest of the content board', async () => {
    vi.useFakeTimers();
    try {
      calendar.mockImplementation(() => new Promise(() => {}));
      const pending = buildContentAssistant(OWNER, deps);
      await vi.advanceTimersByTimeAsync(5001);
      const board = await pending;
      expect(board.unavailable).toContain('diary');
      expect(board.opportunities.map(source => source.type)).toEqual(['gallery', 'knowledge', 'treatment']);
      expect(board.results.available).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it('prepares at most three real draft records with the saved photo attached and source evidence', async () => {
    const board = await prepareContentAssistant(OWNER, {}, deps);
    expect(board.created_post_ids).toHaveLength(3); expect(caption).toHaveBeenCalledTimes(3);
    const drafts = rows.content_posts.filter(row => row.post_type !== 'gallery');
    expect(drafts).toHaveLength(3); expect(drafts.every(row => row.status === 'draft' && !row.scheduled_for && !row.approved_at)).toBe(true);
    expect(drafts[0].image_url).toBe(rows.content_posts[0].after_url);
    expect(rows.ai_actions).toHaveLength(3); expect(rows.ai_actions[0].details).toMatchObject({ assistant: true, post_id: drafts[0].id, source: { type: 'gallery', id: 'photo' } });
    expect(caption.mock.calls[1][3]).toContain('A consultation is included before treatment.');
    expect(caption.mock.calls[1][3]).toContain('Never claim a cancellation');
    expect(board.prepared.every(post => post.source.type !== 'saved_post')).toBe(true);
    expect(writes.every(write => ['content_posts', 'ai_actions'].includes(write.table))).toBe(true);
  });
  it('reuses pending work and does not make another pile or repeat AI on reload/retry', async () => {
    await prepareContentAssistant(OWNER, {}, deps);
    const again = await prepareContentAssistant(OWNER, {}, deps);
    expect(again.created_post_ids).toEqual([]); expect(caption).toHaveBeenCalledTimes(3);
    expect(again.message).toContain('already have prepared drafts');
  });
  it('legacy caption-only backlog does not prevent the first assistant batch, then durable counts stop repeats', async () => {
    rows.content_posts.push(...Array.from({ length: 110 }, (_, index) => ({ id: `old-${index}`, beautician_id: 'owner', status: 'draft', caption: 'An untouched old caption.' })));
    const before = await buildContentAssistant(OWNER, deps);
    expect(before).toMatchObject({ pending_count: 110, assistant_pending_count: 0, prepare_capacity: 3 });
    const after = await prepareContentAssistant(OWNER, {}, deps);
    expect(after.created_post_ids).toHaveLength(3);
    expect(after).toMatchObject({ pending_count: 113, assistant_pending_count: 3, prepare_capacity: 0 });
    expect(after.created_post_ids.every(id => after.prepared.some(post => post.post_id === id))).toBe(true);
    rows.ai_actions = []; // A lost activity log cannot reopen capacity.
    expect((await buildContentAssistant(OWNER, deps)).prepare_capacity).toBe(0);
  });
  it('ready legacy work uses preparation capacity without being counted twice as assistant work', async () => {
    rows.content_posts.push({ id: 'ready-legacy', beautician_id: 'owner', status: 'draft', image_url: 'https://photo.example/ready.jpg', caption: 'Ready' });
    expect((await buildContentAssistant(OWNER, deps)).prepare_capacity).toBe(2);
    const result = await prepareContentAssistant(OWNER, {}, deps);
    expect(result.created_post_ids).toHaveLength(2); expect(result.prepare_capacity).toBe(0);
  });
  it('keeps assistant work ahead of ready and incomplete legacy drafts', async () => {
    const result = await prepareContentAssistant(OWNER, {}, deps);
    rows.content_posts.unshift({ id: 'legacy-ready', beautician_id: 'owner', status: 'draft', caption: 'Ready', image_url: 'https://image.example/photo.jpg' });
    rows.content_posts.unshift({ id: 'legacy-incomplete', beautician_id: 'owner', status: 'draft', caption: 'Needs a photo' });
    const board = await buildContentAssistant(OWNER, deps);
    expect(new Set(board.prepared.slice(0, 3).map(post => post.post_id))).toEqual(new Set(result.created_post_ids));
    expect(board.prepared.slice(3).map(post => post.post_id)).toEqual(['legacy-ready', 'legacy-incomplete']);
  });
  it('provides exact short artwork facts only for assistant-created posts with unchanged trusted sources', async () => {
    const board = await prepareContentAssistant({ ...OWNER, business_name: 'Demo Salon' }, {}, deps);
    const guide = board.prepared.find(item => item.source.type === 'knowledge');
    expect(guide.artwork).toEqual({ kind: 'knowledge', title: 'Brow consultation', body: 'A consultation is included before treatment.' });
    expect(guide.needs).toContain('photo');
    expect(board.business_name).toBe('Demo Salon'); expect(board.booking_slug).toBe('demo-salon');
    rows.knowledge_entries[0].content = 'The owner changed this guidance.';
    expect((await buildContentAssistant(OWNER, deps)).prepared.find(item => item.post_id === guide.post_id).artwork).toBeUndefined();
    rows.content_posts.push({ id: 'historic', beautician_id: 'owner', status: 'draft', caption: 'An old draft.' });
    expect((await buildContentAssistant(OWNER, deps)).prepared.find(item => item.post_id === 'historic').artwork).toBeUndefined();
  });
  it('does not truncate long guidance into an artwork claim', async () => {
    rows.knowledge_entries[0].content = 'An explanation with qualifications. '.repeat(10);
    const board = await prepareContentAssistant(OWNER, { sources: [{ type: 'knowledge', source_id: 'guide' }] }, deps);
    expect(board.prepared[0].artwork).toBeUndefined();
    expect(board.prepared[0].needs).toEqual(['photo']);
  });
  it('does not offer gallery images already used, including published posts', async () => {
    rows.content_posts.push({ id: 'published', beautician_id: 'owner', status: 'posted', image_url: rows.content_posts[0].after_url });
    expect((await buildContentAssistant(OWNER, deps)).opportunities.some(source => source.type === 'gallery')).toBe(false);
  });
  it('does not regenerate a completed source from this week', async () => {
    rows.content_posts.push({ id: assistantPostId('owner', 'knowledge', 'guide', NOW), beautician_id: 'owner', status: 'posted' });
    expect((await buildContentAssistant(OWNER, deps)).opportunities.some(source => source.type === 'knowledge')).toBe(false);
  });
  it('blocks unreadable draft counts before spending on AI', async () => {
    fail.add('content_posts');
    await expect(prepareContentAssistant(OWNER, {}, deps)).rejects.toMatchObject({ status: 503 });
    expect(caption).not.toHaveBeenCalled(); expect(writes).toEqual([]);
  });
  it('rejects another owner’s or stale source without sending it to the model', async () => {
    await expect(prepareContentAssistant(OWNER, { sources: [{ type: 'gallery', source_id: 'other-private' }] }, deps)).rejects.toMatchObject({ status: 409 });
    expect(caption).not.toHaveBeenCalled();
  });
  it('fails closed if an owner removes the source while its caption is being prepared', async () => {
    caption.mockImplementation(async () => { rows.knowledge_entries[0].is_active = false; return { caption: 'Caption', hashtags: [] }; });
    const board = await prepareContentAssistant(OWNER, { sources: [{ type: 'knowledge', source_id: 'guide' }] }, deps);
    expect(board.created_post_ids).toEqual([]); expect(board.errors).toHaveLength(1); expect(writes).toEqual([]);
  });
  it.each(['title', 'category'])('rejects knowledge %s changes during generation', async field => {
    caption.mockImplementation(async () => { rows.knowledge_entries[0][field] = field === 'title' ? 'Different claim' : 'arrival'; return { caption: 'Caption', hashtags: [] }; });
    const board = await prepareContentAssistant(OWNER, { sources: [{ type: 'knowledge', source_id: 'guide' }] }, deps);
    expect(board.created_post_ids).toEqual([]); expect(board.errors).toHaveLength(1); expect(writes).toEqual([]);
  });
  it('recovers an uncertain save by the stable id without overwriting or duplicating it', async () => {
    uncertain = true;
    const board = await prepareContentAssistant(OWNER, { sources: [{ type: 'gallery', source_id: 'photo' }] }, deps);
    expect(board.created_post_ids).toHaveLength(1); expect(board.errors).toEqual([]);
    expect(rows.content_posts.filter(row => row.id === board.created_post_ids[0])).toHaveLength(1);
    expect((await buildContentAssistant(OWNER, deps)).opportunities.some(source => source.type === 'gallery')).toBe(false);
  });
  it('reports failed saves as incomplete instead of claiming posts were prepared', async () => {
    upsertFailure = true;
    const board = await prepareContentAssistant(OWNER, { sources: [{ type: 'gallery', source_id: 'photo' }] }, deps);
    expect(board.created_post_ids).toEqual([]); expect(board.errors).toHaveLength(1); expect(rows.ai_actions).toEqual([]);
  });
  it('a booking invitation uses the real booking link, not stale appointment times', async () => {
    const board = await prepareContentAssistant(OWNER, { sources: [{ type: 'booking', source_id: 'current-diary' }] }, deps);
    expect(caption.mock.calls[0][3]).toContain('https://florrie.ai/book/demo-salon');
    expect(caption.mock.calls[0][3]).not.toMatch(/2026-09-30|14:00|15:00/);
    expect(caption.mock.calls[0][3]).toContain('current times');
    expect(board.prepared[0].artwork).toEqual({ kind: 'booking', title: 'A little time for you', body: 'Signature brows. Check my booking page for current appointments.' });
  });
  it.each([{ duration_minutes: 60, buffer_minutes: 15 }, { duration_minutes: null }, { duration_minutes: 0 }, { duration_minutes: 30, buffer_minutes: -5 }])('does not suggest booking when a treatment cannot fit safely: %j', change => {
    Object.assign(rows.treatments[0], change);
    return buildContentAssistant(OWNER, deps).then(board => expect(board.opportunities.some(source => source.type === 'booking')).toBe(false));
  });
  it('balances real photos, an explanation and a booking invitation instead of taking three photos', async () => {
    rows.content_posts.push(...['two', 'three'].map(id => ({ ...rows.content_posts[0], id, after_url: `https://media.example/${id}.jpg`, image_url: `https://media.example/${id}.jpg` })));
    const board = await buildContentAssistant(OWNER, deps);
    expect(board.opportunities.slice(0, 3).map(source => source.type)).toEqual(['gallery', 'knowledge', 'booking']);
    await prepareContentAssistant(OWNER, {}, deps);
    expect(rows.ai_actions.map(action => action.details.source.type)).toEqual(['gallery', 'knowledge', 'booking']);
  });
  it('preserves the owner’s explicit source order and falls back to treatment facts without Knowledge', async () => {
    rows.knowledge_entries = [];
    const board = await buildContentAssistant(OWNER, deps);
    expect(board.opportunities.slice(0, 3).map(source => source.type)).toEqual(['gallery', 'treatment', 'booking']);
    await prepareContentAssistant(OWNER, { sources: [{ type: 'booking', source_id: 'current-diary' }, { type: 'gallery', source_id: 'photo' }] }, deps);
    expect(rows.ai_actions.map(action => action.details.source.type)).toEqual(['booking', 'gallery']);
  });
  it('blocks overlapping preparation for one owner and releases the lock after completion', async () => {
    let release;
    caption.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const first = prepareContentAssistant(OWNER, { sources: [{ type: 'gallery', source_id: 'photo' }] }, deps);
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await expect(prepareContentAssistant(OWNER, {}, deps)).rejects.toMatchObject({ status: 409 });
    release({ caption: 'One draft', hashtags: [] }); await first;
    await expect(buildContentAssistant(OWNER, deps)).resolves.toMatchObject({ prepared: [{ post: { caption: 'One draft' } }] });
  });
  it('stable ids isolate owners and source types, and rotate only with the week', () => {
    const id = assistantPostId('owner', 'gallery', 'photo', NOW);
    expect(id).toMatch(/^[a-f0-9]{8}-[a-f0-9]{4}-5[a-f0-9]{3}-a[a-f0-9]{3}-[a-f0-9]{12}$/);
    expect(assistantPostId('owner', 'gallery', 'photo', new Date('2026-09-30'))).toBe(id);
    expect(assistantPostId('other', 'gallery', 'photo', NOW)).not.toBe(id);
    expect(assistantPostId('owner', 'knowledge', 'photo', NOW)).not.toBe(id);
    expect(assistantPostId('owner', 'gallery', 'photo', new Date('2026-10-06'))).not.toBe(id);
  });
  it.each([null, [], { image_url: 'https://private.example' }, { sources: [] }, { sources: [{ type: 'review', source_id: 'one' }] }, { sources: Array(4).fill({ type: 'gallery', source_id: 'one' }) }])('rejects unsafe or unbounded preparation options %j', body => {
    expect(() => assistantPrepareOptions(body)).toThrow();
  });
});
