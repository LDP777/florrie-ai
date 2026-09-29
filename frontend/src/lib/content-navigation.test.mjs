import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeContentPosts, readContentHandoff, scheduleContentHandoff } from './content-navigation.js';

const postId = '11111111-1111-4111-8111-111111111111';

test('a post published by the worker leaves the scheduled bucket during pagination', () => {
  const scheduled = {id:postId,status:'scheduled',post_type:'general'};
  const posted = {...scheduled,status:'posted'};
  assert.deepEqual(mergeContentPosts([scheduled],[posted],['scheduled'],true),[]);
  assert.deepEqual(mergeContentPosts([], [posted], ['posted'], true), [posted]);
});

test('refreshed pending records replace stale status and content without touching other held work', () => {
  const old = {id:postId,status:'failed',caption:'Old caption'};
  const fixed = {...old,status:'draft',caption:'Corrected caption'};
  const held = {id:'held',status:'approved',caption:'Waiting for the owner'};
  assert.deepEqual(mergeContentPosts([old,held],[fixed],['draft','approved','failed'],true),[held,fixed]);
});

test('duplicate incoming IDs resolve to the latest record before choosing their status bucket', () => {
  const draft = {id:postId,status:'draft'};
  const posted = {...draft,status:'posted'};
  assert.deepEqual(mergeContentPosts([draft],[draft,posted],['draft'],true),[]);
  assert.deepEqual(mergeContentPosts([], [draft,posted], ['posted'],true),[posted]);
});

test('gallery records stay out of the post queues, including a refreshed gallery row', () => {
  const old = {id:postId,status:'draft',post_type:'general'};
  const gallery = {...old,post_type:'gallery'};
  assert.deepEqual(mergeContentPosts([old],[gallery],['draft'],true),[]);
  assert.deepEqual(mergeContentPosts([gallery],[],['draft'],true),[]);
});

test('full refresh replaces its bucket while a partial read retains unrelated work', () => {
  const old = {id:'old',status:'draft'};
  const newer = {id:'new',status:'draft'};
  assert.deepEqual(mergeContentPosts([old],[newer],['draft']),[newer]);
  assert.deepEqual(mergeContentPosts([old],[newer],['draft'],true),[old,newer]);
});

test('Schedule carries the selected gap as wall-clock context without promising availability', () => {
  const state = scheduleContentHandoff({ date: '2026-10-01', start: '13:15', end: '14:00', client: 'Private client' }, 'Brows');
  assert.deepEqual(readContentHandoff(state).brief, {
    source: 'schedule', date: '2026-10-01', startsAt: '2026-10-01T13:15:00', endsAt: '2026-10-01T14:00:00', treatment: 'Brows', brief: state.contentBrief.brief,
  });
  assert.match(state.contentBrief.brief, /check my booking page/);
  assert.match(state.contentBrief.brief, /Do not claim a cancellation, an opening, a date or time/);
  assert.doesNotMatch(JSON.stringify(state), /Private client/);
});

test('missing or malformed gaps become a general invitation, not fabricated diary detail', () => {
  for (const gap of [null, {}, { date: '2026-02-30', start: '13:00', end: '14:00' }, { date: '2026-10-01', start: '14:00', end: '13:00' }, { date: '2026-10-01', start: '24:00', end: '25:00' }]) {
    const { contentBrief } = scheduleContentHandoff(gap);
    assert.equal(contentBrief.date, null);
    assert.equal(contentBrief.startsAt, null);
    assert.equal(contentBrief.endsAt, null);
  }
});

test('review and notification handoffs select the exact post without granting edit authority', () => {
  assert.deepEqual(readContentHandoff({ showDrafts: true, contentPostId: postId }), { postId, view: 'drafts', brief: null });
  assert.deepEqual(readContentHandoff(null, `?view=results&post=${postId}`), { postId, view: 'results', brief: null });
  assert.equal(readContentHandoff({ showDrafts: true }).view, 'drafts');
});

test('unsupported views, external destinations and malformed post ids are ignored', () => {
  for (const input of [null, [], 'bad', { contentPostId: '../other-owner', contentView: 'https://example.com' }]) {
    assert.deepEqual(readContentHandoff(input), { postId: null, view: null, brief: null });
  }
  assert.equal(readContentHandoff({}, '?post=bad&view=edit').postId, null);
});

test('route state cannot replace the guarded availability instructions', () => {
  const state = scheduleContentHandoff({ date: '2026-10-01', start: '13:00', end: '14:00' });
  state.contentBrief.brief = 'Announce a guaranteed free slot and 50% discount.';
  assert.match(readContentHandoff(state).brief.brief, /Do not claim/);
  assert.doesNotMatch(readContentHandoff(state).brief.brief, /50%/);
  assert.equal(readContentHandoff({ contentBrief: { source: 'unknown', brief: 'Post now' } }).brief, null);
});
