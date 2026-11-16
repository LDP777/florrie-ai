import { afterEach, it, expect, vi } from 'vitest';
vi.mock('../../src/config.js', () => ({ supabase: {} }));
import { completeWhatsAppSignup } from '../../src/lib/whatsapp-signup.js';
import { appMessages, hasWhatsAppAppEvent } from '../../src/services/whatsapp-business-app.js';
import { businessAppSignupEnabled } from '../../src/lib/whatsapp-connection.js';
afterEach(() => vi.unstubAllEnvs());
function setup({ linked = true, fields = true, ambiguous = false } = {}) {
  vi.stubEnv('WHATSAPP_APP_SECRET', 'secret'); vi.stubEnv('WHATSAPP_CREDENTIALS_KEY', 'ab'.repeat(32));
  const calls = [], db = { rpc: vi.fn(async () => ({ data: true })) };
  const fetchImpl = async (url, options) => {
    const path = new URL(url).pathname; calls.push(path);
    let data;
    if (path.endsWith('/oauth/access_token')) data = { access_token: 'customer' };
    else if (path.endsWith('/debug_token')) data = { data: { is_valid: true, app_id: '100', user_id: '555', scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'] } };
    else if (path.endsWith('/100/subscriptions')) data = { data: [{ object: 'whatsapp_business_account', fields: (fields ? ['messages','account_update','history','smb_app_state_sync','smb_message_echoes'] : ['messages']).map(name => ({ name })) }] };
    else if (path.endsWith('/300/phone_numbers')) data = { data: ambiguous ? [{ id: '400' }, { id: '401' }] : [{ id: '400', display_phone_number: '+447700900001' }] };
    else if (path.endsWith('/300/subscribed_apps')) data = options.method === 'POST' ? { success: true } : { data: [{ id: '100' }] };
    else if (path.endsWith('/400')) data = { id: '400', is_on_biz_app: linked, platform_type: 'CLOUD_API' };
    else if (path.endsWith('/300')) data = { id: '300' };
    else throw new Error('Unexpected API call');
    return Response.json(data);
  };
  const run = () => completeWhatsAppSignup({ db, fetchImpl, session: { id: 'session', beautician_id: 'salon', signup_mode: 'business_app' }, code: 'auth-code', wabaId: '300', config: { appId: '100', version: 'v21.0' } });
  return { run, db, calls };
}
it('verifies coexistence and saves a WABA-only completion without registering or changing the number PIN', async () => {
  const s = setup(); expect(await s.run()).toMatchObject({ connected: true }); expect(s.calls.some(x => x.endsWith('/register'))).toBe(false);
  expect(s.db.rpc.mock.calls.map(x => x[0])).toEqual(['bind_whatsapp_signup_identity','reserve_whatsapp_phone','finish_whatsapp_signup']);
});
it.each([{ linked: false }, { fields: false }, { ambiguous: true }])('does not connect incomplete or ambiguous Business app setup: %j', async options => {
  const s = setup(options); await expect(s.run()).rejects.toThrow(); expect(s.db.rpc).not.toHaveBeenCalled(); expect(s.calls.some(x => x.endsWith('/register'))).toBe(false);
});
it('requires an explicit salon allowlist before exposing Business app onboarding', () => {
  vi.stubEnv('WHATSAPP_TENANT_CREDENTIALS_ENABLED', 'true'); vi.stubEnv('WHATSAPP_EMBEDDED_SIGNUP_ENABLED', 'true'); vi.stubEnv('WHATSAPP_BUSINESS_APP_ENABLED', 'true');
  vi.stubEnv('WHATSAPP_BUSINESS_APP_SALONS', ''); expect(businessAppSignupEnabled('demo')).toBe(false);
  vi.stubEnv('WHATSAPP_BUSINESS_APP_SALONS', 'demo'); expect(businessAppSignupEnabled('demo')).toBe(true); expect(businessAppSignupEnabled('live-salon')).toBe(false);
});
it('distinguishes owner echoes and historical client messages without inventing missing phone identities', () => {
  const one = { id: 'one', timestamp: '1794823200', type: 'text', text: { body: 'I have replied myself' } };
  expect(appMessages('smb_message_echoes', { message_echoes: [{ ...one, to: '447700900001' }] })[0]).toMatchObject({ direction: 'outbound', recipient: '447700900001' });
  expect(appMessages('smb_message_echoes', { message_echoes: [{ ...one, to_user_id: 'bsuid' }] })[0].recipient).toBe('');
  expect(appMessages('history', { history: [{ threads: [{ id: '447700900001', messages: [one, { ...one, to: '447700900001' }] }] }] }).map(x => x.direction)).toEqual(['inbound', 'outbound']);
  expect(hasWhatsAppAppEvent({ entry: [{ changes: [{ field: 'messages' }, { field: 'smb_message_echoes' }] }] })).toBe(true);
});
