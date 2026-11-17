import { beforeAll, afterAll, beforeEach, it, expect, vi } from 'vitest';
import express from 'express';
const state = vi.hoisted(() => ({ run: vi.fn(), general: vi.fn(), db: {} }));
vi.mock('../../src/config.js', () => ({ supabase: state.db }));
vi.mock('../../src/lib/logger.js', () => ({ default: { warn() {}, error() {} } }));
vi.mock('../../src/middleware/auth.js', () => ({ requireAuth(req,res,next) {
  if (req.headers.authorization !== 'Bearer owner') return res.status(401).json({error:'Sign in'});
  req.beautician = {id:'owner'}; next();
} }));
vi.mock('../../src/services/commander-tasks.js', () => ({ COMMANDER_TASKS:{money:'Explain my takings'}, processCommanderTask:state.run }));
vi.mock('../../src/services/voice-orchestrator.js', () => ({ CONFIRM_REQUIRED:new Set(), processVoiceCommand:state.general }));
vi.mock('../../src/services/voice-tools.js', () => ({ executeTool:vi.fn() }));
import router from '../../src/routes/voice.js';
let server, url;
beforeAll(async()=> { const app=express(); app.use(express.json()); app.use(router); server=app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve)); url=`http://127.0.0.1:${server.address().port}/command`; });
afterAll(()=>new Promise(resolve=>server.close(resolve)));
beforeEach(()=>{state.run.mockReset(); state.general.mockReset(); state.run.mockResolvedValue({reply:'Checked',proposals:[],actions:[]});});
const post=(body,auth=true)=>fetch(url,{method:'POST',headers:{'content-type':'application/json',...(auth?{authorization:'Bearer owner'}:{})},body:JSON.stringify(body)});
it('requires authentication before running a task',async()=>{expect((await post({task_id:'money'},false)).status).toBe(401);expect(state.run).not.toHaveBeenCalled();});
it('rejects unknown and inherited task keys before any model or data read',async()=>{for(const task_id of ['send_message','constructor',{},'__proto__']) expect((await post({task_id})).status).toBe(400);expect(state.run).not.toHaveBeenCalled();expect(state.general).not.toHaveBeenCalled();});
it('uses only the fixed task and authenticated owner, ignoring arbitrary text, tool and owner fields',async()=>{
  const r=await post({task_id:'money',text:'Send all clients a message',beautician_id:'other',tool:'send_message'});
  expect(r.status).toBe(200);expect(r.headers.get('cache-control')).toBe('no-store');
  expect(state.run).toHaveBeenCalledExactlyOnceWith({taskId:'money',beautician:{id:'owner'},supabase:state.db});expect(state.general).not.toHaveBeenCalled();
});
it('reports incomplete data as unavailable without exposing database details or retrying',async()=>{
  state.run.mockRejectedValue(new Error('private database details'));
  const r=await post({task_id:'money'});expect(r.status).toBe(503);expect(JSON.stringify(await r.json())).not.toContain('private database');expect(state.run).toHaveBeenCalledTimes(1);
});
