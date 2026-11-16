import { randomUUID } from 'node:crypto';
import { supabase } from '../config.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { emailKey, emailProviderConfig, exchangeEmailToken, readEmailPage, replyToEmail, ownerAlreadyReplied, EmailProviderError } from '../lib/email-provider.js';
import logger from '../lib/logger.js';

const confirmed = result => { if (result.error) throw new EmailProviderError('storage_unavailable'); return result.data; };
export const emailErrorMessage = code => ({
  reconnect: 'Reconnect your email account to continue.',
  busy: 'Your mailbox is being checked. Try again shortly.',
  reply_address_changed: 'This email asks for replies to a different address. Review it in your email app.',
  thread_unavailable: 'Open this conversation in your email app to reply.',
  unconfirmed: 'We could not confirm whether your email was sent. Check Sent in your email app before replying again.',
  already_sent: 'A reply is already sent or awaiting confirmation. Check the conversation and your email app.',
  owner_replied: 'You have already replied in your email app. Open that thread there to continue.',
  disabled: 'Email connections are not available for this account yet.',
}[code] || 'Email could not be checked. Your connection is saved; try again shortly.');

export function createEmailConnections({ db = supabase, fetchImpl = fetch, preview = async args => (await import('./ai-front-desk.js')).previewClientQuestion(args) } = {}) {
  const update = (c, values) => db.from('email_connections').update(values).eq('id', c.id).eq('generation', c.generation).eq('lease_token', c.lease_token).select('id').maybeSingle();
  async function withConnection(owner, work) {
    const lease = randomUUID();
    const rows = confirmed(await db.rpc('claim_email_connection', { p_owner: owner, p_lease: lease }));
    const c = rows?.[0];
    if (!c) throw new EmailProviderError('busy', 409);
    try {
      const config = emailProviderConfig(c.provider, owner);
      if (!config) throw new EmailProviderError('disabled', 503);
      let tokens;
      try { tokens = decrypt(c.credentials, emailKey()); } catch { throw new EmailProviderError('storage_unavailable'); }
      if (tokens.owner !== owner || tokens.provider !== c.provider || tokens.subject !== c.account_subject) throw new EmailProviderError('storage_unavailable');
      if (tokens.expires_at < Date.now() + 60000) {
        const fresh = await exchangeEmailToken(config, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token }, fetchImpl);
        tokens = { ...tokens, access_token: fresh.access_token, refresh_token: fresh.refresh_token || tokens.refresh_token, expires_at: Date.now() + fresh.expires_in * 1000 };
        if (!confirmed(await update(c, { credentials: encrypt(tokens, emailKey()) }))) throw new EmailProviderError('connection_changed');
      }
      return await work(c, tokens.access_token);
    } catch (e) {
      await update(c, { error_code: e.code || 'unavailable', ...(e.code === 'reconnect' ? { status: 'reconnect' } : {}) });
      throw e;
    } finally { await update(c, { lease_until: null, lease_token: null }); }
  }

  async function sync(owner) {
    return withConnection(owner, async (c, token) => {
      const started = c.sync_started_at || new Date().toISOString();
      const page = await readEmailPage(c.provider, token, c.sync_after, c.sync_cursor, fetchImpl, started);
      const imported = [];
      for (const m of page.messages) {
        const id = confirmed(await db.rpc('import_mailbox_message', { p_connection: c.id, p_generation: c.generation, p_lease: c.lease_token, p_mail: m }));
        if (id) imported.push({ id, m });
      }
      const stamp = new Date().toISOString();
      const saved = confirmed(await update(c, { last_checked_at: stamp, error_code: null, sync_cursor: page.next,
        sync_started_at: page.next ? started : null, ...(page.next ? {} : { last_synced_at: stamp, sync_after: new Date(Math.max(Date.parse(c.sync_after), Date.parse(started) - 60000)).toISOString() }) }));
      if (!saved) throw new EmailProviderError('connection_changed');
      // A separate, read-only answer path. Never enter the booking/action engine.
      if (c.ai_drafts && imported.length) {
        const b = confirmed(await db.from('beauticians').select('*').eq('id', owner).single());
        for (const { id, m } of imported.slice(0, 3)) {
          if (m.body.length > 1000) continue;
          try {
            const answer = await preview({ beautician: b, question: m.body });
            const current = confirmed(await db.from('email_connections').select('generation,status,ai_drafts').eq('id', c.id).single());
            if (current.generation !== c.generation || current.status !== 'connected' || !current.ai_drafts) break;
            if (answer?.canAnswer && answer.reply) confirmed(await db.from('messages').update({ ai_response: answer.reply, escalated: true, escalated_reason: 'Email draft ready for your approval' }).eq('id', id).eq('beautician_id', owner).eq('resolved', false));
          } catch { logger.warn({ owner }, 'Email imported; draft could not be prepared'); }
        }
      }
      return { imported: imported.length, more: !!page.next };
    });
  }

  async function reply({ owner, clientId, messageId, body, author = 'human' }) {
    return withConnection(owner, async (c, token) => {
      const message = confirmed(await db.from('messages').select('id,client_id,created_at').eq('id', messageId).eq('beautician_id', owner).eq('client_id', clientId).eq('channel', 'email').eq('direction', 'inbound').maybeSingle());
      if (!message) throw new EmailProviderError('thread_unavailable', 409);
      const link = confirmed(await db.from('email_message_links').select('*').eq('message_id', message.id).eq('connection_id', c.id).maybeSingle());
      if (!link || link.account_key !== `${c.provider}:${c.account_subject}`) throw new EmailProviderError('thread_unavailable', 409);
      // Validate the recipient before creating a send attempt.
      if (link.reply_email !== link.sender_email) throw new EmailProviderError('reply_address_changed', 409);
      if (await ownerAlreadyReplied(c.provider, token, link, c.email, message.created_at, fetchImpl)) throw new EmailProviderError('owner_replied', 409);
      const outbound = confirmed(await db.rpc('prepare_mailbox_reply', { p_owner: owner, p_inbound: message.id, p_generation: c.generation, p_body: body, p_author: author }));
      if (!outbound) throw new EmailProviderError('already_sent', 409);
      let status = 'unknown', receipt = null;
      try {
        receipt = await replyToEmail(c.provider, token, link, body, fetchImpl);
        status = 'accepted';
      } catch (e) {
        // Explicit 4xx rejection is safe to retry. Timeouts/5xx may follow a successful send.
        status = e.status >= 400 && e.status < 500 ? 'failed' : 'unknown';
        confirmed(await db.rpc('finish_mailbox_reply', { p_outbound: outbound, p_status: status, p_provider_id: null }));
        throw status === 'unknown' ? new EmailProviderError('unconfirmed', 409) : e;
      }
      const saved = await db.rpc('finish_mailbox_reply', { p_outbound: outbound, p_status: status, p_provider_id: receipt.id || null });
      if (saved.error) throw new EmailProviderError('unconfirmed', 409);
      const finished = saved.data;
      if (!finished) throw new EmailProviderError('unconfirmed', 409);
      return confirmed(await db.from('messages').select('*').eq('id', outbound).eq('beautician_id', owner).single());
    });
  }
  return { sync, reply };
}
export const emailConnections = createEmailConnections();
export async function processConnectedEmails() {
  if (!['EMAIL_GOOGLE_ENABLED', 'EMAIL_MICROSOFT_ENABLED'].some(k => process.env[k] === 'true')) return;
  confirmed(await supabase.from('email_connection_sessions').update({ verifier: '', status: 'failed' }).in('status', ['pending', 'processing']).lt('expires_at', new Date().toISOString()));
  const rows = confirmed(await supabase.from('email_connections').select('beautician_id,provider').eq('status', 'connected').order('last_checked_at', { ascending: true, nullsFirst: true }).limit(20));
  const deadline = Date.now() + 4 * 60 * 1000;
  for (const row of rows || []) {
    if (Date.now() > deadline) break;
    if (!emailProviderConfig(row.provider, row.beautician_id)) continue;
    try { await emailConnections.sync(row.beautician_id); }
    catch (e) { logger.warn({ owner: row.beautician_id, code: e.code || 'unavailable' }, 'Email check incomplete'); }
  }
}
