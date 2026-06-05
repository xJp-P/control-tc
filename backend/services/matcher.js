// backend/services/matcher.js
// Capa 1 de conciliación: MATCH DETERMINISTA EXACTO entre las líneas de compra del texto del
// extracto y las compras registradas en la app (BD), ANTES de involucrar el criterio de la IA.
//
// Filosofía: el matcher es CONSERVADOR y solo REDUCE ruido. Empareja una línea del extracto con
// una compra de la app si y solo si coinciden Monto (±tol) AND Fecha (±1 día) AND Descripción
// (similitud alta). Maneja un POOL: cada compra de la app y cada línea del extracto se emparejan
// como máximo una vez (resuelve el caso de dos compras del mismo monto el mismo día). Si no logra
// emparejar, no pasa nada: la IA concilia como antes. Nunca inventa cargos ni acciones.

// Parsea un monto en formato colombiano a número. "43.440,78" -> 43440.78 ; "44.900" -> 44900.
function parseMontoCol(s) {
  let t = String(s).replace(/[$\s]/g, '');
  if (t.indexOf(',') >= 0) t = t.replace(/\./g, '').replace(',', '.'); // coma = decimal, puntos = miles
  else t = t.replace(/\./g, '');                                       // sin coma: puntos = miles
  const v = parseFloat(t);
  return isNaN(v) ? null : v;
}

// Normaliza una descripción para comparar: MAYÚSCULAS, sin acentos, solo alfanumérico + espacios.
// El rango ̀-ͯ son los diacríticos combinantes que deja NFD al descomponer acentos.
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
// Usa el año de la compra de la app para ambos lados; tolera el desfase de corte (±1 día).
function fechaCercana(dia, mes, fechaBD, tolDias) {
  if (!fechaBD) return false;
  const d = new Date(String(fechaBD).slice(0, 10) + 'T00:00:00');
  if (isNaN(d.getTime())) return false;
  const ref = new Date(d.getFullYear(), mes - 1, dia);
  const diff = Math.abs(ref.getTime() - d.getTime()) / 86400000;
  return diff <= tolDias + 0.001;
}

// Extrae de cada línea del texto del extracto los movimientos con forma de compra:
// { dia, mes, descripcion, monto, raw }. Conservador: exige una fecha DD/MM, un monto plausible
// y una descripción con texto. Descarta tasas (X,XXXX%), cuotas (N/M) y el sub-renglón VR MONEDA ORIG.
function parsearLineasExtracto(texto) {
  const out = [];
  const reFecha = /\b(\d{1,2})[\/\-](\d{1,2})(?:[\/\-]\d{2,4})?\b/;
  const reMontoG = /\$?\s?(\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d{4,}(?:,\d{1,2})?)/g;
  String(texto || '').split(/\r?\n/).forEach(raw => {
    const linea = raw.trim();
    if (linea.length < 6) return;
    const mF = linea.match(reFecha);
    if (!mF) return;
    const dia = parseInt(mF[1], 10), mes = parseInt(mF[2], 10);
    if (!(dia >= 1 && dia <= 31 && mes >= 1 && mes <= 12)) return;
    // Quitar el ruido estructural ANTES de extraer monto/descripción, para que los dígitos de la
    // tasa ("1,9110%" -> 9110), las cuotas ("1/36") o el VR MONEDA ORIG no se tomen como monto.
    const limpia = linea
      .replace(mF[0], ' ')                          // fecha
      .replace(/VR\s+MONEDA\s+ORIG.*$/i, ' ')       // sub-fila VR orig (resto de la línea)
      .replace(/\b\d+[.,]\d+\s+[A-Z]{2}\b/g, ' ')   // "11.6 FI" / "79.0 US"
      .replace(/\b\d{1,2}[.,]\d{1,4}\s*%/g, ' ')    // tasa "1,9110%"
      .replace(/\b\d{1,3}\/\d{1,3}\b/g, ' ');       // cuotas "1/1", "1/36"
    // Monto principal = el mayor de los candidatos de la línea ya limpia (formato miles o entero).
    const montos = [];
    let mm; reMontoG.lastIndex = 0;
    while ((mm = reMontoG.exec(limpia)) !== null) {
      const v = parseMontoCol(mm[1]);
      if (v != null && v >= 1) montos.push(v);
    }
    if (!montos.length) return;
    const monto = Math.max.apply(null, montos);
    // Descripción: lo que queda tras quitar también los montos y los símbolos.
    const desc = limpia
      .replace(/\$?\s?\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?/g, ' ') // montos con miles
      .replace(/\b\d{4,}(?:,\d{1,2})?\b/g, ' ')               // enteros largos
      .replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ0-9\s*&./-]/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (!/[A-Za-zÁÉÍÓÚÑáéíóúñ]{3,}/.test(desc)) return; // sin texto de comercio útil
    out.push({ dia, mes, descripcion: desc, monto: Math.round(monto), raw: linea });
  });
  return out;
}

/**
 * Cruza el texto del extracto con las compras de la app (1 cuota). Devuelve los emparejamientos
 * EXACTOS (con pool), las compras de la app sin contraparte y las líneas del extracto sin cruzar.
 * @param {string} texto  Texto del extracto (ya redactado).
 * @param {Array}  comprasBD  movimientos.compras (detalleCompras): { id, descripcion, total, fecha, ... }
 * @param {object} [opts]  { tolMonto=2, tolDias=1, umbral=0.55 }
 */
function cruzarConExtracto(texto, comprasBD, opts) {
  opts = opts || {};
  const tolMonto = opts.tolMonto != null ? opts.tolMonto : 2;
  const tolDias = opts.tolDias != null ? opts.tolDias : 1;
  const umbral = opts.umbral != null ? opts.umbral : 0.55;

  const lineas = parsearLineasExtracto(texto);
  const compras = (comprasBD || []).filter(c => c && c.id != null);

  // 1) Generar TODOS los pares (línea, compra) que cumplen el match estricto, con su score.
  const pares = [];
  lineas.forEach((L, li) => {
    compras.forEach((C, ci) => {
      const montoBD = Math.round(Number(C.total) || 0);
      if (montoBD <= 0) return;
      if (Math.abs(Math.round(L.monto) - montoBD) > tolMonto) return;       // Monto
      if (!fechaCercana(L.dia, L.mes, C.fecha, tolDias)) return;            // Fecha ±1
      const score = dice(normalizarDesc(L.descripcion), normalizarDesc(C.descripcion)); // Descripción
      if (score < umbral) return;
      pares.push({ li, ci, score });
    });
  });

  // 2) Asignación greedy por mejor score, respetando el POOL (cada línea y cada compra, una vez).
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

module.exports = { cruzarConExtracto, parsearLineasExtracto, normalizarDesc, dice, parseMontoCol, fechaCercana };
