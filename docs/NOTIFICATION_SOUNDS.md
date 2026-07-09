# Signature notification sounds (Levi's Xcode evening)

The backend already sends per-category sound names on every APNs push:

- `bloom-good.caf` — good news: bookings, filled gaps, money moments, milestones, week in review
- `bloom-needsyou.caf` — needs her: escalations, pending unpaid bookings, cancellations, channel failovers

Until the files ship in a build, pushes use the default iOS sound (the names
are env-gated so a missing file can never cause silent pushes).

## Steps (files already generated and committed)
The two .caf files live at `frontend/ios/App/App/Sounds/` — synthesized from
the bloom.js chime (E5+B5 rise for good news, single soft B4 for needs-you),
IMA4-in-CAF, correct format for APNs.

1. In Xcode: drag `bloom-good.caf` and `bloom-needsyou.caf` from
   frontend/ios/App/App/Sounds/ into the App target (tick "App" under
   target membership). They must end up in the app bundle root.
2. Cut a build.
3. Set `APNS_CUSTOM_SOUNDS=true` on Railway and restart.
4. Optional: preview them first with `afplay bloom-good.caf` on your Mac; if
   you want a different feel, tell me and I regenerate.

Haptics: the in-app haptic grammar (hapticSuccess vs hapticTap) already
distinguishes good-news from needs-you inside the app; the sound split gives
the same signal when the phone is in her pocket.
