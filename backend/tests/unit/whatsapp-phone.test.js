/**
 * Unit tests for whatsapp-config phone utilities and verify idempotency.
 *
 * Runs with node --test (built into Node 18+, no framework install needed).
 *   cd backend && node --test tests/unit/whatsapp-phone.test.js
 *
 * These cover the pure helpers that can be tested without mocking Supabase or
 * Meta's Graph API. The route-level integration tests belong in Playwright
 * (tests/e2e/) where a real database + HTTP stack is available.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

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

test('normalisePhone: UK mobile 07xxx becomes 447xxx', () => {
  assert.equal(normalisePhone('07903881459'), '447903881459');
});

test('normalisePhone: strips spaces and non-digits', () => {
  assert.equal(normalisePhone('+44 7903 881 459'), '447903881459');
  assert.equal(normalisePhone('(07903) 881-459'), '447903881459');
});

test('normalisePhone: leaves already-international numbers alone', () => {
  assert.equal(normalisePhone('+447903881459'), '447903881459');
  assert.equal(normalisePhone('12025550123'), '12025550123');
});

test('isValidE164: rejects too-short and too-long digit strings', () => {
  assert.equal(isValidE164('123'), false);
  assert.equal(isValidE164('1234567890123456'), false);
});

test('isValidE164: accepts valid UK mobile', () => {
  assert.equal(isValidE164('447903881459'), true);
});

test('isValidE164: rejects non-digits', () => {
  assert.equal(isValidE164('+447903881459'), false);
  assert.equal(isValidE164('44790abc1459'), false);
});

test('splitPhone: UK mobile splits into 44 cc + subscriber', () => {
  if (typeof splitPhone !== 'function') return;
  const out = splitPhone('447903881459');
  assert.equal(out.cc, '44');
  assert.equal(out.phone, '7903881459');
});

test('idempotencyKey: combines beauticianId + code deterministically', () => {
  assert.equal(idempotencyKey('abc', '123456'), 'abc:123456');
  assert.equal(idempotencyKey('abc', ' 123456 '), 'abc:123456');
});

test('cacheVerify + getCachedVerify: stores and replays response', () => {
  verifyIdempotencyCache.clear();
  const key = idempotencyKey('test-user', '111111');
  assert.equal(getCachedVerify(key), null);

  cacheVerify(key, 200, { success: true, phone: '447903881459' });
  const hit = getCachedVerify(key);
  assert.ok(hit);
  assert.equal(hit.status, 200);
  assert.equal(hit.body.success, true);
  assert.equal(hit.body.phone, '447903881459');
});

test('getCachedVerify: returns null and evicts after TTL', async () => {
  verifyIdempotencyCache.clear();
  const key = idempotencyKey('test-user', '222222');
  cacheVerify(key, 400, { error: 'Invalid code' });
  // Force expiry by rewriting the at timestamp to way in the past.
  const entry = verifyIdempotencyCache.get(key);
  entry.at = Date.now() - 10 * 60 * 1000;
  assert.equal(getCachedVerify(key), null);
  assert.equal(verifyIdempotencyCache.has(key), false);
});

test('cacheVerify: GC keeps map size bounded', () => {
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
  assert.ok(verifyIdempotencyCache.size <= 500);
});
