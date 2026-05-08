// backend/routes/proyecciones.js — /api/proyecciones
const { Router } = require('express');
const { hoyLocal, addMonths } = require('../helpers/dates');
const { calcularAmortizacionAvance } = require('../engine/amortizacion');
const { calcularAmortizacionDiferida } = require('../engine/amortizacion');
const { nuOpts, avanceOpts } = require('../helpers/banco');

module.exports = function(db) {
  const router = Router();

  router.get('/', (req, res) => {
    const meses = parseInt(req.query.meses) || 24;
    const { tarjeta_id } = req.query;
    const hoy = hoyLocal();
    const proyeccion = [];

    const tjFilter = tarjeta_id ? ' AND tarjeta_id = ?' : '';
    const tjParams = tarjeta_id ? [tarjeta_id] : [];

    let diaCorte = 30;
    if (tarjeta_id) {
      const tj = db.prepare('SELECT dia_corte FROM tarjetas WHERE id=?').get(tarjeta_id);
      if (tj) diaCorte = tj.dia_corte;
    }

    const avancesActivos = db.prepare("SELECT * FROM avances WHERE estado='activo'" + tjFilter).all(...tjParams);
    const diferidasActivas = db.prepare("SELECT * FROM diferidas WHERE estado='activo'" + tjFilter).all(...tjParams);

    for (let m = 0; m < meses; m++) {
      const d = new Date();
      d.setMonth(d.getMonth() + m);
      const mesStr = d.toISOString().slice(0, 7);
      const fechaCorte = `${mesStr}-${String(diaCorte).padStart(2, '0')}`;

      let totalAvances = 0, totalDiferidas = 0, interesesAvances = 0, interesesDiferidas = 0;

      avancesActivos.forEach(av => {
        const abonos = db.prepare('SELECT * FROM abonos_avance WHERE avance_id=? ORDER BY fecha').all(av.id);
        const amort = calcularAmortizacionAvance(av.monto, av.tasa_mv, av.plazo, av.fecha_desembolso, av.dia_corte, abonos, av.comision, avanceOpts(db, av.tarjeta_id));
        const cuota = amort.tabla.find(r => r.fechaCorte.slice(0, 7) === mesStr);
        if (cuota) { totalAvances += cuota.totalExtracto; interesesAvances += cuota.interes; }
      });

      diferidasActivas.forEach(d => {
        const amort = calcularAmortizacionDiferida(d.monto, d.tasa_mv, d.num_cuotas, d.fecha_compra, d.fecha_primer_corte, null, nuOpts(db, d.tarjeta_id));
        const cuota = amort.tabla.find(r => r.fechaCorte.slice(0, 7) === mesStr);
        if (cuota) { totalDiferidas += cuota.totalPagar; interesesDiferidas += cuota.interesTotal; }
      });

      proyeccion.push({
        mes: mesStr, fechaCorte,
        totalAvances: Math.round(totalAvances), totalDiferidas: Math.round(totalDiferidas),
        interesesAvances: Math.round(interesesAvances), interesesDiferidas: Math.round(interesesDiferidas),
        totalExtracto: Math.round(totalAvances + totalDiferidas)
      });
    }

    const proyeccionFiltrada = proyeccion.filter(p => p.totalExtracto > 0);
    const ultimoConDeuda = proyeccionFiltrada.length > 0 ? proyeccionFiltrada[proyeccionFiltrada.length - 1] : null;
    const fechaDeudaCero = ultimoConDeuda ? addMonths(ultimoConDeuda.mes + '-01', 1).slice(0, 7) : null;

    res.json({ proyeccion: proyeccionFiltrada, fechaDeudaCero });
  });

  return router;
};
