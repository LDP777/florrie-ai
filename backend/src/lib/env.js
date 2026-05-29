/**
 * Centralised accessors for env values that ship under more than one name.
 *
 * Meta's official variable names and our shorter names are both accepted (the
 * first set value wins), because Railway provisions with the Meta names while
 * local/dev uses the short ones. Reading these in one place stops a deploy that
 * sets only one alias from silently breaking webhook signature checks (M9).
 */

/** WhatsApp/Meta app secret used for webhook HMAC-SHA256 verification. */
export function getAppSecret() {
  return process.env.WHATSAPP_APP_SECRET || process.env.META_APP_SECRET;
}

/** WhatsApp webhook verification token (Meta challenge handshake). */
export function getWhatsAppVerifyToken() {
  return process.env.WHATSAPP_VERIFY_TOKEN;
}
