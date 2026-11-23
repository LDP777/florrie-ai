import { describe,it,expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { materialHash } from '../../src/services/content-v2/state.js';

const migration=readFileSync(new URL('../../../supabase/migrations/20261123090000_content_v2.sql',import.meta.url),'utf8');
const accountProtection=readFileSync(new URL('../../../supabase/migrations/20260906_account_protection_and_deletion.sql',import.meta.url),'utf8');
describe('Content v2 additive database migration',()=>{
  it('preserves saved work, hashes approvals identically to Node and protects service tables',async()=>{
    const db=new PGlite();
    try {
      await db.exec(`
        CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
        CREATE TABLE beauticians(id uuid PRIMARY KEY,booking_slug text);
        CREATE TABLE treatments(id uuid PRIMARY KEY); CREATE TABLE clients(id uuid PRIMARY KEY);
        CREATE TABLE photo_consents(id uuid PRIMARY KEY,beautician_id uuid,client_id uuid,status text,permitted_uses text[],revoked_at timestamptz,expires_at timestamptz);
        CREATE TABLE content_posts(id uuid PRIMARY KEY,beautician_id uuid,caption text,hashtags text[],image_url text,platform text CHECK(platform IN ('instagram','facebook','tiktok')),
          post_type text,status text,media_kind text,approved_at timestamptz,scheduled_for timestamptz);
        CREATE TABLE promo_codes(id uuid PRIMARY KEY);
        CREATE TABLE content_campaigns(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),beautician_id uuid,post_id uuid UNIQUE,token text DEFAULT replace(gen_random_uuid()::text,'-',''));
        CREATE TABLE reviews(id uuid PRIMARY KEY,beautician_id uuid,comment text);
        CREATE TABLE review_post_permissions(post_id uuid,beautician_id uuid,review_id uuid);
        INSERT INTO beauticians VALUES('11111111-1111-4111-8111-111111111111','willow-beauty');
        INSERT INTO content_posts(id,beautician_id,caption,hashtags,platform,post_type,status,media_kind) VALUES
          ('22222222-2222-4222-8222-222222222222','11111111-1111-4111-8111-111111111111','A saved £45 caption',ARRAY['#brows'],'instagram','general','scheduled','feed'),
          ('33333333-3333-4333-8333-333333333333','11111111-1111-4111-8111-111111111111','A saved draft','{}','instagram','general','draft','feed'),
          ('44444444-4444-4444-8444-444444444444','11111111-1111-4111-8111-111111111111','A saved photo','{}','instagram','gallery','draft','feed');
      `);
      await db.exec(migration);
      await db.exec(migration);
      const {rows}=await db.query('SELECT *,public.content_v2_material_hash(content_posts) AS computed FROM content_posts ORDER BY id');
      expect(rows).toHaveLength(3);expect(rows[0].caption).toBe('A saved £45 caption');expect(rows[0].status).toBe('scheduled');
      expect(rows[0].approved_hash).toBe(rows[0].material_hash);expect(rows[0].material_hash).toBe(materialHash(rows[0]));
      expect(rows[0].computed).toBe(materialHash(rows[0]));expect(rows[0].link_url).toContain('/book/willow-beauty?fl_content=');
      expect(rows[1].status).toBe('draft');expect(rows[2].permission_status).toBe('pending');
      expect((await db.query('SELECT count(*)::int AS count FROM content_campaigns')).rows[0].count).toBe(2);
      expect((await db.query('SELECT content_v2 FROM beauticians')).rows[0].content_v2).toBe(false);
      const triggerFunction=accountProtection.match(/CREATE OR REPLACE FUNCTION public\.protect_beautician_server_fields\(\) RETURNS trigger[\s\S]*?\$\$;/)[0];
      await db.exec(`${triggerFunction}
        CREATE TRIGGER protect_beautician_server_fields BEFORE INSERT OR UPDATE ON beauticians
        FOR EACH ROW EXECUTE FUNCTION public.protect_beautician_server_fields();
        GRANT SELECT ON beauticians TO authenticated;
        GRANT UPDATE(content_v2) ON beauticians TO authenticated;
        SET ROLE authenticated;`);
      await expect(db.query('UPDATE beauticians SET content_v2=true')).rejects.toMatchObject({code:'42501'});
      await db.exec('RESET ROLE;');
      await db.query("INSERT INTO content_voice_rules(beautician_id,kind,value,source_post_id) VALUES($1,'max_hashtags','1',$2)",[rows[0].beautician_id,rows[0].id]);
      await expect(db.query("INSERT INTO content_voice_rules(beautician_id,kind,value,source_post_id) VALUES($1,'max_hashtags','1',$2)",[rows[0].beautician_id,rows[1].id])).rejects.toMatchObject({code:'23505'});
      await db.query('UPDATE content_voice_rules SET forgotten_at=now()');
      await db.query("INSERT INTO content_voice_rules(beautician_id,kind,value,source_post_id) VALUES($1,'max_hashtags','1',$2)",[rows[0].beautician_id,rows[1].id]);
      const permissions=await db.query(`SELECT has_table_privilege('authenticated','content_preparations','SELECT') AS client_read,
        has_table_privilege('anon','content_voice_rules','INSERT') AS anon_write,
        has_table_privilege('service_role','content_preparations','INSERT') AS worker_write`);
      expect(permissions.rows[0]).toEqual({client_read:false,anon_write:false,worker_write:true});
      const rls=await db.query("SELECT relrowsecurity FROM pg_class WHERE relname IN ('content_preparations','content_voice_rules')");
      expect(rls.rows.every(r=>r.relrowsecurity)).toBe(true);
      await db.query('UPDATE content_posts SET media=$1 WHERE id=$2',[{type:'layout',layout:{kind:'offer',title:'Café “£45”',lines:['One','Two'],width:1080}},rows[0].id]);
      const changed=(await db.query('SELECT *,public.content_v2_material_hash(content_posts) AS computed FROM content_posts WHERE id=$1',[rows[0].id])).rows[0];
      expect(changed.computed).toBe(materialHash(changed));
    } finally {await db.close();}
  },30000);
});
