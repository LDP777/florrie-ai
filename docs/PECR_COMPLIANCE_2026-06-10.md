# PECR compliance model (shipped 2026-06-10)

Florrie sends two kinds of client messages and UK law (PECR reg 22 + UK GDPR)
treats them differently.

## Service messages (always allowed)
Booking confirmations, reminders, reschedule replies, patch test notices,
conversational replies to an inbound message. No consent machinery needed.

## Direct marketing (rebook nudges, gap-fill offers, win-backs, campaigns)
Legal basis: the soft opt-in. Existing clients whose details came from a
booking can be messaged about similar services PROVIDED every message offers
an opt-out and opt-outs are honoured immediately and forever.

What's now enforced in code:

1. **Single choke point** (`backend/src/lib/marketing-guard.js`): every
   marketing-class send (WhatsApp templates gap_fill_offer*, rebook_nudge*,
   generic_message*; SMS messageTypes marketing, rebook_nudge, comeback,
   gap_fill, win_back, campaign) is checked against the client's
   `marketing_opted_out_at` flag and blocked forever once set.
2. **STOP handling** (`ai-front-desk.js`): an inbound STOP / unsubscribe /
   opt out on any channel instantly sets the flag, confirms to the client in
   plain English, and logs to "What Florrie did" so the beautician knows.
3. **Quiet hours**: marketing sends only between 08:00 and 21:00 UK time.
   Service messages are unaffected.
4. **Consent capture**: the public booking form now has an unticked-by-default
   "keep me posted about offers" box. Ticking it sets `marketing_consent` +
   timestamp (and clears a previous opt-out, since it's a fresh, active
   consent). Not ticking changes nothing (soft opt-in still applies).
5. **Opt-out facility in messages**: marketing starter-pack templates created
   from now on carry the footer "Reply STOP to opt out". TODO for Levi/PA:
   once Ellie's current v3 templates clear review, add the same footer in a
   v4 pass (editing in-review templates restarts review, so we wait).

## Honest limitations
- The guard matches clients by the last 9 phone digits; if a number is stored
  in an exotic format the guard fails OPEN for that send. The opt-out flag is
  authoritative the moment the client's record matches, and STOP processing
  uses the exact client record, so the protection is real where it matters.
- Migration 055 must be applied for the opted-out flag and voice_metrics
  table to exist (applied to prod 2026-06-10).
