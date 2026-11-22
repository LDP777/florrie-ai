# Working hours

`/hours` has three sections: Specific dates, Usual week and Time off. The old Settings hours link redirects to the usual week. The day calendar opens the same date editor directly.

## Opening hours and blocked time

- `beauticians.working_hours` remains the usual week.
- `date_working_hours` replaces the opening window for a salon on one date. Its primary key is `(beautician_id, date)`. Removing the row restores the usual weekday, including a normally closed day.
- `hours_exceptions` still removes availability. Existing `amended` and `extended` rows are blocked time, despite their old labels. Do not migrate them into openings or reinterpret them.
- Existing appointments are never moved by changing hours. Holidays and personal blocks still apply inside a dated opening window.

The pure `backend/src/lib/effective-hours.js` resolver is shared by the API and frontend. It uses salon wall-clock dates, matching appointment storage. It does not convert those strings into the device timezone.

## Writes and reads

The authenticated `/api/working-hours` route scopes every operation to the current salon. `PUT /dates` saves 1–60 dates with one database upsert. `DELETE /dates/:date` restores the usual hours. Times must be whole minutes, ordered and within the same day. The GET range is limited to two years. Direct browser access is owner-only SELECT; only the backend can write.

Deploy `20261122001046_date_working_hours.sql` before the application. It adds empty storage and changes no existing hours or booking records. Availability reads fail explicitly if dated hours cannot be checked, rather than pretending the usual week is authoritative.

Client day/month pickers, rescheduling, patch-test slots, manual creation, conversational booking, gap availability and Smart Schedule use the dated window. The public booking write rechecks that the full treatment, buffer and lateness padding fit before saving. Both calendar grids expand if an early or late opening needs more room.

## Verification

- `backend/tests/unit/date-working-hours.test.js`: multi-date save, one-off opening, regular week unchanged, blocks, failures, ownership and date validation.
- `backend/tests/unit/date-working-hours-sql.test.js`: real Postgres constraints and row access using PGlite.
- `backend/tests/unit/reschedule-shows-real-times.test.js`: public availability and acceptance of extra-hours reschedules.
- `frontend/scripts/check-working-hours.mjs`: built phone UI, Settings redirect, explicit weekly save, failed-save recovery, personal-block edit, calendar restoration, early/late grid bounds and client date/time selection. All records and writes are fictional.
