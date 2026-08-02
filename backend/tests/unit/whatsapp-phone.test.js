/**
 * whatsapp-config phone utilities and verify idempotency.
 *
 *   cd backend && npm test
 *
 * These cover the pure helpers that can be tested without mocking Supabase or
 * Meta's Graph API. The route-level integration tests belong in Playwright
 * (frontend/tests/) where a real database and HTTP stack is available.
 */

import { describe, it, expect } from 'vitest';

// The module reads WHATSAPP_TOKEN/WABA_ID at import time. Stub them so the
// import doesn't warn on boot.
process.env.WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || 'test-token';
process.env.WHATSAPP_WABA_ID = process.env.WHATSAPP_WABA_ID || 'test-waba';
process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'http://localhost';
process.env.SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || 'test';

const { _whatsappInternals } = await import('../../src/routes/whatsapp-config.js');
const {
  normalisePhone,
  isValidE164,
  splitPhone,
  idempotencyKey,
  getCachedVerify,
  cacheVerify,
  verifyIdempotencyCache,
} = _whatsappInternals;

describe('whatsapp phone helpers', () => {
  it('normalisePhone: UK mobile 07xxx becomes 447xxx', () => {
    expect(normalisePhone('07903881459')).toBe('447903881459');
  });

  it('normalisePhone: strips spaces and non-digits', () => {
    expect(normalisePhone('+44 7903 881 459')).toBe('447903881459');
    expect(normalisePhone('(07903) 881-459')).toBe('447903881459');
  });

  it('normalisePhone: leaves already-international numbers alone', () => {
    expect(normalisePhone('+447903881459')).toBe('447903881459');
    expect(normalisePhone('12025550123')).toBe('12025550123');
  });

  it('isValidE164: rejects too-short and too-long digit strings', () => {
    expect(isValidE164('123')).toBe(false);
    expect(isValidE164('1234567890123456')).toBe(false);
  });

  it('isValidE164: accepts valid UK mobile', () => {
    expect(isValidE164('447903881459')).toBe(true);
  });

  it('isValidE164: rejects non-digits', () => {
    expect(isValidE164('+447903881459')).toBe(false);
    expect(isValidE164('44790abc1459')).toBe(false);
  });

  it('splitPhone: UK mobile splits into 44 cc + subscriber', () => {
    // The field is `number`, not `phone`. This assertion had been wrong since
    // it was written and nobody knew, because the file could not be loaded by
    // either runner. That is the entire argument for making `npm test` work.
    const out = splitPhone('447903881459');
    expect(out.cc).toBe('44');
    expect(out.number).toBe('7903881459');
  });

  it('idempotencyKey: combines beauticianId + code deterministically', () => {
    expect(idempotencyKey('abc', '123456')).toBe('abc:123456');
    expect(idempotencyKey('abc', ' 123456 ')).toBe('abc:123456');
  });

  it('cacheVerify + getCachedVerify: stores and replays response', () => {
    verifyIdempotencyCache.clear();
    const key = idempotencyKey('test-user', '111111');
    expect(getCachedVerify(key)).toBe(null);

    cacheVerify(key, 200, { success: true, phone: '447903881459' });
    const hit = getCachedVerify(key);
    expect(hit).toBeTruthy();
    expect(hit.status).toBe(200);
    expect(hit.body.success).toBe(true);
    expect(hit.body.phone).toBe('447903881459');
  });

  it('getCachedVerify: returns null and evicts after TTL', async () => {
    verifyIdempotencyCache.clear();
    const key = idempotencyKey('test-user', '222222');
    cacheVerify(key, 400, { error: 'Invalid code' });
    // Force expiry by rewriting the at timestamp to way in the past.
    const entry = verifyIdempotencyCache.get(key);
    entry.at = Date.now() - 10 * 60 * 1000;
    expect(getCachedVerify(key)).toBe(null);
    expect(verifyIdempotencyCache.has(key)).toBe(false);
  });

  it('cacheVerify: GC keeps map size bounded', () => {
    verifyIdempotencyCache.clear();
    for (let i = 0; i < 510; i++) {
      const k = idempotencyKey('gc', String(i));
      cacheVerify(k, 200, { i });
      // Age out everything written so far.
      if (i < 505) {
        const entry = verifyIdempotencyCache.get(k);
        if (entry) entry.at = Date.now() - 10 * 60 * 1000;
      }
    }
    // GC runs at size > 500 on next write, pruning aged entries.
    expect(verifyIdempotencyCache.size <= 500).toBeTruthy();
  });
});
