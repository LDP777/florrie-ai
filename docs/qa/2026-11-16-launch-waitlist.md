# Florrie launch waitlist

The landing page sent visitors straight to account signup and had no email-only capture. Its unused waitlist handler also waited for two email sends before responding.

Primary landing actions now open a short email-and-consent form in the existing design. The backend saves the normalized address before returning success, preserves the first signup and unsubscribe on retries, records bounded campaign tags, rejects missing consent and honeypot submissions, and retains existing CAPTCHA enforcement. No welcome or campaign emails are sent by capture. The public form never receives a subscriber list or unsubscribe credentials.

Migration waitlist_launch_capture applied as 20261116155849. The private florrie_launch_mailing_list view is the export source: only consented, subscribed, non-test records. Anonymous and ordinary salon users cannot read, insert directly, export or truncate this list. Unsubscribe requires POST; merely following an email link does not change preferences.

Verification before release: full backend 221 files / 4,137 tests passed, plus 2 real PostgreSQL-engine storage/access tests; production frontend build passed; six browser groups cover 320/390/1440px, unchecked consent, save, error/retry without losing input, no-JavaScript contact fallback, and campaign tags through the anonymous homepage redirect. No fonts were changed. Database health advisors clear. Live capture proof follows deployment.
