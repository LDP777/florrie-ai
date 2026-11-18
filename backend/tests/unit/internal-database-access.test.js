import { it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const owner = '00000000-0000-0000-0000-000000000001';
const other = '00000000-0000-0000-0000-000000000002';
const policies = [
  ['aftercare_sends', 'Service role inserts aftercare sends'],
  ['appointment_add_ons', 'Service role inserts appointment add-ons'],
  ['automation_rule_logs', 'Service role inserts rule logs'],
  ['booking_suggestions', 'Service role inserts booking suggestions'],
  ['client_nudges', 'service_insert_nudges'],
  ['follow_up_enrollments', 'Service role manages enrollments'],
  ['review_requests_sent', 'Service role inserts review requests'],
];

it('blocks public internal writes and cross-salon reads while preserving owner reads and workers', async () => {
  const db = new PGlite();
  try {
    await db.exec(`
      CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE SCHEMA auth;
      CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$
        SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
      $$;
      GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
      CREATE TABLE beauticians(id uuid PRIMARY KEY, auth_id uuid);
      INSERT INTO beauticians VALUES ('${owner}','${owner}'),('${other}','${other}');
      CREATE FUNCTION get_my_beautician_id() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER AS $$
        SELECT id FROM public.beauticians WHERE auth_id=auth.uid() LIMIT 1;
      $$;
      CREATE FUNCTION update_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at=now(); RETURN NEW; END $$;
      CREATE FUNCTION bump_client_last_visit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
      CREATE FUNCTION record_deleted_appointment() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN OLD; END $$;
      CREATE FUNCTION increment_message_usage(uuid,date,integer,text,integer) RETURNS integer LANGUAGE sql AS $$ SELECT 1; $$;
      CREATE FUNCTION increment_sms_usage(uuid,date,integer,integer) RETURNS integer LANGUAGE sql AS $$ SELECT 1; $$;
      CREATE TABLE trigger_audit(id integer);
      CREATE FUNCTION redact_deleted_account_event() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN INSERT INTO public.trigger_audit VALUES (NEW.id); RETURN NEW; END $$;
      CREATE FUNCTION remember_instagram_account_links() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RETURN NEW; END $$;
      CREATE FUNCTION reserve_stripe_receipt_key() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER AS $$ BEGIN RETURN NEW; END $$;
      CREATE TABLE trigger_source(id integer, updated_at timestamptz);
      GRANT INSERT,SELECT ON trigger_source TO authenticated;
      CREATE TRIGGER audit_insert BEFORE INSERT ON trigger_source FOR EACH ROW EXECUTE FUNCTION redact_deleted_account_event();
      CREATE TRIGGER timestamp_insert BEFORE INSERT ON trigger_source FOR EACH ROW EXECUTE FUNCTION update_updated_at();
    `);
    for (const [table, policy] of policies) {
      await db.exec(`CREATE TABLE ${table}(id integer PRIMARY KEY, beautician_id uuid);
        ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY;
        GRANT SELECT,INSERT,UPDATE,DELETE ON ${table} TO anon,authenticated,service_role;
        CREATE POLICY owner_read ON ${table} FOR SELECT TO authenticated USING(beautician_id=get_my_beautician_id());
        CREATE POLICY "${policy}" ON ${table} FOR ${table === 'follow_up_enrollments' ? 'ALL' : 'INSERT'} WITH CHECK(true);
        INSERT INTO ${table} VALUES (1,'${owner}'),(2,'${other}');`);
    }
    // Reproduce the unsafe INSERT using fictional rows before the fix.
    // WITH CHECK(true) alone is not evidence of anonymous SELECT access.
    await db.exec('SET ROLE anon');
    await db.query(`INSERT INTO follow_up_enrollments VALUES(99,'${other}')`);
    await db.exec('RESET ROLE');
    expect((await db.query('SELECT id FROM follow_up_enrollments WHERE id=99')).rows).toEqual([{ id: 99 }]);
    await db.exec('DELETE FROM follow_up_enrollments WHERE id=99');
    const sql = await readFile(new URL('../../../supabase/migrations/20261118000042_restrict_internal_database_access.sql', import.meta.url), 'utf8');
    await db.exec(sql);
    await db.exec(sql); // Repeatable if a deploy is retried.

    for (const role of ['anon', 'authenticated']) {
      await db.exec(`SET ROLE ${role}; SET request.jwt.claim.sub='${role === 'authenticated' ? owner : ''}'`);
      for (const [table] of policies) {
        expect((await db.query(`SELECT * FROM ${table}`)).rows.map(r => r.id)).toEqual(role === 'authenticated' ? [1] : []);
        await expect(db.query(`INSERT INTO ${table} VALUES(3,'${other}')`)).rejects.toThrow(/row-level security/);
        expect((await db.query(`UPDATE ${table} SET beautician_id='${owner}' WHERE id=2 RETURNING id`)).rows).toEqual([]);
        expect((await db.query(`DELETE FROM ${table} WHERE id=2 RETURNING id`)).rows).toEqual([]);
      }
      await expect(db.query(`SELECT increment_message_usage('${owner}','2026-11-01',100,'sms',1)`)).rejects.toThrow(/permission denied/);
      await expect(db.query(`SELECT increment_sms_usage('${owner}','2026-11-01',100,1)`)).rejects.toThrow(/permission denied/);
      for (const name of ['redact_deleted_account_event','remember_instagram_account_links','reserve_stripe_receipt_key']) {
        expect((await db.query('SELECT has_function_privilege(current_user,$1,\'EXECUTE\') AS allowed', [name+'()'])).rows[0].allowed).toBe(false);
      }
      await db.exec('RESET ROLE');
    }
    // Trigger invocation must survive removing client EXECUTE privileges.
    await db.exec("SET ROLE authenticated; INSERT INTO trigger_source(id) VALUES(9); RESET ROLE;");
    expect((await db.query('SELECT id FROM trigger_audit')).rows).toEqual([{ id: 9 }]);
    expect((await db.query('SELECT updated_at IS NOT NULL AS stamped FROM trigger_source')).rows[0].stamped).toBe(true);
    await db.exec('SET ROLE service_role');
    for (const [table] of policies) {
      await db.exec(`INSERT INTO ${table} VALUES(3,'${owner}'); UPDATE ${table} SET beautician_id='${other}' WHERE id=3; DELETE FROM ${table} WHERE id=3;`);
      expect((await db.query(`SELECT * FROM ${table}`)).rows).toHaveLength(2);
    }
    expect((await db.query(`SELECT increment_message_usage('${owner}','2026-11-01',100,'sms',1) AS value`)).rows[0].value).toBe(1);
    expect((await db.query(`SELECT increment_sms_usage('${owner}','2026-11-01',100,1) AS value`)).rows[0].value).toBe(1);
    await db.exec('RESET ROLE');
    const paths = await db.query("SELECT proname,proconfig FROM pg_proc WHERE proname IN ('get_my_beautician_id','update_updated_at','bump_client_last_visit','record_deleted_appointment','increment_message_usage','increment_sms_usage')");
    expect(paths.rows).toHaveLength(6);
    for (const row of paths.rows) expect(row.proconfig).toContain('search_path=pg_catalog, public, pg_temp');
    expect((await db.query('SELECT * FROM beauticians')).rows).toHaveLength(2);
  } finally { await db.close(); }
}, 30000);
