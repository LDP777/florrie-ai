import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { getFlorrieThoughts } from '../services/florrie-thinking.js';
const router=Router();
router.get('/',requireAuth,async(req,res)=>{
 try {res.json(await getFlorrieThoughts(req.beautician));}
 catch {res.status(503).json({error:'Could not check your priorities. Try again.'});}
});
export default router;
