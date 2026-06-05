// backend/engine/extracto.js
// Único punto de verdad del cálculo de extracto por ciclo (pago mínimo, pago total y
// desglose de compras/cuotas/avances/diferidas, con soporte dual COP/USD).
// Extraído de routes/extractos.js (v3.6) para reutilizarlo también en el Asistente de
// Conciliación (services/movimientos.js). Recibe `db` explícitamente.
const { daysBetween, addDays } = require('../helpers/dates');
const { calcularAmortizacionAvance, calcularAmortizacionDiferida } = require('./amortizacion');
const { esNuBank, nuOpts, avanceOpts, isDualExtracto, aplicaIntInternacional } = require('../helpers/banco');

function calcExtracto(db, tarjetaId, cicloStr, incluirPagadas) {
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
    SELECT c.id, c.fecha, c.descripcion, c.nota_personal, c.tasa_intl, c.valor_cop, c.valor_usd, c.tasa_usd,
           COALESCE(c.monto_abonado,0) as monto_abonado, c.estado, c.grupo_id, c.persona_id,
           COALESCE(c.es_internacional,0) as es_internacional,
           p.nombre as persona_nombre, p.color as persona_color
    FROM compras c LEFT JOIN personas p ON c.persona_id = p.id
    WHERE c.tarjeta_id=? AND c.ciclo=? AND c.estado NOT IN ('pagado','diferida')
  `).all(tarjetaId, cicloStr);
  const comprasCiclo = { total: comprasIndividuales.reduce((s, c) => s + (c.valor_cop - c.monto_abonado), 0) };
  const comprasPagadasCiclo = incluirPagadas
    ? db.prepare(`
        SELECT c.id, c.fecha, c.descripcion, c.nota_personal, c.tasa_intl, c.valor_cop, c.valor_usd, c.tasa_usd,
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

  // Interés INTL atribuido a UNA compra individual. ÚNICO punto de verdad: lo usan tanto el
  // total del pago mínimo (interesesComprasIntl, abajo) como el desglose por compra
  // (detalleCompras[].interes_intl), de modo que el total sea SIEMPRE la suma exacta del detalle.
  //   - Solo las tarjetas que aplican (Bancolombia Visa) cobran interés sobre compras intl en COP.
  //     En duales (MC/Amex) aplicaIntl=false → 0: las compras USD a 1 cuota no devengan interés si
  //     se pagan al vencimiento (el interés USD solo nace en diferidas o revolving — pendiente).
  //   - Tasa: snapshot histórico de la compra (c.tasa_intl) si existe; si no, la global de la
  //     tarjeta (v4.1.0). Nunca con la global sola: reescribiría la historia al fluctuar la tasa.
  const calcInteresIntlPorCompra = (c) => {
    if (!aplicaIntl) return 0;
    if (!c.es_internacional && !(c.valor_usd && c.valor_usd > 0)) return 0;
    const saldo = incluirPagadas ? c.valor_cop : (c.valor_cop - (c.monto_abonado || 0));
    if (saldo <= 0) return 0;
    const dias = daysBetween(c.fecha, fechaCorte);
    if (dias <= 0) return 0;
    const tasa = (c.tasa_intl != null ? c.tasa_intl : tasaIntl);
    return Math.round(saldo * tasa * (dias / 30));
  };

  // Total INTL del extracto = suma del interés por compra (mismo cálculo que el desglose).
  // Solo sobre comprasIndividuales (1 cuota, no pagadas); diferidas/avances devengan su interés
  // vía el motor de amortización. interesesComprasUsd queda 0 (revolving USD aún sin modelar).
  let interesesComprasIntl = 0, interesesComprasUsd = 0;
  comprasIndividuales.forEach(c => { interesesComprasIntl += calcInteresIntlPorCompra(c); });
  interesesComprasUsd = Math.round(interesesComprasUsd * 100) / 100;

  let comprasUsdTotal = 0, pagoMinimoUsd = 0;
  const detalleComprasUsd = [];
  if (dualExtracto) {
    const comprasUsdCiclo = comprasIndividuales.filter(c => c.valor_usd && c.valor_usd > 0);
    const comprasUsdPagadas = incluirPagadas ? comprasPagadasCiclo.filter(c => c.valor_usd && c.valor_usd > 0) : [];
    const todasUsd = [...comprasUsdPagadas, ...comprasUsdCiclo];
    comprasUsdTotal = Math.round(comprasUsdCiclo.reduce((s, c) => s + c.valor_usd, 0) * 100) / 100;
    todasUsd.forEach(c => {
      detalleComprasUsd.push({ id: c.id, fecha: c.fecha, descripcion: c.descripcion, total_usd: Math.round(c.valor_usd * 100) / 100, tasa_usd: c.tasa_usd || null, persona_id: c.persona_id || null });
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
  const detalleCompras = comprasCopParaDetalle.map(c => {
    const capital = Math.round(incluirPagadas ? c.valor_cop : (c.valor_cop - c.monto_abonado));
    const interes_intl = calcInteresIntlPorCompra(c);
    return {
      id: c.id,
      fecha: c.fecha, descripcion: c.descripcion, nota_personal: c.nota_personal || null,
      total: capital,
      interes_intl,
      tasa_intl: c.tasa_intl != null ? c.tasa_intl : null,
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

module.exports = { calcExtracto };
