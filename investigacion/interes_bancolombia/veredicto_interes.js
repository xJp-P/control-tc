// investigacion/interes_bancolombia/veredicto_interes.js
// VEREDICTO de un pre-registro (prediccion_interes.js) contra el cargo INTERESES CORRIENTES que imprimio
// el banco, con el CHEQUEO DE UNICIDAD que exige la directriz 2 del director: no basta con encontrar una
// combinacion de supuestos que cuadre; se barren TODAS y se cuenta cuantas cuadran dentro de la
// tolerancia. Una conclusion solo vale si todas las que cuadran coinciden en ella.
//
// Dimensiones del barrido (cada una es algo que el extracto no dice y el motor tiene que suponer):
//   corte        el dia de corte del ciclo para contar los dias del periodo (el de la app o el impreso)
//   tasa         la de cada plan, o min(tasa de origen, tasa vigente de la tarjeta)
//   intl         que interes de compras internacionales 1/1 entra en el cargo (y hasta que dia)
//   orden        en que orden aplica el banco cada pago al extracto anterior: de eso depende hasta que
//                dia devenga cada peso de la cuota facturada (el termino de la Fase B)
//
// Solo lectura. Los datos del extracto van en un JSON de docs/temp/ (ignorado), nunca en este archivo:
//   { "tarjeta": "...", "ciclo": "AAAA-MM", "interes_banco": 0, "corte_impreso": "AAAA-MM-DD",
//     "tolerancia": 1500,
//     "extracto_anterior": { "interes": 0, "mes": 0, "anteriores": 0, "avances": 0 },   // su "Detalle del pago minimo"
//     "eventos": [["AAAA-MM-DD", monto], ...],          // pagos y creditos al extracto anterior, con la fecha del BANCO
//     "intl_al_0": ["DESCRIPCION", ...] }               // compras que la app marca intl y el banco imprime al 0%
//
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe \
//     investigacion/interes_bancolombia/veredicto_interes.js <data.db> <docs/temp/veredicto_AAAA-MM.json>
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const Database = require(path.join(ROOT, 'node_modules/better-sqlite3'));
const { calcExtracto } = require(path.join(ROOT, 'backend/engine/extracto.js'));
const { calcularAmortizacionDiferida, calcularAmortizacionAvance } = require(path.join(ROOT, 'backend/engine/amortizacion.js'));
const { nuOptsDif, avanceOpts } = require(path.join(ROOT, 'backend/helpers/banco.js'));
const { desgloseIntereses } = require(path.join(ROOT, 'backend/services/movimientos.js'));
const { daysBetween } = require(path.join(ROOT, 'backend/helpers/dates.js'));

const [dbPath, rutaJson] = process.argv.slice(2);
if (!dbPath || !rutaJson) { console.error('Uso: veredicto_interes.js <data.db> <parametros.json>'); process.exit(2); }
const J = JSON.parse(fs.readFileSync(rutaJson, 'utf8'));
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const r2 = n => Math.round(n * 100) / 100;
const cicloAnterior = c => { const [y, m] = c.split('-').map(Number); return m === 1 ? (y - 1) + '-12' : y + '-' + String(m - 1).padStart(2, '0'); };

const tjs = db.prepare('SELECT * FROM tarjetas WHERE nombre=?').all(J.tarjeta);
if (tjs.length !== 1) { console.error('La tarjeta "' + J.tarjeta + '" no es unica o no existe.'); process.exit(1); }
const T = tjs[0].id, vig = Number(tjs[0].tasa_mv_diferidas) || 0;
const C = J.ciclo, P = cicloAnterior(C);
const calc = calcExtracto(db, T, C, false);
const cortePrevio = calcExtracto(db, T, P, true).fechaCorte;
const corteApp = calc.fechaCorte;
const CORTES = [...new Set([corteApp, J.corte_impreso || corteApp])];
const E = J.extracto_anterior;
const TOL = Number(J.tolerancia) || 1500;
const EVENTOS = (J.eventos || []).slice().sort((a, b) => a[0].localeCompare(b[0]));
const fFinal = EVENTOS.length ? EVENTOS[EVENTOS.length - 1][0] : calc.fechaPago;

// 1. Interes de PERIODO del ciclo por plan (desglose de la app). Todas las filas del ciclo van del corte
// anterior al corte: con otro corte, el periodo escala por los dias.
const dg = desgloseIntereses(db, T, C, calc);
const diasApp = daysBetween(cortePrevio, corteApp);
const periodo = (corte, tasaMin) => dg.planes.reduce((s, p) => {
  const f = tasaMin && p.tasa_mv > vig ? vig / p.tasa_mv : 1;
  return s + (p.interes.periodo + (p.interes.cuota1_diferido || 0)) * f * daysBetween(cortePrevio, corte) / diasApp;
}, 0);
const arrastre = dg.componentes.arrastre_reprogramacion || 0;

// 2. Lo que facturo el extracto anterior y devenga hasta que se paga (mismo criterio que prediccion_interes.js).
const items = [];
db.prepare("SELECT * FROM diferidas WHERE tarjeta_id=? AND estado IN ('activo','liquidado')").all(T).forEach(d => {
  const o = nuOptsDif(db, d);
  if (!o || !o.fechaPagoDe) return;
  const t = calcularAmortizacionDiferida(d.monto, d.tasa_mv, d.num_cuotas, d.fecha_compra, d.fecha_primer_corte,
    db.prepare('SELECT * FROM abonos_diferida WHERE diferida_id=? ORDER BY fecha').all(d.id), o).tabla;
  const f = t.find(r => r.fechaCorte.slice(0, 7) === P);
  const compra = db.prepare('SELECT fecha FROM compras WHERE diferida_id=? ORDER BY fecha LIMIT 1').get(d.id);
  const origen = compra ? compra.fecha : d.fecha_compra;
  if (f) items.push({ origen, cap: f.cuotaCapital, tasa: d.tasa_mv, grupo: 'anteriores' });
  if (!f && d.fecha_primer_corte && d.fecha_primer_corte.slice(0, 7) === C && o.capitalFacturadoPrevio > 0)
    items.push({ origen, cap: o.capitalFacturadoPrevio, tasa: d.tasa_mv, grupo: 'mes' });
});
db.prepare("SELECT * FROM avances WHERE tarjeta_id=? AND estado IN ('activo','liquidado')").all(T).forEach(av => {
  const o = avanceOpts(db, T);
  if (!o || !o.fechaPagoDe) return;
  const t = calcularAmortizacionAvance(av.monto, av.tasa_mv, av.plazo, av.fecha_desembolso, av.dia_corte,
    db.prepare('SELECT * FROM abonos_avance WHERE avance_id=? ORDER BY fecha').all(av.id), av.comision, o).tabla;
  const f = t.find(r => r.fechaCorte.slice(0, 7) === P);
  if (f) items.push({ origen: av.fecha_desembolso, cap: f.cuotaCapital, tasa: av.tasa_mv, grupo: 'avances' });
});
const suma = g => r2(items.filter(i => i.grupo === g).reduce((s, i) => s + i.cap, 0));
const cuadreCapital = { anteriores: [suma('anteriores'), E.anteriores], avances: [suma('avances'), E.avances] };

// 3. Variantes del interes intl de compras 1/1.
const intlDe = (filas, hasta) => filas.reduce((s, c) => s + c.valor_cop * (c.tasa_intl || vig) * Math.max(0, daysBetween(c.fecha, hasta)) / 30, 0);
const intlQ = "SELECT fecha, valor_cop, tasa_intl, descripcion FROM compras WHERE tarjeta_id=? AND ciclo=? AND es_internacional=1 AND estado<>'diferida' AND COALESCE(anulada,0)=0";
const intlPrev = db.prepare(intlQ).all(T, P), intlAhoraApp = db.prepare(intlQ).all(T, C);
const al0 = new Set((J.intl_al_0 || []).map(s => String(s).toUpperCase()));
const intlAhoraBanco = intlAhoraApp.filter(c => !al0.has(String(c.descripcion).toUpperCase()));
const INTL = {
  'anterior al corte': () => intlDe(intlPrev, cortePrevio),
  'anterior al pago': () => intlDe(intlPrev, fFinal),
  'del ciclo (clasif. app)': corte => intlDe(intlAhoraApp, corte),
  'del ciclo (clasif. banco)': corte => intlDe(intlAhoraBanco, corte),
  'ninguno': () => 0,
};

// 4. Termino de la cuota facturada segun el ORDEN en que el banco aplica cada peso de los pagos.
const ORDENES = {
  'H1 todo al pago final': null,
  'H2 interes, cuotas viejas, 1/1': 'H2',
  'H3 interes, 1/1, cuotas viejas': 'H3',
  'H4 orden del detalle del minimo': 'H4',
  'H5 interes, 1/1, cuotas nuevas': 'H5',
  'H6 1/1, cuotas viejas, interes': 'H6',
  'H7 prorrata': 'H7',
};
function termino(clave, tasaMin, corte) {
  const tope = daysBetween(cortePrevio, corte);
  const dias = f => Math.max(0, Math.min(tope, daysBetween(cortePrevio, f)));
  const fac = it => tasaMin && it.tasa > vig ? vig / it.tasa : 1;
  if (!clave) return items.reduce((s, it) => s + it.cap * it.tasa * fac(it) * dias(fFinal) / 30, 0);
  const capMes = E.mes - suma('mes');
  if (clave === 'H7') {
    const pend = items.map(it => ({ it, falta: it.cap }));
    let otros = E.interes + capMes, total = 0;
    for (const [f, m] of EVENTOS) {
      const k = Math.min(1, m / (otros + pend.reduce((s, p) => s + p.falta, 0)));
      pend.forEach(p => { const c = p.falta * k; total += c * p.it.tasa * fac(p.it) * dias(f) / 30; p.falta -= c; });
      otros -= otros * k;
    }
    return total + pend.reduce((s, p) => s + p.falta * p.it.tasa * fac(p.it) * tope / 30, 0);
  }
  const viejas = items.slice().sort((a, b) => String(a.origen).localeCompare(String(b.origen)));
  const B = xs => xs.map(it => ({ cap: it.cap, it }));
  const b11 = { cap: capMes, it: null }, bInt = { cap: E.interes, it: null };
  const baldes = ({
    H2: [bInt, ...B(viejas), b11],
    H3: [bInt, b11, ...B(viejas)],
    H4: [b11, ...B(items.filter(i => i.grupo === 'mes')), ...B(items.filter(i => i.grupo === 'anteriores')), ...B(items.filter(i => i.grupo === 'avances')), bInt],
    H5: [bInt, b11, ...B(viejas.slice().reverse())],
    H6: [b11, ...B(viejas), bInt],
  })[clave].map(b => Object.assign({ falta: b.cap }, b));
  let total = 0;
  for (const [f, m] of EVENTOS) {
    let plata = m;
    for (const b of baldes) {
      if (plata <= 0) break;
      if (b.falta <= 0) continue;
      const c = Math.min(plata, b.falta); b.falta -= c; plata -= c;
      if (b.it) total += c * b.it.tasa * fac(b.it) * dias(f) / 30;
    }
  }
  return total + baldes.reduce((s, b) => s + (b.it && b.falta > 0.005 ? b.falta * b.it.tasa * fac(b.it) * tope / 30 : 0), 0);
}

const filas = [];
for (const corte of CORTES) for (const tasaMin of [false, true]) for (const [nI, fI] of Object.entries(INTL)) for (const [nO, kO] of Object.entries(ORDENES)) {
  const v = periodo(corte, tasaMin) + arrastre + termino(kO, tasaMin, corte) + fI(corte);
  filas.push({ corte, tasa: tasaMin ? 'min' : 'propia', intl: nI, orden: nO, modelo: Math.round(v), dif: Math.round(v - J.interes_banco) });
}
const cuadran = filas.filter(f => Math.abs(f.dif) <= TOL).sort((a, b) => Math.abs(a.dif) - Math.abs(b.dif));
const distintos = k => [...new Set(cuadran.map(f => f[k]))];
const salida = { generado: new Date().toISOString(), parametros: J, corte_app: corteApp, corte_previo: cortePrevio, cuadre_capital: cuadreCapital,
  periodo: Object.fromEntries(CORTES.map(c => [c, r2(periodo(c, false))])), arrastre,
  intl: Object.fromEntries(Object.entries(INTL).map(([k, f]) => [k, CORTES.map(c => r2(f(c)))])),
  termino_por_orden: Object.fromEntries(Object.entries(ORDENES).map(([n, k]) => [n, CORTES.map(c => r2(termino(k, false, c)))])),
  cuadran, unicidad: { combinaciones: filas.length, cuadran: cuadran.length, cortes: distintos('corte'), ordenes: distintos('orden'), tasas: distintos('tasa'), intl: distintos('intl') },
  filas };
const destino = path.join(ROOT, 'docs', 'temp', 'veredicto_interes_' + C + '.json');
fs.writeFileSync(destino, JSON.stringify(salida, null, 2) + '\n', 'utf8');

console.log('Veredicto del cargo INTERESES CORRIENTES de ' + C + ' (' + J.tarjeta + '): banco ' + J.interes_banco);
console.log('  cuadre del capital facturado en ' + P + ': ' + JSON.stringify(cuadreCapital));
console.log('  periodo por corte: ' + JSON.stringify(salida.periodo) + ' | arrastre ' + arrastre);
console.log('  intl: ' + JSON.stringify(salida.intl));
console.log('  termino por orden: ' + JSON.stringify(salida.termino_por_orden));
console.log('  CUADRAN (|dif| <= ' + TOL + '): ' + cuadran.length + ' de ' + filas.length);
cuadran.forEach(f => console.log('    corte ' + f.corte + ' · tasa ' + f.tasa.padEnd(6) + ' · intl ' + f.intl.padEnd(26) + ' · ' + f.orden.padEnd(34) + (f.dif > 0 ? '+' : '') + f.dif));
console.log('  unicidad: cortes ' + JSON.stringify(salida.unicidad.cortes) + ' · ordenes ' + JSON.stringify(salida.unicidad.ordenes));
for (const corte of CORTES) {
  console.log('  mejor por orden con corte ' + corte + ':');
  Object.keys(ORDENES).forEach(o => { const b = filas.filter(f => f.corte === corte && f.orden === o).sort((a, b) => Math.abs(a.dif) - Math.abs(b.dif))[0];
    console.log('    ' + o.padEnd(34) + String(b.dif).padStart(7) + '  (tasa ' + b.tasa + ', intl ' + b.intl + ')'); });
}
console.log('  -> ' + path.relative(ROOT, destino));
