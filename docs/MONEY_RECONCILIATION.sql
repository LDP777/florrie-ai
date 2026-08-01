-- ============================================================================
-- FLORRIE MONEY RECONCILIATION  (Supabase SQL editor)
-- Written 2026-08-01. READ-ONLY except section C, which is DO NOT RUN YET.
--
-- Background: until 25 Jul, nine code paths inserted payment_method = 'card',
-- which violates the CHECK constraint on transactions.payment_method and
-- failed silently. Money left cards at Stripe; nothing was recorded. A 64-row
-- deposit backfill (£501.20) was run by Levi; everything else is still missing.
-- The Stripe webhook has never recorded an event, so payment links and course
-- payments have NO fallback recorder at all.
--
-- Schema note: column names inferred from live code paths (backend/src), not
-- from repo migrations, which drift. Verify a SELECT works before trusting a
-- column name. appointments.starts_at is SALON WALL TIME stored in the UTC
-- slot; ::date on it is safe, timezone conversion is not.
-- ============================================================================


-- ============================================================================
-- (A) Appointments where Stripe DID take money (stripe_payment_intent_id set)
--     but NO transaction row exists for that appointment.
--     Matches on either the payment intent id or the appointment id carrying
--     any income-type row, so the 64-row backfill (which may lack intent ids)
--     still counts as recorded.
-- ============================================================================

-- A1. Booking payments (deposit or pay-in-full) never recorded
SELECT
  a.id                                   AS appointment_id,
  a.created_at::date                     AS booked_on,
  a.starts_at::date                      AS appt_date,
  c.first_name || ' ' || COALESCE(c.last_name, '') AS client,
  a.status,
  a.payment_type,                        -- 'deposit' or 'full'
  a.deposit_paid,
  a.deposit_cents / 100.0                AS deposit_gbp,
  a.price_cents / 100.0                  AS price_gbp,
  COALESCE(a.discount_cents, 0) / 100.0  AS discount_gbp,
  a.stripe_payment_intent_id
FROM appointments a
LEFT JOIN clients c ON c.id = a.client_id
WHERE a.stripe_payment_intent_id IS NOT NULL
  AND a.deposit_paid = true              -- money actually landed (confirm redirect ran)
  AND NOT EXISTS (
    SELECT 1 FROM transactions t
    WHERE (t.stripe_payment_intent_id = a.stripe_payment_intent_id
           OR t.appointment_id = a.id)
      AND t.type IN ('deposit', 'full_payment', 'payment')
      AND t.amount_cents > 0
  )
ORDER BY a.created_at;

-- A2. Policy fees charged (no-show / late cancel) but never recorded
SELECT
  a.id AS appointment_id,
  c.first_name || ' ' || COALESCE(c.last_name, '') AS client,
  a.status,
  a.policy_fee_charged_at,
  a.policy_fee_amount_cents / 100.0 AS fee_gbp,
  a.policy_fee_payment_intent_id
FROM appointments a
LEFT JOIN clients c ON c.id = a.client_id
WHERE a.policy_fee_charged_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM transactions t
    WHERE t.stripe_payment_intent_id = a.policy_fee_payment_intent_id
       OR (t.appointment_id = a.id AND t.type IN ('no_show_fee', 'late_cancel_fee'))
  )
ORDER BY a.policy_fee_charged_at;

-- A3. Payment links stuck 'pending'. The ONLY recorder for a paid link is the
--     Stripe webhook, which has never fired, so every link a client actually
--     paid still says 'pending' here and has no transaction. The DB cannot
--     tell paid from abandoned: each stripe_session_id must be checked in the
--     Stripe dashboard (or via the API) before backfilling.
SELECT
  pl.created_at::date AS sent_on,
  c.first_name || ' ' || COALESCE(c.last_name, '') AS client,
  pl.amount_cents / 100.0 AS amount_gbp,
  pl.description,
  pl.status,
  pl.stripe_session_id,
  pl.appointment_id
FROM payment_links pl
LEFT JOIN clients c ON c.id = pl.client_id
WHERE pl.status = 'pending'
ORDER BY pl.created_at;

-- A4. Course/training enrolments whose Stripe payment can never have been
--     recorded (webhook-only path, no redirect fallback).
SELECT ce.id, ce.created_at::date, ce.payment_status, ce.amount_paid_cents / 100.0 AS paid_gbp,
       ce.stripe_payment_intent_id
FROM course_enrollments ce
WHERE ce.stripe_payment_intent_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM transactions t
    WHERE t.stripe_payment_intent_id = ce.stripe_payment_intent_id
  );


-- ============================================================================
-- (B) Estimate of the missing money, by type.
--     Full payments: estimated as price - discount (add-ons, if any, were also
--     charged at checkout; the add-on sum is included when the
--     appointment_add_ons table has rows). Deposits: deposit_cents.
--     These are ESTIMATES of what Stripe took; verify totals against the
--     Stripe dashboard before treating them as gospel.
-- ============================================================================
WITH missing AS (
  SELECT
    a.id,
    a.payment_type,
    CASE
      WHEN a.payment_type = 'full' THEN
        GREATEST(0, a.price_cents - COALESCE(a.discount_cents, 0))
        + COALESCE((SELECT SUM(ao.price_cents) FROM appointment_add_ons ao
                    WHERE ao.appointment_id = a.id), 0)
      ELSE COALESCE(NULLIF(a.deposit_amount_cents, 0), a.deposit_cents, 0)
    END AS est_cents
  FROM appointments a
  WHERE a.stripe_payment_intent_id IS NOT NULL
    AND a.deposit_paid = true
    AND NOT EXISTS (
      SELECT 1 FROM transactions t
      WHERE (t.stripe_payment_intent_id = a.stripe_payment_intent_id
             OR t.appointment_id = a.id)
        AND t.type IN ('deposit', 'full_payment', 'payment')
        AND t.amount_cents > 0
    )
)
SELECT
  CASE WHEN payment_type = 'full' THEN 'full_payment (pay-in-full at booking)'
       ELSE 'deposit' END               AS missing_type,
  COUNT(*)                             AS rows_missing,
  SUM(est_cents) / 100.0               AS estimated_gbp
FROM missing
GROUP BY 1
UNION ALL
SELECT 'policy_fee (no-show / late cancel)', COUNT(*), SUM(a.policy_fee_amount_cents) / 100.0
FROM appointments a
WHERE a.policy_fee_charged_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM transactions t
    WHERE t.stripe_payment_intent_id = a.policy_fee_payment_intent_id
       OR (t.appointment_id = a.id AND t.type IN ('no_show_fee', 'late_cancel_fee'))
  )
UNION ALL
SELECT 'payment_link still pending (paid state UNKNOWN, check Stripe)', COUNT(*), SUM(pl.amount_cents) / 100.0
FROM payment_links pl
WHERE pl.status = 'pending';


-- ============================================================================
-- (C) CANDIDATE BACKFILL  ***** DO NOT RUN YET *****
--     Recreates the missing booking-payment rows with payment_method
--     'card_online' (the value the fixed code writes today).
--     Before running:
--       1. Run (A1) and eyeball every row against the Stripe dashboard.
--       2. Confirm amounts: for 'full' rows the estimate below is
--          price - discount + add-ons; cross-check against the Stripe charge.
--       3. Run in a transaction; check the count matches (A1); then COMMIT.
--     tax_year matches getTaxYear() in backend/src/lib/time-utils.js
--     ('2025-26' style, UK tax year starting 6 April), computed from the
--     appointment's wall-time date, same as the code does.
-- ============================================================================
-- BEGIN;  -- DO NOT RUN YET
/*
INSERT INTO transactions
  (beautician_id, appointment_id, client_id, amount_cents, type, status,
   stripe_payment_intent_id, payment_method, tax_year, created_at)
SELECT
  a.beautician_id,
  a.id,
  a.client_id,
  CASE
    WHEN a.payment_type = 'full' THEN
      GREATEST(0, a.price_cents - COALESCE(a.discount_cents, 0))
      + COALESCE((SELECT SUM(ao.price_cents) FROM appointment_add_ons ao
                  WHERE ao.appointment_id = a.id), 0)
    ELSE COALESCE(NULLIF(a.deposit_amount_cents, 0), a.deposit_cents, 0)
  END,
  CASE WHEN a.payment_type = 'full' THEN 'full_payment' ELSE 'deposit' END,
  'completed',
  a.stripe_payment_intent_id,
  'card_online',
  CASE
    WHEN a.starts_at::date >= make_date(EXTRACT(YEAR FROM a.starts_at::date)::int, 4, 6)
      THEN EXTRACT(YEAR FROM a.starts_at::date)::text || '-'
           || RIGHT((EXTRACT(YEAR FROM a.starts_at::date)::int + 1)::text, 2)
    ELSE (EXTRACT(YEAR FROM a.starts_at::date)::int - 1)::text || '-'
         || RIGHT(EXTRACT(YEAR FROM a.starts_at::date)::int::text, 2)
  END,
  a.created_at              -- backdate to when the money actually moved
FROM appointments a
WHERE a.stripe_payment_intent_id IS NOT NULL
  AND a.deposit_paid = true
  AND NOT EXISTS (
    SELECT 1 FROM transactions t
    WHERE (t.stripe_payment_intent_id = a.stripe_payment_intent_id
           OR t.appointment_id = a.id)
      AND t.type IN ('deposit', 'full_payment', 'payment')
      AND t.amount_cents > 0
  )
  AND CASE
        WHEN a.payment_type = 'full' THEN
          GREATEST(0, a.price_cents - COALESCE(a.discount_cents, 0))
        ELSE COALESCE(NULLIF(a.deposit_amount_cents, 0), a.deposit_cents, 0)
      END > 0;
*/
-- COMMIT;  -- DO NOT RUN YET

-- NOT included in (C), deliberately:
--  * payment_links: paid state unknowable from the DB, verify each session in
--    Stripe first, then insert type 'payment_link' rows by hand.
--  * policy fees (A2): expected to be few; verify intents in Stripe and
--    insert type 'no_show_fee' / 'late_cancel_fee' rows by hand.
--  * course enrolments (A4): verify in Stripe, insert type 'deposit' by hand.
--  * WARNING on double counting: if an appointment in (A1) later auto-completed,
--    the sweep wrote an assumed-takings row (type 'payment', method NULL) for
--    price MINUS deposit. Backfilling a FULL payment on such an appointment
--    counts the balance twice (assumed row + full_payment row). Check with:
SELECT a.id, t.type, t.amount_cents / 100.0 AS gbp, t.payment_method
FROM appointments a
JOIN transactions t ON t.appointment_id = a.id
WHERE a.payment_type = 'full'
  AND t.type = 'payment' AND t.payment_method IS NULL
ORDER BY a.starts_at;
-- Any rows here: delete the assumed row when backfilling the full_payment,
-- or the client's month will read (price - deposit) + price.
