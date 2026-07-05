# Florrie "on the desk" Live Activity - Xcode setup

The code is written and committed. These are the steps only Xcode on your Mac can do (adding a target, entitlements, and putting the Swift files in the right targets). Roughly 20 minutes, then a TestFlight build.

## What ships in the repo

Backend (live already once deployed):
- `backend/src/services/apns.js` -> `sendLiveActivityPush()` (liveactivity push type)
- `backend/src/services/live-activity.js` -> `buildDeskState`, `refreshLiveActivity`, `endLiveActivity`
- `backend/src/routes/push.js` -> `POST /api/push/live-activity/register`, `/end`, `GET /state`
- `refreshLiveActivity()` fires after: a new booking, a gap-fill send, and a front-desk escalation/reply
- Migration `supabase/migrations/20260705_live_activity_tokens.sql` (also in `docs/`)

iOS (needs wiring in Xcode):
- `frontend/ios/App/FlorrieWidget/` -> `FlorrieActivityAttributes.swift`, `FlorrieBrand.swift`, `FlorrieWidgetLiveActivity.swift`, `FlorrieWidgetBundle.swift`, `Info.plist`
- `frontend/ios/App/App/FlorrieLiveActivity.swift` + `FlorrieLiveActivity.m` (Capacitor plugin)
- `frontend/ios/App/App/Info.plist` -> `NSSupportsLiveActivities` already set
- JS bridge `frontend/src/lib/liveActivity.js`, started from `App.jsx` on sign-in

## Xcode steps

1. Open `frontend/ios/App/App.xcworkspace` in Xcode.

2. **Add the Widget Extension target.** File > New > Target > **Widget Extension**. Name it exactly **FlorrieWidget**. Tick **Include Live Activity**. Untick "Include Configuration App Intent". Finish, and Activate the scheme if prompted. Xcode creates a FlorrieWidget group with a starter file, delete that starter `FlorrieWidget.swift`/`...LiveActivity.swift` it generates.

3. **Add the committed Swift files to the target.** In Xcode, right-click the FlorrieWidget group > Add Files, and add the four files from `frontend/ios/App/FlorrieWidget/` (the repo ones). Set target membership:
   - `FlorrieActivityAttributes.swift` -> **both** App and FlorrieWidget targets
   - `FlorrieBrand.swift` -> **both** App and FlorrieWidget targets
   - `FlorrieWidgetLiveActivity.swift` -> FlorrieWidget only
   - `FlorrieWidgetBundle.swift` -> FlorrieWidget only
   - Let Xcode use the committed `FlorrieWidget/Info.plist` for the extension (or keep the one Xcode made, either is fine).

4. **Add the plugin to the App target.** Add `frontend/ios/App/App/FlorrieLiveActivity.swift` and `FlorrieLiveActivity.m` to the **App** target (they're already in the folder; confirm target membership is App). Capacitor registers the plugin automatically via the `.m` macro.

5. **Deployment target.** Set the FlorrieWidget target's iOS Deployment Target to **16.1** (Live Activities). The App target can stay where it is.

6. **Capabilities.** The App target already has Push Notifications. `NSSupportsLiveActivities` is in `App/Info.plist`. No App Group is needed (updates come by push, not shared storage).

7. Build to a **real device** (Live Activities need a physical iPhone, iOS 16.1+). Sign in. The strip should appear on the lock screen and, on a 14 Pro or later, in the Dynamic Island.

## APNs environment gotcha

Live Activity pushes use the **same** .p8 auth key you already set (`APNS_KEY_ID`, `APNS_TEAM_ID`, `APNS_PRIVATE_KEY`). The one thing to get right is the host:
- A build run from Xcode onto your device uses the **sandbox** APNs -> set `APNS_HOST=api.sandbox.push.apple.com`.
- A **TestFlight / App Store** build uses **production** APNs -> `APNS_HOST=api.push.apple.com` (the default).
If the strip appears but never updates, this mismatch is the first thing to check.

## How it behaves

- The app starts the strip on sign-in and registers its push token with the backend.
- `refreshLiveActivity()` pushes fresh content (handled count + next client) whenever Florrie books someone, fills a gap, or handles a message. It reads salon wall time straight off `starts_at` (no timezone conversion).
- The strip goes stale (greys) after 2h with no update, and can be ended with `endDeskActivity()` (good to wire into an end-of-day moment later).

## Quick test without waiting for a real event

With a device strip running, call the backend refresh manually (psql or a one-off): `select` the beautician id, then hit any action that logs an `ai_action` or creates a booking, or add a temporary authed route that calls `refreshLiveActivity(req.beautician.id)`.
