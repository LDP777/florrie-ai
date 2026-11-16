import { beforeAll, afterAll, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
let db;
beforeAll(async()=>{
 db=new PGlite();
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
 CREATE TABLE public.waitlist_signups(id uuid primary key default gen_random_uuid(),email text not null unique,name text,source text default 'landing_page',signed_up_at timestamptz default now(),notified boolean default false);
 GRANT ALL ON public.waitlist_signups TO anon,authenticated,service_role;
 ALTER TABLE public.waitlist_signups ENABLE ROW LEVEL SECURITY;
 CREATE POLICY anon_can_insert ON public.waitlist_signups FOR INSERT WITH CHECK (true);`);
 await db.exec(readFileSync(new URL('../../../supabase/migrations/20261116155849_waitlist_launch_capture.sql',import.meta.url),'utf8'));
});
afterAll(async()=>{await db.close();});
it('protects the list and blocks direct public writes and truncation',async()=>{
 const {rows}=await db.query(`SELECT has_table_privilege('anon','public.waitlist_signups','SELECT') AS read,has_table_privilege('anon','public.waitlist_signups','INSERT') AS insert,has_table_privilege('authenticated','public.waitlist_signups','TRUNCATE') AS truncate,has_table_privilege('anon','public.florrie_launch_mailing_list','SELECT') AS export`);
 expect(rows[0]).toEqual({read:false,insert:false,truncate:false,export:false});
});
it('exports only consented, subscribed, non-test people with their individual unsubscribe link',async()=>{
 await db.exec(`INSERT INTO public.waitlist_signups(email,marketing_consent_at,is_test,unsubscribed_at) VALUES ('active@example.com',now(),false,null),('no-consent@example.com',null,false,null),('test@example.com',now(),true,null),('stopped@example.com',now(),false,now());`);
 const {rows}=await db.query('SELECT email,unsubscribe_url FROM public.florrie_launch_mailing_list');
 expect(rows).toHaveLength(1);expect(rows[0].email).toBe('active@example.com');expect(rows[0].unsubscribe_url).toMatch(/^https:\/\/api.florrie.ai\/api\/waitlist\/unsubscribe\?token=[a-f0-9-]{36}$/);
});
