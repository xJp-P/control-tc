// backend/routes/config.js — GET/PUT /api/config
const { Router } = require('express');

module.exports = function(db) {
  const router = Router();

  router.get('/', (req, res) => {
    const rows = db.prepare('SELECT * FROM config').all();
    const config = {};
    rows.forEach(r => config[r.key] = r.value);
    res.json(config);
  });

  router.put('/:key', (req, res) => {
    const { key } = req.params;
    const { value } = req.body;
    db.prepare('INSERT OR REPLACE INTO config (key, value) VALUES (?, ?)').run(key, String(value));
    res.json({ ok: true });
  });

  // Propaga una URL canónica del preset a todas las tarjetas que usan ese banco.
  // Esto permite que cuando el usuario hace "Restaurar URL" en BancoUrlConfig,
  // las tarjetas individuales también se actualicen (no sólo el preset global).
  // Body: { banco: 'Nu', url: 'https://...' }
  router.post('/sync-bank-url', (req, res) => {
    const { banco, url } = req.body;
    if (!banco || !url) {
      return res.status(400).json({ error: 'Se requieren banco y url' });
    }
    const result = db.prepare(
      'UPDATE tarjetas SET url_tasas = ? WHERE LOWER(banco) = LOWER(?)'
    ).run(String(url), String(banco));
    res.json({ ok: true, tarjetasActualizadas: result.changes });
  });

  return router;
};
