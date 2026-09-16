import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import express from 'express';
import { verifyMetaSignedRequest } from '../../src/lib/meta-signed-request.js';

const fake = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('../../src/config.js', () => ({ supabase: fake }));
const { default: router } = await import('../../src/routes/whatsapp-privacy.js');
const secret = 'whatsapp-test-secret';
const code = 'a'.repeat(48);
const signed = (data = {}, key = secret) => {
  const payload = Buffer.from(JSON.stringify({ algorithm: 'HMAC-SHA256', user_id: '12345', issued_at: Math.floor(Date.now()/1000), ...data })).toString('base64url');
  return createHmac('sha256', key).update(payload).digest('base64url') + '.' + payload;
};
let server, base;
beforeAll(async () => {
  const app = express(); app.use(express.json()); app.use(express.urlencoded({ extended: false })); app.use(router);
  server = app.listen(0,'127.0.0.1'); await new Promise(resolve => server.once('listening',resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
afterAll(() => new Promise(resolve => server.close(resolve)));
beforeEach(() => {
  vi.clearAllMocks(); process.env.WHATSAPP_APP_SECRET = secret;
  process.env.WHATSAPP_SIGNUP_URL = 'https://api.florrie.test/api/whatsapp/embedded';
  fake.rpc.mockResolvedValue({ data: { confirmation_code: code, status: 'needs_review' }, error: null });
  const query = { select:()=>query, eq:()=>query, maybeSingle:async()=>({data:{status:'needs_review'},error:null}) };
  fake.from.mockReturnValue(query);
});
const post = (path, value) => fetch(base + path, { method:'POST', body:new URLSearchParams({signed_request:value}) });

describe('WhatsApp privacy callbacks', () => {
  it('saves a verified deletion request before returning its unique status link', async () => {
    const response = await post('/data-deletion',signed());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({url:`https://api.florrie.test/api/whatsapp/privacy/data-deletion/status/${code}`,confirmation_code:code});
    expect(fake.rpc).toHaveBeenCalledWith('request_whatsapp_data_action',expect.objectContaining({p_action:'delete',p_kind:'user',p_account_hash:expect.stringMatching(/^[a-f0-9]{64}$/)}));
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(fake.rpc.mock.calls[0][1].p_account_hash).not.toBe(verifyMetaSignedRequest(signed(),secret).accountHash);
  });
  it('acknowledges deauthorization only after the atomic database action', async () => {
    expect(await (await post('/deauthorize',signed())).json()).toEqual({success:true});
    expect(fake.rpc.mock.calls[0][1].p_action).toBe('deauthorize');
  });
  it('never mutates data for an unsigned or wrong-app callback', async () => {
    expect((await post('/data-deletion','')).status).toBe(403);
    expect((await post('/deauthorize',signed({},'another-app'))).status).toBe(403);
    expect(fake.rpc).not.toHaveBeenCalled();
  });
  it('never falls back to the Instagram app secret', async () => {
    delete process.env.WHATSAPP_APP_SECRET; delete process.env.META_APP_SECRET; process.env.INSTAGRAM_APP_SECRET=secret;
    expect((await post('/deauthorize',signed())).status).toBe(503);
    expect(fake.rpc).not.toHaveBeenCalled();
  });
  it('returns a retryable failure when saving the receipt fails', async () => {
    fake.rpc.mockResolvedValue({error:{message:'database error containing sensitive details'}});
    const response = await post('/data-deletion',signed());
    expect(response.status).toBe(503); expect(await response.text()).not.toContain('sensitive');
  });
  it('does not call a pending deletion complete or expose salon identifiers', async () => {
    const response = await fetch(base+'/data-deletion/status/'+code); const html=await response.text();
    expect(response.status).toBe(200); expect(html).toContain('Deletion is not complete yet');
    expect(html).not.toContain('beautician'); expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  });
  it('rejects guessed or malformed status references before querying', async () => {
    expect((await fetch(base+'/data-deletion/status/12345')).status).toBe(404); expect(fake.from).not.toHaveBeenCalled();
  });
  it('shows an unavailable status as unavailable, never complete', async () => {
    const query={select:()=>query,eq:()=>query,maybeSingle:async()=>({error:{message:'unavailable'}})};fake.from.mockReturnValue(query);
    const response=await fetch(base+'/data-deletion/status/'+code);
    expect(response.status).toBe(503);expect(await response.text()).toContain('Status temporarily unavailable');
  });
});
