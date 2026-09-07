# Voice and Content update

Voice Commander has editable starting points for the diary, client care and content, plus a clearer mobile header. Commands use a 45-second deadline covering session lookup and the response, without automatic retries. An expired session cannot produce a demo answer. Late authentication cannot send a timed-out request. Existing action confirmation cards remain in place.

Content drafts can be searched by caption or post type and filtered to failed posts or missing photos. Filtering returns to list view. Save and discard failures preserve the draft.

Reviews excludes unknown ratings from averages, labels saved replies as internal to Florrie and describes the scheduler's actual seven-day check. Aftercare tolerates malformed legacy instruction and product fields. Cards remain saved guidance; this change does not connect automatic sending.

Validation: frontend production build and 78-page render checks; four command lifecycle tests; More recovery and owner workflow checks; mobile browser checks for editable Voice suggestions, single submission, returned answer, no horizontal overflow, draft filtering, failed saves/discards and retry recovery. Browser fixtures contain synthetic data and do not send client messages or publish posts. Native speech recognition and live AI responses still need an on-device check.
