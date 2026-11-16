import { it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
it('keeps Business app mode bound to its session and imports owner replies once without running AI', async () => {
  const db = new PGlite(), owner = '00000000-0000-0000-0000-000000000001', legacy = '00000000-0000-0000-0000-000000000002';
  const scalar = async (s, values = []) => Object.values((await db.query(s, values)).rows[0])[0];
  try {
    await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
      CREATE TABLE beauticians(id uuid PRIMARY KEY,wa_provider text,whatsapp_connected boolean default false,whatsapp_phone_id text,twilio_wa_sender text,whatsapp_phone text,whatsapp_registered_at timestamptz,whatsapp_pending_phone text,whatsapp_pending_activation boolean,whatsapp_retry_at timestamptz,whatsapp_retry_reason text,whatsapp_retry_attempts int,whatsapp_retry_exhausted boolean);
      CREATE TABLE clients(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),beautician_id uuid,first_name text,phone text,whatsapp_id text,preferred_channel text,status text);
      CREATE TABLE messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),beautician_id uuid,client_id uuid,channel text,direction text,content text,created_at timestamptz,ai_handled boolean,authored_by text,external_message_id text,whatsapp_message_id text,send_status text);
      INSERT INTO beauticians(id) VALUES('${owner}'); INSERT INTO beauticians(id,whatsapp_connected,whatsapp_phone_id) VALUES('${legacy}',true,'999');`);
    for (const file of ['20260916_whatsapp_embedded_signup.sql','20260916_whatsapp_privacy_lifecycle.sql','20261116184431_whatsapp_business_app_onboarding.sql']) await db.exec(await readFile(new URL('../../../supabase/migrations/' + file, import.meta.url), 'utf8'));
    const session = await scalar("SELECT start_whatsapp_app_signup($1,$2,'native')", [owner, 'b'.repeat(64)]);
    const claim = await scalar('SELECT claim_whatsapp_signup($1)', ['b'.repeat(64)]); expect(claim.signup_mode).toBe('business_app');
    const hash = (kind, id) => createHash('sha256').update(`whatsapp:${kind}:${id}`).digest('hex');
    expect(await scalar('SELECT bind_whatsapp_signup_identity($1,$2,$3)', [session, hash('user', '555'), hash('waba', '300')])).toBe(true);
    expect(await scalar("SELECT reserve_whatsapp_phone($1,'400')", [session])).toBe(true);
    expect(await scalar("SELECT finish_whatsapp_signup($1,'400','300','+447700900000','encrypted')", [session])).toBe(true);
    const c = (await db.query('SELECT * FROM whatsapp_connections WHERE beautician_id=$1', [owner])).rows[0]; expect(c.business_app).toBe(true);
    expect(await scalar('SELECT business_app FROM whatsapp_connections WHERE beautician_id=$1', [legacy])).toBe(false);
    const m = { id: 'wamid1', recipient: '447700900001', direction: 'outbound', author: 'human', body: 'I have sorted that for you', at: new Date().toISOString() };
    const ingest = payload => scalar('SELECT import_whatsapp_app_message($1,$2,$3,$4)', [owner, '400', c.connected_at, payload]);
    const saved = await ingest(m); expect(saved).toBeTruthy(); expect(await ingest(m)).toBeNull();
    expect((await db.query('SELECT authored_by,ai_handled FROM messages WHERE id=$1', [saved])).rows[0]).toEqual({ authored_by: 'human', ai_handled: true });
    expect(await ingest({ ...m, id: 'unknown-user', recipient: '' })).toBeNull();
    expect(await scalar('SELECT count(*)::int FROM clients')).toBe(1);
    expect(await scalar('SELECT import_whatsapp_app_message($1,$2,$3,$4)', [legacy, '999', c.connected_at, m])).toBeNull();
    await scalar('SELECT disconnect_embedded_whatsapp($1)', [owner]); expect(await ingest({ ...m, id: 'late' })).toBeNull();
    expect(await scalar('SELECT phone_id FROM whatsapp_connections WHERE beautician_id=$1', [legacy])).toBe('999');
    await db.exec('SET ROLE authenticated'); await expect(db.query('SELECT * FROM whatsapp_app_events')).rejects.toThrow('permission denied');
    await expect(db.query('SELECT import_whatsapp_app_message($1,$2,$3,$4)', [owner, '400', c.connected_at, m])).rejects.toThrow('permission denied');
  } finally { await db.close(); }
}, 30000);
