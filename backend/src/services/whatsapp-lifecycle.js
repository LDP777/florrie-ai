import { createHash, randomBytes } from 'node:crypto';
import { supabase } from '../config.js';

const PARTNER_EVENTS = new Set(['PARTNER_REMOVED', 'PARTNER_APP_UNINSTALLED']);
const metaId = value => typeof value === 'string' && /^\d{1,40}$/.test(value)
  ? value : Number.isSafeInteger(value) && value > 0 ? String(value) : null;

export function hasWhatsAppLifecycleEvent(body) {
  return Array.isArray(body?.entry) && body.entry.some(entry =>
    Array.isArray(entry?.changes) && entry.changes.some(change =>
      change?.field === 'account_update' && PARTNER_EVENTS.has(change.value?.event)));
}

// Called only after the webhook route verifies Meta's signature. Persist before
// acknowledging so Meta can retry a database failure. No provider DELETE calls.
export async function applyWhatsAppLifecycle(body, db = supabase, now = Date.now(), appId = process.env.WHATSAPP_APP_ID || process.env.META_APP_ID) {
  if (body?.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) return 0;
  let saved = 0;
  for (const entry of body.entry) {
    if (!Array.isArray(entry?.changes)) continue;
    for (const change of entry.changes) {
      const event = change?.value?.event;
      if (change?.field !== 'account_update' || !PARTNER_EVENTS.has(event)) continue;
      // Meta's partner-event examples intentionally have a different entry.id:
      // the affected customer account is waba_info.waba_id, never the envelope.
      // https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_update
      const wabaId = metaId(change.value.waba_info?.waba_id);
      let partnerAppId = null;
      if (event === 'PARTNER_APP_UNINSTALLED') {
        partnerAppId = metaId(change.value.waba_info?.partner_app_id);
        const ownAppId = metaId(appId);
        if (!partnerAppId || !ownAppId) throw new Error('WhatsApp lifecycle app identity is unavailable');
        // A signed update about another partner must not revoke our grant.
        if (partnerAppId !== ownAppId) continue;
      }
      const seconds = entry.time;
      if (!metaId(entry.id) || !wabaId
        || !Number.isSafeInteger(seconds) || seconds <= 0 || seconds > Math.floor(now / 1000) + 300) {
        throw new Error('WhatsApp lifecycle event has no valid customer account and timestamp');
      }
      // Stable across JSON key order and duplicate deliveries. One removal per
      // WABA and issued second is sufficient to invalidate the same grant.
      const { error, data } = await db.rpc('request_whatsapp_data_action', {
        p_account_hash: createHash('sha256').update('whatsapp:waba:' + wabaId).digest('hex'),
        p_kind: 'waba', p_action: 'deauthorize', p_issued_at: new Date(seconds * 1000).toISOString(),
        p_event_hash: createHash('sha256').update(`${event}:${wabaId}:${partnerAppId ? partnerAppId + ':' : ''}${seconds}`).digest('hex'),
        p_confirmation_code: randomBytes(24).toString('hex'),
      });
      if (error || !/^[a-f0-9]{48}$/.test(data?.confirmation_code || '')) throw new Error('WhatsApp lifecycle event could not be saved');
      saved++;
    }
  }
  return saved;
}
