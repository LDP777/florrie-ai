# In-app updates

The **More → What’s new** page is at `/updates`. Its content lives in `frontend/src/pages/app-updates.js` and ships with the app. It needs no extra account permission or database request.

When releasing a useful change:

1. Add a short entry to the dated history, newest first. Use the actual release date. Group small related fixes into one entry.
2. Say what the salon owner can now do, in a short title and one or two plain sentences. Keep implementation details and promises of future features out.
3. Link to the relevant screen when useful. Check that the route exists on web and iPhone.
4. Record the supporting commit IDs in `commits` for future checks. These are not displayed in the app.
5. Build and check `/more` and `/updates`, including a narrow phone. Add the release commit ID after it exists if the entry is added in the same release.

The initial history covers verified releases on 14, 16, 17 and 18 November 2026. It is deliberately selective. It contains no client records, credentials or claims that pending platform approvals are complete.
