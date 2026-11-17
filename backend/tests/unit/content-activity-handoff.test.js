import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ rows: [] }));
vi.mock('../../src/services/week-in-review.js', () => ({ computeWeekReview: vi.fn() }));
vi.mock('../../src/middleware/auth.js', () => ({ requireAuth: (_req, _res, next) => next() }));
vi.mock('../../src/lib/logger.js', () => ({ default: { error: vi.fn() } }));
vi.mock('../../src/config.js', () => ({ supabase: { from(table) {
  if (table !== 'ai_actions') throw new Error('Unexpected table');
  const predicates = [];
  let first = 0, last = Infinity;
  const query = {
    select() { return query; },
    eq(key, value) { predicates.push(row => row[key] === value); return query; },
    or() { predicates.push(row => !row.details?.heartbeat); return query; },
    gte(key, value) { predicates.push(row => row[key] >= value); return query; },
    lte(key, value) { predicates.push(row => row[key] <= value); return query; },
    abortSignal() { return query; },
    order() { return query; },
    limit(n) { last = n - 1; return query; },
    range(a,b) { first = a; last = b; return query; },
    then(resolve) { const rows = state.rows.filter(row => predicates.every(match => match(row))); return Promise.resolve({ data: rows.slice(first, last+1), count: rows.length, error: null }).then(resolve); },
  };
  return query;
} } }));

import router from '../../src/routes/activity.js';
const postId = '11111111-1111-4111-8111-111111111111';
const secondId = '22222222-2222-4222-8222-222222222222';
async function feed() {
  const result = { status: 200 };
  const res = { status(code) { result.status = code; return res; }, json(body) { result.body = body; return res; } };
  const route = router.stack.find(layer => layer.route?.path === '/feed' && layer.route.methods.get).route;
  for (const layer of route.stack) {
    let next = false;
    await layer.handle({ beautician: { id: 'owner' }, query: {} }, res, () => { next = true; });
    if (!next) break;
  }
  return result;
}

beforeEach(() => { state.rows = []; });
describe('Content activity opens the saved work', () => {
  it('background checks cannot crowd out work and the day receipt is not capped at 50 feed entries', async () => {
    const created_at = new Date().toISOString();
    state.rows = [
      ...Array.from({length:60},(_,i) => ({ id: `check-${i}`, beautician_id: 'owner', action_type: 'message_replied', outcome: 'success', details: { heartbeat: true }, created_at })),
      ...Array.from({length:73},(_,i) => ({ id: `work-${i}`, beautician_id: 'owner', action_type: 'appointment_reminder', outcome: 'success', details: {}, created_at })),
      { id: 'yesterday', beautician_id: 'owner', action_type: 'appointment_reminder', outcome: 'success', created_at: new Date(Date.now()-86400000).toISOString() },
    ];
    const { body } = await feed();
    expect(body.rows).toHaveLength(50);
    expect(body.rows[0].id).toBe('work-0');
    expect(body.receipt).toEqual([{ icon: 'clock', text: '73 reminders sent' }]);
    expect(body.receipt_unavailable).toBe(false);
  });
  it.each([
    ['content_drafted', 'drafts'], ['gap_post', 'drafts'], ['content_posted', 'posted'],
  ])('opens the exact post for %s', async (action_type, view) => {
    state.rows = [{ id: 'action', beautician_id: 'owner', action_type, details: { post_id: postId } }];
    expect((await feed()).body.rows[0].link_to).toBe(`/content?view=${view}&post=${postId}`);
  });

  it('keeps multi-post plans on the draft queue without arbitrarily choosing a post', async () => {
    state.rows = [{ id: 'action', beautician_id: 'owner', action_type: 'content_drafted', details: { post_ids: [postId, secondId], post_id: postId } }];
    expect((await feed()).body.rows[0].link_to).toBe('/content?view=drafts');
  });

  it.each([null, 'unexpected', [], { post_id: '../other' }, { post_id: `${postId}&view=posted` }, { post_id: [postId] }, { post_ids: [postId] }])('falls back safely for unsupported details %j', async details => {
    state.rows = [{ id: 'action', beautician_id: 'owner', action_type: 'content_drafted', details }];
    expect((await feed()).body.rows[0].link_to).toBe('/content?view=drafts');
  });

  it('keeps only the signed-in salon’s activity and does not expose other post metadata', async () => {
    state.rows = [
      { id: 'own-action', beautician_id: 'owner', action_type: 'content_posted', details: { post_id: postId } },
      { id: 'other-action', beautician_id: 'other', action_type: 'content_drafted', details: { post_id: secondId } },
    ];
    const result = await feed();
    expect(result.body.rows).toHaveLength(1);
    expect(result.body.rows[0].id).toBe('own-action');
    expect(JSON.stringify(result.body)).not.toContain(secondId);
  });
});
