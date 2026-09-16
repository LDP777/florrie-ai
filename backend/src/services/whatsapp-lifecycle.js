import { createHash, randomBytes } from 'node:crypto';
import { supabase } from '../config.js';

// Called only after the webhook route verifies Meta's signature. Persist before
// acknowledging so Meta can retry a database failure. No provider DELETE calls.
export async function applyWhatsAppLifecycle(body, db = supabase, now = Date.now()) {
  if (body?.object !== 'whatsapp_business_account' || !Array.isArray(body.entry)) return 0;
  let saved = 0;
  for (const entry of body.entry) {
    if (!Array.isArray(entry?.changes)) continue;
    for (const change of entry.changes) {
      if (change?.field !== 'account_update' || change.value?.event !== 'PARTNER_REMOVED') continue;
      const wabaId = entry.id;
      const seconds = entry.time;
      if (typeof wabaId !== 'string' || !/^\d{1,40}$/.test(wabaId)
        || !Number.isSafeInteger(seconds) || seconds <= 0 || seconds > Math.floor(now / 1000) + 300
        || (change.value.waba_info?.waba_id != null && String(change.value.waba_info.waba_id) !== wabaId)) {
        throw new Error('WhatsApp lifecycle event has no consistent account and timestamp');
      }
      // Stable across JSON key order and duplicate deliveries. One removal per
      // WABA and issued second is sufficient to invalidate the same grant.
      const { error, data } = await db.rpc('request_whatsapp_data_action', {
        p_account_hash: createHash('sha256').update('whatsapp:waba:' + wabaId).digest('hex'),
        p_kind: 'waba', p_action: 'deauthorize', p_issued_at: new Date(seconds * 1000).toISOString(),
        p_event_hash: createHash('sha256').update(`PARTNER_REMOVED:${wabaId}:${seconds}`).digest('hex'),
        p_confirmation_code: randomBytes(24).toString('hex'),
      });
      if (error || !/^[a-f0-9]{48}$/.test(data?.confirmation_code || '')) throw new Error('WhatsApp lifecycle event could not be saved');
      saved++;
    }
  }
  return saved;
}
