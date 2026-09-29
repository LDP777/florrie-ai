import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { voiceResultLinks } from './voice-result-links.js';

const firstClient = '12cbdf6b-6c38-4e91-8ad7-c179d3f35499';
const secondClient = '74617226-16dc-4697-9f3a-8df1758df290';

test('reads only recognised tools and tolerates malformed envelopes', () => {
  for (const value of [null, undefined, {}, 'check_schedule', 3]) assert.deepEqual(voiceResultLinks(value), []);
  assert.deepEqual(voiceResultLinks([null, false, [], {}, { tool: null }, { tool: 'toString' }, { tool: '__proto__' }, { tool: 'draft_content' }]), []);
});

test('deduplicates destinations and limits results to three in tool order', () => {
  const result = voiceResultLinks([
    { tool: 'check_schedule' }, { tool: 'get_upcoming_appointments' },
    { tool: 'get_revenue_summary' }, { tool: 'get_outstanding_payments' },
    { tool: 'get_florrie_brief' }, { tool: 'get_settings' },
  ]);
  assert.deepEqual(result.map(link => link.path), ['/calendar', '/money', '/insights']);
});

test('opens the actual day for valid dates, including leap days', () => {
  for (const date of ['2026-09-29', '2024-02-29', '2026-12-31']) {
    assert.deepEqual(voiceResultLinks([{ tool: 'check_schedule', data: { date } }]), [
      { label: 'Open this day', path: `/calendar/week?date=${date}&view=day` },
    ]);
  }
});

test('invalid dates use Calendar without copying payload text into the route', () => {
  for (const date of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-00-01', '0000-01-01', '2026-9-1', '2026-09-29T09:00:00Z', '2026-09-29&view=week', 'https://example.com', null, {}, 20260929]) {
    assert.deepEqual(voiceResultLinks([{ tool: 'check_schedule', data: { date } }]), [
      { label: 'Open Calendar', path: '/calendar' },
    ]);
  }
});

test('client lookup opens its validated record, deduping IDs case-insensitively', () => {
  const result = voiceResultLinks([
    { tool: 'get_client_info', data: { client: { id: firstClient.toUpperCase() } } },
    { tool: 'get_client_info', data: { client: { id: firstClient } } },
    { tool: 'get_client_info', data: { client: { id: secondClient } } },
  ]);
  assert.deepEqual(result, [
    { label: 'View client', path: '/clients', state: { clientId: firstClient } },
    { label: 'View client', path: '/clients', state: { clientId: secondClient } },
  ]);
});

test('malformed client IDs open the client directory without unsafe route state', () => {
  for (const id of [null, undefined, '', 'Ellie', '/clients?admin=true', `${firstClient}/other`, 123, {}, [firstClient]]) {
    assert.deepEqual(voiceResultLinks([{ tool: 'get_client_info', data: { client: { id } } }]), [
      { label: 'View Clients', path: '/clients' },
    ]);
  }
});

test('explicit errors and unsuccessful action/result/data envelopes produce no link', () => {
  const failures = [{ error: 'Unavailable' }, { success: false }, { ok: false }, { status: 'failed' }, { status: 'error' }, { status: 'failure' }];
  for (const failure of failures) {
    assert.deepEqual(voiceResultLinks([{ tool: 'check_schedule', ...failure }]), []);
    assert.deepEqual(voiceResultLinks([{ tool: 'check_schedule', data: failure }]), []);
    assert.deepEqual(voiceResultLinks([{ tool: 'check_schedule', result: failure }]), []);
  }
  assert.equal(voiceResultLinks([{ tool: 'check_schedule', error: null, success: true }]).length, 1);
});

test('care links lead to the corresponding working area', () => {
  assert.deepEqual(voiceResultLinks([
    { tool: 'check_patch_test' }, { tool: 'get_patch_tests_needed' },
    { tool: 'get_consultations_needed' }, { tool: 'get_florrie_brief' },
  ]).map(link => link.path), ['/patch-tests', '/consultation-forms', '/insights']);
});

test('ignores suggested paths, labels, client names and dates inferred only from input or text', () => {
  assert.deepEqual(voiceResultLinks([{
    tool: 'check_schedule', result: 'Open https://bad.example', input: { date: '2026-09-29' },
    path: '//bad.example', label: 'Unsafe', data: { path: '/unknown', url: 'https://bad.example' },
  }]), [{ label: 'Open Calendar', path: '/calendar' }]);
});

test('every supported tool destination exists as a registered app route', () => {
  const app = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');
  const routes = new Set([...app.matchAll(/<Route\s+path="([^"]+)"/g)].map(match => match[1]));
  const toolSource = readFileSync(new URL('../../../backend/src/services/voice-tools.js', import.meta.url), 'utf8');
  const tools = [...toolSource.split('export const TOOL_DEFINITIONS = [')[1].split('// ─')[0].matchAll(/name: '([^']+)'/g)].map(match => match[1]);
  assert.ok(tools.length > 20, 'read the real supported tool catalogue');
  for (const tool of tools) {
    const links = voiceResultLinks([{ tool }]);
    assert.equal(links.length, 1, `missing supported tool: ${tool}`);
    assert.ok(routes.has(links[0].path), `unregistered route: ${links[0].path}`);
  }
  assert.ok(routes.has('/calendar/week'));
});

test('returns fresh destinations without mutating actions or retaining caller mutations', () => {
  const action = Object.freeze({ tool: 'get_florrie_brief', data: Object.freeze({}) });
  const links = voiceResultLinks(Object.freeze([action]));
  links[0].path = '/changed';
  assert.equal(voiceResultLinks([action])[0].path, '/insights');
});
