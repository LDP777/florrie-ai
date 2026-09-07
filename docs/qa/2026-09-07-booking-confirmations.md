# Booking confirmation correction

A client had a confirmed appointment moved through the public management page, but the thread retained only the original confirmation. The reschedule route saved the move without sending updated client details. Its activity insert also called `.catch()` on a Supabase query builder, which can return an error after the move is already committed.

The route now sends the existing confirmation using the saved appointment and treats activity logging failure as nonfatal. Email confirmation records require a provider response ID; a rejected or unconfigured email send no longer creates a successful outbound record or confirmation timestamp.

Regression coverage uses a Supabase builder without `.catch()`, checks confirmation after a successful move and an activity database error, and checks email provider acceptance versus rejection. No historical bookings or messages are rewritten, and no retrospective confirmations are sent by this change.

Local validation: full backend suite excluding the unavailable local PGlite SQL test. The line-based consent inventory was updated only for moved lines; no new exceptions were added. Production CI must run the SQL test.
