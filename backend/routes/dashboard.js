// backend/routes/dashboard.js — /api/dashboard
const { Router } = require('express');
const { hoyLocal, daysBetween, addDays } = require('../helpers/dates');
const { calcularAmortizacionAvance } = require('../engine/amortizacion');
const { calcularAmortizacionDiferida } = require('../engine/amortizacion');
const { nuOpts, avanceOpts, isDualExtracto, aplicaIntInternacional } = require('../helpers/banco');

module.exports = function(db) {
  const router = Router();

  router.get('/', (req, res) => {
    const { tarjeta_id, ciclo: cicloParam } = req.query;
    const hoy = hoyLocal();
    const cicloActual = cicloParam || hoy.slice(0, 7);
    const cicloReal = hoy.slice(0, 7);

    const tjFilter = tarjeta_id ? ' AND tarjeta_id = ?' : '';
    const tjParams = tarjeta_id ? [tarjeta_id] : [];

    let diaCorte = 30, diaPago = 16, esRappiDash = false, dualExtractoDash = false, tasaIntlGlobal = 0.01911, aplicaIntlDash = false;
    if (tarjeta_id) {
      const tj = db.prepare('SELECT dia_corte, dia_pago, banco, franquicia, tasa_mv_avances FROM tarjetas WHERE id=?').get(tarjeta_id);
      if (tj) {
        diaCorte = tj.dia_corte;
        diaPago = tj.dia_pago || 16;
        esRappiDash = tj.banco && (tj.banco.toLowerCase().includes('rappi') || tj.banco.toLowerCase().includes('davivienda'));
        dualExtractoDash = isDualExtracto(tj.franquicia);
        aplicaIntlDash = aplicaIntInternacional(tj.banco, tj.franquicia);
        if (tj.tasa_mv_avances) tasaIntlGlobal = tj.tasa_mv_avances;
      }
    }

    const comprasCiclo = db.prepare("SELECT COALESCE(SUM(valor_cop - COALESCE(monto_abonado,0)),0) as total FROM compras WHERE ciclo=? AND estado NOT IN ('pagado','diferida')" + tjFilter).get(cicloActual, ...tjParams);
    const saldoBolsilloCompras = db.prepare("SELECT COALESCE(SUM(CASE WHEN estado='bolsillo' THEN valor_cop WHEN estado='bolsillo_parcial' THEN COALESCE(monto_bolsillo,0) WHEN estado='diferida' THEN COALESCE(monto_bolsillo,0) ELSE 0 END),0) as total FROM compras WHERE ciclo=? AND estado IN ('bolsillo','bolsillo_parcial','diferida')" + tjFilter).get(cicloActual, ...tjParams);
    const saldoBolsilloAvances = db.prepare("SELECT COALESCE(SUM(COALESCE(monto_bolsillo,0)),0) as total FROM avances WHERE estado='activo'" + tjFilter).get(...tjParams);
    // Diferidas sin compra vinculada (ej: RappiCard registradas directamente) guardan bolsillo en diferidas.monto_bolsillo
    const saldoBolsilloDiferidas = db.prepare("SELECT COALESCE(SUM(COALESCE(monto_bolsillo,0)),0) as total FROM diferidas WHERE estado='activo' AND id NOT IN (SELECT COALESCE(diferida_id,0) FROM compras WHERE diferida_id IS NOT NULL)" + tjFilter).get(...tjParams);
    const saldoBolsillo = { total: (saldoBolsilloCompras.total || 0) + (saldoBolsilloAvances.total || 0) + (saldoBolsilloDiferidas.total || 0) };

    // Me Deben (total histórico): replica EXACTAMENTE la fórmula de la card "Me deben" en Terceros.
    //   - 1 cuota: valor_cop - monto_bolsillo
    //   - Diferida: suma de cuotas no pagadas (fechaCorte >= hoy) y no cubiertas por bolsillo
    //               (el bolsillo cubre la cuota del calendario si bolsillo >= cuota.total)
    // El bolsillo afecta el total visual al apartar dinero. Incluye todas las compras pendientes.
    const comprasTerceroAll = db.prepare(`
      SELECT c.id, c.tarjeta_id, c.persona_id, p.nombre, p.color, c.valor_cop, c.estado,
        c.diferida_id, c.descripcion, c.fecha, c.ciclo,
        COALESCE(c.es_internacional, 0) as es_internacional,
        COALESCE(c.monto_bolsillo, 0) as bolsillo,
        t.dia_corte as tarjeta_dia_corte,
        COALESCE(t.tasa_mv_avances, 0.01911) as tarjeta_tasa_intl,
        t.franquicia as tarjeta_franquicia,
        t.banco as tarjeta_banco
      FROM compras c JOIN personas p ON c.persona_id = p.id JOIN tarjetas t ON c.tarjeta_id = t.id
      WHERE c.tercero_pagado = 0${tjFilter}
    `).all(...tjParams);
    const meDebenMap = {};
    comprasTerceroAll.forEach(c => {
      let pendiente = 0;
      if (c.estado === 'diferida') {
        // Buscar la diferida vinculada (igual que en routes/terceros.js)
        const dif = c.diferida_id
          ? db.prepare('SELECT * FROM diferidas WHERE id=?').get(c.diferida_id)
          : db.prepare('SELECT * FROM diferidas WHERE tarjeta_id=? AND etiqueta=? AND fecha_compra=?').get(c.tarjeta_id, c.descripcion, c.fecha);
        if (!dif) return;
        const amort = calcularAmortizacionDiferida(c.valor_cop, dif.tasa_mv, dif.num_cuotas, dif.fecha_compra, dif.fecha_primer_corte, null, nuOpts(db, c.tarjeta_id));
        const bolsilloRound = Math.round(c.bolsillo);
        const cuotasBase = amort.tabla.map(r => ({
          total: Math.round(r.totalPagar),
          pagada: r.fechaCorte < hoy
        }));
        // Per-cuota bolsillo: cada cuota tiene su propio monto apartado
        const bolCuotasDash = db.prepare('SELECT cuota_num, monto FROM bolsillo_cuotas WHERE compra_id=?').all(c.id);
        const bolMapDash = {};
        bolCuotasDash.forEach(b => { bolMapDash[b.cuota_num] = Math.round(b.monto); });
        const cuotas = cuotasBase.map((q, i) => ({
          ...q,
          cubierta_bolsillo: (bolMapDash[i + 1] || 0) >= q.total
        }));
        pendiente = cuotas.filter(q => !q.pagada && !q.cubierta_bolsillo).reduce((s, q) => s + q.total, 0);
      } else {
        // 1 cuota: valor - bolsillo (+ interés intl si la tarjeta aplica)
        pendiente = c.valor_cop - c.bolsillo;
        if (c.es_internacional && c.ciclo) {
          const cDiaCorte = tarjeta_id ? diaCorte : (c.tarjeta_dia_corte || 30);
          const cTasaIntl = tarjeta_id ? tasaIntlGlobal : (c.tarjeta_tasa_intl || 0.01911);
          const cAplicaIntl = tarjeta_id ? aplicaIntlDash : aplicaIntInternacional(c.tarjeta_banco, c.tarjeta_franquicia);
          if (cAplicaIntl) {
            const [yr, mo] = c.ciclo.split('-').map(Number);
            const lastDay = new Date(yr, mo, 0).getDate();
            const fCorte = new Date(yr, mo - 1, Math.min(cDiaCorte, lastDay)).toISOString().slice(0, 10);
            const dias = daysBetween(c.fecha, fCorte);
            if (dias > 0) pendiente += Math.round(c.valor_cop * cTasaIntl * (dias / 30));
          }
        }
      }
      if (pendiente <= 0) return;
      if (!meDebenMap[c.persona_id]) meDebenMap[c.persona_id] = { nombre: c.nombre, color: c.color, total: 0 };
      meDebenMap[c.persona_id].total += pendiente;
    });
    const meDeben = Object.values(meDebenMap).map(r => ({ nombre: r.nombre, color: r.color, total: Math.round(r.total) }));
    const totalMeDeben = meDeben.reduce((s, r) => s + r.total, 0);

    const avancesActivos = db.prepare("SELECT * FROM avances WHERE estado='activo'" + tjFilter).all(...tjParams);
    let deudaAvances = 0, interesesMesAvances = 0;
    const proximosPagos = [];

    avancesActivos.forEach(av => {
      const abonos = db.prepare('SELECT * FROM abonos_avance WHERE avance_id=? ORDER BY fecha').all(av.id);
      const amort = calcularAmortizacionAvance(av.monto, av.tasa_mv, av.plazo, av.fecha_desembolso, av.dia_corte, abonos, av.comision, avanceOpts(db, av.tarjeta_id));
      deudaAvances += amort.resumen.saldoActual;
      const cuotaActual = cicloParam
        ? amort.tabla.find(r => r.fechaCorte.slice(0, 7) === cicloActual)
        : amort.tabla.find(r => r.fechaCorte >= hoy);
      if (cuotaActual) {
        interesesMesAvances += cuotaActual.interes;
        proximosPagos.push({ tipo: 'avance', etiqueta: av.etiqueta, fechaCorte: cuotaActual.fechaCorte, interes: cuotaActual.interes, capital: cuotaActual.cuotaCapital, total: cuotaActual.totalExtracto });
      }
    });

    const diferidasActivas = db.prepare("SELECT * FROM diferidas WHERE estado='activo'" + tjFilter).all(...tjParams);
    let deudaDiferidas = 0, interesesMesDiferidas = 0;
    // Para "Deuda Personal del corte": suma de la cuota del ciclo de diferidas SIN persona vinculada (personal o RappiCard directa)
    let cuotasDiferidasPersonalCorte = 0;

    diferidasActivas.forEach(d => {
      const abonosDif = db.prepare('SELECT * FROM abonos_diferida WHERE diferida_id=? ORDER BY fecha').all(d.id);
      const amort = calcularAmortizacionDiferida(d.monto, d.tasa_mv, d.num_cuotas, d.fecha_compra, d.fecha_primer_corte, abonosDif, nuOpts(db, d.tarjeta_id));
      deudaDiferidas += amort.resumen.saldoActual;
      const cuotaActual = cicloParam
        ? amort.tabla.find(r => r.fechaCorte.slice(0, 7) === cicloActual)
        : amort.tabla.find(r => r.fechaCorte >= hoy);
      if (cuotaActual) {
        interesesMesDiferidas += cuotaActual.interesTotal;
        proximosPagos.push({ tipo: 'diferida', etiqueta: d.etiqueta, fechaCorte: cuotaActual.fechaCorte, interes: cuotaActual.interesTotal, capital: cuotaActual.cuotaCapital, total: cuotaActual.totalPagar });
        // Si la diferida no tiene compra de tercero vinculada, su cuota suma a deuda personal
        const compraVinc = db.prepare('SELECT persona_id FROM compras WHERE diferida_id=? LIMIT 1').get(d.id);
        if (!compraVinc || !compraVinc.persona_id) {
          cuotasDiferidasPersonalCorte += cuotaActual.totalPagar;
        }
      }
    });

    const now = new Date();
    let proximoCorteDate;
    if (now.getDate() < diaCorte) {
      proximoCorteDate = new Date(now.getFullYear(), now.getMonth(), diaCorte);
    } else {
      proximoCorteDate = new Date(now.getFullYear(), now.getMonth() + 1, diaCorte);
    }
    const diasParaCorte = Math.ceil((proximoCorteDate - now) / 86400000);

    const totalAbonosHist = db.prepare('SELECT COALESCE(SUM(monto),0) as total FROM abonos_avance' + (tarjeta_id ? ' WHERE avance_id IN (SELECT id FROM avances WHERE tarjeta_id=?)' : '')).get(...tjParams);
    const totalPagos = db.prepare('SELECT COALESCE(SUM(monto),0) as total FROM pagos WHERE 1=1' + tjFilter).get(...tjParams);
    const cuotasCorte = proximosPagos.reduce((s, p) => s + p.total, 0);
    const interesesCorte = proximosPagos.reduce((s, p) => s + p.interes, 0);

    const comprasPendientesCiclo = db.prepare("SELECT COALESCE(SUM(valor_cop - COALESCE(monto_abonado,0)),0) as total FROM compras WHERE ciclo=? AND estado NOT IN ('pagado','diferida')" + tjFilter).get(cicloActual, ...tjParams);
    const todasComprasPendientes = db.prepare("SELECT COALESCE(SUM(valor_cop - COALESCE(monto_abonado,0)),0) as total FROM compras WHERE estado NOT IN ('pagado','diferida')" + tjFilter).get(...tjParams);

    let deudaImpagaAvances = 0, deudaImpagaDiferidas = 0;
    if (tarjeta_id) {
      const extractosImpagos2 = db.prepare("SELECT ciclo FROM extractos WHERE tarjeta_id=? AND estado='pendiente' AND fecha_corte <= ?").all(tarjeta_id, hoy);
      extractosImpagos2.forEach(ext => {
        avancesActivos.forEach(av => {
          const abonos2 = db.prepare('SELECT * FROM abonos_avance WHERE avance_id=? ORDER BY fecha').all(av.id);
          const amort2 = calcularAmortizacionAvance(av.monto, av.tasa_mv, av.plazo, av.fecha_desembolso, av.dia_corte, abonos2, av.comision, avanceOpts(db, av.tarjeta_id));
          const cuota2 = amort2.tabla.find(r => r.fechaCorte.slice(0, 7) === ext.ciclo);
          if (cuota2) deudaImpagaAvances += cuota2.cuotaCapital;
        });
        diferidasActivas.forEach(d => {
          const abonosDif2 = db.prepare('SELECT * FROM abonos_diferida WHERE diferida_id=? ORDER BY fecha').all(d.id);
          const amort2 = calcularAmortizacionDiferida(d.monto, d.tasa_mv, d.num_cuotas, d.fecha_compra, d.fecha_primer_corte, abonosDif2, nuOpts(db, d.tarjeta_id));
          const cuota2 = amort2.tabla.find(r => r.fechaCorte.slice(0, 7) === ext.ciclo);
          if (cuota2) deudaImpagaDiferidas += cuota2.cuotaCapital;
        });
      });
    }
    deudaAvances += deudaImpagaAvances;
    deudaDiferidas += deudaImpagaDiferidas;

    let montoPagadoExtractoTotal = 0;
    if (tarjeta_id) {
      const extParciales = db.prepare("SELECT COALESCE(SUM(monto_pagado),0) as total FROM extractos WHERE tarjeta_id=? AND estado='pendiente' AND monto_pagado > 0").get(tarjeta_id);
      montoPagadoExtractoTotal = extParciales.total || 0;
    }
    let montoPagadoExtractoCiclo = 0, extractoCicloData = null;
    if (tarjeta_id) {
      const extCiclo = db.prepare("SELECT * FROM extractos WHERE tarjeta_id=? AND ciclo=?").get(tarjeta_id, cicloActual);
      if (extCiclo) {
        if (extCiclo.estado === 'pendiente') montoPagadoExtractoCiclo = extCiclo.monto_pagado || 0;
        if (extCiclo.estado === 'pagado') {
          extractoCicloData = { estado: 'pagado', pago_minimo: extCiclo.pago_minimo, pago_total: extCiclo.pago_total, monto_pagado: extCiclo.monto_pagado || 0, fecha_pagado: extCiclo.fecha_pagado, fecha_corte: extCiclo.fecha_corte, fecha_pago: extCiclo.fecha_pago };
        }
      }
    }

    const comprasUsdCiclo = db.prepare("SELECT COALESCE(SUM(valor_usd),0) as totalUsd, COALESCE(SUM(valor_cop - COALESCE(monto_abonado,0)),0) as totalCop FROM compras WHERE ciclo=? AND estado NOT IN ('pagado','diferida') AND valor_usd IS NOT NULL AND valor_usd > 0" + tjFilter).get(cicloActual, ...tjParams);
    const comprasCopCiclo = db.prepare("SELECT COALESCE(SUM(valor_cop - COALESCE(monto_abonado,0)),0) as totalCop FROM compras WHERE ciclo=? AND estado NOT IN ('pagado','diferida') AND (valor_usd IS NULL OR valor_usd = 0)" + tjFilter).get(cicloActual, ...tjParams);

    // interesesComprasIntl es la suma TOTAL (personal + tercero) — alimenta el card "Intereses del Mes".
    // interesesComprasIntlPersonal es solo la porción de compras sin persona_id — alimenta "Deuda Personal".
    let interesesComprasIntl = 0, interesesComprasIntlPersonal = 0, interesesComprasUsdDash = 0;
    if (tarjeta_id) {
      const tjIntl = db.prepare('SELECT tasa_mv_avances FROM tarjetas WHERE id=?').get(tarjeta_id);
      const tasaIntl = tjIntl ? tjIntl.tasa_mv_avances : 0.01911;
      const [anio, mes] = cicloActual.split('-').map(Number);
      const lastDayCorte = new Date(anio, mes, 0).getDate();
      const fechaCorteCiclo = new Date(anio, mes - 1, Math.min(diaCorte, lastDayCorte)).toISOString().slice(0, 10);

      if (dualExtractoDash) {
        // Mastercard / Amex: las compras USD a 1 cuota NO devengan intereses si se pagan
        // al vencimiento. Solo se generan intereses cuando hay diferida (>1 cuota) — manejado
        // por el motor de diferidas — o saldo revolvente del mes anterior — pendiente.
        // Antes hacíamos `valor_usd × tasa × días/30` lo cual sobre-estimaba.
        interesesComprasUsdDash = 0;
      } else if (aplicaIntlDash) {
        // Solo tarjetas que aplican (Bancolombia Visa por ahora) cobran interés sobre intl en COP.
        const queryInteres = "SELECT fecha, valor_cop, COALESCE(monto_abonado,0) as monto_abonado, persona_id FROM compras WHERE ciclo=? AND estado NOT IN ('pagado','diferida') AND (es_internacional=1 OR (valor_usd IS NOT NULL AND valor_usd > 0))" + tjFilter;
        const comprasIntlCiclo = db.prepare(queryInteres).all(cicloActual, ...tjParams);
        comprasIntlCiclo.forEach(c => {
          const saldo = c.valor_cop - c.monto_abonado;
          if (saldo <= 0) return;
          const dias = daysBetween(c.fecha, fechaCorteCiclo);
          if (dias <= 0) return;
          const interes = saldo * tasaIntl * (dias / 30);
          interesesComprasIntl += interes;
          if (!c.persona_id) interesesComprasIntlPersonal += interes;
        });
        interesesComprasIntl = Math.round(interesesComprasIntl);
        interesesComprasIntlPersonal = Math.round(interesesComprasIntlPersonal);
      }
    } else {
      // Global: calcula intereses intl por tarjeta solo donde aplica (Bancolombia Visa).
      const tarjetasGlobal = db.prepare("SELECT id, tasa_mv_avances, dia_corte, banco, franquicia FROM tarjetas WHERE estado='activa'").all();
      tarjetasGlobal.forEach(tj => {
        if (!aplicaIntInternacional(tj.banco, tj.franquicia)) return;
        const tasaIntl = tj.tasa_mv_avances || 0.01911;
        const [anio, mes] = cicloActual.split('-').map(Number);
        const lastDayTj = new Date(anio, mes, 0).getDate();
        const fechaCorteTj = new Date(anio, mes - 1, Math.min(tj.dia_corte, lastDayTj)).toISOString().slice(0, 10);
        const comprasIntlGlobal = db.prepare(
          "SELECT fecha, valor_cop, COALESCE(monto_abonado,0) as monto_abonado, persona_id FROM compras WHERE ciclo=? AND estado NOT IN ('pagado','diferida') AND (es_internacional=1 OR (valor_usd IS NOT NULL AND valor_usd > 0)) AND tarjeta_id=?"
        ).all(cicloActual, tj.id);
        comprasIntlGlobal.forEach(c => {
          const saldo = c.valor_cop - c.monto_abonado;
          if (saldo <= 0) return;
          const dias = daysBetween(c.fecha, fechaCorteTj);
          if (dias <= 0) return;
          const interes = saldo * tasaIntl * (dias / 30);
          interesesComprasIntl += interes;
          if (!c.persona_id) interesesComprasIntlPersonal += interes;
        });
      });
      interesesComprasIntl = Math.round(interesesComprasIntl);
      interesesComprasIntlPersonal = Math.round(interesesComprasIntlPersonal);
    }

    let pagoMinimoUsdDash = 0, deudaUsdDash = 0;
    if (dualExtractoDash) {
      pagoMinimoUsdDash = Math.round((comprasUsdCiclo.totalUsd + interesesComprasUsdDash) * 100) / 100;
      // Deuda total USD a fecha de corte = suma de valor_usd de compras pendientes/diferidas con USD
      const deudaUsdRow = db.prepare(
        "SELECT COALESCE(SUM(valor_usd),0) as total FROM compras WHERE valor_usd IS NOT NULL AND valor_usd > 0 AND estado NOT IN ('pagado')" + tjFilter
      ).get(...tjParams);
      deudaUsdDash = Math.round((deudaUsdRow.total || 0) * 100) / 100;
    }

    const cupoTotal = tarjeta_id
      ? (db.prepare("SELECT COALESCE(cupo_total,0) as total FROM tarjetas WHERE id=?").get(tarjeta_id) || {}).total || 0
      : (db.prepare("SELECT COALESCE(SUM(cupo_total),0) as total FROM tarjetas WHERE estado='activa'").get() || {}).total || 0;

    const deudaDelCorte = comprasPendientesCiclo.total + cuotasCorte;
    const deudaTotal = todasComprasPendientes.total + deudaAvances + deudaDiferidas - montoPagadoExtractoTotal;

    let pagoMinimoBruto = comprasPendientesCiclo.total + cuotasCorte + interesesComprasIntl;
    let pagoMinimo = Math.max(0, pagoMinimoBruto - montoPagadoExtractoCiclo);

    let comprasCicloHistorico = null;
    if (extractoCicloData) {
      pagoMinimoBruto = extractoCicloData.pago_minimo;
      pagoMinimo = 0;
      montoPagadoExtractoCiclo = extractoCicloData.monto_pagado;
      if (tarjeta_id) {
        const comprasPagadasCiclo = db.prepare("SELECT COALESCE(SUM(valor_cop),0) as total FROM compras WHERE tarjeta_id=? AND ciclo=? AND estado='pagado'").get(tarjeta_id, cicloActual);
        comprasCicloHistorico = comprasPagadasCiclo.total || 0;
      }
    }

    let fechaPago;
    if (esRappiDash) {
      // RappiCard/Davivienda: fecha de pago = fecha de corte + 14 dias
      const corteIso = proximoCorteDate.toISOString().slice(0, 10);
      // Buscamos el corte mas reciente cuya fecha+14 sea aun > hoy.
      // Si proximoCorte+14 > hoy, ese es el pago. Si no, sumamos un mes.
      let fechaPagoIso = addDays(corteIso, 14);
      let fechaPagoCandidate = new Date(fechaPagoIso + 'T00:00:00');
      if (fechaPagoCandidate <= now) {
        // Corte previo ya paso, usar siguiente
        const siguienteCorte = new Date(proximoCorteDate.getFullYear(), proximoCorteDate.getMonth() + 1, diaCorte);
        fechaPagoIso = addDays(siguienteCorte.toISOString().slice(0, 10), 14);
        fechaPagoCandidate = new Date(fechaPagoIso + 'T00:00:00');
      }
      fechaPago = fechaPagoCandidate;
    } else {
      if (now.getDate() < diaCorte) {
        fechaPago = new Date(now.getFullYear(), now.getMonth(), diaPago);
        if (fechaPago <= now) fechaPago = new Date(now.getFullYear(), now.getMonth() + 1, diaPago);
      } else {
        fechaPago = new Date(now.getFullYear(), now.getMonth() + 1, diaPago);
      }
    }
    const diasParaPago = Math.ceil((fechaPago - now) / 86400000);

    let extractosVencidos = [];
    if (tarjeta_id) {
      const rawExt = db.prepare("SELECT ciclo, pago_minimo, COALESCE(monto_pagado,0) as monto_pagado, fecha_pago FROM extractos WHERE tarjeta_id=? AND estado='pendiente' AND ciclo < ? ORDER BY ciclo ASC").all(tarjeta_id, cicloActual);
      extractosVencidos = rawExt
        .filter(e => e.pago_minimo - e.monto_pagado > 1)
        .map(e => ({ ciclo: e.ciclo, pagoMinimo: Math.round(e.pago_minimo), pagado: Math.round(e.monto_pagado), falta: Math.round(e.pago_minimo - e.monto_pagado), fechaPago: e.fecha_pago, tipo: e.fecha_pago < hoy ? 'vencido' : 'proximo' }));
    }

    // ─── Datos del corte: Deuda Personal y Me Deben Corte ─────────
    // Compras "Personal" del ciclo: pendientes (no pagado, no diferida) sin persona_id
    const comprasPersonalCiclo = db.prepare(
      "SELECT COALESCE(SUM(valor_cop - COALESCE(monto_abonado,0)),0) as total FROM compras WHERE ciclo=? AND estado NOT IN ('pagado','diferida') AND persona_id IS NULL" + tjFilter
    ).get(cicloActual, ...tjParams);
    // Cuotas de avances del ciclo (todos los avances son personales)
    let cuotasAvancesPersonalCorte = 0;
    avancesActivos.forEach(av => {
      const abonos = db.prepare('SELECT * FROM abonos_avance WHERE avance_id=? ORDER BY fecha').all(av.id);
      const amort = calcularAmortizacionAvance(av.monto, av.tasa_mv, av.plazo, av.fecha_desembolso, av.dia_corte, abonos, av.comision, avanceOpts(db, av.tarjeta_id));
      const cuota = amort.tabla.find(r => r.fechaCorte.slice(0, 7) === cicloActual);
      if (cuota) cuotasAvancesPersonalCorte += cuota.totalExtracto;
    });
    // Deuda Personal del corte = compras personales + cuotas avances + cuotas diferidas no-tercero
    //                          + intereses INTL SOLO de compras personales (los de terceros van a Me Deben Corte)
    const deudaPersonalCorte = Math.round(
      (comprasPersonalCiclo.total || 0) + cuotasAvancesPersonalCorte + cuotasDiferidasPersonalCorte + interesesComprasIntlPersonal
    );

    // Me Deben Corte: lo que cada tercero debe en este ciclo. Resta abono del tercero y bolsillo del usuario.
    const meDebenCorteMap = {};
    const meDebenCorte1Cuota = db.prepare(`
      SELECT c.persona_id, p.nombre, p.color, c.valor_cop, c.fecha,
        COALESCE(c.es_internacional, 0) as es_internacional,
        COALESCE(c.tercero_monto_abonado, 0) as abono,
        COALESCE(c.monto_bolsillo, 0) as bolsillo,
        t.dia_corte as tarjeta_dia_corte,
        COALESCE(t.tasa_mv_avances, 0.01911) as tarjeta_tasa_intl,
        t.franquicia as tarjeta_franquicia,
        t.banco as tarjeta_banco
      FROM compras c JOIN personas p ON c.persona_id = p.id JOIN tarjetas t ON c.tarjeta_id = t.id
      WHERE c.tercero_pagado = 0 AND c.estado != 'diferida' AND c.ciclo = ?${tjFilter}
    `).all(cicloActual, ...tjParams);
    meDebenCorte1Cuota.forEach(r => {
      let pendiente = Math.max(0, r.valor_cop - r.abono - r.bolsillo);
      if (r.es_internacional && r.fecha) {
        const rDiaCorte = tarjeta_id ? diaCorte : (r.tarjeta_dia_corte || 30);
        const rTasaIntl = tarjeta_id ? tasaIntlGlobal : (r.tarjeta_tasa_intl || 0.01911);
        const rAplicaIntl = tarjeta_id ? aplicaIntlDash : aplicaIntInternacional(r.tarjeta_banco, r.tarjeta_franquicia);
        if (rAplicaIntl) {
          const [yr, mo] = cicloActual.split('-').map(Number);
          const lastDay = new Date(yr, mo, 0).getDate();
          const fCorte = new Date(yr, mo - 1, Math.min(rDiaCorte, lastDay)).toISOString().slice(0, 10);
          const dias = daysBetween(r.fecha, fCorte);
          if (dias > 0) pendiente += Math.round(r.valor_cop * rTasaIntl * (dias / 30));
        }
      }
      if (pendiente <= 0) return;
      if (!meDebenCorteMap[r.persona_id]) meDebenCorteMap[r.persona_id] = { nombre: r.nombre, color: r.color, total: 0 };
      meDebenCorteMap[r.persona_id].total += pendiente;
    });
    const comprasDifTercero = db.prepare(`
      SELECT c.id, c.persona_id, c.diferida_id, c.valor_cop, p.nombre, p.color,
        COALESCE(c.monto_bolsillo, 0) as bolsillo
      FROM compras c JOIN personas p ON c.persona_id = p.id
      WHERE c.tercero_pagado = 0 AND c.estado = 'diferida' AND c.diferida_id IS NOT NULL${tjFilter}
    `).all(...tjParams);
    comprasDifTercero.forEach(c => {
      const dif = db.prepare("SELECT * FROM diferidas WHERE id=? AND estado='activo'").get(c.diferida_id);
      if (!dif) return;
      const amort = calcularAmortizacionDiferida(c.valor_cop, dif.tasa_mv, dif.num_cuotas, dif.fecha_compra, dif.fecha_primer_corte, [], nuOpts(db, dif.tarjeta_id));
      const cuota = amort.tabla.find(r => r.fechaCorte.slice(0, 7) === cicloActual);
      if (!cuota) return;
      // Cuota pasada (fechaCorte < hoy): consistente con meDeben que excluye cuotas cuyo fechaCorte < hoy
      if (cuota.fechaCorte < hoy) return;
      // Per-cuota bolsillo: buscar el monto específico de ESTA cuota
      const bolCuotaRow = db.prepare('SELECT monto FROM bolsillo_cuotas WHERE compra_id=? AND cuota_num=?').get(c.id, cuota.numCuota);
      const bolCuota = bolCuotaRow ? Math.round(bolCuotaRow.monto) : 0;
      const pendiente = Math.max(0, Math.round(cuota.totalPagar) - bolCuota);
      if (pendiente <= 0) return;
      if (!meDebenCorteMap[c.persona_id]) meDebenCorteMap[c.persona_id] = { nombre: c.nombre, color: c.color, total: 0 };
      meDebenCorteMap[c.persona_id].total += pendiente;
    });
    const meDebenCorteList = Object.values(meDebenCorteMap)
      .filter(r => r.total > 0)
      .map(r => ({ nombre: r.nombre, color: r.color, total: Math.round(r.total) }));
    const totalMeDebenCorte = meDebenCorteList.reduce((s, r) => s + r.total, 0);

    res.json({
      cupoTotal: Math.round(cupoTotal),
      deudaTotal: Math.round(deudaTotal),
      deudaAvances: Math.round(deudaAvances),
      deudaDiferidas: Math.round(deudaDiferidas),
      comprasCiclo: Math.round(comprasCicloHistorico !== null ? comprasCicloHistorico : comprasPendientesCiclo.total),
      comprasTotalPendientes: Math.round(todasComprasPendientes.total),
      deudaDelCorte: Math.round(deudaDelCorte),
      cuotasCorte: Math.round(cuotasCorte),
      pagoMinimo: Math.round(pagoMinimo),
      pagoMinimoBruto: Math.round(pagoMinimoBruto),
      montoPagadoExtracto: Math.round(montoPagadoExtractoCiclo),
      minimoUsd: dualExtractoDash ? Math.round(comprasUsdCiclo.totalUsd * 100) / 100 : 0,
      minimoUsdEnCop: dualExtractoDash ? Math.round(comprasUsdCiclo.totalCop) : 0,
      minimoCop: dualExtractoDash ? Math.round(comprasCopCiclo.totalCop) + Math.round(cuotasCorte) : 0,
      pagoTotal: Math.round(deudaTotal),
      meDeben: { total: Math.round(totalMeDeben), detalle: meDeben },
      meDebenCorte: { total: totalMeDebenCorte, detalle: meDebenCorteList },
      deudaPersonal: deudaPersonalCorte,
      proximoCorte: { fecha: proximoCorteDate.toISOString().slice(0, 10), diasFaltan: diasParaCorte },
      fechaPago: { fecha: fechaPago.toISOString().slice(0, 10), diasFaltan: diasParaPago },
      interesesMes: Math.round((interesesMesAvances + interesesMesDiferidas + interesesComprasIntl) * 100) / 100,
      interesesMesAvances: Math.round(interesesMesAvances * 100) / 100,
      interesesMesDiferidas: Math.round(interesesMesDiferidas * 100) / 100,
      interesesComprasIntl: Math.round(interesesComprasIntl),
      dualExtracto: dualExtractoDash,
      interesesComprasUsd: interesesComprasUsdDash,
      pagoMinimoUsd: pagoMinimoUsdDash,
      deudaUsd: deudaUsdDash,
      saldoBolsillo: Math.round(Math.max(0, saldoBolsillo.total - montoPagadoExtractoCiclo)),
      totalAbonos: Math.round(totalAbonosHist.total),
      totalPagos: Math.round(totalPagos.total),
      proximosPagos: proximosPagos.sort((a, b) => a.fechaCorte.localeCompare(b.fechaCorte)),
      extractosVencidos,
      extractoCiclo: extractoCicloData
    });
  });

  return router;
};
