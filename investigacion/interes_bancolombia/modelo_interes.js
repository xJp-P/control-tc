// investigacion/interes_bancolombia/modelo_interes.js
// Ingenieria inversa del cargo "INTERESES CORRIENTES" de un extracto Bancolombia. El banco lo
// imprime como UNA sola linea por ciclo, sin desglose por compra; este script lo recompone por
// componentes bajo varias convenciones candidatas y mide cual reproduce el total impreso.
//
// Solo lectura y sin dependencias: `node modelo_interes.js <dataset.json>`.
// El dataset lleva saldos reales de extractos, asi que vive FUERA del repo (docs/temp/, ignorado):
// este repositorio es publico y aqui solo se versiona el metodo, nunca los datos.
//
// Convenciones de la base de interes de una deuda en cuotas (avance o diferida), con U = capital
// sin facturar al corte anterior y B = cuota facturada en ese corte, que se paga dentro del periodo:
//   SF_plano   (U + B) * tasa                      "saldo facturado" (docs/bancos/Bancolombia_Visa.md §6.2)
//   U_dias     U * tasa * dias/30                  lo que hace HOY el motor (amortizacion.js)
//   diario_30  U * tasa + B * tasa * diasHastaPago/30
//   diario     U * tasa * dias/30 + B * tasa * diasHastaPago/30   (saldo diario real)
'use strict';
const fs = require('fs');

const dia = s => new Date(s + 'T12:00:00Z');
const diasEntre = (a, b) => Math.round((dia(b) - dia(a)) / 86400000);
const f2 = n => n.toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const BASES = {
  SF_plano: (U, B) => U + B,
  U_dias: (U, B, c) => U * diasEntre(c.tp, c.tc) / 30,
  diario_30: (U, B, c) => U + B * diasEntre(c.tp, c.pago) / 30,
  diario: (U, B, c) => U * diasEntre(c.tp, c.tc) / 30 + B * diasEntre(c.tp, c.pago) / 30,
};

// Interes del ciclo bajo una convencion. `inicios` elige, por deuda, la fecha desde la que corre
// el interes de la cuota 1 (que Bancolombia difiere y cobra junto con la cuota 2).
function interesCiclo(c, base, intl, inicios) {
  const det = {};
  const b = BASES[base];
  det.avances = c.avances.reduce((s, x) => s + b(x.U, x.B, c) * x.tasa, 0);
  c.diferidas.forEach(x => { det[x.id] = b(x.U, x.B, c) * x.tasa; });
  c.cuota1.forEach(x => {
    const ini = x.inicios[inicios[x.id]];
    det['cuota 1 ' + x.id] = x.monto * x.tasa * diasEntre(ini, x.corte1) / 30;
  });
  det['intl 1/1'] = c.intl.reduce((s, x) => s + x.valor * x.tasa * (diasEntre(x.fecha, c.tp)
    + (intl === 'hasta_pago' ? diasEntre(c.tp, c.pago) : 0)) / 30, 0);
  return { total: Object.values(det).reduce((s, v) => s + v, 0), det };
}

// Todas las combinaciones de fechas de inicio de la cuota 1 de un ciclo.
function combinaciones(c) {
  return c.cuota1.reduce((acc, x) => acc.flatMap(a => Object.keys(x.inicios).map(k => ({ ...a, [x.id]: k }))), [{}]);
}

const ds = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const nombres = Object.keys(ds.ciclos);

console.log('=== Residuo (modelo - extracto) de cada convencion, con su mejor combinacion de fechas ===');
for (const base of Object.keys(BASES)) {
  let mejor = null;
  for (const intl of ['hasta_corte', 'hasta_pago']) {
    const porCiclo = nombres.map(n => combinaciones(ds.ciclos[n]).map(ini => ({ ini, d: interesCiclo(ds.ciclos[n], base, intl, ini).total - ds.ciclos[n].interes_real })));
    // Cada ciclo elige sus fechas por separado: las deudas de un ciclo no se repiten en el otro.
    const elegidos = porCiclo.map(ops => ops.reduce((a, o) => (Math.abs(o.d) < Math.abs(a.d) ? o : a)));
    const err = elegidos.reduce((s, o) => s + Math.abs(o.d), 0);
    if (!mejor || err < mejor.err) mejor = { err, intl, elegidos };
  }
  console.log(`${base.padEnd(10)} ` + nombres.map((n, i) => `${n} ${f2(mejor.elegidos[i].d).padStart(12)}`).join('   ') + `   (intl ${mejor.intl})`);
}

for (const n of nombres) {
  const c = ds.ciclos[n];
  console.log(`\n=== ${n} (${c.tp} -> ${c.tc}, ${diasEntre(c.tp, c.tc)} dias; pago ${c.pago}) con la convencion "diario" ===`);
  for (const ini of combinaciones(c)) {
    const r = interesCiclo(c, 'diario', 'hasta_corte', ini);
    const exp = c.cuota1.filter(x => x.experimento).map(x => `${x.id}=${ini[x.id]}`).join(', ');
    console.log(`residuo ${f2(r.total - c.interes_real).padStart(12)}   ${exp || Object.values(ini).join(', ')}`);
  }
  const bTerm = [...c.avances, ...c.diferidas].reduce((s, x) => s + x.B * x.tasa * diasEntre(c.tp, c.pago) / 30, 0);
  const dia31 = [...c.avances, ...c.diferidas].reduce((s, x) => s + x.U * x.tasa * (diasEntre(c.tp, c.tc) - 30) / 30, 0);
  console.log(`cuota facturada devengando ${diasEntre(c.tp, c.pago)} dias hasta el pago (el motor no lo modela): ${f2(bTerm)}`);
  if (dia31) console.log(`valor de los dias por encima de 30 (el motor SI los cuenta): ${f2(dia31)}`);
  c.cuota1.filter(x => x.experimento).forEach(x => {
    const v = Object.entries(x.inicios).map(([k, ini]) => `${k}: ${f2(x.monto * x.tasa * diasEntre(ini, x.corte1) / 30)}`);
    console.log(`senal ${x.id} -> ${v.join(' | ')}`);
  });
  if (c.ruido) {
    const pa = c.ruido.pago_anticipado, re = c.ruido.reembolso;
    const tasaMax = Math.max(...[...c.avances, ...c.diferidas].map(x => x.tasa));
    console.log(`ruido: pago del ${pa.fecha} aplicado a capital con interes -> hasta -${f2(pa.capital * tasaMax * diasEntre(pa.fecha, c.pago) / 30)}`);
    console.log(`ruido: reembolso del ${re.fecha} -> hasta -${f2(re.monto * tasaMax * diasEntre(re.fecha, c.pago) / 30)}`);
    console.log(`ruido: contar el dia de la compra en las cuotas 1 -> +${f2(c.cuota1.reduce((s, x) => s + x.monto * x.tasa / 30, 0))}`);
  }
}
