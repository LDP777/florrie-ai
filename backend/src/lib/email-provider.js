import { createHash, randomBytes } from 'node:crypto';

export const mailboxProviders = ['google', 'microsoft'];
export const validEmail = value => typeof value === 'string' && value.length <= 254 && /^[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+\.[A-Z]{2,}$/i.test(value);
export const stateHash = value => createHash('sha256').update(value).digest('hex');
export const newSecret = () => randomBytes(32).toString('base64url');
export function emailKey() {
  const key = process.env.EMAIL_CONNECTIONS_KEY || process.env.WHATSAPP_CREDENTIALS_KEY;
  if (!/^[a-f0-9]{64}$/i.test(key || '')) throw new Error('Email connection storage is not configured');
  return key;
}
export function emailProviderConfig(provider, owner) {
  if (!mailboxProviders.includes(provider)) return null;
  const prefix = provider === 'google' ? 'EMAIL_GOOGLE' : 'EMAIL_MICROSOFT';
  const allow = (process.env.EMAIL_CONNECTIONS_SALONS || '').split(',').map(x => x.trim()).filter(Boolean);
  if (process.env[`${prefix}_ENABLED`] !== 'true' || (allow.length && !allow.includes(owner))) return null;
  const id = process.env[`${prefix}_CLIENT_ID`], secret = process.env[`${prefix}_CLIENT_SECRET`];
  const redirect = process.env[`${prefix}_REDIRECT_URI`];
  if (!id || !secret) return null;
  try {
    emailKey();
    const u = new URL(redirect);
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== `/api/email/callback/${provider}`) return null;
  } catch { return null; }
  return { id, secret, redirect, provider };
}
export const scopesFor = provider => provider === 'google'
  ? ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send']
  : ['offline_access', 'https://graph.microsoft.com/User.Read', 'https://graph.microsoft.com/Mail.Read', 'https://graph.microsoft.com/Mail.Send'];
export function authorizationUrl(config, state, verifier) {
  const google = config.provider === 'google';
  const url = new URL(google ? 'https://accounts.google.com/o/oauth2/v2/auth' : 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize');
  Object.entries({ client_id: config.id, redirect_uri: config.redirect, response_type: 'code', scope: scopesFor(config.provider).join(' '),
    state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256',
    ...(google ? { access_type: 'offline', prompt: 'consent select_account' } : { prompt: 'select_account', response_mode: 'query' }),
  }).forEach(([k, v]) => url.searchParams.set(k, v));
  return url.href;
}
export class EmailProviderError extends Error {
  constructor(code = 'unavailable', status = 503) { super(code); this.code = code; this.status = status; }
}
export async function providerRequest(url, options = {}, fetchImpl = fetch) {
  let response;
  try { response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(12000), redirect: 'error' }); }
  catch { throw new EmailProviderError('unavailable'); }
  const data = response.status === 204 || response.status === 202 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    const reconnect = response.status === 401 || data.error === 'invalid_grant';
    throw new EmailProviderError(reconnect ? 'reconnect' : response.status === 429 ? 'rate_limited' : 'provider_rejected', response.status);
  }
  return data;
}
export async function exchangeEmailToken(config, fields, fetchImpl = fetch) {
  const url = config.provider === 'google' ? 'https://oauth2.googleapis.com/token' : 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
  const data = await providerRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: config.id, client_secret: config.secret, ...fields }).toString() }, fetchImpl);
  if (typeof data.access_token !== 'string' || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new EmailProviderError('invalid_token');
  return data;
}
export function checkedScopes(provider, scope) {
  const granted = new Set(String(scope || '').split(' ').map(x => x.replace('https://graph.microsoft.com/', '').toLowerCase()));
  return scopesFor(provider).filter(x => x !== 'offline_access').every(x => granted.has(x.replace('https://graph.microsoft.com/', '').toLowerCase()));
}
const graph = 'https://graph.microsoft.com/v1.0';
const gmail = 'https://gmail.googleapis.com/gmail/v1/users/me';
const auth = token => ({ Authorization: `Bearer ${token}` });
export async function mailboxIdentity(provider, token, fetchImpl = fetch) {
  const data = await providerRequest(provider === 'google' ? `${gmail}/profile` : `${graph}/me?$select=id,mail,userPrincipalName`, { headers: auth(token) }, fetchImpl);
  const email = String(provider === 'google' ? data.emailAddress || '' : data.mail || data.userPrincipalName || '').toLowerCase();
  const subject = provider === 'google' ? email : data.id;
  if (!validEmail(email) || typeof subject !== 'string' || !subject) throw new EmailProviderError('invalid_identity');
  return { email, subject };
}
const textOnly = value => String(value || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
  .replace(/<br\s*\/?\s*>|<\/p>|<\/div>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim().slice(0, 12000);
export function mailboxAddress(value) {
  const raw = String(value || '').trim();
  const match = raw.match(/<([^<>]+)>$/);
  const address = (match ? match[1] : raw).trim().toLowerCase();
  return validEmail(address) ? address : null;
}
function gmailBody(part, depth = 0) {
  if (!part || depth > 10 || part.filename) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) return Buffer.from(part.body.data, 'base64url').toString('utf8').slice(0, 12000);
  if (part.parts) {
    const plain = part.parts.find(p => p.mimeType === 'text/plain' && !p.filename);
    if (plain) return gmailBody(plain, depth + 1);
    return part.parts.map(p => gmailBody(p, depth + 1)).join('\n').slice(0, 12000);
  }
  return part.mimeType === 'text/html' && part.body?.data ? textOnly(Buffer.from(part.body.data, 'base64url').toString('utf8')) : '';
}
export function normaliseEmail(provider, data) {
  const rawHeaders = provider === 'google' ? data.payload?.headers : data.internetMessageHeaders;
  const headers = new Map((rawHeaders || []).map(h => [String(h.name).toLowerCase(), String(h.value)]));
  const from = provider === 'google' ? mailboxAddress(headers.get('from')) : mailboxAddress(data.from?.emailAddress?.address);
  const reply = provider === 'google' ? mailboxAddress(headers.get('reply-to') || headers.get('from')) : mailboxAddress(data.replyTo?.[0]?.emailAddress?.address || from);
  const automatic = headers.has('list-unsubscribe') || headers.has('list-id') ||
    (headers.has('auto-submitted') && headers.get('auto-submitted').toLowerCase() !== 'no') || /^(bulk|list|junk)$/i.test(headers.get('precedence') || '');
  const body = provider === 'google' ? gmailBody(data.payload) : data.body?.contentType?.toLowerCase() === 'html' ? textOnly(data.body.content) : String(data.body?.content || '').slice(0, 12000);
  const date = provider === 'google' ? new Date(Number(data.internalDate)) : new Date(data.receivedDateTime);
  if (!from || !reply || !body.trim() || automatic || !Number.isFinite(date.getTime()) || !data.id) return null;
  return { id: data.id, threadId: provider === 'google' ? data.threadId : data.conversationId,
    internetId: provider === 'google' ? headers.get('message-id') : data.internetMessageId,
    subject: String(provider === 'google' ? headers.get('subject') || '' : data.subject || '').replace(/[\r\n]/g, ' ').slice(0, 250),
    from, reply, body: body.trim(), at: date.toISOString() };
}
export async function readEmailPage(provider, token, since, cursor, fetchImpl = fetch, until = new Date().toISOString()) {
  if (provider === 'google') {
    const q = new URLSearchParams({ q: `in:inbox after:${Math.floor(Date.parse(since) / 1000)} before:${Math.ceil(Date.parse(until) / 1000)} -category:promotions -category:social`, maxResults: '10', ...(cursor ? { pageToken: cursor } : {}) });
    const list = await providerRequest(`${gmail}/messages?${q}`, { headers: auth(token) }, fetchImpl);
    const messages = [];
    for (const entry of list.messages || []) {
      const data = await providerRequest(`${gmail}/messages/${encodeURIComponent(entry.id)}?format=full`, { headers: auth(token) }, fetchImpl);
      const m = normaliseEmail(provider, data); if (m) messages.push(m);
    }
    return { messages, next: list.nextPageToken || null };
  }
  const url = cursor || `${graph}/me/mailFolders/inbox/messages?` + new URLSearchParams({ '$filter': `receivedDateTime ge ${new Date(since).toISOString()} and receivedDateTime le ${new Date(until).toISOString()}`, '$top': '20', '$orderby': 'receivedDateTime asc', '$select': 'id,conversationId,from,replyTo,subject,body,internetMessageId,internetMessageHeaders,receivedDateTime' });
  const parsed = new URL(url);
  if (parsed.origin !== 'https://graph.microsoft.com' || !parsed.pathname.startsWith('/v1.0/me/mailFolders/') || parsed.username || parsed.password || parsed.hash) throw new EmailProviderError('invalid_cursor');
  const data = await providerRequest(url, { headers: { ...auth(token), Prefer: 'outlook.body-content-type="text", IdType="ImmutableId"' } }, fetchImpl);
  return { messages: (data.value || []).map(x => normaliseEmail(provider, x)).filter(Boolean), next: data['@odata.nextLink'] || null };
}
export async function replyToEmail(provider, token, original, body, fetchImpl = fetch) {
  if (!validEmail(original.sender_email) || original.reply_email !== original.sender_email) throw new EmailProviderError('reply_address_changed', 409);
  if (provider === 'microsoft') {
    await providerRequest(`${graph}/me/messages/${encodeURIComponent(original.provider_message_id)}/reply`, { method: 'POST', headers: { ...auth(token), Prefer: 'IdType="ImmutableId"', 'Content-Type': 'application/json' }, body: JSON.stringify({ comment: body }) }, fetchImpl);
    return { accepted: true };
  }
  const id = original.internet_message_id;
  if (typeof id !== 'string' || !/^<[^\s<>]+>$/.test(id)) throw new EmailProviderError('thread_unavailable', 409);
  const subject = /^re:/i.test(original.subject) ? original.subject : `Re: ${original.subject}`;
  const mime = [`To: ${original.sender_email}`, `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`, `In-Reply-To: ${id}`, `References: ${id}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64', '', Buffer.from(body).toString('base64')].join('\r\n');
  const result = await providerRequest(`${gmail}/messages/send`, { method: 'POST', headers: { ...auth(token), 'Content-Type': 'application/json' }, body: JSON.stringify({ raw: Buffer.from(mime).toString('base64url'), threadId: original.thread_id }) }, fetchImpl);
  if (!result.id) throw new EmailProviderError('unconfirmed');
  return { accepted: true, id: result.id };
}
export async function ownerAlreadyReplied(provider, token, original, ownerEmail, receivedAt, fetchImpl = fetch) {
  if (provider === 'google') {
    const data = await providerRequest(`${gmail}/threads/${encodeURIComponent(original.thread_id)}?format=metadata&metadataHeaders=From`, { headers: auth(token) }, fetchImpl);
    if (!Array.isArray(data.messages)) throw new EmailProviderError('thread_unavailable', 409);
    return data.messages.some(m => Number(m.internalDate) >= Date.parse(receivedAt) && m.id !== original.provider_message_id &&
      (m.labelIds?.includes('SENT') || mailboxAddress(m.payload?.headers?.find(h => h.name.toLowerCase() === 'from')?.value) === ownerEmail));
  }
  const query = new URLSearchParams({ '$filter': `conversationId eq '${String(original.thread_id).replaceAll("'", "''")}'`, '$select': 'id,sentDateTime', '$top': '100' });
  const data = await providerRequest(`${graph}/me/mailFolders/sentitems/messages?${query}`, { headers: { ...auth(token), Prefer: 'IdType="ImmutableId"' } }, fetchImpl);
  if (!Array.isArray(data.value) || data['@odata.nextLink']) throw new EmailProviderError('thread_unavailable', 409);
  return data.value.some(m => Date.parse(m.sentDateTime) >= Date.parse(receivedAt));
}
