/**
 * "Make sure this can't happen, I need IG to stay live."
 *
 * The founder, 2 September, on being told that the fail-closed webhook change
 * would pause the pilot salon's Instagram DMs if the secret turned out to be
 * missing on deploy day. So: three answers, and the difference is the date.
 * A live channel cannot go dark on deploy day, and a channel cannot stay
 * unsecured forever either.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  unsignedWebhookPolicy, unsecuredWebhookChannels, reportUnsecuredOnce,
  UNSIGNED_WEBHOOK_DEADLINE, __resetUnsecuredReports,
} from '../../src/lib/unsigned-webhook-policy.js';

const DAY = 86_400_000;
const deployDay = new Date('2026-09-02T12:00:00Z');
const afterDeadline = new Date(UNSIGNED_WEBHOOK_DEADLINE.getTime() + DAY);
const noSecrets = {};

describe('on deploy day, with the secret missing', () => {
  it('accepts, so the channel stays live', () => {
    const p = unsignedWebhookPolicy({ channel: 'instagram', envVar: 'INSTAGRAM_APP_SECRET', now: deployDay, env: noSecrets });
    expect(p.accept).toBe(true);
    expect(p.mode).toBe('grace');
  });

  it('says how long is left and which variable to set', () => {
    const p = unsignedWebhookPolicy({ channel: 'instagram', envVar: 'INSTAGRAM_APP_SECRET', now: deployDay, env: noSecrets });
    expect(p.daysLeft).toBeGreaterThan(0);
    expect(p.daysLeft).toBeLessThanOrEqual(7);
    expect(p.detail).toMatch(/INSTAGRAM_APP_SECRET is NOT SET/);
    expect(p.detail).toMatch(/Set INSTAGRAM_APP_SECRET now/);
  });
});

describe('after the deadline, with the secret still missing', () => {
  it('rejects', () => {
    const p = unsignedWebhookPolicy({ channel: 'instagram', envVar: 'INSTAGRAM_APP_SECRET', now: afterDeadline, env: noSecrets });
    expect(p.accept).toBe(false);
    expect(p.mode).toBe('reject');
    expect(p.daysLeft).toBe(0);
  });

  it('the deadline is a fixed date, so a restart cannot reset it', () => {
    // "N days from boot" would give every restart a fresh week. The whole
    // point is that the window closes.
    expect(UNSIGNED_WEBHOOK_DEADLINE).toBeInstanceOf(Date);
    expect(UNSIGNED_WEBHOOK_DEADLINE.getTime()).toBe(Date.parse('2026-09-09T00:00:00Z'));
  });

  it('flips at exactly the deadline, not a day either side', () => {
    const justBefore = new Date(UNSIGNED_WEBHOOK_DEADLINE.getTime() - 1);
    const at = UNSIGNED_WEBHOOK_DEADLINE;
    expect(unsignedWebhookPolicy({ channel: 'x', envVar: 'X', now: justBefore, env: noSecrets }).accept).toBe(true);
    expect(unsignedWebhookPolicy({ channel: 'x', envVar: 'X', now: at, env: noSecrets }).accept).toBe(false);
  });
});

describe('the local development override', () => {
  it('accepts with no deadline, and says so', () => {
    const p = unsignedWebhookPolicy({ channel: 'x', envVar: 'X', now: afterDeadline, env: { WEBHOOK_ALLOW_UNSIGNED: 'true' } });
    expect(p.accept).toBe(true);
    expect(p.mode).toBe('dev_override');
    expect(p.daysLeft).toBeNull();
  });

  it('is an exact string match, so "1" or "yes" does not switch it on', () => {
    for (const v of ['1', 'yes', 'TRUE', 'True']) {
      expect(unsignedWebhookPolicy({ channel: 'x', envVar: 'X', now: afterDeadline, env: { WEBHOOK_ALLOW_UNSIGNED: v } }).accept).toBe(false);
    }
  });
});

describe('what /health reports', () => {
  it('lists every channel with no secret, honouring the fallbacks the code uses', () => {
    // META_APP_SECRET alone secures both WhatsApp and Instagram, because that
    // is what the handlers actually read.
    const only = unsecuredWebhookChannels({ now: deployDay, env: { META_APP_SECRET: 'x' } }).map((c) => c.channel);
    expect(only).toEqual(['bird_sms', 'twilio_sms']);
  });

  it('is empty when everything is set', () => {
    const env = { WHATSAPP_APP_SECRET: 'a', INSTAGRAM_APP_SECRET: 'b', BIRD_WEBHOOK_TOKEN: 'c', TWILIO_AUTH_TOKEN: 'd' };
    expect(unsecuredWebhookChannels({ now: deployDay, env })).toEqual([]);
  });

  it('carries the mode and days left per channel', () => {
    const [ig] = unsecuredWebhookChannels({ now: deployDay, env: { WHATSAPP_APP_SECRET: 'a', BIRD_WEBHOOK_TOKEN: 'c', TWILIO_AUTH_TOKEN: 'd' } });
    expect(ig.channel).toBe('instagram');
    expect(ig.mode).toBe('grace');
    expect(ig.daysLeft).toBeGreaterThan(0);
  });
});

describe('waking somebody up', () => {
  beforeEach(() => __resetUnsecuredReports());

  it('sends one Sentry event per channel per process, not one per request', () => {
    const calls = [];
    const Sentry = { captureMessage: (m, level) => calls.push([m, level]) };
    reportUnsecuredOnce('instagram', 'detail', Sentry);
    reportUnsecuredOnce('instagram', 'detail', Sentry);
    reportUnsecuredOnce('instagram', 'detail', Sentry);
    reportUnsecuredOnce('whatsapp', 'detail', Sentry);
    expect(calls).toHaveLength(2);
    expect(calls[0][1]).toBe('error');
  });

  it('survives Sentry being absent or throwing', () => {
    expect(() => reportUnsecuredOnce('a', 'd', null)).not.toThrow();
    expect(() => reportUnsecuredOnce('b', 'd', { captureMessage() { throw new Error('down'); } })).not.toThrow();
  });
});

describe('the Instagram subscribe cannot cost the DM subscription', () => {
  // "make sure nothing you did or will do breaks the instagram connection,
  // ellie will need it in the morning". Meta's reference lists a permission
  // for message_echoes that this app does not request, so a single call
  // asking for messages AND echoes could be refused as a whole. On a reconnect
  // that would leave the account subscribed to nothing.
  const connect = readFileSync(new URL('../../src/routes/instagram.js', import.meta.url), 'utf8');
  const webhook = readFileSync(new URL('../../src/routes/instagram-webhooks.js', import.meta.url), 'utf8');

  it('subscribes to messages ALONE first at connect time, then echoes separately', () => {
    const alone = connect.indexOf("subscribe('messages')");
    const withEchoes = connect.indexOf("subscribe('messages,message_echoes')");
    expect(alone).toBeGreaterThan(-1);
    expect(withEchoes).toBeGreaterThan(alone);
  });

  it('re-asserts messages alone if the echo subscribe fails on a live account', () => {
    const at = webhook.indexOf('could not add message_echoes');
    expect(webhook.slice(at, at + 900)).toContain('subscribed_fields=messages\'');
  });

  it('handles each webhook event in its own try, so an echo cannot take a DM with it', () => {
    expect(webhook).toMatch(/for \(const event of entry\.messaging \|\| \[\]\) \{\s*\n[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*\n\s*try \{\s*\n\s*await handleInstagramMessage/);
  });
});
