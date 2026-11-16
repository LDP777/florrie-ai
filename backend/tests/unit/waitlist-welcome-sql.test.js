import { beforeAll, afterAll, beforeEach, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
let db;
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE public.waitlist_signups(id uuid primary key default gen_random_uuid(),email text unique,name text,source text,signed_up_at timestamptz default now());`);
  for (const file of ['20261116155849_waitlist_launch_capture.sql','20261116162734_waitlist_welcome_delivery.sql'])
    await db.exec(readFileSync(new URL('../../../supabase/migrations/'+file,import.meta.url),'utf8'));
});
afterAll(async () => db.close());
beforeEach(async () => db.exec('TRUNCATE public.waitlist_signups'));
const insert = () => db.exec("INSERT INTO public.waitlist_signups(email,marketing_consent_at) VALUES ('test@example.com',now())");
const claim = () => db.query('SELECT * FROM public.claim_waitlist_welcomes(5)');
it('claims only consented non-test subscribers once across sequential workers',async()=>{
  await insert();
  await db.exec("INSERT INTO public.waitlist_signups(email,marketing_consent_at,is_test,unsubscribed_at) VALUES ('no@example.com',null,false,null),('test2@example.com',now(),true,null),('unsub@example.com',now(),false,now())");
  const first=await claim();expect(first.rows).toHaveLength(1);expect(first.rows[0].welcome_attempts).toBe(1);
  expect(first.rows[0].welcome_claim).toBeTruthy();expect((await claim()).rows).toHaveLength(0);
});
it('reclaims a crashed send with a new lease but the same recipient id',async()=>{
  await insert();const first=(await claim()).rows[0];
  await db.exec("UPDATE public.waitlist_signups SET welcome_last_attempt_at=now()-interval '6 minutes'");
  const second=(await claim()).rows[0];expect(second.id).toBe(first.id);expect(second.welcome_claim).not.toBe(first.welcome_claim);expect(second.welcome_attempts).toBe(2);
});
it('does not retry after the provider deduplication window',async()=>{
  await insert();await claim();
  await db.exec("UPDATE public.waitlist_signups SET welcome_first_attempt_at=now()-interval '24 hours',welcome_last_attempt_at=now()-interval '6 minutes'");
  expect((await claim()).rows).toHaveLength(0);
  expect((await db.query('select welcome_status from public.waitlist_signups')).rows[0].welcome_status).toBe('needs_review');
});
it('backs off retries and caps attempts without re-sending successful receipts',async()=>{
  await insert();await db.exec("UPDATE public.waitlist_signups SET welcome_next_attempt_at=now()+interval '5 minutes'");
  expect((await claim()).rows).toHaveLength(0);
  await db.exec("UPDATE public.waitlist_signups SET welcome_status='sent'");expect((await claim()).rows).toHaveLength(0);
  await db.exec("UPDATE public.waitlist_signups SET welcome_status='pending',welcome_attempts=6,welcome_last_attempt_at=now()-interval '6 minutes'");
  expect((await claim()).rows).toHaveLength(0);expect((await db.query('select welcome_status from public.waitlist_signups')).rows[0].welcome_status).toBe('needs_review');
});
it('suppresses an unsubscribe after a claim',async()=>{
  await insert();await claim();await db.exec('UPDATE public.waitlist_signups SET unsubscribed_at=now()');
  expect((await claim()).rows).toHaveLength(0);expect((await db.query('select welcome_status from public.waitlist_signups')).rows[0].welcome_status).toBe('suppressed');
});
it('does not expose subscriber addresses through the queue function',async()=>{
  const {rows}=await db.query("SELECT has_function_privilege('anon','public.claim_waitlist_welcomes(integer)','EXECUTE') AS anon,has_function_privilege('authenticated','public.claim_waitlist_welcomes(integer)','EXECUTE') AS salon,has_function_privilege('service_role','public.claim_waitlist_welcomes(integer)','EXECUTE') AS worker");
  expect(rows[0]).toEqual({anon:false,salon:false,worker:true});
});
