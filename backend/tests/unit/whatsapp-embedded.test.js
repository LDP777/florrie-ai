import { beforeEach,afterEach,describe,it,expect,vi } from 'vitest';
vi.mock('../../src/config.js',()=>({supabase:{}}));
import { encrypt, decrypt } from '../../src/lib/crypto.js';
import { resolveWhatsAppCredentials } from '../../src/lib/whatsapp-connection.js';
import { completeWhatsAppSignup } from '../../src/lib/whatsapp-signup.js';
const salon='56b47ba3-4b63-415c-a907-b30f118ca2c3';
const config={appId:'100',configId:'200',version:'v21.0'};
const session={id:'session1',beautician_id:salon};
const calls=[];
let tokenData, phoneData, db;
function connectionDb(row,error=null){return {from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:row,error})})})})};}
const fetchImpl=async(url,options)=>{
 const u=new URL(url);calls.push({path:u.pathname,headers:options.headers,body:options.body});
 let data;
 if(u.pathname.endsWith('/oauth/access_token'))data={access_token:'customer-token'};
 else if(u.pathname.endsWith('/debug_token'))data={data:tokenData};
 else if(u.pathname.endsWith('/300/phone_numbers'))data={data:[phoneData]};
 else if(u.pathname.endsWith('/300/subscribed_apps'))data=options.method==='POST'?{success:true}:{data:[{whatsapp_business_api_data:{id:'100'}}]};
 else if(u.pathname.endsWith('/400/register'))data={success:true};
 else if(u.pathname.endsWith('/400'))data={id:'400',status:'CONNECTED'};
 else if(u.pathname.endsWith('/300'))data={id:'300'};
 else throw new Error('Unexpected provider request');
 return {ok:true,json:async()=>data};
};
const complete=()=>completeWhatsAppSignup({db,session,code:'authorisation-code',wabaId:'300',phoneId:'400',config,fetchImpl});
beforeEach(()=>{
 vi.stubEnv('WHATSAPP_TENANT_CREDENTIALS_ENABLED','true');vi.stubEnv('ENCRYPTION_KEY','ab'.repeat(32));
 vi.stubEnv('WHATSAPP_APP_SECRET','app-secret');vi.stubEnv('WHATSAPP_TOKEN','legacy-token');
 calls.length=0;tokenData={is_valid:true,app_id:'100',scopes:['whatsapp_business_management','whatsapp_business_messaging'],granular_scopes:[{scope:'whatsapp_business_management',target_ids:['300']}]};
 phoneData={id:'400',display_phone_number:'+44 7700 900001',code_verification_status:'VERIFIED',status:'VERIFIED'};
 db={rpc:vi.fn(async()=>({data:true,error:null}))};
});
afterEach(()=>vi.unstubAllEnvs());
describe('customer WhatsApp isolation',()=>{
 it('uses only credentials bound to this salon and phone',async()=>{
   const row={mode:'embedded',phone_id:'400',waba_id:'300',credentials:encrypt({token:'customer-token',beauticianId:salon,phoneId:'400',wabaId:'300'})};
   expect((await resolveWhatsAppCredentials(salon,'400',connectionDb(row))).token).toBe('customer-token');
   expect(await resolveWhatsAppCredentials(salon,'401',connectionDb(row))).toBeNull();
   await expect(resolveWhatsAppCredentials('another-salon','400',connectionDb(row))).rejects.toThrow('ownership');
 });
 it('never falls back to platform credentials when missing, expired or storage fails',async()=>{
   expect(await resolveWhatsAppCredentials(salon,'400',connectionDb(null))).toBeNull();
   await expect(resolveWhatsAppCredentials(salon,'400',connectionDb(null,{code:'42P01'}))).rejects.toThrow();
   expect(await resolveWhatsAppCredentials(salon,'400',connectionDb({mode:'embedded',phone_id:'400',waba_id:'300',credentials:encrypt({token:'old',beauticianId:salon,phoneId:'400',wabaId:'300',expiresAt:'2020-01-01'})}))).toBeNull();
 });
 it('shares WhatsApp credentials across deployments without rotating other integration keys',async()=>{
   vi.stubEnv('WHATSAPP_CREDENTIALS_KEY','cd'.repeat(32));
   const oldIntegration=encrypt({refreshToken:'existing-integration'});
   await complete();const cipher=db.rpc.mock.calls[1][1].p_credentials;
   vi.stubEnv('ENCRYPTION_KEY','ef'.repeat(32));
   const row={mode:'embedded',phone_id:'400',waba_id:'300',credentials:cipher};
   expect((await resolveWhatsAppCredentials(salon,'400',connectionDb(row))).token).toBe('customer-token');
   vi.stubEnv('ENCRYPTION_KEY','ab'.repeat(32));expect(decrypt(oldIntegration).refreshToken).toBe('existing-integration');
 });
 it('preserves explicit legacy connections',async()=>{
   expect((await resolveWhatsAppCredentials(salon,'400',connectionDb({mode:'legacy',phone_id:'400'}))).token).toBe('legacy-token');
 });
});
describe('provider ownership and activation',()=>{
 it('validates the customer grant, reserves ownership, verifies activation and stores encrypted credentials',async()=>{
   expect(await complete()).toMatchObject({connected:true});
   expect(db.rpc.mock.calls.map(c=>c[0])).toEqual(['reserve_whatsapp_phone','finish_whatsapp_signup']);
   const saved=db.rpc.mock.calls[1][1];expect(saved.p_credentials).not.toContain('customer-token');
   expect(calls.filter(c=>!/oauth|debug_token/.test(c.path)).every(c=>c.headers.Authorization==='Bearer customer-token')).toBe(true);
 });
 it.each(['invalid','wrong-app','missing-scope','wrong-waba','expired'])('rejects %s tokens before registration or storage',async(reason)=>{
   if(reason==='invalid')tokenData.is_valid=false;
   if(reason==='wrong-app')tokenData.app_id='evil';
   if(reason==='missing-scope')tokenData.scopes=[];
   if(reason==='wrong-waba')tokenData.granular_scopes[0].target_ids=['999'];
   if(reason==='expired')tokenData.expires_at=1;
   await expect(complete()).rejects.toThrow();expect(db.rpc).not.toHaveBeenCalled();
   expect(calls.some(c=>/register|subscribed_apps/.test(c.path))).toBe(false);
 });
 it('rejects a phone outside the granted WABA',async()=>{
   phoneData.id='999';await expect(complete()).rejects.toThrow('does not belong');expect(db.rpc).not.toHaveBeenCalled();
 });
 it('does not register a phone claimed by another salon',async()=>{
   db.rpc.mockResolvedValue({data:false});await expect(complete()).rejects.toThrow('already connected');
   expect(calls.some(c=>c.path.endsWith('/register'))).toBe(false);
 });
 it('does not reset an already connected Meta number',async()=>{
   phoneData.status='CONNECTED';await complete();expect(calls.some(c=>c.path.endsWith('/register'))).toBe(false);
 });
 it('does not report success when the atomic save is refused',async()=>{
   db.rpc.mockImplementation(async(name)=>({data:name==='reserve_whatsapp_phone'}));
   await expect(complete()).rejects.toThrow('could not be saved');
 });
});
