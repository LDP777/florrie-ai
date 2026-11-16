import { beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';
const state = vi.hoisted(() => ({ rows: [], error: null, writes: 0 }));
vi.mock('../../src/config.js', () => ({ supabase: { from(table) {
  if (table !== 'waitlist_signups') throw Error('Wrong table');
  return {
    upsert(row, options) {
      state.writes++;
      expect(options).toEqual({ onConflict: 'email', ignoreDuplicates: true });
      if (!state.error && !state.rows.some(r => r.email === row.email)) state.rows.push({ ...row, unsubscribe_token: '11111111-2222-3333-4444-555555555555' });
      return { abortSignal: async () => ({ error: state.error }) };
    },
    update(patch) {
      const filters = [];
      const q = { eq: (key, value) => { filters.push([key, value]); return q; }, is: (key, value) => { filters.push([key, value]); return q; },
        abortSignal: async () => { state.writes++; if (!state.error) state.rows.filter(r => filters.every(([k,v]) => (r[k] ?? null) === v)).forEach(r => Object.assign(r,patch)); return { error: state.error }; } };
      return q;
    },
  };
} } }));
vi.mock('../../src/middleware/turnstile.js', () => ({ verifyTurnstile: (_req,_res,next) => next() }));
vi.mock('../../src/lib/logger.js', () => ({ default: { error() {} } }));
const { default: router } = await import('../../src/routes/waitlist.js');
const app = express(); app.use(express.json()); app.use('/api/waitlist', router);
const server = createServer(app); await new Promise(r => server.listen(0,'127.0.0.1',r));
afterAll(() => new Promise(r => server.close(r)));
const origin = `http://127.0.0.1:${server.address().port}`;
const submit = async body => { const r = await fetch(origin+'/api/waitlist',{ method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body) });return {status:r.status,body:await r.json()}; };
beforeEach(() => { state.rows=[];state.error=null;state.writes=0;vi.unstubAllEnvs(); });
describe('launch mailing list capture', () => {
  it('saves normalized email, explicit consent and bounded attribution without sending email', async () => {
    const r=await submit({email:'  Person@Example.com ',marketingConsent:true,attribution:{utm_source:'instagram',utm_campaign:'ellie_launch'},is_test:true,unsubscribe_token:'attacker'});
    expect(r.status).toBe(200);expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({email:'person@example.com',source:'landing_page',consent_version:'launch-updates-2026-11-16',attribution:{utm_source:'instagram',utm_campaign:'ellie_launch'}});
    expect(state.rows[0].marketing_consent_at).toBeTruthy();expect(state.rows[0].is_test).toBeUndefined();
    expect(JSON.stringify(r.body)).not.toMatch(/@|unsubscribe_token/);
  });
  it('does not save invalid addresses or missing consent',async()=>{
    for(const body of [{email:'bad',marketingConsent:true},{email:'p@example.com'},{email:'p@example.com',marketingConsent:false}]) expect((await submit(body)).status).toBe(400);
    expect(state.writes).toBe(0);
  });
  it('rejects the honeypot before storage',async()=>{expect((await submit({email:'p@example.com',marketingConsent:true,website:'spam'})).status).toBe(400);expect(state.writes).toBe(0);});
  it('keeps original consent and source on duplicate requests, and never clears an unsubscribe',async()=>{
    await submit({email:'p@example.com',marketingConsent:true,attribution:{utm_source:'instagram'}});
    const original={...state.rows[0],unsubscribed_at:'2026-11-17T00:00:00Z'};state.rows[0]=original;
    expect((await submit({email:'P@example.com',marketingConsent:true,attribution:{utm_source:'different'}})).status).toBe(200);
    expect(state.rows).toEqual([original]);
  });
  it('never claims success when storage fails',async()=>{state.error={code:'XX000'};expect((await submit({email:'p@example.com',marketingConsent:true})).status).toBe(503);expect(state.rows).toHaveLength(0);});
  it('fails closed for incomplete enforced CAPTCHA configuration',async()=>{
    vi.stubEnv('TURNSTILE_ENFORCE','true');vi.stubEnv('TURNSTILE_SITE_KEY','');vi.stubEnv('VITE_TURNSTILE_SITE_KEY','');
    expect((await fetch(origin+'/api/waitlist/config')).status).toBe(503);
    expect((await submit({email:'p@example.com',marketingConsent:true})).status).toBe(503);expect(state.writes).toBe(0);
  });
  it('only exposes a public CAPTCHA site key',async()=>{
    vi.stubEnv('TURNSTILE_ENFORCE','true');vi.stubEnv('TURNSTILE_SITE_KEY','public-key');vi.stubEnv('TURNSTILE_SECRET_KEY','private-secret');
    const r=await fetch(origin+'/api/waitlist/config');expect(await r.json()).toEqual({required:true,siteKey:'public-key'});
  });
  it('GET unsubscribe is read-only and POST removes the address from future mailing',async()=>{
    await submit({email:'p@example.com',marketingConsent:true});const token=state.rows[0].unsubscribe_token;
    const before=state.writes;const get=await fetch(origin+'/api/waitlist/unsubscribe?token='+token);
    expect(get.status).toBe(200);expect(await get.text()).toContain('method="post"');expect(state.writes).toBe(before);
    const post=await fetch(origin+'/api/waitlist/unsubscribe',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token})});
    expect(post.status).toBe(200);expect(state.rows[0].unsubscribed_at).toBeTruthy();
  });
  it('rejects malformed unsubscribe tokens without querying storage',async()=>{
    expect((await fetch(origin+'/api/waitlist/unsubscribe?token=%22%3E%3Cscript%3E')).status).toBe(400);
    expect(state.writes).toBe(0);
  });
});
