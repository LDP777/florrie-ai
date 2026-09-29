import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { createGoogleReviews, reviewFingerprint } from '../../src/services/google-reviews.js';
import { encrypt } from '../../src/lib/crypto.js';
import { signOAuthState } from '../../src/lib/oauth-state.js';

const owner='salon-a',other='salon-b',location='accounts/12/locations/34';
let rows,writeError,readError,network,service,env;
const current={name:`${location}/reviews/review_1`,reviewId:'review_1',comment:'A welcoming studio.',starRating:'FIVE',updateTime:'2026-09-27T10:00:00Z'};
function database(){return {from(){let predicates=[],change,remove=false,upsert;const q={select(){return q;},eq(k,v){predicates.push(r=>r[k]===v);return q;},gt(k,v){predicates.push(r=>r[k]>v);return q;},maybeSingle(){q.one=true;return q;},update(v){change=v;return q;},upsert(v){upsert=v;return q;},delete(){remove=true;return q;},then(resolve){
 if((change||upsert||remove)?writeError:readError)return Promise.resolve({data:null,error:{code:'offline'}}).then(resolve);
 if(upsert){const found=rows.find(r=>r.beautician_id===upsert.beautician_id);if(found)Object.assign(found,upsert);else rows.push({...upsert});}
 const matches=rows.filter(r=>predicates.every(p=>p(r)));if(change)matches.forEach(r=>Object.assign(r,change));if(remove)rows=rows.filter(r=>!matches.includes(r));
 return Promise.resolve({data:q.one?(matches[0]?{...matches[0]}:null):matches.map(r=>({...r})),error:null}).then(resolve);
 }};return q;}};}
function ok(body,status=200){return {ok:status<400,status,json:async()=>body};}
function seed(id=owner,credentials={}){const key=createHash('sha256').update(`florrie.google-reviews.tokens:${env.OAUTH_STATE_SECRET}`).digest('hex');rows.push({beautician_id:id,tokens:encrypt({access_token:'access',refresh_token:'refresh',expires_at:Date.now()+3600000,...credentials},key),location_name:location,location_title:'Fictional salon'});}
beforeEach(()=>{rows=[];writeError=false;readError=false;process.env.OAUTH_STATE_SECRET='shared-test-secret';env={GOOGLE_REVIEWS_ENABLED:'true',GOOGLE_REVIEWS_CLIENT_ID:'test-client',GOOGLE_REVIEWS_CLIENT_SECRET:'test-secret',GOOGLE_REVIEWS_REDIRECT_URI:'https://api.test/api/google-reviews/callback',OAUTH_STATE_SECRET:process.env.OAUTH_STATE_SECRET};network=vi.fn(async()=>ok(current));service=createGoogleReviews({db:database(),fetchImpl:network,env});});
describe('Google reviews require a real authorised connection',()=>{
 it('does not offer a connection before provider setup is enabled',async()=>{env.GOOGLE_REVIEWS_ENABLED='false';expect(await service.status(owner)).toMatchObject({available:false,connected:false});await expect(service.connect(owner)).rejects.toThrow('not available');expect(network).not.toHaveBeenCalled();});
 it('does not expose tokens or nonces in status',async()=>{seed();network.mockResolvedValue(ok({title:'Fictional salon'}));expect(await service.status(owner)).toEqual({available:true,connected:true,location:{name:location,title:'Fictional salon'}});});
 it('checks the owner on every read',async()=>{seed(other);await expect(service.list(owner)).rejects.toThrow('Connect');expect(network).not.toHaveBeenCalled();});
 it('uses signed, purpose-bound state with one-time storage and only the Business Profile scope',async()=>{const u=new URL(await service.connect(owner,true));expect(u.origin).toBe('https://accounts.google.com');expect(u.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/business.manage');expect(u.searchParams.get('prompt')).toBe('consent select_account');expect(rows[0].oauth_nonce).toHaveLength(48);expect(u.searchParams.get('state')).toContain('v1.');});
 it('rejects calendar/other OAuth state without exchanging a code',async()=>{await expect(service.callback('code',signOAuthState({beauticianId:owner}))).rejects.toThrow('expired');expect(network).not.toHaveBeenCalled();});
 it('rejects replays and saves encrypted credentials once',async()=>{const u=new URL(await service.connect(owner));const state=u.searchParams.get('state');network.mockResolvedValue(ok({access_token:'new-access',refresh_token:'new-refresh',expires_in:3600,scope:'https://www.googleapis.com/auth/business.manage'}));await service.callback('code',state);expect(rows[0].tokens).not.toContain('new-access');await expect(service.callback('code',state)).rejects.toThrow('already used');expect(network).toHaveBeenCalledTimes(1);});
 it('does not claim to connect after a failed save',async()=>{const u=new URL(await service.connect(owner));network.mockImplementation(async()=>{writeError=true;return ok({access_token:'a',refresh_token:'r',expires_in:3600,scope:'https://www.googleapis.com/auth/business.manage'});});await expect(service.callback('code',u.searchParams.get('state'))).rejects.toThrow('not saved');expect(rows[0].tokens).toBeUndefined();});
 it('requires Google to grant the correct scope',async()=>{const u=new URL(await service.connect(owner));network.mockResolvedValue(ok({access_token:'a',refresh_token:'r',expires_in:3600,scope:'calendar'}));await expect(service.callback('code',u.searchParams.get('state'))).rejects.toThrow('did not grant');});
 it('does not erase a connection for a temporary provider failure',async()=>{seed();const saved=rows[0].tokens;network.mockRejectedValue(new Error('offline'));await expect(service.list(owner)).rejects.toThrow('too long');expect(rows[0].tokens).toBe(saved);});
 it('reads live reviews without saving their text or learning it',async()=>{seed();const before=JSON.stringify(rows);network.mockResolvedValue(ok({reviews:[current],nextPageToken:'next'}));const out=await service.list(owner);expect(out.reviews[0].fingerprint).toBe(reviewFingerprint(current));expect(JSON.stringify(rows)).toBe(before);expect(out.nextPageToken).toBe('next');});
 it('rejects unowned business selection',async()=>{seed();network.mockResolvedValue(ok({accounts:[{name:'accounts/12'}],locations:[{name:'locations/34',title:'Fictional salon'}]}));await expect(service.selectLocation(owner,'accounts/88/locations/99')).rejects.toThrow('not available');expect(rows[0].location_name).toBe(location);});
 it('only disconnects this salon and does not revoke other Google products',async()=>{seed();seed(other);await service.disconnect(owner);expect(rows.map(r=>r.beautician_id)).toEqual([other]);expect(network).not.toHaveBeenCalled();});
});
describe('each salon can recover its own Google connection',()=>{
 it('shows reconnect after revoked refresh permission instead of an endless retry',async()=>{
  seed(owner,{expires_at:0});seed(other);const before=JSON.stringify(rows);
  network.mockResolvedValue(ok({error:'invalid_grant'},400));
  expect(await service.status(owner)).toMatchObject({available:true,connected:false,reconnect_required:true,check_error:'Reconnect Google to continue.'});
  expect(JSON.stringify(rows)).toBe(before);
  await expect(service.list(owner)).rejects.toMatchObject({status:409,message:'Reconnect Google to continue.'});
 });
 it('checks credentials even if a salon has not selected a business yet',async()=>{
  seed(owner,{expires_at:0});rows[0].location_name=null;
  network.mockResolvedValue(ok({error:'invalid_grant'},400));
  expect(await service.status(owner)).toMatchObject({connected:false,reconnect_required:true,location:null});
 });
 it('does not call a provider when encrypted credentials can no longer be read',async()=>{
  seed();rows[0].tokens='unreadable';
  expect(await service.status(owner)).toMatchObject({connected:false,reconnect_required:true});
  expect(network).not.toHaveBeenCalled();
 });
 it('keeps temporary provider outages separate from revoked access',async()=>{
  seed(owner,{expires_at:0});const saved=rows[0].tokens;network.mockRejectedValue(new Error('offline'));
  const status=await service.status(owner);
  expect(status).toMatchObject({connected:true,check_error:'Google took too long to respond. Try again.'});
  expect(status.reconnect_required).toBeUndefined();expect(rows[0].tokens).toBe(saved);
 });
 it.each(['invalid_client','unauthorized_client'])('identifies global %s configuration without blaming the salon sign-in',async error=>{
  seed(owner,{expires_at:0});network.mockResolvedValue(ok({error},401));
  const status=await service.status(owner);
  expect(status).toMatchObject({connected:true,check_error:'Google connections need attention from Florrie. Try again later.'});
  expect(status.reconnect_required).toBeUndefined();
 });
 it('only saves a selected business for the owner who authorised its account',async()=>{
  seed();seed(other);const untouched={...rows[1]};
  network.mockResolvedValueOnce(ok({accounts:[{name:'accounts/12'}]})).mockResolvedValueOnce(ok({locations:[{name:'locations/56',title:'Chosen salon'}]}));
  expect(await service.selectLocation(owner,'accounts/12/locations/56')).toMatchObject({name:'accounts/12/locations/56'});
  expect(rows[0].location_name).toBe('accounts/12/locations/56');expect(rows[1]).toEqual(untouched);
 });
 it('does not save a location looked up before the salon reconnected a different account',async()=>{
  seed();
  network.mockResolvedValueOnce(ok({accounts:[{name:'accounts/12'}]})).mockImplementationOnce(async()=>{
   rows[0].tokens='new-account-credentials';rows[0].location_name=null;
   return ok({locations:[{name:'locations/56',title:'Old account salon'}]});
  });
  await expect(service.selectLocation(owner,'accounts/12/locations/56')).rejects.toMatchObject({status:409,message:expect.stringContaining('connection changed')});
  expect(rows[0].location_name).toBeNull();expect(rows[0].tokens).toBe('new-account-credentials');
 });
 it('does not resurrect a location selection after disconnect',async()=>{
  seed();
  network.mockResolvedValueOnce(ok({accounts:[{name:'accounts/12'}]})).mockImplementationOnce(async()=>{
   await service.disconnect(owner);return ok({locations:[{name:'locations/56',title:'Old account salon'}]});
  });
  await expect(service.selectLocation(owner,'accounts/12/locations/56')).rejects.toMatchObject({status:409});expect(rows).toEqual([]);
 });
 it('can select a location after refreshing an expired access token',async()=>{
  seed(owner,{expires_at:0});const before=rows[0].tokens;
  network.mockResolvedValueOnce(ok({access_token:'fresh-access',expires_in:3600})).mockResolvedValueOnce(ok({accounts:[{name:'accounts/12'}]})).mockResolvedValueOnce(ok({locations:[{name:'locations/56',title:'Chosen salon'}]}));
  expect(await service.selectLocation(owner,'accounts/12/locations/56')).toMatchObject({name:'accounts/12/locations/56'});
  expect(rows[0].tokens).not.toBe(before);expect(rows[0].location_name).toBe('accounts/12/locations/56');
  expect(network.mock.calls[1][1].headers.Authorization).toBe('Bearer fresh-access');
 });
});
describe('Google replies stay under the owner’s control',()=>{
 beforeEach(()=>seed());
 it('requires explicit approval and nonempty words before any provider call',async()=>{await expect(service.reply(owner,'review_1','Thank you',reviewFingerprint(current),false)).rejects.toThrow('approve');expect(network).not.toHaveBeenCalled();});
 it('rejects review/path injection',async()=>{await expect(service.reply(owner,'../other','Thank you','hash',true)).rejects.toThrow('Choose');expect(network).not.toHaveBeenCalled();});
 it('refuses a review changed since the draft',async()=>{network.mockResolvedValue(ok({...current,comment:'Changed'}));await expect(service.reply(owner,'review_1','Thank you',reviewFingerprint(current),true)).rejects.toThrow('changed');expect(network).toHaveBeenCalledTimes(1);});
 it('never replies to a mismatched location response',async()=>{network.mockResolvedValue(ok({...current,name:'accounts/12/locations/99/reviews/review_1'}));await expect(service.reply(owner,'review_1','Thank you','hash',true)).rejects.toThrow('different review');});
 it('publishes only the approved exact reply and waits for Google confirmation',async()=>{network.mockResolvedValueOnce(ok(current)).mockResolvedValueOnce(ok({comment:'Thank you',updateTime:'now'}));expect(await service.reply(owner,'review_1','Thank you',reviewFingerprint(current),true)).toMatchObject({reply:{comment:'Thank you'}});const [url,options]=network.mock.calls[1];expect(url).toBe(`https://mybusiness.googleapis.com/v4/${location}/reviews/review_1/reply`);expect(options.method).toBe('PUT');expect(JSON.parse(options.body)).toEqual({comment:'Thank you'});});
 it('does not issue another write when the same reply already reached Google',async()=>{network.mockResolvedValue(ok({...current,reviewReply:{comment:'Thank you'}}));expect(await service.reply(owner,'review_1','Thank you','old-hash',true)).toMatchObject({already_posted:true});expect(network).toHaveBeenCalledTimes(1);});
 it('reports uncertain delivery without retrying an interrupted publish',async()=>{network.mockResolvedValueOnce(ok(current)).mockRejectedValueOnce(new Error('lost'));await expect(service.reply(owner,'review_1','Thank you',reviewFingerprint(current),true)).rejects.toThrow('uncertain');expect(network).toHaveBeenCalledTimes(2);});
});
