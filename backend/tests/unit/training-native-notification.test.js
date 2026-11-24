import { beforeEach, afterAll, describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { generateKeyPairSync } from 'node:crypto';

// Run the real course -> preference -> APNs path. Only the database and
// provider transports are replaced; no student or salon receives a test.
const state = vi.hoisted(() => ({ prefs: {}, requests: [], web: [], email: [], status: 200 }));
vi.mock('../../src/config.js', () => ({ supabase: { from(table) {
  const q = {
    select: () => q, eq: () => q,
    maybeSingle: async () => ({ data: { notification_prefs: state.prefs, timezone: 'Europe/London' } }),
    then: resolve => Promise.resolve({ data: table === 'native_push_tokens'
      ? [{ token: 'fictional-device' }]
      : [{ subscription: { endpoint: 'https://push.example.test' } }] }).then(resolve),
  };
  return q;
} } }));
vi.mock('node:http2', () => ({ default: { connect() {
  const client = new EventEmitter(); client.close = vi.fn();
  client.request = headers => {
    const req = new EventEmitter(); req.setEncoding = vi.fn(); req.setTimeout = vi.fn();
    req.end = payload => {
      state.requests.push({ headers, payload: JSON.parse(payload) });
      queueMicrotask(() => {
        req.emit('response', { ':status': state.status });
        if (state.status !== 200) req.emit('data', JSON.stringify({ reason: 'ServiceUnavailable' }));
        req.emit('end');
      });
    };
    return req;
  };
  return client;
} } }));
vi.mock('web-push', () => ({ default: {
  setVapidDetails() {}, sendNotification: async (_sub, payload) => { state.web.push(JSON.parse(payload)); },
} }));
vi.mock('../../src/services/notifications.js', () => ({ sendEmail: async message => { state.email.push(message); return { id: 'fictional-email' }; } }));
vi.mock('../../src/lib/logger.js', () => ({ default: { info() {}, warn() {}, debug() {}, error() {} } }));

vi.stubEnv('APNS_KEY_ID', 'TESTKEY'); vi.stubEnv('APNS_TEAM_ID', 'TESTTEAM');
vi.stubEnv('APNS_PRIVATE_KEY', generateKeyPairSync('ec', { namedCurve: 'P-256', privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } }).privateKey);
vi.stubEnv('APNS_CUSTOM_SOUNDS', 'false');
vi.stubEnv('VAPID_PUBLIC_KEY', 'fictional'); vi.stubEnv('VAPID_PRIVATE_KEY', 'fictional');
const { announceEnrolment } = await import('../../src/services/course-notifications.js');
const { pushTeamUpdate } = await import('../../src/services/push-notifications.js');
const input = () => ({
  beautician: { id: 'salon', business_name: 'Demo Studio', booking_slug: 'demo' },
  course: { id: 'course', name: 'Brow training', date: '2027-01-12', start_time: '09:30:00', price: 450.75, deposit: 90.50 },
  enrollment: { id: 'student-1', name: 'Demo Student', email: 'student@example.test', payment_status: 'deposit_paid', amount_paid_cents: 9050 },
  paid: 'deposit',
});
beforeEach(() => { state.prefs = {}; state.requests = []; state.web = []; state.email = []; state.status = 200; });
afterAll(() => vi.unstubAllEnvs());

describe('A separate native training booking alert', () => {
  it('reaches Apple with the headline, actual amount, start time and exact booking link', async () => {
    const delivered = [];
    const result = await announceEnrolment({ ...input(), onDelivered: async channel => delivered.push(channel) });
    expect(result.failures).toEqual([]);
    expect(delivered.sort()).toEqual(['apns', 'email', 'web']);
    expect(state.requests).toHaveLength(1);
    const { headers, payload } = state.requests[0];
    expect(headers['apns-push-type']).toBe('alert');
    expect(payload.aps).toEqual({
      alert: { title: '🎓 Training booking confirmed', body: 'Demo Student booked onto Brow training, Tuesday 12 January 2027 at 09:30. Deposit paid (£90.50).' },
      sound: 'default', 'thread-id': 'training-bookings',
    });
    expect(payload.url).toBe('/packages?course=course&student=student-1');
    expect(payload.data.url).toBe(payload.url);
    expect(payload.actionType).toBe('course_enrolled');
    expect(state.web[0].tag).toBe('course-enrolment-student-1');
  });

  it('still sends training alerts when treatment booking alerts are turned off', async () => {
    state.prefs = { booking_confirmed: { push: false } };
    await announceEnrolment(input());
    expect(state.requests).toHaveLength(1);
  });

  it('turns off only the owner training alert, preserving the student confirmation and treatment alerts', async () => {
    state.prefs = { course_enrolled: { push: false } };
    const delivered = [];
    const result = await announceEnrolment({ ...input(), onDelivered: async channel => delivered.push(channel) });
    expect(result.failures).toEqual([]);
    expect(delivered.sort()).toEqual(['apns', 'email', 'web']);
    expect(state.requests).toHaveLength(0);
    expect(state.web).toHaveLength(0);
    expect(state.email).toHaveLength(1);
    await pushTeamUpdate('salon', 'booking_confirmed', 'A treatment is booked');
    expect(state.requests).toHaveLength(1);
    expect(state.requests[0].payload.aps['thread-id']).toBeUndefined();
  });

  it('leaves Apple delivery pending on failure, then retries only that channel', async () => {
    const delivered = [];
    state.status = 503;
    const first = await announceEnrolment({ ...input(), onDelivered: async channel => delivered.push(channel) });
    expect(first.failures).toEqual(['iPhone push unavailable']);
    expect(delivered.sort()).toEqual(['email', 'web']);
    state.status = 200;
    const retry = await announceEnrolment({ ...input(), delivery: { email: false, web: false, apns: true }, onDelivered: async channel => delivered.push(channel) });
    expect(retry.failures).toEqual([]);
    expect(state.email).toHaveLength(1); expect(state.web).toHaveLength(1);
    expect(state.requests).toHaveLength(2);
    expect(delivered.sort()).toEqual(['apns', 'email', 'web']);
  });

  it('keeps each student distinct and does not collapse all course bookings into one alert', async () => {
    await announceEnrolment(input());
    await announceEnrolment({ ...input(), enrollment: { ...input().enrollment, id: 'student-2' } });
    expect(state.requests.map(r => r.payload.url)).toEqual(['/packages?course=course&student=student-1', '/packages?course=course&student=student-2']);
    expect(state.requests.every(r => !r.headers['apns-collapse-id'])).toBe(true);
    expect(new Set(state.web.map(r => r.tag)).size).toBe(2);
  });

  it('does not describe a pay-direct booking as money received', async () => {
    await announceEnrolment({ ...input(), paid: 'unpaid', enrollment: { ...input().enrollment, payment_status: 'unpaid', amount_paid_cents: 0 } });
    expect(state.requests[0].payload.aps.alert.body).toContain('Deposit of £90.50 still to collect.');
    expect(state.requests[0].payload.aps.alert.body).not.toContain('Deposit paid');
  });
});
