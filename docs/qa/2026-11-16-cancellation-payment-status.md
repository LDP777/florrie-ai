# Cancellation payment status

A client cancelled a rescheduled appointment after a £24 fee had already been collected. The payment guard prevented another charge, but the client saw a new fee quote and the activity feed said awaiting confirmation.

The booking page now recognises the existing fee and displays its collection date. Cancelling does not create another fee intent for that recorded charge. Cancelled links retain the payment receipt. Money > Income and cancelled appointment details show Collected, Pending or Needs attention, with reasons for failed collection. Activity links open Income, and historical already_charged actions display the correct message without rewriting payment records. Cancellation alerts direct the owner to payment status rather than implying collection. Income includes the fee type alongside Paid by card.

This change does not change fee percentages, notice periods, card charging, refunds or retry policy. No database migration is required. Public responses omit Stripe/customer/card identifiers; owner endpoints scope every read to the authenticated salon. A failed receipt lookup does not hide a cancelled appointment. Privacy hides amounts and client names while retaining payment states; fonts and colours are unchanged.

Validation: 220 backend files / 4,128 tests passed, frontend production build passed, 17 manage-booking browser groups, 4 existing policy groups, 3 new cancellation-status browser groups and 14 primary privacy groups passed. Tests use fictional records and intercepted providers; no real booking, payment or message mutations occurred. Screenshot evidence is in Codex-pa/work/florrie-headless/cancellation-status-proof-20261116.

The line-based consent-join baseline was moved to its new source line numbers; no consent exception was added. The new branch is included in hosted CI so checks can finish before the main deployment. Stripe dashboard sign-in remains necessary for an independent recheck of the original £24 payment; the investigation used the stored successful payment receipt and action history.
