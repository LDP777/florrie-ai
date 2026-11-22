# Monthly Money summary

The previous headline used recorded receipts. That is useful for checking payments, but it omits unrecorded cash and bank transfers and assigns deposits to the month they were received. It was a poor summary of the work in the diary.

Money now opens on This Month. Booked value uses the full month's confirmed and completed appointments, split into completed work and work still booked. It includes saved add-ons and promotions once. Deposits, vouchers and prepaid sessions are already part of the service value. Cancelled appointments, no-shows and pending reservations are excluded.

Payments recorded remains a separate receipt total, with a drill-down for the selected period. Receipts follow their payment date; appointments follow their salon date. Tax calculations, exports and payment collection still use receipts. This release writes no payment or appointment records and needs no migration.

Verification:

- Backend regressions cover deposits, promotions, add-ons, vouchers, packages, exclusions, missing prices, invalid statuses, duplicate rows, integer limits, month/week boundaries and BST.
- The reports route checks owner isolation and pagination beyond 1,000 appointments. An unsuccessful query returns an error instead of a zero total.
- The built app passed the monthly flow in Chromium and WebKit at 320, 390 and 430 pixels. Checks cover period selection, receipt-date filtering, All dates, recording navigation, privacy, calendar navigation, load errors, retry and genuine empty states. External requests and writes were blocked.
- Existing Money regressions passed, including more than 1,200 receipts, deduplication, refunds, receipt recording, tax, exports, interrupted writes and retry protection.
- Frontend build and its native startup, render, brand and interaction gates passed. The full backend suite passed before the final add-on/discount cases; the final affected suites passed again. CI runs the full suite on the release commit.

Unknown amounts stay unknown. Existing cash and bank payments still need the owner to record when and how they were received; appointment completion does not establish receipt.
