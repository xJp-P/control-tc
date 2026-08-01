'use strict';
// backend/routes/extractos/lectura.js
//
// Rutas movidas VERBATIM desde extractos.js. Se registran sobre el MISMO router que crea el
// archivo padre, no sobre un sub-router montado: asi el stack de Express conserva su
// forma y su ORDEN exactos, y el contrato que se ve desde fuera no cambia ni un apice.
const { Router } = require('express');
const { minimoEfectivo, pagoMinimoOficial } = require('../../helpers/extractoOficial');
// Margen que el pago de un extracto puede desviarse del mínimo estimado y aun así darse por completo.
// Existe porque el estimado NO puede ser exacto por diseño (el banco cobra interés sobre la cuota ya
// facturada hasta el día del pago). Calibrado con 10 extractos reales: los desfases medidos van de
// −$1.628 a +$1.060. Un abono parcial de verdad es de otro orden de magnitud y queda fuera.
const TOLERANCIA_PAGO_COP = 2000;
const { hoyLocal } = require('../../helpers/dates');
const { calcularAmortizacionAvance, calcularAmortizacionDiferida } = require('../../engine/amortizacion');
const { nuOpts, nuOptsDif, avanceOpts } = require('../../helpers/banco');
const { calcExtracto } = require('../../engine/extracto');

module.exports = function(router, ctx) {
  const { db, logAction, tjNombre, pagarExtracto } = ctx;

  router.get('/', (req, res) => {
    const { tarjeta_id } = req.query;
    if (!tarjeta_id) return res.status(400).json({ error: 'tarjeta_id requerido' });

    const extractos = db.prepare('SELECT * FROM extractos WHERE tarjeta_id=? ORDER BY ciclo DESC').all(tarjeta_id);
    const hoy = new Date();
    const ciclosConDeuda = new Set();

    const comprasCiclos = db.prepare("SELECT DISTINCT ciclo FROM compras WHERE tarjeta_id=? AND estado NOT IN ('pagado','diferida') AND ciclo IS NOT NULL").all(tarjeta_id);
    comprasCiclos.forEach(c => ciclosConDeuda.add(c.ciclo));

    const avancesAll = db.prepare("SELECT * FROM avances WHERE tarjeta_id=? AND estado='activo'").all(tarjeta_id);
    avancesAll.forEach(av => {
      const abonos = db.prepare('SELECT * FROM abonos_avance WHERE avance_id=? ORDER BY fecha').all(av.id);
      const amort = calcularAmortizacionAvance(av.monto, av.tasa_mv, av.plazo, av.fecha_desembolso, av.dia_corte, abonos, av.comision, avanceOpts(db, av.tarjeta_id));
      amort.tabla.forEach(r => ciclosConDeuda.add(r.fechaCorte.slice(0, 7)));
    });

    const diferidasAll = db.prepare("SELECT * FROM diferidas WHERE tarjeta_id=? AND estado='activo'").all(tarjeta_id);
    diferidasAll.forEach(d => {
      const amort = calcularAmortizacionDiferida(d.monto, d.tasa_mv, d.num_cuotas, d.fecha_compra, d.fecha_primer_corte, null, nuOptsDif(db, d));
      amort.tabla.forEach(r => ciclosConDeuda.add(r.fechaCorte.slice(0, 7)));
    });

    ciclosConDeuda.add(hoy.getFullYear() + '-' + String(hoy.getMonth() + 1).padStart(2, '0'));

    ciclosConDeuda.forEach(ciclo => {
      const exists = db.prepare('SELECT id FROM extractos WHERE tarjeta_id=? AND ciclo=?').get(tarjeta_id, ciclo);
      if (!exists) {
        const calc = calcExtracto(db, tarjeta_id, ciclo);
        if (calc && (calc.pagoTotal > 0 || calc.pagoMinimo > 0)) {
          db.prepare('INSERT OR IGNORE INTO extractos (tarjeta_id, ciclo, fecha_corte, fecha_pago, pago_minimo, pago_total, intereses_intl) VALUES (?,?,?,?,?,?,?)')
            .run(tarjeta_id, ciclo, calc.fechaCorte, calc.fechaPago, calc.pagoMinimo, calc.pagoTotal, calc.interesesComprasIntl || 0);
        }
      }
    });

    const result = db.prepare(`
      SELECT ext.*, fpc.fecha_pago as fecha_pago_custom, cc.fecha_corte as fecha_corte_custom,
             eo.pago_minimo as pago_minimo_oficial, eo.pago_total as pago_total_oficial, eo.fuente as fuente_oficial
      FROM extractos ext
      LEFT JOIN fechas_pago_custom fpc ON fpc.tarjeta_id = ext.tarjeta_id AND fpc.ciclo = ext.ciclo
      LEFT JOIN cortes_custom cc ON cc.tarjeta_id = ext.tarjeta_id AND cc.ciclo = ext.ciclo
      LEFT JOIN extractos_oficiales eo ON eo.tarjeta_id = ext.tarjeta_id AND eo.ciclo = ext.ciclo
      WHERE ext.tarjeta_id = ? ORDER BY ext.ciclo DESC
    `).all(tarjeta_id);
    result.forEach(ext => {
      // Si hay override manual de fecha de pago, lo aplicamos al campo display.
      // El valor "auto" original sigue intacto en la columna extractos.fecha_pago.
      if (ext.fecha_pago_custom) {
        ext.fecha_pago_auto = ext.fecha_pago;
        ext.fecha_pago = ext.fecha_pago_custom;
        ext.es_fecha_pago_manual = true;
      } else {
        ext.es_fecha_pago_manual = false;
      }
      // Corte adelantado (cortes_custom): mismo patrón que la fecha de pago manual — se aplica al
      // campo display y se marca con un flag para que la UI muestre "(ADELANTADO)". El valor teórico
      // original queda en fecha_corte_auto. Solo display: no recalcula intereses ni pago mínimo.
      if (ext.fecha_corte_custom) {
        ext.fecha_corte_auto = ext.fecha_corte;
        ext.fecha_corte = ext.fecha_corte_custom;
        ext.es_corte_adelantado = true;
      } else {
        ext.es_corte_adelantado = false;
      }
      const calc = calcExtracto(db, tarjeta_id, ext.ciclo, ext.estado === 'pagado');
      if (calc) {
        ext.compras = calc.compras;
        ext.detalle_compras = calc.detalleCompras;
        ext.cuotas_capital = calc.cuotasCapital;
        ext.cuotas_interes = calc.cuotasInteres;
        ext.avances_total = calc.avancesTotal;
        ext.diferidas_total = calc.diferidasTotal;
        ext.detalle_avances = calc.detalleAvances;
        ext.detalle_diferidas = calc.detalleDiferidas;
        ext.dual_extracto = calc.dualExtracto || false;
        ext.compras_usd = calc.comprasUsd || 0;
        ext.intereses_compras_usd = calc.interesesComprasUsd || 0;
        ext.detalle_compras_usd = calc.detalleComprasUsd || [];
        if (ext.estado === 'pendiente') {
          ext.pago_minimo = calc.pagoMinimo;
          ext.pago_total = calc.pagoTotal;
          ext.intereses_intl = calc.interesesComprasIntl || 0;
          ext.pago_minimo_usd = calc.pagoMinimoUsd || 0;
          db.prepare('UPDATE extractos SET pago_minimo=?, pago_total=?, fecha_corte=?, fecha_pago=?, intereses_intl=?, pago_minimo_usd=? WHERE id=?')
            .run(calc.pagoMinimo, calc.pagoTotal, calc.fechaCorte, calc.fechaPago, calc.interesesComprasIntl || 0, calc.pagoMinimoUsd || 0, ext.id);
        }
        // Para extractos PAGADOS conservamos intereses_intl y pago_minimo_usd que
        // se persistieron al cerrar. Ya vienen desde el SELECT inicial y NO se
        // sobreescriben acá.

        // Campo derivado: el ciclo está completamente cerrado cuando ambas porciones
        // (COP y USD) están al día (o USD es 'no_aplica' para tarjetas no-duales).
        ext.cerrado_completo = ext.estado === 'pagado' && (ext.estado_usd === 'pagado' || ext.estado_usd === 'no_aplica');
      }
      // Cifra OFICIAL del extracto del banco (v5.7.0). El cálculo de la app queda intacto en
      // `pago_minimo_calculado` (alimenta deuda, cupo y proyecciones); `pago_minimo` pasa a ser el
      // valor REAL cuando se conoce, que es el que el usuario tiene que pagar. Ver el porqué en
      // docs/bancos/RappiCard_Visa.md §4.3: el modelo NO puede ser exacto por diseño.
      ext.tiene_oficial = ext.pago_minimo_oficial != null;
      // Distingue la cifra LEIDA del PDF de la que se adopto del monto pagado (v5.7.1): el badge no
      // puede decir "DEL EXTRACTO" sobre un numero que salio del teclado del usuario.
      ext.oficial_es_ajuste = ext.tiene_oficial && ext.fuente_oficial === "ajuste por dias de interes";
      if (ext.tiene_oficial) {
        ext.pago_minimo_calculado = ext.pago_minimo;
        ext.pago_total_calculado = ext.pago_total;
        ext.pago_minimo = ext.pago_minimo_oficial;
        if (ext.pago_total_oficial != null) ext.pago_total = ext.pago_total_oficial;
      }
    });

    const filtered = result.filter(ext => ext.estado === 'pagado' || ext.pago_minimo > 0 || ext.pago_total > 0);
    result.forEach(ext => {
      if (ext.estado === 'pendiente' && ext.pago_minimo <= 0 && ext.pago_total <= 0) {
        db.prepare('DELETE FROM extractos WHERE id=?').run(ext.id);
      }
    });

    res.json(filtered);
  });
};
