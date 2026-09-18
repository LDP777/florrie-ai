// Disposable PostgreSQL only. No service credentials, network or provider calls.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const db=new PGlite();
const id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
try {
 await db.exec(`
  CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
  CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
  GRANT USAGE ON SCHEMA auth TO authenticated;
  CREATE TABLE public.beauticians(id uuid PRIMARY KEY, auth_id uuid NOT NULL);
  GRANT SELECT ON public.beauticians TO authenticated;
  CREATE TABLE public.aftercare_messages(id uuid PRIMARY KEY, message text, is_active boolean);
  CREATE TABLE public.knowledge_entries(id uuid PRIMARY KEY, content text, is_active boolean);
 `);
 await db.query('INSERT INTO beauticians VALUES ($1,$2),($3,$4)',[id(1),id(11),id(2),id(22)]);
 await db.query('INSERT INTO aftercare_messages VALUES ($1,$2,true)',[id(80),'Existing executor guidance']);
 await db.query('INSERT INTO knowledge_entries VALUES ($1,$2,true)',[id(90),'Existing approved answer']);
 const migration=await readFile(new URL('../../supabase/migrations/20260918_aftercare_cards.sql',import.meta.url),'utf8');
 await db.exec(migration);
 const content=[{title:'Saved step',text:'Owner guidance',reference:'Retain'}];
 await db.query('INSERT INTO aftercare_cards(id,beautician_id,treatment_name,instructions,products,personal_note,auto_send,send_after_hours,rebook_nudge_days) VALUES ($1,$2,$3,$4,$5,$6,true,72,56),($7,$8,$9,$4,$5,$6,false,1,28)',[id(3),id(1),'Owner A card',JSON.stringify(content),JSON.stringify(['Product']),'Keep this note',id(4),id(2),'Owner B card']);
 await db.exec(migration);
 assert.equal((await db.query('SELECT count(*)::int AS count FROM aftercare_cards')).rows[0].count,2,'rerun preserves existing rows');

 await db.exec('SET ROLE anon');
 await assert.rejects(db.query('SELECT * FROM aftercare_cards'),/permission denied/);
 await db.exec('RESET ROLE; SET ROLE authenticated');
 await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[id(11)]);
 const own=(await db.query('SELECT * FROM aftercare_cards')).rows;
 assert.equal(own.length,1);assert.equal(own[0].id,id(3));
 await assert.rejects(db.query('INSERT INTO aftercare_cards(beautician_id,treatment_name) VALUES ($1,$2)',[id(2),'Foreign insert']),/row-level security/);
 assert.equal((await db.query('UPDATE aftercare_cards SET personal_note=$1 WHERE id=$2 RETURNING id',['Attack',id(4)])).rows.length,0);
 await assert.rejects(db.query('UPDATE aftercare_cards SET beautician_id=$1 WHERE id=$2',[id(2),id(3)]),/row-level security/);
 await assert.rejects(db.query('DELETE FROM aftercare_cards WHERE id=$1',[id(3)]),/permission denied/);
 await assert.rejects(db.query("UPDATE aftercare_cards SET instructions='{}'::jsonb WHERE id=$1",[id(3)]),/check constraint/);

 const changed=(await db.query('UPDATE aftercare_cards SET personal_note=$1 WHERE id=$2 AND beautician_id=$3 AND updated_at=$4 RETURNING *',['Owner correction',id(3),id(1),own[0].updated_at])).rows[0];
 assert.ok(changed);assert.equal(changed.auto_send,true);assert.equal(changed.send_after_hours,72);assert.equal(changed.rebook_nudge_days,56);
 assert.deepEqual(changed.instructions,content);assert.ok(new Date(changed.updated_at).getTime()>new Date(own[0].updated_at).getTime());
 assert.equal((await db.query('UPDATE aftercare_cards SET personal_note=$1 WHERE id=$2 AND updated_at=$3 RETURNING id',['Stale edit',id(3),own[0].updated_at])).rows.length,0);
 const archived=(await db.query('UPDATE aftercare_cards SET archived_at=now() WHERE id=$1 RETURNING *',[id(3)])).rows[0];
 assert.ok(archived.archived_at);assert.equal(archived.personal_note,'Owner correction');
 assert.equal((await db.query('SELECT * FROM aftercare_cards WHERE archived_at IS NULL')).rows.length,0);
 await db.query('UPDATE aftercare_cards SET archived_at=NULL WHERE id=$1',[id(3)]);
 assert.equal((await db.query('SELECT * FROM aftercare_cards WHERE archived_at IS NULL')).rows.length,1);
 const created=(await db.query('INSERT INTO aftercare_cards(beautician_id,treatment_name) VALUES ($1,$2) RETURNING *',[id(1),'New draft'])).rows[0];
 assert.equal(created.auto_send,false);assert.equal(created.archived_at,null);

 await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[id(22)]);
 assert.deepEqual((await db.query('SELECT treatment_name,personal_note FROM aftercare_cards')).rows,[{treatment_name:'Owner B card',personal_note:'Keep this note'}]);
 await db.exec('RESET ROLE');
 assert.deepEqual((await db.query('SELECT message,is_active FROM aftercare_messages')).rows,[{message:'Existing executor guidance',is_active:true}]);
 assert.deepEqual((await db.query('SELECT content,is_active FROM knowledge_entries')).rows,[{content:'Existing approved answer',is_active:true}]);
 console.log('PASS: migration rerun retains records; owner RLS blocks cross-salon reads/writes/reassignment and deletion; version checks protect edits; archive/restore retains guidance and leaves executors/approved answers unchanged');
} finally {await db.close();}
