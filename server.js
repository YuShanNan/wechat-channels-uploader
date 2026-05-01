const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const { execSync } = require('child_process');

const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const upload = multer({ dest: UPLOADS_DIR });
const accounts = require('./accounts');
const {
  initBrowser, unlockProfile, loginFlow, batchUpload,
  preflightRecords, loadCSV, loadCSVFromString, isLogin, logger, LOG_PATH, RESULTS_PATH,
} = require('./batch-upload');

const PORT = process.env.PORT || 3123;

const app = express();
app.use(express.json({ limit: '200mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/screenshots', express.static(path.join(__dirname, 'screenshots')));

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

// ── Auto-shutdown when no clients connected ──
let shutdownTimer = null;

wss.on('connection', (ws) => {
  if (shutdownTimer) { clearTimeout(shutdownTimer); shutdownTimer = null; }
  ws.on('close', () => {
    const hasClient = [...wss.clients].some(c => c.readyState === 1);
    if (!hasClient) {
      shutdownTimer = setTimeout(() => {
        const stillNoClient = [...wss.clients].every(c => c.readyState !== 1);
        if (stillNoClient) {
          uploadState.abort = true;
          console.log('No clients connected, shutting down...');
          cleanup().then(() => { server.close(); process.exit(0); });
        }
      }, 30000);
    }
  });
});

// ── API Routes ──

// Accounts
app.get('/api/accounts', (req, res) => {
  res.json(accounts.loadAccounts());
});

app.post('/api/accounts', (req, res) => {
  try {
    const { name, label } = req.body;
    if (!name) return res.status(400).json({ error: 'name required' });
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) return res.status(400).json({ error: 'Invalid account name' });
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
    const ctx = activeContexts[req.params.name];
    delete activeContexts[req.params.name];
    if (ctx) ctx.close().catch(() => {});
    res.json(acct);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Login: capture QR code and show in web UI
app.post('/api/accounts/:name/qrcode', async (req, res) => {
  try {
    const acct = accounts.getAccount(req.params.name);
    if (!acct) return res.status(404).json({ error: 'Account not found' });

    // Close any existing context
    const existing = activeContexts[req.params.name];
    delete activeContexts[req.params.name];
    if (existing) { try { await existing.close(); } catch {} }

    unlockProfile(acct.profileDir);
    const ctx = await initBrowser(acct.profileDir, { headless: false });
    if (ctx.pages().length === 0) {
      await ctx.close();
      return res.status(500).json({ error: '浏览器启动失败' });
    }
    activeContexts[req.params.name] = ctx;

    const page = ctx.pages()[0];
    await page.goto('https://channels.weixin.qq.com/', { waitUntil: 'networkidle', timeout: 30000 });
    await page.waitForTimeout(3000);

    // Find QR code element — try common WeChat login selectors
    let qrBuf = null;
    const qrSelectors = [
      '.impowerBox img', '.qrcode img', '.login_qrcode_img',
      'img[src*="qrcode" i]', 'img[src*="qr" i]', '.qrcode_scan img',
      '#login_container img', '.wr_code_img',
    ];
    const captureQR = async (locator) => {
      const el = locator.first();
      if (!(await el.count() > 0 && await el.isVisible({ timeout: 1000 }).catch(() => false))) return null;
      // 微信二维码 src 为内嵌 base64 data URL（1000×1000 原图），直接提取避免 CSS overflow:hidden 裁剪
      const src = await el.getAttribute('src').catch(() => null);
      if (src && src.startsWith('data:image/')) {
        const base64 = src.replace(/^data:image\/\w+;base64,/, '');
        return Buffer.from(base64, 'base64');
      }
      // 回退：非 data URL 时使用截图方式
      return await el.screenshot({ type: 'png' });
    };

    for (const sel of qrSelectors) {
      try {
        qrBuf = await captureQR(page.locator(sel));
        if (qrBuf) break;
      } catch {}
    }

    // Check iframes (WeChat QR often in open.weixin.qq.com iframe)
    if (!qrBuf) {
      for (const frame of page.frames()) {
        if (frame === page.mainFrame()) continue;
        for (const sel of qrSelectors) {
          try {
            qrBuf = await captureQR(frame.locator(sel));
            if (qrBuf) break;
          } catch {}
        }
        if (qrBuf) break;
      }
    }

    // Fallback: full page screenshot
    if (!qrBuf) {
      qrBuf = await page.screenshot({ type: 'png' });
    }

    logger.info(`QR code captured for ${acct.label}`);
    res.json({ qrcode: 'data:image/png;base64,' + qrBuf.toString('base64') });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Check QR login status
app.get('/api/accounts/:name/qrcode/status', async (req, res) => {
  try {
    const ctx = activeContexts[req.params.name];
    if (!ctx || ctx.pages().length === 0) return res.json({ status: 'expired' });

    const page = ctx.pages()[0];
    const url = page.url();

    // 检查所有页面：扫码成功后可能在新标签页中跳转
    let doneUrl = null;
    for (const p of ctx.pages()) {
      const u = p.url();
      if (!isLogin(u)) { doneUrl = u; break; }
    }
    if (doneUrl) {
      accounts.updateAccountStatus(req.params.name, 'ready');
      try { await ctx.close(); } catch {}
      delete activeContexts[req.params.name];
      logger.info(`QR login complete for ${req.params.name} (${doneUrl})`);
      return res.json({ status: 'done' });
    }

    // 检查页面内容：扫码后出现"已扫码"等文字
    try {
      const bodyText = await page.textContent('body').catch(() => '');
      if (bodyText.includes('已扫码') || bodyText.includes('扫描成功') || bodyText.includes('确认登录')) {
        return res.json({ status: 'scanned' });
      }
    } catch {}

    // Check for expired message on page
    try {
      const expiredTexts = ['过期', 'expired', '已失效', '重新获取'];
      const bodyText = await page.textContent('body').catch(() => '');
      if (expiredTexts.some(t => bodyText.includes(t))) {
        return res.json({ status: 'expired' });
      }
    } catch {}

    res.json({ status: 'waiting' });
  } catch (e) {
    res.json({ status: 'expired', error: e.message });
  }
});

// Cancel QR login: user closed the modal, clean up browser
app.post('/api/accounts/:name/qrcode/cancel', async (req, res) => {
  try {
    const ctx = activeContexts[req.params.name];
    delete activeContexts[req.params.name];
    if (ctx) {
      try { await ctx.close(); } catch {}
      logger.info(`Login browser closed for ${req.params.name} (cancelled)`);
    }
    res.json({ message: 'Cancelled' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Login done: mark account as ready and close login browser
app.post('/api/accounts/:name/login/done', async (req, res) => {
  try {
    accounts.updateAccountStatus(req.params.name, 'ready');
    const ctx = activeContexts[req.params.name];
    delete activeContexts[req.params.name];
    if (ctx) {
      try { await ctx.close(); logger.info(`Login browser closed for ${req.params.name}`); } catch {}
    }
    res.json({ message: 'Login saved' });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Verify login status
app.post('/api/accounts/:name/verify', async (req, res) => {
  let ctx = null;
  try {
    const acct = accounts.getAccount(req.params.name);
    if (!acct) return res.status(404).json({ error: 'Account not found' });

    // Close any existing context to free profile lock
    const existing = activeContexts[req.params.name];
    delete activeContexts[req.params.name];
    if (existing) { try { await existing.close(); } catch {} }

    unlockProfile(acct.profileDir);
    ctx = await initBrowser(acct.profileDir, { headless: true });
    if (ctx.pages().length === 0) {
      await ctx.close();
      return res.status(500).json({ error: '浏览器启动失败，profile 可能被占用' });
    }
    const page = ctx.pages()[0];
    await page.goto('https://channels.weixin.qq.com/platform/post/create', {
      waitUntil: 'domcontentloaded', timeout: 15000,
    });
    // 等待页面稳定，客户端重定向可能在 DOMContentLoaded 之后才触发
    await page.waitForTimeout(5000);
    const currentUrl = page.url();
    const expired = isLogin(currentUrl);
    if (expired) {
      accounts.updateAccountStatus(req.params.name, 'needs-login');
      logger.info(`Account ${acct.label}: login expired`);
    } else {
      accounts.updateAccountStatus(req.params.name, 'ready');
      logger.info(`Account ${acct.label}: login valid (url: ${currentUrl})`);
    }

    res.json({ name: req.params.name, valid: !expired });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (ctx) { try { await ctx.close(); } catch {} }
  }
});

// Close browser for an account
app.post('/api/accounts/:name/close', async (req, res) => {
  try {
    const ctx = activeContexts[req.params.name];
    delete activeContexts[req.params.name]; // remove first to prevent races
    if (ctx) {
      try { await ctx.close(); } catch {}
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

  // Save for crash recovery
  fs.writeFileSync(path.join(__dirname, 'last-batch.csv'), csvContent, 'utf-8');

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
    if (ctx.pages().length === 0) {
      logger.error('Browser launched but no page created — profile may be locked or Chrome crashed');
      uploadState.running = false;
      broadcast({ type: 'upload-end', success: false, error: '浏览器启动失败，请检查是否有其他 Chrome 实例占用同一账号，或重启电脑后重试' });
      return;
    }

    // Parse CSV
    let records;
    try {
      records = loadCSVFromString(csvContent);
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
      resume: false,
      abortSignal: uploadState,
      onProgress: (p) => {
        broadcast({ type: 'progress', current: p.current, total: p.total, status: p.status, title: p.title });
      },
      onLoginExpired: (record) => {
        accounts.updateAccountStatus(accountName, 'needs-login');
        broadcast({ type: 'login-expired', account: accountName, title: record.title });
      },
    });

    const loginExpired = results.some(r => r._loginExpired);
    broadcast({ type: 'upload-end', success: true, results: results.filter(r => r.status === 'published').length, total: results.length, loginExpired });
    logger.info(`Upload complete: ${results.filter(r => r.status === 'published').length}/${results.length}`);

    // Cleanup old temp files (>7 days), keep recent ones for "恢复上次"
    try {
      const now = Date.now();
      for (const f of fs.readdirSync(UPLOADS_DIR)) {
        const fp = path.join(UPLOADS_DIR, f);
        try {
          if (now - fs.statSync(fp).mtimeMs > 36 * 3600000) fs.unlinkSync(fp);
        } catch {}
      }
    } catch {}
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

app.get('/api/upload/last-csv', (req, res) => {
  const p = path.join(__dirname, 'last-batch.csv');
  try {
    const csv = fs.readFileSync(p, 'utf-8');
    const records = loadCSVFromString(csv);
    const validated = preflightRecords(records);
    res.json({ entries: validated.map(r => ({
      video_path: r.video_path,
      cover_path: r.cover_path || '',
      title: r.title || '',
      description: r.description || '',
      short_drama_name: r.short_drama_name || '',
      publish_time: r.publish_time || '',
      valid: !r._skip,
      error: r._skipReason || '',
    }))});
  } catch {
    res.json({ entries: null });
  }
});

app.post('/api/upload/validate', (req, res) => {
  try {
    const { csv: csvContent } = req.body;
    if (!csvContent) return res.status(400).json({ error: 'csv required' });
    const records = loadCSVFromString(csvContent);
    const validated = preflightRecords(records);
    res.json(validated.map(r => ({
      title: r.title,
      video_path: r.video_path,
      valid: !r._skip,
      error: r._skipReason || '',
    })));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/upload/status', (req, res) => {
  res.json({ running: uploadState.running, abort: uploadState.abort });
});

// File upload (drag-drop support)
app.post('/api/upload/file', upload.single('file'), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'no file uploaded' });
    const originalName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    const safeName = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}_${originalName}`;
    const dest = path.join(UPLOADS_DIR, safeName);
    fs.renameSync(req.file.path, dest);
    res.json({ path: dest, name: originalName, size: req.file.size });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Results & log
app.get('/api/results', (req, res) => {
  try {
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
  } catch {
    res.json([]);
  }
});

app.get('/api/log', (req, res) => {
  if (!fs.existsSync(LOG_PATH)) return res.json([]);
  const text = fs.readFileSync(LOG_PATH, 'utf-8');
  res.json(text.split('\n').filter(Boolean).slice(-200));
});

// ── Cleanup ──
async function cleanup() {
  for (const [name, ctx] of Object.entries(activeContexts)) {
    try { await ctx.close(); } catch {}
    delete activeContexts[name];
  }
}

process.on('SIGINT', async () => { await cleanup(); process.exit(0); });
process.on('SIGTERM', async () => { await cleanup(); process.exit(0); });
process.on('uncaughtException', async (err) => {
  console.error('Uncaught exception:', err.message);
  await cleanup();
  process.exit(1);
});
process.on('unhandledRejection', async (reason) => {
  console.error('Unhandled rejection:', reason);
  await cleanup();
  process.exit(1);
});

// ── Start ──
server.listen(PORT, () => {
  console.log(`Server: http://localhost:${PORT}`);
});
