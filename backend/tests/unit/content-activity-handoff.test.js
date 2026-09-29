import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ rows: [] }));
vi.mock('../../src/services/week-in-review.js', () => ({ computeWeekReview: vi.fn() }));
vi.mock('../../src/middleware/auth.js', () => ({ requireAuth: (_req, _res, next) => next() }));
vi.mock('../../src/lib/logger.js', () => ({ default: { error: vi.fn() } }));
vi.mock('../../src/config.js', () => ({ supabase: { from(table) {
  if (table !== 'ai_actions') throw new Error('Unexpected table');
  const predicates = [];
  const query = {
    select() { return query; },
    eq(key, value) { predicates.push(row => row[key] === value); return query; },
    order() { return query; },
    limit() { return query; },
    then(resolve) { return Promise.resolve({ data: state.rows.filter(row => predicates.every(match => match(row))), error: null }).then(resolve); },
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
