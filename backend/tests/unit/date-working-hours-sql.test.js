import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
let db;
const owner = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO authenticated; GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
    CREATE TABLE public.beauticians(id uuid PRIMARY KEY, auth_id uuid);
    GRANT SELECT ON public.beauticians TO authenticated;
    INSERT INTO public.beauticians VALUES ('${owner}','${owner}'),('${other}','${other}');`);
  await db.exec(readFileSync(new URL('../../../supabase/migrations/20261122001046_date_working_hours.sql', import.meta.url), 'utf8'));
  await db.exec(`INSERT INTO public.date_working_hours(beautician_id,date,start_time,end_time) VALUES ('${owner}','2026-11-23','09:00','20:00'),('${other}','2026-11-23','10:00','19:00');`);
}, 15000);
afterAll(async () => { await db?.close(); });
describe('dated hours storage', () => {
  it('enforces one valid opening window per salon/date', async () => {
    await expect(db.exec(`INSERT INTO public.date_working_hours(beautician_id,date,start_time,end_time) VALUES ('${owner}','2026-11-23','09:00','20:00')`)).rejects.toThrow(/duplicate/);
    for (const [start, end] of [['20:00','09:00'],['09:00','09:00'],['09:00','24:00'],['09:00:01','20:00']]) {
      await expect(db.exec(`INSERT INTO public.date_working_hours(beautician_id,date,start_time,end_time) VALUES ('${owner}','2026-11-24','${start}','${end}')`)).rejects.toThrow(/check constraint/);
    }
  });
  it('allows each owner to read only their rows and refuses direct browser writes', async () => {
    await db.exec(`SET ROLE authenticated; SELECT set_config('request.jwt.claim.sub','${owner}',false);`);
    const rows = await db.query('SELECT beautician_id, end_time FROM public.date_working_hours');
    expect(rows.rows).toEqual([{ beautician_id: owner, end_time: '20:00:00' }]);
    await expect(db.exec(`UPDATE public.date_working_hours SET end_time='22:00'`)).rejects.toThrow(/permission denied/);
    await db.exec('RESET ROLE; SET ROLE anon;');
    await expect(db.query('SELECT * FROM public.date_working_hours')).rejects.toThrow(/permission denied/);
    await db.exec('RESET ROLE;');
  });
});
