# Florrie Agent Widget — iOS Setup

## What It Does
Home screen widget showing 6 little agent avatars with live activity status.
Fetches from `GET /api/agents/widget` every 15 minutes via WidgetKit timeline.

## Prerequisites
- Apple Developer Account (Levi needs to set this up)
- Xcode 15+ with iOS 17 SDK
- Capacitor iOS project initialised (`npx cap add ios`)

## Setup Steps

### 1. Add Widget Extension in Xcode
- Open the iOS project: `npx cap open ios`
- File → New → Target → Widget Extension
- Name: `FlorrieAgentWidget`
- Uncheck "Include Configuration App Intent" (we use StaticConfiguration)

### 2. App Group
Both the main app and widget need to share auth tokens:
- Xcode → Main target → Signing & Capabilities → + App Groups
- Add group: `group.ai.florrie.app`
- Do the same for the widget target

### 3. Auth Token Sharing
The Capacitor app writes the Supabase auth token to shared UserDefaults on login.
Add this to the iOS native bridge (AppDelegate or a Capacitor plugin):

```swift
let defaults = UserDefaults(suiteName: "group.ai.florrie.app")
defaults?.set(token, forKey: "authToken")
WidgetCenter.shared.reloadAllTimelines()
```

### 4. Copy Widget Code
Copy `FlorrieAgentWidget.swift` into the widget extension target.

### 5. Build & Test
- Select the widget scheme in Xcode
- Run on simulator or device
- Long-press home screen → + → Search "Florrie" → Add widget

## Widget Sizes
- **Small (2×2)**: 6 avatar circles in a 3×2 grid
- **Medium (4×2)**: Avatars with names and micro-status ("2h", "15m")
- **Lock Screen**: Headline + active agent avatars in a row

## Backend Endpoints
- `GET /api/agents/status` — full data for dashboard (auth required)
- `GET /api/agents/widget` — lightweight payload for iOS widget (auth required)

## Refresh Rate
WidgetKit controls refresh timing. We request 15-minute intervals, but iOS
may throttle to ~40-70 refreshes per day. The widget shows `updatedAt` so
users know how fresh the data is.
