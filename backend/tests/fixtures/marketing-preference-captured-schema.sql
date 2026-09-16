-- Schema-only fixture from the 2026-09-16 17:19 UTC production catalog capture.
-- Includes the two relevant tables, their column defaults/nullability, owner RLS
-- and account column grants. No account/client rows or provider credentials.
-- Unrelated foreign keys, triggers and indexes are omitted; the test installs
-- the real protected-field trigger from its production migration.
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
CREATE FUNCTION public.uuid_generate_v4() RETURNS uuid LANGUAGE sql AS $$ SELECT gen_random_uuid() $$;
GRANT USAGE ON SCHEMA public,auth TO anon,authenticated,service_role;
CREATE TABLE public.beauticians (
  "id" uuid DEFAULT uuid_generate_v4() NOT NULL,
  "auth_id" uuid NOT NULL,
  "first_name" text NOT NULL,
  "last_name" text NOT NULL,
  "business_name" text,
  "email" text NOT NULL,
  "phone" text,
  "avatar_url" text,
  "booking_slug" text,
  "timezone" text DEFAULT 'Europe/London'::text,
  "currency" text DEFAULT 'GBP'::text,
  "locale" text DEFAULT 'en-GB'::text,
  "working_hours" jsonb DEFAULT '{"fri": {"end": "17:00", "start": "09:00"}, "mon": {"end": "17:00", "start": "09:00"}, "sat": null, "sun": null, "thu": {"end": "17:00", "start": "09:00"}, "tue": {"end": "17:00", "start": "09:00"}, "wed": {"end": "17:00", "start": "09:00"}}'::jsonb,
  "tone_model" jsonb DEFAULT '{}'::jsonb,
  "confidence_threshold" numeric(3,2) DEFAULT 0.90,
  "auto_reply_enabled" boolean DEFAULT true,
  "stripe_account_id" text,
  "stripe_onboarding_complete" boolean DEFAULT false,
  "subscription_status" text DEFAULT 'trial'::text,
  "trial_ends_at" timestamp with time zone,
  "brand_color" text DEFAULT '#C4A882'::text,
  "brand_font" text DEFAULT 'DM Sans'::text,
  "logo_url" text,
  "whatsapp_phone_id" text,
  "whatsapp_token" text,
  "instagram_page_id" text,
  "instagram_page_token" text,
  "google_place_id" text,
  "onboarding_completed_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now(),
  "updated_at" timestamp with time zone DEFAULT now(),
  "stripe_customer_id" text,
  "subscription_plan" text DEFAULT 'free'::text,
  "subscription_stripe_id" text,
  "subscription_current_period_end" timestamp with time zone,
  "tagline" text,
  "address" text,
  "social_links" jsonb DEFAULT '{}'::jsonb,
  "google_calendar_connected" boolean DEFAULT false,
  "google_calendar_tokens" jsonb,
  "google_calendar_id" text DEFAULT 'primary'::text,
  "xero_connected" boolean DEFAULT false,
  "xero_tokens" jsonb,
  "xero_tenant_id" text,
  "quickbooks_connected" boolean DEFAULT false,
  "quickbooks_tokens" jsonb,
  "quickbooks_realm_id" text,
  "onboarded" boolean DEFAULT false,
  "google_review_link" text,
  "whatsapp_display_name" text,
  "whatsapp_registered_at" timestamp with time zone,
  "whatsapp_pending_phone" text,
  "sms_originator" character varying(20) DEFAULT 'Florrie'::character varying,
  "sms_enabled" boolean DEFAULT false,
  "business_type" text DEFAULT 'sole_trader'::text,
  "vat_registered" boolean DEFAULT false,
  "vat_number" text,
  "instagram_dm_mode" text DEFAULT 'ai'::text,
  "instagram_redirect_message" text,
  "instagram_redirect_sent_at" timestamp with time zone,
  "credit_priority_rules" jsonb DEFAULT '{}'::jsonb,
  "booking_policy" jsonb DEFAULT '{"deposit_type": "fixed", "deposit_percent": 25, "deposit_required": false, "min_booking_hours": 0, "deposit_amount_cents": 1000, "rebook_charge_if_late": true, "payment_buffer_enabled": false, "payment_buffer_minutes": 10, "cancellation_notice_hours": 48, "late_cancel_charge_percent": 100}'::jsonb,
  "calendar_settings" jsonb DEFAULT '{"two_way_sync": false, "push_bookings": true, "block_personal": false, "buffer_minutes": 10}'::jsonb,
  "payment_settings" jsonb DEFAULT '{"no_show_fee": false, "deposit_amount": "£10", "require_deposit": false, "accepted_methods": ["cash"]}'::jsonb,
  "instagram_page_name" text,
  "patch_test_expiry_months" integer DEFAULT 6 NOT NULL,
  "patch_test_auto_remind" boolean DEFAULT true NOT NULL,
  "patch_test_remind_days_before" integer DEFAULT 7 NOT NULL,
  "patch_test_block_booking" boolean DEFAULT false NOT NULL,
  "whatsapp_pin" text,
  "whatsapp_retry_at" timestamp with time zone,
  "whatsapp_retry_reason" text,
  "whatsapp_retry_attempts" integer DEFAULT 0 NOT NULL,
  "whatsapp_pending_activation" boolean DEFAULT false NOT NULL,
  "whatsapp_phone" text,
  "whatsapp_connected" boolean DEFAULT false NOT NULL,
  "whatsapp_retry_exhausted" boolean DEFAULT false NOT NULL,
  "client_reminder_prefs" jsonb DEFAULT '{"channel": "whatsapp"}'::jsonb,
  "wa_provider" text DEFAULT 'meta'::text,
  "twilio_wa_sender" text,
  "autonomy" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "ical_token" text,
  "voice_profile" jsonb,
  "voice_profile_updated_at" timestamp with time zone,
  "patch_test_duration_minutes" integer DEFAULT 10,
  "patch_test_price_cents" integer DEFAULT 0,
  "instagram_account_ids" text[],
  "instagram_token_expires_at" timestamp with time zone,
  "notification_prefs" jsonb DEFAULT '{"new_review": {"sms": false, "push": true, "email": true}, "reminder_1h": {"sms": false, "push": true, "email": false}, "reminder_24h": {"sms": false, "push": true, "email": true}, "ai_escalation": {"sms": false, "push": true, "email": true}, "weekly_digest": {"sms": false, "push": false, "email": true}, "booking_pending": {"sms": false, "push": true, "email": true}, "payment_received": {"sms": false, "push": true, "email": true}, "booking_cancelled": {"sms": false, "push": true, "email": true}, "booking_confirmed": {"sms": false, "push": true, "email": true}}'::jsonb,
  "payment_failed_at" timestamp with time zone,
  "instagram_connected_at" timestamp with time zone
);
GRANT ALL ON public.beauticians TO service_role;
ALTER TABLE public.beauticians ADD PRIMARY KEY (id);
ALTER TABLE public.beauticians ADD UNIQUE (auth_id);
ALTER TABLE public.beauticians ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON public.beauticians TO authenticated;
GRANT UPDATE ("first_name") ON public.beauticians TO authenticated;
GRANT UPDATE ("last_name") ON public.beauticians TO authenticated;
GRANT UPDATE ("business_name") ON public.beauticians TO authenticated;
GRANT UPDATE ("phone") ON public.beauticians TO authenticated;
GRANT UPDATE ("avatar_url") ON public.beauticians TO authenticated;
GRANT UPDATE ("booking_slug") ON public.beauticians TO authenticated;
GRANT UPDATE ("timezone") ON public.beauticians TO authenticated;
GRANT UPDATE ("currency") ON public.beauticians TO authenticated;
GRANT UPDATE ("locale") ON public.beauticians TO authenticated;
GRANT UPDATE ("working_hours") ON public.beauticians TO authenticated;
GRANT UPDATE ("tone_model") ON public.beauticians TO authenticated;
GRANT UPDATE ("confidence_threshold") ON public.beauticians TO authenticated;
GRANT UPDATE ("auto_reply_enabled") ON public.beauticians TO authenticated;
GRANT UPDATE ("brand_color") ON public.beauticians TO authenticated;
GRANT UPDATE ("brand_font") ON public.beauticians TO authenticated;
GRANT UPDATE ("logo_url") ON public.beauticians TO authenticated;
GRANT UPDATE ("google_place_id") ON public.beauticians TO authenticated;
GRANT UPDATE ("onboarding_completed_at") ON public.beauticians TO authenticated;
GRANT UPDATE ("tagline") ON public.beauticians TO authenticated;
GRANT UPDATE ("address") ON public.beauticians TO authenticated;
GRANT UPDATE ("social_links") ON public.beauticians TO authenticated;
GRANT UPDATE ("google_review_link") ON public.beauticians TO authenticated;
GRANT UPDATE ("business_type") ON public.beauticians TO authenticated;
GRANT UPDATE ("vat_registered") ON public.beauticians TO authenticated;
GRANT UPDATE ("vat_number") ON public.beauticians TO authenticated;
GRANT UPDATE ("instagram_dm_mode") ON public.beauticians TO authenticated;
GRANT UPDATE ("booking_policy") ON public.beauticians TO authenticated;
GRANT UPDATE ("calendar_settings") ON public.beauticians TO authenticated;
GRANT UPDATE ("payment_settings") ON public.beauticians TO authenticated;
GRANT UPDATE ("patch_test_expiry_months") ON public.beauticians TO authenticated;
GRANT UPDATE ("patch_test_auto_remind") ON public.beauticians TO authenticated;
GRANT UPDATE ("patch_test_remind_days_before") ON public.beauticians TO authenticated;
GRANT UPDATE ("patch_test_block_booking") ON public.beauticians TO authenticated;
GRANT UPDATE ("client_reminder_prefs") ON public.beauticians TO authenticated;
GRANT UPDATE ("autonomy") ON public.beauticians TO authenticated;
GRANT UPDATE ("patch_test_duration_minutes") ON public.beauticians TO authenticated;
GRANT UPDATE ("patch_test_price_cents") ON public.beauticians TO authenticated;
GRANT UPDATE ("notification_prefs") ON public.beauticians TO authenticated;
CREATE TABLE public.email_sends (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "beautician_id" uuid NOT NULL,
  "email_key" text,
  "sequence" text,
  "subject" text,
  "send_at" timestamp with time zone,
  "status" text DEFAULT 'pending'::text,
  "context" jsonb,
  "sent_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now()
);
GRANT ALL ON public.email_sends TO service_role;
CREATE POLICY "beautician_own_data" ON public.beauticians FOR ALL TO PUBLIC USING ((auth_id = auth.uid()));
CREATE POLICY "beauticians_select_own" ON public.beauticians FOR SELECT TO PUBLIC USING ((auth_id = auth.uid()));
CREATE POLICY "beauticians_update_own" ON public.beauticians FOR UPDATE TO PUBLIC USING ((auth_id = auth.uid()));
CREATE FUNCTION public.update_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at=now(); RETURN NEW; END $$;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON public.beauticians FOR EACH ROW EXECUTE FUNCTION public.update_updated_at();
