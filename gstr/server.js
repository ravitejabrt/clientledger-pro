const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const { exec } = require('child_process');

const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'data', 'db.json');
const PUBLIC_DIR = __dirname;

// Ensure data folder and db.json exist
if (!fs.existsSync(path.join(__dirname, 'data'))) {
  fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
}

function readDb() {
  try {
    const raw = fs.readFileSync(DB_PATH, 'utf8');
    const data = JSON.parse(raw);
    if (!data.clients) data.clients = [];
    if (!data.months) data.months = [];
    if (!data.filings) data.filings = {};
    if (!data.qrmpClients) data.qrmpClients = [];
    if (!data.qrmpQuarters) data.qrmpQuarters = [];
    if (!data.qrmpFilings) data.qrmpFilings = {};
    if (!data.compositionClients) data.compositionClients = [];
    if (!data.compositionQuarters) data.compositionQuarters = [];
    if (!data.compositionFilings) data.compositionFilings = {};
    return data;
  } catch (err) {
    console.error('Error reading db.json:', err);
    return {
      clients: [], months: [], filings: {},
      qrmpClients: [], qrmpQuarters: [], qrmpFilings: {},
      compositionClients: [], compositionQuarters: [], compositionFilings: {}
    };
  }
}

function writeDb(data) {
  try {
    fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
    return true;
  } catch (err) {
    console.error('Error writing db.json:', err);
    return false;
  }
}

// MIME types dictionary
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.csv': 'text/csv; charset=utf-8',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
};

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
      if (body.length > 1e7) {
        req.connection.destroy();
        reject(new Error('Payload too large'));
      }
    });
    req.on('end', () => {
      if (!body) return resolve({});
      try {
        resolve(JSON.parse(body));
      } catch (err) {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS'
  });
  res.end(JSON.stringify(data));
}

function sendError(res, statusCode, message) {
  sendJson(res, statusCode, { error: message });
}

// --- CALENDAR & QUARTER RESOLUTION HELPERS ---
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

function getPreviousMonthName(monthName, db) {
  const parsed = parseMonthYear(monthName);
  if (parsed) {
    const prevMIdx = parsed.monthIndex === 0 ? 11 : parsed.monthIndex - 1;
    const prevYear = parsed.monthIndex === 0 ? parsed.year - 1 : parsed.year;
    const foundInMonths = db.months.find(m => {
      const p = parseMonthYear(m.name);
      return p && p.monthIndex === prevMIdx && p.year === prevYear;
    });
    if (foundInMonths) return foundInMonths.name;
    const foundInFilings = Object.keys(db.filings).find(m => {
      const p = parseMonthYear(m);
      return p && p.monthIndex === prevMIdx && p.year === prevYear;
    });
    if (foundInFilings) return foundInFilings;
    return `${MONTH_NAMES[prevMIdx]} ${prevYear}`;
  }
  const idx = db.months.findIndex(m => m.name === monthName);
  if (idx > 0) return db.months[idx - 1].name;
  return null;
}

function parseQuarterYear(str) {
  if (!str) return null;
  const upper = str.trim().toUpperCase();
  let qNum = null;
  let year = null;

  // Q1 = January to March, Q2 = April to June, Q3 = July to September, Q4 = October to December
  if (upper.includes('Q1') || upper.includes('FIRST') || upper.includes('JAN') || upper.includes('MAR')) {
    qNum = 1;
  } else if (upper.includes('Q2') || upper.includes('SECOND') || upper.includes('APR') || upper.includes('JUN')) {
    qNum = 2;
  } else if (upper.includes('Q3') || upper.includes('THIRD') || upper.includes('JUL') || upper.includes('SEP')) {
    qNum = 3;
  } else if (upper.includes('Q4') || upper.includes('FOURTH') || upper.includes('OCT') || upper.includes('DEC')) {
    qNum = 4;
  }

  const yMatch = upper.match(/20\d{2}/);
  if (yMatch) year = parseInt(yMatch[0], 10);
  if (qNum !== null && year !== null) {
    return { qNum, year };
  }
  return null;
}

function getPreviousQuarterName(quarterName, db) {
  const parsed = parseQuarterYear(quarterName);
  if (parsed) {
    const prevQNum = parsed.qNum === 1 ? 4 : parsed.qNum - 1;
    const prevYear = parsed.qNum === 1 ? parsed.year - 1 : parsed.year;
    const allQuarters = (db.qrmpQuarters || []).concat(db.compositionQuarters || []);
    const foundInQuarters = allQuarters.find(q => {
      const p = parseQuarterYear(q.name);
      return p && p.qNum === prevQNum && p.year === prevYear;
    });
    if (foundInQuarters) return foundInQuarters.name;
    const allFilingsKeys = Object.keys(db.qrmpFilings || {}).concat(Object.keys(db.compositionFilings || {}));
    const foundInFilings = allFilingsKeys.find(qName => {
      const p = parseQuarterYear(qName);
      return p && p.qNum === prevQNum && p.year === prevYear;
    });
    if (foundInFilings) return foundInFilings;
    const Q_RANGES = { 1: 'JAN - MAR', 2: 'APR - JUN', 3: 'JUL - SEP', 4: 'OCT - DEC' };
    return `Q${prevQNum} (${Q_RANGES[prevQNum]} ${prevYear})`;
  }
  const idx = db.qrmpQuarters.findIndex(q => q.name === quarterName);
  if (idx > 0) return db.qrmpQuarters[idx - 1].name;
  return null;
}

// Route matcher for GSTR (Rahul 3B) integration
function matches(pathname) {
  if (!pathname) return false;
  if (pathname === '/gstr' || pathname.startsWith('/gstr/')) return true;
  if (pathname === '/api/months' || pathname.startsWith('/api/months/')) return true;
  if (pathname === '/api/filings' || pathname.startsWith('/api/filings/')) return true;
  if (pathname === '/api/period' || pathname.startsWith('/api/period/')) return true;
  if (pathname === '/api/clients' || pathname.startsWith('/api/clients/')) return true;
  if (pathname.startsWith('/api/qrmp/')) return true;
  if (pathname.startsWith('/api/composition/')) return true;
  if (pathname.startsWith('/api/export/')) return true;
  return false;
}

// Main HTTP request listener & exported handler
async function handleRequest(req, res, pathname, parsedUrl) {
  try {
    if (!parsedUrl) {
      parsedUrl = url.parse(req.url, true);
    }
    if (!pathname) {
      const rawPathname = decodeURIComponent(parsedUrl.pathname || '/');
      pathname = (rawPathname.length > 1 && rawPathname.endsWith('/')) 
        ? rawPathname.slice(0, -1) 
        : rawPathname;
    }
    const method = req.method;

  // Handle CORS preflight
  if (method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    return res.end();
  }

  // --- API ROUTES ---

  // GET /api/months - List all months with summary statistics
  if (method === 'GET' && pathname === '/api/months') {
    const db = readDb();
    const activeWorkingMonth = (db.periodConfig && db.periodConfig.activeMonth) ? db.periodConfig.activeMonth : 'NOV 2026';

    const monthsWithStats = db.months.map(m => {
      const monthFilings = db.filings[m.name] || {};
      const clientCount = db.clients.length;
      let rentCount = 0;
      let itcCount = 0;
      let ownCount = 0;
      let unselectedCount = 0;
      let totalRentAmount = 0;
      let g1Filed = 0;
      let g3bFiled = 0;

      db.clients.forEach(c => {
        const f = monthFilings[c.id] || { rent: '', rentAmount: '', gstr1: 'Pending', gstr3b: 'Pending' };
        if (f.rent === 'Rent') {
          rentCount++;
          if (f.rentAmount) totalRentAmount += parseFloat(f.rentAmount) || 0;
        } else if (f.rent === 'ITC') {
          itcCount++;
        } else if (f.rent === 'Own') {
          ownCount++;
        } else {
          unselectedCount++;
        }

        if (f.gstr1 === 'Filed') g1Filed++;
        if (f.gstr3b === 'Filed') g3bFiled++;
      });

      // A return period is available if it is strictly before the current working calendar month
      const isAvailable = isMonthBefore(m.name, activeWorkingMonth);

      return {
        ...m,
        isAvailable,
        totalClients: clientCount,
        rentCount,
        itcCount,
        ownCount,
        unselectedCount,
        totalRentAmount,
        g1Filed,
        g1Pending: clientCount - g1Filed,
        g3bFiled,
        g3bPending: clientCount - g3bFiled,
        percentComplete: clientCount > 0 ? Math.round(((g1Filed + g3bFiled) / (clientCount * 2)) * 100) : 0
      };
    });
    return sendJson(res, 200, { 
      months: monthsWithStats,
      periodConfig: db.periodConfig || { activeMonth: 'NOV 2026', enteredJanuary: false }
    });
  }

  // POST /api/months/create - Month-to-Month Rollover!
  if (method === 'POST' && pathname === '/api/months/create') {
    try {
      const body = await parseBody(req);
      const { name, title, g1Due, g3bDue, sourceMonth } = body;

      if (!name) return sendError(res, 400, 'Month name is required (e.g. NOV 2026)');

      const db = readDb();
      const existingMonth = db.months.find(m => m.name.toLowerCase() === name.toLowerCase());
      if (existingMonth) {
        // Month already exists in master list: perform rollover of client filings into this month
        const resolvedSource = sourceMonth || getPreviousMonthName(existingMonth.name, db);
        const sourceFilings = (resolvedSource && db.filings[resolvedSource]) ? db.filings[resolvedSource] : null;
        if (!db.filings[existingMonth.name]) db.filings[existingMonth.name] = {};

        db.clients.forEach(c => {
          const prevFiling = sourceFilings ? sourceFilings[c.id] : null;
          db.filings[existingMonth.name][c.id] = {
            clientId: c.id,
            name: prevFiling ? (prevFiling.name || c.name) : c.name,
            rent: prevFiling ? (prevFiling.rent || '') : (c.defaultRent || ''),
            rentAmount: prevFiling ? (prevFiling.rentAmount || '') : (c.rentAmount || ''),
            suggestedRentAmount: prevFiling ? (prevFiling.rentAmount || '') : (c.suggestedRentAmount || c.rentAmount || ''),
            taxableAmount: '',
            gstr1: 'Pending',
            gstr1Arn: '',
            gstr1Date: '',
            gstr3b: 'Pending',
            gstr3bArn: '',
            gstr3bDate: '',
            remarks: prevFiling ? prevFiling.remarks : (c.remarks || '')
          };
        });

        writeDb(db);
        return sendJson(res, 200, { 
          success: true, 
          message: `Month '${existingMonth.name}' rolled over successfully with client data automatically copied from ${resolvedSource || 'previous records'}!`, 
          month: existingMonth 
        });
      }

      // Default due dates if not provided
      const newMonth = {
        id: name.trim(),
        name: name.trim(),
        title: title ? title.trim() : name.trim(),
        g1Due: g1Due || '11th of Next Month',
        g3bDue: g3bDue || '20th of Next Month'
      };

      // Rollover filings from sourceMonth or previous month
      const resolvedSource = sourceMonth || getPreviousMonthName(newMonth.name, db);
      const sourceFilings = (resolvedSource && db.filings[resolvedSource]) ? db.filings[resolvedSource] : null;
      db.filings[newMonth.name] = {};

      db.clients.forEach(c => {
        const prevFiling = sourceFilings ? sourceFilings[c.id] : null;
        db.filings[newMonth.name][c.id] = {
          clientId: c.id,
          name: prevFiling ? (prevFiling.name || c.name) : c.name,
          rent: prevFiling ? (prevFiling.rent || '') : (c.defaultRent || ''),
          rentAmount: prevFiling ? (prevFiling.rentAmount || '') : (c.rentAmount || ''),
          suggestedRentAmount: prevFiling ? (prevFiling.rentAmount || '') : (c.suggestedRentAmount || c.rentAmount || ''),
          taxableAmount: '',
          gstr1: 'Pending',
          gstr1Arn: '',
          gstr1Date: '',
          gstr3b: 'Pending',
          gstr3bArn: '',
          gstr3bDate: '',
          remarks: prevFiling ? prevFiling.remarks : (c.remarks || '')
        };
      });

      db.months.push(newMonth);
      writeDb(db);
      return sendJson(res, 201, { 
        success: true, 
        message: `Month '${newMonth.name}' created with client data automatically copied from ${resolvedSource || 'previous records'}!`, 
        month: newMonth 
      });
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  }

  // GET /api/filings/:month - Get full client list and filing statuses for a month (with auto-copy from previous month)
  if (method === 'GET' && pathname.startsWith('/api/filings/')) {
    const month = pathname.replace('/api/filings/', '').trim();
    const db = readDb();
    
    // Ensure month filings container exists
    if (!db.filings[month]) {
      db.filings[month] = {};
    }

    const monthFilings = db.filings[month];
    let isUpdated = false;

    // Resolve previous month
    const prevMonthName = getPreviousMonthName(month, db);
    const prevFilings = (prevMonthName && db.filings[prevMonthName]) ? db.filings[prevMonthName] : null;

    // Join clients with month's filing details and auto-copy from previous month
    const list = db.clients.map(c => {
      let f = monthFilings[c.id];
      const prevF = prevFilings ? prevFilings[c.id] : null;

      if (!f) {
        // Automatically copy from previous month data: COMPANY / SHOP NAME, RENT OPTION & AMOUNT
        f = {
          clientId: c.id,
          name: (prevF && prevF.name) || c.name,
          rent: (prevF && prevF.rent !== undefined && prevF.rent !== '') ? prevF.rent : (c.defaultRent || ''),
          rentAmount: (prevF && prevF.rentAmount !== undefined && prevF.rentAmount !== '') ? prevF.rentAmount : (c.rentAmount || ''),
          suggestedRentAmount: (prevF && prevF.rentAmount) || c.rentAmount || '',
          taxableAmount: '',
          gstr1: 'Pending',
          gstr1Arn: '',
          gstr1Date: '',
          gstr3b: 'Pending',
          gstr3bArn: '',
          gstr3bDate: '',
          remarks: (prevF && prevF.remarks) || c.remarks || ''
        };
        monthFilings[c.id] = f;
        isUpdated = true;
      } else {
        // Sync name, rent, and rent amount if updated in previous month and not specifically overridden in this month
        if (prevF) {
          if (prevF.name && (!f.editedName || !f.name)) {
            if (f.name !== prevF.name) {
              f.name = prevF.name;
              isUpdated = true;
            }
          }
          if (prevF.rent !== undefined && prevF.rent !== '' && (!f.editedRent || !f.rent)) {
            if (f.rent !== prevF.rent) {
              f.rent = prevF.rent;
              isUpdated = true;
            }
          }
          if (prevF.rentAmount !== undefined && prevF.rentAmount !== '' && (!f.editedRentAmount || !f.rentAmount)) {
            if (f.rentAmount !== prevF.rentAmount) {
              f.rentAmount = prevF.rentAmount;
              f.suggestedRentAmount = prevF.rentAmount;
              isUpdated = true;
            }
          }
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
        gstr1: f.gstr1 || 'Pending',
        gstr1Arn: f.gstr1Arn || '',
        gstr1Date: f.gstr1Date || '',
        gstr3b: f.gstr3b || 'Pending',
        gstr3bArn: f.gstr3bArn || '',
        gstr3bDate: f.gstr3bDate || '',
        remarks: f.remarks !== undefined ? f.remarks : (c.remarks || '')
      };
    });

    if (isUpdated) {
      writeDb(db);
    }

    // Sort by S.NO
    list.sort((a, b) => a.sno - b.sno);

    return sendJson(res, 200, { month, copiedFrom: prevMonthName, filings: list });
  }

  // POST /api/filings/:month/copy-from-previous - Force copy/sync COMPANY / SHOP NAME, RENT OPTION & AMOUNT from previous month
  if (method === 'POST' && pathname.startsWith('/api/filings/') && pathname.endsWith('/copy-from-previous')) {
    const month = pathname.replace('/api/filings/', '').replace('/copy-from-previous', '').trim();
    const db = readDb();
    const prevMonthName = getPreviousMonthName(month, db);
    if (!prevMonthName || !db.filings[prevMonthName]) {
      return sendError(res, 400, `No previous month data found before ${month}`);
    }
    const prevFilings = db.filings[prevMonthName];
    if (!db.filings[month]) db.filings[month] = {};
    const monthFilings = db.filings[month];

    db.clients.forEach(c => {
      const prevF = prevFilings[c.id];
      if (prevF) {
        if (!monthFilings[c.id]) monthFilings[c.id] = { clientId: c.id };
        const f = monthFilings[c.id];
        f.name = prevF.name || c.name;
        f.rent = prevF.rent !== undefined ? prevF.rent : c.defaultRent;
        f.rentAmount = prevF.rentAmount !== undefined ? prevF.rentAmount : c.rentAmount;
        f.suggestedRentAmount = f.rentAmount;
      }
    });

    writeDb(db);
    return sendJson(res, 200, { 
      success: true, 
      copiedFrom: prevMonthName, 
      message: `Successfully copied Company Name, Rent Option & Amount from ${prevMonthName}!` 
    });
  }

  // PUT /api/filings/:month/:clientId - Update single filing record
  if (method === 'PUT' && pathname.startsWith('/api/filings/')) {
    const parts = pathname.replace('/api/filings/', '').split('/');
    if (parts.length >= 2) {
      const month = decodeURIComponent(parts[0]);
      const clientId = decodeURIComponent(parts[1]);
      try {
        const body = await parseBody(req);
        const db = readDb();

        if (!db.filings[month]) db.filings[month] = {};
        const current = db.filings[month][clientId] || { clientId };

        // Update fields
        if (body.name !== undefined) {
          current.name = body.name.trim();
          current.editedName = true;
        }
        if (body.rent !== undefined) {
          current.rent = body.rent;
          current.editedRent = true;
        }
        if (body.rentAmount !== undefined) {
          current.rentAmount = body.rentAmount.toString().replace(/[^0-9]/g, '');
          current.suggestedRentAmount = current.rentAmount;
          current.editedRentAmount = true;
        }
        if (body.taxableAmount !== undefined) current.taxableAmount = body.taxableAmount.toString().replace(/[^0-9]/g, '');
        if (body.gstr1 !== undefined) current.gstr1 = body.gstr1;
        if (body.gstr1Arn !== undefined) current.gstr1Arn = body.gstr1Arn;
        if (body.gstr1Date !== undefined) current.gstr1Date = body.gstr1Date;
        if (body.gstr3b !== undefined) current.gstr3b = body.gstr3b;
        if (body.gstr3bArn !== undefined) current.gstr3bArn = body.gstr3bArn;
        if (body.gstr3bDate !== undefined) current.gstr3bDate = body.gstr3bDate;
        if (body.remarks !== undefined) current.remarks = body.remarks;

        db.filings[month][clientId] = current;

        // Keep master client in sync
        const c = db.clients.find(x => x.id === clientId);
        if (c) {
          if (body.name !== undefined) c.name = current.name;
          if (body.rent !== undefined) c.defaultRent = current.rent;
          if (body.rentAmount !== undefined) c.rentAmount = current.rentAmount;
        }

        // Forward-propagate to subsequent months if not custom-overridden
        const curParsed = parseMonthYear(month);
        if (curParsed) {
          db.months.forEach(m => {
            const mParsed = parseMonthYear(m.name);
            if (mParsed && (mParsed.year > curParsed.year || (mParsed.year === curParsed.year && mParsed.monthIndex > curParsed.monthIndex))) {
              if (db.filings[m.name] && db.filings[m.name][clientId]) {
                const futF = db.filings[m.name][clientId];
                if (body.name !== undefined && !futF.editedName) futF.name = current.name;
                if (body.rent !== undefined && !futF.editedRent) futF.rent = current.rent;
                if (body.rentAmount !== undefined && !futF.editedRentAmount) {
                  futF.rentAmount = current.rentAmount;
                  futF.suggestedRentAmount = current.rentAmount;
                }
              }
            }
          });
        }

        writeDb(db);
        return sendJson(res, 200, { success: true, updated: current });
      } catch (err) {
        return sendError(res, 500, err.message);
      }
    }
  }

  // POST /api/filings/:month/bulk - Bulk update status
  if (method === 'POST' && pathname.startsWith('/api/filings/') && pathname.endsWith('/bulk')) {
    const month = pathname.replace('/api/filings/', '').replace('/bulk', '').trim();
    try {
      const body = await parseBody(req);
      const { clientIds, updates } = body;
      if (!Array.isArray(clientIds) || !updates) {
        return sendError(res, 400, 'clientIds array and updates object required');
      }

      const db = readDb();
      if (!db.filings[month]) db.filings[month] = {};

      clientIds.forEach(cId => {
        const current = db.filings[month][cId] || { clientId: cId };
        Object.assign(current, updates);
        db.filings[month][cId] = current;
      });

      writeDb(db);
      return sendJson(res, 200, { success: true, count: clientIds.length });
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  }

  // GET /api/clients - Get all master clients
  if (method === 'GET' && pathname === '/api/clients') {
    const db = readDb();
    return sendJson(res, 200, { clients: db.clients });
  }

  // POST /api/clients - Add new client shop
  if (method === 'POST' && pathname === '/api/clients') {
    try {
      const body = await parseBody(req);
      const { name, user, gst, defaultRent, rentAmount, remarks } = body;
      if (!name) return sendError(res, 400, 'Company Name is required');

      const db = readDb();
      const nextSno = db.clients.reduce((max, c) => Math.max(max, c.sno || 0), 0) + 1;
      const cleanRentAmount = (rentAmount || '').toString().replace(/[^0-9]/g, '');
      const cleanTaxableAmount = (body.taxableAmount || '').toString().replace(/[^0-9]/g, '');
      const newClient = {
        id: 'c' + Date.now(),
        sno: nextSno,
        name: name.trim(),
        user: (user || '').trim(),
        gst: (gst || '').trim().toUpperCase(),
        defaultRent: defaultRent || '',
        rentAmount: cleanRentAmount,
        suggestedRentAmount: cleanRentAmount,
        taxableAmount: cleanTaxableAmount,
        remarks: (remarks || '').trim()
      };

      db.clients.push(newClient);

      // Add to all existing months
      Object.keys(db.filings).forEach(mName => {
        db.filings[mName][newClient.id] = {
          clientId: newClient.id,
          rent: newClient.defaultRent || '',
          rentAmount: newClient.defaultRent === 'Rent' ? cleanRentAmount : '',
          suggestedRentAmount: cleanRentAmount,
          taxableAmount: cleanTaxableAmount,
          gstr1: 'Pending',
          gstr1Arn: '',
          gstr1Date: '',
          gstr3b: 'Pending',
          gstr3bArn: '',
          gstr3bDate: '',
          remarks: newClient.remarks
        };
      });

      writeDb(db);
      return sendJson(res, 201, { success: true, client: newClient });
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  }

  // PUT /api/clients/:id - Edit client info
  if (method === 'PUT' && pathname.startsWith('/api/clients/')) {
    const id = pathname.replace('/api/clients/', '').trim();
    try {
      const body = await parseBody(req);
      const db = readDb();
      const idx = db.clients.findIndex(c => c.id === id);
      if (idx === -1) return sendError(res, 404, 'Client not found');

      const c = db.clients[idx];
      if (body.name !== undefined) c.name = body.name.trim();
      if (body.user !== undefined) c.user = body.user.trim();
      if (body.gst !== undefined) c.gst = body.gst.trim().toUpperCase();
      if (body.defaultRent !== undefined) c.defaultRent = body.defaultRent;
      if (body.rentAmount !== undefined) {
        c.rentAmount = body.rentAmount.toString().replace(/[^0-9]/g, '');
        c.suggestedRentAmount = c.rentAmount;
        // Update in filings
        Object.keys(db.filings).forEach(m => {
          if (db.filings[m][id]) {
            if (db.filings[m][id].rent === 'Rent' || !db.filings[m][id].rentAmount) {
              db.filings[m][id].rentAmount = c.rentAmount;
            }
            db.filings[m][id].suggestedRentAmount = c.rentAmount;
          }
        });
      }
      if (body.remarks !== undefined) c.remarks = body.remarks.trim();
      if (body.taxableAmount !== undefined) {
        c.taxableAmount = body.taxableAmount.toString().replace(/[^0-9]/g, '');
      }

      writeDb(db);
      return sendJson(res, 200, { success: true, client: c });
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  }

  // DELETE /api/clients/:id - Remove client
  if (method === 'DELETE' && pathname.startsWith('/api/clients/')) {
    const id = pathname.replace('/api/clients/', '').trim();
    const db = readDb();
    const idx = db.clients.findIndex(c => c.id === id);
    if (idx === -1) return sendError(res, 404, 'Client not found');

    const deletedClient = db.clients.splice(idx, 1)[0];
    // Re-sequence remaining clients' sno
    db.clients.forEach((c, i) => {
      c.sno = i + 1;
    });
    // Remove from filings across all months
    Object.keys(db.filings).forEach(m => {
      delete db.filings[m][id];
    });

    writeDb(db);
    return sendJson(res, 200, { success: true, message: `Shop "${deletedClient.name}" deleted`, client: deletedClient });
  }

  // GET /api/export/csv/:month - Export clean CSV for selected month
  if (method === 'GET' && pathname.startsWith('/api/export/csv/')) {
    const month = pathname.replace('/api/export/csv/', '').trim();
    const db = readDb();
    const monthFilings = db.filings[month] || {};

    let csv = `S.NO,Company Name,RENT OPTION,RENT AMOUNT (Rs),User Name,GST No,GSTR-1,GSTR-3B,TAXABLE AMOUNT,REMARKS\n`;
    db.clients.forEach(c => {
      const f = monthFilings[c.id] || {};
      const rent = f.rent || '';
      const rentAmt = f.rentAmount || '';
      const g1 = f.gstr1 || 'Pending';
      const g3b = f.gstr3b || 'Pending';
      const taxableAmt = f.taxableAmount || '';
      const rem = (f.remarks || c.remarks || '').replace(/"/g, '""');
      const cName = c.name.replace(/"/g, '""');
      csv += `${c.sno},"${cName}","${rent}","${rentAmt}","${c.user}","${c.gst}",${g1},${g3b},"${taxableAmt}","${rem}"\n`;
    });

    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${month.replace(/\s+/g, '_')}_GST_Returns.csv"`
    });
    return res.end(csv);
  }

  // GET /api/export/excel - Download the pre-built master Excel file with all dropdowns
  if (method === 'GET' && pathname === '/api/export/excel') {
    const excelPath = path.join(__dirname, 'GST_Monthly_Returns_Tracker_FY2026-27.xlsx');
    if (fs.existsSync(excelPath)) {
      const stat = fs.statSync(excelPath);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Length': stat.size,
        'Content-Disposition': 'attachment; filename="GST_Monthly_Returns_Tracker_FY2026-27.xlsx"'
      });
      return fs.createReadStream(excelPath).pipe(res);
    } else {
      return sendError(res, 404, 'Excel file not found');
    }
  }

  // --- PERIOD MANAGEMENT API (Nov 2026 / Jan 2027 Rollover & Q4 Unlock) ---

  // GET /api/period - Get current active period and Q4 unlock status
  if (method === 'GET' && pathname === '/api/period') {
    const db = readDb();
    if (!db.periodConfig) {
      db.periodConfig = { activeMonth: 'NOV 2026', enteredJanuary: false };
    }
    return sendJson(res, 200, { periodConfig: db.periodConfig });
  }

  // POST /api/period - Switch active period / Enter January (Unlocks Q4 and copies Q3 data)
  if (method === 'POST' && pathname === '/api/period') {
    try {
      const body = await parseBody(req);
      const db = readDb();
      if (!db.periodConfig) {
        db.periodConfig = { activeMonth: 'NOV 2026', enteredJanuary: false };
      }

      if (body.activeMonth !== undefined) {
        db.periodConfig.activeMonth = body.activeMonth.trim();
        const upper = db.periodConfig.activeMonth.toUpperCase();
        if (upper.includes('JAN') || upper.includes('2027')) {
          db.periodConfig.enteredJanuary = true;
        } else {
          db.periodConfig.enteredJanuary = false;
        }
      }

      if (body.enteredJanuary !== undefined) {
        db.periodConfig.enteredJanuary = Boolean(body.enteredJanuary);
      }

      const isJan = db.periodConfig.enteredJanuary;

      // Ensure filing records exist and are auto-copied for the newly active return period
      const latestReturnPeriod = getPreviousMonthName(db.periodConfig.activeMonth, db);
      if (latestReturnPeriod) {
        if (!db.filings[latestReturnPeriod]) db.filings[latestReturnPeriod] = {};
        const targetFilings = db.filings[latestReturnPeriod];
        const prevMonthName = getPreviousMonthName(latestReturnPeriod, db);
        const prevFilings = (prevMonthName && db.filings[prevMonthName]) ? db.filings[prevMonthName] : null;

        db.clients.forEach(c => {
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

      // Update quarters isAvailable state
      db.qrmpQuarters.forEach(q => {
        if (q.name.includes('Q4 (OCT - DEC 2026)') || q.name.includes('2027')) {
          q.isAvailable = isJan;
        } else {
          q.isAvailable = true;
        }
      });

      db.compositionQuarters.forEach(q => {
        if (q.name.includes('Q4 (OCT - DEC 2026)') || q.name.includes('2027')) {
          q.isAvailable = isJan;
        } else {
          q.isAvailable = true;
        }
      });

      // When January is entered, auto-copy Q3 data to Q4 for QRMP and Composition
      if (isJan) {
        // 1. QRMP Auto-copy Q3 -> Q4
        const q3Qrmp = db.qrmpFilings['Q3 (JUL - SEP 2026)'] || {};
        if (!db.qrmpFilings['Q4 (OCT - DEC 2026)']) db.qrmpFilings['Q4 (OCT - DEC 2026)'] = {};
        const q4Qrmp = db.qrmpFilings['Q4 (OCT - DEC 2026)'];

        db.qrmpClients.forEach(c => {
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

        // 2. Composition Auto-copy Q3 -> Q4
        const q3Comp = db.compositionFilings['Q3 (JUL - SEP 2026)'] || {};
        if (!db.compositionFilings['Q4 (OCT - DEC 2026)']) db.compositionFilings['Q4 (OCT - DEC 2026)'] = {};
        const q4Comp = db.compositionFilings['Q4 (OCT - DEC 2026)'];

        db.compositionClients.forEach(c => {
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

      writeDb(db);
      return sendJson(res, 200, {
        success: true,
        periodConfig: db.periodConfig,
        message: isJan 
          ? 'Entered January 2027: Q4 (OCT - DEC 2026) unlocked and populated with copied Q3 data!' 
          : 'Active period set to November 2026: showing quarters up to Q3 (JUL - SEP 2026).'
      });
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  }

  // GET /api/qrmp/quarters - List all QRMP quarters with summary statistics
  if (method === 'GET' && pathname === '/api/qrmp/quarters') {
    const db = readDb();
    const clientCount = db.qrmpClients.length;
    const quartersWithStats = db.qrmpQuarters.map(q => {
      const qFilings = db.qrmpFilings[q.name] || {};
      let m1Filed = 0;
      let m2Filed = 0;
      let m3Filed = 0;
      let g3bFiled = 0;
      let totalTaxableAmount = 0;

      db.qrmpClients.forEach(c => {
        const f = qFilings[c.id] || {};
        if (f.m1Gstr1 === 'Filed') m1Filed++;
        if (f.m2Gstr1 === 'Filed') m2Filed++;
        if (f.m3Gstr1 === 'Filed') m3Filed++;
        if (f.gstr3b === 'Filed') g3bFiled++;
        if (f.taxableAmount) totalTaxableAmount += parseFloat(f.taxableAmount) || 0;
      });

      return {
        ...q,
        totalClients: clientCount,
        m1Filed,
        m1Pending: clientCount - m1Filed,
        m2Filed,
        m2Pending: clientCount - m2Filed,
        m3Filed,
        m3Pending: clientCount - m3Filed,
        g3bFiled,
        g3bPending: clientCount - g3bFiled,
        totalTaxableAmount,
        percentComplete: clientCount > 0 ? Math.round(((m3Filed + g3bFiled) / (clientCount * 2)) * 100) : 0
      };
    });
    return sendJson(res, 200, { quarters: quartersWithStats });
  }

  // GET /api/qrmp/filings/:quarter - Get all QRMP client filings for a quarter (with auto-copy from previous quarter)
  if (method === 'GET' && pathname.startsWith('/api/qrmp/filings/')) {
    let quarter = pathname.replace('/api/qrmp/filings/', '').trim();
    const db = readDb();

    // Support legacy quarter aliases if requested
    if (quarter === 'Q3 (OCT - DEC 2026)' && db.qrmpQuarters.some(q => q.name === 'Q4 (OCT - DEC 2026)')) {
      quarter = 'Q4 (OCT - DEC 2026)';
    } else if (quarter === 'Q4 (JAN - MAR 2027)' && db.qrmpQuarters.some(q => q.name === 'Q1 (JAN - MAR 2027)')) {
      quarter = 'Q1 (JAN - MAR 2027)';
    }

    if (!db.qrmpFilings[quarter]) db.qrmpFilings[quarter] = {};
    const qFilings = db.qrmpFilings[quarter];
    let isUpdated = false;

    // Resolve previous quarter for auto-copying
    const prevQuarterName = getPreviousQuarterName(quarter, db);
    const prevQFilings = (prevQuarterName && db.qrmpFilings[prevQuarterName]) ? db.qrmpFilings[prevQuarterName] : null;

    const list = db.qrmpClients.map(c => {
      let f = qFilings[c.id];
      const prevF = prevQFilings ? prevQFilings[c.id] : null;

      if (!f) {
        // Automatically copy from previous quarter data: COMPANY / SHOP NAME, RENT OPTION & AMOUNT
        f = {
          clientId: c.id,
          name: (prevF && prevF.name) || c.name,
          rent: (prevF && prevF.rent !== undefined && prevF.rent !== '') ? prevF.rent : (c.defaultRent || 'Rent'),
          rentAmount: (prevF && prevF.rentAmount !== undefined && prevF.rentAmount !== '') ? prevF.rentAmount : (c.rentAmount || ''),
          m1Gstr1: 'Pending',
          m1Gstr1Arn: '',
          m1Gstr1Date: '',
          m2Gstr1: 'Pending',
          m2Gstr1Arn: '',
          m2Gstr1Date: '',
          m3Gstr1: 'Pending',
          m3Gstr1Arn: '',
          m3Gstr1Date: '',
          gstr3b: 'Pending',
          gstr3bArn: '',
          gstr3bDate: '',
          taxableAmount: '',
          remarks: (prevF && prevF.remarks) || c.remarks || ''
        };
        qFilings[c.id] = f;
        isUpdated = true;
      } else {
        // Sync name, rent, and rent amount if updated in previous quarter and not specifically overridden in this quarter
        if (prevF) {
          if (prevF.name && (!f.editedName || !f.name)) {
            if (f.name !== prevF.name) {
              f.name = prevF.name;
              isUpdated = true;
            }
          }
          if (prevF.rent !== undefined && prevF.rent !== '' && (!f.editedRent || !f.rent)) {
            if (f.rent !== prevF.rent) {
              f.rent = prevF.rent;
              isUpdated = true;
            }
          }
          if (prevF.rentAmount !== undefined && prevF.rentAmount !== '' && (!f.editedRentAmount || !f.rentAmount)) {
            if (f.rentAmount !== prevF.rentAmount) {
              f.rentAmount = prevF.rentAmount;
              isUpdated = true;
            }
          }
        }
      }

      return {
        id: c.id,
        sno: c.sno,
        name: f.name || c.name,
        user: c.user,
        gst: c.gst,
        rent: f.rent !== undefined ? f.rent : (c.defaultRent || 'Rent'),
        rentAmount: f.rentAmount !== undefined ? f.rentAmount : (c.rentAmount || ''),
        m1Gstr1: f.m1Gstr1 || 'Pending',
        m1Gstr1Arn: f.m1Gstr1Arn || '',
        m1Gstr1Date: f.m1Gstr1Date || '',
        m2Gstr1: f.m2Gstr1 || 'Pending',
        m2Gstr1Arn: f.m2Gstr1Arn || '',
        m2Gstr1Date: f.m2Gstr1Date || '',
        m3Gstr1: f.m3Gstr1 || 'Pending',
        m3Gstr1Arn: f.m3Gstr1Arn || '',
        m3Gstr1Date: f.m3Gstr1Date || '',
        gstr3b: f.gstr3b || 'Pending',
        gstr3bArn: f.gstr3bArn || '',
        gstr3bDate: f.gstr3bDate || '',
        taxableAmount: f.taxableAmount !== undefined ? f.taxableAmount : '',
        remarks: f.remarks !== undefined ? f.remarks : (c.remarks || '')
      };
    });

    if (isUpdated) writeDb(db);
    list.sort((a, b) => a.sno - b.sno);
    const quarterInfo = db.qrmpQuarters.find(q => q.name === quarter) || null;
    return sendJson(res, 200, { quarter, quarterInfo, copiedFrom: prevQuarterName, filings: list });
  }

  // POST /api/qrmp/filings/:quarter/copy-from-previous - Force copy COMPANY / SHOP NAME, RENT OPTION & AMOUNT from previous quarter
  if (method === 'POST' && pathname.startsWith('/api/qrmp/filings/') && pathname.endsWith('/copy-from-previous')) {
    const quarter = pathname.replace('/api/qrmp/filings/', '').replace('/copy-from-previous', '').trim();
    const db = readDb();
    const prevQuarterName = getPreviousQuarterName(quarter, db);
    if (!prevQuarterName || !db.qrmpFilings[prevQuarterName]) {
      return sendError(res, 400, `No previous quarter data found before ${quarter}`);
    }
    const prevFilings = db.qrmpFilings[prevQuarterName];
    if (!db.qrmpFilings[quarter]) db.qrmpFilings[quarter] = {};
    const qFilings = db.qrmpFilings[quarter];

    db.qrmpClients.forEach(c => {
      const prevF = prevFilings[c.id];
      if (prevF) {
        if (!qFilings[c.id]) qFilings[c.id] = { clientId: c.id };
        const f = qFilings[c.id];
        f.name = prevF.name || c.name;
        f.rent = prevF.rent !== undefined ? prevF.rent : (c.defaultRent || 'Rent');
        f.rentAmount = prevF.rentAmount !== undefined ? prevF.rentAmount : (c.rentAmount || '');
        f.user = prevF.user || c.user;
        f.gst = prevF.gst || c.gst;
      }
    });

    writeDb(db);
    return sendJson(res, 200, { 
      success: true, 
      copiedFrom: prevQuarterName, 
      message: `Successfully copied Company Name, Rent Option & Amount, User Name, and GSTIN from ${prevQuarterName}!` 
    });
  }

  // POST /api/qrmp/quarters/create - Quarter-to-Quarter Rollover for QRMP!
  if (method === 'POST' && pathname === '/api/qrmp/quarters/create') {
    try {
      const body = await parseBody(req);
      const { name, title, m1, m2, m3, m1Due, m2Due, m3Due, g3bDue, sourceQuarter } = body;
      if (!name) return sendError(res, 400, 'Quarter name is required (e.g. Q1 (JAN - MAR 2027))');

      const db = readDb();
      const existingQuarter = db.qrmpQuarters.find(q => q.name.toLowerCase() === name.toLowerCase());
      if (existingQuarter) {
        const resolvedSource = sourceQuarter || getPreviousQuarterName(existingQuarter.name, db);
        const sourceFilings = (resolvedSource && db.qrmpFilings[resolvedSource]) ? db.qrmpFilings[resolvedSource] : null;
        if (!db.qrmpFilings[existingQuarter.name]) db.qrmpFilings[existingQuarter.name] = {};

        db.qrmpClients.forEach(c => {
          const prevF = sourceFilings ? sourceFilings[c.id] : null;
          db.qrmpFilings[existingQuarter.name][c.id] = {
            clientId: c.id,
            name: prevF ? (prevF.name || c.name) : c.name,
            rent: prevF ? (prevF.rent || '') : (c.defaultRent || 'Rent'),
            rentAmount: prevF ? (prevF.rentAmount || '') : (c.rentAmount || ''),
            m1Gstr1: 'Pending',
            m1Gstr1Arn: '',
            m1Gstr1Date: '',
            m2Gstr1: 'Pending',
            m2Gstr1Arn: '',
            m2Gstr1Date: '',
            m3Gstr1: 'Pending',
            m3Gstr1Arn: '',
            m3Gstr1Date: '',
            gstr3b: 'Pending',
            gstr3bArn: '',
            gstr3bDate: '',
            taxableAmount: '',
            remarks: prevF ? prevF.remarks : (c.remarks || '')
          };
        });

        writeDb(db);
        return sendJson(res, 200, {
          success: true,
          message: `Quarter '${existingQuarter.name}' rolled over successfully with company details automatically copied from ${resolvedSource || 'previous records'}!`,
          quarter: existingQuarter
        });
      }

      const parsed = parseQuarterYear(name);
      const qNum = parsed ? parsed.qNum : 1;
      const year = parsed ? parsed.year : 2027;
      const Q_MONTHS = {
        1: ['JAN ' + year, 'FEB ' + year, 'MAR ' + year],
        2: ['APR ' + year, 'MAY ' + year, 'JUN ' + year],
        3: ['JUL ' + year, 'AUG ' + year, 'SEP ' + year],
        4: ['OCT ' + year, 'NOV ' + year, 'DEC ' + year]
      };
      const defMonths = Q_MONTHS[qNum] || ['M1', 'M2', 'M3'];

      const newQuarter = {
        id: 'Q' + qNum + '-' + year,
        name: name.trim(),
        title: title ? title.trim() : `Quarter ${qNum} (${defMonths[0].split(' ')[0]} - ${defMonths[2].split(' ')[0]} ${year})`,
        m1: m1 || defMonths[0],
        m2: m2 || defMonths[1],
        m3: m3 || defMonths[2],
        m1Due: m1Due || '13th of Next Month',
        m2Due: m2Due || '13th of Next Month',
        m3Due: m3Due || '13th of Next Month',
        g3bDue: g3bDue || '22nd of Next Month'
      };

      const resolvedSource = sourceQuarter || getPreviousQuarterName(newQuarter.name, db);
      const sourceFilings = (resolvedSource && db.qrmpFilings[resolvedSource]) ? db.qrmpFilings[resolvedSource] : null;
      db.qrmpFilings[newQuarter.name] = {};

      db.qrmpClients.forEach(c => {
        const prevF = sourceFilings ? sourceFilings[c.id] : null;
        db.qrmpFilings[newQuarter.name][c.id] = {
          clientId: c.id,
          name: prevF ? (prevF.name || c.name) : c.name,
          rent: prevF ? (prevF.rent || '') : (c.defaultRent || 'Rent'),
          rentAmount: prevF ? (prevF.rentAmount || '') : (c.rentAmount || ''),
          m1Gstr1: 'Pending',
          m1Gstr1Arn: '',
          m1Gstr1Date: '',
          m2Gstr1: 'Pending',
          m2Gstr1Arn: '',
          m2Gstr1Date: '',
          m3Gstr1: 'Pending',
          m3Gstr1Arn: '',
          m3Gstr1Date: '',
          gstr3b: 'Pending',
          gstr3bArn: '',
          gstr3bDate: '',
          taxableAmount: '',
          remarks: prevF ? prevF.remarks : (c.remarks || '')
        };
      });

      db.qrmpQuarters.push(newQuarter);
      writeDb(db);
      return sendJson(res, 201, {
        success: true,
        message: `Quarter '${newQuarter.name}' created with company details automatically copied from ${resolvedSource || 'previous records'}!`,
        quarter: newQuarter
      });
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  }

  // PUT /api/qrmp/filings/:quarter/:clientId - Update single QRMP filing record
  if (method === 'PUT' && pathname.startsWith('/api/qrmp/filings/')) {
    const parts = pathname.replace('/api/qrmp/filings/', '').split('/');
    if (parts.length >= 2) {
      const quarter = decodeURIComponent(parts[0]);
      const clientId = decodeURIComponent(parts[1]);
      try {
        const body = await parseBody(req);
        const db = readDb();
        if (!db.qrmpFilings[quarter]) db.qrmpFilings[quarter] = {};
        const current = db.qrmpFilings[quarter][clientId] || { clientId };

        if (body.name !== undefined) {
          current.name = body.name.trim();
          current.editedName = true;
        }
        if (body.rent !== undefined) {
          current.rent = body.rent;
          current.editedRent = true;
        }
        if (body.rentAmount !== undefined) {
          current.rentAmount = body.rentAmount.toString().replace(/[^0-9]/g, '');
          current.editedRentAmount = true;
        }
        if (body.user !== undefined) {
          current.user = body.user.trim();
          current.editedUser = true;
        }
        if (body.gst !== undefined) {
          current.gst = body.gst.trim().toUpperCase();
          current.editedGst = true;
        }

        if (body.m1Gstr1 !== undefined) current.m1Gstr1 = body.m1Gstr1;
        if (body.m1Gstr1Arn !== undefined) current.m1Gstr1Arn = body.m1Gstr1Arn;
        if (body.m1Gstr1Date !== undefined) current.m1Gstr1Date = body.m1Gstr1Date;

        if (body.m2Gstr1 !== undefined) current.m2Gstr1 = body.m2Gstr1;
        if (body.m2Gstr1Arn !== undefined) current.m2Gstr1Arn = body.m2Gstr1Arn;
        if (body.m2Gstr1Date !== undefined) current.m2Gstr1Date = body.m2Gstr1Date;

        if (body.m3Gstr1 !== undefined) {
          current.m3Gstr1 = body.m3Gstr1;
          // If M3 GSTR-1 is reverted to Pending, GSTR-3B must also be reset to Pending because M3 GSTR-1 is compulsory!
          if (body.m3Gstr1 === 'Pending' && current.gstr3b === 'Filed') {
            current.gstr3b = 'Pending';
            current.gstr3bDate = '';
            current.gstr3bArn = '';
          }
        }
        if (body.m3Gstr1Arn !== undefined) current.m3Gstr1Arn = body.m3Gstr1Arn;
        if (body.m3Gstr1Date !== undefined) current.m3Gstr1Date = body.m3Gstr1Date;

        if (body.gstr3b !== undefined) {
          if (body.gstr3b === 'Filed' && current.m3Gstr1 !== 'Filed') {
            return sendError(res, 400, 'Cannot file GSTR-3B: Month 3 GSTR-1 must be filed compulsorily first!');
          }
          current.gstr3b = body.gstr3b;
        }
        if (body.gstr3bArn !== undefined) current.gstr3bArn = body.gstr3bArn;
        if (body.gstr3bDate !== undefined) current.gstr3bDate = body.gstr3bDate;

        if (body.taxableAmount !== undefined) current.taxableAmount = body.taxableAmount.toString().replace(/[^0-9]/g, '');
        if (body.remarks !== undefined) current.remarks = body.remarks;

        db.qrmpFilings[quarter][clientId] = current;

        // Keep master QRMP client in sync
        const qc = db.qrmpClients.find(x => x.id === clientId);
        if (qc) {
          if (body.name !== undefined) qc.name = current.name;
          if (body.user !== undefined) qc.user = current.user;
          if (body.gst !== undefined) qc.gst = current.gst;
          if (body.rent !== undefined) qc.defaultRent = current.rent;
          if (body.rentAmount !== undefined) qc.rentAmount = current.rentAmount;
        }

        // Forward-propagate to subsequent quarters if not custom-overridden
        const curParsed = parseQuarterYear(quarter);
        if (curParsed) {
          db.qrmpQuarters.forEach(q => {
            const qParsed = parseQuarterYear(q.name);
            if (qParsed && (qParsed.year > curParsed.year || (qParsed.year === curParsed.year && qParsed.qNum > curParsed.qNum))) {
              if (db.qrmpFilings[q.name] && db.qrmpFilings[q.name][clientId]) {
                const futF = db.qrmpFilings[q.name][clientId];
                if (body.name !== undefined && !futF.editedName) futF.name = current.name;
                if (body.rent !== undefined && !futF.editedRent) futF.rent = current.rent;
                if (body.rentAmount !== undefined && !futF.editedRentAmount) futF.rentAmount = current.rentAmount;
                if (body.user !== undefined && !futF.editedUser) futF.user = current.user;
                if (body.gst !== undefined && !futF.editedGst) futF.gst = current.gst;
              }
            }
          });
        }

        writeDb(db);
        return sendJson(res, 200, { success: true, updated: current });
      } catch (err) {
        return sendError(res, 500, err.message);
      }
    }
  }

  // POST /api/qrmp/clients - Add new QRMP company
  if (method === 'POST' && pathname === '/api/qrmp/clients') {
    try {
      const body = await parseBody(req);
      const { name, user, gst, defaultRent, rentAmount, taxableAmount, remarks } = body;
      if (!name) return sendError(res, 400, 'Company Name is required');

      const db = readDb();
      const nextSno = db.qrmpClients.reduce((max, c) => Math.max(max, c.sno || 0), 0) + 1;
      const newClient = {
        id: 'q' + Date.now(),
        sno: nextSno,
        name: name.trim(),
        user: (user || '').trim(),
        gst: (gst || '').trim().toUpperCase(),
        defaultRent: defaultRent || 'Rent',
        rentAmount: (rentAmount || '').toString().replace(/[^0-9]/g, ''),
        remarks: (remarks || '').trim()
      };

      db.qrmpClients.push(newClient);
      Object.keys(db.qrmpFilings).forEach(qName => {
        db.qrmpFilings[qName][newClient.id] = {
          clientId: newClient.id,
          rent: newClient.defaultRent,
          rentAmount: newClient.rentAmount,
          m1Gstr1: 'Pending',
          m1Gstr1Arn: '',
          m1Gstr1Date: '',
          m2Gstr1: 'Pending',
          m2Gstr1Arn: '',
          m2Gstr1Date: '',
          m3Gstr1: 'Pending',
          m3Gstr1Arn: '',
          m3Gstr1Date: '',
          gstr3b: 'Pending',
          gstr3bArn: '',
          gstr3bDate: '',
          taxableAmount: (taxableAmount || '').toString().replace(/[^0-9]/g, ''),
          remarks: newClient.remarks
        };
      });

      writeDb(db);
      return sendJson(res, 201, { success: true, client: newClient });
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  }

  // PUT /api/qrmp/clients/:id - Edit QRMP company
  if (method === 'PUT' && pathname.startsWith('/api/qrmp/clients/')) {
    const id = pathname.replace('/api/qrmp/clients/', '').trim();
    try {
      const body = await parseBody(req);
      const db = readDb();
      const idx = db.qrmpClients.findIndex(c => c.id === id);
      if (idx === -1) return sendError(res, 404, 'QRMP company not found');

      const c = db.qrmpClients[idx];
      if (body.name !== undefined) c.name = body.name.trim();
      if (body.user !== undefined) c.user = body.user.trim();
      if (body.gst !== undefined) c.gst = body.gst.trim().toUpperCase();
      if (body.defaultRent !== undefined) c.defaultRent = body.defaultRent;
      if (body.rentAmount !== undefined) c.rentAmount = body.rentAmount.toString().replace(/[^0-9]/g, '');
      if (body.remarks !== undefined) c.remarks = body.remarks.trim();

      writeDb(db);
      return sendJson(res, 200, { success: true, client: c });
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  }

  // DELETE /api/qrmp/clients/:id - Delete QRMP company
  if (method === 'DELETE' && pathname.startsWith('/api/qrmp/clients/')) {
    const id = pathname.replace('/api/qrmp/clients/', '').trim();
    const db = readDb();
    const idx = db.qrmpClients.findIndex(c => c.id === id);
    if (idx === -1) return sendError(res, 404, 'QRMP company not found');

    const deleted = db.qrmpClients.splice(idx, 1)[0];
    db.qrmpClients.forEach((c, i) => { c.sno = i + 1; });
    Object.keys(db.qrmpFilings).forEach(q => {
      delete db.qrmpFilings[q][id];
    });

    writeDb(db);
    return sendJson(res, 200, { success: true, message: `Shop "${deleted.name}" deleted`, client: deleted });
  }

  // GET /api/export/qrmp/csv/:quarter - Export QRMP CSV
  if (method === 'GET' && pathname.startsWith('/api/export/qrmp/csv/')) {
    const quarter = pathname.replace('/api/export/qrmp/csv/', '').trim();
    const db = readDb();
    const qFilings = db.qrmpFilings[quarter] || {};
    const qInfo = db.qrmpQuarters.find(q => q.name === quarter);
    const m1Header = qInfo ? `${qInfo.m1} GSTR-1` : 'M1 GSTR-1';
    const m2Header = qInfo ? `${qInfo.m2} GSTR-1` : 'M2 GSTR-1';
    const m3Header = qInfo ? `${qInfo.m3} GSTR-1 (Compulsory)` : 'M3 GSTR-1 (Compulsory)';

    let csv = `S.NO,Company Name,RENT OPTION,RENT AMOUNT (Rs),User Name,GST No,${m1Header},${m2Header},${m3Header},GSTR-3B (Quarterly),TAXABLE AMOUNT,REMARKS\n`;
    db.qrmpClients.forEach(c => {
      const f = qFilings[c.id] || {};
      const cName = (f.name || c.name).replace(/"/g, '""');
      const rent = f.rent || c.defaultRent || 'Rent';
      const rentAmt = f.rentAmount || c.rentAmount || '';
      const rem = (f.remarks || c.remarks || '').replace(/"/g, '""');
      csv += `${c.sno},"${cName}","${rent}","${rentAmt}","${c.user}","${c.gst}",${f.m1Gstr1 || 'Pending'},${f.m2Gstr1 || 'Pending'},${f.m3Gstr1 || 'Pending'},${f.gstr3b || 'Pending'},"${f.taxableAmount || ''}","${rem}"\n`;
    });

    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${quarter.replace(/[\s\(\)\-\:]+/g, '_')}_QRMP_Returns.csv"`
    });
    return res.end(csv);
  }

  // --- COMPOSITION SCHEME API ROUTES ---

  // GET /api/composition/quarters - List all Composition quarters with summary statistics
  if (method === 'GET' && pathname === '/api/composition/quarters') {
    const db = readDb();
    const clientCount = db.compositionClients.length;
    const quartersWithStats = db.compositionQuarters.map(q => {
      const cFilings = db.compositionFilings[q.name] || {};
      let cmp08Filed = 0;
      let gstr4Filed = 0;
      let totalTurnover = 0;
      let totalTaxAmount = 0;

      db.compositionClients.forEach(c => {
        const f = cFilings[c.id] || {};
        if (f.cmp08 === 'Filed') cmp08Filed++;
        if (f.gstr4 === 'Filed') gstr4Filed++;
        if (f.taxableTurnover) totalTurnover += parseFloat(f.taxableTurnover) || 0;
        if (f.taxAmount) totalTaxAmount += parseFloat(f.taxAmount) || 0;
      });

      return {
        ...q,
        totalClients: clientCount,
        cmp08Filed,
        cmp08Pending: clientCount - cmp08Filed,
        gstr4Filed,
        gstr4Pending: clientCount - gstr4Filed,
        totalTurnover,
        totalTaxAmount,
        percentComplete: clientCount > 0 ? Math.round((cmp08Filed / clientCount) * 100) : 0
      };
    });
    return sendJson(res, 200, { quarters: quartersWithStats });
  }

  // GET /api/composition/filings/:quarter - Get all Composition client filings for a quarter (with auto-copy from previous quarter)
  if (method === 'GET' && pathname.startsWith('/api/composition/filings/')) {
    const quarter = pathname.replace('/api/composition/filings/', '').trim();
    const db = readDb();
    if (!db.compositionFilings[quarter]) db.compositionFilings[quarter] = {};
    const cFilings = db.compositionFilings[quarter];
    let isUpdated = false;

    // Resolve previous quarter for auto-copying (e.g. Q3 -> Q4)
    const prevQuarterName = getPreviousQuarterName(quarter, db);
    const prevCFilings = (prevQuarterName && db.compositionFilings[prevQuarterName]) ? db.compositionFilings[prevQuarterName] : null;

    const list = db.compositionClients.map(c => {
      let f = cFilings[c.id];
      const prevF = prevCFilings ? prevCFilings[c.id] : null;

      if (!f) {
        // Automatically copy from previous quarter data: COMPANY / SHOP NAME, RENT OPTION & AMOUNT, USER NAME, GSTIN & PORTAL LOGIN
        f = {
          clientId: c.id,
          name: (prevF && prevF.name) || c.name,
          rent: (prevF && prevF.rent !== undefined && prevF.rent !== '') ? prevF.rent : (c.defaultRent || 'Rent'),
          rentAmount: (prevF && prevF.rentAmount !== undefined && prevF.rentAmount !== '') ? prevF.rentAmount : (c.rentAmount || ''),
          user: (prevF && prevF.user) || c.user,
          gst: (prevF && prevF.gst) || c.gst,
          category: (prevF && prevF.category) || c.category || 'Trader',
          taxRate: (prevF && prevF.taxRate) || c.taxRate || '1%',
          cmp08: 'Pending',
          cmp08Date: '',
          cmp08Arn: '',
          gstr4: 'Pending',
          gstr4Date: '',
          gstr4Arn: '',
          taxableTurnover: '',
          taxAmount: '',
          remarks: (prevF && prevF.remarks) || c.remarks || ''
        };
        cFilings[c.id] = f;
        isUpdated = true;
      } else {
        // Sync if updated in previous quarter and not specifically overridden in this quarter
        if (prevF) {
          if (prevF.name && (!f.editedName || !f.name)) {
            if (f.name !== prevF.name) {
              f.name = prevF.name;
              isUpdated = true;
            }
          }
          if (prevF.rent !== undefined && prevF.rent !== '' && (!f.editedRent || !f.rent)) {
            if (f.rent !== prevF.rent) {
              f.rent = prevF.rent;
              isUpdated = true;
            }
          }
          if (prevF.rentAmount !== undefined && prevF.rentAmount !== '' && (!f.editedRentAmount || !f.rentAmount)) {
            if (f.rentAmount !== prevF.rentAmount) {
              f.rentAmount = prevF.rentAmount;
              isUpdated = true;
            }
          }
          if (prevF.user && (!f.editedUser || !f.user)) {
            if (f.user !== prevF.user) {
              f.user = prevF.user;
              isUpdated = true;
            }
          }
          if (prevF.gst && (!f.editedGst || !f.gst)) {
            if (f.gst !== prevF.gst) {
              f.gst = prevF.gst;
              isUpdated = true;
            }
          }
        }
      }

      return {
        id: c.id,
        sno: c.sno,
        name: f.name || (prevF && prevF.name) || c.name,
        user: f.user || (prevF && prevF.user) || c.user,
        gst: f.gst || (prevF && prevF.gst) || c.gst,
        category: f.category || (prevF && prevF.category) || c.category || 'Trader',
        taxRate: f.taxRate || (prevF && prevF.taxRate) || c.taxRate || '1%',
        rent: f.rent !== undefined ? f.rent : ((prevF && prevF.rent) || c.defaultRent || 'Rent'),
        rentAmount: f.rentAmount !== undefined ? f.rentAmount : ((prevF && prevF.rentAmount) || c.rentAmount || ''),
        cmp08: f.cmp08 || 'Pending',
        cmp08Date: f.cmp08Date || '',
        cmp08Arn: f.cmp08Arn || '',
        gstr4: f.gstr4 || 'Pending',
        gstr4Date: f.gstr4Date || '',
        gstr4Arn: f.gstr4Arn || '',
        taxableTurnover: f.taxableTurnover !== undefined ? f.taxableTurnover : '',
        taxAmount: f.taxAmount !== undefined ? f.taxAmount : '',
        remarks: f.remarks !== undefined ? f.remarks : ((prevF && prevF.remarks) || c.remarks || '')
      };
    });

    if (isUpdated) writeDb(db);
    list.sort((a, b) => a.sno - b.sno);
    const quarterInfo = db.compositionQuarters.find(q => q.name === quarter) || null;
    return sendJson(res, 200, { quarter, quarterInfo, copiedFrom: prevQuarterName, filings: list });
  }

  // POST /api/composition/filings/:quarter/copy-from-previous - Force copy COMPANY / SHOP NAME, RENT OPTION & AMOUNT, USER NAME, GSTIN from previous quarter
  if (method === 'POST' && pathname.startsWith('/api/composition/filings/') && pathname.endsWith('/copy-from-previous')) {
    const quarter = pathname.replace('/api/composition/filings/', '').replace('/copy-from-previous', '').trim();
    const db = readDb();
    const prevQuarterName = getPreviousQuarterName(quarter, db);
    if (!prevQuarterName || !db.compositionFilings[prevQuarterName]) {
      return sendError(res, 400, `No previous quarter data found before ${quarter}`);
    }
    const prevFilings = db.compositionFilings[prevQuarterName];
    if (!db.compositionFilings[quarter]) db.compositionFilings[quarter] = {};
    const cFilings = db.compositionFilings[quarter];

    db.compositionClients.forEach(c => {
      const prevF = prevFilings[c.id];
      if (prevF) {
        if (!cFilings[c.id]) cFilings[c.id] = { clientId: c.id };
        const f = cFilings[c.id];
        f.name = prevF.name || c.name;
        f.rent = prevF.rent !== undefined ? prevF.rent : (c.defaultRent || 'Rent');
        f.rentAmount = prevF.rentAmount !== undefined ? prevF.rentAmount : (c.rentAmount || '');
        f.user = prevF.user || c.user;
        f.gst = prevF.gst || c.gst;
        f.category = prevF.category || c.category || 'Trader';
        f.taxRate = prevF.taxRate || c.taxRate || '1%';
      }
    });

    writeDb(db);
    return sendJson(res, 200, { 
      success: true, 
      copiedFrom: prevQuarterName, 
      message: `Successfully copied Company Name, Rent Option & Amount, User Name, and GSTIN from ${prevQuarterName}!` 
    });
  }

  // PUT /api/composition/filings/:quarter/:clientId - Update single Composition filing record
  if (method === 'PUT' && pathname.startsWith('/api/composition/filings/')) {
    const parts = pathname.replace('/api/composition/filings/', '').split('/');
    if (parts.length >= 2) {
      const quarter = decodeURIComponent(parts[0]);
      const clientId = decodeURIComponent(parts[1]);
      try {
        const body = await parseBody(req);
        const db = readDb();
        if (!db.compositionFilings[quarter]) db.compositionFilings[quarter] = {};
        const current = db.compositionFilings[quarter][clientId] || { clientId };

        if (body.name !== undefined) {
          current.name = body.name.trim();
          current.editedName = true;
        }
        if (body.rent !== undefined) {
          current.rent = body.rent;
          current.editedRent = true;
        }
        if (body.rentAmount !== undefined) {
          current.rentAmount = body.rentAmount.toString().replace(/[^0-9]/g, '');
          current.editedRentAmount = true;
        }
        if (body.user !== undefined) {
          current.user = body.user.trim();
          current.editedUser = true;
        }
        if (body.gst !== undefined) {
          current.gst = body.gst.trim().toUpperCase();
          current.editedGst = true;
        }
        if (body.category !== undefined) current.category = body.category;
        if (body.cmp08 !== undefined) current.cmp08 = body.cmp08;
        if (body.cmp08Date !== undefined) current.cmp08Date = body.cmp08Date;
        if (body.cmp08Arn !== undefined) current.cmp08Arn = body.cmp08Arn;

        if (body.gstr4 !== undefined) current.gstr4 = body.gstr4;
        if (body.gstr4Date !== undefined) current.gstr4Date = body.gstr4Date;
        if (body.gstr4Arn !== undefined) current.gstr4Arn = body.gstr4Arn;

        if (body.taxableTurnover !== undefined) {
          current.taxableTurnover = body.taxableTurnover.toString().replace(/[^0-9]/g, '');
        }
        if (body.taxRate !== undefined) current.taxRate = body.taxRate;
        if (body.taxAmount !== undefined) {
          current.taxAmount = body.taxAmount.toString().replace(/[^0-9]/g, '');
        }
        if (body.remarks !== undefined) current.remarks = body.remarks;

        db.compositionFilings[quarter][clientId] = current;

        // Keep master composition client in sync
        const cc = db.compositionClients.find(x => x.id === clientId);
        if (cc) {
          if (body.name !== undefined) cc.name = current.name;
          if (body.user !== undefined) cc.user = current.user;
          if (body.gst !== undefined) cc.gst = current.gst;
          if (body.rent !== undefined) cc.defaultRent = current.rent;
          if (body.rentAmount !== undefined) cc.rentAmount = current.rentAmount;
          if (body.category !== undefined) cc.category = current.category;
          if (body.taxRate !== undefined) cc.taxRate = current.taxRate;
        }

        // Forward-propagate to subsequent quarters if not custom-overridden
        const curParsed = parseQuarterYear(quarter);
        if (curParsed) {
          db.compositionQuarters.forEach(q => {
            const qParsed = parseQuarterYear(q.name);
            if (qParsed && (qParsed.year > curParsed.year || (qParsed.year === curParsed.year && qParsed.qNum > curParsed.qNum))) {
              if (db.compositionFilings[q.name] && db.compositionFilings[q.name][clientId]) {
                const futF = db.compositionFilings[q.name][clientId];
                if (body.name !== undefined && !futF.editedName) futF.name = current.name;
                if (body.rent !== undefined && !futF.editedRent) futF.rent = current.rent;
                if (body.rentAmount !== undefined && !futF.editedRentAmount) futF.rentAmount = current.rentAmount;
                if (body.user !== undefined && !futF.editedUser) futF.user = current.user;
                if (body.gst !== undefined && !futF.editedGst) futF.gst = current.gst;
              }
            }
          });
        }

        writeDb(db);
        return sendJson(res, 200, { success: true, updated: current });
      } catch (err) {
        return sendError(res, 500, err.message);
      }
    }
  }

  // POST /api/composition/clients - Add new Composition shop
  if (method === 'POST' && pathname === '/api/composition/clients') {
    try {
      const body = await parseBody(req);
      const { name, user, gst, taxRate, category, remarks } = body;
      if (!name) return sendError(res, 400, 'Company Name is required');

      const db = readDb();
      const nextSno = db.compositionClients.reduce((max, c) => Math.max(max, c.sno || 0), 0) + 1;
      const newClient = {
        id: 'cmp' + Date.now(),
        sno: nextSno,
        name: name.trim(),
        user: (user || '').trim(),
        gst: (gst || '').trim().toUpperCase(),
        taxRate: taxRate || '1%',
        category: category || 'Trader',
        remarks: (remarks || '').trim()
      };

      db.compositionClients.push(newClient);
      Object.keys(db.compositionFilings).forEach(qName => {
        db.compositionFilings[qName][newClient.id] = {
          clientId: newClient.id,
          cmp08: 'Pending',
          cmp08Date: '',
          cmp08Arn: '',
          gstr4: 'Pending',
          gstr4Date: '',
          gstr4Arn: '',
          taxableTurnover: '',
          taxRate: newClient.taxRate,
          taxAmount: '',
          remarks: newClient.remarks
        };
      });

      writeDb(db);
      return sendJson(res, 201, { success: true, client: newClient });
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  }

  // PUT /api/composition/clients/:id - Edit Composition shop
  if (method === 'PUT' && pathname.startsWith('/api/composition/clients/')) {
    const id = pathname.replace('/api/composition/clients/', '').trim();
    try {
      const body = await parseBody(req);
      const db = readDb();
      const idx = db.compositionClients.findIndex(c => c.id === id);
      if (idx === -1) return sendError(res, 404, 'Composition shop not found');

      const c = db.compositionClients[idx];
      if (body.name !== undefined) c.name = body.name.trim();
      if (body.user !== undefined) c.user = body.user.trim();
      if (body.gst !== undefined) c.gst = body.gst.trim().toUpperCase();
      if (body.taxRate !== undefined) c.taxRate = body.taxRate;
      if (body.category !== undefined) c.category = body.category;
      if (body.remarks !== undefined) c.remarks = body.remarks.trim();

      writeDb(db);
      return sendJson(res, 200, { success: true, client: c });
    } catch (err) {
      return sendError(res, 500, err.message);
    }
  }

  // DELETE /api/composition/clients/:id - Delete Composition shop
  if (method === 'DELETE' && pathname.startsWith('/api/composition/clients/')) {
    const id = pathname.replace('/api/composition/clients/', '').trim();
    const db = readDb();
    const idx = db.compositionClients.findIndex(c => c.id === id);
    if (idx === -1) return sendError(res, 404, 'Composition shop not found');

    const deleted = db.compositionClients.splice(idx, 1)[0];
    db.compositionClients.forEach((c, i) => { c.sno = i + 1; });
    Object.keys(db.compositionFilings).forEach(q => {
      delete db.compositionFilings[q][id];
    });

    writeDb(db);
    return sendJson(res, 200, { success: true, message: `Shop "${deleted.name}" deleted`, client: deleted });
  }

  // GET /api/export/composition/csv/:quarter - Export Composition CSV
  if (method === 'GET' && pathname.startsWith('/api/export/composition/csv/')) {
    const quarter = pathname.replace('/api/export/composition/csv/', '').trim();
    const db = readDb();
    const cFilings = db.compositionFilings[quarter] || {};

    let csv = `S.NO,Company Name,Category,Tax Rate,User Name,GST No,CMP-08 (Quarterly),TAXABLE TURNOVER,TAX AMOUNT,GSTR-4 (Annual),REMARKS\n`;
    db.compositionClients.forEach(c => {
      const f = cFilings[c.id] || {};
      const cName = c.name.replace(/"/g, '""');
      const rem = (f.remarks || c.remarks || '').replace(/"/g, '""');
      csv += `${c.sno},"${cName}","${c.category || ''}","${f.taxRate || c.taxRate || '1%'}","${c.user}","${c.gst}",${f.cmp08 || 'Pending'},"${f.taxableTurnover || ''}","${f.taxAmount || ''}",${f.gstr4 || 'Pending'},"${rem}"\n`;
    });

    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${quarter.replace(/[\s\(\)\-\:]+/g, '_')}_Composition_Returns.csv"`
    });
    return res.end(csv);
  }

  // --- 404 NOT FOUND FOR UNMATCHED API ENDPOINTS ---
  if (pathname.startsWith('/api/')) {
    return sendError(res, 404, `API route not found: ${method} ${pathname}`);
  }

  // --- STATIC FILE SERVING ---
  let targetPath = pathname;
  if (targetPath.startsWith('/gstr')) {
    targetPath = targetPath.slice(5);
  }
  if (!targetPath || targetPath === '/' || targetPath === '') {
    targetPath = '/index.html';
  }
  let filePath = path.join(PUBLIC_DIR, targetPath);

  // Security check: prevent directory traversal
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    return res.end('Access denied');
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      filePath = path.join(PUBLIC_DIR, 'index.html');
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    fs.readFile(filePath, (readErr, content) => {
      if (readErr) {
        res.writeHead(500);
        return res.end('Server Error');
      }
      res.writeHead(200, { 'Content-Type': contentType });
      res.end(content);
    });
  });
  } catch (serverErr) {
    console.error('Unhandled Server Error:', serverErr);
    try {
      sendError(res, 500, 'Internal Server Error: ' + serverErr.message);
    } catch (_) {
      res.writeHead(500);
      res.end('Server Error');
    }
  }
}

module.exports = {
  matches,
  handle: handleRequest,
  readDb,
  writeDb
};

if (require.main === module) {
  const server = http.createServer(async (req, res) => {
    const parsedUrl = url.parse(req.url, true);
    const rawPathname = decodeURIComponent(parsedUrl.pathname || '/');
    const pathname = (rawPathname.length > 1 && rawPathname.endsWith('/')) 
      ? rawPathname.slice(0, -1) 
      : rawPathname;
    handleRequest(req, res, pathname, parsedUrl);
  });
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`====================================================`);
    console.log(`  BRT GST Return & Rent Compliance Tracker Started!`);
    console.log(`  Access Application at: http://localhost:${PORT}`);
    console.log(`====================================================`);
  });
}
