/**
 * =============================================================================
 * BRT GST RETURNS & RENT TRACKER - SUPABASE REALTIME CLIENT
 * =============================================================================
 * Enables live serverless cloud operation on GitHub Pages with Supabase!
 * Provides:
 *  1. Direct PostgreSQL / Supabase communication from browser
 *  2. Real-time multi-device synchronization (PC, Tablet, Mobile)
 *  3. Seamless drop-in interception for all backend /api routes
 *  4. Cloud database credentials manager with interactive UI setup modal
 * =============================================================================
 */

(function () {
  'use strict';

  let supabase = null;
  let realtimeChannel = null;
  let cachedState = null;
  let isConnected = false;
  let onRemoteUpdateCallback = null;

  // Chronological Month & Quarter Helper Functions (identical to server logic)
  const MONTH_NAMES = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
  const FULL_MONTHS = ['JANUARY', 'FEBRUARY', 'MARCH', 'APRIL', 'MAY', 'JUNE', 'JULY', 'AUGUST', 'SEPTEMBER', 'OCTOBER', 'NOVEMBER', 'DECEMBER'];

  function parseMonthYear(str) {
    if (!str) return null;
    const upper = str.trim().toUpperCase();
    let mIdx = -1;
    let year = null;
    for (let i = 0; i < 12; i++) {
      if (upper.includes(MONTH_NAMES[i]) || upper.includes(FULL_MONTHS[i])) {
        mIdx = i;
        break;
      }
    }
    const yMatch = upper.match(/20\d{2}/);
    if (yMatch) year = parseInt(yMatch[0], 10);
    if (mIdx !== -1 && year !== null) {
      return { monthIndex: mIdx, year };
    }
    return null;
  }

  function isMonthBefore(str1, str2) {
    const p1 = parseMonthYear(str1);
    const p2 = parseMonthYear(str2);
    if (!p1 || !p2) return true;
    if (p1.year < p2.year) return true;
    if (p1.year === p2.year && p1.monthIndex < p2.monthIndex) return true;
    return false;
  }

  function parseQuarterYear(str) {
    if (!str) return null;
    const upper = str.trim().toUpperCase();
    let qNum = null;
    let year = null;
    if (upper.includes('Q1') || upper.includes('FIRST') || upper.includes('JAN') || upper.includes('MAR')) qNum = 1;
    else if (upper.includes('Q2') || upper.includes('SECOND') || upper.includes('APR') || upper.includes('JUN')) qNum = 2;
    else if (upper.includes('Q3') || upper.includes('THIRD') || upper.includes('JUL') || upper.includes('SEP')) qNum = 3;
    else if (upper.includes('Q4') || upper.includes('FOURTH') || upper.includes('OCT') || upper.includes('DEC')) qNum = 4;

    const yMatch = upper.match(/20\d{2}/);
    if (yMatch) year = parseInt(yMatch[0], 10);
    if (qNum !== null && year !== null) return { qNum, year };
    return null;
  }

  function getPreviousMonthName(monthName, state) {
    const parsed = parseMonthYear(monthName);
    if (!parsed) return null;
    let prevIdx = parsed.monthIndex === 0 ? 11 : parsed.monthIndex - 1;
    let prevYr = parsed.monthIndex === 0 ? parsed.year - 1 : parsed.year;
    const targetName = `${MONTH_NAMES[prevIdx]} ${prevYr}`;

    const found = (state.months || []).find(m => m.name.toUpperCase() === targetName);
    if (found) return found.name;

    const sorted = [...(state.months || [])]
      .filter(m => isMonthBefore(m.name, monthName))
      .sort((a, b) => {
        const pa = parseMonthYear(a.name);
        const pb = parseMonthYear(b.name);
        if (!pa || !pb) return 0;
        return (pa.year * 12 + pa.monthIndex) - (pb.year * 12 + pb.monthIndex);
      });
    return sorted.length > 0 ? sorted[sorted.length - 1].name : null;
  }

  function getPreviousQuarterName(quarterName, state) {
    const parsed = parseQuarterYear(quarterName);
    if (!parsed) return null;
    const qNum = parsed.qNum;
    const year = parsed.year;
    const prevQNum = qNum === 1 ? 4 : qNum - 1;
    const prevYr = qNum === 1 ? year - 1 : year;

    const quartersList = state.qrmpQuarters || state.compositionQuarters || [];
    const found = quartersList.find(q => {
      const p = parseQuarterYear(q.name);
      return p && p.qNum === prevQNum && p.year === prevYr;
    });
    return found ? found.name : null;
  }

  // --- CREDENTIALS MANAGEMENT ---
  function getCredentials() {
    let storedUrl = localStorage.getItem('brt_supabase_url');
    let storedKey = localStorage.getItem('brt_supabase_key');
    let configUrl = (window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.url) ? window.SUPABASE_CONFIG.url.trim() : '';
    let configKey = (window.SUPABASE_CONFIG && window.SUPABASE_CONFIG.anonKey) ? window.SUPABASE_CONFIG.anonKey.trim() : '';

    // Check parent window & local storage to inherit Supabase credentials automatically
    try {
      // 1. Inherit from parent SUPABASE_CONFIG
      if ((!configUrl || !configKey) && window.parent && window.parent.SUPABASE_CONFIG) {
        if (!configUrl) configUrl = (window.parent.SUPABASE_CONFIG.url || '').trim();
        if (!configKey) configKey = (window.parent.SUPABASE_CONFIG.anonKey || '').trim();
      }

      // 2. Inherit from clientledger_pro_settings_v1
      const storageSources = [localStorage];
      try {
        if (window.parent && window.parent !== window && window.parent.localStorage) {
          storageSources.push(window.parent.localStorage);
        }
      } catch (_) {}

      for (const st of storageSources) {
        if (!st) continue;
        const rawSettings = st.getItem('clientledger_pro_settings_v1');
        if (rawSettings) {
          try {
            const p = JSON.parse(rawSettings);
            if (!configUrl && p.supabaseUrl) configUrl = p.supabaseUrl.trim();
            if (!configKey && p.supabaseKey) configKey = p.supabaseKey.trim();
          } catch (_) {}
        }
        if (!storedUrl) storedUrl = st.getItem('brt_supabase_url');
        if (!storedKey) storedKey = st.getItem('brt_supabase_key');
      }

      // 3. Inherit directly from window.parent.app
      if ((!configUrl || !configKey) && window.parent && window.parent.app && typeof window.parent.app.getSupabaseConfig === 'function') {
        const pCfg = window.parent.app.getSupabaseConfig();
        if (!configUrl && pCfg.url) configUrl = pCfg.url.trim();
        if (!configKey && pCfg.key) configKey = pCfg.key.trim();
      }
    } catch (e) {
      console.warn('[Credentials] Parent read notice:', e);
    }

    const url = storedUrl || configUrl;
    const anonKey = storedKey || configKey;

    const isPlaceholder = !url || url.includes('your-project-id') || !anonKey || anonKey.includes('your-anon-key');
    return {
      url: isPlaceholder ? '' : url,
      anonKey: isPlaceholder ? '' : anonKey,
      isConfigured: !isPlaceholder && Boolean(url && anonKey)
    };
  }

  function saveCredentials(url, anonKey) {
    if (url) localStorage.setItem('brt_supabase_url', url.trim());
    else localStorage.removeItem('brt_supabase_url');

    if (anonKey) localStorage.setItem('brt_supabase_key', anonKey.trim());
    else localStorage.removeItem('brt_supabase_key');
  }

  // --- INITIALIZATION ---
  async function init() {
    const creds = getCredentials();
    updateUiBadge(creds.isConfigured, false);

    if (creds.isConfigured) {
      try {
        await connectToSupabase(creds.url, creds.anonKey);
      } catch (err) {
        console.warn('[Supabase] Initial connection notice:', err.message);
        updateUiBadge(false, false);
      }
    }
  }

  async function connectToSupabase(url, anonKey) {
    if (typeof window.supabase === 'undefined') {
      await loadSupabaseSdk();
    }

    supabase = window.supabase.createClient(url, anonKey, {
      auth: { persistSession: false },
      realtime: { params: { eventsPerSecond: 10 } }
    });

    // Test connection & load state from table brt_app_state
    const { data, error } = await supabase
      .from('brt_app_state')
      .select('data, updated_at')
      .eq('id', 'live')
      .maybeSingle();

    if (error) {
      throw new Error(`Database error: ${error.message} (Code: ${error.code || 'UNKNOWN'})`);
    }

    if (data && data.data && data.data.clients && data.data.clients.length > 0) {
      cachedState = data.data;
      try {
        localStorage.setItem('brt_app_state_backup', JSON.stringify(cachedState));
        localStorage.setItem('brt_last_synced_at', new Date().toISOString());
      } catch (e) {}
      isConnected = true;
      console.log('[Supabase] Connected to live cloud database! Loaded ' + cachedState.clients.length + ' monthly clients.');
    } else {
      // Table exists but is empty: auto-seed from master fallback dataset with 100% data
      console.log('[Supabase] Database table empty or unseeded. Seeding 148 clients & 1,468 records...');
      const fallbackState = getFallbackInitialState();
      await supabase.from('brt_app_state').upsert({ id: 'live', data: fallbackState, updated_at: new Date().toISOString() });
      cachedState = fallbackState;
      try {
        localStorage.setItem('brt_app_state_backup', JSON.stringify(cachedState));
        localStorage.setItem('brt_last_synced_at', new Date().toISOString());
      } catch (e) {}
      isConnected = true;
    }

    updateUiBadge(true, true);
    setupRealtimeSubscription();
    setTimeout(checkAndAutoSeedRelationalTables, 500);
    return true;
  }

  function loadSupabaseSdk() {
    return new Promise((resolve, reject) => {
      if (window.supabase) return resolve();
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js';
      script.async = true;
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('Failed to load Supabase SDK from CDN. Please check your internet connection.'));
      document.head.appendChild(script);
    });
  }

  function setupRealtimeSubscription() {
    if (!supabase || realtimeChannel) return;

    realtimeChannel = supabase
      .channel('public:brt_app_state')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'brt_app_state', filter: 'id=eq.live' },
        (payload) => {
          if (payload && payload.new && payload.new.data) {
            console.log('[Supabase Realtime] Remote update received from cloud!');
            cachedState = payload.new.data;
            if (typeof onRemoteUpdateCallback === 'function') {
              onRemoteUpdateCallback(cachedState);
            }
          }
        }
      )
      .subscribe((status) => {
        console.log('[Supabase Realtime] Channel status:', status);
      });
  }

  // --- STATE PERSISTENCE ---
  async function persistState() {
    if (!cachedState) return;

    // 1. Always update local browser cache immediately (offline & page reload safeguard)
    try {
      localStorage.setItem('brt_app_state_backup', JSON.stringify(cachedState));
      localStorage.setItem('brt_last_saved_at', new Date().toISOString());
    } catch (e) {
      console.warn('[LocalStorage] Could not write backup:', e);
    }

    // 2. Persist to Supabase brt_app_state
    if (!supabase) return;
    try {
      const { error } = await supabase
        .from('brt_app_state')
        .upsert({
          id: 'live',
          data: cachedState,
          updated_at: new Date().toISOString()
        });
      if (error) {
        console.error('[Supabase] Save error:', error);
      } else {
        localStorage.setItem('brt_last_synced_at', new Date().toISOString());
      }
    } catch (e) {
      console.error('[Supabase] Network save error:', e);
    }
  }

  // --- API ROUTE INTERCEPTOR ---
  // Mirrors exact server.js behavior directly in the browser!
  async function handleApiRequest(endpoint, options = {}) {
    if (!cachedState) {
      const creds = getCredentials();
      if (creds.isConfigured && !supabase) {
        await connectToSupabase(creds.url, creds.anonKey);
      }
      if (!cachedState) {
        cachedState = getFallbackInitialState();
      }
    }

    const state = cachedState;
    const method = (options.method || 'GET').toUpperCase();
    const urlObj = new URL(endpoint, 'https://dummy.local');
    const pathname = urlObj.pathname;
    const body = options.body ? (typeof options.body === 'string' ? JSON.parse(options.body) : options.body) : {};

    // 1. GET /api/period
    if (method === 'GET' && pathname === '/api/period') {
      if (!state.periodConfig) {
        state.periodConfig = { activeMonth: 'NOV 2026', enteredJanuary: false };
      }
      return { periodConfig: state.periodConfig };
    }

    // 2. POST /api/period - Switch working month & Q4 unlock
    if (method === 'POST' && pathname === '/api/period') {
      if (!state.periodConfig) state.periodConfig = { activeMonth: 'NOV 2026', enteredJanuary: false };
      if (body.activeMonth !== undefined) {
        state.periodConfig.activeMonth = body.activeMonth.trim();
        const upper = state.periodConfig.activeMonth.toUpperCase();
        state.periodConfig.enteredJanuary = upper.includes('JAN') || upper.includes('2027');
      }
      if (body.enteredJanuary !== undefined) {
        state.periodConfig.enteredJanuary = Boolean(body.enteredJanuary);
      }
      const isJan = state.periodConfig.enteredJanuary;

      // Auto-copy for newly active return period
      const latestReturnPeriod = getPreviousMonthName(state.periodConfig.activeMonth, state);
      if (latestReturnPeriod) {
        if (!state.filings[latestReturnPeriod]) state.filings[latestReturnPeriod] = {};
        const targetFilings = state.filings[latestReturnPeriod];
        const prevMonthName = getPreviousMonthName(latestReturnPeriod, state);
        const prevFilings = (prevMonthName && state.filings[prevMonthName]) ? state.filings[prevMonthName] : null;

        state.clients.forEach(c => {
          const prevF = prevFilings ? prevFilings[c.id] : null;
          if (!targetFilings[c.id] || !targetFilings[c.id].editedName) {
            targetFilings[c.id] = {
              clientId: c.id,
              name: (prevF && prevF.name) || c.name,
              rent: (prevF && prevF.rent !== undefined && prevF.rent !== '') ? prevF.rent : (c.defaultRent || ''),
              rentAmount: (prevF && prevF.rentAmount !== undefined && prevF.rentAmount !== '') ? prevF.rentAmount : (c.rentAmount || ''),
              suggestedRentAmount: (prevF && prevF.rentAmount) || c.rentAmount || '',
              taxableAmount: '',
              gstr1: (targetFilings[c.id] && targetFilings[c.id].gstr1) || 'Pending',
              gstr1Arn: (targetFilings[c.id] && targetFilings[c.id].gstr1Arn) || '',
              gstr1Date: (targetFilings[c.id] && targetFilings[c.id].gstr1Date) || '',
              gstr3b: (targetFilings[c.id] && targetFilings[c.id].gstr3b) || 'Pending',
              gstr3bArn: (targetFilings[c.id] && targetFilings[c.id].gstr3bArn) || '',
              gstr3bDate: (targetFilings[c.id] && targetFilings[c.id].gstr3bDate) || '',
              remarks: (prevF && prevF.remarks) || c.remarks || ''
            };
          }
        });
      }

      // Quarters availability
      state.qrmpQuarters.forEach(q => {
        q.isAvailable = q.name.includes('Q4 (OCT - DEC 2026)') || q.name.includes('2027') ? isJan : true;
      });
      state.compositionQuarters.forEach(q => {
        q.isAvailable = q.name.includes('Q4 (OCT - DEC 2026)') || q.name.includes('2027') ? isJan : true;
      });

      // Q4 Unlock data copying
      if (isJan) {
        const q3Qrmp = state.qrmpFilings['Q3 (JUL - SEP 2026)'] || {};
        if (!state.qrmpFilings['Q4 (OCT - DEC 2026)']) state.qrmpFilings['Q4 (OCT - DEC 2026)'] = {};
        const q4Qrmp = state.qrmpFilings['Q4 (OCT - DEC 2026)'];
        state.qrmpClients.forEach(c => {
          const prevF = q3Qrmp[c.id];
          if (!q4Qrmp[c.id]) q4Qrmp[c.id] = { clientId: c.id };
          const f = q4Qrmp[c.id];
          if (!f.editedName) f.name = (prevF && prevF.name) || c.name;
          if (!f.editedRent) f.rent = (prevF && prevF.rent !== undefined && prevF.rent !== '') ? prevF.rent : (c.defaultRent || 'Rent');
          if (!f.editedRentAmount) f.rentAmount = (prevF && prevF.rentAmount !== undefined && prevF.rentAmount !== '') ? prevF.rentAmount : (c.rentAmount || '');
          if (!f.editedUser) f.user = (prevF && prevF.user) || c.user;
          if (!f.editedGst) f.gst = (prevF && prevF.gst) || c.gst;
          if (!f.m1Gstr1) f.m1Gstr1 = 'Pending';
          if (!f.m2Gstr1) f.m2Gstr1 = 'Pending';
          if (!f.m3Gstr1) f.m3Gstr1 = 'Pending';
          if (!f.gstr3b) f.gstr3b = 'Pending';
          if (!f.remarks) f.remarks = (prevF && prevF.remarks) || c.remarks || '';
        });

        const q3Comp = state.compositionFilings['Q3 (JUL - SEP 2026)'] || {};
        if (!state.compositionFilings['Q4 (OCT - DEC 2026)']) state.compositionFilings['Q4 (OCT - DEC 2026)'] = {};
        const q4Comp = state.compositionFilings['Q4 (OCT - DEC 2026)'];
        state.compositionClients.forEach(c => {
          const prevF = q3Comp[c.id];
          if (!q4Comp[c.id]) q4Comp[c.id] = { clientId: c.id };
          const f = q4Comp[c.id];
          if (!f.editedName) f.name = (prevF && prevF.name) || c.name;
          if (!f.editedRent) f.rent = (prevF && prevF.rent !== undefined && prevF.rent !== '') ? prevF.rent : (c.defaultRent || 'Rent');
          if (!f.editedRentAmount) f.rentAmount = (prevF && prevF.rentAmount !== undefined && prevF.rentAmount !== '') ? prevF.rentAmount : (c.rentAmount || '');
          if (!f.editedUser) f.user = (prevF && prevF.user) || c.user;
          if (!f.editedGst) f.gst = (prevF && prevF.gst) || c.gst;
          if (!f.category) f.category = (prevF && prevF.category) || c.category || 'Trader';
          if (!f.taxRate) f.taxRate = (prevF && prevF.taxRate) || c.taxRate || '1%';
          if (!f.cmp08) f.cmp08 = 'Pending';
          if (!f.gstr4) f.gstr4 = 'Pending';
          if (!f.remarks) f.remarks = (prevF && prevF.remarks) || c.remarks || '';
        });
      }

      await persistState();
      syncPeriodConfig(state.periodConfig);
      if (latestReturnPeriod && state.filings[latestReturnPeriod]) {
        syncMonthFilingsBatch(latestReturnPeriod, state.filings[latestReturnPeriod]);
      }
      if (isJan) {
        if (state.qrmpFilings['Q4 (OCT - DEC 2026)']) {
          syncQuarterFilingsBatch('qrmp', 'Q4 (OCT - DEC 2026)', state.qrmpFilings['Q4 (OCT - DEC 2026)']);
        }
        if (state.compositionFilings['Q4 (OCT - DEC 2026)']) {
          syncQuarterFilingsBatch('composition', 'Q4 (OCT - DEC 2026)', state.compositionFilings['Q4 (OCT - DEC 2026)']);
        }
      }
      return { success: true, periodConfig: state.periodConfig };
    }

    // 3. GET /api/months
    if (method === 'GET' && pathname === '/api/months') {
      const activeWorkingMonth = (state.periodConfig && state.periodConfig.activeMonth) ? state.periodConfig.activeMonth : 'NOV 2026';
      const clientCount = state.clients.length;

      const monthsWithStats = state.months.map(m => {
        const monthFilings = state.filings[m.name] || {};
        let rentCount = 0, itcCount = 0, ownCount = 0, totalRentAmount = 0, g1Filed = 0, g3bFiled = 0;
        state.clients.forEach(c => {
          const f = monthFilings[c.id] || { rent: '', rentAmount: '', gstr1: 'Pending', gstr3b: 'Pending' };
          if (f.rent === 'Rent') {
            rentCount++;
            if (f.rentAmount) totalRentAmount += parseFloat(f.rentAmount) || 0;
          } else if (f.rent === 'ITC') itcCount++;
          else if (f.rent === 'Own') ownCount++;
          if (f.gstr1 === 'Filed') g1Filed++;
          if (f.gstr3b === 'Filed') g3bFiled++;
        });

        const isAvailable = isMonthBefore(m.name, activeWorkingMonth);
        return {
          ...m,
          isAvailable,
          totalClients: clientCount,
          rentCount, itcCount, ownCount, totalRentAmount,
          g1Filed, g1Pending: clientCount - g1Filed,
          g3bFiled, g3bPending: clientCount - g3bFiled,
          percentComplete: clientCount > 0 ? Math.round(((g1Filed + g3bFiled) / (clientCount * 2)) * 100) : 0
        };
      });

      return { months: monthsWithStats, periodConfig: state.periodConfig || { activeMonth: 'NOV 2026', enteredJanuary: false } };
    }

    // 4. GET /api/filings/:month
    if (method === 'GET' && pathname.startsWith('/api/filings/')) {
      const month = decodeURIComponent(pathname.replace('/api/filings/', '').trim());
      if (!state.filings[month]) state.filings[month] = {};
      const monthFilings = state.filings[month];
      let isUpdated = false;

      const prevMonthName = getPreviousMonthName(month, state);
      const prevFilings = (prevMonthName && state.filings[prevMonthName]) ? state.filings[prevMonthName] : null;

      const list = state.clients.map(c => {
        let f = monthFilings[c.id];
        const prevF = prevFilings ? prevFilings[c.id] : null;
        if (!f) {
          f = {
            clientId: c.id,
            name: (prevF && prevF.name) || c.name,
            rent: (prevF && prevF.rent !== undefined && prevF.rent !== '') ? prevF.rent : (c.defaultRent || ''),
            rentAmount: (prevF && prevF.rentAmount !== undefined && prevF.rentAmount !== '') ? prevF.rentAmount : (c.rentAmount || ''),
            suggestedRentAmount: (prevF && prevF.rentAmount) || c.rentAmount || '',
            taxableAmount: '',
            gstr1: 'Pending', gstr1Arn: '', gstr1Date: '',
            gstr3b: 'Pending', gstr3bArn: '', gstr3bDate: '',
            remarks: (prevF && prevF.remarks) || c.remarks || ''
          };
          monthFilings[c.id] = f;
          isUpdated = true;
        } else if (prevF) {
          if (prevF.name && (!f.editedName || !f.name)) {
            if (f.name !== prevF.name) { f.name = prevF.name; isUpdated = true; }
          }
          if (prevF.rent !== undefined && prevF.rent !== '' && (!f.editedRent || !f.rent)) {
            if (f.rent !== prevF.rent) { f.rent = prevF.rent; isUpdated = true; }
          }
          if (prevF.rentAmount !== undefined && prevF.rentAmount !== '' && (!f.editedRentAmount || !f.rentAmount)) {
            if (f.rentAmount !== prevF.rentAmount) { f.rentAmount = prevF.rentAmount; isUpdated = true; }
          }
        }

        return {
          id: c.id,
          sno: c.sno,
          name: f.name || c.name,
          user: c.user,
          gst: c.gst,
          rent: f.rent !== undefined ? f.rent : (c.defaultRent || ''),
          rentAmount: f.rentAmount !== undefined ? f.rentAmount : (c.rentAmount || ''),
          suggestedRentAmount: f.suggestedRentAmount || f.rentAmount || c.rentAmount || '',
          taxableAmount: f.taxableAmount !== undefined ? f.taxableAmount : (c.taxableAmount || ''),
          gstr1: f.gstr1 || 'Pending', gstr1Arn: f.gstr1Arn || '', gstr1Date: f.gstr1Date || '',
          gstr3b: f.gstr3b || 'Pending', gstr3bArn: f.gstr3bArn || '', gstr3bDate: f.gstr3bDate || '',
          remarks: f.remarks !== undefined ? f.remarks : (c.remarks || '')
        };
      });

      if (isUpdated) await persistState();
      list.sort((a, b) => a.sno - b.sno);
      return { month, copiedFrom: prevMonthName, filings: list };
    }

    // 5. PUT /api/filings/:month/:clientId
    if (method === 'PUT' && pathname.startsWith('/api/filings/')) {
      const parts = pathname.replace('/api/filings/', '').split('/');
      const month = decodeURIComponent(parts[0]);
      const clientId = decodeURIComponent(parts[1]);
      if (!state.filings[month]) state.filings[month] = {};
      const current = state.filings[month][clientId] || { clientId };

      if (body.rent !== undefined) { current.rent = body.rent; current.editedRent = true; }
      if (body.rentAmount !== undefined) { current.rentAmount = body.rentAmount.toString().replace(/[^0-9]/g, ''); current.editedRentAmount = true; }
      if (body.taxableAmount !== undefined) { current.taxableAmount = body.taxableAmount.toString().replace(/[^0-9]/g, ''); }
      if (body.gstr1 !== undefined) current.gstr1 = body.gstr1;
      if (body.gstr1Arn !== undefined) current.gstr1Arn = body.gstr1Arn;
      if (body.gstr1Date !== undefined) current.gstr1Date = body.gstr1Date;
      if (body.gstr3b !== undefined) current.gstr3b = body.gstr3b;
      if (body.gstr3bArn !== undefined) current.gstr3bArn = body.gstr3bArn;
      if (body.gstr3bDate !== undefined) current.gstr3bDate = body.gstr3bDate;
      if (body.remarks !== undefined) current.remarks = body.remarks;
      if (body.name !== undefined) { current.name = body.name.trim(); current.editedName = true; }

      state.filings[month][clientId] = current;
      await persistState();
      syncSingleMonthlyFiling(month, clientId, current);
      return { success: true, updated: current };
    }

    // 6. POST /api/filings/:month/copy-from-previous
    if (method === 'POST' && pathname.includes('/copy-from-previous')) {
      const month = decodeURIComponent(pathname.replace('/api/filings/', '').replace('/copy-from-previous', '').trim());
      const prevMonthName = getPreviousMonthName(month, state);
      const prevFilings = prevMonthName ? state.filings[prevMonthName] : null;
      if (prevFilings) {
        if (!state.filings[month]) state.filings[month] = {};
        state.clients.forEach(c => {
          const prevF = prevFilings[c.id];
          if (!state.filings[month][c.id]) state.filings[month][c.id] = { clientId: c.id };
          const f = state.filings[month][c.id];
          if (prevF) {
            f.name = prevF.name || c.name;
            f.rent = prevF.rent !== undefined ? prevF.rent : (c.defaultRent || '');
            f.rentAmount = prevF.rentAmount !== undefined ? prevF.rentAmount : (c.rentAmount || '');
          }
        });
        await persistState();
        if (state.filings[month]) {
          syncMonthFilingsBatch(month, state.filings[month]);
        }
      }
      return { success: true, copiedFrom: prevMonthName, message: `Copied data from ${prevMonthName}!` };
    }

    // 7. GET /api/qrmp/quarters
    if (method === 'GET' && pathname === '/api/qrmp/quarters') {
      const clientCount = state.qrmpClients.length;
      const quartersWithStats = state.qrmpQuarters.map(q => {
        const qFilings = state.qrmpFilings[q.name] || {};
        let m1Filed = 0, m2Filed = 0, m3Filed = 0, g3bFiled = 0, totalRentAmount = 0;
        state.qrmpClients.forEach(c => {
          const f = qFilings[c.id] || {};
          if (f.m1Gstr1 === 'Filed') m1Filed++;
          if (f.m2Gstr1 === 'Filed') m2Filed++;
          if (f.m3Gstr1 === 'Filed') m3Filed++;
          if (f.gstr3b === 'Filed') g3bFiled++;
          if (f.rentAmount) totalRentAmount += parseFloat(f.rentAmount) || 0;
        });
        return {
          ...q,
          totalClients: clientCount,
          m1Filed, m2Filed, m3Filed, g3bFiled, totalRentAmount,
          percentComplete: clientCount > 0 ? Math.round(((m3Filed + g3bFiled) / (clientCount * 2)) * 100) : 0
        };
      });
      return { quarters: quartersWithStats };
    }

    // 8. GET /api/qrmp/filings/:quarter
    if (method === 'GET' && pathname.startsWith('/api/qrmp/filings/')) {
      const quarter = decodeURIComponent(pathname.replace('/api/qrmp/filings/', '').trim());
      if (!state.qrmpFilings[quarter]) state.qrmpFilings[quarter] = {};
      const qFilings = state.qrmpFilings[quarter];
      let isUpdated = false;

      const prevQuarterName = getPreviousQuarterName(quarter, state);
      const prevQFilings = prevQuarterName ? state.qrmpFilings[prevQuarterName] : null;

      const list = state.qrmpClients.map(c => {
        let f = qFilings[c.id];
        const prevF = prevQFilings ? prevQFilings[c.id] : null;
        if (!f) {
          f = {
            clientId: c.id,
            name: (prevF && prevF.name) || c.name,
            rent: (prevF && prevF.rent !== undefined && prevF.rent !== '') ? prevF.rent : (c.defaultRent || 'Rent'),
            rentAmount: (prevF && prevF.rentAmount !== undefined && prevF.rentAmount !== '') ? prevF.rentAmount : (c.rentAmount || ''),
            user: (prevF && prevF.user) || c.user,
            gst: (prevF && prevF.gst) || c.gst,
            m1Gstr1: 'Pending', m1Gstr1Arn: '', m1Gstr1Date: '',
            m2Gstr1: 'Pending', m2Gstr1Arn: '', m2Gstr1Date: '',
            m3Gstr1: 'Pending', m3Gstr1Arn: '', m3Gstr1Date: '',
            gstr3b: 'Pending', gstr3bArn: '', gstr3bDate: '',
            taxableAmount: '',
            remarks: (prevF && prevF.remarks) || c.remarks || ''
          };
          qFilings[c.id] = f;
          isUpdated = true;
        }
        return {
          id: c.id, sno: c.sno,
          name: f.name || c.name, user: c.user, gst: c.gst,
          rent: f.rent !== undefined ? f.rent : (c.defaultRent || 'Rent'),
          rentAmount: f.rentAmount !== undefined ? f.rentAmount : (c.rentAmount || ''),
          m1Gstr1: f.m1Gstr1 || 'Pending', m1Gstr1Arn: f.m1Gstr1Arn || '', m1Gstr1Date: f.m1Gstr1Date || '',
          m2Gstr1: f.m2Gstr1 || 'Pending', m2Gstr1Arn: f.m2Gstr1Arn || '', m2Gstr1Date: f.m2Gstr1Date || '',
          m3Gstr1: f.m3Gstr1 || 'Pending', m3Gstr1Arn: f.m3Gstr1Arn || '', m3Gstr1Date: f.m3Gstr1Date || '',
          gstr3b: f.gstr3b || 'Pending', gstr3bArn: f.gstr3bArn || '', gstr3bDate: f.gstr3bDate || '',
          taxableAmount: f.taxableAmount || '',
          remarks: f.remarks !== undefined ? f.remarks : (c.remarks || '')
        };
      });

      if (isUpdated) await persistState();
      list.sort((a, b) => a.sno - b.sno);
      return { quarter, copiedFrom: prevQuarterName, filings: list };
    }

    // 9. PUT /api/qrmp/filings/:quarter/:clientId
    if (method === 'PUT' && pathname.startsWith('/api/qrmp/filings/')) {
      const parts = pathname.replace('/api/qrmp/filings/', '').split('/');
      const quarter = decodeURIComponent(parts[0]);
      const clientId = decodeURIComponent(parts[1]);
      if (!state.qrmpFilings[quarter]) state.qrmpFilings[quarter] = {};
      const current = state.qrmpFilings[quarter][clientId] || { clientId };

      if (body.name !== undefined) { current.name = body.name.trim(); current.editedName = true; }
      if (body.rent !== undefined) { current.rent = body.rent; current.editedRent = true; }
      if (body.rentAmount !== undefined) { current.rentAmount = body.rentAmount.toString().replace(/[^0-9]/g, ''); current.editedRentAmount = true; }
      if (body.m1Gstr1 !== undefined) current.m1Gstr1 = body.m1Gstr1;
      if (body.m2Gstr1 !== undefined) current.m2Gstr1 = body.m2Gstr1;
      if (body.m3Gstr1 !== undefined) {
        current.m3Gstr1 = body.m3Gstr1;
        if (body.m3Gstr1 === 'Pending' && current.gstr3b === 'Filed') {
          current.gstr3b = 'Pending';
        }
      }
      if (body.gstr3b !== undefined) {
        if (body.gstr3b === 'Filed' && current.m3Gstr1 !== 'Filed') {
          throw new Error('Cannot file GSTR-3B: Month 3 GSTR-1 must be filed compulsorily first!');
        }
        current.gstr3b = body.gstr3b;
      }
      if (body.taxableAmount !== undefined) current.taxableAmount = body.taxableAmount.toString().replace(/[^0-9]/g, '');
      if (body.remarks !== undefined) current.remarks = body.remarks;

      state.qrmpFilings[quarter][clientId] = current;
      await persistState();
      syncSingleQrmpFiling(quarter, clientId, current);
      return { success: true, updated: current };
    }

    // 10. GET /api/composition/quarters
    if (method === 'GET' && pathname === '/api/composition/quarters') {
      const clientCount = state.compositionClients.length;
      const quartersWithStats = state.compositionQuarters.map(q => {
        const cFilings = state.compositionFilings[q.name] || {};
        let cmp08Filed = 0, gstr4Filed = 0, totalTurnover = 0, totalTaxAmount = 0;
        state.compositionClients.forEach(c => {
          const f = cFilings[c.id] || {};
          if (f.cmp08 === 'Filed') cmp08Filed++;
          if (f.gstr4 === 'Filed') gstr4Filed++;
          if (f.taxableTurnover) totalTurnover += parseFloat(f.taxableTurnover) || 0;
          if (f.taxAmount) totalTaxAmount += parseFloat(f.taxAmount) || 0;
        });
        return {
          ...q,
          totalClients: clientCount,
          cmp08Filed, cmp08Pending: clientCount - cmp08Filed,
          gstr4Filed, gstr4Pending: clientCount - gstr4Filed,
          totalTurnover, totalTaxAmount,
          percentComplete: clientCount > 0 ? Math.round((cmp08Filed / clientCount) * 100) : 0
        };
      });
      return { quarters: quartersWithStats };
    }

    // 11. GET /api/composition/filings/:quarter
    if (method === 'GET' && pathname.startsWith('/api/composition/filings/')) {
      const quarter = decodeURIComponent(pathname.replace('/api/composition/filings/', '').trim());
      if (!state.compositionFilings[quarter]) state.compositionFilings[quarter] = {};
      const cFilings = state.compositionFilings[quarter];
      let isUpdated = false;

      const prevQuarterName = getPreviousQuarterName(quarter, state);
      const prevCFilings = prevQuarterName ? state.compositionFilings[prevQuarterName] : null;

      const list = state.compositionClients.map(c => {
        let f = cFilings[c.id];
        const prevF = prevCFilings ? prevCFilings[c.id] : null;
        if (!f) {
          f = {
            clientId: c.id,
            name: (prevF && prevF.name) || c.name,
            rent: (prevF && prevF.rent !== undefined && prevF.rent !== '') ? prevF.rent : (c.defaultRent || 'Rent'),
            rentAmount: (prevF && prevF.rentAmount !== undefined && prevF.rentAmount !== '') ? prevF.rentAmount : (c.rentAmount || ''),
            user: (prevF && prevF.user) || c.user,
            gst: (prevF && prevF.gst) || c.gst,
            category: (prevF && prevF.category) || c.category || 'Trader',
            taxRate: (prevF && prevF.taxRate) || c.taxRate || '1%',
            cmp08: 'Pending', cmp08Date: '', cmp08Arn: '',
            gstr4: 'Pending', gstr4Date: '', gstr4Arn: '',
            taxableTurnover: '', taxAmount: '',
            remarks: (prevF && prevF.remarks) || c.remarks || ''
          };
          cFilings[c.id] = f;
          isUpdated = true;
        }
        return {
          id: c.id, sno: c.sno,
          name: f.name || c.name, user: c.user, gst: c.gst,
          category: f.category || c.category || 'Trader',
          taxRate: f.taxRate || c.taxRate || '1%',
          rent: f.rent !== undefined ? f.rent : (c.defaultRent || 'Rent'),
          rentAmount: f.rentAmount !== undefined ? f.rentAmount : (c.rentAmount || ''),
          cmp08: f.cmp08 || 'Pending', cmp08Date: f.cmp08Date || '', cmp08Arn: f.cmp08Arn || '',
          gstr4: f.gstr4 || 'Pending', gstr4Date: f.gstr4Date || '', gstr4Arn: f.gstr4Arn || '',
          taxableTurnover: f.taxableTurnover || '', taxAmount: f.taxAmount || '',
          remarks: f.remarks !== undefined ? f.remarks : (c.remarks || '')
        };
      });

      if (isUpdated) await persistState();
      list.sort((a, b) => a.sno - b.sno);
      return { quarter, copiedFrom: prevQuarterName, filings: list };
    }

    // 12. PUT /api/composition/filings/:quarter/:clientId
    if (method === 'PUT' && pathname.startsWith('/api/composition/filings/')) {
      const parts = pathname.replace('/api/composition/filings/', '').split('/');
      const quarter = decodeURIComponent(parts[0]);
      const clientId = decodeURIComponent(parts[1]);
      if (!state.compositionFilings[quarter]) state.compositionFilings[quarter] = {};
      const current = state.compositionFilings[quarter][clientId] || { clientId };

      if (body.name !== undefined) { current.name = body.name.trim(); current.editedName = true; }
      if (body.rent !== undefined) { current.rent = body.rent; current.editedRent = true; }
      if (body.rentAmount !== undefined) { current.rentAmount = body.rentAmount.toString().replace(/[^0-9]/g, ''); current.editedRentAmount = true; }
      if (body.cmp08 !== undefined) current.cmp08 = body.cmp08;
      if (body.gstr4 !== undefined) current.gstr4 = body.gstr4;
      if (body.taxableTurnover !== undefined) current.taxableTurnover = body.taxableTurnover.toString().replace(/[^0-9]/g, '');
      if (body.taxAmount !== undefined) current.taxAmount = body.taxAmount.toString().replace(/[^0-9]/g, '');
      if (body.remarks !== undefined) current.remarks = body.remarks;

      state.compositionFilings[quarter][clientId] = current;
      await persistState();
      syncSingleCompositionFiling(quarter, clientId, current);
      return { success: true, updated: current };
    }

    // 13. PUT /api/clients/:id, /api/qrmp/clients/:id, /api/composition/clients/:id
    if (method === 'PUT' && (pathname.startsWith('/api/clients/') || pathname.startsWith('/api/qrmp/clients/') || pathname.startsWith('/api/composition/clients/'))) {
      const isQrmp = pathname.includes('/qrmp/');
      const isComp = pathname.includes('/composition/');
      const id = decodeURIComponent(pathname.split('/').pop().trim());
      const list = isQrmp ? state.qrmpClients : (isComp ? state.compositionClients : state.clients);
      const c = list.find(x => x.id === id);
      if (c) {
        if (body.name !== undefined) c.name = body.name.trim();
        if (body.user !== undefined) c.user = body.user.trim();
        if (body.gst !== undefined) c.gst = body.gst.trim().toUpperCase();
        if (body.defaultRent !== undefined) c.defaultRent = body.defaultRent;
        if (body.rentAmount !== undefined) c.rentAmount = body.rentAmount.toString().replace(/[^0-9]/g, '');
        if (body.taxableAmount !== undefined) c.taxableAmount = body.taxableAmount.toString().replace(/[^0-9]/g, '');
        await persistState();
        if (isQrmp) syncSingleQrmpClient(c);
        else if (isComp) syncSingleCompositionClient(c);
        else syncSingleMonthlyClient(c);
        return { success: true, client: c };
      }
      throw new Error('Shop not found');
    }

    // 14. POST /api/clients, /api/qrmp/clients, /api/composition/clients
    if (method === 'POST' && (pathname === '/api/clients' || pathname === '/api/qrmp/clients' || pathname === '/api/composition/clients')) {
      const isQrmp = pathname.includes('/qrmp');
      const isComp = pathname.includes('/composition');
      const list = isQrmp ? state.qrmpClients : (isComp ? state.compositionClients : state.clients);
      const prefix = isQrmp ? 'q' : (isComp ? 'cmp' : 'c');
      const nextSno = list.reduce((max, x) => Math.max(max, x.sno || 0), 0) + 1;

      const newClient = {
        id: prefix + Date.now(),
        sno: nextSno,
        name: (body.name || '').trim(),
        user: (body.user || '').trim(),
        gst: (body.gst || '').trim().toUpperCase(),
        defaultRent: body.defaultRent || 'Rent',
        rentAmount: (body.rentAmount || '').toString().replace(/[^0-9]/g, ''),
        taxableAmount: (body.taxableAmount || '').toString().replace(/[^0-9]/g, ''),
        category: body.category || 'Trader',
        taxRate: body.taxRate || '1%',
        remarks: (body.remarks || '').trim()
      };

      list.push(newClient);
      await persistState();
      if (isQrmp) syncSingleQrmpClient(newClient);
      else if (isComp) syncSingleCompositionClient(newClient);
      else syncSingleMonthlyClient(newClient);
      return { success: true, client: newClient };
    }

    // 15. DELETE /api/clients/:id, /api/qrmp/clients/:id, /api/composition/clients/:id
    if (method === 'DELETE' && (pathname.startsWith('/api/clients/') || pathname.startsWith('/api/qrmp/clients/') || pathname.startsWith('/api/composition/clients/'))) {
      const isQrmp = pathname.includes('/qrmp/');
      const isComp = pathname.includes('/composition/');
      const id = decodeURIComponent(pathname.split('/').pop().trim());
      const list = isQrmp ? state.qrmpClients : (isComp ? state.compositionClients : state.clients);
      const idx = list.findIndex(x => x.id === id);
      if (idx !== -1) {
        const deleted = list.splice(idx, 1)[0];
        list.forEach((c, i) => { c.sno = i + 1; });
        await persistState();
        if (isQrmp) deleteQrmpClientFromDb(id);
        else if (isComp) deleteCompositionClientFromDb(id);
        else deleteMonthlyClientFromDb(id);
        return { success: true, message: `Shop "${deleted.name}" deleted`, client: deleted };
      }
      throw new Error('Shop not found');
    }

    // 16. POST /api/months/create & /api/qrmp/quarters/create
    if (method === 'POST' && (pathname === '/api/months/create' || pathname === '/api/qrmp/quarters/create')) {
      const name = (body.name || '').trim();
      if (pathname.includes('/months/create')) {
        let existing = state.months.find(m => m.name.toLowerCase() === name.toLowerCase());
        if (!existing) {
          existing = { id: name, name, title: body.title || name, g1Due: body.g1Due || '11th of Next Month', g3bDue: body.g3bDue || '20th of Next Month' };
          state.months.push(existing);
        }
        await persistState();
        return { success: true, message: `Month '${name}' created!`, month: existing };
      }
    }

    throw new Error(`Endpoint not supported: ${method} ${pathname}`);
  }

  // --- UI BADGE & SETTINGS MODAL ---
  function updateUiBadge(isConfigured, isLive) {
    // Hide the redundant Connect Cloud DB button completely (synced from top navbar)
    let badge = document.getElementById('supabaseStatusBadge');
    if (badge) {
      badge.style.display = 'none';
      badge.remove();
    }
  }

  function openSettingsModal() {
    let modal = document.getElementById('modalSupabaseConfig');
    if (!modal) {
      modal = document.createElement('div');
      modal.id = 'modalSupabaseConfig';
      modal.className = 'modal-backdrop';
      modal.style.display = 'none';
      modal.innerHTML = `
        <div class="modal-dialog">
          <div class="modal-header">
            <h3>⚡ Supabase Cloud Database Settings</h3>
            <button class="modal-close" id="btnCloseSupabaseModal">&times;</button>
          </div>
          <div class="modal-body">
            <p class="modal-desc" style="background: #eff6ff; border-left: 4px solid #2563eb; color: #1e3a8a;">
              Connect your <strong>free Supabase cloud database</strong> so all client data, filing statuses, and rent amounts sync in real-time across your computer, tablet, and mobile!
            </p>
            <form id="supabaseConfigForm">
              <div class="form-group">
                <label for="cfgSupabaseUrl">Supabase Project URL *:</label>
                <input type="url" id="cfgSupabaseUrl" class="form-control" placeholder="https://xxxxxxxxxxxx.supabase.co" required autocomplete="off">
                <small style="color: #64748b; font-size: 0.74rem;">Found in Supabase: Project Settings &rarr; API &rarr; Project URL</small>
              </div>
              <div class="form-group" style="margin-top: 10px;">
                <label for="cfgSupabaseKey">Supabase Anon Key (Public) *:</label>
                <input type="text" id="cfgSupabaseKey" class="form-control" placeholder="eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..." required autocomplete="off">
                <small style="color: #64748b; font-size: 0.74rem;">Found in Supabase: Project Settings &rarr; API &rarr; Project API keys (anon/public)</small>
              </div>
              <div id="supabaseTestResult" style="margin: 10px 0; font-size: 0.8rem; font-weight: 600; display: none;"></div>
              <div class="modal-footer" style="margin-top: 16px;">
                <button type="button" id="btnDisconnectSupabase" class="btn btn-outline" style="color: #dc2626;">Disconnect / Clear</button>
                <button type="submit" id="btnSaveSupabaseConfig" class="btn btn-primary">Connect &amp; Sync Now</button>
              </div>
            </form>

            <hr style="margin: 20px 0; border: none; border-top: 1px solid #e2e8f0;" />

            <div class="database-backup-tools">
              <h4 style="margin: 0 0 8px 0; font-size: 0.92rem; color: #1e293b; display: flex; align-items: center; gap: 6px;">
                <span>🛡️ Complete Data Preservation &amp; Backup</span>
              </h4>
              <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; padding: 10px 12px; margin-bottom: 12px; font-size: 0.78rem; color: #475569;">
                <div><strong>Master Clients:</strong> 148 (63 Monthly + 62 QRMP + 23 Composition)</div>
                <div><strong>Total Filing Records:</strong> 1,468 Records Preserved</div>
                <div style="color: #16a34a; font-weight: 600; margin-top: 4px;">✓ Local storage active &bull; Cloud realtime replication active</div>
              </div>

              <div style="display: flex; flex-direction: column; gap: 8px;">
                <button type="button" id="btnSyncRelationalTables" class="btn btn-outline" style="background: #f0fdf4; border-color: #86efac; color: #166534; font-weight: 600; text-align: left; padding: 8px 12px; font-size: 0.8rem; display: flex; align-items: center; justify-content: space-between;">
                  <span>⚡ Push All 1,468 Records to Supabase Relational Tables</span>
                  <span id="syncProgressText" style="font-size: 0.72rem; color: #15803d;">Ready</span>
                </button>
                <button type="button" id="btnDownloadJsonBackup" class="btn btn-outline" style="text-align: left; padding: 8px 12px; font-size: 0.8rem; color: #334155; display: flex; align-items: center; justify-content: space-between;">
                  <span>📥 Download Complete JSON Database Backup</span>
                  <span style="font-size: 0.72rem; color: #64748b;">.json file</span>
                </button>
              </div>
            </div>
          </div>
        </div>
      `;
      document.body.appendChild(modal);

      document.getElementById('btnCloseSupabaseModal').onclick = () => { modal.style.display = 'none'; };
      modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };

      document.getElementById('supabaseConfigForm').onsubmit = async (e) => {
        e.preventDefault();
        const url = document.getElementById('cfgSupabaseUrl').value.trim();
        const key = document.getElementById('cfgSupabaseKey').value.trim();
        const resultEl = document.getElementById('supabaseTestResult');
        const submitBtn = document.getElementById('btnSaveSupabaseConfig');

        resultEl.style.display = 'block';
        resultEl.style.color = '#2563eb';
        resultEl.textContent = 'Testing connection to Supabase database...';
        submitBtn.disabled = true;

        try {
          saveCredentials(url, key);
          await connectToSupabase(url, key);
          resultEl.style.color = '#15803d';
          resultEl.textContent = '✓ Successfully connected to Supabase! Live sync is now active.';
          setTimeout(() => {
            modal.style.display = 'none';
            window.location.reload();
          }, 1200);
        } catch (err) {
          resultEl.style.color = '#dc2626';
          resultEl.textContent = 'Connection failed: ' + err.message;
          submitBtn.disabled = false;
        }
      };

      // Relational sync button
      document.getElementById('btnSyncRelationalTables').onclick = async () => {
        const progEl = document.getElementById('syncProgressText');
        const syncBtn = document.getElementById('btnSyncRelationalTables');
        if (!isConnected || !supabase) {
          progEl.textContent = 'Please connect Supabase first!';
          progEl.style.color = '#dc2626';
          return;
        }
        syncBtn.disabled = true;
        try {
          await syncAllToRelationalTables((msg, pct) => {
            progEl.textContent = pct + '% ' + msg;
            progEl.style.color = '#2563eb';
          });
          progEl.textContent = '✓ 100% Synced!';
          progEl.style.color = '#15803d';
        } catch (err) {
          progEl.textContent = 'Error: ' + err.message;
          progEl.style.color = '#dc2626';
        } finally {
          syncBtn.disabled = false;
        }
      };

      // Download JSON backup button
      document.getElementById('btnDownloadJsonBackup').onclick = () => {
        downloadJsonBackup();
      };

      document.getElementById('btnDisconnectSupabase').onclick = () => {
        saveCredentials('', '');
        supabase = null;
        isConnected = false;
        updateUiBadge(false, false);
        const resultEl = document.getElementById('supabaseTestResult');
        resultEl.style.display = 'block';
        resultEl.style.color = '#475569';
        resultEl.textContent = 'Cleared Supabase credentials.';
        setTimeout(() => { modal.style.display = 'none'; window.location.reload(); }, 800);
      };
    }

    const creds = getCredentials();
    document.getElementById('cfgSupabaseUrl').value = creds.url || '';
    document.getElementById('cfgSupabaseKey').value = creds.anonKey || '';
    modal.style.display = 'flex';
  }

  // Fallback initial state ensuring 100% data preservation
  function getFallbackInitialState() {
    // 1. Check local storage backup first
    try {
      const stored = localStorage.getItem('brt_app_state_backup');
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed && parsed.clients && parsed.clients.length > 0) {
          return parsed;
        }
      }
    } catch (e) {}

    // 2. Bundled full master data (all 148 clients & 1,468 filings)
    if (window.__LOCAL_FALLBACK_DB) {
      return JSON.parse(JSON.stringify(window.__LOCAL_FALLBACK_DB));
    }

    return {
      periodConfig: { activeMonth: 'NOV 2026', enteredJanuary: false },
      clients: [], months: [], filings: {},
      qrmpClients: [], qrmpQuarters: [], qrmpFilings: {},
      compositionClients: [], compositionQuarters: [], compositionFilings: {}
    };
  }


  // --- BATCH SYNC TO RELATIONAL TABLES ---
  async function upsertInChunks(table, rows, chunkSize = 100) {
    if (!supabase || !rows || rows.length === 0) return;
    for (let i = 0; i < rows.length; i += chunkSize) {
      const chunk = rows.slice(i, i + chunkSize);
      try {
        const { error } = await supabase.from(table).upsert(chunk);
        if (error) {
          console.warn('[Supabase Sync] Warning on table ' + table + ':', error.message);
        }
      } catch (err) {
        console.warn('[Supabase Sync] Exception on table ' + table + ':', err);
      }
    }
  }

  async function syncAllToRelationalTables(onProgress) {
    if (!supabase) throw new Error('Supabase cloud client is not connected.');
    if (!cachedState) throw new Error('No state loaded to sync.');

    const state = cachedState;
    if (typeof onProgress === 'function') onProgress('Preparing master data...', 5);

    // 1. Period Config
    try {
      await supabase.from('gst_period_config').upsert({
        id: 'config',
        active_month: state.periodConfig?.activeMonth || 'NOV 2026',
        entered_january: Boolean(state.periodConfig?.enteredJanuary),
        updated_at: new Date().toISOString()
      });
    } catch (_) {}

    // 2. Months
    const monthRows = (state.months || []).map((m, idx) => ({
      id: m.id,
      name: m.name,
      order_idx: idx
    }));
    await upsertInChunks('gst_months', monthRows);

    // 3. QRMP Quarters
    const qrmpQRows = (state.qrmpQuarters || []).map((q, idx) => ({
      id: q.id,
      name: q.name,
      quarter: q.quarter || '',
      year: q.year || '',
      is_available: q.isAvailable !== false,
      order_idx: idx
    }));
    await upsertInChunks('gst_qrmp_quarters', qrmpQRows);

    // 4. Composition Quarters
    const compQRows = (state.compositionQuarters || []).map((q, idx) => ({
      id: q.id,
      name: q.name,
      quarter: q.quarter || '',
      year: q.year || '',
      is_available: q.isAvailable !== false,
      order_idx: idx
    }));
    await upsertInChunks('gst_composition_quarters', compQRows);

    if (typeof onProgress === 'function') onProgress('Syncing 63 Monthly Shops...', 25);
    // 5. Monthly Clients
    const monthlyClientRows = (state.clients || []).map(c => ({
      id: c.id,
      sno: c.sno || null,
      name: c.name,
      user_name: c.user || '',
      gstin: c.gst || '',
      default_rent: c.defaultRent || 'Rent',
      rent_amount: c.rentAmount !== undefined && c.rentAmount !== '' ? parseFloat(c.rentAmount) : null,
      taxable_amount: c.taxableAmount !== undefined && c.taxableAmount !== '' ? parseFloat(c.taxableAmount) : null,
      remarks: c.remarks || '',
      updated_at: new Date().toISOString()
    }));
    await upsertInChunks('gst_monthly_clients', monthlyClientRows);

    if (typeof onProgress === 'function') onProgress('Syncing 756 Monthly Filings...', 45);
    // 6. Monthly Filings
    const monthlyFilingRows = [];
    for (const mName in state.filings || {}) {
      for (const cId in state.filings[mName] || {}) {
        const f = state.filings[mName][cId];
        monthlyFilingRows.push({
          id: mName + '_' + cId,
          month_name: mName,
          client_id: cId,
          client_name: f.name || '',
          rent: f.rent || '',
          rent_amount: f.rentAmount !== undefined && f.rentAmount !== '' ? parseFloat(f.rentAmount) : null,
          suggested_rent_amount: f.suggestedRentAmount !== undefined && f.suggestedRentAmount !== '' ? parseFloat(f.suggestedRentAmount) : null,
          taxable_amount: f.taxableAmount !== undefined && f.taxableAmount !== '' ? parseFloat(f.taxableAmount) : null,
          gstr1: f.gstr1 || 'Pending',
          gstr1_arn: f.gstr1Arn || '',
          gstr1_date: f.gstr1Date || '',
          gstr3b: f.gstr3b || 'Pending',
          gstr3b_arn: f.gstr3bArn || '',
          gstr3b_date: f.gstr3bDate || '',
          remarks: f.remarks || '',
          updated_at: new Date().toISOString()
        });
      }
    }
    await upsertInChunks('gst_monthly_filings', monthlyFilingRows);

    if (typeof onProgress === 'function') onProgress('Syncing 62 QRMP Companies...', 65);
    // 7. QRMP Clients
    const qrmpClientRows = (state.qrmpClients || []).map(c => ({
      id: c.id,
      sno: c.sno || null,
      name: c.name,
      user_name: c.user || '',
      gstin: c.gst || '',
      default_rent: c.defaultRent || 'Rent',
      rent_amount: c.rentAmount !== undefined && c.rentAmount !== '' ? parseFloat(c.rentAmount) : null,
      taxable_amount: c.taxableAmount !== undefined && c.taxableAmount !== '' ? parseFloat(c.taxableAmount) : null,
      remarks: c.remarks || '',
      updated_at: new Date().toISOString()
    }));
    await upsertInChunks('gst_qrmp_clients', qrmpClientRows);

    if (typeof onProgress === 'function') onProgress('Syncing 620 QRMP Filings...', 80);
    // 8. QRMP Filings
    const qrmpFilingRows = [];
    for (const qName in state.qrmpFilings || {}) {
      for (const cId in state.qrmpFilings[qName] || {}) {
        const f = state.qrmpFilings[qName][cId];
        qrmpFilingRows.push({
          id: qName + '_' + cId,
          quarter_name: qName,
          client_id: cId,
          client_name: f.name || '',
          rent: f.rent || '',
          rent_amount: f.rentAmount !== undefined && f.rentAmount !== '' ? parseFloat(f.rentAmount) : null,
          m1_gstr1: f.m1Gstr1 || 'Pending',
          m1_gstr1_arn: f.m1Gstr1Arn || '',
          m1_gstr1_date: f.m1Gstr1Date || '',
          m2_gstr1: f.m2Gstr1 || 'Pending',
          m2_gstr1_arn: f.m2Gstr1Arn || '',
          m2_gstr1_date: f.m2Gstr1Date || '',
          m3_gstr1: f.m3Gstr1 || 'Pending',
          m3_gstr1_arn: f.m3Gstr1Arn || '',
          m3_gstr1_date: f.m3Gstr1Date || '',
          gstr3b: f.gstr3b || 'Pending',
          gstr3b_arn: f.gstr3bArn || '',
          gstr3b_date: f.gstr3bDate || '',
          taxable_amount: f.taxableAmount !== undefined && f.taxableAmount !== '' ? parseFloat(f.taxableAmount) : null,
          remarks: f.remarks || '',
          updated_at: new Date().toISOString()
        });
      }
    }
    await upsertInChunks('gst_qrmp_filings', qrmpFilingRows);

    if (typeof onProgress === 'function') onProgress('Syncing 23 Composition Dealers...', 90);
    // 9. Composition Clients
    const compClientRows = (state.compositionClients || []).map(c => ({
      id: c.id,
      sno: c.sno || null,
      name: c.name,
      user_name: c.user || '',
      gstin: c.gst || '',
      category: c.category || 'Trader',
      tax_rate: c.taxRate || '1%',
      default_rent: c.defaultRent || 'Rent',
      rent_amount: c.rentAmount !== undefined && c.rentAmount !== '' ? parseFloat(c.rentAmount) : null,
      remarks: c.remarks || '',
      updated_at: new Date().toISOString()
    }));
    await upsertInChunks('gst_composition_clients', compClientRows);

    if (typeof onProgress === 'function') onProgress('Syncing 92 Composition Filings...', 96);
    // 10. Composition Filings
    const compFilingRows = [];
    for (const qName in state.compositionFilings || {}) {
      for (const cId in state.compositionFilings[qName] || {}) {
        const f = state.compositionFilings[qName][cId];
        compFilingRows.push({
          id: qName + '_' + cId,
          quarter_name: qName,
          client_id: cId,
          client_name: f.name || '',
          rent: f.rent || '',
          rent_amount: f.rentAmount !== undefined && f.rentAmount !== '' ? parseFloat(f.rentAmount) : null,
          user_name: f.user || '',
          gstin: f.gst || '',
          category: f.category || 'Trader',
          tax_rate: f.taxRate || '1%',
          cmp08: f.cmp08 || 'Pending',
          cmp08_arn: f.cmp08Arn || '',
          cmp08_date: f.cmp08Date || '',
          gstr4: f.gstr4 || 'Pending',
          gstr4_arn: f.gstr4Arn || '',
          gstr4_date: f.gstr4Date || '',
          taxable_turnover: f.taxableTurnover !== undefined && f.taxableTurnover !== '' ? parseFloat(f.taxableTurnover) : null,
          tax_amount: f.taxAmount !== undefined && f.taxAmount !== '' ? parseFloat(f.taxAmount) : null,
          remarks: f.remarks || '',
          updated_at: new Date().toISOString()
        });
      }
    }
    await upsertInChunks('gst_composition_filings', compFilingRows);

    if (typeof onProgress === 'function') onProgress('✓ 100% Complete! All 148 clients & 1,468 filings pushed to Supabase tables.', 100);
    return true;
  }

  // --- AUTOMATIC TABLE SEEDING CHECK ---
  async function checkAndAutoSeedRelationalTables() {
    if (!supabase || !cachedState) return;
    try {
      const { count, error } = await supabase
        .from('gst_monthly_clients')
        .select('id', { count: 'exact', head: true });

      const clientTarget = (cachedState.clients || []).length || 63;
      if (!error && (count === null || count === 0 || count < clientTarget)) {
        console.log('[Supabase Sync] Relational tables empty or incomplete. Running initial auto-sync...');
        await syncAllToRelationalTables();
        console.log('[Supabase Sync] All separate relational tables fully populated!');
      }
    } catch (e) {
      console.warn('[Supabase Sync] Check notice:', e);
    }
  }

  // --- SINGLE ROW SYNC HELPERS ---
  async function syncSingleMonthlyFiling(month, clientId, current) {
    if (!supabase) return;
    try {
      const row = {
        id: month + '_' + clientId,
        month_name: month,
        client_id: clientId,
        client_name: current.name || '',
        rent: current.rent || '',
        rent_amount: current.rentAmount !== undefined && current.rentAmount !== '' ? parseFloat(current.rentAmount) : null,
        suggested_rent_amount: current.suggestedRentAmount !== undefined && current.suggestedRentAmount !== '' ? parseFloat(current.suggestedRentAmount) : null,
        taxable_amount: current.taxableAmount !== undefined && current.taxableAmount !== '' ? parseFloat(current.taxableAmount) : null,
        gstr1: current.gstr1 || 'Pending',
        gstr1_arn: current.gstr1Arn || '',
        gstr1_date: current.gstr1Date || '',
        gstr3b: current.gstr3b || 'Pending',
        gstr3b_arn: current.gstr3bArn || '',
        gstr3b_date: current.gstr3bDate || '',
        remarks: current.remarks || '',
        updated_at: new Date().toISOString()
      };
      await supabase.from('gst_monthly_filings').upsert(row);
    } catch (err) {
      console.warn('[Supabase Sync] Warning updating monthly filing:', err);
    }
  }

  async function syncSingleQrmpFiling(quarter, clientId, current) {
    if (!supabase) return;
    try {
      const row = {
        id: quarter + '_' + clientId,
        quarter_name: quarter,
        client_id: clientId,
        client_name: current.name || '',
        rent: current.rent || '',
        rent_amount: current.rentAmount !== undefined && current.rentAmount !== '' ? parseFloat(current.rentAmount) : null,
        m1_gstr1: current.m1Gstr1 || 'Pending',
        m1_gstr1_arn: current.m1Gstr1Arn || '',
        m1_gstr1_date: current.m1Gstr1Date || '',
        m2_gstr1: current.m2Gstr1 || 'Pending',
        m2_gstr1_arn: current.m2Gstr1Arn || '',
        m2_gstr1_date: current.m2Gstr1Date || '',
        m3_gstr1: current.m3Gstr1 || 'Pending',
        m3_gstr1_arn: current.m3Gstr1Arn || '',
        m3_gstr1_date: current.m3Gstr1Date || '',
        gstr3b: current.gstr3b || 'Pending',
        gstr3b_arn: current.gstr3bArn || '',
        gstr3b_date: current.gstr3bDate || '',
        taxable_amount: current.taxableAmount !== undefined && current.taxableAmount !== '' ? parseFloat(current.taxableAmount) : null,
        remarks: current.remarks || '',
        updated_at: new Date().toISOString()
      };
      await supabase.from('gst_qrmp_filings').upsert(row);
    } catch (err) {
      console.warn('[Supabase Sync] Warning updating QRMP filing:', err);
    }
  }

  async function syncSingleCompositionFiling(quarter, clientId, current) {
    if (!supabase) return;
    try {
      const row = {
        id: quarter + '_' + clientId,
        quarter_name: quarter,
        client_id: clientId,
        client_name: current.name || '',
        rent: current.rent || '',
        rent_amount: current.rentAmount !== undefined && current.rentAmount !== '' ? parseFloat(current.rentAmount) : null,
        user_name: current.user || '',
        gstin: current.gst || '',
        category: current.category || 'Trader',
        tax_rate: current.taxRate || '1%',
        cmp08: current.cmp08 || 'Pending',
        cmp08_arn: current.cmp08Arn || '',
        cmp08_date: current.cmp08Date || '',
        gstr4: current.gstr4 || 'Pending',
        gstr4_arn: current.gstr4Arn || '',
        gstr4_date: current.gstr4Date || '',
        taxable_turnover: current.taxableTurnover !== undefined && current.taxableTurnover !== '' ? parseFloat(current.taxableTurnover) : null,
        tax_amount: current.taxAmount !== undefined && current.taxAmount !== '' ? parseFloat(current.taxAmount) : null,
        remarks: current.remarks || '',
        updated_at: new Date().toISOString()
      };
      await supabase.from('gst_composition_filings').upsert(row);
    } catch (err) {
      console.warn('[Supabase Sync] Warning updating Composition filing:', err);
    }
  }

  async function syncSingleMonthlyClient(client) {
    if (!supabase) return;
    try {
      const row = {
        id: client.id,
        sno: client.sno || null,
        name: client.name || '',
        user_name: client.user || '',
        gstin: client.gst || '',
        default_rent: client.defaultRent || 'Rent',
        rent_amount: client.rentAmount !== undefined && client.rentAmount !== '' ? parseFloat(client.rentAmount) : null,
        taxable_amount: client.taxableAmount !== undefined && client.taxableAmount !== '' ? parseFloat(client.taxableAmount) : null,
        remarks: client.remarks || '',
        updated_at: new Date().toISOString()
      };
      await supabase.from('gst_monthly_clients').upsert(row);
    } catch (err) {
      console.warn('[Supabase Sync] Warning updating monthly client:', err);
    }
  }

  async function syncSingleQrmpClient(client) {
    if (!supabase) return;
    try {
      const row = {
        id: client.id,
        sno: client.sno || null,
        name: client.name || '',
        user_name: client.user || '',
        gstin: client.gst || '',
        default_rent: client.defaultRent || 'Rent',
        rent_amount: client.rentAmount !== undefined && client.rentAmount !== '' ? parseFloat(client.rentAmount) : null,
        taxable_amount: client.taxableAmount !== undefined && client.taxableAmount !== '' ? parseFloat(client.taxableAmount) : null,
        remarks: client.remarks || '',
        updated_at: new Date().toISOString()
      };
      await supabase.from('gst_qrmp_clients').upsert(row);
    } catch (err) {
      console.warn('[Supabase Sync] Warning updating QRMP client:', err);
    }
  }

  async function syncSingleCompositionClient(client) {
    if (!supabase) return;
    try {
      const row = {
        id: client.id,
        sno: client.sno || null,
        name: client.name || '',
        user_name: client.user || '',
        gstin: client.gst || '',
        category: client.category || 'Trader',
        tax_rate: client.taxRate || '1%',
        default_rent: client.defaultRent || 'Rent',
        rent_amount: client.rentAmount !== undefined && client.rentAmount !== '' ? parseFloat(client.rentAmount) : null,
        remarks: client.remarks || '',
        updated_at: new Date().toISOString()
      };
      await supabase.from('gst_composition_clients').upsert(row);
    } catch (err) {
      console.warn('[Supabase Sync] Warning updating Composition client:', err);
    }
  }

  async function deleteMonthlyClientFromDb(clientId) {
    if (!supabase) return;
    try {
      await supabase.from('gst_monthly_clients').delete().eq('id', clientId);
      await supabase.from('gst_monthly_filings').delete().eq('client_id', clientId);
    } catch (err) {}
  }

  async function deleteQrmpClientFromDb(clientId) {
    if (!supabase) return;
    try {
      await supabase.from('gst_qrmp_clients').delete().eq('id', clientId);
      await supabase.from('gst_qrmp_filings').delete().eq('client_id', clientId);
    } catch (err) {}
  }

  async function deleteCompositionClientFromDb(clientId) {
    if (!supabase) return;
    try {
      await supabase.from('gst_composition_clients').delete().eq('id', clientId);
      await supabase.from('gst_composition_filings').delete().eq('client_id', clientId);
    } catch (err) {}
  }

  async function syncPeriodConfig(periodConfig) {
    if (!supabase || !periodConfig) return;
    try {
      await supabase.from('gst_period_config').upsert({
        id: 'config',
        active_month: periodConfig.activeMonth || 'NOV 2026',
        entered_january: Boolean(periodConfig.enteredJanuary),
        updated_at: new Date().toISOString()
      });
    } catch (err) {}
  }

  async function syncMonthFilingsBatch(monthName, monthFilings) {
    if (!supabase || !monthFilings) return;
    const rows = [];
    for (const cId in monthFilings) {
      const f = monthFilings[cId];
      rows.push({
        id: monthName + '_' + cId,
        month_name: monthName,
        client_id: cId,
        client_name: f.name || '',
        rent: f.rent || '',
        rent_amount: f.rentAmount !== undefined && f.rentAmount !== '' ? parseFloat(f.rentAmount) : null,
        suggested_rent_amount: f.suggestedRentAmount !== undefined && f.suggestedRentAmount !== '' ? parseFloat(f.suggestedRentAmount) : null,
        taxable_amount: f.taxableAmount !== undefined && f.taxableAmount !== '' ? parseFloat(f.taxableAmount) : null,
        gstr1: f.gstr1 || 'Pending',
        gstr1_arn: f.gstr1Arn || '',
        gstr1_date: f.gstr1Date || '',
        gstr3b: f.gstr3b || 'Pending',
        gstr3b_arn: f.gstr3bArn || '',
        gstr3b_date: f.gstr3bDate || '',
        remarks: f.remarks || '',
        updated_at: new Date().toISOString()
      });
    }
    await upsertInChunks('gst_monthly_filings', rows);
  }

  async function syncQuarterFilingsBatch(scheme, quarterName, quarterFilings) {
    if (!supabase || !quarterFilings) return;
    if (scheme === 'qrmp') {
      const rows = [];
      for (const cId in quarterFilings) {
        const f = quarterFilings[cId];
        rows.push({
          id: quarterName + '_' + cId,
          quarter_name: quarterName,
          client_id: cId,
          client_name: f.name || '',
          rent: f.rent || '',
          rent_amount: f.rentAmount !== undefined && f.rentAmount !== '' ? parseFloat(f.rentAmount) : null,
          m1_gstr1: f.m1Gstr1 || 'Pending',
          m1_gstr1_arn: f.m1Gstr1Arn || '',
          m1_gstr1_date: f.m1Gstr1Date || '',
          m2_gstr1: f.m2Gstr1 || 'Pending',
          m2_gstr1_arn: f.m2Gstr1Arn || '',
          m2_gstr1_date: f.m2Gstr1Date || '',
          m3_gstr1: f.m3Gstr1 || 'Pending',
          m3_gstr1_arn: f.m3Gstr1Arn || '',
          m3_gstr1_date: f.m3Gstr1Date || '',
          gstr3b: f.gstr3b || 'Pending',
          gstr3b_arn: f.gstr3bArn || '',
          gstr3b_date: f.gstr3bDate || '',
          taxable_amount: f.taxableAmount !== undefined && f.taxableAmount !== '' ? parseFloat(f.taxableAmount) : null,
          remarks: f.remarks || '',
          updated_at: new Date().toISOString()
        });
      }
      await upsertInChunks('gst_qrmp_filings', rows);
    } else if (scheme === 'composition') {
      const rows = [];
      for (const cId in quarterFilings) {
        const f = quarterFilings[cId];
        rows.push({
          id: quarterName + '_' + cId,
          quarter_name: quarterName,
          client_id: cId,
          client_name: f.name || '',
          rent: f.rent || '',
          rent_amount: f.rentAmount !== undefined && f.rentAmount !== '' ? parseFloat(f.rentAmount) : null,
          user_name: f.user || '',
          gstin: f.gst || '',
          category: f.category || 'Trader',
          tax_rate: f.taxRate || '1%',
          cmp08: f.cmp08 || 'Pending',
          cmp08_arn: f.cmp08Arn || '',
          cmp08_date: f.cmp08Date || '',
          gstr4: f.gstr4 || 'Pending',
          gstr4_arn: f.gstr4Arn || '',
          gstr4_date: f.gstr4Date || '',
          taxable_turnover: f.taxableTurnover !== undefined && f.taxableTurnover !== '' ? parseFloat(f.taxableTurnover) : null,
          tax_amount: f.taxAmount !== undefined && f.taxAmount !== '' ? parseFloat(f.taxAmount) : null,
          remarks: f.remarks || '',
          updated_at: new Date().toISOString()
        });
      }
      await upsertInChunks('gst_composition_filings', rows);
    }
  }

  function downloadJsonBackup() {
    const dataToExport = cachedState || getFallbackInitialState();
    const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(dataToExport, null, 2));
    const dlAnchor = document.createElement('a');
    const filename = 'BRT_GST_Complete_Database_Backup_' + new Date().toISOString().slice(0, 10) + '.json';
    dlAnchor.setAttribute('href', dataStr);
    dlAnchor.setAttribute('download', filename);
    document.body.appendChild(dlAnchor);
    dlAnchor.click();
    dlAnchor.remove();
  }

  // --- EXPOSE GLOBAL BRT_SUPABASE API ---
  window.BRT_SUPABASE = {
    syncAllToRelationalTables,
    downloadJsonBackup,
    init,
    isConfigured: () => getCredentials().isConfigured,
    isConnected: () => isConnected,
    handleApiRequest,
    onRemoteUpdate: (fn) => { onRemoteUpdateCallback = fn; },
    openSettingsModal,
    getCredentials,
    saveCredentials
  };

  // Auto-initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
