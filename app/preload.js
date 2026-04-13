'use strict';
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ea', {
  // Settings
  getSettings:  ()  => ipcRenderer.invoke('settings:get'),
  setSettings:  (s) => ipcRenderer.invoke('settings:set', s),

  // Updater
  checkUpdates:  () => ipcRenderer.invoke('updater:check'),
  installUpdate: () => ipcRenderer.invoke('updater:install'),
  onUpdateAvailable:  (cb) => ipcRenderer.on('update-available',  (_, i) => cb(i)),
  onUpdateDownloaded: (cb) => ipcRenderer.on('update-downloaded', (_, i) => cb(i)),
  onDownloadProgress: (cb) => ipcRenderer.on('download-progress', (_, p) => cb(p)),

  // File export (save dialog)
  saveFile: (url, defaultName) => ipcRenderer.invoke('file:save', { url, defaultName }),

  // Open URL in default browser
  openExternal: (url) => ipcRenderer.invoke('shell:openExternal', url),
});
