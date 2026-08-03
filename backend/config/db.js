// backend/config/db.js — Database path resolution + orquestacion del arranque
//
// Solo compone. Las tres fases viven en db/: crearEsquema -> aplicarMigraciones -> syncData, y
// ese ORDEN es el contrato: los ALTER de la fase 2 asumen que las tablas ya existen, y syncData
// asume que existen las columnas. Repartir por entidad en vez de por fase reintroduce el crash
// de v4.7.1 con BDs de versiones viejas (ver db/schema.js).

const path = require('path');
const fs = require('fs');
const { crearEsquema } = require('./db/schema');
const { aplicarMigraciones } = require('./db/migraciones');
const { syncData } = require('./db/syncData');

const DEFAULT_DB_DIR = path.join(require('os').homedir(), 'AppData', 'Roaming', 'CreditCardManager');
const DB_CONFIG_FILE = path.join(DEFAULT_DB_DIR, 'db_location.json');

function getDbPath() {
  try {
    if (fs.existsSync(DB_CONFIG_FILE)) {
      const config = JSON.parse(fs.readFileSync(DB_CONFIG_FILE, 'utf8'));
      if (config.dbPath && fs.existsSync(config.dbPath)) {
        return config.dbPath;
      }
    }
  } catch (e) { /* fallback to default */ }
  return path.join(DEFAULT_DB_DIR, 'data.db');
}

function getDbConfigPath() {
  return DB_CONFIG_FILE;
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

// ─── Database initialization: schema + migrations ─────────────────
function initDb(dbPathOverride) {
  const Database = require('better-sqlite3');
  const dbPath = dbPathOverride || getDbPath();
  ensureDir(dbPath);
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // FASE 1 — el esquema completo, ANTES de cualquier migracion.
  crearEsquema(db);

  // FASES 2 y 3 — columnas nuevas y migraciones de datos.
  aplicarMigraciones(db);

  // Run sync
  syncData(db);

  const insertConfig = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
  insertConfig.run('theme', 'dark');
  // TRM (Tasa Representativa del Mercado) USD→COP. Solo se usa para estimar el
  // cupo usado de tarjetas duales (la deuda USD se convierte a COP equivalentes
  // para calcular el % de cupo). El usuario puede actualizarla via SQL o futura UI.
  // Default ~4200 COP/USD (rango típico Colombia 2024-2026).
  insertConfig.run('trm_usd_cop', '4200');

  return db;
}

module.exports = { DEFAULT_DB_DIR, getDbPath, getDbConfigPath, ensureDir, initDb, syncData };
