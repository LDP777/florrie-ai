-- Waitlist table for landing page sign-ups
-- Run this once in Supabase SQL editor: https://app.supabase.com

CREATE TABLE IF NOT EXISTS public.waitlist (
  id          uuid        DEFAULT gen_random_uuid() PRIMARY KEY,
  email       text        UNIQUE NOT NULL,
  source      text        DEFAULT 'landing',
  created_at  timestamptz DEFAULT now()
);

-- Enable RLS so the anon key can insert but not read other rows
ALTER TABLE public.waitlist ENABLE ROW LEVEL SECURITY;

-- Allow anyone (anon or authenticated) to join the waitlist
CREATE POLICY "anyone can join waitlist"
  ON public.waitlist
  FOR INSERT
  TO anon, authenticated
  WITH CHECK (true);

-- Only service role can read the full list (for admin/exports)
-- No SELECT policy for anon = anon key cannot enumerate emails
