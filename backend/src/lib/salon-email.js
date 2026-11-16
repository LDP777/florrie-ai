import { createHmac, timingSafeEqual } from 'node:crypto';
import { mailboxAddress } from './email-provider.js';

export function salonEmailConfig(owner, env = process.env) {
  const domain = env.SALON_EMAIL_DOMAIN;
  const salons = (env.SALON_EMAIL_SALONS || '').split(',').map(s => s.trim()).filter(Boolean);
  if (env.SALON_EMAIL_ENABLED !== 'true' || env.SALON_EMAIL_DOMAIN_VERIFIED !== 'true' ||
      !/^([a-z0-9-]+\.)+florrie\.ai$/.test(domain || '') || !env.RESEND_API_KEY || !env.SALON_EMAIL_WEBHOOK_SECRET ||
      (owner && !salons.includes('*') && !salons.includes(owner))) return null;
  return { domain, key: env.RESEND_API_KEY, secret: env.SALON_EMAIL_WEBHOOK_SECRET };
}
export function mailboxLocalPart(beautician) {
  const name = String(beautician.booking_slug || beautician.business_name || 'salon').toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').replace(/[^a-z0-9]+/g,'-').replace(/^-+|-+$/g,'').slice(0,45);
  return name.length >= 2 && !['admin','support','postmaster','abuse','noreply','levi'].includes(name) ? name : `salon-${beautician.id.slice(0,8)}`;
}
export function salonFrom(name, address) {
  const label = String(name || 'Your salon').replace(/[\x00-\x1f\x7f<>"\\]/g, '').trim().slice(0,80);
  return `"${label} via Florrie" <${address}>`;
}
export function verifySalonWebhook(raw, headers, secret, now = Date.now()) {
  const id = headers['svix-id'], stamp = headers['svix-timestamp'], signatures = headers['svix-signature'];
  if (!Buffer.isBuffer(raw) || raw.length>65536 || !/^whsec_[A-Za-z0-9+/=]+$/.test(secret || '') ||
      typeof id!=='string' || id.length>200 || !/^\d{10}$/.test(stamp || '') || Math.abs(now/1000-Number(stamp))>300 || typeof signatures!=='string' || signatures.length>2048) return false;
  const expected = createHmac('sha256',Buffer.from(secret.slice(6),'base64')).update(`${id}.${stamp}.`).update(raw).digest();
  return signatures.split(' ').some(value => {
    if (!/^v1,[A-Za-z0-9+/]{43}=$/.test(value)) return false;
    const actual = Buffer.from(value.slice(3),'base64');
    return actual.length===expected.length && timingSafeEqual(actual,expected);
  });
}
const plain = value => String(value || '').slice(0,200000).replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<br\s*\/?\s*>|<\/p>|<\/div>/gi,'\n').replace(/<[^>]+>/g,'').replace(/&nbsp;/g,' ').replace(/&amp;/g,'&').replace(/&lt;/g,'<').replace(/&gt;/g,'>');
export function normaliseSalonEmail(data, address) {
  const headers = Object.fromEntries(Object.entries(data.headers || {}).map(([k,v])=>[k.toLowerCase(),String(v)]));
  const from = mailboxAddress(data.from), replies = data.reply_to || [];
  const reply = mailboxAddress(Array.isArray(replies) ? replies[0] || headers['reply-to'] || from : replies);
  if (!from || from===address || !reply) return null;
  const automatic = (headers['auto-submitted'] && headers['auto-submitted'].toLowerCase()!=='no') || headers['list-id'] || headers['list-unsubscribe'] || /^(bulk|list|junk)$/i.test(headers.precedence || '');
  if (automatic) return null;
  const attachments = Array.isArray(data.attachments) ? data.attachments.length : 0;
  const id = String(data.message_id || '');
  const internetId = /^<[^\s<>\r\n]{1,900}>$/.test(id) ? id : null;
  const verifiedSender = data.authentication?.dmarc === 'pass';
  const replyAllowed = reply===from && (!Array.isArray(replies) || replies.length<=1) && verifiedSender && !!internetId;
  let body = String(data.text || plain(data.html)).trim().slice(0,12000);
  if (attachments) body += `\n\n[${attachments} email attachment${attachments===1?'':'s'}. Attachment viewing is not available in Florrie yet. Ask the sender to include the details in their reply.]`;
  if (!replyAllowed) body += '\n\n[Sender verification needs review. Replying from Florrie is paused for this email.]';
  if (!body.trim()) body = '[Email received without text.]';
  return { from, reply, internetId, subject: String(data.subject || '').replace(/[\r\n]/g,' ').slice(0,250), body, replyAllowed, attachments };
}
export async function resendRequest(path, { method='GET', body, idempotencyKey, key=process.env.RESEND_API_KEY } = {}, fetchImpl=fetch) {
  const response = await fetchImpl(`https://api.resend.com${path}`, { method, redirect:'error', signal:AbortSignal.timeout(12000), headers: {
    Authorization:`Bearer ${key}`, 'Content-Type':'application/json', ...(idempotencyKey ? {'Idempotency-Key':idempotencyKey} : {})
  }, ...(body ? {body:JSON.stringify(body)} : {}) });
  const data = await response.json().catch(()=>({}));
  if (!response.ok) { const error = new Error('Email provider unavailable'); error.status=response.status; throw error; }
  return data;
}
