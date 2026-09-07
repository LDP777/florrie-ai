# Florrie at work

Local component for Today and Florrie's brief. Six selectable roles show how diary, writing and client information supports each area, followed by recorded activity and background checks. Selection highlights a connection; it does not claim an agent is currently running.

Today requests the existing lightweight status endpoint only as the widget approaches the viewport. Selecting a role makes no request. The full brief reuses its existing response. No backend, authentication, subscription, message permission or scheduler changes.

Verified locally:
- Production frontend build and all More checks passed.
- Today loading regression checks passed.
- Role selection, unknown counts, unavailable checks and 44px tap targets passed in the isolated production bundle.
- Deferred requests, read failure, retry and discarding a previous account's response passed with the real component.
- Inspected 320px, 390px and desktop screenshots. Images use fictional fixture evidence, not live counts.

Release held locally while Levi clarifies whether the iPhone is failing. No push or deployment of this component has happened.

Incident check on 7 September:
- The emailed failed CI run was 34158177481, commit 1cad962. The test-only screenshot path failure was corrected in 0ffe384.
- Current production commit 87f97e5 has successful frontend, backend and Apple archive checks.
- The open calendar tab initially had no content. Reload restored it. Ellie’s signed-in calendar, Today and Inbox then displayed real data; calendar had 34 bookings in the selected week.
- This does not establish the state of Ellie’s iPhone. A clarification question remains pending.
- TestFlight 1.0 (743) was verified against Xcode Cloud build fe79d40e-1d2a-4738-9b04-34713c815ccb, then assigned to existing Team (2 testers). What to Test saved. Build 742 retained.
