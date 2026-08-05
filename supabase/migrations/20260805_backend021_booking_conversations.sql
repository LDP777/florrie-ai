-- 021: the state behind an end to end booking conversation.
--
-- WHY A TABLE AT ALL
-- Booking someone in over WhatsApp or Instagram takes several messages: she
-- asks for lashes, Florrie asks which kind, she says hybrid, Florrie offers
-- three real times, she says "the 4 one". Nothing in the inbound path has ever
-- remembered anything between messages, so step 4 arrives with no idea what
-- was offered in step 3. The transcript is not enough: "the 4 one" is only
-- resolvable against the exact list Florrie SENT, and re-deriving that list
-- from the diary a minute later can produce a different list.
--
-- WHY NOT COLUMNS ON clients
-- Five nullable columns on the client record that describe a transient
-- negotiation, with nothing to expire them, is how a half-finished booking
-- from last week hijacks a fresh "hi". A row with an expires_at can simply
-- stop existing.
--
-- WHY NOT booking_suggestions
-- That table is Ellie's review queue (suggest and confirm). It is a record of
-- what Florrie proposed to HER, keeps its rows forever on purpose, and has no
-- place to put an offered slot list or a held appointment. Reusing it would
-- put transient machine state into a screen she reads.
--
-- ONE LIVE NEGOTIATION PER CLIENT
-- The unique index is the point, not an optimisation. Two open offers to the
-- same person means "the 4 one" has two possible answers, and picking the
-- wrong one books the wrong slot. Upsert on conflict, so a new booking request
-- replaces the old negotiation rather than racing it.
--
-- Run by hand in the Supabase SQL editor (idempotent, safe to re-run).
-- After running, RESTART Railway. Not redeploy: PgBouncer caches the PostgREST
-- schema and a redeploy leaves the new table invisible to the API.

CREATE TABLE IF NOT EXISTS booking_conversations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  beautician_id UUID NOT NULL REFERENCES beauticians(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,

  -- awaiting_treatment: Florrie asked which treatment they meant.
  -- awaiting_pick:      Florrie offered real slots and is waiting for a choice.
  -- held:               the slot is pending in the diary and the deposit link is out.
  -- No CHECK constraint listing the steps on purpose: a value nobody enumerated
  -- would make PostgREST reject the write whole, which is the failure mode that
  -- has already cost this codebase two silently dead features.
  step TEXT NOT NULL,

  treatment_id UUID REFERENCES treatments(id) ON DELETE SET NULL,

  -- Exactly what was offered, in the wall frame, as [{iso, date, time}].
  -- This is the list "the 4 one" is resolved against and the list the reply
  -- claims guard was given as allowed times. Storing it means the two can
  -- never drift apart between messages.
  offered JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Set once a slot is actually held, so a duplicate inbound cannot create a
  -- second pending appointment for the same negotiation.
  appointment_id UUID REFERENCES appointments(id) ON DELETE SET NULL,
  checkout_url TEXT,

  -- How many times Florrie has asked the same question. Two is the cap; after
  -- that the thread goes to Ellie rather than looping at the client.
  asked_count SMALLINT NOT NULL DEFAULT 0,

  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS booking_conversations_one_per_client
  ON booking_conversations (beautician_id, client_id);

-- Every read is "the live negotiation with this person", so index that shape.
CREATE INDEX IF NOT EXISTS booking_conversations_live
  ON booking_conversations (beautician_id, client_id, expires_at);

-- RLS: the backend uses the service key and bypasses this. The owner policy is
-- belt and braces so the anon key can never read another salon's conversations,
-- which contain a client id and a held appointment id.
ALTER TABLE booking_conversations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS booking_conversations_owner ON booking_conversations;
CREATE POLICY booking_conversations_owner ON booking_conversations
  FOR ALL USING (beautician_id IN (SELECT id FROM beauticians WHERE auth_id = auth.uid()));

COMMENT ON TABLE booking_conversations IS
  'Short lived state for a booking being agreed over messages. Expires, so an abandoned half-booking cannot hijack a later conversation.';
