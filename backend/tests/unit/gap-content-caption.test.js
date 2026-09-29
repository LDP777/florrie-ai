import { beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({ calls: vi.fn(), writes: [], profile: null, actionFailure: false }));
vi.mock('@anthropic-ai/sdk', () => ({ default: class { messages = { create: state.calls }; } }));
vi.mock('../../src/lib/anti-slop.js', () => ({ ensureNoSlop: async text => text }));
vi.mock('../../src/config.js', () => ({ supabase: { from: table => {
  let payload;
  const query = {
    select() { return query; }, eq() { return query; },
    insert(value) { payload = value; return query; },
    single() {
      if (table === 'beauticians') return Promise.resolve({ data: state.profile, error: null });
      state.writes.push({ table, payload });
      return Promise.resolve({ data: { id: 'post-1', ...payload }, error: null });
    },
    then(resolve, reject) {
      state.writes.push({ table, payload });
      return (state.actionFailure ? Promise.reject(new Error('Activity unavailable')) : Promise.resolve({ error: null })).then(resolve, reject);
    },
  };
  return query;
} } }));

const { draftAvailabilityPost } = await import('../../src/services/content-autopilot.js');

beforeEach(() => {
  state.writes = [];
  state.actionFailure = false;
  state.profile = { first_name: 'Ellie', business_name: 'Demo', booking_slug: 'demo', voice_profile: {} };
  state.calls.mockReset().mockResolvedValue({ content: [{ text: 'A manually requested draft.' }] });
});

it('keeps background captions and hashtags free of stale slot claims', async () => {
  const beforeSave = vi.fn().mockResolvedValue(undefined);
  const post = await draftAvailabilityPost('owner', '2026-09-30', '13:30', ['Brow tint'], { bookingInvitationOnly: true, beforeSave });
  expect(post.caption).toBe('Thinking of booking for Brow tint? Check my booking page for current availability: florrie.ai/book/demo');
  expect(post.caption).not.toMatch(/13:30|September|Wednesday|tomorrow|last.minute|slots? left/i);
  expect(post.hashtags).toEqual([]);
  expect(post.status).toBe('draft');
  expect(beforeSave).toHaveBeenCalledOnce();
  expect(state.calls).not.toHaveBeenCalled();
});

it('saves no caption when the final availability check fails', async () => {
  await expect(draftAvailabilityPost('owner', '2026-09-30', '13:30', ['Brow tint'], {
    bookingInvitationOnly: true, beforeSave: async () => { throw new Error('Opening booked'); },
  })).rejects.toThrow('Opening booked');
  expect(state.writes).toHaveLength(0);
});

it('does not fall back to a fictional salon when its profile cannot be read', async () => {
  state.profile = null;
  await expect(draftAvailabilityPost('owner', '2026-09-30', '13:30', ['Brow tint'], { bookingInvitationOnly: true })).rejects.toThrow('Could not check the salon');
  expect(state.writes).toHaveLength(0);
});

it('preserves the existing manually requested availability generation', async () => {
  const post = await draftAvailabilityPost('owner', '2026-09-30', '13:30', ['Brow tint']);
  expect(post.caption).toBe('A manually requested draft.');
  expect(state.calls).toHaveBeenCalledOnce();
  expect(state.calls.mock.calls[0][0].messages[0].content).toContain('Wednesday 30 September');
});

it('returns the saved draft even if activity logging fails, so approval cannot duplicate it', async () => {
  state.actionFailure = true;
  const post = await draftAvailabilityPost('owner', '2026-09-30', '13:30', ['Brow tint'], { bookingInvitationOnly: true });
  expect(post.id).toBe('post-1');
  expect(state.writes.filter(write => write.table === 'content_posts')).toHaveLength(1);
});
