#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
batch_upload.py - 视频号批量上传工具 (Python Playwright 版)
Translated from batch-upload.js
"""

import asyncio
import base64
import csv
import io
import json
import os
import re
import signal
import subprocess
import sys
import time
from datetime import datetime
from shutil import which as shutil_which

from playwright.async_api import async_playwright

__all__ = [
    'PROFILE_DIR', 'LOG_PATH', 'RESULTS_PATH', 'SCREENSHOTS_DIR', 'PLATFORM', 'MAX_RETRIES',
    'init_browser', 'unlock_profile', 'login_flow', 'batch_upload', 'process_video',
    'preflight_records', 'load_csv', 'load_csv_from_string', 'validate_title',
    'write_results', 'load_published_titles',
    'classify_error', 'is_login', 'wait_for_upload_with_progress', 'select_short_drama',
    'set_cover', 'hide_location', 'verify_publish', 'wait_until', 'handle_login_expired',
    'probe_video', 'logger', 'notify_user',
]

# ── Constants ──
_BASE_DIR = os.environ.get('APP_BASE_DIR', os.path.dirname(os.path.abspath(__file__)))
PROFILE_DIR = os.path.join(_BASE_DIR, 'browser-profile')
LOG_PATH = os.path.join(_BASE_DIR, 'upload.log')
SCREENSHOTS_DIR = os.path.join(_BASE_DIR, 'screenshots')
RESULTS_PATH = os.path.join(_BASE_DIR, 'results.csv')
MAX_RETRIES = 2

PLATFORM = {
    'maxFileSize': 20 * 1024 * 1024 * 1024,
    'maxDuration': 8 * 3600,
    'minDuration': 5,
    'allowedCodec': 'h264',
    'maxBitrate': 10 * 1000 * 1000,
    'allowedFormats': ['.mp4'],
    'titleMinLen': 6,
}


# ── Logger ──
class _Logger:
    """Logger that writes to console and upload.log with timestamp."""

    def _write(self, level, msg):
        ts = datetime.now().strftime('%Y/%m/%d %H:%M:%S')
        line = f'[{ts}] [{level}] {msg}'
        print(line)
        try:
            with open(LOG_PATH, 'a', encoding='utf-8') as f:
                f.write(line + '\n')
        except OSError:
            pass

    def info(self, msg):
        self._write('INFO', msg)

    def warn(self, msg):
        self._write('WARN', msg)

    def error(self, msg):
        self._write('ERROR', msg)


logger = _Logger()


# ── Desktop notification ──
def notify_user(title, message):
    """Show a Windows message box notification."""
    try:
        s = message.replace("'", "''").replace('"', '``')
        t = title.replace("'", "''")
        subprocess.run(
            f'powershell -Command "Add-Type -AssemblyName System.Windows.Forms; '
            f'[System.Windows.Forms.MessageBox]::Show(\'{s}\', \'{t}\')"',
            shell=True, timeout=10
        )
    except Exception:
        pass


# ── Internal helpers ──
def _check_abort(abort_signal):
    """Check if abort signal is set, supporting both dict and object-style signals."""
    if abort_signal is None:
        return False
    if isinstance(abort_signal, dict):
        return abort_signal.get('abort', False)
    return bool(getattr(abort_signal, 'abort', False))


def _safe_filename(text, max_len=30):
    """Replace unsafe path characters and truncate."""
    s = str(text) if text is not None else ''
    return re.sub(r'[<>:"/\\|?*]', '_', s)[:max_len]


# ── CSV helpers ──
def csv_escape(val):
    """Escape a value for CSV output."""
    s = str(val) if val is not None else ''
    if ',' in s or '"' in s or '\n' in s:
        return '"' + s.replace('"', '""') + '"'
    return s


def write_results(results, results_path=None):
    """Write results array to CSV with BOM."""
    rp = results_path or RESULTS_PATH
    header = 'video_path,title,status,error'
    rows = [header]
    for r in results:
        rows.append(','.join([
            csv_escape(r.get('video_path', '')),
            csv_escape(r.get('title', '')),
            csv_escape(r.get('status', '')),
            csv_escape(r.get('error', '')),
        ]))
    with open(rp, 'w', encoding='utf-8-sig') as f:
        f.write('\n'.join(rows))


def load_published_titles(results_path, resume):
    """Load previously published titles from results CSV (for --resume)."""
    published = set()
    if not resume or not os.path.exists(results_path):
        return published
    with open(results_path, 'r', encoding='utf-8-sig') as f:
        text = f.read()
    lines = text.split('\n')[1:]  # skip header
    for line in lines:
        if not line.strip():
            continue
        try:
            reader = csv.DictReader(io.StringIO(line), fieldnames=['vp', 't', 'st', 'err'])
            for row in reader:
                if row.get('st') == 'published':
                    published.add(row.get('t', ''))
        except Exception:
            pass
    return published


# ── ffprobe ──
def probe_video(file_path):
    """Use ffprobe to get video metadata."""
    try:
        if not shutil_which('ffprobe'):
            return None
        result = subprocess.run(
            ['ffprobe', '-v', 'quiet', '-print_format', 'json',
             '-show_format', '-show_streams', file_path],
            capture_output=True, text=True, timeout=15
        )
        if not result.stdout:
            return None
        data = json.loads(result.stdout)
        streams = data.get('streams', []) or []
        vs = None
        for s in streams:
            if s.get('codec_type') == 'video':
                vs = s
                break
        fmt = data.get('format', {}) or {}
        return {
            'duration': float(fmt.get('duration', 0)),
            'size': int(fmt.get('size', 0)),
            'codec': vs.get('codec_name', 'unknown') if vs else 'unknown',
            'bitrate': int(fmt.get('bit_rate', 0)),
            'width': vs.get('width', 0) if vs else 0,
            'height': vs.get('height', 0) if vs else 0,
        }
    except Exception as e:
        logger.warn(f'  ffprobe failed for {os.path.basename(file_path)}: {e}')
        return None


# ── Validation ──
def load_csv(csv_path):
    """Load and parse a CSV file, return list of dicts."""
    if not os.path.exists(csv_path):
        raise Exception(f'CSV not found: {csv_path}')
    with open(csv_path, 'r', encoding='utf-8-sig') as f:
        reader = csv.DictReader(f, skipinitialspace=True)
        return [row for row in reader]


def load_csv_from_string(csv_content):
    """Parse CSV from a string, return list of dicts."""
    reader = csv.DictReader(io.StringIO(csv_content), skipinitialspace=True)
    return [row for row in reader]


def validate_title(title):
    """Validate title: allowed chars and minimum length."""
    if not title:
        return None  # optional field
    allowed_basic = set(
        'abcdefghijklmnopqrstuvwxyz'
        'ABCDEFGHIJKLMNOPQRSTUVWXYZ'
        '0123456789 《》（）《》“”‘’：+？%℃ '
    )
    for ch in title:
        if ch not in allowed_basic and not ('一' <= ch <= '鿿'):
            return f'Unsupported char "{ch}"'
    if len(title) < 6:
        return f'Title too short ({len(title)}), min 6'
    return None


def preflight_records(records):
    """Run pre-flight checks on all records, mark invalid ones with _skip."""
    for r in records:
        errs = []

        video_path_val = r.get('video_path') or ''
        vp = video_path_val.strip()
        if not vp:
            errs.append('Missing video_path')
        else:
            if not os.path.exists(vp):
                errs.append(f'File not found: {vp}')
            else:
                stat = os.stat(vp)
                if stat.st_size > PLATFORM['maxFileSize']:
                    size_gb = stat.st_size / 1024 / 1024 / 1024
                    errs.append(f'File too large ({size_gb:.1f} GB)')
                ext = os.path.splitext(vp)[1].lower()
                if ext not in PLATFORM['allowedFormats']:
                    logger.warn(f'  [Preflight] {r.get("title", "")}: format {ext} not recommended')
                info = probe_video(vp)
                if info:
                    if info['duration'] > PLATFORM['maxDuration']:
                        hours = info['duration'] / 3600
                        errs.append(f'Video too long ({hours:.1f}h)')
                    if info['codec'] != PLATFORM['allowedCodec'] and info['codec'] != 'unknown':
                        logger.warn(f'  [Preflight] {r.get("title", "")}: codec {info["codec"]}')
                    if info['bitrate'] > PLATFORM['maxBitrate']:
                        mbps = info['bitrate'] / 1000 / 1000
                        logger.warn(f'  [Preflight] {r.get("title", "")}: bitrate {mbps:.1f} Mbps')

        title_val = r.get('title') or ''
        if title_val.strip():
            ve = validate_title(title_val.strip())
            if ve:
                errs.append(ve)

        if errs:
            r['_skip'] = True
            r['_skipReason'] = '; '.join(errs)
    return records


# ── Error classification ──
def classify_error(msg):
    """Classify error message into error type for retry/abort decisions."""
    if not msg:
        return 'fatal'
    login_keywords = ['login', 'Login', 'Not logged in', '登录']
    for k in login_keywords:
        if k in msg:
            return 'login-expired'
    title_keywords = ['title', 'Title']
    for k in title_keywords:
        if k in msg:
            return 'title-error'
    retry_keywords = [
        'timeout', 'Timeout', 'net::ERR_', 'ETIMEDOUT',
        'ECONNRESET', 'NS_ERROR_', 'CONNECTION', 'INTERNET_',
    ]
    for k in retry_keywords:
        if k in msg:
            return 'retryable'
    return 'fatal'


def is_login(url):
    """Check if URL indicates a login page."""
    return 'login' in url


# ── Browser helpers ──
async def init_browser(profile_dir, headless=True):
    """Launch a persistent Chromium browser context with the given profile."""
    _pw_path = os.environ.get('PLAYWRIGHT_BROWSERS_PATH', '')
    if _pw_path and os.path.isdir(_pw_path):
        os.environ.setdefault('PLAYWRIGHT_BROWSERS_PATH', _pw_path)
    p = await async_playwright().start()
    args = []
    if headless:
        args.append('--headless=new')
    context = await p.chromium.launch_persistent_context(
        profile_dir,
        headless=False,
        args=args,
        viewport={'width': 1440, 'height': 900},
        locale='zh-CN'
    )
    return context


async def unlock_profile(profile_dir):
    """Remove Chrome profile lock file if present."""
    lock_file = os.path.join(profile_dir, 'SingletonLock')
    if os.path.exists(lock_file):
        logger.warn('Profile locked — removing lock file...')
        try:
            os.unlink(lock_file)
            logger.info('Profile unlocked')
        except OSError:
            logger.warn('Could not remove lock file')


async def login_flow(browser_context):
    """Open login page, wait for user to scan QR code and press Enter."""
    page = browser_context.pages[0]
    await page.goto('https://channels.weixin.qq.com/', wait_until='domcontentloaded')
    logger.info('=== Scan QR code to login, then press Enter ===')
    loop = asyncio.get_event_loop()
    try:
        await asyncio.wait_for(
            loop.run_in_executor(None, sys.stdin.readline),
            timeout=300
        )
    except asyncio.TimeoutError:
        pass
    logger.info('Login saved')


# ── Upload helpers ──
async def wait_for_upload_with_progress(page, abort_signal):
    """Wait for video upload to complete by detecting page changes.
    先检测上传是否已启动（页面出现进度/文件名等变化），再等上传完成。
    不依赖 networkidle，因为页面背景流量会干扰检测。"""
    start_time = time.time()

    # 通用上传进度/完成选择器
    progress_selectors = [
        'progress', '[class*="progress"]', '[class*="upload"]',
        '[class*="loading"]', '.ant-slider', '.weui-desktop-progress',
        '[class*="percent"]',
        'text=/上传中|uploading|\\d+%/i',
    ]
    done_selectors = [
        'video', 'video[src]', '[class*="preview"] video',
        '[class*="success"]', '[class*="done"]',
        'text=/上传成功|upload.*complete|success/i',
    ]

    upload_started = False

    while time.time() - start_time < 900:
        if _check_abort(abort_signal):
            logger.warn('  Upload aborted by user')
            return 'aborted'

        # 检测上传是否在进行中
        if not upload_started:
            for sel in progress_selectors:
                try:
                    if await page.locator(sel).count() > 0:
                        upload_started = True
                        break
                except Exception:
                    pass

        # 检测上传是否已完成
        for sel in done_selectors:
            try:
                if await page.locator(sel).count() > 0:
                    if upload_started:
                        elapsed = round(time.time() - start_time)
                        logger.info(f'  Upload complete ({elapsed}s)')
                        return 'ok'
            except Exception:
                pass

        elapsed = round(time.time() - start_time)
        if elapsed % 30 == 0:
            tag = 'Uploading' if upload_started else 'Waiting for upload'
            logger.info(f'  {tag}... {elapsed}s')

        await page.wait_for_timeout(5000)

    if upload_started:
        logger.warn('  Upload timeout (900s)')
        return 'timeout'
    logger.warn('  Upload never started')
    return 'not_started'
    return 'timeout'


async def select_short_drama(page, drama_name):
    """Select a short drama series from the link selector."""
    logger.info(f'  Selecting drama: {drama_name}')
    try:
        base = (
            page.locator('.link-selector').get_by_text('选择链接')
            .or_(page.get_by_text('选择链接', exact=True))
        )
        await base.first.click()
        await page.get_by_text('视频号剧集', exact=True).wait_for(state='visible', timeout=5000)
        await page.get_by_text('视频号剧集', exact=True).click()
        await page.get_by_text('选择需要添加的视频号剧集').wait_for(state='visible', timeout=5000)
        await page.get_by_text('选择需要添加的视频号剧集').click()
        sb = page.get_by_role('textbox', name='搜索内容')
        await sb.wait_for(state='visible', timeout=5000)
        await sb.fill(drama_name)
        await page.keyboard.press('Enter')
        await page.wait_for_timeout(1000)
        for loc in [
            page.locator('table tbody tr').first,
            page.get_by_role('row').nth(1),
        ]:
            try:
                if await loc.count() > 0:
                    await loc.click(timeout=3000)
                    logger.info(f'  Selected drama: {drama_name}')
                    return
            except Exception:
                pass
        logger.warn(f'  Drama "{drama_name}" not found')
        await page.keyboard.press('Escape')
    except Exception as e:
        logger.warn(f'  Drama failed: {e}')


async def set_cover(page, cover_path):
    """Upload a custom cover image for the video."""
    logger.info('  Setting cover')
    if not os.path.exists(cover_path):
        logger.warn(f'  Cover not found: {cover_path}')
        return
    try:
        await page.get_by_text('编辑', exact=True).click(force=True)
        await page.get_by_role('heading', name='编辑封面').wait_for(state='visible', timeout=5000)
        await page.get_by_text('上传封面', exact=True).click()
        await page.locator('input[type=file]').nth(1).set_input_files(cover_path)
        await page.wait_for_timeout(2000)
        await page.get_by_role('button', name='确认').click()
        logger.info('  Cover set')
    except Exception as e:
        logger.warn(f'  Cover failed: {e}')


async def hide_location(page):
    """Hide location display for the video post."""
    logger.info('  Hiding location')
    try:
        try:
            if await page.get_by_text('不显示位置').first.is_visible():
                return
        except Exception:
            pass
        await page.locator('.location-name').first.click()
        await page.wait_for_timeout(300)
        await page.get_by_text('不显示位置', exact=True).click()
    except Exception as e:
        logger.warn(f'  Location failed: {e}')


async def verify_publish(page):
    """Verify that the video was published successfully."""
    await page.wait_for_timeout(2000)
    try:
        await page.wait_for_url(lambda url: '/post/create' not in url, timeout=15000)
        return True
    except Exception:
        pass
    try:
        await page.wait_for_selector('text=/已发表|发表成功|success/i', timeout=8000)
        return True
    except Exception:
        pass
    try:
        await page.wait_for_selector('[class*="success"]', timeout=5000)
        return True
    except Exception:
        pass
    return False


# ── Main upload logic ──
async def process_video(browser_context, record):
    """Process a single video record: upload, fill metadata, and publish."""
    pages = [p for p in browser_context.pages if not p.is_closed()]
    page = pages[0] if pages else None
    if not page:
        logger.warn('  No live page, creating new page...')
        page = await browser_context.new_page()

    result = {
        'video_path': record.get('video_path', ''),
        'title': record.get('title', ''),
        'status': 'unknown',
        'error': '',
        '_errorType': 'fatal',
        '_loginExpired': False,
    }

    try:
        logger.info(f'\n=== {record.get("title", "")} ===')
        # 先导航到平台首页，再通过导航进入发表页面
        await page.goto('https://channels.weixin.qq.com/platform',
                        wait_until='domcontentloaded', timeout=30000)
        await page.wait_for_timeout(5000)
        if is_login(page.url):
            result['status'] = 'failed'
            result['error'] = 'Not logged in'
            result['_loginExpired'] = True
            return result

        # Try direct URL first (might work if URL structure unchanged)
        # If it redirects, go through the navigation flow
        if '/post/create' not in page.url:
            logger.info('  Looking for upload entry via navigation...')
            # 尝试通过侧边栏导航到发表页面
            # Flow: 内容管理 → 发表视频
            nav_steps = [
                # Step 1: 找 "内容管理" 或 "发表视频" 菜单
                {'action': 'click', 'selector': page.get_by_text('内容管理', exact=True),
                 'desc': '内容管理'},
                {'action': 'click', 'selector': page.get_by_text(
                    re.compile(r'内容管理|发表视频|视频管理')),
                 'desc': '内容/发表/视频管理 (模糊)'},
                {'action': 'click', 'selector': page.get_by_text('发表视频', exact=True),
                 'desc': '发表视频'},
                # Direct buttons on dashboard
                {'action': 'click', 'selector': page.get_by_role(
                    'button', name=re.compile(r'发布视频|发表视频|上传视频|创作')),
                 'desc': '发布/发表/上传/创作按钮'},
            ]

            for step in nav_steps:
                try:
                    el = step['selector'].first
                    if await el.count() > 0:
                        await el.click(timeout=3000)
                        logger.info(f'  Clicked: {step["desc"]}')
                        await page.wait_for_timeout(3000)
                except Exception:
                    pass

            # Check if we've landed on a page with file input
            if await page.locator('input[type=file]').count() == 0:
                # Try navigating to old URL as fallback
                logger.info('  Trying legacy URL /platform/post/create...')
                await page.goto('https://channels.weixin.qq.com/platform/post/create',
                                wait_until='domcontentloaded', timeout=15000)
                await page.wait_for_timeout(3000)

        # 等待上传区域出现
        file_input = page.locator('input[type=file]').first
        try:
            await file_input.wait_for(state='attached', timeout=15000)
        except Exception:
            # 保存截图 + HTML 用于调试
            if not os.path.exists(SCREENSHOTS_DIR):
                os.makedirs(SCREENSHOTS_DIR, exist_ok=True)
            ts = int(time.time() * 1000)
            sfx = _safe_filename(record.get('title', '') or 'unknown', 30)
            await page.screenshot(
                path=os.path.join(SCREENSHOTS_DIR, f'debug_{ts}_{sfx}.png'),
                full_page=True
            )
            with open(os.path.join(SCREENSHOTS_DIR, f'debug_{ts}_{sfx}.html'),
                      'w', encoding='utf-8') as f:
                f.write(await page.content())
            logger.info(f'  Debug: screenshots/debug_{ts}_{sfx}.png + .html (url: {page.url})')
            raise Exception(
                'input[type=file] not found after 15s — '
                'page may have changed. Screenshot saved.'
            )

        logger.info(f'  Upload: {record.get("video_path", "")}')
        video_path = record.get('video_path', '')
        if not os.path.exists(video_path):
            raise Exception(f'File not found: {video_path}')
        await page.locator('input[type=file]').first.set_input_files(video_path)
        upload_result = await wait_for_upload_with_progress(page, record.get('_abortSignal'))
        if upload_result == 'aborted':
            result['status'] = 'failed'
            result['error'] = 'Aborted by user'
            return result
        if upload_result in ('timeout', 'not_started'):
            result['status'] = 'failed'
            result['error'] = 'Upload timed out' if upload_result == 'timeout' else 'Upload never started'
            result['_errorType'] = 'upload-failed'
            return result
        await page.wait_for_timeout(5000)
        if is_login(page.url):
            result['status'] = 'failed'
            result['error'] = 'Login expired during upload'
            result['_loginExpired'] = True
            return result

        cover_path = record.get('cover_path', '').strip() if record.get('cover_path') else ''
        if cover_path:
            await set_cover(page, cover_path)
        await hide_location(page)
        if is_login(page.url):
            result['status'] = 'failed'
            result['error'] = 'Login expired'
            result['_loginExpired'] = True
            return result

        title_val = record.get('title', '').strip() if record.get('title') else ''
        if title_val:
            logger.info(f'  Title: {title_val}')
            await page.get_by_role('textbox',
                                   name=re.compile(r'概括视频主要内容')).fill(title_val)

        desc = record.get('description', '')
        if desc:
            logger.info('  Description')
            editor = page.locator('.input-editor')
            await editor.click()
            await editor.evaluate('el => { el.textContent = ""; }')
            await page.keyboard.type(desc)

        drama_name = record.get('short_drama_name', '')
        if drama_name:
            await select_short_drama(page, drama_name)

        logger.info('  Clicking 发表...')
        await page.get_by_role('button', name='发表').click()

        if await verify_publish(page):
            result['status'] = 'published'
            logger.info(f'  SUCCESS: {record.get("title", "")}')
        else:
            if not os.path.exists(SCREENSHOTS_DIR):
                os.makedirs(SCREENSHOTS_DIR, exist_ok=True)
            ss = f'{int(time.time() * 1000)}_{_safe_filename(record.get("title", "") or "unknown", 50)}.png'
            await page.screenshot(path=os.path.join(SCREENSHOTS_DIR, ss), full_page=False)
            logger.info(f'  Screenshot: {ss}')
            result['status'] = 'uncertain'
            try:
                body_text = await page.locator('body').text_content()
                result['error'] = (body_text or '')[:200]
            except Exception:
                result['error'] = ''

    except Exception as e:
        result['status'] = 'failed'
        result['error'] = str(e)
        result['_errorType'] = classify_error(str(e))
        logger.error(f'  FAILED: {e}')

    return result


async def wait_until(target_time):
    """Wait until a specific datetime."""
    now = datetime.now()
    diff = (target_time - now).total_seconds()
    if diff > 0:
        logger.info(f'  Waiting {round(diff / 60)} min...')
        await asyncio.sleep(diff)


def handle_login_expired():
    """Log and notify user that login has expired."""
    logger.error('LOGIN EXPIRED — run python batch_upload.py --setup')
    notify_user('视频号上传 - 登录过期', '登录态已过期，请重新扫码登录。')


# ── Batch process (used by both CLI and server) ──
async def batch_upload(browser_context, records, options=None):
    """Process multiple video records sequentially, with retry and resume support."""
    if options is None:
        options = {}
    results_path = options.get('resultsPath', RESULTS_PATH)
    resume = options.get('resume', False)
    existing_results = options.get('results', [])
    abort_signal = options.get('abortSignal')
    on_progress = options.get('onProgress')
    on_login_expired = options.get('onLoginExpired')

    results = list(existing_results)
    published_set = load_published_titles(results_path, resume)
    login_expired_flag = False

    # Close extra tabs, ensure at least one LIVE page exists
    pages = browser_context.pages
    for i in range(len(pages) - 1, 0, -1):
        await pages[i].close()
    # 过滤掉已关闭的页面
    live = [p for p in browser_context.pages if not p.is_closed()]
    if not live:
        await browser_context.new_page()

    total = len(records)
    for i, record in enumerate(records):
        if _check_abort(abort_signal):
            logger.warn('Upload aborted by user')
            break

        record['_abortSignal'] = abort_signal
        if record.get('_skip'):
            results.append({
                'video_path': record.get('video_path', ''),
                'title': record.get('title', ''),
                'status': 'skipped',
                'error': record.get('_skipReason', ''),
            })
            if on_progress:
                on_progress({'current': i + 1, 'total': total,
                             'status': 'skipped', 'title': record.get('title', '')})
            continue

        if record.get('title', '') in published_set:
            results.append({
                'video_path': record.get('video_path', ''),
                'title': record.get('title', ''),
                'status': 'published',
                'error': '',
            })
            if on_progress:
                on_progress({'current': i + 1, 'total': total,
                             'status': 'published', 'title': record.get('title', '')})
            continue

        if login_expired_flag:
            results.append({
                'video_path': record.get('video_path', ''),
                'title': record.get('title', ''),
                'status': 'failed',
                'error': 'Login expired',
            })
            continue

        # Wait for scheduled publish time if specified
        pt = None
        publish_time = record.get('publish_time', '')
        if publish_time:
            try:
                pt = datetime.fromisoformat(publish_time)
            except Exception:
                pass
        if pt:
            await wait_until(pt)

        result = None
        for attempt in range(MAX_RETRIES + 1):
            if attempt > 0:
                logger.info(f'  Retry {attempt}/{MAX_RETRIES}')
                await asyncio.sleep(3)
            result = await process_video(browser_context, record)
            if result['status'] == 'published' or result.get('_errorType') in (
                    'login-expired', 'title-error', 'upload-failed'):
                break

        results.append(result)
        if result.get('_loginExpired'):
            login_expired_flag = True
            handle_login_expired()
            if on_login_expired:
                on_login_expired(record)
        write_results(results, results_path)
        if on_progress:
            on_progress({'current': i + 1, 'total': total,
                         'status': result['status'], 'title': record.get('title', '')})

    return results


# ── CLI entry ──
async def main():
    """CLI entry point for batch upload."""
    args = sys.argv[1:]
    is_setup = '--setup' in args
    csv_idx = args.index('--csv') if '--csv' in args else -1
    if csv_idx >= 0:
        csv_path = os.path.abspath(args[csv_idx + 1])
    else:
        csv_path = os.path.join(_BASE_DIR, 'batch-config.csv')
    resume = '--resume' in args

    if os.path.exists(LOG_PATH):
        os.unlink(LOG_PATH)
    unlock_profile(PROFILE_DIR)

    logger.info('Opening browser...')
    browser_context = await init_browser(PROFILE_DIR)

    # Register SIGTERM handler (best-effort on Windows)
    try:
        signal.signal(signal.SIGTERM, lambda sig, frame: os._exit(0))
    except (ValueError, AttributeError):
        pass

    try:
        if is_setup:
            await login_flow(browser_context)
            await browser_context.close()
            return

        records = None
        try:
            records = load_csv(csv_path)
            logger.info(f'Loaded {len(records)} records')
        except Exception as e:
            logger.error(f'CSV: {e}')
            await browser_context.close()
            sys.exit(1)

        records = preflight_records(records)
        valid_count = len([r for r in records if not r.get('_skip')])
        if valid_count == 0:
            logger.warn('No valid records')
            await browser_context.close()
            return
        logger.info(f'Preflight: {valid_count} valid, {len(records) - valid_count} skipped')

        results = await batch_upload(browser_context, records, {
            'resume': resume,
            'resultsPath': RESULTS_PATH,
        })

        published_count = len([r for r in results if r.get('status') == 'published'])
        logger.info(f'\nDone. {published_count}/{len(results)} published')
        logger.info('Browser left open. Close when done.')
        write_results(results, RESULTS_PATH)

    except (KeyboardInterrupt, asyncio.CancelledError):
        logger.info('Shutting down...')
        try:
            await browser_context.close()
        except Exception:
            pass
        sys.exit(0)


if __name__ == '__main__':
    try:
        asyncio.run(main())
    except (KeyboardInterrupt, SystemExit):
        pass
