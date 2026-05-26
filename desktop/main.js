// desktop/main.js — Electron main process con boot protegido (splash + update check pre-BD)
const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const https = require('https');
const { execSync, exec } = require('child_process');
// IMPORTANTE: createApp NO se importa aquí — se hace lazy-require dentro de startBackend()
// para garantizar que la BD no se abra hasta que pasemos por el update check.
const { getDbPath, getDbConfigPath, DEFAULT_DB_DIR, initDb } = require('../backend/config/db');

const PORT = 3500;
const GH_REPO = 'xJp-P/control-tc';
const BOOT_UPDATE_TIMEOUT_MS = 60 * 1000;

// Paleta tomada del tema dark de Control-TC (public/index.html :15-22)
const SPLASH_COLORS = {
  bg: '#0f1117',
  card: '#1e2130',
  border: '#2a2d3a',
  textPrimary: '#e8eaed',
  textSecondary: '#9aa0b0',
  textMuted: '#5f6578',
  accent: '#4f8cff',
  success: '#34d399',
  warning: '#fbbf24'
};

let mainWindow;
let splashWin;
let server;
let db;
let macUpdateVersion = null;        // usado por banner in-app (post-boot)
let macUpdateScript = null;
let pendingUpdateVersion = null;    // usado por boot flow (FASE 4a)

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ═══════════════════════════════════════════════════════════════════
// FASE 4b — Backend & BD (NUNCA se ejecuta antes del update check)
// ═══════════════════════════════════════════════════════════════════
function startBackend() {
  // Lazy require: el módulo backend/app.js solo se carga ahora, justo antes
  // de abrir la BD. Si una versión vieja tiene un bug que corrompe la BD al
  // arrancar, esta línea no se ejecuta si el splash detectó y aplicó la
  // actualización.
  const createApp = require('../backend/app');
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
    show: false   // se muestra explícitamente desde whenReady DESPUÉS de cerrar el splash
  });

  mainWindow.loadURL(`http://127.0.0.1:${PORT}`);

  if (process.env.NODE_ENV === 'development') {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ═══════════════════════════════════════════════════════════════════
// FASE 2 — Splash window (sin BD, sin servidor)
// ═══════════════════════════════════════════════════════════════════
function buildSplashHtml() {
  const c = SPLASH_COLORS;
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0;}
html,body{width:100%;height:100%;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:${c.bg};color:${c.textPrimary};-webkit-user-select:none;user-select:none;}
.wrap{height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:20px;}
#vLoading,#vOffline{width:100%;display:flex;flex-direction:column;align-items:center;}
#vOffline{display:none;}
#countdown{font-family:'SF Mono','Consolas',monospace;font-size:11px;color:${c.textMuted};letter-spacing:1px;margin-bottom:14px;min-height:14px;}
.spinner{width:42px;height:42px;border:3px solid ${c.border};border-top-color:${c.accent};border-radius:50%;animation:spin 1s linear infinite;margin-bottom:18px;}
@keyframes spin{to{transform:rotate(360deg);}}
.title{font-size:16px;font-weight:700;color:${c.textPrimary};margin-bottom:6px;letter-spacing:0.2px;}
#splashMsg{font-size:12px;color:${c.textSecondary};text-align:center;min-height:16px;margin-bottom:12px;padding:0 12px;}
.barWrap{width:240px;height:4px;background:${c.border};border-radius:99px;overflow:hidden;margin-bottom:14px;display:none;}
.barWrap.show{display:block;}
#splashBar{height:100%;width:0%;background:${c.accent};border-radius:99px;transition:width 0.2s ease;}
.version{font-size:10px;color:${c.textMuted};margin-top:4px;letter-spacing:0.5px;}
.warnIcon{width:56px;height:56px;border-radius:50%;background:rgba(251,191,36,0.12);display:flex;align-items:center;justify-content:center;margin-bottom:14px;font-size:28px;color:${c.warning};}
.offTitle{font-size:15px;font-weight:700;color:${c.textPrimary};margin-bottom:8px;}
.offMsg{font-size:12px;color:${c.textSecondary};text-align:center;padding:0 16px;margin-bottom:18px;line-height:1.5;}
.btnRow{display:flex;gap:10px;}
button{font-family:inherit;border:none;border-radius:8px;padding:9px 20px;font-size:12px;font-weight:600;cursor:pointer;transition:opacity 0.15s;}
button:hover{opacity:0.88;}
#btnContinue{background:${c.success};color:${c.bg};}
#btnQuit{background:${c.border};color:${c.textPrimary};}
</style></head><body><div class="wrap">
<div id="vLoading">
<div id="countdown">60s</div>
<div class="spinner"></div>
<div class="title">Control TC</div>
<div id="splashMsg">Buscando actualizaciones...</div>
<div class="barWrap" id="barWrap"><div id="splashBar"></div></div>
<div class="version" id="splashVersion"></div>
</div>
<div id="vOffline">
<div class="warnIcon">!</div>
<div class="offTitle">Problemas de conexion</div>
<div class="offMsg">No pudimos verificar si hay una actualizacion pendiente. Deseas continuar de todas formas?</div>
<div class="btnRow">
<button id="btnContinue">Continuar</button>
<button id="btnQuit">Cerrar app</button>
</div>
</div>
<div id="vUpdateError" style="display:none;">
<div class="warnIcon">!</div>
<div class="offTitle">Error al actualizar</div>
<div class="offMsg" id="updateErrorMsg">No se pudo descargar la actualizacion. Por favor cierra la app y abrela de nuevo para reintentar.</div>
<div class="btnRow">
<button id="btnQuitUpdate">Cerrar app</button>
</div>
</div>
</div>
<script>
var ipc=require('electron').ipcRenderer;
document.getElementById('btnContinue').addEventListener('click',function(){ipc.send('splash-decision','continue');});
document.getElementById('btnQuit').addEventListener('click',function(){ipc.send('splash-decision','quit');});
document.getElementById('btnQuitUpdate').addEventListener('click',function(){ipc.send('splash-update-error-quit');});
</script></body></html>`;
}

function createSplashWindow() {
  const win = new BrowserWindow({
    width: 440,
    height: 290,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    center: true,
    backgroundColor: SPLASH_COLORS.bg,
    skipTaskbar: false,
    icon: path.join(__dirname, '..', 'build', 'icon.png'),
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false
    },
    show: false
  });
  win.setMenu(null);
  const html = buildSplashHtml();
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  win.once('ready-to-show', () => {
    // Setea la versión actual abajo del splash apenas el DOM esté listo.
    const v = app.getVersion();
    win.webContents.executeJavaScript(
      `(function(){var el=document.getElementById('splashVersion');if(el)el.textContent='v${v}';})();`
    ).catch(() => {});
    win.show();
  });
  return win;
}

function splashAlive() {
  return splashWin && !splashWin.isDestroyed();
}

function updateSplashMessage(msg, percent) {
  if (!splashAlive()) return;
  const safe = String(msg || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, ' ');
  let js = `(function(){var m=document.getElementById('splashMsg');if(m)m.textContent='${safe}';`;
  if (typeof percent === 'number' && percent >= 0) {
    const p = Math.max(0, Math.min(100, Math.round(percent)));
    js += `var b=document.getElementById('barWrap');if(b)b.classList.add('show');`;
    js += `var bar=document.getElementById('splashBar');if(bar)bar.style.width='${p}%';`;
  }
  js += `})();`;
  splashWin.webContents.executeJavaScript(js).catch(() => {});
}

function updateSplashCountdown(seconds) {
  if (!splashAlive()) return;
  const s = Math.max(0, Math.round(seconds));
  splashWin.webContents.executeJavaScript(
    `(function(){var c=document.getElementById('countdown');if(c)c.textContent='${s}s';})();`
  ).catch(() => {});
}

function showUpdateErrorInSplash(version) {
  return new Promise((resolve) => {
    if (!splashAlive()) return resolve();
    const v = String(version || '').replace(/'/g, "\\'");
    const msg = v
      ? `No se pudo descargar la actualizacion v${v}. Por favor cierra la app y abrela de nuevo para reintentar.`
      : `No se pudo descargar la actualizacion. Por favor cierra la app y abrela de nuevo para reintentar.`;
    splashWin.webContents.executeJavaScript(
      `(function(){var a=document.getElementById('vLoading');var b=document.getElementById('vOffline');var c=document.getElementById('vUpdateError');if(a)a.style.display='none';if(b)b.style.display='none';if(c)c.style.display='flex';var m=document.getElementById('updateErrorMsg');if(m)m.textContent='${msg.replace(/'/g, "\\'")}';})();`
    ).catch(() => {});
    ipcMain.once('splash-update-error-quit', () => resolve());
  });
}

function showOfflineDecisionInSplash() {
  return new Promise((resolve) => {
    if (!splashAlive()) return resolve('quit');
    splashWin.webContents.executeJavaScript(
      `(function(){var a=document.getElementById('vLoading');var b=document.getElementById('vOffline');if(a)a.style.display='none';if(b)b.style.display='flex';})();`
    ).catch(() => {});
    ipcMain.once('splash-decision', (_, choice) => {
      if (choice === 'continue' && splashAlive()) {
        // Estética: restaurar vista loading antes de cerrar el splash en FASE 4b.
        splashWin.webContents.executeJavaScript(
          `(function(){var a=document.getElementById('vLoading');var b=document.getElementById('vOffline');if(b)b.style.display='none';if(a)a.style.display='flex';var m=document.getElementById('splashMsg');if(m)m.textContent='Iniciando...';var c=document.getElementById('countdown');if(c)c.textContent='';})();`
        ).catch(() => {});
      }
      resolve(choice === 'continue' ? 'continue' : 'quit');
    });
  });
}

// ═══════════════════════════════════════════════════════════════════
// FASE 3 — Update check (Win: autoUpdater, Mac: GitHub API)
// ═══════════════════════════════════════════════════════════════════
function compareVersions(a, b) {
  const pa = String(a || '').split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) > (pb[i] || 0)) return 1;
    if ((pa[i] || 0) < (pb[i] || 0)) return -1;
  }
  return 0;
}

function httpsGetJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, {
      headers: {
        'User-Agent': 'control-tc',
        'Accept': 'application/vnd.github+json'
      }
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpsGetJson(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      let body = '';
      res.setEncoding('utf8');
      res.on('data', c => body += c);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function checkMacUpdateAvailable() {
  try {
    const json = await httpsGetJson(`https://api.github.com/repos/${GH_REPO}/releases/latest`);
    const latestTag = String(json.tag_name || '').replace(/^v/, '');
    const currentVer = app.getVersion();
    if (latestTag && compareVersions(latestTag, currentVer) > 0) {
      macUpdateVersion = latestTag;
      pendingUpdateVersion = latestTag;
      return 'install';
    }
    return 'skip';
  } catch (e) {
    // Error de red (sin internet, DNS roto, etc) → tratar como 'timeout' para que
    // aparezca la vista offline en vez de saltar silenciosamente al arranque.
    console.log('Mac update check error (treating as offline):', e.message);
    return 'timeout';
  }
}

function checkWindowsUpdateAvailable() {
  return new Promise((resolve) => {
    let autoUpdater;
    try {
      autoUpdater = require('electron-updater').autoUpdater;
    } catch (e) {
      return resolve('skip');
    }
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;

    let settled = false;
    const onAvail = (info) => {
      if (settled) return;
      settled = true;
      pendingUpdateVersion = info && info.version;
      cleanup();
      resolve('install');
    };
    const onNotAvail = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve('skip');
    };
    const onErr = (err) => {
      if (settled) return;
      settled = true;
      // Error de red / 404 / latest.yml ausente → tratar como 'timeout' para que
      // aparezca la vista offline en vez de saltar silenciosamente al arranque.
      console.log('Win update check error (treating as offline):', err && err.message);
      cleanup();
      resolve('timeout');
    };
    function cleanup() {
      autoUpdater.removeListener('update-available', onAvail);
      autoUpdater.removeListener('update-not-available', onNotAvail);
      autoUpdater.removeListener('error', onErr);
    }
    autoUpdater.on('update-available', onAvail);
    autoUpdater.on('update-not-available', onNotAvail);
    autoUpdater.on('error', onErr);
    autoUpdater.checkForUpdates().catch(onErr);
  });
}

async function checkForUpdatesAtBoot() {
  if (!app.isPackaged) {
    // Dev mode: salta el check
    return 'skip';
  }

  // Countdown visual paralelo al check
  const startedAt = Date.now();
  updateSplashCountdown(BOOT_UPDATE_TIMEOUT_MS / 1000);
  const countdownTimer = setInterval(() => {
    const remaining = Math.max(0, BOOT_UPDATE_TIMEOUT_MS - (Date.now() - startedAt));
    updateSplashCountdown(remaining / 1000);
    if (remaining <= 0) clearInterval(countdownTimer);
  }, 1000);

  const checkPromise = (process.platform === 'darwin')
    ? checkMacUpdateAvailable()
    : checkWindowsUpdateAvailable();

  const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve('timeout'), BOOT_UPDATE_TIMEOUT_MS));

  const decision = await Promise.race([checkPromise, timeoutPromise]);
  clearInterval(countdownTimer);
  return decision;
}

// ═══════════════════════════════════════════════════════════════════
// FASE 4a — Descargar + instalar update (NO toca BD)
// ═══════════════════════════════════════════════════════════════════

// Variante de macDownloadAndInstall para boot: reporta progreso al splash
// (no al mainWindow porque no existe) y retorna Promise<boolean>.
function macDownloadAndInstallAtBoot(version) {
  return new Promise((resolve) => {
    const zipUrl = `https://github.com/${GH_REPO}/releases/download/v${version}/Instalador-Mac-${version}.zip`;
    const tmpDir = path.join(os.tmpdir(), 'cc-update-' + Date.now());
    const zipPath = path.join(tmpDir, 'update.zip');

    try { fs.mkdirSync(tmpDir, { recursive: true }); } catch (_) {}
    updateSplashMessage(`Descargando v${version}...`, 0);

    httpsGet(zipUrl).then((res) => {
      const total = parseInt(res.headers['content-length'] || '0', 10);
      let downloaded = 0;
      const file = fs.createWriteStream(zipPath);
      res.on('data', (chunk) => {
        downloaded += chunk.length;
        if (total > 0) {
          updateSplashMessage(`Descargando v${version}...`, Math.round((downloaded / total) * 100));
        }
      });
      res.pipe(file);
      file.on('finish', () => {
        file.close();
        try {
          updateSplashMessage(`Instalando v${version}...`, 100);
          execSync(`unzip -o -q "${zipPath}" -d "${tmpDir}"`);
          const extractedApp = path.join(tmpDir, 'Control TC.app');
          if (!fs.existsSync(extractedApp)) {
            console.log('Mac update: app not found in zip');
            return resolve(false);
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
          exec(`bash "${scriptPath}"`);
          setTimeout(() => { app.quit(); }, 500);
          resolve(true);
        } catch (err) {
          console.log('Mac install error:', err.message);
          try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {}
          resolve(false);
        }
      });
      file.on('error', (err) => {
        console.log('Mac file write error:', err.message);
        try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {}
        resolve(false);
      });
    }).catch((err) => {
      console.log('Mac download error:', err.message);
      try { fs.rmSync(tmpDir, { recursive: true }); } catch (_) {}
      resolve(false);
    });
  });
}

function winDownloadAndInstallAtBoot() {
  return new Promise((resolve) => {
    let autoUpdater;
    try {
      autoUpdater = require('electron-updater').autoUpdater;
    } catch (e) {
      return resolve(false);
    }

    const onProgress = (p) => {
      const pct = Math.round((p && p.percent) || 0);
      updateSplashMessage(`Descargando v${pendingUpdateVersion || ''}...`, pct);
    };
    const onDownloaded = () => {
      cleanup();
      updateSplashMessage(`Instalando v${pendingUpdateVersion || ''}...`, 100);
      // quitAndInstall mata la app — el resolve(true) puede no llegar a procesarse,
      // pero lo emitimos por completitud.
      setTimeout(() => {
        try { autoUpdater.quitAndInstall(false, true); } catch (_) {}
        resolve(true);
      }, 400);
    };
    const onErr = (err) => {
      console.log('Win download error:', err && err.message);
      cleanup();
      resolve(false);
    };
    function cleanup() {
      autoUpdater.removeListener('download-progress', onProgress);
      autoUpdater.removeListener('update-downloaded', onDownloaded);
      autoUpdater.removeListener('error', onErr);
    }

    autoUpdater.on('download-progress', onProgress);
    autoUpdater.on('update-downloaded', onDownloaded);
    autoUpdater.on('error', onErr);

    autoUpdater.downloadUpdate().catch(onErr);
  });
}

// ═══════════════════════════════════════════════════════════════════
// IPC HANDLERS (sin cambios — se registran ANTES de whenReady)
// ═══════════════════════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════════════════════
// Auto-updater post-boot (alimenta el banner in-app de la sección Configurador)
// ═══════════════════════════════════════════════════════════════════
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
  const zipUrl = `https://github.com/${GH_REPO}/releases/download/v${version}/Instalador-Mac-${version}.zip`;
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

    // IPC opcional para chequeo manual desde la UI (no expuesto aún en preload;
    // queda cableado para usos futuros desde Configurador → "Buscar actualizaciones").
    ipcMain.handle('check-for-updates', () => {
      try { autoUpdater.checkForUpdates().catch(() => {}); } catch (_) {}
      return true;
    });
    // El chequeo automático post-boot fue ELIMINADO — ahora el chequeo es
    // boot-blocking en checkForUpdatesAtBoot(). Esto evita que código viejo
    // tenga la chance de tocar la BD antes de instalar una corrección crítica.
  } catch (e) {
    console.log('Auto-updater not available (dev mode):', e.message);
  }
}

// ═══════════════════════════════════════════════════════════════════
// Orquestador del boot — 4 fases
// ═══════════════════════════════════════════════════════════════════
app.whenReady().then(async () => {
  // FASE 2: splash inmediato (BD intacta — startBackend NO se ha llamado)
  splashWin = createSplashWindow();

  // FASE 3: update check con timeout 60s
  const decision = await checkForUpdatesAtBoot();

  if (decision === 'install') {
    // FASE 4a: descargar + instalar (NO toca BD)
    const version = pendingUpdateVersion || '';
    updateSplashMessage(`Descargando v${version}...`, 0);
    let ok;
    if (process.platform === 'darwin') {
      ok = await macDownloadAndInstallAtBoot(version);
    } else {
      ok = await winDownloadAndInstallAtBoot();
    }
    if (ok) {
      // El proceso de instalación reinicia/reemplaza la app. No continuamos.
      return;
    }
    // FASE 4a falló: forzar al usuario a cerrar y reabrir para reintentar.
    // No caemos a FASE 4b con la versión vieja — eso defeatea el propósito
    // del boot protegido (la actualización podía contener un fix crítico de BD).
    await showUpdateErrorInSplash(version);
    app.quit();
    return;
  } else if (decision === 'timeout') {
    // FASE 4-OFFLINE: usuario decide
    const choice = await showOfflineDecisionInSplash();
    if (choice === 'quit') {
      app.quit();
      return;
    }
    // 'continue' → cae a FASE 4b
  }
  // decision === 'skip' o el usuario eligió continuar → FASE 4b

  // FASE 4b: AHORA SÍ se conecta la BD
  updateSplashMessage('Iniciando...');
  await startBackend();
  createWindow();
  setupAutoUpdater();   // listeners + IPC handlers para el banner in-app

  // Esperar a que la ventana principal esté lista (HTML cargado), luego cerrar
  // el splash y RECIÉN AHÍ mostrar/maximizar el mainWindow. Esto evita que la
  // ventana maximizada aparezca encima del splash y le robe foco visual.
  await new Promise((resolve) => {
    if (!mainWindow) return resolve();
    let done = false;
    const finish = () => { if (done) return; done = true; resolve(); };
    mainWindow.once('ready-to-show', finish);
    setTimeout(finish, 5000); // fallback hard cap
  });

  if (splashAlive()) { splashWin.close(); }
  splashWin = null;

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.maximize();
    mainWindow.show();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (server) server.close();
  if (db) db.close();
  app.quit();
});
