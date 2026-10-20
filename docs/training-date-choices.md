# Training date choices

Ellie can create one course with several offered dates, or use **Add dates** on an existing course. Students follow the shared course link and choose one occurrence. Each occurrence has its own start time, capacity, students and payment records.

## Owner workflow

In Courses, **New course** opens the existing builder. **Add another date** adds a date and start time; the capacity applies to each new date. The initial save inserts the whole set in one database transaction. Generated IDs stay with a failed request so retries can recover an already saved course.

Grouped cards show the dates together and retain one shared link. Each date has its own student list, payment controls and booking status. **Add dates** copies the displayed source occurrence's description, price, deposit, location and course details. The form states which occurrence supplies those details. Editing an occurrence changes that occurrence only.

Booked dates and dates with an open checkout cannot be moved through the editor. A database trigger enforces the same rule if the form was opened before a student booked. Cancelling a grouped occurrence retains the row so shared links can still reach other offered dates.

## Student workflow

The public page requires an explicit choice when it offers several dates. It shows that occurrence's details and places before the student submits. Full, past or closed occurrences cannot be selected. A single legacy course keeps its existing booking path, including an undated course.

The API validates the selected occurrence against the same trainer and explicit course group. It uses the selected course ID for enrolment, duplicate checks, pricing, Stripe metadata, return URLs and confirmation messages. Returning from a cancelled checkout selects the same offered date when it remains bookable.

An `enrolled=true` URL parameter is not payment evidence. The return page says the payment was submitted and directs the student to their confirmation; it does not independently claim a deposit has cleared.

## Database and release

Apply only `supabase/migrations/20261020_course_date_choices.sql` before deploying this feature. It:

- Adds the nullable `courses.course_group_id` and the existing optional start-time column if absent.
- Indexes trainer/group/date and prevents duplicate date/time options within a group.
- Adds authenticated, owner-scoped `add_course_dates`, which updates the anchor and inserts new dates atomically.
- Makes exact add-date retries safe and rolls back a rejected set in full.
- Prevents changing dates or start times that have enrolments.

Existing course and enrolment IDs remain unchanged. No bookings are moved, charges collected or messages sent by the migration. If the migration is missing, existing single-date courses still work; a multi-date save explains that the training update is needed and retains the draft.

The general migration backlog must not be run for this release. Content Team changes are on a separate branch and are not part of this update.

## Checks and limits

Backend tests cover selected-date payment metadata, same-owner/group restrictions, old links, full/past dates, retry behaviour and real PostgreSQL-compatible migration/RLS/rollback behaviour. The browser suite drives the actual owner and public pages with fictional records, including date selection, mobile layout, interrupted requests and account/route changes. CI runs it through `frontend/scripts/check-training-dates.mjs`.

Existing course capacity counters and Stripe settlement logic are unchanged. This update does not add atomic seat reservations across simultaneous checkouts. Existing courses are not grouped by matching names; owners explicitly add new dates.
