// desktop/preload.js — contextBridge for Electron ↔ frontend communication
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getVersion: () => ipcRenderer.invoke('get-version'),
  backupDb: () => ipcRenderer.invoke('backup-db'),
  restoreDb: () => ipcRenderer.invoke('restore-db'),
  getDbLocation: () => ipcRenderer.invoke('get-db-location'),
  moveDb: () => ipcRenderer.invoke('move-db'),
  restoreDbLocation: () => ipcRenderer.invoke('restore-db-location'),
  relaunchApp: () => ipcRenderer.invoke('relaunch-app'),
  downloadUpdate: () => ipcRenderer.invoke('download-update'),
  installUpdate: () => ipcRenderer.invoke('install-update'),
  onUpdateAvailable: (callback) => ipcRenderer.on('update-available', (_, info) => callback(info)),
  onDownloadProgress: (callback) => ipcRenderer.on('download-progress', (_, progress) => callback(progress)),
  onUpdateDownloaded: (callback) => ipcRenderer.on('update-downloaded', () => callback()),
  // IA Asistente — credenciales (IPC puro; la key nunca vuelve al frontend)
  iaGetConfig: () => ipcRenderer.invoke('ia-get-config'),
  iaSaveKey: (payload) => ipcRenderer.invoke('ia-save-key', payload),
  iaClearKey: () => ipcRenderer.invoke('ia-clear-key'),
  openExternal: (url) => ipcRenderer.invoke('open-external', url)
});
