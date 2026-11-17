// Disposable PostgreSQL rehearsal. No external database or customer records.
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const db = new PGlite();
const id = n => `00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
try {
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
    CREATE TABLE beauticians(id uuid PRIMARY KEY, timezone text);
    CREATE TABLE appointments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), beautician_id uuid, starts_at timestamptz, ends_at timestamptz, status text, note text);
    CREATE TABLE hours_exceptions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), beautician_id uuid, date date, end_date date, type text, is_closed boolean, start_time time, end_time time, custom_start time, custom_end time, reason text, note text, notify_clients boolean);
    CREATE TABLE ai_actions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), beautician_id uuid, action_type text, digital_employee text, summary text, details jsonb, outcome text, autonomous boolean);
    CREATE TABLE florrie_decisions(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), beautician_id uuid, suggestion_type text, suggestion_payload jsonb, response text, acted_on boolean);
  `);
  await db.exec(await readFile(new URL('../../supabase/migrations/20261117094906_thoughtful_time_protection.sql', import.meta.url), 'utf8'));
  await db.query('INSERT INTO beauticians VALUES ($1,$2),($3,$2)', [id(1), 'Europe/London', id(2)]);
  const day = (await db.query("SELECT (current_date+14)::text AS day")).rows[0].day;
  const next = (await db.query("SELECT (current_date+15)::text AS day")).rows[0].day;
  const confirm = (key, date = day, start = null, end = null, reason = 'personal') => db.query('SELECT confirm_suggested_time($1,$2,$3,$4,$5,$6,$7) AS result', [id(1), key, date, start, end, 'Fictional protected time', reason]);
  const booking = (owner, date, start = '10:00', end = '11:00', status = 'confirmed') => db.query('INSERT INTO appointments(beautician_id,starts_at,ends_at,status) VALUES($1,$2,$3,$4) RETURNING id', [owner, `${date}T${start}:00Z`, `${date}T${end}:00Z`, status]);
  await assert.rejects(confirm('bad', day, null, null, null), /Invalid suggested time/);
  const first = (await confirm('day-off')).rows[0].result;
  assert.equal(first.already_done, false);
  assert.equal((await confirm('day-off')).rows[0].result.already_done, true);
  for (const table of ['hours_exceptions', 'ai_actions', 'florrie_decisions']) assert.equal((await db.query(`SELECT count(*)::int n FROM ${table}`)).rows[0].n, 1, 'retry must not duplicate work or receipts');
  await assert.rejects(booking(id(1), day), /protected/);
  await booking(id(2), day); // another salon remains independent
  await booking(id(1), day, '10:00', '11:00', 'cancelled');
  await assert.rejects(db.query("UPDATE appointments SET status='confirmed' WHERE beautician_id=$1", [id(1)]), /protected/);
  await db.query("UPDATE appointments SET note='Fictional note' WHERE beautician_id=$1", [id(1)]);
  const existing = (await booking(id(1), next)).rows[0];
  await assert.rejects(confirm('blocked-by-booking', next), /booking now overlaps/);
  assert.equal((await db.query('SELECT count(*)::int n FROM hours_exceptions')).rows[0].n, 1);
  await confirm('break', next, '12:00', '12:30');
  await booking(id(1), next, '11:30', '12:00');
  await booking(id(1), next, '12:30', '13:00');
  await assert.rejects(booking(id(1), next, '12:15', '13:00'), /protected/);
  await assert.rejects(db.query('UPDATE appointments SET starts_at=$1, ends_at=$2 WHERE id=$3', [`${next}T12:00:00Z`, `${next}T12:30:00Z`, existing.id]), /protected/);
  await assert.rejects(confirm('overlap-block', next, '12:00', '12:15'), /diary already/);
  await db.query("UPDATE hours_exceptions SET end_date=date+2 WHERE suggestion_key='break'");
  const third = (await db.query('SELECT (current_date+16)::text AS day')).rows[0].day;
  await booking(id(1), third, '10:00', '11:00'); // repeated partial blocks do not close the whole intervening day
  await assert.rejects(booking(id(1), third, '12:00', '12:30'), /protected/);
  await confirm('other-break', third, '14:00', '14:30');
  await db.query("UPDATE hours_exceptions SET start_time='13:00',end_time='13:30' WHERE suggestion_key='break'");
  await assert.rejects(confirm('break', next, '12:00', '12:30'), /since been edited/);
  await db.query("DELETE FROM hours_exceptions WHERE suggestion_key='break'");
  await booking(id(1), next, '12:00', '12:30'); // deleting the block restores availability
  await db.exec('SET ROLE authenticated');
  await assert.rejects(confirm('forbidden'), /permission denied/);
  await db.exec('RESET ROLE');
  console.log('PASS: SQL validation, owner isolation, idempotency, overlap rejection, late booking protection, edit/delete and execute permissions');
} finally { await db.close(); }
