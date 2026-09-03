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
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import { createServer } from 'node:http';
import { checkoutAbandoned, holdsAPlace, enrolmentLabel, spotsLeft, balanceDue } from '../../src/lib/course-enrolment.js';

/* ---------------------------------------------------------------- the db -- */
const db = { beauticians: [], courses: [], course_enrollments: [] };
let nextId = 1;

function makeBuilder(table) {
  const preds = [];
  let pending = null;
  let inserted = null;
  const rows = () => (db[table] || []).filter(r => preds.every(p => p(r)));
  const settle = () => {
    if (inserted) return { data: [inserted], error: null };
    if (pending) {
      const hit = rows();
      for (const r of hit) Object.assign(r, pending);
      return { data: hit, error: null };
    }
    return { data: rows(), error: null };
  };
  const b = {
    select() { return b; },
    update(p) { pending = p; return b; },
    insert(p) { inserted = { id: `row-${nextId++}`, created_at: new Date().toISOString(), ...p }; db[table].push(inserted); return b; },
    eq(c, v) { preds.push(r => r[c] === v); return b; },
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
vi.mock('../../src/lib/schema-probe.js', () => ({ hasColumn: async () => false }));

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
}
const STUDENT = { name: 'Chloe Morgan', email: 'Chloe.Morgan@Example.com', phone: '07700900123', notes: 'Complete beginner' };

beforeEach(() => seed());

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
