import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import logger from '../lib/logger.js';
import { embeddedSignupEnabled, readWhatsAppConnection, tenantWhatsAppEnabled } from '../lib/whatsapp-connection.js';
import { signupConfig, hashSignupSecret, completeWhatsAppSignup } from '../lib/whatsapp-signup.js';
import { signupPage } from '../lib/whatsapp-signup-page.js';
const router = Router();
const handled = fn => (req, res) => Promise.resolve(fn(req, res)).catch(() => {
  if (!res.headersSent) res.status(503).json({error:'WhatsApp setup could not be checked. Return to Florrie and try again.'});
});
router.use((_req,res,next)=>{res.set('Cache-Control','no-store');res.set('Referrer-Policy','no-referrer');next();});
router.get('/embedded',(_req,res)=>{
  const config=signupConfig();
  if(!config || !tenantWhatsAppEnabled()) return res.status(503).send('WhatsApp setup is not available yet. Return to Florrie.');
  const nonce=randomBytes(18).toString('base64');
  res.set('Content-Security-Policy',`default-src 'none'; script-src 'nonce-${nonce}' https://connect.facebook.net https://www.facebook.com; style-src 'nonce-${nonce}'; connect-src 'self' https://www.facebook.com https://graph.facebook.com; frame-src https://www.facebook.com https://web.facebook.com; img-src https://www.facebook.com data:; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`);
  return res.type('html').send(signupPage(config,nonce));
});
router.post('/embedded/start',requireAuth,handled(async(req,res)=>{
  const config=signupConfig();
  if(!config || !embeddedSignupEnabled(req.beautician.id))return res.status(503).json({error:'WhatsApp self-service setup is not available for this account yet. Keep using Florrie and check back here.'});
  try{
    const secret=randomBytes(32).toString('hex');
    const {data,error}=await supabase.rpc('start_whatsapp_signup',{p_salon:req.beautician.id,p_hash:hashSignupSecret(secret),p_platform:req.body?.platform==='native'?'native':'web'});
    if(error||!data)return res.status(409).json({error:'Could not start a new setup. Check your existing WhatsApp connection and try again.'});
    return res.json({url:`${config.page}#${secret}`});
  }catch{return res.status(503).json({error:'Could not start WhatsApp setup. Try again shortly.'});}
}));
function readSecret(req){const value=req.body?.secret;return typeof value==='string'&&/^[a-f0-9]{64}$/.test(value)?hashSignupSecret(value):null;}
router.post('/embedded/session',handled(async(req,res)=>{
  const hash=readSecret(req);if(!hash)return res.status(400).json({error:'Invalid setup link. Start again from Florrie.'});
  const {data,error}=await supabase.from('whatsapp_signup_sessions').select('platform,beautician_id').eq('secret_hash',hash).eq('status','pending').gt('expires_at',new Date().toISOString()).maybeSingle();
  if(error||!data||!embeddedSignupEnabled(data.beautician_id))return res.status(410).json({error:'This setup link expired. Start again from Florrie.'});
  return res.json({platform:data.platform});
}));
router.post('/embedded/complete',handled(async(req,res)=>{
  const hash=readSecret(req),config=signupConfig();
  if(!hash||!config)return res.status(400).json({error:'Invalid setup. Start again from Florrie.'});
  const {data:session,error}=await supabase.rpc('claim_whatsapp_signup',{p_hash:hash});
  if(error||!session||!embeddedSignupEnabled(session.beautician_id))return res.status(410).json({error:'This setup expired or was already used. Return to Florrie to check your connection.'});
  try{
    const result=await completeWhatsAppSignup({db:supabase,session,code:req.body.code,wabaId:req.body.waba_id,phoneId:req.body.phone_number_id,config});
    return res.json(result);
  }catch(err){
    await supabase.from('whatsapp_signup_sessions').update({status:'failed'}).eq('id',session.id).eq('status','processing');
    await supabase.from('whatsapp_phone_claims').delete().eq('session_id',session.id);
    logger.warn({beauticianId:session.beautician_id,code:err.code||'internal'},'WhatsApp customer signup did not complete');
    return res.status(err.status||503).json({error:err.code?err.message:'Could not finish WhatsApp setup. Return to Florrie and try again.'});
  }
}));
router.get('/embedded/availability',requireAuth,handled(async(req,res)=>{
  try{
    const c=tenantWhatsAppEnabled()?await readWhatsAppConnection(req.beautician.id):null;
    return res.json({available:!!signupConfig()&&embeddedSignupEnabled(req.beautician.id),tenant_mode:tenantWhatsAppEnabled(),connection_mode:c?.mode||null});
  }catch{return res.status(503).json({error:'Could not check WhatsApp setup. Your existing connection has not changed.'});}
}));
export default router;
