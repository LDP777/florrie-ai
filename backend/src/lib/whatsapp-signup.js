import { createHash, randomInt } from 'node:crypto';
import { getAppSecret } from './env.js';
import { encrypt } from './crypto.js';
import { whatsAppEncryptionKey } from './whatsapp-connection.js';

export const hashSignupSecret = secret => createHash('sha256').update(secret).digest('hex');
export const metaId = value => typeof value === 'string' && /^\d{1,40}$/.test(value);
export function signupConfig() {
  const appId = process.env.WHATSAPP_APP_ID || process.env.META_APP_ID;
  const configId = process.env.WHATSAPP_EMBEDDED_SIGNUP_CONFIG_ID;
  const page = process.env.WHATSAPP_SIGNUP_URL;
  const version = process.env.WHATSAPP_API_VERSION || 'v21.0';
  if (!metaId(appId) || !metaId(configId) || !getAppSecret()) return null;
  try { whatsAppEncryptionKey(); } catch { return null; }
  try {
    const u = new URL(page);
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/api/whatsapp/embedded') return null;
  } catch { return null; }
  if (!/^v\d+\.\d+$/.test(version)) return null;
  return { appId, configId, page, version };
}

export class SignupError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
export async function metaJson(path, { token, body, fetchImpl = fetch, version = 'v21.0' } = {}) {
  let response;
  try {
    response = await fetchImpl(`https://graph.facebook.com/${version}/${path}`, {
      method: body ? 'POST' : 'GET', signal: AbortSignal.timeout(15000),
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? {'Content-Type':'application/json'} : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
  } catch { throw new SignupError('meta_unavailable','Meta did not respond. Return to Florrie and try connecting again.',503); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok || data.error) {
    // Provider messages may include tokens or private assets. Return a safe code only.
    const code = Number(data.error?.code);
    throw new SignupError('meta_rejected',code === 190
      ? 'Meta access expired. Return to Florrie and connect again.'
      : 'Meta could not finish this connection. Keep your existing WhatsApp account and contact hello@florrie.ai if this continues.',502);
  }
  return data;
}

export async function completeWhatsAppSignup({ db, session, code, wabaId, phoneId, config, fetchImpl = fetch }) {
  if (typeof code !== 'string' || code.length < 8 || code.length > 8192 || !metaId(wabaId) || !metaId(phoneId)) {
    throw new SignupError('invalid_response','Meta did not return a complete connection. Start again from Florrie.');
  }
  const graph = (path, options={}) => metaJson(path,{version:config.version,fetchImpl,...options});
  const params = new URLSearchParams({ client_id:config.appId,client_secret:getAppSecret(),code,redirect_uri:'' });
  const exchange = await graph(`oauth/access_token?${params}`);
  const token = exchange.access_token;
  if (!token || typeof token !== 'string') throw new SignupError('missing_token','Meta did not authorise the connection.');
  const debug = await graph(`debug_token?input_token=${encodeURIComponent(token)}`,{token:`${config.appId}|${getAppSecret()}`});
  const d = debug.data;
  const required = ['whatsapp_business_management','whatsapp_business_messaging'];
  if (!d?.is_valid || !metaId(d.user_id) || String(d.app_id) !== config.appId || required.some(scope => !d.scopes?.includes(scope)) ||
    (d.expires_at && d.expires_at * 1000 <= Date.now()) || (d.data_access_expires_at && d.data_access_expires_at * 1000 <= Date.now())) {
    throw new SignupError('invalid_grant','Meta has not granted the required WhatsApp access. Start again and approve both requested permissions.');
  }
  for (const scope of required) {
    const grant = d.granular_scopes?.find(g=>g.scope===scope);
    if (grant?.target_ids?.length && !grant.target_ids.map(String).includes(wabaId)) throw new SignupError('wrong_account','This WhatsApp account was not authorised.');
  }
  // Prove ownership with this customer's token, never a platform credential.
  const waba = await graph(`${wabaId}?fields=id`,{token});
  if (String(waba.id) !== wabaId) throw new SignupError('wrong_account','This WhatsApp account was not authorised.');
  let cursor = null, phone = null;
  for (let page=0;page<10 && !phone;page++) {
    const phones = await graph(`${wabaId}/phone_numbers?fields=id,display_phone_number,code_verification_status,status&limit=100${cursor ? `&after=${encodeURIComponent(cursor)}` : ''}`,{token});
    phone = phones.data?.find(p=>String(p.id)===phoneId);
    cursor = phones.paging?.cursors?.after;
    if (!phones.paging?.next || !cursor) break;
  }
  if (!phone) throw new SignupError('wrong_phone','That number does not belong to the authorised WhatsApp account.');
  if (phone.code_verification_status !== 'VERIFIED') throw new SignupError('unverified_phone','Finish verifying your phone number with Meta before connecting it.');
  // Only Meta's verified token subject can route later privacy callbacks.
  const identity = await db.rpc('bind_whatsapp_signup_identity', {
    p_session: session.id,
    p_subject_hash: createHash('sha256').update('whatsapp:user:' + d.user_id).digest('hex'),
    p_waba_hash: createHash('sha256').update('whatsapp:waba:' + wabaId).digest('hex'),
  });
  if (identity.error || !identity.data) throw new SignupError('grant_changed', 'This authorisation changed or could not be saved. Return to Florrie and connect again.', 409);
  const reserved = await db.rpc('reserve_whatsapp_phone',{p_session:session.id,p_phone:phoneId});
  if (reserved.error) throw new SignupError('storage_unavailable','We could not save this connection. Return to Florrie and try again.',503);
  if (!reserved.data) throw new SignupError('phone_in_use','This number is already connected, or this setup has expired. Return to Florrie to check it.',409);
  const pin = String(randomInt(100000,1000000));
  if (phone.status !== 'CONNECTED') {
    await graph(`${phoneId}/register`,{token,body:{messaging_product:'whatsapp',pin}});
  }
  await graph(`${wabaId}/subscribed_apps`,{token,body:{}});
  const [live, subscriptions] = await Promise.all([
    graph(`${phoneId}?fields=id,status`,{token}), graph(`${wabaId}/subscribed_apps`,{token}),
  ]);
  if (live.status !== 'CONNECTED' || !subscriptions.data?.some(s=>String(s.whatsapp_business_api_data?.id || s.id)===config.appId)) {
    throw new SignupError('activation_pending','Meta is still activating your connection. Return to Florrie and try again shortly.',409);
  }
  const expiries = [d.expires_at,d.data_access_expires_at,exchange.expires_in ? Math.floor(Date.now()/1000)+exchange.expires_in : 0].filter(n=>Number(n)>0);
  const credentials = encrypt({token,pin,beauticianId:session.beautician_id,phoneId,wabaId,
    expiresAt:expiries.length ? new Date(Math.min(...expiries)*1000).toISOString() : null}, whatsAppEncryptionKey());
  const saved = await db.rpc('finish_whatsapp_signup',{p_session:session.id,p_phone:phoneId,p_waba:wabaId,p_display_phone:phone.display_phone_number,p_credentials:credentials});
  if (saved.error || !saved.data) throw new SignupError('save_failed','This setup changed or could not be saved. Return to Florrie to check the connection.',409);
  return {connected:true,phone:phone.display_phone_number};
}
