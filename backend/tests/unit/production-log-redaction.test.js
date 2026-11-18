import { expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';

it('redacts secrets and client fields from real production log output', () => {
  const moduleUrl = new URL('../../src/lib/logger.js', import.meta.url).href;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', `
    import logger from ${JSON.stringify(moduleUrl)};
    logger.info({
      email: 'private-email-sentinel', password: 'private-password-sentinel',
      phone: 'private-phone-sentinel', status: 503, operation: 'provider_refresh',
      req: { headers: { authorization: 'private-bearer-sentinel', cookie: 'private-cookie-sentinel' }, body: { answers: 'private-health-sentinel' } },
      provider: { auth: { credentials: { refresh_token: 'private-refresh-sentinel', client_secret: 'private-secret-sentinel' } } },
      response: { headers: { 'set-cookie': 'private-session-sentinel' } },
      client: { first_name: 'private-name-sentinel' },
    }, 'Connection unavailable');
  `], { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production', LOG_LEVEL: 'info' } });
  expect(output).not.toContain('private-');
  const entry = JSON.parse(output.trim());
  expect(entry.msg).toBe('Connection unavailable');
  expect(entry.status).toBe(503);
  expect(entry.operation).toBe('provider_refresh');
  expect(entry.req.headers.authorization).toBe('[redacted]');
  expect(entry.req.body).toBe('[redacted]');
  expect(entry.provider.auth.credentials.refresh_token).toBe('[redacted]');
});
