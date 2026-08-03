// backend/routes/ia/movimientos.js
//
// Ruta movida VERBATIM desde ia.js. Se registra sobre el MISMO router que crea el archivo padre.
const { construirMovimientos } = require('../../services/movimientos');

module.exports = function(router, ctx) {
  const { db } = ctx;

  // GET /api/ia/movimientos?tarjeta_id&ciclo — movimientos del ciclo SIN PDF. Sirve para
  // refrescar la vista tras aplicar una accion y ver el nuevo pago minimo de la app.
  router.get('/movimientos', (req, res) => {
    const { tarjeta_id, ciclo } = req.query;
    if (!tarjeta_id || !ciclo) return res.status(400).json({ error: 'tarjeta_id y ciclo son requeridos.' });
    const mv = construirMovimientos(db, tarjeta_id, ciclo);
    if (mv && mv.error) return res.status(404).json(mv);
    res.json(mv);
  });
};
