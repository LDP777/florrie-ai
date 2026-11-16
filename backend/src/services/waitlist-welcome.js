import { supabase } from '../config.js';
import { sendEmail } from './notifications.js';
import logger from '../lib/logger.js';
import { waitlistWelcomeEmail } from '../templates/waitlist-welcome.js';

// The database claims each row across both backend deployments. The provider
// key also covers a crash after sending but before recording the receipt.
export async function processWaitlistWelcomes() {
  if (!process.env.RESEND_API_KEY) throw new Error('Waitlist email sender is not configured');
  const { data: rows, error } = await supabase.rpc('claim_waitlist_welcomes', { p_limit: 5 })
    .abortSignal(AbortSignal.timeout(7000));
  if (error) throw new Error('Waitlist welcome queue could not be read');
  let sent = 0, failures = 0;
  for (const row of rows || []) {
    // Recheck consent immediately before delivery; a claimed item is not
    // permission to ignore an unsubscribe that happened in the meantime.
    const { data: current, error: readError } = await supabase.from('waitlist_signups')
      .select('id').eq('id', row.id).eq('welcome_claim', row.welcome_claim)
      .eq('welcome_status', 'sending').eq('is_test', false)
      .is('unsubscribed_at', null).not('marketing_consent_at', 'is', null)
      .maybeSingle().abortSignal(AbortSignal.timeout(7000));
    if (readError) throw new Error('Waitlist welcome consent could not be checked');
    if (!current) continue;
    const message = waitlistWelcomeEmail(row.unsubscribe_token);
    const receipt = await sendEmail({ to: row.email, ...message,
      replyTo: 'levi@florrie.ai', idempotencyKey: `waitlist-welcome/v1/${row.id}`, timeoutMs: 8000 });
    const patch = receipt?.id
      ? { welcome_status: 'sent', welcome_sent_at: new Date().toISOString(), welcome_message_id: receipt.id }
      : { welcome_status: row.welcome_attempts >= 6 ? 'needs_review' : 'pending',
          welcome_next_attempt_at: new Date(Date.now() + Math.min(60, 2 ** row.welcome_attempts) * 60000).toISOString() };
    const { error: saveError } = await supabase.from('waitlist_signups').update({ ...patch, welcome_claim: null })
      .eq('id', row.id).eq('welcome_claim', row.welcome_claim).abortSignal(AbortSignal.timeout(7000));
    if (saveError) throw new Error('Waitlist welcome receipt could not be recorded');
    if (receipt?.id) sent++; else failures++;
  }
  if (failures) {
    logger.warn({ failures }, 'Waitlist welcome emails pending retry');
    throw new Error('Some waitlist welcome emails need retry');
  }
  return { sent };
}
