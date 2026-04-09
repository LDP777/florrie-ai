import { supabase } from '../index.js';
import logger from '../lib/logger.js';

/**
 * Delete Stripe events older than 90 days.
 * Stripe events accumulate forever without this cleanup.
 * Returns the number of events deleted.
 */
export async function cleanupStripeEvents() {
  try {
    // Calculate cutoff date: 90 days ago
    const ninetyDaysAgo = new Date();
    ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);
    const cutoffDate = ninetyDaysAgo.toISOString();

    // Delete old events
    const { data, error } = await supabase
      .from('stripe_events')
      .delete()
      .lt('processed_at', cutoffDate);

    if (error) {
      logger.error({ error }, 'Failed to cleanup stripe events');
      throw error;
    }

    const deletedCount = data?.length || 0;
    logger.info({ deletedCount, cutoffDate }, 'Stripe events cleanup completed');

    return {
      success: true,
      deleted: deletedCount,
      cutoffDate,
    };
  } catch (err) {
    logger.error({ err }, 'Stripe events cleanup error');
    throw err;
  }
}
