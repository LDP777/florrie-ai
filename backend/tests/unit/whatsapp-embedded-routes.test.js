import {beforeAll,afterAll,beforeEach,afterEach,it,expect,vi} from 'vitest';
import express from 'express';
const fake=vi.hoisted(()=>({rpc:vi.fn(),from:vi.fn()}));
vi.mock('../../src/config.js',()=>({supabase:fake}));
vi.mock('../../src/middleware/auth.js',()=>({requireAuth:(req,res,next)=>{
 if(req.headers.authorization!=='Bearer test-owner')return res.status(401).json({error:'Sign in'});
 req.beautician={id:'owner'};next();
}}));
vi.mock('../../src/lib/logger.js',()=>({default:{warn:vi.fn()}}));
const {default:router}=await import('../../src/routes/whatsapp-embedded.js');
let server,base;
beforeAll(async()=>{const app=express();app.use(express.json(),router);server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));base=`http://127.0.0.1:${server.address().port}`;});
afterAll(()=>new Promise(r=>server.close(r)));
beforeEach(()=>{
 vi.clearAllMocks();
 for(const [k,v]of Object.entries({WHATSAPP_TENANT_CREDENTIALS_ENABLED:'true',WHATSAPP_EMBEDDED_SIGNUP_ENABLED:'true',WHATSAPP_EMBEDDED_SIGNUP_SALONS:'owner',META_APP_ID:'123',WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID:'456',WHATSAPP_APP_SECRET:'private',ENCRYPTION_KEY:'ab'.repeat(32),WHATSAPP_SIGNUP_URL:'https://api.florrie.ai/api/whatsapp/embedded'}))vi.stubEnv(k,v);
 fake.rpc.mockResolvedValue({data:'session-id'});
});
afterEach(()=>vi.unstubAllEnvs());
const post=(path,body={},auth=false)=>fetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Bearer test-owner'}:{})},body:JSON.stringify(body)});
it('requires authentication before creating a session',async()=>{expect((await post('/embedded/start')).status).toBe(401);expect(fake.rpc).not.toHaveBeenCalled();});
it('creates only an owner-bound hashed single-use secret, never a bearer token in the link',async()=>{
 const r=await post('/embedded/start',{platform:'native',beautician_id:'attacker'},true);const d=await r.json();
 expect(r.status).toBe(200);expect(d.url).toMatch(/^https:\/\/api.florrie.ai\/api\/whatsapp\/embedded#[a-f0-9]{64}$/);
 expect(fake.rpc.mock.calls[0][1]).toMatchObject({p_salon:'owner',p_platform:'native'});
 expect(fake.rpc.mock.calls[0][1].p_hash).not.toEqual(new URL(d.url).hash.slice(1));expect(r.headers.get('cache-control')).toBe('no-store');
});
it('does not start setup outside the rollout',async()=>{vi.stubEnv('WHATSAPP_EMBEDDED_SIGNUP_SALONS','other');expect((await post('/embedded/start',{},true)).status).toBe(503);expect(fake.rpc).not.toHaveBeenCalled();});
it('rejects malformed secrets before any database request',async()=>{expect((await post('/embedded/complete',{secret:'guess'})).status).toBe(400);expect(fake.rpc).not.toHaveBeenCalled();});
it('rejects replayed or expired sessions before provider calls',async()=>{fake.rpc.mockResolvedValue({data:null});expect((await post('/embedded/complete',{secret:'a'.repeat(64)})).status).toBe(410);});
it('returns a bounded safe error when storage throws',async()=>{fake.rpc.mockRejectedValue(new Error('private provider details'));const r=await post('/embedded/complete',{secret:'a'.repeat(64)});expect(r.status).toBe(503);expect(await r.text()).not.toContain('private provider');});
it('delivers the bridge with nonce policy, no cache and no referrer',async()=>{const r=await fetch(base+'/embedded');expect(r.status).toBe(200);expect(r.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");expect(r.headers.get('referrer-policy')).toBe('no-referrer');expect(await r.text()).not.toContain('private');});
