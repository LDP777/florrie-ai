/**
 * Stripe Events Cleanup
 * Deletes stripe_events rows older than 90 days. Replaces the Cowork-scheduled
 * task `florrie-stripe-cleanup` which has been blocked by the Cowork outbound
 * proxy (HTTP 403 on api.florrie.ai) for 6+ weeks running.
 *
 * Run weekly via Railway native cron. Idempotent — only deletes rows past TTL.
 *
 * Usage:
 *   node src/jobs/cleanup-stripe-events.js
 *
 * Railway cron schedule (recommended): `0 3 * * 0`  (Sunday 03:00 UTC weekly)
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { cleanupStripeEvents } from '../services/stripe-cleanup.js';
import logger from '../lib/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../../.env') });

async function run() {
  logger.info('Stripe events cleanup starting');
  try {
    const result = await cleanupStripeEvents();
    logger.info({ result }, 'Stripe events cleanup done');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Stripe events cleanup failed');
    process.exit(1);
  }
}

run();
