# Client care: form recovery and request order

Client records now put form requests before submitted answers, with pending requests first and counts for both sections. Expired links show a past-tense date.

Public consultation forms stop a stalled read after 15 seconds and offer Retry after load failure. Changing the form link resets client details, answers and signature state, and ignores a late response from the previous link. Existing submission and backend permissions remain unchanged.

Validation uses synthetic clients: Guardian selection and signatures, patch-test records and failed reads, template save recovery, send-a-form flow, public load failure and timeout recovery, required signatures, and submission failure preserving answers. The frontend production build and care suites pass. Phone and desktop screenshots were inspected for the record layout.

This release does not establish delivery on a real client's phone or replace Ellie's review of recorded reactions and answers. No production client records or messages were created during testing. The wider More audit remains open, including Content edit/discard failures and Waitlist offer behaviour.
