import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { it, expect } from 'vitest';

it('atomically approves once, isolates salons, preserves pause and forbids direct client approval', async () => {
  const db = new PGlite();
  const owner = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', other = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
  const source = 'cccccccc-cccc-4ccc-cccc-cccccccccccc', id = 'dddddddd-dddd-4ddd-dddd-dddddddddddd';
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
      CREATE TABLE beauticians(id uuid PRIMARY KEY);
      CREATE TABLE messages(id uuid PRIMARY KEY);
      CREATE TABLE knowledge_entries(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),beautician_id uuid REFERENCES beauticians(id),category text NOT NULL CHECK(category IN ('faq','policy')),title text,content text,is_active boolean DEFAULT true,updated_at timestamptz DEFAULT now());
      GRANT ALL ON knowledge_entries TO service_role;
      INSERT INTO beauticians VALUES('${owner}'),('${other}'); INSERT INTO messages VALUES('${source}');`);
    const sql = await readFile(new URL('../../../supabase/migrations/20260917_reply_learning.sql', import.meta.url), 'utf8');
    await db.exec(sql); await db.exec(sql);
    await db.query(`INSERT INTO knowledge_suggestions(id,beautician_id,source_message_id,status,category,title,content) VALUES($1,$2,$3,'pending','faq','Vouchers','Twelve months.')`, [id,owner,source]);
    const approve = (who = owner, category = 'faq', replacement = null) => db.query('SELECT * FROM approve_knowledge_suggestion($1,$2,$3,$4,$5,$6)',[who,id,category,'Gift vouchers','Valid for twelve months.',replacement]);
    await expect(approve(other)).rejects.toThrow('Suggestion not found');
    await expect(approve(owner, 'invalid')).rejects.toThrow();
    expect((await db.query('SELECT status FROM knowledge_suggestions')).rows[0].status).toBe('pending');
    expect((await db.query('SELECT * FROM knowledge_entries')).rows).toHaveLength(0);
    const entry = (await approve()).rows[0];
    expect(entry.is_active).toBe(true);
    expect((await approve()).rows[0].id).toBe(entry.id);
    expect((await db.query('SELECT * FROM knowledge_entries')).rows).toHaveLength(1);
    await db.query('UPDATE knowledge_entries SET is_active=false WHERE id=$1',[entry.id]);
    expect((await approve()).rows[0].is_active).toBe(false);
    await db.exec("SET ROLE authenticated");
    await expect(db.query('SELECT * FROM knowledge_suggestions')).rejects.toThrow('permission denied');
    await expect(approve()).rejects.toThrow('permission denied');
    await db.exec('RESET ROLE');
    await db.query("UPDATE knowledge_suggestions SET status='pending',knowledge_entry_id=NULL WHERE id=$1",[id]);
    await expect(approve(other, 'faq', entry.id)).rejects.toThrow();
    expect((await approve(owner,'faq',entry.id)).rows[0].is_active).toBe(false);
    expect((await db.query('SELECT * FROM knowledge_entries')).rows).toHaveLength(1);
    await db.query("UPDATE knowledge_suggestions SET status='dismissed' WHERE id=$1",[id]);
    await expect(approve()).rejects.toThrow('not awaiting approval');
  } finally { await db.close(); }
}, 30000);
