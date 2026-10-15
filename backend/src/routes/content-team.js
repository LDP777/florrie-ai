import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { enqueueContentTeam, getContentTeam, getContentTeamRun, listContentTeamRuns, retryContentTeam } from '../services/content-team.js';
import { teamError } from '../lib/content-team.js';

const router = Router();
const route = handler => async (req, res) => {
  try { await handler(req, res); }
  catch (error) { res.status(error.isContentTeamError ? error.status : 503).json({ error: error.isContentTeamError ? error.message : 'Content Team could not finish this request. Refresh saved work before trying again.', code: error.isContentTeamError ? error.code : 'unavailable' }); }
};
router.get('/', requireAuth, route(async (req, res) => res.json(await getContentTeam(req.beautician))));
router.get('/runs', requireAuth, route(async (req, res) => res.json(await listContentTeamRuns(req.beautician, req.query))));
router.get('/runs/:id', requireAuth, route(async (req, res) => res.json({ run: await getContentTeamRun(req.beautician, req.params.id) })));
router.post('/runs', requireAuth, route(async (req, res) => res.status(202).json({ run: await enqueueContentTeam(req.beautician, req.body) })));
router.post('/runs/:id/retry', requireAuth, route(async (req, res) => {
  if (req.body && (typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).length)) throw teamError('Retry the saved brief without changing it.', 400, 'invalid_retry');
  res.status(202).json({ run: await retryContentTeam(req.beautician, req.params.id) });
}));
export default router;
