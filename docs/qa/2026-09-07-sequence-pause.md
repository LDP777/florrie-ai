# Follow-up sequence pause

Pausing a sequence previously stopped new enrolments while the worker continued sending queued steps. The worker now reads the sequence's current active state and supported trigger, scoped to the enrolment's salon, before processing each due step. Paused, missing, unsupported or unreadable sequences retain their step and due date.

The Automations page now uses Pause sequence and Resume sequence. It explains that resuming includes overdue steps and that a send already in progress can still arrive. Existing consent and outbound checks remain in place.

Validation: paused queue with a stale active join snapshot, resume from the held step, missing sequence, unsupported trigger, wrong salon and failed state read. Full local backend suite: 2,419 tests passed, excluding local PGlite. Frontend build and More regression suite passed. No live sequence switches or messages were used for testing.
