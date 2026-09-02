/**
 * A client who hits Reply on a booking confirmation must reach the salon.
 *
 * The confirmation email ends "Just reply to this email and Ellie will sort
 * it", and the From is Florrie's noreply mailbox. Until sendEmail forwarded a
 * reply-to, every one of those replies went to nobody. The From does not
 * change (it is the domain Resend is verified for); Resend's reply_to field
 * carries the salon's own address instead.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

process.env.RESEND_API_KEY = 'test-resend-key';

const sent = [];
global.fetch = vi.fn(async (url, opts = {}) => {
  if (String(url).includes('api.resend.com')) {
    sent.push(JSON.parse(opts.body));
    return { ok: true, status: 200, json: async () => ({ id: `email_${sent.length}` }) };
  }
  throw new Error(`unexpected fetch: ${url}`);
});

vi.mock('../../src/config.js', () => ({
  supabase: { from: () => { throw new Error('no database in this test'); } },
}));

const { sendEmail } = await import('../../src/services/notifications.js');

beforeEach(() => { sent.length = 0; });

describe('sendEmail forwards replyTo', () => {
  it('sends the salon address as reply_to and leaves From alone', async () => {
    await sendEmail({ to: 'client@example.com', subject: 'Confirmed', text: 'hi', html: '<p>hi</p>', replyTo: 'ellie@salon.example' });
    expect(sent).toHaveLength(1);
    expect(sent[0].reply_to).toBe('ellie@salon.example');
    expect(sent[0].from).toMatch(/noreply@florrie\.ai/);
  });

  it('omits reply_to entirely when none is given', async () => {
    await sendEmail({ to: 'client@example.com', subject: 'Hello', text: 'hi', html: '<p>hi</p>' });
    expect(sent[0]).not.toHaveProperty('reply_to');
  });

  it('does not let a blank or malformed salon email break the send', async () => {
    await sendEmail({ to: 'client@example.com', subject: 'Hello', text: 'hi', html: '<p>hi</p>', replyTo: '   ' });
    await sendEmail({ to: 'client@example.com', subject: 'Hello', text: 'hi', html: '<p>hi</p>', replyTo: 'not-an-address' });
    expect(sent).toHaveLength(2);
    for (const body of sent) expect(body).not.toHaveProperty('reply_to');
  });
});
