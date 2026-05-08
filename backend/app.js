// backend/app.js — Express factory: initializes DB, mounts all routes
'use strict';
const path = require('path');
const express = require('express');
const cors = require('cors');

const { getDbPath, initDb } = require('./config/db');
const { createLogHelpers } = require('./helpers/log');

module.exports = function createApp(dbPathOverride) {
  const db = initDb(dbPathOverride);
  const dbPath = db.name; // better-sqlite3 exposes the file path as .name
  const { logAction, tjNombre } = createLogHelpers(db);
  const ctx = { logAction, tjNombre };

  const app = express();
  app.use(cors());
  app.use(express.json({ limit: '10mb' }));
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
  app.use('/api/dashboard',       require('./routes/dashboard')(db));
  app.use('/api/proyecciones',    require('./routes/proyecciones')(db));
  app.use('/api/calculadora',     require('./routes/calculadora')(db));
  app.use('/api',                 require('./routes/misc')(db, dbPath));

  // SPA fallback (must be LAST)
  app.get('*', (req, res) => {
    if (!req.path.startsWith('/api')) {
      res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
    }
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
