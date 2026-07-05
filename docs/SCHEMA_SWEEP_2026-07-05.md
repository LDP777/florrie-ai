# Schema-vs-code sweep, 2026-07-05

Method: extracted all 164 insert/upsert sites (70 tables), diffed field lists
against the LIVE information_schema (not the repo migrations, which drift).

## Fixed this pass (code + migration 078)
- auto-complete cron takings: phantom transactions.treatment_id rejected every
  insert (the remaining source of missing Money takings)
- rebook reminder queue: cron read reminder_date/sent, writer wrote client_id/
  message - none existed. Columns added; due-date nudges can fire now
- patch_tests: appointment_id/status/suggested_slot/confirmed_at/auto_booked
  added, test_date made nullable; appointments.treatment_id made nullable so
  patch-test appointments can insert. The whole manage-portal patch flow and
  the new-client pending test row work now
- messages.status phantom in 4 send-log inserts (notify routes + consultation
  SMS log): those thread logs always failed
- voice add_client_note wrote to a nonexistent client_notes table: now appends
  to clients.notes with a date stamp
- whatsapp client creation: phantom clients.source
- reviews POST: review_text -> comment, platform 'website' failed the CHECK
- client tag assignment: phantom beautician_id + wrong key client_tag_id
- retail_products / push_subscriptions / email_sends tables created (Products,
  web push and email sequences wrote to tables that never existed)

## Known-remaining (deliberately not patched blind)
features.js long tail, mostly More-section admin pages flagged half-dead in the
2026-06-21 audit: add_ons (price/category/suggest_with), packages (treatments),
client_memberships (status/starts_at), membership_subscriptions
(subscription_status/next_billing_date), loyalty_config (redemption_rate/
min_points_redeem), loyalty_points (transaction_date), referrals (reward /
referred_client_id / reward_type...), campaigns (content), end_of_day_reports
(summary/revenue/appointments_count), portal_settings (theme etc),
hours_exceptions (details), automation_rules (config/enabled), policies
(category - page already retired). Each needs a per-feature decision (rename
column vs migrate schema) - fix when the page is next touched.
Missing tables left as documented-dead until the features are wanted:
hmrc_submissions (MTD), team_members.
Caveat: the static extractor cannot see JS shorthand keys or spread-built
inserts; MISSING-REQUIRED flags were manually triaged, BAD-COLUMN flags are
reliable.
