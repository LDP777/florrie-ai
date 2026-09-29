import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ read: vi.fn(), prepare: vi.fn(), auth: vi.fn((req, res, next) => next()) }));
vi.mock('../../src/middleware/auth.js', () => ({ requireAuth: state.auth }));
vi.mock('../../src/lib/logger.js', () => ({ default: { warn: vi.fn() } }));
vi.mock('../../src/services/content-assistant.js', () => ({ buildContentAssistant: state.read, prepareContentAssistant: state.prepare }));
import router from '../../src/routes/content-assistant.js';
const owner = { id: 'authenticated-owner', business_name: 'Demo salon' };
async function call(method, path, body = {}) {
  const output = { status: 200 };
  const response = { status(value) { output.status = value; return response; }, json(value) { output.body = value; return response; } };
  const route = router.stack.find(layer => layer.route?.path === path && layer.route.methods[method]).route;
  for (const layer of route.stack) { let proceed = false; await layer.handle({ beautician: owner, body }, response, () => { proceed = true; }); if (!proceed) break; }
  return output;
}
beforeEach(() => { vi.clearAllMocks(); state.read.mockResolvedValue({ prepared: [], opportunities: [] }); state.prepare.mockResolvedValue({ prepared: [], created_post_ids: [] }); });
describe('Content assistant HTTP boundary', () => {
  it('requires authentication and reads without preparing work', async () => {
    expect((await call('get', '/')).status).toBe(200);
    expect(state.auth).toHaveBeenCalledOnce(); expect(state.read).toHaveBeenCalledWith(owner); expect(state.prepare).not.toHaveBeenCalled();
  });
  it('uses the authenticated owner rather than a submitted owner id', async () => {
    const body = { beautician_id: 'another-owner' };
    await call('post', '/prepare', body);
    expect(state.auth).toHaveBeenCalledOnce(); expect(state.prepare).toHaveBeenCalledWith(owner, body);
  });
  it('keeps retry/conflict status and does not expose internal failures', async () => {
    state.prepare.mockRejectedValueOnce(Object.assign(new Error('Refresh the changed source.'), { status: 409 }));
    expect(await call('post', '/prepare')).toEqual({ status: 409, body: { error: 'Refresh the changed source.' } });
    state.prepare.mockRejectedValueOnce(new Error('Private provider credentials'));
    const result = await call('post', '/prepare'); expect(result.status).toBe(503); expect(result.body.error).not.toContain('credentials');
  });
});
