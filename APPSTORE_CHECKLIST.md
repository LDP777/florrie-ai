# App Store Submission Checklist

## Before You Start

1. **Decide on platforms:** iOS (Apple App Store) and/or Android (Google Play)
2. **Budget:** Apple Developer Program (£99/year), Google Play (£25 one-time)
3. **Timeline:** Expect 1–3 weeks for review on each store

---

## Both Stores

- [ ] App ID: `ai.florrie.app`
- [ ] App Name: `Florrie`
- [ ] Version: `1.0.0`
- [ ] Build locally: `npm run build && npx cap sync`
- [ ] App icons: 1024×1024 PNG (use logo from ellindigo-branding/)
- [ ] Screenshots:
  - [ ] 6.7" iPhone (e.g. iPhone 14/15 Pro Max)
  - [ ] 12.9" iPad
  - [ ] Pixel 7 Pro or similar Android device
  - Minimum 2 screenshots, ideally 5–8 per platform
- [ ] Privacy policy: https://florrie.ai/privacy ✅ (page created)
- [ ] Support URL: https://florrie.ai/support ✅ (page created)
- [ ] Terms of service (optional but recommended)
- [ ] Contact email: hello@florrie.ai
- [ ] Test on multiple devices before submitting

---

## Apple App Store

### Account & Setup

- [ ] Apple Developer account (register at [developer.apple.com](https://developer.apple.com), pay £99/year)
- [ ] Mac with Xcode installed (`xcode-select --install` to verify)
- [ ] iPhone or iPad with iOS 15+ for testing
- [ ] Create App ID on Apple Developer Portal

### Build Configuration

- [ ] Bundle ID: `ai.florrie.app`
- [ ] Minimum iOS version: 15.0
- [ ] Development Team: Add your team certificate
- [ ] Signing certificate: Create in Xcode (automatic usually)
- [ ] Provisioning profile: Create in Xcode

### App Content

- [ ] App category: **Business**
- [ ] Subcategory: (optional, e.g. "Business Utilities")
- [ ] Age rating: **4+** (no adult content, violence, etc.)
- [ ] Subscription terms (if applicable):
  - Florrie is free to try; premium features require subscription
  - Add your pricing: £29/month
  - Include trial info if offered

### Privacy & Security

- [ ] App Privacy section:
  - Collected: Name, phone, email, appointment history
  - Used for: Service delivery (booking management, reminders)
  - NOT sold or shared to third parties
  - Marketing consent optional
- [ ] Data minimization: Don't ask for camera/location unless necessary

### Submission

1. Open Xcode → Product → Scheme → Edit Scheme → Release
2. Product → Archive
3. Organizer window → Distribute App
4. App Store Connect
5. Complete app metadata in App Store Connect:
   - Screenshots
   - Description
   - Keywords (salon management, appointments, booking)
   - Support URL
   - Privacy policy
6. Submit for review

**Expected review time:** 24–48 hours (usually faster for first app)

---

## Google Play

### Account & Setup

- [ ] Google Play Console account (register at [play.google.com/console](https://play.google.com/console), pay £25 one-time)
- [ ] Google account (personal or business)
- [ ] Android device or emulator for testing
- [ ] Android Studio installed (optional but helpful)

### Build Configuration

- [ ] Package name: `ai.florrie.app`
- [ ] Target SDK: 34 (Android 14) — update in `android/app/build.gradle`
- [ ] Min SDK: 21 (Android 5.0)
- [ ] Version name: `1.0.0`
- [ ] Version code: `1`
- [ ] Signing key: Generate or use existing (Google will handle renewal for updates)

### App Content

- [ ] Category: **Business**
- [ ] Data safety form:
  - [ ] Does not collect personal data (NO — we do)
  - [ ] Collects: Name, phone, email, appointment history
  - [ ] Purpose: Service delivery (booking, reminders)
  - [ ] Data sharing: Not shared with third parties (select "No")
  - [ ] Encryption: HTTPS in transit
  - Permissions: Location (no), Camera (no unless for photo consent), Contacts (no)
- [ ] Ads declaration: **No ads**
- [ ] Targeting: Not for children (COPPA not applicable)

### Build & Sign

1. Generate a signed APK/AAB:
   ```bash
   cd android
   ./gradlew bundleRelease  # creates app-release.aab (preferred for Play Store)
   ```
2. Or: `./gradlew assembleRelease` for APK (legacy)
3. Sign with your key (gradle handles this with `keystore`)

### Submission

1. Go to Google Play Console
2. Create new app → Select language (English) → Category (Business)
3. Fill in app details:
   - Title, short description, full description
   - Screenshots (minimum 2, up to 8 per device type)
   - Feature image (1024×500)
   - Category icon (192×192)
   - Promo video (optional)
4. App signing:
   - Use Google Play App Signing (Google will manage your keystore)
   - Or provide your own keystore
5. Release to production (not beta/alpha for first submission)
6. Submit for review

**Expected review time:** 2–4 hours (usually very fast)

---

## Post-Launch

### Monitor

- [ ] Check app store reviews daily for first week
- [ ] Monitor crash reports (via Google Play Console / App Store Connect)
- [ ] Set up analytics to track installs, retention, uninstalls

### Updates

- [ ] Increment version code/number for each release
- [ ] Resubmit with release notes (usually faster than initial review)
- [ ] Keep privacy policy updated

---

## Troubleshooting

### iOS Build Fails
- Check Team ID in Xcode project
- Ensure provisioning profile is valid
- Run `pod install` in ios/ directory if Capacitor plugins need updating

### Android Build Fails
- Check `targetSdk` in `android/app/build.gradle`
- Ensure keystore password is correct
- Verify `compileSdk` matches `targetSdk`

### App Rejected
- **iOS:** Usually for privacy/data handling — read reviewer feedback carefully
- **Google Play:** Usually rejects for deceptive practices — review data safety form

---

## Resources

- [Apple Developer Documentation](https://developer.apple.com/documentation/)
- [Google Play Console Help](https://support.google.com/googleplay/android-developer)
- [Capacitor iOS Deployment](https://capacitorjs.com/docs/ios)
- [Capacitor Android Deployment](https://capacitorjs.com/docs/android)
