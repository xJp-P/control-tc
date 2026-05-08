// backend/routes/extractos.js — /api/extractos + pagar
const { Router } = require('express');
const { hoyLocal, daysBetween, addDays } = require('../helpers/dates');
const { calcularAmortizacionAvance } = require('../engine/amortizacion');
const { calcularAmortizacionDiferida } = require('../engine/amortizacion');
const { esNuBank, nuOpts, avanceOpts, isDualExtracto, aplicaIntInternacional } = require('../helpers/banco');

module.exports = function(db, { logAction, tjNombre }) {
  const router = Router();

  // Helper: calculate pago minimo and pago total for a given ciclo
  function calcExtracto(tarjetaId, cicloStr, incluirPagadas) {
    const tj = db.prepare('SELECT * FROM tarjetas WHERE id=?').get(tarjetaId);
    if (!tj) return null;
    const diaCorte = tj.dia_corte || 30;
    const diaPago = tj.dia_pago || 16;
    const esRappiCardCalc = tj.banco && (tj.banco.toLowerCase().includes('rappi') || tj.banco.toLowerCase().includes('davivienda'));
    const esNuCalc = esNuBank(db, tj);
    const dualExtracto = !esNuCalc && isDualExtracto(tj.franquicia);
    const aplicaIntl = aplicaIntInternacional(tj.banco, tj.franquicia);

    const [year, month] = cicloStr.split('-').map(Number);
    const lastDayOfMonth = new Date(year, month, 0).getDate();
    const fechaCorte = new Date(year, month - 1, Math.min(diaCorte, lastDayOfMonth)).toISOString().slice(0, 10);
    let fechaPago;
    if (esRappiCardCalc) {
      // RappiCard/Davivienda: fecha de pago = fecha de corte + 14 dias
      fechaPago = addDays(fechaCorte, 14);
    } else {
      fechaPago = new Date(year, month, diaPago).toISOString().slice(0, 10);
    }

    const comprasIndividuales = db.prepare(`
      SELECT c.id, c.fecha, c.descripcion, c.valor_cop, c.valor_usd, c.tasa_usd,
             COALESCE(c.monto_abonado,0) as monto_abonado, c.estado, c.grupo_id, c.persona_id,
             COALESCE(c.es_internacional,0) as es_internacional,
             p.nombre as persona_nombre, p.color as persona_color
      FROM compras c LEFT JOIN personas p ON c.persona_id = p.id
      WHERE c.tarjeta_id=? AND c.ciclo=? AND c.estado NOT IN ('pagado','diferida')
    `).all(tarjetaId, cicloStr);
    const comprasCiclo = { total: comprasIndividuales.reduce((s, c) => s + (c.valor_cop - c.monto_abonado), 0) };
    const comprasPagadasCiclo = incluirPagadas
      ? db.prepare(`
          SELECT c.id, c.fecha, c.descripcion, c.valor_cop, c.valor_usd, c.tasa_usd,
                 c.valor_cop as monto_abonado, c.estado, c.grupo_id, c.persona_id,
                 p.nombre as persona_nombre, p.color as persona_color
          FROM compras c LEFT JOIN personas p ON c.persona_id = p.id
          WHERE c.tarjeta_id=? AND c.ciclo=? AND c.estado='pagado'
        `).all(tarjetaId, cicloStr)
      : [];

    let cuotasCapital = 0, cuotasInteres = 0, cuotasTotal = 0, avancesTotal = 0, diferidasTotal = 0;
    const detalleAvances = [], detalleDiferidas = [];
    let saldoTotalAvances = 0, saldoTotalDiferidas = 0;

    const avancesQuery = incluirPagadas ? "SELECT * FROM avances WHERE tarjeta_id=? AND estado IN ('activo','liquidado')" : "SELECT * FROM avances WHERE tarjeta_id=? AND estado='activo'";
    const avancesActivos = db.prepare(avancesQuery).all(tarjetaId);
    avancesActivos.forEach(av => {
      const abonos = db.prepare('SELECT * FROM abonos_avance WHERE avance_id=? ORDER BY fecha').all(av.id);
      const amort = calcularAmortizacionAvance(av.monto, av.tasa_mv, av.plazo, av.fecha_desembolso, av.dia_corte, abonos, av.comision, avanceOpts(db, av.tarjeta_id));
      saldoTotalAvances += amort.resumen.saldoActual;
      const cuota = amort.tabla.find(r => r.fechaCorte.slice(0, 7) === cicloStr);
      if (cuota) {
        cuotasCapital += cuota.cuotaCapital;
        cuotasInteres += cuota.interes;
        cuotasTotal += cuota.totalExtracto;
        avancesTotal += cuota.totalExtracto;
        detalleAvances.push({ etiqueta: av.etiqueta, fecha: av.fecha_desembolso, capital: Math.round(cuota.cuotaCapital), interes: Math.round(cuota.interes), total: Math.round(cuota.totalExtracto) });
      }
    });

    const diferidasQuery = incluirPagadas ? "SELECT * FROM diferidas WHERE tarjeta_id=? AND estado IN ('activo','liquidado')" : "SELECT * FROM diferidas WHERE tarjeta_id=? AND estado='activo'";
    const diferidasActivas = db.prepare(diferidasQuery).all(tarjetaId);
    diferidasActivas.forEach(d => {
      const abonosDif = db.prepare('SELECT * FROM abonos_diferida WHERE diferida_id=? ORDER BY fecha').all(d.id);
      const amort = calcularAmortizacionDiferida(d.monto, d.tasa_mv, d.num_cuotas, d.fecha_compra, d.fecha_primer_corte, abonosDif, nuOpts(db, d.tarjeta_id));
      const cuotaIdx = amort.tabla.findIndex(r => r.fechaCorte.slice(0, 7) >= cicloStr);
      if (cuotaIdx !== -1) {
        saldoTotalDiferidas += (cuotaIdx > 0 ? Math.max(0, amort.tabla[cuotaIdx - 1].saldoInicial - amort.tabla[cuotaIdx - 1].cuotaCapital) : d.monto);
      }
      const cuota = amort.tabla.find(r => r.fechaCorte.slice(0, 7) === cicloStr);
      if (cuota) {
        cuotasCapital += cuota.cuotaCapital;
        cuotasInteres += cuota.interesTotal;
        cuotasTotal += cuota.totalPagar;
        diferidasTotal += cuota.totalPagar;
        // Buscar la compra vinculada para enriquecer con grupo_id y persona (puede ser null para diferidas
        // creadas directamente sin compra, ej: RappiCard).
        const compraVinc = db.prepare(`
          SELECT c.id, c.grupo_id, c.persona_id, p.nombre as persona_nombre, p.color as persona_color
          FROM compras c LEFT JOIN personas p ON c.persona_id = p.id
          WHERE c.diferida_id = ? LIMIT 1
        `).get(d.id);
        detalleDiferidas.push({
          etiqueta: d.etiqueta, fecha: d.fecha_compra,
          capital: Math.round(cuota.cuotaCapital), interes: Math.round(cuota.interesTotal), total: Math.round(cuota.totalPagar),
          compra_id: compraVinc ? compraVinc.id : null,
          grupo_id: compraVinc ? compraVinc.grupo_id : null,
          persona_id: compraVinc ? compraVinc.persona_id : null,
          persona_nombre: compraVinc ? compraVinc.persona_nombre : null,
          persona_color: compraVinc ? compraVinc.persona_color : null
        });
      }
    });

    const comprasTotalPendientes = db.prepare("SELECT COALESCE(SUM(valor_cop - COALESCE(monto_abonado,0)),0) as total FROM compras WHERE tarjeta_id=? AND estado NOT IN ('pagado','diferida')").get(tarjetaId);
    const tasaIntl = tj.tasa_mv_avances || 0.01911;
    let interesesComprasIntl = 0, interesesComprasUsd = 0;

    comprasIndividuales.forEach(c => {
      if (dualExtracto) {
        // Mastercard / Amex (extracto dual):
        // Las compras USD a 1 cuota NO devengan intereses si se pagan al vencimiento.
        // El banco solo cobra interés en USD cuando:
        //   (a) la compra se difiere a más de 1 cuota (manejado por amortizacion.js diferidas), o
        //   (b) hay saldo del mes anterior que no se cubrió (revolving) — pendiente de modelar.
        // Por eso ya NO aplicamos el proxy `valor_usd × tasa × días/30` que sobre-estimaba.
        // Las compras de comprasIndividuales son por definición de 1 cuota (estado != 'diferida').
        return;
      }
      // Solo tarjetas que aplican (Bancolombia Visa por ahora) cobran intereses
      // sobre compras en COP marcadas como internacionales o sobre compras USD.
      // Otras tarjetas (RappiCard, Nu, etc.) NO acumulan estos intereses hasta
      // tener evidencia de extracto que confirme el cobro.
      if (!aplicaIntl) return;
      const esIntl = (c.valor_usd && c.valor_usd > 0) || c.es_internacional;
      if (!esIntl) return;
      const saldo = c.valor_cop - c.monto_abonado;
      if (saldo <= 0) return;
      const dias = daysBetween(c.fecha, fechaCorte);
      interesesComprasIntl += saldo * tasaIntl * (dias / 30);
    });
    interesesComprasIntl = Math.round(interesesComprasIntl);
    interesesComprasUsd = Math.round(interesesComprasUsd * 100) / 100;

    let comprasUsdTotal = 0, pagoMinimoUsd = 0;
    const detalleComprasUsd = [];
    if (dualExtracto) {
      const comprasUsdCiclo = comprasIndividuales.filter(c => c.valor_usd && c.valor_usd > 0);
      const comprasUsdPagadas = incluirPagadas ? comprasPagadasCiclo.filter(c => c.valor_usd && c.valor_usd > 0) : [];
      const todasUsd = [...comprasUsdPagadas, ...comprasUsdCiclo];
      comprasUsdTotal = Math.round(comprasUsdCiclo.reduce((s, c) => s + c.valor_usd, 0) * 100) / 100;
      todasUsd.forEach(c => {
        detalleComprasUsd.push({ fecha: c.fecha, descripcion: c.descripcion, total_usd: Math.round(c.valor_usd * 100) / 100, tasa_usd: c.tasa_usd || null });
      });
      pagoMinimoUsd = Math.round((comprasUsdTotal + interesesComprasUsd) * 100) / 100;
    }

    const pagoMinimo = Math.round(comprasCiclo.total + cuotasTotal + interesesComprasIntl);
    // Pago total incluye intereses corrientes del mes (cuotas de diferidas/avances + USD)
    const pagoTotal = Math.round(comprasTotalPendientes.total + saldoTotalAvances + saldoTotalDiferidas + cuotasInteres + interesesComprasIntl);

    const todasComprasCiclo = incluirPagadas ? [...comprasPagadasCiclo, ...comprasIndividuales] : comprasIndividuales;
    const comprasCopParaDetalle = dualExtracto
      ? todasComprasCiclo.filter(c => !c.valor_usd || c.valor_usd <= 0)
      : todasComprasCiclo;
    // Calcula el interés INTL atribuido a cada compra individual para el desglose.
    // Solo aplica a tarjetas que devengan intereses internacionales (Bancolombia Visa).
    const calcInteresIntlPorCompra = (c) => {
      if (!aplicaIntl) return 0;
      if (!c.es_internacional && !(c.valor_usd && c.valor_usd > 0)) return 0;
      const saldo = incluirPagadas ? c.valor_cop : (c.valor_cop - (c.monto_abonado || 0));
      if (saldo <= 0) return 0;
      const dias = daysBetween(c.fecha, fechaCorte);
      if (dias <= 0) return 0;
      return Math.round(saldo * tasaIntl * (dias / 30));
    };
    const detalleCompras = comprasCopParaDetalle.map(c => {
      const capital = Math.round(incluirPagadas ? c.valor_cop : (c.valor_cop - c.monto_abonado));
      const interes_intl = calcInteresIntlPorCompra(c);
      return {
        id: c.id,
        fecha: c.fecha, descripcion: c.descripcion,
        total: capital,
        interes_intl,
        es_internacional: !!(c.es_internacional || (c.valor_usd && c.valor_usd > 0)),
        valor_usd: c.valor_usd || null, tasa_usd: c.tasa_usd || null,
        grupo_id: c.grupo_id || null,
        persona_id: c.persona_id || null,
        persona_nombre: c.persona_nombre || null,
        persona_color: c.persona_color || null
      };
    });

    return {
      fechaCorte, fechaPago, pagoMinimo, pagoTotal,
      compras: Math.round(incluirPagadas ? comprasCopParaDetalle.reduce((s, c) => s + c.valor_cop, 0) : comprasCiclo.total),
      detalleCompras,
      cuotasCapital: Math.round(cuotasCapital), cuotasInteres: Math.round(cuotasInteres + interesesComprasIntl),
      avancesTotal: Math.round(avancesTotal), diferidasTotal: Math.round(diferidasTotal),
      interesesComprasIntl,
      detalleAvances, detalleDiferidas,
      dualExtracto,
      comprasUsd: comprasUsdTotal,
      interesesComprasUsd,
      pagoMinimoUsd,
      detalleComprasUsd
    };
  }

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
        const calc = calcExtracto(tarjeta_id, ciclo);
        if (calc && (calc.pagoTotal > 0 || calc.pagoMinimo > 0)) {
          db.prepare('INSERT OR IGNORE INTO extractos (tarjeta_id, ciclo, fecha_corte, fecha_pago, pago_minimo, pago_total, intereses_intl) VALUES (?,?,?,?,?,?,?)')
            .run(tarjeta_id, ciclo, calc.fechaCorte, calc.fechaPago, calc.pagoMinimo, calc.pagoTotal, calc.interesesComprasIntl || 0);
        }
      }
    });

    const result = db.prepare('SELECT * FROM extractos WHERE tarjeta_id=? ORDER BY ciclo DESC').all(tarjeta_id);
    result.forEach(ext => {
      const calc = calcExtracto(tarjeta_id, ext.ciclo, ext.estado === 'pagado');
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
        ext.pago_minimo_usd = calc.pagoMinimoUsd || 0;
        ext.detalle_compras_usd = calc.detalleComprasUsd || [];
        if (ext.estado === 'pendiente') {
          ext.pago_minimo = calc.pagoMinimo;
          ext.pago_total = calc.pagoTotal;
          ext.intereses_intl = calc.interesesComprasIntl || 0;
          db.prepare('UPDATE extractos SET pago_minimo=?, pago_total=?, fecha_corte=?, fecha_pago=?, intereses_intl=? WHERE id=?')
            .run(calc.pagoMinimo, calc.pagoTotal, calc.fechaCorte, calc.fechaPago, calc.interesesComprasIntl || 0, ext.id);
        }
        // Para extractos PAGADOS conservamos el intereses_intl que se persistió al cerrar.
        // Ya viene desde el SELECT inicial y NO se sobreescribe acá.
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
    const { monto_pagado, fecha_pagado, tipo } = req.body;
    const ext = db.prepare('SELECT * FROM extractos WHERE id=?').get(req.params.id);
    if (!ext) return res.status(404).json({ error: 'Extracto no encontrado' });

    const montoAbono = parseFloat(monto_pagado) || ext.pago_minimo;
    const fechaPagado = fecha_pagado || hoyLocal();
    const tipoPago = tipo || 'abono_extracto';
    const nuevoMontoPagado = (ext.monto_pagado || 0) + montoAbono;
    const pagadoCompleto = nuevoMontoPagado >= ext.pago_minimo;

    if (pagadoCompleto) {
      // Congelar intereses_intl al cerrar el extracto: usamos el valor calculado
      // sobre el estado actual de las compras del ciclo. Una vez pagado, el GET
      // ya no recalcula y este valor queda persistente en el historial.
      const calcCierre = calcExtracto(ext.tarjeta_id, ext.ciclo, false);
      const interesesIntlFinal = calcCierre ? (calcCierre.interesesComprasIntl || 0) : (ext.intereses_intl || 0);
      db.prepare("UPDATE extractos SET estado='pagado', monto_pagado=?, fecha_pagado=?, intereses_intl=? WHERE id=?")
        .run(nuevoMontoPagado, fechaPagado, interesesIntlFinal, req.params.id);
      db.prepare("UPDATE compras SET estado='pagado', monto_abonado=valor_cop WHERE tarjeta_id=? AND ciclo=? AND estado NOT IN ('pagado','diferida')")
        .run(ext.tarjeta_id, ext.ciclo);
    } else {
      db.prepare("UPDATE extractos SET monto_pagado=?, fecha_pagado=? WHERE id=?")
        .run(nuevoMontoPagado, fechaPagado, req.params.id);
    }

    db.prepare('INSERT INTO pagos (tarjeta_id, fecha, monto, tipo, ciclo, notas) VALUES (?,?,?,?,?,?)')
      .run(ext.tarjeta_id, fechaPagado, montoAbono, tipoPago, ext.ciclo,
        (pagadoCompleto ? 'Pago completo extracto ' : 'Abono a extracto ') + ext.ciclo);

    const fmt = new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',maximumFractionDigits:0}).format(montoAbono);
    logAction('pago', tjNombre(ext.tarjeta_id) + (pagadoCompleto ? 'Extracto pagado: ' : 'Abono a extracto: ') + ext.ciclo + ' por ' + fmt);
    res.json({ ok: true, pagadoCompleto, nuevoMontoPagado });
  });

  return router;
};
