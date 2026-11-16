import { afterEach, describe, expect, it, vi } from 'vitest';
import { authorizationUrl, checkedScopes, emailKey, emailProviderConfig, mailboxAddress, normaliseEmail, readEmailPage, replyToEmail, ownerAlreadyReplied, scopesFor } from '../../src/lib/email-provider.js';
afterEach(() => vi.unstubAllEnvs());
const b64 = text => Buffer.from(text).toString('base64url');
const googleMessage = (overrides = {}) => ({ id: 'm1', threadId: 't1', internalDate: '1794823200000', payload: { mimeType: 'text/plain', body: { data: b64('How much is a tint?') }, headers: [{ name: 'From', value: 'Alex <alex@example.com>' }, { name: 'Message-ID', value: '<message@example.com>' }] }, ...overrides });
describe('mailbox provider boundaries', () => {
  it('requires explicit rollout, credentials, HTTPS callback and strong encryption', () => {
    expect(emailProviderConfig('google', 'salon')).toBeNull();
    vi.stubEnv('EMAIL_GOOGLE_ENABLED', 'true'); vi.stubEnv('EMAIL_GOOGLE_CLIENT_ID', 'id'); vi.stubEnv('EMAIL_GOOGLE_CLIENT_SECRET', 'secret');
    vi.stubEnv('EMAIL_GOOGLE_REDIRECT_URI', 'https://api.florrie.ai/api/email/callback/google');
    vi.stubEnv('EMAIL_CONNECTIONS_KEY', 'short'); expect(() => emailKey()).toThrow();
    vi.stubEnv('EMAIL_CONNECTIONS_KEY', 'a'.repeat(64)); expect(emailProviderConfig('google', 'salon')).not.toBeNull();
    vi.stubEnv('EMAIL_CONNECTIONS_SALONS', 'demo'); expect(emailProviderConfig('google', 'salon')).toBeNull();
    expect(emailProviderConfig('google', 'demo')).not.toBeNull();
    vi.stubEnv('EMAIL_GOOGLE_REDIRECT_URI', 'http://api.florrie.ai/api/email/callback/google'); expect(emailProviderConfig('google', 'demo')).toBeNull();
  });
  it('binds each OAuth request with state and S256 proof without a client secret in the URL', () => {
    for (const provider of ['google', 'microsoft']) {
      const u = new URL(authorizationUrl({ provider, id: 'id', secret: 'never-in-url', redirect: `https://api.florrie.ai/api/email/callback/${provider}` }, 'nonce', 'proof'));
      expect(u.searchParams.get('code_challenge_method')).toBe('S256'); expect(u.searchParams.get('state')).toBe('nonce');
      expect(u.href).not.toContain('never-in-url'); expect(u.searchParams.get('code_challenge')).not.toBe('proof');
      expect(checkedScopes(provider, scopesFor(provider).join(' '))).toBe(true);
      expect(checkedScopes(provider, 'openid email')).toBe(false);
    }
  });
  it('imports text and subject without treating sender names or HTML as markup', () => {
    const m = normaliseEmail('google', googleMessage()); expect(m.from).toBe('alex@example.com'); expect(m.body).toBe('How much is a tint?');
    expect(mailboxAddress('Alex <alex@example.com>\r\nBcc: other@example.com')).toBeNull();
    expect(normaliseEmail('microsoft', { id: 'm', from: { emailAddress: { address: 'a@example.com' } }, body: { contentType: 'HTML', content: '<script>steal()</script><p>Hello &amp; thanks</p>' }, receivedDateTime: '2026-11-16T12:00:00Z' }).body).toBe('Hello & thanks');
  });
  it('leaves newsletter, automatic and attachment-only mail out of the client inbox', () => {
    const m = googleMessage(); m.payload.headers.push({ name: 'Auto-Submitted', value: 'auto-replied' }); expect(normaliseEmail('google', m)).toBeNull();
    const attachment = googleMessage(); attachment.payload.filename = 'invoice.txt'; expect(normaliseEmail('google', attachment)).toBeNull();
  });
  it('does not send mailbox tokens to an untrusted pagination link', async () => {
    const fetcher = vi.fn(); await expect(readEmailPage('microsoft', 'secret', '2026-11-16', 'https://attacker.example/mail', fetcher)).rejects.toThrow('invalid_cursor'); expect(fetcher).not.toHaveBeenCalled();
  });
  it('replies inside the original Gmail thread with encoded body and safe headers', async () => {
    const fetcher = vi.fn(async () => Response.json({ id: 'sent1' }));
    await replyToEmail('google', 'token', { sender_email: 'a@example.com', reply_email: 'a@example.com', thread_id: 'thread', internet_message_id: '<original@example.com>', provider_message_id: 'original', subject: 'Brow £30' }, 'Yes, £30\nThanks!', fetcher);
    const payload = JSON.parse(fetcher.mock.calls[0][1].body); expect(payload.threadId).toBe('thread');
    const mime = Buffer.from(payload.raw, 'base64url').toString(); expect(mime).toContain('In-Reply-To: <original@example.com>'); expect(mime).toContain('To: a@example.com'); expect(mime).toContain(Buffer.from('Yes, £30\nThanks!').toString('base64'));
  });
  it('requires review for an alternate reply address and rejects malformed threading headers before sending', async () => {
    const fetcher = vi.fn(); const original = { sender_email: 'a@example.com', reply_email: 'b@example.com', internet_message_id: '<id>\r\nBcc: c@example.com' };
    await expect(replyToEmail('microsoft', 'token', original, 'Hi', fetcher)).rejects.toThrow('reply_address_changed');
    await expect(replyToEmail('google', 'token', { ...original, reply_email: original.sender_email }, 'Hi', fetcher)).rejects.toThrow('thread_unavailable'); expect(fetcher).not.toHaveBeenCalled();
  });
  it('records Microsoft acceptance separately from delivery and uses immutable IDs', async () => {
    const fetcher = vi.fn(async () => new Response(null, { status: 202 }));
    expect(await replyToEmail('microsoft', 'token', { sender_email: 'a@example.com', reply_email: 'a@example.com', provider_message_id: 'id/one' }, 'Hi', fetcher)).toEqual({ accepted: true });
    expect(fetcher.mock.calls[0][0]).toContain('id%2Fone/reply'); expect(fetcher.mock.calls[0][1].headers.Prefer).toContain('ImmutableId');
  });
  it.each(['google', 'microsoft'])('bounds an inbox scan so new arrivals cannot move the page under the reader: %s', async provider => {
    const calls = []; const fetcher = async url => { calls.push(new URL(url)); return Response.json(provider === 'google' ? { messages: [] } : { value: [] }); };
    await readEmailPage(provider, 'token', '2026-11-16T10:00:00Z', null, fetcher, '2026-11-16T11:00:00Z');
    if (provider === 'google') expect(calls[0].searchParams.get('q')).toContain(`before:${Date.parse('2026-11-16T11:00:00Z') / 1000}`);
    else expect(calls[0].searchParams.get('$filter')).toContain('receivedDateTime le 2026-11-16T11:00:00.000Z');
  });
  it('detects Gmail owner replies after the incoming message, without treating an old sent email as a reply', async () => {
    const original = { thread_id: 'thread', provider_message_id: 'inbound' }, at = '2026-11-16T10:00:00Z';
    const sent = { id: 'sent', internalDate: String(Date.parse(at) + 1000), labelIds: ['SENT'] };
    expect(await ownerAlreadyReplied('google', 't', original, 'owner@example.com', at, async () => Response.json({ messages: [sent] }))).toBe(true);
    expect(await ownerAlreadyReplied('google', 't', original, 'owner@example.com', at, async () => Response.json({ messages: [{ ...sent, internalDate: '1' }] }))).toBe(false);
  });
  it('detects Outlook replies and refuses to guess when the sent-thread check is incomplete', async () => {
    const original = { thread_id: 'thread' }, at = '2026-11-16T10:00:00Z';
    expect(await ownerAlreadyReplied('microsoft', 't', original, 'owner@example.com', at, async () => Response.json({ value: [{ sentDateTime: '2026-11-16T10:01:00Z' }] }))).toBe(true);
    await expect(ownerAlreadyReplied('microsoft', 't', original, 'owner@example.com', at, async () => Response.json({ value: [], '@odata.nextLink': 'next' }))).rejects.toThrow('thread_unavailable');
  });
});
