-- 063_policy_fees.sql
-- Auto-charge late-cancellation and no-show fees through Stripe.
--
-- Deposits already save the card (setup_future_usage off_session on the
-- Checkout payment intent). This adds the columns needed to charge that
-- saved card later, idempotently, plus an audit trail on the appointment.
--
-- NOTE: numbered 063 (not 062) on purpose; a parallel workstream may take 062.

BEGIN;

-- Saved Stripe customer on the client (already created by the booking flow;
-- IF NOT EXISTS keeps this a no-op on environments that already have it).
ALTER TABLE clients
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;

-- Per-appointment card on file + policy-fee audit trail.
ALTER TABLE appointments
  ADD COLUMN IF NOT EXISTS stripe_payment_method_id TEXT,
  ADD COLUMN IF NOT EXISTS policy_fee_charged_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS policy_fee_amount_cents INTEGER,
  ADD COLUMN IF NOT EXISTS policy_fee_payment_intent_id TEXT;

COMMENT ON COLUMN appointments.stripe_payment_method_id IS
  'Payment method saved from the deposit Checkout (off_session reuse for policy fees)';
COMMENT ON COLUMN appointments.policy_fee_charged_at IS
  'When a late-cancel or no-show fee was charged. Set once; the charge code treats non-null as already charged (idempotency guard)';
COMMENT ON COLUMN appointments.policy_fee_amount_cents IS
  'Amount of the policy fee charged, in pence';
COMMENT ON COLUMN appointments.policy_fee_payment_intent_id IS
  'Stripe PaymentIntent id of the policy fee charge';

-- transactions.type: 001 only allowed (payment, deposit, no_show_fee, refund, tip).
-- The webhook already inserts 'full_payment' and 'payment_link' (those inserts were
-- silently failing the CHECK), and policy fees add 'late_cancel_fee'. Extend the list.
ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_type_check;
ALTER TABLE transactions ADD CONSTRAINT transactions_type_check
  CHECK (type IN (
    'payment', 'deposit', 'no_show_fee', 'refund', 'tip',
    'full_payment', 'payment_link', 'late_cancel_fee'
  ));

COMMIT;
