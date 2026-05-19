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

  // TRM (Tasa Representativa del Mercado) USD→COP del día actual.
  // Consulta el dataset abierto de la Superintendencia Financiera vía datos.gov.co.
  // Si falla la API externa, devuelve el valor guardado en config como fallback.
  router.get('/trm-actual', async (req, res) => {
    const apiUrl = 'https://www.datos.gov.co/resource/32sa-8pi3.json?$limit=1&$order=vigenciadesde DESC';
    try {
      const response = await fetch(apiUrl, {
        headers: { 'Accept': 'application/json', 'User-Agent': 'ControlTC/1.0' }
      });
      if (!response.ok) throw new Error('HTTP ' + response.status);
      const data = await response.json();
      if (!Array.isArray(data) || data.length === 0) throw new Error('Respuesta vacía');
      const row = data[0];
      const trm = parseFloat(row.valor);
      if (!trm || isNaN(trm)) throw new Error('TRM inválida en respuesta');
      const fecha = row.vigenciadesde ? row.vigenciadesde.slice(0, 10) : null;
      // Actualizar el config para que el dashboard use la TRM más reciente al calcular cupo.
      db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('trm_usd_cop', String(trm));
      db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run('trm_usd_cop_fecha', fecha || '');
      return res.json({ ok: true, trm, fecha, source: 'datos.gov.co (Banco República)' });
    } catch (err) {
      // Fallback al valor guardado en config.
      const row = db.prepare("SELECT value FROM config WHERE key='trm_usd_cop'").get();
      const fechaRow = db.prepare("SELECT value FROM config WHERE key='trm_usd_cop_fecha'").get();
      const trm = row && row.value ? parseFloat(row.value) || 4200 : 4200;
      return res.json({ ok: false, error: err.message, trm, fecha: fechaRow ? fechaRow.value : null, source: 'config (fallback)' });
    }
  });

  return router;
};
