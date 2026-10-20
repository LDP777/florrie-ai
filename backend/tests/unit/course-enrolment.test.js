/**
 * Enrolling on a course, the parts that went wrong the first time anyone
 * tried it for real.
 *
 *   1. A student opened the deposit checkout, closed the tab, and came back.
 *      The duplicate check found her `unpaid` row and told her she was
 *      "already enrolled". She was not, and she could not book.
 *   2. The place was never held for a checkout that never finished, which is
 *      right, but the owner's page showed that row as "Unpaid" beside a
 *      student who really was paying by bank transfer.
 *   3. Nobody was told an enrolment happened. Not Ellie, not the student.
 *   4. Two enrolments from the same address, one typed with a capital letter.
 *
 * The fake database is the minimum the route touches. Everything asserted is
 * what reached the tables, the trainer's phone and the student's inbox.
 */
import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';
import { checkoutAbandoned, holdsAPlace, enrolmentLabel, spotsLeft, balanceDue } from '../../src/lib/course-enrolment.js';

/* ---------------------------------------------------------------- the db -- */
const db = { beauticians: [], courses: [], course_enrollments: [] };
let nextId = 1;
let groupColumnPresent = false;
let failGroupRead = false;

function makeBuilder(table) {
  const preds = [];
  let pending = null;
  let inserted = null;
  let columns = '*';
  let groupRead = false;
  const rows = () => (db[table] || []).filter(r => preds.every(p => p(r)));
  const project = rows => columns === '*' ? rows : rows.map(row => Object.fromEntries(columns.split(',').map(c => c.trim()).filter(c => c in row).map(c => [c, row[c]])));
  const settle = () => {
    if (groupRead && failGroupRead) return { data: null, error: { message: 'Read failed' } };
    if (inserted) return { data: [inserted], error: null };
    if (pending) {
      const hit = rows();
      for (const r of hit) Object.assign(r, pending);
      return { data: hit, error: null };
    }
    return { data: project(rows()), error: null };
  };
  const b = {
    select(c = '*') { columns = c; return b; },
    update(p) { pending = p; return b; },
    insert(p) { inserted = { id: `row-${nextId++}`, created_at: new Date().toISOString(), ...p }; db[table].push(inserted); return b; },
    eq(c, v) { if (c === 'course_group_id') groupRead = true; preds.push(r => r[c] === v); return b; },
    order() { return b; },
    limit() { return b; },
    single() { const s = settle(); return Promise.resolve({ data: s.data?.[0] || null, error: s.data?.[0] ? null : { message: 'no rows' } }); },
    then(res) { return Promise.resolve(settle()).then(res); },
  };
  return b;
}
const supabase = { from: (t) => makeBuilder(t) };

vi.mock('../../src/config.js', () => ({ supabase, supabaseAdmin: supabase }));
vi.mock('../../src/lib/logger.js', () => ({ default: { info() {}, warn() {}, error() {}, debug() {} } }));
// The live database may or may not have start_time; this test does not care.
vi.mock('../../src/lib/schema-probe.js', () => ({ hasColumn: async (_db, _table, column) => column === 'start_time' || (column === 'course_group_id' && groupColumnPresent) }));

const announced = [];
vi.mock('../../src/services/course-notifications.js', () => ({
  announceEnrolment: async (a) => { announced.push(a); },
  announceEnrolmentById: async () => {},
}));

const sessions = [];
vi.mock('stripe', () => ({
  default: class Stripe {
    constructor() {
      this.checkout = { sessions: { create: async (opts) => { const s = { id: `cs_test_${sessions.length + 1}`, url: 'https://checkout.stripe.com/c/pay/x', opts }; sessions.push(s); return s; } } };
    }
  },
}));
process.env.STRIPE_SECRET_KEY = 'sk_test_x';

const { default: courseRouter } = await import('../../src/routes/courses.js');

const app = express();
app.use(express.json());
app.use('/api/courses', courseRouter);
const server = createServer(app);
await new Promise(r => server.listen(0, r));
afterAll(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
const PORT = server.address().port;
const post = (path, body) => fetch(`http://127.0.0.1:${PORT}${path}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
}).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));
const get = (path) => fetch(`http://127.0.0.1:${PORT}${path}`).then(async r => ({ status: r.status, body: await r.json().catch(() => ({})) }));

/* --------------------------------------------------------------- fixtures -- */
const COURSE = 'course-1';
function seed({ deposit = 150, stripeReady = true, enrolled = 0, max = 4, date = '2026-10-12', status = 'active' } = {}) {
  db.beauticians = [{ id: 'biz-1', booking_slug: 'ellindigo', first_name: 'Ellie', business_name: 'Ellindigo', email: 'ellie@example.com', phone: '07700900000', stripe_account_id: stripeReady ? 'acct_1' : null, stripe_onboarding_complete: stripeReady }];
  db.courses = [{ id: COURSE, beautician_id: 'biz-1', name: 'Ultimate Beginner Course', date, location: 'Ellindigo', duration: 'Full day (7hrs)', max_students: max, price: 750, deposit, includes: ['certificate', 'kit'], enrolled, status }];
  db.course_enrollments = [];
  announced.length = 0; sessions.length = 0;
  groupColumnPresent = false;
  failGroupRead = false;
}
const STUDENT = { name: 'Chloe Morgan', email: 'Chloe.Morgan@Example.com', phone: '07700900123', notes: 'Complete beginner' };

// These scenarios use October 2026 appointments; freeze Date, not HTTP timers.
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-10-01T12:00:00Z')); });
afterEach(() => vi.useRealTimers());

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-01T12:00:00Z'));
  seed();
});
afterEach(() => vi.useRealTimers());

/* ------------------------------------------------------------- the rules -- */
describe('lib/course-enrolment: what a row means', () => {
  it('tells an abandoned checkout apart from a student paying the trainer directly', () => {
    expect(checkoutAbandoned({ payment_status: 'unpaid', stripe_payment_intent_id: 'cs_test_1' })).toBe(true);
    expect(checkoutAbandoned({ payment_status: 'unpaid', stripe_payment_intent_id: null })).toBe(false);
    expect(checkoutAbandoned({ payment_status: 'deposit_paid', stripe_payment_intent_id: 'pi_1' })).toBe(false);
    expect(holdsAPlace({ payment_status: 'unpaid', stripe_payment_intent_id: 'cs_test_1' })).toBe(false);
    expect(holdsAPlace({ payment_status: 'unpaid' })).toBe(true);
    expect(enrolmentLabel({ payment_status: 'unpaid', stripe_payment_intent_id: 'cs_x' }).text).toBe('Checkout not finished');
    expect(enrolmentLabel({ payment_status: 'unpaid' }).text).toBe('To pay');
    expect(enrolmentLabel({ payment_status: 'paid' }).text).toBe('Paid in full');
  });
  it('never reports negative places or a negative balance', () => {
    expect(spotsLeft({ max_students: 2, enrolled: 5 })).toBe(0);
    expect(balanceDue({ price: 750 }, { payment_status: 'deposit_paid', amount_paid_cents: 15000 })).toBe(600);
    expect(balanceDue({ price: 750 }, { payment_status: 'paid', amount_paid_cents: 0 })).toBe(0);
    expect(balanceDue({ price: 100 }, { payment_status: 'deposit_paid', amount_paid_cents: 20000 })).toBe(0);
  });
});

/* ------------------------------------------------------------- the route -- */
describe('POST /enroll with a deposit and Stripe ready', () => {
  it('opens a checkout, remembers it on the row, holds no place yet, tells nobody yet', async () => {
    const r = await post(`/api/courses/ellindigo/${COURSE}/enroll`, STUDENT);
    expect(r.status).toBe(201);
    expect(r.body.checkout_url).toMatch(/stripe/);
    const row = db.course_enrollments[0];
    expect(row.email).toBe('chloe.morgan@example.com');
    expect(row.stripe_payment_intent_id).toBe('cs_test_1');
    expect(db.courses[0].enrolled).toBe(0);
    expect(announced).toHaveLength(0);
  });

  it('lets the same student try again after abandoning the checkout, on the same row', async () => {
    await post(`/api/courses/ellindigo/${COURSE}/enroll`, STUDENT);
    const again = await post(`/api/courses/ellindigo/${COURSE}/enroll`, { ...STUDENT, email: 'chloe.morgan@example.com', notes: 'Second go' });
    expect(again.status).toBe(201);
    expect(again.body.checkout_url).toBeTruthy();
    expect(db.course_enrollments).toHaveLength(1);
    expect(db.course_enrollments[0].notes).toBe('Second go');
    expect(db.course_enrollments[0].stripe_payment_intent_id).toBe('cs_test_2');
  });

  it('refuses a real duplicate, whatever the capitalisation', async () => {
    db.course_enrollments.push({ id: 'e-paid', course_id: COURSE, email: 'chloe.morgan@example.com', payment_status: 'deposit_paid', stripe_payment_intent_id: 'pi_1', created_at: '2026-09-01T00:00:00Z' });
    const r = await post(`/api/courses/ellindigo/${COURSE}/enroll`, STUDENT);
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/already booked/);
  });
});

describe('POST /enroll when the trainer takes the deposit herself', () => {
  it('holds the place, and tells the trainer and the student once', async () => {
    seed({ stripeReady: false });
    const r = await post(`/api/courses/ellindigo/${COURSE}/enroll`, STUDENT);
    expect(r.status).toBe(201);
    expect(r.body.confirmed).toBe(true);
    expect(r.body.deposit_pending).toBe(true);
    expect(db.courses[0].enrolled).toBe(1);
    expect(announced).toHaveLength(1);
    expect(announced[0].paid).toBe('unpaid');
    expect(announced[0].enrollment.email).toBe('chloe.morgan@example.com');
    expect(announced[0].beautician.email).toBe('ellie@example.com');
  });

  it('a free-to-book course confirms without any deposit talk', async () => {
    seed({ stripeReady: false, deposit: 0 });
    const r = await post(`/api/courses/ellindigo/${COURSE}/enroll`, STUDENT);
    expect(r.body.deposit_pending).toBe(false);
    expect(r.body.deposit_note).toBeNull();
  });
});

describe('what cannot be booked', () => {
  it('a full course', async () => {
    seed({ enrolled: 4 });
    const r = await post(`/api/courses/ellindigo/${COURSE}/enroll`, STUDENT);
    expect(r.status).toBe(409);
    expect(db.course_enrollments).toHaveLength(0);
  });
  it('a course whose date has passed', async () => {
    seed({ date: '2024-01-01' });
    const r = await post(`/api/courses/ellindigo/${COURSE}/enroll`, STUDENT);
    expect(r.status).toBe(410);
  });
  it('a closed course says so on the public page rather than vanishing', async () => {
    seed({ status: 'draft' });
    const r = await get(`/api/courses/ellindigo/${COURSE}`);
    expect(r.status).toBe(410);
    expect(r.body.error).toMatch(/closed/);
    expect(r.body.course.name).toBe('Ultimate Beginner Course');
  });
  it('the public page carries a readable date and the places left', async () => {
    seed({ enrolled: 1 });
    const r = await get(`/api/courses/ellindigo/${COURSE}`);
    expect(r.status).toBe(200);
    expect(r.body.course.date_label).toBe('Monday 12 October 2026');
    expect(r.body.course.spots_left).toBe(3);
    expect(r.body.course.in_the_past).toBe(false);
  });
});

const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
const THIRD = '33333333-3333-4333-8333-333333333333';
const GROUP = '44444444-4444-4444-8444-444444444444';
function seedDates(options = {}) {
  seed(options);
  groupColumnPresent = true;
  db.courses[0] = { ...db.courses[0], id: FIRST, course_group_id: GROUP, start_time: '09:30' };
  db.courses.push({ ...db.courses[0], id: SECOND, date: '2026-10-19', start_time: '10:00', enrolled: 0, price: 800, deposit: 175, location: 'Second studio' });
}
const datePath = `/api/courses/ellindigo/${FIRST}`;

describe('students choose one of the offered training dates', () => {
  beforeEach(() => seedDates());

  it('returns only the same trainer and explicit course group, with each date’s full public details', async () => {
    db.courses.push({ ...db.courses[0], id: THIRD, beautician_id: 'biz-other' });
    db.courses.push({ ...db.courses[0], id: 'other-group', course_group_id: 'other' });
    db.courses.push({ ...db.courses[0], id: 'past', date: '2026-09-30' });
    db.courses.push({ ...db.courses[0], id: 'closed', status: 'draft' });
    const r = await get(datePath);
    expect(r.status).toBe(200);
    expect(r.body.date_selection_required).toBe(true);
    expect(r.body.dates.map(c => c.id)).toEqual([FIRST, SECOND]);
    expect(r.body.dates[1]).toMatchObject({ price: 800, deposit: 175, location: 'Second studio', start_time: '10:00', spots_left: 4 });
    expect(r.body.dates[1]).not.toHaveProperty('beautician_id');
    expect(r.body.dates[1]).not.toHaveProperty('course_group_id');
  });

  it('requires an explicit date when several bookable dates are offered', async () => {
    const r = await post(`${datePath}/enroll`, STUDENT);
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/choose a course date/i);
    expect(db.course_enrollments).toHaveLength(0);
    expect(sessions).toHaveLength(0);
  });

  it('uses the selected occurrence price, metadata and return URL for its deposit', async () => {
    const r = await post(`${datePath}/enroll`, { ...STUDENT, selected_course_id: SECOND });
    expect(r.status).toBe(201);
    expect(r.body.selected_course_id).toBe(SECOND);
    expect(r.body.course).toMatchObject({ id: SECOND, date: '2026-10-19', price: 800, deposit: 175 });
    expect(db.course_enrollments[0].course_id).toBe(SECOND);
    expect(sessions[0].opts.line_items[0].price_data.unit_amount).toBe(17500);
    expect(sessions[0].opts.metadata.course_id).toBe(SECOND);
    expect(sessions[0].opts.payment_intent_data.metadata.course_id).toBe(SECOND);
    expect(sessions[0].opts.success_url).toContain(`/training/ellindigo/${SECOND}?`);
    expect(sessions[0].opts.cancel_url).toContain(`/training/ellindigo/${SECOND}?`);
    expect(db.courses.map(c => c.enrolled)).toEqual([0, 0]);
  });

  it('reserves and confirms only the chosen date when the trainer takes payment herself', async () => {
    seedDates({ stripeReady: false });
    const r = await post(`${datePath}/enroll`, { ...STUDENT, selected_course_id: SECOND });
    expect(r.status).toBe(201);
    expect(r.body.course.start_time).toBe('10:00');
    expect(r.body.deposit_note).toContain('175.00');
    expect(db.courses.map(c => c.enrolled)).toEqual([0, 1]);
    expect(announced).toHaveLength(1);
    expect(announced[0].course.id).toBe(SECOND);
    expect(announced[0].enrollment.course_id).toBe(SECOND);
  });

  it.each(['another owner', 'another group', 'unknown', 'past', 'closed'])('rejects a selection from %s without opening payment or changing bookings', async kind => {
    if (kind === 'another owner') db.courses[1].beautician_id = 'biz-other';
    if (kind === 'another group') db.courses[1].course_group_id = THIRD;
    if (kind === 'unknown') db.courses.pop();
    if (kind === 'past') db.courses[1].date = '2026-09-30';
    if (kind === 'closed') db.courses[1].status = 'draft';
    const r = await post(`${datePath}/enroll`, { ...STUDENT, selected_course_id: SECOND });
    expect(r.status).toBe(400);
    expect(db.course_enrollments).toHaveLength(0);
    expect(sessions).toHaveLength(0);
  });

  it('rechecks full dates at submission and leaves other dates bookable', async () => {
    db.courses[1].enrolled = 4;
    const view = await get(datePath);
    expect(view.body.dates[1].is_full).toBe(true);
    const r = await post(`${datePath}/enroll`, { ...STUDENT, selected_course_id: SECOND });
    expect(r.status).toBe(409);
    expect(db.course_enrollments).toHaveLength(0);
    expect((await post(`${datePath}/enroll`, { ...STUDENT, selected_course_id: FIRST })).status).toBe(201);
  });

  it.each(['cancelled', 'past', 'undated'])('keeps a %s anchor link useful without choosing an alternative silently', async kind => {
    if (kind === 'cancelled') db.courses[0].status = 'cancelled';
    if (kind === 'past') db.courses[0].date = '2026-09-30';
    if (kind === 'undated') db.courses[0].date = null;
    const view = await get(datePath);
    expect(view.status).toBe(200);
    expect(view.body.course.id).toBe(SECOND);
    expect(view.body.dates.map(c => c.id)).toEqual([SECOND]);
    expect(view.body.date_selection_required).toBe(true);
    expect((await post(`${datePath}/enroll`, STUDENT)).status).toBe(400);
    expect((await post(`${datePath}/enroll`, { ...STUDENT, selected_course_id: SECOND })).status).toBe(201);
  });

  it('keeps duplicate and abandoned-checkout handling scoped to the chosen date', async () => {
    db.course_enrollments.push({ id: 'first-paid', course_id: FIRST, email: STUDENT.email.toLowerCase(), payment_status: 'paid' });
    const one = await post(`${datePath}/enroll`, { ...STUDENT, selected_course_id: SECOND });
    expect(one.status).toBe(201);
    const again = await post(`${datePath}/enroll`, { ...STUDENT, selected_course_id: SECOND });
    expect(again.status).toBe(201);
    expect(db.course_enrollments).toHaveLength(2);
    expect(db.course_enrollments[1].stripe_payment_intent_id).toBe('cs_test_2');
    expect((await post(`${datePath}/enroll`, { ...STUDENT, selected_course_id: FIRST })).status).toBe(409);
  });

  it('fails safely if offered dates cannot be read instead of booking the anchor', async () => {
    failGroupRead = true;
    expect((await get(datePath)).status).toBe(500);
    expect((await post(`${datePath}/enroll`, { ...STUDENT, selected_course_id: SECOND })).status).toBe(500);
    expect(db.course_enrollments).toHaveLength(0);
  });

  it('keeps old databases and standalone courses working without inferring a group from names', async () => {
    groupColumnPresent = false;
    const view = await get(datePath);
    expect(view.body.dates.map(c => c.id)).toEqual([FIRST]);
    expect(view.body.date_selection_required).toBe(false);
    expect((await post(`${datePath}/enroll`, STUDENT)).status).toBe(201);
    expect((await post(`${datePath}/enroll`, { ...STUDENT, selected_course_id: SECOND })).status).toBe(400);
  });

  it('uses the London date at midnight when excluding expired occurrences', async () => {
    vi.setSystemTime(new Date('2026-10-12T23:30:00Z'));
    const view = await get(datePath);
    expect(view.body.dates.map(c => c.id)).toEqual([SECOND]);
    expect((await post(`${datePath}/enroll`, { ...STUDENT, selected_course_id: FIRST })).status).toBe(410);
  });
});
