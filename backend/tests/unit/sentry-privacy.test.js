import { describe, expect, it } from 'vitest';
import { NodeClient } from '@sentry/node';
import { BrowserClient } from '@sentry/react';
import { readFileSync } from 'node:fs';
import { sentryPrivacyOptions, sentrySafeUrl } from '../../src/lib/sentry-privacy.js';
import { browserSentryOptions } from '../../../frontend/src/lib/sentry-options.js';

const SENTINEL = 'PRIVATE_CLIENT_MEDICAL_ANSWER';
const TOKEN = 'private-bearer-token-value';
const EMAIL = 'private.client@example.test';
const ID = '12345678-abcd-4321-9876-123456789abc';
const FRAME = { filename: 'https://florrie.ai/assets/index-abcdef.js', function: 'submitConsultation', lineno: 42, colno: 12, in_app: true };
const trace = { trace_id: '1234567890abcdef1234567890abcdef', span_id: '1234567890abcdef', op: 'http.server', status: 'internal_error' };

function privateEvent() {
  return {
    event_id: '1234567890abcdef1234567890abcdef',
    release: 'florrie@20260916', environment: 'production', level: 'error',
    message: 'Health check degraded',
    user: { id: ID, email: EMAIL, ip_address: '203.0.113.5' },
    request: {
      method: 'POST', url: `https://user:${TOKEN}@api.florrie.ai/api/consultation-forms/public/${TOKEN}?token=${TOKEN}#${TOKEN}`,
      headers: { Authorization: `Bearer ${TOKEN}`, Cookie: `session=${TOKEN}`, 'X-API-Key': TOKEN },
      cookies: { session: TOKEN }, query_string: `token=${TOKEN}`,
      data: { answers: { health: SENTINEL }, signature: SENTINEL }, env: { secret: TOKEN },
    },
    extra: {
      appointmentId: ID, status_code: 503, attemptCount: 2,
      dbError: `invalid input ${SENTINEL}`, reason: SENTINEL, request: { password: TOKEN },
      messages: [SENTINEL], voice: { transcript: SENTINEL, audio: TOKEN },
      answers: { health: SENTINEL }, rawError: { data: SENTINEL },
    },
    tags: { area: 'booking', check: 'consultation_save', email: EMAIL, transcript: SENTINEL },
    contexts: { trace, voice: { transcript: SENTINEL }, browser: { name: 'Safari', version: '18.0', user_email: EMAIL } },
    exception: { values: [{ type: 'Error', value: `Provider rejected ${SENTINEL} from ${EMAIL}`, mechanism: { type: 'generic', handled: true, data: { private: SENTINEL } }, stacktrace: { frames: [{ ...FRAME, vars: { answers: SENTINEL }, pre_context: [SENTINEL], context_line: SENTINEL, post_context: [SENTINEL] }] } }] },
    breadcrumbs: [
      { category: 'console', level: 'error', message: SENTINEL, data: { arguments: [{ answers: SENTINEL }] } },
      { category: 'ui.click', message: `button[title="${EMAIL}"]`, data: { target: SENTINEL } },
      { category: 'navigation', data: { from: `/form/${TOKEN}?answer=${SENTINEL}`, to: `/inbox?client=${EMAIL}` } },
      { category: 'fetch', data: { method: 'POST', url: `https://api.florrie.ai/api/voice?access_token=${TOKEN}`, status_code: 503, body: SENTINEL } },
    ],
    fingerprint: [SENTINEL], _meta: { original_value: SENTINEL },
    sdkProcessingMetadata: { dynamicSamplingContext: { transaction: SENTINEL, user_segment: EMAIL } },
  };
}

function harness(Client, options) {
  const envelopes = [];
  const client = new Client({
    dsn: 'https://public@sentry.example.test/1',
    integrations: [], stackParser: () => [], sendClientReports: false,
    normalizeDepth: 10,
    transport: () => ({
      send(envelope) { envelopes.push(structuredClone(envelope)); return Promise.resolve({ statusCode: 200 }); },
      flush() { return Promise.resolve(true); },
    }),
    ...options,
  });
  client.init();
  return { client, envelopes };
}

describe.each([
  ['backend', NodeClient, sentryPrivacyOptions],
  ['browser', BrowserClient, browserSentryOptions({ dsn: 'https://public@sentry.example.test/1', environment: 'test', integrations: [] })],
])('%s Sentry export hooks', (_name, Client, options) => {
  it('scrubs the final SDK envelope, retaining the failure, release and stack diagnostics', async () => {
    const { client, envelopes } = harness(Client, options);
    const event = privateEvent();
    client.captureEvent(event, { attachments: [{ filename: 'consultation.txt', data: SENTINEL }] });
    expect(await client.flush(2000)).toBe(true);
    const items = envelopes.flatMap(envelope => envelope[1]);
    const exported = items.find(([header]) => header.type === 'event')?.[1];
    expect(exported).toBeDefined();
    const raw = JSON.stringify(envelopes);
    for (const sensitive of [SENTINEL, TOKEN, EMAIL, '203.0.113.5']) expect(raw).not.toContain(sensitive);
    expect(items.some(([header]) => header.type === 'attachment')).toBe(false);
    expect(exported).toMatchObject({
      event_id: event.event_id, release: event.release, level: 'error', message: 'Health check degraded',
      request: { method: 'POST', url: 'https://api.florrie.ai/api/consultation-forms/public/[Filtered]' },
      tags: { area: 'booking', check: 'consultation_save' },
      extra: { appointmentId: ID, status_code: 503, attemptCount: 2 },
      contexts: { trace, browser: { name: 'Safari', version: '18.0' } },
      exception: { values: [{ type: 'Error', value: '[Filtered]', stacktrace: { frames: [FRAME] } }] },
    });
    expect(exported.request).not.toHaveProperty('headers');
    expect(exported).not.toHaveProperty('user');
    // The filter must not erase the caller's live request or client data.
    expect(event.request.data.answers.health).toBe(SENTINEL);
    await client.close();
  });

  it('also scrubs performance transactions, database/AI spans and token-bearing navigation names', async () => {
    const { client, envelopes } = harness(Client, options);
    client.captureEvent({
      ...privateEvent(), type: 'transaction', transaction: `GET /book/demo/manage/${TOKEN}?token=${TOKEN}`,
      start_timestamp: 1750000000, timestamp: 1750000001,
      spans: [
        { ...trace, start_timestamp: 1750000000, timestamp: 1750000001, op: 'db', description: `INSERT answers ${SENTINEL}`, data: { 'db.statement': SENTINEL } },
        { ...trace, start_timestamp: 1750000000, timestamp: 1750000001, op: 'gen_ai', description: SENTINEL, data: { 'gen_ai.prompt': SENTINEL, 'gen_ai.completion': SENTINEL } },
        { ...trace, start_timestamp: 1750000000, timestamp: 1750000001, op: 'http.client', description: `POST https://api.florrie.ai/api/voice?token=${TOKEN}`, data: { 'http.response.status_code': 503, 'http.request.body': SENTINEL } },
      ],
      measurements: { lcp: { value: 230, unit: 'millisecond' }, [SENTINEL]: { value: 10 } },
    });
    await client.flush(2000);
    const exported = envelopes.flatMap(envelope => envelope[1]).find(([header]) => header.type === 'transaction')?.[1];
    expect(exported).toBeDefined();
    for (const sensitive of [SENTINEL, TOKEN, EMAIL]) expect(JSON.stringify(envelopes)).not.toContain(sensitive);
    expect(exported.transaction).toBe('GET /book/demo/manage/[Filtered]');
    expect(exported.spans).toHaveLength(3);
    expect(exported.spans[0]).toMatchObject({ op: 'db', timestamp: 1750000001, data: {} });
    expect(exported.spans[2]).toMatchObject({ description: 'POST https://api.florrie.ai/api/voice', data: { 'http.response.status_code': 503 } });
    expect(exported.measurements).toEqual({ lcp: { value: 230, unit: 'millisecond' } });
    await client.close();
  });
});

describe('Sentry policy edge cases and application wiring', () => {
  it.each([
    [`/book/demo/manage/${ID}`, '/book/demo/manage/[Filtered]'],
    [`/form/short-secret?email=${EMAIL}`, '/form/[Filtered]'],
    [`https://api.florrie.ai/api/calendar/feed/${TOKEN}.ics`, 'https://api.florrie.ai/api/calendar/feed/[Filtered]'],
    [`https://api.florrie.ai/storage/v1/object/public/photos/${EMAIL}.jpg`, 'https://api.florrie.ai/[Filtered]'],
    [`https://florrie.ai/auth/callback?code=${TOKEN}#access_token=${TOKEN}`, 'https://florrie.ai/auth/callback'],
    [`https://graph.facebook.com/v25.0/1234567890123/messages?access_token=${TOKEN}`, 'https://graph.facebook.com/v25.0/[Filtered]/messages'],
    ['data:text/plain,private', '[Filtered]'],
    ['/app/src/routes/consultation-booking-care.js', '/app/src/routes/consultation-booking-care.js'],
  ])('removes credentials from %s', (url, expected) => expect(sentrySafeUrl(url)).toBe(expected));

  it('preserves useful standard error classes without the echoed client value', () => {
    const event = sentryPrivacyOptions.beforeSend({ exception: { values: [{ type: 'TypeError', value: `Cannot read properties of undefined (reading '${SENTINEL}')` }] } });
    expect(event.exception.values[0]).toEqual({ type: 'TypeError', value: 'Cannot read properties of undefined' });
  });

  it('keeps existing browser noise filters without dropping an actionable application error', () => {
    const options = browserSentryOptions({});
    expect(options.beforeSend(privateEvent(), { originalException: new DOMException('Cancelled', 'AbortError') })).toBeNull();
    expect(options.beforeSend({ message: 'ResizeObserver loop limit exceeded' })).toBeNull();
    expect(options.beforeSend(privateEvent())).not.toBeNull();
    expect(options.beforeBreadcrumb({ category: 'console', message: SENTINEL, data: { arguments: [SENTINEL] } })).toEqual({ category: 'console', message: '[Filtered]', data: {} });
  });

  it('uses the tested policy in both real initializers and opts out of backend body/local capture', () => {
    const backend = readFileSync(new URL('../../src/index.js', import.meta.url), 'utf8');
    const frontend = readFileSync(new URL('../../../frontend/src/main.jsx', import.meta.url), 'utf8');
    expect(backend).toContain('...sentryPrivacyOptions');
    expect(backend).toContain("Sentry.httpIntegration({ maxIncomingRequestBodySize: 'none' })");
    expect(backend).toContain('includeLocalVariables: false');
    expect(frontend).toContain('Sentry.init(browserSentryOptions({');
    expect(sentryPrivacyOptions.sendDefaultPii).toBe(false);
  });
});
