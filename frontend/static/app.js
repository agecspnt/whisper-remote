/**
 * whisper-remote — Dashboard logic
 *
 * Responsibilities:
 *  - Session management (create / select / stop / export)
 *  - Audio source control (mic / system / file / browser mic)
 *  - WebSocket: browser mic → /ws/audio/{session_id}
 *  - WebSocket: subtitles  ← /ws/subtitles
 *  - Render subtitle cards in the feed
 */

// ============================================================
// State
// ============================================================
let _livePollTimer = null;

const state = {
  sessionId: null,
  sessionName: '',
  isLive: false,
  browserMicActive: false,
  subtitleWs: null,
  audioWs: null,
  audioContext: null,
  audioWorklet: null,
  mediaStream: null,
  // Upload progress coordination
  uploadProcessingDone: false,   // true if upload_done WS arrived before xhr.onload
  uploadCurrentFile: '',
  _subtitlePingTimer: null,
};

// ============================================================
// DOM refs
// ============================================================
const $ = id => document.getElementById(id);
const $sessionList   = $('session-list');
const $subtitleFeed  = $('subtitle-feed');
const $emptyState    = $('empty-state');
const $sessionTitle  = $('session-title');
const $sessionBadge  = $('session-badge');
const $statusDot     = $('status-dot');
const $toast         = $('toast');

// ============================================================
// Toast
// ============================================================
let _toastTimer;
function toast(msg, type = 'info') {
  $toast.textContent = msg;
  $toast.className = `show ${type}`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => { $toast.className = ''; }, 3000);
}

// ============================================================
// API helpers
// ============================================================
async function api(method, path, body) {
  const opts = { method, headers: {} };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch(path, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ detail: res.statusText }));
    throw new Error(err.detail || res.statusText);
  }
  return res.json().catch(() => null);
}

// ============================================================
// Health check
// ============================================================
async function checkHealth() {
  try {
    await api('GET', '/api/health');
    $statusDot.className = 'status-dot ok';
  } catch {
    $statusDot.className = 'status-dot err';
  }
}

// ============================================================
// Session list
// ============================================================
async function loadSessions() {
  try {
    const sessions = await api('GET', '/api/sessions');
    $sessionList.innerHTML = '';
    sessions.forEach(s => {
      const div = document.createElement('div');
      div.className = 'session-item' + (s.id === state.sessionId ? ' active' : '');
      div.dataset.id = s.id;
      div.innerHTML = `
        <div>
          <div class="session-name">${esc(s.name)}</div>
          <div class="session-meta">${fmtDur(s.duration)} · ${s.subtitle_count} lines</div>
        </div>
        ${s.active ? '<span class="session-live">LIVE</span>' : ''}
      `;
      div.addEventListener('click', () => selectSession(s.id, s.name));
      $sessionList.appendChild(div);
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
    toast(`Session "${s.name}" created`, 'success');
  } catch (e) { toast(e.message, 'error'); }
}

// ============================================================
// Live poll — fallback for WS misses (reconnect gap, NAT drop, etc.)
// ============================================================
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
  $sessionTitle.textContent = name;

  // Load existing subtitles
  try {
    const s = await api('GET', `/api/sessions/${id}`);
    $subtitleFeed.innerHTML = '';
    s.subtitles.forEach(renderSubtitle);
    updateBadge(s.active);
    scrollToBottom();
  } catch {}
  startLivePoll();  // keep feed in sync even when WS misses a message
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
    toast('Session stopped', 'success');
    updateBadge(false);
    loadSessions();
  } catch (e) { toast(e.message, 'error'); }
}

// ============================================================
// Export
// ============================================================
async function exportSession(fmt) {
  if (!state.sessionId) return toast('No session selected', 'error');
  window.location = `/api/sessions/${state.sessionId}/export/${fmt}`;
}

// ============================================================
// Subtitle rendering
// ============================================================
function renderSubtitle(sub) {
  if (!sub.original_text) return;

  // Check for existing card with same id (interim update)
  let card = document.querySelector(`[data-sub-id="${sub.id}"]`);
  const isNew = !card;
  if (!card) {
    card = document.createElement('div');
    card.dataset.subId = sub.id;
    $subtitleFeed.appendChild(card);
  }

  const display = sub.display || {};
  const isZh = sub.original_language === 'zh' || sub.original_language === 'yue';
  const line1 = isZh ? (display.zh || sub.original_text) : (display.en || sub.original_text);
  const line2 = isZh ? (display.en || sub.translated_text) : (display.zh || sub.translated_text);

  card.className = 'subtitle-card' + (sub.is_interim ? ' interim' : '');
  card.innerHTML = `
    <div class="subtitle-ts">${fmtTs(sub.start_time)} → ${fmtTs(sub.end_time)}
      &nbsp;·&nbsp; <span class="lang-tag">${sub.original_language}</span>
    </div>
    <div class="subtitle-original ${isZh ? '' : 'lang-en'}">${esc(line1)}</div>
    ${line2 ? `<div class="subtitle-translated ${isZh ? '' : 'lang-en'}">${esc(line2)}</div>` : ''}
  `;

  if (isNew) {
    $emptyState.style.display = 'none';
    scrollToBottom();
  }
}

// ============================================================
// WebSocket: subtitle broadcast
// ============================================================
function connectSubtitleWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws/subtitles`);

  ws.onopen = () => {
    state.subtitleWs = ws;
    // Keepalive: Oracle NAT drops idle TCP after ~30 s; ping every 20 s.
    clearInterval(state._subtitlePingTimer);
    state._subtitlePingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) ws.send('ping');
    }, 20000);
  };
  ws.onmessage = e => {
    const msg = JSON.parse(e.data);
    const d = msg.data || {};

    if (msg.type === 'subtitle' && d.session_id === state.sessionId) {
      renderSubtitle(d);

    } else if (msg.type === 'upload_progress' && d.session_id === state.sessionId) {
      const phaseLabel = { converting: '转换格式…', reading: '读取音频…', processing: '识别中…' };
      // Map server pct 0–100 → bar 50–100 so bar never goes backwards after upload.
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
    setTimeout(connectSubtitleWs, 2000);  // auto-reconnect
  };
}

// ============================================================
// Browser Mic device enumeration
// ============================================================
async function loadBrowserDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) {
    return toast('浏览器不支持设备枚举（需要 HTTPS）', 'error');
  }
  try {
    // Request mic permission first so labels are populated.
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: true }); }
    catch { /* permission denied — labels will be empty, still populate list */ }
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
    toast(`找到 ${sel.options.length - 1} 个输入设备`, 'info');
  } catch (e) { toast('枚举设备失败: ' + e.message, 'error'); }
}

// ============================================================
// Browser Mic → WebSocket audio
// ============================================================
async function startBrowserMic() {
  if (!state.sessionId) return toast('Create or select a session first', 'error');
  if (state.browserMicActive) return;

  if (!navigator.mediaDevices?.getUserMedia) {
    return toast('麦克风需要 HTTPS 访问（当前为 HTTP，浏览器已拦截）', 'error');
  }

  try {
    const deviceId = $('browser-mic-device')?.value;
    const audioConstraint = deviceId ? { deviceId: { exact: deviceId } } : true;
    state.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraint, video: false });
    // Don't force 16 kHz — let the browser use its preferred rate.
    // The AudioWorklet (worklet.js) resamples down to 16 kHz before sending.
    state.audioContext = new AudioContext();

    // Add AudioWorklet processor
    await state.audioContext.audioWorklet.addModule('/static/worklet.js');
    const source = state.audioContext.createMediaStreamSource(state.mediaStream);
    state.audioWorklet = new AudioWorkletNode(state.audioContext, 'pcm-sender');

    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    state.audioWs = new WebSocket(`${proto}://${location.host}/ws/audio/${state.sessionId}`);
    state.audioWs.binaryType = 'arraybuffer';

    state.audioWorklet.port.onmessage = e => {
      if (state.audioWs && state.audioWs.readyState === WebSocket.OPEN) {
        state.audioWs.send(e.data);
      }
    };

    source.connect(state.audioWorklet);
    state.audioWorklet.connect(state.audioContext.destination);  // needed by some browsers

    state.browserMicActive = true;
    $('btn-browser-mic').textContent = '⏹ Stop Browser Mic';
    $('btn-browser-mic').className = 'btn btn-danger btn-sm';
    updateBadge(true);
    toast('Browser mic started', 'success');
  } catch (e) {
    toast(`Mic error: ${e.message}`, 'error');
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
  $('btn-browser-mic').textContent = '🎙 Browser Mic';
  $('btn-browser-mic').className = 'btn btn-ghost btn-sm';
}

function toggleBrowserMic() {
  state.browserMicActive ? stopBrowserMic() : startBrowserMic();
}

// ============================================================
// Server-side mic
// ============================================================
async function micStart() {
  if (!state.sessionId) return toast('Create or select a session first', 'error');
  const device = $('mic-device').value || null;
  try {
    await api('POST', '/api/sources/mic/start', {
      session_id: state.sessionId,
      device: device ? parseInt(device) : null,
    });
    updateBadge(true);
    toast('Server mic started', 'success');
  } catch (e) { toast(e.message, 'error'); }
}

async function micStop() {
  try { await api('POST', '/api/sources/mic/stop'); toast('Server mic stopped'); } catch {}
}

// ============================================================
// System audio
// ============================================================
async function systemStart() {
  if (!state.sessionId) return toast('Create or select a session first', 'error');
  try {
    const r = await api('POST', '/api/sources/system/start', { session_id: state.sessionId });
    updateBadge(true);
    toast(`System audio: ${r.device}`, 'success');
  } catch (e) { toast(e.message, 'error'); }
}

async function systemStop() {
  try { await api('POST', '/api/sources/system/stop'); toast('System audio stopped'); } catch {}
}

// ============================================================
// File upload — XHR for upload progress + WS for processing progress
// ============================================================
function uploadFile() {
  if (!state.sessionId) return toast('请先创建或选择会话', 'error');
  const input = $('file-input');
  if (!input.files.length) return toast('请先选择文件', 'error');
  const file = input.files[0];

  // Reset state
  state.uploadProcessingDone = false;
  state.uploadCurrentFile = file.name;
  showProgress(file.name, 0, '上传中…');
  hideError();

  const form = new FormData();
  form.append('file', file);

  const xhr = new XMLHttpRequest();
  xhr.open('POST', `/api/sessions/${state.sessionId}/upload`);

  // XHR upload maps to 0–50 %; WS processing events own 50–100 %.
  // Guard: if WS upload_done already arrived, never let XHR events resurrect the bar.
  xhr.upload.onprogress = e => {
    if (e.lengthComputable && !state.uploadProcessingDone) {
      const pct = Math.round(e.loaded / e.total * 50);   // 0→50
      showProgress(file.name, pct, `上传中… ${pct * 2}%`);
    }
  };

  xhr.onload = () => {
    if (xhr.status >= 200 && xhr.status < 300) {
      input.value = '';
      updateBadge(true);
      // If WS already finished (uploadProcessingDone = true), don't touch the bar —
      // the WS handler already showed "完成 ✓" and scheduled hideProgress.
      if (!state.uploadProcessingDone) {
        // Still waiting for WS processing events; just update the label.
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
  const wrap = $('upload-progress-wrap');
  wrap.style.display = 'block';
  $('upload-filename').textContent = filename;
  $('upload-pct').textContent = pct + '%';
  $('upload-bar').style.width = pct + '%';
  $('upload-phase').textContent = phase;
}

function hideProgress() {
  $('upload-progress-wrap').style.display = 'none';
}

function showProgressError(filename, msg) {
  // Keep the bar visible but turn it red
  $('upload-bar').style.background = 'var(--danger)';
  $('upload-phase').style.color = 'var(--danger)';
  $('upload-phase').textContent = '出错';
  // Show error box
  const box = $('upload-error-box');
  box.style.display = 'block';
  box.textContent = `${filename}: ${msg}`;
}

function hideError() {
  $('upload-error-box').style.display = 'none';
  $('upload-bar').style.background = 'var(--accent)';
  $('upload-phase').style.color = 'var(--text-muted)';
}

// ============================================================
// Device list
// ============================================================
async function loadDevices() {
  try {
    const devices = await api('GET', '/api/devices');
    const sel = $('mic-device');
    sel.innerHTML = '<option value="">Default</option>';
    devices.forEach(d => {
      const opt = document.createElement('option');
      opt.value = d.index;
      opt.textContent = `[${d.index}] ${d.name}${d.is_monitor ? ' (monitor)' : ''}`;
      sel.appendChild(opt);
    });
  } catch {}
}

// ============================================================
// Helpers
// ============================================================
function updateBadge(live) {
  $sessionBadge.textContent = live ? '● LIVE' : 'Stopped';
  $sessionBadge.className = 'session-status-badge' + (live ? ' live' : '');
}

function scrollToBottom() {
  requestAnimationFrame(() => {
    $subtitleFeed.scrollTop = $subtitleFeed.scrollHeight;
  });
}

function esc(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function fmtTs(s) {
  const m = Math.floor(s / 60), sec = (s % 60).toFixed(1).padStart(4, '0');
  return `${String(m).padStart(2,'0')}:${sec}`;
}

function fmtDur(s) {
  if (s < 60) return `${Math.round(s)}s`;
  return `${Math.floor(s/60)}m${Math.round(s%60)}s`;
}

// ============================================================
// Transcription settings (sentence gap)
// ============================================================
let _sentenceGapDebounce;

function onSentenceGapChange(val) {
  const v = parseFloat(val);
  $('sentence-gap-label').textContent = v.toFixed(1) + 's';
  // Debounce: only send to server 300 ms after the slider stops moving
  clearTimeout(_sentenceGapDebounce);
  _sentenceGapDebounce = setTimeout(() => {
    api('POST', '/api/settings', { sentence_gap_s: v }).catch(() => {});
  }, 300);
}

async function loadSettings() {
  try {
    const r = await api('GET', '/api/settings');
    if (r.sentence_gap_s !== undefined) {
      $('sentence-gap').value = r.sentence_gap_s;
      $('sentence-gap-label').textContent = r.sentence_gap_s.toFixed(1) + 's';
    }
  } catch {}
}

// ============================================================
// Init
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
  checkHealth();
  setInterval(checkHealth, 15000);
  loadSessions();
  setInterval(loadSessions, 10000);
  loadDevices();
  loadSettings();
  connectSubtitleWs();
});
