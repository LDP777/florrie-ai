# APNs Go-Live (real iOS push)

Code is wired end to end. These steps are yours, in order.

## 1. Create the APNs key
Apple Developer portal > Certificates, Identifiers & Profiles > Keys > "+".
Name it (e.g. "Florrie APNs"), tick **Apple Push Notifications service (APNs)**, register, then **download the .p8 file** (one-time download, keep it safe). Note the **Key ID** on that page and your **Team ID** (top right of the portal, under your name).

## 2. Railway env vars (backend service)
- `APNS_KEY_ID` = the Key ID from step 1
- `APNS_TEAM_ID` = your Apple Team ID
- `APNS_PRIVATE_KEY` = full contents of the .p8 file, including the BEGIN/END lines. Pasting it single-line with `\n` instead of newlines works too.
- `APNS_BUNDLE_ID` = `ai.florrie.app` (optional, this is the default)

Leave `APNS_HOST` unset for TestFlight/App Store. Redeploy after setting.

## 3. Apply migration 060
Paste `docs/APPLY_IN_SUPABASE_2026-06-11_native_push.sql` into the Supabase SQL editor, then **Restart** the Railway backend (PgBouncer schema cache).

## 4. Test
Install the next TestFlight build, log in, accept the notification prompt. Then send a WhatsApp message to Ellie's number and complete a booking: the booking confirmation should land as a real iOS push.

## Signing note
Xcode Cloud auto-signing should pick up the new Push Notifications capability from `App/App.entitlements`. If the build fails on signing, open the project once locally in Xcode, tick **Push Notifications** under Signing & Capabilities, and let it regenerate the profile.
