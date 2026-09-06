import { describe, it, expect, vi, afterEach } from 'vitest';
import express from 'express';
import { createHealthRouter } from '../../src/routes/health.js';

const servers = [];
async function start(check, options = {}) {
  const app = express();
  app.use('/health', createHealthRouter({ check, ...options }));
  const server = await new Promise(resolve => {
    const handle = app.listen(0, '127.0.0.1', () => resolve(handle));
  });
  servers.push(server);
  return path => fetch(`http://127.0.0.1:${server.address().port}/health${path}`);
}
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))));
});

describe('public and operator health boundary', () => {
  it.each(['ok', 'degraded'])('does not disclose dependency or financial data when %s', async status => {
    const get = await start(async () => ({ status, checks: { stripe: { available_pence: 999, account: 'private' } }, warnings: ['private'], failing: ['private'] }));
    const response = await get('');
    expect(response.status).toBe(status === 'ok' ? 200 : 503);
    expect(await response.json()).toEqual({ status, service: 'florrie-api' });
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('keeps liveness independent and denies unauthenticated details before probing', async () => {
    vi.stubEnv('CRON_SECRET', 'operator-test');
    const check = vi.fn();
    const get = await start(check);
    expect((await get('/details')).status).toBe(401);
    expect(await (await get('/live')).json()).toEqual({ status: 'alive' });
    expect(check).not.toHaveBeenCalled();
  });
  it('fails closed when operator authentication is not configured', async () => {
    vi.stubEnv('CRON_SECRET', '');
    const check = vi.fn();
    expect((await (await start(check))('/details')).status).toBe(503);
    expect(check).not.toHaveBeenCalled();
  });
  it('does not reflect thrown messages into public responses', async () => {
    const reportError = vi.fn();
    const get = await start(async () => { throw new Error('private account token'); }, { onError: reportError });
    const response = await get('');
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: 'degraded', service: 'florrie-api' });
    expect(reportError).toHaveBeenCalledOnce();
  });
  it('coalesces concurrent probes and keeps operator detail protected', async () => {
    vi.stubEnv('CRON_SECRET', 'operator-test');
    let release;
    const check = vi.fn(() => new Promise(resolve => { release = resolve; }));
    const get = await start(check);
    const one = get('');
    const two = get('');
    await vi.waitFor(() => expect(check).toHaveBeenCalledOnce());
    release({ status: 'ok', checks: { database: { ok: true } } });
    const [a, b] = await Promise.all([one, two]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    const detail = await fetch(a.url + '/details', { headers: { 'x-cron-key': 'operator-test' } });
    expect(await detail.json()).toEqual({ status: 'ok', checks: { database: { ok: true } } });
    expect(check).toHaveBeenCalledOnce();
  });
});
