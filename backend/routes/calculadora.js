// backend/routes/calculadora.js — /api/calculadora
const { Router } = require('express');
const { primerCorteAvance } = require('../helpers/dates');
const { calcularAmortizacionAvance, calcularAmortizacionDiferida } = require('../engine/amortizacion');
const { nuOpts, avanceOpts } = require('../helpers/banco');

module.exports = function(db) {
  const router = Router();

  router.post('/', (req, res) => {
    try {
      const { tipo, monto, tasa_mv, plazo, fecha, dia_corte, comision, tarjeta_id } = req.body;

      if (!tipo || !monto || !tasa_mv || !plazo || !fecha) {
        return res.status(400).json({ error: 'Faltan campos requeridos' });
      }

      const tasaMVDecimal = parseFloat(tasa_mv) / 100;
      const dc = parseInt(dia_corte) || 30;
      const m = parseFloat(monto);
      const p = parseInt(plazo);

      if (tipo === 'avance') {
        const opts = tarjeta_id ? avanceOpts(db, parseInt(tarjeta_id)) : undefined;
        const amort = calcularAmortizacionAvance(
          m, tasaMVDecimal, p, fecha, dc, [], parseFloat(comision) || 0, opts
        );
        return res.json(amort);
      }

      if (tipo === 'diferida') {
        // Primer corte: mismo algoritmo que primerCorteAvance (siguiente día dc tras la compra)
        const primerCorte = primerCorteAvance(fecha, dc);
        const opts = tarjeta_id ? nuOpts(db, parseInt(tarjeta_id)) : {};
        const amort = calcularAmortizacionDiferida(
          m, tasaMVDecimal, p, fecha, primerCorte, null, opts
        );
        return res.json(amort);
      }

      res.status(400).json({ error: 'Tipo inválido' });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  return router;
};
