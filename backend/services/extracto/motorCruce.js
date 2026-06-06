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
  // Montos: (a) CON $ de cualquier tamaño ("$44.900", "$11,75", "$236"); (b) sin $ pero con
  // separador de miles ("287.890,49"); (c) decimal pequeño sin $ ("11,75", USD). NO se toma un
  // entero largo suelto sin $ ni separador (ej. "37627409", una referencia de PayPal en la
  // descripcion), que antes se confundia con el monto.
  const reMontoG = /(\$\s?\d+(?:\.\d{3})*(?:,\d{1,2})?|\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?|\d{1,3},\d{1,2})/g;
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
      .replace(/\$\s?\d[\d.,]*/g, ' ')                         // cualquier monto con $ (incl. USD "$11,50")
      .replace(/\$?\s?\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?/g, ' ') // montos con miles
      .replace(/\b\d{4,}(?:,\d{1,2})?\b/g, ' ')               // enteros largos
      .replace(/[^A-Za-zÁÉÍÓÚÑáéíóúñ0-9\s*&./-]/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (!/[A-Za-zÁÉÍÓÚÑáéíóúñ]{3,}/.test(desc)) return;
    // monto SIN redondear: el cruce compara con tolerancia por moneda y el USD necesita decimales.
    out.push({ dia, mes, descripcion: desc, monto: monto, raw: linea });
  });
  return out;
}

// Campo de monto en la compra de la app, según la moneda de la línea. Es el DEFECTO: un objeto puede
// declarar su propio `campo_monto` (ver montoDe) cuando lo que el banco imprime en la línea NO es su
// `total`. Caso real: las cuotas de diferida/avance se cruzan por su CAPITAL (lo que el banco factura
// en la línea), porque el banco unifica los intereses en un bloque aparte; su `total` (capital+interés)
// nunca coincidiría con la línea.
const CAMPO_MONTO = { COP: 'total', USD: 'total_usd' };

/**
 * Cruce determinista con pool, MULTI-MONEDA. La ESTRATEGIA produce las líneas del extracto, cada
 * una con su `moneda` ('COP' por defecto, o 'USD'); aquí se emparejan con las compras de la app de
 * SU MISMA moneda por Monto (±tol según moneda) AND Fecha (±tolDias) AND Descripción (Dice ≥ umbral),
 * asignando greedy por mejor score (cada línea y cada compra, una sola vez).
 * @param {string} texto  Texto del extracto (ya redactado).
 * @param {Array|object} comprasInput  Array = todo COP (mono-moneda, compatibilidad). Objeto
 *        { COP:[...], USD:[...] } = multi-moneda. Cada compra: { id, descripcion, fecha, total (COP) | total_usd (USD) }.
 * @param {object} estrategia  con parsearLineas(texto) -> [{ dia, mes, descripcion, monto, moneda? }]
 * @param {object} [opts]  { tolMontoCOP=2, tolMontoUSD=0.01, tolDias=1, umbral=0.55 }
 */
function cruzar(texto, comprasInput, estrategia, opts) {
  opts = opts || {};
  const tolDias = opts.tolDias != null ? opts.tolDias : 1;
  const umbral = opts.umbral != null ? opts.umbral : 0.55;
  // Tolerancia de monto POR MONEDA: pesos enteros (±2) vs dólares al centavo (±0.01).
  const tolMonto = { COP: opts.tolMontoCOP != null ? opts.tolMontoCOP : 2, USD: opts.tolMontoUSD != null ? opts.tolMontoUSD : 0.01 };
  // Un array suelto se interpreta como compras en COP (mantiene el contrato mono-moneda de Visa/Rappi/Nu).
  const grupos = Array.isArray(comprasInput) ? { COP: comprasInput } : (comprasInput || {});
  const comprasDe = (moneda) => (grupos[moneda] || []).filter(c => c && c.id != null);
  // Lee el monto facturable del objeto. Por defecto, el campo de la moneda (COP->total, USD->total_usd);
  // pero si el objeto DECLARA `campo_monto` (ej. cuotas de diferida/avance -> 'capital'), se respeta.
  const montoDe = (c, moneda) => Number(c[c.campo_monto || CAMPO_MONTO[moneda]]) || 0;

  const lineas = (estrategia && typeof estrategia.parsearLineas === 'function')
    ? (estrategia.parsearLineas(texto) || [])
    : [];

  // 1) Pares (línea, compra) válidos: cada línea SOLO se compara con compras de su misma moneda.
  const pares = [];
  lineas.forEach((L, li) => {
    const moneda = (L.moneda === 'USD') ? 'USD' : 'COP';
    comprasDe(moneda).forEach(C => {
      const montoBD = montoDe(C, moneda);
      if (montoBD <= 0) return;
      if (Math.abs(Number(L.monto) - montoBD) > tolMonto[moneda]) return;
      if (!fechaCercana(L.dia, L.mes, C.fecha, tolDias)) return;
      const score = dice(normalizarDesc(L.descripcion), normalizarDesc(C.descripcion));
      if (score < umbral) return;
      pares.push({ li, moneda, cid: C.id, score });
    });
  });

  // 2) Asignación greedy por mejor score, con POOL por (línea) y por (moneda+compra).
  pares.sort((a, b) => b.score - a.score);
  const usadosL = {}, usadosC = {}, matches = [];
  pares.forEach(p => {
    const ck = p.moneda + ':' + p.cid;
    if (usadosL[p.li] || usadosC[ck]) return;
    usadosL[p.li] = 1; usadosC[ck] = 1;
    const L = lineas[p.li];
    const C = comprasDe(p.moneda).find(c => c.id === p.cid);
    const m = montoDe(C, p.moneda);
    matches.push({
      compra_id: C.id,
      tipo: C.tipo || 'compra',
      moneda: p.moneda,
      descripcion_app: C.descripcion,
      descripcion_extracto: L.descripcion,
      monto: p.moneda === 'USD' ? Math.round(m * 100) / 100 : Math.round(m),
      fecha_app: C.fecha,
      dia_extracto: L.dia, mes_extracto: L.mes,
      score: Math.round(p.score * 100) / 100
    });
  });

  // Sobrantes: compras de la app sin contraparte (por moneda) y líneas del extracto sin cruzar.
  const comprasSinMatch = [];
  Object.keys(grupos).forEach(moneda => {
    comprasDe(moneda).forEach(c => {
      if (usadosC[moneda + ':' + c.id]) return;
      const m = montoDe(c, moneda);
      comprasSinMatch.push({ compra_id: c.id, tipo: c.tipo || 'compra', moneda, descripcion: c.descripcion, total: moneda === 'USD' ? Math.round(m * 100) / 100 : Math.round(m), fecha: c.fecha });
    });
  });
  const lineasSinMatch = lineas.filter((_, i) => !usadosL[i]).map(L => ({ descripcion: L.descripcion, monto: L.monto, dia: L.dia, mes: L.mes, moneda: L.moneda || 'COP' }));
  const totalCompras = Object.keys(grupos).reduce((s, mon) => s + comprasDe(mon).length, 0);

  return {
    matches,
    comprasSinMatch,
    lineasSinMatch,
    total_lineas_extracto: lineas.length,
    total_compras_app: totalCompras
  };
}

module.exports = { parseMontoCol, normalizarDesc, dice, fechaCercana, parsearTabular, parsearFechaDDMM, cruzar };
