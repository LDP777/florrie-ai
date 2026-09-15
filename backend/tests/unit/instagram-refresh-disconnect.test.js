import { beforeEach, afterEach, expect, it, vi } from 'vitest';
const state=vi.hoisted(()=>({profile:null,clientReads:0}));
vi.mock('../../src/config.js',()=>({supabase:{from(table){
  let patch; const filters=[];
  const matches=()=>state.profile && filters.every(([key,value])=>state.profile[key]===value);
  const settle=()=>{
    if(table==='clients'){state.clientReads++;return {data:[],error:null};}
    if(patch){if(matches()){Object.assign(state.profile,patch);return {data:[{id:state.profile.id}],error:null};}return {data:[],error:null};}
    return {data:matches()?[{...state.profile}]:[],error:null};
  };
  const q={select:()=>q,not:()=>q,eq:(k,v)=>{filters.push([k,v]);return q;},update:p=>{patch=p;return q;},or:()=>q,limit:()=>q,
    maybeSingle:async()=>{const result=settle();return {...result,data:result.data[0]||null};},then:(resolve,reject)=>Promise.resolve(settle()).then(resolve,reject)};
  return q;
}}}));
vi.mock('../../src/routes/instagram-webhooks.js',()=>({fetchInstagramIdentity:vi.fn()}));
vi.mock('@sentry/node',()=>({captureMessage:vi.fn()}));
const {refreshInstagramTokens}=await import('../../src/services/instagram-token-refresh.js');
beforeEach(()=>{state.profile={id:'salon',instagram_page_id:'111',instagram_page_token:'old-token'};state.clientReads=0;});
afterEach(()=>vi.unstubAllGlobals());
it.each([null,'replacement-token'])('does not restore a disconnected or replaced token during refresh: %s',async replacement=>{
  vi.stubGlobal('fetch',vi.fn(async()=>{
    state.profile.instagram_page_token=replacement;
    if(!replacement)state.profile.instagram_page_id=null;
    return {ok:true,json:async()=>({access_token:'refreshed-old-token'})};
  }));
  const result=await refreshInstagramTokens();
  expect(state.profile.instagram_page_token).toBe(replacement);
  expect(result).toMatchObject({refreshed:0,skipped:1,failed:0});expect(state.clientReads).toBe(0);
});
it('refreshes and backfills a connection that still matches',async()=>{
  vi.stubGlobal('fetch',vi.fn(async()=>({ok:true,json:async()=>({access_token:'fresh-token'})})));
  const result=await refreshInstagramTokens();
  expect(state.profile.instagram_page_token).toBe('fresh-token');expect(result.refreshed).toBe(1);expect(state.clientReads).toBe(1);
});
