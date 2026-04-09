# Florrie — Manual Test Checklist

Pre-launch human testing. Run this on desktop and mobile (iPhone Safari) before sending Ellie her access link.

**Test account:** Use your own Florrie account — not a fake one.
**Booking slug:** your actual slug (check Settings > Booking Link).
**Device coverage:** Desktop Chrome + iPhone Safari as minimum.

---

## 1. Sign Up Flow

- [ ] Go to florrie.ai/login — page loads cleanly, no console errors
- [ ] Click "Don't have an account? Sign up" — form switches to signup mode
- [ ] "14-day free trial. No card required." note is visible
- [ ] Fill in email + password (8+ chars) and click "Create account"
- [ ] Email confirmation email arrives within 60 seconds
- [ ] Confirming the email redirects to the app or login
- [ ] Signing in after confirmation takes you to onboarding, not dashboard
- [ ] "Continue with Google" button is visible (don't need to test the full OAuth flow)

---

## 2. Onboarding

- [ ] Step indicator shows "Step 1 of 4" (or whatever total you have)
- [ ] Step 1: first name and business name are required — blank submission stays on step 1
- [ ] Step 1: filling both fields and clicking Continue advances to step 2
- [ ] Step 2: adding a treatment with name, price, and duration works
- [ ] Step 2: "Add another treatment" adds a second row
- [ ] Step 3: working hours — toggle days on/off, set start/end times
- [ ] Step 4 (if applicable): client import or skip works
- [ ] Finishing onboarding lands on the dashboard

---

## 3. Public Booking Page (florrie.ai/book/YOUR-SLUG)

Run this as a client would — open in an incognito window.

- [ ] Page loads your branding (business name, treatments)
- [ ] Treatments list is correct and prices match what you set
- [ ] Selecting a treatment highlights it and "Continue" becomes active
- [ ] Date strip loads the next 14 days
- [ ] Greyed-out dates are not clickable
- [ ] Selecting an available date loads time slots for that day
- [ ] Selecting a time slot highlights it
- [ ] "Your Details" step shows name*, phone*, email (optional)
- [ ] Submitting without name or phone stays on the step and shows validation
- [ ] Filling all required fields and continuing reaches the Confirm step
- [ ] Confirm step shows: treatment name, date, time, client name
- [ ] **Complete an actual test booking** using your own name + number
- [ ] Confirmation screen appears after submit
- [ ] You receive a booking notification (WhatsApp/email depending on config)
- [ ] The booking appears in your Calendar view in the dashboard
- [ ] Client appears in your Clients list

---

## 4. Dashboard

Log in as the beautician after completing the test booking above.

- [ ] Dashboard loads without a blank screen or console errors
- [ ] Agent status badges are visible (Booking Agent, Tax Agent, etc.)
- [ ] Today's schedule card shows the test booking
- [ ] Clicking a booking opens the appointment detail
- [ ] Appointment detail shows client name, treatment, time
- [ ] "Add note" saves and persists after page refresh

---

## 5. Calendar View

- [ ] /calendar loads and shows the current week
- [ ] Test booking is visible on the correct date
- [ ] Clicking the appointment opens the detail panel
- [ ] Previous/next week navigation works

---

## 6. Client Record

- [ ] /clients loads and shows the test client
- [ ] Clicking the client opens their profile
- [ ] Booking history shows the test appointment
- [ ] Notes field saves correctly

---

## 7. Settings — Critical Checks

- [ ] /settings loads without error
- [ ] "Booking Link" tab shows your slug and a copyable URL
- [ ] Opening the booking URL in a new tab works
- [ ] Working hours are saved correctly and reflect on the booking page (test: block today, check booking page doesn't show today)

---

## 8. Mobile (iPhone Safari — repeat key flows)

Open florrie.ai on your iPhone in Safari.

- [ ] Landing page loads cleanly, text is readable
- [ ] Sign in form works — keyboard doesn't break the layout
- [ ] /book/YOUR-SLUG loads on mobile
- [ ] Treatment selection works with tap
- [ ] Date strip is scrollable horizontally
- [ ] Time slot buttons are large enough to tap comfortably
- [ ] Client details form — keyboard appears, doesn't cover the active field
- [ ] Confirm step is readable at 390px width
- [ ] Dashboard loads on mobile — bottom nav is usable
- [ ] Calendar scrolls to current time on load

---

## 9. Things Automation Can't Catch

Run these manually — one time is enough before beta.

- [ ] WhatsApp reply actually arrives when a new booking is made
- [ ] Reminder messages fire at the right time (test with a booking for +24h and wait)
- [ ] Tax dashboard shows plausible numbers after logging income manually
- [ ] Receipt scan — photograph a real receipt, upload it, check extracted values
- [ ] Voice Commander — say "who's coming in tomorrow?" and verify the response is correct

---

## Known Skips (pre-launch)

These are wired but need live external accounts — skip until Ellie's accounts are connected:

- [ ] Stripe payment flow (requires Stripe activation)
- [ ] WhatsApp auto-reply (requires Meta business verification)
- [ ] Google Calendar sync (requires OAuth connection in settings)

---

## How to Run Playwright (automated tests)

```bash
# First time — from frontend/
npm install
npx playwright install chromium

# Against production
E2E_BOOKING_SLUG=your-slug npx playwright test --project=booking

# Against local dev server (make sure both frontend and backend are running)
BASE_URL=http://localhost:5173 E2E_BOOKING_SLUG=your-slug npx playwright test --project=booking

# Authenticated tests (need a real test account)
E2E_EMAIL=test@example.com E2E_PASSWORD=yourpass npx playwright test

# View results
npx playwright show-report
```
