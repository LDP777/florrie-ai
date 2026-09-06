// Disposable embedded PostgreSQL only. Never reads a DATABASE_URL or production secrets.
// PGLITE_MODULE=/tmp/florrie-dbchecks/node_modules/@electric-sql/pglite/dist/index.js node backend/tests/integration/account-protection.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
const owner='11111111-1111-4111-8111-111111111111';
const other='22222222-2222-4222-8222-222222222222';
await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
CREATE SCHEMA auth; CREATE SCHEMA storage;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
GRANT USAGE ON SCHEMA auth TO authenticated;
CREATE TABLE public.beauticians(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),auth_id uuid UNIQUE NOT NULL,first_name text,last_name text,
 subscription_plan text DEFAULT 'trial',subscription_status text DEFAULT 'trial',trial_ends_at timestamptz,stripe_customer_id text,
 instagram_page_token text,created_at timestamptz DEFAULT now(),updated_at timestamptz DEFAULT now());
ALTER TABLE public.beauticians ENABLE ROW LEVEL SECURITY;
CREATE POLICY beautician_own_data ON public.beauticians FOR ALL TO authenticated USING(auth_id=auth.uid()) WITH CHECK(auth_id=auth.uid());
GRANT ALL ON public.beauticians TO authenticated,service_role;
GRANT TRUNCATE,TRIGGER ON public.beauticians TO anon;
GRANT INSERT(stripe_customer_id),UPDATE(stripe_customer_id),REFERENCES(stripe_customer_id) ON public.beauticians TO authenticated;
CREATE TABLE public.stripe_events(id text PRIMARY KEY,beautician_id uuid REFERENCES public.beauticians(id),data jsonb,processed_at timestamptz);
CREATE TABLE storage.objects(bucket_id text,name text,owner_id text);
INSERT INTO public.beauticians(id,auth_id,first_name) VALUES('${owner}','${owner}','Owner'),('${other}','${other}','Other');
`);
await db.exec(`CREATE TABLE public.appointments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),beautician_id uuid REFERENCES public.beauticians(id) ON DELETE CASCADE,client_id uuid,starts_at timestamptz,status text,price_cents integer,deposit_paid boolean,stripe_payment_intent_id text);`);
// Install the actual production archive table and BEFORE DELETE trigger.
const archiveMigration = await readFile(new URL('../../../supabase/migrations/20260805_protect_paid_bookings.sql',import.meta.url),'utf8');
await db.exec(archiveMigration.slice(archiveMigration.indexOf('CREATE TABLE IF NOT EXISTS deleted_appointments')));
await db.exec(`INSERT INTO public.appointments(beautician_id,status) VALUES('${owner}','confirmed'),('${other}','confirmed');
 INSERT INTO public.deleted_appointments(id,beautician_id,row_snapshot) VALUES(gen_random_uuid(),'${owner}','{"notes":"old private snapshot"}'),(gen_random_uuid(),'${other}','{"notes":"other salon archive"}');`);
await db.exec(await readFile(new URL('../../../supabase/migrations/20260906_account_protection_and_deletion.sql',import.meta.url),'utf8'));
async function asUser(sql) {
  await db.exec(`BEGIN; SET LOCAL ROLE authenticated; SET LOCAL request.jwt.claim.sub='${owner}';`);
  try { return await db.query(sql); } finally { await db.exec('ROLLBACK'); }
}
await asUser(`UPDATE public.beauticians SET first_name='New name' WHERE id='${owner}' RETURNING first_name`);
assert.equal((await asUser(`UPDATE public.beauticians SET first_name='Intruder' WHERE id='${other}' RETURNING id`)).rows.length,0);
for(const sql of [
 `UPDATE public.beauticians SET subscription_plan='florrie_team' WHERE id='${owner}'`,
 `UPDATE public.beauticians SET subscription_status='active',trial_ends_at='2099-01-01' WHERE id='${owner}'`,
 `UPDATE public.beauticians SET instagram_page_token='stolen',stripe_customer_id='cus_foreign' WHERE id='${owner}'`,
 `INSERT INTO public.beauticians(auth_id,subscription_plan) VALUES('${owner}','florrie_team')`,
 `DELETE FROM public.beauticians WHERE id='${owner}'`,
 'TRUNCATE public.beauticians CASCADE',
]) await assert.rejects(asUser(sql),e=>e.code==='42501');
for(const role of ['anon','authenticated']) {
 const row=(await db.query(`SELECT has_table_privilege('${role}','public.beauticians','TRUNCATE') AS trunc, has_table_privilege('${role}','public.beauticians','TRIGGER') AS trig, has_column_privilege('${role}','public.beauticians','stripe_customer_id','REFERENCES') AS refs`)).rows[0];
 assert.deepEqual(row,{trunc:false,trig:false,refs:false});
}
await assert.rejects(asUser('SELECT * FROM public.account_deletions'),e=>e.code==='42501');
await assert.rejects(asUser(`SELECT * FROM public.account_deletion_storage_objects('${owner}','${owner}')`),e=>e.code==='42501');
// A future broad grant cannot reopen protected fields through a forgotten column.
await db.exec('ALTER TABLE public.beauticians ADD COLUMN future_billing_credit integer DEFAULT 0; GRANT INSERT,UPDATE ON public.beauticians TO authenticated;');
await assert.rejects(asUser(`UPDATE public.beauticians SET future_billing_credit=999 WHERE id='${owner}'`),e=>e.code==='42501');
await assert.rejects(asUser(`INSERT INTO public.beauticians(auth_id) VALUES('${owner}')`),e=>e.code==='42501');
await asUser(`UPDATE public.beauticians SET first_name='Still editable' WHERE id='${owner}'`);
await db.exec(`SET ROLE service_role; UPDATE public.beauticians SET subscription_plan='florrie_team',trial_ends_at='2099-01-01' WHERE id='${owner}'; RESET ROLE;`);
await db.exec(`INSERT INTO public.account_deletions(auth_id,beautician_id,snapshot_encrypted,status_token_hash) VALUES('${owner}','${owner}','encrypted','hash');
 INSERT INTO public.stripe_events VALUES('evt_test','${owner}','{"email":"private@example.test"}',NULL),
 ('evt_foreign','${other}','{"description":"mentions ${owner}"}',NULL),
 ('evt_nested',NULL,'{"data":{"object":{"metadata":{"beautician_id":"${owner}"}}}}',NULL),
 ('evt_legacy',NULL,'{"metadata":{"beautician_id":"${owner}"}}',NULL);
 INSERT INTO storage.objects VALUES('legacy','flat-file','${owner}'),('private','${owner}/photo.jpg',NULL),('private','${other}/photo.jpg','${other}');`);
const job=(await db.query('SELECT id FROM public.account_deletions')).rows[0];
await db.exec(`SET ROLE service_role; SELECT public.erase_deletion_business('${job.id}'); RESET ROLE;`);
assert.equal((await db.query(`SELECT * FROM public.beauticians WHERE id='${owner}'`)).rows.length,0);
assert.equal((await db.query(`SELECT * FROM public.deleted_appointments WHERE beautician_id='${owner}'`)).rows.length,0,'both old and cascade-created snapshots are erased');
assert.equal((await db.query(`SELECT * FROM public.deleted_appointments WHERE beautician_id='${other}'`)).rows.length,1,'other salon archives survive');
assert.equal((await db.query(`SELECT * FROM public.appointments WHERE beautician_id='${other}'`)).rows.length,1,'other salon appointments survive');
assert.deepEqual((await db.query(`SELECT data FROM public.stripe_events WHERE id='evt_test'`)).rows[0].data,{account_deleted:true});
for (const id of ['evt_nested','evt_legacy']) assert.deepEqual((await db.query('SELECT data FROM public.stripe_events WHERE id=$1',[id])).rows[0].data,{account_deleted:true});
assert.equal((await db.query("SELECT processed_at FROM public.stripe_events WHERE id='evt_foreign'")).rows[0].processed_at,null);
assert.deepEqual((await db.query("SELECT data FROM public.stripe_events WHERE id='evt_foreign'")).rows[0].data,{description:`mentions ${owner}`});
assert.equal((await db.query(`SELECT * FROM public.account_deletion_storage_objects('${owner}','${owner}')`)).rows.length,2);
await assert.rejects(db.exec(`INSERT INTO public.beauticians(auth_id) VALUES('${owner}')`),e=>e.code==='23514');
console.log('PASS: ordinary profile edits, cross-owner denial, INSERT/UPDATE defence, inherited grants, storage isolation, durable deletion and recreation prevention in embedded PostgreSQL');
await db.exec(await readFile(new URL('../../../supabase/migrations/20260906_deleted_account_events.sql',import.meta.url),'utf8'));
await db.query("UPDATE account_deletions SET billing_reference_hashes=ARRAY[encode(sha256(convert_to('cus_erased','UTF8')),'hex'),encode(sha256(convert_to('sub_erased','UTF8')),'hex')]");
for (const payload of [
 {data:{object:{customer:'cus_erased',email:'private@example.test'}}},
 {data:{object:{customer:{id:'cus_erased'}}}},
 {data:{object:{metadata:{beautician_id:owner}}}},
 {id:'cus_erased'},
 {data:{object:{parent:{subscription_details:{subscription:'sub_erased'}}}}},
 {data:{object:{parent:{subscription_details:{metadata:{beautician_id:owner}}}}}},
]) assert.equal((await db.query('SELECT is_deleted_account_event($1) AS blocked',[payload])).rows[0].blocked,true);
assert.equal((await db.query('SELECT is_deleted_account_event($1) AS blocked',[{data:{object:{customer:'cus_other',description:`mentions ${owner}`}}}])).rows[0].blocked,false);
await assert.rejects(asUser("SELECT is_deleted_account_event('{}')"),e=>e.code==='42501');
await db.query("INSERT INTO stripe_events(id,data) VALUES ('evt_late',$1)",[{data:{object:{customer:'cus_erased',email:'private@example.test'}}}]);
assert.deepEqual((await db.query("SELECT data FROM stripe_events WHERE id='evt_late'")).rows[0].data,{account_deleted:true});
await db.query("UPDATE stripe_events SET data=$1 WHERE id='evt_late'",[{email:'restored@example.test'}]);
assert.deepEqual((await db.query("SELECT data FROM stripe_events WHERE id='evt_late'")).rows[0].data,{account_deleted:true});
// Exercise the final replacement erase function, including a restored ID that
// already has an archive row. Both cleanup passes must be one transaction.
await db.exec(`INSERT INTO public.account_deletions(auth_id,beautician_id,snapshot_encrypted,status_token_hash) VALUES('${other}','${other}','encrypted','other-hash');
 INSERT INTO public.deleted_appointments(id,beautician_id,row_snapshot) SELECT id,beautician_id,to_jsonb(appointments) FROM public.appointments WHERE beautician_id='${other}';`);
const otherJob=(await db.query(`SELECT id FROM public.account_deletions WHERE beautician_id='${other}'`)).rows[0];
await db.exec(`CREATE FUNCTION fail_deletion_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'pending recovery'; END $$;
 CREATE TRIGGER fail_deletion_fixture BEFORE DELETE ON public.appointments FOR EACH ROW EXECUTE FUNCTION fail_deletion_fixture();`);
await assert.rejects(db.query('SELECT erase_deletion_business($1)',[otherJob.id]),/pending recovery/);
assert.equal((await db.query(`SELECT * FROM public.deleted_appointments WHERE beautician_id='${other}'`)).rows.length,2,'a failed cascade restores archives removed earlier in the transaction');
await db.exec('DROP TRIGGER fail_deletion_fixture ON public.appointments');
await db.query('SELECT erase_deletion_business($1)',[otherJob.id]);
assert.equal((await db.query(`SELECT * FROM public.deleted_appointments WHERE beautician_id='${other}'`)).rows.length,0,'final migration removes historic, restored-ID and newly created archive rows');
assert.equal((await db.query(`SELECT * FROM public.beauticians WHERE id='${other}'`)).rows.length,0);
console.log('PASS: late webhook customer hashes, exact metadata ownership, private RPC and race-safe persistent event redaction');
await db.close();
