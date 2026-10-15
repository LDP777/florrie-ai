import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { emptyTeamStages } from '../../src/lib/content-team.js';
const sql = readFileSync(new URL('../../../supabase/migrations/20261015_content_team_runs.sql', import.meta.url), 'utf8');
const owner = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const request = '33333333-3333-4333-8333-333333333333', next = '44444444-4444-4444-8444-444444444444';
let db;
beforeAll(async () => {
  db = new PGlite();
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; CREATE TABLE beauticians(id uuid PRIMARY KEY);');
  await db.exec(sql); await db.exec(sql);
}, 20000);
afterAll(() => db.close());
beforeEach(async () => { await db.exec('BEGIN'); await db.query('INSERT INTO beauticians(id) VALUES($1),($2)', [owner, other]); });
afterEach(() => db.exec('ROLLBACK'));
const insert = (o = owner, r = request) => db.query('INSERT INTO content_team_runs(beautician_id,request_id,brief,stages) VALUES($1,$2,$3,$4) RETURNING *', [o, r, { goal: 'explain', focus: '', treatment_id: null }, emptyTeamStages()]);
describe('Actual PostgreSQL Content Team persistence', () => {
  it('keeps runs private and service-only', async () => {
    const result = await db.query("SELECT relrowsecurity,has_table_privilege('anon',oid,'SELECT,INSERT,UPDATE,DELETE') anon,has_table_privilege('authenticated',oid,'SELECT,INSERT,UPDATE,DELETE') authenticated,has_table_privilege('service_role',oid,'SELECT,INSERT,UPDATE,DELETE') service FROM pg_class WHERE relname='content_team_runs'");
    expect(result.rows[0]).toEqual({ relrowsecurity: true, anon: false, authenticated: false, service: true });
  });
  it('enforces one active run per salon but allows another salon', async () => {
    await insert(); await insert(other);
    await expect(insert(owner, next)).rejects.toThrow(/duplicate key/);
  });
  it('keeps request IDs unique after completion, while a fresh request can start', async () => {
    await insert(); await db.query("UPDATE content_team_runs SET status='ready' WHERE beautician_id=$1", [owner]);
    await insert(owner, next);
    await expect(insert(owner, request)).rejects.toThrow(/duplicate key/);
  });
  it('allows only one worker to claim the observed queued version and isolates owner', async () => {
    const row = (await insert()).rows[0];
    const claim = o => db.query("UPDATE content_team_runs SET status='running',lease_token=$3 WHERE id=$1 AND beautician_id=$2 AND status='queued' RETURNING id", [row.id, o, next]);
    expect((await claim(other)).rows).toHaveLength(0); expect((await claim(owner)).rows).toHaveLength(1); expect((await claim(owner)).rows).toHaveLength(0);
  });
  it('does not allow malformed states or missing stage persistence', async () => {
    await expect(db.query("INSERT INTO content_team_runs(beautician_id,request_id,brief,stages,status) VALUES($1,$2,'{}','[]','published')", [owner, request])).rejects.toThrow(/check constraint/);
  });
  it('removes its work when that salon is deleted, without touching another salon', async () => {
    await insert(); await insert(other);
    await db.query('DELETE FROM beauticians WHERE id=$1', [owner]);
    const rows = (await db.query('SELECT beautician_id FROM content_team_runs')).rows;
    expect(rows).toEqual([{ beautician_id: other }]);
  });
});
