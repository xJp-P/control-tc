// backend/routes/extractos.js — /api/extractos + pagar
const { Router } = require('express');
const { hoyLocal } = require('../helpers/dates');
const { calcularAmortizacionAvance, calcularAmortizacionDiferida } = require('../engine/amortizacion');
const { nuOpts, avanceOpts } = require('../helpers/banco');
const { calcExtracto } = require('../engine/extracto');

module.exports = function(db, { logAction, tjNombre }) {
  const router = Router();

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
      const amort = calcularAmortizacionDiferida(d.monto, d.tasa_mv, d.num_cuotas, d.fecha_compra, d.fecha_primer_corte, null, nuOpts(db, d.tarjeta_id));
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
      SELECT ext.*, fpc.fecha_pago as fecha_pago_custom
      FROM extractos ext
      LEFT JOIN fechas_pago_custom fpc ON fpc.tarjeta_id = ext.tarjeta_id AND fpc.ciclo = ext.ciclo
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
    });

    const filtered = result.filter(ext => ext.estado === 'pagado' || ext.pago_minimo > 0 || ext.pago_total > 0);
    result.forEach(ext => {
      if (ext.estado === 'pendiente' && ext.pago_minimo <= 0 && ext.pago_total <= 0) {
        db.prepare('DELETE FROM extractos WHERE id=?').run(ext.id);
      }
    });

    res.json(filtered);
  });

  router.put('/:id/pagar', (req, res) => {
    const { monto_pagado, fecha_pagado, tipo, moneda } = req.body;
    const ext = db.prepare('SELECT * FROM extractos WHERE id=?').get(req.params.id);
    if (!ext) return res.status(404).json({ error: 'Extracto no encontrado' });

    const monedaPago = (moneda === 'USD') ? 'USD' : 'COP';
    const fechaPagado = fecha_pagado || hoyLocal();
    const tipoPago = tipo || 'abono_extracto';

    if (monedaPago === 'COP') {
      const montoAbono = parseFloat(monto_pagado) || ext.pago_minimo;
      const nuevoMontoPagado = (ext.monto_pagado || 0) + montoAbono;
      const pagadoCompleto = nuevoMontoPagado >= ext.pago_minimo;

      if (pagadoCompleto) {
        const calcCierre = calcExtracto(db, ext.tarjeta_id, ext.ciclo, false);
        const interesesIntlFinal = calcCierre ? (calcCierre.interesesComprasIntl || 0) : (ext.intereses_intl || 0);
        db.prepare("UPDATE extractos SET estado='pagado', monto_pagado=?, fecha_pagado=?, intereses_intl=? WHERE id=?")
          .run(nuevoMontoPagado, fechaPagado, interesesIntlFinal, req.params.id);
        // Solo marca como pagadas las compras COP del ciclo (sin USD). Las compras
        // USD se marcan cuando se cierre la porción USD.
        db.prepare(`UPDATE compras SET estado='pagado', monto_abonado=valor_cop
          WHERE tarjeta_id=? AND ciclo=? AND estado NOT IN ('pagado','diferida')
            AND (valor_usd IS NULL OR valor_usd = 0)`)
          .run(ext.tarjeta_id, ext.ciclo);
      } else {
        db.prepare("UPDATE extractos SET monto_pagado=?, fecha_pagado=? WHERE id=?")
          .run(nuevoMontoPagado, fechaPagado, req.params.id);
      }

      db.prepare("INSERT INTO pagos (tarjeta_id, fecha, monto, tipo, ciclo, notas, moneda) VALUES (?,?,?,?,?,?,'COP')")
        .run(ext.tarjeta_id, fechaPagado, montoAbono, tipoPago, ext.ciclo,
          (pagadoCompleto ? 'Pago completo extracto COP ' : 'Abono a extracto COP ') + ext.ciclo);

      const fmt = new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',maximumFractionDigits:0}).format(montoAbono);
      logAction('pago', tjNombre(ext.tarjeta_id) + (pagadoCompleto ? 'Extracto pagado COP: ' : 'Abono a extracto COP: ') + ext.ciclo + ' por ' + fmt);
      return res.json({ ok: true, pagadoCompleto, nuevoMontoPagado, moneda: 'COP' });
    }

    // moneda === 'USD'
    const montoAbonoUsd = parseFloat(monto_pagado) || ext.pago_minimo_usd || 0;
    const nuevoMontoPagadoUsd = (ext.monto_pagado_usd || 0) + montoAbonoUsd;
    const pagadoCompletoUsd = nuevoMontoPagadoUsd >= (ext.pago_minimo_usd || 0);

    if (pagadoCompletoUsd) {
      db.prepare("UPDATE extractos SET estado_usd='pagado', monto_pagado_usd=?, fecha_pagado_usd=? WHERE id=?")
        .run(nuevoMontoPagadoUsd, fechaPagado, req.params.id);
      // Solo marca como pagadas las compras USD del ciclo.
      db.prepare(`UPDATE compras SET estado='pagado', monto_abonado=valor_cop
        WHERE tarjeta_id=? AND ciclo=? AND estado NOT IN ('pagado','diferida')
          AND valor_usd IS NOT NULL AND valor_usd > 0`)
        .run(ext.tarjeta_id, ext.ciclo);
    } else {
      db.prepare("UPDATE extractos SET monto_pagado_usd=?, fecha_pagado_usd=? WHERE id=?")
        .run(nuevoMontoPagadoUsd, fechaPagado, req.params.id);
    }

    db.prepare("INSERT INTO pagos (tarjeta_id, fecha, monto, tipo, ciclo, notas, moneda) VALUES (?,?,?,?,?,?,'USD')")
      .run(ext.tarjeta_id, fechaPagado, montoAbonoUsd, tipoPago, ext.ciclo,
        (pagadoCompletoUsd ? 'Pago completo extracto USD ' : 'Abono a extracto USD ') + ext.ciclo);

    const fmtUsd = 'USD $' + new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(montoAbonoUsd);
    logAction('pago', tjNombre(ext.tarjeta_id) + (pagadoCompletoUsd ? 'Extracto pagado USD: ' : 'Abono a extracto USD: ') + ext.ciclo + ' por ' + fmtUsd);
    return res.json({ ok: true, pagadoCompleto: pagadoCompletoUsd, nuevoMontoPagado: nuevoMontoPagadoUsd, moneda: 'USD' });
  });

  // ── Override manual de fecha de pago por ciclo ──────────────────────
  // PUT /api/extractos/fecha-pago-custom
  // Body: { tarjeta_id, ciclo, fecha_pago }  → si fecha_pago es null/vacía, elimina el override.
  // Es un "display override": no toca extractos.fecha_pago ni recalcula intereses ni pago mínimo.
  router.put('/fecha-pago-custom', (req, res) => {
    const { tarjeta_id, ciclo, fecha_pago } = req.body;
    if (!tarjeta_id || !ciclo) return res.status(400).json({ error: 'tarjeta_id y ciclo son requeridos' });
    const fp = fecha_pago && String(fecha_pago).trim() ? String(fecha_pago).slice(0, 10) : null;
    if (fp) {
      db.prepare('INSERT INTO fechas_pago_custom (tarjeta_id, ciclo, fecha_pago) VALUES (?,?,?) ON CONFLICT(tarjeta_id, ciclo) DO UPDATE SET fecha_pago=?')
        .run(tarjeta_id, ciclo, fp, fp);
      logAction('editar', tjNombre(tarjeta_id) + 'Fecha de pago manual fijada para ' + ciclo + ': ' + fp);
      res.json({ ok: true, fecha_pago: fp, esManual: true });
    } else {
      db.prepare('DELETE FROM fechas_pago_custom WHERE tarjeta_id=? AND ciclo=?').run(tarjeta_id, ciclo);
      logAction('editar', tjNombre(tarjeta_id) + 'Override de fecha de pago eliminado para ' + ciclo);
      res.json({ ok: true, fecha_pago: null, esManual: false });
    }
  });

  return router;
};
