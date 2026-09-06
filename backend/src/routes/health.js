import { Router } from 'express';
import { requireCronKey } from '../middleware/security.js';

/** Share bounded probes, but expose dependency/account details only to operators. */
export function createHealthRouter({ check, report = () => {}, onError = () => {}, cacheMs = 15000 }) {
  const router = Router();
  let cached;
  let cachedAt = 0;
  let inFlight;

  function read() {
    if (cached && Date.now() - cachedAt < cacheMs) return Promise.resolve(cached);
    if (inFlight) return inFlight;
    inFlight = Promise.resolve().then(check).then(result => {
      if (result.status === 'degraded') report(result);
      return result;
    }).catch(error => {
      onError(error);
      return { status: 'degraded', service: 'florrie-api', failing: ['health_check_harness'] };
    }).then(result => {
      cached = result;
      cachedAt = Date.now();
      return result;
    }).finally(() => { inFlight = null; });
    return inFlight;
  }

  router.get('/live', (_req, res) => res.set('Cache-Control', 'no-store').json({ status: 'alive' }));
  router.get('/', async (_req, res) => {
    const result = await read();
    const status = result.status === 'ok' ? 'ok' : 'degraded';
    res.set('Cache-Control', 'no-store').status(status === 'ok' ? 200 : 503)
      .json({ status, service: 'florrie-api' });
  });
  router.get('/details', requireCronKey, async (_req, res) => {
    const result = await read();
    res.set('Cache-Control', 'no-store').status(result.status === 'ok' ? 200 : 503).json(result);
  });
  return router;
}
