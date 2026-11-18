import pino from 'pino';

const isProd = process.env.NODE_ENV === 'production';

// Redact structured fields at the root and inside request/provider envelopes.
// This cannot clean secrets embedded in arbitrary strings: callers must never
// log raw message text, URLs containing tokens, or whole provider responses.
const sensitiveFields = [
  'phone', 'email', 'first_name', 'last_name', 'client_name',
  'from', 'to', 'recipient', 'password', 'new_password', 'password_hash',
  'token', 'code', 'pin', 'otp', 'access_token', 'refresh_token', 'id_token',
  'authorization', 'cookie', 'set-cookie', 'client_secret', 'api_key',
  'service_role_key', 'signing_secret', 'encryption_key',
  'body', 'rawBody', 'message_content', 'consultation_answers', 'signature_data',
];
const redactPaths = ['', '*.', '*.*.', '*.*.*.'].flatMap(prefix =>
  sensitiveFields.map(field => `${prefix}[${JSON.stringify(field)}]`)
);

const logger = pino({
  level: process.env.LOG_LEVEL || (isProd ? 'info' : 'debug'),
  redact: { paths: redactPaths, censor: '[redacted]' },
  ...(isProd ? {} : { transport: { target: 'pino-pretty', options: { colorize: true } } }),
});

export default logger;
