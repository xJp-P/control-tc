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

  return router;
};
