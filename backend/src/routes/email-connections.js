import { Router } from 'express';
import { supabase } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { encrypt, decrypt } from '../lib/crypto.js';
import { authorizationUrl, checkedScopes, emailKey, emailProviderConfig, exchangeEmailToken, mailboxIdentity, mailboxProviders, newSecret, stateHash } from '../lib/email-provider.js';
import { emailConnections, emailErrorMessage } from '../services/email-connections.js';

const router = Router();
const run = fn => (req, res) => Promise.resolve(fn(req, res)).catch(e => {
  if (!res.headersSent) res.status(e.status === 409 ? 409 : 503).json({ error: emailErrorMessage(e.code) });
});
router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); res.set('Referrer-Policy', 'no-referrer'); next(); });
router.get('/status', requireAuth, run(async (req, res) => {
  const providers = mailboxProviders.map(id => ({ id, available: !!emailProviderConfig(id, req.beautician.id) }));
  const { data, error } = await supabase.from('email_connections').select('provider,email,status,ai_drafts,client_emails_only,last_checked_at,last_synced_at,error_code,connected_at').eq('beautician_id', req.beautician.id).maybeSingle();
  if (error) throw new Error('Connection status unavailable');
  res.json({ providers, connection: data ? { ...data, error: data.error_code ? emailErrorMessage(data.error_code) : null } : null });
}));
router.post('/start', requireAuth, run(async (req, res) => {
  const provider = req.body?.provider;
  const config = emailProviderConfig(provider, req.beautician.id);
  if (!config) return res.status(503).json({ error: emailErrorMessage('disabled') });
  // The checkbox is a separate, explicit permission to use Anthropic for email drafts.
  if (req.body.ai_drafts === true && req.body.ai_consent !== 'anthropic-email-drafts-v1') return res.status(400).json({ error: 'Choose whether to allow AI email drafts before continuing.' });
  const state = newSecret(), verifier = newSecret();
  const { data, error } = await supabase.rpc('start_email_connection', { p_owner: req.beautician.id, p_provider: provider, p_hash: stateHash(state),
    p_verifier: encrypt({ verifier, owner: req.beautician.id }, emailKey()), p_platform: req.body.platform === 'native' ? 'native' : 'web',
    p_ai: req.body.ai_drafts === true, p_clients_only: req.body.client_emails_only !== false });
  if (error || !data) throw new Error('Start failed');
  res.json({ url: authorizationUrl(config, state, verifier) });
}));
router.get('/callback/:provider', run(async (req, res) => {
  let platform = 'native';
  const finish = ok => {
    if (platform === 'web') return res.redirect(`https://florrie.ai/connections?email=${ok ? 'connected' : 'incomplete'}`);
    res.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'");
    return res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Florrie email setup</title><body style="background:#FBF6F1;color:#241B17;padding:32px;font-family:system-ui"><h1>${ok ? 'Email connected' : 'Email connection incomplete'}</h1><p>Close this browser to return to Florrie. ${ok ? 'Your connection will be checked there.' : 'You can try again from Message connections.'}</p></body></html>`);
  };
  const { state, code } = req.query;
  if (typeof state !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(state) || !mailboxProviders.includes(req.params.provider)) return finish(false);
  const { data: session, error } = await supabase.from('email_connection_sessions').update({ status: 'processing' })
    .eq('state_hash', stateHash(state)).eq('provider', req.params.provider).eq('status', 'pending').gt('expires_at', new Date().toISOString()).select('*').maybeSingle();
  if (error || !session) return finish(false);
  platform = session.platform;
  try {
    const config = emailProviderConfig(session.provider, session.beautician_id);
    if (!config || req.query.error || typeof code !== 'string' || !code || code.length > 10000) throw new Error('Incomplete permission');
    const saved = decrypt(session.verifier, emailKey());
    if (saved.owner !== session.beautician_id) throw new Error('Owner mismatch');
    const tokens = await exchangeEmailToken(config, { code, grant_type: 'authorization_code', redirect_uri: config.redirect, code_verifier: saved.verifier });
    if (!checkedScopes(session.provider, tokens.scope) || !tokens.refresh_token) throw new Error('Missing permissions');
    const identity = await mailboxIdentity(session.provider, tokens.access_token);
    const credentials = encrypt({ owner: session.beautician_id, provider: session.provider, subject: identity.subject,
      access_token: tokens.access_token, refresh_token: tokens.refresh_token, expires_at: Date.now() + tokens.expires_in * 1000 }, emailKey());
    const result = await supabase.rpc('finish_email_connection', { p_session: session.id, p_subject: identity.subject, p_email: identity.email, p_credentials: credentials });
    if (result.error || result.data !== true) throw new Error('Save not confirmed');
    return finish(true);
  } catch {
    await supabase.from('email_connection_sessions').update({ status: 'failed', verifier: '' }).eq('id', session.id).eq('status', 'processing');
    return finish(false);
  }
}));
router.post('/check', requireAuth, run(async (req, res) => res.json(await emailConnections.sync(req.beautician.id))));
router.post('/preferences', requireAuth, run(async (req, res) => {
  if (req.body?.ai_drafts === true && req.body.ai_consent !== 'anthropic-email-drafts-v1') return res.status(400).json({ error: 'Confirm AI permission before enabling drafts.' });
  const { data, error } = await supabase.from('email_connections').update({ ai_drafts: req.body?.ai_drafts === true, ai_consent_version: req.body?.ai_drafts === true ? 'anthropic-email-drafts-v1' : null, ai_preference_updated_at: new Date().toISOString(), client_emails_only: req.body?.client_emails_only !== false })
    .eq('beautician_id', req.beautician.id).eq('status', 'connected').select('id').maybeSingle();
  if (error || !data) throw new Error('Preferences not saved');
  res.json({ saved: true });
}));
router.post('/disconnect', requireAuth, run(async (req, res) => {
  const { data, error } = await supabase.rpc('disconnect_email_connection', { p_owner: req.beautician.id });
  if (error || data !== true) throw new Error('Disconnect not confirmed');
  res.json({ disconnected: true });
}));
export default router;
