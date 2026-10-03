// backend/engine/amortizacion.js — Amortization engines (pure math, no DB/IO)
const { hoyLocal, addMonths, daysBetween, primerCorteAvance } = require('../helpers/dates');

// Interes de la cuota que se FACTURO en el corte anterior, por los dias que pasaron hasta que se pago.
// Bancolombia liquida sobre el saldo DIARIO: la cuota no deja de devengar el dia del corte sino el dia
// del pago. Medido en los extractos de jul/ago/sep-2026 de la Visa Infinite (CLAUDE.md, 3-oct-2026):
// solo con este termino el interes del motor queda a menos de $2.000 del banco en los tres meses, y
// el termino se encogio de agosto (16 dias) a septiembre (12 dias) en la misma proporcion que el pago.
// Topado a los dias del periodo: un extracto pagado tarde no puede devengar mas alla del corte
// siguiente por esta via (la mora es otra cosa y no se modela aqui).
// En la fila 0 solo hay cuota previa en una hija de "Sellar y Renacer": la ultima cuota SELLADA del plan
// viejo (opts.capitalFacturadoPrevio), facturada en el corte que es la fecha_compra de la hija.
function interesCuotaFacturadaHastaPago(fechaPagoDe, i, capFacturadoPrev, cortePrevio, diasPeriodo, tasaMV) {
  if (!fechaPagoDe || !(capFacturadoPrev > 0)) return 0;
  const fp = fechaPagoDe(String(cortePrevio).slice(0, 7), cortePrevio);
  if (!fp) return 0;
  const d = Math.max(0, Math.min(diasPeriodo, daysBetween(cortePrevio, fp)));
  return capFacturadoPrev * tasaMV * (d / 30);
}

// ─── Amortization engine: Avances ─────────────────────────────────
// El interés se liquida sobre el SALDO AMORTIZADO (saldoInicio): el capital que resta
// DESPUÉS de amortizar la cuota del mes anterior; NO se re-suma la cuota del mes en curso.
// Reconciliado con los extractos Bancolombia Visa mar–jun 2026 (auditoría forense): la
// hipótesis previa de "saldo facturado" (saldoInicio + cuotaCapital para Bancolombia)
// sobreestimaba el interés ~$23k/mes y hacía que el interés de avances superara el total de
// "intereses corrientes" del extracto en mayo/junio (imposible). Marzo (mes limpio, sin
// rotativo) cuadra al peso con el saldo amortizado. opts se conserva por compatibilidad.
function calcularAmortizacionAvance(monto, tasaMV, plazo, fechaDesembolso, diaCorte, abonos, comision, opts) {
  const cuotaCapitalFija = monto / plazo;
  const tabla = [];
  let saldoInicio = monto;
  let fechaAnterior = fechaDesembolso;
  let primerCorte = primerCorteAvance(fechaDesembolso, diaCorte);
  // opts.fechaPagoDe (solo Bancolombia, ver helpers/banco.js): la cuota FACTURADA en el corte anterior
  // sigue devengando hasta el dia en que se paga. Sin la funcion, el termino no existe.
  const fechaPagoDe = (opts && typeof opts.fechaPagoDe === 'function') ? opts.fechaPagoDe : null;
  let capFacturadoPrev = 0;

  for (let i = 0; i < plazo; i++) {
    if (saldoInicio <= 0.01) break;
    const fechaCorte = i === 0 ? primerCorte : addMonths(primerCorte, i);
    const dias = daysBetween(fechaAnterior, fechaCorte);
    const abonosPeriodo = (abonos || []).filter(a => a.fecha > fechaAnterior && a.fecha <= fechaCorte).sort((a, b) => a.fecha.localeCompare(b.fecha));
    const sumaAbonos = abonosPeriodo.reduce((s, a) => s + a.monto, 0);
    const fecha1erAbono = abonosPeriodo.length > 0 ? abonosPeriodo[0].fecha : null;
    const diasPreAbono = fecha1erAbono ? daysBetween(fechaAnterior, fecha1erAbono) : dias;
    const diasPostAbono = fecha1erAbono ? daysBetween(fecha1erAbono, fechaCorte) : 0;

    // Saldo base para intereses = saldo AMORTIZADO al inicio del periodo (saldoInicio).
    // El banco cobra sobre el capital que resta tras amortizar la cuota del mes anterior;
    // no re-suma la cuota del mes en curso (ver auditoría forense en el encabezado).
    const saldoBase = saldoInicio;

    let interes;
    if (!fecha1erAbono || sumaAbonos === 0) {
      interes = saldoBase * tasaMV * (dias / 30);
    } else {
      interes = (saldoBase * tasaMV * (diasPreAbono / 30))
              + (Math.max(0, saldoBase - sumaAbonos) * tasaMV * (diasPostAbono / 30));
    }
    const interesCuotaFacturada = interesCuotaFacturadaHastaPago(fechaPagoDe, i, capFacturadoPrev, fechaAnterior, dias, tasaMV);
    interes += interesCuotaFacturada;

    const cuotaCapital = Math.min(cuotaCapitalFija, Math.max(0, saldoInicio - sumaAbonos));
    const comisionCuota = (i === 0 && comision) ? comision : 0;
    const totalExtracto = interes + cuotaCapital + comisionCuota;
    const saldoFinal = Math.max(0, saldoInicio - sumaAbonos - cuotaCapital);
    const saldoTeorico = Math.max(0, monto - (cuotaCapitalFija * (i + 1)));
    const saldoInicioTeorico = Math.max(0, monto - (cuotaCapitalFija * i));
    const interesTeorico = saldoInicioTeorico * tasaMV * (dias / 30);

    tabla.push({
      numCuota: i + 1, fechaCorte, dias,
      saldoInicio: Math.round(saldoInicio * 100) / 100,
      abonos: Math.round(sumaAbonos * 100) / 100,
      fecha1erAbono, diasPreAbono, diasPostAbono,
      interes: Math.round(interes * 100) / 100,
      interesCuotaFacturada: Math.round(interesCuotaFacturada * 100) / 100,
      comision: comisionCuota,
      cuotaCapital: Math.round(cuotaCapital * 100) / 100,
      totalExtracto: Math.round(totalExtracto * 100) / 100,
      saldoFinal: Math.round(saldoFinal * 100) / 100,
      saldoTeorico: Math.round(saldoTeorico * 100) / 100,
      interesTeorico: Math.round(interesTeorico * 100) / 100
    });

    saldoInicio = saldoFinal;
    fechaAnterior = fechaCorte;
    capFacturadoPrev = cuotaCapital;
    if (saldoFinal <= 0) break;
  }

  const totalIntereses = tabla.reduce((s, r) => s + r.interes, 0);
  const totalAbonos = tabla.reduce((s, r) => s + r.abonos, 0);
  const totalInteresesTeoricos = tabla.reduce((s, r) => s + r.interesTeorico, 0);
  const ahorroIntereses = Math.max(0, totalInteresesTeoricos - totalIntereses);

  const hoyCalc = hoyLocal();
  const cuotaActualIdx = tabla.findIndex(r => r.fechaCorte >= hoyCalc);
  let saldoActual;
  if (cuotaActualIdx === -1) {
    saldoActual = tabla.length > 0 ? tabla[tabla.length - 1].saldoFinal : monto;
  } else {
    const cuotaActual = tabla[cuotaActualIdx];
    saldoActual = Math.max(0, cuotaActual.saldoInicio - cuotaActual.abonos);
  }

  const cuotasVencidas = tabla.filter(r => r.fechaCorte < hoyCalc);
  const interesesPagados = cuotasVencidas.reduce((s, r) => s + r.interes, 0);
  const cuotasPagadas = cuotasVencidas.length;
  const cuotasRestantes = tabla.length - cuotasPagadas;
  const abonoSobrante = Math.max(0, totalAbonos + (cuotasPagadas * cuotaCapitalFija) - monto);

  return {
    tabla,
    resumen: {
      totalIntereses: Math.round(totalIntereses * 100) / 100,
      interesesPagados: Math.round(interesesPagados * 100) / 100,
      totalAbonos: Math.round(totalAbonos * 100) / 100,
      totalInteresesTeoricos: Math.round(totalInteresesTeoricos * 100) / 100,
      ahorroIntereses: Math.round(ahorroIntereses * 100) / 100,
      cuotasRestantes, cuotasPagadas,
      abonoSobrante: Math.round(abonoSobrante * 100) / 100,
      cuotaCapitalFija: Math.round(cuotaCapitalFija * 100) / 100,
      saldoActual: Math.round(saldoActual * 100) / 100
    }
  };
}

// ─── Amortization engine: Diferidas ───────────────────────────────
// opts.esNu          = true → cuota 1 sin intereses (Nu Financiera)
// opts.esBancolombia = true → cuota 1 difiere su interés a la cuota 2
//                              (cuota 2 cobra interés_1 + interés_2; cuotas 3+ normal)
function calcularAmortizacionDiferida(monto, tasaMV, numCuotas, fechaCompra, fechaPrimerCorte, abonos, opts) {
  const esNu = opts && opts.esNu;
  const esBancolombia = opts && opts.esBancolombia;
  const cuotaCapitalFija = monto / numCuotas;
  // Calendario de capital IRREGULAR (opcional). Modela la reprogramacion del banco, que NO
  // re-amortiza uniforme: conserva la cuota base del plan original y comprime el saldo restante
  // en la SIGUIENTE cuota a facturar. Sin el mapa, `cuotaCapitalFija` manda y el resultado es
  // byte-identico al de siempre (la huella de R5 no se mueve).
  const capitalMapa = (opts && opts.capitalPorCuota) || null;
  // Cuota facturada devengando hasta el pago (Bancolombia; ver interesCuotaFacturadaHastaPago).
  const fechaPagoDe = (opts && typeof opts.fechaPagoDe === 'function') ? opts.fechaPagoDe : null;
  // ARRASTRE de "Sellar y Renacer": el interes de la cuota 1 que el plan ORIGINAL difirio a su cuota 2
  // y que, al reprogramar con solo la cuota 1 facturada, cobra la cuota 1 de esta hija. Medido en un
  // extracto real (sep-2026): la primera cuota del plan nuevo trajo ese interes diferido, y sin el el mes
  // no cuadraba por casi un 6%. El banco NO lo condona al reprogramar.
  const interesArrastrado = (opts && Number(opts.interesArrastrado) > 0) ? Number(opts.interesArrastrado) : 0;
  const tabla = [];
  let saldoInicial = monto;
  let fechaAnterior = fechaCompra;
  const abonosList = abonos || [];
  let capFacturadoPrev = (fechaPagoDe && opts && Number(opts.capitalFacturadoPrevio) > 0) ? Number(opts.capitalFacturadoPrevio) : 0;

  // Bancolombia: el interés acumulado de la cuota 1 que se cobrará en la cuota 2
  let interesPendienteCuota1 = 0;

  for (let i = 0; i < numCuotas; i++) {
    if (saldoInicial <= 0.01) break;
    const fechaCorte = i === 0 ? fechaPrimerCorte : addMonths(fechaPrimerCorte, i);
    const dias = daysBetween(fechaAnterior, fechaCorte);
    // Nu: cuota 1 no genera intereses (no se acumulan ni se cobran)
    // Bancolombia: cuota 1 acumula intereses pero no se cobran (se difieren a cuota 2)
    // Default (RappiCard, etc.): cada cuota cobra su propio interés
    const interesCuotaFacturada = interesCuotaFacturadaHastaPago(fechaPagoDe, i, capFacturadoPrev, fechaAnterior, dias, tasaMV);
    const interesPeriodo = (esNu && i === 0) ? 0 : saldoInicial * tasaMV * (dias / 30) + interesCuotaFacturada;

    let interesTotal;
    if (esBancolombia && i === 0) {
      interesPendienteCuota1 = interesPeriodo;
      interesTotal = 0;
    } else if (esBancolombia && i === 1) {
      interesTotal = interesPeriodo + interesPendienteCuota1;
    } else {
      interesTotal = interesPeriodo;
    }
    if (i === 0) interesTotal += interesArrastrado;

    const capitalDeEstaCuota = (capitalMapa && capitalMapa[i + 1] != null) ? capitalMapa[i + 1] : cuotaCapitalFija;
    let cuotaCapital = Math.min(capitalDeEstaCuota, saldoInicial);
    // Lo FACTURADO es la cuota del plan; un abono anticipado no se factura (se paga al hacerlo).
    const capFacturado = cuotaCapital;

    const abonosAntes = abonosList.filter(a => a.fecha < fechaCorte && a.fecha >= (i === 0 ? fechaCompra : addMonths(fechaPrimerCorte, i - 1)));
    const montoAbonosAntes = abonosAntes.reduce((s, a) => s + a.monto, 0);
    if (montoAbonosAntes > 0) {
      cuotaCapital += montoAbonosAntes;
      cuotaCapital = Math.min(cuotaCapital, saldoInicial);
    }

    const totalPagar = interesTotal + cuotaCapital;

    tabla.push({
      numCuota: i + 1, fechaCorte, dias,
      saldoInicial: Math.round(saldoInicial * 100) / 100,
      interesPeriodo: Math.round(interesPeriodo * 100) / 100,
      interesTotal: Math.round(interesTotal * 100) / 100,
      interesCuotaFacturada: Math.round(interesCuotaFacturada * 100) / 100,
      cuotaCapital: Math.round(cuotaCapital * 100) / 100,
      totalPagar: Math.round(totalPagar * 100) / 100
    });

    saldoInicial = Math.max(0, saldoInicial - cuotaCapital);
    fechaAnterior = fechaCorte;
    capFacturadoPrev = capFacturado;
  }

  const totalIntereses = tabla.reduce((s, r) => s + r.interesTotal, 0);
  const hoyCalcDif = hoyLocal();
  const cuotaActualIdxDif = tabla.findIndex(r => r.fechaCorte >= hoyCalcDif);
  let saldoActual;
  if (cuotaActualIdxDif === -1) {
    saldoActual = 0;
  } else {
    saldoActual = tabla[cuotaActualIdxDif].saldoInicial;
  }
  const cuotasRestantes = tabla.filter(r => r.fechaCorte >= hoyCalcDif).length;

  return {
    tabla,
    resumen: {
      totalIntereses: Math.round(totalIntereses * 100) / 100,
      cuotaCapitalFija: Math.round(cuotaCapitalFija * 100) / 100,
      saldoActual: Math.round(saldoActual * 100) / 100,
      cuotasRestantes
    }
  };
}

module.exports = { calcularAmortizacionAvance, calcularAmortizacionDiferida, interesCuotaFacturadaHastaPago };
