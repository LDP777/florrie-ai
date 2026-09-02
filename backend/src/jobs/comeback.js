/**
 * Client Comeback Engine
 * Detects lapsed clients and sends personalised re-engagement SMS.
 * Run daily via cron. Idempotent, tracks nudges in client_nudges table.
 *
 * Usage: node src/jobs/comeback.js
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { fileURLToPath, pathToFileURL } from 'url';
import { dirname, join } from 'path';
import { sendSMS } from '../services/notifications.js';
import { guardedSend } from '../lib/outbound-guard.js';
import { getFutureBookedClientIds } from '../lib/future-bookings.js';
import { splitBillable } from '../lib/billable.js';
import logger from '../lib/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../../.env') });

// Use SUPABASE_SERVICE_KEY to match the rest of the codebase (config.js,
// index.js REQUIRED_ENV, lib/crypto.js). Fall back to SUPABASE_SERVICE_ROLE_KEY
// for any Railway cron service still provisioned with the older variable name.
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Win-back targets clients we genuinely have not seen in a while. 3 months,
// not 6 weeks, so we never nudge someone who is simply between regular visits.
const DORMANT_DAYS = 90;
const RENUDGE_COOLDOWN_DAYS = 90; // never re-send a win-back within 3 months

export async function runComeback() {

  // Get all beauticians. subscription_status and trial_ends_at are in
  // 001_initial_schema.sql, so they are safe to add to the select.
  const { data: allBeauticians, error: bErr } = await supabase
    .from('beauticians')
    .select('id, business_name, tone_model, booking_slug, subscription_status, trial_ends_at');

  if (bErr) {
    logger.error({ err: bErr }, 'Failed to fetch beauticians');
    logger.error('Failed to fetch beauticians:', bErr.message);
    process.exit(1);
  }

  // Win-back texts cost money per send. Expired trials and cancelled salons
  // were still having their lapsed clients texted every day on Florrie's
  // bill. Only billable salons go round the loop.
  const { billable: beauticians, skipped, reasons, wouldSkip, enforce } = splitBillable(allBeauticians);
  if (skipped > 0) {
    logger.info({ skipped, reasons }, 'Comeback: skipping non-billable beauticians');
  } else if (!enforce && wouldSkip.length > 0) {
    // Observe-only until ENFORCE_BILLABILITY=true. This line is what the
    // founder reads before turning it on: every salon named here stops
    // getting automated sends the moment it is enforced.
    logger.warn({ wouldSkip, reasons }, 'Comeback: billability gate is OBSERVE-ONLY; these salons would be skipped once ENFORCE_BILLABILITY=true');
  }

  let totalNudged = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const beautician of beauticians) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - DORMANT_DAYS);

    // Genuinely lapsed: a real recorded last visit, and not within ~3 months.
    const { data: lapsedClients, error: cErr } = await supabase
      .from('clients')
      .select('id, first_name, last_name, phone, last_visit_at')
      .eq('beautician_id', beautician.id)
      .not('phone', 'is', null)
      .lt('last_visit_at', cutoffDate.toISOString())
      .not('last_visit_at', 'is', null);

    if (cErr || !lapsedClients?.length) continue;

    // Don't win-back anyone who already has a future booking, they're coming back.
    const futureBooked = await getFutureBookedClientIds(beautician.id);
    const candidates = lapsedClients.filter(c => !futureBooked.has(c.id));
    if (!candidates.length) continue;

    for (const client of candidates) {
      // Never re-send a win-back within 3 months (idempotency).
      const nudgeCutoff = new Date();
      nudgeCutoff.setDate(nudgeCutoff.getDate() - RENUDGE_COOLDOWN_DAYS);

      const { data: existing } = await supabase
        .from('client_nudges')
        .select('id')
        .eq('beautician_id', beautician.id)
        .eq('client_phone', client.phone)
        .eq('nudge_type', 'comeback')
        .gte('sent_at', nudgeCutoff.toISOString())
        .maybeSingle();

      if (existing) {
        totalSkipped++;
        continue; // Already nudged recently
      }

      // Build personalised message using tone_model or default
      const tone = beautician.tone_model || 'warm and friendly';
      const firstName = client.first_name || 'there';
      const businessName = beautician.business_name || 'the salon';

      // Use Ellie's own branded booking link, not a bare florrie.ai (which goes
      // nowhere bookable). Fall back to a reply CTA if she has no slug yet.
      const bookingUrl = beautician.booking_slug ? `florrie.ai/book/${beautician.booking_slug}` : null;
      const cta = bookingUrl
        ? `book your next appointment here: ${bookingUrl}`
        : `just reply to this message and I'll get you booked in`;
      const message = `Hi ${firstName}! It's been a while since we've seen you at ${businessName}. We'd love to have you back, ${cta} 💫`;

      // Everything proactive goes through the one gate: consent (fail closed),
      // cross-engine frequency + monthly caps, allowance reserve, and the trust
      // dial. The gate only returns 'send' when it is genuinely safe; otherwise
      // it queues the nudge for the daily approval review or blocks it.
      try {
        const verdict = await guardedSend({
          beauticianId: beautician.id,
          clientId: client.id,
          messageType: 'comeback',
          channel: 'sms',
          body: message,
          send: () => sendSMS({ to: client.phone, body: message, beauticianId: beautician.id }),
        });

        if (verdict.delivered) {
          await supabase.from('client_nudges').insert({
            beautician_id: beautician.id,
            client_phone: client.phone,
            nudge_type: 'comeback',
          });
          totalNudged++;
        } else {
          // approved-and-waiting, or blocked by consent/cap/allowance/hours.
          totalSkipped++;
        }
      } catch (err) {
        totalFailed++;
        logger.error({ err, client: client.id }, 'Error nudging client');
      }
    }
  }

  logger.info(
    { sent: totalNudged, skipped: totalSkipped, failed: totalFailed },
    `Comeback engine done. ${totalNudged} sent, ${totalSkipped} skipped, ${totalFailed} failed`
  );
  return { sent: totalNudged, skipped: totalSkipped, failed: totalFailed };
}

// CLI entrypoint: `node src/jobs/comeback.js`. When imported (e.g. by the
// in-process scheduler in index.js) this guard prevents an auto-run + exit.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runComeback().then(() => process.exit(0)).catch(err => {
    logger.error({ err }, 'Fatal comeback engine error');
    process.exit(1);
  });
}
