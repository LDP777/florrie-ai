import { createHash } from 'node:crypto';
import { supabase } from '../config.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { resolveWhatsAppCredentials, tenantWhatsAppEnabled, whatsAppEncryptionKey } from '../lib/whatsapp-connection.js';
import { metaJson } from '../lib/whatsapp-signup.js';
import logger from '../lib/logger.js';

const fields = new Set(['history', 'smb_app_state_sync', 'smb_message_echoes']);
const checked = r => { if (r.error) throw new Error('WhatsApp app storage unavailable'); return r.data; };
export const hasWhatsAppAppEvent = body => body?.entry?.some(e => e.changes?.some(c => fields.has(c.field))) === true;
export function appMessages(field, value) {
  const messages = [];
  const add = (m, recipient, direction, author = 'human') => {
    const at = new Date(Number(m.timestamp) * 1000);
    if (!m.id || !Number.isFinite(at.getTime())) return;
    const body = m.type === 'text' ? m.text?.body : m.type === 'reaction' ? m.reaction?.emoji : `[WhatsApp ${m.type || 'message'}: open WhatsApp to view]`;
    if (!body) return;
    messages.push({ author, id: m.id, recipient: recipient || '', direction, body: String(body).slice(0, 12000), at: at.toISOString() });
  };
  if (field === 'smb_message_echoes') for (const m of value.message_echoes || []) add(m, m.to, 'outbound');
  if (field === 'history') for (const batch of value.history || []) for (const thread of batch.threads || []) {
    for (const m of thread.messages || []) {
      const ownPhone = String(value.metadata?.display_phone_number || '').replace(/[^0-9]/g, '');
      const outbound = !!m.to || (!!ownPhone && m.from === ownPhone);
      add(m, m.to || thread.context?.wa_id || thread.id || m.from, outbound ? 'outbound' : 'inbound', m.to ? 'human' : 'unknown');
    }
  }
  return messages;
}
export async function captureWhatsAppAppEvents(body, db = supabase) {
  if (!tenantWhatsAppEnabled() || !hasWhatsAppAppEvent(body)) return;
  for (const entry of body.entry || []) for (const change of entry.changes || []) {
    if (!fields.has(change.field)) continue;
    const phone = change.value?.metadata?.phone_number_id;
    if (!phone) throw new Error('WhatsApp app event has no phone owner');
    const c = checked(await db.from('whatsapp_connections').select('*').eq('phone_id', phone).eq('waba_id', entry.id).eq('business_app', true).maybeSingle());
    if (!c) continue;
    const payload = JSON.stringify(change.value);
    const id = createHash('sha256').update(`${c.beautician_id}:${c.connected_at}:${change.field}:${payload}`).digest('hex');
    checked(await db.from('whatsapp_app_events').upsert({ id, beautician_id: c.beautician_id, phone_id: phone, waba_id: entry.id, connected_at: c.connected_at, field: change.field,
      payload: encrypt({ owner: c.beautician_id, value: change.value }, whatsAppEncryptionKey()) }, { onConflict: 'id', ignoreDuplicates: true }));
    // Commit human-authored echoes before acknowledging them. This is context for the next inbound message.
    if (change.field === 'smb_message_echoes') {
      for (const m of appMessages(change.field, change.value)) {
        checked(await db.rpc('import_whatsapp_app_message', { p_owner: c.beautician_id, p_phone: phone, p_connected_at: c.connected_at, p_message: m }));
      }
      const unknown = appMessages(change.field, change.value).some(m => !/^[0-9]{7,15}$/.test(m.recipient));
      checked(await db.from('whatsapp_app_events').update({ status: unknown ? 'needs_review' : 'processed', payload: unknown ? encrypt({ owner: c.beautician_id, value: change.value }, whatsAppEncryptionKey()) : null, processed_at: new Date().toISOString() }).eq('id', id));
    }
  }
}

export async function processWhatsAppBusinessApp() {
  if (!tenantWhatsAppEnabled()) return;
  const db = supabase;
  const connections = checked(await db.from('whatsapp_connections').select('*').eq('business_app', true).limit(50));
  for (const c of connections || []) {
    const credentials = await resolveWhatsAppCredentials(c.beautician_id, c.phone_id);
    if (!credentials) continue;
    for (const kind of ['smb_app_state_sync', 'history']) {
      if (c.app_sync?.[kind]?.state) continue;
      const sync = { ...c.app_sync, [kind]: { state: 'requested', at: new Date().toISOString() } };
      const saved = checked(await db.from('whatsapp_connections').update({ app_sync: sync }).eq('beautician_id', c.beautician_id).eq('connected_at', c.connected_at).eq('app_sync', JSON.stringify(c.app_sync)).select('beautician_id').maybeSingle());
      if (!saved) break;
      c.app_sync = sync;
      try {
        if (Date.now() - Date.parse(c.connected_at) > 24 * 3600000) throw new Error('Sync window elapsed');
        const response = await metaJson(`${c.phone_id}/smb_app_data`, { token: credentials.token, body: { messaging_product: 'whatsapp', sync_type: kind }, version: process.env.WHATSAPP_API_VERSION || 'v21.0' });
        if (!response.request_id) throw new Error('Sync not confirmed');
        // Webhooks may already have marked completion. Do not overwrite their status.
      } catch {
        const attention = { ...sync, [kind]: { state: 'needs_review', at: new Date().toISOString() } };
        await db.from('whatsapp_connections').update({ app_sync: attention }).eq('beautician_id', c.beautician_id).eq('connected_at', c.connected_at).eq('app_sync', JSON.stringify(sync));
        c.app_sync = attention;
      }
    }
  }
  const events = checked(await db.from('whatsapp_app_events').select('*').eq('status', 'pending').order('created_at').limit(20));
  for (const event of events || []) {
    try {
      const c = checked(await db.from('whatsapp_connections').select('*').eq('beautician_id', event.beautician_id).eq('phone_id', event.phone_id).eq('waba_id', event.waba_id).eq('connected_at', event.connected_at).eq('business_app', true).maybeSingle());
      if (!c) { checked(await db.from('whatsapp_app_events').update({ status: 'processed', payload: null, processed_at: new Date().toISOString() }).eq('id', event.id)); continue; }
      const decoded = decrypt(event.payload, whatsAppEncryptionKey());
      if (decoded.owner !== event.beautician_id) throw new Error('Owner mismatch');
      const value = decoded.value, messages = appMessages(event.field, value);
      const batch = messages.slice(event.cursor, event.cursor + 50);
      for (const m of batch) checked(await db.rpc('import_whatsapp_app_message', { p_owner: c.beautician_id, p_phone: c.phone_id, p_connected_at: c.connected_at, p_message: m }));
      const more = event.cursor + batch.length < messages.length;
      if (!more && event.field === 'smb_app_state_sync') {
        // Enrich only existing placeholder contacts. A personal address book is not a client list.
        for (const item of value.state_sync || []) {
          const phone = item.contact?.phone_number, name = item.contact?.first_name || item.contact?.full_name;
          if (item.type !== 'contact' || item.action !== 'add' || !/^[0-9]{7,15}$/.test(phone || '') || typeof name !== 'string') continue;
          checked(await db.from('clients').update({ first_name: name.slice(0, 120) }).eq('beautician_id', c.beautician_id).eq('whatsapp_id', phone).eq('first_name', 'WhatsApp contact'));
        }
      }
      const needsReview = messages.some(m => !/^[0-9]{7,15}$/.test(m.recipient));
      checked(await db.from('whatsapp_app_events').update(more ? { cursor: event.cursor + batch.length } : { status: needsReview ? 'needs_review' : 'processed', payload: null, processed_at: new Date().toISOString() }).eq('id', event.id));
      if (!more) {
        const declined = value.history?.some(h => h.errors?.some(e => e.code === 2593109));
        const progress = Math.max(0, ...(value.history || []).map(h => Number(h.metadata?.progress) || 0));
        const prior = c.app_sync?.[event.field] || {};
        const state = needsReview ? 'needs_review' : declined ? 'declined' : event.field === 'smb_app_state_sync' || progress === 100 || prior.state === 'complete' ? 'complete' : 'syncing';
        await db.from('whatsapp_connections').update({ app_sync: { ...c.app_sync, [event.field]: { state, progress: Math.max(progress, prior.progress || 0), at: new Date().toISOString() } } }).eq('beautician_id', c.beautician_id).eq('connected_at', c.connected_at).eq('app_sync', JSON.stringify(c.app_sync));
      }
    } catch { logger.warn({ event: event.id }, 'WhatsApp app sync will retry'); }
  }
}
