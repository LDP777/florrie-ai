import pino from 'pino';

const isProd = process.env.NODE_ENV === 'production';

// Mask PII and secrets before they ever reach the log stream. Covers the common
// shapes used across this codebase: client phone numbers, SMS/WhatsApp from/to,
// auth tokens, verification codes, pins and OTPs.
const redactPaths = [
  'phone', '*.phone',
  'from', 'to', 'recipient', '*.recipient',
  'token', '*.token',
  'code', '*.code',
  'pin', '*.pin',
  'otp', '*.otp',
  'access_token', '*.access_token',
  'authorization', '*.authorization',
  'headers.authorization',
  'req.headers.authorization',
];

const logger = pino({
  level: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
  redact: { paths: redactPaths, censor: '[redacted]' },
  ...(isProd ? {} : { transport: { target: 'pino-pretty', options: { colorize: true } } }),
});

export default logger;
