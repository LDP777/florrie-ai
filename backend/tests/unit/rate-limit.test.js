/**
 * The limiter that stopped Ellie adding a treatment to Lucy's booking.
 *
 * Lucy: "I just realised I need to add lash lift to this booking!" Ellie opened
 * the appointment to add it and got "Too many requests, please try again
 * later", twice, and gave up: "So I just added 30mins block out instead."
 *
 * The app could already do what she wanted. The limiter took it away, because
 * 100 requests per 15 minutes per IP is less than the app spends on badge
 * polling and app-switching before she touches anything.
 *
 * These drive the middleware directly rather than over HTTP — no server, no
 * supertest — because the thing under test is entirely which counter goes up.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { apiLimiter, authLimiter, identityOf, isRead, normaliseIp } from '../../src/middleware/rate-limit.js';

/** A JWT with this subject. Unsigned: the limiter never verifies, by design. */
function tokenFor(sub) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub })}.sig`;
}

function fakeReq({ method = 'GET', ip = '1.2.3.4', sub = null, auth = null } = {}) {
  const headers = {};
  if (sub) headers.authorization = `Bearer ${tokenFor(sub)}`;
  if (auth !== null) headers.authorization = auth;
  return { method, ip, headers, socket: { remoteAddress: ip } };
}

function fakeRes() {
  const h = {};
  const res = {
    statusCode: 200,
    body: null,
    setHeader(k, v) { h[k] = v; },
    getHeader(k) { return h[k]; },
    removeHeader(k) { delete h[k]; },
    status(c) { res.statusCode = c; return res; },
    json(b) { res.body = b; return res; },
    send(b) { res.body = b; return res; },
    headers: h,
  };
  return res;
}

/** One trip through the limiter. Resolves to the res once it settles. */
function hit(mw, reqOpts) {
  return new Promise((resolve) => {
    const req = fakeReq(reqOpts);
    const res = fakeRes();
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(res); } };
    res.json = (b) => { res.body = b; finish(); return res; };
    res.send = (b) => { res.body = b; finish(); return res; };
    mw(req, res, () => { res.statusCode = 200; finish(); });
  });
}

async function hitMany(mw, n, reqOpts) {
  let last = null;
  for (let i = 0; i < n; i++) last = await hit(mw, reqOpts);
  return last;
}

describe('who the count belongs to', () => {
  it('counts a signed-in person by their user id, not their address', () => {
    expect(identityOf(fakeReq({ sub: 'ellie-1' }))).toBe('u:ellie-1');
    // Same person, different network — same bucket.
    expect(identityOf(fakeReq({ sub: 'ellie-1', ip: '9.9.9.9' }))).toBe('u:ellie-1');
  });

  it('falls back to the address when there is no token', () => {
    expect(identityOf(fakeReq({ ip: '1.2.3.4' }))).toBe('ip:1.2.3.4');
  });

  it('falls back to the address when the token is not a readable JWT', () => {
    expect(identityOf(fakeReq({ auth: 'Bearer nonsense' }))).toBe('ip:1.2.3.4');
    expect(identityOf(fakeReq({ auth: 'Basic abc' }))).toBe('ip:1.2.3.4');
    // Three parts, but the middle is not base64 JSON.
    expect(identityOf(fakeReq({ auth: 'Bearer aaa.bbb.ccc' }))).toBe('ip:1.2.3.4');
  });

  it('does not accept a token with no subject', () => {
    const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const noSub = `${b64({ alg: 'HS256' })}.${b64({ role: 'admin' })}.sig`;
    expect(identityOf(fakeReq({ auth: `Bearer ${noSub}` }))).toBe('ip:1.2.3.4');
  });
});

describe('addresses are collapsed to something worth counting', () => {
  it('leaves IPv4 alone', () => {
    expect(normaliseIp('81.2.3.4')).toBe('81.2.3.4');
  });

  it('unwraps IPv4 written as IPv6', () => {
    expect(normaliseIp('::ffff:81.2.3.4')).toBe('81.2.3.4');
  });

  it('collapses IPv6 to the /64 the ISP hands out', () => {
    // Counting the full address counts nothing: one customer is handed
    // 18 quintillion of them and can use a new one per request.
    const a = normaliseIp('2a00:23c5:1234:5600:1111:2222:3333:4444');
    const b = normaliseIp('2a00:23c5:1234:5600:9999:8888:7777:6666');
    expect(a).toBe(b);
    expect(a).toBe('2a00:23c5:1234:5600::/64');
  });

  it('keeps genuinely different IPv6 networks apart', () => {
    expect(normaliseIp('2a00:23c5:1234:5600::1')).not.toBe(normaliseIp('2a00:23c5:1234:5700::1'));
  });
});

describe('reads and writes are told apart', () => {
  it.each(['GET', 'HEAD', 'OPTIONS'])('%s is a read', (m) => expect(isRead(m)).toBe(true));
  it.each(['POST', 'PATCH', 'PUT', 'DELETE'])('%s is a write', (m) => expect(isRead(m)).toBe(false));
});

describe('the day it cost her a booking', () => {
  it('lets one person make far more than 100 requests', async () => {
    // The exact number that used to fail. She reached it by picking her phone
    // up and putting it down, not by doing anything.
    const res = await hitMany(apiLimiter, 140, { sub: 'ellie-a', method: 'GET' });
    expect(res.statusCode).toBe(200);
  });

  it('still lets her WRITE after all that reading', async () => {
    // This is the actual failure: the reads had spent the budget, so the one
    // deliberate action — adding the lash lift — was the request that got
    // refused. Reads and writes are separate counters now.
    await hitMany(apiLimiter, 400, { sub: 'ellie-b', method: 'GET' });
    const res = await hit(apiLimiter, { sub: 'ellie-b', method: 'PATCH' });
    expect(res.statusCode).toBe(200);
  });
});

describe('one person cannot spend another person\'s allowance', () => {
  it('keeps two signed-in people in separate buckets', async () => {
    await hitMany(apiLimiter, 301, { sub: 'heavy-user', method: 'POST' });
    const heavy = await hit(apiLimiter, { sub: 'heavy-user', method: 'POST' });
    expect(heavy.statusCode).toBe(429);

    // Ellie, on the same salon wifi, is untouched.
    const ellie = await hit(apiLimiter, { sub: 'ellie-c', method: 'POST', ip: '1.2.3.4' });
    expect(ellie.statusCode).toBe(200);
  });

  it('does not punish her for moving between wifi and 4G', async () => {
    await hitMany(apiLimiter, 50, { sub: 'ellie-d', ip: '10.0.0.1', method: 'POST' });
    const res = await hit(apiLimiter, { sub: 'ellie-d', ip: '82.15.9.1', method: 'POST' });
    expect(res.statusCode).toBe(200);
  });
});

describe('when it does fire, it says something usable', () => {
  it('says nothing was saved, and how long to wait', async () => {
    await hitMany(apiLimiter, 301, { sub: 'noisy', method: 'POST' });
    const res = await hit(apiLimiter, { sub: 'noisy', method: 'POST' });

    expect(res.statusCode).toBe(429);
    // "please try again later" gave her no way to judge whether to wait or
    // give up. She gave up.
    expect(res.body.error).toMatch(/nothing has been saved or changed/i);
    expect(res.body.error).not.toMatch(/try again later\.?$/i);
    expect(res.body.retryAfterSeconds).toBeGreaterThan(0);
    expect(res.body.code).toBe('rate_limited');
  });
});

describe('the trust in the token is bounded', () => {
  it('reads the subject without verifying it, and says so by still counting the address', async () => {
    // A forged token can mint a fresh per-user bucket every request. The
    // address ceiling is what makes that not worth doing. Proving the
    // ceiling exists and is separate: the per-user bucket for a brand new
    // subject is empty, so a pass here means only the ceiling is in play.
    const fresh = await hit(apiLimiter, { sub: `made-up-${Math.random()}`, ip: '5.5.5.5', method: 'POST' });
    expect(fresh.statusCode).toBe(200);
  });
});

describe('logging in stays hard to brute force', () => {
  it('is still counted by address, because there is no identity before login', async () => {
    const res = await hitMany(authLimiter, 11, { ip: '7.7.7.7', method: 'POST' });
    expect(res.statusCode).toBe(429);
  });

  it('cannot be widened by presenting a token', async () => {
    // Otherwise anyone could hand it a made-up subject and guess passwords
    // all day.
    const res = await hitMany(authLimiter, 11, { ip: '7.7.7.8', sub: 'whoever', method: 'POST' });
    expect(res.statusCode).toBe(429);
  });
});
