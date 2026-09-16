# WhatsApp lifecycle and launch checks

The release adds signed Meta privacy callbacks and WABA removal handling for customer-owned WhatsApp connections. Keep Embedded Signup restricted to Florrie Demo Salon until the provider and physical-phone checks below pass. Ellie’s legacy connection remains outside automatic revocation.

## Storage and callback rules

Apply `supabase/migrations/20260916_whatsapp_privacy_lifecycle.sql` after the existing Embedded Signup migration and before the backend release. It adds private identity links and request receipts, plus nullable identity fields on the existing private tables. It does not change appointments, clients, messages, sign-in accounts or legacy phone connections.

Signup checks Meta’s `debug_token` response and records the verified token subject and WABA as separate hashes before registering the phone. Callback handlers accept only verified Meta signatures. They clear credentials for a matching embedded connection, cancel matching setup sessions and release phone claims in one transaction. Old callbacks cannot remove a newer connection. A callback that arrives during setup prevents that setup from committing.

A Facebook user in a privacy callback may differ from the Business Integration System User returned for an Embedded Signup token. We do not infer that identity from browser input, a salon email or a phone number. Unmatched signed requests enter the review queue; they do not revoke an unrelated connection. This identity mapping needs a real demo revocation check before public availability. WABA `PARTNER_REMOVED` and matching `PARTNER_APP_UNINSTALLED` events provide separate paths tied to the customer WABA identity.

Deletion receipts mean “received”. Existing business records need review and cleanup; the app does not mark them deleted on receipt. Historical hash links remain after a local disconnect so later requests can still locate the salon. Public status links expose only request status and a random reference. An hourly job flags pending work, including unmatched revocations.

## Provider configuration after deployment

For the WhatsApp/Facebook Login for Business app, set:

- Deauthorisation: `https://api.florrie.ai/api/whatsapp/privacy/deauthorize`
- Data deletion: `https://api.florrie.ai/api/whatsapp/privacy/data-deletion`
- Existing WhatsApp webhook: preserve its URL and signature secret; subscribe to `account_update` after checking the current Meta payload in the dashboard.

Do not overwrite the separate Instagram Business Login callback settings. Both production APIs need the migration and code. Keep the existing shared WhatsApp encryption and OAuth signing keys unchanged.

The removal handler accepts `object=whatsapp_business_account`, `entry[].time` in Unix seconds, `changes[].field=account_update` and partner removal/uninstall events. The affected customer WABA is **`value.waba_info.waba_id`**, which is required. Meta's documented partner examples have a different `entry[].id`; the handler must not use the envelope ID or `owner_business_id` to choose a connection.

`PARTNER_APP_UNINSTALLED` also requires `value.waba_info.partner_app_id` to match Florrie's configured `WHATSAPP_APP_ID` (or `META_APP_ID` alias). Another app's uninstall is acknowledged without changing Florrie's grant. An absent or invalid app identity remains retryable, rather than guessing. `PARTNER_REMOVED` has no app ID in Meta's schema; it is accepted only through Florrie's signature-verified provider webhook. The original event timestamp and existing SQL checks prevent stale events from deleting newer grants. All applicable entries are persisted before acknowledging; database failures return 503 for retry. Neither handler calls Meta's phone deletion or WABA unsubscribe endpoints.

## Operator procedure

Run `node backend/scripts/whatsapp-privacy-requests.mjs list` with server credentials in the approved private environment. Inspect only the affected salon and the original request context. Resolve unknown identities through verified owner/provider evidence. Review WhatsApp-derived messages, linked client information, media, downstream copies and applicable retention obligations; preserve unrelated bookings and client records. Record what was removed or retained and why in the private case record.

After fulfilling the request, run `node backend/scripts/whatsapp-privacy-requests.mjs complete REQUEST_UUID --evidence CASE_REFERENCE --confirm-cleanup-finished`. The evidence reference must point to the completed review. This command records completion; it does not perform cleanup. Avoid client text or credentials in the reference. Reopen the receipt page to verify its final status.

## Remaining live proof

1. Connect a separate demo number through ordinary Florrie signup and verify its token subject, WABA and phone ownership. Do not register or migrate Levi’s or Ellie’s existing number.
2. With approval for the exact test message, prove receipt and reply through the demo tenant. Verify delivery status and template availability with that tenant’s credentials.
3. Disconnect and reconnect from Florrie; then revoke the demo integration from Meta. Verify the signed callback’s subject and WABA removal payload, credentials removal, cancelled setup sessions and unaffected legacy connection.
4. Submit a demo deletion request and verify its pending receipt and operator queue. Complete only after reviewing the fictional records.
5. Repeat connection, cancellation and return to Florrie on a physical iPhone.

Florrie’s existing configuration uses the Cloud API flow and asks for a separate business number. It does not implement or prove WhatsApp Business app coexistence. Do not advertise using a consumer WhatsApp number without interruption, ask anyone to delete their WhatsApp account, or describe a Meta test-number send as proof of real customer onboarding.

The global template health check now selects explicit legacy senders and labels both template results `legacy_connections_only`. It no longer pairs the first customer-owned phone with Florrie’s shared token. It does not certify templates for each new salon; use the authenticated per-salon template screen and a delivery check for that.

## Sources and limits

Meta’s official [Cloud API collection](https://www.postman.com/meta/whatsapp-business-platform/documentation/wlk6lh4/whatsapp-cloud-api) documents phone registration, WABA subscription and test messaging as separate steps. Meta’s [Embedded Signup webhook example](https://www.postman.com/meta/whatsapp-business-platform/request/wfua3nd/sandbox-number-upgraded-to-verified-account) shows the WABA entry ID, Unix timestamp and `account_update` structure. Its [sample tech-provider app](https://github.com/fbsamples/business-messaging-sample-tech-provider-app) separates onboarding from messaging and provider configuration.

Meta's official [account_update reference](https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_update), updated 21 May 2026, was verified in the operator's Chrome session on 16 September. The published `PARTNER_REMOVED` example has envelope ID `2949482758682047` and customer WABA `980198427658004`. The uninstall example uses the same envelope ID, customer WABA `184943124712545` and partner app `869361281603019`. Tests use those exact published examples. This follow-up corrects the earlier assumption that envelope and customer WABA IDs had to agree. The actual callback subject and a live demo revocation still need verification.

Other direct Meta pages returned HTTP429 during the initial audit. Postman’s separate [developer-assets guide](https://www.postman.com/postman/brewing-postman-flows/folder/euh50yh/step-1-set-up-developer-assets-and-platform-access) describes Meta’s provided test number, but it is not Meta-authored evidence of a real Embedded Signup flow. A test sender can exercise messaging and receipt handling; it cannot prove the separate number-verification, grant and native onboarding steps.

## Local validation

All 2,622 backend tests across 162 files pass with `TZ=UTC`. Focused coverage includes real PostgreSQL migration/functions in PGlite, HTTP privacy callbacks, signed webhook acknowledgement ordering, tenant/legacy isolation, stale replay, setup races, storage failures and private-table permissions. A pre-existing source scanner pinned a webhook line number; it now pins the same file and dynamic select expression so unrelated line movement does not fail CI. No live callback, message, phone registration, deployment or provider setting changed during this work.

The subsequent partner-event correction passed 93 focused tests across six files, covering both documented payloads, nested customer routing, foreign partner exclusion, app-ID configuration/alias checks, signature rejection, unsigned grace rejection, storage retries, legacy mode, privacy callback isolation, stale events and schema drift. No further migration is needed beyond the lifecycle migration above. It remains subject to the existing demo-only rollout and live-demo proof.
