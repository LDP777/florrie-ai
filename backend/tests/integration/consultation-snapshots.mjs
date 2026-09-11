// Run with PGLITE_MODULE pointing to an installed @electric-sql/pglite module.
// Uses an isolated in-memory PostgreSQL instance; no connection to app data.
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { PGlite } = await import(process.env.PGLITE_MODULE || '@electric-sql/pglite');
const db = new PGlite();
await db.exec(`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE consultation_forms (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), beautician_id uuid, name text, consent_text text, is_default boolean, is_active boolean DEFAULT true, updated_at timestamptz);
CREATE TABLE consultation_form_fields (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), form_id uuid REFERENCES consultation_forms(id), type text CHECK(type IN ('text','signature')), label text NOT NULL, options jsonb, required boolean, sort_order integer);
CREATE TABLE consultation_responses (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), form_id uuid REFERENCES consultation_forms(id), answers jsonb, status text);
INSERT INTO consultation_forms VALUES ('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','Original','Original consent',true,true,now());
INSERT INTO consultation_form_fields (id,form_id,type,label,sort_order) VALUES ('00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000001','text','Allergies?',0);
INSERT INTO consultation_responses (form_id,answers,status) VALUES ('00000000-0000-0000-0000-000000000001','{"00000000-0000-0000-0000-000000000003":"Latex"}','completed');
`);
const migration = await readFile(new URL('../../../supabase/migrations/20260905_consultation_evidence_snapshots.sql', import.meta.url), 'utf8');
await db.exec(migration);
const owner = '00000000-0000-0000-0000-000000000002';
const form = '00000000-0000-0000-0000-000000000001';
const original = (await db.query('SELECT form_snapshot FROM consultation_responses')).rows[0].form_snapshot;
assert.equal(original.name, 'Original');
assert.equal(original.consultation_form_fields[0].label, 'Allergies?');
// Pending requests must also keep the issued template when the owner edits it.
await db.query("INSERT INTO consultation_responses (form_id,status) VALUES ($1,'pending')", [form]);
const changed = { name: 'Changed', consent_text: 'New wording', is_default: true, fields: [{ type: 'text', label: 'Medication?', required: true }] };
await db.query('SELECT save_consultation_template($1,$2,$3)', [owner,form,changed]);
assert.deepEqual((await db.query('SELECT form_snapshot FROM consultation_responses')).rows.map(r=>r.form_snapshot), [original, original]);
assert.equal((await db.query('SELECT label FROM consultation_form_fields')).rows[0].label, 'Medication?');
await db.query("INSERT INTO consultation_responses (form_id,status) VALUES ($1,'pending')", [form]);
assert.equal((await db.query("SELECT form_snapshot FROM consultation_responses WHERE form_snapshot->>'name'='Changed'")).rows.length, 1);
// Neither a crafted submission nor a later update may rewrite its evidence.
await db.query("UPDATE consultation_responses SET form_snapshot = '{}'::jsonb, status='completed' WHERE form_snapshot->>'name'='Original'");
assert.deepEqual((await db.query("SELECT form_snapshot FROM consultation_responses WHERE form_snapshot->>'name'='Original'")).rows.map(r=>r.form_snapshot), [original,original]);
// A field failure must roll back metadata and all previous fields together.
await assert.rejects(db.query('SELECT save_consultation_template($1,$2,$3)', [owner,form,{...changed,name:'Must roll back',fields:[{type:'invalid',label:'Bad'}]}]));
assert.equal((await db.query('SELECT name FROM consultation_forms WHERE id=$1',[form])).rows[0].name,'Changed');
assert.equal((await db.query('SELECT label FROM consultation_form_fields')).rows[0].label,'Medication?');
await assert.rejects(db.query('SELECT save_consultation_template($1,$2,$3)', ['00000000-0000-0000-0000-000000000099',form,changed]));
// Partial PATCH metadata must keep questions and current consent wording.
await db.query('SELECT save_consultation_template($1,$2,$3)', [owner,form,{is_default:false}]);
assert.equal((await db.query('SELECT name FROM consultation_forms WHERE id=$1',[form])).rows[0].name,'Changed');
assert.equal((await db.query('SELECT label FROM consultation_form_fields')).rows[0].label,'Medication?');
// Creating with invalid fields cannot leave an empty active/default form.
await assert.rejects(db.query('SELECT save_consultation_template($1,NULL,$2)', [owner,{...changed,fields:[{type:'invalid',label:'Bad'}]}]));
assert.equal((await db.query('SELECT count(*)::int n FROM consultation_forms')).rows[0].n,1);
// Rerunning a deployment must not replace snapshots with today's template.
await db.exec(migration);
assert.deepEqual((await db.query("SELECT form_snapshot FROM consultation_responses WHERE form_snapshot->>'name'='Original'")).rows.map(r=>r.form_snapshot), [original,original]);
// The booking preparation migration is additive, replayable and leaves the
// snapshot trigger and signed answers untouched.
await db.exec(`CREATE TABLE appointments (id uuid PRIMARY KEY); CREATE TABLE patch_tests (id uuid PRIMARY KEY, test_date date);`);
const careMigration = await readFile(new URL('../../../supabase/migrations/20260911_booking_preparation.sql', import.meta.url), 'utf8');
const beforeCare = (await db.query('SELECT * FROM consultation_responses ORDER BY id')).rows;
await db.exec(careMigration); await db.exec(careMigration);
const afterCare = (await db.query('SELECT * FROM consultation_responses ORDER BY id')).rows;
assert.deepEqual(afterCare.map(({booking_care, ...row}) => row), beforeCare);
assert.ok(afterCare.every(row => row.booking_care === null));
const responseId = afterCare[0].id;
await db.query(`UPDATE consultation_responses SET booking_care = '{"version":1,"revision":0}' WHERE id=$1`, [responseId]);
const update = `UPDATE consultation_responses SET booking_care = '{"version":1,"revision":1}' WHERE id=$1 AND booking_care->>'revision'='0' RETURNING id`;
assert.equal((await db.query(update,[responseId])).rows.length,1);
assert.equal((await db.query(update,[responseId])).rows.length,0);
assert.deepEqual((await db.query('SELECT form_snapshot FROM consultation_responses WHERE id=$1',[responseId])).rows[0].form_snapshot, afterCare[0].form_snapshot);
await db.close();
console.log('PASS: migration backfill, issued evidence, new requests, immutable submissions, atomic edit/create rollback, ownership, repeat migration');
