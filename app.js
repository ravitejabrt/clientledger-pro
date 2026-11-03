/**
 * ClientLedger Pro - Core Application Logic
 * Recurring Monthly Billing, Custom Monthly Adjustments & Balance Tracking
 */

(function () {
  'use strict';

  // Pre-configured Supabase Credentials (dynamic from config.js or configured via UI)
  const SUPABASE_CONFIG = {
    get url() {
      return (window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.url) ? window.SUPABASE_CONFIG.url.trim() : '';
    },
    get anonKey() {
      return (window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.anonKey) ? window.SUPABASE_CONFIG.anonKey.trim() : '';
    },
  };

  // Flag to ensure initial pull from Supabase completes before any local push can occur
  let hasCompletedInitialSync = false;

  // Default BigRock API URL (optional: paste here or configure via the UI)
  const DEFAULT_BIGROCK_API_URL = ''; // e.g. 'https://yourdomain.com/api.php'

  // State Management
  const state = {
    isAuthenticated: false,
    clients: [],
    settings: {
      currency: '₹',
      businessName: '',
      businessPhone: '',
      businessEmail: '',
      businessAddress: '',
      lastModified: 0,
      dbProvider: 'supabase',
      supabaseUrl: '',
      supabaseKey: '',
      apiUrl: '',
    },
    activeView: 'dashboard',
    activeClientId: null,
    searchQuery: '',
    statusFilter: 'all',
    dashboardFilter: {
      preset: 'all',
      from: '',
      to: '',
    },
  };

  const STORAGE_KEY = 'clientledger_pro_data_v1';
  const SETTINGS_KEY = 'clientledger_pro_settings_v1';
  const AUTH_KEY = 'clientledger_auth_user';

  // Utilities
  function formatCurrency(amount) {
    const num = Number(amount) || 0;
    const formatted = Math.abs(num).toLocaleString('en-IN', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
    return `${state.settings.currency} ${formatted}`;
  }

  function getCurrentYearMonth() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }

  // Returns the previous / last completed month (e.g. if now is 2026-10, returns 2026-09)
  function getLastMonth(referenceDate = new Date()) {
    const d = new Date(referenceDate.getFullYear(), referenceDate.getMonth() - 1, 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    return `${y}-${m}`;
  }

  function getTodayDate() {
    const now = new Date();
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const d = String(now.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  function formatMonthName(yearMonth) {
    if (!yearMonth) return '';
    const [y, m] = yearMonth.split('-').map(Number);
    const date = new Date(y, m - 1, 1);
    return date.toLocaleDateString('en-US', { month: 'short', year: 'numeric' });
  }

  function formatFullMonthName(yearMonth) {
    if (!yearMonth) return '';
    const [y, m] = yearMonth.split('-').map(Number);
    const date = new Date(y, m - 1, 1);
    return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }

  function formatDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString('en-US', { day: '2-digit', month: 'short', year: 'numeric' });
  }

  // Generate sequence of months between startMonth and endMonth inclusive
  function generateMonthList(startMonth, endMonth) {
    const months = [];
    let [curY, curM] = startMonth.split('-').map(Number);
    const [endY, endM] = endMonth.split('-').map(Number);

    while (curY < endY || (curY === endY && curM <= endM)) {
      const ym = `${curY}-${String(curM).padStart(2, '0')}`;
      months.push(ym);
      curM++;
      if (curM > 12) {
        curM = 1;
        curY++;
      }
    }
    return months;
  }

  function compareMonths(a, b) {
    return a.localeCompare(b);
  }

  // ==================== CALCULATION ENGINE ====================
  /**
   * Calculates the full financial ledger for a client:
   * - Month-by-month dues with fixed amount or custom overrides
   * - Applies direct payments and FIFO untargeted payments
   * - Produces balance per month and cumulative balance
   */
  function calculateYearlyClientLedger(client, explicitUpToYear = null) {
    const currentYear = new Date().getFullYear();
    let startYear = currentYear;
    if (client.startYear) {
      startYear = parseInt(String(client.startYear).substring(0, 4), 10) || currentYear;
    } else if (client.startMonth) {
      startYear = parseInt(String(client.startMonth).substring(0, 4), 10) || currentYear;
    }

    let maxYear = Math.max(startYear, currentYear);
    if (explicitUpToYear) {
      const parsed = parseInt(String(explicitUpToYear).substring(0, 4), 10);
      if (parsed && parsed > maxYear) maxYear = parsed;
    }

    if (client.monthOverrides) {
      Object.keys(client.monthOverrides).forEach(k => {
        const y = parseInt(String(k).substring(0, 4), 10);
        if (y && y > maxYear) maxYear = y;
      });
    }

    if (client.payments) {
      client.payments.forEach(p => {
        if (p.targetMonth) {
          const y = parseInt(String(p.targetMonth).substring(0, 4), 10);
          if (y && y > maxYear) maxYear = y;
        }
      });
    }

    const years = [];
    for (let y = startYear; y <= maxYear; y++) {
      years.push(String(y));
    }

    const payments = Array.isArray(client.payments) ? [...client.payments] : [];
    payments.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    const directPaidByYear = {};
    let generalPaymentPool = 0;

    payments.forEach(p => {
      const amt = Number(p.amount) || 0;
      const discount = Number(p.discount) || 0;
      const effectiveCredit = amt + discount;
      if (p.targetMonth && p.targetMonth.trim()) {
        const yStr = String(p.targetMonth).substring(0, 4);
        directPaidByYear[yStr] = (directPaidByYear[yStr] || 0) + effectiveCredit;
      } else {
        generalPaymentPool += effectiveCredit;
      }
    });

    let runningGeneralPool = generalPaymentPool;
    const yearlyBreakdown = [];
    let totalBilled = 0;
    let totalAllocatedPaid = 0;

    years.forEach(y => {
      const override = client.monthOverrides && (client.monthOverrides[y] || client.monthOverrides[`${y}-01`]);
      let isOverridden = override && override.amount !== undefined && override.amount !== null;
      let billed = 0;
      let overrideNote = '';

      const isStartYear = (y === (client.startYear || (client.startMonth ? client.startMonth.split('-')[0] : '')));
      const extraFeeAmt = (isStartYear && Number(client.extraFee || 0) > 0) ? Number(client.extraFee) : 0;
      const itFeeAmt = (isStartYear && Number(client.incomeTaxFee || 0) > 0) ? Number(client.incomeTaxFee) : 0;
      const combinedFees = extraFeeAmt + itFeeAmt;

      if (isOverridden) {
        billed = Number(override.amount);
        overrideNote = override.note || '';
      } else {
        billed = Number(client.fixedYearlyAmount || client.fixedMonthlyAmount || 0) + combinedFees;
        if (combinedFees > 0) {
          isOverridden = true;
          const feeParts = [];
          if (itFeeAmt > 0) {
            feeParts.push(client.incomeTaxNote ? `IT Fee: ${formatCurrency(itFeeAmt)} (${client.incomeTaxNote})` : `IT Fee: ${formatCurrency(itFeeAmt)}`);
          }
          if (extraFeeAmt > 0) {
            feeParts.push(client.extraFeeNote ? `Extra Fee: ${formatCurrency(extraFeeAmt)} (${client.extraFeeNote})` : `Extra Fee: ${formatCurrency(extraFeeAmt)}`);
          }
          overrideNote = `Includes ${feeParts.join(', ')}`;
        }
      }

      totalBilled += billed;

      const directPaid = directPaidByYear[y] || 0;
      const neededAfterDirect = Math.max(0, billed - directPaid);

      let fifoAllocated = 0;
      if (runningGeneralPool > 0 && neededAfterDirect > 0) {
        fifoAllocated = Math.min(runningGeneralPool, neededAfterDirect);
        runningGeneralPool -= fifoAllocated;
      }

      const totalYearPaid = directPaid + fifoAllocated;
      totalAllocatedPaid += totalYearPaid;
      const balance = billed - totalYearPaid;

      let status = 'UNPAID';
      if (balance <= 0) {
        status = totalYearPaid > billed ? 'OVERPAID' : 'PAID';
      } else if (totalYearPaid > 0) {
        status = 'PARTIAL';
      }

      yearlyBreakdown.push({
        month: y,
        monthName: `Year ${y}`,
        fullMonthName: `Year ${y}`,
        billed,
        isOverridden,
        overrideNote,
        defaultFee: Number(client.fixedYearlyAmount || client.fixedMonthlyAmount || 0),
        directPaid,
        fifoAllocated,
        paid: totalYearPaid,
        balance,
        status,
      });
    });

    const standaloneFees = Number(client.extraFee || 0) + Number(client.incomeTaxFee || 0);
    if (years.length === 0 && standaloneFees > 0) {
      totalBilled += standaloneFees;
    }

    const totalPaidAll = payments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
    const totalDiscountAll = payments.reduce((sum, p) => sum + (Number(p.discount) || 0), 0);
    const finalBalance = totalBilled - (totalPaidAll + totalDiscountAll);

    const unpaidYears = yearlyBreakdown.filter(item => item.balance > 0);
    const oldestUnpaid = unpaidYears.length > 0 ? unpaidYears[0].month : null;

    return {
      client,
      months: years,
      monthlyBreakdown: yearlyBreakdown,
      payments,
      totalBilled,
      totalPaid: totalPaidAll,
      totalDiscount: totalDiscountAll,
      finalBalance,
      unallocatedAdvance: runningGeneralPool,
      unpaidMonthsCount: unpaidYears.length,
      oldestUnpaidMonth: oldestUnpaid,
    };
  }

  function calculateClientLedger(client, explicitUpToMonth = null) {
    if (!client) return null;

    if (client.billingCycle === 'yearly') {
      return calculateYearlyClientLedger(client, explicitUpToMonth);
    }

    // Current/present month is NOT billed or allocated; billing applies strictly till last month
    const lastMonth = getLastMonth();
    let maxMonth = lastMonth;
    if (explicitUpToMonth && compareMonths(explicitUpToMonth, lastMonth) < 0) {
      maxMonth = explicitUpToMonth;
    }

    const startMonth = client.startMonth || lastMonth;
    // Current month payment is NOT allocated; allocate only till last month
    // Present month must NEVER be displayed as a pending month
    let months = [];
    if (compareMonths(startMonth, maxMonth) <= 0) {
      months = generateMonthList(startMonth, maxMonth);
    }

    // Prepare payments
    const payments = Array.isArray(client.payments) ? [...client.payments] : [];
    // Sort payments by date ascending
    payments.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    // Step 1: Direct targeted payments per month
    const directPaidByMonth = {};
    let generalPaymentPool = 0;

    payments.forEach(p => {
      const amt = Number(p.amount) || 0;
      const discount = Number(p.discount) || 0;
      const effectiveCredit = amt + discount;
      if (p.targetMonth && p.targetMonth.trim()) {
        directPaidByMonth[p.targetMonth] = (directPaidByMonth[p.targetMonth] || 0) + effectiveCredit;
      } else {
        generalPaymentPool += effectiveCredit;
      }
    });

    // Step 2: Compute monthly items and apply FIFO general payments
    let runningGeneralPool = generalPaymentPool;
    const monthlyBreakdown = [];
    let totalBilled = 0;
    let totalAllocatedPaid = 0;

    months.forEach(m => {
      const override = client.monthOverrides && client.monthOverrides[m];
      let isOverridden = override && override.amount !== undefined && override.amount !== null;
      let billed = 0;
      let overrideNote = '';

      const isStartMonth = (m === (client.startMonth || months[0]));
      const extraFeeAmt = (isStartMonth && Number(client.extraFee || 0) > 0) ? Number(client.extraFee) : 0;
      const itFeeAmt = (isStartMonth && Number(client.incomeTaxFee || 0) > 0) ? Number(client.incomeTaxFee) : 0;
      const combinedFees = extraFeeAmt + itFeeAmt;

      if (isOverridden) {
        billed = Number(override.amount);
        overrideNote = override.note || '';
      } else {
        billed = Number(client.fixedMonthlyAmount || 0) + combinedFees;
        if (combinedFees > 0) {
          isOverridden = true;
          const feeParts = [];
          if (itFeeAmt > 0) {
            feeParts.push(client.incomeTaxNote ? `IT Fee: ${formatCurrency(itFeeAmt)} (${client.incomeTaxNote})` : `IT Fee: ${formatCurrency(itFeeAmt)}`);
          }
          if (extraFeeAmt > 0) {
            feeParts.push(client.extraFeeNote ? `Extra Fee: ${formatCurrency(extraFeeAmt)} (${client.extraFeeNote})` : `Extra Fee: ${formatCurrency(extraFeeAmt)}`);
          }
          overrideNote = `Includes ${feeParts.join(', ')}`;
        }
      }

      totalBilled += billed;

      // Direct payment allocated to this month
      const directPaid = directPaidByMonth[m] || 0;
      const neededAfterDirect = Math.max(0, billed - directPaid);

      // FIFO general pool allocation
      let fifoAllocated = 0;
      if (runningGeneralPool > 0 && neededAfterDirect > 0) {
        fifoAllocated = Math.min(runningGeneralPool, neededAfterDirect);
        runningGeneralPool -= fifoAllocated;
      }

      const totalMonthPaid = directPaid + fifoAllocated;
      totalAllocatedPaid += totalMonthPaid;
      const balance = billed - totalMonthPaid;

      let status = 'UNPAID';
      if (balance <= 0) {
        status = totalMonthPaid > billed ? 'OVERPAID' : 'PAID';
      } else if (totalMonthPaid > 0) {
        status = 'PARTIAL';
      }

      monthlyBreakdown.push({
        month: m,
        monthName: formatMonthName(m),
        fullMonthName: formatFullMonthName(m),
        billed,
        isOverridden,
        overrideNote,
        defaultFee: Number(client.fixedMonthlyAmount || 0),
        directPaid,
        fifoAllocated,
        paid: totalMonthPaid,
        balance, // positive means client still owes from this month
        status, // PAID, PARTIAL, UNPAID, OVERPAID
      });
    });

    const standaloneFees = Number(client.extraFee || 0) + Number(client.incomeTaxFee || 0);
    if (months.length === 0 && standaloneFees > 0) {
      totalBilled += standaloneFees;
    }

    const totalPaidAll = payments.reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
    const totalDiscountAll = payments.reduce((sum, p) => sum + (Number(p.discount) || 0), 0);
    const finalBalance = totalBilled - (totalPaidAll + totalDiscountAll); // > 0: client owes; < 0: advance

    const unpaidMonths = monthlyBreakdown.filter(item => item.balance > 0);
    const oldestUnpaid = unpaidMonths.length > 0 ? unpaidMonths[0].month : null;

    return {
      client,
      months,
      monthlyBreakdown,
      payments,
      totalBilled,
      totalPaid: totalPaidAll,
      totalDiscount: totalDiscountAll,
      finalBalance,
      unallocatedAdvance: runningGeneralPool,
      unpaidMonthsCount: unpaidMonths.length,
      oldestUnpaidMonth: oldestUnpaid,
    };
  }

  // ==================== PERSISTENCE & CLOUD DATABASE ====================
  let cloudSyncAvailable = false;
  let currentDbTab = 'supabase';
  let supabaseClient = null;

  function setDbProviderTab(tab) {
    currentDbTab = tab;
    const btnSupabase = document.getElementById('tab-db-supabase');
    const btnBigrock = document.getElementById('tab-db-bigrock');
    const panelSupabase = document.getElementById('panel-db-supabase');
    const panelBigrock = document.getElementById('panel-db-bigrock');

    if (tab === 'supabase') {
      if (btnSupabase) btnSupabase.className = 'px-4 py-2 text-xs font-bold border-b-2 border-emerald-600 text-emerald-700 transition flex items-center gap-1.5';
      if (btnBigrock) btnBigrock.className = 'px-4 py-2 text-xs font-bold border-b-2 border-transparent text-slate-500 hover:text-slate-800 transition flex items-center gap-1.5';
      if (panelSupabase) panelSupabase.classList.remove('hidden');
      if (panelBigrock) panelBigrock.classList.add('hidden');
    } else {
      if (btnSupabase) btnSupabase.className = 'px-4 py-2 text-xs font-bold border-b-2 border-transparent text-slate-500 hover:text-slate-800 transition flex items-center gap-1.5';
      if (btnBigrock) btnBigrock.className = 'px-4 py-2 text-xs font-bold border-b-2 border-blue-600 text-blue-700 transition flex items-center gap-1.5';
      if (panelSupabase) panelSupabase.classList.add('hidden');
      if (panelBigrock) panelBigrock.classList.remove('hidden');
    }

    const statusBox = document.getElementById('cloud-test-status');
    if (statusBox) statusBox.classList.add('hidden');
  }

  function getSupabaseClient() {
    const url = (state.settings.supabaseUrl || SUPABASE_CONFIG.url || '').trim();
    const key = (state.settings.supabaseKey || SUPABASE_CONFIG.anonKey || '').trim();

    if (!url || !key) return null;

    if (typeof window !== 'undefined' && window.supabase && typeof window.supabase.createClient === 'function') {
      if (!supabaseClient || supabaseClient.__url !== url || supabaseClient.__key !== key) {
        try {
          supabaseClient = window.supabase.createClient(url, key);
          supabaseClient.__url = url;
          supabaseClient.__key = key;
        } catch (e) {
          console.error('Failed to initialize Supabase client:', e);
          return null;
        }
      }
      return supabaseClient;
    }
    return null;
  }

  function getApiEndpoint(action) {
    let base = (state.settings.apiUrl || DEFAULT_BIGROCK_API_URL || '').trim();
    if (!base) {
      base = 'api.php';
    }
    const sep = base.includes('?') ? '&' : '?';
    return `${base}${sep}action=${action}`;
  }

  const SUPABASE_SCHEMA_SQL = `-- Supabase Table Setup for ClientLedger Pro
CREATE TABLE IF NOT EXISTS public.clientledger_data (
    id TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

ALTER TABLE public.clientledger_data ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow anon all" ON public.clientledger_data;
CREATE POLICY "Allow anon all"
ON public.clientledger_data
FOR ALL
TO anon, authenticated
USING (true)
WITH CHECK (true);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE public.clientledger_data;
  END IF;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

INSERT INTO public.clientledger_data (id, data)
VALUES ('main_store', '{"clients":[],"settings":{"currency":"₹","businessName":""}}'::jsonb)
ON CONFLICT (id) DO NOTHING;

-- Helper views for Supabase Table Editor
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
    COALESCE((c->>'incomeTaxFee')::numeric, 0) AS income_tax_fee,
    COALESCE((c->>'extraFee')::numeric, 0) AS extra_fee,
    c->>'startMonth' AS start_month,
    c->>'status' AS status,
    jsonb_array_length(COALESCE(c->'payments', '[]'::jsonb)) AS payments_count
FROM public.clientledger_data,
     jsonb_array_elements(COALESCE(data->'clients', '[]'::jsonb)) AS c
WHERE id = 'main_store';

CREATE OR REPLACE VIEW public.v_payments AS
SELECT 
    p->>'id' AS payment_id,
    c->>'name' AS client_name,
    COALESCE((p->>'amount')::numeric, 0) AS amount_paid,
    COALESCE((p->>'discount')::numeric, 0) AS settlement_discount,
    p->>'discountNote' AS discount_note,
    p->>'date' AS payment_date,
    p->>'method' AS payment_method,
    p->>'reference' AS reference,
    p->>'note' AS note
FROM public.clientledger_data,
     jsonb_array_elements(COALESCE(data->'clients', '[]'::jsonb)) AS c,
     jsonb_array_elements(COALESCE(c->'payments', '[]'::jsonb)) AS p
WHERE id = 'main_store';`;

  function copySupabaseSql() {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(SUPABASE_SCHEMA_SQL).then(() => {
        showToast('Supabase SQL copied to clipboard!');
      }).catch(() => {
        prompt('Copy this SQL script and paste into Supabase SQL Editor:', SUPABASE_SCHEMA_SQL);
      });
    } else {
      prompt('Copy this SQL script and paste into Supabase SQL Editor:', SUPABASE_SCHEMA_SQL);
    }
  }

  function openCloudDatabaseModal() {
    const supUrl = document.getElementById('supabase-url-input');
    const supKey = document.getElementById('supabase-key-input');
    const brUrl = document.getElementById('cloud-api-url-input');
    const statusBox = document.getElementById('cloud-test-status');

    if (supUrl) supUrl.value = state.settings.supabaseUrl || SUPABASE_CONFIG.url || '';
    if (supKey) supKey.value = state.settings.supabaseKey || SUPABASE_CONFIG.anonKey || '';
    if (brUrl) brUrl.value = state.settings.apiUrl || DEFAULT_BIGROCK_API_URL || '';

    if (statusBox) statusBox.classList.add('hidden');

    const provider = state.settings.dbProvider || (state.settings.apiUrl ? 'bigrock' : 'supabase');
    setDbProviderTab(provider);

    openModal('cloudDatabaseModal');
  }

  async function testCloudDbConnection() {
    const statusBox = document.getElementById('cloud-test-status');
    const statusIcon = document.getElementById('cloud-test-icon');
    const statusText = document.getElementById('cloud-test-text');
    const btn = document.getElementById('cloud-test-btn');

    if (btn) btn.disabled = true;

    if (statusBox) {
      statusBox.className = 'p-3 rounded-xl text-xs flex items-center gap-2.5 bg-blue-50 text-blue-700 border border-blue-200';
      statusIcon.innerHTML = '<span class="inline-block animate-spin">⏳</span>';
      statusText.textContent = `Testing connection to ${currentDbTab === 'supabase' ? 'Supabase' : 'BigRock'} database...`;
      statusBox.classList.remove('hidden');
    }

    try {
      if (currentDbTab === 'supabase') {
        const urlInput = document.getElementById('supabase-url-input');
        const keyInput = document.getElementById('supabase-key-input');
        const url = (urlInput?.value || '').trim();
        const key = (keyInput?.value || '').trim();

        if (!url || !key) {
          throw new Error('Please enter both Supabase Project URL and Anon API Key.');
        }

        if (!window.supabase || !window.supabase.createClient) {
          throw new Error('Supabase client library not loaded. Check internet connection.');
        }

        const testClient = window.supabase.createClient(url, key);
        const { data, error } = await testClient.from('clientledger_data').select('id').limit(1);

        if (error) {
          if (error.code === '42P01') {
            throw new Error('Table clientledger_data not found in Supabase! Please run the SQL in Supabase SQL Editor.');
          }
          throw new Error(error.message || 'Supabase authentication failed.');
        }

        statusBox.className = 'p-3 rounded-xl text-xs flex items-center gap-2.5 bg-emerald-50 text-emerald-800 border border-emerald-300';
        statusIcon.innerHTML = '✅';
        statusText.innerHTML = `<strong>Connected!</strong> Supabase PostgreSQL database is online and reachable.`;

      } else {
        // BigRock PHP API test
        const input = document.getElementById('cloud-api-url-input');
        let url = (input ? input.value : '').trim();
        if (!url) url = 'api.php';
        const sep = url.includes('?') ? '&' : '?';
        const pingUrl = `${url}${sep}action=ping`;

        const res = await fetch(pingUrl, { method: 'GET' });
        if (res.ok) {
          const json = await res.json();
          if (json.success) {
            statusBox.className = 'p-3 rounded-xl text-xs flex items-center gap-2.5 bg-emerald-50 text-emerald-800 border border-emerald-300';
            statusIcon.innerHTML = '✅';
            statusText.innerHTML = `<strong>Connected!</strong> BigRock MySQL is active and responding.`;
          } else {
            throw new Error(json.error || 'Database connection error on BigRock.');
          }
        } else {
          throw new Error(`HTTP status ${res.status}`);
        }
      }
    } catch (e) {
      statusBox.className = 'p-3 rounded-xl text-xs flex items-center gap-2.5 bg-red-50 text-red-800 border border-red-300';
      statusIcon.innerHTML = '❌';
      statusText.innerHTML = `<strong>Connection Failed:</strong> ${e.message}`;
    } finally {
      if (btn) btn.disabled = false;
    }
  }

  // ==================== SHARED SERVER CONFIGURATION ====================
  async function loadServerConfig() {
    if (!window.location.protocol.startsWith('http')) return;
    try {
      const res = await fetch('api.php?action=load', { cache: 'no-store' });
      if (res.ok) {
        const json = await res.json();
        if (json && json.data && json.data.settings) {
          const s = json.data.settings;
          let changed = false;
          if (!state.settings.supabaseUrl && s.supabaseUrl) {
            state.settings.supabaseUrl = s.supabaseUrl;
            changed = true;
          }
          if (!state.settings.supabaseKey && s.supabaseKey) {
            state.settings.supabaseKey = s.supabaseKey;
            changed = true;
          }
          if (!state.settings.businessName && s.businessName) {
            state.settings.businessName = s.businessName;
            changed = true;
          }
          if (!state.settings.businessPhone && s.businessPhone) {
            state.settings.businessPhone = s.businessPhone;
            changed = true;
          }
          if (!state.settings.businessEmail && s.businessEmail) {
            state.settings.businessEmail = s.businessEmail;
            changed = true;
          }
          if (!state.settings.businessAddress && s.businessAddress) {
            state.settings.businessAddress = s.businessAddress;
            changed = true;
          }
          if (changed) {
            localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
            updateBusinessProfileBanner();
            updateLoginDbStatus();
          }
        }
      }
    } catch (e) {
      // Offline or static server - ignore
    }
  }

  async function saveSettingsToServer() {
    if (!window.location.protocol.startsWith('http')) return;
    try {
      const payload = {
        clients: state.clients || [],
        settings: state.settings || {},
        lastModified: Date.now(),
        version: 1,
      };
      await fetch('api.php?action=save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
    } catch (e) {
      // Offline or static host - ignore
    }
  }

  function updateLoginDbStatus() {
    const el = document.getElementById('login-db-status');
    if (!el) return;
    const configured = isSupabaseConfigured();
    if (configured) {
      el.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span><span class="text-emerald-700 font-semibold">Supabase Connected</span>`;
    } else {
      el.innerHTML = `<span class="w-2 h-2 rounded-full bg-amber-500"></span><span class="text-amber-700 font-medium">Supabase Not Connected</span>`;
    }
  }

  async function handleSaveCloudDb(e) {
    if (e && e.preventDefault) e.preventDefault();
    const supUrl = document.getElementById('supabase-url-input');
    const supKey = document.getElementById('supabase-key-input');
    const brUrl = document.getElementById('cloud-api-url-input');

    state.settings.dbProvider = currentDbTab;
    if (supUrl) state.settings.supabaseUrl = supUrl.value.trim();
    if (supKey) state.settings.supabaseKey = supKey.value.trim();
    if (brUrl) state.settings.apiUrl = brUrl.value.trim();
    state.settings.lastModified = Date.now();

    supabaseClient = null; // Re-create client with new credentials
    realtimeChannel = null;

    // Persist settings locally and to server if running.
    // CRITICAL: DO NOT call saveData() here, because on a new device state.clients is empty!
    // Calling saveData() would push an empty clients array and erase the Supabase database!
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
    } catch (err) {}
    saveSettingsToServer();

    closeModal('cloudDatabaseModal');
    updateLoginDbStatus();
    showToast('Connecting to Supabase and pulling data...');

    // IMMEDIATELY PULL all data from Supabase!
    await checkCloudSync(false, { forcePull: true });
  }

  let realtimeChannel = null;

  function subscribeToRealtime(sb) {
    if (!sb || typeof sb.channel !== 'function') return;
    if (realtimeChannel) return; // Already subscribed

    try {
      realtimeChannel = sb
        .channel('clientledger_realtime_changes')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'clientledger_data', filter: 'id=eq.main_store' },
          payload => {
            if (payload.new && payload.new.data) {
              const remoteData = payload.new.data;
              const remoteTime = Number(remoteData.lastModified) || (payload.new.updated_at ? new Date(payload.new.updated_at).getTime() : 0);
              const localTime = Number(state.settings.lastModified) || 0;

              // If another device made newer changes, apply them live!
              if (remoteTime > localTime) {
                applyCloudData(remoteData, 'Supabase Realtime');
                const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                updateSyncIndicator(true, `Supabase Live (${timeStr})`);
                showToast('Database updated from cloud!');
              }
            }
          }
        )
        .subscribe(status => {
          if (status === 'SUBSCRIBED') {
            console.log('Realtime live sync active with Supabase.');
          }
        });
    } catch (e) {
      console.warn('Realtime subscription error:', e);
    }
  }

  function isSupabaseConfigured() {
    const url = (state.settings.supabaseUrl || SUPABASE_CONFIG.url || '').trim();
    const key = (state.settings.supabaseKey || SUPABASE_CONFIG.anonKey || '').trim();
    return Boolean(url && key);
  }

  function updateSupabaseConnectBanner(show) {
    const banner = document.getElementById('supabase-connect-banner');
    if (banner) {
      if (show) banner.classList.remove('hidden');
      else banner.classList.add('hidden');
    }
  }

  async function checkCloudSync(silent = false, options = {}) {
    updateLoginDbStatus();
    const sb = getSupabaseClient();

    // If not connecting to database, there should NOT be any data in the project and no sync
    if (!sb) {
      cloudSyncAvailable = false;
      state.clients = [];
      updateSyncIndicator(false, 'Supabase Not Connected');
      updateSupabaseConnectBanner(true);
      if (state.activeView === 'dashboard') renderDashboard();
      else if (state.activeView === 'clients') renderClientsList();
      else if (state.activeView === 'matrix') renderMatrixView();
      return;
    }

    updateSupabaseConnectBanner(false);
    subscribeToRealtime(sb);

    try {
      const { data, error } = await sb
        .from('clientledger_data')
        .select('*')
        .eq('id', 'main_store')
        .maybeSingle();

      if (error) {
        console.warn('Supabase checkCloudSync error:', error);
        if (!silent) updateSyncIndicator(false, 'Supabase Sync Error ⚠️');
        return;
      }

      cloudSyncAvailable = true;

      if (data && data.data) {
        const remoteData = data.data;
        const remoteClients = Array.isArray(remoteData.clients) ? remoteData.clients : [];
        const remoteTime = Number(remoteData.lastModified) || (data.updated_at ? new Date(data.updated_at).getTime() : 0);
        const localTime = Number(state.settings.lastModified) || 0;

        // Force pull conditions:
        // 1. Explicitly requested options.forcePull
        // 2. Initial sync not completed yet in this browser session
        // 3. Local has 0 clients while remote has clients
        // 4. Remote is newer or equal timestamp
        const shouldPull = Boolean(
          options.forcePull ||
          !hasCompletedInitialSync ||
          (state.clients.length === 0 && remoteClients.length > 0) ||
          remoteTime >= localTime
        );

        if (shouldPull) {
          applyCloudData(remoteData, 'Supabase');
          hasCompletedInitialSync = true;
          if (!silent && remoteClients.length > 0) {
            showToast(`✅ Synced ${remoteClients.length} client(s) from Supabase database!`);
          }
        } else if (localTime > remoteTime && state.clients.length > 0 && hasCompletedInitialSync) {
          // Local genuinely has newer client edits made in this active session
          await syncToCloud({ force: true });
          hasCompletedInitialSync = true;
        } else {
          applyCloudData(remoteData, 'Supabase');
          hasCompletedInitialSync = true;
        }
      } else {
        // Table row does not exist yet in Supabase
        if (state.clients.length > 0) {
          await syncToCloud({ force: true });
        } else {
          await sb.from('clientledger_data').upsert({
            id: 'main_store',
            data: { clients: [], settings: state.settings, lastModified: Date.now(), version: 1 },
            updated_at: new Date().toISOString(),
          }, { onConflict: 'id' });
        }
        hasCompletedInitialSync = true;
      }

      const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      updateSyncIndicator(true, `Supabase Synced (${timeStr})`);
      updateLoginDbStatus();
    } catch (err) {
      console.warn('Supabase check error:', err);
      if (!silent) updateSyncIndicator(false, 'Supabase Offline ⚠️');
    }
  }

  function applyCloudData(remoteData, sourceName) {
    if (!remoteData) return;
    if (Array.isArray(remoteData.clients)) {
      state.clients = remoteData.clients;
      // Ensure all payments have unique identifiers
      state.clients.forEach(c => {
        if (Array.isArray(c.payments)) {
          c.payments.forEach((p, idx) => {
            if (!p.id) p.id = 'pay_' + (p.createdAt ? new Date(p.createdAt).getTime() : Date.now()) + '_' + idx;
          });
        }
      });
    } else {
      state.clients = [];
    }

    if (remoteData.settings && typeof remoteData.settings === 'object') {
      const localSupUrl = state.settings.supabaseUrl;
      const localSupKey = state.settings.supabaseKey;

      state.settings = { ...state.settings, ...remoteData.settings };

      if (!state.settings.supabaseUrl && localSupUrl) state.settings.supabaseUrl = localSupUrl;
      if (!state.settings.supabaseKey && localSupKey) state.settings.supabaseKey = localSupKey;
    }

    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.clients));
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
    } catch (err) {}

    updateCurrencySymbols();
    updateBusinessProfileBanner();

    if (state.activeView === 'dashboard') renderDashboard();
    else if (state.activeView === 'clients') renderClientsList();
    else if (state.activeView === 'client-detail' && state.activeClientId) renderClientDetail(state.activeClientId);
    else if (state.activeView === 'matrix') renderMatrixView();
  }

  async function syncToCloud(options = {}) {
    const sb = getSupabaseClient();

    // If it is not connecting to database, then there should not be any data sync
    if (!sb) {
      updateSyncIndicator(false, 'Supabase Not Connected');
      return { success: false, provider: 'none', error: 'Supabase database is not connected' };
    }

    // CRITICAL SAFETY SHIELD: Never overwrite remote database clients with an empty array
    // unless the user specifically and explicitly clicked "Clear All Data" (options.allowEmpty === true).
    if ((!state.clients || state.clients.length === 0) && !options.allowEmpty) {
      try {
        const { data: existingRow, error: checkErr } = await sb
          .from('clientledger_data')
          .select('data')
          .eq('id', 'main_store')
          .maybeSingle();

        if (!checkErr && existingRow && existingRow.data) {
          const remoteClients = Array.isArray(existingRow.data.clients) ? existingRow.data.clients : [];
          if (remoteClients.length > 0) {
            console.warn(`[Supabase Shield] Local has 0 clients but remote database has ${remoteClients.length} clients! Aborting destructive push and pulling remote data instead.`);
            applyCloudData(existingRow.data, 'Supabase Remote Recovery');
            hasCompletedInitialSync = true;
            return { success: true, provider: 'supabase', pulled: true, count: remoteClients.length };
          }
        }
      } catch (e) {
        console.warn('[Supabase Shield] Error checking remote data:', e);
      }
    }

    updateSyncIndicator(true, 'Syncing...', true);

    const payload = {
      clients: state.clients,
      settings: state.settings,
      lastModified: state.settings.lastModified || Date.now(),
      version: 1,
    };

    try {
      const { error } = await sb.from('clientledger_data').upsert({
        id: 'main_store',
        data: payload,
        updated_at: new Date().toISOString(),
      }, { onConflict: 'id' });

      if (error) {
        console.error('Supabase syncToCloud error:', error);
        const errDetail = error.message || error.details || error.code || 'Sync failed';
        updateSyncIndicator(false, 'Supabase Sync Error ⚠️');
        return { success: false, provider: 'supabase', error: errDetail };
      }

      cloudSyncAvailable = true;
      hasCompletedInitialSync = true;
      const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      updateSyncIndicator(true, `Supabase Synced (${timeStr})`);
      saveSettingsToServer(); // Keep database.json updated for local server
      return { success: true, provider: 'supabase', time: timeStr };
    } catch (err) {
      console.warn('Supabase syncToCloud exception:', err);
      updateSyncIndicator(false, 'Supabase Offline ⚠️');
      return { success: false, provider: 'supabase', error: err.message || 'Offline' };
    }
  }

  async function manualCloudSync() {
    const sb = getSupabaseClient();
    if (!sb) {
      showToast('⚠️ Please connect Supabase database first in Settings.', true);
      openCloudDatabaseModal();
      return;
    }

    showToast('Syncing all data with Supabase database...');
    const res = await syncToCloud({ force: true });
    if (res && res.success) {
      showToast('✅ All data synced successfully to Supabase PostgreSQL!');
    } else {
      showToast(`⚠️ Database sync failed: ${res ? res.error : 'Unknown error'}`, true);
    }
  }

  function updateSyncIndicator(online, label, isSpinning = false) {
    const el = document.getElementById('cloud-sync-status');
    const footerEl = document.getElementById('footer-sync-status');
    const displayText = label || (online ? 'Supabase Synced' : 'Supabase Not Connected');

    if (el) {
      if (isSpinning) {
        el.className = 'hidden sm:flex items-center gap-1.5 text-[11px] bg-blue-50 text-blue-700 px-2.5 py-1.5 rounded-lg border border-blue-200 cursor-pointer transition';
        el.innerHTML = `<span class="w-2 h-2 rounded-full bg-blue-500 animate-spin"></span><span class="font-bold">${displayText}</span>`;
        el.title = 'Syncing data with Supabase database...';
      } else if (online) {
        el.className = 'hidden sm:flex items-center gap-1.5 text-[11px] bg-emerald-50 text-emerald-700 px-2.5 py-1.5 rounded-lg border border-emerald-200 cursor-pointer hover:bg-emerald-100 transition';
        el.innerHTML = `<span class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span><span class="font-bold">${displayText}</span>`;
        el.title = `Connected to ${displayText}. Click to view database settings.`;
      } else {
        el.className = 'hidden sm:flex items-center gap-1.5 text-[11px] bg-amber-50 text-amber-800 px-2.5 py-1.5 rounded-lg border border-amber-300 cursor-pointer hover:bg-amber-100 transition';
        el.innerHTML = `<span class="w-1.5 h-1.5 rounded-full bg-amber-500"></span><span class="font-medium">Supabase Not Connected</span>`;
        el.title = 'Supabase database is not connected. Click to configure connection.';
      }
    }
    if (footerEl) {
      footerEl.textContent = displayText;
    }
  }

  function updateBusinessProfileBanner() {
    const bizNameEl = document.getElementById('dashboard-business-name');
    const bizAddressEl = document.getElementById('dashboard-business-address');
    const bizPhoneEl = document.getElementById('dashboard-business-phone');
    const bizEmailEl = document.getElementById('dashboard-business-email');
    const bizSepEl = document.getElementById('dashboard-business-separator');

    const name = (state.settings.businessName || '').trim() || 'My Business';
    const address = (state.settings.businessAddress || '').trim();
    const phone = (state.settings.businessPhone || '').trim();
    const email = (state.settings.businessEmail || '').trim();

    if (bizNameEl) bizNameEl.textContent = name;

    if (bizAddressEl) {
      if (address) {
        bizAddressEl.innerHTML = `<span>📍</span> <span>${escapeHtml(address)}</span>`;
        bizAddressEl.classList.remove('hidden');
      } else {
        bizAddressEl.classList.add('hidden');
      }
    }

    if (bizPhoneEl) {
      if (phone) {
        bizPhoneEl.innerHTML = `<span>📞</span> <span>${escapeHtml(phone)}</span>`;
        bizPhoneEl.classList.remove('hidden');
      } else {
        bizPhoneEl.classList.add('hidden');
      }
    }

    if (bizEmailEl) {
      if (email) {
        bizEmailEl.innerHTML = `<span>✉️</span> <span>${escapeHtml(email)}</span>`;
        bizEmailEl.classList.remove('hidden');
      } else {
        bizEmailEl.classList.add('hidden');
      }
    }

    if (bizSepEl) {
      if (phone && email) {
        bizSepEl.classList.remove('hidden');
      } else {
        bizSepEl.classList.add('hidden');
      }
    }
  }

  function loadData() {
    // 1. ALWAYS load settings FIRST so that Supabase credentials and preferences are available!
    try {
      const rawSettings = localStorage.getItem(SETTINGS_KEY);
      if (rawSettings) {
        state.settings = { ...state.settings, ...JSON.parse(rawSettings) };
      }
    } catch (e) {
      console.error('Error loading settings:', e);
    }

    // Merge window.SUPABASE_CONFIG if provided via config.js
    if (window.SUPABASE_CONFIG) {
      if (!state.settings.supabaseUrl && window.SUPABASE_CONFIG.url) {
        state.settings.supabaseUrl = window.SUPABASE_CONFIG.url.trim();
      }
      if (!state.settings.supabaseKey && window.SUPABASE_CONFIG.anonKey) {
        state.settings.supabaseKey = window.SUPABASE_CONFIG.anonKey.trim();
      }
    }

    // 2. Load clients from localStorage
    if (isSupabaseConfigured()) {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
          state.clients = JSON.parse(raw);
          if (Array.isArray(state.clients)) {
            state.clients.forEach(c => {
              if (Array.isArray(c.payments)) {
                c.payments.forEach((p, idx) => {
                  if (!p.id) p.id = 'pay_' + (p.createdAt ? new Date(p.createdAt).getTime() : Date.now()) + '_' + idx;
                });
              }
            });
          }
        } else {
          state.clients = [];
        }
      } catch (e) {
        console.error('Error loading data:', e);
        state.clients = [];
      }
    } else {
      // Supabase is not configured yet. Keep clients empty until connected
      state.clients = [];
    }

    updateBusinessProfileBanner();
    updateLoginDbStatus();
  }

  let syncDebounceTimer = null;

  async function saveData(immediate = true, options = {}) {
    try {
      state.settings.lastModified = Date.now();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.clients));
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
    } catch (e) {
      console.error('Error saving data to local storage:', e);
      showToast('Error saving data to local storage', true);
    }

    // Cancel any pending timer
    if (syncDebounceTimer) {
      clearTimeout(syncDebounceTimer);
      syncDebounceTimer = null;
    }

    if (immediate) {
      // INSTANT SYNC: Immediately push all updated data to Supabase/cloud database without delay
      return await syncToCloud(options);
    } else {
      // Debounce only when specifically requested
      syncDebounceTimer = setTimeout(() => {
        syncToCloud(options);
      }, 150);
    }
  }

  function seedSampleData() {
    // No default dummy clients - clean state
    state.clients = [];
  }

  // ==================== TOAST & UI HELPERS ====================
  function showToast(message, isError = false) {
    const toast = document.getElementById('toast');
    const msgEl = document.getElementById('toast-message');
    if (!toast || !msgEl) return;

    msgEl.textContent = message;
    toast.className = `fixed bottom-5 right-5 text-white text-sm px-4 py-3 rounded-xl shadow-xl transform transition-all duration-200 translate-y-0 opacity-100 z-50 flex items-center gap-2 ${
      isError ? 'bg-red-600' : 'bg-slate-900'
    }`;

    setTimeout(() => {
      toast.className =
        'fixed bottom-5 right-5 bg-slate-900 text-white text-sm px-4 py-3 rounded-xl shadow-xl transform transition-all duration-200 translate-y-24 opacity-0 z-50 flex items-center gap-2';
    }, 2800);
  }

  function updateCurrencySymbols() {
    document.querySelectorAll('.current-currency-symbol').forEach(el => {
      el.textContent = state.settings.currency;
    });
    const currSelect = document.getElementById('currency-select');
    if (currSelect) currSelect.value = state.settings.currency;
  }

  // ==================== VIEW NAVIGATION ====================
  function showView(viewName) {
    if (!state.isAuthenticated) {
      showLoginScreen();
      return;
    }

    state.activeView = viewName;
    ['dashboard', 'clients', 'client-detail', 'matrix'].forEach(v => {
      const el = document.getElementById(`view-${v}`);
      if (el) el.classList.add('hidden');
    });

    const activeEl = document.getElementById(`view-${viewName}`);
    if (activeEl) activeEl.classList.remove('hidden');

    // Update top nav active states
    const navDashboard = document.getElementById('nav-dashboard');
    const navClients = document.getElementById('nav-clients');
    const navMatrix = document.getElementById('nav-matrix');

    [navDashboard, navClients, navMatrix].forEach(nav => {
      if (!nav) return;
      nav.className =
        'px-3 py-2 rounded-lg text-sm font-medium transition-colors text-slate-600 hover:text-slate-900 hover:bg-slate-100 flex items-center space-x-1.5';
    });

    if (viewName === 'dashboard' && navDashboard) {
      navDashboard.className =
        'px-3 py-2 rounded-lg text-sm font-medium transition-colors text-blue-700 bg-blue-50 hover:bg-blue-100 flex items-center space-x-1.5';
    } else if ((viewName === 'clients' || viewName === 'client-detail') && navClients) {
      navClients.className =
        'px-3 py-2 rounded-lg text-sm font-medium transition-colors text-blue-700 bg-blue-50 hover:bg-blue-100 flex items-center space-x-1.5';
    } else if (viewName === 'matrix' && navMatrix) {
      navMatrix.className =
        'px-3 py-2 rounded-lg text-sm font-medium transition-colors text-blue-700 bg-blue-50 hover:bg-blue-100 flex items-center space-x-1.5';
    }

    if (viewName === 'dashboard') renderDashboard();
    if (viewName === 'clients') renderClientsList();
    if (viewName === 'matrix') renderMatrixView();
    if (viewName === 'client-detail' && state.activeClientId) {
      renderClientDetail(state.activeClientId);
    }

    // Scroll to top
    if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }

  // ==================== DASHBOARD DATE RANGE FILTER ====================
  function getPresetDateRange(preset) {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth(); // 0-indexed (0=Jan, 10=Nov)

    if (preset === 'this-month') {
      const yStr = String(year);
      const mStr = String(month + 1).padStart(2, '0');
      const lastDay = new Date(year, month + 1, 0).getDate();
      return {
        from: `${yStr}-${mStr}-01`,
        to: `${yStr}-${mStr}-${String(lastDay).padStart(2, '0')}`,
      };
    }

    if (preset === 'last-month') {
      let lmYear = year;
      let lmMonth = month - 1;
      if (lmMonth < 0) {
        lmMonth = 11;
        lmYear -= 1;
      }
      const yStr = String(lmYear);
      const mStr = String(lmMonth + 1).padStart(2, '0');
      const lastDay = new Date(lmYear, lmMonth + 1, 0).getDate();
      return {
        from: `${yStr}-${mStr}-01`,
        to: `${yStr}-${mStr}-${String(lastDay).padStart(2, '0')}`,
      };
    }

    if (preset === 'last-3-months') {
      let smYear = year;
      let smMonth = month - 2;
      if (smMonth < 0) {
        smMonth += 12;
        smYear -= 1;
      }
      const lastDay = new Date(year, month + 1, 0).getDate();
      return {
        from: `${smYear}-${String(smMonth + 1).padStart(2, '0')}-01`,
        to: `${year}-${String(month + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
      };
    }

    if (preset === 'this-fy') {
      const fyStartYear = month < 3 ? year - 1 : year;
      const fyEndYear = fyStartYear + 1;
      return {
        from: `${fyStartYear}-04-01`,
        to: `${fyEndYear}-03-31`,
      };
    }

    if (preset === 'last-fy') {
      const fyStartYear = (month < 3 ? year - 1 : year) - 1;
      const fyEndYear = fyStartYear + 1;
      return {
        from: `${fyStartYear}-04-01`,
        to: `${fyEndYear}-03-31`,
      };
    }

    if (preset === 'this-year') {
      return {
        from: `${year}-01-01`,
        to: `${year}-12-31`,
      };
    }

    return { from: '', to: '' };
  }

  function onDashboardPresetChange(preset) {
    if (!state.dashboardFilter) {
      state.dashboardFilter = { preset: 'all', from: '', to: '' };
    }
    state.dashboardFilter.preset = preset;

    if (preset === 'all') {
      state.dashboardFilter.from = '';
      state.dashboardFilter.to = '';
      const fromInput = document.getElementById('dashboard-filter-from');
      const toInput = document.getElementById('dashboard-filter-to');
      if (fromInput) fromInput.value = '';
      if (toInput) toInput.value = '';
      renderDashboard();
      return;
    }

    if (preset === 'custom') {
      const fromInput = document.getElementById('dashboard-filter-from');
      if (fromInput) fromInput.focus();
      return;
    }

    const range = getPresetDateRange(preset);
    state.dashboardFilter.from = range.from;
    state.dashboardFilter.to = range.to;

    const fromInput = document.getElementById('dashboard-filter-from');
    const toInput = document.getElementById('dashboard-filter-to');
    if (fromInput) fromInput.value = range.from;
    if (toInput) toInput.value = range.to;

    renderDashboard();
  }

  function onDashboardDateInputChange() {
    const fromVal = document.getElementById('dashboard-filter-from')?.value || '';
    const toVal = document.getElementById('dashboard-filter-to')?.value || '';
    const presetSelect = document.getElementById('dashboard-date-preset');

    if (!fromVal && !toVal) {
      if (presetSelect) presetSelect.value = 'all';
      if (!state.dashboardFilter) state.dashboardFilter = {};
      state.dashboardFilter.preset = 'all';
      state.dashboardFilter.from = '';
      state.dashboardFilter.to = '';
    } else {
      if (presetSelect) presetSelect.value = 'custom';
      if (!state.dashboardFilter) state.dashboardFilter = {};
      state.dashboardFilter.preset = 'custom';
      state.dashboardFilter.from = fromVal;
      state.dashboardFilter.to = toVal;
    }
    renderDashboard();
  }

  function applyDashboardDateFilter() {
    onDashboardDateInputChange();
  }

  function resetDashboardDateFilter() {
    state.dashboardFilter = { preset: 'all', from: '', to: '' };
    const presetSelect = document.getElementById('dashboard-date-preset');
    const fromInput = document.getElementById('dashboard-filter-from');
    const toInput = document.getElementById('dashboard-filter-to');
    if (presetSelect) presetSelect.value = 'all';
    if (fromInput) fromInput.value = '';
    if (toInput) toInput.value = '';
    renderDashboard();
  }

  // ==================== DASHBOARD RENDERING ====================
  function renderDashboard() {
    // Render Business Profile Header in Dashboard
    updateBusinessProfileBanner();

    const filter = state.dashboardFilter || { preset: 'all', from: '', to: '' };
    const hasFilter = Boolean((filter.from && filter.from.trim()) || (filter.to && filter.to.trim()) || (filter.preset && filter.preset !== 'all'));

    const fromDate = filter.from || '';
    const toDate = filter.to || '';
    const fromMonth = fromDate ? fromDate.slice(0, 7) : '';
    const toMonth = toDate ? toDate.slice(0, 7) : '';
    const fromYear = fromDate ? fromDate.slice(0, 4) : '';
    const toYear = toDate ? toDate.slice(0, 4) : '';

    let totalBilledAll = 0;
    let totalPaidAll = 0;
    let totalBalanceAll = 0;
    let pendingClientsCount = 0;
    let monthlyRunrate = 0;

    const duesRows = [];
    const recentPaymentsList = [];

    state.clients.forEach(c => {
      const ledger = calculateClientLedger(c);
      if (!ledger) return;

      if (c.status === 'active') {
        monthlyRunrate += Number(c.fixedMonthlyAmount || 0);
      }

      if (!hasFilter) {
        // All-Time Cumulative Mode
        totalBilledAll += ledger.totalBilled;
        totalPaidAll += ledger.totalPaid;
        totalBalanceAll += ledger.finalBalance;

        if (ledger.finalBalance > 0) {
          pendingClientsCount++;
          duesRows.push({
            client: c,
            ledger,
          });
        }

        if (c.payments) {
          c.payments.forEach(p => {
            recentPaymentsList.push({
              clientName: c.name,
              clientId: c.id,
              payment: p,
            });
          });
        }
      } else {
        // Date Range Filtered Mode
        let clientPeriodBilled = 0;
        let clientPeriodDue = 0;

        if (c.billingCycle === 'yearly') {
          const breakdown = ledger.yearlyBreakdown || [];
          breakdown.forEach(row => {
            const y = String(row.month);
            if (fromYear && y < fromYear) return;
            if (toYear && y > toYear) return;
            clientPeriodBilled += Number(row.billed || 0);
            clientPeriodDue += Math.max(0, Number(row.balance || 0));
          });
        } else {
          const breakdown = ledger.monthlyBreakdown || [];
          breakdown.forEach(row => {
            const m = String(row.month);
            if (fromMonth && m < fromMonth) return;
            if (toMonth && m > toMonth) return;
            clientPeriodBilled += Number(row.billed || 0);
            clientPeriodDue += Math.max(0, Number(row.balance || 0));
          });
        }

        totalBilledAll += clientPeriodBilled;
        totalBalanceAll += clientPeriodDue;

        if (clientPeriodDue > 0) {
          pendingClientsCount++;
          duesRows.push({
            client: c,
            ledger: {
              ...ledger,
              finalBalance: clientPeriodDue,
            },
          });
        }

        if (c.payments) {
          c.payments.forEach(p => {
            const pDate = p.date ? p.date.slice(0, 10) : '';
            if (fromDate && pDate < fromDate) return;
            if (toDate && pDate > toDate) return;
            totalPaidAll += Number(p.amount) || 0;
            recentPaymentsList.push({
              clientName: c.name,
              clientId: c.id,
              payment: p,
            });
          });
        }
      }
    });

    // Update dashboard stat badges
    const statBalance = document.getElementById('stat-total-balance');
    const statBilled = document.getElementById('stat-total-billed');
    const statCollected = document.getElementById('stat-total-collected');
    const statClients = document.getElementById('stat-total-clients');
    const statPendingClients = document.getElementById('stat-pending-clients-count');
    const statCollectionRate = document.getElementById('stat-collection-rate');
    const statRunrate = document.getElementById('stat-monthly-runrate');
    const navClientCount = document.getElementById('nav-client-count');
    const filterIndicator = document.getElementById('dashboard-filter-indicator');
    const billedLabel = document.getElementById('stat-billed-label');
    const billedSubtext = document.getElementById('stat-billed-subtext');

    if (statBalance) statBalance.textContent = formatCurrency(totalBalanceAll);
    if (statBilled) statBilled.textContent = formatCurrency(totalBilledAll);
    if (statCollected) statCollected.textContent = formatCurrency(totalPaidAll);
    if (statClients) statClients.textContent = state.clients.length;
    if (navClientCount) navClientCount.textContent = state.clients.length;

    // Filter indicator badge
    if (filterIndicator) {
      if (!hasFilter) {
        filterIndicator.textContent = 'Showing: All Time';
        filterIndicator.className = 'text-[11px] font-semibold text-slate-600 bg-slate-100 px-2.5 py-0.5 rounded-full border border-slate-200';
      } else {
        const fromStr = fromDate ? formatDate(fromDate) : 'Start';
        const toStr = toDate ? formatDate(toDate) : 'Present';
        filterIndicator.textContent = `Showing: ${fromStr} – ${toStr}`;
        filterIndicator.className = 'text-[11px] font-bold text-blue-700 bg-blue-50 px-2.5 py-0.5 rounded-full border border-blue-200';
      }
    }

    if (billedLabel) {
      billedLabel.textContent = hasFilter ? 'Total Billed (Period)' : 'Total Billed (Cumulative)';
    }
    if (billedSubtext) {
      billedSubtext.textContent = hasFilter ? 'Sum of fees in selected period' : 'Sum of monthly fixed & custom fees';
    }

    if (statPendingClients) {
      statPendingClients.textContent = hasFilter
        ? `${pendingClientsCount} clients with dues in period`
        : `${pendingClientsCount} of ${state.clients.length} clients owe balance`;
    }

    const rate = totalBilledAll > 0 ? Math.round((totalPaidAll / totalBilledAll) * 100) : 0;
    if (statCollectionRate) {
      statCollectionRate.textContent = hasFilter
        ? `${rate}% collection rate in period`
        : `${rate}% collection rate`;
    }
    if (statRunrate) statRunrate.textContent = `${formatCurrency(monthlyRunrate)} / mo recurring base`;

    // Render Pending Dues Table
    const duesTbody = document.getElementById('dashboard-dues-tbody');
    const duesEmpty = document.getElementById('dashboard-dues-empty');

    if (duesTbody && duesEmpty) {
      if (duesRows.length === 0) {
        duesTbody.innerHTML = '';
        duesEmpty.classList.remove('hidden');
        const emptyMsg = duesEmpty.querySelector('p');
        if (emptyMsg) {
          emptyMsg.textContent = hasFilter ? 'No clients with pending dues in this selected date range.' : 'All clients are completely settled! Zero outstanding dues.';
        }
      } else {
        duesEmpty.classList.add('hidden');
        // Sort by highest balance due descending
        duesRows.sort((a, b) => b.ledger.finalBalance - a.ledger.finalBalance);

        duesTbody.innerHTML = duesRows
          .map(item => {
            const c = item.client;
            const l = item.ledger;
            const oldestName = l.oldestUnpaidMonth ? formatMonthName(l.oldestUnpaidMonth) : 'Recent';
            return `
            <tr class="hover:bg-slate-50 transition cursor-pointer" onclick="app.viewClientDetail('${c.id}')">
              <td class="py-3 px-3">
                <div class="font-semibold text-slate-800">${escapeHtml(c.businessName || c.name)}</div>
                <div class="text-xs text-slate-500">${c.businessName ? `<span class="text-slate-600 font-medium">👤 ${escapeHtml(c.name)} &bull; </span>` : ''}${escapeHtml(c.phone || c.email || 'No contact')}</div>
              </td>
              <td class="py-3 px-3 text-slate-600 font-medium">${formatCurrency(c.fixedMonthlyAmount)}/mo</td>
              <td class="py-3 px-3">
                <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-50 text-amber-800 border border-amber-200">
                  ${hasFilter ? `Pending in period` : `${l.unpaidMonthsCount} mo pending (since ${oldestName})`}
                </span>
              </td>
              <td class="py-3 px-3 text-right font-bold text-red-600">${formatCurrency(l.finalBalance)}</td>
              <td class="py-3 px-3 text-right" onclick="event.stopPropagation()">
                <button onclick="app.openRecordPaymentModal('${c.id}')" class="px-2.5 py-1 text-xs font-semibold bg-emerald-50 hover:bg-emerald-100 text-emerald-700 rounded-lg transition">
                  Receive Money
                </button>
              </td>
            </tr>
          `;
          })
          .join('');
      }
    }

    // Render Recent Payments
    const recentPaymentsEl = document.getElementById('dashboard-recent-payments');
    if (recentPaymentsEl) {
      if (recentPaymentsList.length === 0) {
        recentPaymentsEl.innerHTML = `
          <div class="text-center py-8 text-slate-400">
            <p class="text-xs">No payments recorded yet.</p>
          </div>
        `;
      } else {
        // Sort newest date first
        recentPaymentsList.sort((a, b) => (b.payment.date || '').localeCompare(a.payment.date || ''));
        const slice = recentPaymentsList.slice(0, 8);

        recentPaymentsEl.innerHTML = slice
          .map(item => {
            const p = item.payment;
            return `
            <div class="flex items-center justify-between p-3 rounded-xl bg-slate-50 border border-slate-100 hover:bg-slate-100 transition">
              <div class="flex items-center space-x-3">
                <div class="w-8 h-8 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center font-bold text-xs">
                  ✓
                </div>
                <div>
                  <p class="text-xs font-semibold text-slate-800 cursor-pointer hover:text-blue-600" onclick="app.viewClientDetail('${item.clientId}')">
                    ${escapeHtml(item.clientName)}
                  </p>
                  <p class="text-[11px] text-slate-500">${formatDate(p.date)} &bull; ${escapeHtml(p.method || 'Cash')}</p>
                </div>
              </div>
              <div class="text-right">
                <span class="text-xs font-bold text-emerald-700">+${formatCurrency(p.amount)}</span>
                ${p.targetMonth ? `<div class="text-[10px] text-indigo-600 font-medium">For ${formatMonthName(p.targetMonth)}</div>` : ''}
              </div>
            </div>
          `;
          })
          .join('');
      }
    }
  }

  // ==================== CLIENTS LIST RENDERING ====================
  function renderClientsList() {
    const tbody = document.getElementById('clients-table-tbody');
    const emptyEl = document.getElementById('clients-table-empty');
    if (!tbody || !emptyEl) return;

    let filtered = state.clients.map(c => ({
      client: c,
      ledger: calculateClientLedger(c),
    }));

    // Text search filter
    if (state.searchQuery) {
      const q = state.searchQuery.toLowerCase();
      filtered = filtered.filter(item => {
        const c = item.client;
        return (
          (c.name && c.name.toLowerCase().includes(q)) ||
          (c.businessName && c.businessName.toLowerCase().includes(q)) ||
          (c.phone && c.phone.toLowerCase().includes(q)) ||
          (c.email && c.email.toLowerCase().includes(q)) ||
          (c.notes && c.notes.toLowerCase().includes(q)) ||
          (c.gstNumber && c.gstNumber.toLowerCase().includes(q))
        );
      });
    }

    // Status filter
    if (state.statusFilter === 'due') {
      filtered = filtered.filter(item => item.ledger.finalBalance > 0);
    } else if (state.statusFilter === 'settled') {
      filtered = filtered.filter(item => item.ledger.finalBalance === 0);
    } else if (state.statusFilter === 'advance') {
      filtered = filtered.filter(item => item.ledger.finalBalance < 0);
    }

    if (filtered.length === 0) {
      tbody.innerHTML = '';
      emptyEl.classList.remove('hidden');
      return;
    }

    emptyEl.classList.add('hidden');
    tbody.innerHTML = filtered
      .map(item => {
        const c = item.client;
        const l = item.ledger;

        let statusBadge = '';
        if (l.finalBalance > 0) {
          statusBadge = `<span class="px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-800 border border-red-200">Pending Due (${l.unpaidMonthsCount} mo)</span>`;
        } else if (l.finalBalance === 0) {
          statusBadge = `<span class="px-2 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800 border border-emerald-200">Fully Settled</span>`;
        } else {
          statusBadge = `<span class="px-2 py-0.5 rounded-full text-xs font-semibold bg-blue-100 text-blue-800 border border-blue-200">Advance Credit</span>`;
        }

        const balClass =
          l.finalBalance > 0 ? 'text-red-600 font-bold' : l.finalBalance < 0 ? 'text-blue-600 font-bold' : 'text-slate-500 font-medium';

        const isYearly = c.billingCycle === 'yearly';
        const feeStr = isYearly
          ? `${formatCurrency(c.fixedYearlyAmount || c.fixedMonthlyAmount)}<span class="text-xs font-bold text-amber-700 ml-1">/yr</span>`
          : `${formatCurrency(c.fixedMonthlyAmount)}<span class="text-xs font-normal text-slate-400 ml-1">/mo</span>`;
        const startStr = isYearly
          ? `Year ${c.startYear || (c.startMonth ? c.startMonth.substring(0, 4) : '')}`
          : formatMonthName(c.startMonth);

        return `
        <tr class="hover:bg-slate-50 transition">
          <td class="py-3 px-4 cursor-pointer" onclick="app.viewClientDetail('${c.id}')">
            <div class="font-bold text-slate-900 hover:text-blue-600 flex items-center gap-1.5">
              <span>${escapeHtml(c.businessName || c.name)}</span>
              ${c.status === 'inactive' ? '<span class="text-[10px] bg-slate-200 text-slate-600 px-1.5 py-0.2 rounded font-normal">Inactive</span>' : ''}
              ${isYearly ? '<span class="text-[10px] font-bold text-amber-700 bg-amber-50 px-1.5 py-0.2 rounded border border-amber-200">Yearly</span>' : ''}
            </div>
            ${c.businessName ? `<div class="text-xs text-blue-700 font-medium mt-0.5">👤 Contact: ${escapeHtml(c.name)}</div>` : ''}
            ${c.phone ? `<div class="text-xs text-slate-600 mt-0.5">📞 ${escapeHtml(c.phone)}</div>` : ''}
            ${c.hasGst && c.gstNumber ? `<div class="mt-0.5 font-mono text-[10px] font-semibold bg-slate-100 text-slate-700 px-1.5 py-0.5 rounded border border-slate-200 inline-block">GST: ${escapeHtml(c.gstNumber)}</div>` : ''}
            ${c.email ? `<div class="text-xs text-slate-400 mt-0.5">✉️ ${escapeHtml(c.email)}</div>` : ''}
          </td>
          <td class="py-3 px-4 font-semibold text-slate-700">${feeStr}</td>
          <td class="py-3 px-4 text-xs text-slate-600 font-medium">${startStr}</td>
          <td class="py-3 px-4 text-slate-800 font-medium">${formatCurrency(l.totalBilled)}</td>
          <td class="py-3 px-4 text-emerald-600 font-medium">${formatCurrency(l.totalPaid)}</td>
          <td class="py-3 px-4 ${balClass}">${formatCurrency(l.finalBalance)}</td>
          <td class="py-3 px-4">${statusBadge}</td>
          <td class="py-3 px-4 text-right">
            <div class="flex items-center justify-end gap-1.5">
              <button onclick="app.viewClientDetail('${c.id}')" class="px-2.5 py-1 text-xs font-semibold bg-blue-50 text-blue-700 hover:bg-blue-100 rounded-lg transition" title="View Month-by-Month Balance">
                View Ledger
              </button>
              <button onclick="app.openRecordPaymentModal('${c.id}')" class="px-2.5 py-1 text-xs font-semibold bg-emerald-50 text-emerald-700 hover:bg-emerald-100 rounded-lg transition" title="Record Payment">
                + Pay
              </button>
            </div>
          </td>
        </tr>
      `;
      })
      .join('');
  }

  function filterClients() {
    const searchInput = document.getElementById('client-search-input');
    const statusSelect = document.getElementById('client-status-filter');
    if (searchInput) state.searchQuery = searchInput.value.trim();
    if (statusSelect) state.statusFilter = statusSelect.value;
    renderClientsList();
  }

  // ==================== CLIENT LEDGER DETAIL RENDERING ====================
  function viewClientDetail(clientId) {
    state.activeClientId = clientId;
    const upToMonthInput = document.getElementById('ledger-up-to-month');
    if (upToMonthInput) {
      upToMonthInput.value = getLastMonth();
      upToMonthInput.max = getLastMonth();
    }
    showView('client-detail');
  }

  function renderClientDetail(clientId) {
    const client = state.clients.find(c => c.id === clientId);
    if (!client) {
      showToast('Client not found', true);
      showView('clients');
      return;
    }

    const upToMonthInput = document.getElementById('ledger-up-to-month');
    const lastCompleted = getLastMonth();
    let chosenUpTo = lastCompleted;

    if (upToMonthInput) {
      upToMonthInput.max = lastCompleted;
      if (upToMonthInput.value && compareMonths(upToMonthInput.value, lastCompleted) <= 0) {
        chosenUpTo = upToMonthInput.value;
      } else {
        upToMonthInput.value = lastCompleted;
        chosenUpTo = lastCompleted;
      }
    }

    const ledger = calculateClientLedger(client, chosenUpTo);

    // Profile header
    const nameEl = document.getElementById('detail-client-name');
    const phoneEl = document.getElementById('detail-client-phone');
    const emailEl = document.getElementById('detail-client-email');
    const startEl = document.getElementById('detail-client-start');
    const fixedFeeEl = document.getElementById('detail-client-fixed-fee');
    const notesEl = document.getElementById('detail-client-notes');
    const statusBadge = document.getElementById('detail-client-status-badge');

    const isYearly = client.billingCycle === 'yearly';
    if (nameEl) {
      const planBadge = isYearly ? '<span class="text-xs font-bold text-amber-700 bg-amber-50 px-2 py-0.5 rounded-full border border-amber-200 align-middle ml-2">Yearly Plan</span>' : '<span class="text-xs font-bold text-blue-700 bg-blue-50 px-2 py-0.5 rounded-full border border-blue-200 align-middle ml-2">Monthly Plan</span>';
      if (client.businessName) {
        nameEl.innerHTML = `<span>${escapeHtml(client.businessName)}</span> <span class="text-base font-normal text-slate-500 block sm:inline sm:ml-2">👤 ${escapeHtml(client.name)}</span> ${planBadge}`;
      } else {
        nameEl.innerHTML = `${escapeHtml(client.name)} ${planBadge}`;
      }
    }
    if (phoneEl) {
      phoneEl.innerHTML = `<span>📞</span> ${escapeHtml(client.phone || 'No phone')}`;
      if (client.hasGst && client.gstNumber) {
        phoneEl.innerHTML += `<div class="mt-1 font-mono text-xs font-semibold text-slate-700 bg-slate-100 px-2 py-0.5 rounded border border-slate-200 inline-block">GST: ${escapeHtml(client.gstNumber)}</div>`;
      }
    }
    if (emailEl) emailEl.innerHTML = `<span>✉️</span> ${escapeHtml(client.email || 'No email')}`;
    if (startEl) startEl.innerHTML = `<span>📅</span> Started: ${isYearly ? `Year ${client.startYear || (client.startMonth ? client.startMonth.substring(0, 4) : '')}` : formatMonthName(client.startMonth)}`;
    if (fixedFeeEl) {
      let feeText = `Default Fixed: ${formatCurrency(isYearly ? (client.fixedYearlyAmount || client.fixedMonthlyAmount) : client.fixedMonthlyAmount)} / ${isYearly ? 'year' : 'month'}`;
      if (client.incomeTaxFee > 0) {
        feeText += ` &bull; <span class="font-bold text-emerald-700">IT Fee: ${formatCurrency(client.incomeTaxFee)}${client.incomeTaxNote ? ` (${escapeHtml(client.incomeTaxNote)})` : ''}</span>`;
      }
      if (client.extraFee > 0) {
        feeText += ` &bull; <span class="font-bold text-indigo-700">Extra Fee: ${formatCurrency(client.extraFee)}${client.extraFeeNote ? ` (${escapeHtml(client.extraFeeNote)})` : ''}</span>`;
      }
      fixedFeeEl.innerHTML = feeText;
    }
    if (notesEl) {
      notesEl.textContent = client.notes ? `Notes: ${client.notes}` : 'No notes provided.';
    }
    if (statusBadge) {
      if (client.status === 'inactive') {
        statusBadge.className = 'px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-200 text-slate-700';
        statusBadge.textContent = 'Inactive / Paused';
      } else {
        statusBadge.className = 'px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800';
        statusBadge.textContent = 'Active Client';
      }
    }

    // Financial snapshot
    const totalBilledEl = document.getElementById('detail-total-billed');
    const totalPaidEl = document.getElementById('detail-total-paid');
    const finalBalanceEl = document.getElementById('detail-final-balance');
    const totalMonthsEl = document.getElementById('detail-total-months');
    const paymentCountEl = document.getElementById('detail-payment-count');
    const balanceStatusEl = document.getElementById('detail-balance-status-text');

    if (totalBilledEl) totalBilledEl.textContent = formatCurrency(ledger.totalBilled);
    if (totalPaidEl) totalPaidEl.textContent = formatCurrency(ledger.totalPaid);
    if (totalMonthsEl) totalMonthsEl.textContent = `${ledger.months.length} billing months`;
    if (paymentCountEl) paymentCountEl.textContent = `${ledger.payments.length} payments recorded`;

    if (finalBalanceEl && balanceStatusEl) {
      finalBalanceEl.textContent = formatCurrency(ledger.finalBalance);
      if (ledger.finalBalance > 0) {
        finalBalanceEl.className = 'text-2xl font-black text-red-600';
        balanceStatusEl.className = 'text-[10px] font-bold text-red-600';
        balanceStatusEl.textContent = `Pending Due (${ledger.unpaidMonthsCount} mo unpaid)`;
      } else if (ledger.finalBalance === 0) {
        finalBalanceEl.className = 'text-2xl font-black text-emerald-600';
        balanceStatusEl.className = 'text-[10px] font-bold text-emerald-600';
        balanceStatusEl.textContent = 'Account Fully Settled (₹0)';
      } else {
        finalBalanceEl.className = 'text-2xl font-black text-blue-600';
        balanceStatusEl.className = 'text-[10px] font-bold text-blue-600';
        balanceStatusEl.textContent = `Advance Credit (${formatCurrency(Math.abs(ledger.finalBalance))})`;
      }
    }

    // Month-by-Month Table Breakdown (Core User Requirement!)
    const breakdownTbody = document.getElementById('detail-monthly-breakdown-tbody');
    if (breakdownTbody) {
      // Reverse chronological order for ledger (latest month at top)
      const reversedBreakdown = [...ledger.monthlyBreakdown].reverse();

      if (reversedBreakdown.length === 0) {
        breakdownTbody.innerHTML = `
          <tr>
            <td colspan="7" class="py-8 text-center text-slate-400">
              <div class="text-sm font-semibold text-slate-600">No completed billing months yet</div>
              <div class="text-xs text-slate-400 mt-1">Client joined in the current month (${formatMonthName(client.startMonth)}). Current month dues are allocated only after the month completes.</div>
            </td>
          </tr>
        `;
      } else {
        breakdownTbody.innerHTML = reversedBreakdown
          .map(row => {
          let feeTypeBadge = '';
          if (row.isOverridden) {
            feeTypeBadge = `
            <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium badge-override cursor-pointer" onclick="app.openOverrideMonthModal('${client.id}', '${row.month}')" title="Click to edit override">
              Custom Fee
              ${row.overrideNote ? `&bull; <span class="italic text-[10px] max-w-[120px] truncate">${escapeHtml(row.overrideNote)}</span>` : ''}
            </span>
          `;
          } else {
            feeTypeBadge = `
            <span class="text-xs text-slate-500 font-normal">Fixed Default</span>
          `;
          }

          let statusBadge = '';
          let rowClass = '';
          let balanceDisplay = '';

          if (row.balance <= 0) {
            statusBadge = `
            <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold badge-paid">
              ✓ Fully Paid
            </span>
          `;
            balanceDisplay = `<span class="text-slate-400 font-medium">₹0.00</span>`;
            if (row.status === 'OVERPAID') {
              statusBadge = `
              <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold badge-advance">
                + Surplus Paid
              </span>
            `;
            }
          } else if (row.paid > 0) {
            statusBadge = `
            <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold badge-partial">
              Partially Paid
            </span>
          `;
            rowClass = 'bg-amber-50/40';
            balanceDisplay = `<span class="text-amber-700 font-bold">${formatCurrency(row.balance)} due</span>`;
          } else {
            statusBadge = `
            <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold badge-unpaid">
              Unpaid
            </span>
          `;
            rowClass = 'bg-red-50/30';
            balanceDisplay = `<span class="text-red-600 font-bold">${formatCurrency(row.balance)} due</span>`;
          }

          return `
          <tr class="${rowClass} hover:bg-slate-50/80 transition">
            <td class="py-3 px-4 font-semibold text-slate-800">
              ${row.fullMonthName}
            </td>
            <td class="py-3 px-4 font-bold text-slate-900">
              ${formatCurrency(row.billed)}
            </td>
            <td class="py-3 px-4">
              ${feeTypeBadge}
            </td>
            <td class="py-3 px-4 font-medium text-emerald-600">
              ${formatCurrency(row.paid)}
            </td>
            <td class="py-3 px-4">
              ${balanceDisplay}
            </td>
            <td class="py-3 px-4">
              ${statusBadge}
            </td>
            <td class="py-3 px-4 text-right">
              <div class="flex items-center justify-end gap-1.5">
                <button onclick="app.openOverrideMonthModal('${client.id}', '${row.month}')" class="px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50 rounded transition" title="Change payment amount for ${row.fullMonthName}">
                  Change Fee
                </button>
                ${
                  row.balance > 0
                    ? `<button onclick="app.openRecordPaymentForMonth('${client.id}', '${row.month}', ${row.balance})" class="px-2 py-1 text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white rounded transition shadow-xs" title="Pay ${formatCurrency(row.balance)} for this month">
                        Pay ${formatCurrency(row.balance)}
                       </button>`
                    : ''
                }
              </div>
            </td>
          </tr>
        `;
        })
        .join('');
      }
    }

    // Payment History Table
    const paymentsTbody = document.getElementById('detail-payments-tbody');
    const paymentsEmpty = document.getElementById('detail-payments-empty');
    if (paymentsTbody && paymentsEmpty) {
      if (!client.payments || client.payments.length === 0) {
        paymentsTbody.innerHTML = '';
        paymentsEmpty.classList.remove('hidden');
      } else {
        paymentsEmpty.classList.add('hidden');
        (client.payments || []).forEach((p, idx) => {
          if (!p.id) p.id = 'pay_' + (p.createdAt ? new Date(p.createdAt).getTime() : Date.now()) + '_' + idx;
        });
        const reversedPayments = [...client.payments].reverse();

        paymentsTbody.innerHTML = reversedPayments
          .map(p => {
            const hasDiscount = Number(p.discount || 0) > 0;
            return `
            <tr class="hover:bg-slate-50 transition">
              <td class="py-3 px-4 text-slate-700 font-medium">${formatDate(p.date)}</td>
              <td class="py-3 px-4">
                <span class="font-bold text-emerald-600 text-base">+${formatCurrency(p.amount)}</span>
                ${
                  hasDiscount
                    ? `<div class="mt-1">
                        <span class="inline-flex items-center gap-1 text-[11px] font-bold text-amber-900 bg-amber-100/90 px-2 py-0.5 rounded border border-amber-300">
                          🏷️ Discount: ${formatCurrency(p.discount)} ${p.isSettlement ? '(Full Settlement)' : ''}
                        </span>
                        ${p.discountNote ? `<div class="text-[10px] text-slate-500 italic mt-0.5">${escapeHtml(p.discountNote)}</div>` : ''}
                       </div>`
                    : ''
                }
              </td>
              <td class="py-3 px-4 text-xs text-slate-600 font-medium">${escapeHtml(p.method || 'Cash')}</td>
              <td class="py-3 px-4 text-xs">
                ${
                  p.targetMonth
                    ? `<span class="bg-indigo-50 text-indigo-700 px-2 py-0.5 rounded font-semibold">Direct: ${formatMonthName(p.targetMonth)}</span>`
                    : '<span class="text-slate-500">Auto (FIFO)</span>'
                }
              </td>
              <td class="py-3 px-4 text-xs font-mono text-slate-500">${escapeHtml(p.reference || '--')}</td>
              <td class="py-3 px-4 text-xs text-slate-600">${escapeHtml(p.note || '--')}</td>
              <td class="py-3 px-4 text-right whitespace-nowrap">
                <div class="flex items-center justify-end gap-1.5">
                  <button onclick="app.sendPaymentWhatsApp('${client.id}', '${p.id}')" class="text-xs text-emerald-700 hover:text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 font-semibold px-2 py-1 rounded transition flex items-center gap-1 shadow-2xs" title="Send Invoice / Payment Receipt to Registered Client on WhatsApp">
                    <svg class="w-3.5 h-3.5 text-emerald-600" fill="currentColor" viewBox="0 0 24 24"><path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946.003-6.556 5.338-11.891 11.893-11.891 3.181.001 6.167 1.24 8.413 3.488 2.245 2.248 3.481 5.236 3.48 8.414-.003 6.557-5.338 11.892-11.893 11.892-1.99-.001-3.951-.5-5.688-1.448l-6.305 1.654zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884-.001 2.225.651 3.891 1.746 5.634l-.999 3.648 3.742-.981zm11.387-5.464c-.074-.124-.272-.198-.57-.347-.297-.149-1.758-.868-2.031-.967-.272-.099-.47-.149-.669.149-.198.297-.768.967-.941 1.165-.173.198-.347.223-.644.074-.297-.149-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.521.151-.172.2-.296.3-.495.099-.198.05-.372-.025-.521-.075-.148-.669-1.611-.916-2.206-.242-.579-.487-.501-.669-.51l-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.095 3.2 5.076 4.487.709.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.695.248-1.29.173-1.414z"/></svg>
                    WhatsApp
                  </button>
                  <button onclick="app.printPaymentReceipt('${client.id}', '${p.id}')" class="text-xs text-slate-700 hover:text-slate-900 bg-white border border-slate-300 hover:bg-slate-50 font-semibold px-2 py-1 rounded transition flex items-center gap-1 shadow-2xs" title="Print Invoice / Payment Receipt for this transaction">
                    <svg class="w-3.5 h-3.5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/></svg>
                    Print
                  </button>
                  <button onclick="app.openEditPaymentModal('${client.id}', '${p.id}')" class="text-xs text-blue-600 hover:text-blue-800 font-semibold px-2 py-1 hover:bg-blue-50 rounded transition flex items-center gap-1" title="Edit this payment">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
                    Edit
                  </button>
                  <button onclick="app.handleDeletePayment('${client.id}', '${p.id}')" class="text-xs text-red-500 hover:text-red-700 font-medium px-2 py-1 hover:bg-red-50 rounded transition" title="Delete payment entry">
                    Delete
                  </button>
                </div>
              </td>
            </tr>
          `;
          })
          .join('');
      }
    }
  }

  // ==================== MONTHLY MATRIX VIEW ====================
  function renderMatrixView() {
    const container = document.getElementById('matrix-table-container');
    const monthsSelect = document.getElementById('matrix-months-count');
    if (!container) return;

    const count = monthsSelect ? Number(monthsSelect.value) || 12 : 12;
    const lastYM = getLastMonth();
    const [lastY, lastM] = lastYM.split('-').map(Number);

    // Generate recent N completed months up to last month (present month is not displayed)
    const matrixMonths = [];
    for (let i = count - 1; i >= 0; i--) {
      let m = lastM - i;
      let y = lastY;
      while (m < 1) {
        m += 12;
        y--;
      }
      while (m > 12) {
        m -= 12;
        y++;
      }
      matrixMonths.push(`${y}-${String(m).padStart(2, '0')}`);
    }

    if (state.clients.length === 0) {
      container.innerHTML = `
        <div class="text-center py-12 text-slate-400">
          <p>No client data to display.</p>
        </div>
      `;
      return;
    }

    let headerHtml = `
      <table class="w-full text-left text-xs">
        <thead class="bg-slate-50 border-b border-slate-200 uppercase font-semibold text-slate-500">
          <tr>
            <th class="py-3 px-4 sticky left-0 bg-slate-50 z-10 shadow-r">Client</th>
            <th class="py-3 px-4">Fixed Fee</th>
            <th class="py-3 px-4 text-right">Total Balance</th>
    `;

    matrixMonths.forEach(m => {
      headerHtml += `<th class="py-3 px-3 text-center whitespace-nowrap">${formatMonthName(m)}</th>`;
    });
    headerHtml += `</tr></thead><tbody class="divide-y divide-slate-100">`;

    let rowsHtml = '';
    state.clients.forEach(c => {
      const ledger = calculateClientLedger(c);
      const monthMap = {};
      ledger.monthlyBreakdown.forEach(item => {
        monthMap[item.month] = item;
      });

      const balColor = ledger.finalBalance > 0 ? 'text-red-600 font-bold' : 'text-slate-600';

      rowsHtml += `
        <tr class="hover:bg-slate-50 transition cursor-pointer" onclick="app.viewClientDetail('${c.id}')">
          <td class="py-3 px-4 font-semibold text-slate-800 sticky left-0 bg-white z-10 shadow-r whitespace-nowrap">
            ${escapeHtml(c.businessName || c.name)}
            ${c.businessName ? `<div class="text-[10px] text-slate-500 font-normal">👤 ${escapeHtml(c.name)}</div>` : ''}
          </td>
          <td class="py-3 px-4 text-slate-500 whitespace-nowrap">${formatCurrency(c.fixedMonthlyAmount)}</td>
          <td class="py-3 px-4 text-right whitespace-nowrap ${balColor}">${formatCurrency(ledger.finalBalance)}</td>
      `;

      matrixMonths.forEach(m => {
        const item = monthMap[m];
        if (!item) {
          rowsHtml += `<td class="py-3 px-3 text-center text-slate-300">-</td>`;
        } else {
          let cellBadge = '';
          if (item.balance <= 0) {
            cellBadge = `<span class="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold bg-emerald-100 text-emerald-800">PAID</span>`;
          } else if (item.paid > 0) {
            cellBadge = `<span class="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold bg-amber-100 text-amber-800" title="Bal: ${formatCurrency(item.balance)}">${formatCurrency(item.balance)}</span>`;
          } else {
            cellBadge = `<span class="inline-block px-1.5 py-0.5 rounded text-[10px] font-bold bg-red-100 text-red-800" title="Due: ${formatCurrency(item.billed)}">${formatCurrency(item.billed)}</span>`;
          }
          rowsHtml += `<td class="py-3 px-3 text-center">${cellBadge}</td>`;
        }
      });

      rowsHtml += `</tr>`;
    });

    container.innerHTML = headerHtml + rowsHtml + `</tbody></table>`;
  }

  // ==================== MODAL MANAGERS & HANDLERS ====================
  function openModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) {
      modal.classList.remove('hidden');
      // Set default values where applicable
      if (modalId === 'addClientModal') {
        const startMonthInput = document.getElementById('add-client-start-month');
        if (startMonthInput && !startMonthInput.value) {
          startMonthInput.value = getLastMonth();
        }
      }
    }
  }

  function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.add('hidden');
  }

  // GST Field Toggle
  function toggleGstField(prefix) {
    const checkbox = document.getElementById(`${prefix}-client-has-gst`);
    const container = document.getElementById(`${prefix}-client-gst-container`);
    const input = document.getElementById(`${prefix}-client-gst-number`);
    if (!checkbox || !container) return;

    if (checkbox.checked) {
      container.classList.remove('hidden');
      if (input) input.focus();
    } else {
      container.classList.add('hidden');
      if (input) input.value = '';
    }
  }

  // Billing Frequency Toggle (Monthly vs Yearly)
  function setBillingCycle(prefix, cycle) {
    const hiddenInput = document.getElementById(`${prefix}-client-billing-cycle`);
    const monthlyBtn = document.getElementById(`${prefix}-client-cycle-monthly-btn`);
    const yearlyBtn = document.getElementById(`${prefix}-client-cycle-yearly-btn`);
    const monthlyFields = document.getElementById(`${prefix}-client-monthly-fields`);
    const yearlyFields = document.getElementById(`${prefix}-client-yearly-fields`);

    if (hiddenInput) hiddenInput.value = cycle;

    if (cycle === 'yearly') {
      if (monthlyBtn) {
        monthlyBtn.className = 'py-1.5 px-3 text-xs font-bold rounded-md text-slate-600 hover:text-slate-900 transition';
      }
      if (yearlyBtn) {
        yearlyBtn.className = 'py-1.5 px-3 text-xs font-bold rounded-md bg-white text-amber-700 shadow-sm transition';
      }
      if (monthlyFields) monthlyFields.classList.add('hidden');
      if (yearlyFields) {
        yearlyFields.classList.remove('hidden');
        const startYearInput = document.getElementById(`${prefix}-client-start-year`);
        if (startYearInput && !startYearInput.value) {
          startYearInput.value = new Date().getFullYear();
        }
      }
    } else {
      if (monthlyBtn) {
        monthlyBtn.className = 'py-1.5 px-3 text-xs font-bold rounded-md bg-white text-blue-700 shadow-sm transition';
      }
      if (yearlyBtn) {
        yearlyBtn.className = 'py-1.5 px-3 text-xs font-bold rounded-md text-slate-600 hover:text-slate-900 transition';
      }
      if (monthlyFields) monthlyFields.classList.remove('hidden');
      if (yearlyFields) yearlyFields.classList.add('hidden');
    }
  }

  // Add Client
  function handleAddClient(e) {
    e.preventDefault();
    const name = document.getElementById('add-client-name').value.trim();
    const businessName = document.getElementById('add-client-business-name')?.value.trim() || '';
    const hasGst = !!(document.getElementById('add-client-has-gst') && document.getElementById('add-client-has-gst').checked);
    const gstNumber = hasGst ? (document.getElementById('add-client-gst-number')?.value.trim().toUpperCase() || '') : '';
    const billingCycle = document.getElementById('add-client-billing-cycle')?.value || 'monthly';
    const phone = document.getElementById('add-client-phone').value.trim();
    const email = document.getElementById('add-client-email').value.trim();
    const notes = document.getElementById('add-client-notes').value.trim();

    let fixedMonthlyAmount = 0;
    let fixedYearlyAmount = 0;
    let incomeTaxFee = 0;
    let incomeTaxNote = '';
    let extraFee = 0;
    let extraFeeNote = '';
    let startMonth = '';
    let startYear = '';

    if (billingCycle === 'yearly') {
      fixedYearlyAmount = Number(document.getElementById('add-client-yearly-fee').value);
      incomeTaxFee = Number(document.getElementById('add-client-yearly-income-tax-fee')?.value || 0);
      incomeTaxNote = document.getElementById('add-client-yearly-income-tax-note')?.value.trim() || '';
      extraFee = Number(document.getElementById('add-client-yearly-extra-fee')?.value || 0);
      extraFeeNote = document.getElementById('add-client-yearly-extra-fee-note')?.value.trim() || '';
      startYear = String(document.getElementById('add-client-start-year').value).trim();
      if (!name || isNaN(fixedYearlyAmount) || !startYear) {
        showToast('Please fill in required fields (Client Name, Yearly Fee, Start Year)', true);
        return;
      }
      startMonth = `${startYear}-01`;
    } else {
      fixedMonthlyAmount = Number(document.getElementById('add-client-fixed-fee').value);
      incomeTaxFee = Number(document.getElementById('add-client-income-tax-fee')?.value || 0);
      incomeTaxNote = document.getElementById('add-client-income-tax-note')?.value.trim() || '';
      extraFee = Number(document.getElementById('add-client-extra-fee')?.value || 0);
      extraFeeNote = document.getElementById('add-client-extra-fee-note')?.value.trim() || '';
      startMonth = document.getElementById('add-client-start-month').value;
      if (!name || isNaN(fixedMonthlyAmount) || !startMonth) {
        showToast('Please fill in required fields (Client Name, Monthly Fee, Start Month)', true);
        return;
      }
      startYear = startMonth.split('-')[0];
    }

    const newClient = {
      id: 'cli_' + Date.now(),
      name,
      businessName,
      billingCycle,
      hasGst,
      gstNumber,
      fixedMonthlyAmount,
      fixedYearlyAmount,
      incomeTaxFee: isNaN(incomeTaxFee) ? 0 : incomeTaxFee,
      incomeTaxNote,
      extraFee: isNaN(extraFee) ? 0 : extraFee,
      extraFeeNote,
      startMonth,
      startYear,
      phone,
      email,
      notes,
      status: 'active',
      createdAt: new Date().toISOString(),
      monthOverrides: {},
      payments: [],
    };

    state.clients.push(newClient);
    saveData();
    closeModal('addClientModal');
    e.target.reset();
    setBillingCycle('add', 'monthly');
    const gstCheck = document.getElementById('add-client-has-gst');
    if (gstCheck) {
      gstCheck.checked = false;
      toggleGstField('add');
    }
    const displayName = businessName ? `${businessName} (${name})` : name;
    showToast(`Client "${displayName}" added successfully!`);

    viewClientDetail(newClient.id);
  }

  // Edit Client
  function openEditClientModal() {
    const client = state.clients.find(c => c.id === state.activeClientId);
    if (!client) return;

    document.getElementById('edit-client-id').value = client.id;
    document.getElementById('edit-client-name').value = client.name;
    const bizInput = document.getElementById('edit-client-business-name');
    if (bizInput) bizInput.value = client.businessName || '';

    // GST setup
    const hasGst = !!(client.hasGst || (client.gstNumber && client.gstNumber.trim().length > 0));
    const gstCheck = document.getElementById('edit-client-has-gst');
    const gstContainer = document.getElementById('edit-client-gst-container');
    const gstInput = document.getElementById('edit-client-gst-number');
    if (gstCheck) gstCheck.checked = hasGst;
    if (gstInput) gstInput.value = client.gstNumber || '';
    if (gstContainer) {
      if (hasGst) gstContainer.classList.remove('hidden');
      else gstContainer.classList.add('hidden');
    }

    // Billing frequency setup
    const cycle = client.billingCycle === 'yearly' ? 'yearly' : 'monthly';
    setBillingCycle('edit', cycle);

    if (cycle === 'yearly') {
      const yearlyFeeInput = document.getElementById('edit-client-yearly-fee');
      const startYearInput = document.getElementById('edit-client-start-year');
      const yearlyItFeeInput = document.getElementById('edit-client-yearly-income-tax-fee');
      const yearlyItNoteInput = document.getElementById('edit-client-yearly-income-tax-note');
      const yearlyExtraFeeInput = document.getElementById('edit-client-yearly-extra-fee');
      const yearlyExtraFeeNoteInput = document.getElementById('edit-client-yearly-extra-fee-note');
      if (yearlyFeeInput) yearlyFeeInput.value = client.fixedYearlyAmount || client.fixedMonthlyAmount || 0;
      if (startYearInput) startYearInput.value = client.startYear || (client.startMonth ? client.startMonth.split('-')[0] : new Date().getFullYear());
      if (yearlyItFeeInput) yearlyItFeeInput.value = client.incomeTaxFee || 0;
      if (yearlyItNoteInput) yearlyItNoteInput.value = client.incomeTaxNote || '';
      if (yearlyExtraFeeInput) yearlyExtraFeeInput.value = client.extraFee || 0;
      if (yearlyExtraFeeNoteInput) yearlyExtraFeeNoteInput.value = client.extraFeeNote || '';
    } else {
      const fixedFeeInput = document.getElementById('edit-client-fixed-fee');
      const startMonthInput = document.getElementById('edit-client-start-month');
      const itFeeInput = document.getElementById('edit-client-income-tax-fee');
      const itNoteInput = document.getElementById('edit-client-income-tax-note');
      const extraFeeInput = document.getElementById('edit-client-extra-fee');
      const extraFeeNoteInput = document.getElementById('edit-client-extra-fee-note');
      if (fixedFeeInput) fixedFeeInput.value = client.fixedMonthlyAmount || 0;
      if (startMonthInput) startMonthInput.value = client.startMonth || getCurrentYearMonth();
      if (itFeeInput) itFeeInput.value = client.incomeTaxFee || 0;
      if (itNoteInput) itNoteInput.value = client.incomeTaxNote || '';
      if (extraFeeInput) extraFeeInput.value = client.extraFee || 0;
      if (extraFeeNoteInput) extraFeeNoteInput.value = client.extraFeeNote || '';
    }

    document.getElementById('edit-client-phone').value = client.phone || '';
    document.getElementById('edit-client-email').value = client.email || '';
    document.getElementById('edit-client-status').value = client.status || 'active';
    document.getElementById('edit-client-notes').value = client.notes || '';

    openModal('editClientModal');
  }

  function handleSaveEditClient(e) {
    e.preventDefault();
    const clientId = document.getElementById('edit-client-id').value;
    const client = state.clients.find(c => c.id === clientId);
    if (!client) return;

    const name = document.getElementById('edit-client-name').value.trim();
    const businessName = document.getElementById('edit-client-business-name')?.value.trim() || '';
    const hasGst = !!(document.getElementById('edit-client-has-gst') && document.getElementById('edit-client-has-gst').checked);
    const gstNumber = hasGst ? (document.getElementById('edit-client-gst-number')?.value.trim().toUpperCase() || '') : '';
    const billingCycle = document.getElementById('edit-client-billing-cycle')?.value || 'monthly';

    client.name = name;
    client.businessName = businessName;
    client.hasGst = hasGst;
    client.gstNumber = gstNumber;
    client.billingCycle = billingCycle;

    if (billingCycle === 'yearly') {
      const fee = Number(document.getElementById('edit-client-yearly-fee').value);
      const startYear = String(document.getElementById('edit-client-start-year').value).trim();
      const incomeTaxFee = Number(document.getElementById('edit-client-yearly-income-tax-fee')?.value || 0);
      const incomeTaxNote = document.getElementById('edit-client-yearly-income-tax-note')?.value.trim() || '';
      const extraFee = Number(document.getElementById('edit-client-yearly-extra-fee')?.value || 0);
      const extraFeeNote = document.getElementById('edit-client-yearly-extra-fee-note')?.value.trim() || '';
      client.fixedYearlyAmount = fee;
      client.startYear = startYear;
      client.startMonth = `${startYear}-01`;
      client.fixedMonthlyAmount = 0;
      client.incomeTaxFee = isNaN(incomeTaxFee) ? 0 : incomeTaxFee;
      client.incomeTaxNote = incomeTaxNote;
      client.extraFee = isNaN(extraFee) ? 0 : extraFee;
      client.extraFeeNote = extraFeeNote;
    } else {
      const fee = Number(document.getElementById('edit-client-fixed-fee').value);
      const startMonth = document.getElementById('edit-client-start-month').value;
      const incomeTaxFee = Number(document.getElementById('edit-client-income-tax-fee')?.value || 0);
      const incomeTaxNote = document.getElementById('edit-client-income-tax-note')?.value.trim() || '';
      const extraFee = Number(document.getElementById('edit-client-extra-fee')?.value || 0);
      const extraFeeNote = document.getElementById('edit-client-extra-fee-note')?.value.trim() || '';
      client.fixedMonthlyAmount = fee;
      client.startMonth = startMonth;
      client.startYear = startMonth ? startMonth.split('-')[0] : '';
      client.incomeTaxFee = isNaN(incomeTaxFee) ? 0 : incomeTaxFee;
      client.incomeTaxNote = incomeTaxNote;
      client.extraFee = isNaN(extraFee) ? 0 : extraFee;
      client.extraFeeNote = extraFeeNote;
    }

    client.phone = document.getElementById('edit-client-phone').value.trim();
    client.email = document.getElementById('edit-client-email').value.trim();
    client.status = document.getElementById('edit-client-status').value;
    client.notes = document.getElementById('edit-client-notes').value.trim();

    saveData();
    closeModal('editClientModal');
    showToast('Client details updated');
    renderClientDetail(clientId);
  }

  function handleDeleteClient() {
    const client = state.clients.find(c => c.id === state.activeClientId);
    if (!client) return;

    if (confirm(`Are you sure you want to permanently delete "${client.name}" and all their payment records?`)) {
      state.clients = state.clients.filter(c => c.id !== client.id);
      saveData();
      closeModal('editClientModal');
      showToast(`Client "${client.name}" deleted`);
      showView('clients');
    }
  }

  // Business Profile Settings
  function openEditBusinessProfileModal() {
    const nameInput = document.getElementById('business-name-input');
    const addressInput = document.getElementById('business-address-input');
    const phoneInput = document.getElementById('business-phone-input');
    const emailInput = document.getElementById('business-email-input');

    if (nameInput) nameInput.value = state.settings.businessName || '';
    if (addressInput) addressInput.value = state.settings.businessAddress || '';
    if (phoneInput) phoneInput.value = state.settings.businessPhone || '';
    if (emailInput) emailInput.value = state.settings.businessEmail || '';

    openModal('editBusinessProfileModal');
  }

  async function handleSaveBusinessProfile(e) {
    if (e && e.preventDefault) e.preventDefault();
    const nameInput = document.getElementById('business-name-input');
    const addressInput = document.getElementById('business-address-input');
    const phoneInput = document.getElementById('business-phone-input');
    const emailInput = document.getElementById('business-email-input');

    const name = nameInput ? nameInput.value.trim() : '';
    const address = addressInput ? addressInput.value.trim() : '';
    const phone = phoneInput ? phoneInput.value.trim() : '';
    const email = emailInput ? emailInput.value.trim() : '';

    state.settings.businessName = name || 'My Business';
    state.settings.businessAddress = address;
    state.settings.businessPhone = phone;
    state.settings.businessEmail = email;
    state.settings.lastModified = Date.now();

    // 1. Immediately update visual banner on Dashboard
    updateBusinessProfileBanner();
    renderDashboard();

    // 2. Persist to localStorage immediately
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.clients));
    } catch (err) {
      console.warn('LocalStorage error:', err);
    }

    // 3. Close the modal
    closeModal('editBusinessProfileModal');

    // 4. Cancel debounced timer to avoid duplicate sync
    if (syncDebounceTimer) {
      clearTimeout(syncDebounceTimer);
      syncDebounceTimer = null;
    }

    // 5. Trigger immediate live sync to database
    showToast('Saving and syncing business profile...');
    const result = await syncToCloud({ force: true });

    if (result && result.success) {
      if (result.provider === 'supabase') {
        showToast('✅ Business profile updated and synced to Supabase!');
      } else if (result.provider === 'bigrock') {
        showToast('✅ Business profile updated and synced to BigRock database!');
      } else if (result.provider === 'local_server') {
        showToast('✅ Business profile updated and synced to server database!');
      } else {
        showToast('✅ Business profile saved locally!');
      }
    } else if (result && !result.success) {
      showToast(`⚠️ Saved locally, but database sync error: ${result.error || 'Check connection'}`, true);
    } else {
      showToast('✅ Business profile saved!');
    }
  }

  function toggleSettingsDropdown(event) {
    if (event) event.stopPropagation();
    const menu = document.getElementById('settings-dropdown-menu');
    if (menu) {
      menu.classList.toggle('hidden');
    }
  }

  // Override / Change Fee for a Particular Month or Year
  function openOverrideMonthModal(clientId, specificPeriod = null) {
    const client = state.clients.find(c => c.id === clientId);
    if (!client) return;

    const isYearly = client.billingCycle === 'yearly';
    document.getElementById('override-client-id').value = client.id;
    document.getElementById('override-client-name').value = client.businessName ? `${client.businessName} (${client.name})` : client.name;
    const defFee = isYearly ? (client.fixedYearlyAmount || client.fixedMonthlyAmount || 0) : (client.fixedMonthlyAmount || 0);
    document.getElementById('override-default-fee-hint').textContent = `${formatCurrency(defFee)} / ${isYearly ? 'yr' : 'mo'}`;

    const monthInput = document.getElementById('override-month');
    const overrideLabel = monthInput?.parentElement?.querySelector('label');

    if (isYearly) {
      if (overrideLabel) overrideLabel.textContent = 'Select Particular Year *';
      monthInput.type = 'number';
      monthInput.min = '2000';
      monthInput.max = '2099';
      monthInput.step = '1';
    } else {
      if (overrideLabel) overrideLabel.textContent = 'Select Particular Month *';
      monthInput.type = 'month';
      monthInput.removeAttribute('min');
      monthInput.removeAttribute('max');
      monthInput.removeAttribute('step');
    }

    const targetPeriod = specificPeriod || (isYearly ? String(new Date().getFullYear()) : getLastMonth());
    monthInput.value = targetPeriod;

    onOverrideMonthChange(targetPeriod);
    openModal('overrideMonthModal');
  }

  function onOverrideMonthChange(selectedMonth) {
    const clientId = document.getElementById('override-client-id').value;
    const client = state.clients.find(c => c.id === clientId);
    if (!client || !selectedMonth) return;

    const isYearly = client.billingCycle === 'yearly';
    const amountInput = document.getElementById('override-amount');
    const noteInput = document.getElementById('override-note');
    const resetBtn = document.getElementById('btn-reset-month-override');

    const existingOverride = client.monthOverrides && (client.monthOverrides[selectedMonth] || (isYearly ? client.monthOverrides[`${selectedMonth}-01`] : null));
    if (existingOverride && existingOverride.amount !== undefined) {
      amountInput.value = existingOverride.amount;
      noteInput.value = existingOverride.note || '';
      if (resetBtn) resetBtn.classList.remove('hidden');
    } else {
      const isStart = isYearly ? (selectedMonth === (client.startYear || (client.startMonth ? client.startMonth.split('-')[0] : ''))) : (selectedMonth === (client.startMonth || ''));
      const extraAmt = isStart ? Number(client.extraFee || 0) : 0;
      const itAmt = isStart ? Number(client.incomeTaxFee || 0) : 0;
      const baseFee = isYearly ? (client.fixedYearlyAmount || client.fixedMonthlyAmount || 0) : (client.fixedMonthlyAmount || 0);
      amountInput.value = baseFee + extraAmt + itAmt;
      noteInput.value = '';
      if (resetBtn) resetBtn.classList.add('hidden');
    }
  }

  function handleSaveMonthOverride(e) {
    e.preventDefault();
    const clientId = document.getElementById('override-client-id').value;
    const client = state.clients.find(c => c.id === clientId);
    if (!client) return;

    const period = document.getElementById('override-month').value;
    const newAmount = Number(document.getElementById('override-amount').value);
    const note = document.getElementById('override-note').value.trim();

    if (!client.monthOverrides) client.monthOverrides = {};

    client.monthOverrides[period] = {
      amount: newAmount,
      note,
    };

    saveData();
    closeModal('overrideMonthModal');
    const isYearly = client.billingCycle === 'yearly';
    showToast(`Fee for ${isYearly ? `Year ${period}` : formatMonthName(period)} updated to ${formatCurrency(newAmount)}`);

    if (state.activeClientId === clientId) {
      renderClientDetail(clientId);
    } else {
      renderDashboard();
    }
  }

  function handleResetMonthOverride() {
    const clientId = document.getElementById('override-client-id').value;
    const client = state.clients.find(c => c.id === clientId);
    if (!client) return;

    const period = document.getElementById('override-month').value;
    if (client.monthOverrides) {
      delete client.monthOverrides[period];
      delete client.monthOverrides[`${period}-01`];
      saveData();
      closeModal('overrideMonthModal');
      const isYearly = client.billingCycle === 'yearly';
      showToast(`Fee for ${isYearly ? `Year ${period}` : formatMonthName(period)} reset to default fixed amount`);
      if (state.activeClientId === clientId) {
        renderClientDetail(clientId);
      }
    }
  }

  // Record Payment Modal (Subtracts from total amount)
  function openRecordPaymentModal(preselectedClientId = null) {
    const clientSelect = document.getElementById('payment-client-id');
    if (!clientSelect) return;

    clientSelect.innerHTML = state.clients
      .map(c => {
        const isYearly = c.billingCycle === 'yearly';
        const feeStr = isYearly ? `${formatCurrency(c.fixedYearlyAmount || c.fixedMonthlyAmount)}/yr` : `${formatCurrency(c.fixedMonthlyAmount)}/mo`;
        const displayName = c.businessName ? `${c.businessName} (${c.name})` : c.name;
        return `<option value="${c.id}">${escapeHtml(displayName)} (${feeStr})</option>`;
      })
      .join('');

    const activeId = preselectedClientId || (state.clients.length > 0 ? state.clients[0].id : null);
    if (activeId) {
      clientSelect.value = activeId;
    }

    document.getElementById('payment-date').value = getTodayDate();
    document.getElementById('payment-amount').value = '';
    document.getElementById('payment-reference').value = '';
    document.getElementById('payment-note').value = '';

    onPaymentClientChange(clientSelect.value);
    openModal('recordPaymentModal');
  }

  function openRecordPaymentForMonth(clientId, month, balanceAmount) {
    openRecordPaymentModal(clientId);
    const amtInput = document.getElementById('payment-amount');
    const targetMonthSelect = document.getElementById('payment-target-month');
    const noteInput = document.getElementById('payment-note');

    if (amtInput) amtInput.value = balanceAmount;
    if (targetMonthSelect) targetMonthSelect.value = month;
    if (noteInput) noteInput.value = `Payment for ${formatMonthName(month)}`;
  }

  let activePaymentClientBalance = 0;

  function toggleSettlementDiscount(isChecked) {
    const fields = document.getElementById('settlement-discount-fields');
    const badge = document.getElementById('settlement-badge');
    const discountInput = document.getElementById('payment-discount-amount');
    const amtInput = document.getElementById('payment-amount');

    if (fields) {
      if (isChecked) {
        fields.classList.remove('hidden');
        if (badge) badge.classList.remove('hidden');
        if (amtInput && (!amtInput.value || Number(amtInput.value) <= 0)) {
          amtInput.value = activePaymentClientBalance > 0 ? activePaymentClientBalance : 0;
        }
        onPaymentAmountInput();
      } else {
        fields.classList.add('hidden');
        if (badge) badge.classList.add('hidden');
        if (discountInput) discountInput.value = '';
      }
    }
  }

  function setFullSettlementMode() {
    const checkbox = document.getElementById('payment-is-settlement');
    const amtInput = document.getElementById('payment-amount');
    const discountInput = document.getElementById('payment-discount-amount');

    if (activePaymentClientBalance <= 0) {
      showToast('Client has no outstanding balance to settle', true);
      return;
    }

    if (checkbox) checkbox.checked = true;
    toggleSettlementDiscount(true);

    if (amtInput) amtInput.value = activePaymentClientBalance;
    if (discountInput) discountInput.value = 0;

    updateSettlementPreview();
  }

  function onPaymentAmountInput() {
    const isSettlement = document.getElementById('payment-is-settlement')?.checked;
    if (!isSettlement) return;

    const amtInput = document.getElementById('payment-amount');
    const discountInput = document.getElementById('payment-discount-amount');
    const amt = Number(amtInput?.value || 0);

    if (activePaymentClientBalance > 0) {
      const diff = Math.max(0, activePaymentClientBalance - amt);
      if (discountInput) discountInput.value = diff > 0 ? diff : 0;
    }

    updateSettlementPreview();
  }

  function onSettlementDiscountInput() {
    const isSettlement = document.getElementById('payment-is-settlement')?.checked;
    if (!isSettlement) return;

    const amtInput = document.getElementById('payment-amount');
    const discountInput = document.getElementById('payment-discount-amount');
    const discount = Number(discountInput?.value || 0);

    if (activePaymentClientBalance > 0) {
      const remainingAmt = Math.max(0, activePaymentClientBalance - discount);
      if (amtInput) amtInput.value = remainingAmt;
    }

    updateSettlementPreview();
  }

  function updateSettlementPreview() {
    const amt = Number(document.getElementById('payment-amount')?.value || 0);
    const discount = Number(document.getElementById('payment-discount-amount')?.value || 0);
    const totalSettled = amt + discount;
    const finalBal = Math.max(0, activePaymentClientBalance - totalSettled);

    const totalSettledPreview = document.getElementById('settlement-total-settled-preview');
    const remainingPreview = document.getElementById('settlement-remaining-balance-preview');
    const noteInput = document.getElementById('payment-note');

    if (totalSettledPreview) {
      totalSettledPreview.textContent = `${formatCurrency(totalSettled)} (${formatCurrency(amt)} paid + ${formatCurrency(discount)} waiver)`;
    }

    if (remainingPreview) {
      if (finalBal === 0) {
        remainingPreview.className = 'text-emerald-600 font-black';
        remainingPreview.textContent = `${formatCurrency(0)} (Account 100% Fully Settled ✓)`;
      } else {
        remainingPreview.className = 'text-amber-700 font-black';
        remainingPreview.textContent = `${formatCurrency(finalBal)} remaining`;
      }
    }

    if (noteInput && (!noteInput.value || noteInput.value.startsWith('Full & final settlement') || noteInput.value.startsWith('Full balance settlement'))) {
      if (discount > 0) {
        noteInput.value = `Full & final settlement (${formatCurrency(amt)} paid + ${formatCurrency(discount)} discount)`;
      } else {
        noteInput.value = `Full balance settlement (${formatCurrency(amt)})`;
      }
    }
  }

  function onPaymentClientChange(clientId) {
    const client = state.clients.find(c => c.id === clientId);
    const balanceHint = document.getElementById('payment-client-balance-hint');
    const targetMonthSelect = document.getElementById('payment-target-month');
    const quickFullSettleBtn = document.getElementById('btn-quick-full-settle');
    const settlementCheck = document.getElementById('payment-is-settlement');
    const discountInput = document.getElementById('payment-discount-amount');
    const discountNoteInput = document.getElementById('payment-discount-note');

    if (!client) {
      if (balanceHint) balanceHint.textContent = '';
      activePaymentClientBalance = 0;
      return;
    }

    const ledger = calculateClientLedger(client);
    activePaymentClientBalance = Math.max(0, ledger.finalBalance);

    if (settlementCheck) settlementCheck.checked = false;
    toggleSettlementDiscount(false);
    if (discountInput) discountInput.value = '';
    if (discountNoteInput) discountNoteInput.value = '';

    if (quickFullSettleBtn) {
      if (ledger.finalBalance > 0) {
        quickFullSettleBtn.classList.remove('hidden');
        quickFullSettleBtn.textContent = `⚡ Settle Full Balance (${formatCurrency(ledger.finalBalance)})`;
      } else {
        quickFullSettleBtn.classList.add('hidden');
      }
    }

    if (balanceHint) {
      if (ledger.finalBalance > 0) {
        balanceHint.innerHTML = `<span class="text-red-600 font-bold">Outstanding Balance: ${formatCurrency(ledger.finalBalance)}</span> (${ledger.unpaidMonthsCount} months pending)`;
      } else if (ledger.finalBalance === 0) {
        balanceHint.innerHTML = `<span class="text-emerald-600 font-bold">Account is currently settled (₹0 balance)</span>`;
      } else {
        balanceHint.innerHTML = `<span class="text-blue-600 font-bold">Client has advance credit: ${formatCurrency(Math.abs(ledger.finalBalance))}</span>`;
      }
    }

    // Populate target months dropdown
    if (targetMonthSelect) {
      targetMonthSelect.innerHTML = `
        <option value="">Automatic (Applies to Oldest Unpaid Months First - FIFO)</option>
        ${ledger.monthlyBreakdown
          .map(
            m =>
              `<option value="${m.month}">${m.fullMonthName} (Fee: ${formatCurrency(m.billed)}${m.balance > 0 ? ` &bull; Bal: ${formatCurrency(m.balance)}` : ' &bull; Paid'})</option>`
          )
          .join('')}
      `;
    }

    // Pre-fill amount with pending balance if > 0
    const amtInput = document.getElementById('payment-amount');
    if (amtInput && ledger.finalBalance > 0) {
      amtInput.value = ledger.finalBalance;
    }
  }

  function handleRecordPayment(e) {
    e.preventDefault();
    const clientId = document.getElementById('payment-client-id').value;
    const client = state.clients.find(c => c.id === clientId);
    if (!client) return;

    const amount = Number(document.getElementById('payment-amount').value);
    const date = document.getElementById('payment-date').value;
    const method = document.getElementById('payment-method').value;
    const reference = document.getElementById('payment-reference').value.trim();
    const targetMonth = document.getElementById('payment-target-month').value;
    const note = document.getElementById('payment-note').value.trim();

    const isSettlement = !!document.getElementById('payment-is-settlement')?.checked;
    const discount = isSettlement ? (Number(document.getElementById('payment-discount-amount')?.value) || 0) : 0;
    const discountNote = isSettlement ? (document.getElementById('payment-discount-note')?.value.trim() || '') : '';

    if (isNaN(amount) || (amount <= 0 && discount <= 0) || !date) {
      showToast('Please enter a valid amount or discount', true);
      return;
    }

    if (!client.payments) client.payments = [];

    const newPayment = {
      id: 'pay_' + Date.now(),
      amount,
      discount,
      isSettlement,
      discountNote,
      date,
      method,
      reference,
      targetMonth: targetMonth || null,
      note,
      createdAt: new Date().toISOString(),
    };

    client.payments.push(newPayment);
    saveData();
    closeModal('recordPaymentModal');

    // Reset settlement state
    const settleCheck = document.getElementById('payment-is-settlement');
    if (settleCheck) settleCheck.checked = false;
    toggleSettlementDiscount(false);

    if (discount > 0) {
      showToast(`Settlement recorded! ${formatCurrency(amount)} received + ${formatCurrency(discount)} discount applied.`);
    } else {
      showToast(`Payment of ${formatCurrency(amount)} recorded and subtracted from balance!`);
    }

    if (state.activeClientId === clientId) {
      renderClientDetail(clientId);
    } else {
      renderDashboard();
    }
  }

  // Edit Payment Transaction
  function openEditPaymentModal(clientId, paymentId) {
    const cId = clientId || state.activeClientId;
    const client = state.clients.find(c => String(c.id) === String(cId));
    if (!client || !client.payments) return;

    if (Array.isArray(client.payments)) {
      client.payments.forEach((p, idx) => {
        if (!p.id) p.id = 'pay_' + (p.createdAt ? new Date(p.createdAt).getTime() : Date.now()) + '_' + idx;
      });
    }

    let payment = client.payments.find(p => String(p.id) === String(paymentId));
    if (!payment && client.payments.length > 0) {
      payment = client.payments.find((p, idx) => String(idx) === String(paymentId)) || client.payments[client.payments.length - 1];
    }
    if (!payment) return;

    document.getElementById('edit-payment-client-id').value = client.id;
    document.getElementById('edit-payment-id').value = payment.id;

    const nameEl = document.getElementById('edit-payment-client-name');
    if (nameEl) {
      nameEl.textContent = client.businessName ? `${client.businessName} (${client.name})` : client.name;
    }

    document.getElementById('edit-payment-amount').value = payment.amount ?? '';
    document.getElementById('edit-payment-date').value = payment.date || '';
    document.getElementById('edit-payment-method').value = payment.method || 'Cash';
    document.getElementById('edit-payment-reference').value = payment.reference || '';
    document.getElementById('edit-payment-note').value = payment.note || '';

    // Populate target month options
    const targetSelect = document.getElementById('edit-payment-target-month');
    if (targetSelect) {
      targetSelect.innerHTML = '<option value="">Automatic (Applies to Oldest Unpaid Months First - FIFO)</option>';
      const isYearly = client.billingCycle === 'yearly';
      const ledger = calculateClientLedger(client);

      if (isYearly) {
        (ledger.years || []).forEach(y => {
          targetSelect.innerHTML += `<option value="${y}">Year ${y}</option>`;
        });
      } else {
        (ledger.months || []).forEach(m => {
          targetSelect.innerHTML += `<option value="${m}">${formatFullMonthName(m)}</option>`;
        });
      }
      targetSelect.value = payment.targetMonth || '';
    }

    // Discount / Settlement details
    const hasDiscount = Boolean(payment.isSettlement || (Number(payment.discount || 0) > 0));
    const discountCheck = document.getElementById('edit-payment-is-settlement');
    if (discountCheck) discountCheck.checked = hasDiscount;
    toggleEditSettlementDiscount(hasDiscount);

    const discountAmountInput = document.getElementById('edit-payment-discount-amount');
    const discountNoteInput = document.getElementById('edit-payment-discount-note');
    if (discountAmountInput) discountAmountInput.value = payment.discount || 0;
    if (discountNoteInput) discountNoteInput.value = payment.discountNote || '';

    openModal('editPaymentModal');
  }

  function toggleEditSettlementDiscount(isChecked) {
    const container = document.getElementById('edit-payment-discount-container');
    if (!container) return;
    if (isChecked) {
      container.classList.remove('hidden');
    } else {
      container.classList.add('hidden');
    }
  }

  function handleSaveEditPayment(e) {
    e.preventDefault();
    const clientId = document.getElementById('edit-payment-client-id').value;
    const paymentId = document.getElementById('edit-payment-id').value;

    const client = state.clients.find(c => c.id === clientId);
    if (!client || !client.payments) return;

    const payment = client.payments.find(p => p.id === paymentId);
    if (!payment) return;

    const amount = Number(document.getElementById('edit-payment-amount').value);
    const date = document.getElementById('edit-payment-date').value;
    const method = document.getElementById('edit-payment-method').value;
    const reference = document.getElementById('edit-payment-reference').value.trim();
    const targetMonth = document.getElementById('edit-payment-target-month').value || null;
    const note = document.getElementById('edit-payment-note').value.trim();

    const isSettlement = !!document.getElementById('edit-payment-is-settlement')?.checked;
    const discount = isSettlement ? (Number(document.getElementById('edit-payment-discount-amount')?.value) || 0) : 0;
    const discountNote = isSettlement ? (document.getElementById('edit-payment-discount-note')?.value.trim() || '') : '';

    if (isNaN(amount) || (amount <= 0 && discount <= 0) || !date) {
      showToast('Please enter a valid payment amount and date', true);
      return;
    }

    payment.amount = amount;
    payment.date = date;
    payment.method = method;
    payment.reference = reference;
    payment.targetMonth = targetMonth;
    payment.note = note;
    payment.isSettlement = isSettlement;
    payment.discount = discount;
    payment.discountNote = discountNote;
    payment.updatedAt = new Date().toISOString();

    saveData();
    closeModal('editPaymentModal');
    showToast('Payment transaction updated successfully!');

    if (state.activeClientId === clientId) {
      renderClientDetail(clientId);
    } else {
      renderDashboard();
    }
  }

  function handleDeletePayment(clientId, paymentId) {
    const cId = clientId || state.activeClientId;
    const client = state.clients.find(c => String(c.id) === String(cId));
    if (!client || !client.payments) return;

    if (Array.isArray(client.payments)) {
      client.payments.forEach((p, idx) => {
        if (!p.id) p.id = 'pay_' + (p.createdAt ? new Date(p.createdAt).getTime() : Date.now()) + '_' + idx;
      });
    }

    if (confirm('Are you sure you want to delete this payment record? Balance will be updated accordingly.')) {
      let filtered = client.payments.filter(p => String(p.id) !== String(paymentId));
      if (filtered.length === client.payments.length && !isNaN(Number(paymentId))) {
        filtered = client.payments.filter((_, idx) => String(idx) !== String(paymentId));
      }
      client.payments = filtered;
      saveData();
      showToast('Payment record deleted');
      renderClientDetail(client.id);
    }
  }

  // ==================== PRINT STATEMENT / INVOICE ====================
  function openPrintStatementModal() {
    const client = state.clients.find(c => c.id === state.activeClientId);
    if (!client) return;

    const container = document.getElementById('printable-statement-content');
    if (!container) return;

    const ledger = calculateClientLedger(client);

    container.innerHTML = `
      <div class="space-y-6">
        <!-- Header -->
        <div class="flex justify-between items-start border-b border-slate-200 pb-6">
          <div>
            <h1 class="text-2xl font-black text-slate-900">${escapeHtml(state.settings.businessName)}</h1>
            <p class="text-xs text-slate-500 mt-1">${escapeHtml(state.settings.businessAddress)}</p>
            <p class="text-xs text-slate-500">Phone: ${escapeHtml(state.settings.businessPhone)} &bull; Email: ${escapeHtml(state.settings.businessEmail)}</p>
          </div>
          <div class="text-right">
            <span class="inline-block px-3 py-1 bg-blue-50 text-blue-800 text-xs font-bold rounded-lg uppercase tracking-wider">
              Client Account Statement
            </span>
            <p class="text-xs text-slate-400 mt-2">Statement Date: ${formatDate(getTodayDate())}</p>
          </div>
        </div>

        <!-- Billed To & Summary Cards -->
        <div class="grid grid-cols-2 gap-6 bg-slate-50 p-4 rounded-xl border border-slate-200">
          <div>
            <span class="text-xs font-bold uppercase text-slate-400">Statement For (Client):</span>
            <h2 class="text-lg font-bold text-slate-900 mt-1">${escapeHtml(client.businessName || client.name)}</h2>
            ${client.businessName ? `<p class="text-xs text-slate-700 font-semibold">Contact Person: ${escapeHtml(client.name)}</p>` : ''}
            <p class="text-xs text-slate-600">${escapeHtml(client.phone || '')}</p>
            <p class="text-xs text-slate-600">${escapeHtml(client.email || '')}</p>
            <p class="text-xs text-slate-500 mt-1">Billing Started: ${formatMonthName(client.startMonth)} &bull; Fixed Fee: ${formatCurrency(client.fixedMonthlyAmount)}/mo${client.incomeTaxFee > 0 ? ` &bull; IT Fee: ${formatCurrency(client.incomeTaxFee)}` : ''}${client.extraFee > 0 ? ` &bull; Extra Fee: ${formatCurrency(client.extraFee)}` : ''}</p>
          </div>
          <div class="text-right flex flex-col justify-center">
            <span class="text-xs font-bold uppercase text-slate-400">Final Outstanding Balance:</span>
            <div class="text-2xl font-black ${ledger.finalBalance > 0 ? 'text-red-600' : 'text-emerald-600'}">
              ${formatCurrency(ledger.finalBalance)}
            </div>
            <p class="text-xs font-medium text-slate-500 mt-1">
              Total Billed: ${formatCurrency(ledger.totalBilled)} | Total Paid: ${formatCurrency(ledger.totalPaid)}
            </p>
          </div>
        </div>

        <!-- Month by Month Breakdown Table -->
        <div>
          <h3 class="text-sm font-bold text-slate-900 uppercase tracking-wider mb-2">Month-by-Month Dues & Balance Status</h3>
          <table class="w-full text-left text-xs border border-slate-200">
            <thead class="bg-slate-100 font-semibold text-slate-700">
              <tr>
                <th class="py-2 px-3 border border-slate-200">Billing Month</th>
                <th class="py-2 px-3 border border-slate-200">Monthly Fee</th>
                <th class="py-2 px-3 border border-slate-200">Fee Note</th>
                <th class="py-2 px-3 border border-slate-200">Amount Paid</th>
                <th class="py-2 px-3 border border-slate-200 text-right">Balance Due</th>
                <th class="py-2 px-3 border border-slate-200 text-center">Status</th>
              </tr>
            </thead>
            <tbody>
              ${ledger.monthlyBreakdown
                .map(
                  m => `
                <tr>
                  <td class="py-2 px-3 border border-slate-200 font-medium">${m.fullMonthName}</td>
                  <td class="py-2 px-3 border border-slate-200 font-semibold">${formatCurrency(m.billed)}</td>
                  <td class="py-2 px-3 border border-slate-200 text-slate-500">${escapeHtml(m.overrideNote || (m.isOverridden ? 'Custom Fee' : 'Fixed Monthly Fee'))}</td>
                  <td class="py-2 px-3 border border-slate-200 text-emerald-700">${formatCurrency(m.paid)}</td>
                  <td class="py-2 px-3 border border-slate-200 text-right font-bold ${m.balance > 0 ? 'text-red-600' : 'text-slate-500'}">
                    ${formatCurrency(m.balance)}
                  </td>
                  <td class="py-2 px-3 border border-slate-200 text-center font-bold text-[10px]">
                    ${m.balance <= 0 ? 'PAID' : m.paid > 0 ? 'PARTIAL' : 'UNPAID'}
                  </td>
                </tr>
              `
                )
                .join('')}
            </tbody>
            <tfoot class="bg-slate-50 font-bold">
              <tr>
                <td colspan="3" class="py-2 px-3 border border-slate-200 text-right uppercase">Cumulative Totals:</td>
                <td class="py-2 px-3 border border-slate-200 text-emerald-700">
                  ${formatCurrency(ledger.totalPaid)}
                  ${ledger.totalDiscount > 0 ? `<div class="text-[10px] text-amber-800 font-semibold">+ Discount: ${formatCurrency(ledger.totalDiscount)}</div>` : ''}
                </td>
                <td class="py-2 px-3 border border-slate-200 text-right font-black ${ledger.finalBalance > 0 ? 'text-red-600' : 'text-slate-700'}">
                  ${formatCurrency(ledger.finalBalance)}
                </td>
                <td class="py-2 px-3 border border-slate-200"></td>
              </tr>
            </tfoot>
          </table>
        </div>

        <!-- Payment History Table -->
        <div>
          <h3 class="text-sm font-bold text-slate-900 uppercase tracking-wider mb-2">Payment Receipts History</h3>
          <table class="w-full text-left text-xs border border-slate-200">
            <thead class="bg-slate-100 font-semibold text-slate-700">
              <tr>
                <th class="py-2 px-3 border border-slate-200">Payment Date</th>
                <th class="py-2 px-3 border border-slate-200">Amount Given</th>
                <th class="py-2 px-3 border border-slate-200">Discount / Waiver</th>
                <th class="py-2 px-3 border border-slate-200">Total Settled</th>
                <th class="py-2 px-3 border border-slate-200">Method</th>
                <th class="py-2 px-3 border border-slate-200">Reference / Txn ID</th>
                <th class="py-2 px-3 border border-slate-200">Notes</th>
              </tr>
            </thead>
            <tbody>
              ${
                ledger.payments.length === 0
                  ? `<tr><td colspan="7" class="py-4 text-center text-slate-400">No payment receipts found</td></tr>`
                  : ledger.payments
                      .map(
                        p => `
                    <tr>
                      <td class="py-2 px-3 border border-slate-200">${formatDate(p.date)}</td>
                      <td class="py-2 px-3 border border-slate-200 font-bold text-emerald-700">+${formatCurrency(p.amount)}</td>
                      <td class="py-2 px-3 border border-slate-200 font-semibold text-amber-800">${Number(p.discount || 0) > 0 ? formatCurrency(p.discount) : '-'}</td>
                      <td class="py-2 px-3 border border-slate-200 font-bold text-slate-900">${formatCurrency((Number(p.amount) || 0) + (Number(p.discount) || 0))}</td>
                      <td class="py-2 px-3 border border-slate-200">${escapeHtml(p.method || 'Cash')}</td>
                      <td class="py-2 px-3 border border-slate-200 font-mono text-[11px]">${escapeHtml(p.reference || '--')}</td>
                      <td class="py-2 px-3 border border-slate-200 text-slate-600">${escapeHtml(p.note || '--')}</td>
                    </tr>
                  `
                      )
                      .join('')
              }
            </tbody>
          </table>
        </div>

        <!-- Footer / Signature -->
        <div class="pt-8 border-t border-slate-200 flex justify-between items-end text-xs text-slate-500">
          <div>
            <p>Thank you for your business!</p>
            <p class="text-[10px] text-slate-400 mt-1">Generated electronically via ClientLedger Pro</p>
          </div>
          <div class="text-center">
            <div class="w-40 border-b border-slate-400 pb-10"></div>
            <p class="mt-1 font-semibold text-slate-700">Authorized Signature</p>
          </div>
        </div>
      </div>
    `;

    openModal('printStatementModal');
  }

  // Helper for WhatsApp Phone Normalization
  function normalizeWhatsAppPhone(rawPhone) {
    if (!rawPhone) return '';
    let digits = String(rawPhone).replace(/\D/g, '');
    if (!digits) return '';
    if (digits.length === 11 && digits.startsWith('0')) {
      digits = digits.slice(1);
    }
    if (digits.length === 10) {
      digits = '91' + digits;
    }
    return digits;
  }

  // Active receipt context for modal WhatsApp button
  let activeReceiptContext = null;

  // ==================== PAYMENT RECEIPT / INVOICE PRINT ====================
  function printPaymentReceipt(clientId, paymentId) {
    const cId = clientId || state.activeClientId;
    const client = (state.clients || []).find(c => String(c.id) === String(cId));
    if (!client) {
      showToast('Client not found', true);
      return;
    }

    if (Array.isArray(client.payments)) {
      client.payments.forEach((p, idx) => {
        if (!p.id) p.id = 'pay_' + (p.createdAt ? new Date(p.createdAt).getTime() : Date.now()) + '_' + idx;
      });
    }

    let payment = (client.payments || []).find(p => String(p.id) === String(paymentId));
    if (!payment && client.payments && client.payments.length > 0) {
      payment = client.payments.find((p, idx) => String(idx) === String(paymentId)) || client.payments[client.payments.length - 1];
    }
    if (!payment) {
      showToast('Payment record not found', true);
      return;
    }

    activeReceiptContext = { clientId: client.id, paymentId: payment.id };

    const container = document.getElementById('printable-receipt-content');
    if (!container) return;

    const ledger = calculateClientLedger(client) || { totalBilled: 0, totalPaid: 0, finalBalance: 0 };
    const hasDiscount = Number(payment.discount || 0) > 0;
    const paidAmount = Number(payment.amount || 0);
    const discountAmount = Number(payment.discount || 0);
    const totalSettled = paidAmount + discountAmount;
    const receiptNo = payment.reference && payment.reference.trim() !== '--'
      ? payment.reference.trim()
      : `REC-${payment.id ? String(payment.id).slice(-6).toUpperCase() : '001'}`;

    const allocationDesc = payment.targetMonth
      ? `Allocated to Month: ${formatMonthName(payment.targetMonth)}`
      : 'Automatic Balance Credit (FIFO - Applied towards oldest outstanding month)';

    container.innerHTML = `
      <div class="space-y-6 text-slate-800">
        <!-- Top Header & Business Details -->
        <div class="flex justify-between items-start border-b-2 border-slate-900 pb-5">
          <div class="space-y-1">
            <span class="inline-block px-2.5 py-0.5 rounded text-[11px] font-black uppercase tracking-wider bg-emerald-100 text-emerald-800">
              Official Payment Voucher
            </span>
            <h1 class="text-2xl font-black text-slate-950 tracking-tight mt-1">${escapeHtml(state.settings.businessName || 'Digital CA Services')}</h1>
            ${state.settings.businessAddress ? `<p class="text-xs text-slate-600">${escapeHtml(state.settings.businessAddress)}</p>` : ''}
            <div class="text-xs text-slate-500 flex flex-wrap gap-x-3 gap-y-0.5 pt-0.5">
              ${state.settings.businessPhone ? `<span><strong>Phone:</strong> ${escapeHtml(state.settings.businessPhone)}</span>` : ''}
              ${state.settings.businessEmail ? `<span><strong>Email:</strong> ${escapeHtml(state.settings.businessEmail)}</span>` : ''}
            </div>
          </div>
          <div class="text-right">
            <h2 class="text-xl font-extrabold text-slate-900 uppercase tracking-wider">Payment Receipt</h2>
            <div class="mt-2 text-xs text-slate-600 space-y-1">
              <p><span class="font-bold text-slate-700">Receipt No:</span> <span class="font-mono font-bold text-slate-900">${escapeHtml(receiptNo)}</span></p>
              <p><span class="font-bold text-slate-700">Payment Date:</span> ${formatDate(payment.date)}</p>
              <p><span class="font-bold text-slate-700">Payment Mode:</span> <span class="font-semibold text-slate-900">${escapeHtml(payment.method || 'Cash')}</span></p>
            </div>
          </div>
        </div>

        <!-- Client Info & Receipt Summary Box -->
        <div class="grid grid-cols-2 gap-4 bg-slate-50 p-4 rounded-xl border border-slate-200">
          <div>
            <span class="text-[10px] font-black uppercase tracking-wider text-slate-400">Received From (Client):</span>
            <h3 class="text-base font-bold text-slate-900 mt-0.5">${escapeHtml(client.businessName || client.name)}</h3>
            ${client.businessName && client.name ? `<p class="text-xs text-slate-600 font-medium">Contact Person: ${escapeHtml(client.name)}</p>` : ''}
            <div class="text-xs text-slate-500 mt-1 space-y-0.5">
              ${client.phone ? `<p>Phone: ${escapeHtml(client.phone)}</p>` : ''}
              ${client.email ? `<p>Email: ${escapeHtml(client.email)}</p>` : ''}
              ${client.gstNumber ? `<p>GSTIN: <span class="font-mono">${escapeHtml(client.gstNumber)}</span></p>` : ''}
            </div>
          </div>
          <div class="text-right flex flex-col justify-center border-l border-slate-200 pl-4">
            <span class="text-[10px] font-black uppercase tracking-wider text-slate-400">Amount Received:</span>
            <div class="text-3xl font-black text-emerald-600 tracking-tight mt-0.5">
              ${formatCurrency(payment.amount)}
            </div>
            <p class="text-xs font-semibold text-slate-600 mt-1">
              Mode: ${escapeHtml(payment.method || 'Cash')}${payment.reference ? ` &bull; Ref: ${escapeHtml(payment.reference)}` : ''}
            </p>
          </div>
        </div>

        <!-- Particulars & Settlement Details Table -->
        <div class="border border-slate-200 rounded-xl overflow-hidden">
          <table class="w-full text-left text-xs">
            <thead class="bg-slate-100 font-bold text-slate-700 uppercase tracking-wider text-[11px] border-b border-slate-200">
              <tr>
                <th class="py-2.5 px-4">Description / Particulars</th>
                <th class="py-2.5 px-4">Allocation Details</th>
                <th class="py-2.5 px-4 text-right">Amount (₹)</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <tr>
                <td class="py-3 px-4 font-semibold text-slate-900">
                  Professional / Accounting Fee Payment
                  ${payment.note ? `<div class="text-[11px] text-slate-500 font-normal italic mt-0.5">Note: ${escapeHtml(payment.note)}</div>` : ''}
                </td>
                <td class="py-3 px-4 text-slate-600">
                  <span class="inline-block font-medium">${escapeHtml(allocationDesc)}</span>
                </td>
                <td class="py-3 px-4 text-right font-bold text-emerald-700 text-sm">
                  ${formatCurrency(payment.amount)}
                </td>
              </tr>
              ${hasDiscount ? `
              <tr class="bg-amber-50/50">
                <td class="py-2.5 px-4 font-medium text-amber-900">
                  Discount / Fee Waiver
                  ${payment.discountNote ? `<div class="text-[11px] text-amber-700 font-normal italic">${escapeHtml(payment.discountNote)}</div>` : ''}
                </td>
                <td class="py-2.5 px-4 text-amber-800 text-xs">
                  ${payment.isSettlement ? 'Full Account Settlement Concession' : 'Special Billing Discount'}
                </td>
                <td class="py-2.5 px-4 text-right font-bold text-amber-900">
                  ${formatCurrency(payment.discount)}
                </td>
              </tr>
              ` : ''}
            </tbody>
            <tfoot class="bg-slate-50 font-bold border-t border-slate-200 text-xs">
              ${hasDiscount ? `
              <tr>
                <td colspan="2" class="py-2 px-4 text-right uppercase text-slate-600">Total Balance Settled:</td>
                <td class="py-2 px-4 text-right text-slate-900 font-black">${formatCurrency(totalSettled)}</td>
              </tr>
              ` : ''}
              <tr class="bg-slate-100 text-slate-900">
                <td colspan="2" class="py-2.5 px-4 text-right uppercase text-[11px] font-black">Net Cash / Bank Paid:</td>
                <td class="py-2.5 px-4 text-right font-black text-emerald-700 text-base">${formatCurrency(payment.amount)}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <!-- Account Standing Snapshot -->
        <div class="bg-slate-50 p-4 rounded-xl border border-slate-200 flex flex-col sm:flex-row justify-between items-center gap-3 text-xs">
          <div>
            <span class="text-slate-500">Total Billed to Date:</span> <strong class="text-slate-800">${formatCurrency(ledger.totalBilled)}</strong>
            <span class="mx-2 text-slate-300">|</span>
            <span class="text-slate-500">Total Paid to Date:</span> <strong class="text-emerald-700">${formatCurrency(ledger.totalPaid)}</strong>
          </div>
          <div class="font-bold">
            <span class="text-slate-600">Current Outstanding Due:</span>
            <span class="ml-1 text-sm font-black ${ledger.finalBalance > 0 ? 'text-red-600' : 'text-emerald-700'}">
              ${formatCurrency(ledger.finalBalance)}
            </span>
          </div>
        </div>

        <!-- Receipt Declaration & Signatures -->
        <div class="pt-6 border-t border-slate-200 flex justify-between items-end text-xs text-slate-500">
          <div class="space-y-1">
            <p class="font-medium text-slate-700">Thank you for your business & prompt payment!</p>
            <p class="text-[10px] text-slate-400">Subject to realization of payment &bull; Computer-generated receipt</p>
          </div>
          <div class="text-center">
            <div class="w-48 border-b border-slate-400 pb-10"></div>
            <p class="mt-1 font-bold text-slate-800">Authorized Signatory</p>
            <p class="text-[10px] text-slate-400">${escapeHtml(state.settings.businessName || '')}</p>
          </div>
        </div>
      </div>
    `;

    openModal('paymentReceiptModal');
  }

  // ==================== WHATSAPP PAYMENT MESSAGE ====================
  function sendPaymentWhatsApp(clientId, paymentId) {
    const cId = clientId || state.activeClientId;
    const client = (state.clients || []).find(c => String(c.id) === String(cId));
    if (!client) {
      showToast('Client not found', true);
      return;
    }

    if (Array.isArray(client.payments)) {
      client.payments.forEach((p, idx) => {
        if (!p.id) p.id = 'pay_' + (p.createdAt ? new Date(p.createdAt).getTime() : Date.now()) + '_' + idx;
      });
    }

    let payment = (client.payments || []).find(p => String(p.id) === String(paymentId));
    if (!payment && client.payments && client.payments.length > 0) {
      payment = client.payments.find((p, idx) => String(idx) === String(paymentId)) || client.payments[client.payments.length - 1];
    }
    if (!payment) {
      showToast('Payment record not found', true);
      return;
    }

    activeReceiptContext = { clientId: client.id, paymentId: payment.id };

    const ledger = calculateClientLedger(client) || { totalBilled: 0, totalPaid: 0, finalBalance: 0 };
    const hasDiscount = Number(payment.discount || 0) > 0;
    const receiptNo = payment.reference && payment.reference.trim() !== '--'
      ? payment.reference.trim()
      : `REC-${payment.id ? String(payment.id).slice(-6).toUpperCase() : '001'}`;

    const allocationDesc = payment.targetMonth
      ? formatMonthName(payment.targetMonth)
      : 'General Account Balance (FIFO)';

    const businessTitle = state.settings.businessName || 'Digital CA Services';

    // Construct professional WhatsApp formatted receipt
    let msg = `🧾 *PAYMENT RECEIPT*\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `*${businessTitle}*\n`;
    if (state.settings.businessPhone) msg += `📞 Contact: ${state.settings.businessPhone}\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `*Client:* ${client.businessName || client.name}\n`;
    if (client.businessName && client.name) msg += `*Attn:* ${client.name}\n`;
    msg += `*Receipt No:* ${receiptNo}\n`;
    msg += `*Date:* ${formatDate(payment.date)}\n\n`;
    msg += `*💰 AMOUNT PAID: ${formatCurrency(payment.amount)}*\n`;
    msg += `*Payment Mode:* ${payment.method || 'Cash'}\n`;
    msg += `*Allocation:* ${allocationDesc}\n`;
    if (payment.reference && payment.reference.trim() !== '--') {
      msg += `*Ref / Txn ID:* ${payment.reference}\n`;
    }
    if (hasDiscount) {
      msg += `*Discount / Waiver:* ${formatCurrency(payment.discount)}\n`;
      msg += `*Total Settled:* ${formatCurrency(Number(payment.amount) + Number(payment.discount))}\n`;
    }
    if (payment.note && payment.note.trim() !== '--') {
      msg += `*Notes:* ${payment.note}\n`;
    }
    msg += `━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `*Current Outstanding Due:* ${formatCurrency(ledger.finalBalance)}\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `_Thank you for your payment!_\n`;
    msg += `_${businessTitle}_`;

    let phoneDigits = normalizeWhatsAppPhone(client.phone);
    if (!phoneDigits) {
      const entered = prompt(
        `No phone number found for ${client.name || 'this client'}.\nPlease enter WhatsApp number (10 digits):`,
        ''
      );
      if (entered === null) return; // User cancelled
      phoneDigits = normalizeWhatsAppPhone(entered);
      if (phoneDigits) {
        client.phone = entered.trim();
        saveData();
      }
    }

    const encodedText = encodeURIComponent(msg);
    const waUrl = phoneDigits
      ? `https://api.whatsapp.com/send?phone=${phoneDigits}&text=${encodedText}`
      : `https://api.whatsapp.com/send?text=${encodedText}`;

    // Reliable cross-browser opening to prevent popup blocking
    const a = document.createElement('a');
    a.href = waUrl;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 100);

    showToast(phoneDigits ? `Opening WhatsApp for ${client.name || 'client'}...` : 'Opening WhatsApp with payment receipt...');
  }

  function sendActiveReceiptWhatsApp() {
    if (activeReceiptContext && activeReceiptContext.clientId && activeReceiptContext.paymentId) {
      sendPaymentWhatsApp(activeReceiptContext.clientId, activeReceiptContext.paymentId);
    } else {
      showToast('No active receipt found to send', true);
    }
  }

  // ==================== EXPORT & IMPORT ====================
  function exportJSON() {
    const data = {
      clients: state.clients,
      settings: state.settings,
      exportedAt: new Date().toISOString(),
      version: '1.0',
    };
    const jsonStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(data, null, 2));
    const a = document.createElement('a');
    a.setAttribute('href', jsonStr);
    a.setAttribute('download', `ClientLedger_Backup_${getTodayDate()}.json`);
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast('Backup JSON downloaded successfully');
  }

  function importJSON(event) {
    const file = event.target.files && event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (e) {
      try {
        const parsed = JSON.parse(e.target.result);
        if (parsed.clients && Array.isArray(parsed.clients)) {
          state.clients = parsed.clients;
          if (parsed.settings) state.settings = { ...state.settings, ...parsed.settings };
          saveData();
          showToast('Data restored successfully!');
          showView('dashboard');
        } else {
          showToast('Invalid backup file structure', true);
        }
      } catch (err) {
        console.error('Error importing JSON:', err);
        showToast('Error reading JSON file', true);
      }
      event.target.value = '';
    };
    reader.readAsText(file);
  }

  function exportAllToCSV() {
    if (state.clients.length === 0) {
      showToast('No client data to export', true);
      return;
    }

    const rows = [
      ['Client Name', 'Business Name', 'Phone', 'Email', 'Start Month', 'Fixed Monthly Fee', 'Income Tax Fee', 'Extra Fee', 'Total Billed', 'Total Paid', 'Final Balance Due', 'Pending Months Count'],
    ];

    state.clients.forEach(c => {
      const l = calculateClientLedger(c);
      rows.push([
        c.name,
        c.businessName || '',
        c.phone || '',
        c.email || '',
        c.startMonth,
        c.fixedMonthlyAmount,
        c.incomeTaxFee || 0,
        c.extraFee || 0,
        l.totalBilled,
        l.totalPaid,
        l.finalBalance,
        l.unpaidMonthsCount,
      ]);
    });

    const csvContent =
      'data:text/csv;charset=utf-8,' +
      rows
        .map(e => e.map(val => `"${String(val).replace(/"/g, '""')}"`).join(','))
        .join('\n');

    const encodedUri = encodeURI(csvContent);
    const a = document.createElement('a');
    a.setAttribute('href', encodedUri);
    a.setAttribute('download', `ClientLedger_Summary_${getTodayDate()}.csv`);
    document.body.appendChild(a);
    a.click();
    a.remove();
    showToast('CSV Exported successfully');
  }

  function clearAllData() {
    if (confirm('CAUTION: This will delete ALL clients, monthly fees, and payment history! Are you sure?')) {
      if (confirm('Please confirm once more. Export a backup first if needed! Delete everything?')) {
        state.clients = [];
        saveData(true, { allowEmpty: true });
        showToast('All client data cleared');
        showView('dashboard');
      }
    }
  }

  function loadSampleData() {
    if (!isSupabaseConfigured()) {
      showToast('⚠️ Please connect your Supabase database first.', true);
      openCloudDatabaseModal();
      return;
    }
    showToast('No default demo data. Create clients directly or import from backup.');
  }

  function changeCurrency(curr) {
    state.settings.currency = curr;
    saveData();
    updateCurrencySymbols();
    if (state.activeView === 'dashboard') renderDashboard();
    else if (state.activeView === 'clients') renderClientsList();
    else if (state.activeView === 'client-detail') renderClientDetail(state.activeClientId);
    else if (state.activeView === 'matrix') renderMatrixView();
    showToast(`Currency changed to ${curr}`);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ==================== AUTHENTICATION & LOGIN ====================
  function checkAuth() {
    const savedUser = localStorage.getItem(AUTH_KEY);
    if (savedUser === 'rahul') {
      state.isAuthenticated = true;
      showMainApp();
      return true;
    } else {
      state.isAuthenticated = false;
      showLoginScreen();
      return false;
    }
  }

  function showLoginScreen() {
    const loginScreen = document.getElementById('login-screen');
    const mainApp = document.getElementById('main-app-container');
    if (loginScreen) loginScreen.classList.remove('hidden');
    if (mainApp) mainApp.classList.add('hidden');
    const passInput = document.getElementById('login-password');
    if (passInput) passInput.value = '';
    const err = document.getElementById('login-error-msg');
    if (err) err.classList.add('hidden');
  }

  function showMainApp() {
    const loginScreen = document.getElementById('login-screen');
    const mainApp = document.getElementById('main-app-container');
    if (loginScreen) loginScreen.classList.add('hidden');
    if (mainApp) mainApp.classList.remove('hidden');
  }

  function handleLogin(e) {
    if (e && e.preventDefault) e.preventDefault();
    const userEl = document.getElementById('login-username');
    const passEl = document.getElementById('login-password');
    const errBox = document.getElementById('login-error-msg');
    const errText = document.getElementById('login-error-text');

    const username = (userEl?.value || '').trim().toLowerCase();
    const password = (passEl?.value || '').trim();

    if (username === 'rahul' && password === '1990') {
      if (errBox) errBox.classList.add('hidden');
      localStorage.setItem(AUTH_KEY, 'rahul');
      state.isAuthenticated = true;
      showMainApp();
      loadData();
      updateCurrencySymbols();
      showView('dashboard');
      showToast('Welcome back, Rahul! Connecting database...');
      // CRITICAL: Pull latest data from Supabase on login!
      checkCloudSync(false, { forcePull: true });
    } else {
      if (errBox) {
        errBox.classList.remove('hidden');
        if (username !== 'rahul') {
          errText.textContent = 'Incorrect Login ID. Please refer to the hint above (rahul).';
        } else {
          errText.textContent = 'Incorrect Password. Please refer to the hint above (1990).';
        }
      }
      if (passEl) {
        passEl.value = '';
        passEl.focus();
      }
    }
  }

  function handleLogout() {
    if (confirm('Are you sure you want to log out?')) {
      localStorage.removeItem(AUTH_KEY);
      state.isAuthenticated = false;
      showLoginScreen();
      showToast('Logged out successfully.');
    }
  }

  function quickFillLogin() {
    const userEl = document.getElementById('login-username');
    const passEl = document.getElementById('login-password');
    const errBox = document.getElementById('login-error-msg');
    if (userEl) userEl.value = 'rahul';
    if (passEl) passEl.value = '1990';
    if (errBox) errBox.classList.add('hidden');
    showToast('Credentials filled! Click Sign In.');
  }

  function toggleLoginPasswordVisibility() {
    const passEl = document.getElementById('login-password');
    const eyeIcon = document.getElementById('login-eye-icon');
    if (!passEl) return;
    if (passEl.type === 'password') {
      passEl.type = 'text';
      if (eyeIcon) {
        eyeIcon.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l18 18"/>`;
      }
    } else {
      passEl.type = 'password';
      if (eyeIcon) {
        eyeIcon.innerHTML = `<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>`;
      }
    }
  }

  // ==================== APP INITIALIZATION ====================
  async function init() {
    loadData();
    updateCurrencySymbols();
    await loadServerConfig();
    updateLoginDbStatus();

    const isAuth = checkAuth();
    if (isAuth) {
      showMainApp();
      showView('dashboard');
      checkCloudSync(false, { forcePull: true });
    } else {
      showLoginScreen();
    }

    // Background auto-sync every 10 seconds to fetch changes from other devices/tabs
    setInterval(() => {
      if (state.isAuthenticated && typeof checkCloudSync === 'function') {
        checkCloudSync(true);
      }
    }, 10000);

    const allModals = [
      'addClientModal',
      'recordPaymentModal',
      'editPaymentModal',
      'overrideMonthModal',
      'editClientModal',
      'printStatementModal',
      'paymentReceiptModal',
      'editBusinessProfileModal',
      'cloudDatabaseModal',
    ];

    // Close modals and dropdowns on Escape key
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        allModals.forEach(id => closeModal(id));
        const menu = document.getElementById('settings-dropdown-menu');
        if (menu) menu.classList.add('hidden');
      }
    });

    // Close modals when clicking backdrop
    allModals.forEach(id => {
      const modal = document.getElementById(id);
      if (modal) {
        modal.addEventListener('click', e => {
          if (e.target === modal) closeModal(id);
        });
      }
    });

    // Close settings dropdown when clicking outside
    document.addEventListener('click', e => {
      const menu = document.getElementById('settings-dropdown-menu');
      const btn = document.getElementById('settings-dropdown-btn');
      if (menu && !menu.classList.contains('hidden')) {
        if (!menu.contains(e.target) && !btn?.contains(e.target)) {
          menu.classList.add('hidden');
        }
      }
    });
  }

  // Expose methods to global app namespace
  window.app = {
    handleLogin,
    handleLogout,
    quickFillLogin,
    toggleLoginPasswordVisibility,
    showView,
    viewClientDetail,
    renderDashboard,
    onDashboardPresetChange,
    onDashboardDateInputChange,
    applyDashboardDateFilter,
    resetDashboardDateFilter,
    renderClientsList,
    renderClientDetail,
    renderMatrixView,
    filterClients,
    openModal,
    closeModal,
    toggleGstField,
    setBillingCycle,
    handleAddClient,
    openEditClientModal,
    handleSaveEditClient,
    handleDeleteClient,
    openEditBusinessProfileModal,
    handleSaveBusinessProfile,
    openCloudDatabaseModal,
    copySupabaseSql,
    setDbProviderTab,
    testCloudDbConnection,
    handleSaveCloudDb,
    toggleSettingsDropdown,
    openOverrideMonthModal,
    onOverrideMonthChange,
    handleSaveMonthOverride,
    handleResetMonthOverride,
    openRecordPaymentModal,
    openRecordPaymentForMonth,
    onPaymentClientChange,
    toggleSettlementDiscount,
    setFullSettlementMode,
    onPaymentAmountInput,
    onSettlementDiscountInput,
    handleRecordPayment,
    openEditPaymentModal,
    handleSaveEditPayment,
    toggleEditSettlementDiscount,
    handleDeletePayment,
    openPrintStatementModal,
    printPaymentReceipt,
    sendPaymentWhatsApp,
    sendActiveReceiptWhatsApp,
    changeCurrency,
    exportJSON,
    importJSON,
    exportAllToCSV,
    loadSampleData,
    clearAllData,
    manualCloudSync,
    syncToCloud,
    checkCloudSync,
    get activeClientId() {
      return state.activeClientId;
    },
  };

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
