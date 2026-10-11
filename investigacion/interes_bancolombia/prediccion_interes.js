// investigacion/interes_bancolombia/prediccion_interes.js
// PRE-REGISTRO: predice el cargo INTERESES CORRIENTES que imprimira el extracto de un ciclo, bajo
// hipotesis rivales sobre COMO un abono hecho antes de la fecha limite apaga la cuota facturada del
// extracto anterior. Se corre ANTES de que llegue el PDF: una prediccion escrita despues de ver la cifra
// no prueba nada (directriz 2 del director: el veredicto tiene que poder salir mal).
//
// La pregunta: el motor (Fase B) supone que TODA la cuota facturada devenga hasta un unico dia de pago
// (el real si el extracto ya se sello; si no, la fecha limite). Si el banco liquida de verdad sobre el
// SALDO DIARIO, un abono parcial a mitad de camino apaga esa cuota el dia en que entra.
//   H1  motor actual: toda la cuota facturada devenga hasta el pago que completa el minimo.
//   H2  saldo diario: cada pago (y cada credito de reverso) apaga capital facturado el dia que entra;
//       primero los intereses, despues las cuotas de la deuda MAS VIEJA y al final las compras 1/1.
//   H3  igual que H2, pero el pago cubre las compras 1/1 ANTES que las cuotas.
// Como el resto del minimo puede pagarse cualquier dia hasta la fecha limite, cada hipotesis sale como
// una tabla por la fecha de ese ultimo pago (bajo H1 importa; bajo H2 casi no).
//
// Ademas, una VARIANTE de tasa: la de cada plan pasa a min(tasa de origen, tasa vigente de la tarjeta)
// (el extracto de septiembre imprimio la vigente en planes nacidos en agosto; sin medir todavia).
//
// Lo que se compara con el banco: el motor de la app pone el interes de las compras internacionales 1/1
// en el MISMO ciclo de la compra y el banco en el SIGUIENTE (docs/bancos/Bancolombia_Visa.md §4.4), asi
// que la prediccion del cargo del banco cambia el intl del ciclo por el del ciclo anterior.
//
// Solo lectura (better-sqlite3 readonly: lanza si algo intentara escribir). Las cifras llevan datos
// reales: el JSON de salida va a docs/temp/ (ignorado). Al repo solo sube su SHA-256, que fecha la
// prediccion sin publicarla.
//
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe \
//     investigacion/interes_bancolombia/prediccion_interes.js <data.db> "<tarjeta>" <ciclo> [conciliacion_ciclo_anterior.json]
//
// El JSON opcional es el de herramientas/conciliacion (bloque extracto.resumen.intereses): el interes
// que el banco cobro en el ciclo anterior, que es lo primero que cubre un pago. Sin el, se usa el motor.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const ROOT = path.join(__dirname, '..', '..');
const Database = require(path.join(ROOT, 'node_modules/better-sqlite3'));
const { calcExtracto } = require(path.join(ROOT, 'backend/engine/extracto.js'));
const { calcularAmortizacionDiferida, calcularAmortizacionAvance } = require(path.join(ROOT, 'backend/engine/amortizacion.js'));
const { interesColaCuotasFinales } = require(path.join(ROOT, 'backend/engine/colaCuotaFacturada.js'));
const { nuOptsDif, avanceOpts } = require(path.join(ROOT, 'backend/helpers/banco.js'));
const { minimoEfectivo } = require(path.join(ROOT, 'backend/helpers/extractoOficial.js'));
const { daysBetween, addDays } = require(path.join(ROOT, 'backend/helpers/dates.js'));

const [dbPath, nombreTarjeta, ciclo, rutaConciliacion] = process.argv.slice(2);
if (!dbPath || !nombreTarjeta || !/^\d{4}-\d{2}$/.test(ciclo || '')) {
  console.error('Uso: prediccion_interes.js <data.db> "<tarjeta>" <AAAA-MM> [conciliacion.json]');
  process.exit(2);
}
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
const r2 = n => Math.round(n * 100) / 100;
const cicloAnterior = c => { const [y, m] = c.split('-').map(Number); return m === 1 ? (y - 1) + '-12' : y + '-' + String(m - 1).padStart(2, '0'); };

const tjs = db.prepare('SELECT * FROM tarjetas WHERE nombre=?').all(nombreTarjeta);
if (tjs.length !== 1) { console.error('La tarjeta "' + nombreTarjeta + '" no es unica o no existe (' + tjs.length + ').'); process.exit(1); }
const tj = tjs[0];
const T = tj.id;
const previo = cicloAnterior(ciclo);

const eAhora = calcExtracto(db, T, ciclo, false);
const ePrevio = calcExtracto(db, T, previo, true);
const cortePrevio = ePrevio.fechaCorte;
const corte = eAhora.fechaCorte;
const diasPeriodo = daysBetween(cortePrevio, corte);

// ── 1. Lo que la app proyecta hoy para el ciclo (mismo total que investigacion/.../motor_app.js) ──────
const motor = {
  avances: eAhora.detalleAvances.reduce((s, a) => s + a.interes, 0),
  diferidas: eAhora.detalleDiferidas.reduce((s, d) => s + d.interes, 0),
  intl_del_ciclo: eAhora.interesesComprasIntl,
  cola: r2(eAhora.interesCuotasFinales || 0),
};
motor.total = r2(motor.avances + motor.diferidas + motor.intl_del_ciclo + motor.cola);

// ── 2. Las cuotas que facturo el extracto anterior: cada una devenga desde su corte hasta que se paga ──
// La fecha de pago que usa el motor (la misma funcion que recibe la amortizacion).
let fechaPagoMotor = null;
const items = [];          // { tipo, etiqueta, origen, capital, tasa, esDiferida }
let terminoMotor = 0;      // lo que el motor carga HOY en el ciclo por la cuota facturada (filas + cola)
let noBMotorDif = [];      // interes del ciclo de cada plan SIN la cuota facturada ni el arrastre (para la variante de tasa)

db.prepare("SELECT * FROM diferidas WHERE tarjeta_id=? AND estado IN ('activo','liquidado')").all(T).forEach(d => {
  const opts = nuOptsDif(db, d);
  if (!opts || !opts.fechaPagoDe) return;
  if (!fechaPagoMotor) fechaPagoMotor = opts.fechaPagoDe(previo, cortePrevio);
  const abonos = db.prepare('SELECT * FROM abonos_diferida WHERE diferida_id=? ORDER BY fecha').all(d.id);
  const tabla = calcularAmortizacionDiferida(d.monto, d.tasa_mv, d.num_cuotas, d.fecha_compra, d.fecha_primer_corte, abonos, opts).tabla;
  const fPrev = tabla.find(r => r.fechaCorte.slice(0, 7) === previo);
  const fAhora = tabla.find(r => r.fechaCorte.slice(0, 7) === ciclo);
  // El origen (para la prelacion "deuda mas vieja primero") es la fecha de la COMPRA, no la del plan:
  // una hija de "Sellar y Renacer" nace el dia del corte pero su deuda es la de la compra original.
  const compra = db.prepare('SELECT fecha FROM compras WHERE diferida_id=? ORDER BY fecha LIMIT 1').get(d.id);
  const origen = compra ? compra.fecha : d.fecha_compra;
  if (fPrev) items.push({ tipo: 'cuota', etiqueta: d.etiqueta, origen, capital: fPrev.cuotaCapital, tasa: d.tasa_mv, esDiferida: true });
  // Cuota SELLADA por una reprogramacion: es una compra 1/1 en la app, pero para el banco es la cuota
  // del plan, y su interes hasta el pago lo cobra la cuota 1 de la hija (capital_facturado_previo).
  if (!fPrev && d.fecha_primer_corte && d.fecha_primer_corte.slice(0, 7) === ciclo && opts.capitalFacturadoPrevio > 0) {
    items.push({ tipo: 'cuota sellada', etiqueta: d.etiqueta, origen, capital: opts.capitalFacturadoPrevio, tasa: d.tasa_mv, esDiferida: true });
  }
  if (fAhora) {
    terminoMotor += fAhora.interesCuotaFacturada || 0;
    const arrastre = fAhora.numCuota === 1 ? (Number(opts.interesArrastrado) || 0) : 0;
    noBMotorDif.push({ etiqueta: d.etiqueta, tasa: d.tasa_mv, interes: r2(fAhora.interesTotal - (fAhora.interesCuotaFacturada || 0) - arrastre) });
  }
});

db.prepare("SELECT * FROM avances WHERE tarjeta_id=? AND estado IN ('activo','liquidado')").all(T).forEach(av => {
  const opts = avanceOpts(db, av.tarjeta_id);
  if (!opts || !opts.fechaPagoDe) return;
  if (!fechaPagoMotor) fechaPagoMotor = opts.fechaPagoDe(previo, cortePrevio);
  const abonos = db.prepare('SELECT * FROM abonos_avance WHERE avance_id=? ORDER BY fecha').all(av.id);
  const tabla = calcularAmortizacionAvance(av.monto, av.tasa_mv, av.plazo, av.fecha_desembolso, av.dia_corte, abonos, av.comision, opts).tabla;
  const fPrev = tabla.find(r => r.fechaCorte.slice(0, 7) === previo);
  const fAhora = tabla.find(r => r.fechaCorte.slice(0, 7) === ciclo);
  if (fPrev) items.push({ tipo: 'cuota avance', etiqueta: av.etiqueta, origen: av.fecha_desembolso, capital: fPrev.cuotaCapital, tasa: av.tasa_mv, esDiferida: false });
  if (fAhora) terminoMotor += fAhora.interesCuotaFacturada || 0;
});
terminoMotor = r2(terminoMotor + interesColaCuotasFinales(db, T, ciclo).total);

if (!fechaPagoMotor) { console.error('La tarjeta no usa el termino de la cuota facturada (no es Bancolombia): no hay nada que predecir.'); process.exit(1); }

const diasHasta = f => Math.max(0, Math.min(diasPeriodo, daysBetween(cortePrevio, f)));
const termino = (it, f) => it.capital * it.tasa * diasHasta(f) / 30;

// Chequeo de consistencia: con TODO pagado el dia que usa el motor, la suma de los items tiene que dar
// exactamente el termino que el motor ya carga. Si no cuadra, la lista de items esta mal y la
// prediccion no vale (falla ruidosa en vez de un numero bonito).
const terminoItems = r2(items.reduce((s, it) => s + termino(it, fechaPagoMotor), 0));
const consistencia = { termino_motor: terminoMotor, termino_items: terminoItems, diferencia: r2(terminoItems - terminoMotor), fecha_pago_motor: fechaPagoMotor };
if (Math.abs(consistencia.diferencia) > 1) {
  console.error('INCONSISTENCIA: los items no reproducen el termino del motor', consistencia);
  process.exit(1);
}

// ── 3. Lo que hay que pagar del extracto anterior y lo que ya entro ──────────────────────────────────
let interesPrevio = null, fuenteInteresPrevio = 'motor';
if (rutaConciliacion) {
  const j = JSON.parse(fs.readFileSync(rutaConciliacion, 'utf8'));
  const v = j && j.extracto && j.extracto.resumen && j.extracto.resumen.intereses;
  if (v > 0) { interesPrevio = v; fuenteInteresPrevio = 'extracto del banco'; }
}
if (interesPrevio == null) interesPrevio = r2(ePrevio.cuotasInteres);

// Compras 1/1 del ciclo anterior (sin las cuotas selladas: esas ya van como items).
const compras11 = db.prepare(`SELECT COALESCE(SUM(valor_cop),0) t FROM compras
  WHERE tarjeta_id=? AND ciclo=? AND estado <> 'diferida' AND COALESCE(anulada,0)=0
    AND COALESCE(notas,'') NOT LIKE '%sellada por reprogramacion%'`).get(T, previo).t;

const extPrevio = db.prepare('SELECT * FROM extractos WHERE tarjeta_id=? AND ciclo=?').get(T, previo);
const minimoPrevio = minimoEfectivo(db, T, previo, extPrevio ? extPrevio.pago_minimo : 0);
const eventos = db.prepare("SELECT fecha, monto, tipo FROM pagos WHERE tarjeta_id=? AND ciclo=? AND COALESCE(moneda,'COP')='COP' ORDER BY fecha, id").all(T, previo)
  .map(p => ({ fecha: String(p.fecha).slice(0, 10), monto: p.monto, origen: 'pago (' + p.tipo + ')' }));
// minimoEfectivo YA descuenta los creditos de reverso imputados a ese ciclo; para el banco son dinero que
// entro un dia concreto, asi que aqui van como evento y el minimo se mira sin ellos.
const creditos = db.prepare("SELECT fecha, monto FROM creditos_reverso WHERE tarjeta_id=? AND ciclo_destino=? AND estado='aplicado' ORDER BY fecha").all(T, previo);
creditos.forEach(c => eventos.push({ fecha: String(c.fecha).slice(0, 10), monto: c.monto, origen: 'credito de reverso' }));
eventos.sort((a, b) => a.fecha.localeCompare(b.fecha));
const minimoBruto = minimoPrevio + creditos.reduce((s, c) => s + c.monto, 0);
const entrado = eventos.reduce((s, e) => s + e.monto, 0);
const resto = r2(Math.max(0, minimoBruto - entrado));
const fechaLimite = (db.prepare('SELECT fecha_pago FROM fechas_pago_custom WHERE tarjeta_id=? AND ciclo=?').get(T, previo) || {}).fecha_pago || ePrevio.fechaPago;
const sellado = !!(extPrevio && extPrevio.estado === 'pagado');

// ── 4. Reparto de los pagos y termino de la cuota facturada bajo cada hipotesis ──────────────────────
// Recorre los eventos en orden; cada peso cubre primero el interes, despues los "baldes" en el orden de
// la hipotesis. El capital de cada item devenga hasta el dia en que se cubre; lo que ningun evento
// cubre devenga hasta el periodo completo.
function terminoReparto(evs, ordenBaldes) {
  const baldes = ordenBaldes.map(b => Object.assign({ falta: b.capital }, b));
  let interesPend = interesPrevio;
  let total = 0;
  const porItem = new Map();
  for (const ev of evs) {
    let plata = ev.monto;
    const cubreInt = Math.min(plata, interesPend); interesPend -= cubreInt; plata -= cubreInt;
    for (const b of baldes) {
      if (plata <= 0) break;
      if (b.falta <= 0) continue;
      const cubre = Math.min(plata, b.falta);
      b.falta -= cubre; plata -= cubre;
      if (b.item) { const t = b.item.capital > 0 ? cubre * b.item.tasa * diasHasta(ev.fecha) / 30 : 0; total += t; porItem.set(b.item, (porItem.get(b.item) || 0) + t); }
    }
  }
  for (const b of baldes) if (b.item && b.falta > 0) {
    const t = b.falta * b.item.tasa * diasPeriodo / 30; total += t; porItem.set(b.item, (porItem.get(b.item) || 0) + t);
  }
  return { total, porItem };
}
const cuotasMasViejas = items.slice().sort((a, b) => String(a.origen).localeCompare(String(b.origen)))
  .map(it => ({ capital: it.capital, item: it }));
const balde11 = { capital: compras11, item: null };
const ORDEN = { H2: [...cuotasMasViejas, balde11], H3: [balde11, ...cuotasMasViejas] };

// Variante de tasa: cada plan a min(origen, vigente). Escala el interes del ciclo de cada diferida (sin
// el arrastre, que es un monto del pasado) y su parte del termino de la cuota facturada.
const vigente = Number(tj.tasa_mv_diferidas) || 0;
const factor = it => (it.esDiferida && vigente > 0 && it.tasa > vigente) ? vigente / it.tasa : 1;
const ajusteTasaNoB = r2(noBMotorDif.reduce((s, p) => s + ((vigente > 0 && p.tasa > vigente) ? p.interes * (1 - vigente / p.tasa) : 0), 0));

// El intl 1/1: el banco cobra en ESTE ciclo el de las compras del ciclo anterior (y el de las compras
// de este ciclo, que la app ya suma aqui, lo cobra el mes que viene).
const intlPrevioBanco = sellado && extPrevio.intereses_intl != null ? extPrevio.intereses_intl : calcExtracto(db, T, previo, false).interesesComprasIntl;
const base = r2(motor.total - terminoMotor - motor.intl_del_ciclo + intlPrevioBanco);

const fechasResto = [];
if (resto > 0 && !sellado) {
  const ultimo = eventos.length ? eventos[eventos.length - 1].fecha : cortePrevio;
  for (let f = addDays(ultimo, 1); f <= fechaLimite; f = addDays(f, 1)) fechasResto.push(f);
}
const escenarios = (fechasResto.length ? fechasResto : [null]).map(fResto => {
  const evs = eventos.slice();
  if (fResto) evs.push({ fecha: fResto, monto: resto, origen: 'resto del minimo' });
  // H1: todo el capital facturado devenga hasta el pago que COMPLETA el minimo (lo que hace el motor).
  const fFinal = fResto || (sellado ? String(extPrevio.fecha_pagado).slice(0, 10) : fechaLimite);
  const h1Items = new Map(items.map(it => [it, termino(it, fFinal)]));
  const h1 = [...h1Items.values()].reduce((s, v) => s + v, 0);
  const h2 = terminoReparto(evs, ORDEN.H2), h3 = terminoReparto(evs, ORDEN.H3);
  const conTasaMin = porItem => [...porItem.entries()].reduce((s, [it, v]) => s + v * factor(it), 0);
  return {
    pago_del_resto: fResto,
    H1: Math.round(base + h1), H2: Math.round(base + h2.total), H3: Math.round(base + h3.total),
    H1_tasa_min: Math.round(base - ajusteTasaNoB + conTasaMin(h1Items)),
    H2_tasa_min: Math.round(base - ajusteTasaNoB + conTasaMin(h2.porItem)),
    H3_tasa_min: Math.round(base - ajusteTasaNoB + conTasaMin(h3.porItem)),
  };
});

const salida = {
  generado: new Date().toISOString(),
  tarjeta: nombreTarjeta, ciclo, ciclo_facturado: previo, corte_facturado: cortePrevio, corte, dias_periodo: diasPeriodo,
  motor_hoy: motor,
  consistencia,
  base_sin_termino: { valor: base, intl_del_ciclo_que_cobra_el_banco: intlPrevioBanco, intl_del_ciclo_segun_la_app: motor.intl_del_ciclo },
  extracto_facturado: { minimo_efectivo: minimoPrevio, minimo_con_creditos: minimoBruto, interes: interesPrevio, fuente_interes: fuenteInteresPrevio,
    compras_1_1: compras11, sellado, fecha_limite: fechaLimite, eventos, resto },
  tasa_vigente: vigente, ajuste_tasa_min_sin_termino: ajusteTasaNoB,
  items: items.map(it => ({ tipo: it.tipo, etiqueta: it.etiqueta, origen: it.origen, capital: r2(it.capital), tasa: it.tasa })),
  escenarios,
};

const destino = path.join(ROOT, 'docs', 'temp', 'prediccion_interes_' + ciclo + '.json');
fs.mkdirSync(path.dirname(destino), { recursive: true });
const texto = JSON.stringify(salida, null, 2) + '\n';
fs.writeFileSync(destino, texto, 'utf8');
const sha = crypto.createHash('sha256').update(texto, 'utf8').digest('hex');

console.log('Prediccion del cargo INTERESES CORRIENTES de ' + ciclo + ' (' + nombreTarjeta + ')');
console.log('  motor hoy (lo que proyecta la app): ' + motor.total + '  |  termino de la cuota facturada: ' + terminoMotor + ' (items ' + terminoItems + ', pago ' + fechaPagoMotor + ')');
console.log('  extracto ' + previo + ': minimo ' + minimoPrevio + ', entrado ' + r2(entrado) + ' en ' + eventos.length + ' evento(s), resto ' + resto + ' hasta ' + fechaLimite);
console.log('  pago del resto |       H1       H2       H3 | H1 t.min  H2 t.min  H3 t.min');
escenarios.forEach(e => console.log('  ' + String(e.pago_del_resto || '(sellado)').padEnd(14) + ' | ' +
  [e.H1, e.H2, e.H3].map(v => String(v).padStart(8)).join(' ') + ' | ' + [e.H1_tasa_min, e.H2_tasa_min, e.H3_tasa_min].map(v => String(v).padStart(8)).join('  ')));
console.log('  -> ' + path.relative(ROOT, destino));
console.log('  SHA-256 ' + sha);
