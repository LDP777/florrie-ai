-- Migration: Add retention policy and index for stripe_events table
-- Purpose: Optimize cleanup queries and document 90-day retention policy

-- Add index on created_at for efficient cleanup queries
CREATE INDEX IF NOT EXISTS idx_stripe_events_created_at ON stripe_events(created_at DESC);

-- Add table comment documenting the retention policy
COMMENT ON TABLE stripe_events IS 'Stores Stripe webhook events for idempotency and audit logging. Retention policy: events older than 90 days are automatically cleaned up via POST /api/stripe/cleanup-events (cron job).';
