-- Widen beauticians.sms_originator so it can hold a phone number as well as
-- an 11-char alphanumeric sender. E.164 numbers are at most 15 digits + '+',
-- so 20 is a comfortable ceiling.
--
-- Context: shipping 2-way SMS (Bird inbound webhook) means the sender needs
-- to be a real virtual mobile number clients can reply to. The old 11-char
-- limit was written for alphanumeric-only senders.

ALTER TABLE beauticians
  ALTER COLUMN sms_originator TYPE VARCHAR(20);

COMMENT ON COLUMN beauticians.sms_originator IS
  'SMS sender — either a phone number in E.164 (+447700900123) for 2-way SMS, or up to 11 alphanumeric chars (GSMA limit) for a one-way brand sender.';
