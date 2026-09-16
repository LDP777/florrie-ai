import { it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createHash, randomBytes } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

it('routes verified lifecycle events without touching legacy salons or business records', async () => {
  const db = new PGlite();
  const legacy='00000000-0000-0000-0000-000000000001', one='00000000-0000-0000-0000-000000000002', two='00000000-0000-0000-0000-000000000003';
  const hash=(kind,id)=>createHash('sha256').update(`whatsapp:${kind}:${id}`).digest('hex');
  const q=async(sql,params=[])=> (await db.query(sql,params)).rows[0];
  let n=0;
  const action=(id,kind='user',name='deauthorize',issued=new Date().toISOString(),event=String(++n).padStart(64,'0'))=>q('SELECT request_whatsapp_data_action($1,$2,$3,$4,$5,$6) receipt',[hash(kind,id),kind,name,issued,event,randomBytes(24).toString('hex')]);
  const begin=async(salon,user,waba,phone)=>{
    const secret=String(++n).padStart(64,'f');
    const s=await q("SELECT start_whatsapp_signup($1,$2,'web') id",[salon,secret]);
    await q('SELECT claim_whatsapp_signup($1)',[secret]);
    // Keep callback and new-authorisation seconds distinct without wall-clock waits.
    await q("UPDATE whatsapp_signup_sessions SET created_at=now()-interval '2 seconds' WHERE id=$1",[s.id]);
    expect((await q('SELECT bind_whatsapp_signup_identity($1,$2,$3) ok',[s.id,hash('user',user),hash('waba',waba)])).ok).toBe(true);
    expect((await q('SELECT reserve_whatsapp_phone($1,$2) ok',[s.id,phone])).ok).toBe(true);
    return s.id;
  };
  const finish=async(id,phone,waba)=>q("SELECT finish_whatsapp_signup($1,$2,$3,'+447700900000','encrypted') ok",[id,phone,waba]);
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE beauticians(id uuid PRIMARY KEY,wa_provider text,whatsapp_connected boolean default false,whatsapp_phone_id text,twilio_wa_sender text,whatsapp_phone text,whatsapp_registered_at timestamptz,whatsapp_pending_phone text,whatsapp_pending_activation boolean,whatsapp_retry_at timestamptz,whatsapp_retry_reason text,whatsapp_retry_attempts int,whatsapp_retry_exhausted boolean);
    CREATE TABLE appointments(id int,beautician_id uuid); CREATE TABLE messages(id int,beautician_id uuid,content text);
    INSERT INTO beauticians(id,whatsapp_phone_id,whatsapp_connected) VALUES('${legacy}','100',true),('${one}',NULL,false),('${two}',NULL,false);
    INSERT INTO appointments VALUES(1,'${legacy}'),(2,'${one}'); INSERT INTO messages VALUES(1,'${one}','business record');`);
    for(const file of ['20260916_whatsapp_embedded_signup.sql','20260916_whatsapp_privacy_lifecycle.sql']) await db.exec(await readFile(new URL('../../../supabase/migrations/'+file,import.meta.url),'utf8'));
    const first=await begin(one,'555','300','400');
    expect((await finish(first,'400','300')).ok).toBe(true);
    const other=await begin(two,'666','301','401');expect((await finish(other,'401','301')).ok).toBe(true);
    // Arbitrary app-scoped human IDs do not revoke unrelated BISU identities.
    expect((await action('999')).receipt.status).toBe('needs_review');
    expect((await q('SELECT count(*)::int n FROM whatsapp_connections')).n).toBe(3);
    // Invalid or old events cannot clear an account that reconnected later.
    await action('555','user','deauthorize','2020-01-01T00:00:00Z');
    expect((await q('SELECT whatsapp_connected FROM beauticians WHERE id=$1',[one])).whatsapp_connected).toBe(true);
    const issued=new Date().toISOString(),event='b'.repeat(64);
    const receipt=(await action('555','user','delete',issued,event)).receipt;
    expect(receipt.status).toBe('needs_review');
    expect((await action('555','user','delete',issued,event)).receipt).toEqual(receipt);
    expect((await q('SELECT whatsapp_phone_id FROM beauticians WHERE id=$1',[one])).whatsapp_phone_id).toBeNull();
    expect((await q('SELECT whatsapp_phone_id FROM beauticians WHERE id=$1',[legacy])).whatsapp_phone_id).toBe('100');
    expect((await q('SELECT whatsapp_phone_id FROM beauticians WHERE id=$1',[two])).whatsapp_phone_id).toBe('401');
    expect((await q('SELECT count(*)::int n FROM appointments')).n).toBe(2);
    expect((await q('SELECT count(*)::int n FROM messages')).n).toBe(1);
    // A later deletion still locates locally disconnected data through hashes.
    expect((await action('300','waba','delete')).receipt.status).toBe('needs_review');
    const request=await q('SELECT beautician_ids FROM whatsapp_privacy_requests WHERE confirmation_code=$1',[receipt.confirmation_code]);expect(request.beautician_ids).toEqual([one]);
    // Revoke while setup is processing: credential commit must fail.
    const pending=await begin(one,'777','302','402');
    await action('302','waba');
    expect((await finish(pending,'402','302')).ok).toBe(false);
    expect((await q('SELECT count(*)::int n FROM whatsapp_phone_claims WHERE session_id=$1',[pending])).n).toBe(0);
    // Callback arriving before identity binding still blocks that in-flight setup.
    const secret='c'.repeat(64), next=(await q("SELECT start_whatsapp_signup($1,$2,'web') id",[one,secret])).id;
    await q('SELECT claim_whatsapp_signup($1)',[secret]);await action('888');
    expect((await q('SELECT bind_whatsapp_signup_identity($1,$2,$3) ok',[next,hash('user','888'),hash('waba','303')])).ok).toBe(false);
    // A later, genuinely new connection survives an old callback replay.
    await q("UPDATE whatsapp_connections SET connected_at=now()+interval '1 minute' WHERE beautician_id=$1",[two]);
    await action('301','waba');expect((await q('SELECT whatsapp_phone_id FROM beauticians WHERE id=$1',[two])).whatsapp_phone_id).toBe('401');
    for(const role of ['anon','authenticated']){
      await db.exec('SET ROLE '+role);
      await expect(q('SELECT * FROM whatsapp_privacy_requests')).rejects.toThrow(/permission denied/);
      await expect(q('SELECT * FROM whatsapp_account_links')).rejects.toThrow(/permission denied/);
      await expect(action('555')).rejects.toThrow(/permission denied/);
      await expect(q('SELECT bind_whatsapp_signup_identity($1,$2,$3)',[next,hash('user','555'),hash('waba','300')])).rejects.toThrow(/permission denied/);
      await db.exec('RESET ROLE');
    }
    const id=(await q('SELECT id FROM whatsapp_privacy_requests WHERE confirmation_code=$1',[receipt.confirmation_code])).id;
    await expect(q('SELECT confirm_whatsapp_data_cleanup($1,$2)',[id,''])).rejects.toThrow(/evidence/);
    await q('SELECT confirm_whatsapp_data_cleanup($1,$2)',[id,'TEST-REVIEW-ONLY']);
    expect((await q('SELECT status FROM whatsapp_privacy_requests WHERE id=$1',[id])).status).toBe('completed');
  } finally { await db.close(); }
},30000);
