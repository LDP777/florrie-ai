import rateLimit from 'express-rate-limit';

/**
 * Rate limits, and the one that cost Ellie a booking.
 *
 * WHAT HAPPENED. On 21 August Lucy Walker messaged: "I just realised I need to
 * add lash lift to this booking!" Ellie opened the appointment to add it — the
 * app can do this, it was built for exactly her request — and got a modal
 * saying "Too many requests, please try again later" with one OK button. She
 * tried again. Same. Her words: "It kept saying this when I tried doing it my
 * side. So I just added 30mins block out instead."
 *
 * She did not do anything unusual. The old limit was 100 requests per 15
 * minutes PER IP, shared by every authenticated route in the app. The badge
 * poll alone is 15 of those, and it also refires on every focus and every
 * visibilitychange — so each time she switched to WhatsApp to answer Lucy and
 * came back, that was another one. The SMS usage widget adds 30 more per
 * quarter hour on its own. Using the app the way the app asks to be used spent
 * the allowance, and then the thing she actually wanted to do was refused.
 *
 * Worse, keying on IP means her allowance is not even hers: a salon on one
 * wifi, or a phone behind carrier NAT, shares a single bucket with strangers.
 *
 * This is the SAME MISTAKE we already fixed on the public booking page, and the
 * comment below it has been sitting there describing it since. One tight
 * allowance, reads and writes together, keyed on something that is not the
 * person. Nobody carried the lesson across to the authenticated app.
 *
 * SO, THREE RULES HERE:
 *
 *   1. Count per PERSON, not per IP, whenever we can see who is asking.
 *   2. Reads are cheap and constant (polling, badges, page loads) — be
 *      generous. Writes are deliberate and human-paced — a tighter number
 *      still no real person can reach by hand.
 *   3. A limit that fires must say what to do, and must say how long. A dead
 *      end with an OK button is how a booking turns into a 30-minute block.
 */

/**
 * Who is asking.
 *
 * The limiter runs BEFORE the route's auth middleware, so there is no req.user
 * yet. The bearer token's `sub` is read without verifying the signature, which
 * is fine for the job it does here and NOT fine for anything else: this value
 * decides which counter to increment, never what anyone is allowed to see.
 *
 * A forged token could mint itself a fresh bucket, which is why ipCeiling
 * below still counts every request by address whatever the token says.
 */
export function identityOf(req) {
  const auth = req.headers?.authorization || '';
  const m = /^Bearer\s+([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*)$/.exec(auth.trim());
  if (m) {
    try {
      const payload = JSON.parse(Buffer.from(m[1].split('.')[1], 'base64url').toString('utf8'));
      if (payload?.sub) return `u:${payload.sub}`;
    } catch { /* not a readable JWT — fall through to the address */ }
  }
  return `ip:${normaliseIp(req.ip || req.socket?.remoteAddress || 'unknown')}`;
}

/**
 * One IPv6 address is one of 18 quintillion a client may rotate through freely,
 * so counting the full address counts nothing. Collapse to the /64 the ISP
 * actually hands out. IPv4 is already the unit it looks like.
 */
export function normaliseIp(ip) {
  const raw = String(ip).replace(/^::ffff:/, '');
  if (!raw.includes(':')) return raw;
  const groups = raw.split(':');
  return groups.slice(0, 4).join(':') + '::/64';
}

/** Reads do not change anything, and the app makes a lot of them. */
export function isRead(method) {
  return method === 'GET' || method === 'HEAD' || method === 'OPTIONS';
}

/**
 * What a 429 says.
 *
 * Two jobs. Tell the person it is temporary and roughly how long — "try again
 * later" gave Ellie no way to judge whether to wait or to give up, and she gave
 * up. And tell them nothing was saved, because the worst version of this is
 * someone assuming a half-finished write went through.
 */
function tooMany(res) {
  const retryAfter = Number(res.getHeader('Retry-After')) || 60;
  return {
    error: 'The app is asking for a lot at once. Nothing has been saved or changed — give it a moment and try again.',
    retryAfterSeconds: retryAfter,
    code: 'rate_limited',
  };
}

const handler = (req, res) => res.status(429).json(tooMany(res));

/**
 * The numbers.
 *
 * Reads: the app polls badges every 60s and refires on focus, so a busy hour
 * of picking the phone up and putting it down is already in the hundreds
 * without a single deliberate action. 1500 per quarter hour is 100 a minute,
 * which no human generates and no honest client needs to exceed.
 *
 * Writes: 300 per quarter hour is twenty a minute, sustained. Ellie editing a
 * booking makes one. A bulk import makes its own arrangements. Anything above
 * this is a loop, not a person.
 */
const WINDOW_MS = 15 * 60 * 1000;

const common = {
  windowMs: WINDOW_MS,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: identityOf,
  handler,
  // keyGenerator normalises the address itself, below.
  validate: { ip: false },
};

const appReadLimiter = rateLimit({ ...common, max: 1500 });
const appWriteLimiter = rateLimit({ ...common, max: 300 });

/**
 * The backstop, always by address, whatever the token claimed.
 *
 * identityOf trusts an unverified `sub`, so on its own it could be handed a
 * new name every request. This counts the connection instead. Set high enough
 * that a salon with several devices on one wifi never sees it, low enough that
 * a single machine cannot sit on the API all day.
 */
const ipCeiling = rateLimit({
  windowMs: WINDOW_MS,
  max: 4000,
  standardHeaders: false,
  legacyHeaders: false,
  keyGenerator: (req) => normaliseIp(req.ip || req.socket?.remoteAddress || 'unknown'),
  handler,
  validate: { ip: false },
});

/**
 * The general API limiter. Same export name and same mounting as before, so
 * every `app.use('/api/x', apiLimiter, ...)` line is untouched.
 */
export function apiLimiter(req, res, next) {
  ipCeiling(req, res, (err) => {
    if (err) return next(err);
    return (isRead(req.method) ? appReadLimiter : appWriteLimiter)(req, res, next);
  });
}

// Stricter limit for auth endpoints - 10 per 15 min.
// Deliberately still by address: there is no trustworthy identity before login,
// and guessing passwords is the thing this exists to slow down.
export const authLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => normaliseIp(req.ip || req.socket?.remoteAddress || 'unknown'),
  validate: { ip: false },
  message: { error: 'Too many login attempts, please try again later' },
});

// Public booking page.
//
// The old single limiter (30 req / 15 min per IP, reads and writes together)
// locked real clients out mid-booking: the page fires an availability fetch on
// every date tap, so one person browsing a couple of weeks burned the whole
// allowance, and mobile carrier NAT means many clients can share one IP. A
// client then hit "Too many booking requests" on the CONFIRM step and the
// availability fetches started failing too (which made the times look like
// they were jumping around).
//
// Split it: reads (availability, treatments, policy, reviews) are cheap and
// get a generous allowance; writes (creating the booking, validating codes)
// stay tight because that is where abuse would actually hurt.
//
// No identity here on purpose — the whole point of this page is that the
// client has no account.
const bookingReadLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => normaliseIp(req.ip || req.socket?.remoteAddress || 'unknown'),
  validate: { ip: false },
  message: { error: 'Lots of requests right now, give it a few seconds and try again' },
});

const bookingWriteLimiter = rateLimit({
  windowMs: WINDOW_MS,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => normaliseIp(req.ip || req.socket?.remoteAddress || 'unknown'),
  validate: { ip: false },
  message: { error: 'Lots of booking activity right now. Wait a minute and try again, your slot choice is not lost.' },
});

// Drop-in replacement keeping the old export name: route by method.
export function bookingLimiter(req, res, next) {
  const limiter = isRead(req.method) ? bookingReadLimiter : bookingWriteLimiter;
  return limiter(req, res, next);
}
