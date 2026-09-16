// Disposable PostgreSQL only; no network or production data.
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
  CREATE TABLE beauticians (id uuid PRIMARY KEY, timezone text, patch_test_duration_minutes integer, patch_test_price_cents integer);
  CREATE TABLE appointments (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), beautician_id uuid, client_id uuid,
    client_email text, treatment_id uuid, extra_treatment_ids jsonb, starts_at timestamptz, ends_at timestamptz,
    duration_minutes integer, status text, beautician_notes text, booked_via text, price_cents integer, created_at timestamptz DEFAULT now());
  CREATE TABLE patch_tests (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), beautician_id uuid, client_id uuid,
    appointment_id uuid REFERENCES appointments(id), parent_appointment_id uuid REFERENCES appointments(id), covered_treatment_ids uuid[],
    test_date date, suggested_slot timestamptz, confirmed_at timestamptz, performed_at timestamptz, auto_booked boolean,
    result text DEFAULT 'pending', status text DEFAULT 'pending', created_at timestamptz DEFAULT now());
`);
const migration = await readFile(new URL('../../../supabase/migrations/20260916_atomic_managed_patch_booking.sql', import.meta.url), 'utf8');
await db.exec(migration); await db.exec(migration);
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
const parent = id(1), owner = id(2), client = id(3), treatment = id(4), extra = id(5);
const slot = '2099-12-04T09:00:00Z';
const book = (start = slot, create = true, salon = owner) => db.query('SELECT * FROM book_managed_patch_test($1,$2,$3,$4)', [parent, salon, start, create]);
const count = async table => (await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n;
async function seed() {
  await db.exec('DELETE FROM patch_tests; DELETE FROM appointments; DELETE FROM beauticians;');
  await db.query('INSERT INTO beauticians VALUES ($1,$2,10,0)', [owner, 'Europe/London']);
  await db.query("INSERT INTO appointments(id,beautician_id,client_id,client_email,treatment_id,extra_treatment_ids,starts_at,ends_at,status) VALUES ($1,$2,$3,'demo@example.com',$4,$5,'2099-12-08T11:00:00Z','2099-12-08T12:00:00Z','confirmed')", [parent, owner, client, treatment, [extra]]);
}
const failPatch = async () => db.exec(`CREATE OR REPLACE FUNCTION fail_patch_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic evidence failure'; END $$;
  CREATE TRIGGER fail_patch_write BEFORE INSERT OR UPDATE ON patch_tests FOR EACH ROW EXECUTE FUNCTION fail_patch_write();`);
const allowPatch = async () => db.exec('DROP TRIGGER fail_patch_write ON patch_tests');

await seed();
assert.equal((await book(slot, false)).rows.length, 0);
assert.equal(await count('appointments'), 1, 'replay probe creates no visit');
await assert.rejects(book(slot, true, id(99)), /patch_parent_unavailable/);
await failPatch();
await assert.rejects(book(), /synthetic evidence failure/);
assert.equal(await count('appointments'), 1, 'failed evidence INSERT rolls back the visit');
assert.equal(await count('patch_tests'), 0);
await allowPatch();
await db.exec(`CREATE OR REPLACE FUNCTION skip_patch_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$;
  CREATE TRIGGER skip_patch_write BEFORE INSERT ON patch_tests FOR EACH ROW EXECUTE FUNCTION skip_patch_write();`);
await assert.rejects(book(), /patch_evidence_not_saved/);
assert.equal(await count('appointments'), 1, 'a suppressed evidence write cannot leave a visit');
await db.exec('DROP TRIGGER skip_patch_write ON patch_tests');
const first = (await book()).rows[0];
assert.equal(first.already_booked, false);
const replay = (await book()).rows[0];
assert.equal(replay.id, first.id);
assert.equal(replay.already_booked, true);
assert.equal((await book(slot, false)).rows[0].id, first.id, 'lost success response can be recovered before conflict checks');
assert.equal(await count('appointments'), 2);
assert.equal(await count('patch_tests'), 1);
const evidence = (await db.query('SELECT * FROM patch_tests')).rows[0];
assert.equal(evidence.parent_appointment_id, parent);
assert.equal(evidence.appointment_id, first.id);
assert.deepEqual(evidence.covered_treatment_ids.sort(), [treatment, extra].sort());
assert.equal(evidence.performed_at, null, 'booking is not proof the test was applied');
await assert.rejects(book('2099-12-04T10:00:00Z'), /patch_already_booked/);
assert.equal(await count('appointments'), 2, 'a second chosen time cannot create another active visit');

await seed();
await db.query('INSERT INTO patch_tests(id,beautician_id,client_id,appointment_id) VALUES ($1,$2,$3,$4)', [id(6), owner, client, parent]);
await failPatch();
await assert.rejects(book(), /synthetic evidence failure/);
assert.equal(await count('appointments'), 1, 'failed legacy placeholder UPDATE rolls back the visit');
assert.equal((await db.query('SELECT appointment_id FROM patch_tests')).rows[0].appointment_id, parent);
await allowPatch();
await book();
assert.equal(await count('patch_tests'), 1, 'old pending request is reused');
assert.equal((await db.query('SELECT id FROM patch_tests')).rows[0].id, id(6));

await seed();
const concurrent = await Promise.all([book(), book()]);
assert.equal(new Set(concurrent.map(r => r.rows[0].id)).size, 1);
assert.deepEqual(concurrent.map(r => r.rows[0].already_booked).sort(), [false, true]);
assert.equal(await count('appointments'), 2);
await seed();
const choices = await Promise.allSettled([book(), book('2099-12-04T10:00:00Z')]);
assert.equal(choices.filter(r => r.status === 'fulfilled').length, 1);
assert.equal(await count('appointments'), 2);

await seed();
await db.exec("UPDATE appointments SET status='cancelled'");
await assert.rejects(book(), /patch_parent_unavailable/);
await db.exec("UPDATE appointments SET status='confirmed', starts_at='2099-12-06T09:05:00Z'");
await assert.rejects(book(), /patch_time_unavailable/);
assert.equal(await count('appointments'), 1, '48 hours runs from patch visit end');
await seed();
await db.query("INSERT INTO appointments(beautician_id,client_id,starts_at,ends_at,status) VALUES ($1,$2,'2099-12-04T08:55:00Z','2099-12-04T09:15:00Z','confirmed')", [owner, id(44)]);
await assert.rejects(book(), /patch_time_unavailable/);
assert.equal(await count('patch_tests'), 0);

await seed();
await db.query("INSERT INTO patch_tests(id,beautician_id,client_id,parent_appointment_id,performed_at,result) VALUES ($1,$2,$3,$4,'2098-01-01T09:00:00Z','pass')", [id(7), owner, client, parent]);
const signedBefore = (await db.query('SELECT * FROM patch_tests WHERE id=$1', [id(7)])).rows[0];
await book();
assert.deepEqual((await db.query('SELECT * FROM patch_tests WHERE id=$1', [id(7)])).rows[0], signedBefore, 'performed evidence stays intact');
for (const role of ['anon', 'authenticated']) {
  await db.exec(`SET ROLE ${role}`);
  await assert.rejects(book(), /permission denied/);
  await db.exec('RESET ROLE');
}
await db.close();
console.log('PASS: atomic patch INSERT/UPDATE rollback, no-write replay probe, lost-response retry, competing choices, same-slot retry, tenant/parent/time/diary guards, legacy placeholder reuse, performed evidence preservation, service-only permissions and repeat migration');
