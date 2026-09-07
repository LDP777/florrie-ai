# Content and waitlist recovery

Content caption saves and draft deletions now show errors on the affected card. Failed saves preserve edits; failed deletions preserve the draft. The buttons show progress and prevent overlapping edit/delete actions.

Waitlist notification handlers now require a successful sender result before updating status or notification counts. Failed sends return a retryable error and retain the waiting entry. The existing offer-record action is labelled Record offer made and explains its 24-hour tracking window; it does not pick a slot, reserve an appointment or send a message.

Validation: frontend production build; synthetic browser tests for failed caption save, failed discard, successful retries and recording an offer without calling Notify; full More regression suite; 2,414 local backend tests, excluding the unavailable local PGlite test. Sender tests cover rejected SMS and email followed by successful retry. No real messages, posts or bookings were created. This does not establish device delivery or implement a slot-selection offer workflow.
