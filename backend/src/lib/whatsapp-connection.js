import { supabase } from '../config.js';
import { decrypt } from './crypto.js';

// A separate shared key avoids changing encryption for existing integrations
// when API deployments have different historical ENCRYPTION_KEY settings.
export function whatsAppEncryptionKey() {
  const key = process.env.WHATSAPP_CREDENTIALS_KEY || process.env.ENCRYPTION_KEY;
  if (!/^[a-f0-9]{64}$/i.test(key || '')) throw new Error('WhatsApp credential encryption is not configured');
  return key;
}

export function tenantWhatsAppEnabled() {
  return process.env.WHATSAPP_TENANT_CREDENTIALS_ENABLED === 'true';
}
export function embeddedSignupEnabled(salonId) {
  if (!tenantWhatsAppEnabled() || process.env.WHATSAPP_EMBEDDED_SIGNUP_ENABLED !== 'true') return false;
  const allow = (process.env.WHATSAPP_EMBEDDED_SIGNUP_SALONS || '').split(',').map(s => s.trim()).filter(Boolean);
  return !allow.length || allow.includes(salonId);
}
export async function readWhatsAppConnection(salonId, db = supabase) {
  if (!salonId) return null;
  const { data, error } = await db.from('whatsapp_connections').select('*').eq('beautician_id', salonId).maybeSingle();
  if (error) throw new Error('WhatsApp connection could not be checked');
  return data;
}

// While tenant mode is disabled, the deployed legacy sender is unchanged.
// Enabling it requires the additive snapshot migration to have been verified.
export async function resolveWhatsAppCredentials(salonId, phoneId, db = supabase) {
  const legacy = {
    token: process.env.WHATSAPP_TOKEN || process.env.WHATSAPP_ACCESS_TOKEN,
    wabaId: process.env.WHATSAPP_WABA_ID || process.env.WHATSAPP_BUSINESS_ACCOUNT_ID,
    phoneId, mode: 'legacy',
  };
  if (!tenantWhatsAppEnabled()) return legacy.token && phoneId ? legacy : null;
  const connection = await readWhatsAppConnection(salonId, db);
  if (!connection || connection.phone_id !== phoneId) return null;
  if (connection.mode === 'legacy') return legacy.token ? legacy : null;
  const secret = decrypt(connection.credentials, whatsAppEncryptionKey());
  if (secret.beauticianId !== salonId || secret.phoneId !== phoneId || secret.wabaId !== connection.waba_id) {
    throw new Error('WhatsApp credential ownership mismatch');
  }
  if (!secret.token || (secret.expiresAt && Date.parse(secret.expiresAt) <= Date.now())) return null;
  return { token: secret.token, phoneId, wabaId: connection.waba_id, mode: 'embedded' };
}
