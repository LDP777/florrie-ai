# Waitlist welcome flow

Joining the launch list now replaces the form with a cream confirmation card, Florrie’s flower, the submitted email address and a link to the demo. Existing fonts and colours remain. Errors preserve entered details; the confirmation receives keyboard and screen-reader focus; reduced-motion preferences are respected.

A matching HTML and plain-text welcome email is queued in the signup row and sent by the existing scheduler. Signup only waits for database storage. Atomic claims separate workers on both deployments, a stable Resend idempotency key prevents duplicate delivery after an uncertain response, and retries stop before Resend’s 24-hour deduplication window expires. The queue records provider receipt IDs, retries or needs_review; no provider acceptance is described as confirmed inbox delivery. Consent is checked again before sending. Opt-outs, tests and non-consenting rows are excluded.

The email replies to levi@florrie.ai, links to the demo and privacy policy, and includes both a visible unsubscribe link and standard one-click headers. GET unsubscribe remains read-only. Existing unsubscribed addresses are never reactivated by repeated signup.

Migration waitlist_welcome_delivery applied as 20261116162734. The claim function is SECURITY INVOKER with a fixed search path; only service_role may execute. No waitlist security advisor findings. The previous mailing-list export remains private and excludes test records and opt-outs.

Validation: 224 backend files / 4,153 tests passed; production frontend build passed; nine browser groups cover the complete signup, error recovery, no-JavaScript fallback, campaign tags and welcome-email layouts at 320, 390 and 600px. Two pre-existing line-number baselines moved one line after the optional email-header field; no client-consent query behaviour changed. Live signup and inbox proof follows deployment.

Provider reference: https://resend.com/docs/dashboard/emails/idempotency-keys
