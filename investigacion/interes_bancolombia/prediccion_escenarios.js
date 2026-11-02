// investigacion/interes_bancolombia/prediccion_escenarios.js
// PRE-REGISTRO de un cargo INTERESES CORRIENTES bajo ESCENARIOS: combina las preguntas que el extracto
// anterior dejo abiertas y escribe, ANTES de que llegue el PDF y antes de pagar, que cifra corresponde a
// cada combinacion. Despues, veredicto_interes.js (o una lectura directa) dice cual se cumplio. Una
// prediccion escrita despues de ver la cifra no prueba nada (directriz 2 del director).
//
// Preguntas que barre (todas son cosas que el banco no imprime):
//   corte      de que dia arranca el periodo: el corte anterior que supone la app o el que imprimio el
//              banco (oct-2026: la app supone el 30, el banco corto el 31). Mueve los dias del periodo,
//              los del termino de la cuota facturada y los del interes diferido de las cuotas 1.
//   inicio     desde que fecha cuenta el interes de la cuota 1 de los planes nombrados (la de la compra
//              que registro la app, o la del movimiento del banco, que puede ser la de la financiacion).
//   tasa       la de cada plan, o min(tasa de origen, tasa vigente de la tarjeta).
//   pago       el dia en que se paga el extracto anterior, en UN solo pago (con un solo pago todos los
//              ordenes de aplicacion coinciden: veredicto de oct-2026).
// El intl de compras 1/1 entra como el banco lo cobra en el ciclo siguiente (las del ciclo anterior); el
// de las compras del propio ciclo se informa aparte porque depende de compras que aun no existen.
//
// Chequeo de consistencia antes de predecir nada: con TODOS los supuestos de la app (su corte, sus fechas,
// tasa propia, el dia de pago que supone el motor y el intl del ciclo) el modelo tiene que reproducir al
// peso el interes que la app proyecta. Si no, aborta.
//
// Solo lectura; parametros y salida en docs/temp/ (ignorado). Al repo va solo el SHA-256 de la salida.
//   { "tarjeta": "...", "ciclo": "AAAA-MM", "corte_anterior_banco": "AAAA-MM-DD",
//     "planes": [{ "descripcion": "...", "fecha_app": "AAAA-MM-DD", "inicio_alternativo": "AAAA-MM-DD" }],
//     "pago_desde": "AAAA-MM-DD", "pago_hasta": "AAAA-MM-DD" }
//
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe \
//     investigacion/interes_bancolombia/prediccion_escenarios.js <data.db> <docs/temp/escenarios_AAAA-MM.json>
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const Database = require(path.join(ROOT, 'node_modules/better-sqlite3'));
const { calcExtracto } = require(path.join(ROOT, 'backend/engine/extracto.js'));
const { calcularAmortizacionDiferida, calcularAmortizacionAvance } = require(path.join(ROOT, 'backend/engine/amortizacion.js'));
const { nuOptsDif, avanceOpts } = require(path.join(ROOT, 'backend/helpers/banco.js'));
const { desgloseIntereses } = require(path.join(ROOT, 'backend/services/movimientos.js'));
const { daysBetween, addDays } = require(path.join(ROOT, 'backend/helpers/dates.js'));

const [dbPath, rutaJson] = process.argv.slice(2);
if (!dbPath || !rutaJson) { console.error('Uso: prediccion_escenarios.js <data.db> <parametros.json>'); process.exit(2); }
const J = JSON.parse(fs.readFileSync(rutaJson, 'utf8'));
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const r2 = n => Math.round(n * 100) / 100;
const cicloAnterior = c => { const [y, m] = c.split('-').map(Number); return m === 1 ? (y - 1) + '-12' : y + '-' + String(m - 1).padStart(2, '0'); };

const tjs = db.prepare('SELECT * FROM tarjetas WHERE nombre=?').all(J.tarjeta);
if (tjs.length !== 1) { console.error('La tarjeta "' + J.tarjeta + '" no es unica o no existe.'); process.exit(1); }
const T = tjs[0].id, vig = Number(tjs[0].tasa_mv_diferidas) || 0;
const C = J.ciclo, P = cicloAnterior(C);
const calc = calcExtracto(db, T, C, false);
const corte = calc.fechaCorte;
const cortePrevApp = calcExtracto(db, T, P, true).fechaCorte;
const CORTES_PREV = { app: cortePrevApp, banco: J.corte_anterior_banco || cortePrevApp };
const dg = desgloseIntereses(db, T, C, calc);
const fac = (tasa, min) => min && tasa > vig ? vig / tasa : 1;

// Planes nombrados (por descripcion + fecha de la app, NUNCA por id): su cuota 1 se recalcula por escenario.
const nombrados = (J.planes || []).map(p => {
  const filas = db.prepare("SELECT * FROM diferidas WHERE tarjeta_id=? AND etiqueta=? AND fecha_compra=? AND estado='activo'").all(T, p.descripcion, p.fecha_app);
  if (!filas.length) throw new Error('No hay plan activo "' + p.descripcion + '" del ' + p.fecha_app);
  return { p, filas };
});
const idsNombrados = new Set(nombrados.flatMap(n => n.filas.map(f => f.id)));

// 1. Periodo y diferido de cuota 1 por plan del ciclo (de las amortizaciones, igual que el desglose).
const filasCiclo = [];
db.prepare("SELECT * FROM diferidas WHERE tarjeta_id=? AND estado='activo'").all(T).forEach(d => {
  const o = nuOptsDif(db, d);
  const t = calcularAmortizacionDiferida(d.monto, d.tasa_mv, d.num_cuotas, d.fecha_compra, d.fecha_primer_corte,
    db.prepare('SELECT * FROM abonos_diferida WHERE diferida_id=? ORDER BY fecha').all(d.id), o).tabla;
  const f = t.find(r => r.fechaCorte.slice(0, 7) === C);
  if (!f) return;
  const gracia = !!(o && o.esBancolombia);
  const arrastre = (f.numCuota === 1 && o && Number(o.interesArrastrado) > 0) ? Number(o.interesArrastrado) : 0;
  const cuotaFact = (gracia && f.numCuota === 1) ? 0 : (f.interesCuotaFacturada || 0);
  const periodo = (gracia && f.numCuota === 1) ? 0 : f.interesPeriodo - cuotaFact;
  const diferido1 = (gracia && f.numCuota === 2) ? f.interesTotal - f.interesPeriodo : 0;
  filasCiclo.push({ id: d.id, tasa: d.tasa_mv, periodo, diferido1, arrastre, d, primerCorte: d.fecha_primer_corte });
});
db.prepare("SELECT * FROM avances WHERE tarjeta_id=? AND estado='activo'").all(T).forEach(av => {
  const t = calcularAmortizacionAvance(av.monto, av.tasa_mv, av.plazo, av.fecha_desembolso, av.dia_corte,
    db.prepare('SELECT * FROM abonos_avance WHERE avance_id=? ORDER BY fecha').all(av.id), av.comision, avanceOpts(db, T)).tabla;
  const f = t.find(r => r.fechaCorte.slice(0, 7) === C);
  if (f) filasCiclo.push({ id: 'av' + av.id, tasa: av.tasa_mv, periodo: f.interes - (f.interesCuotaFacturada || 0), diferido1: 0, arrastre: 0 });
});

// 2. Lo facturado en el ciclo anterior, que devenga desde ESE corte hasta el pago.
const items = [];
db.prepare("SELECT * FROM diferidas WHERE tarjeta_id=? AND estado IN ('activo','liquidado')").all(T).forEach(d => {
  const o = nuOptsDif(db, d);
  if (!o || !o.fechaPagoDe) return;
  const t = calcularAmortizacionDiferida(d.monto, d.tasa_mv, d.num_cuotas, d.fecha_compra, d.fecha_primer_corte,
    db.prepare('SELECT * FROM abonos_diferida WHERE diferida_id=? ORDER BY fecha').all(d.id), o).tabla;
  const f = t.find(r => r.fechaCorte.slice(0, 7) === P);
  if (f) items.push({ cap: f.cuotaCapital, tasa: d.tasa_mv });
  if (!f && d.fecha_primer_corte && d.fecha_primer_corte.slice(0, 7) === C && o.capitalFacturadoPrevio > 0) items.push({ cap: o.capitalFacturadoPrevio, tasa: d.tasa_mv });
});
db.prepare("SELECT * FROM avances WHERE tarjeta_id=? AND estado IN ('activo','liquidado')").all(T).forEach(av => {
  const o = avanceOpts(db, T);
  if (!o || !o.fechaPagoDe) return;
  const t = calcularAmortizacionAvance(av.monto, av.tasa_mv, av.plazo, av.fecha_desembolso, av.dia_corte,
    db.prepare('SELECT * FROM abonos_avance WHERE avance_id=? ORDER BY fecha').all(av.id), av.comision, o).tabla;
  const f = t.find(r => r.fechaCorte.slice(0, 7) === P);
  if (f) items.push({ cap: f.cuotaCapital, tasa: av.tasa_mv });
});
const terminoCuotaFacturada = (cortePrev, pago, min) => {
  const tope = daysBetween(cortePrev, corte);
  const dias = Math.max(0, Math.min(tope, daysBetween(cortePrev, pago)));
  return items.reduce((s, it) => s + it.cap * it.tasa * fac(it.tasa, min) * dias / 30, 0);
};

// 3. Intl: el del ciclo anterior (lo que el banco cobra en este) y, aparte, el del propio ciclo segun la app.
const intlQ = "SELECT fecha, valor_cop, tasa_intl FROM compras WHERE tarjeta_id=? AND ciclo=? AND es_internacional=1 AND estado<>'diferida' AND COALESCE(anulada,0)=0 AND COALESCE(reversada,0)=0";
const intlDe = (filas, hasta) => filas.reduce((s, c) => s + c.valor_cop * (c.tasa_intl || vig) * Math.max(0, daysBetween(c.fecha, hasta)) / 30, 0);
const intlPrev = cp => intlDe(db.prepare(intlQ).all(T, P), cp);
const intlCiclo = calc.interesesComprasIntl || 0;

// 4. Modelo por escenario.
function modelo({ cortePrev, inicioAlt, min, pago, intl }) {
  const diasPeriodoApp = daysBetween(cortePrevApp, corte);
  const escala = daysBetween(cortePrev, corte) / diasPeriodoApp;
  let s = 0;
  filasCiclo.forEach(f => {
    s += f.periodo * fac(f.tasa, min) * escala + f.arrastre;
    if (idsNombrados.has(f.id) && f.diferido1 > 0) {
      // cuota 1 del plan: desde su inicio hasta SU primer corte (el del banco si el banco corto otro dia)
      const primer = cortePrev;                                   // los planes nombrados nacen en el ciclo anterior
      const inicio = inicioAlt ? (nombrados.find(n => n.filas.some(x => x.id === f.id)).p.inicio_alternativo) : f.d.fecha_compra;
      s += f.d.monto * f.tasa * fac(f.tasa, min) * Math.max(0, daysBetween(inicio, primer)) / 30;
    } else s += f.diferido1 * fac(f.tasa, min);
  });
  s += terminoCuotaFacturada(cortePrev, pago, min);
  return s + intl;
}

// Consistencia: todos los supuestos de la app -> el interes que la app proyecta, al peso.
const ePrev = calcExtracto(db, T, P, true);
const optsTj = avanceOpts(db, T);
const pagoApp = optsTj && optsTj.fechaPagoDe ? optsTj.fechaPagoDe(P, ePrev.fechaCorte) : ePrev.fechaPago;
const comoApp = modelo({ cortePrev: cortePrevApp, inicioAlt: false, min: false, pago: pagoApp, intl: intlCiclo });
const consistencia = { modelo_con_supuestos_app: r2(comoApp), app: dg.total_app, diferencia: r2(comoApp - dg.total_app), pago_supuesto: pagoApp };
if (Math.abs(comoApp - dg.total_app) > 1) { console.error('INCONSISTENCIA: el modelo no reproduce la proyeccion de la app', consistencia); process.exit(1); }

const fechas = [];
for (let f = J.pago_desde; f <= J.pago_hasta; f = addDays(f, 1)) fechas.push(f);
const escenarios = [];
for (const [nc, cp] of Object.entries(CORTES_PREV)) for (const ini of [false, true]) for (const min of [false, true]) {
  const fila = { corte_anterior: nc + ' (' + cp + ')', inicio: ini ? 'alternativo' : 'app', tasa: min ? 'min' : 'propia', por_fecha_de_pago: {} };
  fechas.forEach(x => { fila.por_fecha_de_pago[x] = Math.round(modelo({ cortePrev: cp, inicioAlt: ini, min, pago: x, intl: intlPrev(cp) })); });
  escenarios.push(fila);
}

const salida = { generado: new Date().toISOString(), parametros: J, ciclo: C, corte, corte_anterior_app: cortePrevApp, consistencia,
  intl_del_ciclo_segun_app: r2(intlCiclo), intl_ciclo_anterior: Object.fromEntries(Object.entries(CORTES_PREV).map(([k, cp]) => [k, r2(intlPrev(cp))])),
  nota: 'Un solo pago del extracto anterior. El intl incluido es el de las compras 1/1 del ciclo anterior; si el banco cobra tambien el del propio ciclo, sumar el de las compras internacionales de este ciclo a su cierre.',
  escenarios };
const destino = path.join(ROOT, 'docs', 'temp', 'prediccion_escenarios_' + C + '.json');
const texto = JSON.stringify(salida, null, 2) + '\n';
fs.writeFileSync(destino, texto, 'utf8');
const sha = crypto.createHash('sha256').update(texto, 'utf8').digest('hex');

console.log('Pre-registro de ' + C + ' (' + J.tarjeta + '): consistencia ' + JSON.stringify(consistencia));
const muestra = [fechas[0], fechas[Math.floor(fechas.length / 2)], fechas[fechas.length - 1]];
console.log('  escenario (corte anterior · inicio · tasa) | pago ' + muestra.join(' | '));
escenarios.forEach(e => console.log('  ' + (e.corte_anterior + ' · ' + e.inicio + ' · ' + e.tasa).padEnd(40) + ' | ' + muestra.map(x => String(e.por_fecha_de_pago[x]).padStart(10)).join(' | ')));
console.log('  -> ' + path.relative(ROOT, destino));
console.log('  SHA-256 ' + sha);
