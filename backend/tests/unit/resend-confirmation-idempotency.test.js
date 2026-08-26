/**
 * A GET THAT SENDS MESSAGES, WITH NO IDEMPOTENCY.
 *
 *   GET /api/booking/:slug/manage/:token/resend-confirmation
 *
 * Fired twice, seven seconds apart, by accident, on 26 August. A real client
 * received two identical confirmations on two channels. Nothing refused the
 * second one, because nothing looked.
 *
 * A GET is the wrong verb for this and always was. It is re-fired by browser
 * prefetch, by refreshes and retries, by link unfurlers, and by WhatsApp
 * itself, which fetches a url the moment somebody pastes it into a chat in
 * order to draw the preview card. That last one matters more than it sounds:
 * this url is pasted into WhatsApp threads by hand when a client says her
 * confirmation never arrived, which means the act of asking about it can send
 * it, twice, before anybody taps anything.
 *
 * THE SHAPE IS COPIED, NOT INVENTED. routes/stripe.js solved the identical
 * problem for refunds a few weeks ago, and the load-bearing idea there is not
 * the idempotency key: it is that the route does not trust the caller's
 * intent, it OBSERVES whether the thing already happened, and answers honestly
 * when it did (`success:false, duplicate:true`) rather than reporting the first
 * one as a second. Here the witness is appointments.confirmation_sent_at,
 * which notifyBookingConfirmed stamps only when something really left.
 *
 * The corollary is the important half: a run that delivered NOTHING leaves no
 * stamp, so it is never refused. The whole purpose of this endpoint is the case
 * where nothing arrived, and a guard that blocked that would be worse than the
 * double send.
 */
process.env.TZ = 'UTC';

import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';

const db = { appointments: [] };

function builder(table) {
  const filters = [];
  let pending = null;
  const rows = () => (db[table] || []).filter(r => filters.every(f => f(r)));
  const settle = () => {
    if (pending?.op === 'update') {
      const matched = rows();
      for (const r of matched) Object.assign(r, pending.payload);
      return { data: matched, error: null };
    }
    return { data: rows(), error: null };
  };
  const b = {
    select() { return b; },
    insert(p) { pending = { op: 'insert', payload: p }; return b; },
    update(p) { pending = { op: 'update', payload: p }; return b; },
    eq(c, v) { filters.push(r => r[c] === v); return b; },
    neq() { return b; }, in() { return b; }, is() { return b; },
    not() { return b; }, or() { return b; }, ilike() { return b; },
    gte() { return b; }, lte() { return b; }, gt() { return b; }, lt() { return b; },
    order() { return b; }, limit() { return b; }, range() { return b; },
    maybeSingle() { const o = settle(); return Promise.resolve({ data: (o.data || [])[0] || null, error: null }); },
    single() { const o = settle(); return Promise.resolve({ data: (o.data || [])[0] || null, error: null }); },
    then(res, rej) { return Promise.resolve(settle()).then(res, rej); },
  };
  return b;
}

vi.mock('../../src/config.js', () => ({ supabase: { from: builder }, supabaseAdmin: { from: builder } }));
vi.mock('../../src/lib/logger.js', () => ({ default: { info() {}, warn() {}, error() {}, debug() {} } }));
vi.mock('@sentry/node', () => ({ captureMessage: () => {}, captureException: () => {} }));

/**
 * The real sender is stubbed: what is under test is whether this route calls
 * it twice, not what it does when it is called. It stamps confirmation_sent_at
 * the way the real one does, because that stamp IS the guard.
 */
const confirmations = [];
let confirmResult = { sent: true, channels: ['whatsapp', 'sms'], link: { channel: 'sms', reason: null } };
// The real one talks to Meta, then Bird, then Resend. It is not instant, and
// the gap between "decided to send" and "stamped" is where a double fire lands.
let sendDelayMs = 0;
vi.mock('../../src/services/notifications.js', () => ({
  notifyBookingConfirmed: async (id) => {
    confirmations.push(id);
    if (sendDelayMs) await new Promise(r => setTimeout(r, sendDelayMs));
    if (confirmResult.sent) {
      const appt = db.appointments.find(a => a.id === id);
      if (appt) appt.confirmation_sent_at = new Date().toISOString();
    }
    return confirmResult;
  },
  sendSMS: async () => null,
}));

const bookingRouter = (await import('../../src/routes/booking.js')).default;
const { resendReplay, RESEND_IDEMPOTENCY_WINDOW_MS } = await import('../../src/routes/booking.js');

const app = express();
app.use(express.json());
app.use('/api/booking', bookingRouter);

/**
 * A fresh appointment per test. The in-flight claim the route holds is keyed by
 * appointment id and lives for the length of the window, so reusing one id
 * would leak a claim from one test into the next.
 */
let seq = 0;
let PATH = '';

let server;
let base;
async function listen() {
  if (server) return base;
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  return base;
}

const call = async (method = 'GET', path = null) => {
  const url = (await listen()) + (path || PATH);
  const res = await fetch(url, { method });
  return { status: res.status, headers: res.headers, body: await res.json() };
};

let APPT_ID;
let TOKEN;

beforeEach(() => {
  seq += 1;
  APPT_ID = `a${seq}`;
  TOKEN = `tok_sophie_${seq}`;
  PATH = `/api/booking/ellindigo/manage/${TOKEN}/resend-confirmation`;
  db.appointments = [{
    id: APPT_ID,
    beautician_id: 'b1',
    management_token: TOKEN,
    confirmation_sent_at: null,
    beauticians: { booking_slug: 'ellindigo' },
  }];
  confirmations.length = 0;
  sendDelayMs = 0;
  confirmResult = { sent: true, channels: ['whatsapp', 'sms'], link: { channel: 'sms', reason: null } };
});

/* ============================================================ the two taps == */
describe('the same request twice, seven seconds apart', () => {
  it('sends once and refuses the second', async () => {
    const first = await call('GET');
    const second = await call('GET');

    expect(first.body).toMatchObject({ ok: true, sent: true, duplicate: false });
    expect(second.body.sent).toBe(false);
    expect(second.body.duplicate).toBe(true);
    // The assertion this file exists for: the client's phone rang once.
    expect(confirmations).toEqual([APPT_ID]);
  });

  it('says WHEN it went, rather than just saying no', async () => {
    await call('GET');
    const second = await call('GET');

    expect(second.body.already_sent_at).toBeTruthy();
    expect(Date.parse(second.body.already_sent_at)).toBeGreaterThan(0);
    expect(second.body.seconds_ago).toBeGreaterThanOrEqual(0);
    expect(second.body.reason).toBe('already_sent');
    expect(second.body.message).toMatch(/already went out/i);
    // And it is explicit that this request sent nothing, rather than leaving
    // the reader to infer it from `sent: false`. That inference is exactly
    // what the refund route stopped relying on.
    expect(second.body.message).toMatch(/nothing new was sent/i);
    expect(second.body.message).not.toMatch(/[–—]/);
  });

  it('tells the caller when they may try again', async () => {
    await call('GET');
    const second = await call('GET');
    expect(second.body.retry_after_seconds).toBeGreaterThan(0);
    expect(second.body.retry_after_seconds).toBeLessThanOrEqual(RESEND_IDEMPOTENCY_WINDOW_MS / 1000);
  });

  it('answers 200, because a refusal that already did the right thing is not an error', async () => {
    await call('GET');
    const second = await call('GET');
    expect(second.status).toBe(200);
  });

  it('sends once when both fires land DURING the send, not after it', async () => {
    // The stamp only exists once notifyBookingConfirmed has finished, and it
    // talks to Meta, then Bird, then Resend. A browser that prefetches and then
    // navigates fires inside that gap, and both requests read a null stamp.
    sendDelayMs = 150;

    const [a, b] = await Promise.all([call('GET'), call('GET')]);

    expect(confirmations).toEqual([APPT_ID]);
    const outcomes = [a.body, b.body];
    expect(outcomes.filter(o => o.sent === true)).toHaveLength(1);
    expect(outcomes.filter(o => o.duplicate === true)).toHaveLength(1);
  });

  it('refuses a POST that follows a GET, and a GET that follows a POST', async () => {
    await call('POST');
    expect(confirmations).toEqual([APPT_ID]);
    const viaGet = await call('GET');
    expect(viaGet.body.duplicate).toBe(true);
    expect(confirmations).toEqual([APPT_ID]);
  });
});

/* ================================================================= the verb = */
describe('the verb', () => {
  it('accepts a POST, which is what a send should have been all along', async () => {
    const res = await call('POST');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, sent: true });
    expect(confirmations).toEqual([APPT_ID]);
  });

  it('keeps the GET working, because that url is pasted into browsers by hand', async () => {
    const res = await call('GET');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, sent: true });
  });

  it('keeps the answer shape the old caller expects', async () => {
    const res = await call('GET');
    // ok / sent / channels / reason were the whole contract before. Nothing
    // that reads them may break.
    expect(res.body).toHaveProperty('ok');
    expect(res.body).toHaveProperty('sent');
    expect(Array.isArray(res.body.channels)).toBe(true);
    expect(res.body).toHaveProperty('reason');
  });

  it('tells the caller whether she can actually act on the booking', async () => {
    const res = await call('GET');
    expect(res.body.link).toEqual({ channel: 'sms', reason: null });
  });

  it('refuses to be cached, so nothing else can replay the answer', async () => {
    const res = await call('GET');
    expect(res.headers.get('cache-control')).toMatch(/no-store/);
  });

  it('still 404s an unknown token, on both verbs', async () => {
    const bad = '/api/booking/ellindigo/manage/nope/resend-confirmation';
    expect((await call('GET', bad)).status).toBe(404);
    expect((await call('POST', bad)).status).toBe(404);
    expect(confirmations).toEqual([]);
  });

  it('still 404s a token that belongs to another salon', async () => {
    const wrongSlug = `/api/booking/someone-else/manage/${TOKEN}/resend-confirmation`;
    expect((await call('GET', wrongSlug)).status).toBe(404);
    expect(confirmations).toEqual([]);
  });
});

/* ====================================== the case the endpoint exists for ==== */
describe('when nothing actually went out', () => {
  it('lets her ask again immediately, because no stamp means no message', async () => {
    // The real notifyBookingConfirmed stamps confirmation_sent_at ONLY when a
    // channel delivered (confirmation-honesty.test.js). A run that delivered
    // nothing must not lock the client out of asking again for two minutes.
    confirmResult = { sent: false, channels: [], reason: 'all_channels_disabled', link: null };

    const first = await call('GET');
    const second = await call('GET');

    expect(first.body).toMatchObject({ sent: false, duplicate: false, reason: 'all_channels_disabled' });
    expect(second.body.duplicate).toBe(false);
    expect(confirmations).toEqual([APPT_ID, APPT_ID]);
  });

  it('lets her ask again once the window has passed', async () => {
    db.appointments[0].confirmation_sent_at = new Date(Date.now() - RESEND_IDEMPOTENCY_WINDOW_MS - 1000).toISOString();
    const res = await call('GET');
    expect(res.body.duplicate).toBe(false);
    expect(confirmations).toEqual([APPT_ID]);
  });
});

/* ================================================================ the guard = */
describe('resendReplay, the decision on its own', () => {
  const now = Date.parse('2026-08-26T14:53:00.000Z');

  it('is two minutes', () => {
    expect(RESEND_IDEMPOTENCY_WINDOW_MS).toBe(2 * 60 * 1000);
  });

  it('catches the seven seconds that caused this', () => {
    const v = resendReplay('2026-08-26T14:52:53.000Z', now);
    expect(v).toBeTruthy();
    expect(v.secondsAgo).toBe(7);
    expect(v.retryAfterSeconds).toBe(113);
  });

  it('lets a genuine ask through an hour later', () => {
    expect(resendReplay('2026-08-26T13:53:00.000Z', now)).toBeNull();
  });

  it('lets it through at the boundary and one millisecond past', () => {
    expect(resendReplay(new Date(now - RESEND_IDEMPOTENCY_WINDOW_MS - 1).toISOString(), now)).toBeNull();
    expect(resendReplay(new Date(now - RESEND_IDEMPOTENCY_WINDOW_MS + 1000).toISOString(), now)).toBeTruthy();
  });

  it('treats a booking that was never confirmed as free to send', () => {
    expect(resendReplay(null, now)).toBeNull();
    expect(resendReplay('', now)).toBeNull();
    expect(resendReplay('not a date', now)).toBeNull();
  });

  it('does not refuse on a stamp from the future, which is a clock, not a duplicate', () => {
    // A client who got nothing must always be able to ask again. Skewed
    // clocks are common and this guard must never be the reason she cannot.
    expect(resendReplay(new Date(now + 60_000).toISOString(), now)).toBeNull();
  });
});
