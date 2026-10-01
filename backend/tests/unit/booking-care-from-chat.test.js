import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { preparationDb } from '../helpers/preparation-db.js';

const fixture = vi.hoisted(() => ({ db: {}, writes: [], slots: [], confirmations: [], alerts: [], checkout: [], stripeFails: false }));
function builder(table) {
  let action; let payload; let one = false; let limit = Infinity;
  const filters = [];
  const settle = () => {
    let rows = (fixture.db[table] || []).filter(row => filters.every(filter => filter(row)));
    if (action) fixture.writes.push({ table, action, payload });
    if (action === 'update') rows.forEach(row => Object.assign(row, payload));
    if (action === 'delete') fixture.db[table] = (fixture.db[table] || []).filter(row => !rows.includes(row));
    if (action === 'insert') {
      rows = (Array.isArray(payload) ? payload : [payload]).map((row, i) => ({
        id: `${table}-${(fixture.db[table] || []).length + i}`, management_token: 'fictional-manage-token', ...row,
      }));
      (fixture.db[table] ||= []).push(...rows);
    }
    if (action === 'upsert') {
      let saved = (fixture.db[table] || []).find(row => row.beautician_id === payload.beautician_id && row.client_id === payload.client_id);
      if (saved) Object.assign(saved, payload);
      else { saved = { id: `${table}-state`, ...payload }; (fixture.db[table] ||= []).push(saved); }
      rows = [saved];
    }
    rows = rows.slice(0, limit);
    return { data: one ? rows[0] || null : rows, error: null };
  };
  const q = {
    select() { return q; }, insert(value) { action = 'insert'; payload = value; return q; },
    upsert(value) { action = 'upsert'; payload = value; return q; },
    update(value) { action = 'update'; payload = value; return q; }, delete() { action = 'delete'; return q; },
    eq(key, value) { filters.push(row => row[key] === value); return q; },
    neq(key, value) { filters.push(row => row[key] !== value); return q; },
    in(key, values) { filters.push(row => values.includes(row[key])); return q; },
    gte() { return q; }, lte() { return q; }, gt() { return q; }, lt() { return q; },
    is() { return q; }, not() { return q; }, or() { return q; }, order() { return q; },
    limit(value) { limit = value; return q; },
    single() { one = true; return Promise.resolve(settle()); }, maybeSingle() { return q.single(); },
    then(resolve, reject) { return Promise.resolve(settle()).then(resolve, reject); },
  };
  return q;
}
vi.mock('../../src/config.js', () => ({ supabase: { from: builder } }));
vi.mock('stripe', () => ({ default: class {
  constructor() {
    this.customers = { create: async () => ({ id: 'cus_fictional' }) };
    this.checkout = { sessions: { create: async args => {
      fixture.checkout.push(args);
      if (fixture.stripeFails) throw new Error('Fictional payment provider unavailable');
      return { url: 'https://checkout.stripe.test/fictional-session', payment_intent: 'pi_fictional' };
    } } };
  }
} }));
vi.mock('../../src/lib/schema-probe.js', () => ({ hasColumn: async () => true }));
vi.mock('../../src/lib/free-slots.js', () => ({
  nowInSalonWall: () => new Date('2026-10-01T11:00:00Z'),
  getFreeSlots: async (_owner, options) => {
    const start = options.fromWall.getTime();
    const end = start + options.days * 86400000;
    const earliest = start + options.leadHours * 3600000;
    return fixture.slots.filter(slot => Date.parse(slot.iso) >= earliest && Date.parse(slot.iso) < end
      && (!options.acceptSlot || options.acceptSlot(slot)));
  },
}));
vi.mock('../../src/services/notifications.js', () => ({ notifyBookingConfirmed: async id => { fixture.confirmations.push(id); return true; } }));
vi.mock('../../src/services/booking-confirmed-alert.js', () => ({ announceBookingConfirmed: async id => { fixture.alerts.push(id); return { announced: true }; } }));
vi.mock('../../src/lib/logger.js', () => ({ default: { info() {}, warn() {}, error() {} } }));

import { advanceBookingConversation } from '../../src/services/conversational-booking.js';
import { ensureBookingConsultations, readBookingPreparation } from '../../src/lib/booking-preparation.js';
import { assertCareSubmission, consultationBookingContext } from '../../src/lib/consultation-booking-care.js';
import { checkReplyClaims } from '../../src/lib/reply-claims-guard.js';

const NOW = Date.parse('2026-10-01T10:00:00Z');
const owner = { id: 'fictional-salon', first_name: 'Mara', business_name: 'Fictional Salon', timezone: 'Europe/London',
  booking_slug: 'fictional', booking_policy: {}, payment_settings: {}, stripe_account_id: 'acct_fictional', stripe_onboarding_complete: true };
const client = { id: 'fictional-client', beautician_id: owner.id, first_name: 'Client', blocked_at: null, total_visits: 0 };
const treatment = { id: 'brow', beautician_id: owner.id, name: 'Brow Lamination', duration_minutes: 45, price_cents: 3500,
  deposit_cents: 0, requires_patch_test: true, requires_consultation: true, consultation_form_id: 'brow-form' };
const extraTreatment = { ...treatment, id: 'lash', name: 'Lash Tint', duration_minutes: 20, consultation_form_id: 'lash-form' };
const slot = (date, time) => ({ date, time, iso: `${date}T${time}:00.000Z` });
const form = id => ({ id, beautician_id: owner.id, is_active: true, is_default: id === 'brow-form', name: `${id} consultation`, consultation_form_fields: [] });
const signed = { revision: 0, signature_data: 'data:image/png;base64,YQ==', patch_outcome: 'no_reaction' };
const advance = (message = 'Can I book brow lamination on 7 October at 4pm?', options = {}) => advanceBookingConversation({
  beautician: owner, client, message, classification: { intent: 'booking_request', confidence: 1 },
  context: { treatments: fixture.db.treatments, clientUpcoming: [], conversation: [], ...options },
});
const booking = () => ({ ...fixture.db.appointments[0], beauticians: owner });
const careDb = () => preparationDb(fixture.db);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(NOW);
  fixture.db = { beauticians: [{ ...owner }], clients: [{ ...client }], treatments: [{ ...treatment }, { ...extraTreatment }],
    appointments: [], booking_conversations: [], patch_tests: [], consultation_responses: [], ai_actions: [],
    consultation_forms: [form('brow-form'), form('lash-form')] };
  fixture.slots = [slot('2026-10-02', '16:00'), slot('2026-10-07', '16:00')];
  fixture.writes = []; fixture.confirmations = []; fixture.alerts = []; fixture.checkout = []; fixture.stripeFails = false;
});
afterEach(() => vi.useRealTimers());

describe('chat bookings enter the same preparation journey as public bookings', () => {
  it('confirms a no-deposit consultation treatment without falsely completing its form', async () => {
    fixture.db.treatments[0].requires_patch_test = false;
    const result = await advance();
    expect(result?.actionPerformed).toBe(true);
    expect(booking()).toMatchObject({ status: 'confirmed', treatment_id: treatment.id, deposit_cents: 0 });
    expect(result.reply).toContain('/book/fictional/manage/fictional-manage-token');
    expect(result.reply).toMatch(/before your appointment|checklist/i);
    expect(result.reply).not.toMatch(/fill in.*before.*book|consultation.*(?:complete|received|approved)/i);
    const db = careDb(); await ensureBookingConsultations(db, booking());
    const prep = await readBookingPreparation(db, booking());
    expect(prep).toMatchObject({ confirmed: true, patch: { state: 'not_required', can_complete: true } });
    expect(prep.forms).toEqual([expect.objectContaining({ id: 'brow-form', status: 'pending' })]);
    expect(fixture.db.consultation_responses[0].status).toBe('pending');
    expect(() => assertCareSubmission(fixture.db.consultation_responses[0], prep, { ...signed, signature_data: null })).toThrow(/sign/i);
  });

  it('records the treatment as the parent, not a completed patch visit, and keeps the consultation locked', async () => {
    await advance();
    expect(fixture.db.patch_tests).toEqual([expect.objectContaining({
      beautician_id: owner.id, client_id: client.id, parent_appointment_id: booking().id,
      appointment_id: null, covered_treatment_ids: [treatment.id], status: 'pending',
    })]);
    const db = careDb(); await ensureBookingConsultations(db, booking());
    const prep = await readBookingPreparation(db, booking());
    expect(prep.patch).toMatchObject({ state: 'needed', can_complete: false });
    expect(() => assertCareSubmission(fixture.db.consultation_responses[0], prep, signed)).toThrow(/48-hour/i);
    fixture.db.appointments[0].status = 'completed';
    expect((await readBookingPreparation(db, booking())).patch.can_complete).toBe(false);
    expect(fixture.db.patch_tests[0].performed_at).toBeUndefined();
    expect(fixture.db.patch_tests[0].result).not.toBe('pass');
  });

  it('keeps every selected patch-required treatment and consultation form in preparation', async () => {
    await advance('Can I book brow lamination and lash tint on 7 October at 4pm?');
    expect(booking()).toMatchObject({ status: 'confirmed', extra_treatment_ids: ['lash'] });
    expect(fixture.db.patch_tests[0].covered_treatment_ids).toEqual(['brow', 'lash']);
    const db = careDb(); await ensureBookingConsultations(db, booking());
    const prep = await readBookingPreparation(db, booking());
    expect(prep.forms.map(item => item.id).sort()).toEqual(['brow-form', 'lash-form']);
    expect(prep.forms.every(item => item.status === 'pending')).toBe(true);
    expect(prep.patch.can_complete).toBe(false);
  });

  it('allows signing only after genuine application evidence and the full observation period', async () => {
    await advance();
    const db = careDb(); await ensureBookingConsultations(db, booking());
    const response = fixture.db.consultation_responses[0];
    Object.assign(fixture.db.patch_tests[0], { status: 'recorded_by_owner', performed_at: new Date(NOW).toISOString(), test_date: '2026-10-01', result: 'pending' });
    const waiting = await readBookingPreparation(db, booking(), { now: NOW + 48 * 3600000 - 1 });
    expect(waiting.patch.state).toBe('waiting');
    expect(() => assertCareSubmission(response, waiting, signed)).toThrow(/48-hour/i);
    const ready = await readBookingPreparation(db, booking(), { now: NOW + 48 * 3600000 });
    expect(ready.patch).toMatchObject({ state: 'ready', can_complete: true });
    expect(() => assertCareSubmission(response, ready, signed)).not.toThrow();
    expect(fixture.db.patch_tests[0].result).toBe('pending');
    expect(response.status).toBe('pending');
  });

  it('does not substitute an old or another salon’s signed consultation for this booking', async () => {
    fixture.db.consultation_responses.push({ id: 'old-form', form_id: 'brow-form', client_id: client.id, beautician_id: owner.id,
      appointment_id: 'previous-booking', status: 'completed', signature_data: signed.signature_data });
    await advance();
    const db = careDb(); await ensureBookingConsultations(db, booking());
    const prep = await readBookingPreparation(db, booking());
    expect(prep.forms[0].status).toBe('pending');
    fixture.db.patch_tests.push({ id: 'foreign-patch', beautician_id: 'another-salon', client_id: client.id, treatment_id: treatment.id,
      status: 'recorded_by_owner', test_date: '2026-09-28', performed_at: '2026-09-28T10:00:00Z', result: 'pass' });
    expect((await readBookingPreparation(db, booking())).patch.can_complete).toBe(false);
  });

  it('keeps a deposit hold pending, issues no consultation, and makes no confirmed-booking claim', async () => {
    fixture.db.treatments[0].deposit_cents = 1000;
    const result = await advance();
    expect(booking()).toMatchObject({ status: 'pending', deposit_status: 'pending', deposit_cents: 1000 });
    expect(result.reply).toMatch(/held.*deposit/is);
    expect(result.reply).toMatch(/checklist.*confirm|confirm.*checklist/is);
    expect(result.reply).toContain('Once your booking is confirmed');
    expect(result.reply.replace('Once your booking is confirmed', '')).not.toMatch(/your booking is confirmed|you(?:'re| are) booked|got you in|patch test (?:passed|complete)|consultation (?:received|approved)/i);
    expect(checkReplyClaims(result.reply, { allowedTimes: result.allowedTimes, actionPerformed: result.actionPerformed }).ok).toBe(true);
    expect(fixture.checkout).toHaveLength(1);
    expect(fixture.confirmations).toEqual([]); expect(fixture.alerts).toEqual([]);
    const db = careDb(); await ensureBookingConsultations(db, booking());
    expect(fixture.db.consultation_responses).toEqual([]);
    expect((await readBookingPreparation(db, booking())).confirmed).toBe(false);
    await expect(consultationBookingContext(db, { appointment_id: booking().id, beautician_id: owner.id, client_id: client.id,
      form_id: 'brow-form', booking_care: { version: 1 } })).rejects.toMatchObject({ status: 410 });
  });

  it('does not advertise a confirmed booking or checklist if the deposit provider fails', async () => {
    fixture.db.treatments[0].deposit_cents = 1000; fixture.stripeFails = true;
    const result = await advance();
    expect(result.handOver).toBe(true);
    expect(booking().status).toBe('cancelled');
    expect(result.reply).not.toMatch(/confirmed|got you in|checklist|that's you booked/i);
    const db = careDb(); await ensureBookingConsultations(db, booking());
    expect(fixture.db.consultation_responses).toEqual([]);
    expect(fixture.confirmations).toEqual([]);
  });

  it('retains the 48-hour lead-time check before a first-time patch-required booking', async () => {
    const result = await advance('Can I book brow lamination on 2 October at 4pm?');
    expect(result?.handOver).toBe(true);
    expect(fixture.db.appointments).toEqual([]);
    expect(fixture.checkout).toEqual([]);
  });
});
