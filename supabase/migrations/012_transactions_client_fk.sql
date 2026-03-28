-- Migration 012: Add client_id foreign key to transactions
-- Transactions can be linked to a specific client when payment is for a client's appointment/service.
-- This allows proper tracking of per-client revenue and payment history.

-- ═══════════════════════════════════════════════
-- Add client_id column to transactions
-- ═══════════════════════════════════════════════
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS client_id UUID REFERENCES clients(id) ON DELETE SET NULL;

-- ═══════════════════════════════════════════════
-- Index for faster client payment queries
-- ═══════════════════════════════════════════════
CREATE INDEX IF NOT EXISTS idx_transactions_client ON transactions(client_id);
CREATE INDEX IF NOT EXISTS idx_transactions_client_beautician ON transactions(client_id, beautician_id);
