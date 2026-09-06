# Client care follow-up

Levi confirmed TestFlight 731 loads correctly and asked to continue the More-page audit before Voice Commander.

## Changes in this release

- Guardian's Client records tab displays the selected client's submitted answers, consent wording, signature and outstanding requests on the page. Client profiles use the same component. The client profile no longer waits for consultation records before opening.
- Changing clients clears the prior client's evidence and signature. Backend reads retain the existing authenticated client and salon scope.
- Guardian reduces its header on the records and templates tabs. Patch tests and photo permissions remain linked to the selected client.
- Form templates links to submitted client records and supports search. Failed list reads remain errors. Failed editor reads block editing and offer Retry. Failed saves retain input. Opening New clears the previous template's state.
- Patch-test records support search by client or treatment. Upcoming checks load separately, and a failed check does not hide saved evidence or show an all-clear. Recorded reactions have an explicit reaction badge.
- Care reads use the bounded authenticated JSON helper from build 731. The patch-record query has its own deadline. Message sends and record mutations retain their existing backend paths.

## Evidence

The production frontend build passed its gates, including the 78-page render check. The care browser suite exercises Guardian selection, same-name clients, inline answers/signatures, switching clients, patch record search during a failed alerts request, template retry, failed save preservation and editor route changes. Existing checks cover public signature submission failure/retry, patch settings rollback, refused reminders, selected-client consent, and mobile overflow. Tests use synthetic data; no client messages or production records were created.

The wider More failure/retry suite passed. The populated-screen sweep passed on 82 screens during this work. Release CI runs the same suites on the committed build. Screen checks establish rendering and the tested interactions, not provider delivery or every production mutation.

## Audit still open

The previous 44-destination inventory remains the scope of the More audit. Current source confirms separate fixes are still needed for Outbox partial reply-queue failures, Sunday waitlist preferences, and cancellation grouping by client identity. Content edit/discard failure handling also needs a focused check. Existing feature limits for custom automations, automatic aftercare from the care-card screen and team performance remain documented in the earlier audit. Voice Commander has not been changed.
