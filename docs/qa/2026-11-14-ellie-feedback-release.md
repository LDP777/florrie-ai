# Ellie feedback release

This release follows privacy-only TestFlight 809. It retains the amount masking and payment-status labels and includes the calendar, booking, training, reviews and logo changes requested by Ellie. Existing fonts and the colour palette are retained.

## Behaviour

- Personal blocks can be opened, edited and removed, including their notes, date and times. Day and Today focus the useful diary time.
- Confirmation text includes manage-booking and calendar links. Rescheduling spans months within the configured booking horizon and stops inside the notice window. Cancelled links show a limited receipt.
- Clients explicitly confirm the remaining late fee. Settled deposits and balances are credited once. A cancellation and its delivery/payment intents commit together; providers can retry without attaching a fee to an unrelated owner cancellation. A slow provider returns an honest pending receipt within two seconds.
- Students choose dates the owner sets aside through a reusable course link. A place is reserved before checkout, with identity-bound resumption, provider-verified expiry and scheduled recovery even when new bookings are closed. Confirmations use stored prices and retry by channel.
- Owner-entered client feedback is private by default; publication requires permission. Public booking pages show permitted reviews and the whole business logo. These are not imported Google reviews.

## Verification

Combined backend: 219 files and 4,112 tests passed. Frontend production build passed. Browser checks passed: 51 privacy groups, 4 personal-block groups, 9 calendar navigation groups, 15 self-service booking groups plus 4 policy groups, 32 training groups and 7 reviews/branding/catalogue groups. A final mobile button-wrapping assertion was added after visual inspection. Fixtures intercept provider requests; no real client message, booking or charge was created.

## Database and release

Applied and verified through Supabase before backend release:

- 20261114175653_client_cancellation_intents.sql
- 20261114180658_course_reservations.sql

The filenames match the actual production migration versions, avoiding duplicate same-day versions. Only service_role may execute the new payment/reservation/delivery functions. Notice snapshots have RLS with no anonymous or owner direct read access. Anonymous enrolment inserts and unnecessary truncate privileges are revoked; owner CRUD is retained. Training tables had no existing rows at preflight and remained empty after the migration. Cancellation migration adds a function without rewriting appointments.

Railway deploys both backends from main without waiting for CI. The combined release therefore runs CI on its feature branch before main. Verify the exact deployment SHA on both services and /health before enabling the next TestFlight build.

## Limits

Meta controls the fixed wording of its approved WhatsApp reminder. The app blocks late rescheduling, and Florrie-controlled SMS/email copy is corrected; changing the provider-approved reminder text is a separate Meta update. Push delivery may repeat after a provider-success/process-crash boundary; the durable queue records each channel and does not claim exactly-once delivery. Browser tests do not substitute for installing the build on an iPhone.
