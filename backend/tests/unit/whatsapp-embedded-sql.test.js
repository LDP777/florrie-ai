import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import {beforeAll,afterAll,it,expect} from 'vitest';
let db;
const legacy='00000000-0000-0000-0000-000000000001',one='00000000-0000-0000-0000-000000000002',two='00000000-0000-0000-0000-000000000003';
beforeAll(async()=>{
 db=new PGlite();
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
 CREATE TABLE beauticians(id uuid PRIMARY KEY,wa_provider text,whatsapp_connected boolean default false,whatsapp_phone_id text,twilio_wa_sender text,whatsapp_phone text,whatsapp_registered_at timestamptz,whatsapp_pending_phone text,whatsapp_pending_activation boolean,whatsapp_retry_at timestamptz,whatsapp_retry_reason text,whatsapp_retry_attempts int,whatsapp_retry_exhausted boolean);
 INSERT INTO beauticians(id,whatsapp_phone_id,whatsapp_connected) VALUES('${legacy}','100',true),('${one}',NULL,false),('${two}',NULL,false);`);
 await db.exec(readFileSync(new URL('../../../supabase/migrations/20260916_whatsapp_embedded_signup.sql',import.meta.url),'utf8'));
},20000);
afterAll(async()=>db?.close());
const q=async(sql,params=[])=> (await db.query(sql,params)).rows[0];
it('keeps the live legacy phone and locks private credentials away from app users',async()=>{
 expect(await q('SELECT mode,phone_id FROM whatsapp_connections WHERE beautician_id=$1',[legacy])).toEqual({mode:'legacy',phone_id:'100'});
 const r=await q("SELECT has_table_privilege('authenticated','whatsapp_connections','SELECT') AS allowed");expect(r.allowed).toBe(false);
 await expect(q('SELECT start_whatsapp_signup($1,$2,$3)',[legacy,'a'.repeat(64),'web'])).rejects.toThrow('existing connection');
});
it('consumes a setup once, rejects duplicate phone ownership, and cancels stale completion',async()=>{
 const a=await q("SELECT start_whatsapp_signup($1,$2,'web') AS id",[one,'b'.repeat(64)]);
 const b=await q("SELECT start_whatsapp_signup($1,$2,'native') AS id",[two,'c'.repeat(64)]);
 expect((await q('SELECT claim_whatsapp_signup($1) AS result',['b'.repeat(64)])).result.id).toBe(a.id);
 expect((await q('SELECT claim_whatsapp_signup($1) AS result',['b'.repeat(64)])).result).toBeNull();
 await q('SELECT claim_whatsapp_signup($1)',['c'.repeat(64)]);
 expect((await q("SELECT reserve_whatsapp_phone($1,'100') AS ok",[a.id])).ok).toBe(false);
 expect((await q("SELECT reserve_whatsapp_phone($1,'400') AS ok",[a.id])).ok).toBe(true);
 expect((await q("SELECT reserve_whatsapp_phone($1,'400') AS ok",[b.id])).ok).toBe(false);
 await q('SELECT disconnect_embedded_whatsapp($1)',[one]);
 expect((await q("SELECT finish_whatsapp_signup($1,'400','300','+447700900001','encrypted') AS ok",[a.id])).ok).toBe(false);
 expect((await q('SELECT whatsapp_connected FROM beauticians WHERE id=$1',[legacy])).whatsapp_connected).toBe(true);
});
it('commits a complete connection, then disconnects without touching another salon',async()=>{
 const s=await q("SELECT start_whatsapp_signup($1,$2,'web') AS id",[one,'d'.repeat(64)]);
 await q('SELECT claim_whatsapp_signup($1)',['d'.repeat(64)]);
 await q("SELECT reserve_whatsapp_phone($1,'500')",[s.id]);
 expect((await q("SELECT finish_whatsapp_signup($1,'500','300','+447700900001','encrypted') AS ok",[s.id])).ok).toBe(true);
 expect((await q('SELECT whatsapp_connected FROM beauticians WHERE id=$1',[one])).whatsapp_connected).toBe(true);
 await q('SELECT disconnect_embedded_whatsapp($1)',[one]);
 expect((await q('SELECT whatsapp_phone_id FROM beauticians WHERE id=$1',[one])).whatsapp_phone_id).toBeNull();
 expect((await q('SELECT phone_id FROM whatsapp_connections WHERE beautician_id=$1',[legacy])).phone_id).toBe('100');
});
