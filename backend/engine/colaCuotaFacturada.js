// backend/engine/colaCuotaFacturada.js — Interes de la ULTIMA cuota de un plan, cobrado un mes despues.
//
// La cuota que se factura en un corte devenga interes hasta el dia en que se paga (Bancolombia, ver
// interesCuotaFacturadaHastaPago en engine/amortizacion.js), y ese interes lo cobra el extracto
// SIGUIENTE. Mientras el plan sigue vivo lo cobra su proxima cuota; pero la ULTIMA cuota no tiene
// "proxima": el banco igual cobra ese interes el mes siguiente, cuando en el motor el plan ya no tiene
// filas. Sin esta cola, la proyeccion del mes siguiente al fin de varios planes quedaba corta en un
// orden del 4% del interes del mes (medido en oct-2026, con cinco planes que terminaban en septiembre).
//
// Es el UNICO sitio que la calcula: lo usan calcExtracto (pago minimo y total) y la card de intereses
// del dashboard, para que las dos vistas no puedan contarla distinto.
'use strict';
const { calcularAmortizacionDiferida, calcularAmortizacionAvance, interesCuotaFacturadaHastaPago } = require('./amortizacion');
const { addMonths, primerCorteAvance } = require('../helpers/dates');
const { nuOptsDif, avanceOpts } = require('../helpers/banco');

const cicloAnterior = (c) => {
  const [y, m] = String(c).split('-').map(Number);
  return m === 1 ? (y - 1) + '-12' : y + '-' + String(m - 1).padStart(2, '0');
};

// { total, detalle: [{ tipo, etiqueta, fecha, capital, interes }] } del ciclo `cicloStr` para una tarjeta.
// Solo hay cola si la amortizacion recibe fechaPagoDe (Bancolombia): para el resto devuelve 0 siempre.
function interesColaCuotasFinales(db, tarjetaId, cicloStr) {
  const out = { total: 0, detalle: [] };
  const previo = cicloAnterior(cicloStr);
  const agregar = (tipo, etiqueta, fecha, ultima, tasa, fechaPagoDe) => {
    const corteSiguiente = addMonths(ultima.fechaCorte, 1);
    const diasPeriodo = Math.round((new Date(corteSiguiente + 'T12:00:00') - new Date(ultima.fechaCorte + 'T12:00:00')) / 86400000);
    const interes = interesCuotaFacturadaHastaPago(fechaPagoDe, 1, ultima.cuotaCapital, ultima.fechaCorte, diasPeriodo, tasa);
    if (!(interes > 0)) return;
    out.total += interes;
    out.detalle.push({ tipo, etiqueta, fecha, capital: Math.round(ultima.cuotaCapital), interes: Math.round(interes * 100) / 100 });
  };

  // Filtro barato ANTES de amortizar: solo los planes cuya ultima cuota cae, por calendario, en el ciclo
  // anterior. Incluye los ya liquidados, que es justo el estado en que quedan al terminar.
  db.prepare("SELECT * FROM diferidas WHERE tarjeta_id=? AND estado IN ('activo','liquidado')").all(tarjetaId).forEach(d => {
    if (!d.fecha_primer_corte || !(d.num_cuotas > 0)) return;
    if (addMonths(d.fecha_primer_corte, d.num_cuotas - 1).slice(0, 7) !== previo) return;
    const opts = nuOptsDif(db, d);
    if (!opts || !opts.fechaPagoDe) return;
    const abonos = db.prepare('SELECT * FROM abonos_diferida WHERE diferida_id=? ORDER BY fecha').all(d.id);
    const tabla = calcularAmortizacionDiferida(d.monto, d.tasa_mv, d.num_cuotas, d.fecha_compra, d.fecha_primer_corte, abonos, opts).tabla;
    const ultima = tabla[tabla.length - 1];
    if (ultima && ultima.fechaCorte.slice(0, 7) === previo) agregar('diferida', d.etiqueta, d.fecha_compra, ultima, d.tasa_mv, opts.fechaPagoDe);
  });

  db.prepare("SELECT * FROM avances WHERE tarjeta_id=? AND estado IN ('activo','liquidado')").all(tarjetaId).forEach(av => {
    if (!av.fecha_desembolso || !(av.plazo > 0)) return;
    if (addMonths(primerCorteAvance(av.fecha_desembolso, av.dia_corte), av.plazo - 1).slice(0, 7) !== previo) return;
    const opts = avanceOpts(db, av.tarjeta_id);
    if (!opts || !opts.fechaPagoDe) return;
    const abonos = db.prepare('SELECT * FROM abonos_avance WHERE avance_id=? ORDER BY fecha').all(av.id);
    const tabla = calcularAmortizacionAvance(av.monto, av.tasa_mv, av.plazo, av.fecha_desembolso, av.dia_corte, abonos, av.comision, opts).tabla;
    const ultima = tabla[tabla.length - 1];
    if (ultima && ultima.fechaCorte.slice(0, 7) === previo) agregar('avance', av.etiqueta, av.fecha_desembolso, ultima, av.tasa_mv, opts.fechaPagoDe);
  });

  out.total = Math.round(out.total * 100) / 100;
  return out;
}

module.exports = { interesColaCuotasFinales };
