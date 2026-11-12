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
    expenses: [],
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
    activeExpenseId: null,
    searchQuery: '',
    statusFilter: 'all',
    monthBreakdownFilter: 'all',
    expenseFilter: {
      category: 'all',
      search: '',
      preset: 'all',
      from: '',
      to: '',
    },
    dashboardFilter: {
      preset: 'all',
      from: '',
      to: '',
    },
    batchWhatsApp: null,
  };

  const STORAGE_KEY = 'clientledger_pro_data_v1';
  const EXPENSES_STORAGE_KEY = 'clientledger_pro_expenses_v1';
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

  function getPreviousMonth(monthStr) {
    if (!monthStr) return '';
    const parts = monthStr.split('-');
    let year = parseInt(parts[0], 10);
    let month = parseInt(parts[1], 10);
    month -= 1;
    if (month < 1) {
      month = 12;
      year -= 1;
    }
    return `${year}-${String(month).padStart(2, '0')}`;
  }

  function getNextMonth(monthStr) {
    if (!monthStr) return '';
    const parts = monthStr.split('-');
    let year = parseInt(parts[0], 10);
    let month = parseInt(parts[1], 10);
    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
    return `${year}-${String(month).padStart(2, '0')}`;
  }

  // ==================== CLIENT ON HOLD ENGINE ====================
  function isClientOnHoldInMonth(client, monthStr) {
    if (!client || !monthStr) return null;

    // Check client.holds array
    if (Array.isArray(client.holds) && client.holds.length > 0) {
      for (const h of client.holds) {
        if (!h.fromMonth) continue;
        const afterFrom = compareMonths(monthStr, h.fromMonth) >= 0;
        const beforeTo = !h.toMonth || compareMonths(monthStr, h.toMonth) <= 0;

        // If client is currently active, an open-ended hold entry (without toMonth) does not apply
        if (client.status === 'active' && !h.toMonth) continue;

        if (afterFrom && beforeTo) {
          return h;
        }
      }
    }

    // Check top-level client fields
    if (client.status === 'hold' || (client.holdFrom && client.holdTo)) {
      const fromM = client.holdFrom || client.startMonth;
      const toM = client.holdTo;
      if (!fromM) return null;

      const afterFrom = compareMonths(monthStr, fromM) >= 0;
      const beforeTo = !toM || compareMonths(monthStr, toM) <= 0;

      // If client is active and there's no toM, do not hold
      if (client.status === 'active' && !toM) return null;

      if (afterFrom && beforeTo) {
        return {
          fromMonth: fromM,
          toMonth: toM,
          reason: client.holdReason || 'Client on hold / services paused',
          notes: client.holdNotes || '',
        };
      }
    }

    return null;
  }

  function isClientCurrentlyOnHold(client) {
    if (!client) return false;
    if (client.status === 'inactive') return false;
    if (client.status === 'active') return false; // Explicitly active

    const currentMonth = getTodayDate().slice(0, 7);

    if (client.status === 'hold') {
      if (client.holdTo && compareMonths(currentMonth, client.holdTo) > 0) {
        return false; // Hold date has already passed
      }
      return true;
    }

    if (Array.isArray(client.holds) && client.holds.length > 0) {
      return client.holds.some(h => {
        if (!h.fromMonth) return false;
        const afterFrom = compareMonths(currentMonth, h.fromMonth) >= 0;
        const beforeTo = !h.toMonth || compareMonths(currentMonth, h.toMonth) <= 0;
        return afterFrom && beforeTo;
      });
    }

    if (client.holdFrom) {
      const afterFrom = compareMonths(currentMonth, client.holdFrom) >= 0;
      const beforeTo = !client.holdTo || compareMonths(currentMonth, client.holdTo) <= 0;
      return afterFrom && beforeTo;
    }

    return false;
  }

  // Helper to determine the effective recurring fee for any specific month
  // Handles fee revisions (feeSchedule) applied from a particular month onwards
  function getClientBaseFeeForMonth(client, monthStr) {
    if (!client || !monthStr) return 0;
    const isYearly = client.billingCycle === 'yearly';
    const fallbackBase = isYearly
      ? Number(client.fixedYearlyAmount || client.fixedMonthlyAmount || 0)
      : Number(client.fixedMonthlyAmount || 0);

    if (Array.isArray(client.feeSchedule) && client.feeSchedule.length > 0) {
      const targetM = isYearly && String(monthStr).length === 4 ? `${monthStr}-01` : monthStr;
      const applicable = client.feeSchedule
        .filter(entry => {
          if (!entry || !entry.fromMonth) return false;
          const entryM = isYearly && String(entry.fromMonth).length === 4 ? `${entry.fromMonth}-01` : entry.fromMonth;
          return compareMonths(entryM, targetM) <= 0;
        })
        .sort((a, b) => compareMonths(a.fromMonth, b.fromMonth));

      if (applicable.length > 0) {
        return Number(applicable[applicable.length - 1].amount);
      }
    }

    return fallbackBase;
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

      const holdInfo = isClientOnHoldInMonth(client, `${y}-01`) || isClientOnHoldInMonth(client, String(y));
      const isHold = !!holdInfo;
      const holdReason = holdInfo ? (holdInfo.reason || client.holdReason || 'Client on hold') : '';

      const baseYearlyFee = getClientBaseFeeForMonth(client, y);

      if (isOverridden) {
        billed = Number(override.amount);
        overrideNote = override.note || '';
      } else if (isHold) {
        billed = 0;
        overrideNote = `⏸️ On Hold (${holdReason})`;
      } else {
        billed = baseYearlyFee + combinedFees;
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
      if (isHold && billed === 0 && totalYearPaid === 0) {
        status = 'HOLD';
      } else if (balance <= 0) {
        status = totalYearPaid > billed ? 'OVERPAID' : 'PAID';
      } else if (totalYearPaid > 0) {
        status = 'PARTIAL';
      }

      yearlyBreakdown.push({
        month: y,
        monthName: `Year ${y}`,
        fullMonthName: `Year ${y}`,
        billed,
        isHold,
        holdReason,
        isOverridden,
        overrideNote,
        defaultFee: baseYearlyFee,
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

      const holdInfo = isClientOnHoldInMonth(client, m);
      const isHold = !!holdInfo;
      const holdReason = holdInfo ? (holdInfo.reason || client.holdReason || 'Client on hold') : '';

      const baseMonthlyFee = getClientBaseFeeForMonth(client, m);

      if (isOverridden) {
        billed = Number(override.amount);
        overrideNote = override.note || '';
      } else if (isHold) {
        billed = 0;
        overrideNote = `⏸️ On Hold (${holdReason})`;
      } else {
        billed = baseMonthlyFee + combinedFees;
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
      if (isHold && billed === 0 && totalMonthPaid === 0) {
        status = 'HOLD';
      } else if (balance <= 0) {
        status = totalMonthPaid > billed ? 'OVERPAID' : 'PAID';
      } else if (totalMonthPaid > 0) {
        status = 'PARTIAL';
      }

      monthlyBreakdown.push({
        month: m,
        monthName: formatMonthName(m),
        fullMonthName: formatFullMonthName(m),
        billed,
        isHold,
        holdReason,
        isOverridden,
        overrideNote,
        defaultFee: baseMonthlyFee,
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
WHERE id = 'main_store';

-- View 4: Outgoing Payments & Expenses Table
CREATE OR REPLACE VIEW public.v_expenses AS
SELECT 
    e->>'id' AS expense_id,
    e->>'date' AS expense_date,
    e->>'category' AS category,
    e->>'subcategory' AS subcategory,
    e->>'payee' AS payee,
    e->>'employeeRole' AS employee_role,
    e->>'salaryMonth' AS salary_month,
    e->>'billNumber' AS bill_number,
    COALESCE((e->>'amount')::numeric, 0) AS amount,
    e->>'method' AS payment_method,
    e->>'reference' AS reference,
    e->>'notes' AS notes
FROM public.clientledger_data,
     jsonb_array_elements(COALESCE(data->'expenses', '[]'::jsonb)) AS e
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

    if (Array.isArray(remoteData.expenses)) {
      state.expenses = remoteData.expenses;
    } else if (!state.expenses) {
      state.expenses = [];
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
      localStorage.setItem(EXPENSES_STORAGE_KEY, JSON.stringify(state.expenses));
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(state.settings));
    } catch (err) {}

    updateCurrencySymbols();
    updateBusinessProfileBanner();

    if (state.activeView === 'dashboard') renderDashboard();
    else if (state.activeView === 'clients') renderClientsList();
    else if (state.activeView === 'client-detail' && state.activeClientId) renderClientDetail(state.activeClientId);
    else if (state.activeView === 'matrix') renderMatrixView();
    else if (state.activeView === 'payments') renderPaymentsView();
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
      expenses: state.expenses || [],
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

    // 3. Load outgoing payments & expenses from localStorage
    try {
      const rawExp = localStorage.getItem(EXPENSES_STORAGE_KEY);
      if (rawExp) {
        state.expenses = JSON.parse(rawExp);
        if (!Array.isArray(state.expenses)) state.expenses = [];
      } else {
        state.expenses = [];
      }
    } catch (e) {
      console.error('Error loading expenses:', e);
      state.expenses = [];
    }

    updateBusinessProfileBanner();
    updateLoginDbStatus();
  }

  let syncDebounceTimer = null;

  async function saveData(immediate = true, options = {}) {
    try {
      state.settings.lastModified = Date.now();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state.clients));
      localStorage.setItem(EXPENSES_STORAGE_KEY, JSON.stringify(state.expenses || []));
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
    ['dashboard', 'clients', 'client-detail', 'matrix', 'payments', 'gstr'].forEach(v => {
      const el = document.getElementById(`view-${v}`);
      if (el) el.classList.add('hidden');
    });

    const activeEl = document.getElementById(`view-${viewName}`);
    if (activeEl) activeEl.classList.remove('hidden');

    // Update top nav active states
    const navDashboard = document.getElementById('nav-dashboard');
    const navClients = document.getElementById('nav-clients');
    const navMatrix = document.getElementById('nav-matrix');
    const navPayments = document.getElementById('nav-payments');
    const navGstr = document.getElementById('nav-gstr');

    [navDashboard, navClients, navMatrix, navPayments, navGstr].forEach(nav => {
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
    } else if (viewName === 'payments' && navPayments) {
      navPayments.className =
        'px-3 py-2 rounded-lg text-sm font-medium transition-colors text-blue-700 bg-blue-50 hover:bg-blue-100 flex items-center space-x-1.5';
    } else if (viewName === 'gstr' && navGstr) {
      navGstr.className =
        'px-3 py-2 rounded-lg text-sm font-medium transition-colors text-blue-700 bg-blue-50 hover:bg-blue-100 flex items-center space-x-1.5';
    }

    if (viewName === 'dashboard') renderDashboard();
    if (viewName === 'clients') renderClientsList();
    if (viewName === 'matrix') renderMatrixView();
    if (viewName === 'payments') renderPaymentsView();
    if (viewName === 'client-detail' && state.activeClientId) {
      renderClientDetail(state.activeClientId);
    }
    if (viewName === 'gstr') {
      const frame = document.getElementById('gstr-frame');
      if (frame) {
        if (!frame.src || frame.src === 'about:blank' || !frame.src.includes('gstr/index.html')) {
          const proto = window.location.protocol;
          if (proto === 'file:') {
            frame.src = './gstr/index.html';
          } else {
            const p = window.location.pathname || '/';
            const basePath = p.substring(0, p.lastIndexOf('/') + 1) || '/';
            frame.src = basePath + 'gstr/index.html';
          }
        }
      }
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

    const onHoldClients = state.clients.filter(c => isClientCurrentlyOnHold(c) || c.status === 'hold');
    const activeClients = state.clients.filter(c => !isClientCurrentlyOnHold(c) && c.status !== 'inactive' && c.status !== 'hold');

    state.clients.forEach(c => {
      const ledger = calculateClientLedger(c);
      if (!ledger) return;

      const isCurrentlyHold = isClientCurrentlyOnHold(c) || c.status === 'hold';
      if (c.status === 'active' && !isCurrentlyHold) {
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
    if (statRunrate) {
      if (onHoldClients.length > 0) {
        statRunrate.innerHTML = `${formatCurrency(monthlyRunrate)} / mo <span class="text-amber-600 font-bold text-[11px]">(${onHoldClients.length} on hold)</span>`;
      } else {
        statRunrate.textContent = `${formatCurrency(monthlyRunrate)} / mo recurring base`;
      }
    }

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
    if (state.statusFilter === 'active') {
      filtered = filtered.filter(item => !isClientCurrentlyOnHold(item.client) && item.client.status !== 'inactive' && item.client.status !== 'hold');
    } else if (state.statusFilter === 'hold') {
      filtered = filtered.filter(item => isClientCurrentlyOnHold(item.client) || item.client.status === 'hold');
    } else if (state.statusFilter === 'due') {
      filtered = filtered.filter(item => item.ledger.finalBalance > 0);
    } else if (state.statusFilter === 'settled') {
      filtered = filtered.filter(item => item.ledger.finalBalance === 0);
    } else if (state.statusFilter === 'advance') {
      filtered = filtered.filter(item => item.ledger.finalBalance < 0);
    } else if (state.statusFilter === 'inactive') {
      filtered = filtered.filter(item => item.client.status === 'inactive');
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
        const isClientHold = isClientCurrentlyOnHold(c) || c.status === 'hold';

        let statusBadge = '';
        if (isClientHold) {
          statusBadge = `<span class="px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800 border border-amber-200">⏸️ On Hold</span>`;
        } else if (l.finalBalance > 0) {
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
            <div class="font-bold text-slate-900 hover:text-blue-600 flex items-center gap-1.5 flex-wrap">
              <span>${escapeHtml(c.businessName || c.name)}</span>
              ${isClientHold ? `<span class="text-[10px] bg-amber-100 text-amber-800 border border-amber-200 px-1.5 py-0.2 rounded font-bold">⏸️ On Hold</span>` : ''}
              ${c.status === 'inactive' ? '<span class="text-[10px] bg-slate-200 text-slate-600 px-1.5 py-0.2 rounded font-normal">Inactive</span>' : ''}
              ${isYearly ? '<span class="text-[10px] font-bold text-amber-700 bg-amber-50 px-1.5 py-0.2 rounded border border-amber-200">Yearly</span>' : ''}
            </div>
            ${c.businessName ? `<div class="text-xs text-blue-700 font-medium mt-0.5">👤 Contact: ${escapeHtml(c.name)}</div>` : ''}
            ${isClientHold && c.holdReason ? `<div class="text-xs text-amber-700 italic mt-0.5">⏸️ Hold: ${escapeHtml(c.holdReason)}</div>` : ''}
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
              <button onclick="app.openHoldClientModal('${c.id}')" class="px-2 py-1 text-xs font-semibold ${isClientHold ? 'bg-amber-100 text-amber-800 hover:bg-amber-200' : 'bg-slate-100 text-slate-700 hover:bg-slate-200'} rounded-lg transition" title="Put Client on Hold / Manage Hold">
                ${isClientHold ? '⏸️ Hold' : '⏸️'}
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
    state.activeClientId = clientId;

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
    const isCurrentlyHold = isClientCurrentlyOnHold(client) || client.status === 'hold';
    if (statusBadge) {
      if (isCurrentlyHold) {
        statusBadge.className = 'px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800 border border-amber-200 inline-flex items-center gap-1';
        statusBadge.innerHTML = '<span>⏸️</span> <span>On Hold (Paused)</span>';
      } else if (client.status === 'inactive') {
        statusBadge.className = 'px-2.5 py-0.5 rounded-full text-xs font-semibold bg-slate-200 text-slate-700';
        statusBadge.textContent = 'Inactive / Archived';
      } else {
        statusBadge.className = 'px-2.5 py-0.5 rounded-full text-xs font-semibold bg-emerald-100 text-emerald-800';
        statusBadge.textContent = '✓ Active Client';
      }
    }

    const holdBtn = document.getElementById('detail-hold-btn');
    const holdBtnText = document.getElementById('detail-hold-btn-text');
    if (holdBtn && holdBtnText) {
      if (isCurrentlyHold) {
        holdBtn.className = 'px-3 py-1.5 text-xs font-semibold bg-amber-500 hover:bg-amber-600 text-white rounded-lg flex items-center gap-1.5 shadow-sm transition';
        holdBtnText.textContent = 'Manage Hold / Resume';
      } else {
        holdBtn.className = 'px-3 py-1.5 text-xs font-semibold bg-amber-50 hover:bg-amber-100 border border-amber-300 text-amber-900 rounded-lg flex items-center gap-1.5 shadow-sm transition';
        holdBtnText.textContent = 'Put on Hold';
      }
    }

    const holdBanner = document.getElementById('detail-hold-banner');
    const holdReasonBadge = document.getElementById('detail-hold-reason-badge');
    const holdPeriodText = document.getElementById('detail-hold-period-text');
    if (holdBanner) {
      if (isCurrentlyHold) {
        holdBanner.classList.remove('hidden');
        if (holdReasonBadge) holdReasonBadge.textContent = client.holdReason || 'Services Paused';
        if (holdPeriodText) {
          const fromStr = client.holdFrom ? formatMonthName(client.holdFrom) : 'Current';
          const toStr = client.holdTo ? formatMonthName(client.holdTo) : 'Indefinite / Until Resumed';
          holdPeriodText.textContent = `Monthly recurring fees paused from ${fromStr} to ${toStr}. No fees are charged for hold months.`;
        }
      } else {
        holdBanner.classList.add('hidden');
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
      const unpaidBreakdown = reversedBreakdown.filter(row => row.balance > 0);
      const paidBreakdown = reversedBreakdown.filter(row => row.balance <= 0);

      // Update badge counts on filter buttons
      const unpaidBadge = document.getElementById('month-unpaid-badge');
      const paidBadge = document.getElementById('month-paid-badge');
      if (unpaidBadge) unpaidBadge.textContent = unpaidBreakdown.length;
      if (paidBadge) paidBadge.textContent = paidBreakdown.length;

      // Update active filter button styling
      const filterMode = state.monthBreakdownFilter || 'all';
      ['all', 'unpaid', 'paid'].forEach(type => {
        const btn = document.getElementById(`month-filter-${type}`);
        if (!btn) return;
        if (type === filterMode) {
          btn.className = 'px-3 py-1.5 rounded-lg bg-white text-slate-900 shadow-2xs font-bold transition';
        } else {
          btn.className = 'px-3 py-1.5 rounded-lg text-slate-600 hover:text-slate-900 hover:bg-white/60 font-semibold transition flex items-center gap-1.5';
        }
      });

      // Update Pending Invoices Action Banner
      const actionBanner = document.getElementById('unpaid-months-action-banner');
      const bannerAmount = document.getElementById('unpaid-banner-amount');
      const bannerCount = document.getElementById('unpaid-banner-count');
      const bannerMonths = document.getElementById('unpaid-banner-months');

      if (actionBanner) {
        if (filterMode === 'unpaid' || (unpaidBreakdown.length > 0 && filterMode === 'all')) {
          actionBanner.classList.remove('hidden');
          const totalUnpaidDue = unpaidBreakdown.reduce((sum, r) => sum + (Number(r.balance) || 0), 0);
          if (bannerAmount) bannerAmount.textContent = formatCurrency(totalUnpaidDue);
          if (bannerCount) bannerCount.textContent = `${unpaidBreakdown.length} Month(s) Pending`;
          if (bannerMonths) {
            if (unpaidBreakdown.length > 0) {
              bannerMonths.textContent = `Pending months: ${unpaidBreakdown.map(r => r.fullMonthName).join(', ')}`;
            } else {
              bannerMonths.textContent = 'All billing months are fully cleared! No dues pending.';
            }
          }
        } else {
          actionBanner.classList.add('hidden');
        }
      }

      // Filter rows based on selected status filter
      let displayRows = reversedBreakdown;
      if (filterMode === 'unpaid') {
        displayRows = unpaidBreakdown;
      } else if (filterMode === 'paid') {
        displayRows = paidBreakdown;
      }

      if (displayRows.length === 0) {
        const emptyMsg = filterMode === 'unpaid'
          ? '🎉 Great news! No unpaid months. All completed billing months are fully paid.'
          : filterMode === 'paid'
          ? 'No fully paid months found yet.'
          : 'No completed billing months yet.';
        breakdownTbody.innerHTML = `
          <tr>
            <td colspan="7" class="py-8 text-center text-slate-400">
              <div class="text-sm font-semibold text-slate-600">${emptyMsg}</div>
            </td>
          </tr>
        `;
      } else {
        breakdownTbody.innerHTML = displayRows
          .map(row => {
          let feeTypeBadge = '';
          let statusBadge = '';
          let rowClass = '';
          let balanceDisplay = '';

          if (row.isHold && row.billed === 0) {
            feeTypeBadge = `
              <span class="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-semibold bg-amber-100 text-amber-900 border border-amber-200">
                ⏸️ Fee Waived (Hold)
                ${row.holdReason ? `&bull; <span class="italic text-[10px] max-w-[120px] truncate">${escapeHtml(row.holdReason)}</span>` : ''}
              </span>
            `;
            statusBadge = `
              <span class="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800 border border-amber-200">
                ⏸️ On Hold
              </span>
            `;
            rowClass = 'bg-amber-50/20';
            balanceDisplay = `<span class="text-slate-400 font-medium">₹0.00</span>`;
          } else if (row.isOverridden) {
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

          if (!(row.isHold && row.billed === 0)) {
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
            <td class="py-3 px-4 text-right whitespace-nowrap">
              <div class="flex items-center justify-end gap-1.5">
                ${
                  row.balance > 0
                    ? `
                      <button onclick="app.sendPendingInvoiceWhatsApp('${row.month}')" class="text-xs text-emerald-700 hover:text-emerald-800 bg-emerald-50 hover:bg-emerald-100 border border-emerald-200 font-semibold px-2 py-1 rounded transition flex items-center gap-1 shadow-2xs" title="Send Pending Invoice for ${row.fullMonthName} to WhatsApp">
                        <svg class="w-3.5 h-3.5 text-emerald-600" fill="currentColor" viewBox="0 0 24 24"><path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946.003-6.556 5.338-11.891 11.893-11.891 3.181.001 6.167 1.24 8.413 3.488 2.245 2.248 3.481 5.236 3.48 8.414-.003 6.557-5.338 11.892-11.893 11.892-1.99-.001-3.951-.5-5.688-1.448l-6.305 1.654zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884-.001 2.225.651 3.891 1.746 5.634l-.999 3.648 3.742-.981zm11.387-5.464c-.074-.124-.272-.198-.57-.347-.297-.149-1.758-.868-2.031-.967-.272-.099-.47-.149-.669.149-.198.297-.768.967-.941 1.165-.173.198-.347.223-.644.074-.297-.149-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.521.151-.172.2-.296.3-.495.099-.198.05-.372-.025-.521-.075-.148-.669-1.611-.916-2.206-.242-.579-.487-.501-.669-.51l-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.095 3.2 5.076 4.487.709.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.695.248-1.29.173-1.414z"/></svg>
                        WhatsApp
                      </button>
                      <button onclick="app.printPendingInvoice('${row.month}')" class="text-xs text-slate-700 hover:text-slate-900 bg-white border border-slate-300 hover:bg-slate-50 font-semibold px-2 py-1 rounded transition flex items-center gap-1 shadow-2xs" title="Print Invoice for ${row.fullMonthName}">
                        <svg class="w-3.5 h-3.5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/></svg>
                        Print
                      </button>
                    `
                    : ''
                }
                ${
                  row.isHold
                    ? `<button onclick="app.openHoldClientModal('${client.id}')" class="px-2 py-1 text-xs font-semibold text-amber-800 bg-amber-50 hover:bg-amber-100 border border-amber-200 rounded transition" title="Manage Hold Period">
                        Hold Info
                       </button>`
                    : ''
                }
                <button onclick="app.openOverrideMonthModal('${client.id}', '${row.month}')" class="px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50 rounded transition" title="Change payment amount for ${row.fullMonthName}">
                  Change Fee
                </button>
                ${
                  row.balance > 0
                    ? `<button onclick="app.openRecordPaymentForMonth('${client.id}', '${row.month}', ${row.balance})" class="px-2.5 py-1 text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white rounded transition shadow-xs flex items-center gap-1" title="Pay ${formatCurrency(row.balance)} for this month">
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
    
    const statusSelect = document.getElementById('edit-client-status');
    const clientStatus = client.status || 'active';
    if (statusSelect) statusSelect.value = clientStatus;

    const holdFields = document.getElementById('edit-client-hold-fields');
    const holdFromInput = document.getElementById('edit-client-hold-from');
    const holdToInput = document.getElementById('edit-client-hold-to');
    const holdReasonInput = document.getElementById('edit-client-hold-reason');

    if (holdFromInput) holdFromInput.value = client.holdFrom || '';
    if (holdToInput) holdToInput.value = client.holdTo || '';
    if (holdReasonInput) holdReasonInput.value = client.holdReason || '';

    if (holdFields) {
      if (clientStatus === 'hold') holdFields.classList.remove('hidden');
      else holdFields.classList.add('hidden');
    }

    document.getElementById('edit-client-notes').value = client.notes || '';

    openModal('editClientModal');
  }

  function onEditClientStatusChange() {
    const status = document.getElementById('edit-client-status')?.value;
    const holdFields = document.getElementById('edit-client-hold-fields');
    if (holdFields) {
      if (status === 'hold') {
        holdFields.classList.remove('hidden');
        const holdFromInput = document.getElementById('edit-client-hold-from');
        if (holdFromInput && !holdFromInput.value) {
          holdFromInput.value = getCurrentYearMonth();
        }
      } else {
        holdFields.classList.add('hidden');
      }
    }
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
    const newStatus = document.getElementById('edit-client-status').value;
    client.status = newStatus;
    if (newStatus === 'hold') {
      const fromM = document.getElementById('edit-client-hold-from')?.value || client.holdFrom || getCurrentYearMonth();
      const toM = document.getElementById('edit-client-hold-to')?.value || '';
      const reasonM = document.getElementById('edit-client-hold-reason')?.value.trim() || client.holdReason || 'Client on hold';
      client.holdFrom = fromM;
      client.holdTo = toM;
      client.holdReason = reasonM;
      if (!Array.isArray(client.holds)) client.holds = [];
      client.holds.push({
        id: 'hold_' + Date.now(),
        fromMonth: fromM,
        toMonth: toM || null,
        reason: reasonM,
        createdAt: new Date().toISOString(),
      });
    }
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

  // ==================== HOLD CLIENT / PAUSE BILLING ====================
  function openHoldClientModal(clientId = null, defaultMode = null) {
    const cId = clientId || state.activeClientId;
    const client = state.clients.find(c => String(c.id) === String(cId));
    if (!client) {
      showToast('Client not found', true);
      return;
    }
    state.activeClientId = client.id;

    const nameEl = document.getElementById('hold-modal-client-name');
    const statusEl = document.getElementById('hold-modal-current-status');
    const radioHold = document.getElementById('hold-action-hold');
    const radioActive = document.getElementById('hold-action-active');
    const fromInput = document.getElementById('hold-from-month-input');
    const toInput = document.getElementById('hold-to-month-input');
    const reasonInput = document.getElementById('hold-reason-input');
    const notesInput = document.getElementById('hold-notes-input');
    const submitBtn = document.getElementById('hold-modal-submit-btn');

    const resumeMonthInput = document.getElementById('resume-return-month-input');
    const resumeModeMonth = document.getElementById('resume-mode-month');
    const resumeFromHoldTitle = document.getElementById('resume-from-hold-title');
    const resumeFromHoldDesc = document.getElementById('resume-from-hold-desc');

    if (nameEl) nameEl.textContent = client.businessName ? `${client.businessName} (${client.name})` : client.name;

    const isHold = isClientCurrentlyOnHold(client) || client.status === 'hold';

    if (statusEl) {
      if (isHold) {
        statusEl.className = 'text-xs font-bold px-2.5 py-1 rounded-full bg-amber-100 text-amber-800 border border-amber-200';
        statusEl.textContent = '⏸️ Currently On Hold';
      } else {
        statusEl.className = 'text-xs font-bold px-2.5 py-1 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-200';
        statusEl.textContent = '✓ Currently Active';
      }
    }

    if (defaultMode === 'resume') {
      if (radioActive) radioActive.checked = true;
      if (radioHold) radioHold.checked = false;
    } else {
      if (radioHold && radioActive) {
        radioHold.checked = true;
        radioActive.checked = false;
      }
    }

    const currentYearMonth = getTodayDate().slice(0, 7);

    if (fromInput) {
      fromInput.value = client.holdFrom || currentYearMonth;
    }
    if (toInput) {
      toInput.value = client.holdTo || '';
    }
    if (reasonInput) {
      reasonInput.value = client.holdReason || (isHold ? '' : 'Travelled to another country / abroad');
    }
    if (notesInput) {
      notesInput.value = client.holdNotes || '';
    }

    // Configure resume options
    const holdStartMonth = client.holdFrom || (Array.isArray(client.holds) && client.holds.length > 0 ? client.holds[client.holds.length - 1].fromMonth : '') || currentYearMonth;
    const holdStartFormatted = holdStartMonth ? formatMonthName(holdStartMonth) : 'Hold Start Month';

    if (resumeFromHoldTitle) {
      resumeFromHoldTitle.textContent = `Resume from hold month (${holdStartFormatted}) — Cancel Hold`;
    }
    if (resumeFromHoldDesc) {
      resumeFromHoldDesc.textContent = `Cancels the hold completely. Regular recurring fees will be charged for all months including ${holdStartFormatted}.`;
    }

    if (resumeModeMonth) {
      resumeModeMonth.checked = true;
    }

    if (resumeMonthInput) {
      if (client.holdTo) {
        resumeMonthInput.value = getNextMonth(client.holdTo);
      } else {
        if (holdStartMonth && compareMonths(currentYearMonth, holdStartMonth) <= 0) {
          resumeMonthInput.value = getNextMonth(holdStartMonth);
        } else {
          resumeMonthInput.value = currentYearMonth;
        }
      }
    }

    onResumeModeChange();
    onHoldActionTypeChange();
    openModal('holdClientModal');
  }

  function onHoldActionTypeChange() {
    const isHold = document.getElementById('hold-action-hold')?.checked;
    const holdContainer = document.getElementById('hold-fields-container');
    const resumeContainer = document.getElementById('resume-fields-container');
    const submitBtn = document.getElementById('hold-modal-submit-btn');

    const fromInput = document.getElementById('hold-from-month-input');
    const reasonInput = document.getElementById('hold-reason-input');
    const returnMonthInput = document.getElementById('resume-return-month-input');

    if (isHold) {
      if (holdContainer) holdContainer.classList.remove('hidden');
      if (resumeContainer) resumeContainer.classList.add('hidden');
      if (fromInput) fromInput.required = true;
      if (reasonInput) reasonInput.required = true;
      if (returnMonthInput) returnMonthInput.required = false;

      if (submitBtn) {
        submitBtn.innerHTML = '<span>⏸️</span> <span>Save Hold Details</span>';
        submitBtn.className = 'px-5 py-2 text-sm bg-amber-600 hover:bg-amber-700 text-white rounded-xl font-semibold shadow-sm transition flex items-center gap-1.5';
      }
    } else {
      if (holdContainer) holdContainer.classList.add('hidden');
      if (resumeContainer) resumeContainer.classList.remove('hidden');
      if (fromInput) fromInput.required = false;
      if (reasonInput) reasonInput.required = false;

      const isReturnMonth = document.getElementById('resume-mode-month')?.checked;
      if (returnMonthInput) returnMonthInput.required = !!isReturnMonth;

      if (submitBtn) {
        submitBtn.innerHTML = '<span>✓</span> <span>Confirm & Resume Client</span>';
        submitBtn.className = 'px-5 py-2 text-sm bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-semibold shadow-sm transition flex items-center gap-1.5';
      }
    }
  }

  function onResumeModeChange() {
    const isReturnMonth = document.getElementById('resume-mode-month')?.checked;
    const box = document.getElementById('resume-month-input-box');
    const returnInput = document.getElementById('resume-return-month-input');
    const isHold = document.getElementById('hold-action-hold')?.checked;
    if (box) {
      if (isReturnMonth) {
        box.classList.remove('hidden');
        if (returnInput) returnInput.required = !isHold;
      } else {
        box.classList.add('hidden');
        if (returnInput) returnInput.required = false;
      }
    }
  }

  function setHoldReasonPreset(presetText) {
    const input = document.getElementById('hold-reason-input');
    if (input) {
      input.value = presetText;
      input.focus();
    }
  }

  function handleSaveHoldClient(e) {
    if (e && e.preventDefault) e.preventDefault();
    const client = state.clients.find(c => String(c.id) === String(state.activeClientId));
    if (!client) return;

    const actionType = document.querySelector('input[name="hold-action-type"]:checked')?.value || 'hold';

    if (actionType === 'active') {
      // User is resuming the client
      const resumeMode = document.querySelector('input[name="resume-mode"]:checked')?.value || 'return_month';
      const holdStartMonth = client.holdFrom || (Array.isArray(client.holds) && client.holds.length > 0 ? client.holds[client.holds.length - 1].fromMonth : null);

      if (resumeMode === 'from_hold_month' || !holdStartMonth) {
        // Choice 2: Resume from hold start month (Cancel Hold completely)
        client.status = 'active';
        const oldHoldFrom = client.holdFrom;
        client.holdFrom = null;
        client.holdTo = null;
        client.holdReason = null;
        client.holdNotes = null;

        if (Array.isArray(client.holds)) {
          if (oldHoldFrom) {
            client.holds = client.holds.filter(h => h.fromMonth !== oldHoldFrom);
          } else {
            client.holds = [];
          }
        }

        saveData();
        closeModal('holdClientModal');
        const startLabel = oldHoldFrom ? formatMonthName(oldHoldFrom) : 'the hold month';
        showToast(`Client "${client.name}" resumed from ${startLabel}! Hold canceled and normal billing restored.`);
        renderClientDetail(client.id);
        renderClientsList();
        renderDashboard();
        return;
      }

      // Choice 1: Resume from specific return month
      const returnMonth = document.getElementById('resume-return-month-input')?.value;
      if (!returnMonth) {
        showToast('Please select a Return Month to resume billing', true);
        return;
      }

      // If return month is earlier than or equal to hold start month, treat as canceling hold
      if (compareMonths(returnMonth, holdStartMonth) <= 0) {
        client.status = 'active';
        client.holdFrom = null;
        client.holdTo = null;
        client.holdReason = null;
        client.holdNotes = null;
        if (Array.isArray(client.holds)) {
          client.holds = client.holds.filter(h => h.fromMonth !== holdStartMonth);
        }
        saveData();
        closeModal('holdClientModal');
        showToast(`Client "${client.name}" resumed from ${formatMonthName(returnMonth)}. Hold canceled.`);
        renderClientDetail(client.id);
        renderClientsList();
        renderDashboard();
        return;
      }

      // Hold ends the month before return month
      const lastHoldMonth = getPreviousMonth(returnMonth);
      client.status = 'active';
      client.holdTo = lastHoldMonth;

      if (!Array.isArray(client.holds)) client.holds = [];
      const openHold = client.holds.find(h => h.fromMonth === holdStartMonth || !h.toMonth);
      if (openHold) {
        openHold.toMonth = lastHoldMonth;
      } else {
        client.holds.push({
          id: 'hold_' + Date.now(),
          fromMonth: holdStartMonth,
          toMonth: lastHoldMonth,
          reason: client.holdReason || 'Client on hold',
          notes: client.holdNotes || '',
          createdAt: new Date().toISOString()
        });
      }

      saveData();
      closeModal('holdClientModal');
      showToast(`Client "${client.name}" resumed! Normal billing begins in ${formatMonthName(returnMonth)}. (Held until ${formatMonthName(lastHoldMonth)})`);
      renderClientDetail(client.id);
      renderClientsList();
      renderDashboard();
      return;
    }

    // Placing on hold
    const fromMonth = document.getElementById('hold-from-month-input')?.value;
    const toMonth = document.getElementById('hold-to-month-input')?.value || '';
    const reason = document.getElementById('hold-reason-input')?.value.trim() || 'Client on hold';
    const notes = document.getElementById('hold-notes-input')?.value.trim() || '';

    if (!fromMonth) {
      showToast('Please select a Hold Start Month', true);
      return;
    }

    if (toMonth && compareMonths(toMonth, fromMonth) < 0) {
      showToast('Hold Until Month cannot be earlier than Hold Start Month', true);
      return;
    }

    client.status = 'hold';
    client.holdFrom = fromMonth;
    client.holdTo = toMonth;
    client.holdReason = reason;
    client.holdNotes = notes;

    if (!Array.isArray(client.holds)) client.holds = [];
    const existingHold = client.holds.find(h => !h.toMonth || h.fromMonth === fromMonth);
    if (existingHold) {
      existingHold.fromMonth = fromMonth;
      existingHold.toMonth = toMonth || null;
      existingHold.reason = reason;
      existingHold.notes = notes;
      existingHold.updatedAt = new Date().toISOString();
    } else {
      client.holds.push({
        id: 'hold_' + Date.now(),
        fromMonth,
        toMonth: toMonth || null,
        reason,
        notes,
        createdAt: new Date().toISOString(),
      });
    }

    saveData();
    closeModal('holdClientModal');
    const periodStr = toMonth ? `from ${formatMonthName(fromMonth)} to ${formatMonthName(toMonth)}` : `from ${formatMonthName(fromMonth)} onwards`;
    showToast(`Client "${client.name}" placed on hold ${periodStr}.`);
    renderClientDetail(client.id);
    renderClientsList();
    renderDashboard();
  }

  function resumeClientQuick(clientId = null) {
    const cId = clientId || state.activeClientId;
    openHoldClientModal(cId, 'resume');
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

  // Override / Change Fee for a Particular Month or Year (Single Month vs From This Month Onwards)
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

    // Reset radio to 'single' default
    const radioSingle = document.getElementById('override-scope-single');
    if (radioSingle) radioSingle.checked = true;

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
    const singleTitle = document.getElementById('scope-single-title');
    const fromNowTitle = document.getElementById('scope-from-now-title');
    const periodLabel = isYearly ? `Year ${selectedMonth}` : formatMonthName(selectedMonth);

    if (singleTitle) singleTitle.textContent = `Change only ${periodLabel}`;
    if (fromNowTitle) fromNowTitle.textContent = `Change fee from ${periodLabel}`;

    const existingSchedule = Array.isArray(client.feeSchedule) ? client.feeSchedule.find(s => s.fromMonth === selectedMonth) : null;
    const existingOverride = client.monthOverrides && (client.monthOverrides[selectedMonth] || (isYearly ? client.monthOverrides[`${selectedMonth}-01`] : null));

    if (existingSchedule && existingSchedule.amount !== undefined) {
      const radioFromNow = document.getElementById('override-scope-from-now');
      if (radioFromNow) radioFromNow.checked = true;
      amountInput.value = existingSchedule.amount;
      noteInput.value = existingSchedule.note || '';
      if (resetBtn) resetBtn.classList.remove('hidden');
    } else if (existingOverride && existingOverride.amount !== undefined) {
      const radioSingle = document.getElementById('override-scope-single');
      if (radioSingle) radioSingle.checked = true;
      amountInput.value = existingOverride.amount;
      noteInput.value = existingOverride.note || '';
      if (resetBtn) resetBtn.classList.remove('hidden');
    } else {
      const isStart = isYearly ? (selectedMonth === (client.startYear || (client.startMonth ? client.startMonth.split('-')[0] : ''))) : (selectedMonth === (client.startMonth || ''));
      const extraAmt = isStart ? Number(client.extraFee || 0) : 0;
      const itAmt = isStart ? Number(client.incomeTaxFee || 0) : 0;
      const baseFee = getClientBaseFeeForMonth(client, selectedMonth);
      amountInput.value = baseFee + extraAmt + itAmt;
      noteInput.value = '';
      if (resetBtn) resetBtn.classList.add('hidden');
    }

    onOverrideScopeChange();
  }

  function onOverrideScopeChange() {
    const isFromNow = document.getElementById('override-scope-from-now')?.checked;
    const monthVal = document.getElementById('override-month')?.value;
    const clientId = document.getElementById('override-client-id')?.value;
    const client = state.clients.find(c => c.id === clientId);
    const isYearly = client && client.billingCycle === 'yearly';
    const periodLabel = monthVal ? (isYearly ? `Year ${monthVal}` : formatMonthName(monthVal)) : 'this month';

    const amountLabel = document.getElementById('override-amount-label');
    const noteLabel = document.getElementById('override-note-label');
    const scopeHint = document.getElementById('override-scope-hint');
    const submitBtn = document.getElementById('override-submit-btn');

    if (isFromNow) {
      if (amountLabel) amountLabel.textContent = `New Recurring Fee (From ${periodLabel} onwards) *`;
      if (noteLabel) noteLabel.textContent = `Reason for Fee Revision (Optional)`;
      if (scopeHint) scopeHint.innerHTML = `<span>🔄</span> <strong>Permanent Revision:</strong> Applies this new fee to <strong>${periodLabel} and all future months</strong>. Previous months remain unchanged.`;
      if (submitBtn) submitBtn.textContent = 'Save Fee From This Month';
    } else {
      if (amountLabel) amountLabel.textContent = `New Fee for ${periodLabel} Only *`;
      if (noteLabel) noteLabel.textContent = `Reason / Note for ${periodLabel}`;
      if (scopeHint) scopeHint.innerHTML = `<span>📅</span> <strong>Single Month Only:</strong> Only overrides <strong>${periodLabel}</strong>. Other months continue with their normal fee.`;
      if (submitBtn) submitBtn.textContent = 'Save Single Month Fee';
    }
  }

  function handleSaveMonthOverride(e) {
    if (e && e.preventDefault) e.preventDefault();
    const clientId = document.getElementById('override-client-id').value;
    const client = state.clients.find(c => c.id === clientId);
    if (!client) return;

    const period = document.getElementById('override-month').value;
    const newAmount = Number(document.getElementById('override-amount').value);
    const note = document.getElementById('override-note').value.trim();
    const scope = document.querySelector('input[name="override-scope"]:checked')?.value || 'single';
    const isYearly = client.billingCycle === 'yearly';
    const periodLabel = isYearly ? `Year ${period}` : formatMonthName(period);

    if (scope === 'from_this_month') {
      if (!Array.isArray(client.feeSchedule)) {
        client.feeSchedule = [];
        const startP = isYearly ? (client.startYear || '2000') : (client.startMonth || '2000-01');
        const origBase = isYearly ? Number(client.fixedYearlyAmount || client.fixedMonthlyAmount || 0) : Number(client.fixedMonthlyAmount || 0);
        if (compareMonths(startP, period) < 0) {
          client.feeSchedule.push({
            fromMonth: startP,
            amount: origBase,
            note: 'Initial base fee',
            createdAt: new Date().toISOString(),
          });
        }
      }

      client.feeSchedule = client.feeSchedule.filter(s => s.fromMonth !== period);
      client.feeSchedule.push({
        fromMonth: period,
        amount: newAmount,
        note: note || `Fee revised from ${periodLabel}`,
        createdAt: new Date().toISOString(),
      });
      client.feeSchedule.sort((a, b) => compareMonths(a.fromMonth, b.fromMonth));

      const currentPeriod = isYearly ? String(new Date().getFullYear()) : getCurrentYearMonth();
      if (compareMonths(period, currentPeriod) >= 0 || client.feeSchedule[client.feeSchedule.length - 1].fromMonth === period) {
        if (isYearly) {
          client.fixedYearlyAmount = newAmount;
        } else {
          client.fixedMonthlyAmount = newAmount;
        }
      }

      if (client.monthOverrides) {
        delete client.monthOverrides[period];
        delete client.monthOverrides[`${period}-01`];
      }

      saveData();
      closeModal('overrideMonthModal');
      showToast(`Fee revised to ${formatCurrency(newAmount)} starting from ${periodLabel} onwards`);
    } else {
      if (!client.monthOverrides) client.monthOverrides = {};

      client.monthOverrides[period] = {
        amount: newAmount,
        note,
      };

      saveData();
      closeModal('overrideMonthModal');
      showToast(`Fee for ${periodLabel} updated to ${formatCurrency(newAmount)} (single month only)`);
    }

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
    const isYearly = client.billingCycle === 'yearly';
    const periodLabel = isYearly ? `Year ${period}` : formatMonthName(period);

    let didReset = false;

    if (client.monthOverrides) {
      if (client.monthOverrides[period] || client.monthOverrides[`${period}-01`]) {
        delete client.monthOverrides[period];
        delete client.monthOverrides[`${period}-01`];
        didReset = true;
      }
    }

    if (Array.isArray(client.feeSchedule)) {
      const idx = client.feeSchedule.findIndex(s => s.fromMonth === period);
      if (idx !== -1) {
        client.feeSchedule.splice(idx, 1);
        didReset = true;
        if (client.feeSchedule.length > 0) {
          const latest = client.feeSchedule[client.feeSchedule.length - 1];
          if (isYearly) client.fixedYearlyAmount = latest.amount;
          else client.fixedMonthlyAmount = latest.amount;
        }
      }
    }

    if (didReset) {
      saveData();
      closeModal('overrideMonthModal');
      showToast(`Fee for ${periodLabel} reset to default`);
      if (state.activeClientId === clientId) {
        renderClientDetail(clientId);
      } else {
        renderDashboard();
      }
    } else {
      closeModal('overrideMonthModal');
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
  let activePendingInvoiceContext = null;

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

  // ==================== MONTH BREAKDOWN FILTER & PENDING INVOICE ====================
  function setMonthBreakdownFilter(filterType) {
    state.monthBreakdownFilter = filterType || 'all';
    if (state.activeClientId) {
      renderClientDetail(state.activeClientId);
    }
  }

  function printPendingInvoice(explicitMonth = null) {
    const cId = state.activeClientId;
    const client = (state.clients || []).find(c => String(c.id) === String(cId));
    if (!client) {
      showToast('Client not found', true);
      return;
    }

    const ledger = calculateClientLedger(client) || { monthlyBreakdown: [], totalBilled: 0, totalPaid: 0, finalBalance: 0 };
    let unpaidRows = (ledger.monthlyBreakdown || []).filter(r => r.balance > 0);

    if (explicitMonth) {
      unpaidRows = unpaidRows.filter(r => r.month === explicitMonth);
      if (unpaidRows.length === 0) {
        const rowExists = (ledger.monthlyBreakdown || []).some(r => r.month === explicitMonth);
        showToast(rowExists ? 'This month is already fully paid!' : 'Selected month not found', false);
        return;
      }
    } else {
      if (unpaidRows.length === 0) {
        showToast('🎉 All billing months are fully paid! No pending invoices.', false);
        return;
      }
    }

    activePendingInvoiceContext = { clientId: client.id, explicitMonth: explicitMonth || null };

    const container = document.getElementById('printable-pending-invoice-content');
    if (!container) return;

    const totalInvoiceDue = unpaidRows.reduce((sum, r) => sum + (Number(r.balance) || 0), 0);
    const totalInvoiceBilled = unpaidRows.reduce((sum, r) => sum + (Number(r.billed) || 0), 0);
    const totalInvoicePaid = unpaidRows.reduce((sum, r) => sum + (Number(r.paid) || 0), 0);

    const safeClientId = client.id ? String(client.id).replace(/[^a-zA-Z0-9]/g, '').slice(-4).toUpperCase() : '001';
    const invoiceNo = `INV-DUE-${safeClientId}-${getTodayDate().replace(/-/g, '')}`;
    const invoiceScope = explicitMonth
      ? `Single Month Due: ${unpaidRows[0].fullMonthName}`
      : `All Outstanding Dues (${unpaidRows.length} Month${unpaidRows.length > 1 ? 's' : ''})`;

    container.innerHTML = `
      <div class="space-y-6 text-slate-800">
        <!-- Top Header & Business Details -->
        <div class="flex justify-between items-start border-b-2 border-red-900/80 pb-5">
          <div class="space-y-1">
            <span class="inline-block px-2.5 py-0.5 rounded text-[11px] font-black uppercase tracking-wider bg-red-100 text-red-800">
              Official Pending Dues Invoice / Demand Note
            </span>
            <h1 class="text-2xl font-black text-slate-950 tracking-tight mt-1">${escapeHtml(state.settings.businessName || 'Digital CA Services')}</h1>
            ${state.settings.businessAddress ? `<p class="text-xs text-slate-600">${escapeHtml(state.settings.businessAddress)}</p>` : ''}
            <div class="text-xs text-slate-500 flex flex-wrap gap-x-3 gap-y-0.5 pt-0.5">
              ${state.settings.businessPhone ? `<span><strong>Phone:</strong> ${escapeHtml(state.settings.businessPhone)}</span>` : ''}
              ${state.settings.businessEmail ? `<span><strong>Email:</strong> ${escapeHtml(state.settings.businessEmail)}</span>` : ''}
            </div>
          </div>
          <div class="text-right">
            <h2 class="text-xl font-extrabold text-red-700 uppercase tracking-wider">Demand Invoice</h2>
            <div class="mt-2 text-xs text-slate-600 space-y-1">
              <p><span class="font-bold text-slate-700">Invoice No:</span> <span class="font-mono font-bold text-slate-900">${escapeHtml(invoiceNo)}</span></p>
              <p><span class="font-bold text-slate-700">Invoice Date:</span> ${formatDate(getTodayDate())}</p>
              <p><span class="font-bold text-slate-700">Payment Status:</span> <span class="font-bold text-red-600 uppercase">Payment Pending</span></p>
              <p><span class="font-bold text-slate-700">Due Date:</span> <span class="font-semibold text-slate-900">Immediate / Upon Receipt</span></p>
            </div>
          </div>
        </div>

        <!-- Client Info & Total Due Box -->
        <div class="grid grid-cols-2 gap-4 bg-red-50/50 p-4 rounded-xl border border-red-200">
          <div>
            <span class="text-[10px] font-black uppercase tracking-wider text-slate-400">Bill To (Client Details):</span>
            <h3 class="text-base font-bold text-slate-900 mt-0.5">${escapeHtml(client.businessName || client.name)}</h3>
            ${client.businessName && client.name ? `<p class="text-xs text-slate-600 font-medium">Contact Person: ${escapeHtml(client.name)}</p>` : ''}
            <div class="text-xs text-slate-500 mt-1 space-y-0.5">
              ${client.phone ? `<p>Phone: ${escapeHtml(client.phone)}</p>` : ''}
              ${client.email ? `<p>Email: ${escapeHtml(client.email)}</p>` : ''}
              ${client.gstNumber ? `<p>GSTIN: <span class="font-mono">${escapeHtml(client.gstNumber)}</span></p>` : ''}
            </div>
          </div>
          <div class="text-right flex flex-col justify-center border-l border-red-200 pl-4">
            <span class="text-[10px] font-black uppercase tracking-wider text-red-700">Total Pending Amount Payable:</span>
            <div class="text-3xl font-black text-red-600 tracking-tight mt-0.5">
              ${formatCurrency(totalInvoiceDue)}
            </div>
            <p class="text-xs font-semibold text-slate-600 mt-1">
              Scope: ${escapeHtml(invoiceScope)}
            </p>
          </div>
        </div>

        <!-- Itemized Unpaid Months Table -->
        <div class="border border-slate-200 rounded-xl overflow-hidden">
          <table class="w-full text-left text-xs">
            <thead class="bg-slate-100 font-bold text-slate-700 uppercase tracking-wider text-[11px] border-b border-slate-200">
              <tr>
                <th class="py-2.5 px-4">Billing Month</th>
                <th class="py-2.5 px-4">Fee Structure</th>
                <th class="py-2.5 px-4 text-right">Billed (₹)</th>
                <th class="py-2.5 px-4 text-right">Paid Towards Month (₹)</th>
                <th class="py-2.5 px-4 text-right">Pending Balance (₹)</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              ${unpaidRows.map(row => `
                <tr class="hover:bg-slate-50/60">
                  <td class="py-3 px-4 font-bold text-slate-900">
                    ${escapeHtml(row.fullMonthName)}
                  </td>
                  <td class="py-3 px-4 text-slate-600">
                    ${row.isOverridden ? `Custom Fee${row.overrideNote ? ` (${escapeHtml(row.overrideNote)})` : ''}` : 'Fixed Monthly Fee'}
                  </td>
                  <td class="py-3 px-4 text-right font-medium text-slate-800">
                    ${formatCurrency(row.billed)}
                  </td>
                  <td class="py-3 px-4 text-right font-medium text-emerald-600">
                    ${formatCurrency(row.paid)}
                  </td>
                  <td class="py-3 px-4 text-right font-bold text-red-600 text-sm">
                    ${formatCurrency(row.balance)}
                  </td>
                </tr>
              `).join('')}
            </tbody>
            <tfoot class="bg-slate-100 border-t-2 border-slate-300 font-bold text-xs">
              <tr class="text-slate-900">
                <td colspan="2" class="py-2.5 px-4 uppercase text-[11px] font-black">
                  Total Outstanding For Mentioned Months:
                </td>
                <td class="py-2.5 px-4 text-right">${formatCurrency(totalInvoiceBilled)}</td>
                <td class="py-2.5 px-4 text-right text-emerald-700">${formatCurrency(totalInvoicePaid)}</td>
                <td class="py-2.5 px-4 text-right font-black text-red-600 text-base">${formatCurrency(totalInvoiceDue)}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <!-- Overall Client Ledger Standing -->
        <div class="bg-slate-50 p-4 rounded-xl border border-slate-200 flex flex-col sm:flex-row justify-between items-center gap-3 text-xs">
          <div>
            <span class="text-slate-500">Cumulative Billed to Date:</span> <strong class="text-slate-800">${formatCurrency(ledger.totalBilled)}</strong>
            <span class="mx-2 text-slate-300">|</span>
            <span class="text-slate-500">Cumulative Paid to Date:</span> <strong class="text-emerald-700">${formatCurrency(ledger.totalPaid)}</strong>
          </div>
          <div class="font-bold">
            <span class="text-slate-600">Total Net Outstanding Balance:</span>
            <span class="ml-1 text-sm font-black text-red-600">
              ${formatCurrency(ledger.finalBalance)}
            </span>
          </div>
        </div>

        <!-- Payment Instructions & Signature -->
        <div class="pt-6 border-t border-slate-200 flex justify-between items-end text-xs text-slate-500">
          <div class="space-y-1">
            <p class="font-bold text-slate-700">Payment Remittance Instructions:</p>
            <p class="text-[11px] text-slate-600">Please settle the pending balance via Bank Transfer (NEFT/RTGS), UPI, or Cash.</p>
            <p class="text-[10px] text-slate-400">Computer-generated pending dues demand invoice &bull; ${escapeHtml(state.settings.businessName || '')}</p>
          </div>
          <div class="text-center">
            <div class="w-48 border-b border-slate-400 pb-10"></div>
            <p class="mt-1 font-bold text-slate-800">Authorized Signatory</p>
            <p class="text-[10px] text-slate-400">${escapeHtml(state.settings.businessName || '')}</p>
          </div>
        </div>
      </div>
    `;

    openModal('pendingInvoiceModal');
  }

  function buildPendingInvoiceWhatsAppMessage(client, unpaidRows, totalDue, ledger, targetMonth = null) {
    const businessTitle = state.settings.businessName || 'Digital CA Services';

    let msg = `🔔 *PENDING DUES INVOICE / PAYMENT REMINDER*\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `*From:* ${businessTitle}\n`;
    if (state.settings.businessPhone) {
      msg += `*Contact:* ${state.settings.businessPhone}\n`;
    }
    msg += `*Date:* ${formatDate(getTodayDate())}\n`;
    msg += `━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `*Dear ${client.businessName || client.name},*\n\n`;
    msg += `This is a friendly reminder regarding outstanding professional fee / service dues:\n\n`;

    if (targetMonth && unpaidRows.length === 1) {
      const r = unpaidRows[0];
      msg += `📌 *Pending Month:* ${r.fullMonthName}\n`;
      msg += `*Billed Amount:* ${formatCurrency(r.billed)}\n`;
      if (r.paid > 0) {
        msg += `*Already Paid:* ${formatCurrency(r.paid)}\n`;
      }
      msg += `*Pending Balance:* ${formatCurrency(r.balance)}\n\n`;
    } else {
      msg += `📌 *Outstanding Months Breakdown (${unpaidRows.length} Month${unpaidRows.length > 1 ? 's' : ''}):*\n`;
      unpaidRows.forEach(r => {
        msg += `• *${r.fullMonthName}:* ${formatCurrency(r.balance)} due${r.paid > 0 ? ` (Paid: ${formatCurrency(r.paid)} of ${formatCurrency(r.billed)})` : ` (Billed: ${formatCurrency(r.billed)})`}\n`;
      });
      msg += `\n`;
    }

    msg += `━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `*TOTAL PENDING DUE: ${formatCurrency(totalDue)}*\n`;
    if (ledger && ledger.finalBalance !== undefined && ledger.finalBalance !== totalDue) {
      msg += `*Overall Ledger Balance: ${formatCurrency(ledger.finalBalance)}*\n`;
    }
    msg += `━━━━━━━━━━━━━━━━━━━━\n`;
    msg += `Kindly clear the pending amount at your earliest convenience.\n`;
    msg += `If you have already transferred the payment, please share the transaction reference / screenshot.\n\n`;
    msg += `_Thank you!_\n`;
    msg += `_${businessTitle}_`;

    return msg;
  }

  function sendPendingInvoiceWhatsApp(explicitMonth = null) {
    const cId = state.activeClientId || (activePendingInvoiceContext ? activePendingInvoiceContext.clientId : null);
    const client = (state.clients || []).find(c => String(c.id) === String(cId));
    if (!client) {
      showToast('Client not found', true);
      return;
    }

    const targetMonth = explicitMonth || (activePendingInvoiceContext && activePendingInvoiceContext.explicitMonth ? activePendingInvoiceContext.explicitMonth : null);
    const ledger = calculateClientLedger(client) || { monthlyBreakdown: [], totalBilled: 0, totalPaid: 0, finalBalance: 0 };
    let unpaidRows = (ledger.monthlyBreakdown || []).filter(r => r.balance > 0);

    if (targetMonth) {
      unpaidRows = unpaidRows.filter(r => r.month === targetMonth);
    }

    if (unpaidRows.length === 0) {
      showToast(targetMonth ? 'This month has no pending balance!' : '🎉 All billing months are fully paid! No pending dues.', false);
      return;
    }

    const totalDue = unpaidRows.reduce((sum, r) => sum + (Number(r.balance) || 0), 0);
    const msg = buildPendingInvoiceWhatsAppMessage(client, unpaidRows, totalDue, ledger, targetMonth);

    let phoneDigits = normalizeWhatsAppPhone(client.phone);
    if (!phoneDigits) {
      const entered = prompt(
        `No phone number found for ${client.name || 'this client'}.\nPlease enter WhatsApp number (10 digits):`,
        ''
      );
      if (entered === null) return;
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

    const a = document.createElement('a');
    a.href = waUrl;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 100);

    showToast(phoneDigits ? `Opening WhatsApp for ${client.name || 'client'}...` : 'Opening WhatsApp with pending dues invoice...');
  }

  // ==================== BATCH SEND PENDING WHATSAPP INVOICES ====================

  function openBatchPendingWhatsAppModal() {
    stopBatchWhatsAppQueue();
    const pendingClients = [];

    (state.clients || []).forEach(c => {
      const ledger = calculateClientLedger(c);
      if (ledger && ledger.finalBalance > 0) {
        const unpaidRows = (ledger.monthlyBreakdown || []).filter(r => r.balance > 0);
        pendingClients.push({
          client: c,
          ledger,
          unpaidRows,
          status: 'ready',
        });
      }
    });

    pendingClients.sort((a, b) => b.ledger.finalBalance - a.ledger.finalBalance);

    state.batchWhatsApp = {
      items: pendingClients,
      selectedClientIds: new Set(pendingClients.map(item => String(item.client.id))),
      queue: [],
      currentIndex: 0,
      isRunning: false,
      timer: null,
      filterQuery: '',
    };

    const searchInput = document.getElementById('batch-wa-search-input');
    if (searchInput) searchInput.value = '';

    const progressBanner = document.getElementById('batch-wa-progress-banner');
    if (progressBanner) progressBanner.classList.add('hidden');

    const previewBox = document.getElementById('batch-wa-sample-preview');
    if (previewBox) {
      previewBox.classList.add('hidden');
      if (pendingClients.length > 0) {
        const sample = pendingClients[0];
        previewBox.textContent = buildPendingInvoiceWhatsAppMessage(sample.client, sample.unpaidRows, sample.ledger.finalBalance, sample.ledger);
      } else {
        previewBox.textContent = 'No pending clients to preview.';
      }
    }

    renderBatchWhatsAppTable();
    openModal('batchPendingWhatsAppModal');
  }

  function renderBatchWhatsAppTable(filterQuery = '') {
    const tbody = document.getElementById('batch-wa-table-tbody');
    const emptyState = document.getElementById('batch-wa-empty-state');
    const headerCount = document.getElementById('batch-wa-header-count');
    const selectedStat = document.getElementById('batch-wa-selected-stat');
    const totalStat = document.getElementById('batch-wa-total-stat');
    const startBtnText = document.getElementById('btn-start-batch-whatsapp-text');
    const selectAllCb = document.getElementById('batch-wa-select-all-cb');

    if (!tbody || !state.batchWhatsApp) return;

    const allItems = state.batchWhatsApp.items || [];
    const query = (filterQuery || '').toLowerCase().trim();

    const filteredItems = query
      ? allItems.filter(item => {
          const c = item.client;
          const searchHaystack = `${c.name || ''} ${c.businessName || ''} ${c.phone || ''} ${c.email || ''}`.toLowerCase();
          return searchHaystack.includes(query);
        })
      : allItems;

    if (headerCount) {
      headerCount.textContent = `${allItems.length} Client${allItems.length === 1 ? '' : 's'}`;
    }

    if (filteredItems.length === 0) {
      tbody.innerHTML = '';
      if (emptyState) emptyState.classList.remove('hidden');
    } else {
      if (emptyState) emptyState.classList.add('hidden');

      tbody.innerHTML = filteredItems
        .map(item => {
          const c = item.client;
          const l = item.ledger;
          const isSelected = state.batchWhatsApp.selectedClientIds.has(String(c.id));
          const phoneDigits = normalizeWhatsAppPhone(c.phone);
          const hasPhone = !!phoneDigits;

          const unpaidMonthsNames = (item.unpaidRows || []).map(r => r.fullMonthName).slice(0, 3).join(', ');
          const extraCount = (item.unpaidRows || []).length > 3 ? ` +${(item.unpaidRows || []).length - 3} more` : '';
          const monthsText = `${item.unpaidRows.length} mo: ${unpaidMonthsNames}${extraCount}`;

          let statusBadge = `<span id="batch-wa-status-${c.id}" class="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-slate-100 text-slate-700">Ready</span>`;
          if (item.status === 'sent') {
            statusBadge = `<span id="batch-wa-status-${c.id}" class="text-xs font-bold px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-300">Sent ✓</span>`;
          } else if (item.status === 'sending') {
            statusBadge = `<span id="batch-wa-status-${c.id}" class="text-xs font-bold px-2.5 py-0.5 rounded-full bg-amber-100 text-amber-800 border border-amber-300 animate-pulse">Sending...</span>`;
          } else if (!hasPhone) {
            statusBadge = `<span id="batch-wa-status-${c.id}" class="text-xs font-bold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">No Phone ⚠️</span>`;
          }

          const phoneDisplay = hasPhone
            ? `<div class="flex items-center gap-1.5 font-medium text-slate-700">
                 <span class="text-emerald-600 font-bold">📱</span>
                 <span>${escapeHtml(c.phone)}</span>
               </div>`
            : `<div class="flex items-center gap-1">
                 <input type="tel" id="inline-phone-${c.id}" placeholder="10-digit number" class="w-28 px-1.5 py-0.5 text-[11px] border border-amber-300 rounded focus:ring-1 focus:ring-emerald-500 bg-amber-50/50">
                 <button type="button" onclick="app.updateClientPhoneInline('${c.id}')" class="text-[10px] bg-slate-800 hover:bg-black text-white px-1.5 py-0.5 rounded font-bold">Save</button>
               </div>`;

          return `
            <tr id="batch-wa-row-${c.id}" class="hover:bg-slate-50 transition ${item.status === 'sent' ? 'bg-emerald-50/30' : ''}">
              <td class="py-2.5 px-3 text-center">
                <input type="checkbox" data-client-id="${c.id}" ${isSelected ? 'checked' : ''} onchange="app.onBatchWaClientToggle('${c.id}', this.checked)" class="w-4 h-4 text-emerald-600 rounded border-slate-300 focus:ring-emerald-500 cursor-pointer align-middle">
              </td>
              <td class="py-2.5 px-3">
                <div class="font-bold text-slate-900">${escapeHtml(c.businessName || c.name)}</div>
                ${c.businessName ? `<div class="text-[11px] text-slate-500">👤 ${escapeHtml(c.name)}</div>` : ''}
              </td>
              <td class="py-2.5 px-3">
                ${phoneDisplay}
              </td>
              <td class="py-2.5 px-3">
                <span class="text-xs font-medium text-amber-800 bg-amber-50 border border-amber-200 px-2 py-0.5 rounded-md inline-block">
                  ${escapeHtml(monthsText)}
                </span>
              </td>
              <td class="py-2.5 px-3 text-right font-black text-red-600 text-sm">
                ${formatCurrency(l.finalBalance)}
              </td>
              <td class="py-2.5 px-3 text-center">
                ${statusBadge}
              </td>
              <td class="py-2.5 px-3 text-right whitespace-nowrap">
                <button type="button" onclick="app.sendSingleBatchWhatsApp('${c.id}')" class="px-2.5 py-1 text-xs font-bold bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg transition shadow-2xs flex items-center gap-1 ml-auto" title="Send WhatsApp pending dues invoice now">
                  <svg class="w-3 h-3" fill="currentColor" viewBox="0 0 24 24"><path d="M.057 24l1.687-6.163c-1.041-1.804-1.588-3.849-1.587-5.946.003-6.556 5.338-11.891 11.893-11.891 3.181.001 6.167 1.24 8.413 3.488 2.245 2.248 3.481 5.236 3.48 8.414-.003 6.557-5.338 11.892-11.893 11.892-1.99-.001-3.951-.5-5.688-1.448l-6.305 1.654zm6.597-3.807c1.676.995 3.276 1.591 5.392 1.592 5.448 0 9.886-4.434 9.889-9.885.002-5.462-4.415-9.89-9.881-9.892-5.452 0-9.887 4.434-9.889 9.884-.001 2.225.651 3.891 1.746 5.634l-.999 3.648 3.742-.981zm11.387-5.464c-.074-.124-.272-.198-.57-.347-.297-.149-1.758-.868-2.031-.967-.272-.099-.47-.149-.669.149-.198.297-.768.967-.941 1.165-.173.198-.347.223-.644.074-.297-.149-1.255-.462-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.297-.347.446-.521.151-.172.2-.296.3-.495.099-.198.05-.372-.025-.521-.075-.148-.669-1.611-.916-2.206-.242-.579-.487-.501-.669-.51l-.57-.01c-.198 0-.52.074-.792.372s-1.04 1.016-1.04 2.479 1.065 2.876 1.213 3.074c.149.198 2.095 3.2 5.076 4.487.709.306 1.263.489 1.694.626.712.226 1.36.194 1.872.118.571-.085 1.758-.719 2.006-1.413.248-.695.248-1.29.173-1.414z"/></svg>
                  <span>Send</span>
                </button>
              </td>
            </tr>
          `;
        })
        .join('');
    }

    const selectedItems = allItems.filter(item => state.batchWhatsApp.selectedClientIds.has(String(item.client.id)));
    const totalSelectedDue = selectedItems.reduce((sum, item) => sum + (Number(item.ledger.finalBalance) || 0), 0);

    if (selectedStat) selectedStat.textContent = String(selectedItems.length);
    if (totalStat) totalStat.textContent = formatCurrency(totalSelectedDue);
    if (startBtnText) startBtnText.textContent = `Send WhatsApp Invoices (${selectedItems.length})`;

    if (selectAllCb) {
      selectAllCb.checked = allItems.length > 0 && selectedItems.length === allItems.length;
      selectAllCb.indeterminate = selectedItems.length > 0 && selectedItems.length < allItems.length;
    }
  }

  function toggleSelectAllBatchWhatsApp(isChecked) {
    if (!state.batchWhatsApp) return;
    const allItems = state.batchWhatsApp.items || [];
    if (isChecked) {
      state.batchWhatsApp.selectedClientIds = new Set(allItems.map(item => String(item.client.id)));
    } else {
      state.batchWhatsApp.selectedClientIds.clear();
    }
    renderBatchWhatsAppTable(state.batchWhatsApp.filterQuery);
  }

  function onBatchWaClientToggle(clientId, isChecked) {
    if (!state.batchWhatsApp) return;
    if (isChecked) {
      state.batchWhatsApp.selectedClientIds.add(String(clientId));
    } else {
      state.batchWhatsApp.selectedClientIds.delete(String(clientId));
    }
    renderBatchWhatsAppTable(state.batchWhatsApp.filterQuery);
  }

  function filterBatchWhatsAppList() {
    if (!state.batchWhatsApp) return;
    const query = document.getElementById('batch-wa-search-input')?.value || '';
    state.batchWhatsApp.filterQuery = query;
    renderBatchWhatsAppTable(query);
  }

  function updateClientPhoneInline(clientId) {
    const input = document.getElementById(`inline-phone-${clientId}`);
    if (!input) return;
    const val = input.value.trim();
    if (!val) {
      showToast('Please enter a phone number', true);
      return;
    }
    const client = (state.clients || []).find(c => String(c.id) === String(clientId));
    if (client) {
      client.phone = val;
      saveData();
      showToast(`Phone number updated for ${client.name}`);
      renderBatchWhatsAppTable(state.batchWhatsApp.filterQuery);
    }
  }

  function sendSingleBatchWhatsApp(clientId) {
    if (!state.batchWhatsApp) return;
    const item = (state.batchWhatsApp.items || []).find(it => String(it.client.id) === String(clientId));
    if (!item) return;

    const c = item.client;
    let phoneDigits = normalizeWhatsAppPhone(c.phone);

    if (!phoneDigits) {
      const entered = prompt(`Please enter WhatsApp number (10 digits) for ${c.name || 'this client'}:`, '');
      if (entered === null) return;
      phoneDigits = normalizeWhatsAppPhone(entered);
      if (phoneDigits) {
        c.phone = entered.trim();
        saveData();
      }
    }

    const msg = buildPendingInvoiceWhatsAppMessage(c, item.unpaidRows, item.ledger.finalBalance, item.ledger);
    const encodedText = encodeURIComponent(msg);
    const waUrl = phoneDigits
      ? `https://api.whatsapp.com/send?phone=${phoneDigits}&text=${encodedText}`
      : `https://api.whatsapp.com/send?text=${encodedText}`;

    const a = document.createElement('a');
    a.href = waUrl;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 150);

    item.status = 'sent';
    const statusCell = document.getElementById(`batch-wa-status-${c.id}`);
    if (statusCell) {
      statusCell.className = 'text-xs font-bold px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-300';
      statusCell.textContent = 'Sent ✓';
    }
    const row = document.getElementById(`batch-wa-row-${c.id}`);
    if (row) row.classList.add('bg-emerald-50/40');

    showToast(`WhatsApp invoice opened for ${c.businessName || c.name}!`);
  }

  function startBatchWhatsAppQueue() {
    if (!state.batchWhatsApp) return;
    stopBatchWhatsAppQueue();

    const selectedItems = (state.batchWhatsApp.items || []).filter(item =>
      state.batchWhatsApp.selectedClientIds.has(String(item.client.id))
    );

    if (selectedItems.length === 0) {
      showToast('Please select at least 1 client to send WhatsApp invoices.', true);
      return;
    }

    state.batchWhatsApp.queue = selectedItems;
    state.batchWhatsApp.currentIndex = 0;
    state.batchWhatsApp.isRunning = true;

    const banner = document.getElementById('batch-wa-progress-banner');
    if (banner) banner.classList.remove('hidden');

    processNextInBatchQueue();
  }

  function processNextInBatchQueue() {
    if (!state.batchWhatsApp || !state.batchWhatsApp.isRunning) return;

    const { queue, currentIndex } = state.batchWhatsApp;

    if (currentIndex >= queue.length) {
      state.batchWhatsApp.isRunning = false;
      const progressText = document.getElementById('batch-wa-progress-text');
      const progressBar = document.getElementById('batch-wa-progress-bar');
      const nextBox = document.getElementById('batch-wa-next-action-box');

      if (progressText) progressText.innerHTML = `🎉 <span class="text-emerald-950 font-bold">Done! All ${queue.length} WhatsApp invoices opened!</span>`;
      if (progressBar) progressBar.style.width = '100%';
      if (nextBox) nextBox.innerHTML = `<span class="text-xs font-bold text-emerald-800">All selected client reminders have been launched to WhatsApp.</span>`;

      showToast(`🎉 All ${queue.length} WhatsApp invoices opened!`);
      return;
    }

    const currentItem = queue[currentIndex];
    const c = currentItem.client;

    const percent = Math.round(((currentIndex + 1) / queue.length) * 100);
    const progressBar = document.getElementById('batch-wa-progress-bar');
    const progressText = document.getElementById('batch-wa-progress-text');
    const currentItemHint = document.getElementById('batch-wa-current-item-hint');
    const manualBtn = document.getElementById('batch-wa-manual-next-btn');

    if (progressBar) progressBar.style.width = `${percent}%`;
    if (progressText) {
      progressText.textContent = `Dispatched ${currentIndex + 1} of ${queue.length}: ${c.businessName || c.name}`;
    }

    let phoneDigits = normalizeWhatsAppPhone(c.phone);
    const msg = buildPendingInvoiceWhatsAppMessage(c, currentItem.unpaidRows, currentItem.ledger.finalBalance, currentItem.ledger);
    const encodedText = encodeURIComponent(msg);
    const waUrl = phoneDigits
      ? `https://api.whatsapp.com/send?phone=${phoneDigits}&text=${encodedText}`
      : `https://api.whatsapp.com/send?text=${encodedText}`;

    const a = document.createElement('a');
    a.href = waUrl;
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 150);

    currentItem.status = 'sent';
    const statusCell = document.getElementById(`batch-wa-status-${c.id}`);
    if (statusCell) {
      statusCell.className = 'text-xs font-bold px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 border border-emerald-300';
      statusCell.textContent = 'Sent ✓';
    }
    const row = document.getElementById(`batch-wa-row-${c.id}`);
    if (row) row.classList.add('bg-emerald-50/40');

    state.batchWhatsApp.currentIndex++;

    if (state.batchWhatsApp.currentIndex < queue.length) {
      const nextItem = queue[state.batchWhatsApp.currentIndex];
      const nextName = nextItem.client.businessName || nextItem.client.name;
      const nextDue = formatCurrency(nextItem.ledger.finalBalance);

      if (currentItemHint) {
        currentItemHint.innerHTML = `Next: <strong>${escapeHtml(nextName)}</strong> (${nextDue} due)`;
      }
      if (manualBtn) {
        manualBtn.innerHTML = `<span>Send Next (${state.batchWhatsApp.currentIndex + 1}/${queue.length}) ➡️</span>`;
      }

      const autoAdvance = document.getElementById('batch-wa-auto-advance')?.checked;
      if (autoAdvance) {
        state.batchWhatsApp.timer = setTimeout(() => {
          processNextInBatchQueue();
        }, 2500);
      }
    } else {
      processNextInBatchQueue();
    }
  }

  function sendNextInBatchQueue() {
    if (!state.batchWhatsApp) return;
    if (state.batchWhatsApp.timer) {
      clearTimeout(state.batchWhatsApp.timer);
      state.batchWhatsApp.timer = null;
    }
    processNextInBatchQueue();
  }

  function stopBatchWhatsAppQueue() {
    if (!state.batchWhatsApp) return;
    if (state.batchWhatsApp.timer) {
      clearTimeout(state.batchWhatsApp.timer);
      state.batchWhatsApp.timer = null;
    }
    state.batchWhatsApp.isRunning = false;
    const progressText = document.getElementById('batch-wa-progress-text');
    if (progressText) progressText.textContent = 'Batch WhatsApp Queue Stopped / Paused.';
  }

  function copyBatchWhatsAppSummary() {
    if (!state.batchWhatsApp) return;
    const allItems = state.batchWhatsApp.items || [];
    const selectedItems = allItems.filter(item => state.batchWhatsApp.selectedClientIds.has(String(item.client.id)));

    if (selectedItems.length === 0) {
      showToast('No clients selected to copy summary.', true);
      return;
    }

    const businessTitle = state.settings.businessName || 'Digital CA Services';
    const totalDue = selectedItems.reduce((sum, item) => sum + (Number(item.ledger.finalBalance) || 0), 0);

    let text = `📋 PENDING DUES SUMMARY - ${businessTitle.toUpperCase()}\n`;
    text += `Date: ${formatDate(getTodayDate())}\n`;
    text += `Total Outstanding: ${formatCurrency(totalDue)} (${selectedItems.length} Clients)\n`;
    text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

    selectedItems.forEach((item, idx) => {
      const c = item.client;
      const l = item.ledger;
      const monthsStr = (item.unpaidRows || []).map(r => r.fullMonthName).join(', ');
      text += `${idx + 1}. ${c.businessName || c.name}${c.businessName ? ` (${c.name})` : ''}\n`;
      text += `   • Phone: ${c.phone || 'No phone'}\n`;
      text += `   • Pending Balance: ${formatCurrency(l.finalBalance)}\n`;
      text += `   • Months: ${monthsStr || 'Unallocated due'}\n\n`;
    });

    text += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n`;
    text += `Generated via Client Ledger Pro`;

    if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        showToast('Pending dues summary copied to clipboard! 📋');
      }).catch(() => {
        fallbackCopyTextToClipboard(text);
      });
    } else {
      fallbackCopyTextToClipboard(text);
    }
  }

  function fallbackCopyTextToClipboard(text) {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    try {
      document.execCommand('copy');
      showToast('Pending dues summary copied to clipboard! 📋');
    } catch (err) {
      showToast('Could not copy to clipboard', true);
    }
    textArea.remove();
  }

  function toggleBatchWaSamplePreview() {
    const previewBox = document.getElementById('batch-wa-sample-preview');
    if (previewBox) {
      previewBox.classList.toggle('hidden');
    }
  }

  // ==================== EXPORT & IMPORT ====================
  function exportJSON() {
    const data = {
      clients: state.clients,
      expenses: state.expenses || [],
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
          if (Array.isArray(parsed.expenses)) {
            state.expenses = parsed.expenses;
          }
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

  // ==================== PAYMENTS & EXPENSES MANAGEMENT ====================
  function amountToWords(amount) {
    const num = Math.round(Number(amount) || 0);
    if (num === 0) return 'Zero Rupees Only';
    const a = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
      'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
    const b = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

    function inWords(n) {
      if (n < 20) return a[n];
      if (n < 100) return b[Math.floor(n / 10)] + (n % 10 ? ' ' + a[n % 10] : '');
      if (n < 1000) return a[Math.floor(n / 100)] + ' Hundred' + (n % 100 ? ' and ' + inWords(n % 100) : '');
      if (n < 100000) return inWords(Math.floor(n / 1000)) + ' Thousand' + (n % 1000 ? ' ' + inWords(n % 1000) : '');
      if (n < 10000000) return inWords(Math.floor(n / 100000)) + ' Lakh' + (n % 100000 ? ' ' + inWords(n % 100000) : '');
      return inWords(Math.floor(n / 10000000)) + ' Crore' + (n % 10000000 ? ' ' + inWords(n % 10000000) : '');
    }

    return (inWords(num).trim() + ' Rupees Only');
  }

  function renderPaymentsView() {
    if (!Array.isArray(state.expenses)) state.expenses = [];

    // 1. Calculate KPI Metrics
    let totalOutflow = 0;
    let employeeTotal = 0;
    let employeeCount = 0;
    let officeTotal = 0;
    let officeCount = 0;
    let otherTotal = 0;
    let otherCount = 0;

    state.expenses.forEach(e => {
      const amt = Number(e.amount) || 0;
      totalOutflow += amt;
      if (e.category === 'employee') {
        employeeTotal += amt;
        employeeCount++;
      } else if (e.category === 'office') {
        officeTotal += amt;
        officeCount++;
      } else {
        otherTotal += amt;
        otherCount++;
      }
    });

    const totalEl = document.getElementById('exp-total-outflow');
    const totalCountEl = document.getElementById('exp-total-count');
    const empEl = document.getElementById('exp-total-employee');
    const empCountEl = document.getElementById('exp-employee-count');
    const offEl = document.getElementById('exp-total-office');
    const offCountEl = document.getElementById('exp-office-count');
    const othEl = document.getElementById('exp-total-other');
    const othCountEl = document.getElementById('exp-other-count');

    if (totalEl) totalEl.textContent = formatCurrency(totalOutflow);
    if (totalCountEl) totalCountEl.textContent = `${state.expenses.length} transaction${state.expenses.length === 1 ? '' : 's'} recorded`;
    if (empEl) empEl.textContent = formatCurrency(employeeTotal);
    if (empCountEl) empCountEl.textContent = `${employeeCount} salary payout${employeeCount === 1 ? '' : 's'}`;
    if (offEl) offEl.textContent = formatCurrency(officeTotal);
    if (offCountEl) offCountEl.textContent = `${officeCount} office expense${officeCount === 1 ? '' : 's'}`;
    if (othEl) othEl.textContent = formatCurrency(otherTotal);
    if (othCountEl) othCountEl.textContent = `${otherCount} other overhead${otherCount === 1 ? '' : 's'}`;

    // Update Nav Badge
    const navBadge = document.getElementById('nav-expense-count');
    if (navBadge) {
      navBadge.textContent = state.expenses.length;
      if (state.expenses.length > 0) navBadge.classList.remove('hidden');
      else navBadge.classList.add('hidden');
    }

    // Update Category Pill Badges
    const badgeAll = document.getElementById('exp-badge-all');
    const badgeEmp = document.getElementById('exp-badge-employee');
    const badgeOff = document.getElementById('exp-badge-office');
    const badgeOth = document.getElementById('exp-badge-other');
    if (badgeAll) badgeAll.textContent = state.expenses.length;
    if (badgeEmp) badgeEmp.textContent = employeeCount;
    if (badgeOff) badgeOff.textContent = officeCount;
    if (badgeOth) badgeOth.textContent = otherCount;

    // Filter active pill styles
    const cat = state.expenseFilter?.category || 'all';
    ['all', 'employee', 'office', 'other'].forEach(c => {
      const btn = document.getElementById(`exp-filter-btn-${c}`);
      if (!btn) return;
      if (c === cat) {
        btn.className = 'px-3.5 py-1.5 rounded-lg text-xs font-bold transition bg-blue-50 text-blue-700 border border-blue-200';
      } else {
        btn.className = 'px-3.5 py-1.5 rounded-lg text-xs font-semibold transition text-slate-600 hover:text-slate-900 hover:bg-slate-100';
      }
    });

    // 2. Filter Rows
    let list = [...state.expenses];

    // Filter by Category
    if (cat !== 'all') {
      list = list.filter(e => e.category === cat);
    }

    // Filter by Date Range
    const from = state.expenseFilter?.from;
    const to = state.expenseFilter?.to;
    if (from) {
      list = list.filter(e => e.date >= from);
    }
    if (to) {
      list = list.filter(e => e.date <= to);
    }

    // Filter by Search Query
    const query = (state.expenseFilter?.search || '').trim().toLowerCase();
    if (query) {
      list = list.filter(e => {
        const title = (e.title || '').toLowerCase();
        const payee = (e.payee || '').toLowerCase();
        const catName = (e.category || '').toLowerCase();
        const subcat = (e.subcategory || '').toLowerCase();
        const role = (e.employeeRole || '').toLowerCase();
        const bill = (e.billNumber || '').toLowerCase();
        const ref = (e.reference || '').toLowerCase();
        const method = (e.method || '').toLowerCase();
        const notes = (e.notes || '').toLowerCase();
        return (
          title.includes(query) ||
          payee.includes(query) ||
          catName.includes(query) ||
          subcat.includes(query) ||
          role.includes(query) ||
          bill.includes(query) ||
          ref.includes(query) ||
          method.includes(query) ||
          notes.includes(query)
        );
      });
    }

    // Sort by Date Descending (newest first)
    list.sort((a, b) => {
      const dComp = (b.date || '').localeCompare(a.date || '');
      if (dComp !== 0) return dComp;
      return (b.createdAt || '').localeCompare(a.createdAt || '');
    });

    // Render Table
    const tbody = document.getElementById('expenses-table-body');
    const emptyState = document.getElementById('expenses-empty-state');
    if (!tbody) return;

    if (list.length === 0) {
      tbody.innerHTML = '';
      if (emptyState) emptyState.classList.remove('hidden');
      return;
    }

    if (emptyState) emptyState.classList.add('hidden');

    tbody.innerHTML = list.map(e => {
      let catBadge = '';
      let payeeDesc = '';

      if (e.category === 'employee') {
        catBadge = `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-blue-100 text-blue-800 border border-blue-200">👥 Employee</span>`;
        payeeDesc = `
          <div class="font-bold text-slate-900">${escapeHtml(e.payee || 'Employee')}</div>
          <div class="text-[11px] text-slate-500">
            ${e.employeeRole ? `${escapeHtml(e.employeeRole)} &bull; ` : ''}
            ${e.salaryMonth ? `Salary: <span class="font-semibold text-slate-700">${formatFullMonthName(e.salaryMonth)}</span> &bull; ` : ''}
            <span class="text-blue-700 font-medium">${escapeHtml(e.subcategory || 'Salary')}</span>
          </div>
        `;
      } else if (e.category === 'office') {
        catBadge = `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 text-emerald-800 border border-emerald-200">🏢 Office</span>`;
        payeeDesc = `
          <div class="font-bold text-slate-900">${escapeHtml(e.subcategory || 'Office Expense')}</div>
          <div class="text-[11px] text-slate-500">
            ${e.payee ? `Payee: <span class="font-medium text-slate-700">${escapeHtml(e.payee)}</span>` : ''}
            ${e.billNumber ? ` &bull; Bill #${escapeHtml(e.billNumber)}` : ''}
          </div>
        `;
      } else {
        catBadge = `<span class="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold bg-purple-100 text-purple-800 border border-purple-200">📋 Other</span>`;
        payeeDesc = `
          <div class="font-bold text-slate-900">${escapeHtml(e.title || e.subcategory || 'Other Expense')}</div>
          <div class="text-[11px] text-slate-500">
            ${e.payee ? `Payee: <span class="font-medium text-slate-700">${escapeHtml(e.payee)}</span> &bull; ` : ''}
            <span class="text-purple-700 font-medium">${escapeHtml(e.subcategory || 'Misc')}</span>
          </div>
        `;
      }

      return `
        <tr class="hover:bg-slate-50/80 transition group">
          <td class="py-3 px-4 font-semibold text-slate-800 whitespace-nowrap">
            ${formatDate(e.date)}
          </td>
          <td class="py-3 px-4 whitespace-nowrap">
            ${catBadge}
          </td>
          <td class="py-3 px-4">
            ${payeeDesc}
          </td>
          <td class="py-3 px-4 text-right whitespace-nowrap">
            <span class="font-black text-rose-600 text-sm">- ${formatCurrency(e.amount)}</span>
          </td>
          <td class="py-3 px-4 whitespace-nowrap">
            <span class="inline-block px-2 py-0.5 rounded text-[11px] font-medium bg-slate-100 text-slate-700">
              ${escapeHtml(e.method || 'Cash')}
            </span>
          </td>
          <td class="py-3 px-4 font-mono text-[11px] text-slate-500 whitespace-nowrap">
            ${escapeHtml(e.reference || e.billNumber || '--')}
          </td>
          <td class="py-3 px-4 text-slate-500 text-xs max-w-xs truncate" title="${escapeHtml(e.notes || '')}">
            ${escapeHtml(e.notes || '--')}
          </td>
          <td class="py-3 px-4 text-center whitespace-nowrap">
            <div class="flex items-center justify-center gap-1.5">
              <button onclick="app.viewExpenseVoucher('${e.id}')" class="p-1.5 text-blue-600 hover:bg-blue-50 rounded-lg transition" title="View / Print Payment Voucher">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/></svg>
              </button>
              <button onclick="app.openRecordExpenseModal('${e.id}')" class="p-1.5 text-slate-600 hover:bg-slate-100 rounded-lg transition" title="Edit Expense">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"/></svg>
              </button>
              <button onclick="app.deleteExpense('${e.id}')" class="p-1.5 text-rose-600 hover:bg-rose-50 rounded-lg transition" title="Delete Expense">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"/></svg>
              </button>
            </div>
          </td>
        </tr>
      `;
    }).join('');
  }

  function setExpenseCategoryFilter(category) {
    if (!state.expenseFilter) state.expenseFilter = {};
    state.expenseFilter.category = category;
    renderPaymentsView();
  }

  function onExpenseSearchChange(query) {
    if (!state.expenseFilter) state.expenseFilter = {};
    state.expenseFilter.search = query;
    renderPaymentsView();
  }

  function onExpensePresetChange(preset) {
    if (!state.expenseFilter) state.expenseFilter = {};
    state.expenseFilter.preset = preset;
    const range = getPresetDateRange(preset);
    state.expenseFilter.from = range.from;
    state.expenseFilter.to = range.to;

    const fromEl = document.getElementById('exp-from-date');
    const toEl = document.getElementById('exp-to-date');
    if (fromEl) fromEl.value = range.from;
    if (toEl) toEl.value = range.to;

    renderPaymentsView();
  }

  function applyExpenseCustomDates() {
    if (!state.expenseFilter) state.expenseFilter = {};
    const fromEl = document.getElementById('exp-from-date');
    const toEl = document.getElementById('exp-to-date');
    state.expenseFilter.from = fromEl ? fromEl.value : '';
    state.expenseFilter.to = toEl ? toEl.value : '';
    state.expenseFilter.preset = 'custom';
    const presetSelect = document.getElementById('exp-date-preset');
    if (presetSelect) presetSelect.value = 'custom';
    renderPaymentsView();
  }

  function resetExpenseFilter() {
    state.expenseFilter = { category: 'all', search: '', preset: 'all', from: '', to: '' };
    const searchEl = document.getElementById('exp-search-input');
    const presetSelect = document.getElementById('exp-date-preset');
    const fromEl = document.getElementById('exp-from-date');
    const toEl = document.getElementById('exp-to-date');
    if (searchEl) searchEl.value = '';
    if (presetSelect) presetSelect.value = 'all';
    if (fromEl) fromEl.value = '';
    if (toEl) toEl.value = '';
    renderPaymentsView();
  }

  function onExpenseCategorySelect(cat) {
    ['employee', 'office', 'other'].forEach(c => {
      const container = document.getElementById(`expense-fields-${c}`);
      const label = document.getElementById(`exp-cat-label-${c}`);
      if (container) {
        if (c === cat) container.classList.remove('hidden');
        else container.classList.add('hidden');
      }
      if (label) {
        if (c === cat) {
          label.className = 'relative flex flex-col p-3 rounded-xl border-2 border-blue-500 bg-blue-50/40 cursor-pointer transition text-center select-none';
        } else {
          label.className = 'relative flex flex-col p-3 rounded-xl border-2 border-slate-200 bg-white cursor-pointer transition text-center select-none';
        }
      }
    });
  }

  function onOfficeSubcatChange(value) {
    const customInput = document.getElementById('expense-office-custom-subcat');
    if (customInput) {
      if (value === 'custom') customInput.classList.remove('hidden');
      else customInput.classList.add('hidden');
    }
  }

  function openRecordExpenseModal(expenseId = null) {
    const editIdInput = document.getElementById('expense-edit-id');
    const titleEl = document.getElementById('expense-modal-title');
    const submitBtn = document.getElementById('expense-submit-btn');

    // Populate previous employee names in suggestions
    const datalist = document.getElementById('employee-suggestions');
    if (datalist && Array.isArray(state.expenses)) {
      const uniqueNames = [...new Set(state.expenses.filter(e => e.category === 'employee' && e.payee).map(e => e.payee))];
      datalist.innerHTML = uniqueNames.map(n => `<option value="${escapeHtml(n)}"></option>`).join('');
    }

    if (expenseId) {
      const exp = (state.expenses || []).find(e => e.id === expenseId);
      if (!exp) {
        showToast('Expense record not found', true);
        return;
      }
      state.activeExpenseId = exp.id;
      if (editIdInput) editIdInput.value = exp.id;
      if (titleEl) titleEl.innerHTML = `<span>✏️</span> <span>Edit Payment / Expense</span>`;
      if (submitBtn) submitBtn.innerHTML = `<span>💾 Update Payment</span>`;

      // Set category radio
      const catRadio = document.querySelector(`input[name="expense-main-category"][value="${exp.category}"]`);
      if (catRadio) catRadio.checked = true;
      onExpenseCategorySelect(exp.category);

      // Fill category fields
      if (exp.category === 'employee') {
        const nameEl = document.getElementById('expense-emp-name');
        const roleEl = document.getElementById('expense-emp-role');
        const monthEl = document.getElementById('expense-emp-month');
        const typeEl = document.getElementById('expense-emp-type');
        if (nameEl) nameEl.value = exp.payee || '';
        if (roleEl) roleEl.value = exp.employeeRole || '';
        if (monthEl) monthEl.value = exp.salaryMonth || '';
        if (typeEl) typeEl.value = exp.subcategory || 'Monthly Salary';
      } else if (exp.category === 'office') {
        const subcatEl = document.getElementById('expense-office-subcat');
        const customSubcatEl = document.getElementById('expense-office-custom-subcat');
        const payeeEl = document.getElementById('expense-office-payee');
        const billEl = document.getElementById('expense-office-bill-no');
        if (payeeEl) payeeEl.value = exp.payee || '';
        if (billEl) billEl.value = exp.billNumber || '';

        const knownOptions = ['Office Rent', 'Electricity Bill', 'Internet & Broadband', 'Stationery & Printing', 'Tea, Coffee & Pantry', 'Cleaning & Housekeeping', 'Software & Cloud Subscriptions', 'Water Supply', 'Repairs & Maintenance', 'Furniture & Equipment'];
        if (knownOptions.includes(exp.subcategory)) {
          if (subcatEl) subcatEl.value = exp.subcategory;
          if (customSubcatEl) { customSubcatEl.value = ''; customSubcatEl.classList.add('hidden'); }
        } else {
          if (subcatEl) subcatEl.value = 'custom';
          if (customSubcatEl) { customSubcatEl.value = exp.subcategory || ''; customSubcatEl.classList.remove('hidden'); }
        }
      } else {
        const titleInput = document.getElementById('expense-other-title');
        const tagEl = document.getElementById('expense-other-tag');
        const payeeEl = document.getElementById('expense-other-payee');
        if (titleInput) titleInput.value = exp.title || '';
        if (tagEl) tagEl.value = exp.subcategory || 'Miscellaneous';
        if (payeeEl) payeeEl.value = exp.payee || '';
      }

      // Universal fields
      const amtInput = document.getElementById('expense-amount-input');
      const dateInput = document.getElementById('expense-date-input');
      const methodInput = document.getElementById('expense-method-input');
      const refInput = document.getElementById('expense-ref-input');
      const notesInput = document.getElementById('expense-notes-input');

      if (amtInput) amtInput.value = exp.amount || '';
      if (dateInput) dateInput.value = exp.date || getTodayDate();
      if (methodInput) methodInput.value = exp.method || 'UPI / PhonePe / GPay';
      if (refInput) refInput.value = exp.reference || '';
      if (notesInput) notesInput.value = exp.notes || '';

    } else {
      // New Expense
      state.activeExpenseId = null;
      if (editIdInput) editIdInput.value = '';
      if (titleEl) titleEl.innerHTML = `<span>💸</span> <span>Record Outgoing Payment / Expense</span>`;
      if (submitBtn) submitBtn.innerHTML = `<span>💾 Save Outgoing Payment</span>`;

      // Default category is employee or whatever is currently filtered
      const defaultCat = (state.expenseFilter?.category && state.expenseFilter?.category !== 'all') ? state.expenseFilter.category : 'employee';
      const catRadio = document.querySelector(`input[name="expense-main-category"][value="${defaultCat}"]`);
      if (catRadio) catRadio.checked = true;
      onExpenseCategorySelect(defaultCat);

      // Reset fields
      const empName = document.getElementById('expense-emp-name');
      const empRole = document.getElementById('expense-emp-role');
      const empMonth = document.getElementById('expense-emp-month');
      const empType = document.getElementById('expense-emp-type');
      if (empName) empName.value = '';
      if (empRole) empRole.value = '';
      if (empMonth) empMonth.value = getLastMonth();
      if (empType) empType.value = 'Monthly Salary';

      const offSubcat = document.getElementById('expense-office-subcat');
      const offCustom = document.getElementById('expense-office-custom-subcat');
      const offPayee = document.getElementById('expense-office-payee');
      const offBill = document.getElementById('expense-office-bill-no');
      if (offSubcat) offSubcat.value = 'Office Rent';
      if (offCustom) { offCustom.value = ''; offCustom.classList.add('hidden'); }
      if (offPayee) offPayee.value = '';
      if (offBill) offBill.value = '';

      const othTitle = document.getElementById('expense-other-title');
      const othTag = document.getElementById('expense-other-tag');
      const othPayee = document.getElementById('expense-other-payee');
      if (othTitle) othTitle.value = '';
      if (othTag) othTag.value = 'Travel & Conveyance';
      if (othPayee) othPayee.value = '';

      const amtInput = document.getElementById('expense-amount-input');
      const dateInput = document.getElementById('expense-date-input');
      const methodInput = document.getElementById('expense-method-input');
      const refInput = document.getElementById('expense-ref-input');
      const notesInput = document.getElementById('expense-notes-input');

      if (amtInput) amtInput.value = '';
      if (dateInput) dateInput.value = getTodayDate();
      if (methodInput) methodInput.value = 'UPI / PhonePe / GPay';
      if (refInput) refInput.value = '';
      if (notesInput) notesInput.value = '';
    }

    openModal('recordExpenseModal');
  }

  async function handleSaveExpense(event) {
    if (event) event.preventDefault();

    const editId = (document.getElementById('expense-edit-id')?.value || '').trim();
    const catRadio = document.querySelector('input[name="expense-main-category"]:checked');
    const category = catRadio ? catRadio.value : 'employee';

    const amtVal = parseFloat(document.getElementById('expense-amount-input')?.value || '0');
    if (isNaN(amtVal) || amtVal <= 0) {
      showToast('Please enter a valid expense amount greater than 0', true);
      return;
    }

    const dateVal = (document.getElementById('expense-date-input')?.value || '').trim() || getTodayDate();
    const methodVal = (document.getElementById('expense-method-input')?.value || '').trim() || 'UPI';
    const refVal = (document.getElementById('expense-ref-input')?.value || '').trim();
    const notesVal = (document.getElementById('expense-notes-input')?.value || '').trim();

    let payeeVal = '';
    let titleVal = '';
    let subcatVal = '';
    let empRoleVal = '';
    let empMonthVal = '';
    let billNoVal = '';

    if (category === 'employee') {
      payeeVal = (document.getElementById('expense-emp-name')?.value || '').trim();
      if (!payeeVal) {
        showToast('Please enter employee name', true);
        document.getElementById('expense-emp-name')?.focus();
        return;
      }
      empRoleVal = (document.getElementById('expense-emp-role')?.value || '').trim();
      empMonthVal = (document.getElementById('expense-emp-month')?.value || '').trim();
      subcatVal = (document.getElementById('expense-emp-type')?.value || '').trim() || 'Monthly Salary';
      titleVal = `${payeeVal} - ${subcatVal}${empMonthVal ? ` (${formatFullMonthName(empMonthVal)})` : ''}`;
    } else if (category === 'office') {
      const offSelect = document.getElementById('expense-office-subcat')?.value || 'Office Rent';
      if (offSelect === 'custom') {
        subcatVal = (document.getElementById('expense-office-custom-subcat')?.value || '').trim() || 'Office Expense';
      } else {
        subcatVal = offSelect;
      }
      payeeVal = (document.getElementById('expense-office-payee')?.value || '').trim();
      billNoVal = (document.getElementById('expense-office-bill-no')?.value || '').trim();
      titleVal = `${subcatVal}${payeeVal ? ` (${payeeVal})` : ''}`;
    } else {
      titleVal = (document.getElementById('expense-other-title')?.value || '').trim();
      if (!titleVal) {
        showToast('Please enter expense title or description', true);
        document.getElementById('expense-other-title')?.focus();
        return;
      }
      subcatVal = (document.getElementById('expense-other-tag')?.value || '').trim() || 'Miscellaneous';
      payeeVal = (document.getElementById('expense-other-payee')?.value || '').trim();
    }

    if (!Array.isArray(state.expenses)) state.expenses = [];

    if (editId) {
      // Update existing expense
      const idx = state.expenses.findIndex(e => e.id === editId);
      if (idx !== -1) {
        state.expenses[idx] = {
          ...state.expenses[idx],
          category,
          subcategory: subcatVal,
          title: titleVal,
          payee: payeeVal,
          amount: amtVal,
          date: dateVal,
          method: methodVal,
          reference: refVal,
          notes: notesVal,
          employeeRole: empRoleVal,
          salaryMonth: empMonthVal,
          billNumber: billNoVal,
          updatedAt: new Date().toISOString(),
        };
        showToast(`✅ Payment "${titleVal}" updated successfully!`);
      }
    } else {
      // Create new expense
      const newExp = {
        id: 'exp_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
        category,
        subcategory: subcatVal,
        title: titleVal,
        payee: payeeVal,
        amount: amtVal,
        date: dateVal,
        method: methodVal,
        reference: refVal,
        notes: notesVal,
        employeeRole: empRoleVal,
        salaryMonth: empMonthVal,
        billNumber: billNoVal,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      state.expenses.unshift(newExp);
      showToast(`✅ Payment of ${formatCurrency(amtVal)} recorded successfully!`);
    }

    closeModal('recordExpenseModal');
    renderPaymentsView();
    await saveData(true);
  }

  async function deleteExpense(expenseId) {
    const exp = (state.expenses || []).find(e => e.id === expenseId);
    if (!exp) return;
    const desc = exp.title || exp.payee || 'this payment';
    if (confirm(`Are you sure you want to delete payment record "${desc}" (${formatCurrency(exp.amount)})?`)) {
      state.expenses = state.expenses.filter(e => e.id !== expenseId);
      renderPaymentsView();
      await saveData(true);
      showToast(`Payment record deleted`);
    }
  }

  function viewExpenseVoucher(expenseId) {
    const exp = (state.expenses || []).find(e => e.id === expenseId);
    if (!exp) {
      showToast('Expense record not found', true);
      return;
    }
    state.activeExpenseId = exp.id;

    const voucherContainer = document.getElementById('printable-voucher-content');
    if (!voucherContainer) return;

    const voucherNum = 'VCH-' + (exp.date ? exp.date.replace(/-/g, '') : '00') + '-' + exp.id.slice(-4).toUpperCase();
    const biz = state.settings || {};
    const bizName = biz.businessName || 'Business Services & Solutions';

    let catLabel = 'Payment / Expense';
    if (exp.category === 'employee') catLabel = 'Employee Salary Disbursement';
    else if (exp.category === 'office') catLabel = 'Office Operational Expense';
    else catLabel = 'General Business Expense';

    voucherContainer.innerHTML = `
      <div class="space-y-6 text-slate-800">
        <!-- Voucher Header -->
        <div class="flex justify-between items-start border-b-2 border-slate-900 pb-5">
          <div>
            <h2 class="text-2xl font-black text-slate-900 tracking-tight">${escapeHtml(bizName)}</h2>
            ${biz.businessAddress ? `<p class="text-xs text-slate-600 mt-1">${escapeHtml(biz.businessAddress)}</p>` : ''}
            <div class="text-xs text-slate-500 mt-0.5 flex flex-wrap gap-x-3">
              ${biz.businessPhone ? `<span>Phone: ${escapeHtml(biz.businessPhone)}</span>` : ''}
              ${biz.businessEmail ? `<span>Email: ${escapeHtml(biz.businessEmail)}</span>` : ''}
            </div>
          </div>
          <div class="text-right">
            <span class="inline-block px-3 py-1 bg-slate-900 text-white text-xs font-bold uppercase tracking-wider rounded-lg">
              Payment Voucher
            </span>
            <div class="mt-2 text-xs">
              <span class="text-slate-500">Voucher No:</span> <strong class="font-mono text-slate-900">${voucherNum}</strong>
            </div>
            <div class="text-xs">
              <span class="text-slate-500">Date:</span> <strong class="text-slate-900">${formatDate(exp.date)}</strong>
            </div>
          </div>
        </div>

        <!-- Paid To & Category Details -->
        <div class="grid grid-cols-2 gap-4 bg-slate-50 p-4 rounded-xl border border-slate-200 text-xs">
          <div>
            <span class="text-slate-500 font-medium block uppercase text-[10px] tracking-wider">Paid To / Beneficiary:</span>
            <strong class="text-sm text-slate-900 block mt-0.5">${escapeHtml(exp.payee || exp.title || 'Bearer')}</strong>
            ${exp.employeeRole ? `<span class="text-slate-600">Designation: ${escapeHtml(exp.employeeRole)}</span>` : ''}
            ${exp.billNumber ? `<span class="text-slate-600">Bill / Inv #: ${escapeHtml(exp.billNumber)}</span>` : ''}
          </div>
          <div class="text-right sm:text-left">
            <span class="text-slate-500 font-medium block uppercase text-[10px] tracking-wider">Category / Payout Type:</span>
            <strong class="text-sm text-slate-900 block mt-0.5">${catLabel}</strong>
            <span class="text-slate-600">${escapeHtml(exp.subcategory || '')}</span>
            ${exp.salaryMonth ? `<span class="block text-blue-700 font-semibold">For Period: ${formatFullMonthName(exp.salaryMonth)}</span>` : ''}
          </div>
        </div>

        <!-- Particulars Table -->
        <div class="border border-slate-200 rounded-xl overflow-hidden">
          <table class="w-full text-left text-xs">
            <thead class="bg-slate-100 font-bold text-slate-700 uppercase tracking-wider border-b border-slate-200 text-[11px]">
              <tr>
                <th class="py-3 px-4">Particulars / Description</th>
                <th class="py-3 px-4">Payment Method</th>
                <th class="py-3 px-4">Reference #</th>
                <th class="py-3 px-4 text-right">Amount (${state.settings.currency})</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-slate-100">
              <tr>
                <td class="py-3 px-4 font-semibold text-slate-900">
                  ${escapeHtml(exp.title || exp.subcategory || 'Disbursement')}
                  ${exp.notes ? `<div class="text-[11px] text-slate-500 font-normal italic mt-0.5">Note: ${escapeHtml(exp.notes)}</div>` : ''}
                </td>
                <td class="py-3 px-4 text-slate-700 font-medium">
                  ${escapeHtml(exp.method || 'Cash')}
                </td>
                <td class="py-3 px-4 font-mono text-slate-600">
                  ${escapeHtml(exp.reference || exp.billNumber || '--')}
                </td>
                <td class="py-3 px-4 text-right font-black text-rose-700 text-sm">
                  ${formatCurrency(exp.amount)}
                </td>
              </tr>
            </tbody>
            <tfoot class="bg-slate-50 font-bold border-t border-slate-200 text-xs">
              <tr class="bg-slate-100 text-slate-900">
                <td colspan="3" class="py-2.5 px-4 text-right uppercase text-[11px] font-black">Total Paid:</td>
                <td class="py-2.5 px-4 text-right font-black text-rose-700 text-base">${formatCurrency(exp.amount)}</td>
              </tr>
            </tfoot>
          </table>
        </div>

        <!-- Amount in Words -->
        <div class="bg-slate-50 p-3.5 rounded-xl border border-slate-200 text-xs">
          <span class="text-slate-500 font-medium">Amount in Words:</span>
          <strong class="text-slate-900 ml-1 italic font-semibold">${amountToWords(exp.amount)}</strong>
        </div>

        <!-- Declarations & Signatures -->
        <div class="pt-8 border-t border-slate-200 grid grid-cols-3 gap-6 text-center text-xs text-slate-600">
          <div>
            <div class="border-b border-slate-400 pb-10"></div>
            <p class="mt-1 font-bold text-slate-800">Prepared By</p>
          </div>
          <div>
            <div class="border-b border-slate-400 pb-10"></div>
            <p class="mt-1 font-bold text-slate-800">Authorized Signatory</p>
            <p class="text-[10px] text-slate-400">${escapeHtml(bizName)}</p>
          </div>
          <div>
            <div class="border-b border-slate-400 pb-10"></div>
            <p class="mt-1 font-bold text-slate-800">Receiver's Signature</p>
          </div>
        </div>

        <p class="text-[10px] text-center text-slate-400 pt-2">
          Subject to realization &bull; Official Computer-Generated Payment Voucher &bull; ClientLedger Pro
        </p>
      </div>
    `;

    openModal('expenseVoucherModal');
  }

  function sendExpenseVoucherWhatsApp() {
    const exp = (state.expenses || []).find(e => e.id === state.activeExpenseId);
    if (!exp) {
      showToast('Expense record not found', true);
      return;
    }
    const biz = state.settings || {};
    const bizName = biz.businessName || 'Our Business';

    let msg = `*PAYMENT DISBURSEMENT VOUCHER*\n`;
    msg += `------------------------------\n`;
    msg += `*From:* ${bizName}\n`;
    msg += `*Paid To:* ${exp.payee || exp.title || 'Recipient'}\n`;
    if (exp.category === 'employee' && exp.salaryMonth) {
      msg += `*Salary Month:* ${formatFullMonthName(exp.salaryMonth)}\n`;
    }
    msg += `*Category:* ${exp.category.toUpperCase()} - ${exp.subcategory || ''}\n`;
    msg += `*Amount Paid:* ${formatCurrency(exp.amount)}\n`;
    msg += `*Date:* ${formatDate(exp.date)}\n`;
    msg += `*Payment Method:* ${exp.method || 'Cash'}\n`;
    if (exp.reference) msg += `*Reference / UTR:* ${exp.reference}\n`;
    if (exp.notes) msg += `*Notes:* ${exp.notes}\n`;
    msg += `------------------------------\n`;
    msg += `_Thank you for your service & association._`;

    const url = `https://wa.me/?text=${encodeURIComponent(msg)}`;
    window.open(url, '_blank');
  }

  function exportExpensesToCSV() {
    if (!Array.isArray(state.expenses) || state.expenses.length === 0) {
      showToast('No expense records to export', true);
      return;
    }

    const headers = [
      'Date',
      'Category',
      'Subcategory',
      'Payee / Beneficiary',
      'Designation / Bill No',
      'Salary Month',
      'Amount',
      'Payment Method',
      'Reference / UTR',
      'Notes'
    ];

    const rows = state.expenses.map(e => [
      `"${e.date || ''}"`,
      `"${e.category || ''}"`,
      `"${(e.subcategory || '').replace(/"/g, '""')}"`,
      `"${(e.payee || '').replace(/"/g, '""')}"`,
      `"${(e.employeeRole || e.billNumber || '').replace(/"/g, '""')}"`,
      `"${e.salaryMonth || ''}"`,
      Number(e.amount) || 0,
      `"${(e.method || '').replace(/"/g, '""')}"`,
      `"${(e.reference || '').replace(/"/g, '""')}"`,
      `"${(e.notes || '').replace(/"/g, '""')}"`
    ]);

    const csvContent = 'data:text/csv;charset=utf-8,' + [headers.join(','), ...rows.map(r => r.join(','))].join('\n');
    const encodedUri = encodeURI(csvContent);
    const link = document.createElement('a');
    link.setAttribute('href', encodedUri);
    link.setAttribute('download', `Expenses_Report_${getTodayDate()}.csv`);
    document.body.appendChild(link);
    link.click();
    link.remove();
    showToast('Expenses CSV exported successfully!');
  }

  function printExpensesSummary() {
    window.print();
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
      'holdClientModal',
      'recordExpenseModal',
      'expenseVoucherModal',
      'printStatementModal',
      'paymentReceiptModal',
      'pendingInvoiceModal',
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
    onEditClientStatusChange,
    handleDeleteClient,
    openHoldClientModal,
    onHoldActionTypeChange,
    onResumeModeChange,
    setHoldReasonPreset,
    handleSaveHoldClient,
    resumeClientQuick,
    isClientCurrentlyOnHold,
    isClientOnHoldInMonth,
    getPreviousMonth,
    getNextMonth,
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
    onOverrideScopeChange,
    getClientBaseFeeForMonth,
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
    setMonthBreakdownFilter,
    printPendingInvoice,
    sendPendingInvoiceWhatsApp,
    openBatchPendingWhatsAppModal,
    renderBatchWhatsAppTable,
    toggleSelectAllBatchWhatsApp,
    onBatchWaClientToggle,
    filterBatchWhatsAppList,
    updateClientPhoneInline,
    sendSingleBatchWhatsApp,
    startBatchWhatsAppQueue,
    sendNextInBatchQueue,
    stopBatchWhatsAppQueue,
    copyBatchWhatsAppSummary,
    toggleBatchWaSamplePreview,
    renderPaymentsView,
    setExpenseCategoryFilter,
    onExpenseSearchChange,
    onExpensePresetChange,
    applyExpenseCustomDates,
    resetExpenseFilter,
    openRecordExpenseModal,
    onExpenseCategorySelect,
    onOfficeSubcatChange,
    handleSaveExpense,
    deleteExpense,
    viewExpenseVoucher,
    sendExpenseVoucherWhatsApp,
    exportExpensesToCSV,
    printExpensesSummary,
    amountToWords,
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
    get expenses() {
      return state.expenses;
    },
    get activeExpenseId() {
      return state.activeExpenseId;
    },
  };

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
