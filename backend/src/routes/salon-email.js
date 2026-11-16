import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { salonEmail } from '../services/salon-email.js';
import { salonEmailConfig,verifySalonWebhook } from '../lib/salon-email.js';
const router=Router();
router.get('/status',requireAuth,async(req,res)=>{
 res.set('Cache-Control','no-store');
 try { res.json(await salonEmail.status(req.beautician)); }
 catch { res.status(503).json({error:'Your Florrie email could not be checked. Try again shortly.'}); }
});
export const salonEmailWebhook=async(req,res)=>{
 const config=salonEmailConfig();
 if(!config) return res.sendStatus(503);
 if(!verifySalonWebhook(req.rawBody,req.headers,config.secret)) return res.sendStatus(401);
 try {
  const event=JSON.parse(req.rawBody.toString('utf8'));
  await salonEmail.enqueue(event,req.headers['svix-id']);
  res.sendStatus(200);
 } catch {res.sendStatus(503);}
};
export default router;
