import { beforeAll, beforeEach, afterAll, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { recordOfflineReceipt } from '../../src/lib/offline-receipts.js';
import { moneyTotals } from '../../src/lib/money-reporting.js';

const owner = '00000000-0000-4000-8000-000000000001', other = '00000000-0000-4000-8000-000000000002';
const appointment = '00000000-0000-4000-8000-000000000003', transaction = '00000000-0000-4000-8000-000000000004';
const payload = { payment_method: 'cash', received_on: '2026-08-02', expected_amount_cents: 2400 };
let db;
const api = { rpc: async (name, params) => {
  expect(name).toBe('confirm_offline_receipt');
  try { return { data: (await db.query('select confirm_offline_receipt($1,$2,$3,$4,$5) receipt', Object.values(params))).rows[0].receipt }; }
  catch (error) { return { error }; }
} };
const save = (body = payload, salon = owner) => recordOfflineReceipt(api, salon, transaction, body);
beforeAll(async () => {
  db = new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE beauticians(id uuid primary key, timezone text);
    CREATE TABLE appointments(id uuid primary key, beautician_id uuid, status text, price_cents integer, deposit_cents integer, deposit_paid boolean, payment_type text);
    CREATE TABLE transactions(id uuid primary key, beautician_id uuid references beauticians(id), appointment_id uuid references appointments(id), amount_cents integer, type text, status text, payment_method text, stripe_payment_intent_id text, stripe_charge_id text, accounting_synced boolean default false, created_at timestamptz, tax_year text);
    GRANT USAGE ON SCHEMA public TO service_role,authenticated,anon;
    GRANT ALL ON beauticians,appointments,transactions TO service_role;
    INSERT INTO beauticians VALUES ('${owner}','Europe/London'),('${other}','Europe/London');`);
  await db.exec(await readFile(new URL('../../../supabase/migrations/20261118210924_money_offline_receipts.sql', import.meta.url), 'utf8'));
});
beforeEach(async () => {
  await db.exec(`TRUNCATE money_receipt_confirmations,transactions,appointments CASCADE;
    INSERT INTO appointments VALUES ('${appointment}','${owner}','completed',3000,600,true,'deposit');
    INSERT INTO transactions(id,beautician_id,appointment_id,amount_cents,type,status,created_at,tax_year) VALUES('${transaction}','${owner}','${appointment}',2400,'payment','completed','2026-08-01T14:00:00Z','2026-27');`);
});
afterAll(async () => { await db?.close(); });
it('records the existing remainder once, using the owner-selected receipt date and preserving original evidence', async () => {
  const before = (await db.query('select * from transactions')).rows;
  expect(moneyTotals({ transactions: before }).income_cents).toBe(0);
  const result = await save();
  expect(result.status).toBe(200); expect(result.transaction.payment_method).toBe('cash');
  expect(result.transaction.created_at).toBe('2026-08-02T11:00:00+00:00');
  expect(moneyTotals({ transactions: [result.transaction] }).income_cents).toBe(2400);
  const evidence = (await db.query('select * from money_receipt_confirmations')).rows;
  expect(evidence).toHaveLength(1); expect(evidence[0].original_transaction.payment_method).toBeNull();
  expect((await db.query('select * from transactions')).rows).toHaveLength(1);
});
it('recovers a lost response without writing a second receipt', async () => {
  expect((await save()).status).toBe(200); expect((await save()).status).toBe(200);
  expect((await db.query('select * from money_receipt_confirmations')).rows).toHaveLength(1);
  expect((await save({ ...payload, payment_method: 'bank_transfer' })).status).toBe(409);
});
it('denies another salon, even with the transaction ID', async () => {
  expect((await save(payload, other)).status).toBe(404);
  expect((await db.query('select payment_method from transactions')).rows[0].payment_method).toBeNull();
});
it.each(['bank_transfer','card_terminal'])('records the chosen offline method %s', async payment_method => {
  expect((await save({ ...payload, payment_method })).transaction.payment_method).toBe(payment_method);
});
it.each([
  { payment_method: 'card_online' }, { received_on: '2026-02-30' }, { received_on: '2099-01-01' },
  { expected_amount_cents: -1 }, { beautician_id: other },
])('rejects invalid, future or injected fields %j', async fields => { expect((await save({ ...payload, ...fields })).status).toBe(400); });
it.each([
  "update transactions set amount_cents=2500", "update appointments set price_cents=4000", "update appointments set status='cancelled'",
  "update appointments set payment_type='full'", "update transactions set accounting_synced=true", "update transactions set status='pending'",
  "update transactions set stripe_payment_intent_id='pi_recorded'", "update transactions set payment_method='bank_transfer'",
])('refuses changed or already-settled records: %s', async change => { await db.exec(change); expect((await save()).status).toBe(409); });
it.each(['payment','full_payment','payment_link','refund'])('refuses conflicting %s records', async type => {
  await db.query("insert into transactions(id,beautician_id,appointment_id,amount_cents,type,status,payment_method,created_at) values('00000000-0000-4000-8000-000000000005',$1,$2,2400,$3,'completed','card_online',now())", [owner,appointment,type]);
  expect((await save()).status).toBe(409);
});
it('dates an earlier receipt into its actual tax year', async () => {
  const r = await save({ ...payload, received_on: '2026-04-05' });
  expect(r.status).toBe(200); expect(r.transaction.tax_year).toBe('2025-26');
});
it('requires the server role, including when authenticated users guess the RPC name', async () => {
  const grants = (await db.query(`select has_function_privilege('authenticated','confirm_offline_receipt(uuid,uuid,text,date,integer)','execute') app,
    has_function_privilege('anon','confirm_offline_receipt(uuid,uuid,text,date,integer)','execute') anon,
    has_function_privilege('service_role','confirm_offline_receipt(uuid,uuid,text,date,integer)','execute') service`)).rows[0];
  expect(grants).toEqual({ app: false, anon: false, service: true });
  await db.exec('SET ROLE service_role');
  try { expect((await save()).status).toBe(200); } finally { await db.exec('RESET ROLE'); }
});
it('does not claim a save when the RPC returns an error or no matching owner row', async () => {
  expect((await recordOfflineReceipt({ rpc: async () => ({ error: { code: 'XX000' } }) }, owner, transaction, payload)).status).toBe(503);
  expect((await recordOfflineReceipt({ rpc: async () => ({ data: { id:transaction, beautician_id:other } }) }, owner, transaction, payload)).status).toBe(503);
});
