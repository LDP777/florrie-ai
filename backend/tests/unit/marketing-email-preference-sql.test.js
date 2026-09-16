import { it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

// Embedded PostgreSQL only; no DATABASE_URL, secrets or external database.
const migration = await readFile(new URL('../../../supabase/migrations/20260916_marketing_email_preference.sql', import.meta.url), 'utf8');
const capturedSchema = await readFile(new URL('../fixtures/marketing-preference-captured-schema.sql', import.meta.url), 'utf8');
const protection = await readFile(new URL('../../../supabase/migrations/20260906_account_protection_and_deletion.sql', import.meta.url), 'utf8');
const owner = '00000000-0000-4000-8000-000000000001';
const ownerAuth = '00000000-0000-4000-8000-000000000002';
const other = '00000000-0000-4000-8000-000000000003';
const otherAuth = '00000000-0000-4000-8000-000000000004';

async function database() {
  const db = new PGlite();
  await db.exec(capturedSchema);
  await db.exec('CREATE TABLE public.account_deletions(auth_id uuid);');
  // Use the real server-field protection, including its allowed-column list.
  const fn = protection.match(/CREATE OR REPLACE FUNCTION public\.protect_beautician_server_fields\(\)[\s\S]*?\$\$;/)?.[0];
  expect(fn).toBeTruthy();
  await db.exec(fn + '\nCREATE TRIGGER protect_beautician_server_fields BEFORE INSERT OR UPDATE ON public.beauticians FOR EACH ROW EXECUTE FUNCTION public.protect_beautician_server_fields();');
  await db.query("INSERT INTO beauticians(id,auth_id,first_name,email,last_name) VALUES ($1,$2,$3,$4,'Fixture'),($5,$6,$7,$8,'Fixture')",
    [owner,ownerAuth,'Fictional owner','owner@example.invalid',other,otherAuth,'Other owner','other@example.invalid']);
  return db;
}

async function asOwner(db, sql, role = 'authenticated') {
  await db.exec(`BEGIN; SET LOCAL ROLE ${role}; SET LOCAL request.jwt.claim.sub='${ownerAuth}';`);
  try {
    const result = await db.query(sql);
    await db.exec('COMMIT');
    return result;
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }
}

it('repairs the captured missing-column layout without replaying emails or widening account access', async () => {
  const db = await database();
  try {
    expect((await db.query("SELECT column_name FROM information_schema.columns WHERE table_name='beauticians' AND column_name='marketing_emails_enabled'")).rows).toEqual([]);
    // Production email_sends has no updated_at; the new migration must not
    // install 022's incompatible trigger or mutate queued/skipped messages.
    expect((await db.query("SELECT column_name FROM information_schema.columns WHERE table_name='email_sends' AND column_name='updated_at'")).rows).toEqual([]);
    await db.query("INSERT INTO email_sends(beautician_id,email_key,sequence,subject,send_at,status) VALUES ($1,'skipped_fixture','welcome','Fixture',now(),'skipped'),($1,'due_fixture','welcome','Fixture',now(),'pending')", [owner]);
    const before = (await db.query('SELECT * FROM email_sends ORDER BY email_key')).rows;
    await db.exec(migration);
    await db.exec(migration);
    expect((await db.query('SELECT marketing_emails_enabled FROM beauticians')).rows).toEqual([
      {marketing_emails_enabled:false},{marketing_emails_enabled:false},
    ]);
    expect((await db.query('SELECT * FROM email_sends ORDER BY email_key')).rows).toEqual(before);
    const column = (await db.query("SELECT column_default,is_nullable FROM information_schema.columns WHERE table_name='beauticians' AND column_name='marketing_emails_enabled'")).rows[0];
    expect(column).toEqual({column_default:'false',is_nullable:'NO'});
    const privileges = (await db.query("SELECT has_column_privilege('authenticated','beauticians','marketing_emails_enabled','UPDATE') AS preference, has_table_privilege('authenticated','beauticians','UPDATE') AS whole_row, has_column_privilege('authenticated','beauticians','subscription_plan','UPDATE') AS billing, has_column_privilege('anon','beauticians','marketing_emails_enabled','UPDATE') AS anonymous")).rows[0];
    expect(privileges).toEqual({preference:true,whole_row:false,billing:false,anonymous:false});
    expect((await asOwner(db,`UPDATE beauticians SET marketing_emails_enabled=true WHERE id='${owner}' RETURNING marketing_emails_enabled`)).rows).toEqual([{marketing_emails_enabled:true}]);
    expect((await asOwner(db,`UPDATE beauticians SET marketing_emails_enabled=true WHERE id='${other}' RETURNING id`)).rows).toEqual([]);
    expect((await db.query('SELECT marketing_emails_enabled FROM beauticians WHERE id=$1',[other])).rows[0].marketing_emails_enabled).toBe(false);
    await expect(asOwner(db,`UPDATE beauticians SET marketing_emails_enabled=false WHERE id='${owner}'`,'anon')).rejects.toMatchObject({code:'42501'});
    await expect(asOwner(db,`UPDATE beauticians SET subscription_plan='florrie_team' WHERE id='${owner}'`)).rejects.toMatchObject({code:'42501'});
    await expect(asOwner(db,`UPDATE beauticians SET marketing_emails_enabled=NULL WHERE id='${owner}'`)).rejects.toMatchObject({code:'23502'});
    // The owner can still turn it off and edit an ordinary profile field.
    await asOwner(db,`UPDATE beauticians SET marketing_emails_enabled=false,first_name='Updated name' WHERE id='${owner}'`);
    expect((await db.query('SELECT marketing_emails_enabled,first_name FROM beauticians WHERE id=$1',[owner])).rows[0]).toEqual({marketing_emails_enabled:false,first_name:'Updated name'});
    await db.query("INSERT INTO beauticians(auth_id,first_name,email,last_name) VALUES (gen_random_uuid(),$1,$2,'Fixture')", ['New owner','new@example.invalid']);
    expect((await db.query("SELECT marketing_emails_enabled FROM beauticians WHERE first_name='New owner'")).rows[0].marketing_emails_enabled).toBe(false);
  } finally { await db.close(); }
}, 30000);

it('preserves explicit choices in a nullable legacy installation while replacing only unknown values', async () => {
  const db = await database();
  try {
    await db.exec('ALTER TABLE beauticians ADD COLUMN marketing_emails_enabled BOOLEAN DEFAULT true;');
    await db.query('UPDATE beauticians SET marketing_emails_enabled=false WHERE id=$1',[other]);
    await db.query("INSERT INTO beauticians(auth_id,first_name,email,last_name,marketing_emails_enabled) VALUES (gen_random_uuid(),$1,$2,'Fixture',NULL)", ['Unknown owner','unknown@example.invalid']);
    await db.exec(migration);
    await db.exec(migration);
    expect((await db.query('SELECT first_name,marketing_emails_enabled FROM beauticians ORDER BY first_name')).rows).toEqual([
      {first_name:'Fictional owner',marketing_emails_enabled:true},
      {first_name:'Other owner',marketing_emails_enabled:false},
      {first_name:'Unknown owner',marketing_emails_enabled:false},
    ]);
    await db.query("INSERT INTO beauticians(auth_id,first_name,email,last_name) VALUES (gen_random_uuid(),$1,$2,'Fixture')", ['New owner','new@example.invalid']);
    expect((await db.query("SELECT marketing_emails_enabled FROM beauticians WHERE first_name='New owner'")).rows[0].marketing_emails_enabled).toBe(false);
  } finally { await db.close(); }
}, 30000);
