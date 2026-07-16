// backend/routes/dashboard.js — /api/dashboard
const { Router } = require('express');
const { hoyLocal, daysBetween, addDays } = require('../helpers/dates');
const { calcularAmortizacionAvance } = require('../engine/amortizacion');
const { calcularAmortizacionDiferida } = require('../engine/amortizacion');
const { calcExtracto } = require('../engine/extracto');
const { nuOpts, nuOptsDif, avanceOpts, isDualExtracto, aplicaIntInternacional } = require('../helpers/banco');

module.exports = function(db) {
  const router = Router();

  router.get('/', (req, res) => {
    const { tarjeta_id, ciclo: cicloParam } = req.query;
    const hoy = hoyLocal();
    const cicloActual = cicloParam || hoy.slice(0, 7);
    const cicloReal = hoy.slice(0, 7);

    // tjFilter:
    //   - Si hay tarjeta_id (vista per-card): respeta la selección del usuario, incluso si está inactiva
    //     (para poder consultar historial de tarjetas archivadas).
    //   - Si NO hay tarjeta_id (vista global / Dashboard general): excluye tarjetas inactivas de TODOS los
    //     aggregados (cupo, deudas, intereses, bolsillo, me deben). Las inactivas son históricas y no
    //     deben contar para nada en los totales actuales.
    const tjFilter = tarjeta_id
      ? ' AND tarjeta_id = ?'
      : " AND tarjeta_id IN (SELECT id FROM tarjetas WHERE estado='activa')";
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
    // 'bolsillo' usa (valor_cop − abonado) en vez de valor_cop: una compra cubierta por bolsillo que
    // además recibió un abono a capital parcial debe contar solo su saldo neto (abonado=0 → valor_cop).
    const saldoBolsilloCompras = db.prepare("SELECT COALESCE(SUM(CASE WHEN estado='bolsillo' THEN valor_cop - COALESCE(monto_abonado,0) WHEN estado='bolsillo_parcial' THEN COALESCE(monto_bolsillo,0) WHEN estado='diferida' THEN COALESCE(monto_bolsillo,0) ELSE 0 END),0) as total FROM compras WHERE ciclo=? AND estado IN ('bolsillo','bolsillo_parcial','diferida')" + tjFilter).get(cicloActual, ...tjParams);
    // Avances: bolsillo per-cuota se acumula en el forEach de avancesActivos (más abajo)
    // a partir de bolsillo_cuotas_avance, filtrado por la cuota_num del ciclo navegado.
    // NO se usa avances.monto_bolsillo (que es el cache total acumulado de todas las cuotas).
    let bolsilloAvancesCiclo = 0;
    // Diferidas sin compra vinculada (ej: RappiCard registradas directamente) guardan bolsillo en diferidas.monto_bolsillo
    const saldoBolsilloDiferidas = db.prepare("SELECT COALESCE(SUM(COALESCE(monto_bolsillo,0)),0) as total FROM diferidas WHERE estado='activo' AND id NOT IN (SELECT COALESCE(diferida_id,0) FROM compras WHERE diferida_id IS NOT NULL)" + tjFilter).get(...tjParams);

    // Me Deben (total histórico): replica EXACTAMENTE la fórmula de la card "Me deben" en Terceros.
    //   - 1 cuota: valor_cop - monto_bolsillo
    //   - Diferida: suma de cuotas no pagadas (fechaCorte >= hoy) y no cubiertas por bolsillo
    //               (el bolsillo cubre la cuota del calendario si bolsillo >= cuota.total)
    // El bolsillo afecta el total visual al apartar dinero. Incluye todas las compras pendientes.
    const comprasTerceroAll = db.prepare(`
      SELECT c.id, c.tarjeta_id, c.persona_id, p.nombre, p.color, c.valor_cop, c.valor_usd, c.estado,
        c.diferida_id, c.descripcion, c.fecha, c.ciclo,
        COALESCE(c.es_internacional, 0) as es_internacional, c.tasa_intl,
        COALESCE(c.interes_sellado, 0) as interes_sellado,
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
      let pendienteUsd = 0;
      let cuotasArr = null;
      if (c.estado === 'diferida') {
        // Buscar la diferida vinculada (igual que en routes/terceros.js)
        const dif = c.diferida_id
          ? db.prepare('SELECT * FROM diferidas WHERE id=?').get(c.diferida_id)
          : db.prepare('SELECT * FROM diferidas WHERE tarjeta_id=? AND etiqueta=? AND fecha_compra=?').get(c.tarjeta_id, c.descripcion, c.fecha);
        if (!dif) return;
        const amort = calcularAmortizacionDiferida(c.valor_cop, dif.tasa_mv, dif.num_cuotas, dif.fecha_compra, dif.fecha_primer_corte, null, nuOptsDif(db, dif));
        const cuotasBase = amort.tabla.map(r => ({
          total: Math.round(r.totalPagar),
          pagada: r.fechaCorte < hoy
        }));
        const bolCuotasDash = db.prepare('SELECT cuota_num, monto FROM bolsillo_cuotas WHERE compra_id=?').all(c.id);
        const bolMapDash = {};
        bolCuotasDash.forEach(b => { bolMapDash[b.cuota_num] = Math.round(b.monto); });
        cuotasArr = cuotasBase.map((q, i) => ({
          ...q,
          cubierta_bolsillo: (bolMapDash[i + 1] || 0) >= q.total
        }));
        // Deuda del tercero: cuenta como pendiente mientras NO esté reembolsada (cubierta_bolsillo);
        // no se excluye por corte vencido (mismo criterio que routes/terceros.js).
        pendiente = cuotasArr.filter(q => !q.cubierta_bolsillo).reduce((s, q) => s + q.total, 0);
        // USD: prorrateo del valor USD entre cuotas pendientes (asume mismo plazo).
        if (c.valor_usd && c.valor_usd > 0) {
          const cuotaUsd = c.valor_usd / dif.num_cuotas;
          const pendientesCount = cuotasArr.filter(q => !q.cubierta_bolsillo).length;
          pendienteUsd = cuotaUsd * pendientesCount;
        }
      } else {
        // 1 cuota: valor + interés sellado - bolsillo (+ interés intl si la tarjeta aplica).
        // interes_sellado: si es una cuota SELLADA por reprogramación de saldo, el tercero me debe
        // capital + el interés que el banco facturó por esa cuota. NULL→0 en el resto → sin regresión.
        // (Esta card NO resta tercero_monto_abonado, a diferencia de "Me Deben Corte"; se respeta esa
        // asimetría preexistente a propósito: unificarla sería otro cambio, ajeno a este feature.)
        pendiente = c.valor_cop + c.interes_sellado - c.bolsillo;
        if (c.es_internacional && c.ciclo) {
          const cDiaCorte = tarjeta_id ? diaCorte : (c.tarjeta_dia_corte || 30);
          const cTasaIntl = tarjeta_id ? tasaIntlGlobal : (c.tarjeta_tasa_intl || 0.01911);
          const cAplicaIntl = tarjeta_id ? aplicaIntlDash : aplicaIntInternacional(c.tarjeta_banco, c.tarjeta_franquicia);
          if (cAplicaIntl) {
            const [yr, mo] = c.ciclo.split('-').map(Number);
            const lastDay = new Date(yr, mo, 0).getDate();
            const fCorte = new Date(yr, mo - 1, Math.min(cDiaCorte, lastDay)).toISOString().slice(0, 10);
            const dias = daysBetween(c.fecha, fCorte);
            if (dias > 0) pendiente += Math.round(c.valor_cop * (c.tasa_intl != null ? c.tasa_intl : cTasaIntl) * (dias / 30));
          }
        }
        // USD: para compras 1 cuota Mastercard/Amex, valor_cop = 0 y valor_usd > 0.
        if (c.valor_usd && c.valor_usd > 0) pendienteUsd = c.valor_usd;
      }
      if (pendiente <= 0 && pendienteUsd <= 0) return;
      if (!meDebenMap[c.persona_id]) meDebenMap[c.persona_id] = { nombre: c.nombre, color: c.color, total: 0, totalUsd: 0 };
      if (pendiente > 0) meDebenMap[c.persona_id].total += pendiente;
      if (pendienteUsd > 0) meDebenMap[c.persona_id].totalUsd += pendienteUsd;
    });
    const meDeben = Object.values(meDebenMap).map(r => ({
      nombre: r.nombre, color: r.color,
      total: Math.round(r.total),
      totalUsd: Math.round((r.totalUsd || 0) * 100) / 100
    }));
    const totalMeDeben = meDeben.reduce((s, r) => s + r.total, 0);
    const totalMeDebenUsd = Math.round(meDeben.reduce((s, r) => s + (r.totalUsd || 0), 0) * 100) / 100;

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
        // Bolsillo per-cuota del ciclo navegado: solo cuenta si esa cuota tiene aparte propio.
        // Si el avance no tiene cuota en el ciclo (cuotaActual undefined), suma 0.
        const bolCuotaAvRow = db.prepare('SELECT monto FROM bolsillo_cuotas_avance WHERE avance_id=? AND cuota_num=?').get(av.id, cuotaActual.numCuota);
        if (bolCuotaAvRow) bolsilloAvancesCiclo += Math.round(bolCuotaAvRow.monto);
        proximosPagos.push({ tipo: 'avance', etiqueta: av.etiqueta, fechaCorte: cuotaActual.fechaCorte, interes: cuotaActual.interes, capital: cuotaActual.cuotaCapital, total: cuotaActual.totalExtracto });
      }
    });
    // Total de saldo en bolsillo (compras del ciclo + avances per-cuota + diferidas standalone).
    // Se computa aquí porque bolsilloAvancesCiclo se acumuló en el forEach anterior.
    const saldoBolsillo = { total: (saldoBolsilloCompras.total || 0) + bolsilloAvancesCiclo + (saldoBolsilloDiferidas.total || 0) };

    const diferidasActivas = db.prepare("SELECT * FROM diferidas WHERE estado='activo'" + tjFilter).all(...tjParams);
    let deudaDiferidas = 0, deudaDiferidasUsd = 0;
    let interesesMesDiferidas = 0, interesesMesDiferidasUsd = 0;
    // Para "Deuda Personal del corte": suma de la cuota del ciclo de diferidas SIN persona vinculada (personal o RappiCard directa)
    let cuotasDiferidasPersonalCorte = 0;

    diferidasActivas.forEach(d => {
      const abonosDif = db.prepare('SELECT * FROM abonos_diferida WHERE diferida_id=? ORDER BY fecha').all(d.id);
      const amort = calcularAmortizacionDiferida(d.monto, d.tasa_mv, d.num_cuotas, d.fecha_compra, d.fecha_primer_corte, abonosDif, nuOptsDif(db, d));
      // Detección de moneda: una diferida es USD solo si es USD PURA (valor_cop=0). Una compra
      // internacional de Visa tiene valor_cop>0 (deuda real en pesos) + valor_usd informativo: NO
      // es USD. Antes se clasificaba por `valor_usd > 0` a secas, lo que mandaba el saldo COP de una
      // diferida internacional de Visa a deudaDiferidasUsd; como Visa no es dual, ese saldo no
      // sumaba a la deuda total → la deuda de esa diferida DESAPARECÍA del cupo (falso disponible).
      const compraVinc = db.prepare('SELECT persona_id, valor_usd, valor_cop FROM compras WHERE diferida_id=? LIMIT 1').get(d.id);
      const esDifUsd = !!(compraVinc && compraVinc.valor_usd > 0 && !(compraVinc.valor_cop > 0));
      if (esDifUsd) deudaDiferidasUsd += amort.resumen.saldoActual;
      else deudaDiferidas += amort.resumen.saldoActual;
      const cuotaActual = cicloParam
        ? amort.tabla.find(r => r.fechaCorte.slice(0, 7) === cicloActual)
        : amort.tabla.find(r => r.fechaCorte >= hoy);
      if (cuotaActual) {
        if (esDifUsd) interesesMesDiferidasUsd += cuotaActual.interesTotal;
        else interesesMesDiferidas += cuotaActual.interesTotal;
        proximosPagos.push({ tipo: 'diferida', etiqueta: d.etiqueta, fechaCorte: cuotaActual.fechaCorte, interes: cuotaActual.interesTotal, capital: cuotaActual.cuotaCapital, total: cuotaActual.totalPagar });
        // Si la diferida no tiene compra de tercero vinculada, su cuota suma a deuda personal
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
    // USD: para el desglose "Compras" de la card Deuda Total USD.
    const todasComprasPendientesUsd = db.prepare("SELECT COALESCE(SUM(valor_usd),0) as total FROM compras WHERE estado NOT IN ('pagado','diferida') AND valor_usd IS NOT NULL AND valor_usd > 0" + tjFilter).get(...tjParams);

    // Ajustes de deuda: capital de cuotas en extractos pendientes pasados
    // y monto pagado a esos extractos. Antes solo corrían en vista per-card,
    // por eso la mega-card del Dashboard global mostraba un disponible y un
    // porcentaje distintos de la suma de las cards individuales. Ahora corren
    // siempre — en global, cada extracto pendiente filtra sus avances/diferidas
    // por su propio tarjeta_id internamente.
    let deudaImpagaAvances = 0, deudaImpagaDiferidas = 0;
    // En vista global excluimos extractos de tarjetas inactivas (no deben sumar a deuda total).
    // fecha_corte ESTRICTAMENTE < hoy: la cuota cuyo corte es exactamente hoy (día de corte)
    // ya está incluida en el saldoActual de la amortización (que usa fechaCorte >= hoy). Si
    // aquí usáramos <= hoy, esa cuota se contaría dos veces el mismo día del corte, inflando
    // la deuda y mostrando un falso "sobrecupo". Solo re-sumamos cuotas de extractos pendientes
    // ya vencidos (corte anterior a hoy), que el saldoActual sí descontó.
    const extractosImpagos2 = tarjeta_id
      ? db.prepare("SELECT tarjeta_id, ciclo FROM extractos WHERE tarjeta_id=? AND estado='pendiente' AND fecha_corte < ?").all(tarjeta_id, hoy)
      : db.prepare("SELECT tarjeta_id, ciclo FROM extractos WHERE estado='pendiente' AND fecha_corte < ? AND tarjeta_id IN (SELECT id FROM tarjetas WHERE estado='activa')").all(hoy);
    extractosImpagos2.forEach(ext => {
      avancesActivos.filter(av => av.tarjeta_id === ext.tarjeta_id).forEach(av => {
        const abonos2 = db.prepare('SELECT * FROM abonos_avance WHERE avance_id=? ORDER BY fecha').all(av.id);
        const amort2 = calcularAmortizacionAvance(av.monto, av.tasa_mv, av.plazo, av.fecha_desembolso, av.dia_corte, abonos2, av.comision, avanceOpts(db, av.tarjeta_id));
        const cuota2 = amort2.tabla.find(r => r.fechaCorte.slice(0, 7) === ext.ciclo);
        if (cuota2) deudaImpagaAvances += cuota2.cuotaCapital;
      });
      diferidasActivas.filter(d => d.tarjeta_id === ext.tarjeta_id).forEach(d => {
        const abonosDif2 = db.prepare('SELECT * FROM abonos_diferida WHERE diferida_id=? ORDER BY fecha').all(d.id);
        const amort2 = calcularAmortizacionDiferida(d.monto, d.tasa_mv, d.num_cuotas, d.fecha_compra, d.fecha_primer_corte, abonosDif2, nuOptsDif(db, d));
        const cuota2 = amort2.tabla.find(r => r.fechaCorte.slice(0, 7) === ext.ciclo);
        if (cuota2) deudaImpagaDiferidas += cuota2.cuotaCapital;
      });
    });
    deudaAvances += deudaImpagaAvances;
    deudaDiferidas += deudaImpagaDiferidas;

    const extParciales = tarjeta_id
      ? db.prepare("SELECT COALESCE(SUM(monto_pagado),0) as total FROM extractos WHERE tarjeta_id=? AND estado='pendiente' AND monto_pagado > 0").get(tarjeta_id)
      : db.prepare("SELECT COALESCE(SUM(monto_pagado),0) as total FROM extractos WHERE estado='pendiente' AND monto_pagado > 0 AND tarjeta_id IN (SELECT id FROM tarjetas WHERE estado='activa')").get();
    const montoPagadoExtractoTotal = extParciales.total || 0;
    let montoPagadoExtractoCiclo = 0, montoPagadoUsdExtractoCiclo = 0;
    let estadoUsdExtractoCiclo = null, extractoCicloData = null;
    if (tarjeta_id) {
      const extCiclo = db.prepare("SELECT * FROM extractos WHERE tarjeta_id=? AND ciclo=?").get(tarjeta_id, cicloActual);
      if (extCiclo) {
        if (extCiclo.estado === 'pendiente') montoPagadoExtractoCiclo = extCiclo.monto_pagado || 0;
        if (extCiclo.estado === 'pagado') {
          extractoCicloData = {
            estado: 'pagado', pago_minimo: extCiclo.pago_minimo, pago_total: extCiclo.pago_total,
            monto_pagado: extCiclo.monto_pagado || 0, fecha_pagado: extCiclo.fecha_pagado,
            fecha_corte: extCiclo.fecha_corte, fecha_pago: extCiclo.fecha_pago,
            estado_usd: extCiclo.estado_usd, monto_pagado_usd: extCiclo.monto_pagado_usd || 0,
            fecha_pagado_usd: extCiclo.fecha_pagado_usd, pago_minimo_usd: extCiclo.pago_minimo_usd || 0,
            pago_total_usd: extCiclo.pago_total_usd || 0
          };
        }
        // Para extractos pendientes, también arrastramos el abono USD parcial y el estado_usd.
        montoPagadoUsdExtractoCiclo = extCiclo.monto_pagado_usd || 0;
        estadoUsdExtractoCiclo = extCiclo.estado_usd || null;
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
        const queryInteres = "SELECT fecha, valor_cop, COALESCE(monto_abonado,0) as monto_abonado, persona_id, tasa_intl FROM compras WHERE ciclo=? AND estado NOT IN ('pagado','diferida') AND (es_internacional=1 OR (valor_usd IS NOT NULL AND valor_usd > 0))" + tjFilter;
        const comprasIntlCiclo = db.prepare(queryInteres).all(cicloActual, ...tjParams);
        comprasIntlCiclo.forEach(c => {
          const saldo = c.valor_cop - c.monto_abonado;
          if (saldo <= 0) return;
          const dias = daysBetween(c.fecha, fechaCorteCiclo);
          if (dias <= 0) return;
          const interes = saldo * (c.tasa_intl != null ? c.tasa_intl : tasaIntl) * (dias / 30);
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
          "SELECT fecha, valor_cop, COALESCE(monto_abonado,0) as monto_abonado, persona_id, tasa_intl FROM compras WHERE ciclo=? AND estado NOT IN ('pagado','diferida') AND (es_internacional=1 OR (valor_usd IS NOT NULL AND valor_usd > 0)) AND tarjeta_id=?"
        ).all(cicloActual, tj.id);
        comprasIntlGlobal.forEach(c => {
          const saldo = c.valor_cop - c.monto_abonado;
          if (saldo <= 0) return;
          const dias = daysBetween(c.fecha, fechaCorteTj);
          if (dias <= 0) return;
          const interes = saldo * (c.tasa_intl != null ? c.tasa_intl : tasaIntl) * (dias / 30);
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

      // Para ciclos donde al menos una porción ya está cerrada (COP o USD),
      // las compras de esa moneda están en 'pagado' y el cálculo desde compras
      // pendientes da 0 → la card desaparece. Preferimos los valores reales
      // facturados por el banco, almacenados en pago_minimo_usd / pago_total_usd.
      if (tarjeta_id) {
        const extRow = db.prepare(
          "SELECT estado, estado_usd, COALESCE(pago_minimo_usd,0) as pm, COALESCE(pago_total_usd,0) as pt FROM extractos WHERE tarjeta_id=? AND ciclo=?"
        ).get(tarjeta_id, cicloActual);
        if (extRow && (extRow.estado === 'pagado' || extRow.estado_usd === 'pagado')) {
          pagoMinimoUsdDash = Math.round(extRow.pm * 100) / 100;
          deudaUsdDash = Math.round(extRow.pt * 100) / 100;
        }
      }
    }

    const cupoTotal = tarjeta_id
      ? (db.prepare("SELECT COALESCE(cupo_total,0) as total FROM tarjetas WHERE id=?").get(tarjeta_id) || {}).total || 0
      : (db.prepare("SELECT COALESCE(SUM(cupo_total),0) as total FROM tarjetas WHERE estado='activa'").get() || {}).total || 0;

    const deudaDelCorte = comprasPendientesCiclo.total + cuotasCorte;
    const deudaTotal = todasComprasPendientes.total + deudaAvances + deudaDiferidas - montoPagadoExtractoTotal;

    // Para tarjetas duales: convertimos la deuda USD a COP equivalente con la TRM
    // configurada, sumando al cupo usado total. La TRM es una aproximación — el banco
    // calcula al día del pago con su propia tasa, pero para uso interno (cuánto cupo
    // queda) este estimado es suficiente.
    const trmRow = db.prepare("SELECT value FROM config WHERE key='trm_usd_cop'").get();
    const trmUsdCop = trmRow && trmRow.value ? parseFloat(trmRow.value) || 4200 : 4200;
    const deudaTotalUsdEquivCop = deudaUsdDash * trmUsdCop;
    const deudaTotalEnCop = deudaTotal + (dualExtractoDash ? deudaTotalUsdEquivCop : 0);

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

    // Fecha de Pago: respeta el ciclo navegado y permite override manual por ciclo.
    // Jerarquía: 1) fechas_pago_custom (manual)  2) extractos.fecha_pago (histórico)
    //            3) cálculo desde tarjeta + ciclo (proyección)
    let fechaPago;
    let esFechaPagoManual = false;

    if (tarjeta_id) {
      const custom = db.prepare("SELECT fecha_pago FROM fechas_pago_custom WHERE tarjeta_id=? AND ciclo=?").get(tarjeta_id, cicloActual);
      if (custom && custom.fecha_pago) {
        fechaPago = new Date(custom.fecha_pago + 'T00:00:00');
        esFechaPagoManual = true;
      } else {
        const extFechaRow = db.prepare("SELECT fecha_pago FROM extractos WHERE tarjeta_id=? AND ciclo=?").get(tarjeta_id, cicloActual);
        if (extFechaRow && extFechaRow.fecha_pago) {
          fechaPago = new Date(extFechaRow.fecha_pago + 'T00:00:00');
        }
      }
    }

    if (!fechaPago) {
      // Cálculo por ciclo (no por "hoy"): para el ciclo navegado, determinamos
      // su fecha_corte y luego su fecha_pago según las reglas del banco.
      const [yrC, moC] = cicloActual.split('-').map(Number);
      const lastDayCicloMonth = new Date(yrC, moC, 0).getDate();
      const fechaCorteCiclo = new Date(yrC, moC - 1, Math.min(diaCorte, lastDayCicloMonth));
      if (esRappiDash) {
        // RappiCard/Davivienda: corte + 14 días
        const corteIso = fechaCorteCiclo.toISOString().slice(0, 10);
        const fpIso = addDays(corteIso, 14);
        fechaPago = new Date(fpIso + 'T00:00:00');
      } else {
        // Bancolombia y similares: dia_pago del mes siguiente al ciclo
        fechaPago = new Date(yrC, moC, diaPago);
      }
    }
    const diasParaPago = Math.ceil((fechaPago - now) / 86400000);

    // Pago mínimo REAL de un ciclo, EN VIVO, vía el motor único calcExtracto (engine/extracto.js).
    // Se usa para "Próximos Pagos" en vez del valor persistido en extractos.pago_minimo, que solo
    // se refresca al entrar a la vista Pagos — así la card siempre muestra el monto al día, sin
    // depender del orden de navegación. Solo aplica en vista per-card (tarjeta_id presente).
    // incluirPagadas=false: el pago mínimo cuenta solo lo pendiente del ciclo.
    // Antes esta función duplicaba a mano la fórmula del extracto (compras + cuotas + intl);
    // unificado en v4.2.0 para tener un único punto de verdad (deuda técnica (c)).
    const calcPagoMinimoCiclo = (ciclo) => {
      const ext = calcExtracto(db, tarjeta_id, ciclo, false);
      return ext ? ext.pagoMinimo : 0;
    };

    let extractosVencidos = [];
    if (tarjeta_id) {
      // "Próximos Pagos": muestra el/los extracto(s) pendiente(s) cuyo CORTE YA CERRÓ
      // (fecha_corte < hoy), con su fecha límite de pago. Aparece el día siguiente al corte
      // (ej. Visa corte día 30 → aparece el 31) y desaparece al pagar el extracto. Se listan
      // todos los pendientes de la tarjeta (un vencido + el recién cerrado conviven).
      // Antes el gate era por mes calendario (ciclo < mes actual), lo que retrasaba la alerta
      // en tarjetas cuyo pago cae poco después del corte (RappiCard).
      // El pago mínimo se RECALCULA en vivo (calcPagoMinimoCiclo), no se lee el persistido.
      // COALESCE: si hay override en fechas_pago_custom, esa fecha gana sobre extractos.fecha_pago.
      // COALESCE cortes_custom: si el banco adelantó el corte de un ciclo, el pago aparece cuando
      // venció el corte REAL (cc.fecha_corte), no el teórico → el widget revela el pago a tiempo.
      const rawExt = db.prepare(`
        SELECT ext.ciclo, COALESCE(ext.monto_pagado, 0) as monto_pagado,
          COALESCE(fpc.fecha_pago, ext.fecha_pago) as fecha_pago,
          CASE WHEN fpc.fecha_pago IS NOT NULL THEN 1 ELSE 0 END as es_manual
        FROM extractos ext
        LEFT JOIN fechas_pago_custom fpc ON fpc.tarjeta_id = ext.tarjeta_id AND fpc.ciclo = ext.ciclo
        LEFT JOIN cortes_custom cc ON cc.tarjeta_id = ext.tarjeta_id AND cc.ciclo = ext.ciclo
        WHERE ext.tarjeta_id = ? AND ext.estado = 'pendiente' AND COALESCE(cc.fecha_corte, ext.fecha_corte) < ?
        ORDER BY COALESCE(fpc.fecha_pago, ext.fecha_pago) ASC
      `).all(tarjeta_id, hoy);
      extractosVencidos = rawExt
        .map(e => {
          const pmReal = calcPagoMinimoCiclo(e.ciclo);
          return { ciclo: e.ciclo, pagoMinimo: pmReal, pagado: Math.round(e.monto_pagado), falta: Math.round(pmReal - e.monto_pagado), fechaPago: e.fecha_pago, esFechaManual: !!e.es_manual, tipo: e.fecha_pago < hoy ? 'vencido' : 'proximo' };
        })
        .filter(e => e.falta > 1);
    }

    // ─── Datos del corte: Deuda Personal y Me Deben Corte ─────────
    // Compras "Personal" del ciclo: pendientes (no pagado, no diferida) sin persona_id
    const comprasPersonalCiclo = db.prepare(
      "SELECT COALESCE(SUM(valor_cop - COALESCE(monto_abonado,0)),0) as total FROM compras WHERE ciclo=? AND estado NOT IN ('pagado','diferida') AND persona_id IS NULL" + tjFilter
    ).get(cicloActual, ...tjParams);
    // USD: para Mastercard/Amex, las compras 1-cuota tienen valor_cop=0 y valor_usd>0;
    // estas no aparecen en la suma COP de arriba. Las sumamos aparte.
    const comprasPersonalCicloUsd = db.prepare(
      "SELECT COALESCE(SUM(valor_usd),0) as total FROM compras WHERE ciclo=? AND estado NOT IN ('pagado','diferida') AND persona_id IS NULL AND valor_usd IS NOT NULL AND valor_usd > 0" + tjFilter
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
    // USD: para tarjetas duales, las compras personales del ciclo en USD se suman aparte.
    // Por ahora no incluimos cuotas USD de avances/diferidas (raros: solo compras 1-cuota USD).
    const deudaPersonalCorteUsd = Math.round((comprasPersonalCicloUsd.total || 0) * 100) / 100;
    // Saldo Bolsillo USD: bruto = suma de monto_bolsillo_usd; abonado = monto_pagado_usd del
    // extracto del ciclo; neto = max(0, bruto - abonado). Espejo de la lógica COP.
    const saldoBolsilloComprasUsd = db.prepare(
      "SELECT COALESCE(SUM(monto_bolsillo_usd),0) as total FROM compras WHERE ciclo=? AND estado IN ('bolsillo','bolsillo_parcial','diferida') AND COALESCE(monto_bolsillo_usd,0) > 0" + tjFilter
    ).get(cicloActual, ...tjParams);
    const saldoBolsilloUsdBruto = Math.round((saldoBolsilloComprasUsd.total || 0) * 100) / 100;
    const saldoBolsilloUsdAbonado = Math.round((montoPagadoUsdExtractoCiclo || 0) * 100) / 100;
    const saldoBolsilloUsd = Math.max(0, Math.round((saldoBolsilloUsdBruto - saldoBolsilloUsdAbonado) * 100) / 100);
    // Intereses del mes USD: suma de intereses USD de diferidas + revolving USD (= 0 por ahora).
    const interesesMesUsd = Math.round((interesesMesDiferidasUsd + interesesComprasUsdDash) * 100) / 100;

    // Me Deben Corte: lo que cada tercero debe en este ciclo. Resta abono del tercero y bolsillo del usuario.
    const meDebenCorteMap = {};
    const meDebenCorte1Cuota = db.prepare(`
      SELECT c.persona_id, p.nombre, p.color, c.valor_cop, c.valor_usd, c.fecha,
        COALESCE(c.es_internacional, 0) as es_internacional, c.tasa_intl,
        COALESCE(c.tercero_monto_abonado, 0) as abono,
        COALESCE(c.interes_sellado, 0) as interes_sellado,
        COALESCE(c.monto_bolsillo, 0) as bolsillo,
        t.dia_corte as tarjeta_dia_corte,
        COALESCE(t.tasa_mv_avances, 0.01911) as tarjeta_tasa_intl,
        t.franquicia as tarjeta_franquicia,
        t.banco as tarjeta_banco
      FROM compras c JOIN personas p ON c.persona_id = p.id JOIN tarjetas t ON c.tarjeta_id = t.id
      WHERE c.tercero_pagado = 0 AND c.estado != 'diferida' AND c.ciclo = ?${tjFilter}
    `).all(cicloActual, ...tjParams);
    meDebenCorte1Cuota.forEach(r => {
      // NO recortar a 0 todavía: si el bolsillo apartado supera el valor (excedente que el
      // usuario reservó para el interés intl), ese excedente debe poder absorber el interés
      // que se suma abajo. Aplicar Math.max(0,...) ANTES borraría ese crédito y el interés
      // aparecería como deuda fantasma aunque el bolsillo ya lo cubriera. El recorte a 0 se
      // hace al final, igual que en la card "Me Deben" (histórica).
      // + interes_sellado: en una cuota SELLADA por reprogramación de saldo el tercero debe capital + el
      // interés que el banco facturó por esa cuota. NULL→0 en el resto de compras → sin regresión.
      let pendiente = r.valor_cop + r.interes_sellado - r.abono - r.bolsillo;
      if (r.es_internacional && r.fecha) {
        const rDiaCorte = tarjeta_id ? diaCorte : (r.tarjeta_dia_corte || 30);
        const rTasaIntl = tarjeta_id ? tasaIntlGlobal : (r.tarjeta_tasa_intl || 0.01911);
        const rAplicaIntl = tarjeta_id ? aplicaIntlDash : aplicaIntInternacional(r.tarjeta_banco, r.tarjeta_franquicia);
        if (rAplicaIntl) {
          const [yr, mo] = cicloActual.split('-').map(Number);
          const lastDay = new Date(yr, mo, 0).getDate();
          const fCorte = new Date(yr, mo - 1, Math.min(rDiaCorte, lastDay)).toISOString().slice(0, 10);
          const dias = daysBetween(r.fecha, fCorte);
          if (dias > 0) pendiente += Math.round(r.valor_cop * (r.tasa_intl != null ? r.tasa_intl : rTasaIntl) * (dias / 30));
        }
      }
      pendiente = Math.max(0, pendiente);
      const pendienteUsd = (r.valor_usd && r.valor_usd > 0) ? r.valor_usd : 0;
      if (pendiente <= 0 && pendienteUsd <= 0) return;
      if (!meDebenCorteMap[r.persona_id]) meDebenCorteMap[r.persona_id] = { nombre: r.nombre, color: r.color, total: 0, totalUsd: 0 };
      if (pendiente > 0) meDebenCorteMap[r.persona_id].total += pendiente;
      if (pendienteUsd > 0) meDebenCorteMap[r.persona_id].totalUsd += pendienteUsd;
    });
    const comprasDifTercero = db.prepare(`
      SELECT c.id, c.persona_id, c.diferida_id, c.valor_cop, c.valor_usd, p.nombre, p.color,
        COALESCE(c.monto_bolsillo, 0) as bolsillo
      FROM compras c JOIN personas p ON c.persona_id = p.id
      WHERE c.tercero_pagado = 0 AND c.estado = 'diferida' AND c.diferida_id IS NOT NULL${tjFilter}
    `).all(...tjParams);
    comprasDifTercero.forEach(c => {
      const dif = db.prepare("SELECT * FROM diferidas WHERE id=? AND estado='activo'").get(c.diferida_id);
      if (!dif) return;
      const amort = calcularAmortizacionDiferida(c.valor_cop, dif.tasa_mv, dif.num_cuotas, dif.fecha_compra, dif.fecha_primer_corte, [], nuOptsDif(db, dif));
      const cuota = amort.tabla.find(r => r.fechaCorte.slice(0, 7) === cicloActual);
      if (!cuota) return;
      // Per-cuota bolsillo
      const bolCuotaRow = db.prepare('SELECT monto FROM bolsillo_cuotas WHERE compra_id=? AND cuota_num=?').get(c.id, cuota.numCuota);
      const bolCuota = bolCuotaRow ? Math.round(bolCuotaRow.monto) : 0;
      const pendiente = Math.max(0, Math.round(cuota.totalPagar) - bolCuota);
      // USD: cuota_usd = valor_usd / num_cuotas
      const pendienteUsd = (c.valor_usd && c.valor_usd > 0) ? (c.valor_usd / dif.num_cuotas) : 0;
      if (pendiente <= 0 && pendienteUsd <= 0) return;
      if (!meDebenCorteMap[c.persona_id]) meDebenCorteMap[c.persona_id] = { nombre: c.nombre, color: c.color, total: 0, totalUsd: 0 };
      if (pendiente > 0) meDebenCorteMap[c.persona_id].total += pendiente;
      if (pendienteUsd > 0) meDebenCorteMap[c.persona_id].totalUsd += pendienteUsd;
    });
    const meDebenCorteList = Object.values(meDebenCorteMap)
      .filter(r => r.total > 0 || (r.totalUsd || 0) > 0)
      .map(r => ({
        nombre: r.nombre, color: r.color,
        total: Math.round(r.total),
        totalUsd: Math.round((r.totalUsd || 0) * 100) / 100
      }));
    const totalMeDebenCorte = meDebenCorteList.reduce((s, r) => s + r.total, 0);
    const totalMeDebenCorteUsd = Math.round(meDebenCorteList.reduce((s, r) => s + (r.totalUsd || 0), 0) * 100) / 100;

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
      meDeben: { total: Math.round(totalMeDeben), totalUsd: totalMeDebenUsd, detalle: meDeben },
      meDebenCorte: { total: totalMeDebenCorte, totalUsd: totalMeDebenCorteUsd, detalle: meDebenCorteList },
      deudaPersonal: deudaPersonalCorte,
      deudaPersonalUsd: deudaPersonalCorteUsd,
      // Desglose de Deuda Personal (sin terceros): para mostrar a qué corresponde el total.
      deudaPersonalCompras: Math.round(comprasPersonalCiclo.total || 0),
      deudaPersonalAvances: Math.round(cuotasAvancesPersonalCorte),
      deudaPersonalDiferidas: Math.round(cuotasDiferidasPersonalCorte),
      deudaPersonalIntIntl: Math.round(interesesComprasIntlPersonal || 0),
      saldoBolsilloUsd: saldoBolsilloUsd,
      proximoCorte: { fecha: proximoCorteDate.toISOString().slice(0, 10), diasFaltan: diasParaCorte },
      fechaPago: { fecha: fechaPago.toISOString().slice(0, 10), diasFaltan: diasParaPago, esManual: esFechaPagoManual },
      interesesMes: Math.round((interesesMesAvances + interesesMesDiferidas + interesesComprasIntl) * 100) / 100,
      interesesMesAvances: Math.round(interesesMesAvances * 100) / 100,
      interesesMesDiferidas: Math.round(interesesMesDiferidas * 100) / 100,
      interesesComprasIntl: Math.round(interesesComprasIntl),
      dualExtracto: dualExtractoDash,
      interesesComprasUsd: interesesComprasUsdDash,
      interesesMesUsd: interesesMesUsd,
      interesesMesDiferidasUsd: Math.round(interesesMesDiferidasUsd * 100) / 100,
      pagoMinimoUsd: pagoMinimoUsdDash,
      deudaUsd: deudaUsdDash,
      // Desglose USD para la card Deuda Total (espejo de los campos COP):
      deudaAvancesUsd: 0, // No hay avances USD en el modelo actual; expuesto para futuro.
      deudaDiferidasUsd: Math.round(deudaDiferidasUsd * 100) / 100,
      comprasTotalPendientesUsd: Math.round((todasComprasPendientesUsd.total || 0) * 100) / 100,
      // Para el cálculo de Cupo Usado en tarjetas duales: TRM + deuda total en COP equiv.
      trmUsdCop: trmUsdCop,
      deudaTotalEnCop: Math.round(deudaTotalEnCop),
      montoPagadoExtractoUsd: Math.round((montoPagadoUsdExtractoCiclo || 0) * 100) / 100,
      estadoUsdExtractoCiclo: estadoUsdExtractoCiclo,
      // Card "Saldo en Bolsillo": valor neto + desglose para transparencia.
      //   bruto    = Total Apartado del ciclo (compras + avances per-cuota + diferidas standalone)
      //   abonado  = Abonos Realizados al extracto del ciclo (extractos.monto_pagado)
      //   neto     = max(0, bruto - abonado) → lo que efectivamente queda apartado
      saldoBolsillo: Math.round(Math.max(0, saldoBolsillo.total - montoPagadoExtractoCiclo)),
      saldoBolsilloBruto: Math.round(saldoBolsillo.total),
      saldoBolsilloAbonado: Math.round(montoPagadoExtractoCiclo),
      saldoBolsilloUsdBruto: saldoBolsilloUsdBruto,
      saldoBolsilloUsdAbonado: saldoBolsilloUsdAbonado,
      totalAbonos: Math.round(totalAbonosHist.total),
      totalPagos: Math.round(totalPagos.total),
      proximosPagos: proximosPagos.sort((a, b) => a.fechaCorte.localeCompare(b.fechaCorte)),
      extractosVencidos,
      extractoCiclo: extractoCicloData
    });
  });

  return router;
};
