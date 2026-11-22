import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { contentV2 } from '../services/content-v2/index.js';
import { isUuid, publicPost, contentError } from '../services/content-v2/state.js';
import logger from '../lib/logger.js';

export function createContentV2Router(service=contentV2) {
  const router=Router();
  router.use(requireAuth);
  router.use((req,res,next)=>{
    if(req.beautician.content_v2!==true) return res.status(404).json({error:'This Content update is not enabled for your salon yet.'});
    next();
  });
  const handle=fn=>async(req,res)=>{
    try {
      if(req.params.id && !isUuid(req.params.id)) throw contentError('Choose a saved item.',400);
      const result=await fn(req,req.beautician.id);
      res.json(result);
    } catch(error) {
      if(!error.status || error.status>=500) logger.warn({err:error,owner:req.beautician?.id},'Content request failed');
      res.status(error.status || 503).json({error:error.status?error.message:'Could not finish that request. Try again.',
        ...(error.code?{code:error.code}:{}),...(error.post?{post:error.post}:{}),...(error.preparation?{preparation:error.preparation}:{})});
    }
  };
  router.get('/home',handle((req,owner)=>service.home(owner)));
  router.post('/preparations',handle((req,owner)=>service.prepare(owner,req.body.request_id,req.body.request)));
  router.get('/preparations/:id',handle((req,owner)=>service.preparation(owner,req.params.id)));
  router.post('/ask',handle((req,owner)=>service.ask(owner,req.body.request_id,req.body.text)));
  router.get('/posts',handle((req,owner)=>{
    if(req.query.status && !['draft','approved','scheduled','failed','posted'].includes(req.query.status)) throw contentError('Choose a supported post state.',400);
    return service.listPosts(owner,req.query.status);
  }));
  router.get('/posts/:id',handle(async(req,owner)=>({post:publicPost(await service.getPost(owner,req.params.id),await service.connections(owner))})));
  router.patch('/posts/:id',handle((req,owner)=>service.edit(owner,req.params.id,req.body)));
  router.post('/posts/:id/revise',handle((req,owner)=>service.revise(owner,req.params.id,req.body.instruction)));
  router.post('/posts/:id/undo',handle((req,owner)=>service.undo(owner,req.params.id)));
  router.post('/posts/:id/approve',handle((req,owner)=>service.approve(owner,req.params.id,req.body.expected_hash)));
  router.post('/posts/:id/timing',handle((req,owner)=>service.timing(owner,req.params.id,req.body.at)));
  for(const action of ['move-back','retry','posted-by-owner','post-now','restore']) router.post(`/posts/:id/${action}`,handle((req,owner)=>service.action(owner,req.params.id,action)));
  router.delete('/posts/:id',handle((req,owner)=>service.action(owner,req.params.id,'remove')));
  router.get('/results',handle((req,owner)=>{
    const days=req.query.days===undefined?30:Number(req.query.days);
    if(!Number.isSafeInteger(days) || days<1 || days>90) throw contentError('Choose between 1 and 90 days.',400);
    return service.results(owner,days);
  }));
  router.get('/photos',handle((req,owner)=>service.photos(owner)));
  router.post('/photos',handle((req,owner)=>service.savePhoto(owner,req.body)));
  router.patch('/photos',handle((req,owner)=>{
    if(!isUuid(req.body.id)) throw contentError('Choose a saved photo.',400);
    return service.savePhoto(owner,req.body);
  }));
  router.get('/voice',handle((req,owner)=>service.voice(owner)));
  router.delete('/voice/:id',handle((req,owner)=>service.forget(owner,req.params.id)));
  router.get('/offers',handle((req,owner)=>service.offers(owner)));
  return router;
}
export default createContentV2Router();
