-- ==============================================================
-- ClientLedger Pro - Supabase PostgreSQL Database Setup
-- 
-- HOW TO RUN:
-- 1. Go to your Supabase project dashboard (https://supabase.com/dashboard)
-- 2. Click on "SQL Editor" in the left sidebar
-- 3. Click "New Query", paste this entire script, and click "Run" (green button)
-- ==============================================================

-- 1. Create the main data storage table
CREATE TABLE IF NOT EXISTS public.clientledger_data (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- 2. Enable Row Level Security (RLS)
ALTER TABLE public.clientledger_data ENABLE ROW LEVEL SECURITY;

-- 3. Allow anonymous access through public anon key
DROP POLICY IF EXISTS "Allow anon all" ON public.clientledger_data;
CREATE POLICY "Allow anon all"
ON public.clientledger_data
FOR ALL
TO anon, authenticated
USING (true)
WITH CHECK (true);

-- 4. Enable Supabase Realtime broadcast for instant live sync across devices
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.clientledger_data;
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
