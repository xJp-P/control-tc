'use strict';
// backend/routes/diferidas/_compartido.js — Helpers internos del router de diferidas.
//
// Cuerpos movidos VERBATIM desde diferidas.js. Se exponen por una factory porque son CLOSURES
// sobre el contexto del router: recibirlo entero es la unica forma de moverlos sin tocar
// su codigo. Recibe logAction y tjNombre ademas de db aunque algun helper no los use:
// pagarExtracto (extractos) SI los llama, y pasarle solo `db` lo dejaba con logAction
// indefinido -> HTTP 500 al registrar un pago. Lo caza R6, que es el unico detector que
// ejercita rutas de ESCRITURA; ninguno de los otros catorce lo habria visto.
const { calcCicloLocal } = require('../../helpers/dates');

module.exports = function(db, logAction, tjNombre) {

  // Helper: chequear inmutabilidad de una diferida.
  // Bloquea si el extracto del ciclo de origen (fecha_compra) está pagado.
  function validateDiferidaMutable(difRow) {
    if (!difRow) return null;
    const tj = db.prepare('SELECT dia_corte FROM tarjetas WHERE id=?').get(difRow.tarjeta_id);
    const diaCorte = tj ? tj.dia_corte : 30;
    // Ciclo de ORIGEN = el del PRIMER CORTE (donde se factura la cuota 1). Se deriva de fecha_primer_corte
    // (siempre cae dentro del ciclo de origen), NO de fecha_compra: en las diferidas OMITIDAS la fecha_compra
    // se fija ~30 dias antes (corte del mes anterior), y calcCicloLocal la ubicaria un mes antes del origen
    // real → el candado inspeccionaria el extracto equivocado. Fallback a fecha_compra si no hay primer corte.
    const cicloOrigen = difRow.fecha_primer_corte ? String(difRow.fecha_primer_corte).slice(0, 7) : calcCicloLocal(difRow.fecha_compra, diaCorte);
    const ext = db.prepare("SELECT estado FROM extractos WHERE tarjeta_id=? AND ciclo=?").get(difRow.tarjeta_id, cicloOrigen);
    if (ext && ext.estado === 'pagado') {
      return 'No se puede modificar: el extracto del ciclo ' + cicloOrigen + ' (origen de la diferida) ya está pagado.';
    }
    return null;
  }

  return { validateDiferidaMutable };
};
