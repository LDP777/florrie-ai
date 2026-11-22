import { beforeAll, beforeEach, afterAll, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { setCompletionReceiptPaid } from '../../src/lib/offline-receipts.js';
import { moneyTotals, reconcileTransactions, taxReport } from '../../src/lib/money-reporting.js';
import { isSettledPriceRow, supersedeAssumedPlan } from '../../src/lib/money-guards.js';

const owner='00000000-0000-4000-8000-000000000001', other='00000000-0000-4000-8000-000000000002';
const appointment='00000000-0000-4000-8000-000000000003';
let db;
const rows=async()=> (await db.query('select * from transactions order by created_at,id')).rows;
const record=async()=> (await db.query('select record_completion_receipt($1,$2) receipt',[owner,appointment])).rows[0].receipt;
const api={rpc: async (name, params)=> {
  expect(name).toBe('set_completion_receipt_paid');
  try { return {data:(await db.query('select set_completion_receipt_paid($1,$2,$3,$4) receipt',Object.values(params))).rows[0].receipt}; }
  catch(error) { return {error}; }
}};
const toggle=(tx,paid,salon=owner)=>setCompletionReceiptPaid(api,salon,tx.id,{paid,expected_amount_cents:tx.amount_cents});
const enable=()=>db.query('update beauticians set completion_receipts_enabled=true where id=$1',[owner]);
const complete=()=>db.query("update appointments set status='completed' where id=$1",[appointment]);
const insert=async({amount=2400,method=null,type='payment',intent=null,status='completed'}={})=>db.query(`insert into transactions(beautician_id,appointment_id,amount_cents,type,status,payment_method,stripe_payment_intent_id,created_at) values($1,$2,$3,$4,$5,$6,$7,'2026-08-10T10:00Z') returning *`,[owner,appointment,amount,type,status,method,intent]);

beforeAll(async()=>{
  db=new PGlite();
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE beauticians(id uuid primary key,timezone text);
    CREATE TABLE appointments(id uuid primary key,beautician_id uuid,client_id uuid,status text,starts_at timestamptz,ends_at timestamptz,price_cents integer,deposit_cents integer,deposit_paid boolean,payment_type text,discount_cents integer,package_redemption boolean);
    CREATE TABLE appointment_add_ons(appointment_id uuid,price_cents integer);
    CREATE TABLE transactions(id uuid primary key default gen_random_uuid(),beautician_id uuid,appointment_id uuid,client_id uuid,amount_cents integer,type text,status text,payment_method text,stripe_payment_intent_id text,stripe_charge_id text,accounting_synced boolean default false,created_at timestamptz default now(),tax_year text,description text);
    GRANT USAGE ON SCHEMA public TO service_role,authenticated,anon;
    GRANT ALL ON beauticians,appointments,appointment_add_ons,transactions TO service_role;
    INSERT INTO beauticians VALUES('${owner}','Europe/London'),('${other}','Europe/London');`);
  await db.exec(await readFile(new URL('../../../supabase/migrations/20261122144554_completion_receipts.sql',import.meta.url),'utf8'));
});
beforeEach(async()=>{
  await db.exec(`TRUNCATE completion_receipt_events,transactions,appointments,appointment_add_ons;
    UPDATE beauticians SET completion_receipts_enabled=false;
    INSERT INTO appointments(id,beautician_id,status,starts_at,ends_at,price_cents,deposit_cents,deposit_paid,payment_type,discount_cents,package_redemption)
      VALUES('${appointment}','${owner}','confirmed','2026-07-01T14:00Z','2026-07-01T15:00Z',3000,600,true,'deposit',0,false);`);
});
afterAll(()=>db.close());
it('opts in one salon and records only its remainder, dated to the visit in salon time',async()=>{
  await enable(); await complete();
  const [tx]=await rows();
  expect(tx.amount_cents).toBe(2400); expect(tx.payment_method).toBe('completion_record');
  expect(tx.stripe_payment_intent_id).toBeNull(); expect(new Date(tx.created_at).toISOString()).toBe('2026-07-01T14:00:00.000Z');
  expect(moneyTotals({transactions:[tx]}).income_cents).toBe(2400);
  expect(isSettledPriceRow(tx)).toBe(true);
  expect((await db.query('select completion_receipts_enabled from beauticians where id=$1',[other])).rows[0].completion_receipts_enabled).toBe(false);
});
it('leaves a salon without this rule unchanged',async()=>{
  await complete(); await insert();
  const [tx]=await rows(); expect(tx.payment_method).toBeNull();
  expect(moneyTotals({transactions:[tx]}).income_cents).toBe(0);
});
it('converts history once and preserves its original date and amount in the audit',async()=>{
  await complete(); await insert(); await enable(); const tx=await record(); await record();
  expect(await rows()).toHaveLength(1);
  const events=(await db.query('select * from completion_receipt_events')).rows;
  expect(events).toHaveLength(1); expect(events[0].original_transaction.payment_method).toBeNull();
  expect(taxReport({transactions:[tx],year:'2026-27'}).monthlyIncome).toEqual({'2026-07':2400});
});
it('suppresses a replay from older completion workers',async()=>{
  await enable(); await complete(); await insert(); await complete();
  expect(await rows()).toHaveLength(1);
});
it('does not double-count a deposit or an already-paid balance',async()=>{
  await insert({type:'deposit',amount:600,method:'card_online',intent:'pi_deposit'});
  await insert({amount:2400,method:'card_online',intent:'pi_balance'});
  await complete(); await insert(); await enable(); expect(await record()).toBeNull();
  const txs=await rows(); expect(txs).toHaveLength(2); expect(moneyTotals({transactions:txs}).income_cents).toBe(3000);
  expect((await db.query('select action from completion_receipt_events')).rows[0].action).toBe('superseded');
});
it('uses partial receipts, add-ons and discounts when computing the remaining balance',async()=>{
  await db.exec(`insert into appointment_add_ons values('${appointment}',1000); update appointments set discount_cents=500;`);
  await insert({amount:1000,method:'cash'}); await enable(); await complete();
  expect((await rows()).find(t=>t.payment_method==='completion_record').amount_cents).toBe(1900);
});
it.each(['no_show','cancelled','confirmed'])('reverses only bookkeeping when an appointment becomes %s',async status=>{
  await insert({type:'deposit',amount:600,method:'card_online',intent:'pi_keep'});
  await enable(); await complete();
  await db.query('update appointments set status=$1 where id=$2',[status,appointment]);
  const txs=await rows(); expect(txs).toHaveLength(1); expect(txs[0].stripe_payment_intent_id).toBe('pi_keep');
});
it('makes an unpaid exception durable across cron replays and reopening the appointment',async()=>{
  await enable(); await complete(); const [tx]=await rows();
  expect((await toggle(tx,false)).status).toBe(200); expect((await toggle(tx,false)).status).toBe(200);
  expect(moneyTotals({transactions:await rows()}).income_cents).toBe(0);
  expect(reconcileTransactions(await rows())[0].reporting_status).toBe('unpaid');
  expect(isSettledPriceRow((await rows())[0])).toBe(false);
  await insert(); await record(); expect(await rows()).toHaveLength(1);
  expect((await toggle(tx,true)).status).toBe(200);
  expect(moneyTotals({transactions:await rows()}).income_cents).toBe(2400);
  await toggle(tx,false); await db.exec("update appointments set status='confirmed'"); await complete();
  expect(await rows()).toHaveLength(1); expect((await rows())[0].payment_method).toBe('completion_unpaid');
  expect((await db.query('select completion_payment_unpaid from appointments')).rows[0].completion_payment_unpaid).toBe(true);
});
it('rejects edits to card receipts and attempts by another salon',async()=>{
  await enable(); await complete(); const [tx]=await rows();
  expect((await toggle(tx,false,other)).status).toBe(404);
  await db.query("update transactions set payment_method='card_online',stripe_payment_intent_id='pi_actual' where id=$1",[tx.id]);
  expect((await toggle(tx,false)).status).toBe(409);
  expect((await rows())[0].status).toBe('completed');
});
it.each(["price_cents=0,deposit_cents=0",'package_redemption=true',"payment_type='full'","starts_at='2099-01-01T12:00Z'"])('does not invent receipts for %s',async fields=>{
  await db.exec(`update appointments set ${fields}`); await enable(); await complete(); expect(await rows()).toHaveLength(0);
});
it('replaces an automatic or unpaid bookkeeping balance when real money is collected later',()=>{
  for(const method of ['completion_record','completion_unpaid']) {
    expect(supersedeAssumedPlan([{id:'book',type:'payment',payment_method:method,amount_cents:2400}],2400)).toEqual({deleteIds:['book'],reduce:[],supersededCents:2400});
  }
});
it('restricts receipt changes and audit access to the server role',async()=>{
  const grants=(await db.query(`select has_function_privilege('authenticated','set_completion_receipt_paid(uuid,uuid,boolean,integer)','execute') app,
    has_function_privilege('anon','record_completion_receipt(uuid,uuid)','execute') anon,
    has_table_privilege('authenticated','completion_receipt_events','select') audit`)).rows[0];
  expect(grants).toEqual({app:false,anon:false,audit:false});
  await enable(); await db.exec('set role service_role');
  try { await complete(); expect(await rows()).toHaveLength(1); } finally { await db.exec('reset role'); }
});
