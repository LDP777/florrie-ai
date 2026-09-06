import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getVisibleCategories, searchCategories, readRecentPages } from './more-catalog.js';
import { ROTA_KEYS, weekDates, localDateKey, effectiveShift, validShift } from './staff-rota-model.js';

const paths = categories => categories.flatMap(category => category.items.map(item => item.path));
const storageWith = value => ({ getItem: () => JSON.stringify(value) });

// These are the destinations available before the More reorganisation. Moving
// a tool between groups must not remove its route or strand an existing user.
const existingDestinations = [
  '/inbox', '/outbox', '/clients', '/money', '/calendar/week', '/waitlist-pro',
  '/end-of-day', '/hours', '/notifications', '/setup', '/settings', '/whatsapp',
  '/sms', '/whatsapp/templates', '/portal', '/automations', '/knowledge', '/pricing',
  '/import', '/reviews', '/memberships', '/loyalty', '/treatments', '/addons',
  '/price-list', '/aftercare', '/compliance', '/patch-tests', '/consultation-forms',
  '/photo-consent', '/analytics', '/expenses', '/packages', '/deposits', '/vouchers',
  '/promos', '/cancellations', '/content', '/campaigns', '/rebook', '/team', '/rota',
  '/staff-performance', '/locations',
];

test('More retains all 44 existing destinations and each still has an application route', () => {
  const cataloguePaths = paths(getVisibleCategories());
  assert.equal(cataloguePaths.length, 44);
  assert.equal(new Set(cataloguePaths).size, 44, 'A duplicate must not hide a missing destination');
  assert.deepEqual([...cataloguePaths].sort(), [...existingDestinations].sort());
  const app = readFileSync(new URL('../App.jsx', import.meta.url), 'utf8');
  const routes = new Set([...app.matchAll(/<Route\s+path="([^"]+)"/g)].map(match => match[1]));
  for (const path of existingDestinations) assert.ok(routes.has(path), `More destination has no route: ${path}`);
});

test('clients can find renamed care tools using the old name or the task they need', () => {
  const catalogue = getVisibleCategories();
  for (const [query, expected] of [
    ['  GUARDIAN  ', '/compliance'],
    ['form   builder', '/consultation-forms'],
    ['consultation forms', '/consultation-forms'],
    ['photo consent', '/photo-consent'],
    ['outbox', '/outbox'],
    ['income', '/money'],
  ]) assert.ok(paths(searchCategories(catalogue, query)).includes(expected), `No useful result for ${query}`);
  assert.equal(paths(searchCategories(catalogue, '   ')).length, 44);
  assert.deepEqual(searchCategories(catalogue, 'nonexistent-zebra-tool'), []);
});

test('old or malformed recent history cannot break More or resurrect retired links', () => {
  const catalogue = getVisibleCategories();
  for (const invalid of [null, {}, 123, 'a string']) {
    assert.deepEqual(readRecentPages(catalogue, storageWith(invalid)), []);
  }
  assert.deepEqual(readRecentPages(catalogue, { getItem: () => '{broken JSON' }), []);
  assert.deepEqual(readRecentPages(catalogue, { getItem() { throw new Error('Storage access blocked'); } }), []);
  const recent = readRecentPages(catalogue, storageWith([
    null, { path: '/retired' }, { path: '/compliance', label: 'Old Guardian label', matIcon: 'invalid' },
    { path: '/compliance' }, { path: '/consultation-forms' },
  ]));
  assert.deepEqual(recent.map(item => item.path), ['/compliance', '/consultation-forms']);
  assert.equal(recent[0].label, 'Client checks', 'Use the current catalogue label, not persisted UI text');
});

test('recent history keeps six distinct destinations in visit order', () => {
  const visited = existingDestinations.slice(0, 8);
  const recent = readRecentPages(getVisibleCategories(), storageWith(visited.map(path => ({ path }))));
  assert.deepEqual(recent.map(item => item.path), visited.slice(0, 6));
});

test('a pricing link saved on web stays hidden in iOS search and recent history', () => {
  const savedOnWeb = storageWith([{ path: '/pricing' }, { path: '/settings' }]);
  assert.deepEqual(readRecentPages(getVisibleCategories(false), savedOnWeb).map(item => item.path), ['/pricing', '/settings']);
  const ios = getVisibleCategories(true);
  assert.equal(paths(ios).length, 43);
  assert.ok(!paths(ios).includes('/pricing'));
  assert.ok(!paths(searchCategories(ios, 'billing')).includes('/pricing'));
  assert.deepEqual(readRecentPages(ios, savedOnWeb).map(item => item.path), ['/settings']);
});

test('opening the rota on Sunday includes that Sunday in the current week', () => {
  const dates = weekDates(0, new Date(2026, 8, 6, 12));
  assert.deepEqual(dates.map(localDateKey), [
    '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03',
    '2026-09-04', '2026-09-05', '2026-09-06',
  ]);
  assert.equal(localDateKey(weekDates(1, new Date(2026, 8, 6, 12))[0]), '2026-09-07');
  assert.equal(localDateKey(weekDates(-1, new Date(2026, 8, 6, 12))[6]), '2026-08-30');
  const sundayWorker = { is_active: true, working_hours: { sun: { start: '10:00', end: '14:30' } } };
  assert.equal(effectiveShift(sundayWorker, 'sun', dates[6]).hours, 4.5);
});

test('weekly scheduled totals include Sunday, exclude inactive staff and respect salon exceptions', () => {
  const dates = weekDates(0, new Date(2026, 8, 6, 12));
  const schedule = {
    mon: { start: '09:00', end: '17:00' },
    tue: { start: '09:00', end: '17:00' },
    sun: { start: '10:00', end: '14:30' },
  };
  const team = [
    { is_active: true, working_hours: schedule },
    { is_active: false, working_hours: schedule },
  ];
  const exceptions = [
    { date: '2026-08-31', type: 'closed' },
    { date: '2026-09-01', type: 'amended', start_time: '11:00:00', end_time: '15:30:00' },
    { date: '2026-09-07', type: 'closed' }, // Next week's closure must not affect this one.
  ];
  const shifts = team.flatMap(member => ROTA_KEYS.map((day, index) => effectiveShift(member, day, dates[index], exceptions)));
  assert.equal(shifts.reduce((sum, shift) => sum + shift.hours, 0), 9);
  assert.equal(effectiveShift(team[1], 'sun', dates[6], exceptions).label, 'Inactive');
});

test('legacy partial time off removes only the overlap and extended salon hours do not lengthen a staff shift', () => {
  const sunday = new Date(2026, 8, 6, 12);
  const member = { is_active: true, working_hours: { sun: { start: '09:00', end: '17:00' } } };
  const partial = [{ date: '2026-09-06', type: 'time-off', start_time: '12:00', end_time: '13:30' }];
  assert.deepEqual(effectiveShift(member, 'sun', sunday, partial), { label: '09:00–12:00, 13:30–17:00', hours: 6.5 });
  assert.equal(effectiveShift(member, 'sun', sunday, [
    { date: '2026-09-06', type: 'extended', start_time: '07:00', end_time: '21:00' },
  ]).hours, 8);
});

test('invalid saved schedules and salon changes remain unknown rather than counting as zero', () => {
  const sunday = new Date(2026, 8, 6, 12);
  const member = { is_active: true, working_hours: { sun: { start: '17:00', end: '09:00' } } };
  assert.equal(validShift(member.working_hours.sun), false);
  assert.equal(effectiveShift(member, 'sun', sunday).hours, null);
  member.working_hours.sun = { start: '09:00', end: '17:00' };
  assert.equal(validShift(member.working_hours.sun), true);
  assert.equal(effectiveShift(member, 'sun', sunday, [
    { date: '2026-09-06', type: 'amended', start_time: 'bad', end_time: '14:00' },
  ]).hours, null);
});

test('a holiday saved as one date range removes each affected shift including Sunday and both boundaries', () => {
  const dates = weekDates(0, new Date(2026, 8, 6, 12));
  const member = { is_active: true, working_hours: Object.fromEntries(ROTA_KEYS.map(day => [day, { start: '09:00', end: '17:00' }])) };
  const holiday = [{ date: '2026-09-04', end_date: '2026-09-07', type: 'closed' }];
  assert.deepEqual(ROTA_KEYS.map((day, i) => effectiveShift(member, day, dates[i], holiday).hours), [8, 8, 8, 8, 0, 0, 0]);
  assert.equal(effectiveShift(member, 'mon', new Date(2026, 8, 7, 12), holiday).hours, 0);
  assert.equal(effectiveShift(member, 'tue', new Date(2026, 8, 8, 12), holiday).hours, 8);
});
