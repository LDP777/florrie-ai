import { beforeAll, beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { reminderDb } from '../helpers/reminder-db.js';

let pg, db;
const prep = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../../src/lib/booking-preparation.js', async original => ({ ...await original(), readBookingPreparation: prep.read }));
vi.mock('../../src/config.js', () => ({ supabase: { from: (...args) => db.from(...args), rpc: (...args) => db.rpc(...args) } }));
vi.mock('../../src/lib/logger.js', () => ({ default: { info() {}, warn() {}, error() {} } }));
const { sendTrackedReminder, saveWhatsAppReceipts, processReminderSmsFallbacks } = await import('../../src/services/reminder-sms-fallback.js');
const OWNER = '11111111-1111-4111-8111-111111111111';
const CLIENT = '22222222-2222-4222-8222-222222222222';
const APPT = '33333333-3333-4333-8333-333333333333';
const PHONE = '+447700900000';
const migration = readFileSync(new URL('../../../supabase/migrations/20261124190335_reminder_sms_fallback.sql', import.meta.url), 'utf8');
let appointment, client, sms;
const opts = extras => ({ appointment, client, body: 'Appointment on Friday. Manage it: https://florrie.ai/book/demo/manage/test',
  messageType: 'appointment_reminder', sendWhatsApp: async () => ({ messages: [{ id: 'wamid.1' }] }), sendSms: sms, ...extras });
const received = (status, id='wamid.1') => saveWhatsAppReceipts([{ id, status, timestamp: String(Math.floor(Date.now()/1000)), errors: [{ code: 131026 }] }]);
const deliveries = async () => (await pg.query('SELECT * FROM appointment_reminder_deliveries')).rows;
const activities = async () => (await pg.query('SELECT * FROM ai_actions')).rows;

beforeAll(async () => {
  pg = new PGlite(); db = reminderDb(pg);
  await pg.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
    CREATE TABLE beauticians(id uuid PRIMARY KEY,timezone text,patch_test_auto_remind boolean,client_reminder_prefs jsonb);
    CREATE TABLE clients(id uuid PRIMARY KEY,beautician_id uuid,phone text);
    CREATE TABLE appointments(id uuid PRIMARY KEY,beautician_id uuid,client_id uuid,starts_at timestamptz,status text);
    CREATE TABLE ai_actions(id uuid PRIMARY KEY,beautician_id uuid,client_id uuid,appointment_id uuid,
      action_type text,digital_employee text,outcome text CHECK(outcome IN ('success','pending','failed','escalated')),summary text,details jsonb);
    GRANT SELECT ON appointments TO service_role;`);
  await pg.exec(migration);
  await pg.exec(migration);
}, 30000);
afterAll(async () => { await pg.close(); });
beforeEach(async () => {
  await pg.exec('TRUNCATE beauticians, clients, appointments, ai_actions, appointment_reminder_deliveries, whatsapp_delivery_receipts CASCADE');
  const starts = new Date(Date.now() + 24*3600000).toISOString();
  await pg.query('INSERT INTO beauticians VALUES($1,$2,true,$3)', [OWNER,'Europe/London',{paused:true}]);
  await pg.query('INSERT INTO clients VALUES($1,$2,$3)', [CLIENT,OWNER,PHONE]);
  await pg.query('INSERT INTO appointments VALUES($1,$2,$3,$4,$5)', [APPT,OWNER,CLIENT,starts,'confirmed']);
  appointment = {id:APPT,beautician_id:OWNER,client_id:CLIENT,starts_at:starts};
  client = {id:CLIENT,phone:PHONE}; sms = vi.fn(async () => ({ id:'sms.1' }));
  prep.read.mockResolvedValue({ patch: {required:true,can_complete:false,state:'needed'}, forms:[{status:'pending',available:true}] });
});

describe('WhatsApp reminder to SMS', () => {
  it('falls back immediately on WhatsApp rejection, once, with the full booking link', async () => {
    const result = await sendTrackedReminder(opts({sendWhatsApp: async () => null}));
    expect(result.channel).toBe('sms'); expect(sms).toHaveBeenCalledTimes(1);
    expect(sms.mock.calls[0][0]).toMatchObject({to:PHONE,clientId:CLIENT,singleAttempt:true,messageType:'appointment_reminder'});
    expect(sms.mock.calls[0][0].body).toContain('/manage/test');
    await sendTrackedReminder(opts()); await processReminderSmsFallbacks(sms);
    expect(sms).toHaveBeenCalledTimes(1); expect((await deliveries())[0].state).toBe('sms_sent');
  });
  it('falls back on a later failed receipt despite paused AI, with concurrent workers and repeat receipts', async () => {
    await sendTrackedReminder(opts()); expect(sms).not.toHaveBeenCalled();
    await received('failed');
    await Promise.all([processReminderSmsFallbacks(sms,['wamid.1']),processReminderSmsFallbacks(sms)]);
    await received('failed'); await processReminderSmsFallbacks(sms);
    expect(sms).toHaveBeenCalledTimes(1); expect((await activities())).toHaveLength(1);
    expect((await activities())[0].summary).toContain('Sent it by text instead');
  });
  it('saves a failed receipt that beats the WhatsApp POST response', async () => {
    const result = await sendTrackedReminder(opts({sendWhatsApp: async () => {await received('failed');return {messages:[{id:'wamid.1'}]};}}));
    expect(sms).toHaveBeenCalledTimes(1); expect(result.channel).toBe('sms');
  });
  it.each(['sent','delivered','read'])('does not send SMS for %s or an unread message', async status => {
    await sendTrackedReminder(opts()); await received(status); await processReminderSmsFallbacks(sms);
    expect(sms).not.toHaveBeenCalled();
  });
  it('does not act on historical/unrelated failures', async () => {
    await received('failed','historical.message'); await processReminderSmsFallbacks(sms);
    expect(sms).not.toHaveBeenCalled(); expect(await deliveries()).toHaveLength(0);
  });
  it.each(['delivered','read'])('positive %s evidence wins over delayed failures in either order', async status => {
    await sendTrackedReminder(opts()); await received('failed'); await received(status); await received('failed');
    await processReminderSmsFallbacks(sms); expect(sms).not.toHaveBeenCalled();
    expect((await deliveries())[0].state).toBe('whatsapp_delivered');
  });
  it.each([
    ['cancelled', "UPDATE appointments SET status='cancelled'"],
    ['moved', "UPDATE appointments SET starts_at=starts_at+interval '1 day'"],
    ['phone changed', "UPDATE clients SET phone='+447700900009'"],
    ['email only', "UPDATE beauticians SET client_reminder_prefs='{\"channel\":\"email\"}'::jsonb"],
    ['wrong salon', "UPDATE clients SET beautician_id='44444444-4444-4444-8444-444444444444'"],
    ['expired', "UPDATE appointment_reminder_deliveries SET expires_at=now()-interval '1 minute'"],
  ])('suppresses a %s reminder before the fallback', async (_, change) => {
    await sendTrackedReminder(opts()); await received('failed'); await pg.exec(change);
    await processReminderSmsFallbacks(sms); expect(sms).not.toHaveBeenCalled();
    expect((await deliveries())[0].state).toBe('suppressed');
  });
  it('honours the patch reminder switch if Ellie changes it before fallback', async () => {
    await sendTrackedReminder(opts({messageType:'patch_test'})); await received('failed');
    await pg.exec('UPDATE beauticians SET patch_test_auto_remind=false');
    await processReminderSmsFallbacks(sms); expect(sms).not.toHaveBeenCalled();
  });
  it.each(['patch_test','consultation_form'])('keeps %s running with AI paused and stops once preparation is completed', async messageType => {
    await sendTrackedReminder(opts({messageType})); expect((await deliveries())[0].state).toBe('awaiting_whatsapp');
    await received('failed');
    prep.read.mockResolvedValue({patch:{required:true,can_complete:true,state:'ready'},forms:[{status:'received',available:true}]});
    await processReminderSmsFallbacks(sms); expect(sms).not.toHaveBeenCalled();
    expect((await deliveries())[0].state).toBe('suppressed');
  });
  it.each(['patch_test','consultation_form'])('uses SMS for still-needed %s with AI paused', async messageType => {
    await sendTrackedReminder(opts({messageType})); await received('failed');
    await processReminderSmsFallbacks(sms); expect(sms).toHaveBeenCalledTimes(1);
  });
  it('records uncertain SMS without retrying, even after a restart', async () => {
    sms.mockRejectedValue(Object.assign(new Error('timeout'),{deliveryUnknown:true}));
    await sendTrackedReminder(opts({sendWhatsApp: async () => null}));
    await processReminderSmsFallbacks(sms); await processReminderSmsFallbacks(sms);
    expect(sms).toHaveBeenCalledTimes(1); expect((await deliveries())[0].state).toBe('sms_unknown');
    expect((await activities())[0].summary).toContain('not confirmed');
  });
  it('does not blindly fall back after an ambiguous WhatsApp timeout', async () => {
    await sendTrackedReminder(opts({sendWhatsApp:async()=>{throw Object.assign(new Error('timeout'),{deliveryUnknown:true});}}));
    await processReminderSmsFallbacks(sms); expect(sms).not.toHaveBeenCalled();
    expect((await activities())[0].outcome).toBe('failed');
  });
  it('records refused SMS as failed, never as delivered', async () => {
    sms.mockResolvedValue(null); await sendTrackedReminder(opts({sendWhatsApp:async()=>null}));
    expect((await activities())[0].outcome).toBe('failed'); expect((await deliveries())[0].state).toBe('sms_failed');
  });
  it('does not replay a send interrupted after its claim', async () => {
    await sendTrackedReminder(opts()); await received('failed');
    await db.rpc('claim_appointment_reminder_sms',{p_id:(await deliveries())[0].id});
    await pg.exec("UPDATE appointment_reminder_deliveries SET updated_at=now()-interval '10 minutes'");
    await processReminderSmsFallbacks(sms); expect(sms).not.toHaveBeenCalled();
    expect((await deliveries())[0].state).toBe('sms_unknown');
  });
  it('allows no browser access to delivery data or claims', async () => {
    const {rows} = await pg.query(`SELECT
      has_table_privilege('anon','appointment_reminder_deliveries','SELECT') AS anon_read,
      has_table_privilege('authenticated','whatsapp_delivery_receipts','INSERT') AS client_write,
      has_function_privilege('authenticated','claim_appointment_reminder_sms(uuid)','EXECUTE') AS client_claim,
      has_function_privilege('service_role','claim_appointment_reminder_sms(uuid)','EXECUTE') AS worker_claim`);
    expect(rows[0]).toEqual({anon_read:false,client_write:false,client_claim:false,worker_claim:true});
  });
});
