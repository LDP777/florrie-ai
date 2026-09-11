import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { preparationDb } from '../helpers/preparation-db.js';
const state = vi.hoisted(() => ({ db: null, sms: vi.fn(), push: vi.fn() }));
vi.mock('../../src/config.js', () => ({ supabase: { from: (...args) => state.db.from(...args) } }));
vi.mock('../../src/middleware/auth.js', () => ({ requireAuth: (req,res,next) => next() }));
vi.mock('../../src/services/notifications.js', () => ({ sendSMS: (...args) => state.sms(...args) }));
vi.mock('../../src/services/push-notifications.js', () => ({ pushTeamUpdate: (...args) => state.push(...args) }));
vi.mock('../../src/lib/logger.js', () => ({ default: { info(){},warn(){},error(){},debug(){} } }));
import publicForms, { sendConsultationFormSMS } from '../../src/routes/consultation-forms.js';
import careRoutes from '../../src/routes/consultation-booking-care.js';
import bookingRoutes from '../../src/routes/booking-preparation.js';
import { patchPreparation, salonWallInstant, readBookingPreparation, ensureBookingConsultations } from '../../src/lib/booking-preparation.js';
import { nextPreparationReminder, sendBookingPreparationReminder } from '../../src/services/booking-preparation-reminder.js';
const NOW = Date.parse('2026-09-11T12:00:00Z');
const SIG = 'data:image/png;base64,YQ==';
let booking;
const owner = { id: 'owner', booking_slug: 'salon', timezone: 'Europe/London', patch_test_expiry_months: 6 };
const treatment = { id: 'brow', beautician_id: 'owner', name: 'Brows', requires_patch_test: true, requires_consultation: true, consultation_form_id: 'form' };
async function run(router, method, path, options = {}) {
  const req = { beautician: owner, params: {}, body: {}, query: {}, ...options };
  const out = { status: 200, body: null }; const res = { set(){return res;},status(n){out.status=n;return res;},json(v){out.body=v;return res;} };
  const layer = router.stack.find(l => l.route?.path === path && l.route.methods[method]);
  for (const middleware of layer.route.stack) { let next=false; await middleware.handle(req,res,err => { if(err) throw err; next=true; }); if(!next) break; }
  return out;
}
const patch = overrides => ({ id:'patch', beautician_id:'owner',client_id:'client',treatment_id:'brow',test_date:'2026-09-09',status:'recorded_by_owner',performed_at:'2026-09-09T12:00:00Z',result:'pending',...overrides });
const assess = (patches=[],overrides={}) => patchPreparation({ appointment:booking,treatments:[treatment],patches,now:NOW,...overrides });
async function issued() { await ensureBookingConsultations(state.db, booking); return state.db.tables.consultation_responses[0]; }
const formReq = row => ({ params:{token:row.token},body:{answers:{allergy:'None'},signature_data:SIG,revision:row.booking_care.revision,patch_outcome:'no_reaction'} });
beforeEach(() => {
  vi.useFakeTimers();vi.setSystemTime(NOW);state.sms.mockReset().mockResolvedValue({accepted:true});state.push.mockReset().mockResolvedValue({sent:1});
  booking = {id:'booking',beautician_id:'owner',client_id:'client',treatment_id:'brow',extra_treatment_ids:[],management_token:'manage',status:'confirmed',starts_at:'2026-09-15T12:00:00Z',ends_at:'2026-09-15T13:00:00Z',beauticians:owner};
  state.db = preparationDb({ appointments:[booking],beauticians:[owner],clients:[{id:'client',beautician_id:'owner',first_name:'Client',total_visits:0}],treatments:[treatment],patch_tests:[],consultation_responses:[],ai_actions:[],
    consultation_forms:[{id:'form',beautician_id:'owner',name:'Brow consultation',is_default:true,is_active:true,consultation_form_fields:[{id:'allergy',label:'Any allergies?',type:'text',required:true}]}] });
});
afterEach(() => vi.useRealTimers());
describe('the five preparation stages', () => {
  it('starts with a patch booking action, never a made-up pass', () => { expect(assess().state).toBe('needed');expect(assess().can_complete).toBe(false); });
  it('a pending request attached to the treatment is not a booked or performed patch test', () => {
    const pending = patch({ status: 'pending', performed_at: null, test_date: null, appointment_id: booking.id });
    expect(assess([pending], { visits: [{ ...booking, status: 'completed' }] })).toMatchObject({ state: 'needed', can_complete: false });
    expect(assess([{ ...pending, appointment_id: null, parent_appointment_id: booking.id }]).state).toBe('needed');
  });
  it('keeps returning clients with missing evidence with their tech', () => { expect(assess([], {appointment:{...booking,returning_client:true}}).state).toBe('check_record'); });
  it('a booked appointment does not start the timer', () => {
    const p=patch({status:'pending',performed_at:null,appointment_id:'visit'});
    expect(assess([p],{visits:[{id:'visit',status:'confirmed',starts_at:'2026-09-12T09:00:00Z',ends_at:'2026-09-12T09:10:00Z'}]})).toMatchObject({state:'booked',can_complete:false});
  });
  it('waits for the whole 48 hours, then unlocks at the exact boundary', () => {
    expect(assess([patch()],{now:NOW-1})).toMatchObject({state:'waiting',ready_at:new Date(NOW).toISOString()});
    expect(assess([patch()])).toMatchObject({state:'ready',can_complete:true});
    expect(assess([patch()]).evidence[0].result).toBe('pending');
  });
  it('uses elapsed hours across both clock changes', () => {
    expect(salonWallInstant('2026-03-28T10:00:00Z')).toBe('2026-03-28T10:00:00.000Z');
    expect(salonWallInstant('2026-03-30T10:00:00Z')).toBe('2026-03-30T09:00:00.000Z');
    const autumn=assess([patch({test_date:'2026-10-24',performed_at:'2026-10-24T09:00:00Z'})],{appointment:{...booking,starts_at:'2026-10-28T12:00:00Z'},now:Date.parse('2026-10-26T09:00:00Z')});
    expect(autumn).toMatchObject({state:'ready',ready_at:'2026-10-26T09:00:00.000Z'});
  });
  it('uses a completed patch visit, but never a cancelled one, as application evidence', () => {
    const p=patch({status:'pending',performed_at:null,appointment_id:'visit'});
    expect(assess([p],{visits:[{id:'visit',status:'completed',ends_at:'2026-09-09T13:00:00Z'}]}).state).toBe('ready');
    expect(assess([p],{visits:[{id:'visit',status:'cancelled',ends_at:'2026-09-09T13:00:00Z'}]}).can_complete).toBe(false);
  });
  it('does not invent a time for a date-only historic record', () => {
    const result=assess([patch({performed_at:null})]);
    expect(result).toMatchObject({state:'waiting',ready_at:'2026-09-11T22:59:59.000Z'});
    expect(result.evidence[0].date_only).toBe(true);
  });
  it('prefers the recorded time over a date-only duplicate on the same day', () => {
    expect(assess([patch({id:'old',performed_at:null}),patch()])).toMatchObject({state:'ready',ready_at:new Date(NOW).toISOString()});
  });
  it('checks every extra treatment and expiry on the treatment date', () => {
    expect(assess([patch()],{treatments:[treatment,{...treatment,id:'lash'}]}).can_complete).toBe(false);
    expect(assess([patch({covered_treatment_ids:['lash']})],{treatments:[treatment,{...treatment,id:'lash'}]}).can_complete).toBe(true);
    expect(assess([patch()],{appointment:{...booking,starts_at:'2027-05-01T12:00:00Z'}}).state).toBe('check_record');
  });
  it('keeps reactions visible even after expiry or when a replacement test is booked', () => {
    const bad=patch({result:'reaction',test_date:'2025-01-01',performed_at:'2025-01-01T10:00:00Z'});
    expect(assess([bad]).state).toBe('review');
    expect(assess([bad,patch({id:'new',status:'pending',performed_at:null,appointment_id:'v'})],{visits:[{id:'v',status:'confirmed',starts_at:'2026-09-12T09:00:00Z'}]}).state).toBe('review');
  });
  it('flags a moved treatment that no longer leaves 48 hours after its patch test', () => {
    expect(assess([patch()], { appointment: { ...booking, starts_at: '2026-09-11T12:30:00Z' } })).toMatchObject({ state: 'timing_review', can_complete: false });
    expect(assess([patch({ status: 'pending', performed_at: null, appointment_id: 'visit' })], { visits: [{ id: 'visit', status: 'confirmed', starts_at: '2026-09-14T10:00:00Z', ends_at: '2026-09-14T10:10:00Z' }] }).state).toBe('timing_review');
  });
  it('unlocks consultation-only bookings immediately', () => { expect(assess([],{treatments:[{...treatment,requires_patch_test:false}]})).toMatchObject({state:'not_required',can_complete:true}); });
});
describe('issued forms, tokens and signed records', () => {
  it('creates one response per required form under concurrent confirmations, independent of SMS', async () => {
    await Promise.all([ensureBookingConsultations(state.db,booking),ensureBookingConsultations(state.db,booking)]);
    expect(state.db.tables.consultation_responses).toHaveLength(1);expect(state.sms).not.toHaveBeenCalled();
    expect(Date.parse(state.db.tables.consultation_responses[0].expires_at)).toBe(Date.parse('2026-09-22T12:00:00Z'));
  });
  it('preserves an existing signed form and its questions', async () => {
    const row=await issued();Object.assign(row,{status:'completed',answers:{allergy:'Original'},signature_data:SIG});
    const before=structuredClone(row);await ensureBookingConsultations(state.db,booking);
    expect(row).toEqual(before);expect((await readBookingPreparation(state.db,booking)).forms[0].status).toBe('received');
  });
  it('does not issue for unpaid bookings', async () => {booking.status='pending';await ensureBookingConsultations(state.db,booking);expect(state.db.tables.consultation_responses).toHaveLength(0);});
  it('keeps issued forms available when an explicit text send fails', async () => {
    state.sms.mockResolvedValue(null);
    await expect(sendConsultationFormSMS({beauticianId:'owner',clientId:'client',appointmentId:'booking',clientPhone:'07700900123',clientFirstName:'Client',beauticianName:'Salon'})).rejects.toThrow();
    expect(state.db.tables.consultation_responses).toHaveLength(1);
  });
  it('renews expired links only through the booking’s own valid management token', async () => {
    const row=await issued();const old=row.token;row.expires_at='2020-01-01';row.status='expired';
    expect((await run(bookingRoutes,'post','/consultations/:formId/start',{params:{slug:'wrong',token:'manage',formId:'form'}})).status).toBe(404);
    const result=await run(bookingRoutes,'post','/consultations/:formId/start',{params:{slug:'salon',token:'manage',formId:'form'}});
    expect(result.status).toBe(200);expect(result.body.token).not.toBe(old);expect(row.status).toBe('pending');
  });
  it('isolates unreadable preparation from booking data and rejects unassigned forms', async () => {
    state.db.fail='patch_tests';expect((await run(bookingRoutes,'get','/preparation',{params:{slug:'salon',token:'manage'}})).status).toBe(503);
    expect(booking.status).toBe('confirmed');state.db.fail=null;
    expect((await run(bookingRoutes,'post','/consultations/:formId/start',{params:{slug:'salon',token:'manage',formId:'foreign-form'}})).status).toBe(404);
  });
});
describe('drafts, outcomes, signatures and owner review', () => {
  it('loads saved answers, but never presents the waiting period as finished', async () => {
    const row=await issued();row.answers={allergy:'Saved'};
    const result=await run(publicForms,'get','/public/:token',{params:{token:row.token}});
    expect(result.body.draft.answers).toEqual(row.answers);expect(result.body.preparation.can_complete).toBe(false);
    expect(result.body.form.fields.some(f=>f.type==='signature'&&f.required)).toBe(true);
  });
  it('rejects final submission before 48 hours, without changing answers or booking', async () => {
    state.db.tables.patch_tests=[patch({performed_at:'2026-09-09T12:00:01Z'})];const row=await issued();
    expect((await run(publicForms,'post','/public/:token/submit',formReq(row))).status).toBe(409);
    expect(row.status).toBe('pending');expect(booking.status).toBe('confirmed');
  });
  it('requires an explicit outcome and a signature, then stores the client’s outcome separately from answers', async () => {
    state.db.tables.patch_tests=[patch()];const row=await issued();
    const missing=formReq(row);delete missing.body.patch_outcome;
    expect((await run(publicForms,'post','/public/:token/submit',missing)).status).toBe(400);
    const unsigned=formReq(row);delete unsigned.body.signature_data;
    expect((await run(publicForms,'post','/public/:token/submit',unsigned)).status).toBe(400);
    expect((await run(publicForms,'post','/public/:token/submit',formReq(row))).status).toBe(200);
    expect(row).toMatchObject({status:'completed',answers:{allergy:'None'},signature_data:SIG,booking_care:{patch_outcome:'no_reaction',revision:1}});
    expect(row.booking_care.patch_evidence.state).toBe('ready');
  });
  it('can report a reaction while waiting, with a durable flag for Ellie even if push fails', async () => {
    const row=await issued();state.push.mockRejectedValue(new Error('provider unavailable'));
    const result=await run(careRoutes,'post','/public/:token/draft',{params:{token:row.token},body:{answers:{allergy:'Latex'},revision:0,patch_outcome:'reaction'}});
    expect(result.status).toBe(200);expect(row.status).toBe('pending');expect(row.booking_care.review_required).toBe(true);
    expect((await run(careRoutes,'get','/reviews/pending')).body.reviews).toHaveLength(1);
    expect((await run(careRoutes,'get','/reviews/pending',{beautician:{id:'other'}})).body.reviews).toHaveLength(0);
  });
  it('flags uncertain outcomes at final submission and preserves the original patch record', async () => {
    state.db.tables.patch_tests=[patch()];const before=structuredClone(state.db.tables.patch_tests);const row=await issued();const request=formReq(row);request.body.patch_outcome='unsure';
    expect((await run(publicForms,'post','/public/:token/submit',request)).body.review_required).toBe(true);
    expect(state.db.tables.patch_tests).toEqual(before);
    const detail=await run(publicForms,'get','/responses/:id',{params:{id:row.id}});
    expect(detail.body.response.worth_knowing).toContain('Client is unsure about their patch-test outcome.');
  });
  it('rejects stale submissions and racing draft writes', async () => {
    state.db.tables.patch_tests=[patch()];const row=await issued();const req=formReq(row);row.booking_care.revision=2;
    expect((await run(publicForms,'post','/public/:token/submit',req)).status).toBe(409);
    state.db.beforeUpdate=()=>{row.status='completed';row.answers={allergy:'Signed elsewhere'};};
    expect((await run(careRoutes,'post','/public/:token/draft',{params:{token:row.token},body:{answers:{allergy:'Old'},revision:2}})).status).toBe(409);
    expect(row.answers.allergy).toBe('Signed elsewhere');
  });
  it('revokes pending forms for cancelled bookings and removed treatments', async () => {
    const row=await issued();booking.status='cancelled';
    expect((await run(publicForms,'get','/public/:token',{params:{token:row.token}})).status).toBe(410);
    booking.status='confirmed';booking.treatment_id='different';state.db.tables.treatments.push({...treatment,id:'different',requires_patch_test:false,requires_consultation:false,consultation_form_id:null});
    expect((await run(careRoutes,'post','/public/:token/draft',{params:{token:row.token},body:{answers:{},revision:0}})).status).toBe(409);
  });
  it('marks the version Ellie actually read as reviewed and keeps signed evidence intact', async () => {
    const row=await issued();row.status='completed';row.signature_data=SIG;row.booking_care.review_required=true;
    expect((await run(careRoutes,'post','/responses/:id/review',{params:{id:row.id},body:{revision:0},beautician:{id:'other'}})).status).toBe(404);
    expect((await run(careRoutes,'post','/responses/:id/review',{params:{id:row.id},body:{revision:0}})).status).toBe(200);
    expect(row.signature_data).toBe(SIG);expect(row.status).toBe('completed');expect((await run(careRoutes,'get','/reviews/pending')).body.reviews).toHaveLength(0);
  });
});
describe('only actionable reminders', () => {
  it('never asks for final consultation while booked/waiting/under review', () => {
    for (const state of ['booked','waiting','review','check_record']) expect(nextPreparationReminder({confirmed:true,patch:{state,can_complete:false},forms:[{status:'pending',available:true}]},booking,{patchReminders:true})).toBeNull();
  });
  it('deduplicates successful reminders, retries a provider failure, and keeps form issuance independent', async () => {
    const row=await issued();state.db.tables.patch_tests=[patch()];const deliver=vi.fn().mockResolvedValue(false);
    const args={db:state.db,appointment:booking,deliver,patchReminders:true};
    expect(await sendBookingPreparationReminder(args)).toBe(false);expect(row.status).toBe('pending');
    deliver.mockResolvedValue(true);
    await Promise.all([sendBookingPreparationReminder(args),sendBookingPreparationReminder(args)]);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(await sendBookingPreparationReminder(args)).toBe(false);expect(deliver).toHaveBeenCalledTimes(2);
  });
  it('does not tell clients to book an impossible short-notice patch test', async () => {
    const prep=await readBookingPreparation(state.db,booking);const soon={...booking,starts_at:'2026-09-12T12:00:00Z'};
    expect(nextPreparationReminder(prep,soon,{patchReminders:true}).body).toContain('contact your tech');
    expect(nextPreparationReminder(prep,soon,{patchReminders:false})).toBeNull();
  });
});
