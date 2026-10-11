// backend/services/movimientos.js
// Arma el JSON de movimientos de un ciclo para que la IA lo contraste con el extracto.
// Reutiliza calcExtracto (único punto de verdad) y resuelve el doc de reglas del banco.
const path = require('path');
const fs = require('fs');
const { calcExtracto } = require('../engine/extracto');
const { calcularAmortizacionDiferida, calcularAmortizacionAvance } = require('../engine/amortizacion');
const { interesColaCuotasFinales } = require('../engine/colaCuotaFacturada');
const { nuOptsDif, avanceOpts } = require('../helpers/banco');

// Mapea banco + franquicia (texto libre en la BD) al archivo docs/bancos/{Banco}_{Franquicia}.md
// Archivos existentes: Bancolombia_{Visa,Mastercard,Amex}, Nu_Mastercard, RappiCard_Visa.
function resolveBancoDoc(banco, franquicia) {
  const b = String(banco || '').toLowerCase();
  const f = String(franquicia || '').toLowerCase();
  if (b.includes('bancolombia')) {
    if (f.includes('visa')) return 'Bancolombia_Visa';
    if (f.includes('master')) return 'Bancolombia_Mastercard';
    if (f.includes('amex') || f.includes('american')) return 'Bancolombia_Amex';
    return null;
  }
  if (b.includes('nu')) return 'Nu_Mastercard';
  if (b.includes('rappi') || b.includes('davivienda')) return 'RappiCard_Visa';
  return null;
}

function docPathDe(nombre) {
  if (!nombre) return null;
  return path.join(__dirname, '..', '..', 'docs', 'bancos', nombre + '.md');
}

const r2 = (n) => Math.round(n * 100) / 100;
const cicloAnterior = (c) => {
  const [y, m] = String(c).split('-').map(Number);
  return m === 1 ? (y - 1) + '-12' : y + '-' + String(m - 1).padStart(2, '0');
};

// Lo que la app cobra de INTERES en el ciclo, separado por causa. El banco imprime todo su interes como
// UNA linea ("INTERESES CORRIENTES") y no lo desglosa jamas; la app si sabe de donde sale cada peso, y
// sin este bloque la IA solo veia un "interes" por cuota y atribuia cualquier diferencia a un cajon de
// sastre ("revolving") que en la conciliacion de septiembre de 2026 escondio tres causas reales. Repite
// las mismas amortizaciones que calcExtracto -mismas consultas, mismos opts- y por eso su total cuadra
// al peso con el interes que la app suma al pago minimo (lo comprueba R13).
function desgloseIntereses(db, tarjetaId, ciclo, calc) {
  const T = Number(tarjetaId);
  const comp = { periodo: 0, cuota_facturada_hasta_pago: 0, interes_cuota1_diferido: 0, arrastre_reprogramacion: 0, cola_ultima_cuota: 0 };
  const planes = [];
  let aplazadoACuota2 = 0;

  db.prepare("SELECT * FROM diferidas WHERE tarjeta_id=? AND estado='activo'").all(T).forEach(d => {
    const opts = nuOptsDif(db, d);
    const abonos = db.prepare('SELECT * FROM abonos_diferida WHERE diferida_id=? ORDER BY fecha').all(d.id);
    const tabla = calcularAmortizacionDiferida(d.monto, d.tasa_mv, d.num_cuotas, d.fecha_compra, d.fecha_primer_corte, abonos, opts).tabla;
    const f = tabla.find(r => r.fechaCorte.slice(0, 7) === ciclo);
    if (!f) return;
    const gracia = !!(opts && opts.esBancolombia);   // Bancolombia: la cuota 1 difiere su interes a la 2
    const arrastre = (f.numCuota === 1 && opts && Number(opts.interesArrastrado) > 0) ? Number(opts.interesArrastrado) : 0;
    let periodo = 0, cuotaFact = 0, diferido1 = 0;
    if (gracia && f.numCuota === 1) {
      aplazadoACuota2 += f.interesPeriodo;           // se cobra el mes que viene, no este
    } else {
      cuotaFact = f.interesCuotaFacturada || 0;
      periodo = f.interesPeriodo - cuotaFact;
      if (gracia && f.numCuota === 2) diferido1 = f.interesTotal - f.interesPeriodo;
    }
    comp.periodo += periodo; comp.cuota_facturada_hasta_pago += cuotaFact;
    comp.interes_cuota1_diferido += diferido1; comp.arrastre_reprogramacion += arrastre;
    // Numeracion del banco: en una hija de "Sellar y Renacer" las cuotas selladas cuentan (reprog_total).
    const selladas = d.reprog_total ? Math.max(0, d.reprog_total - d.num_cuotas) : 0;
    const plan = {
      tipo: 'diferida', etiqueta: d.etiqueta, fecha: d.fecha_compra,
      cuota: (f.numCuota + selladas) + '/' + (d.reprog_total || d.num_cuotas),
      capital: r2(f.cuotaCapital), tasa_mv: d.tasa_mv,
      interes: { periodo: r2(periodo), cuota_facturada_hasta_pago: r2(cuotaFact), cuota1_diferido: r2(diferido1), arrastre: r2(arrastre), total: r2(f.interesTotal) },
    };
    // Calendario IRREGULAR del banco (reprogramaciones): se manda tal cual, para que la IA describa el
    // plan desde el dato ("4.950 / 4.675") y no desde un supuesto ("dos cuotas iguales").
    if (opts && opts.capitalPorCuota) plan.calendario_capital = tabla.map(r => r2(r.cuotaCapital));
    planes.push(plan);
  });

  db.prepare("SELECT * FROM avances WHERE tarjeta_id=? AND estado='activo'").all(T).forEach(av => {
    const abonos = db.prepare('SELECT * FROM abonos_avance WHERE avance_id=? ORDER BY fecha').all(av.id);
    const tabla = calcularAmortizacionAvance(av.monto, av.tasa_mv, av.plazo, av.fecha_desembolso, av.dia_corte, abonos, av.comision, avanceOpts(db, av.tarjeta_id)).tabla;
    const f = tabla.find(r => r.fechaCorte.slice(0, 7) === ciclo);
    if (!f) return;
    const cuotaFact = f.interesCuotaFacturada || 0;
    comp.periodo += f.interes - cuotaFact; comp.cuota_facturada_hasta_pago += cuotaFact;
    planes.push({ tipo: 'avance', etiqueta: av.etiqueta, fecha: av.fecha_desembolso, cuota: f.numCuota + '/' + av.plazo,
      capital: r2(f.cuotaCapital), tasa_mv: av.tasa_mv,
      interes: { periodo: r2(f.interes - cuotaFact), cuota_facturada_hasta_pago: r2(cuotaFact), total: r2(f.interes) } });
  });

  const cola = interesColaCuotasFinales(db, T, ciclo);
  comp.cola_ultima_cuota = cola.total;
  const intlCiclo = calc ? (calc.interesesComprasIntl || 0) : 0;

  // El intl de las compras 1/1 del ciclo ANTERIOR: el banco puede cobrarlo en este (docs/bancos/
  // Bancolombia_Visa.md §4.4). Sin medir al peso; se manda para acotar ese desfase, no para restarlo.
  const previo = cicloAnterior(ciclo);
  const extPrevio = db.prepare('SELECT estado, fecha_pagado, intereses_intl FROM extractos WHERE tarjeta_id=? AND ciclo=?').get(T, previo);
  let intlPrevio = 0;
  if (extPrevio && extPrevio.estado === 'pagado' && extPrevio.intereses_intl != null) intlPrevio = extPrevio.intereses_intl;
  else { try { const cp = calcExtracto(db, T, previo, false); intlPrevio = cp ? (cp.interesesComprasIntl || 0) : 0; } catch (e) { intlPrevio = 0; } }

  // Hasta que dia supone la app que devengo la cuota facturada del extracto anterior, y de donde sale.
  let fechaPago = null, origen = null;
  const opts = avanceOpts(db, T);
  if (opts && opts.fechaPagoDe) {
    const ePrev = calcExtracto(db, T, previo, true);
    fechaPago = opts.fechaPagoDe(previo, ePrev ? ePrev.fechaCorte : null);
    const custom = db.prepare('SELECT fecha_pago FROM fechas_pago_custom WHERE tarjeta_id=? AND ciclo=?').get(T, previo);
    origen = (extPrevio && extPrevio.estado === 'pagado' && extPrevio.fecha_pagado) ? 'dia real del pago del extracto anterior'
      : custom ? 'fecha limite del extracto anterior (el pago aun no se registra)' : 'fecha limite proyectada (el pago aun no se registra)';
  }
  const pagosPrevio = db.prepare("SELECT fecha, monto FROM pagos WHERE tarjeta_id=? AND ciclo=? AND COALESCE(moneda,'COP')='COP' ORDER BY fecha").all(T, previo)
    .map(p => ({ fecha: String(p.fecha).slice(0, 10), monto: r2(p.monto) }));

  Object.keys(comp).forEach(k => { comp[k] = r2(comp[k]); });
  const total = Math.round(comp.periodo + comp.cuota_facturada_hasta_pago + comp.interes_cuota1_diferido
    + comp.arrastre_reprogramacion + comp.cola_ultima_cuota + intlCiclo);
  return {
    que_es: 'El interes que la app suma al pago minimo de este ciclo, separado por causa. Es el numero que se compara con el cargo INTERESES CORRIENTES del extracto.',
    componentes: Object.assign({}, comp, { intl_compras_1_1: r2(intlCiclo) }),
    total_app: total,
    intl_desfase: { de_este_ciclo_segun_app: r2(intlCiclo), del_ciclo_anterior: r2(intlPrevio),
      nota: 'La app cobra el interes intl de una compra 1/1 en su mismo ciclo; el banco puede cobrarlo en el siguiente. Una diferencia de ese tamano puede ser solo ese desfase.' },
    aplazado_a_la_cuota_2: r2(aplazadoACuota2),
    cuota_facturada: fechaPago ? { devenga_hasta: fechaPago, segun: origen, abonos_al_extracto_anterior: pagosPrevio } : null,
    planes,
  };
}

// Devuelve el objeto de movimientos del ciclo (sin tocar la BD).
function construirMovimientos(db, tarjetaId, ciclo) {
  const tj = db.prepare('SELECT * FROM tarjetas WHERE id=?').get(tarjetaId);
  if (!tj) return { error: 'Tarjeta no encontrada' };

  const calc = calcExtracto(db, tarjetaId, ciclo, false);
  const docNombre = resolveBancoDoc(tj.banco, tj.franquicia);
  const dPath = docPathDe(docNombre);
  const docExiste = dPath ? fs.existsSync(dPath) : false;
  let desglose = null;
  try { desglose = desgloseIntereses(db, tarjetaId, ciclo, calc); }
  catch (e) { console.log('[movimientos] desglose de intereses:', e && e.message); }

  return {
    tarjeta: {
      id: tj.id, nombre: tj.nombre, banco: tj.banco, franquicia: tj.franquicia || null,
      dia_corte: tj.dia_corte, dia_pago: tj.dia_pago
    },
    ciclo,
    fecha_corte: calc ? calc.fechaCorte : null,
    fecha_pago: calc ? calc.fechaPago : null,
    pago_minimo_app: calc ? calc.pagoMinimo : null,
    pago_total_app: calc ? calc.pagoTotal : null,
    intereses_intl: calc ? calc.interesesComprasIntl : 0,
    intereses_app: calc ? calc.cuotasInteres : 0,
    desglose_intereses: desglose,
    dual: calc ? !!calc.dualExtracto : false,
    compras: calc ? calc.detalleCompras : [],
    diferidas: calc ? calc.detalleDiferidas : [],
    avances: calc ? calc.detalleAvances : [],
    compras_usd: calc ? calc.detalleComprasUsd : [],
    pago_minimo_usd: calc ? calc.pagoMinimoUsd : 0,
    banco_doc: docNombre,
    banco_doc_existe: docExiste
  };
}

// Lee el contenido del .md de reglas del banco (para la Fase 3 / análisis). Puede ser null.
function leerBancoDoc(nombre) {
  const dPath = docPathDe(nombre);
  if (!dPath || !fs.existsSync(dPath)) return null;
  try { return fs.readFileSync(dPath, 'utf8'); } catch (_) { return null; }
}

// Secciones de docs/bancos/*.md que NO son reglas sino material de consulta: contrastes con otras
// franquicias, curiosidades, la validacion del motor y los apendices de datos crudos.
const SECCION_DE_CONSULTA = /^##\s+\d+\.\s+(Diferencias clave|Curiosidades|Contraste|Validaci[oó]n|Ap[eé]ndice)/i;

// Lo que del documento del banco llega al prompt. Hasta oct-2026 se cortaba a ciegas en 16.000
// caracteres y la IA nunca habia leido la mitad de las reglas de la Visa (la cuota facturada hasta el
// pago, la formula del pago minimo, la fecha limite) ni el 61% de las de RappiCard. Ahora va COMPLETO
// salvo las secciones de consulta, y las que se omiten se nombran: nunca se recorta en silencio.
function reglasParaPrompt(doc) {
  if (!doc) return { texto: '', omitidas: [] };
  const out = [], omitidas = [];
  let saltando = false;
  String(doc).split(/\r?\n/).forEach(l => {
    if (/^##\s/.test(l)) {
      saltando = SECCION_DE_CONSULTA.test(l);
      if (saltando) omitidas.push(l.replace(/^##\s+/, '').trim());
    }
    if (!saltando) out.push(l);
  });
  return { texto: out.join('\n').trim(), omitidas };
}

module.exports = { construirMovimientos, resolveBancoDoc, leerBancoDoc, reglasParaPrompt, desgloseIntereses };
