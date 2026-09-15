import { createHmac, timingSafeEqual, createHash } from 'node:crypto';

export class InvalidMetaRequest extends Error {}

// Meta signs the encoded payload, not JSON re-serialised after decoding.
export function verifyMetaSignedRequest(value, secret, now = Date.now()) {
  if (!secret) throw new Error('Instagram callback verification is not configured');
  const fail = () => { throw new InvalidMetaRequest('Invalid signed request'); };
  if (typeof value !== 'string' || value.length > 16384) fail();
  const parts = value.split('.');
  if (parts.length !== 2 || parts.some(part => !/^[A-Za-z0-9_-]+={0,2}$/.test(part))) fail();
  const [signature, encoded] = parts;
  const received = Buffer.from(signature, 'base64url');
  const expected = createHmac('sha256', secret).update(encoded).digest();
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) fail();
  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch { fail(); }
  if (!payload || payload.algorithm !== 'HMAC-SHA256'
    || typeof payload.user_id !== 'string' || !/^\d{1,40}$/.test(payload.user_id)
    || !Number.isSafeInteger(payload.issued_at) || payload.issued_at <= 0
    || payload.issued_at > Math.floor(now / 1000) + 300) fail();
  // Old, authentic callbacks remain retryable. The database compares issued_at
  // with the connection time so a replay cannot revoke a newer connection.
  return {
    accountHash: createHash('sha256').update('instagram:' + payload.user_id).digest('hex'),
    issuedAt: new Date(payload.issued_at * 1000).toISOString(),
    eventHash: createHash('sha256').update(encoded).digest('hex'),
  };
}
