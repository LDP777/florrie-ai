import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getFlorrieThoughts, readThoughtCandidates } from '../services/florrie-thinking.js';
import { createThoughtActions } from '../services/thought-actions.js';
import { supabase } from '../config.js';
const router=Router();
const actions = createThoughtActions({ db: supabase, candidates: readThoughtCandidates });
router.get('/',requireAuth,async(req,res)=>{
 res.set('Cache-Control', 'no-store');
 if (req.query.fresh === '1') getFlorrieThoughts.invalidate(req.beautician.id);
 try {res.json(await getFlorrieThoughts(req.beautician));}
 catch {res.status(503).json({error:'Could not check your priorities. Try again.'});}
});
router.post('/prepare', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try { res.json(await actions.prepare(req.beautician, req.body?.id)); }
  catch (err) { res.status(err.status || 503).json({ error: err.status ? err.message : 'Could not check everything needed for this suggestion. Please try again.' }); }
});
router.post('/confirm', requireAuth, async (req, res) => {
  res.set('Cache-Control', 'no-store');
  try {
    const result = await actions.execute(req.beautician, req.body?.confirmation_token);
    getFlorrieThoughts.invalidate(req.beautician.id);
    res.json(result);
  } catch (err) { res.status(err.status || 503).json({ error: err.status ? err.message : 'Could not confirm this diary change. Refresh before trying again.' }); }
});
export default router;
