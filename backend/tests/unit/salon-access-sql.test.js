import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(new URL('../../../supabase/migrations/20261124163844_private_beta_salon_access.sql', import.meta.url), 'utf8');
const prior = readFileSync(new URL('../../../supabase/migrations/20260906_account_protection_and_deletion.sql', import.meta.url), 'utf8');
const owner = '00000000-0000-4000-8000-000000000001';
const student = '00000000-0000-4000-8000-000000000002';
const paid = '00000000-0000-4000-8000-000000000003';
const next = '00000000-0000-4000-8000-000000000004';
let db;

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true),'')::uuid $$;
    GRANT USAGE ON SCHEMA public, auth TO anon, authenticated, service_role;
    CREATE TABLE public.account_deletions (auth_id uuid);
    CREATE TABLE public.beauticians (id uuid PRIMARY KEY, auth_id uuid UNIQUE, business_name text, subscription_status text DEFAULT 'trial', onboarding_completed_at timestamptz);
    INSERT INTO public.beauticians VALUES
      ('${owner}', '${owner}', 'Approved salon', 'trial', now()),
      ('${student}', '${student}', null, 'trial', null),
      ('${paid}', '${paid}', 'Established paid salon', 'active', null);
    ALTER TABLE public.beauticians ENABLE ROW LEVEL SECURITY;
    CREATE POLICY own_profile ON public.beauticians FOR ALL USING (auth_id=auth.uid()) WITH CHECK (auth_id=auth.uid());
    GRANT SELECT ON public.beauticians TO authenticated;
    GRANT UPDATE (business_name, onboarding_completed_at) ON public.beauticians TO authenticated;
    GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
    CREATE FUNCTION public.get_my_beautician_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER AS $$ SELECT id FROM public.beauticians WHERE auth_id=auth.uid() LIMIT 1 $$;
    CREATE TABLE public.courses (id uuid DEFAULT gen_random_uuid(), beautician_id uuid, name text);
    ALTER TABLE public.courses ENABLE ROW LEVEL SECURITY;
    CREATE POLICY own_courses ON public.courses FOR ALL USING (beautician_id=public.get_my_beautician_id()) WITH CHECK (beautician_id=public.get_my_beautician_id());
    GRANT SELECT, INSERT ON public.courses TO authenticated;
  `);
  // Use the actual deployed field-protection trigger, not a simplified stand-in.
  await db.exec(prior.slice(prior.indexOf('CREATE OR REPLACE FUNCTION public.protect_beautician_server_fields()'), prior.indexOf('-- Storage API')));
  await db.exec(migration);
}, 15000);
afterAll(async () => { await db?.close(); });

async function as(role, authId, sql) {
  await db.exec('BEGIN');
  try {
    await db.query("SELECT set_config('request.jwt.claim.sub', $1, true)", [authId]);
    await db.exec(`SET LOCAL ROLE ${role}`);
    return (await db.query(sql)).rows;
  } finally { await db.exec('ROLLBACK'); }
}

describe('salon admission database boundary', () => {
  it('preserves established salons and excludes unfinished trial profiles', async () => {
    expect((await db.query('SELECT id, owner_access_approved FROM beauticians ORDER BY id')).rows).toEqual([
      { id: owner, owner_access_approved: true }, { id: student, owner_access_approved: false }, { id: paid, owner_access_approved: true },
    ]);
  });
  it('does not reapprove a revoked account when the migration is repeated', async () => {
    await db.exec(`UPDATE beauticians SET owner_access_approved=false WHERE id='${paid}'`);
    await db.exec(migration);
    expect((await db.query(`SELECT owner_access_approved FROM beauticians WHERE id='${paid}'`)).rows[0].owner_access_approved).toBe(false);
    await db.exec(`UPDATE beauticians SET owner_access_approved=true WHERE id='${paid}'`);
  });
  it('lets an approved salon read and edit its own profile only', async () => {
    expect((await as('authenticated', owner, 'SELECT id FROM beauticians')).map(x => x.id)).toEqual([owner]);
    expect(await as('authenticated', owner, `UPDATE beauticians SET business_name='Updated' WHERE id='${owner}' RETURNING business_name`)).toEqual([{ business_name: 'Updated' }]);
    expect(await as('authenticated', owner, `UPDATE beauticians SET business_name='Wrong owner' WHERE id='${paid}' RETURNING id`)).toEqual([]);
  });
  it('prevents an unapproved client from reading or completing salon setup', async () => {
    expect(await as('authenticated', student, 'SELECT id FROM beauticians')).toEqual([]);
    expect(await as('authenticated', student, `UPDATE beauticians SET onboarding_completed_at=now(),business_name='Denied' WHERE id='${student}' RETURNING id`)).toEqual([]);
    expect(await as('authenticated', student, 'SELECT public.get_my_beautician_id() AS id')).toEqual([{ id: null }]);
    await expect(as('authenticated', student, `INSERT INTO courses(beautician_id,name) VALUES ('${student}','Denied')`)).rejects.toMatchObject({ code: '42501' });
  });
  it('does not allow browser approval or new salon inserts', async () => {
    await expect(as('authenticated', student, `UPDATE beauticians SET owner_access_approved=true WHERE id='${student}'`)).rejects.toMatchObject({ code: '42501' });
    await expect(as('authenticated', owner, `INSERT INTO beauticians(id,auth_id,owner_access_approved) VALUES ('${next}','${next}',true)`)).rejects.toMatchObject({ code: '42501' });
  });
  it('fails closed for the previous server insert and permits explicit approved server inserts', async () => {
    await expect(as('service_role', next, `INSERT INTO beauticians(id,auth_id) VALUES ('${next}','${next}')`)).rejects.toMatchObject({ code: '42501' });
    expect(await as('service_role', next, `INSERT INTO beauticians(id,auth_id,owner_access_approved) VALUES ('${next}','${next}',true) RETURNING id`)).toEqual([{ id: next }]);
  });
  it('keeps approval protected even if a future migration grants whole-row update', async () => {
    await db.exec('GRANT UPDATE ON public.beauticians TO authenticated');
    await expect(as('authenticated', owner, `UPDATE beauticians SET owner_access_approved=false WHERE id='${owner}'`)).rejects.toMatchObject({ code: '42501' });
    await db.exec('REVOKE UPDATE ON public.beauticians FROM authenticated');
  });
});
