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
import { billSurplusSMS } from '../services/sms-metering.js';
import logger from '../lib/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(__dirname, '../../.env') });

async function run() {
  logger.info('Surplus SMS billing starting');
  try {
    const result = await billSurplusSMS();
    logger.info({ result }, 'Surplus SMS billing done');
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Surplus SMS billing failed');
    process.exit(1);
  }
}

run();
