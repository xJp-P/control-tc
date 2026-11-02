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
//   pago       el dia en que se paga el extracto anterior. Por defecto en UN solo pago (con un solo pago
//              todos los ordenes de aplicacion coinciden: veredicto de oct-2026). Con `pagos_previos`
//              (abonos ya hechos antes del pago final) se agrega la dimension ORDEN: en que orden aplica el
//              banco cada pago (los siete de veredicto_interes.js), y el pago final es el resto del minimo.
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
//     "pago_desde": "AAAA-MM-DD", "pago_hasta": "AAAA-MM-DD",
//     opcional, para abonos parciales:
//     "pagos_previos": [["AAAA-MM-DD", monto], ...],
//     "extracto_anterior": { "minimo": 0, "interes": 0, "mes": 0, "anteriores": 0, "avances": 0 },   // su "Detalle del pago minimo"
//     "nombre_salida": "..." }   // para no pisar la salida (y la huella) de un pre-registro anterior
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
// Cada item lleva su ORIGEN (fecha de la compra) y su grupo del "Detalle del pago minimo" del extracto
// anterior: las cuotas de planes comprados en ese periodo van en "transacciones del mes", las de planes
// anteriores en "cuotas anteriores", y los avances aparte (lo usa la dimension orden).
const corteAntesDeP = calcExtracto(db, T, cicloAnterior(P), true).fechaCorte;
const items = [];
db.prepare("SELECT * FROM diferidas WHERE tarjeta_id=? AND estado IN ('activo','liquidado')").all(T).forEach(d => {
  const o = nuOptsDif(db, d);
  if (!o || !o.fechaPagoDe) return;
  const t = calcularAmortizacionDiferida(d.monto, d.tasa_mv, d.num_cuotas, d.fecha_compra, d.fecha_primer_corte,
    db.prepare('SELECT * FROM abonos_diferida WHERE diferida_id=? ORDER BY fecha').all(d.id), o).tabla;
  const f = t.find(r => r.fechaCorte.slice(0, 7) === P);
  const compra = db.prepare('SELECT fecha FROM compras WHERE diferida_id=? ORDER BY fecha LIMIT 1').get(d.id);
  const origen = compra ? compra.fecha : d.fecha_compra;
  const grupo = origen > corteAntesDeP ? 'mes' : 'anteriores';
  if (f) items.push({ cap: f.cuotaCapital, tasa: d.tasa_mv, origen, grupo });
  if (!f && d.fecha_primer_corte && d.fecha_primer_corte.slice(0, 7) === C && o.capitalFacturadoPrevio > 0) items.push({ cap: o.capitalFacturadoPrevio, tasa: d.tasa_mv, origen, grupo: 'anteriores' });
});
db.prepare("SELECT * FROM avances WHERE tarjeta_id=? AND estado IN ('activo','liquidado')").all(T).forEach(av => {
  const o = avanceOpts(db, T);
  if (!o || !o.fechaPagoDe) return;
  const t = calcularAmortizacionAvance(av.monto, av.tasa_mv, av.plazo, av.fecha_desembolso, av.dia_corte,
    db.prepare('SELECT * FROM abonos_avance WHERE avance_id=? ORDER BY fecha').all(av.id), av.comision, o).tabla;
  const f = t.find(r => r.fechaCorte.slice(0, 7) === P);
  if (f) items.push({ cap: f.cuotaCapital, tasa: av.tasa_mv, origen: av.fecha_desembolso, grupo: 'avances' });
});
const terminoCuotaFacturada = (cortePrev, pago, min) => {
  const tope = daysBetween(cortePrev, corte);
  const dias = Math.max(0, Math.min(tope, daysBetween(cortePrev, pago)));
  return items.reduce((s, it) => s + it.cap * it.tasa * fac(it.tasa, min) * dias / 30, 0);
};

// 2b. Con abonos previos: termino segun el ORDEN en que el banco aplica cada peso (mismos siete ordenes y
// mismo reparto que veredicto_interes.js). El pago final cubre el resto del minimo el dia `pago`.
const E = J.extracto_anterior || null;
const PREVIOS = (J.pagos_previos || []).slice().sort((a, b) => a[0].localeCompare(b[0]));
const ORDENES = { 'H1 todo al pago final': null, 'H2 interes, cuotas viejas, 1/1': 'H2', 'H3 interes, 1/1, cuotas viejas': 'H3',
  'H4 orden del detalle del minimo': 'H4', 'H5 interes, 1/1, cuotas nuevas': 'H5', 'H6 1/1, cuotas viejas, interes': 'H6', 'H7 prorrata': 'H7' };
if (PREVIOS.length) {
  if (!E || !(E.minimo > 0)) { console.error('Con pagos_previos hace falta extracto_anterior (minimo, interes, mes, anteriores, avances).'); process.exit(2); }
  const suma = g => r2(items.filter(i => i.grupo === g).reduce((s, i) => s + i.cap, 0));
  console.log('  cuadre del capital facturado: anteriores ' + suma('anteriores') + ' (banco ' + E.anteriores + ') · avances ' + suma('avances') + ' (banco ' + E.avances + ') · cuotas del mes ' + suma('mes'));
}
function terminoOrden(clave, cortePrev, pago, min) {
  if (!clave) return terminoCuotaFacturada(cortePrev, pago, min);
  const tope = daysBetween(cortePrev, corte);
  const dias = f => Math.max(0, Math.min(tope, daysBetween(cortePrev, f)));
  const k = it => it.tasa * fac(it.tasa, min);
  const eventos = [...PREVIOS, [pago, Math.max(0, E.minimo - PREVIOS.reduce((s, x) => s + x[1], 0))]];
  const capMes = E.mes - items.filter(i => i.grupo === 'mes').reduce((s, i) => s + i.cap, 0);
  if (clave === 'H7') {
    const pend = items.map(it => ({ it, falta: it.cap }));
    let otros = E.interes + capMes, total = 0;
    for (const [f, m] of eventos) {
      const q = Math.min(1, m / (otros + pend.reduce((s, x) => s + x.falta, 0)));
      pend.forEach(x => { const c = x.falta * q; total += c * k(x.it) * dias(f) / 30; x.falta -= c; });
      otros -= otros * q;
    }
    return total + pend.reduce((s, x) => s + x.falta * k(x.it) * tope / 30, 0);
  }
  const viejas = items.slice().sort((a, b) => String(a.origen).localeCompare(String(b.origen)));
  const B = xs => xs.map(it => ({ cap: it.cap, it }));
  const b11 = { cap: capMes, it: null }, bInt = { cap: E.interes, it: null };
  const baldes = ({
    H2: [bInt, ...B(viejas), b11], H3: [bInt, b11, ...B(viejas)],
    H4: [b11, ...B(items.filter(i => i.grupo === 'mes')), ...B(items.filter(i => i.grupo === 'anteriores')), ...B(items.filter(i => i.grupo === 'avances')), bInt],
    H5: [bInt, b11, ...B(viejas.slice().reverse())], H6: [b11, ...B(viejas), bInt],
  })[clave].map(b => Object.assign({ falta: b.cap }, b));
  let total = 0;
  for (const [f, m] of eventos) {
    let plata = m;
    for (const b of baldes) {
      if (plata <= 0) break;
      if (b.falta <= 0) continue;
      const c = Math.min(plata, b.falta); b.falta -= c; plata -= c;
      if (b.it) total += c * k(b.it) * dias(f) / 30;
    }
  }
  return total + baldes.reduce((s, b) => s + (b.it && b.falta > 0.005 ? b.falta * k(b.it) * tope / 30 : 0), 0);
}

// 3. Intl: el del ciclo anterior (lo que el banco cobra en este) y, aparte, el del propio ciclo segun la app.
const intlQ = "SELECT fecha, valor_cop, tasa_intl FROM compras WHERE tarjeta_id=? AND ciclo=? AND es_internacional=1 AND estado<>'diferida' AND COALESCE(anulada,0)=0 AND COALESCE(reversada,0)=0";
const intlDe = (filas, hasta) => filas.reduce((s, c) => s + c.valor_cop * (c.tasa_intl || vig) * Math.max(0, daysBetween(c.fecha, hasta)) / 30, 0);
const intlPrev = cp => intlDe(db.prepare(intlQ).all(T, P), cp);
const intlCiclo = calc.interesesComprasIntl || 0;

// 4. Modelo por escenario.
function modelo({ cortePrev, inicioAlt, min, pago, intl, orden }) {
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
  s += orden ? terminoOrden(orden, cortePrev, pago, min) : terminoCuotaFacturada(cortePrev, pago, min);
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
const ordenes = PREVIOS.length ? Object.entries(ORDENES) : [[null, null]];
for (const [no, ko] of ordenes) for (const [nc, cp] of Object.entries(CORTES_PREV)) for (const ini of [false, true]) for (const min of [false, true]) {
  const fila = { corte_anterior: nc + ' (' + cp + ')', inicio: ini ? 'alternativo' : 'app', tasa: min ? 'min' : 'propia', por_fecha_de_pago: {} };
  if (no) fila.orden = no;
  // H1 con abonos previos = todo devenga hasta el pago final, que es lo mismo que el termino sin orden.
  fechas.forEach(x => { fila.por_fecha_de_pago[x] = Math.round(modelo({ cortePrev: cp, inicioAlt: ini, min, pago: x, intl: intlPrev(cp), orden: ko })); });
  escenarios.push(fila);
}

const salida = { generado: new Date().toISOString(), parametros: J, ciclo: C, corte, corte_anterior_app: cortePrevApp, consistencia,
  intl_del_ciclo_segun_app: r2(intlCiclo), intl_ciclo_anterior: Object.fromEntries(Object.entries(CORTES_PREV).map(([k, cp]) => [k, r2(intlPrev(cp))])),
  nota: (PREVIOS.length ? 'Abonos previos ' + JSON.stringify(PREVIOS) + ' y el resto del minimo el dia de la columna, bajo cada orden de aplicacion. ' : 'Un solo pago del extracto anterior. ') + 'El intl incluido es el de las compras 1/1 del ciclo anterior; si el banco cobra tambien el del propio ciclo, sumar el de las compras internacionales de este ciclo a su cierre.',
  escenarios };
const destino = path.join(ROOT, 'docs', 'temp', (J.nombre_salida || ('prediccion_escenarios_' + C)) + '.json');
const texto = JSON.stringify(salida, null, 2) + '\n';
fs.writeFileSync(destino, texto, 'utf8');
const sha = crypto.createHash('sha256').update(texto, 'utf8').digest('hex');

console.log('Pre-registro de ' + C + ' (' + J.tarjeta + '): consistencia ' + JSON.stringify(consistencia));
const muestra = [fechas[0], fechas[Math.floor(fechas.length / 2)], fechas[fechas.length - 1]];
console.log('  escenario (corte anterior · inicio · tasa) | pago ' + muestra.join(' | '));
escenarios.filter(e => !e.orden || (e.tasa === 'propia' && e.inicio === 'app')).forEach(e => console.log('  ' + ((e.orden ? e.orden.slice(0, 2) + ' · ' : '') + e.corte_anterior + ' · ' + e.inicio + ' · ' + e.tasa).padEnd(45) + ' | ' + muestra.map(x => String(e.por_fecha_de_pago[x]).padStart(10)).join(' | ')));
console.log('  -> ' + path.relative(ROOT, destino));
console.log('  SHA-256 ' + sha);
