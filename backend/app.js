// backend/app.js — Express factory: initializes DB, mounts all routes
'use strict';
const path = require('path');
const express = require('express');
const cors = require('cors');

const { getDbPath, initDb } = require('./config/db');
const { createLogHelpers } = require('./helpers/log');

module.exports = function createApp(dbPathOverride, deps = {}) {
  const db = initDb(dbPathOverride);
  const dbPath = db.name; // better-sqlite3 exposes the file path as .name
  const { logAction, tjNombre } = createLogHelpers(db);
  // deps.readIaKey: función inyectada por desktop/main.js que descifra la API key
  // de la IA con safeStorage (on-demand). Ausente en modo `npm run server` (Node
  // puro) → las rutas de IA que requieran la key responderán 503.
  const ctx = { logAction, tjNombre, readIaKey: deps.readIaKey || null };

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '25mb' })); // 25mb: el Asistente de IA envia el PDF en base64
  app.use(express.static(path.join(__dirname, '..', 'public')));

  // ── Routes ────────────────────────────────────────────────────────
  app.use('/api/config',          require('./routes/config')(db));
  app.use('/api/tarjetas',        require('./routes/tarjetas')(db, ctx));
  app.use('/api/personas',        require('./routes/personas')(db, ctx));
  app.use('/api/compras',         require('./routes/compras')(db, ctx));
  app.use('/api/avances',         require('./routes/avances')(db, ctx));
  app.use('/api/abonos',          require('./routes/abonos')(db, ctx));
  app.use('/api/diferidas',       require('./routes/diferidas')(db, ctx));
  app.use('/api/pagos',           require('./routes/pagos')(db, ctx));
  app.use('/api/extractos',       require('./routes/extractos')(db, ctx));
  app.use('/api/abono-capital',   require('./routes/abonoCapital')(db, ctx));
  app.use('/api/terceros',        require('./routes/terceros')(db, ctx));
  app.use('/api/saldos-favor',    require('./routes/saldosFavor')(db, ctx));
  app.use('/api/dashboard',       require('./routes/dashboard')(db));
  app.use('/api/proyecciones',    require('./routes/proyecciones')(db));
  app.use('/api/calculadora',     require('./routes/calculadora')(db));
  app.use('/api/ia',              require('./routes/ia')(db, ctx));
  app.use('/api',                 require('./routes/misc')(db, dbPath));

  // ── 404 real para rutas /api no montadas ──────────────────────────
  // Antes, un GET a una ruta /api inexistente caía en el catch-all de abajo, no entraba en la rama
  // del SPA y el handler terminaba SIN responder ni ceder: la petición quedaba abierta hasta que
  // expirara el socket. El `api()` del frontend hace `await fetch(...)` + `res.json()` sin
  // comprobar `res.ok`, así que la promesa nunca se resolvía: ni toast, ni error en consola, ni
  // entrada roja en Network — sólo un botón pensando para siempre. Con los demás verbos el síntoma
  // era distinto pero igual de mudo: Express devolvía su 404 en HTML y `res.json()` reventaba con
  // SyntaxError. Este handler cubre TODOS los verbos y responde SIEMPRE en JSON, que es el formato
  // que el frontend sabe leer.
  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Ruta no encontrada: ' + req.method + ' /api' + req.url });
  });

  // ── SPA fallback (debe ir de ÚLTIMO) ──────────────────────────────
  // Un subrecurso ausente (js/css/mapa/imagen) debe dar 404 REAL, nunca el HTML de index.html con
  // 200: servir HTML donde se pidió JavaScript produce un mudo "Uncaught SyntaxError: Unexpected
  // token <" que no nombra el archivo que falta. En el instalador ese mismo síntoma puede venir de
  // un archivo no empaquetado (files de electron-builder) o de un desajuste de mayúsculas (el
  // índice del asar resuelve por clave exacta, a diferencia de NTFS), y sin 404 son
  // indistinguibles. Hoy index.html sólo referencia los dos CDN de React, así que este camino aún
  // no se puede disparar; se blinda ANTES de que el frontend estrene subrecursos locales.
  const RE_ASSET = /\.(js|mjs|css|map|json|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|otf|eot|pdf|txt|wasm)$/i;
  app.get('*', (req, res) => {
    if (RE_ASSET.test(req.path)) {
      return res.status(404).type('text/plain').send('No encontrado: ' + req.path);
    }
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  });

  return { app, db, logAction };
};

// ─── Standalone run ─────────────────────────────────────────────
if (require.main === module) {
  const { app } = module.exports();
  const PORT = 3500;
  app.listen(PORT, '127.0.0.1', () => {
    console.log(`Server running at http://127.0.0.1:${PORT}`);
  });
}
