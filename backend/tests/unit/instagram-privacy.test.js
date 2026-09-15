import { beforeAll, afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import express from 'express';
import { verifyMetaSignedRequest } from '../../src/lib/meta-signed-request.js';

const fake = vi.hoisted(() => ({ rpc: vi.fn(), from: vi.fn() }));
vi.mock('../../src/config.js', () => ({ supabase: fake }));
const { default: router } = await import('../../src/routes/instagram-privacy.js');
const secret = 'instagram-test-secret';
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
  vi.clearAllMocks(); process.env.INSTAGRAM_APP_SECRET = secret;
  process.env.INSTAGRAM_REDIRECT_URI = 'https://api.florrie.test/api/instagram/callback';
  fake.rpc.mockResolvedValue({ data: { confirmation_code: code, status: 'needs_review' }, error: null });
  const query = { select:()=>query, eq:()=>query, maybeSingle:async()=>({data:{status:'needs_review'},error:null}) };
  fake.from.mockReturnValue(query);
});
const post = (path, value) => fetch(base + path, { method:'POST', body:new URLSearchParams({signed_request:value}) });

describe('Meta signature verification', () => {
  it('verifies the encoded payload and returns no raw account id or signature', () => {
    const result = verifyMetaSignedRequest(signed(),secret);
    expect(Object.keys(result)).toEqual(['accountHash','issuedAt','eventHash']);
    expect(result.accountHash).toMatch(/^[a-f0-9]{64}$/);
  });
  it.each([null, '', 'a.b.c', 'a.b', '..', {}, 'x'.repeat(17000)])('rejects malformed input %j', value => {
    expect(() => verifyMetaSignedRequest(value,secret)).toThrow();
  });
  it.each([{ algorithm:'none' },{user_id:12345},{user_id:"12') OR TRUE"},{issued_at:0},{issued_at:'123'},{issued_at:Math.floor(Date.now()/1000)+600}])('rejects invalid signed claims %j', claims => {
    expect(() => verifyMetaSignedRequest(signed(claims),secret)).toThrow();
  });
  it('rejects a different app secret or missing configuration', () => {
    expect(() => verifyMetaSignedRequest(signed({},'facebook-secret'),secret)).toThrow();
    expect(() => verifyMetaSignedRequest(signed(),undefined)).toThrow();
  });
  it('accepts an authentic older callback so the database can handle delayed delivery and replay', () => {
    expect(verifyMetaSignedRequest(signed({issued_at:1700000000}),secret).issuedAt).toBe('2023-11-14T22:13:20.000Z');
  });
});

describe('Instagram privacy callbacks', () => {
  it('saves a verified deletion request before returning its unique status link', async () => {
    const response = await post('/data-deletion',signed());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({url:`https://api.florrie.test/api/instagram/privacy/data-deletion/status/${code}`,confirmation_code:code});
    expect(fake.rpc).toHaveBeenCalledWith('request_instagram_data_action',expect.objectContaining({p_action:'delete',p_account_hash:expect.stringMatching(/^[a-f0-9]{64}$/)}));
    expect(response.headers.get('cache-control')).toBe('no-store');
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
  it('does not fall back to the main Meta app secret', async () => {
    delete process.env.INSTAGRAM_APP_SECRET; process.env.META_APP_SECRET=secret;
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
