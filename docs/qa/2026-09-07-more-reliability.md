# More follow-up: replies, waitlist and cancellation history

Outbox now reports a failed reply-queue read instead of hiding replies behind an apparently successful pending-drafts view. Both reads use the bounded authenticated reader introduced for Today.

Waitlist includes Sunday, which the backend day matcher already supports. Failed client, treatment or waitlist reads block the page with a retry action rather than showing zero counts and an Add form with missing choices.

Cancellation repeat counts use client IDs and the selected period. Different clients with the same name stay separate; unpaid releases and records without a client ID do not establish repeat cancellation history.

Validation: frontend build passed including 78-page render checks; check:more passed 15 unit tests and browser failure/retry scenarios, including the new Waitlist and Outbox cases. Browser fixtures are synthetic. No live messages or booking changes were made.

Separate care release: 81b39ba passed GitHub frontend/backend checks and Apple archive. Build 732 was assigned to the internal Team group (2 testers). Production Vercel deployment is READY. Levi confirmed build 731 resolved loading before this work.

Remaining audit work includes Content draft edit/discard error recovery, Waitlist offer semantics, and provider acceptance for live notification delivery. The 44-destination inventory is not evidence that every external integration is ready to launch. Voice Commander remains deferred at Levi's request.
