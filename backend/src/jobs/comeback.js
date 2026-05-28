/**
 * Client Comeback Engine
 * Detects lapsed clients and sends personalised re-engagement SMS.
 * Run daily via cron. Idempotent, tracks nudges in client_nudges table.
 *
 * Usage: node src/jobs/comeback.js
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { sendSMS } from '../services/notifications.js';
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

const DEFAULT_REBOOKING_DAYS = 42;

async function run() {

  // Get all beauticians
  const { data: beauticians, error: bErr } = await supabase
    .from('beauticians')
    .select('id, business_name, tone_model');

  if (bErr) {
    logger.error({ err: bErr }, 'Failed to fetch beauticians');
    logger.error('Failed to fetch beauticians:', bErr.message);
    process.exit(1);
  }

  let totalNudged = 0;
  let totalSkipped = 0;
  let totalFailed = 0;

  for (const beautician of beauticians) {
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - DEFAULT_REBOOKING_DAYS);

    // Find clients who haven't visited since cutoff
    const { data: lapsedClients, error: cErr } = await supabase
      .from('clients')
      .select('id, first_name, last_name, phone, last_visit_at')
      .eq('beautician_id', beautician.id)
      .not('phone', 'is', null)
      .lt('last_visit_at', cutoffDate.toISOString())
      .not('last_visit_at', 'is', null);

    if (cErr || !lapsedClients?.length) continue;

    for (const client of lapsedClients) {
      // Check if already nudged in the last 42 days (idempotency)
      const nudgeCutoff = new Date();
      nudgeCutoff.setDate(nudgeCutoff.getDate() - DEFAULT_REBOOKING_DAYS);

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

      const message = `Hi ${firstName}! It's been a while since we've seen you at ${businessName}. We'd love to have you back, book your next appointment at florrie.ai 💫`;

      // Send SMS via Bird API (same pattern as notifications.js)
      try {
        const result = await sendSMS({
          to: client.phone,
          body: message,
          beauticianId: beautician.id
        });

        // Record nudge only if sent successfully
        if (result) {
          await supabase.from('client_nudges').insert({
            beautician_id: beautician.id,
            client_phone: client.phone,
            nudge_type: 'comeback',
          });

          totalNudged++;
        } else {
          totalFailed++;
          logger.warn({ client: client.id, beautician: beautician.id }, 'SMS send returned falsy result');
        }
      } catch (err) {
        totalFailed++;
        logger.error({ err, client: client.id, phone: client.phone }, 'Error nudging client');
        logger.error(`✗ Error nudging ${client.phone}:`, err.message);
      }
    }
  }

  logger.info(
    { sent: totalNudged, skipped: totalSkipped, failed: totalFailed },
    `Comeback engine done. ${totalNudged} sent, ${totalSkipped} skipped, ${totalFailed} failed`
  );
  process.exit(0);
}

run().catch(err => {
  logger.error({ err }, 'Fatal comeback engine error');
  logger.error('Fatal error:', err);
  process.exit(1);
});
