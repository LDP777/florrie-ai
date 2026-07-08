/**
 * Bill Surplus SMS
 * Walks unbilled sms_usage weeks with surplus > 0 and creates Stripe invoice
 * items, then marks each week as billed. Replaces the Cowork-scheduled task
 * `florrie-sms-billing` which has been blocked by the Cowork outbound proxy
 * (HTTP 403 on api.florrie.ai) every run.
 *
 * Run weekly via Railway native cron. Idempotent — only processes rows where
 * billed = false.
 *
 * Usage:
 *   node src/jobs/bill-surplus-sms.js
 *
 * Railway cron schedule (recommended): `0 4 * * 1`  (Monday 04:00 UTC weekly)
 */
import dotenv from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import logger from '../lib/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../../.env') });

async function run() {
  // RETIRED 2026-07-08. Billing single-sources from the MONTHLY combined
  // meter (services/whatsapp-metering.js billMonthlySurplus, daily cron in
  // index.js). Running this weekly biller as well created a second Stripe
  // invoice item for the same SMS. The job exits cleanly so the Railway
  // cron keeps passing until it is deleted from the dashboard.
  logger.info('bill-surplus-sms: RETIRED no-op — monthly combined meter bills surplus now. Delete this Railway cron.');
  process.exit(0);
}

run();
