const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const accounts = require('./accounts');
const {
  initBrowser, unlockProfile, loginFlow, batchUpload,
  preflightRecords, loadCSV, logger, LOG_PATH, RESULTS_PATH,
} = require('./batch-upload');

const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '200mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// ── WebSocket: stream log to all clients ──
function broadcast(msg) {
  wss.clients.forEach(client => {
    if (client.readyState === 1) client.send(JSON.stringify(msg));
  });
}

// Override logger to broadcast to WS
const origInfo = logger.info.bind(logger);
const origWarn = logger.warn.bind(logger);
const origError = logger.error.bind(logger);
logger.info = (msg) => { origInfo(msg); broadcast({ type: 'log', level: 'INFO', msg, ts: new Date().toISOString() }); };
logger.warn = (msg) => { origWarn(msg); broadcast({ type: 'log', level: 'WARN', msg, ts: new Date().toISOString() }); };
logger.error = (msg) => { origError(msg); broadcast({ type: 'log', level: 'ERROR', msg, ts: new Date().toISOString() }); };

// ── State ──
let activeContexts = {};
let uploadState = { running: false, abort: false };

// ── API Routes ──

// Accounts
app.get('/api/accounts', (req, res) => {
  res.json(accounts.loadAccounts());
});

app.post('/api/accounts', (req, res) => {
  try {
    const { name, label } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    const acct = accounts.createAccount(name, label || name);
    res.json(acct);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.patch('/api/accounts/:name', (req, res) => {
  try {
    const acct = accounts.updateAccount(req.params.name, req.body);
    res.json(acct);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/accounts/:name', (req, res) => {
  try {
    const acct = accounts.deleteAccount(req.params.name);
    // Close context if open
    if (activeContexts[req.params.name]) {
      activeContexts[req.params.name].close().catch(() => {});
      delete activeContexts[req.params.name];
    }
    res.json(acct);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Login: open browser for an account
app.post('/api/accounts/:name/login', async (req, res) => {
  try {
    const acct = accounts.getAccount(req.params.name);
    if (!acct) return res.status(404).json({ error: 'Account not found' });

    unlockProfile(acct.profileDir);

    const ctx = await initBrowser(acct.profileDir);
    activeContexts[req.params.name] = ctx;

    // Navigate to channels
    const page = ctx.pages()[0];
    await page.goto('https://channels.weixin.qq.com/', { waitUntil: 'domcontentloaded' });
    logger.info(`Login browser opened for ${acct.label}`);

    res.json({ message: 'Browser opened for login' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Login done: mark account as ready
app.post('/api/accounts/:name/login/done', (req, res) => {
  try {
    accounts.updateAccountStatus(req.params.name, 'ready');
    res.json({ message: 'Login saved' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Close browser for an account
app.post('/api/accounts/:name/close', async (req, res) => {
  try {
    if (activeContexts[req.params.name]) {
      await activeContexts[req.params.name].close();
      delete activeContexts[req.params.name];
    }
    res.json({ message: 'Browser closed' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Upload
app.post('/api/upload/start', async (req, res) => {
  if (uploadState.running) return res.status(400).json({ error: 'Upload already running' });

  const { account: accountName, csv: csvContent } = req.body;
  if (!accountName) return res.status(400).json({ error: 'account required' });
  if (!csvContent) return res.status(400).json({ error: 'csv content required' });

  const acct = accounts.getAccount(accountName);
  if (!acct) return res.status(404).json({ error: 'Account not found' });

  res.json({ message: 'Upload started' });

  // Run async in background
  uploadState.running = true;
  uploadState.abort = false;

  try {
    let ctx = activeContexts[accountName];
    if (!ctx) {
      unlockProfile(acct.profileDir);
      ctx = await initBrowser(acct.profileDir);
      activeContexts[accountName] = ctx;
    }

    // Parse CSV
    let records;
    try {
      const tmpCsv = path.join(__dirname, `_upload_${Date.now()}.csv`);
      fs.writeFileSync(tmpCsv, csvContent, 'utf-8');
      records = loadCSV(tmpCsv);
      fs.unlinkSync(tmpCsv);
    } catch (e) {
      logger.error(`CSV parse error: ${e.message}`);
      uploadState.running = false;
      broadcast({ type: 'upload-end', success: false, error: e.message });
      return;
    }

    records = preflightRecords(records);
    const validCount = records.filter(r => !r._skip).length;
    if (validCount === 0) {
      logger.warn('No valid records');
      uploadState.running = false;
      broadcast({ type: 'upload-end', success: false, error: 'No valid records' });
      return;
    }
    logger.info(`Preflight: ${validCount} valid, ${records.length - validCount} skipped`);

    const results = await batchUpload(ctx, records, {
      resume: true,
      abortSignal: uploadState,
      onProgress: (p) => {
        broadcast({ type: 'progress', current: p.current, total: p.total, status: p.status, title: p.title });
      },
    });

    broadcast({ type: 'upload-end', success: true, results: results.filter(r => r.status === 'published').length, total: results.length });
    logger.info(`Upload complete: ${results.filter(r => r.status === 'published').length}/${results.length}`);
  } catch (e) {
    logger.error(`Upload error: ${e.message}`);
    broadcast({ type: 'upload-end', success: false, error: e.message });
  } finally {
    uploadState.running = false;
  }
});

app.post('/api/upload/stop', (req, res) => {
  uploadState.abort = true;
  res.json({ message: 'Stopping after current video' });
});

app.get('/api/upload/status', (req, res) => {
  res.json({ running: uploadState.running, abort: uploadState.abort });
});

// File upload (drag-drop support)
app.post('/api/upload/file', (req, res) => {
  try {
    const { name, data } = req.body; // data = base64 string
    if (!name || !data) return res.status(400).json({ error: 'name and data required' });
    const ext = path.extname(name) || '.bin';
    const safeName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}${ext}`;
    const dest = path.join(UPLOADS_DIR, safeName);
    const buffer = Buffer.from(data, 'base64');
    fs.writeFileSync(dest, buffer);
    res.json({ path: dest, name: safeName, size: buffer.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Results & log
app.get('/api/results', (req, res) => {
  if (!fs.existsSync(RESULTS_PATH)) return res.json([]);
  const text = fs.readFileSync(RESULTS_PATH, 'utf-8');
  const lines = text.split('\n').filter(Boolean);
  if (lines.length <= 1) return res.json([]);
  const headers = lines[0].split(',');
  const rows = lines.slice(1).map(line => {
    const vals = line.split(',');
    return headers.reduce((obj, h, i) => ({ ...obj, [h.trim()]: (vals[i] || '').replace(/^"|"$/g, '') }), {});
  });
  res.json(rows);
});

app.get('/api/log', (req, res) => {
  if (!fs.existsSync(LOG_PATH)) return res.json([]);
  const text = fs.readFileSync(LOG_PATH, 'utf-8');
  res.json(text.split('\n').filter(Boolean).slice(-200));
});

// ── Start ──
server.listen(PORT, () => {
  console.log(`Server: http://localhost:${PORT}`);
});
