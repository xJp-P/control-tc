// backend/routes/ia/_detectores.js
//
// Los dos detectores DETERMINISTAS de la conciliacion, movidos VERBATIM desde ia.js. Son
// funciones puras de modulo (no dependen del router ni del ctx): reciben la conexion, el texto
// del extracto y la tarjeta, y devuelven discrepancias. El factory de ia.js las vuelve a colgar
// de module.exports porque son los unicos exports del backend pensados para pruebas.
const { parseMontoCol, dice, normalizarDesc } = require('../../services/extracto/motorCruce');
const { calcExtracto } = require('../../engine/extracto');
const { addMonths } = require('../../helpers/dates');

// ── Detección determinista de REVERSOS (devoluciones/refunds) ──────────────────
// Un reverso aparece en el extracto como un movimiento de valor NEGATIVO cuyo concepto es un
// COMERCIO (no "ABONO"/"PAGO"), con el nombre ACORTADO por el banco (ej. "LATAM AIR" por
// "LATAM AIRLINES COLOM"). Se cruza contra el HISTORIAL de la tarjeta por monto (valor absoluto,
// ±$2) + descripción difusa (Dice ≥ 0.4). Devuelve discrepancias tipo 'reverso_detectado' con
// accion_sugerida.operacion='reversar_compra' (o 'ninguna' + ya_aplicado si la compra ya está
// reversada -> idempotencia). Alcance v1: compras de 1 cuota en COP (las que el endpoint reversa).
function detectarReversos(db, texto, tarjetaId) {
  if (!texto || !tarjetaId) return [];
  const fmt = (n) => '$' + Math.round(n).toLocaleString('es-CO');
  const esPago = (c) => /\b(ABONO|PAGO|SU PAGO|SALDO A FAVOR|A FAVOR|NU\b)/i.test(c);
  // Líneas con valor NEGATIVO en pesos: [auth] DD/MM/YYYY  CONCEPTO  $ -NNN.NNN,NN
  const reNeg = /(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(.+?)\s+\$\s*-\s*([\d][\d.]*(?:,\d{1,2})?)/;
  const candidatos = [];
  String(texto).split(/\r?\n/).forEach(raw => {
    const linea = raw.trim();
    const m = linea.match(reNeg);
    if (!m) return;
    const concepto = m[2].replace(/\s{2,}/g, ' ').trim();
    if (!concepto || concepto.length < 3 || esPago(concepto)) return;
    if (!/[A-Za-zÁÉÍÓÚÑ]{3,}/.test(concepto)) return; // debe tener texto de comercio, no solo números
    const monto = parseMontoCol(m[3]);
    if (!(monto > 0)) return;
    candidatos.push({ concepto, monto });
  });
  if (!candidatos.length) return [];
  // Historial de compras EJECUTABLES por el endpoint de reverso (1 cuota, COP, sin grupo/diferida).
  const compras = db.prepare(
    "SELECT id, descripcion, valor_cop, fecha, ciclo, persona_id, COALESCE(monto_bolsillo,0) AS monto_bolsillo, COALESCE(reversada,0) AS reversada " +
    "FROM compras WHERE tarjeta_id=? AND grupo_id IS NULL AND diferida_id IS NULL AND estado != 'diferida' AND COALESCE(valor_cop,0) > 0"
  ).all(tarjetaId);
  const usados = {}, out = [];
  candidatos.forEach(cand => {
    let best = null;
    compras.forEach(c => {
      if (usados[c.id]) return;
      if (Math.abs(Math.round(c.valor_cop) - Math.round(cand.monto)) > 2) return;   // monto exacto (±$2)
      const score = dice(normalizarDesc(cand.concepto), normalizarDesc(c.descripcion)); // difuso: banco acorta
      if (score < 0.4) return;
      if (!best || score > best.score) best = { c, score };
    });
    if (!best) return;
    usados[best.c.id] = 1;
    const c = best.c;
    const esTercero = c.persona_id != null;
    out.push({
      tipo: 'reverso_detectado',
      descripcion: 'El banco reversó "' + cand.concepto + '" por ' + fmt(cand.monto) + '. Coincide con la compra #' + c.id + ' "' + c.descripcion + '"' + (esTercero ? ' (de un tercero que ya reembolsó)' : '') + '.',
      valor_extracto: -Math.round(cand.monto),
      valor_app: Math.round(c.valor_cop),
      compra_id: c.id,
      severidad: 'alta',
      ya_aplicado: !!c.reversada,
      reverso: {
        concepto_extracto: cand.concepto, monto: Math.round(cand.monto),
        compra_descripcion: c.descripcion, es_tercero: esTercero,
        reembolso: esTercero ? Math.round(c.monto_bolsillo) : 0, score: Math.round(best.score * 100) / 100
      },
      accion_sugerida: c.reversada
        ? { operacion: 'ninguna', parametros: {} }
        : { operacion: 'reversar_compra', parametros: { compra_id: c.id } }
    });
  });
  return out;
}

// ── Detección determinista de PAGOS-DE-FACTURA omitidos ────────────────────────
// Un "ABONO SUCURSAL VIRTUAL" (negativo) suele ser el pago que saldó el extracto ANTERIOR (regla 1).
// Este detector reconoce esas líneas (mismo parser que reversos, pero quedándose con los conceptos de
// PAGO/ABONO en vez de excluirlos) y las clasifica de forma DETERMINISTA: si el monto de una línea —o
// la suma de varias líneas fraccionadas— cuadra (~1%) con el pago mínimo o el pago total que la app
// calcula para el ciclo anterior, es un PAGO-DE-FACTURA; si ese extracto aún NO está registrado en la
// app, propone la acción registrar_pago (marca ese ciclo como pagado vía POST /extractos/registrar-pago).
// La tolerancia es ~1% (no ±$2) porque el mínimo/total que calcula la app diverge del real del banco por
// el interés revolvente no modelado (ver "Limitaciones Conocidas"): 1% cubre esa divergencia (~0,7%
// observada) y aún separa limpiamente un abono-a-capital, que es un orden de magnitud menor. Los pagos
// que NO cuadran (abonos a capital, remanentes, parciales) NO se auto-registran: quedan informativos en
// "pagos_detectados" por la ambigüedad de "liquidación dirigida" (documentada). Alcance v1: COP.
// `lineasBanco` (OPCIONAL) son los movimientos negativos que la estrategia del banco ya aplanó, con la
// fecha normalizada a ISO — hoy solo RappiCard, vía estrategia.parsearNegativos. Sin ese argumento el
// detector parsea el texto crudo, que es lo que siempre hizo (Bancolombia y el resto, sin cambio).
// Hacía falta porque `reNeg` exige la fecha en DD/MM/YYYY y RappiCard la imprime en ISO: ahí la regex
// no casaba NUNCA y los pagos de esa tarjeta no tenían cruce determinista.
function detectarPagosOmitidos(db, texto, tarjetaId, ciclo, lineasBanco) {
  if (!texto || !tarjetaId || !ciclo) return [];
  const fmt = (n) => '$' + Math.round(n).toLocaleString('es-CO');
  // Conceptos de PAGO/ABONO (subconjunto del esPago de reversos, SIN "NU"): las líneas que toma este
  // detector son justo las que reversos excluye → ninguna línea la procesan ambos.
  // PLURALES: el `\b` de cierre hacía que "\bPAGO\b" NO matcheara "PAGOS RAPPIPAY APP" (el concepto real
  // de RappiCard/Davivienda), así que esa línea se caía de los DOS detectores y rompía el invariante de
  // arriba (el de reversos sí la matchea: su regex no lleva `\b` final, así que casa por prefijo).
  const esPago = (c) => /\b(ABONOS?|PAGOS?|SU PAGO|SALDO A FAVOR|A FAVOR)\b/i.test(c);
  const reNeg = /(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(.+?)\s+\$\s*-\s*([\d][\d.]*(?:,\d{1,2})?)/;
  const aISO = (s) => { const m = String(s).match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); if (!m) return null; let y = m[3]; if (y.length === 2) y = '20' + y; return y + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0'); };
  const lineas = [];
  if (Array.isArray(lineasBanco) && lineasBanco.length) {
    // Se aplica el MISMO filtro esPago que a las líneas crudas: es lo que sostiene el reparto con
    // detectarReversos (cada línea la procesa uno solo de los dos). Un reverso de comercio que llegue
    // por aquí no lleva ABONO/PAGO en el concepto y queda fuera, igual que en la rama cruda.
    lineasBanco.forEach(l => {
      const concepto = String((l && l.concepto) || '').replace(/\s{2,}/g, ' ').trim();
      const monto = Math.round(Number(l && l.monto) || 0);
      if (!concepto || !esPago(concepto) || !(monto > 0)) return;
      lineas.push({ concepto, monto, fecha: (l && l.fecha) || null });
    });
  } else {
    String(texto).split(/\r?\n/).forEach(raw => {
      const linea = raw.trim();
      const m = linea.match(reNeg);
      if (!m) return;
      const concepto = m[2].replace(/\s{2,}/g, ' ').trim();
      if (!concepto || !esPago(concepto)) return;
      const monto = parseMontoCol(m[3]);
      if (!(monto > 0)) return;
      lineas.push({ concepto, monto: Math.round(monto), fecha: aISO(m[1]) });
    });
  }
  if (!lineas.length) return [];

  // Ciclo anterior: el pago del extracto se aplica al mes previo (regla 1).
  const cicloPrev = addMonths(ciclo + '-01', -1).slice(0, 7);
  const extPrev = db.prepare('SELECT id, estado, COALESCE(monto_pagado,0) mp FROM extractos WHERE tarjeta_id=? AND ciclo=?').get(tarjetaId, cicloPrev);
  // Si el extracto anterior ya está pagado o tiene algún abono registrado, el pago YA está reflejado en
  // la app → nada que proponer (evita duplicar el pago del usuario). Belt-and-suspenders con el endpoint.
  if (extPrev && (extPrev.estado === 'pagado' || extPrev.mp > 0)) return [];
  const pagosReg = db.prepare("SELECT 1 FROM pagos WHERE tarjeta_id=? AND ciclo=? AND tipo='abono_extracto' AND (moneda='COP' OR moneda IS NULL) LIMIT 1").get(tarjetaId, cicloPrev);
  if (pagosReg) return []; // ya hay un pago de factura registrado para ese ciclo

  let pmPrev = 0, ptPrev = 0;
  try { const calc = calcExtracto(db, tarjetaId, cicloPrev, false); if (calc) { pmPrev = Math.round(calc.pagoMinimo || 0); ptPrev = Math.round(calc.pagoTotal || 0); } } catch (e) { return []; }
  if (!(pmPrev > 0) && !(ptPrev > 0)) return [];

  const cuadra = (monto, ancla) => ancla > 0 && Math.abs(monto - ancla) <= Math.max(5, Math.round(ancla * 0.01));
  const clasif = (monto) => cuadra(monto, ptPrev) ? 'total' : (cuadra(monto, pmPrev) ? 'minimo' : null);
  const mkDisc = (monto, fecha, tipoPago, descripcion) => ({
    tipo: 'pago_omitido',
    descripcion,
    severidad: 'media',
    pago: { ciclo: cicloPrev, monto, tipo_pago: tipoPago, fecha: fecha || null },
    accion_sugerida: { operacion: 'registrar_pago', parametros: { tarjeta_id: tarjetaId, ciclo: cicloPrev, monto, fecha: fecha || null, moneda: 'COP' } }
  });
  const txt = (monto, tipoPago, concepto) => 'El extracto muestra un pago de ' + fmt(monto) + ' ("' + concepto + '") que salda el extracto del ciclo ' + cicloPrev + ' (' + (tipoPago === 'total' ? 'pago total' : 'pago minimo') + '). La app aun no lo tiene registrado.';

  // Caso 1: una línea individual cuadra con el mínimo o el total.
  const matched = lineas.map(l => ({ l, tp: clasif(l.monto) })).filter(x => x.tp);
  if (matched.length) {
    return matched.map(x => mkDisc(x.l.monto, x.l.fecha, x.tp, txt(x.l.monto, x.tp, x.l.concepto)));
  }
  // Caso 2: pago fraccionado — ninguna línea cuadra sola, pero la SUMA sí (ej. mínimo pagado en varios abonos).
  if (lineas.length >= 2) {
    const suma = lineas.reduce((s, l) => s + l.monto, 0);
    const tp = clasif(suma);
    if (tp) {
      const fecha = lineas[lineas.length - 1].fecha;
      return [mkDisc(suma, fecha, tp, 'El extracto muestra ' + lineas.length + ' abonos que suman ' + fmt(suma) + ' y saldan el extracto del ciclo ' + cicloPrev + ' (' + (tp === 'total' ? 'pago total' : 'pago minimo') + '). La app aun no lo tiene registrado.')];
    }
  }
  return [];
}

module.exports = { detectarReversos, detectarPagosOmitidos };
