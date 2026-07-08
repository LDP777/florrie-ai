import rateLimit from 'express-rate-limit';

// General API rate limit - 100 requests per 15 min per IP
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' }
});

// Stricter limit for auth endpoints - 10 per 15 min
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts, please try again later' }
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
const bookingReadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Lots of requests right now, give it a few seconds and try again' }
});

const bookingWriteLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Lots of booking activity right now. Wait a minute and try again, your slot choice is not lost.' }
});

// Drop-in replacement keeping the old export name: route by method.
export function bookingLimiter(req, res, next) {
  const limiter = (req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS')
    ? bookingReadLimiter
    : bookingWriteLimiter;
  return limiter(req, res, next);
}
