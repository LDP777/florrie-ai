/**
 * Is this salon somebody we should still be spending money on?
 *
 * No background job gated on subscription state. The autonomous scheduler,
 * comeback nudges and the rest ran for every row in beauticians, so a salon
 * whose trial ended in March, or whose card died and was never replaced, kept
 * burning SMS, WhatsApp templates and Claude tokens every two hours with
 * nobody paying for any of it. Two of those cost real money per message.
 *
 * Billable means one of:
 *   - subscription_status 'active'
 *   - subscription_status 'past_due' (Stripe is still retrying; the salon is
 *     inside the same grace period middleware/require-plan.js gives them)
 *   - subscription_status 'trial' AND trial_ends_at is null or in the future
 *
 * 'cancelled' is never billable. A trial with a trial_ends_at in the past is
 * not billable either: that is the account that has simply gone quiet.
 *
 * Column names are the ones migration 001_initial_schema.sql actually creates
 * on beauticians (subscription_status, trial_ends_at), so any select that
 * includes them cannot fail the PostgREST whole-select rule.
 */

export const BILLABLE_COLUMNS = ['subscription_status', 'trial_ends_at'];

/**
 * @param {object} beautician row with subscription_status and trial_ends_at
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isBillable(beautician, now = new Date()) {
  if (!beautician) return false;
  const status = beautician.subscription_status;
  if (status === 'active' || status === 'past_due') return true;
  if (status !== 'trial') return false;

  const endsAt = beautician.trial_ends_at;
  if (endsAt == null) return true;
  const ends = new Date(endsAt);
  if (Number.isNaN(ends.getTime())) return true;
  return ends.getTime() > now.getTime();
}

/**
 * Filter a beautician list to the billable ones and say, once, how many were
 * dropped and why. Callers log the returned summary rather than one line per
 * salon, so a job over a hundred salons does not write a hundred lines.
 *
 * @returns {{ billable: object[], skipped: number, reasons: Record<string, number> }}
 */
export function splitBillable(beauticians, now = new Date()) {
  const billable = [];
  const reasons = {};
  for (const b of beauticians || []) {
    if (isBillable(b, now)) {
      billable.push(b);
      continue;
    }
    const why = b?.subscription_status === 'trial' ? 'trial_expired' : (b?.subscription_status || 'unknown_status');
    reasons[why] = (reasons[why] || 0) + 1;
  }
  const skipped = (beauticians || []).length - billable.length;
  return { billable, skipped, reasons };
}
