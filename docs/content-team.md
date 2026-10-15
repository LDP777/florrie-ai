# Content Team

Content’s For you page gives a salon one brief and three connected stages: a strategy, client-facing captions and a Reel filming plan. The existing photo preparation, saved posts, review, scheduling and booking-link results stay accessible from the same page.

The team uses the salon’s active treatment menu, approved knowledge, writing preferences and saved Content-gallery notes. It does not read client conversations, clinical records or unapproved review quotes. A saved photo description is not evidence that the model has seen the photo. The planner uses the existing assistant board’s work summary to avoid treating the salon as an empty workspace.

## What completes in the background

An explicit Start content brief request creates a `content_team_runs` row. The scheduler claims up to three runs per pass and saves each completed stage before continuing. It processes a salon’s stages in order. An owner can have one queued/running brief at a time; a repeated request UUID returns the original run. Closing the page does not cancel server work.

The worker checks the current account and source fingerprint before and after generation. Changes stop the brief for review. Per-run leases, conditional writes and bounded retries protect against two workers or lost responses. A retry preserves finished stages. Older briefs remain available through owner-scoped history and exact-run reads.

The model receives a static JSON schema for each stage. Application validation still enforces length, counts, stable idea IDs and supplied source references. Public captions reject obvious production notes and unsupported bio-link claims. No generator or validator can establish that every natural-language statement is true; the owner reviews drafts before publication.

## Media and review

Writing opens an unsaved draft in the existing editor. Feed captions need a photo. A Story has editable heading/words and creates an actual 1080 × 1920 PNG before review, because Instagram’s Story publication does not attach a text caption. Story notes in the editor are clearly labelled as unpublished notes.

The Reel stage produces shots, spoken lines, on-screen words and a caption. It does not create footage, upload a Reel or claim a finished video exists. Review Reel caption opens the existing photo editor; the filming plan remains saved separately.

Model planning/caption work is durable on the server. Canvas artwork generation still requires the page to remain open and says so. The new worker never calls message, scheduling or publishing APIs.

## Account and request safety

Both Content Team and the existing preparation wrapper compare the SDK session’s user ID with the displayed salon’s `auth_id`. Session checks time out after ten seconds. Account events invalidate pending results, uploads and callbacks. An uncertain enqueue retains its original UUID and brief until a read or an explicit same-request retry confirms it.

## Release order

1. Apply only `supabase/migrations/20261015_content_team_runs.sql` to the intended project. It adds one service-only table with row-level security, active-run/request uniqueness and queue/history indexes. Do not run unrelated pending migrations.
2. Verify the table’s schema and grants, then deploy backend and frontend from the tested commit.
3. Verify authenticated read-only access and the scheduler’s registration. Exercise generation with a fictional salon only. Do not enqueue work on Ellie’s behalf.
4. Verify the iPhone build through the normal release workflow and TestFlight.

If the migration is missing, the new team shows a setup state and leaves existing photo/post tools available. Reverting the app commit disables the worker and page; retaining the new table preserves any saved briefs.

## Validation

The suite covers actual PostgreSQL-compatible migration behavior, owner isolation, concurrent claims, recovery, stale sources, history and schema validation. Browser checks cover the real components, account-switch races, interrupted writes, edited Story PNGs, keyboard navigation, reduced motion, existing fonts and mobile layout. A fictional-source rehearsal runs the actual worker against the configured model without a production database or message/publishing calls.

Instagram comment handling, verified profile analysis, trend feeds and native Instagram performance collection are separate provider integrations. The existing results measure bookings through tracked post links; they are not reach, engagement or a prediction of virality.
