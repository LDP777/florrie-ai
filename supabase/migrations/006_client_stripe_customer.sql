-- Florrie.ai — Migration 006: Add stripe_customer_id to clients for saved payment methods
-- Created: 2026-03-27
-- Purpose: Enable returning clients to pay deposits faster with saved cards

ALTER TABLE clients ADD COLUMN IF NOT EXISTS stripe_customer_id text;

-- Index for fast lookup when creating Stripe Checkout sessions
CREATE INDEX IF NOT EXISTS idx_clients_stripe_customer ON clients (stripe_customer_id) WHERE stripe_customer_id IS NOT NULL;
