// herramientas/conciliacion/verificar_ciclo.js
// Contrasta un ciclo de la app contra el extracto del banco, linea por linea y AL CENTAVO, en modo
// SOLO LECTURA (better-sqlite3 readonly: lanza si algo intentara escribir). Es la condicion para
// sellar un mes: si algo no cuadra, el sello daria por pagadas compras que el banco no cobro (o al
// reves). Lee el bloque "extracto" del mismo JSON del plan (docs/temp/, ignorado: lleva datos reales).
//
// Que se comprueba:
//   0. El propio JSON: sus lineas suman los componentes que imprime el banco (atrapa una transcripcion mal hecha).
//   1. Compras del periodo: cada linea del extracto con su compra en la app (mismo valor, fecha +-2 dias;
//      una compra DIVIDIDA entre personas se suma por grupo) y ninguna compra de la app sin pareja.
//   2. Cuotas de diferidas: capital, saldo que queda y numeracion N/M, contra el motor real
//      (calcularAmortizacionDiferida + nuOptsDif, que inyecta el calendario irregular del banco).
//   3. Cuotas de avances: capital y saldo.
//   4. Cifras oficiales y fecha limite fijadas para el ciclo.
//   El INTERES se informa pero NO se exige: el motor no lo modela completo (ver CLAUDE.md, Fase B).
//
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe \
//     herramientas/conciliacion/verificar_ciclo.js <data.db> <plan.json>
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const Database = require(path.join(ROOT, 'node_modules/better-sqlite3'));
const { calcularAmortizacionDiferida, calcularAmortizacionAvance } = require(path.join(ROOT, 'backend/engine/amortizacion.js'));
const { nuOptsDif, avanceOpts } = require(path.join(ROOT, 'backend/helpers/banco.js'));
const { calcExtracto } = require(path.join(ROOT, 'backend/engine/extracto.js'));

const [dbPath, planPath] = process.argv.slice(2);
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const E = plan.extracto, ciclo = plan.ciclo;
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const T = db.prepare('SELECT id FROM tarjetas WHERE nombre=?').get(plan.tarjeta).id;

const r2 = n => Math.round(n * 100) / 100;
const iguales = (a, b) => Math.abs(a - b) < 0.005;
const fmt = n => r2(n).toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const dias = (a, b) => Math.abs(Math.round((new Date(a + 'T12:00:00Z') - new Date(b + 'T12:00:00Z')) / 86400000));
let fallos = 0;
// Lo que difiere entre la app (x) y el banco (c), en pesos con signo (app - banco).
const delta = (x, c) => {
  const d = [];
  if (!iguales(x.capital, c.capital)) d.push('capital ' + (x.capital > c.capital ? '+' : '') + fmt(x.capital - c.capital));
  if (!iguales(x.saldo, c.saldo)) d.push('saldo ' + (x.saldo > c.saldo ? '+' : '') + fmt(x.saldo - c.saldo));
  if (x.nm !== c.cuota) d.push('numeracion ' + x.nm + ' vs ' + c.cuota);
  if (x.fecha && c.fecha && x.fecha !== c.fecha) d.push('fecha app ' + x.fecha);
  return d.length ? '   [' + d.join(' · ') + ']' : '';
};
const ok = (cond, txt) => { if (!cond) fallos++; console.log((cond ? '  OK    ' : '  FALLO ') + txt); };

// ── 0. Coherencia interna del extracto transcrito ──────────────────────────────────────────────
console.log('0. El extracto transcrito');
const sCompras = E.compras.reduce((s, c) => s + c.valor, 0);
const sMes = sCompras + E.cuotas.filter(c => c.seccion === 'mes').reduce((s, c) => s + c.capital, 0);
const sAnt = E.cuotas.filter(c => c.seccion === 'anteriores').reduce((s, c) => s + c.capital, 0);
const sAv = E.avances.reduce((s, c) => s + c.capital, 0);
ok(iguales(sMes, E.resumen.mes), 'cuota transacciones del mes: lineas ' + fmt(sMes) + ' vs impreso ' + fmt(E.resumen.mes));
ok(iguales(sAnt, E.resumen.anteriores), 'cuota transacciones anteriores: lineas ' + fmt(sAnt) + ' vs impreso ' + fmt(E.resumen.anteriores));
ok(iguales(sAv, E.resumen.avances), 'cuota avances: lineas ' + fmt(sAv) + ' vs impreso ' + fmt(E.resumen.avances));
const minimo = E.resumen.mes + E.resumen.anteriores + E.resumen.avances + E.resumen.intereses;
ok(Math.abs(minimo - E.pago_minimo) <= 1, 'pago minimo: componentes ' + fmt(minimo) + ' vs impreso ' + fmt(E.pago_minimo));
const saldos = E.cuotas.reduce((s, c) => s + c.saldo, 0) + E.avances.reduce((s, c) => s + c.saldo, 0);
ok(Math.abs(minimo + saldos - E.pago_total) <= 1, 'pago total: minimo + saldos pendientes ' + fmt(minimo + saldos) + ' vs impreso ' + fmt(E.pago_total));

// ── 1. Compras del periodo ─────────────────────────────────────────────────────────────────────
console.log('\n1. Compras del periodo');
const filas = db.prepare(`SELECT id, fecha, descripcion, valor_cop, grupo_id FROM compras
  WHERE tarjeta_id=? AND ciclo=? AND estado<>'diferida' AND COALESCE(anulada,0)=0 AND COALESCE(reversada,0)=0`).all(T, ciclo);
const grupos = new Map();
filas.forEach(f => {
  const k = f.grupo_id || ('c' + f.id);
  if (!grupos.has(k)) grupos.set(k, { fecha: f.fecha, descripcion: f.descripcion, valor: 0, partes: 0, usado: false });
  const g = grupos.get(k); g.valor += f.valor_cop; g.partes++;
});
const lista = [...grupos.values()];
E.compras.forEach(c => {
  const cand = lista.filter(g => !g.usado && iguales(g.valor, c.valor) && dias(g.fecha, c.fecha) <= 3).sort((a, b) => dias(a.fecha, c.fecha) - dias(b.fecha, c.fecha));
  if (cand.length) cand[0].usado = true;
  ok(cand.length > 0, c.fecha + ' ' + c.descripcion.padEnd(24) + fmt(c.valor).padStart(14)
    + (cand.length ? '  <- app ' + cand[0].fecha + ' ' + cand[0].descripcion + (cand[0].partes > 1 ? ' (' + cand[0].partes + ' partes)' : '') : '  <- SIN PAREJA en la app'));
});
lista.filter(g => !g.usado).forEach(g => ok(false, 'la app tiene ' + g.fecha + ' ' + g.descripcion + ' ' + fmt(g.valor) + ' y el extracto NO'));

// ── 2. Cuotas de diferidas ─────────────────────────────────────────────────────────────────────
console.log('\n2. Cuotas de diferidas (capital · saldo que queda · N/M)');
const appCuotas = [];
db.prepare("SELECT * FROM diferidas WHERE tarjeta_id=? AND estado IN ('activo','liquidado')").all(T).forEach(d => {
  const a = calcularAmortizacionDiferida(d.monto, d.tasa_mv, d.num_cuotas, d.fecha_compra, d.fecha_primer_corte, null, nuOptsDif(db, d));
  const q = a.tabla.find(r => r.fechaCorte.slice(0, 7) === ciclo);
  if (!q) return;
  const cv = db.prepare('SELECT fecha, descripcion FROM compras WHERE diferida_id=? ORDER BY id LIMIT 1').get(d.id);
  const N = d.reprog_total ? (d.reprog_total - d.num_cuotas + q.numCuota) : q.numCuota;
  const M = d.reprog_total || d.num_cuotas;
  appCuotas.push({ fecha: cv ? cv.fecha : d.fecha_compra, descripcion: cv ? cv.descripcion : d.etiqueta, capital: q.cuotaCapital,
    saldo: r2(q.saldoInicial - q.cuotaCapital), nm: N + '/' + M, usado: false });
});
// Emparejar con holgura (capital a 1%, fecha de origen +-3 dias) y comparar despues AL CENTAVO: asi
// una diferencia de centavos se ve como lo que es, con su delta, y no como "sin pareja".
E.cuotas.forEach(c => {
  const cand = appCuotas.filter(x => !x.usado && Math.abs(x.capital - c.capital) <= Math.max(1, c.capital * 0.01) && dias(x.fecha, c.fecha) <= 3)
    .sort((a, b) => Math.abs(a.capital - c.capital) - Math.abs(b.capital - c.capital));
  const x = cand[0];
  if (x) x.usado = true;
  ok(!!x && iguales(x.capital, c.capital) && iguales(x.saldo, c.saldo) && x.nm === c.cuota,
    (c.fecha + ' ' + c.descripcion).padEnd(36) + c.cuota.padStart(5) + fmt(c.capital).padStart(15) + '  saldo ' + fmt(c.saldo).padStart(13)
    + (x ? '  <- app ' + x.nm + ' ' + fmt(x.capital) + ', saldo ' + fmt(x.saldo) + delta(x, c) : '  <- SIN PAREJA en la app'));
});
appCuotas.filter(x => !x.usado).forEach(x => ok(false, 'la app cobra ' + x.fecha + ' ' + x.descripcion + ' ' + x.nm + ' por ' + fmt(x.capital) + ' y el extracto NO'));

// ── 3. Avances ─────────────────────────────────────────────────────────────────────────────────
console.log('\n3. Avances');
const appAv = db.prepare("SELECT * FROM avances WHERE tarjeta_id=? AND estado IN ('activo','liquidado')").all(T).map(av => {
  const ab = db.prepare('SELECT * FROM abonos_avance WHERE avance_id=? ORDER BY fecha').all(av.id);
  const q = calcularAmortizacionAvance(av.monto, av.tasa_mv, av.plazo, av.fecha_desembolso, av.dia_corte, ab, av.comision, avanceOpts(db, av.tarjeta_id)).tabla.find(r => r.fechaCorte.slice(0, 7) === ciclo);
  return q && { fecha: av.fecha_desembolso, capital: q.cuotaCapital, saldo: q.saldoFinal, nm: q.numCuota + '/' + av.plazo, usado: false };
}).filter(Boolean);
E.avances.forEach(c => {
  const x = appAv.find(a => !a.usado && a.fecha === c.fecha && Math.abs(a.capital - c.capital) <= 1);
  if (x) x.usado = true;
  ok(!!x && iguales(x.capital, c.capital) && iguales(x.saldo, c.saldo) && x.nm === c.cuota, c.fecha + ' ' + c.cuota + fmt(c.capital).padStart(15) + '  saldo ' + fmt(c.saldo).padStart(15)
    + (x ? '  <- app ' + x.nm + ' ' + fmt(x.capital) + ', saldo ' + fmt(x.saldo) + delta(x, c) : '  <- SIN PAREJA'));
});
appAv.filter(x => !x.usado).forEach(x => ok(false, 'la app cobra el avance del ' + x.fecha + ' y el extracto NO'));

// ── 4. Cifras oficiales y fecha limite ─────────────────────────────────────────────────────────
console.log('\n4. Cifras oficiales');
const of = db.prepare('SELECT pago_minimo, pago_total FROM extractos_oficiales WHERE tarjeta_id=? AND ciclo=?').get(T, ciclo);
ok(!!of && iguales(of.pago_minimo, E.pago_minimo) && iguales(of.pago_total, E.pago_total),
  'minimo/total oficiales: ' + (of ? fmt(of.pago_minimo) + ' / ' + fmt(of.pago_total) : 'NO fijados'));
const fp = db.prepare('SELECT fecha_pago FROM fechas_pago_custom WHERE tarjeta_id=? AND ciclo=?').get(T, ciclo);
ok(!!fp && fp.fecha_pago === E.fecha_pago, 'fecha limite: ' + (fp ? fp.fecha_pago : 'NO fijada'));

// ── Interes (informativo) ──────────────────────────────────────────────────────────────────────
const ce = calcExtracto(db, T, ciclo, false);
const intApp = ce.detalleAvances.reduce((s, a) => s + a.interes, 0) + ce.detalleDiferidas.reduce((s, a) => s + a.interes, 0) + ce.interesesComprasIntl
  + (ce.interesCuotasFinales || 0);   // la ultima cuota de los planes que terminaron el mes anterior
console.log('\nInteres (informativo, NO se exige): motor ' + fmt(intApp) + ' vs extracto ' + fmt(E.resumen.intereses) + ' -> diferencia ' + fmt(E.resumen.intereses - intApp));
const est = db.prepare('SELECT estado, monto_pagado FROM extractos WHERE tarjeta_id=? AND ciclo=?').get(T, ciclo);
const pagos = db.prepare("SELECT COUNT(*) n FROM pagos WHERE tarjeta_id=? AND ciclo=? AND tipo='abono_extracto'").get(T, ciclo).n;
console.log('Estado del extracto ' + ciclo + ' en la app: ' + (est ? est.estado + ', pagado ' + fmt(est.monto_pagado) : 'sin fila') + ' · pagos registrados: ' + pagos);

db.close();
console.log('\n' + (fallos ? fallos + ' COMPROBACION(ES) EN ROJO' : 'TODO CUADRA AL CENTAVO'));
process.exit(fallos ? 1 : 0);
