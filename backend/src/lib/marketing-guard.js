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
 * client's consent and opt-out flags, and keep marketing inside sociable
 * hours.
 *
 * It used to fail OPEN when the phone matched no client, on the argument that
 * phone formats vary and the hard guarantee lived on the inbound side (STOP
 * sets marketing_opted_out_at). It also selected marketing_consent and never
 * read it. That was tolerable with one pilot salon whose clients Ellie knew
 * by name. It is not tolerable for a national launch: PECR reg 22 requires
 * consent (or the soft opt-in) BEFORE the message goes, the ICO fines per
 * message sent rather than per complaint, and "we could not find her row so
 * we texted her anyway" is the opposite of the burden of proof the sender
 * carries. Since 2 September 2026 it fails CLOSED: no match is no send, and a
 * matched client without marketing_consent === true is no send.
 *
 * Transactional messages never come through canSendMarketing at all. Both
 * callers in services/notifications.js gate only the marketing-typed SMS
 * (isMarketingSmsType) and the marketing templates (isMarketingTemplate, and
 * only when the caller has not marked the send transactional). A booking
 * confirmation to a brand new client is not affected by this.
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
    const { data, error } = await supabase
      .from('clients')
      .select('id, first_name, marketing_consent, marketing_opted_out_at')
      .eq('beautician_id', beauticianId)
      .ilike('phone', `%${digits.slice(-9)}`)
      .limit(1)
      .maybeSingle();
    if (error) {
      // A null here now BLOCKS the send (see canSendMarketing), which is the
      // right outcome, but a guard that blocks because the database is down
      // must say so or the drop looks like a consent problem on her record.
      logger.warn({ err: error, beauticianId }, 'findClientByPhone: read failed; the marketing guard will treat this number as unmatched');
      return null;
    }
    return data || null;
  } catch (err) {
    logger.warn({ err, beauticianId }, 'findClientByPhone failed');
    return null;
  }
}

/**
 * Can a marketing-class message go to this number right now?
 * Returns { allowed, reason, client }.
 *
 * Reasons, in the order they are checked: 'quiet_hours', 'no_client_match'
 * (no row on this salon ends in these digits), 'opted_out' (she said STOP,
 * which outranks any consent flag), 'no_consent' (a row, but
 * marketing_consent is not true). See the header for why the last two exist.
 */
export async function canSendMarketing(beauticianId, phone) {
  if (inMarketingQuietHours()) {
    return { allowed: false, reason: 'quiet_hours', client: null };
  }
  const client = await findClientByPhone(beauticianId, phone);
  if (!client) {
    return { allowed: false, reason: 'no_client_match', client: null };
  }
  if (client.marketing_opted_out_at) {
    return { allowed: false, reason: 'opted_out', client };
  }
  if (client.marketing_consent !== true) {
    return { allowed: false, reason: 'no_consent', client };
  }
  return { allowed: true, reason: null, client };
}
