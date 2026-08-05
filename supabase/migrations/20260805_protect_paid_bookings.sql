-- ===========================================================================
-- A BOOKING SOMEBODY PAID FOR MUST NOT BE DELETABLE BY ACCIDENT
--
-- Charlotte Scott paid GBP 80 in full on 26 July for two treatments at 14:00
-- on 5 August. She turned up. There was no booking. Not cancelled: GONE. The
-- Stripe metadata still names it, appointment_id 8a7f063b-624d-43cd-ad90-
-- a2262660bac6, her client row still exists, and two ai_actions prove the
-- booking was made. The row itself was hard deleted and nothing in the
-- application had any business deleting it.
--
-- We could not prove who did it, which is the real problem: there was no way
-- to find out. This migration closes the two silent paths and makes any
-- future deletion leave a trace.
--
-- 1. appointments.client_id was ON DELETE CASCADE. Deleting one client row
--    silently destroyed every appointment they had ever had, and with the
--    Stripe webhook dead there was often no transaction row left to object.
--    A client record is contact details. A booking is an agreement somebody
--    paid money for. The first must never take the second with it.
--
-- 2. Same for transactions: deleting a client should never delete the record
--    of money they paid.
--
-- RESTRICT, not SET NULL, on purpose. The client merge moves appointments to
-- the surviving record BEFORE deleting the duplicate, so a correct merge is
-- unaffected. A merge that failed to move them now fails loudly at the delete
-- instead of quietly destroying the bookings, which is the behaviour we
-- wanted all along.
-- ===========================================================================

ALTER TABLE appointments DROP CONSTRAINT IF EXISTS appointments_client_id_fkey;
ALTER TABLE appointments
  ADD CONSTRAINT appointments_client_id_fkey
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE RESTRICT;

ALTER TABLE transactions DROP CONSTRAINT IF EXISTS transactions_client_id_fkey;
ALTER TABLE transactions
  ADD CONSTRAINT transactions_client_id_fkey
  FOREIGN KEY (client_id) REFERENCES clients(id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- And if one ever does disappear, we find out who and when.
--
-- Today cost hours precisely because a booking vanished and nothing recorded
-- it. This keeps the whole row, so a deletion is recoverable rather than just
-- explainable.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deleted_appointments (
  id UUID PRIMARY KEY,
  beautician_id UUID,
  client_id UUID,
  starts_at TIMESTAMPTZ,
  status TEXT,
  price_cents INTEGER,
  deposit_paid BOOLEAN,
  stripe_payment_intent_id TEXT,
  row_snapshot JSONB NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_by TEXT NOT NULL DEFAULT current_user
);

ALTER TABLE deleted_appointments ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION record_deleted_appointment() RETURNS TRIGGER AS $fn$
BEGIN
  INSERT INTO deleted_appointments (
    id, beautician_id, client_id, starts_at, status, price_cents,
    deposit_paid, stripe_payment_intent_id, row_snapshot
  ) VALUES (
    OLD.id, OLD.beautician_id, OLD.client_id, OLD.starts_at, OLD.status,
    OLD.price_cents, OLD.deposit_paid, OLD.stripe_payment_intent_id,
    to_jsonb(OLD)
  );
  RETURN OLD;
END;
$fn$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_record_deleted_appointment ON appointments;
CREATE TRIGGER trg_record_deleted_appointment
  BEFORE DELETE ON appointments
  FOR EACH ROW EXECUTE FUNCTION record_deleted_appointment();
