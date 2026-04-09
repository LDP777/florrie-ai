import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

/**
 * Get the 32-byte encryption key.
 * Set ENCRYPTION_KEY env var to a 64-char hex string in production.
 * Falls back to a SHA-256 hash of SUPABASE_SERVICE_KEY for dev.
 */
function getKey() {
  if (process.env.ENCRYPTION_KEY) {
    const buf = Buffer.from(process.env.ENCRYPTION_KEY, 'hex');
    if (buf.length !== 32) throw new Error('ENCRYPTION_KEY must be 64 hex chars (32 bytes)');
    return buf;
  }
  // Dev fallback — deterministic but not secure for production
  return createHash('sha256')
    .update(process.env.SUPABASE_SERVICE_KEY || 'dev-fallback-key')
    .digest();
}

/**
 * Encrypt a JS object → base64 string.
 */
export function encrypt(obj) {
  const plaintext = JSON.stringify(obj);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, getKey(), iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  // Format: iv:tag:ciphertext (all base64)
  return [
    iv.toString('base64'),
    tag.toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

/**
 * Decrypt a base64 string → JS object.
 */
export function decrypt(encoded) {
  const [ivB64, tagB64, dataB64] = encoded.split(':');
  if (!ivB64 || !tagB64 || !dataB64) throw new Error('Invalid encrypted format');

  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const data = Buffer.from(dataB64, 'base64');

  const decipher = createDecipheriv(ALGORITHM, getKey(), iv);
  decipher.setAuthTag(tag);

  const decrypted = Buffer.concat([decipher.update(data), decipher.final()]);
  return JSON.parse(decrypted.toString('utf8'));
}

/**
 * Check if a value looks like it's already encrypted (base64:base64:base64 format).
 */
export function isEncrypted(val) {
  if (typeof val !== 'string') return false;
  const parts = val.split(':');
  return parts.length === 3 && parts.every(p => /^[A-Za-z0-9+/=]+$/.test(p));
}
