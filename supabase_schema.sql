-- ==============================================================
-- Rahul 2.0 (ClientLedger Pro + GST Returns & Rent Tracker)
-- Complete Supabase PostgreSQL Database Setup
-- ==============================================================
-- HOW TO RUN:
-- 1. Go to your Supabase project dashboard (https://supabase.com/dashboard)
-- 2. Click on "SQL Editor" in the left sidebar (icon with >_)
-- 3. Click "New Query", paste this entire script, and click "Run" (green button)
--
-- NOTE: This script is fast, lightweight (< 20 KB), and creates all required
-- tables and views cleanly without any errors!
-- All 148 clients and 1,468 filing records will be automatically synced
-- directly into these separate tables by the application upon connecting.
-- ==============================================================

-- ==============================================================
-- PART 1: CLIENTLEDGER PRO (Billing & Expenses)
-- ==============================================================

-- 1. Create the main data storage table for ClientLedger Pro
CREATE TABLE IF NOT EXISTS public.clientledger_data (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable Row Level Security (RLS)
ALTER TABLE public.clientledger_data ENABLE ROW LEVEL SECURITY;

-- Allow anonymous access through public anon key
DROP POLICY IF EXISTS "Allow anon all" ON public.clientledger_data;
CREATE POLICY "Allow anon all"
ON public.clientledger_data
FOR ALL
TO anon, authenticated
USING (true)
WITH CHECK (true);

-- Enable Supabase Realtime broadcast for instant live sync across devices
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.clientledger_data;
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

-- Insert starter record if table is brand new
INSERT INTO public.clientledger_data (id, data)
VALUES ('main_store', '{"clients":[],"settings":{"currency":"₹","businessName":""}}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- ClientLedger Pro Views
-- Dropping existing views first prevents PostgreSQL error 42P16 (cannot change name of view column)
DROP VIEW IF EXISTS public.v_clients CASCADE;
CREATE VIEW public.v_clients AS
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
    COALESCE((c->>'incomeTaxFee')::numeric, 0) AS income_tax_fee,
    c->>'incomeTaxNote' AS income_tax_note,
    COALESCE((c->>'extraFee')::numeric, 0) AS extra_fee,
    c->>'extraFeeNote' AS extra_fee_note,
    c->>'startMonth' AS start_month,
    c->>'status' AS status,
    c->>'notes' AS notes,
    jsonb_array_length(COALESCE(c->'payments', '[]'::jsonb)) AS total_payments_count
FROM public.clientledger_data,
     jsonb_array_elements(COALESCE(data->'clients', '[]'::jsonb)) AS c
WHERE id = 'main_store';

DROP VIEW IF EXISTS public.v_payments CASCADE;
CREATE VIEW public.v_payments AS
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

DROP VIEW IF EXISTS public.v_business_profile CASCADE;
CREATE VIEW public.v_business_profile AS
SELECT 
    data->'settings'->>'businessName' AS business_name,
    data->'settings'->>'businessAddress' AS business_address,
    data->'settings'->>'businessPhone' AS business_phone,
    data->'settings'->>'businessEmail' AS business_email,
    data->'settings'->>'currency' AS currency,
    updated_at AS last_synced_at
FROM public.clientledger_data
WHERE id = 'main_store';

DROP VIEW IF EXISTS public.v_expenses CASCADE;
CREATE VIEW public.v_expenses AS
SELECT 
    e->>'id' AS expense_id,
    e->>'date' AS expense_date,
    e->>'category' AS main_category,
    e->>'subcategory' AS subcategory,
    e->>'payee' AS payee,
    e->>'employeeRole' AS employee_role,
    e->>'salaryMonth' AS salary_month,
    e->>'billNumber' AS bill_number,
    COALESCE((e->>'amount')::numeric, 0) AS amount,
    e->>'method' AS payment_method,
    e->>'reference' AS reference,
    e->>'notes' AS notes,
    e->>'createdAt' AS created_at
FROM public.clientledger_data,
     jsonb_array_elements(COALESCE(data->'expenses', '[]'::jsonb)) AS e
WHERE id = 'main_store';


-- ==============================================================
-- PART 2: GST RETURNS & RENT TRACKER (GSTR) - UNIFIED CACHE
-- ==============================================================

CREATE TABLE IF NOT EXISTS public.brt_app_state (
    id TEXT PRIMARY KEY DEFAULT 'live',
    data JSONB NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.brt_app_state ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow anon all brt_app_state" ON public.brt_app_state;
CREATE POLICY "Allow anon all brt_app_state"
ON public.brt_app_state
FOR ALL
TO anon, authenticated
USING (true)
WITH CHECK (true);


-- ==============================================================
-- PART 3: GST MONTHLY (REGULAR 3B) SEPARATE TABLES
-- ==============================================================

-- 1. Monthly Master Clients (63 Registered Monthly Shops)
CREATE TABLE IF NOT EXISTS public.gst_monthly_clients (
    id TEXT PRIMARY KEY,
    sno INT,
    name TEXT NOT NULL,
    user_name TEXT,
    gstin TEXT,
    default_rent TEXT DEFAULT 'Rent',
    rent_amount NUMERIC,
    taxable_amount NUMERIC,
    remarks TEXT,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.gst_monthly_clients ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow anon all gst_monthly_clients" ON public.gst_monthly_clients;
CREATE POLICY "Allow anon all gst_monthly_clients" ON public.gst_monthly_clients FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- 2. Monthly Filings (756 Monthly GSTR-1 & 3B Records)
CREATE TABLE IF NOT EXISTS public.gst_monthly_filings (
    id TEXT PRIMARY KEY,
    month_name TEXT NOT NULL,
    client_id TEXT NOT NULL,
    client_name TEXT NOT NULL,
    rent TEXT,
    rent_amount NUMERIC,
    suggested_rent_amount NUMERIC,
    taxable_amount NUMERIC,
    gstr1 TEXT DEFAULT 'Pending',
    gstr1_arn TEXT,
    gstr1_date TEXT,
    gstr3b TEXT DEFAULT 'Pending',
    gstr3b_arn TEXT,
    gstr3b_date TEXT,
    remarks TEXT,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_monthly_filings_month ON public.gst_monthly_filings (month_name);
CREATE INDEX IF NOT EXISTS idx_monthly_filings_client ON public.gst_monthly_filings (client_id);

ALTER TABLE public.gst_monthly_filings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow anon all gst_monthly_filings" ON public.gst_monthly_filings;
CREATE POLICY "Allow anon all gst_monthly_filings" ON public.gst_monthly_filings FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);


-- ==============================================================
-- PART 4: GST QRMP (QUARTERLY RETURN MONTHLY PAYMENT) SEPARATE TABLES
-- ==============================================================

-- 1. QRMP Master Clients (62 QRMP Companies)
CREATE TABLE IF NOT EXISTS public.gst_qrmp_clients (
    id TEXT PRIMARY KEY,
    sno INT,
    name TEXT NOT NULL,
    user_name TEXT,
    gstin TEXT,
    default_rent TEXT DEFAULT 'Rent',
    rent_amount NUMERIC,
    taxable_amount NUMERIC,
    remarks TEXT,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.gst_qrmp_clients ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow anon all gst_qrmp_clients" ON public.gst_qrmp_clients;
CREATE POLICY "Allow anon all gst_qrmp_clients" ON public.gst_qrmp_clients FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- 2. QRMP Filings (620 Quarterly IFF & 3B Records)
CREATE TABLE IF NOT EXISTS public.gst_qrmp_filings (
    id TEXT PRIMARY KEY,
    quarter_name TEXT NOT NULL,
    client_id TEXT NOT NULL,
    client_name TEXT NOT NULL,
    rent TEXT,
    rent_amount NUMERIC,
    m1_gstr1 TEXT DEFAULT 'Pending',
    m1_gstr1_arn TEXT,
    m1_gstr1_date TEXT,
    m2_gstr1 TEXT DEFAULT 'Pending',
    m2_gstr1_arn TEXT,
    m2_gstr1_date TEXT,
    m3_gstr1 TEXT DEFAULT 'Pending',
    m3_gstr1_arn TEXT,
    m3_gstr1_date TEXT,
    gstr3b TEXT DEFAULT 'Pending',
    gstr3b_arn TEXT,
    gstr3b_date TEXT,
    taxable_amount NUMERIC,
    remarks TEXT,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_qrmp_filings_quarter ON public.gst_qrmp_filings (quarter_name);
CREATE INDEX IF NOT EXISTS idx_qrmp_filings_client ON public.gst_qrmp_filings (client_id);

ALTER TABLE public.gst_qrmp_filings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow anon all gst_qrmp_filings" ON public.gst_qrmp_filings;
CREATE POLICY "Allow anon all gst_qrmp_filings" ON public.gst_qrmp_filings FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);


-- ==============================================================
-- PART 5: GST COMPOSITION SCHEME (CMP-08 & GSTR-4) SEPARATE TABLES
-- ==============================================================

-- 1. Composition Master Clients (23 Composition Dealers)
CREATE TABLE IF NOT EXISTS public.gst_composition_clients (
    id TEXT PRIMARY KEY,
    sno INT,
    name TEXT NOT NULL,
    user_name TEXT,
    gstin TEXT,
    category TEXT DEFAULT 'Trader',
    tax_rate TEXT DEFAULT '1%',
    default_rent TEXT DEFAULT 'Rent',
    rent_amount NUMERIC,
    remarks TEXT,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.gst_composition_clients ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow anon all gst_composition_clients" ON public.gst_composition_clients;
CREATE POLICY "Allow anon all gst_composition_clients" ON public.gst_composition_clients FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

-- 2. Composition Filings (92 CMP-08 Quarterly & GSTR-4 Annual Records)
CREATE TABLE IF NOT EXISTS public.gst_composition_filings (
    id TEXT PRIMARY KEY,
    quarter_name TEXT NOT NULL,
    client_id TEXT NOT NULL,
    client_name TEXT NOT NULL,
    rent TEXT,
    rent_amount NUMERIC,
    user_name TEXT,
    gstin TEXT,
    category TEXT DEFAULT 'Trader',
    tax_rate TEXT DEFAULT '1%',
    cmp08 TEXT DEFAULT 'Pending',
    cmp08_arn TEXT,
    cmp08_date TEXT,
    gstr4 TEXT DEFAULT 'Pending',
    gstr4_arn TEXT,
    gstr4_date TEXT,
    taxable_turnover NUMERIC,
    tax_amount NUMERIC,
    remarks TEXT,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_composition_filings_quarter ON public.gst_composition_filings (quarter_name);
CREATE INDEX IF NOT EXISTS idx_composition_filings_client ON public.gst_composition_filings (client_id);

ALTER TABLE public.gst_composition_filings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow anon all gst_composition_filings" ON public.gst_composition_filings;
CREATE POLICY "Allow anon all gst_composition_filings" ON public.gst_composition_filings FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);


-- ==============================================================
-- PART 6: GST PERIOD CONFIG & MASTER LISTS
-- ==============================================================

CREATE TABLE IF NOT EXISTS public.gst_period_config (
    id TEXT PRIMARY KEY DEFAULT 'config',
    active_month TEXT NOT NULL,
    entered_january BOOLEAN NOT NULL DEFAULT false,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.gst_period_config ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow anon all gst_period_config" ON public.gst_period_config;
CREATE POLICY "Allow anon all gst_period_config" ON public.gst_period_config FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

INSERT INTO public.gst_period_config (id, active_month, entered_january, updated_at)
VALUES ('config', 'NOV 2026', false, now())
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.gst_months (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    order_idx INT NOT NULL
);

ALTER TABLE public.gst_months ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow anon all gst_months" ON public.gst_months;
CREATE POLICY "Allow anon all gst_months" ON public.gst_months FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

INSERT INTO public.gst_months (id, name, order_idx) VALUES
('APR 2026', 'APR 2026', 0),
('MAY 2026', 'MAY 2026', 1),
('JUN 2026', 'JUN 2026', 2),
('JUL 2026', 'JUL 2026', 3),
('AUG 2026', 'AUG 2026', 4),
('SEP 2026', 'SEP 2026', 5),
('OCT 2026', 'OCT 2026', 6),
('NOV 2026', 'NOV 2026', 7),
('DEC 2026', 'DEC 2026', 8),
('JAN 2027', 'JAN 2027', 9),
('FEB 2027', 'FEB 2027', 10),
('MAR 2027', 'MAR 2027', 11)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.gst_qrmp_quarters (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    quarter TEXT,
    year TEXT,
    is_available BOOLEAN DEFAULT true,
    order_idx INT NOT NULL
);

ALTER TABLE public.gst_qrmp_quarters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow anon all gst_qrmp_quarters" ON public.gst_qrmp_quarters;
CREATE POLICY "Allow anon all gst_qrmp_quarters" ON public.gst_qrmp_quarters FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

INSERT INTO public.gst_qrmp_quarters (id, name, quarter, year, is_available, order_idx) VALUES
('Q1-2026', 'Q1 (JAN - MAR 2026)', '', '', true, 0),
('Q2-2026', 'Q2 (APR - JUN 2026)', '', '', true, 1),
('Q3-2026', 'Q3 (JUL - SEP 2026)', '', '', true, 2),
('Q4-2026', 'Q4 (OCT - DEC 2026)', '', '', false, 3),
('Q1-2027', 'Q1 (JAN - MAR 2027)', '', '', false, 4),
('Q2-2027', 'Q2 (APR - JUN 2027)', '', '', false, 5),
('Q3-2027', 'Q3 (JUL - SEP 2027)', '', '', false, 6),
('Q4-2027', 'Q4 (OCT - DEC 2027)', '', '', false, 7)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.gst_composition_quarters (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    quarter TEXT,
    year TEXT,
    is_available BOOLEAN DEFAULT true,
    order_idx INT NOT NULL
);

ALTER TABLE public.gst_composition_quarters ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow anon all gst_composition_quarters" ON public.gst_composition_quarters;
CREATE POLICY "Allow anon all gst_composition_quarters" ON public.gst_composition_quarters FOR ALL TO anon, authenticated USING (true) WITH CHECK (true);

INSERT INTO public.gst_composition_quarters (id, name, quarter, year, is_available, order_idx) VALUES
('Q1-2026', 'Q1 (JAN - MAR 2026)', '', '', true, 0),
('Q2-2026', 'Q2 (APR - JUN 2026)', '', '', true, 1),
('Q3-2026', 'Q3 (JUL - SEP 2026)', '', '', true, 2),
('Q4-2026', 'Q4 (OCT - DEC 2026)', '', '', false, 3)
ON CONFLICT (id) DO NOTHING;


-- ==============================================================
-- PART 7: CONVENIENT SUMMARY VIEWS FOR SUPABASE TABLE EDITOR
-- ==============================================================

-- 1. Monthly Returns View (All shops with monthly filings)
DROP VIEW IF EXISTS public.v_gst_monthly_returns CASCADE;
CREATE VIEW public.v_gst_monthly_returns AS
SELECT 
    f.month_name,
    c.sno,
    f.client_name,
    c.user_name,
    c.gstin,
    f.rent,
    f.rent_amount,
    f.taxable_amount,
    f.gstr1,
    f.gstr1_arn,
    f.gstr1_date,
    f.gstr3b,
    f.gstr3b_arn,
    f.gstr3b_date,
    f.remarks
FROM public.gst_monthly_filings f
LEFT JOIN public.gst_monthly_clients c ON f.client_id = c.id
ORDER BY f.month_name, c.sno;

-- 2. QRMP Returns View (All QRMP companies with quarterly filings)
DROP VIEW IF EXISTS public.v_gst_qrmp_returns CASCADE;
CREATE VIEW public.v_gst_qrmp_returns AS
SELECT 
    f.quarter_name,
    c.sno,
    f.client_name,
    c.user_name,
    c.gstin,
    f.rent,
    f.rent_amount,
    f.m1_gstr1,
    f.m1_gstr1_arn,
    f.m1_gstr1_date,
    f.m2_gstr1,
    f.m2_gstr1_arn,
    f.m2_gstr1_date,
    f.m3_gstr1,
    f.m3_gstr1_arn,
    f.m3_gstr1_date,
    f.gstr3b,
    f.gstr3b_arn,
    f.gstr3b_date,
    f.taxable_amount,
    f.remarks
FROM public.gst_qrmp_filings f
LEFT JOIN public.gst_qrmp_clients c ON f.client_id = c.id
ORDER BY f.quarter_name, c.sno;

-- 3. Composition Returns View (All Composition dealers with quarterly CMP-08 filings)
DROP VIEW IF EXISTS public.v_gst_composition_returns CASCADE;
CREATE VIEW public.v_gst_composition_returns AS
SELECT 
    f.quarter_name,
    c.sno,
    f.client_name,
    f.user_name,
    f.gstin,
    f.category,
    f.tax_rate,
    f.rent,
    f.rent_amount,
    f.cmp08,
    f.cmp08_arn,
    f.cmp08_date,
    f.gstr4,
    f.gstr4_arn,
    f.gstr4_date,
    f.taxable_turnover,
    f.tax_amount,
    f.remarks
FROM public.gst_composition_filings f
LEFT JOIN public.gst_composition_clients c ON f.client_id = c.id
ORDER BY f.quarter_name, c.sno;

-- Backward compatibility views
DROP VIEW IF EXISTS public.monthly_clients CASCADE;
CREATE VIEW public.monthly_clients AS SELECT * FROM public.gst_monthly_clients;

DROP VIEW IF EXISTS public.monthly_filings CASCADE;
CREATE VIEW public.monthly_filings AS SELECT * FROM public.gst_monthly_filings;

DROP VIEW IF EXISTS public.qrmp_clients CASCADE;
CREATE VIEW public.qrmp_clients AS SELECT * FROM public.gst_qrmp_clients;

DROP VIEW IF EXISTS public.qrmp_filings CASCADE;
CREATE VIEW public.qrmp_filings AS SELECT * FROM public.gst_qrmp_filings;

DROP VIEW IF EXISTS public.composition_clients CASCADE;
CREATE VIEW public.composition_clients AS SELECT * FROM public.gst_composition_clients;

DROP VIEW IF EXISTS public.composition_filings CASCADE;
CREATE VIEW public.composition_filings AS SELECT * FROM public.gst_composition_filings;

-- ==============================================================
-- PART 8: SUPABASE REALTIME PUBLICATION SETUP
-- ==============================================================

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.brt_app_state;
    ALTER PUBLICATION supabase_realtime ADD TABLE public.gst_monthly_clients;
    ALTER PUBLICATION supabase_realtime ADD TABLE public.gst_monthly_filings;
    ALTER PUBLICATION supabase_realtime ADD TABLE public.gst_qrmp_clients;
    ALTER PUBLICATION supabase_realtime ADD TABLE public.gst_qrmp_filings;
    ALTER PUBLICATION supabase_realtime ADD TABLE public.gst_composition_clients;
    ALTER PUBLICATION supabase_realtime ADD TABLE public.gst_composition_filings;
    ALTER PUBLICATION supabase_realtime ADD TABLE public.gst_period_config;
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;
