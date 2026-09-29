import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { buildContentAssistant, prepareContentAssistant } from '../services/content-assistant.js';
import logger from '../lib/logger.js';

const router = Router();
router.get('/', requireAuth, async (req, res) => {
  try { res.json(await buildContentAssistant(req.beautician)); }
  catch (error) { logger.warn({ err: error }, 'Content assistant read failed'); res.status(503).json({ error: 'Could not check your content. Your saved posts are still available.' }); }
});
router.post('/prepare', requireAuth, async (req, res) => {
  try { res.json(await prepareContentAssistant(req.beautician, req.body)); }
  catch (error) { logger.warn({ err: error }, 'Content assistant preparation failed'); res.status(error.status || 503).json({ error: error.status ? error.message : 'Could not prepare your content. Check your saved drafts before trying again.' }); }
});
export default router;
