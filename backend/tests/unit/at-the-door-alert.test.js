/**
 * GETTING IT IN FRONT OF HER WITHIN SECONDS, which is the whole point.
 *
 * 27 August 2026. A client wrote "Im 60 seconds away!" and Florrie answered her
 * herself. Holding that reply is only half a fix: the client is still outside,
 * and a draft sitting in an outbox is worth nothing to somebody already on the
 * step. So the owner has to be told NOW, and "told" has to mean her phone
 * actually buzzed, not that a row was written somewhere she might look later.
 *
 * There were two notification paths already in this file and NEITHER of them
 * does that job:
 *
 *   pushMessagesWaiting is throttled to one push per channel per fifteen
 *   minutes. That is the right design for "you have messages" and roughly
 *   fourteen and a half minutes too slow for a person at a door.
 *
 *   pushEscalation shares the "💬 Needs you" headline with 142 escalations a
 *   month, is fired and forgotten after a model call and two database writes,
 *   and can be switched off entirely by a toggle in Settings.
 *
 * This file pins the four properties that make the third path different: no
 * toggle can silence it, no throttle can hold it, the same words twice in a row
 * do not buzz twice, and when push reaches no device at all it says so and
 * falls back to a channel that needs no permission and no app.
 */
process.env.TZ = 'UTC';
process.env.VAPID_PUBLIC_KEY = 'test-public';
process.env.VAPID_PRIVATE_KEY = 'test-private';
process.env.VAPID_EMAIL = 'mailto:test@florrie.ai';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const THAT_MORNING = new Date('2026-08-27T11:32:00.000Z');

/**
 * The clock is fixed, and it also MOVES BETWEEN TESTS, ten minutes at a time.
 *
 * The duplicate suppressor inside pushAtTheDoor is module state keyed by time,
 * which is the correct shape for a process that runs for weeks and the wrong
 * shape for a suite that resets the world and then rewinds the clock to the
 * same instant. Pinning every test to 11:32 makes the second test look like a
 * webhook redelivery of the first. So each test gets its own minute, and none
 * of them gets the real one: a wall-clock read in the code is a wall-clock
 * write in the test.
 */
let testClock = THAT_MORNING.getTime();

/* -------------------------------------------------------------- the world -- */
const db = { beauticians: [], push_subscriptions: [] };

function builder(name) {
  const filters = [];
  let pending = null;
  const rows = () => (db[name] || []).filter(r => filters.every(f => f(r)));
  const settle = () => {
    if (pending === 'delete') {
      db[name] = (db[name] || []).filter(r => !filters.every(f => f(r)));
      return { data: null, error: null };
    }
    return { data: rows(), error: null };
  };
  const b = {
    select() { return b; },
    delete() { pending = 'delete'; return b; },
    eq(c, v) { filters.push(r => r[c] === v); return b; },
    filter() { return b; },
    maybeSingle() { return Promise.resolve({ data: rows()[0] || null, error: null }); },
    then(res, rej) { return Promise.resolve(settle()).then(res, rej); },
  };
  return b;
}
vi.mock('../../src/config.js', () => ({ supabase: { from: builder } }));

/* ------------------------------------------------------------- the phones -- */
const webSent = [];
let webFails = false;
vi.mock('web-push', () => ({
  default: {
    setVapidDetails: () => {},
    sendNotification: async (sub, payload) => {
      if (webFails) { const e = new Error('gone'); e.statusCode = 410; throw e; }
      webSent.push({ endpoint: sub.endpoint, payload: JSON.parse(payload) });
      return { statusCode: 201 };
    },
  },
}));

const apnsSent = [];
let apnsDevices = 0;
vi.mock('../../src/services/apns.js', () => ({
  sendApnsToBeautician: async (id, opts) => {
    if (!apnsDevices) return null;
    apnsSent.push({ id, ...opts });
    return { sent: apnsDevices, removed: 0 };
  },
  isApnsConfigured: () => true,
  sendLiveActivityPush: async () => null,
}));

/* ----------------------------------------------------------- the last resort */
const texts = [];
let smsWorks = true;
vi.mock('../../src/services/notifications.js', () => ({
  sendSMS: async (args) => { texts.push(args); return smsWorks ? { id: 'sms_1' } : null; },
}));

const { pushAtTheDoor, pushEscalation, pushMessagesWaiting } =
  await import('../../src/services/push-notifications.js');

const HER_WORDS = 'Im 60 seconds away!';

beforeEach(() => {
  vi.useFakeTimers();
  testClock += 10 * 60 * 1000;
  vi.setSystemTime(new Date(testClock));
  db.beauticians = [{ id: 'b1', phone: '+447700900999', notification_prefs: {}, timezone: 'Europe/London' }];
  db.push_subscriptions = [{ beautician_id: 'b1', subscription: { endpoint: 'https://push.example/ellie' } }];
  webSent.length = 0;
  apnsSent.length = 0;
  texts.length = 0;
  apnsDevices = 0;
  webFails = false;
  smsWorks = true;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the doorstep alert', () => {
  it("reaches her phone with the client's own words, verbatim", async () => {
    const out = await pushAtTheDoor('b1', 'Nicole', HER_WORDS, { clientId: 'c1' });

    expect(out).toMatchObject({ channel: 'push', delivered: 1 });
    expect(webSent).toHaveLength(1);
    // Her words, not a summary of them. "Im 60 seconds away!" tells Ellie
    // everything she needs in the two seconds she has.
    expect(webSent[0].payload.body).toBe(`Nicole: ${HER_WORDS}`);
    expect(webSent[0].payload.url).toBe('/inbox?client=c1');
  });

  it('has its own headline, not the one she has learned to ignore', async () => {
    await pushAtTheDoor('b1', 'Nicole', HER_WORDS, { clientId: 'c1' });
    await pushEscalation('b1', 'Nicole', 'can I move to Saturday?');

    const [door, ordinary] = webSent;
    expect(door.payload.title).not.toBe(ordinary.payload.title);
    expect(door.payload.title).toMatch(/door/i);
  });

  it('goes to the iPhone as well as the browser', async () => {
    apnsDevices = 2;
    const out = await pushAtTheDoor('b1', 'Nicole', HER_WORDS, { clientId: 'c1' });

    expect(apnsSent).toHaveLength(1);
    expect(apnsSent[0].data.url).toBe('/inbox?client=c1');
    expect(out.delivered).toBe(3); // one browser, two devices
  });

  it('cannot be switched off in Settings, unlike every other push', async () => {
    // She turned AI escalations off. That is a reasonable thing to say about a
    // queue of 142 messages a month, and an unreasonable thing to say about a
    // person standing outside, so this type is not in ACTION_TO_PREF at all.
    db.beauticians[0].notification_prefs = { ai_escalation: { push: false } };

    await pushEscalation('b1', 'Nicole', 'can I move to Saturday?');
    expect(webSent, 'the ordinary escalation should have been suppressed').toHaveLength(0);

    const out = await pushAtTheDoor('b1', 'Nicole', HER_WORDS, { clientId: 'c1' });
    expect(out.channel).toBe('push');
    expect(webSent).toHaveLength(1);
  });

  it('cannot be held by quiet hours either', async () => {
    db.beauticians[0].notification_prefs = { quiet_hours: { enabled: true, start: '00:00', end: '23:59' } };

    const out = await pushAtTheDoor('b1', 'Nicole', HER_WORDS, { clientId: 'c1' });
    expect(out.channel).toBe('push');
    expect(webSent).toHaveLength(1);
  });

  it('is not throttled, because the second message is new information', async () => {
    // pushMessagesWaiting collapses a burst into one calm notification every
    // fifteen minutes. Correct there, fatal here: "I'm outside" followed by "I
    // can't find you" is two different facts and she needs both.
    await pushAtTheDoor('b1', 'Nicole', "I'm outside", { clientId: 'c1' });
    await pushAtTheDoor('b1', 'Nicole', "I can't find you", { clientId: 'c1' });
    expect(webSent).toHaveLength(2);

    webSent.length = 0;
    await pushMessagesWaiting('b1', 'sms');
    const second = await pushMessagesWaiting('b1', 'sms');
    expect(second).toEqual({ skipped: 'throttled' });
    expect(webSent, 'the throttled path should have sent one').toHaveLength(1);
  });

  it('does not buzz twice for a redelivered webhook', async () => {
    await pushAtTheDoor('b1', 'Nicole', HER_WORDS, { clientId: 'c1' });
    const again = await pushAtTheDoor('b1', 'Nicole', HER_WORDS, { clientId: 'c1' });

    expect(again).toMatchObject({ channel: 'duplicate' });
    expect(webSent).toHaveLength(1);
  });

  it('buzzes again if she really does say the same thing later', async () => {
    await pushAtTheDoor('b1', 'Nicole', HER_WORDS, { clientId: 'c1' });
    vi.setSystemTime(new Date(testClock + 3 * 60 * 1000));
    await pushAtTheDoor('b1', 'Nicole', HER_WORDS, { clientId: 'c1' });

    expect(webSent).toHaveLength(2);
  });

  it('separates one client from another', async () => {
    await pushAtTheDoor('b1', 'Nicole', "I'm outside", { clientId: 'c1' });
    await pushAtTheDoor('b1', 'Leanne', "I'm outside", { clientId: 'c2' });
    expect(webSent).toHaveLength(2);
  });
});

describe('when push reaches nobody, which is the honest case', () => {
  it('texts her own mobile instead', async () => {
    // No browser subscription, no iOS device. A push here is silence, and a
    // client is standing outside. An SMS needs no permission and no app.
    db.push_subscriptions = [];
    apnsDevices = 0;

    const out = await pushAtTheDoor('b1', 'Nicole', HER_WORDS, { clientId: 'c1' });

    expect(out).toMatchObject({ channel: 'sms', delivered: 1 });
    expect(texts).toHaveLength(1);
    expect(texts[0].to).toBe('+447700900999');
    expect(texts[0].body).toContain('Nicole');
    expect(texts[0].body).toContain(HER_WORDS);
    // Her own phone is not a client thread and must never appear in one.
    expect(texts[0].skipThreadLog).toBe(true);
    expect(texts[0].clientId).toBeNull();
  });

  it('counts an expired subscription as nobody', async () => {
    // A stale endpoint returns 410 and is cleaned up. That is not a delivery,
    // and treating it as one is exactly the kind of quiet lie this change is
    // about.
    webFails = true;
    apnsDevices = 0;

    const out = await pushAtTheDoor('b1', 'Nicole', HER_WORDS, { clientId: 'c1' });
    expect(out.channel).toBe('sms');
    expect(texts).toHaveLength(1);
  });

  it('says plainly that she has not been told when there is nothing left', async () => {
    db.push_subscriptions = [];
    db.beauticians[0].phone = null;

    const out = await pushAtTheDoor('b1', 'Nicole', HER_WORDS, { clientId: 'c1' });

    expect(out).toEqual({ delivered: 0, channel: 'none' });
    expect(texts).toEqual([]);
  });

  it('never throws, whatever fails', async () => {
    db.push_subscriptions = [];
    smsWorks = false;

    await expect(pushAtTheDoor('b1', 'Nicole', HER_WORDS, { clientId: 'c1' }))
      .resolves.toMatchObject({ delivered: 0, channel: 'none' });
  });

  it('does nothing at all without a beautician', async () => {
    await expect(pushAtTheDoor(null, 'Nicole', HER_WORDS, {}))
      .resolves.toEqual({ delivered: 0, channel: 'none' });
    expect(webSent).toEqual([]);
  });
});
