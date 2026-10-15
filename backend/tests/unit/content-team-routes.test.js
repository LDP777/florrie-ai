import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({ get: vi.fn(), list: vi.fn(), read: vi.fn(), enqueue: vi.fn(), retry: vi.fn(), auth: vi.fn((req, res, next) => next()) }));
vi.mock('../../src/middleware/auth.js', () => ({ requireAuth: state.auth }));
vi.mock('../../src/services/content-team.js', () => ({ getContentTeam: state.get, listContentTeamRuns: state.list, getContentTeamRun: state.read, enqueueContentTeam: state.enqueue, retryContentTeam: state.retry }));
import router from '../../src/routes/content-team.js';
import { teamError } from '../../src/lib/content-team.js';
const owner = { id: 'authenticated-salon' };
async function call(method, path, body = {}, id = 'run-id', query = {}) {
  const out = { status: 200 }, res = { status(value) { out.status = value; return res; }, json(value) { out.body = value; return res; } };
  const route = router.stack.find(layer => layer.route?.path === path && layer.route.methods[method]).route;
  for (const layer of route.stack) { let next = false; await layer.handle({ beautician: owner, body, params: { id }, query }, res, () => { next = true; }); if (!next) break; }
  return out;
}
beforeEach(() => { vi.clearAllMocks(); state.get.mockResolvedValue({ available: true, run: null, capabilities: [] }); state.enqueue.mockResolvedValue({ id: 'saved', status: 'queued' }); state.retry.mockResolvedValue({ id: 'saved', status: 'queued' }); });
describe('Content Team route boundary', () => {
  it('authenticates reads without preparing work', async () => {
    expect(await call('get', '/')).toMatchObject({ status: 200, body: { available: true, run: null } });
    expect(state.auth).toHaveBeenCalledOnce(); expect(state.get).toHaveBeenCalledWith(owner); expect(state.enqueue).not.toHaveBeenCalled();
  });
  it('returns202 only for saved queued work using the authenticated owner', async () => {
    const brief = { request_id: 'client-key', beautician_id: 'malicious-owner' };
    expect(await call('post', '/runs', brief)).toMatchObject({ status: 202, body: { run: { id: 'saved' } } });
    expect(state.auth).toHaveBeenCalledOnce(); expect(state.enqueue).toHaveBeenCalledWith(owner, brief);
  });
  it('authenticates history and exact saved outputs without starting or retrying work', async () => {
    state.list.mockResolvedValue({ runs: [], has_more: false, next_offset: null });
    expect((await call('get', '/runs', {}, undefined, { offset: '20', limit: '20' })).body.runs).toEqual([]);
    expect(state.list).toHaveBeenCalledWith(owner, { offset: '20', limit: '20' });
    state.read.mockResolvedValue({ id: 'saved', status: 'ready' });
    expect((await call('get', '/runs/:id', {}, 'saved')).body.run.id).toBe('saved');
    expect(state.read).toHaveBeenCalledWith(owner, 'saved'); expect(state.auth).toHaveBeenCalledTimes(2);
    expect(state.enqueue).not.toHaveBeenCalled(); expect(state.retry).not.toHaveBeenCalled();
  });
  it('retries the exact owned job without accepting a changed brief', async () => {
    expect((await call('post', '/runs/:id/retry')).status).toBe(202); expect(state.retry).toHaveBeenCalledWith(owner, 'run-id');
    expect((await call('post', '/runs/:id/retry', { focus: 'different' })).status).toBe(400); expect(state.retry).toHaveBeenCalledOnce();
  });
  it('preserves meaningful conflict/setup status and redacts unexpected provider details', async () => {
    state.enqueue.mockRejectedValueOnce(teamError('Storage update required.', 503, 'setup_required'));
    expect(await call('post', '/runs')).toEqual({ status: 503, body: { error: 'Storage update required.', code: 'setup_required' } });
    state.enqueue.mockRejectedValueOnce(Object.assign(new Error('secret token'), { status: 401 }));
    expect(JSON.stringify(await call('post', '/runs'))).not.toContain('secret token');
  });
});
