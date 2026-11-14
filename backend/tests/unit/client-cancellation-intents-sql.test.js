import { beforeAll, afterAll, beforeEach, afterEach, describe, it, expect } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';

const OWNER='11111111-1111-4111-8111-111111111111', APPT='22222222-2222-4222-8222-222222222222', TOKEN='33333333-3333-4333-8333-333333333333', ALERT='44444444-4444-4444-8444-444444444444', FEE='55555555-5555-4555-8555-555555555555';
const migration=readFileSync(new URL('../../../supabase/migrations/20261114175653_client_cancellation_intents.sql',import.meta.url),'utf8');
let db;
beforeAll(async()=>{
  db=new PGlite();
  await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
    CREATE TABLE appointments(id uuid PRIMARY KEY,beautician_id uuid,client_id uuid,management_token uuid,starts_at timestamptz,price_cents integer,policy_snapshot jsonb,status text,cancelled_at timestamptz,late_cancel_charged boolean);
    CREATE TABLE ai_actions(id uuid PRIMARY KEY,beautician_id uuid,client_id uuid,appointment_id uuid,action_type text,digital_employee text CHECK(digital_employee IN ('front_desk','money')),outcome text,summary text,autonomous boolean,notification_sent boolean,details jsonb);`);
  await db.exec(migration);await db.exec(migration);
},20000);
afterAll(()=>db.close());
beforeEach(async()=>{
  await db.exec('BEGIN');
  await db.query("INSERT INTO appointments(id,beautician_id,management_token,starts_at,price_cents,policy_snapshot,status) VALUES($1,$2,$3,'2050-12-20T12:00:00Z',3500,'{\"late_cancel_charge_percent\":100}','confirmed')",[APPT,OWNER,TOKEN]);
});
afterEach(()=>db.exec('ROLLBACK'));
const intents=()=>[{id:ALERT,beautician_id:OWNER,appointment_id:APPT,action_type:'booking_cancelled',digital_employee:'front_desk',summary:'Client cancelled',details:{delivery_version:1}},
  {id:FEE,beautician_id:OWNER,appointment_id:APPT,action_type:'client_cancellation_fee',digital_employee:'money',summary:'Payment pending',details:{version:1,fee_cents:2800}}];
const cancel=(overrides={})=>{
  const a={appointment:APPT,owner:OWNER,token:TOKEN,starts:'2050-12-20T12:00:00Z',price:3500,policy:{late_cancel_charge_percent:100},late:true,intents:intents(),...overrides};
  return db.query('SELECT cancel_client_booking($1,$2,$3,$4,$5,$6::jsonb,$7,$8::jsonb) result',[a.appointment,a.owner,a.token,a.starts,a.price,JSON.stringify(a.policy),a.late,JSON.stringify(a.intents)]);
};
async function rejected(call){await db.exec('SAVEPOINT rejection');await expect(call()).rejects.toThrow();await db.exec('ROLLBACK TO SAVEPOINT rejection');}
const status=async()=> (await db.query('SELECT status,cancelled_at FROM appointments')).rows[0];
describe('Cancellation and its authorised work commit together',()=>{
  it('stamps the exact winning cancellation onto notification and payment intents',async()=>{
    const r=(await cancel()).rows[0].result;
    expect(r.already_cancelled).toBe(false);expect((await status()).status).toBe('cancelled');
    const rows=(await db.query('SELECT details FROM ai_actions')).rows;
    expect(rows).toHaveLength(2);
    expect(rows.every(row=>row.details.source==='client_manage'&&Date.parse(row.details.cancelled_at)===Date.parse(r.cancelled_at))).toBe(true);
  });
  it('rolls cancellation back if either durable intent fails',async()=>{
    const rows=intents();rows[1].digital_employee='invalid';
    await rejected(()=>cancel({intents:rows}));
    expect((await status()).status).toBe('confirmed');expect((await db.query('SELECT * FROM ai_actions')).rows).toEqual([]);
  });
  it('does not attach a late client fee to an earlier owner cancellation',async()=>{
    await db.exec("UPDATE appointments SET status='cancelled',cancelled_at=now()");
    expect((await cancel()).rows[0].result.already_cancelled).toBe(true);
    expect((await db.query('SELECT * FROM ai_actions')).rows).toEqual([]);
  });
  it('repeated client cancellation does not queue or charge twice',async()=>{
    await cancel();expect((await cancel()).rows[0].result.already_cancelled).toBe(true);
    expect((await db.query('SELECT * FROM ai_actions')).rows).toHaveLength(2);
  });
  it('rejects stale appointment time, price, policy and foreign owner/token',async()=>{
    for(const patch of [{starts:'2050-12-21T12:00:00Z'},{price:4500},{policy:{}},{owner:TOKEN},{token:OWNER}])await rejected(()=>cancel(patch));
    expect((await status()).status).toBe('confirmed');expect((await db.query('SELECT * FROM ai_actions')).rows).toEqual([]);
  });
  it('cannot bind an intent to somebody else or accept missing delivery work',async()=>{
    const rows=intents();rows[1].appointment_id=TOKEN;
    await rejected(()=>cancel({intents:rows}));await rejected(()=>cancel({intents:[]}));
    expect((await status()).status).toBe('confirmed');
  });
  it('is executable only by the backend service role',async()=>{
    for(const role of ['anon','authenticated'])expect((await db.query(`SELECT has_function_privilege('${role}','cancel_client_booking(uuid,uuid,uuid,timestamptz,integer,jsonb,boolean,jsonb)','EXECUTE') allowed`)).rows[0].allowed).toBe(false);
    expect((await db.query("SELECT has_function_privilege('service_role','cancel_client_booking(uuid,uuid,uuid,timestamptz,integer,jsonb,boolean,jsonb)','EXECUTE') allowed")).rows[0].allowed).toBe(true);
  });
});
