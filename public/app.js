/* ─── State ─── */
let accounts = [];
let entries = [];
let allResults = [];       // cached for filtering
let entryIdCounter = 0;
let uploadRunning = false;
let currentView = 'dashboard';
let logCollapsed = false;

const addEntryBtnDefault = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>添加到队列`;

/* ─── Helpers ─── */
const esc = s => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };
const $ = id => document.getElementById(id);
const api = (url, opts = {}) => fetch(url, { headers: { 'Content-Type': 'application/json' }, ...opts });
const toLocalDatetime = d => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;

/* ─── Modal ─── */
let modalCallback = null;
function showModal(title, body, onOk) {
  $('modalTitle').innerHTML = esc(title);
  $('modalBody').innerHTML = body;
  $('modalOverlay').style.display = 'flex';
  modalCallback = onOk || null;
}
$('modalOk').addEventListener('click', async () => {
  $('modalOverlay').style.display = 'none';
  if (modalCallback) await modalCallback();
  modalCallback = null;
});
$('modalCancel').addEventListener('click', () => {
  $('modalOverlay').style.display = 'none';
  modalCallback = null;
});
$('modalOverlay').addEventListener('click', e => {
  if (e.target === $('modalOverlay')) {
    $('modalOverlay').style.display = 'none';
    modalCallback = null;
  }
});

/* ─── Toast ─── */
function toast(msg, type) {
  type = type || 'info';
  const container = $('toastContainer');
  const el = document.createElement('div');
  el.className = 'toast ' + type;
  el.innerHTML = `<span class="toast-msg">${esc(msg)}</span><button class="toast-close" aria-label="关闭">&times;</button>`;
  el.querySelector('.toast-close').addEventListener('click', () => {
    el.classList.add('leaving');
    setTimeout(() => el.remove(), 150);
  });
  container.appendChild(el);
  setTimeout(() => {
    if (el.parentNode) { el.classList.add('leaving'); setTimeout(() => el.remove(), 150); }
  }, 4000);
}

/* ─── WebSocket ─── */
function connectWS() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`);
  ws.onmessage = e => {
    try {
      const d = JSON.parse(e.data);
      if (d.type === 'log') appendLog(d);
      if (d.type === 'progress') onProgress(d);
      if (d.type === 'upload-end') onUploadEnd(d);
      if (d.type === 'login-expired') onLoginExpired(d);
    } catch {}
  };
  ws.onclose = () => setTimeout(connectWS, 2000);
  ws.onopen = () => setStatus('idle', '就绪');
  ws.onerror = () => setStatus('error', '连接断开');
}

/* ═══════════════════════════════════════════════
   Navigation
   ═══════════════════════════════════════════════ */
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    const view = item.dataset.view;
    if (view === currentView) return;
    switchView(view);
  });
});

function switchView(view) {
  currentView = view;
  document.querySelector('.main').scrollTop = 0;
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  document.querySelector(`.nav-item[data-view="${view}"]`).classList.add('active');
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  $(`view-${view}`).classList.add('active');

  if (view === 'dashboard') loadDashboard();
  if (view === 'results') refreshResults();
  if (view === 'logs') refreshLog();
}

/* ═══════════════════════════════════════════════
   Status indicator
   ═══════════════════════════════════════════════ */
function setStatus(type, text) {
  const dot = $('statusDot');
  const label = $('statusLabel');
  dot.className = 'status-dot ' + type;
  label.textContent = text;
}

/* ═══════════════════════════════════════════════
   DASHBOARD
   ═══════════════════════════════════════════════ */
async function loadDashboard() {
  try {
    const [resR, resA] = await Promise.all([fetch('/api/results'), api('/api/accounts')]);
    const results = await resR.json();
    const accts = await resA.json();
    accounts = accts;

    const total = results.length;
    const published = results.filter(r => (r.status || '').toLowerCase() === 'published').length;
    const failed = results.filter(r => (r.status || '').toLowerCase() === 'failed').length;
    const rate = total > 0 ? Math.round((published / total) * 100) : 0;
    const active = accts.filter(a => a.status === 'ready').length;

    $('statTotal').textContent = total;
    $('statRate').textContent = rate + '%';
    $('statRate').className = 'stat-value' + (rate >= 80 ? ' accent' : rate >= 50 ? '' : '');
    $('statFailed').textContent = failed;
    $('statAccounts').textContent = active;

    // Recent activity table
    const recent = [...results].reverse().slice(0, 10);
    const tb = $('dashTable');
    if (recent.length === 0) {
      tb.innerHTML = '<div class="empty-state">暂无发布记录</div>';
    } else {
      tb.innerHTML = `<table><thead><tr><th>视频</th><th>标题</th><th>状态</th><th>错误</th></tr></thead><tbody>${
        recent.map(r => {
          const sc = (r.status || '').toLowerCase();
          return `<tr>
            <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.video_path||'')}">${esc((r.video_path||'').split('/').pop().split('\\').pop())}</td>
            <td>${esc(r.title||'')}</td>
            <td><span class="status-cell ${sc}"><span class="dot"></span>${esc(r.status||'')}</span></td>
            <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-tertiary)" title="${esc(r.error||'')}">${esc(r.error||'')}</td>
          </tr>`;
        }).join('')
      }</tbody></table>`;
    }
  } catch (e) {
    console.error('Dashboard load error:', e);
  }
}

$('dashRefreshBtn').addEventListener('click', loadDashboard);
$('clearEntriesBtn').addEventListener('click', () => {
  if (entries.length === 0) return;
  showModal('清空队列', `确定要清空全部 ${entries.length} 个待上传条目吗？`, () => {
    entries = [];
    renderEntries();
    $('timeline').innerHTML = '';
    $('timeline').classList.remove('visible');
    $('progressWrap').style.display = 'none';
    toast('队列已清空', 'info');
  });
});

/* ═══════════════════════════════════════════════
   ENTRIES
   ═══════════════════════════════════════════════ */
function addEntry(videoPath, videoName, coverPath, coverName, title, drama, time, desc) {
  if (!videoPath) return toast('请选择视频文件', 'error');
  entries.push({
    id: ++entryIdCounter,
    video_path: videoPath, videoName,
    cover_path: coverPath || '', coverName: coverName || '',
    title: title.trim(),
    short_drama_name: drama || '',
    publish_time: time || '',
    description: desc || '',
    _uploadStatus: 'pending',
  });
  renderEntries();
}

function removeEntry(id) {
  entries = entries.filter(e => e.id !== id);
  renderEntries();
}

function renderEntries() {
  const el = $('entryList');
  $('entryCount').textContent = entries.length;
  $('startBtn').disabled = entries.length === 0 || uploadRunning;
  $('clearEntriesBtn').style.display = entries.length > 0 && !uploadRunning ? '' : 'none';

  if (entries.length === 0) {
    el.innerHTML = '<div class="empty-state">暂无视频待上传</div>';
    return;
  }
  el.innerHTML = entries.map((e, i) => {
    const statusMap = {
      pending: ['待上传', 'pending'],
      done: ['已发布', 'done'],
      fail: ['失败', 'fail'],
    };
    const [sLabel, sClass] = statusMap[e._uploadStatus] || ['待上传', 'pending'];
    const valError = e._validationError || '';
    let displayDesc = e.description || '';
    if (displayDesc.length > 50) displayDesc = displayDesc.slice(0, 50) + '…';
    if (!displayDesc) displayDesc = e.title || '(无描述)';
    return `<div class="entry-item${valError ? ' invalid' : ''}" draggable="true" data-id="${e.id}">
      <span class="entry-num">${i + 1}</span>
      <div class="entry-info">
        <div class="entry-title">${esc(displayDesc)}</div>
        <div class="entry-meta">
          <span>${esc(e.videoName || e.video_path.split(/[\\/]/).pop())}</span>
          ${e.title ? `<span>标题: ${esc(e.title)}</span>` : ''}
          ${e.cover_path ? `<span>封面: ${esc(e.coverName || e.cover_path.split(/[\\/]/).pop())}</span>` : ''}
          ${e.short_drama_name ? `<span>剧集: ${esc(e.short_drama_name)}</span>` : ''}
          ${e.publish_time ? `<span>定时: ${esc(e.publish_time.replace('T', ' '))}</span>` : ''}
          ${valError ? `<span class="val-error">${esc(valError)}</span>` : ''}
        </div>
      </div>
      <span class="entry-status ${sClass}"><span class="dot"></span>${sLabel}</span>
      <button class="btn-icon" data-remove="${e.id}" title="删除">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>`;
  }).join('');

  // Attach remove handlers
  el.querySelectorAll('[data-remove]').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      removeEntry(parseInt(btn.dataset.remove));
    });
  });

  // Drag-to-reorder
  setupDragReorder();
}

/* ─── Drag to reorder ─── */
function setupDragReorder() {
  const items = document.querySelectorAll('#entryList .entry-item');
  let dragSrc = null;

  items.forEach(item => {
    item.addEventListener('dragstart', function(e) {
      dragSrc = this;
      this.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', '');
    });

    item.addEventListener('dragend', function() {
      this.classList.remove('dragging');
      document.querySelectorAll('#entryList .entry-item').forEach(el => el.classList.remove('drag-over'));
      dragSrc = null;
    });

    item.addEventListener('dragover', function(e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      if (this !== dragSrc) this.classList.add('drag-over');
    });

    item.addEventListener('dragleave', function() {
      this.classList.remove('drag-over');
    });

    item.addEventListener('drop', function(e) {
      e.preventDefault();
      this.classList.remove('drag-over');
      if (this === dragSrc) return;

      const srcId = parseInt(dragSrc.dataset.id);
      const dstId = parseInt(this.dataset.id);
      const srcIdx = entries.findIndex(e => e.id === srcId);
      const dstIdx = entries.findIndex(e => e.id === dstId);
      if (srcIdx < 0 || dstIdx < 0) return;

      const [moved] = entries.splice(srcIdx, 1);
      entries.splice(dstIdx, 0, moved);
      renderEntries();
    });
  });
}

/* ─── Add entry button ─── */
$('addEntryBtn').addEventListener('click', () => {
  // 批量模式：一次性添加多个视频
  if (batchVideoFiles.length > 0) {
    const title = $('formTitle').value;
    const drama = $('formDrama').value;
    const baseTime = $('formTime').value;
    const interval = parseInt($('formInterval').value) || 0;
    const desc = $('formDesc').value;
    const coverPath = $('coverPreview').dataset.path || '';
    const coverName = $('coverPreview').dataset.name || '';

    batchVideoFiles.forEach(({ path, name }, i) => {
      let t = baseTime;
      if (baseTime && interval > 0) {
        const d = new Date(baseTime);
        const now = new Date();
        if (d <= now) {
          d.setTime(now.getTime());
          d.setMinutes(d.getMinutes() + 1 + i * interval);
        } else {
          d.setMinutes(d.getMinutes() + i * interval);
        }
        t = toLocalDatetime(d);
      }
      entries.push({
        id: ++entryIdCounter,
        video_path: path, videoName: name,
        cover_path: coverPath, coverName,
        title: title.trim(),
        short_drama_name: drama || '',
        publish_time: t,
        description: desc || '',
        _uploadStatus: 'pending',
      });
    });
    renderEntries();
    toast(`已添加 ${batchVideoFiles.length} 个视频到队列`, 'success');
    batchVideoFiles.forEach(f => { if (f._blobUrl) URL.revokeObjectURL(f._blobUrl); });
    batchVideoFiles = [];
    $('batchVideoStrip').style.display = 'none';
    $('addEntryBtn').innerHTML = addEntryBtnDefault;
    clearDropZone('video'); clearDropZone('cover');
    $('formTitle').value = ''; $('formDrama').value = '';
    $('formDesc').value = '';
    return;
  }

  // 单视频模式
  addEntry(
    $('videoPreview').dataset.path,
    $('videoPreview').dataset.name,
    $('coverPreview').dataset.path,
    $('coverPreview').dataset.name,
    $('formTitle').value,
    $('formDrama').value,
    $('formTime').value,
    $('formDesc').value,
  );
  const time = $('formTime').value;
  const interval = parseInt($('formInterval').value) || 0;
  if (time && interval > 0) {
    const d = new Date(time);
    const now = new Date();
    if (d <= now) {
      d.setTime(now.getTime());
      d.setMinutes(d.getMinutes() + 1);
    } else {
      d.setMinutes(d.getMinutes() + interval);
    }
    $('formTime').value = toLocalDatetime(d);
  }
  clearDropZone('video'); clearDropZone('cover');
  $('formTitle').value = ''; $('formDrama').value = '';
  $('formDesc').value = '';
});

/* ─── Title hint ─── */
$('formTitle').addEventListener('input', function() {
  const hint = $('titleHint');
  const v = this.value;
  if (!v) { hint.textContent = '出现在搜索、话题、发现页等场景'; hint.className = 'field-hint'; return; }
  if (v.length < 6) { hint.textContent = '还需 ' + (6 - v.length) + ' 个字符达建议长度'; hint.className = 'field-hint'; return; }
  const allowed = new Set('abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 《》（）"":+?%℃ ');
  for (const ch of v) {
    if (!allowed.has(ch) && !(ch >= '一' && ch <= '鿿')) { hint.textContent = '不支持字符 "' + ch + '"'; hint.className = 'field-hint err'; return; }
  }
  hint.textContent = 'OK'; hint.className = 'field-hint ok';
});

/* ═══════════════════════════════════════════════
   DRAG & DROP (file upload)
   ═══════════════════════════════════════════════ */
function setupDropZone(type) {
  const zone = $(`${type}Drop`);
  const input = $(`${type}Input`);

  input.addEventListener('change', () => {
    const files = input.files;
    if (!files || files.length === 0) return;
    if (type === 'video' && files.length > 1) {
      handleBatchVideos(files);
    } else {
      handleFile(type, files[0]);
    }
  });
  zone.addEventListener('dragover', e => { e.preventDefault(); zone.classList.add('drag-over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault(); zone.classList.remove('drag-over');
    const files = e.dataTransfer.files;
    if (!files || files.length === 0) return;
    // Validate file type
    if (type === 'video') {
      const invalid = [...files].filter(f => !f.type.startsWith('video/'));
      if (invalid.length > 0) {
        toast('不支持的文件类型: ' + invalid.map(f => f.name).join(', ') + '，请拖入 MP4 视频文件', 'error');
        return;
      }
    } else if (type === 'cover') {
      if (!files[0].type.startsWith('image/')) {
        toast('请拖入 PNG / JPG 图片作为封面', 'error');
        return;
      }
    }
    if (type === 'video' && files.length > 1) {
      handleBatchVideos(files);
    } else {
      handleFile(type, files[0]);
    }
  });
}

async function handleFile(type, file) {
  // 单文件上传时清除批量暂存
  if (type === 'video') {
    batchVideoFiles.forEach(f => { if (f._blobUrl) URL.revokeObjectURL(f._blobUrl); });
    batchVideoFiles = [];
    $('batchVideoStrip').style.display = 'none';
    $('addEntryBtn').innerHTML = addEntryBtnDefault;
  }
  const preview = $(`${type}Preview`);
  const zone = $(`${type}Drop`);
  const el = preview.querySelector(type === 'video' ? 'video' : 'img');
  const nameEl = preview.querySelector('.drop-filename');

  // Revoke previous blob URL
  if (preview.dataset.blobUrl) URL.revokeObjectURL(preview.dataset.blobUrl);
  const url = URL.createObjectURL(file);
  preview.dataset.blobUrl = url;
  el.src = url;
  nameEl.textContent = file.name;
  preview.style.display = 'flex';
  zone.querySelector('.drop-icon').style.display = 'none';
  zone.querySelector('.drop-text').style.display = 'none';
  zone.querySelector('.drop-hint').textContent = file.name;

  const formData = new FormData();
  formData.append('file', file);
  try {
    const res = await fetch('/api/upload/file', { method: 'POST', body: formData });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || '上传失败');
    }
    const data = await res.json();
    preview.dataset.path = data.path;
    preview.dataset.name = data.name;
  } catch (err) {
    toast('文件上传失败: ' + (err.message || '网络错误'), 'error');
    return;
  }
}

function uploadVideo(file) {
  return new Promise(async (resolve) => {
    const formData = new FormData();
    formData.append('file', file);
    try {
      const res = await fetch('/api/upload/file', { method: 'POST', body: formData });
      const data = await res.json();
      resolve({ path: data.path, name: data.name });
    } catch {
      resolve({ path: file.name, name: file.name });
    }
  });
}

// 批量拖拽暂存区 — 上传后不立即入队，等用户填完表单
let batchVideoFiles = [];

async function handleBatchVideos(files) {
  const list = [...files];
  const hintEl = $('videoDrop').querySelector('.drop-hint');
  hintEl.textContent = '上传中 0/' + list.length + '…';

  const results = [];
  for (let i = 0; i < list.length; i++) {
    results.push(await uploadVideo(list[i]));
    hintEl.textContent = '上传中 ' + (i + 1) + '/' + list.length + '…';
  }

  // 暂存上传结果，填充横排预览条
  batchVideoFiles = results;
  const strip = $('batchVideoStrip');
  strip.innerHTML = list.map((file, i) => {
    const blobUrl = URL.createObjectURL(file);
    results[i]._blobUrl = blobUrl; // 暂存以便后续清理
    return `<div class="batch-video-card" data-index="${i}">
      <video src="${blobUrl}" muted preload="metadata" title="${esc(results[i].name)}"></video>
      <div class="batch-video-name">${esc(results[i].name)}</div>
    </div>`;
  }).join('');
  strip.style.display = 'flex';
  $('videoPreview').style.display = 'none';
  // 点击卡片预览
  strip.querySelectorAll('.batch-video-card').forEach(card => {
    card.addEventListener('click', () => {
      const vid = card.querySelector('video');
      if (vid.paused) { vid.play(); } else { vid.pause(); }
    });
  });
  // 更新按钮文案
  $('addEntryBtn').innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>添加 ${results.length} 个到队列`;

  hintEl.textContent = results.length + ' 个视频已就绪';
  toast(`${results.length} 个视频已就绪，请填写信息后点击"添加到队列"`, 'info');
}

function clearDropZone(type) {
  const zone = $(`${type}Drop`);
  const preview = $(`${type}Preview`);
  const input = $(`${type}Input`);
  const defaultHints = { video: 'MP4 · 可批量选择 · 最大 20GB', cover: 'PNG / JPG' };
  if (preview.dataset.blobUrl) { URL.revokeObjectURL(preview.dataset.blobUrl); delete preview.dataset.blobUrl; }
  preview.style.display = 'none';
  preview.dataset.path = ''; preview.dataset.name = ''; input.value = '';
  zone.querySelector('.drop-icon').style.display = '';
  zone.querySelector('.drop-text').style.display = '';
  zone.querySelector('.drop-hint').textContent = defaultHints[type];
}

setupDropZone('video');
setupDropZone('cover');

/* ═══════════════════════════════════════════════
   UPLOAD
   ═══════════════════════════════════════════════ */
$('startBtn').addEventListener('click', startUpload);
$('stopBtn').addEventListener('click', stopUpload);
$('retryBtn').addEventListener('click', retryFailed);
$('resumeBtn').addEventListener('click', resumeLastBatch);
$('validateBtn').addEventListener('click', validateEntries);

function generateCSV() {
  const header = 'video_path,title,description,short_drama_name,publish_time,cover_path';
  const rows = entries.map(e => {
    const cols = [e.video_path, e.title || '', e.description || '', e.short_drama_name || '', e.publish_time || '', e.cover_path || ''];
    return cols.map(v => {
      const s = String(v || '');
      return s.includes(',') || s.includes('"') ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(',');
  });
  return header + '\n' + rows.join('\n');
}

async function startUpload() {
  const account = $('accountSelect').value;
  if (!account) return toast('请先在左侧选择发布账号', 'error');
  if (entries.length === 0) return toast('请先添加视频', 'error');

  const csv = generateCSV();
  setStatus('running', '上传中…');
  $('startBtn').disabled = true;
  $('stopBtn').disabled = false;
  $('liveLog').textContent = '';
  uploadRunning = true;
  entries.forEach(e => { e._uploadStatus = 'pending'; delete e._validationError; });
  renderEntries();

  // Show timeline
  const tl = $('timeline');
  tl.classList.add('visible');
  tl.innerHTML = entries.map((e, i) =>
    `<div class="timeline-node pending" data-tl="${e.id}">
      <div class="timeline-node-title">${i + 1}. ${esc(e.title || e.videoName || '未命名')}</div>
      <div class="timeline-node-meta">等待中</div>
    </div>`
  ).join('');

  $('progressWrap').style.display = 'block';
  $('retryBtn').style.display = 'none';
  updateProgress(0, entries.length);

  try {
    const res = await api('/api/upload/start', {
      method: 'POST',
      body: JSON.stringify({ account, csv }),
    });
    if (!res.ok) {
      const d = await res.json();
      toast(d.error || '启动失败', 'error');
      resetUI();
    }
  } catch (e) {
    toast('错误: ' + e.message, 'error');
    resetUI();
  }
}

function stopUpload() {
  showModal('停止上传', '确定要停止当前上传吗？<br>已完成的视频不会受影响，剩余视频将标记为失败。', () => {
    api('/api/upload/stop', { method: 'POST' });
    $('stopBtn').disabled = true;
    toast('正在停止…', 'info');
  });
}

function updateProgress(current, total) {
  const pct = total > 0 ? Math.round((current / total) * 100) : 0;
  $('progressFill').style.width = pct + '%';
  $('progressText').textContent = current + ' / ' + total + ' (' + pct + '%)';
}

function onProgress(data) {
  const idx = data.current - 1;
  if (idx >= 0 && idx < entries.length) {
    entries[idx]._uploadStatus = data.status === 'published' ? 'done' : data.status === 'failed' ? 'fail' : 'pending';
    renderEntries();

    // Update timeline node
    const tlNode = document.querySelector(`.timeline-node[data-tl="${entries[idx].id}"]`);
    if (tlNode) {
      tlNode.classList.remove('pending', 'active', 'done', 'fail');
      const statusClass = data.status === 'published' ? 'done' : data.status === 'failed' ? 'fail' : 'active';
      tlNode.classList.add(statusClass);
      const meta = tlNode.querySelector('.timeline-node-meta');
      if (meta) meta.textContent = data.status === 'published' ? '已发布' : data.status === 'failed' ? '失败' : '处理中…';
    }
  }
  updateProgress(data.current, data.total);
}

async function validateEntries() {
  if (entries.length === 0) return toast('请先添加视频', 'info');
  $('validateBtn').disabled = true;
  $('validateBtn').textContent = '预检中…';
  const csv = generateCSV();
  try {
    const res = await api('/api/upload/validate', { method: 'POST', body: JSON.stringify({ csv }) });
    if (!res.ok) return toast('预检失败', 'error');
    const results = await res.json();
    let issues = 0;
    results.forEach((r, i) => {
      if (i < entries.length) {
        entries[i]._validationError = r.valid ? '' : r.error;
        if (!r.valid) issues++;
      }
    });
    renderEntries();
    if (issues === 0) toast('全部 ' + entries.length + ' 个条目预检通过', 'success');
    else toast(issues + ' 个条目存在问题，已高亮显示', 'warn');
  } catch { toast('预检失败', 'error'); }
  $('validateBtn').disabled = false;
  $('validateBtn').innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>预检';
}

// Clean server-renamed filename: "1680000000_a1b2c3_video.mp4" → "video.mp4"
function cleanUploadName(filePath) {
  const name = (filePath || '').split(/[\\/]/).pop();
  return name.replace(/^\d+_[a-z0-9]{6}_/, '');
}

async function resumeLastBatch() {
  try {
    const res = await fetch('/api/upload/last-csv');
    const data = await res.json();
    if (!data.entries || data.entries.length === 0) return toast('没有可恢复的上次上传', 'info');
    const newEntries = data.entries.map(r => ({
      id: ++entryIdCounter,
      video_path: r.video_path,
      videoName: cleanUploadName(r.video_path),
      cover_path: r.cover_path || '',
      coverName: cleanUploadName(r.cover_path),
      title: r.title || '',
      description: r.description || '',
      short_drama_name: r.short_drama_name || '',
      publish_time: r.publish_time || '',
      _uploadStatus: 'pending',
      _validationError: r.valid ? '' : (r.error || '校验失败'),
    }));
    entries = [...entries, ...newEntries];
    renderEntries();
    const invalid = newEntries.filter(e => e._validationError).length;
    toast(`已恢复 ${newEntries.length} 个条目${invalid > 0 ? '（' + invalid + ' 个校验未通过）' : ''}`, invalid > 0 ? 'error' : 'success');
  } catch { toast('恢复失败', 'error'); }
}

async function retryFailed() {
  const failed = entries.filter(e => e._uploadStatus === 'fail');
  if (failed.length === 0) return toast('没有失败的条目', 'info');
  entries = failed;
  entries.forEach(e => { e._uploadStatus = 'pending'; delete e._validationError; });
  $('entryCount').textContent = entries.length;
  await startUpload();
}

function onLoginExpired(data) {
  toast(`账号登录已过期！视频「${data.title || '未知'}」上传中断，请重新扫码登录`, 'error');
  resetUI();
  loadAccounts(); // refresh account list and select
  setStatus('error', '登录过期');
}

function onUploadEnd(data) {
  uploadRunning = false;
  resetUI();
  $('progressWrap').style.display = 'none';
  if (data.loginExpired) {
    loadAccounts();
    setStatus('error', '登录过期');
  }
  if (data.success) {
    const pct = Math.round((data.results / data.total) * 100);
    toast('完成: ' + data.results + '/' + data.total + ' (' + pct + '%)', 'success');

    // Update remaining timeline nodes
    let done = 0;
    entries.forEach(e => {
      if (done < data.results) { e._uploadStatus = 'done'; done++; }
      else if (e._uploadStatus === 'pending') e._uploadStatus = 'fail';
    });
    renderEntries();
    refreshResults();
  } else {
    toast('上传失败: ' + (data.error || '未知错误'), 'error');
  }
  // Show retry button if any failed
  const hasFailed = entries.some(e => e._uploadStatus === 'fail');
  $('retryBtn').style.display = hasFailed ? '' : 'none';
}

function resetUI() {
  $('startBtn').disabled = false;
  $('stopBtn').disabled = true;
  $('progressWrap').style.display = 'none';
  if (!uploadRunning) setStatus('idle', '就绪');
}

/* ═══════════════════════════════════════════════
   LOGS
   ═══════════════════════════════════════════════ */
function appendLog(data) {
  // Live log (upload view)
  const liveLog = $('liveLog');
  if (liveLog) {
    const level = data.level === 'ERROR' ? 'err' : data.level === 'WARN' ? 'warn' : 'info';
    liveLog.innerHTML += '<span class="' + level + '">[' + (data.ts ? new Date(data.ts).toLocaleTimeString() : '') + '] ' + esc(data.msg) + '</span>\n';
    liveLog.scrollTop = liveLog.scrollHeight;
  }

  // Full log view — if visible and auto-refresh on, refresh
  if (currentView === 'logs' && $('logAutoRefresh').checked) {
    refreshLog();
  }
}

$('clearLogBtn').addEventListener('click', () => { $('liveLog').textContent = ''; });

/* ═══════════════════════════════════════════════
   ACCOUNTS
   ═══════════════════════════════════════════════ */
async function loadAccounts() {
  const res = await api('/api/accounts');
  accounts = await res.json();
  renderAccounts();
  renderAccountSelect();

  // Auto-verify stale accounts in parallel (>1 hour since last check)
  const stale = accounts.filter(a => !a.lastLogin || Date.now() - new Date(a.lastLogin).getTime() >= 3600000);
  if (stale.length > 0) {
    const results = await Promise.allSettled(stale.map(a =>
      api(`/api/accounts/${a.name}/verify`, { method: 'POST' }).then(r => r.json().then(d => ({ name: a.name, data: d })))
    ));
    results.forEach(r => {
      if (r.status === 'fulfilled') {
        const acct = accounts.find(ac => ac.name === r.value.name);
        if (acct) acct.status = r.value.data.valid ? 'ready' : 'needs-login';
      }
    });
  }
  renderAccounts();
  renderAccountSelect();
}

function renderAccounts() {
  const grid = $('accountsGrid');
  // Clear all except the add card
  grid.querySelectorAll('.acct-card:not(.acct-add)').forEach(c => c.remove());

  accounts.forEach(a => {
    const card = document.createElement('div');
    card.className = 'acct-card';
    const initial = (a.label || a.name)[0].toUpperCase();
    card.innerHTML = `
      <div class="acct-card-header">
        <div class="acct-avatar">${esc(initial)}</div>
        <div class="acct-card-name">
          <div class="name">${esc(a.label)}</div>
          <div class="label">${esc(a.name)}</div>
        </div>
        <span class="acct-status ${a.status}"><span class="acct-status-dot"></span>${a.status === 'ready' ? '已登录' : '未登录'}</span>
      </div>
      <div class="acct-meta">
        ${a.lastLogin ? '<span>最后登录: ' + new Date(a.lastLogin).toLocaleDateString() + '</span>' : '<span>尚未登录</span>'}
      </div>
      <div class="acct-actions">
        ${a.status !== 'ready' ? '<button class="btn btn-primary btn-sm" data-login="' + esc(a.name) + '">扫码登录</button>' : ''}
        <button class="btn btn-ghost btn-sm" data-verify="' + esc(a.name) + '">验证</button>
        <button class="btn btn-ghost btn-sm" data-rename="' + esc(a.name) + '">改名</button>
        ${a.name !== 'default' ? '<button class="btn btn-ghost btn-sm" style="color:var(--red)" data-delete="' + esc(a.name) + '">删除</button>' : ''}
      </div>
    `;

    // Event handlers
    card.querySelector('[data-login]')?.addEventListener('click', () => loginAccount(a.name));
    card.querySelector('[data-verify]')?.addEventListener('click', () => verifyAccount(a.name));
    card.querySelector('[data-rename]')?.addEventListener('click', () => editAccountLabel(a.name));
    card.querySelector('[data-delete]')?.addEventListener('click', () => deleteAccount(a.name));

    grid.appendChild(card);
  });
}

function renderAccountSelect() {
  const sel = $('accountSelect');
  sel.innerHTML = accounts.map(a =>
    '<option value="' + esc(a.name) + '">' + esc(a.label) + (a.status === 'ready' ? '' : ' (未登录)') + '</option>'
  ).join('');
}

async function editAccountLabel(name) {
  const acct = accounts.find(a => a.name === name);
  if (!acct) return;
  const newLabel = prompt('输入新的显示名称：', acct.label);
  if (!newLabel || newLabel.trim() === acct.label) return;
  const res = await api('/api/accounts/' + name, {
    method: 'PATCH',
    body: JSON.stringify({ label: newLabel.trim() }),
  });
  if (!res.ok) {
    const d = await res.json();
    return toast(d.error || '修改失败', 'error');
  }
  toast('账号已更新', 'success');
  await loadAccounts();
}

async function verifyAccount(name) {
  const card = document.querySelector(`[data-verify="${esc(name)}"]`);
  if (card) { card.disabled = true; card.textContent = '验证中…'; }
  try {
    const vRes = await api(`/api/accounts/${name}/verify`, { method: 'POST' });
    if (vRes.ok) {
      const vData = await vRes.json();
      const acct = accounts.find(a => a.name === vData.name);
      if (acct) { acct.status = vData.valid ? 'ready' : 'needs-login'; acct.lastLogin = new Date().toISOString(); }
      toast(vData.valid ? '登录状态有效' : '登录已过期，请重新扫码', vData.valid ? 'success' : 'error');
      renderAccounts();
      renderAccountSelect();
    }
  } catch { toast('验证失败', 'error'); }
  if (card) { card.disabled = false; card.textContent = '验证'; }
}

async function loginAccount(name) {
  showModal('扫码登录', '<div style="text-align:center;padding:12px"><p>正在获取二维码…</p></div>', null);
  $('modalOk').style.display = 'none';

  let pollTimer = null;
  const stopPolling = () => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    api('/api/accounts/' + name + '/qrcode/cancel', { method: 'POST' }).catch(() => {});
  };

  try {
    const res = await api('/api/accounts/' + name + '/qrcode', { method: 'POST' });
    if (!res.ok) {
      $('modalOverlay').style.display = 'none';
      toast('获取二维码失败', 'error');
      return;
    }
    const data = await res.json();

    $('modalBody').innerHTML = `
      <div style="text-align:center">
        <img src="${data.qrcode}" style="max-width:280px;width:100%;border-radius:8px;border:1px solid var(--border)" alt="QR Code">
        <p style="margin-top:14px;color:var(--text-secondary);font-size:13px">请使用微信扫码登录</p>
        <p id="qrStatus" style="font-size:11px;color:var(--text-tertiary);margin-top:6px">等待扫码…</p>
      </div>
    `;

    pollTimer = setInterval(async () => {
      if ($('modalOverlay').style.display === 'none') { stopPolling(); return; }
      try {
        const sRes = await api('/api/accounts/' + name + '/qrcode/status');
        if (!sRes.ok) return;
        const status = await sRes.json();
        const statusEl = $('qrStatus');
        if (status.status === 'done') {
          stopPolling();
          if (statusEl) statusEl.innerHTML = '<span style="color:var(--green)">登录成功！</span>';
          $('modalOverlay').style.display = 'none';
          modalCallback = null;
          toast('登录成功', 'success');
          await loadAccounts();
        } else if (status.status === 'scanned') {
          if (statusEl) statusEl.innerHTML = '<span style="color:var(--green)">已扫码，请在手机上确认登录</span>';
        } else if (status.status === 'expired') {
          stopPolling();
          if (statusEl) statusEl.innerHTML = '<span style="color:var(--yellow)">二维码已过期</span>';
          const btn = document.createElement('button');
          btn.className = 'btn btn-primary btn-sm';
          btn.style.cssText = 'margin-top:10px';
          btn.textContent = '刷新二维码';
          btn.addEventListener('click', () => {
            $('modalOverlay').style.display = 'none';
            modalCallback = null;
            setTimeout(() => loginAccount(name), 300);
          });
          statusEl.parentElement.appendChild(btn);
        }
      } catch {}
    }, 3000);
  } catch (e) {
    $('modalOverlay').style.display = 'none';
    toast('获取二维码失败: ' + e.message, 'error');
  }
}

async function deleteAccount(name) {
  if (!confirm('删除账号「' + name + '」？')) return;
  await api('/api/accounts/' + name, { method: 'DELETE' });
  toast('账号已删除', 'info');
  await loadAccounts();
}

// Add account UI
$('showAddAccountBtn').addEventListener('click', () => {
  $('showAddAccountBtn').style.display = 'none';
  $('addAccountForm').style.display = 'flex';
  $('newAccountName').focus();
});

$('cancelAddAccountBtn').addEventListener('click', () => {
  $('showAddAccountBtn').style.display = '';
  $('addAccountForm').style.display = 'none';
  $('newAccountName').value = '';
  $('newAccountLabel').value = '';
});

$('addAccountBtn').addEventListener('click', async () => {
  const name = $('newAccountName').value.trim();
  const label = $('newAccountLabel').value.trim() || name;
  if (!name) return toast('请输入账号名称', 'error');
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) return toast('账号名称只能包含英文、数字、下划线和连字符', 'error');
  const res = await api('/api/accounts', {
    method: 'POST',
    body: JSON.stringify({ name, label }),
  });
  if (!res.ok) {
    const d = await res.json();
    return toast(d.error || '创建失败', 'error');
  }
  $('newAccountName').value = ''; $('newAccountLabel').value = '';
  $('showAddAccountBtn').style.display = '';
  $('addAccountForm').style.display = 'none';
  toast('账号创建成功', 'success');
  await loadAccounts();
});

/* ═══════════════════════════════════════════════
   RESULTS
   ═══════════════════════════════════════════════ */
let currentFilter = 'all';

document.querySelectorAll('#resultFilters .filter-tab').forEach(tab => {
  tab.addEventListener('click', function() {
    document.querySelectorAll('#resultFilters .filter-tab').forEach(t => t.classList.remove('active'));
    this.classList.add('active');
    currentFilter = this.dataset.filter;
    renderResultsTable();
  });
});

async function refreshResults() {
  const res = await fetch('/api/results');
  allResults = await res.json();
  renderResultsTable();
}

function renderResultsTable() {
  const tb = document.querySelector('#resultsTable tbody');
  const search = ($('resultSearch')?.value || '').toLowerCase();
  let filtered = currentFilter === 'all'
    ? allResults
    : allResults.filter(r => (r.status || '').toLowerCase() === currentFilter);
  if (search) {
    filtered = filtered.filter(r =>
      (r.title || '').toLowerCase().includes(search) ||
      (r.video_path || '').toLowerCase().includes(search) ||
      (r.error || '').toLowerCase().includes(search)
    );
  }

  if (filtered.length === 0) {
    tb.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-tertiary);padding:30px;font-size:13px">暂无发布记录</td></tr>';
    return;
  }
  tb.innerHTML = filtered.map(r => {
    const sc = (r.status || '').toLowerCase();
    return '<tr>' +
      '<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(r.video_path || '') + '">' + esc((r.video_path || '').split('/').pop().split('\\').pop()) + '</td>' +
      '<td>' + esc(r.title || '') + '</td>' +
      '<td><span class="status-cell ' + sc + '"><span class="dot"></span>' + esc(r.status || '') + '</span></td>' +
      '<td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-tertiary)" title="' + esc(r.error || '') + '">' + esc(r.error || '') + '</td>' +
    '</tr>';
  }).join('');
}
document.addEventListener('DOMContentLoaded', () => {
  const searchEl = $('resultSearch');
  if (searchEl) searchEl.addEventListener('input', renderResultsTable);
  // 默认定时发布时间设为当前时间（本地时区），禁止选择过去时间
  if ($('formTime')) {
    const localStr = toLocalDatetime(new Date());
    $('formTime').min = localStr;
    if (!$('formTime').value) $('formTime').value = localStr;
  }
});

$('refreshResultsBtn').addEventListener('click', refreshResults);
$('exportResultsBtn').addEventListener('click', async () => {
  const res = await fetch('/api/results');
  const rows = await res.json();
  if (rows.length === 0) return toast('暂无结果', 'info');
  const csv = ['video_path,title,status,error', ...rows.map(r =>
    [r.video_path, r.title, r.status, r.error].map(v => {
      const s = String(v || '');
      return s.includes(',') || s.includes('"') ? '"' + s.replace(/"/g, '""') + '"' : s;
    }).join(','))
  ].join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = 'results.csv'; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 100);
});

/* ═══════════════════════════════════════════════
   FULL LOG
   ═══════════════════════════════════════════════ */
async function refreshLog() {
  try {
    const res = await fetch('/api/log');
    const lines = await res.json();
    const searchTerm = $('logSearch').value.toLowerCase();
    const filtered = searchTerm ? lines.filter(l => l.toLowerCase().includes(searchTerm)) : lines;
    $('fullLog').textContent = filtered.join('\n');
  } catch (e) {
    console.error('Log refresh error:', e);
  }
}

$('refreshLogBtn').addEventListener('click', refreshLog);
$('logSearch').addEventListener('input', refreshLog);

/* ═══════════════════════════════════════════════
   Log panel collapse
   ═══════════════════════════════════════════════ */
$('logToggle').addEventListener('click', function() {
  logCollapsed = !logCollapsed;
  const viewer = $('liveLog');
  const header = this;
  if (logCollapsed) {
    viewer.style.display = 'none';
    header.classList.add('collapsed');
  } else {
    viewer.style.display = '';
    header.classList.remove('collapsed');
  }
});

/* ═══════════════════════════════════════════════
   KEYBOARD SHORTCUTS
   ═══════════════════════════════════════════════ */
document.addEventListener('keydown', function(e) {
  // Ctrl+Enter: start upload (from upload view)
  if (e.ctrlKey && e.key === 'Enter') {
    if (currentView === 'upload' && !uploadRunning && entries.length > 0) {
      e.preventDefault();
      startUpload();
    }
  }
  // Ctrl+1..5: switch views
  const viewMap = { '1': 'dashboard', '2': 'upload', '3': 'accounts', '4': 'results', '5': 'logs' };
  if (e.ctrlKey && viewMap[e.key]) {
    e.preventDefault();
    switchView(viewMap[e.key]);
  }
});

/* ═══════════════════════════════════════════════
   THEME TOGGLE
   ═══════════════════════════════════════════════ */
(function() {
  const KEY = 'theme';
  const saved = localStorage.getItem(KEY);
  if (saved === 'dark') document.body.setAttribute('data-theme', 'dark');
  $('themeToggle').addEventListener('click', () => {
    const isDark = document.body.getAttribute('data-theme') === 'dark';
    if (isDark) {
      document.body.removeAttribute('data-theme');
      localStorage.setItem(KEY, 'light');
      $('themeToggle').textContent = '🌙';
    } else {
      document.body.setAttribute('data-theme', 'dark');
      localStorage.setItem(KEY, 'dark');
      $('themeToggle').textContent = '☀️';
    }
  });
  $('themeToggle').textContent = saved === 'dark' ? '☀️' : '🌙';
})();

/* ═══════════════════════════════════════════════
   INIT
   ═══════════════════════════════════════════════ */
connectWS();
loadAccounts();
loadDashboard();
