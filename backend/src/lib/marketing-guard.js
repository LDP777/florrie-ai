/**
 * PECR marketing guard.
 *
 * UK law (PECR reg 22) splits messages into two kinds:
 *   - Service/transactional (confirmations, reminders, replies): always fine.
 *   - Direct marketing (rebook nudges, gap-fill offers, win-backs, campaigns):
 *     allowed to existing clients under the soft opt-in, PROVIDED every message
 *     offers a way out and an opt-out is honoured immediately and forever.
 *
 * This module is the single choke point: classify the message, check the
 * client's opt-out flag, and keep marketing inside sociable hours. It fails
 * OPEN when the client can't be matched (phone formats vary), because the
 * hard guarantee lives on the inbound side: any STOP reply sets
 * marketing_opted_out_at and this guard blocks from then on.
 */
import { supabase } from '../config.js';
import logger from './logger.js';

const MARKETING_TEMPLATE_RE = /^(gap_fill_offer|rebook_nudge|generic_message)/;
const MARKETING_SMS_TYPES = new Set(['marketing', 'rebook_nudge', 'comeback', 'gap_fill', 'win_back', 'campaign']);

export function isMarketingTemplate(name) {
  return MARKETING_TEMPLATE_RE.test(String(name || ''));
}

export function isMarketingSmsType(messageType) {
  return MARKETING_SMS_TYPES.has(String(messageType || ''));
}

/** Marketing only between 08:00 and 21:00 in the salon's own timezone
 *  (defaults to Europe/London when the beautician has none set). */
export function inMarketingQuietHours(now = new Date(), tz = 'Europe/London') {
  let hour;
  try {
    hour = Number(
      new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: tz || 'Europe/London' }).format(now)
    );
  } catch {
    // Bad tz string on the record: fall back to the UK default.
    hour = Number(
      new Intl.DateTimeFormat('en-GB', { hour: 'numeric', hour12: false, timeZone: 'Europe/London' }).format(now)
    );
  }
  return hour >= 21 || hour < 8;
}

/** Best-effort client lookup by phone (formats vary, so match on the last 9 digits). */
export async function findClientByPhone(beauticianId, phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits || digits.length < 7 || !beauticianId) return null;
  try {
    const { data } = await supabase
      .from('clients')
      .select('id, first_name, marketing_consent, marketing_opted_out_at')
      .eq('beautician_id', beauticianId)
      .ilike('phone', `%${digits.slice(-9)}`)
      .limit(1)
      .maybeSingle();
    return data || null;
  } catch (err) {
    logger.warn({ err, beauticianId }, 'findClientByPhone failed');
    return null;
  }
}

/**
 * Can a marketing-class message go to this number right now?
 * Returns { allowed, reason, client }.
 */
export async function canSendMarketing(beauticianId, phone) {
  if (inMarketingQuietHours()) {
    return { allowed: false, reason: 'quiet_hours', client: null };
  }
  const client = await findClientByPhone(beauticianId, phone);
  if (client?.marketing_opted_out_at) {
    return { allowed: false, reason: 'opted_out', client };
  }
  return { allowed: true, reason: null, client };
}
