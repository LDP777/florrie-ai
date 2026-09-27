import {beforeAll,afterAll,beforeEach,afterEach,describe,it,expect} from 'vitest';
import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
const sql=readFileSync(new URL('../../../supabase/migrations/20260927_reviews_content_connections.sql',import.meta.url),'utf8');
const owner='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
let db,post,review,appointment,campaign;
beforeAll(async()=>{
 db=new PGlite();
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
 CREATE TABLE beauticians(id uuid PRIMARY KEY DEFAULT gen_random_uuid());
 CREATE TABLE content_posts(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),beautician_id uuid REFERENCES beauticians(id),caption text,platform text,post_type text,status text);
 CREATE TABLE appointments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),beautician_id uuid REFERENCES beauticians(id),status text,price_cents integer,created_at timestamptz DEFAULT now());
 CREATE TABLE reviews(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),beautician_id uuid REFERENCES beauticians(id),comment text,is_public boolean,platform text);`);
 await db.exec(sql);await db.exec(sql);
},20000);
afterAll(()=>db.close());
beforeEach(async()=>{
 await db.exec('BEGIN');await db.query('INSERT INTO beauticians(id) VALUES($1),($2)',[owner,other]);
 post=(await db.query("INSERT INTO content_posts(beautician_id,caption,platform,post_type,status) VALUES($1,'Fictional post','instagram','general','draft') RETURNING id",[owner])).rows[0].id;
 review=(await db.query("INSERT INTO reviews(beautician_id,comment,is_public,platform) VALUES($1,'A fictional kind review',true,'florrie') RETURNING id",[owner])).rows[0].id;
 appointment=(await db.query("INSERT INTO appointments(beautician_id,status,price_cents) VALUES($1,'pending',3000) RETURNING id",[owner])).rows[0].id;
 campaign=(await db.query('INSERT INTO content_campaigns(beautician_id,post_id) VALUES($1,$2) RETURNING *',[owner,post])).rows[0];
});
afterEach(()=>db.exec('ROLLBACK'));
const record=(o=owner,t=campaign.token)=>db.query('SELECT record_content_booking($1,$2,$3) ok',[o,appointment,t]);
const results=(o=owner)=>db.query('SELECT * FROM content_booking_results($1)',[o]);
describe('Actual PostgreSQL content storage',()=>{
 it('has no public or direct authenticated table/RPC access',async()=>{
  const r=await db.query("SELECT relname,relrowsecurity,has_table_privilege('anon',oid,'SELECT') anon,has_table_privilege('authenticated',oid,'SELECT,INSERT,UPDATE,DELETE') authenticated FROM pg_class WHERE relname IN ('google_review_connections','content_campaigns','content_booking_sources','review_post_permissions')");expect(r.rows).toHaveLength(4);expect(r.rows.every(v=>v.relrowsecurity&&!v.anon&&!v.authenticated)).toBe(true);
  const f=await db.query("SELECT has_function_privilege('anon','record_content_booking(uuid,uuid,text)','EXECUTE') anon,has_function_privilege('authenticated','create_review_post(uuid,uuid,text)','EXECUTE') authenticated");expect(f.rows[0]).toEqual({anon:false,authenticated:false});
 });
 it('rejects another salon and unknown tokens without recording a booking',async()=>{expect((await record(other)).rows[0].ok).toBe(false);expect((await record(owner,'wrong')).rows[0].ok).toBe(false);expect((await results(other)).rows).toEqual([]);expect(Number((await results()).rows[0].pending)).toBe(0);});
 it('counts a booking once, then derives current paid/held/cancelled status',async()=>{expect((await record()).rows[0].ok).toBe(true);expect((await record()).rows[0].ok).toBe(false);let r=(await results()).rows[0];expect([Number(r.pending),Number(r.confirmed),Number(r.booking_value_cents)]).toEqual([1,0,0]);await db.query("UPDATE appointments SET status='confirmed' WHERE id=$1",[appointment]);r=(await results()).rows[0];expect([Number(r.pending),Number(r.confirmed),Number(r.booking_value_cents)]).toEqual([0,1,3000]);await db.query("UPDATE appointments SET status='cancelled_by_client' WHERE id=$1",[appointment]);r=(await results()).rows[0];expect([Number(r.cancelled),Number(r.confirmed),Number(r.booking_value_cents)]).toEqual([1,0,0]);});
 it('keeps historical results after a post is deleted, but stops new attribution',async()=>{await record();await db.query('DELETE FROM content_posts WHERE id=$1',[post]);expect((await record()).rows[0].ok).toBe(false);expect(Number((await results()).rows[0].pending)).toBe(1);});
 it('does not count appointments older than 90 days',async()=>{await record();await db.query("UPDATE appointments SET created_at=now()-interval '91 days' WHERE id=$1",[appointment]);expect(Number((await results()).rows[0].pending)).toBe(0);});
 it('creates exactly one unpublished draft and permission record on retry',async()=>{const create=()=>db.query('SELECT * FROM create_review_post($1,$2,$3)',[owner,review,'A fictional kind review']);const a=(await create()).rows[0],b=(await create()).rows[0];expect(a.id).toBe(b.id);expect(a.status).toBe('draft');expect(a.caption).toBe('“A fictional kind review”\n\nThank you for sharing your experience.');expect((await db.query('SELECT * FROM review_post_permissions')).rows).toHaveLength(1);});
 it.each(['private','google','changed','other'])('rejects %s feedback before saving a testimonial',async kind=>{if(kind==='private')await db.query('UPDATE reviews SET is_public=false WHERE id=$1',[review]);if(kind==='google')await db.query("UPDATE reviews SET platform='google' WHERE id=$1",[review]);await expect(db.query('SELECT * FROM create_review_post($1,$2,$3)',[kind==='other'?other:owner,review,kind==='changed'?'Altered review':'A fictional kind review'])).rejects.toThrow();});
 it('retains the permission record when its source is removed, so publishing can refuse it',async()=>{const p=(await db.query('SELECT * FROM create_review_post($1,$2,$3)',[owner,review,'A fictional kind review'])).rows[0];await db.query('DELETE FROM reviews WHERE id=$1',[review]);expect((await db.query('SELECT review_id FROM review_post_permissions WHERE post_id=$1',[p.id])).rows[0].review_id).toBeNull();});
});
