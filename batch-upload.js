const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');
const { parse } = require('csv-parse/sync');

const PROFILE_DIR = path.join(__dirname, 'browser-profile');
const LOG_PATH = path.join(__dirname, 'upload.log');
const SCREENSHOTS_DIR = path.join(__dirname, 'screenshots');
const RESULTS_PATH = path.join(__dirname, 'results.csv');
const MAX_RETRIES = 2;

const PLATFORM = {
  maxFileSize: 20 * 1024 * 1024 * 1024,
  maxDuration: 8 * 3600,
  minDuration: 5,
  allowedCodec: 'h264',
  maxBitrate: 10 * 1000 * 1000,
  allowedFormats: ['.mp4'],
  titleMinLen: 6,
};

// ── Logger ──
function ts() {
  return new Date().toLocaleString('zh-CN', { hour12: false });
}
const logger = {
  _write(level, msg) {
    const line = `[${ts()}] [${level}] ${msg}`;
    console.log(line);
    try { fs.appendFileSync(LOG_PATH, line + '\n'); } catch {}
  },
  info(msg) { this._write('INFO', msg); },
  warn(msg) { this._write('WARN', msg); },
  error(msg) { this._write('ERROR', msg); },
};

// ── Desktop notification ──
function notifyUser(title, message) {
  try {
    const s = message.replace(/'/g, "''").replace(/"/g, '``');
    execSync(
      `powershell -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('${s}', '${title.replace(/'/g, "''")}')"`,
      { timeout: 10000 }
    );
  } catch {}
}

// ── CSV ──
function csvEscape(val) {
  const s = String(val ?? '');
  if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

function writeResults(results, resultsPath) {
  const rp = resultsPath || RESULTS_PATH;
  const header = 'video_path,title,status,error';
  const rows = [header];
  for (const r of results) {
    rows.push([csvEscape(r.video_path), csvEscape(r.title), csvEscape(r.status), csvEscape(r.error)].join(','));
  }
  fs.writeFileSync(rp, '﻿' + rows.join('\n'), 'utf-8');
}

function loadPublishedTitles(resultsPath, resume) {
  const set = new Set();
  if (!resume || !fs.existsSync(resultsPath)) return set;
  const text = fs.readFileSync(resultsPath, 'utf-8');
  for (const line of text.split('\n').slice(1)) {
    if (!line.trim()) continue;
    try {
      const p = parse(line, { columns: ['vp', 't', 'st', 'err'], skip_empty_lines: true, relax_column_count: true });
      if (p.length > 0 && p[0].st === 'published') set.add(p[0].t);
    } catch {}
  }
  return set;
}

// ── ffprobe ──
function probeVideo(filePath) {
  try {
    const out = execFileSync('ffprobe', [
      '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', filePath,
    ], { timeout: 15000, encoding: 'utf-8' });
    const data = JSON.parse(out);
    const vs = (data.streams || []).find(s => s.codec_type === 'video');
    const fmt = data.format || {};
    return {
      duration: parseFloat(fmt.duration || 0),
      size: parseInt(fmt.size || 0),
      codec: vs ? vs.codec_name : 'unknown',
      bitrate: parseInt(fmt.bit_rate || 0),
      width: vs ? vs.width : 0,
      height: vs ? vs.height : 0,
    };
  } catch (e) {
    logger.warn(`  ffprobe failed for ${path.basename(filePath)}: ${e.message}`);
    return null;
  }
}

// ── Validation ──
function loadCSV(csvPath) {
  if (!fs.existsSync(csvPath)) throw new Error(`CSV not found: ${csvPath}`);
  return parse(fs.readFileSync(csvPath, 'utf-8'), {
    columns: true, skip_empty_lines: true, relax_column_count: true, bom: true,
  });
}

function loadCSVFromString(csvContent) {
  return parse(csvContent, {
    columns: true, skip_empty_lines: true, relax_column_count: true, bom: true,
  });
}

function validateTitle(title) {
  if (!title) return null; // optional
  const allowed = new Set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 《》（）《》“”‘’：+？%℃ ');
  for (const ch of title) {
    if (!allowed.has(ch) && !(ch >= '一' && ch <= '鿿')) return `Unsupported char "${ch}"`;
  }
  if (title.length < 6) return `Title too short (${title.length}), min 6`;
  return null;
}

function preflightRecords(records) {
  const valid = [];
  for (const r of records) {
    const errs = [];
    if (!r.video_path || !r.video_path.trim()) {
      errs.push('Missing video_path');
    } else {
      const vp = r.video_path.trim();
      if (!fs.existsSync(vp)) {
        errs.push(`File not found: ${vp}`);
      } else {
        const stat = fs.statSync(vp);
        if (stat.size > PLATFORM.maxFileSize) errs.push(`File too large (${(stat.size / 1024 / 1024 / 1024).toFixed(1)} GB)`);
        const ext = path.extname(vp).toLowerCase();
        if (!PLATFORM.allowedFormats.includes(ext)) logger.warn(`  [Preflight] ${r.title}: format ${ext} not recommended`);
        const info = probeVideo(vp);
        if (info) {
          if (info.duration > PLATFORM.maxDuration) errs.push(`Video too long (${(info.duration / 3600).toFixed(1)}h)`);
          if (info.codec !== PLATFORM.allowedCodec && info.codec !== 'unknown') logger.warn(`  [Preflight] ${r.title}: codec ${info.codec}`);
          if (info.bitrate > PLATFORM.maxBitrate) logger.warn(`  [Preflight] ${r.title}: bitrate ${(info.bitrate / 1000 / 1000).toFixed(1)} Mbps`);
        }
      }
    }
    if (!r.title || !r.title.trim()) {
      // title is optional
    } else {
      const ve = validateTitle(r.title.trim());
      if (ve) errs.push(ve);
    }
    if (errs.length > 0) {
      r._skip = true;
      r._skipReason = errs.join('; ');
    }
    valid.push(r._skip ? r : r); // keep all, just mark skipped
  }
  return records; // return all with _skip flags
}

// ── Error classification ──
function classifyError(msg) {
  if (!msg) return 'fatal';
  if (['login', 'Login', 'Not logged in', '登录'].some(k => msg.includes(k))) return 'login-expired';
  if (['title', 'Title'].some(k => msg.includes(k))) return 'title-error';
  if (['timeout', 'Timeout', 'net::ERR_', 'ETIMEDOUT', 'ECONNRESET', 'NS_ERROR_', 'CONNECTION', 'INTERNET_'].some(k => msg.includes(k))) return 'retryable';
  return 'fatal';
}

function isLogin(url) { return url.includes('login'); }

// ── Browser helpers ──
async function initBrowser(profileDir, options = {}) {
  const { headless = true } = options;
  const browserContext = await chromium.launchPersistentContext(profileDir, {
    headless, channel: 'chrome', viewport: { width: 1440, height: 900 }, locale: 'zh-CN',
  });
  return browserContext;
}

async function unlockProfile(profileDir) {
  const lockFile = path.join(profileDir, 'SingletonLock');
  if (fs.existsSync(lockFile)) {
    logger.warn('Profile locked — removing lock file...');
    try {
      fs.unlinkSync(lockFile);
      logger.info('Profile unlocked');
    } catch { logger.warn('Could not remove lock file'); }
  }
}

async function loginFlow(browserContext) {
  const page = browserContext.pages()[0];
  await page.goto('https://channels.weixin.qq.com/', { waitUntil: 'domcontentloaded' });
  logger.info('=== Scan QR code to login, then press Enter ===');
  await Promise.race([
    new Promise(r => process.stdin.once('data', r)),
    new Promise(r => setTimeout(r, 300000)),
  ]);
  logger.info('Login saved');
}

// ── Upload helpers ──
async function waitForUploadWithProgress(page, abortSignal) {
  const startTime = Date.now();
  while (Date.now() - startTime < 300000) {
    if (abortSignal && abortSignal.abort) {
      logger.warn('  Upload aborted by user');
      return 'aborted';
    }
    if (await page.locator('.ant-slider').count().catch(() => 0) > 0) {
      logger.info(`  Upload complete (${Math.round((Date.now() - startTime) / 1000)}s)`);
      return 'ok';
    }
    logger.info(`  Uploading... ${Math.round((Date.now() - startTime) / 1000)}s`);
    await page.waitForTimeout(15000);
  }
  logger.warn('  Upload timeout (300s), continuing');
}

async function selectShortDrama(page, dramaName) {
  logger.info(`  Selecting drama: ${dramaName}`);
  try {
    const base = page.locator('.link-selector').getByText('选择链接').or(page.getByText('选择链接', { exact: true }));
    await base.first().click();
    await page.getByText('视频号剧集', { exact: true }).waitFor({ state: 'visible', timeout: 5000 });
    await page.getByText('视频号剧集', { exact: true }).click();
    await page.getByText('选择需要添加的视频号剧集').waitFor({ state: 'visible', timeout: 5000 });
    await page.getByText('选择需要添加的视频号剧集').click();
    const sb = page.getByRole('textbox', { name: '搜索内容' });
    await sb.waitFor({ state: 'visible', timeout: 5000 });
    await sb.fill(dramaName);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(1000);
    for (const loc of [
      page.locator('table tbody tr').first(), page.getByRole('row').nth(1),
    ]) {
      try { if (await loc.count() > 0) { await loc.click({ timeout: 3000 }); logger.info(`  Selected drama: ${dramaName}`); return; } } catch {}
    }
    logger.warn(`  Drama "${dramaName}" not found`);
    await page.keyboard.press('Escape');
  } catch (e) { logger.warn(`  Drama failed: ${e.message}`); }
}

async function setCover(page, coverPath) {
  logger.info(`  Setting cover`);
  if (!fs.existsSync(coverPath)) { logger.warn(`  Cover not found: ${coverPath}`); return; }
  try {
    await page.getByText('编辑', { exact: true }).click({ force: true });
    await page.getByRole('heading', { name: '编辑封面' }).waitFor({ state: 'visible', timeout: 5000 });
    await page.getByText('上传封面', { exact: true }).click();
    await page.locator('input[type=file]').nth(1).setInputFiles(coverPath);
    await page.waitForTimeout(2000);
    await page.getByRole('button', { name: '确认' }).click();
    logger.info('  Cover set');
  } catch (e) { logger.warn(`  Cover failed: ${e.message}`); }
}

async function hideLocation(page) {
  logger.info('  Hiding location');
  try {
    if (await page.getByText('不显示位置').first().isVisible().catch(() => false)) return;
    await page.locator('.location-name').first().click();
    await page.waitForTimeout(300);
    await page.getByText('不显示位置', { exact: true }).click();
  } catch (e) { logger.warn(`  Location failed: ${e.message}`); }
}

async function verifyPublish(page) {
  await page.waitForTimeout(2000);
  try { await page.waitForURL(u => !u.href.includes('/post/create'), { timeout: 15000 }); return true; } catch {}
  try { await page.waitForSelector('text=/已发表|发表成功|success/i', { timeout: 8000 }); return true; } catch {}
  try { await page.waitForSelector('[class*="success"]', { timeout: 5000 }); return true; } catch {}
  return false;
}

async function processVideo(browserContext, record) {
  let page = browserContext.pages()[0];
  if (!page) {
    logger.warn('  No page in context, creating new page...');
    page = await browserContext.newPage();
  }
  const result = { video_path: record.video_path, title: record.title, status: 'unknown', error: '', _errorType: 'fatal', _loginExpired: false };

  try {
    logger.info(`\n=== ${record.title} ===`);
    // 先导航到平台首页，再通过导航进入发表页面
    await page.goto('https://channels.weixin.qq.com/platform', {
      waitUntil: 'domcontentloaded', timeout: 30000,
    });
    await page.waitForTimeout(5000);
    if (isLogin(page.url())) { result.status = 'failed'; result.error = 'Not logged in'; result._loginExpired = true; return result; }

    // Try direct URL first (might work if URL structure unchanged)
    // If it redirects, go through the navigation flow
    if (!page.url().includes('/post/create')) {
      logger.info('  Looking for upload entry via navigation...');
      // 尝试通过侧边栏导航到发表页面
      // Flow: 内容管理 → 发表视频
      const navSteps = [
        // Step 1: 找 "内容管理" 或 "发表视频" 菜单
        { action: 'click', selector: page.getByText('内容管理', { exact: true }), desc: '内容管理' },
        { action: 'click', selector: page.getByText(/内容管理|发表视频|视频管理/), desc: '内容/发表/视频管理 (模糊)' },
        { action: 'click', selector: page.getByText('发表视频', { exact: true }), desc: '发表视频' },
        // Direct buttons on dashboard
        { action: 'click', selector: page.getByRole('button', { name: /发布视频|发表视频|上传视频|创作/ }), desc: '发布/发表/上传/创作按钮' },
      ];

      for (const step of navSteps) {
        try {
          const el = step.selector.first();
          if (await el.count() > 0) {
            await el.click({ timeout: 3000 });
            logger.info(`  Clicked: ${step.desc}`);
            await page.waitForTimeout(3000);
          }
        } catch {}
      }

      // Check if we've landed on a page with file input
      if (await page.locator('input[type=file]').count() === 0) {
        // Try navigating to old URL as fallback
        logger.info('  Trying legacy URL /platform/post/create...');
        await page.goto('https://channels.weixin.qq.com/platform/post/create', {
          waitUntil: 'domcontentloaded', timeout: 15000,
        });
        await page.waitForTimeout(3000);
      }
    }
    // 等待上传区域出现 — 先截图确认页面状态
    let fileInput = page.locator('input[type=file]').first();
    try {
      await fileInput.waitFor({ state: 'attached', timeout: 15000 });
    } catch {
      // 保存截图 + HTML 用于调试
      if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
      const ts = Date.now();
      const sfx = (record.title || 'unknown').replace(/[<>:"/\\|?*]/g, '_').slice(0, 30);
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, `debug_${ts}_${sfx}.png`), fullPage: true });
      fs.writeFileSync(path.join(SCREENSHOTS_DIR, `debug_${ts}_${sfx}.html`), await page.content(), 'utf-8');
      logger.info(`  Debug: screenshots/debug_${ts}_${sfx}.png + .html (url: ${page.url()})`);
      throw new Error(`input[type=file] not found after 15s — page may have changed. Screenshot saved.`);
    }

    logger.info(`  Upload: ${record.video_path}`);
    if (!fs.existsSync(record.video_path)) throw new Error(`File not found: ${record.video_path}`);
    await page.locator('input[type=file]').first().setInputFiles(record.video_path);
    const uploadResult = await waitForUploadWithProgress(page, record._abortSignal);
    if (uploadResult === 'aborted') {
      result.status = 'failed'; result.error = 'Aborted by user'; return result;
    }
    await page.waitForTimeout(5000);
    if (isLogin(page.url())) { result.status = 'failed'; result.error = 'Login expired during upload'; result._loginExpired = true; return result; }

    if (record.cover_path && record.cover_path.trim()) await setCover(page, record.cover_path.trim());
    await hideLocation(page);
    if (isLogin(page.url())) { result.status = 'failed'; result.error = 'Login expired'; result._loginExpired = true; return result; }

    if (record.title && record.title.trim()) {
      logger.info(`  Title: ${record.title}`);
      await page.getByRole('textbox', { name: /概括视频主要内容/ }).fill(record.title);
    }
    if (record.description) {
      logger.info('  Description');
      const editor = page.locator('.input-editor');
      await editor.click();
      await editor.evaluate(el => { el.textContent = ''; });
      await page.keyboard.type(record.description);
    }
    if (record.short_drama_name) await selectShortDrama(page, record.short_drama_name);

    logger.info('  Clicking 发表...');
    await page.getByRole('button', { name: '发表' }).click();

    if (await verifyPublish(page)) {
      result.status = 'published'; logger.info(`  SUCCESS: ${record.title}`);
    } else {
      if (!fs.existsSync(SCREENSHOTS_DIR)) fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });
      const ss = `${Date.now()}_${(record.title || 'unknown').replace(/[<>:"/\\|?*]/g, '_').slice(0, 50)}.png`;
      await page.screenshot({ path: path.join(SCREENSHOTS_DIR, ss), fullPage: false });
      logger.info(`  Screenshot: ${ss}`);
      result.status = 'uncertain';
      result.error = (await page.textContent('body').catch(() => '')).substring(0, 200);
    }
  } catch (e) {
    result.status = 'failed'; result.error = e.message;
    result._errorType = classifyError(e.message);
    logger.error(`  FAILED: ${e.message}`);
  }
  return result;
}

async function waitUntil(targetTime) {
  const diff = targetTime.getTime() - Date.now();
  if (diff > 0) {
    logger.info(`  Waiting ${Math.round(diff / 1000 / 60)} min...`);
    await new Promise(r => setTimeout(r, diff));
  }
}

function handleLoginExpired() {
  logger.error('LOGIN EXPIRED — run node batch-upload.js --setup');
  notifyUser('视频号上传 - 登录过期', '登录态已过期，请重新扫码登录。');
}

// ── Batch process (used by both CLI and server) ──
async function batchUpload(browserContext, records, options = {}) {
  const { resultsPath = RESULTS_PATH, resume = false, results: existingResults = [], abortSignal, onProgress, onLoginExpired } = options;
  const results = existingResults.slice();
  const publishedSet = loadPublishedTitles(resultsPath, resume);
  let loginExpired = false;

  // Close extra tabs, ensure at least one page exists
  const pages = browserContext.pages();
  for (let i = pages.length - 1; i >= 1; i--) await pages[i].close();
  if (browserContext.pages().length === 0) await browserContext.newPage();

  const total = records.length;
  for (let i = 0; i < records.length; i++) {
    if (abortSignal && abortSignal.abort) {
      logger.warn('Upload aborted by user');
      break;
    }

    const record = records[i];
    record._abortSignal = abortSignal;
    if (record._skip) {
      results.push({ video_path: record.video_path, title: record.title, status: 'skipped', error: record._skipReason });
      if (onProgress) onProgress({ current: i + 1, total, status: 'skipped', title: record.title });
      continue;
    }
    if (publishedSet.has(record.title)) {
      results.push({ video_path: record.video_path, title: record.title, status: 'published', error: '' });
      if (onProgress) onProgress({ current: i + 1, total, status: 'published', title: record.title });
      continue;
    }
    if (loginExpired) {
      results.push({ video_path: record.video_path, title: record.title, status: 'failed', error: 'Login expired' });
      continue;
    }

    const pt = record.publish_time ? new Date(record.publish_time) : null;
    if (pt) await waitUntil(pt);

    let result = null;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        logger.info(`  Retry ${attempt}/${MAX_RETRIES}`);
        await new Promise(r => setTimeout(r, 3000));
      }
      result = await processVideo(browserContext, record);
      if (result.status === 'published' || result._errorType === 'login-expired' || result._errorType === 'title-error') break;
    }

    results.push(result);
    if (result._loginExpired) { loginExpired = true; handleLoginExpired(); if (onLoginExpired) onLoginExpired(record); }
    writeResults(results, resultsPath);
    if (onProgress) onProgress({ current: i + 1, total, status: result.status, title: record.title });
  }
  return results;
}

// ── CLI entry ──
async function main() {
  const args = process.argv.slice(2);
  const isSetup = args.includes('--setup');
  const csvIdx = args.indexOf('--csv');
  const csvPath = csvIdx >= 0 ? path.resolve(args[csvIdx + 1]) : path.join(__dirname, 'batch-config.csv');
  const resume = args.includes('--resume');

  if (fs.existsSync(LOG_PATH)) fs.unlinkSync(LOG_PATH);
  unlockProfile(PROFILE_DIR);

  logger.info('Opening browser...');
  const browserContext = await initBrowser(PROFILE_DIR);

  let shuttingDown = false;
  async function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('Shutting down...');
    try { await browserContext.close(); } catch {}
    process.exit(0);
  }
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  if (isSetup) {
    await loginFlow(browserContext);
    await browserContext.close();
    return;
  }

  let records;
  try {
    records = loadCSV(csvPath);
    logger.info(`Loaded ${records.length} records`);
  } catch (e) {
    logger.error(`CSV: ${e.message}`);
    await browserContext.close(); process.exit(1);
  }

  records = preflightRecords(records);
  const validCount = records.filter(r => !r._skip).length;
  if (validCount === 0) { logger.warn('No valid records'); await browserContext.close(); return; }
  logger.info(`Preflight: ${validCount} valid, ${records.length - validCount} skipped`);

  const results = await batchUpload(browserContext, records, { resume, resultsPath: RESULTS_PATH });

  logger.info(`\nDone. ${results.filter(r => r.status === 'published').length}/${results.length} published`);
  logger.info('Browser left open. Close when done.');
  writeResults(results, RESULTS_PATH);
}

if (require.main === module) {
  main().catch(e => { logger.error(`Fatal: ${e.message}`); process.exit(1); });
}

module.exports = {
  // Constants
  PROFILE_DIR, LOG_PATH, RESULTS_PATH, SCREENSHOTS_DIR, PLATFORM, MAX_RETRIES,
  // Core
  initBrowser, unlockProfile, loginFlow, batchUpload, processVideo, preflightRecords, loadCSV, loadCSVFromString, validateTitle, writeResults, loadPublishedTitles,
  // Helpers
  classifyError, isLogin, waitForUploadWithProgress, selectShortDrama, setCover, hideLocation, verifyPublish,
  waitUntil, handleLoginExpired, probeVideo, logger, notifyUser,
};
