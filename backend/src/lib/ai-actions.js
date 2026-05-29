/**
 * Helpers for writing ai_actions rows safely.
 */

/**
 * Map an internal action lifecycle status onto the ai_actions.outcome enum.
 *
 * ai_actions.outcome only accepts: success | pending | failed | escalated.
 * Services pass richer status strings (executed, pending_approval, info, ...),
 * so normalising here prevents silent 23514 CHECK violations on insert.
 *
 * @param {string} status
 * @returns {'success'|'pending'|'failed'|'escalated'}
 */
export function normaliseOutcome(status) {
  switch (status) {
    case 'executed':
    case 'sent':
    case 'done':
    case 'completed':
    case 'success':
    case 'info':
      return 'success';
    case 'failed':
    case 'error':
      return 'failed';
    case 'escalated':
      return 'escalated';
    case 'pending':
    case 'pending_approval':
    case 'scheduled':
    case 'queued':
    default:
      return 'pending';
  }
}
