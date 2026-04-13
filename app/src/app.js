'use strict';
/**
 * whisper-remote — Electron renderer
 *
 * Differences from the web version:
 *  - Server URL is configurable (persisted via window.ea.getSettings/setSettings)
 *  - All API calls are prefixed with state.serverUrl
 *  - WebSocket URLs derived from state.serverUrl (http→ws, https→wss)
 *  - File export via window.ea.saveFile() (native Save dialog)
 *  - Auto-update banner driven by window.ea IPC events
 *  - AudioWorklet fetched as blob: to work around script-src CSP
 */

// ── State ──────────────────────────────────────────────────────────────────
let _livePollTimer = null;

const state = {
  serverUrl: 'http://localhost:8000',
  sessionId: null,
  sessionName: '',
  browserMicActive: false,
  subtitleWs: null,
  audioWs: null,
  audioContext: null,
  audioWorklet: null,
  mediaStream: null,
  uploadProcessingDone: false,
  _subtitlePingTimer: null,
};

// ── DOM helper ─────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── Toast ──────────────────────────────────────────────────────────────────
let _toastTimer;
function toast(msg, type = 'info') {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast show' + (type !== 'info' ? ' ' + type : '');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { el.className = 'toast'; }, 3000);
}

// ── URL helpers ────────────────────────────────────────────────────────────
function apiUrl(path) {
  return state.serverUrl.replace(/\/$/, '') + path;
}

function wsUrl(path) {
  return state.serverUrl.replace(/\/$/, '')
    .replace(/^https:/, 'wss:')
    .replace(/^http:/, 'ws:') + path;
}

// ── API helper ─────────────────────────────────────────────────────────────
async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(apiUrl(path), opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || res.statusText);
  }
  return res.json().catch(() => null);
}

// ── Server connection ──────────────────────────────────────────────────────
async function connectToServer() {
  let url = $('server-url').value.trim();
  if (!url) return;
  // Auto-prepend http:// if user omitted the protocol
  if (!/^https?:\/\//i.test(url)) url = 'http://' + url;
  $('server-url').value = url;
  state.serverUrl = url;
  if (window.ea) window.ea.setSettings({ serverUrl: url }).catch(() => {});

  // Tear down old subtitle WS so it reconnects with the new URL
  if (state.subtitleWs) {
    state.subtitleWs.onclose = null; // suppress auto-reconnect with stale URL
    state.subtitleWs.close();
    state.subtitleWs = null;
  }
  clearInterval(state._subtitlePingTimer);

  try {
    await api('GET', '/api/health');
    $('status-dot').className = 'dot ok';
    toast('已连接到服务器', 'success');
  } catch {
    $('status-dot').className = 'dot err';
    toast('无法连接：' + url, 'error');
    return;
  }
  connectSubtitleWs();
  loadSessions();
  loadDevices();
  loadSettings();
}

// ── Health ─────────────────────────────────────────────────────────────────
async function checkHealth() {
  try {
    await api('GET', '/api/health');
    $('status-dot').className = 'dot ok';
  } catch {
    $('status-dot').className = 'dot err';
  }
}

// ── Session list ───────────────────────────────────────────────────────────
async function loadSessions() {
  try {
    const sessions = await api('GET', '/api/sessions');
    const list = $('session-list');
    list.innerHTML = '';
    sessions.forEach(s => {
      const div = document.createElement('div');
      div.className = 'session-item' + (s.id === state.sessionId ? ' active' : '');
      div.dataset.id = s.id;
      div.innerHTML = `
        <div>
          <div class="session-name">${esc(s.name)}</div>
          <div class="session-meta">${fmtDur(s.duration)} · ${s.subtitle_count} lines</div>
        </div>
        ${s.active ? '<span class="badge-live">LIVE</span>' : ''}
      `;
      div.addEventListener('click', () => selectSession(s.id, s.name));
      list.appendChild(div);
    });
  } catch {}
}

async function createSession() {
  const nameInput = $('new-session-name');
  const name = nameInput.value.trim() || '';
  try {
    const s = await api('POST', '/api/sessions', { name });
    nameInput.value = '';
    await loadSessions();
    selectSession(s.id, s.name);
    toast(`会话 "${s.name}" 已创建`, 'success');
  } catch (e) { toast(e.message, 'error'); }
}

// ── Live poll fallback (catches subtitles missed during WS reconnect) ──────
function startLivePoll() {
  clearInterval(_livePollTimer);
  _livePollTimer = setInterval(async () => {
    if (!state.sessionId) return;
    try {
      const s = await api('GET', `/api/sessions/${state.sessionId}`);
      let added = false;
      s.subtitles.forEach(sub => {
        if (!document.querySelector(`[data-sub-id="${sub.id}"]`)) {
          renderSubtitle(sub);
          added = true;
        }
      });
      if (added) scrollToBottom();
    } catch {}
  }, 3000);
}

function stopLivePoll() {
  clearInterval(_livePollTimer);
  _livePollTimer = null;
}

async function selectSession(id, name) {
  state.sessionId = id;
  state.sessionName = name;
  $('session-title').textContent = name;
  try {
    const s = await api('GET', `/api/sessions/${id}`);
    $('subtitle-feed').innerHTML = '';
    s.subtitles.forEach(renderSubtitle);
    updateBadge(s.active);
    scrollToBottom();
  } catch {}
  startLivePoll();
  loadSessions();
}

async function stopSession() {
  if (!state.sessionId) return;
  await stopBrowserMic();
  await micStop();
  await systemStop();
  stopLivePoll();
  try {
    await api('DELETE', `/api/sessions/${state.sessionId}`);
    toast('会话已停止', 'success');
    updateBadge(false);
    loadSessions();
  } catch (e) { toast(e.message, 'error'); }
}

// ── Export ─────────────────────────────────────────────────────────────────
async function exportSession(fmt) {
  if (!state.sessionId) return toast('未选择会话', 'error');
  const url  = apiUrl(`/api/sessions/${state.sessionId}/export/${fmt}`);
  const name = `${state.sessionName || state.sessionId}.${fmt}`;
  if (window.ea) {
    const saved = await window.ea.saveFile(url, name).catch(() => null);
    if (saved) toast(`已保存: ${saved}`, 'success');
  } else {
    window.location = url;
  }
}

// ── Subtitle rendering ─────────────────────────────────────────────────────
function renderSubtitle(sub) {
  if (!sub.original_text) return;

  let card = document.querySelector(`[data-sub-id="${sub.id}"]`);
  const isNew = !card;
  if (!card) {
    card = document.createElement('div');
    card.dataset.subId = sub.id;
    $('subtitle-feed').appendChild(card);
  }

  const display = sub.display || {};
  const isZh = sub.original_language === 'zh' || sub.original_language === 'yue';
  const line1 = isZh ? (display.zh || sub.original_text)   : (display.en || sub.original_text);
  const line2 = isZh ? (display.en || sub.translated_text) : (display.zh || sub.translated_text);

  card.className = 'card' + (sub.is_interim ? ' interim' : '');
  card.innerHTML = `
    <div class="card-meta">${fmtTs(sub.start_time)} → ${fmtTs(sub.end_time)}&nbsp;<span class="lang-tag">${sub.original_language}</span></div>
    <div class="card-original${isZh ? '' : ' en'}">${esc(line1)}</div>
    ${line2 ? `<div class="card-translated${isZh ? '' : ' en'}">${esc(line2)}</div>` : ''}
  `;

  if (isNew) {
    $('empty-state').style.display = 'none';
    scrollToBottom();
  }
}

// ── WebSocket: subtitle broadcast ──────────────────────────────────────────
function connectSubtitleWs() {
  const ws = new WebSocket(wsUrl('/ws/subtitles'));

  ws.onopen = () => {
    state.subtitleWs = ws;
    clearInterval(state._subtitlePingTimer);
    // Keepalive: NAT drops idle TCP after ~30 s; ping every 20 s
    state._subtitlePingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send('ping');
    }, 20000);
  };

  ws.onmessage = e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    const d = msg.data || {};

    if (msg.type === 'subtitle' && d.session_id === state.sessionId) {
      renderSubtitle(d);

    } else if (msg.type === 'upload_progress' && d.session_id === state.sessionId) {
      const phaseLabel = { converting: '转换格式…', reading: '读取音频…', processing: '识别中…' };
      // Server reports 0–100 %; map to bar range 50–100 % (XHR owns 0–50 %)
      const barPct = 50 + Math.round(d.pct / 2);
      showProgress(d.filename, barPct, phaseLabel[d.phase] || d.phase);

    } else if (msg.type === 'upload_error' && d.session_id === state.sessionId) {
      showProgressError(d.filename, d.message);
      toast(`处理出错: ${d.message.slice(0, 60)}`, 'error');

    } else if (msg.type === 'upload_done' && d.session_id === state.sessionId) {
      state.uploadProcessingDone = true;
      showProgress(d.filename, 100, '完成 ✓');
      setTimeout(hideProgress, 3000);
      updateBadge(true);
    }
  };

  ws.onclose = () => {
    state.subtitleWs = null;
    clearInterval(state._subtitlePingTimer);
    setTimeout(connectSubtitleWs, 2000);
  };
}

// ── Browser mic device enumeration ────────────────────────────────────────
async function loadBrowserDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return toast('不支持设备枚举', 'error');
  }
  try {
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { /* labels will be empty but still populate list */ }
    const devices = await navigator.mediaDevices.enumerateDevices();
    if (stream) stream.getTracks().forEach(t => t.stop());

    const sel = $('browser-mic-device');
    sel.innerHTML = '<option value="">默认</option>';
    let n = 0;
    devices.filter(d => d.kind === 'audioinput').forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.deviceId;
      opt.textContent = d.label || `麦克风 ${++n}`;
      sel.appendChild(opt);
    });
    toast(`找到 ${sel.options.length - 1} 个输入设备`);
  } catch (e) { toast('枚举设备失败: ' + e.message, 'error'); }
}

// ── Browser Mic → WebSocket audio ─────────────────────────────────────────
async function startBrowserMic() {
  if (!state.sessionId) return toast('请先创建或选择会话', 'error');
  if (state.browserMicActive) return;
  if (!navigator.mediaDevices?.getUserMedia) {
    return toast('麦克风需要 HTTPS 或 localhost 访问', 'error');
  }

  try {
    const deviceId = $('browser-mic-device')?.value;
    const audioConstraint = deviceId ? { deviceId: { exact: deviceId } } : true;
    state.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint, video: false });
    state.audioContext = new AudioContext();

    // Fetch worklet script from server and load via blob: (avoids script-src CSP)
    const resp = await fetch(apiUrl('/static/worklet.js'));
    if (!resp.ok) throw new Error('无法加载音频工作线程');
    const src  = await resp.text();
    const blob = new Blob([src], { type: 'application/javascript' });
    const burl = URL.createObjectURL(blob);
    await state.audioContext.audioWorklet.addModule(burl);
    URL.revokeObjectURL(burl);

    const source = state.audioContext.createMediaStreamSource(state.mediaStream);
    state.audioWorklet = new AudioWorkletNode(state.audioContext, 'pcm-sender');

    state.audioWs = new WebSocket(wsUrl(`/ws/audio/${state.sessionId}`));
    state.audioWs.binaryType = 'arraybuffer';
    state.audioWorklet.port.onmessage = e => {
      if (state.audioWs?.readyState === WebSocket.OPEN) state.audioWs.send(e.data);
    };

    source.connect(state.audioWorklet);
    state.audioWorklet.connect(state.audioContext.destination);

    state.browserMicActive = true;
    const btn = $('btn-browser-mic');
    btn.textContent = '⏹ 停止麦克风';
    btn.classList.add('danger');
    updateBadge(true);
    toast('本地麦克风已启动', 'success');
  } catch (e) {
    toast(`麦克风错误: ${e.message}`, 'error');
  }
}

async function stopBrowserMic() {
  if (!state.browserMicActive) return;
  state.audioWorklet?.disconnect();
  state.audioContext?.close();
  state.mediaStream?.getTracks().forEach(t => t.stop());
  state.audioWs?.close();
  state.browserMicActive = false;
  state.audioContext = null;
  state.audioWs = null;
  const btn = $('btn-browser-mic');
  btn.textContent = '🎙 麦克风';
  btn.classList.remove('danger');
}

function toggleBrowserMic() {
  state.browserMicActive ? stopBrowserMic() : startBrowserMic();
}

// ── Server-side mic ────────────────────────────────────────────────────────
async function micStart() {
  if (!state.sessionId) return toast('请先创建或选择会话', 'error');
  const device = $('mic-device').value || null;
  try {
    await api('POST', '/api/sources/mic/start', {
      session_id: state.sessionId,
      device: device ? parseInt(device) : null,
    });
    updateBadge(true);
    toast('服务器麦克风已启动', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

async function micStop() {
  try { await api('POST', '/api/sources/mic/stop'); toast('服务器麦克风已停止'); } catch {}
}

// ── System audio ───────────────────────────────────────────────────────────
async function systemStart() {
  if (!state.sessionId) return toast('请先创建或选择会话', 'error');
  try {
    const r = await api('POST', '/api/sources/system/start', { session_id: state.sessionId });
    updateBadge(true);
    toast(`系统音频: ${r.device}`, 'success');
  } catch (e) { toast(e.message, 'error'); }
}

async function systemStop() {
  try { await api('POST', '/api/sources/system/stop'); toast('系统音频已停止'); } catch {}
}

// ── File upload ────────────────────────────────────────────────────────────
function uploadFile() {
  if (!state.sessionId) return toast('请先创建或选择会话', 'error');
  const input = $('file-input');
  if (!input.files.length) return toast('请先选择文件', 'error');
  const file = input.files[0];

  state.uploadProcessingDone = false;
  showProgress(file.name, 0, '上传中…');
  hideError();

  const form = new FormData();
  form.append('file', file);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', apiUrl(`/api/sessions/${state.sessionId}/upload`));

  // XHR upload → 0–50 %; WS processing events → 50–100 %
  // Guard: stop if WS upload_done already arrived and closed the bar
  xhr.upload.onprogress = e => {
    if (e.lengthComputable && !state.uploadProcessingDone) {
      const pct = Math.round(e.loaded / e.total * 50);
      showProgress(file.name, pct, `上传中… ${pct * 2}%`);
    }
  };

  xhr.onload = () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      input.value = '';
      updateBadge(true);
      if (!state.uploadProcessingDone) {
        $('upload-phase').textContent = '处理中…';
      }
    } else {
      let msg = xhr.statusText;
      try { msg = JSON.parse(xhr.responseText).detail || msg; } catch {}
      showProgressError(file.name, `上传失败: ${msg}`);
      toast(msg, 'error');
    }
  };

  xhr.onerror = () => {
    showProgressError(file.name, '网络错误，上传失败');
    toast('网络错误', 'error');
  };

  xhr.send(form);
}

function showProgress(filename, pct, phase) {
  $('upload-progress-wrap').classList.remove('hidden');
  $('upload-filename').textContent = filename;
  $('upload-pct').textContent = pct + '%';
  $('upload-bar').style.width = pct + '%';
  $('upload-phase').textContent = phase;
}

function hideProgress() {
  $('upload-progress-wrap').classList.add('hidden');
}

function showProgressError(filename, msg) {
  $('upload-bar').classList.add('error');
  $('upload-phase').textContent = '出错';
  const box = $('upload-error-box');
  box.classList.remove('hidden');
  box.textContent = `${filename}: ${msg}`;
}

function hideError() {
  $('upload-error-box').classList.add('hidden');
  $('upload-bar').classList.remove('error');
}

// ── Server device list ─────────────────────────────────────────────────────
async function loadDevices() {
  try {
    const devices = await api('GET', '/api/devices');
    const sel = $('mic-device');
    sel.innerHTML = '<option value="">默认</option>';
    devices.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.index;
      opt.textContent = `[${d.index}] ${d.name}${d.is_monitor ? ' (monitor)' : ''}`;
      sel.appendChild(opt);
    });
  } catch {}
}

// ── Helpers ────────────────────────────────────────────────────────────────
function updateBadge(live) {
  const badge = $('session-badge');
  badge.textContent = live ? '● LIVE' : '';
  badge.className = 'badge' + (live ? ' live' : '');
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    const feed = $('subtitle-feed');
    feed.scrollTop = feed.scrollHeight;
  });
}

function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function fmtTs(s) {
  const m = Math.floor(s / 60), sec = (s % 60).toFixed(1).padStart(4, '0');
  return `${String(m).padStart(2, '0')}:${sec}`;
}

function fmtDur(s) {
  if (s < 60) return `${Math.round(s)}s`;
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

// ── Sentence gap slider ────────────────────────────────────────────────────
let _sentenceGapDebounce;

function onSentenceGapChange(val) {
  const v = parseFloat(val);
  $('sentence-gap-label').textContent = v.toFixed(1) + 's';
  clearTimeout(_sentenceGapDebounce);
  _sentenceGapDebounce = setTimeout(() => {
    api('POST', '/api/settings', { sentence_gap_s: v }).catch(() => {});
  }, 300);
}

async function loadSettings() {
  try {
    const r = await api('GET', '/api/settings');
    if (r?.sentence_gap_s !== undefined) {
      $('sentence-gap').value = r.sentence_gap_s;
      $('sentence-gap-label').textContent = r.sentence_gap_s.toFixed(1) + 's';
    }
  } catch {}
}

// ── Auto-update banner ─────────────────────────────────────────────────────
function setupUpdater() {
  if (!window.ea) return;

  window.ea.onUpdateAvailable(info => {
    $('update-msg').textContent = `新版本 ${info.version} 正在下载…`;
    $('update-btn').textContent = '下载中';
    $('update-btn').disabled = true;
    $('update-bar').classList.remove('hidden');
  });

  window.ea.onDownloadProgress(prog => {
    const pct = Math.round(prog.percent ?? 0);
    $('update-msg').textContent = `正在下载更新… ${pct}%`;
  });

  window.ea.onUpdateDownloaded(info => {
    $('update-msg').textContent = `版本 ${info.version} 已下载，重启后安装`;
    $('update-btn').textContent = '立即重启';
    $('update-btn').disabled = false;
    $('update-bar').classList.remove('hidden');
  });

  $('update-btn').addEventListener('click', () => window.ea.installUpdate());
  $('update-dismiss').addEventListener('click', () => $('update-bar').classList.add('hidden'));
}

// ── Init ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  // Restore persisted server URL from Electron settings
  if (window.ea) {
    try {
      const s = await window.ea.getSettings();
      if (s?.serverUrl) {
        state.serverUrl = s.serverUrl;
        $('server-url').value = s.serverUrl;
      } else {
        $('server-url').value = state.serverUrl;
      }
    } catch {
      $('server-url').value = state.serverUrl;
    }
  } else {
    $('server-url').value = state.serverUrl;
  }

  setupUpdater();
  checkHealth();
  setInterval(checkHealth, 15000);
  loadSessions();
  setInterval(loadSessions, 10000);
  loadDevices();
  loadBrowserDevices();
  loadSettings();
  connectSubtitleWs();
});
