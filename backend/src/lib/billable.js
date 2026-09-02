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
/**
 * Whether the gate is ENFORCED or only REPORTED.
 *
 * Off by default for the first deploy, on purpose. The pilot salon's row was
 * set up by hand months before any of this existed, and nobody could read its
 * subscription_status from where this was written. If it is 'trial' with a
 * trial_ends_at in March, enforcing tonight switches off her gap-fill offers,
 * rebook nudges and comeback messages the morning she is enrolling people on
 * a course, and the first anyone hears of it is her. So the first deploy
 * skips nobody and logs who it WOULD have skipped, with the reason. The
 * founder reads that line, fixes any row that is wrong, and sets
 * ENFORCE_BILLABILITY=true. From then on it is real.
 */
export function billabilityEnforced(env = process.env) {
  return env.ENFORCE_BILLABILITY === 'true';
}

export function splitBillable(beauticians, now = new Date(), { enforce = billabilityEnforced() } = {}) {
  const billable = [];
  const reasons = {};
  const wouldSkip = [];
  for (const b of beauticians || []) {
    if (isBillable(b, now)) {
      billable.push(b);
      continue;
    }
    const why = b?.subscription_status === 'trial' ? 'trial_expired' : (b?.subscription_status || 'unknown_status');
    reasons[why] = (reasons[why] || 0) + 1;
    wouldSkip.push({ id: b?.id, business_name: b?.business_name || null, reason: why });
    if (!enforce) billable.push(b);
  }
  const skipped = enforce ? (beauticians || []).length - billable.length : 0;
  return { billable, skipped, reasons, wouldSkip, enforce };
}
