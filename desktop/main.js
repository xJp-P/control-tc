// desktop/main.js — Electron main process
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { execSync, exec } = require('child_process');
const createApp = require('../backend/app');
const { getDbPath, getDbConfigPath, DEFAULT_DB_DIR, initDb } = require('../backend/config/db');

let mainWindow;
let server;
let db;
let macUpdateVersion = null;
let macUpdateScript = null;
const PORT = 3500;

function startServer() {
  const result = createApp();
  db = result.db;
  return new Promise((resolve) => {
    server = result.app.listen(PORT, '127.0.0.1', () => {
      console.log(`Backend running on http://127.0.0.1:${PORT}`);
      resolve();
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    show: false
  });

  mainWindow.maximize();
  mainWindow.show();
  mainWindow.loadURL(`http://127.0.0.1:${PORT}`);

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ─── IPC Handlers ──────────────────────────────────────────────
ipcMain.handle('get-version', () => app.getVersion());

ipcMain.handle('backup-db', async () => {
  const { filePath } = await dialog.showSaveDialog(mainWindow, {
    title: 'Guardar Backup',
    defaultPath: `backup_tarjeta_${new Date().toISOString().slice(0, 10)}.db`,
    filters: [{ name: 'SQLite Database', extensions: ['db'] }]
  });
  if (!filePath) return { ok: false, cancelled: true };
  try {
    db.backup(filePath);
    return { ok: true, path: filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('restore-db', async () => {
  const { filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Restaurar Backup',
    filters: [{ name: 'SQLite Database', extensions: ['db'] }],
    properties: ['openFile']
  });
  if (!filePaths || filePaths.length === 0) return { ok: false, cancelled: true };
  try {
    const dbPath = db.name;
    db.close();
    fs.copyFileSync(filePaths[0], dbPath);

    // Aplicar migraciones idempotentes para que un backup de una versión anterior
    // de la app reciba las columnas que se hayan agregado en versiones posteriores
    // (es_internacional, intereses_intl, monto_bolsillo, franquicia, etc.).
    // initDb usa CREATE TABLE IF NOT EXISTS y try/catch + ALTER TABLE ADD COLUMN,
    // por lo que es seguro correr sobre cualquier estado de schema.
    db = initDb(dbPath);
    db.close(); // cerramos la conexión de main; el backend usa la suya.

    return {
      ok: true,
      msg: 'Base de datos restaurada y schema actualizado. La app se reiniciará para que los cambios surtan efecto.',
      needsRestart: true
    };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('get-db-location', () => {
  const currentPath = getDbPath();
  const defaultPath = path.join(DEFAULT_DB_DIR, 'data.db');
  return { currentPath, defaultPath, isDefault: currentPath === defaultPath };
});

ipcMain.handle('move-db', async () => {
  const { filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: 'Seleccionar carpeta destino para la base de datos',
    properties: ['openDirectory']
  });
  if (!filePaths || filePaths.length === 0) return { ok: false, cancelled: true };

  const currentDbPath = getDbPath();
  const newDbPath = path.join(filePaths[0], 'data.db');

  if (currentDbPath === newDbPath) return { ok: false, error: 'La BD ya está en esa ubicación.' };

  try {
    if (db) db.close();
    fs.mkdirSync(filePaths[0], { recursive: true });

    if (fs.existsSync(newDbPath)) {
      fs.unlinkSync(currentDbPath);
    } else {
      fs.copyFileSync(currentDbPath, newDbPath);
      fs.unlinkSync(currentDbPath);
    }

    fs.mkdirSync(DEFAULT_DB_DIR, { recursive: true });
    fs.writeFileSync(getDbConfigPath(), JSON.stringify({ dbPath: newDbPath }), 'utf8');
    return { ok: true, newPath: newDbPath, existed: fs.existsSync(newDbPath) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('relaunch-app', () => {
  app.relaunch();
  app.exit(0);
});

ipcMain.handle('restore-db-location', async () => {
  const currentDbPath = getDbPath();
  const defaultPath = path.join(DEFAULT_DB_DIR, 'data.db');

  if (currentDbPath === defaultPath) return { ok: false, error: 'La BD ya está en la ubicación original.' };

  try {
    if (db) db.close();
    fs.mkdirSync(DEFAULT_DB_DIR, { recursive: true });
    fs.copyFileSync(currentDbPath, defaultPath);
    fs.unlinkSync(currentDbPath);
    const configPath = getDbConfigPath();
    if (fs.existsSync(configPath)) fs.unlinkSync(configPath);
    return { ok: true, newPath: defaultPath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ─── Auto-updater ──────────────────────────────────────────────
function httpsGet(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGet(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode));
      resolve(res);
    }).on('error', reject);
  });
}

function macDownloadAndInstall(version) {
  const zipUrl = `https://github.com/xJp-P/control-tc/releases/download/v${version}/Instalador-Mac-${version}.zip`;
  const tmpDir = path.join(os.tmpdir(), 'cc-update-' + Date.now());
  const zipPath = path.join(tmpDir, 'update.zip');

  fs.mkdirSync(tmpDir, { recursive: true });
  if (mainWindow) mainWindow.webContents.send('download-progress', { percent: 0 });

  httpsGet(zipUrl).then((res) => {
    const total = parseInt(res.headers['content-length'] || '0', 10);
    let downloaded = 0;
    const file = fs.createWriteStream(zipPath);

    res.on('data', (chunk) => {
      downloaded += chunk.length;
      if (total > 0 && mainWindow) {
        mainWindow.webContents.send('download-progress', { percent: Math.round((downloaded / total) * 100) });
      }
    });

    res.pipe(file);
    file.on('finish', () => {
      file.close();
      try {
        execSync(`unzip -o -q "${zipPath}" -d "${tmpDir}"`);
        const extractedApp = path.join(tmpDir, 'Control TC.app');
        if (!fs.existsSync(extractedApp)) {
          console.log('Mac update: app not found in zip');
          return;
        }
        execSync(`xattr -cr "${extractedApp}"`);
        const appPath = path.dirname(path.dirname(path.dirname(app.getAppPath())));
        const scriptPath = path.join(tmpDir, 'update.sh');
        const script = `#!/bin/bash
sleep 2
rm -rf "${appPath}"
cp -R "${extractedApp}" "${appPath}"
xattr -cr "${appPath}"
open "${appPath}"
rm -rf "${tmpDir}"
`;
        fs.writeFileSync(scriptPath, script, { mode: 0o755 });
        macUpdateScript = scriptPath;
        if (mainWindow) mainWindow.webContents.send('update-downloaded');
      } catch (err) {
        console.log('Mac update error:', err.message);
        try { fs.rmSync(tmpDir, { recursive: true }); } catch(_) {}
      }
    });
  }).catch((err) => {
    console.log('Mac download error:', err.message);
    try { fs.rmSync(tmpDir, { recursive: true }); } catch(_) {}
  });
}

function setupAutoUpdater() {
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on('update-available', (info) => {
      macUpdateVersion = info.version;
      if (mainWindow) mainWindow.webContents.send('update-available', info);
    });

    autoUpdater.on('download-progress', (progress) => {
      if (mainWindow) mainWindow.webContents.send('download-progress', progress);
    });

    autoUpdater.on('update-downloaded', () => {
      if (mainWindow) mainWindow.webContents.send('update-downloaded');
    });

    autoUpdater.on('error', (err) => {
      if (process.platform === 'darwin') return;
      console.log('Update error:', err.message);
    });

    ipcMain.handle('download-update', () => {
      if (process.platform === 'darwin' && macUpdateVersion) {
        macDownloadAndInstall(macUpdateVersion);
        return;
      }
      autoUpdater.downloadUpdate();
    });

    ipcMain.handle('install-update', () => {
      if (process.platform === 'darwin' && macUpdateScript) {
        exec(`bash "${macUpdateScript}"`);
        setTimeout(() => { app.quit(); }, 500);
        return;
      }
      autoUpdater.quitAndInstall(false, true);
    });

    if (app.isPackaged) {
      setTimeout(() => autoUpdater.checkForUpdates().catch(() => {}), 5000);
    }
  } catch (e) {
    console.log('Auto-updater not available (dev mode):', e.message);
  }
}

// ─── App lifecycle ─────────────────────────────────────────────
app.whenReady().then(async () => {
  await startServer();
  createWindow();
  setupAutoUpdater();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (server) server.close();
  if (db) db.close();
  app.quit();
});
