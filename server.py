#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
server.py - 视频号批量上传工具 Web 服务器 (Flask + Flask-SocketIO)
Translated from server.js
"""

import asyncio
import json
import os
import random
import re
import string
import sys
import threading
import time
from datetime import datetime, timezone

from flask import Flask, jsonify, request, send_from_directory
from flask_socketio import SocketIO, emit

from accounts import (
    loadAccounts,
    getAccount,
    createAccount,
    deleteAccount,
    updateAccount,
    updateAccountStatus,
)
from batch_upload import (
    init_browser,
    unlock_profile,
    batch_upload,
    preflight_records,
    load_csv_from_string,
    is_login,
    logger as batch_logger,
    LOG_PATH,
    RESULTS_PATH,
    SCREENSHOTS_DIR,
)

BASE_DIR = os.environ.get('APP_BASE_DIR', os.path.dirname(os.path.abspath(__file__)))
RES_DIR = os.environ.get('APP_RES_DIR', BASE_DIR)

app = Flask(__name__, static_folder=os.path.join(RES_DIR, 'public'), static_url_path='')
app.config['MAX_CONTENT_LENGTH'] = 200 * 1024 * 1024  # 200MB
socketio = SocketIO(app, cors_allowed_origins='*', async_mode='threading')

PORT = int(os.environ.get('PORT', 3123))
UPLOADS_DIR = os.path.join(BASE_DIR, 'uploads')
LAST_BATCH_PATH = os.path.join(BASE_DIR, 'last-batch.csv')

os.makedirs(UPLOADS_DIR, exist_ok=True)

# ── State ──
active_contexts = {}  # {name: browser_context}
upload_state = {'running': False, 'abort': False}

# ── Socket.IO broadcast ──


def broadcast(msg):
    """Send a message to all connected Socket.IO clients."""
    try:
        socketio.emit('message', msg, namespace='/')
    except Exception:
        pass


# Override logger to broadcast via WebSocket
_orig_info = batch_logger.info
_orig_warn = batch_logger.warn
_orig_error = batch_logger.error


def _broadcast_info(msg):
    _orig_info(msg)
    broadcast({
        'type': 'log',
        'level': 'INFO',
        'msg': msg,
        'ts': datetime.now(timezone.utc).isoformat()
    })


def _broadcast_warn(msg):
    _orig_warn(msg)
    broadcast({
        'type': 'log',
        'level': 'WARN',
        'msg': msg,
        'ts': datetime.now(timezone.utc).isoformat()
    })


def _broadcast_error(msg):
    _orig_error(msg)
    broadcast({
        'type': 'log',
        'level': 'ERROR',
        'msg': msg,
        'ts': datetime.now(timezone.utc).isoformat()
    })


batch_logger.info = _broadcast_info
batch_logger.warn = _broadcast_warn
batch_logger.error = _broadcast_error

logger = batch_logger

# ── Auto-shutdown when no clients connected ──

connected_clients = set()
shutdown_timer = None
SHUTDOWN_DELAY = 30  # seconds


@socketio.on('connect')
def on_connect():
    connected_clients.add(request.sid)
    global shutdown_timer
    if shutdown_timer is not None:
        shutdown_timer.cancel()
        shutdown_timer = None
    logger.info(f'Client connected ({len(connected_clients)} total)')


@socketio.on('disconnect')
def on_disconnect():
    connected_clients.discard(request.sid)
    global shutdown_timer
    if len(connected_clients) == 0:

        def _do_shutdown():
            if len(connected_clients) == 0:
                upload_state['abort'] = True
                logger.info('No clients connected, shutting down...')
                cleanup()
                os._exit(0)

        shutdown_timer = threading.Timer(SHUTDOWN_DELAY, _do_shutdown)
        shutdown_timer.daemon = True
        shutdown_timer.start()
    logger.info(f'Client disconnected ({len(connected_clients)} total)')


# ── Helper: run async coroutine ──


def run_async_sync(coro):
    """Run an async coroutine synchronously (blocks current thread)."""
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(coro)
    finally:
        loop.close()


def run_async_thread(coro):
    """Run an async coroutine in a background daemon thread (non-blocking)."""
    def _run():
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        try:
            loop.run_until_complete(coro)
        except Exception as e:
            logger.error(f'Background task error: {e}')
        finally:
            loop.close()

    t = threading.Thread(target=_run, daemon=True)
    t.start()
    return t


# ── Cleanup ──


def cleanup():
    """Close all active browser contexts."""
    for name in list(active_contexts.keys()):
        ctx = active_contexts.pop(name, None)
        if ctx is not None:
            loop = asyncio.new_event_loop()
            asyncio.set_event_loop(loop)
            try:
                loop.run_until_complete(ctx.close())
            except Exception:
                pass
            finally:
                loop.close()


# ══════════════════════════════════════════════
# API Routes
# ══════════════════════════════════════════════

# ── Accounts ──


@app.route('/api/accounts', methods=['GET'])
def api_get_accounts():
    return jsonify(loadAccounts())


@app.route('/api/accounts', methods=['POST'])
def api_create_account():
    try:
        data = request.get_json(force=True)
        label = data.get('label', '')
        if not label:
            return jsonify({'error': 'label required'}), 400
        # Auto-generate English name
        accounts = loadAccounts()
        existing_ids = set()
        for a in accounts:
            m = re.match(r'^account(\d+)$', a['name'])
            if m:
                existing_ids.add(int(m.group(1)))
        n = 1
        while n in existing_ids:
            n += 1
        name = f'account{n}' if n > 1 else 'account1'
        acct = createAccount(name, label)
        return jsonify(acct)
    except Exception as e:
        return jsonify({'error': str(e)}), 400


@app.route('/api/accounts/<name>', methods=['PATCH'])
def api_update_account(name):
    try:
        data = request.get_json(force=True)
        acct = updateAccount(name, data)
        return jsonify(acct)
    except Exception as e:
        return jsonify({'error': str(e)}), 400


@app.route('/api/accounts/<name>', methods=['DELETE'])
def api_delete_account(name):
    try:
        acct = deleteAccount(name)
        # Close context if open
        ctx = active_contexts.pop(name, None)
        if ctx is not None:
            run_async_sync(ctx.close())
        return jsonify(acct)
    except Exception as e:
        return jsonify({'error': str(e)}), 400


# ── Login: launch native browser window for QR scan ──


@app.route('/api/accounts/<name>/login', methods=['POST'])
def api_login(name):
    """Launch a visible Chrome window for WeChat QR login.
    Polls page URL every 2s; closes window and updates status on success."""
    try:
        acct = getAccount(name)
        if acct is None:
            return jsonify({'error': 'Account not found'}), 404

        # Close any existing context for this account
        existing = active_contexts.pop(name, None)
        if existing is not None:
            run_async_sync(existing.close())

        run_async_thread(_login_async(name, acct))
        return jsonify({'message': 'login started'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


async def _login_async(name, acct):
    """Launch browser, wait for QR scan completion, then close."""
    await unlock_profile(acct['profileDir'])
    ctx = await init_browser(acct['profileDir'], headless=False)

    if len(ctx.pages) == 0:
        await ctx.close()
        logger.error(f'Login browser failed to start for {acct["label"]}')
        return

    active_contexts[name] = ctx
    page = ctx.pages[0]

    try:
        await page.goto('https://channels.weixin.qq.com/login.html',
                        wait_until='domcontentloaded', timeout=15000)
        # 等待页面稳定，client-side redirect 可能在 DOMContentLoaded 之后才触发
        await page.wait_for_timeout(3000)

        logger.info(f'Login window opened for {acct["label"]} (url: {page.url})')

        # 检查是否已经处于登录状态（不在 login 页面则已登录，只检查主页面）
        login_done = not is_login(page.url)
        if login_done:
            logger.info(f'Already logged in for {acct["label"]} (url: {page.url})')

        # Poll URL every 2s until login completes or expires or 5min timeout
        deadline = time.time() + 300

        while time.time() < deadline and not login_done:
            await asyncio.sleep(2)

            if not is_login(page.url):
                login_done = True
                break

            # Check for QR expiration on page
            try:
                body_text = await page.text_content('body') or ''
                expired_texts = ['过期', 'expired', '已失效', '重新获取']
                if any(t in body_text for t in expired_texts):
                    logger.info(f'QR code expired for {acct["label"]}')
                    broadcast({
                        'type': 'login-result',
                        'account': name,
                        'result': 'expired'
                    })
                    return
            except Exception:
                pass

            # Check for scanned state
            try:
                body_text = await page.text_content('body') or ''
                if '已扫码' in body_text or '扫描成功' in body_text or '确认登录' in body_text:
                    logger.info(f'QR scanned for {acct["label"]}')
            except Exception:
                pass

        if login_done:
            updateAccountStatus(name, 'ready')
            logger.info(f'Login complete for {acct["label"]}')
            broadcast({
                'type': 'account-updated',
                'account': name,
                'status': 'ready'
            })
        else:
            logger.warn(f'Login timeout for {acct["label"]}')
            broadcast({
                'type': 'login-result',
                'account': name,
                'result': 'timeout'
            })

    except Exception as e:
        logger.error(f'Login error for {acct["label"]}: {e}')
        broadcast({
            'type': 'login-result',
            'account': name,
            'result': 'error',
            'error': str(e)
        })
    finally:
        try:
            await ctx.close()
        except Exception:
            pass
        if active_contexts.get(name) is ctx:
            active_contexts.pop(name, None)


# ── Verify login status ──


@app.route('/api/accounts/<name>/verify', methods=['POST'])
def api_verify(name):
    try:
        acct = getAccount(name)
        if acct is None:
            return jsonify({'error': 'Account not found'}), 404

        result = run_async_sync(_verify_async(name, acct))
        return jsonify(result)
    except Exception as e:
        return jsonify({'error': str(e)}), 500


async def _verify_async(name, acct):
    """Verify login status by navigating to post/create page.
    等待页面稳定，客户端重定向可能在 DOMContentLoaded 之后才触发
    """
    # Close any existing context to free profile lock
    existing = active_contexts.pop(name, None)
    if existing is not None:
        try:
            await existing.close()
        except Exception:
            pass

    await unlock_profile(acct['profileDir'])
    ctx = await init_browser(acct['profileDir'], headless=True)
    try:
        if len(ctx.pages) == 0:
            await ctx.close()
            raise Exception('浏览器启动失败，profile 可能被占用')

        page = ctx.pages[0]
        await page.goto('https://channels.weixin.qq.com/platform/post/create',
                        wait_until='domcontentloaded', timeout=15000)
        # 等待页面稳定，客户端重定向可能在 DOMContentLoaded 之后才触发
        await page.wait_for_timeout(5000)
        current_url = page.url
        expired = is_login(current_url)
        if expired:
            updateAccountStatus(name, 'needs-login')
            logger.info(f'Account {acct["label"]}: login expired')
        else:
            updateAccountStatus(name, 'ready')
            logger.info(
                f'Account {acct["label"]}: login valid (url: {current_url})')

        return {'name': name, 'valid': not expired}
    finally:
        try:
            await ctx.close()
        except Exception:
            pass


# ── Close browser for an account ──


@app.route('/api/accounts/<name>/close', methods=['POST'])
def api_close(name):
    try:
        ctx = active_contexts.pop(name, None)
        if ctx is not None:
            run_async_sync(ctx.close())
        return jsonify({'message': 'Browser closed'})
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── Upload ──


def _upload_background(account_name, csv_content):
    """Background task: run the upload process and broadcast progress."""
    upload_state['running'] = True
    upload_state['abort'] = False

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        loop.run_until_complete(_upload_async(account_name, csv_content))
    except Exception as e:
        logger.error(f'Upload error: {e}')
        broadcast({'type': 'upload-end', 'success': False, 'error': str(e)})
    finally:
        upload_state['running'] = False
        loop.close()


async def _upload_async(account_name, csv_content):
    """Async upload process."""
    acct = getAccount(account_name)
    if acct is None:
        logger.error(f'Account not found: {account_name}')
        broadcast({
            'type': 'upload-end',
            'success': False,
            'error': 'Account not found'
        })
        return

    ctx = active_contexts.get(account_name)
    if ctx is None:
        await unlock_profile(acct['profileDir'])
        ctx = await init_browser(acct['profileDir'])
        active_contexts[account_name] = ctx

    if len(ctx.pages) == 0:
        logger.error(
            'Browser launched but no page created — '
            'profile may be locked or Chrome crashed'
        )
        broadcast({
            'type': 'upload-end',
            'success': False,
            'error': '浏览器启动失败，请检查是否有其他 Chrome 实例占用同一账号，或重启电脑后重试',
        })
        return

    # Parse CSV
    try:
        records = load_csv_from_string(csv_content)
    except Exception as e:
        logger.error(f'CSV parse error: {e}')
        broadcast({
            'type': 'upload-end',
            'success': False,
            'error': str(e),
        })
        return

    records = preflight_records(records)
    valid_count = len([r for r in records if not r.get('_skip')])
    if valid_count == 0:
        logger.warn('No valid records')
        broadcast({
            'type': 'upload-end',
            'success': False,
            'error': 'No valid records',
        })
        return

    logger.info(
        f'Preflight: {valid_count} valid, {len(records) - valid_count} skipped')

    def on_progress(p):
        broadcast({
            'type': 'progress',
            'current': p['current'],
            'total': p['total'],
            'status': p['status'],
            'title': p['title'],
        })

    def on_login_expired(record):
        updateAccountStatus(account_name, 'needs-login')
        broadcast({
            'type': 'login-expired',
            'account': account_name,
            'title': record.get('title', ''),
        })

    results = await batch_upload(ctx, records, {
        'resume': False,
        'abortSignal': upload_state,
        'onProgress': on_progress,
        'onLoginExpired': on_login_expired,
    })

    login_expired = any(r.get('_loginExpired') for r in results)
    published_count = len([r for r in results if r.get('status') == 'published'])
    broadcast({
        'type': 'upload-end',
        'success': True,
        'results': published_count,
        'total': len(results),
        'loginExpired': login_expired,
    })
    logger.info(f'Upload complete: {published_count}/{len(results)}')

    # Cleanup old temp files (>36 hours), keep recent ones for "恢复上次"
    try:
        now_ms = time.time() * 1000
        for f in os.listdir(UPLOADS_DIR):
            fp = os.path.join(UPLOADS_DIR, f)
            try:
                if now_ms - os.path.getmtime(fp) > 36 * 3600000:
                    os.unlink(fp)
            except Exception:
                pass
    except Exception:
        pass


@app.route('/api/upload/start', methods=['POST'])
def api_upload_start():
    if upload_state['running']:
        return jsonify({'error': 'Upload already running'}), 400

    data = request.get_json(force=True)
    account_name = data.get('account', '')
    csv_content = data.get('csv', '')

    if not account_name:
        return jsonify({'error': 'account required'}), 400
    if not csv_content:
        return jsonify({'error': 'csv content required'}), 400

    acct = getAccount(account_name)
    if acct is None:
        return jsonify({'error': 'Account not found'}), 404

    # Save for crash recovery
    with open(LAST_BATCH_PATH, 'w', encoding='utf-8') as f:
        f.write(csv_content)

    # Start background upload thread
    t = threading.Thread(
        target=_upload_background,
        args=(account_name, csv_content),
        daemon=True,
    )
    t.start()

    return jsonify({'message': 'Upload started'})


@app.route('/api/upload/stop', methods=['POST'])
def api_upload_stop():
    upload_state['abort'] = True
    return jsonify({'message': 'Stopping after current video'})


@app.route('/api/upload/last-csv', methods=['GET'])
def api_upload_last_csv():
    try:
        with open(LAST_BATCH_PATH, 'r', encoding='utf-8') as f:
            csv_content = f.read()
        records = load_csv_from_string(csv_content)
        validated = preflight_records(records)
        entries = []
        for r in validated:
            entries.append({
                'video_path': r.get('video_path', ''),
                'cover_path': r.get('cover_path', '') or '',
                'title': r.get('title', '') or '',
                'description': r.get('description', '') or '',
                'short_drama_name': r.get('short_drama_name', '') or '',
                'publish_time': r.get('publish_time', '') or '',
                'valid': not r.get('_skip', False),
                'error': r.get('_skipReason', '') or '',
            })
        return jsonify({'entries': entries})
    except Exception:
        return jsonify({'entries': None})


@app.route('/api/upload/validate', methods=['POST'])
def api_upload_validate():
    try:
        data = request.get_json(force=True)
        csv_content = data.get('csv', '')
        if not csv_content:
            return jsonify({'error': 'csv required'}), 400
        records = load_csv_from_string(csv_content)
        validated = preflight_records(records)
        results = []
        for r in validated:
            results.append({
                'title': r.get('title', ''),
                'video_path': r.get('video_path', ''),
                'valid': not r.get('_skip', False),
                'error': r.get('_skipReason', '') or '',
            })
        return jsonify(results)
    except Exception as e:
        return jsonify({'error': str(e)}), 400


@app.route('/api/upload/status', methods=['GET'])
def api_upload_status():
    return jsonify({
        'running': upload_state['running'],
        'abort': upload_state['abort'],
    })


# ── File upload (drag-drop support) ──


@app.route('/api/upload/file', methods=['POST'])
def api_upload_file():
    try:
        if 'file' not in request.files:
            return jsonify({'error': 'no file uploaded'}), 400
        f = request.files['file']
        if f.filename == '':
            return jsonify({'error': 'no file selected'}), 400

        original_name = f.filename
        # Generate safe filename: timestamp_random_original
        rand_str = ''.join(random.choices(string.ascii_lowercase + string.digits, k=6))
        safe_name = f'{int(time.time() * 1000)}_{rand_str}_{original_name}'
        dest = os.path.join(UPLOADS_DIR, safe_name)
        f.save(dest)
        return jsonify({
            'path': dest,
            'name': original_name,
            'size': os.path.getsize(dest),
        })
    except Exception as e:
        return jsonify({'error': str(e)}), 500


# ── Results & log ──


@app.route('/api/results', methods=['GET'])
def api_results():
    try:
        if not os.path.exists(RESULTS_PATH):
            return jsonify([])
        with open(RESULTS_PATH, 'r', encoding='utf-8-sig') as f:
            text = f.read()
        lines = text.split('\n')
        lines = [l for l in lines if l.strip()]
        if len(lines) <= 1:
            return jsonify([])
        headers = [h.strip() for h in lines[0].split(',')]
        rows = []
        for line in lines[1:]:
            vals = line.split(',')
            obj = {}
            for i, h in enumerate(headers):
                val = vals[i] if i < len(vals) else ''
                val = val.strip('"')
                obj[h] = val
            rows.append(obj)
        return jsonify(rows)
    except Exception:
        return jsonify([])


@app.route('/api/log', methods=['GET'])
def api_log():
    try:
        if not os.path.exists(LOG_PATH):
            return jsonify([])
        with open(LOG_PATH, 'r', encoding='utf-8') as f:
            text = f.read()
        lines = text.split('\n')
        lines = [l for l in lines if l.strip()]
        return jsonify(lines[-200:])
    except Exception:
        return jsonify([])


# ── Static files ──


@app.route('/')
def index():
    return send_from_directory(os.path.join(RES_DIR, 'public'), 'index.html')


@app.route('/<path:path>')
def static_files(path):
    public_dir = os.path.join(RES_DIR, 'public')
    public_path = os.path.join(public_dir, path)
    if os.path.exists(public_path):
        return send_from_directory(public_dir, path)
    return send_from_directory(public_dir, 'index.html')


# ══════════════════════════════════════════════
# Main
# ══════════════════════════════════════════════

if __name__ == '__main__':
    logger.info('Server starting...')
    os.makedirs('uploads', exist_ok=True)
    os.makedirs('screenshots', exist_ok=True)

    print(f'Server: http://localhost:{PORT}')
    socketio.run(app, host='0.0.0.0', port=PORT, allow_unsafe_werkzeug=True)
