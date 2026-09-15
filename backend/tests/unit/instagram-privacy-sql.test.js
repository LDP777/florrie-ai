import { it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';

it('preserves work data, isolates requests, survives retries and protects newer connections in PostgreSQL', async () => {
  const db = new PGlite();
  const salon = '00000000-0000-0000-0000-000000000001', other='00000000-0000-0000-0000-000000000002';
  const hash = id => createHash('sha256').update('instagram:'+id).digest('hex');
  let event = 0;
  const request = (account,action='delete',issued='2026-09-15T11:00:00Z',eventHash=String(++event).padStart(64,'0')) => db.query('SELECT request_instagram_data_action($1,$2,$3,$4,$5) AS receipt',[hash(account),action,issued,eventHash,String(event).padStart(48,'a')]);
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE beauticians(id uuid PRIMARY KEY,created_at timestamptz DEFAULT '2026-09-01',instagram_page_id text,instagram_page_token text,instagram_page_name text,instagram_account_ids text[]);
      CREATE TABLE appointments(id int,beautician_id uuid);
      CREATE TABLE messages(id int,beautician_id uuid,content text);`);
    await db.query('INSERT INTO beauticians(id,instagram_page_id,instagram_page_token,instagram_account_ids) VALUES($1,\'111\',\'token-one\',ARRAY[\'112\']),($2,\'222\',\'token-two\',ARRAY[\'223\'])',[salon,other]);
    await db.query('INSERT INTO appointments VALUES(1,$1),(2,$2)',[salon,other]);
    await db.query("INSERT INTO messages VALUES(1,$1,'work records'),(2,$2,'other records')",[salon,other]);
    const sql=await readFile(new URL('../../../supabase/migrations/20260915_instagram_privacy_requests.sql',import.meta.url),'utf8');
    await db.exec(sql);
    expect((await db.query('SELECT instagram_page_token FROM beauticians ORDER BY id')).rows.map(r=>r.instagram_page_token)).toEqual(['token-one','token-two']);
    expect((await db.query('SELECT count(*)::int n FROM instagram_account_links')).rows[0].n).toBe(4);
    const receipt=(await request('112')).rows[0].receipt;
    expect(receipt.status).toBe('needs_review');
    expect((await db.query('SELECT instagram_page_id,instagram_page_token,instagram_account_ids FROM beauticians WHERE id=$1',[salon])).rows[0]).toEqual({instagram_page_id:null,instagram_page_token:null,instagram_account_ids:null});
    expect((await db.query('SELECT instagram_page_token FROM beauticians WHERE id=$1',[other])).rows[0].instagram_page_token).toBe('token-two');
    expect((await db.query('SELECT * FROM appointments')).rows).toHaveLength(2);
    expect((await db.query('SELECT * FROM messages')).rows).toHaveLength(2);
    const repeated=(await request('112','delete','2026-09-15T11:00:00Z','1'.padStart(64,'0'))).rows[0].receipt;
    expect(repeated).toEqual(receipt);
    expect((await db.query('SELECT count(*)::int n FROM instagram_privacy_requests')).rows[0].n).toBe(1);
    // New callback after local disconnect still finds the salon via hashed links.
    await request('111');
    expect((await db.query('SELECT beautician_ids FROM instagram_privacy_requests ORDER BY requested_at DESC LIMIT 1')).rows[0].beautician_ids).toEqual([salon]);
    await db.query("UPDATE beauticians SET instagram_page_id='111',instagram_page_token='new-token',instagram_connected_at='2026-09-15T12:00:00Z' WHERE id=$1",[salon]);
    await request('111','deauthorize','2026-09-15T11:59:59Z');
    expect((await db.query('SELECT instagram_page_token FROM beauticians WHERE id=$1',[salon])).rows[0].instagram_page_token).toBe('new-token');
    await request('111','deauthorize','2026-09-15T12:01:00Z');
    expect((await db.query('SELECT instagram_page_token FROM beauticians WHERE id=$1',[salon])).rows[0].instagram_page_token).toBe(null);
    // A different new Instagram account remains attached after an old callback.
    await db.query("UPDATE beauticians SET instagram_page_id='333',instagram_page_token='third-token',instagram_account_ids=ARRAY['334'],instagram_connected_at='2026-09-15T12:02:00Z' WHERE id=$1",[salon]);
    await request('111','deauthorize','2026-09-15T12:03:00Z');
    expect((await db.query('SELECT instagram_page_token FROM beauticians WHERE id=$1',[salon])).rows[0].instagram_page_token).toBe('third-token');
    expect((await request('999')).rows[0].receipt.status).toBe('needs_review');
    for (const role of ['anon','authenticated']) {
      await db.exec('SET ROLE '+role);
      await expect(db.query('SELECT * FROM instagram_privacy_requests')).rejects.toThrow(/permission denied/);
      await expect(db.query('SELECT * FROM instagram_account_links')).rejects.toThrow(/permission denied/);
      await expect(request('222')).rejects.toThrow(/permission denied/);
      await expect(db.query('SELECT confirm_instagram_data_cleanup($1,$2)',[salon,'fake'])).rejects.toThrow(/permission denied/);
      await db.exec('RESET ROLE');
    }
    const id=(await db.query("SELECT id FROM instagram_privacy_requests WHERE confirmation_code=$1",[receipt.confirmation_code])).rows[0].id;
    await expect(db.query('SELECT confirm_instagram_data_cleanup($1,$2)',[id,''])).rejects.toThrow(/evidence/);
    await db.query('SELECT confirm_instagram_data_cleanup($1,$2)',[id,'TEST-REVIEW-ONLY']);
    expect((await db.query('SELECT status FROM instagram_privacy_requests WHERE id=$1',[id])).rows[0].status).toBe('completed');
  } finally { await db.close(); }
},30000);
