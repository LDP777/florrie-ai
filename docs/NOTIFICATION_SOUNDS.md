# Signature notification sounds (Levi's Xcode evening)

The backend already sends per-category sound names on every APNs push:

- `bloom-good.caf` — good news: bookings, filled gaps, money moments, milestones, week in review
- `bloom-needsyou.caf` — needs her: escalations, pending unpaid bookings, cancellations, channel failovers

Until the files ship in a build, pushes use the default iOS sound (the names
are env-gated so a missing file can never cause silent pushes).

## Steps
1. Produce the two sounds (<=30s, ideally <2s). The two-note bloom chime from
   lib/bloom.js (E5 then B5, soft synth) is the brand sound: export it as
   bloom-good; a single softer note (B4) as bloom-needsyou. Convert to CAF:
   `afconvert input.wav bloom-good.caf -d ima4 -f caff -v`
2. In Xcode: drag both .caf files into the App target (Copy items if needed,
   add to target App). They must be in the app bundle root, not an asset catalog.
3. Cut a build.
4. Set `APNS_CUSTOM_SOUNDS=true` on Railway and restart.

Haptics: the in-app haptic grammar (hapticSuccess vs hapticTap) already
distinguishes good-news from needs-you inside the app; the sound split gives
the same signal when the phone is in her pocket.
