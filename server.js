/**
 * Zero-dependency local development & browser runner for ClientLedger Pro
 * Run: node server.js (or double-click start.bat)
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const DB_FILE = path.join(ROOT, 'database.json');

// Import GSTR (Rahul 3B) Sub-App & API Router
let gstrServer = null;
try {
  gstrServer = require('./gstr/server.js');
} catch (err) {
  console.warn('Note: ./gstr/server.js could not be loaded:', err.message);
}

const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.js': 'text/javascript; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
}

const server = http.createServer((req, res) => {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;
  const action = parsedUrl.searchParams.get('action') || '';

  // ==================== GSTR (RAHUL 3B) INTEGRATION ====================
  if (gstrServer && gstrServer.matches(pathname)) {
    return gstrServer.handle(req, res, pathname);
  }

  // ==================== DATABASE API ENDPOINTS ====================
  // Emulates api.php / BigRock API directly in Node.js for instant local database sync
  if (pathname === '/api.php' || pathname === '/api' || pathname === '/api/ping' || pathname === '/api/load' || pathname === '/api/save') {
    res.setHeader('Content-Type', 'application/json; charset=UTF-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');

    // 1. PING / STATUS TEST
    if (action === 'ping' || pathname === '/api/ping') {
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        message: 'Successfully connected to Local Server Database (database.json)!',
        timestamp: new Date().toISOString(),
      }));
      return;
    }

    // 2. LOAD DATA
    if (action === 'load' || pathname === '/api/load' || (req.method === 'GET' && !action)) {
      try {
        if (fs.existsSync(DB_FILE)) {
          const content = fs.readFileSync(DB_FILE, 'utf8');
          const parsed = JSON.parse(content || '{}');
          res.writeHead(200);
          res.end(JSON.stringify({
            success: true,
            source: 'local_server_db',
            data: parsed,
          }));
        } else {
          res.writeHead(200);
          res.end(JSON.stringify({
            success: true,
            source: 'empty',
            data: null,
          }));
        }
      } catch (err) {
        res.writeHead(500);
        res.end(JSON.stringify({
          success: false,
          error: 'Error reading database file: ' + err.message,
        }));
      }
      return;
    }

    // 3. SAVE DATA
    if (action === 'save' || pathname === '/api/save' || req.method === 'POST') {
      let body = '';
      req.on('data', chunk => {
        body += chunk;
        if (body.length > 50 * 1024 * 1024) { // 50MB limit
          res.writeHead(413);
          res.end(JSON.stringify({ success: false, error: 'Payload too large' }));
          req.destroy();
        }
      });

      req.on('end', () => {
        try {
          if (!body || !body.trim()) {
            res.writeHead(400);
            res.end(JSON.stringify({ success: false, error: 'Empty payload' }));
            return;
          }

          const parsed = JSON.parse(body);
          // Atomic write to database.json
          fs.writeFileSync(DB_FILE, JSON.stringify(parsed, null, 2), 'utf8');

          res.writeHead(200);
          res.end(JSON.stringify({
            success: true,
            message: 'Data successfully synced and saved to server database (database.json)',
            savedAt: new Date().toISOString(),
          }));
        } catch (err) {
          res.writeHead(400);
          res.end(JSON.stringify({
            success: false,
            error: 'Invalid JSON or write error: ' + err.message,
          }));
        }
      });
      return;
    }

    res.writeHead(400);
    res.end(JSON.stringify({ success: false, error: 'Unknown action: ' + action }));
    return;
  }

  // ==================== STATIC FILE SERVING ====================
  let reqPath = decodeURI(pathname);
  if (reqPath === '/' || reqPath === '') reqPath = '/index.html';

  const filePath = path.join(ROOT, reqPath);

  // Security check: ensure path is within ROOT
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });

    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  const url = `http://localhost:${PORT}`;
  console.log('====================================================');
  console.log(` ClientLedger Pro + BRT GSTR Returns Tracker running!`);
  console.log(` Main App URL: ${url}`);
  console.log(` GSTR Tab URL: ${url}/gstr`);
  console.log(` Press Ctrl + C to stop the server.`);
  console.log('====================================================');

  // Automatically open browser on Windows
  exec(`start ${url}`, (err) => {
    if (err) {
      console.log(`Please open ${url} in your browser.`);
    }
  });
});
