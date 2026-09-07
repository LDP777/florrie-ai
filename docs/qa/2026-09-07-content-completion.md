# Content: finish a draft and choose its posting time

The weekly planner could leave Ellie with drafts that needed a photo, but the draft editor only changed the caption. This release lets her attach a photo or reuse a gallery image, edit hashtags, save the same draft and choose its posting time.

## Result

- Draft editing saves the caption, hashtags and photo together through the owned-post API. Upload and save failures retain the edits. Discard only removes the card after the server confirms deletion.
- A gallery after-photo can become a separate draft; the gallery pair remains intact.
- Scheduling offers a date and time in the device timezone, with change-time and return-to-drafts actions. Calendar grouping uses that timezone too. The server requires a future instant and a saved public image.
- AI captions use the selected treatment, brief, existing caption and optional attached photo. The suggestion waits for acceptance before replacing the writing. Failed generation preserves the draft.
- Starter templates no longer invent discounts, available days or client results. The text shown in an idea card is the text opened in the composer.
- Switching back from a content stream to All reloads the full current feed. Older feed responses cannot replace a newer filter result. Weekly plans switch to All so their drafts are visible.
- Recent-work ideas are requested explicitly, use completed past appointments and omit client identities. An unreadable draft count stops another weekly plan with an explanation.
- Server edits, scheduling and deletion protect gallery pairs, another salon's rows, published posts and posts claimed by the publishing worker. Legacy rows with no post type remain editable.

## Validation

- Frontend build and its required checks passed.
- More-page recovery and populated-layout browser suites passed, including the new Content completion flow. Requests use isolated fixtures; external traffic is blocked.
- Completion coverage includes upload failure, same-draft photo recovery, stream switching, rejected scheduling and retry, returning to drafts, AI refusal and acceptance, photo context, gallery reuse and mobile overflow. The posting picker is exercised in Europe/London.
- 2,434 backend tests passed across 141 files. The local run excluded the separate disposable-PostgreSQL payment-integrity suite; CI runs that suite with the installed dependency.
- Server regression cases include tenant ownership, worker-claim races, published-post protection, invalid image/time input, failed writes, completed-appointment filtering and optional AI photo context.

No live Instagram posts, client messages, appointments or gallery records were created for these checks. Native photo selection and a real Instagram publish still need device/provider validation.

## Remaining Content work

This is a completion release, not the end of the Content audit. Feed pagination still limits the initial result to 30 posts. Stream progress needs a separate review of its counting period, posted-versus-scheduled totals and stale responses. Cancellation-based ideas need current availability revalidation. Image-format preparation and broader video/carousel tools also remain separate work.
