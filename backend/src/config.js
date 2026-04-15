/**
 * Shared configuration and clients.
 * This module exports global dependencies (Supabase clients, etc.)
 * and is imported by routes, services, and middleware — NOT by index.js.
 * This breaks the circular dependency cycle: index.js imports routes,
 * but routes import from config.js, not from index.js.
 */
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

// Supabase client (service role for backend operations)
export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Supabase client (anon key for auth-gated operations)
export const supabaseAnon = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);
