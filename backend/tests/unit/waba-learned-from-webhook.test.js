/**
 * Meta names the owning account on every WhatsApp webhook, and for months
 * nobody wrote it down.
 *
 * 2 September 2026. Three attempts to ASK Meta which account owns the pilot
 * salon's phone were refused in turn: a nonexistent field, an empty
 * target_ids list, a missing permission. Meanwhile every inbound message and
 * every delivery receipt arrived as { entry: [{ id: <WABA>, changes: [{ value:
 * { metadata: { phone_number_id } } }] }] }. The answer was in the envelope.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

vi.mock('../../src/config.js', () => ({ supabase: { from: () => ({}) } }));
vi.mock('../../src/lib/logger.js', () => ({ default: { info() {}, warn() {}, error() {}, debug() {} } }));

const notif = await import('../../src/services/notifications.js');

describe('learnPhoneParentWaba', () => {
  beforeEach(() => {
    process.env.WHATSAPP_TOKEN = 'tok';
  });

  it('remembers the account a webhook named for a phone, and the lookup prefers it', async () => {
    notif.learnPhoneParentWaba('1073724175829484', '999888777');
    const answer = await notif.explainPhoneParentWaba('1073724175829484');
    expect(answer.wabaId).toBe('999888777');
    expect(answer.source).toBe('learned_from_webhook');
    expect(answer.reason).toBeNull();
  });

  it('ignores a delivery with either half missing', async () => {
    notif.learnPhoneParentWaba(undefined, '1');
    notif.learnPhoneParentWaba('555', undefined);
    const answer = await notif.explainPhoneParentWaba('555');
    expect(answer.source).not.toBe('learned_from_webhook');
  });

  it('stringifies ids, because Meta sends numbers in some fields and strings in others', async () => {
    notif.learnPhoneParentWaba(4242, 8686);
    const answer = await notif.explainPhoneParentWaba('4242');
    expect(answer.wabaId).toBe('8686');
  });
});

describe('the webhook writes it down', () => {
  const src = readFileSync(new URL('../../src/routes/webhooks.js', import.meta.url), 'utf8');

  it('learns from every delivery, receipts included, after the signature check and before the early returns', () => {
    const learn = src.indexOf('learnPhoneParentWaba(body.entry?.[0]?.changes?.[0]?.value?.metadata?.phone_number_id, body.entry?.[0]?.id)');
    const verified = src.indexOf("recordWebhookHit({ ...hitBase, result: '200_accepted' })");
    const statuses = src.indexOf("const statuses = body.entry?.[0]?.changes?.[0]?.value?.statuses");
    expect(learn).toBeGreaterThan(verified);   // only from payloads we accepted
    expect(learn).toBeLessThan(statuses);      // receipts teach it too
  });
});
