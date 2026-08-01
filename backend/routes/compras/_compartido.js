'use strict';
// backend/routes/compras/_compartido.js — Helpers internos del router de compras.
//
// Cuerpos movidos VERBATIM desde compras.js. Se exponen por una factory porque son CLOSURES
// sobre el contexto del router: recibirlo entero es la unica forma de moverlos sin tocar
// su codigo. Recibe logAction y tjNombre ademas de db aunque algun helper no los use:
// pagarExtracto (extractos) SI los llama, y pasarle solo `db` lo dejaba con logAction
// indefinido -> HTTP 500 al registrar un pago. Lo caza R6, que es el unico detector que
// ejercita rutas de ESCRITURA; ninguno de los otros catorce lo habria visto.
const { Router } = require('express');
const { hoyLocal, daysBetween, primerCorteAvance } = require('../../helpers/dates');
const { calcularAmortizacionDiferida } = require('../../engine/amortizacion');
const { nuOpts, nuOptsDif, aplicaIntInternacional } = require('../../helpers/banco');
const { compraTerceroConReembolso, objetivoBolsilloCop, cicloYaPagado } = require('../../helpers/bolsillo');
const { getCortesCustomMap, cicloConCorte, corteDeCiclo } = require('../../helpers/cortes');
const { tasaIntlEnFecha } = require('../../helpers/tasas');
const { pagoMinimoOficial } = require('../../helpers/extractoOficial');

module.exports = function(db, logAction, tjNombre) {

  function calcCiclo(fecha, tarjetaId) {
    const tj = db.prepare('SELECT dia_corte FROM tarjetas WHERE id=?').get(tarjetaId);
    const diaCorte = (tj && tj.dia_corte) || 30;
    // Ciclo = regla normal por dia_corte global + desvío por corte ADELANTADO (cortes_custom):
    // si el banco cortó antes del dia_corte teórico, las compras hechas después de ese corte real
    // saltan al ciclo siguiente. cicloConCorte cae al ciclo teórico normal si no hay override
    // (la aritmética año/mes directa de calcCicloLocal evita el desborde de día 31→mes+2).
    return cicloConCorte(fecha, diaCorte, getCortesCustomMap(db, tarjetaId));
  }

  // ¿El extracto de ese (tarjeta, ciclo) ya está PAGADO? ÚNICO candado de inmutabilidad desde v5.8.0.
  // Regla del Product Owner: un ciclo se sella cuando se PAGA, no cuando pasa su fecha de corte. Entre
  // el corte y la fecha límite hay ~2 semanas en las que el extracto existe pero la deuda sigue viva:
  // ahí registrar lo que faltó es legítimo y el banco mismo lo admite. Sin exención — ni la IA lo salta.
  // Si el ciclo que se acaba de tocar tiene una cifra de pago mínimo tomada del PDF, esa cifra MANDA
  // sobre el cálculo (helpers/extractoOficial) y por tanto NO refleja el movimiento nuevo: el mínimo se
  // queda quieto en todas las vistas y, al sellar, la compra igual quedaría marcada como pagada. No se
  // toca nada por cuenta propia (esa cifra costó conciliarla y es más confiable que el estimado): se
  // devuelve el aviso para que el usuario decida si la descarta y vuelve al cálculo.
  function avisoCifraOficial(tarjetaId, ciclo) {
    const of = pagoMinimoOficial(db, tarjetaId, ciclo);
    if (of == null) return null;
    const row = db.prepare('SELECT fuente FROM extractos_oficiales WHERE tarjeta_id=? AND ciclo=?').get(tarjetaId, ciclo);
    return { tarjeta_id: tarjetaId, ciclo, pago_minimo_oficial: of, fuente: (row && row.fuente) || null };
  }

  function esCicloPagado(tarjetaId, ciclo) {
    if (!ciclo) return false;
    const ext = db.prepare("SELECT estado FROM extractos WHERE tarjeta_id=? AND ciclo=?").get(tarjetaId, ciclo);
    return !!(ext && ext.estado === 'pagado');
  }

  // ¿El ciclo ya CERRÓ por TIEMPO? (cerrado ≠ pagado: el banco generó el extracto, esté pagado o no.)
  // DEROGADO en v5.8.0 como candado del ciclo de vida de la compra — bloqueaba el registro manual
  // durante toda la ventana corte→pago. Sobrevive en UN solo sitio: `merge-personal`, que BORRA
  // físicamente las partes de terceros y no tiene deshacer (decisión explícita del Product Owner).
  function esCicloCerrado(tarjetaId, ciclo) {
    if (!ciclo) return false;
    const tj = db.prepare('SELECT dia_corte FROM tarjetas WHERE id=?').get(tarjetaId);
    const diaCorte = (tj && tj.dia_corte) || 30;
    // Vigente CONSCIENTE del corte adelantado (cortes_custom): si el banco cortó antes del día
    // teórico, el ciclo en curso avanza y el anterior queda CERRADO de inmediato (su extracto ya
    // se generó). cicloConCorte sólo ADELANTA (nunca retrocede) → no sella de más; sin override en
    // cortes_custom cae al ciclo teórico, idéntico al comportamiento previo. Las compras que el
    // motor empujó al ciclo siguiente (ventana post-corte) quedan en el vigente → NO se sellan.
    return ciclo < cicloConCorte(hoyLocal(), diaCorte, getCortesCustomMap(db, tarjetaId));
  }

  // Calcula el target máximo del bolsillo de una compra (lo que realmente costará):
  //   - Diferida per-cuota: el total de esa cuota (COP) o valor_usd/num_cuotas (USD).
  //   - 1 cuota COP: valor_cop + interés intl (si la tarjeta lo cobra, ej. Bancolombia Visa).
  //   - 1 cuota USD: valor_usd.
  // Se usa para CAP-ear el monto apartado: no tiene sentido guardar en el bolsillo más de lo
  // que la compra va a costar. Para intl el tope incluye el interés (por eso no es solo valor_cop).
  function targetBolsillo(c, monedaPago, cuotaNum) {
    if (cuotaNum != null && c.estado === 'diferida') {
      const dif = c.diferida_id ? db.prepare('SELECT * FROM diferidas WHERE id=?').get(c.diferida_id) : null;
      if (!dif) return null; // sin diferida vinculada no podemos calcular el tope → no cap-eamos
      if (monedaPago === 'USD') return Math.round(((c.valor_usd || 0) / dif.num_cuotas) * 100) / 100;
      const amort = calcularAmortizacionDiferida(c.valor_cop, dif.tasa_mv, dif.num_cuotas, dif.fecha_compra, dif.fecha_primer_corte, null, nuOptsDif(db, dif));
      const cuotaObj = amort.tabla.find(r => r.numCuota === cuotaNum);
      return cuotaObj ? Math.round(cuotaObj.totalPagar) : null;
    }
    if (monedaPago === 'USD') return Math.round((c.valor_usd || 0) * 100) / 100;
    // COP: valor + interés intl. Fuente única en helpers/bolsillo → el cruce de saldo a favor y este
    // cap usan EXACTAMENTE el mismo objetivo (sin drift del interés intl).
    return objetivoBolsilloCop(db, c);
  }

  return { calcCiclo, avisoCifraOficial, esCicloPagado, esCicloCerrado, targetBolsillo };
};
