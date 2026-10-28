-- ==============================================================
-- ClientLedger Pro - Complete Supabase PostgreSQL Database Setup
-- 
-- HOW TO RUN:
-- 1. Go to your Supabase project dashboard (https://supabase.com/dashboard)
-- 2. Click on "SQL Editor" in the left sidebar (icon with >_)
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

-- 5. Insert starter record if table is brand new
INSERT INTO public.clientledger_data (id, data)
VALUES ('main_store', '{"clients":[],"settings":{"currency":"₹","businessName":"Business Services & Solutions"}}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- ==============================================================
-- OPTIONAL HELPER VIEWS: Browse your data in Supabase Table Editor
-- ==============================================================

-- View 1: Clients List Table
CREATE OR REPLACE VIEW public.v_clients AS
SELECT 
    c->>'id' AS client_id,
    c->>'name' AS client_name,
    c->>'businessName' AS business_name,
    c->>'phone' AS phone,
    c->>'email' AS email,
    COALESCE((c->>'hasGst')::boolean, false) AS has_gst,
    c->>'gstNumber' AS gst_number,
    c->>'billingCycle' AS billing_cycle,
    COALESCE((c->>'fixedMonthlyAmount')::numeric, 0) AS fixed_monthly_fee,
    COALESCE((c->>'fixedYearlyAmount')::numeric, 0) AS fixed_yearly_fee,
    COALESCE((c->>'extraFee')::numeric, 0) AS extra_fee,
    c->>'extraFeeNote' AS extra_fee_note,
    c->>'startMonth' AS start_month,
    c->>'status' AS status,
    c->>'notes' AS notes,
    jsonb_array_length(COALESCE(c->'payments', '[]'::jsonb)) AS total_payments_count
FROM public.clientledger_data,
     jsonb_array_elements(COALESCE(data->'clients', '[]'::jsonb)) AS c
WHERE id = 'main_store';

-- View 2: Payments & Settlements Table
CREATE OR REPLACE VIEW public.v_payments AS
SELECT 
    p->>'id' AS payment_id,
    c->>'id' AS client_id,
    c->>'name' AS client_name,
    c->>'businessName' AS client_business,
    COALESCE((p->>'amount')::numeric, 0) AS amount_paid,
    COALESCE((p->>'discount')::numeric, 0) AS settlement_discount,
    p->>'discountNote' AS discount_note,
    p->>'date' AS payment_date,
    p->>'method' AS payment_method,
    p->>'reference' AS transaction_reference,
    p->>'targetMonth' AS target_month,
    p->>'note' AS note
FROM public.clientledger_data,
     jsonb_array_elements(COALESCE(data->'clients', '[]'::jsonb)) AS c,
     jsonb_array_elements(COALESCE(c->'payments', '[]'::jsonb)) AS p
WHERE id = 'main_store';

-- View 3: Business Profile & Settings Table
CREATE OR REPLACE VIEW public.v_business_profile AS
SELECT 
    data->'settings'->>'businessName' AS business_name,
    data->'settings'->>'businessAddress' AS business_address,
    data->'settings'->>'businessPhone' AS business_phone,
    data->'settings'->>'businessEmail' AS business_email,
    data->'settings'->>'currency' AS currency,
    updated_at AS last_synced_at
FROM public.clientledger_data
WHERE id = 'main_store';
