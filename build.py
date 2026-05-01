#!/usr/bin/env python3
"""PyInstaller build script - packages the app into a folder distribution"""
import glob
import os
import shutil
import subprocess
import sys


def find_chromium_version():
    """Find which chromium version Playwright 1.52 uses by checking browsers.json"""
    try:
        import playwright
        pw_dir = os.path.dirname(playwright.__file__)
        browsers_json = os.path.join(pw_dir, 'driver', 'package', 'browsers.json')
        if not os.path.exists(browsers_json):
            browsers_json = os.path.join(pw_dir, 'driver', 'browsers.json')
        if not os.path.exists(browsers_json):
            browsers_json = os.path.join(pw_dir, 'browsers.json')
        if os.path.exists(browsers_json):
            import json
            with open(browsers_json, 'r') as f:
                data = json.load(f)
            for browser in data.get('browsers', []):
                if browser.get('name') == 'chromium':
                    return str(browser['revision'])
    except Exception:
        pass

    # Fallback: find newest chromium-* directory
    ms_pw = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'ms-playwright')
    if os.path.isdir(ms_pw):
        versions = glob.glob(os.path.join(ms_pw, 'chromium-*'))
        if versions:
            versions.sort(key=lambda p: int(os.path.basename(p).split('-')[1]))
            return os.path.basename(versions[-1]).split('-')[1]
    return None


def clean():
    """Remove previous build artifacts"""
    base = os.path.dirname(os.path.abspath(__file__))
    for d in ['dist', 'build']:
        dp = os.path.join(base, d)
        if os.path.exists(dp):
            try:
                shutil.rmtree(dp)
            except PermissionError:
                print(f'[WARN] Cannot remove {dp}, file in use. Trying to continue...')
                pass
    for f in glob.glob(os.path.join(base, '*.spec')):
        os.remove(f)


def build():
    base = os.path.dirname(os.path.abspath(__file__))
    os.chdir(base)

    # Find chromium version
    chromium_ver = find_chromium_version()
    ms_pw = os.path.join(os.environ.get('LOCALAPPDATA', ''), 'ms-playwright')
    chromium_dir = os.path.join(ms_pw, f'chromium-{chromium_ver}') if chromium_ver else None
    ffmpeg_dir = None

    if chromium_dir and os.path.isdir(chromium_dir):
        print(f'[INFO] Chromium: {chromium_dir}')
        # Find matching ffmpeg
        for d in os.listdir(ms_pw):
            if d.startswith('ffmpeg-'):
                ffmpeg_dir = os.path.join(ms_pw, d)
                break
        if ffmpeg_dir:
            print(f'[INFO] FFmpeg: {ffmpeg_dir}')
    else:
        print('[WARN] Chromium not found, run: playwright install chromium')
        print('[WARN] Packaged app will need Playwright Chromium installed separately')

    clean()

    # Build PyInstaller command
    # On Windows, --add-data separator is ";"
    cmd = [
        sys.executable, '-m', 'PyInstaller',
        '--onedir',
        '--noconsole',
        '--name', '视频号批量上传',
        '--add-data', f'public{os.pathsep}public',
        '--collect-submodules', 'flask_socketio',
        '--collect-submodules', 'engineio.async_drivers.threading',
        '--hidden-import', 'engineio.async_drivers.threading',
        '--hidden-import', 'playwright.async_api',
        '--hidden-import', 'webview',
        '--hidden-import', 'webview.platforms.windowsforms',
        '--copy-metadata', 'playwright',
        '--clean',
        '--noconfirm',
        'run.py',
    ]

    print(f'[INFO] Running PyInstaller...')
    result = subprocess.run(cmd)
    if result.returncode != 0:
        print('[ERROR] PyInstaller failed')
        sys.exit(1)

    # Copy Chromium into _internal/ms-playwright/ AFTER PyInstaller finishes
    dist_internal = os.path.join(base, 'dist', '视频号批量上传', '_internal')
    if chromium_dir and os.path.isdir(chromium_dir) and os.path.isdir(dist_internal):
        pw_dest = os.path.join(dist_internal, 'ms-playwright')
        os.makedirs(pw_dest, exist_ok=True)

        print(f'[INFO] Copying Chromium to _internal/ms-playwright/...')
        # Copy chromium
        dest_chromium = os.path.join(pw_dest, f'chromium-{chromium_ver}')
        if not os.path.exists(dest_chromium):
            shutil.copytree(chromium_dir, dest_chromium)

        # Copy headless shell if exists
        headless_src = os.path.join(ms_pw, f'chromium_headless_shell-{chromium_ver}')
        if os.path.isdir(headless_src):
            dest_headless = os.path.join(pw_dest, f'chromium_headless_shell-{chromium_ver}')
            if not os.path.exists(dest_headless):
                shutil.copytree(headless_src, dest_headless)

        # Copy ffmpeg if exists
        if ffmpeg_dir and os.path.isdir(ffmpeg_dir):
            dest_ffmpeg = os.path.join(pw_dest, os.path.basename(ffmpeg_dir))
            if not os.path.exists(dest_ffmpeg):
                shutil.copytree(ffmpeg_dir, dest_ffmpeg)

        print('[INFO] Chromium bundled successfully')

    # Clean up unnecessary build artifacts
    for f in glob.glob(os.path.join(base, '*.spec')):
        os.remove(f)

    # Verify
    exe = os.path.join(base, 'dist', '视频号批量上传', '视频号批量上传.exe')
    if os.path.exists(exe):
        total = 0
        dist_dir = os.path.dirname(exe)
        for root, dirs, files in os.walk(dist_dir):
            for f in files:
                try:
                    total += os.path.getsize(os.path.join(root, f))
                except OSError:
                    pass
        print(f'[SUCCESS] Build complete: {dist_dir}')
        print(f'[INFO] Total size: {total / (1024*1024*1024):.2f} GB')
    else:
        print('[ERROR] exe not found at expected path')
        sys.exit(1)


if __name__ == '__main__':
    build()
