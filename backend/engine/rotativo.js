// backend/engine/rotativo.js — Motor Rotativo (Libro Mayor de deuda: saldo anterior + waterfall).
// Fase 1: infra + core. NO alimenta la UI todavía (dashboard.js sigue con el modelo por-fila).
// Descubrimientos matemáticos (8 extractos Personal Visa, ver CLAUDE.md "Arquitectura Futura:
// Motor Rotativo"):
//   (1) Identidad de rotación: deuda_corte(N) = saldo_anterior + compras + avances + otros +
//       int_corriente - pagos ;  saldo_anterior(N+1) = deuda_corte(N).
//   (2) Pago mínimo = cuota_transacciones + cuota_avances + int_corriente + otros + mora.
//   (3) Cascada de pagos: mora -> int_corriente -> otros -> cuotas -> prepago a capital.
//   (4) Interés corriente sobre el capital VIVO (saldo diario promedio; Fix #1 = base amortizada).
const { daysBetween, calcCicloLocal } = require('../helpers/dates');

const round2 = (n) => Math.round((n || 0) * 100) / 100;

// Último día de corte de un ciclo 'YYYY-MM' según el día de corte (clamp a fin de mes).
function fechaCorteCiclo(ciclo, diaCorte) {
  const [y, m] = ciclo.split('-').map(Number);
  const ultimo = new Date(y, m, 0).getDate();
  const d = Math.min(diaCorte || 30, ultimo);
  return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}
function cicloPrevio(ciclo) {
  let [y, m] = ciclo.split('-').map(Number);
  m -= 1; if (m < 1) { m = 12; y -= 1; }
  return y + '-' + String(m).padStart(2, '0');
}

// ─── (3) Cascada de pagos / imputación ─────────────────────────────────────────
// Reparte un pago global en el orden legal de imputación. Devuelve cuánto fue a cada bucket.
function aplicarCascada(pago, { mora = 0, intCorriente = 0, otrosCargos = 0, cuotasCapital = 0 } = {}) {
  let r = Math.max(0, pago || 0);
  const aMora = Math.min(r, mora); r -= aMora;
  const aInteres = Math.min(r, intCorriente); r -= aInteres;
  const aOtros = Math.min(r, otrosCargos); r -= aOtros;
  const aCuotas = Math.min(r, cuotasCapital); r -= aCuotas;
  const aPrepago = r; // excedente sobre el mínimo -> prepago a capital (reduce saldo -> reduce interés futuro)
  return {
    aMora: round2(aMora), aInteres: round2(aInteres), aOtros: round2(aOtros),
    aCuotas: round2(aCuotas), aPrepago: round2(aPrepago), aCapital: round2(aCuotas + aPrepago)
  };
}

// ─── (4) Interés corriente: modelo sobre el saldo diario promedio ───────────────
// Aproximación Fase 1: integra el saldo día a día, reduciéndolo por cada pago en su fecha.
// (Refinamiento Fase 2: prorratear también la ENTRADA de cargos por su fecha, y tasa mixta.)
function interesRotativoModelo(saldoApertura, pagos, tasaMv, fCorteAnterior, fCorte) {
  const totalDias = daysBetween(fCorteAnterior, fCorte);
  if (totalDias <= 0) return 0;
  const evs = (pagos || [])
    .filter(p => p.fecha > fCorteAnterior && p.fecha <= fCorte)
    .sort((a, b) => a.fecha.localeCompare(b.fecha));
  let saldo = Math.max(0, saldoApertura), cursor = fCorteAnterior, acum = 0;
  for (const p of evs) {
    const d = daysBetween(cursor, p.fecha);
    acum += saldo * d;
    saldo = Math.max(0, saldo - Math.abs(p.monto));
    cursor = p.fecha;
  }
  acum += saldo * daysBetween(cursor, fCorte);
  const saldoPromedio = acum / totalDias;
  return round2(saldoPromedio * tasaMv * (totalDias / 30));
}

// Deriva los cargos del mes desde el DETALLE (compras/avances). Reproduce el desglose del extracto:
//   compras_mes  = compras del ciclo (incl. capital de diferidas nuevas), SIN cuota de manejo ni
//                  "intereses ... " registrados como compra.
//   otros_cargos = cuota de manejo (compra) + comisiones de los avances desembolsados en el ciclo.
//   avances_mes  = capital de los avances desembolsados en el ciclo.
function derivarCargosCiclo(db, tarjetaId, ciclo) {
  const tj = db.prepare('SELECT dia_corte FROM tarjetas WHERE id=?').get(tarjetaId) || {};
  const diaCorte = tj.dia_corte || 30;
  const compras = db.prepare(
    "SELECT COALESCE(SUM(valor_cop),0) t FROM compras WHERE tarjeta_id=? AND ciclo=? " +
    "AND UPPER(descripcion) NOT LIKE 'CUOTA DE MANEJO%' AND UPPER(descripcion) NOT LIKE 'INTERESES%'"
  ).get(tarjetaId, ciclo).t;
  const cuotaManejo = db.prepare(
    "SELECT COALESCE(SUM(valor_cop),0) t FROM compras WHERE tarjeta_id=? AND ciclo=? AND UPPER(descripcion) LIKE 'CUOTA DE MANEJO%'"
  ).get(tarjetaId, ciclo).t;
  let avances = 0, comisiones = 0;
  for (const a of db.prepare('SELECT monto, comision, fecha_desembolso FROM avances WHERE tarjeta_id=?').all(tarjetaId)) {
    if (calcCicloLocal(a.fecha_desembolso, diaCorte) === ciclo) { avances += a.monto; comisiones += (a.comision || 0); }
  }
  return { compras_mes: round2(compras), avances_mes: round2(avances), otros_cargos: round2(cuotaManejo + comisiones) };
}

// ─── cerrarCiclo: genera (o actualiza) el cierre mensual de una tarjeta/ciclo ───
// opts: { saldoAnterior?, compras_mes?, avances_mes?, otros_cargos?, pagos?, intCorriente?, mora?,
//         cuotaTransacciones?, cuotaAvances?, tasaMv?, dryRun? }
//   - intCorriente: si se provee (conciliado con el extracto) se usa; si no, el modelo rotativo.
//   - cuotaTransacciones/cuotaAvances: Fase 1 se proveen (conciliadas). Derivarlas del saldo vivo = Fase 2.
function cerrarCiclo(db, tarjetaId, ciclo, opts = {}) {
  const tj = db.prepare('SELECT dia_corte, tasa_mv_avances FROM tarjetas WHERE id=?').get(tarjetaId) || {};
  const diaCorte = tj.dia_corte || 30;
  const tasaMv = opts.tasaMv != null ? opts.tasaMv : (tj.tasa_mv_avances || 0.01911);

  // (1) Saldo anterior = deuda_corte del cierre previo (rollover) o bootstrap.
  let saldoAnterior;
  if (opts.saldoAnterior != null) saldoAnterior = opts.saldoAnterior;
  else {
    const prev = db.prepare("SELECT deuda_corte FROM cierres_mensuales WHERE tarjeta_id=? AND ciclo < ? ORDER BY ciclo DESC LIMIT 1").get(tarjetaId, ciclo);
    saldoAnterior = prev ? prev.deuda_corte : 0;
  }

  // (2) Cargos del mes (derivados del detalle, con overrides opcionales).
  const cargos = derivarCargosCiclo(db, tarjetaId, ciclo);
  const compras = opts.compras_mes != null ? opts.compras_mes : cargos.compras_mes;
  const avances = opts.avances_mes != null ? opts.avances_mes : cargos.avances_mes;
  const otros = opts.otros_cargos != null ? opts.otros_cargos : cargos.otros_cargos;

  // (3) Pagos del ciclo (globales, de pagos_tarjeta).
  const pagosRows = db.prepare("SELECT fecha, monto FROM pagos_tarjeta WHERE tarjeta_id=? AND ciclo=? ORDER BY fecha").all(tarjetaId, ciclo);
  const pagos = opts.pagos != null ? opts.pagos : round2(pagosRows.reduce((s, p) => s + Math.abs(p.monto), 0));

  // (4) Interés corriente: conciliado (real) o el modelo del saldo diario promedio.
  const fCorte = fechaCorteCiclo(ciclo, diaCorte);
  const fCorteAnt = fechaCorteCiclo(cicloPrevio(ciclo), diaCorte);
  const intModelo = interesRotativoModelo(saldoAnterior + avances, pagosRows, tasaMv, fCorteAnt, fCorte);
  const intCorriente = opts.intCorriente != null ? opts.intCorriente : intModelo;
  const mora = opts.mora || 0;

  // (5) Cuotas del mínimo (Fase 1: conciliadas).
  const cuotaTrans = opts.cuotaTransacciones || 0;
  const cuotaAvan = opts.cuotaAvances || 0;

  // (6) Waterfall.
  const cascada = aplicarCascada(pagos, { mora, intCorriente, otrosCargos: otros, cuotasCapital: cuotaTrans + cuotaAvan });

  // (7) Identidad de rotación + pago mínimo.
  const deudaCorte = round2(saldoAnterior + compras + avances + otros + intCorriente - pagos);
  const pagoMinimo = round2(cuotaTrans + cuotaAvan + intCorriente + otros + mora);

  const cierre = {
    tarjeta_id: tarjetaId, ciclo, fecha_corte: fCorte,
    saldo_anterior: round2(saldoAnterior), compras_mes: round2(compras), avances_mes: round2(avances),
    otros_cargos: round2(otros), int_corriente: round2(intCorriente), int_mora: round2(mora),
    pagos_abonos: round2(pagos), deuda_corte: deudaCorte, pago_minimo: pagoMinimo,
    cuota_transacciones: round2(cuotaTrans), cuota_avances: round2(cuotaAvan),
    estado: pagos >= pagoMinimo ? 'pagado' : (pagos > 0 ? 'parcial' : 'pendiente'),
    _intModelo: intModelo, _cascada: cascada
  };

  if (!opts.dryRun) {
    db.prepare(`INSERT INTO cierres_mensuales
        (tarjeta_id,ciclo,fecha_corte,saldo_anterior,compras_mes,avances_mes,otros_cargos,int_corriente,int_mora,pagos_abonos,deuda_corte,pago_minimo,cuota_transacciones,cuota_avances,estado)
      VALUES (@tarjeta_id,@ciclo,@fecha_corte,@saldo_anterior,@compras_mes,@avances_mes,@otros_cargos,@int_corriente,@int_mora,@pagos_abonos,@deuda_corte,@pago_minimo,@cuota_transacciones,@cuota_avances,@estado)
      ON CONFLICT(tarjeta_id,ciclo) DO UPDATE SET
        fecha_corte=@fecha_corte, saldo_anterior=@saldo_anterior, compras_mes=@compras_mes, avances_mes=@avances_mes,
        otros_cargos=@otros_cargos, int_corriente=@int_corriente, int_mora=@int_mora, pagos_abonos=@pagos_abonos,
        deuda_corte=@deuda_corte, pago_minimo=@pago_minimo, cuota_transacciones=@cuota_transacciones,
        cuota_avances=@cuota_avances, estado=@estado`).run(cierre);
  }
  return cierre;
}

module.exports = { cerrarCiclo, aplicarCascada, interesRotativoModelo, derivarCargosCiclo, fechaCorteCiclo, cicloPrevio };
