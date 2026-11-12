-- =============================================================================
-- BRT GST RETURNS & RENT TRACKER - SUPABASE LIGHTWEIGHT SETUP SCRIPT
-- =============================================================================
-- Run this in your Supabase SQL Editor.
-- NOTE: You DO NOT need to paste massive data inserts here!
-- As soon as this table is created, the application will automatically seed
-- all 148 clients and filings from initial-data.js directly via Supabase API!
-- =============================================================================

-- 1. Create the unified state table
CREATE TABLE IF NOT EXISTS public.brt_app_state (
    id TEXT PRIMARY KEY DEFAULT 'live',
    data JSONB NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 2. Enable Row Level Security (RLS)
ALTER TABLE public.brt_app_state ENABLE ROW LEVEL SECURITY;

-- 3. Allow anonymous access via public anon key
DROP POLICY IF EXISTS "Allow public all brt_app_state" ON public.brt_app_state;
CREATE POLICY "Allow public all brt_app_state"
ON public.brt_app_state
FOR ALL
TO anon, authenticated
USING (true)
WITH CHECK (true);

-- 4. Enable Supabase Realtime broadcast for instant live sync across devices
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'brt_app_state'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.brt_app_state;
  END IF;
END $$;
