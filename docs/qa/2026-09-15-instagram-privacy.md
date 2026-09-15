# Instagram connection and data requests

The demo Instagram connection received Levi's test DM once and sent the single approved reply through Florrie's authenticated inbox endpoint. Meta returned a message identifier and Florrie stored both messages in the demo salon. This verifies that conversation on the tester account; public access and owner replies from Instagram still need separate validation.

## Change

Disconnect now clears the token, account IDs, display name and expiry in one checked write. A failed write returns an error. Background refresh and display-name repair cannot restore values after a concurrent disconnect or token replacement. Inbound routing ignores disconnected profiles even if an old alias remains.

The Instagram privacy routes verify HMAC-SHA256 with the Instagram app secret before accepting a request. Requests use an idempotent receipt and a hashed account reference. A callback predating a newer connection cannot revoke that connection. The new database tables restrict access to the service role; the public receipt page exposes status only.

Data deletion requires operator review. The callback saves the request and disconnects its still-matching connection. It does **not** claim that clearing credentials deletes messages, client records or learned data. The status page remains unfinished until an operator records completed cleanup. An hourly job flags pending requests in the existing job-error/Sentry reporting path. This is an intake and review workflow, not automated full data erasure.

## Deployment order

1. Apply `supabase/migrations/20260915_instagram_privacy_requests.sql` before deploying the backend. This adds columns/tables and hashed account references without altering existing profile values or deleting business records.
2. Confirm `INSTAGRAM_APP_SECRET` is set to the Instagram app secret and `INSTAGRAM_REDIRECT_URI` is the production HTTPS callback.
3. Deploy, check invalid signatures return 403, and confirm the public instructions page is reachable.
4. Register deauthorization URL `https://api.florrie.ai/api/instagram/privacy/deauthorize` and data-deletion callback URL `https://api.florrie.ai/api/instagram/privacy/data-deletion` in the Instagram Business Login settings.

## Operator cleanup

Run `node backend/scripts/instagram-privacy-requests.mjs list` with the existing private production configuration. Review the referenced salon IDs and the request timestamp. Requests after disconnect retain hashed routing references; unmatched requests also remain in the review queue.

Inventory the Instagram messages and media, Instagram-derived client identifiers and names, outbound records, queued drafts, AI action/decision records, client intelligence, voice examples and correction history affected by the request. Identify mixed booking/consultation records and any retention obligation. Do not delete an entire salon, auth account, appointment diary or billing account merely because Instagram sent a platform-data request. Also check provider records and backups. Record the disposition and any justified retained records in the private support case.

Only after the review and actual cleanup are finished, run `node backend/scripts/instagram-privacy-requests.mjs complete UUID --evidence TICKET --confirm-cleanup-finished`. This records evidence and changes the receipt status; it performs no deletion itself. Do not use a test fixture or an assumed cleanup as evidence.

## Validation

All 2,544 backend tests across 152 files passed with `TZ=UTC`, including the disposable PostgreSQL regressions. The full project build and 79 frontend render checks passed. The additive migration was applied in production; both existing Instagram connections remain present, five hashed references were seeded, and the demo user's database role cannot read the private request queue.

Tests cover forged/malformed/wrong-app signatures; durable receipt before success; retryable failures; status privacy; pending-vs-completed wording; SQL role restrictions; callback deduplication; old/replaced connections; aliases after disconnect; and preservation of other salons and work records. Existing Instagram connection/messaging tests cover the changed paths. No real account was disconnected or deleted as a test.

Meta reference: https://developers.facebook.com/documentation/development/create-an-app/app-dashboard/data-deletion-callback

## Still needed for public launch

Instagram advanced-access review, publishing evidence, owner-message echo permission/delivery validation, complete privacy/AI disclosures, and customer-owned WhatsApp Embedded Signup remain separate work. Do not describe this module as completing Meta review or automatic deletion.
