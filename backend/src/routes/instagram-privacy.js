import { Router } from 'express';
import { randomBytes } from 'node:crypto';
import { supabase } from '../config.js';
import { InvalidMetaRequest, verifyMetaSignedRequest } from '../lib/meta-signed-request.js';
import logger from '../lib/logger.js';

const router = Router();
const codePattern = /^[a-f0-9]{48}$/;
const support = 'hello@florrie.ai';

export function instagramPrivacyOrigin() {
  const url = new URL(process.env.INSTAGRAM_REDIRECT_URI || 'http://localhost:3001');
  if (process.env.NODE_ENV === 'production' && url.protocol !== 'https:') throw new Error('HTTPS callback origin required');
  return url.origin;
}

function page(title, text, reference = '') {
  // All interpolated values are server-owned strings or validated hex codes.
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} | Florrie</title><style>body{margin:0;background:#fbf6f0;color:#2c2526;font:17px/1.6 system-ui,sans-serif}main{max-width:620px;margin:10vh auto;padding:28px}h1{font:36px Georgia,serif;color:#934063}a{color:#934063}code{overflow-wrap:anywhere}</style></head><body><main><p>florrie.ai</p><h1>${title}</h1><p>${text}</p>${reference ? `<p>Reference: <code>${reference}</code></p>` : ''}<p>Contact <a href="mailto:${support}">${support}</a> about your request.</p><p><a href="https://florrie.ai/privacy">Privacy policy</a></p></main></body></html>`;
}

router.use((_req, res, next) => {
  res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'" });
  next();
});

router.get('/data-deletion', (_req, res) => res.type('html').send(page('Instagram data requests',
  'You can request removal of the data Florrie received through Instagram by removing Florrie in Instagram’s Apps and websites settings and choosing the data-deletion option, or by emailing us from the address on your Florrie account. Include your Instagram username. We will verify the request and review the affected records. Disconnecting Instagram stops the connection; it does not by itself erase your salon’s existing records.')));

for (const [path, action] of [['/deauthorize', 'deauthorize'], ['/data-deletion', 'delete']]) {
  router.post(path, async (req, res) => {
    try {
      // Only the Instagram app's secret can authorize an Instagram data action.
      // Never fall back to a different Meta app's credential or a user JWT.
      const verified = verifyMetaSignedRequest(req.body?.signed_request, process.env.INSTAGRAM_APP_SECRET);
      const origin = instagramPrivacyOrigin();
      const { data, error } = await supabase.rpc('request_instagram_data_action', {
        p_account_hash: verified.accountHash, p_action: action, p_issued_at: verified.issuedAt,
        p_event_hash: verified.eventHash, p_confirmation_code: randomBytes(24).toString('hex'),
      });
      if (error || !data || !codePattern.test(data.confirmation_code || '')) throw new Error('Request was not saved');
      if (action === 'deauthorize') return res.json({ success: true });
      // A receipt means saved, not deleted. The status page reports review as
      // incomplete until an operator records evidence of the actual cleanup.
      res.json({ url: `${origin}/api/instagram/privacy/data-deletion/status/${data.confirmation_code}`,
        confirmation_code: data.confirmation_code });
    } catch (error) {
      if (error instanceof InvalidMetaRequest) return res.status(403).json({ error: 'Invalid signed request' });
      logger.error({ action }, 'Instagram privacy request could not be saved');
      res.status(503).json({ error: 'Your request could not be saved. Please try again.' });
    }
  });
}

router.get('/data-deletion/status/:code', async (req, res) => {
  if (!codePattern.test(req.params.code)) return res.status(404).type('html').send(page('Request not found', 'Check the reference link supplied with your request.'));
  try {
    const { data, error } = await supabase.from('instagram_privacy_requests')
      .select('status').eq('confirmation_code', req.params.code).eq('action', 'delete').maybeSingle();
    if (error) throw error;
    if (!data) return res.status(404).type('html').send(page('Request not found', 'Check the reference link supplied with your request.'));
    const complete = data.status === 'completed';
    res.type('html').send(page(complete ? 'Instagram data request completed' : 'Instagram data request received',
      complete ? 'We have completed the Instagram data cleanup recorded for this request. Contact us with your reference if you need more details.'
        : 'We have saved your request and stopped the affected Instagram connection where it was still active. Our team must review the Instagram data held in your salon’s records and complete the cleanup. Deletion is not complete yet.', req.params.code));
  } catch {
    res.status(503).type('html').send(page('Status temporarily unavailable', 'Please try this link again. An unavailable status does not mean your request is complete.'));
  }
});

export default router;
