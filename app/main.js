'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, nativeTheme, Menu } = require('electron');
const { autoUpdater } = require('electron-updater');
const path = require('path');
const fs   = require('fs');

// ─── Settings ────────────────────────────────────────────────────────────────

const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');
const DEFAULTS = { serverUrl: 'http://localhost:8000', sentenceGapS: 1.5 };

function loadSettings() {
  try { return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')) }; }
  catch { return { ...DEFAULTS }; }
}
function saveSettings(s) { fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2)); }

// ─── Windows ─────────────────────────────────────────────────────────────────

let win;

function createWindow() {
  win = new BrowserWindow({
    width:  1060,
    height: 700,
    minWidth:  820,
    minHeight: 520,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 16 },
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#1c1c1e' : '#f2f2f7',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Grant microphone & media permissions
  win.webContents.session.setPermissionRequestHandler((_wc, perm, cb) => {
    cb(['media', 'microphone', 'notifications', 'clipboard-read'].includes(perm));
  });
  win.webContents.session.setPermissionCheckHandler((_wc, perm) =>
    ['media', 'microphone'].includes(perm)
  );

  win.loadFile(path.join(__dirname, 'src', 'index.html'));
}

// ─── App menu ────────────────────────────────────────────────────────────────

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    { role: 'editMenu' },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
    {
      label: '帮助',
      submenu: [
        { label: '检查更新', click: () => autoUpdater.checkForUpdates().catch(() => {}) },
        { type: 'separator' },
        { label: '打开数据目录', click: () => shell.openPath(app.getPath('userData')) },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─── IPC ─────────────────────────────────────────────────────────────────────

ipcMain.handle('settings:get', () => loadSettings());
ipcMain.handle('settings:set', (_, s) => { saveSettings(s); return s; });

ipcMain.handle('updater:check',   () => autoUpdater.checkForUpdates().catch(e => ({ error: e.message })));
ipcMain.handle('updater:install', () => { autoUpdater.quitAndInstall(false, true); });

// Save a file fetched from the server (for exports)
ipcMain.handle('file:save', async (_, { url, defaultName }) => {
  const { filePath } = await dialog.showSaveDialog(win, { defaultPath: defaultName });
  if (!filePath) return null;
  const res  = await fetch(url);
  const buf  = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(filePath, buf);
  return filePath;
});

ipcMain.handle('shell:openExternal', (_, url) => shell.openExternal(url));

// ─── Auto-updater ────────────────────────────────────────────────────────────

function setupUpdater() {
  autoUpdater.autoDownload        = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger               = null; // silence verbose logs

  autoUpdater.on('update-available',  info => win?.webContents.send('update-available',  info));
  autoUpdater.on('update-downloaded', info => win?.webContents.send('update-downloaded', info));
  autoUpdater.on('download-progress', prog => win?.webContents.send('download-progress', prog));
  autoUpdater.on('error', err => console.log('[updater] error:', err.message));

  // Delay first check so the window is ready
  setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 4000);
  // Periodic check every 4 hours
  setInterval(() => autoUpdater.checkForUpdates().catch(() => {}), 4 * 60 * 60 * 1000);
}

// ─── Lifecycle ───────────────────────────────────────────────────────────────

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  if (app.isPackaged) setupUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
