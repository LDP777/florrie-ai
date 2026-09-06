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
 INSERT INTO public.stripe_events VALUES('evt_test','${owner}','{"email":"private@example.test"}',NULL);
 INSERT INTO storage.objects VALUES('legacy','flat-file','${owner}'),('private','${owner}/photo.jpg',NULL),('private','${other}/photo.jpg','${other}');`);
const job=(await db.query('SELECT id FROM public.account_deletions')).rows[0];
await db.exec(`SET ROLE service_role; SELECT public.erase_deletion_business('${job.id}'); RESET ROLE;`);
assert.equal((await db.query(`SELECT * FROM public.beauticians WHERE id='${owner}'`)).rows.length,0);
assert.deepEqual((await db.query(`SELECT data FROM public.stripe_events WHERE id='evt_test'`)).rows[0].data,{account_deleted:true});
assert.equal((await db.query(`SELECT * FROM public.account_deletion_storage_objects('${owner}','${owner}')`)).rows.length,2);
await assert.rejects(db.exec(`INSERT INTO public.beauticians(auth_id) VALUES('${owner}')`),e=>e.code==='23514');
console.log('PASS: ordinary profile edits, cross-owner denial, INSERT/UPDATE defence, inherited grants, storage isolation, durable deletion and recreation prevention in embedded PostgreSQL');
await db.close();
