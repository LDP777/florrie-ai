import { beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
vi.mock('../../src/config.js', () => ({ supabase: {} }));
import { createContentV2Publisher } from '../../src/services/content-v2/publish.js';
import { materialHash } from '../../src/services/content-v2/state.js';
import { googlePostBody, createGooglePosts } from '../../src/services/google-posts.js';

// Column truth follows 001, backend025, and the additive Content v2 migration.
const COLUMNS = {
  content_posts: ['id','beautician_id','caption','hashtags','media','image_url','link_url','platform','format','kind','post_type','status','approved_at','approved_hash','material_hash','version','publish_key','publish_claimed_at','publish_uncertain_since','publish_attempts','external_post_id','posted_at','published_by_owner','failure_reason','facts','held','change_note','scheduled_for','deleted_at'],
  beauticians: ['id','content_v2','instagram_page_id','instagram_page_token','instagram_token_expires_at'],
  ai_actions: ['beautician_id','action_type','digital_employee','summary','details','confidence','autonomous','outcome'],
};
function database(tables) {
  const db = { tables, fail: null, beforeUpdate: null };
  db.from = table => {
    const filters = []; let payload, insert = false, invalid, one = false;
    const validate = columns => { for (const name of columns) if (!COLUMNS[table]?.includes(name)) invalid = { code: '42703', message: `${table}.${name} does not exist` }; };
    const settle = () => {
      if (invalid) return { data: null, error: invalid };
      if (db.fail?.(table, payload)) return { data: null, error: { message: 'Fictional database outage' } };
      if (payload && db.beforeUpdate) { const fn = db.beforeUpdate; db.beforeUpdate = null; fn(); }
      let rows = (tables[table] || []).filter(row => filters.every(filter => filter(row)));
      if (insert) { (tables[table] ||= []).push(payload); rows = [payload]; }
      else if (payload) rows.forEach(row => Object.assign(row, payload));
      return { data: one ? structuredClone(rows[0] || null) : structuredClone(rows), error: null };
    };
    const q = {
      select(spec = '*') { if (spec !== '*') validate(spec.split(',').map(s => s.trim())); return q; },
      eq(key, value) { validate([key]); filters.push(row => row[key] === value); return q; },
      is(key, value) { validate([key]); filters.push(row => (row[key] ?? null) === value); return q; },
      in(key, values) { validate([key]); filters.push(row => values.includes(row[key])); return q; },
      update(data) { validate(Object.keys(data)); payload = data; return q; },
      insert(data) { validate(Object.keys(data)); payload = data; insert = true; return q; },
      maybeSingle() { one = true; return Promise.resolve(settle()); },
      then(resolve, reject) { return Promise.resolve(settle()).then(resolve, reject); },
    }; return q;
  };
  return db;
}
let db, post, now, provider, fetchImpl, service;
beforeEach(() => {
  now = new Date('2026-12-01T12:00:00Z');
  post = { id: 'post-a', beautician_id: 'salon-a', caption: 'Lash lift and tint is £50.', hashtags: ['#lashes'], media: { photo_id: 'photo-a' }, image_url: 'https://fictional.example/photo.jpg', link_url: 'https://fictional.example/book?fl_content=abc', platform: 'instagram', format: 'feed', kind: 'post', post_type: 'general', version: 1, facts: [], status: 'scheduled', scheduled_for: '2026-12-01T11:00:00Z' };
  post.material_hash = post.approved_hash = materialHash(post);
  db = database({ content_posts: [post], beauticians: [{ id: 'salon-a', content_v2: true, instagram_page_id: 'ig-a', instagram_page_token: 'fake-token', instagram_token_expires_at: '2027-01-01T00:00:00Z' }], ai_actions: [] });
  provider = vi.fn(async (_owner, _id, options) => { await options.beforePublish(); return { published: true, instagramId: 'provider-1' }; });
  fetchImpl = vi.fn(async () => ({ ok: true, json: async () => ({ data: [] }) }));
  service = createContentV2Publisher({ db, recheckPost: async () => structuredClone(post), materialHash, publishLegacy: provider, fetchImpl, now: () => now });
});

describe('Content v2 publishing', () => {
  it('uses only columns declared by the migration history and rejects fictional columns', async () => {
    const folder = fileURLToPath(new URL('../../../supabase/migrations/', import.meta.url));
    const sql = fs.readdirSync(folder).filter(name => name.endsWith('.sql')).map(name => fs.readFileSync(path.join(folder, name), 'utf8')).join('\n');
    for (const columns of Object.values(COLUMNS)) for (const column of columns) expect(sql).toMatch(new RegExp(`\\b${column}\\b`));
    expect((await db.from('content_posts').select('fictional_column')).error.code).toBe('42703');
  });
  it('publishes once, stores the accepted provider id and makes a second call a no-op', async () => {
    expect((await service.publish('salon-a', 'post-a')).published).toBe(true);
    expect(post.external_post_id).toBe('provider-1'); expect(post.status).toBe('posted');
    expect((await service.publish('salon-a', 'post-a')).already_posted).toBe(true);
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it('reserves one claim across overlapping calls', async () => {
    const outcomes = await Promise.all([service.publish('salon-a', 'post-a'), service.publish('salon-a', 'post-a')]);
    expect(provider).toHaveBeenCalledTimes(1); expect(outcomes.filter(result => result.published)).toHaveLength(1);
  });
  it('reconciles a lost media_publish answer without another send', async () => {
    provider.mockImplementationOnce(async (_owner, _id, options) => { await options.beforePublish(); return { published: false, uncertain: true }; });
    expect((await service.publish('salon-a', 'post-a')).posting).toBe(true);
    expect(post.publish_uncertain_since).toBe(now.toISOString());
    fetchImpl.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: 'found-on-instagram', caption: `${post.caption}\n#lashes`, timestamp: now.toISOString() }] }) });
    expect((await service.publish('salon-a', 'post-a')).reconciled).toBe(true);
    expect(post.external_post_id).toBe('found-on-instagram'); expect(provider).toHaveBeenCalledTimes(1);
    expect(db.tables.ai_actions[0].summary).toBe('Checked with Instagram: the post went out once.');
  });
  it('keeps an uncertain claim while the provider read fails', async () => {
    post.publish_claimed_at = post.publish_uncertain_since = now.toISOString(); post.publish_key = 'same-key';
    now = new Date(now.getTime() + 11 * 60000);
    fetchImpl.mockRejectedValueOnce(new Error('Fictional network outage'));
    await expect(service.publish('salon-a', 'post-a')).rejects.toThrow();
    expect(post.publish_claimed_at).toBeTruthy(); expect(provider).not.toHaveBeenCalled();
  });
  it('recognises a published timestamp rounded to the dispatch second', async () => {
    post.publish_claimed_at = post.publish_uncertain_since = '2026-12-01T12:00:00.750Z'; post.publish_key = 'same-key';
    now = new Date('2026-12-01T12:11:00Z');
    fetchImpl.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: 'whole-second-post', caption: `${post.caption}\n#lashes`, timestamp: '2026-12-01T12:00:00Z' }] }) });
    expect((await service.publish('salon-a', 'post-a')).reconciled).toBe(true);
    expect(post.external_post_id).toBe('whole-second-post'); expect(provider).not.toHaveBeenCalled();
  });
  it('reads the next media page before deciding whether the post went out', async () => {
    post.publish_claimed_at = post.publish_uncertain_since = now.toISOString(); post.publish_key = 'same-key';
    now = new Date(now.getTime() + 11 * 60000);
    fetchImpl.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: 'later', caption: 'A different post', timestamp: now.toISOString() }], paging: { next: 'https://graph.instagram.com/v21.0/ig-a/media?after=next' } }) });
    fetchImpl.mockResolvedValueOnce({ ok: true, json: async () => ({ data: [{ id: 'second-page-post', caption: `${post.caption}\n#lashes`, timestamp: post.publish_claimed_at }] }) });
    expect((await service.publish('salon-a', 'post-a')).reconciled).toBe(true);
    expect(post.external_post_id).toBe('second-page-post'); expect(fetchImpl).toHaveBeenCalledTimes(2); expect(provider).not.toHaveBeenCalled();
  });
  it('keeps the claim if a bounded media read has not covered the dispatch window', async () => {
    post.publish_claimed_at = post.publish_uncertain_since = now.toISOString(); post.publish_key = 'same-key';
    now = new Date(now.getTime() + 11 * 60000);
    fetchImpl.mockImplementation(async () => ({ ok: true, json: async () => ({ data: [{ id: 'later', caption: 'A different post', timestamp: now.toISOString() }], paging: { next: 'https://graph.instagram.com/v21.0/ig-a/media?after=more' } }) }));
    expect((await service.publish('salon-a', 'post-a')).posting).toBe(true);
    expect(post.publish_claimed_at).toBeTruthy(); expect(post.status).toBe('scheduled'); expect(fetchImpl).toHaveBeenCalledTimes(5); expect(provider).not.toHaveBeenCalled();
  });
  it('does not attribute one of several indistinguishable provider posts', async () => {
    post.publish_claimed_at = post.publish_uncertain_since = now.toISOString(); post.publish_key = 'same-key';
    now = new Date(now.getTime() + 11 * 60000);
    fetchImpl.mockResolvedValueOnce({ ok: true, json: async () => ({ data: ['first', 'second'].map(id => ({ id, caption: `${post.caption}\n#lashes`, timestamp: post.publish_claimed_at })) }) });
    expect((await service.publish('salon-a', 'post-a')).posting).toBe(true);
    expect(post.publish_claimed_at).toBeTruthy(); expect(post.external_post_id).toBeUndefined(); expect(provider).not.toHaveBeenCalled();
  });
  it('only clears uncertainty after a successful provider read and ten minutes without a match', async () => {
    post.publish_claimed_at = post.publish_uncertain_since = now.toISOString(); post.publish_key = 'same-key';
    expect((await service.publish('salon-a', 'post-a')).posting).toBe(true);
    now = new Date(now.getTime() + 11 * 60000);
    expect((await service.publish('salon-a', 'post-a')).reason).toContain('Nothing went out');
    expect(post.status).toBe('failed'); expect(post.publish_claimed_at).toBeNull(); expect(provider).not.toHaveBeenCalled();
  });
  it('keeps approval while disconnected and publishes after reconnect', async () => {
    db.tables.beauticians[0].instagram_page_token = null;
    expect((await service.publish('salon-a', 'post-a')).not_connected).toBe(true);
    expect(post.approved_hash).toBe(post.material_hash); expect(post.status).toBe('scheduled');
    db.tables.beauticians[0].instagram_page_token = 'reconnected';
    expect((await service.publish('salon-a', 'post-a')).published).toBe(true);
  });
  it('returns a changed material hash to the owner before any provider traffic', async () => {
    post.caption = 'A changed caption.';
    expect((await service.publish('salon-a', 'post-a')).needs_approval).toBe(true);
    expect(post.status).toBe('draft'); expect(post.approved_hash).toBeNull();
    expect(post.change_note.reasons).toContain('It changed after you approved it'); expect(provider).not.toHaveBeenCalled();
  });
  it('stops dispatch if a fact changes while Instagram processes the image', async () => {
    const recheck = vi.fn(async (_owner, _id, options) => {
      if (options?.publishing) {
        post.caption = 'Lash lift and tint is £55.'; post.status = 'draft'; post.approved_hash = null;
        post.change_note = { kind: 'facts', reasons: ['The price changed while the image was uploading.'] };
      }
      return structuredClone(post);
    });
    const publish = vi.fn(async (_owner, _id, options) => { await options.beforePublish(); throw new Error('Must not reach provider dispatch'); });
    const local = createContentV2Publisher({ db, recheckPost: recheck, materialHash, publishLegacy: publish, now: () => now });
    expect((await local.publish('salon-a', 'post-a')).needs_approval).toBe(true);
    expect(post.status).toBe('draft'); expect(post.publish_claimed_at).toBeNull();
    expect(post.change_note.reasons).toEqual(['The price changed while the image was uploading.']);
  });
  it('honours rollout being disabled while the provider processes the image', async () => {
    provider.mockImplementationOnce(async (_owner, _id, options) => {
      db.tables.beauticians[0].content_v2 = false;
      await options.beforePublish();
      throw new Error('Must not reach provider dispatch');
    });
    expect((await service.publish('salon-a', 'post-a')).disabled).toBe(true);
    expect(post.publish_claimed_at).toBeNull(); expect(post.publish_uncertain_since).toBeNull();
    expect(post.status).toBe('scheduled'); expect(post.approved_hash).toBe(post.material_hash);
  });
  it('records rejected credentials so the home screen asks for reconnection', async () => {
    provider.mockResolvedValueOnce({ published: false, not_connected: true, reason: 'Session expired' });
    expect((await service.publish('salon-a', 'post-a')).not_connected).toBe(true);
    expect(db.tables.beauticians[0].instagram_token_expires_at).toBe(now.toISOString());
    expect(post.status).toBe('scheduled'); expect(post.approved_hash).toBe(post.material_hash);
    expect(post.publish_claimed_at).toBeNull();
  });
  it('records an explicit refusal and retries with the same publish key', async () => {
    provider.mockImplementationOnce(async (_owner, _id, options) => { await options.beforePublish(); return { published: false, reason: 'Instagram refused the photo.' }; });
    await service.publish('salon-a', 'post-a');
    const key = post.publish_key; expect(post.status).toBe('failed'); expect(post.failure_reason).toBe('Instagram refused the photo.');
    post.status = 'scheduled'; await service.publish('salon-a', 'post-a');
    expect(post.publish_key).toBe(key); expect(post.publish_attempts).toBe(2); expect(post.external_post_id).toBe('provider-1');
  });
  it('does not send after a concurrent edit wins the version check', async () => {
    db.beforeUpdate = () => { post.version += 1; post.status = 'draft'; post.approved_hash = null; };
    expect((await service.publish('salon-a', 'post-a')).posting).toBe(true); expect(provider).not.toHaveBeenCalled();
  });
  it('preserves the claim after a database outage saving a known provider result', async () => {
    db.fail = (_table, data) => data?.status === 'posted';
    expect((await service.publish('salon-a', 'post-a')).uncertain).toBe(true);
    expect(post.publish_claimed_at).toBeTruthy(); expect(post.status).toBe('scheduled');
  });
  it('refuses a removed post even when a stale caller still has its id', async () => {
    post.deleted_at = now.toISOString();
    await expect(service.publish('salon-a', 'post-a')).rejects.toMatchObject({ status: 404 });
    expect(provider).not.toHaveBeenCalled();
  });
  it('refuses another tenant, gallery rows and Reel plans', async () => {
    await expect(service.publish('salon-b', 'post-a')).rejects.toMatchObject({ status: 404 });
    for (const change of [{ kind: 'reel_plan' }, { kind: 'post', post_type: 'gallery' }]) {
      Object.assign(post, change); expect((await service.publish('salon-a', 'post-a')).published).toBe(false);
    }
    expect(provider).not.toHaveBeenCalled();
  });
});

describe('flagged Google posting', () => {
  it('uses the tracked link for Book and sends the approved offer terms', () => {
    const body = googlePostBody(post, { title: 'Festive lashes', code: 'FESTIVE10', terms: 'One per client.', appointments_from: '2026-12-01', appointments_to: '2026-12-24' });
    expect(body.callToAction).toEqual({ actionType: 'BOOK', url: post.link_url });
    expect(body.topicType).toBe('OFFER'); expect(body.offer.couponCode).toBe('FESTIVE10');
    expect(body.event.schedule.endDate).toEqual({ year: 2026, month: 12, day: 24 });
  });
  it('does not reach Google until the feature flag is on', async () => {
    const google = createGooglePosts({ db, fetchImpl, env: {} });
    expect((await google.publish('salon-a', post, vi.fn())).not_connected).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('reads Google pages before reporting a complete reconciliation window', async () => {
    const connection = { publishingContext: async () => ({ access: 'fictional-token', location: 'accounts/fictional/locations/fictional' }) };
    const google = createGooglePosts({ db, fetchImpl, connection, env: { GOOGLE_POSTS_ENABLED: 'true' } });
    fetchImpl.mockResolvedValueOnce({ ok: true, json: async () => ({ localPosts: [{ name: 'post-first', summary: 'First', createTime: now.toISOString() }], nextPageToken: 'next+page' }) });
    fetchImpl.mockResolvedValueOnce({ ok: true, json: async () => ({ localPosts: [{ name: 'post-second', summary: 'Second', createTime: now.toISOString() }] }) });
    expect(await google.recent('salon-a')).toMatchObject({ complete: true, posts: [{ id: 'post-first' }, { id: 'post-second' }] });
    expect(fetchImpl.mock.calls[1][0]).toContain('pageToken=next%2Bpage');
  });
});
