# iPhone startup checks

Build 848 crashed on iOS 27.2.1 in UIKit's
`_UIApplicationEvaluateRuntimeIssueForNoSceneLifecycleAdoption` check. It used
the legacy AppDelegate lifecycle despite being built with Apple's 27 SDK.
The failure happened before the web app loaded, so a web deployment could not
repair an installed build.

The iPhone app now uses a single `UIWindowScene`, owned by `SceneDelegate`,
and Capacitor 8.6.2. Capacitor forwards both initial and subsequent URL opens
to the App plugin. APNs callbacks remain in AppDelegate. The bundle ID,
`capacitor://localhost` origin, auth storage and app data are unchanged.

`SceneDelegate` creates the window and bridge in code. Do not also configure
`Main.storyboard` as an application or scene startup storyboard: that creates
a second bridge. The retained AppDelegate window references the same window
for plugins that still use that property. CSS continues to own safe-area
spacing; iOS does not add a second status-bar inset.

Before an iOS release:

```sh
python3 frontend/scripts/check-ios-startup.py
npm run build --workspace frontend
cd frontend
node scripts/sync-native.cjs ios
cd ..
xcodebuild test -workspace frontend/ios/App/App.xcworkspace -scheme App \
  -destination 'platform=iOS Simulator,name=iPhone 17' \
  -parallel-testing-enabled NO CODE_SIGNING_ALLOWED=NO
```

The configuration check also runs in GitHub CI and Xcode Cloud before archiving.
The native tests launch the real app and check its window, bundled UI, plugin
registration, custom URL routing, universal-link forwarding, scene pause/resume
events and in-app browser presentation. They use synthetic URLs and no salon data.

Also cold-launch the app with an `ai.florrie.app://` URL, then repeat while it
is running. Confirm auth callbacks and a normal background/foreground cycle on
a physical iPhone before declaring the device incident resolved. A simulator
running an older iOS version does not verify the affected OS.

References: [Apple scene migration](https://developer.apple.com/documentation/technotes/tn3187-migrating-to-the-uikit-scene-based-life-cycle),
[Capacitor scene migration](https://capacitorjs.com/docs/updating/8-5).
