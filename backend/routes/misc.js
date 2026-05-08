// backend/routes/misc.js — /api/backup, /api/log, /api/sync, /api/scrape-tasas
const { Router } = require('express');
const fs = require('fs');
const { syncData } = require('../config/db');
const { scrapeTasas } = require('../helpers/scraper');

module.exports = function(db, dbPath) {
  const router = Router();

  router.get('/backup', (req, res) => {
    const data = fs.readFileSync(dbPath);
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename=backup_${new Date().toISOString().slice(0,10)}.db`);
    res.send(data);
  });

  router.get('/log', (req, res) => {
    try {
      const lim = parseInt(req.query.limit) || 50;
      const off = parseInt(req.query.offset) || 0;
      const total = db.prepare('SELECT COUNT(*) as c FROM historial').get().c;
      const rows = db.prepare('SELECT * FROM historial ORDER BY fecha DESC, id DESC LIMIT ? OFFSET ?').all(lim, off);
      res.json({ total, rows });
    } catch(err) {
      console.error('GET /api/log error:', err);
      res.status(500).json({ error: err.message });
    }
  });

  router.delete('/log', (req, res) => {
    db.prepare('DELETE FROM historial').run();
    res.json({ ok: true });
  });

  router.post('/sync', (req, res) => {
    const fixes = syncData(db);
    res.json({ ok: true, fixes });
  });

  router.get('/scrape-tasas', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'URL requerida' });
    const result = await scrapeTasas(url);
    res.json(result);
  });

  return router;
};
