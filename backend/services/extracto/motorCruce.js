// backend/services/extracto/motorCruce.js
// Motor GENÉRICO de cruce determinista compra(app) <-> línea(extracto). NO depende de ningún
// banco: recibe una ESTRATEGIA que sabe parsear las líneas del layout de su banco, y aquí se hace
// el emparejamiento por Monto (±tol) AND Fecha (±1 día) AND Descripción (Dice ≥ umbral), con pool.
//
// Piezas reutilizables (comunes a los extractos colombianos), antes en services/matcher.js:
//   - parseMontoCol: formato numérico colombiano ("43.440,78" -> 43440.78).
//   - normalizarDesc + dice: similitud de descripción robusta a orden/typos.
//   - fechaCercana: comparación de fecha con tolerancia (desfase de corte ±1 día).
//   - parsearTabular: parser de layout TABULAR parametrizable (lo usan las estrategias tabulares).
//   - cruzar: el algoritmo de pool greedy (asignación 1:1).

// Parsea un monto en formato colombiano a número. "43.440,78" -> 43440.78 ; "44.900" -> 44900.
function parseMontoCol(s) {
  let t = String(s).replace(/[$\s]/g, '');
  if (t.indexOf(',') >= 0) t = t.replace(/\./g, '').replace(',', '.'); // coma = decimal, puntos = miles
  else t = t.replace(/\./g, '');                                       // sin coma: puntos = miles
  const v = parseFloat(t);
  return isNaN(v) ? null : v;
}

// Normaliza una descripción para comparar: MAYÚSCULAS, sin acentos, solo alfanumérico + espacios.
function normalizarDesc(s) {
  return String(s || '')
    .toUpperCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Z0-9]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// Bigramas de caracteres (sin espacios) y coeficiente de Dice (0..1). Robusto a orden y typos.
function bigramas(s) { const o = []; const t = String(s).replace(/\s/g, ''); for (let i = 0; i < t.length - 1; i++) o.push(t.slice(i, i + 2)); return o; }
function dice(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const A = bigramas(a), B = bigramas(b);
  if (!A.length || !B.length) return 0;
  const cnt = {};
  B.forEach(x => { cnt[x] = (cnt[x] || 0) + 1; });
  let inter = 0;
  A.forEach(x => { if (cnt[x] > 0) { inter++; cnt[x]--; } });
  return (2 * inter) / (A.length + B.length);
}

// ¿La fecha dia/mes del extracto cae a ±tolDias de la fecha (YYYY-MM-DD) de la compra de la app?
function fechaCercana(dia, mes, fechaBD, tolDias) {
  if (!fechaBD) return false;
  const d = new Date(String(fechaBD).slice(0, 10) + 'T00:00:00');
  if (isNaN(d.getTime())) return false;
  const ref = new Date(d.getFullYear(), mes - 1, dia);
  const diff = Math.abs(ref.getTime() - d.getTime()) / 86400000;
  return diff <= tolDias + 0.001;
}

// Extractor de fecha por DEFECTO: DD/MM (o DD-MM) con año opcional, en cualquier parte de la línea.
// Las estrategias con otro formato (ej. "19 SEP" de Davivienda) pasan su propio opts.parsearFecha.
function parsearFechaDDMM(linea) {
  const m = String(linea).match(/\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-]\d{2,4})?\b/);
  if (!m) return null;
  const dia = parseInt(m[1], 10), mes = parseInt(m[2], 10);
  if (!(dia >= 1 && dia <= 31 && mes >= 1 && mes <= 12)) return null;
  return { dia, mes, raw: m[0] };
}

// Parser de layout TABULAR genérico y parametrizable. Lo usan las estrategias cuyos extractos
// tienen forma "una línea = [fecha] descripción + monto + cuotas + tasa" (Bancolombia, RappiCard...).
//   opts.limpiezaExtra: regex ESPECÍFICAS del banco a quitar ANTES de extraer monto/descripción
//                       (ej. el sub-renglón "VR MONEDA ORIG ..." de Bancolombia).
//   opts.parsearFecha:  función (linea) -> { dia, mes, raw } | null. Por defecto, DD/MM.
//   opts.montoMin: monto mínimo a considerar (por defecto 1).
// Devuelve [{ dia, mes, descripcion, monto, raw }].
function parsearTabular(texto, opts) {
  opts = opts || {};
  const limpiezaExtra = Array.isArray(opts.limpiezaExtra) ? opts.limpiezaExtra : [];
  const montoMin = opts.montoMin != null ? opts.montoMin : 1;
  const parsearFecha = (typeof opts.parsearFecha === 'function') ? opts.parsearFecha : parsearFechaDDMM;
  const out = [];
  const reMontoG = /\$?\s?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d{4,}(?:,\d{1,2})?)/g;
  String(texto || '').split(/\r?\n/).forEach(raw => {
    const linea = raw.trim();
    if (linea.length < 6) return;
    const f = parsearFecha(linea);
    if (!f) return;
    const dia = f.dia, mes = f.mes;
    // Quitar el ruido estructural ANTES de extraer monto/descripción: primero la fecha, luego la
    // limpieza específica del banco (limpiezaExtra), luego lo común (tasa por línea y cuotas N/M).
    let limpia = linea.replace(f.raw, ' ');
    limpiezaExtra.forEach(re => { limpia = limpia.replace(re, ' '); });
    limpia = limpia
      .replace(/\b\d{1,2}[.,]\d{1,4}\s*%/g, ' ')   // tasa "1,9110%"
      .replace(/\b\d{1,3}\/\d{1,3}\b/g, ' ');      // cuotas "1/1", "1/36"
    const montos = [];
    let mm; reMontoG.lastIndex = 0;
    while ((mm = reMontoG.exec(limpia)) !== null) {
      const v = parseMontoCol(mm[1]);
      if (v != null && v >= montoMin) montos.push(v);
    }
    if (!montos.length) return;
    const monto = Math.max.apply(null, montos);
    const desc = limpia
      .replace(/\$?\s?\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?/g, ' ') // montos con miles
      .replace(/\b\d{4,}(?:,\d{1,2})?\b/g, ' ')               // enteros largos
      .replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ0-9\s*&./-]/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (!/[A-Za-zÁÉÍÓÚÑáéíóúñ]{3,}/.test(desc)) return;
    out.push({ dia, mes, descripcion: desc, monto: Math.round(monto), raw: linea });
  });
  return out;
}

/**
 * Cruce determinista con pool. La ESTRATEGIA produce las líneas del extracto; aquí se emparejan
 * con las compras de la app (1 cuota) por Monto (±tolMonto) AND Fecha (±tolDias) AND Descripción
 * (Dice ≥ umbral), asignando greedy por mejor score (cada línea y cada compra, una sola vez).
 * @param {string} texto  Texto del extracto (ya redactado).
 * @param {Array}  comprasBD  movimientos.compras: { id, descripcion, total, fecha, ... }
 * @param {object} estrategia  objeto con parsearLineas(texto) -> [{ dia, mes, descripcion, monto }]
 * @param {object} [opts]  { tolMonto=2, tolDias=1, umbral=0.55 }
 */
function cruzar(texto, comprasBD, estrategia, opts) {
  opts = opts || {};
  const tolMonto = opts.tolMonto != null ? opts.tolMonto : 2;
  const tolDias = opts.tolDias != null ? opts.tolDias : 1;
  const umbral = opts.umbral != null ? opts.umbral : 0.55;

  const lineas = (estrategia && typeof estrategia.parsearLineas === 'function')
    ? (estrategia.parsearLineas(texto) || [])
    : [];
  const compras = (comprasBD || []).filter(c => c && c.id != null);

  // 1) Todos los pares (línea, compra) que cumplen el match estricto, con su score.
  const pares = [];
  lineas.forEach((L, li) => {
    compras.forEach((C, ci) => {
      const montoBD = Math.round(Number(C.total) || 0);
      if (montoBD <= 0) return;
      if (Math.abs(Math.round(L.monto) - montoBD) > tolMonto) return;
      if (!fechaCercana(L.dia, L.mes, C.fecha, tolDias)) return;
      const score = dice(normalizarDesc(L.descripcion), normalizarDesc(C.descripcion));
      if (score < umbral) return;
      pares.push({ li, ci, score });
    });
  });

  // 2) Asignación greedy por mejor score respetando el POOL (cada línea/compra una vez).
  pares.sort((a, b) => b.score - a.score);
  const usadosL = {}, usadosC = {}, matches = [];
  pares.forEach(p => {
    if (usadosL[p.li] || usadosC[p.ci]) return;
    usadosL[p.li] = 1; usadosC[p.ci] = 1;
    const L = lineas[p.li], C = compras[p.ci];
    matches.push({
      compra_id: C.id,
      descripcion_app: C.descripcion,
      descripcion_extracto: L.descripcion,
      monto: Math.round(Number(C.total) || 0),
      fecha_app: C.fecha,
      dia_extracto: L.dia, mes_extracto: L.mes,
      score: Math.round(p.score * 100) / 100
    });
  });

  const comprasSinMatch = compras.filter((_, i) => !usadosC[i]).map(c => ({ compra_id: c.id, descripcion: c.descripcion, total: Math.round(Number(c.total) || 0), fecha: c.fecha }));
  const lineasSinMatch = lineas.filter((_, i) => !usadosL[i]).map(L => ({ descripcion: L.descripcion, monto: L.monto, dia: L.dia, mes: L.mes }));

  return {
    matches,
    comprasSinMatch,
    lineasSinMatch,
    total_lineas_extracto: lineas.length,
    total_compras_app: compras.length
  };
}

module.exports = { parseMontoCol, normalizarDesc, dice, fechaCercana, parsearTabular, parsearFechaDDMM, cruzar };
