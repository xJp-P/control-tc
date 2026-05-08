// backend/routes/abonos.js — PUT/DELETE /api/abonos/:id (abonos_avance)
const { Router } = require('express');

module.exports = function(db, { logAction }) {
  const router = Router();

  router.put('/:id', (req, res) => {
    const { fecha, monto, notas } = req.body;
    db.prepare('UPDATE abonos_avance SET fecha=?, monto=?, notas=? WHERE id=?')
      .run(fecha, monto, notas, req.params.id);
    logAction('editar', 'Abono de avance editado');
    res.json({ ok: true });
  });

  router.delete('/:id', (req, res) => {
    db.prepare('DELETE FROM abonos_avance WHERE id=?').run(req.params.id);
    logAction('eliminar', 'Abono de avance eliminado');
    res.json({ ok: true });
  });

  return router;
};
