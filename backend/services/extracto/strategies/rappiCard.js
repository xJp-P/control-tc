// backend/services/extracto/strategies/rappiCard.js
// Estrategia de extracto para RappiCard (emisor Davivienda, franquicia Visa). El layout difiere de
// Bancolombia en dos cosas clave:
//   1) NO existe el sub-renglón "VR MONEDA ORIG ..." — RappiCard convierte todo a COP y no separa
//      compras internacionales (todas se muestran como compras COP normales). Por eso NO se limpia
//      nada extra y la tasa de interés internacional no aplica (tasa_intl_extracto = null).
//   2) La fecha de la transacción puede venir en formato Davivienda: DD/MM numérico o "DD MMM"
//      (mes en español abreviado, ej. "19 SEP"). Se ancla al INICIO de la línea para no confundir
//      la fecha con el bloque de cuotas "N/M" (que en RappiCard va después del monto, ej. "1/1").
//
// NOTA (calibración): el doc del banco describe el comportamiento financiero pero no el texto crudo
// exacto de cada línea (los ejemplos de §3.1 aparecen sin la fecha). El parser asume el formato
// estándar "fecha al inicio". Como el motor de cruce es conservador, si el layout real difiere las
// líneas simplemente no se cruzan y la IA concilia igual (sin regresión) — se afina con un PDF real.

const { parsearTabular, parseMontoCol } = require('../motorCruce');

// --- Layout REAL del PDF (calibrado con el extracto de julio-2026) ---------------------------------
// El "Detalle de transacciones" de RappiCard NO es tabular: al extraer el texto, cada celda cae en su
// PROPIA línea, en bloques de 9 campos por movimiento:
//     Virtual | 2026-07-15 | RAPPI | $36.300,00 | $36.300,00 | 1 de 1 | $0,00 | 0,0000% | 0,00%
//     canal   | fecha ISO  | desc  | valor tx   | capital fac | cuotas | pendiente | tasa MV | tasa EA
// Por eso `parsearTabular` (que exige fecha + monto en la MISMA línea) no cruzaba NADA en esta tarjeta:
// toda la conciliación caía sobre el LLM, sin la red determinista. Este parser reconstruye los bloques.
//
// Se emite el CAPITAL FACTURADO (2º monto), no el valor de la transacción: es lo que el banco cobra en
// ESTE ciclo y es lo que el motor compara — las cuotas de diferida se cruzan por `campo_monto:'capital'`
// (v4.3.2) y en una compra de contado ambos valores coinciden, así que sirve para los dos casos.
const RE_FECHA_ISO = /^(\d{4})-(\d{2})-(\d{2})$/;
// El monto DEBE traer "$" o separador de miles. Sin esa exigencia, un entero pelado ("37627409", un
// numero de referencia) contaba como monto: la descripcion del comercio SI se parte en varias lineas
// (en el PDF real "BFINITY BITFI" / "TECHNOLO"), asi que un fragmento numerico se colaria ANTES de los
// montos reales y desplazaria montos[1] del capital facturado al valor de la transaccion. Es la misma
// clase de bug que se corrigio en el parser tabular en v4.3.0 (caso "PAYPAL *HABBO 37627409").
const RE_MONTO_SOLO = /^(?:\$\s*(-)?\s*\d[\d.]*(?:,\d{1,2})?|(-)?\s*\d{1,3}(?:\.\d{3})+(?:,\d{1,2})?)$/;
const RE_PCT_SOLO = /^\d{1,2}[.,]?\d{0,4}\s*%$/;
const RE_CUOTAS = /^(\d{1,3})\s*(?:de|\/)\s*(\d{1,3})$/i;

function parsearVertical(texto, opts) {
  const incluirNegativos = !!(opts && opts.incluirNegativos);
  const crudas = String(texto || '').split(/\r?\n/);
  const lineas = crudas.map(l => l.trim());
  const out = [];
  for (let i = 0; i < lineas.length; i++) {
    const mf = lineas[i].match(RE_FECHA_ISO);
    if (!mf) continue;
    const mes = parseInt(mf[2], 10), dia = parseInt(mf[3], 10);
    if (!(dia >= 1 && dia <= 31 && mes >= 1 && mes <= 12)) continue;
    // Ventana hasta el siguiente movimiento (máx. 10 campos) — tolera bloques incompletos.
    const campos = [];
    for (let j = i + 1; j < lineas.length && campos.length < 10; j++) {
      if (RE_FECHA_ISO.test(lineas[j])) break;
      // `sep` = el PDF traía un espacio al final de este trozo, así que la palabra NO venía cortada
      // ("BFINITY BITFI " + "TECHNOLO"). Sin espacio final es un corte a mitad de palabra y hay que
      // pegar los trozos directos ("Topper*Phantom-" + "Walle").
      if (lineas[j]) campos.push({ v: lineas[j], sep: /\s$/.test(crudas[j]) });
    }
    // La descripción del comercio SE PARTE en varias líneas cuando no cabe en la celda (confirmado en
    // los PDF reales: "Topper*Phantom-" + "Walle", "BFINITY BITFI " + "TECHNOLO"). Se concatenan TODAS
    // las líneas de texto que preceden al primer campo numérico; quedarse con la primera truncaba el
    // nombre y debilitaba el cruce por descripción (Dice) contra la compra de la app.
    const partesDesc = [];
    let tasa = null, negativo = false, vistoNumero = false;
    const montos = [];
    campos.forEach(campo => {
      const c = campo.v;
      if (RE_CUOTAS.test(c)) { vistoNumero = true; return; }
      const mm = c.match(RE_MONTO_SOLO);
      if (mm) {
        vistoNumero = true;
        if (mm[1] || mm[2]) negativo = true;     // "$-237.136,05" → pago/reverso, no es una compra
        const v = parseMontoCol(c.replace('-', ''));
        if (v != null) montos.push(v);
        return;
      }
      if (RE_PCT_SOLO.test(c)) {
        vistoNumero = true;
        const v = parseFloat(c.replace('%', '').replace(',', '.')) / 100;
        if (v > 0 && tasa == null) tasa = Math.round(v * 1e6) / 1e6;
        return;
      }
      if (/^N\/A$/i.test(c)) { vistoNumero = true; return; }
      if (!vistoNumero) partesDesc.push(campo);
    });
    // Une los fragmentos respetando el espacio que el propio PDF ya traía al final de cada trozo.
    let descripcion = partesDesc.reduce((acc, p, k) => acc + (k && partesDesc[k - 1].sep ? ' ' : '') + p.v, '')
      .replace(/\s{2,}/g, ' ').trim() || null;
    if (descripcion && !/[A-Za-zÁÉÍÓÚÑáéíóúñ]{3,}/.test(descripcion)) descripcion = null;
    // Los movimientos NEGATIVOS (pagos, reversos) se descartan del pool del matcher: no son compras.
    // Con `incluirNegativos` se emiten aparte para los detectores deterministas (ver parsearNegativos).
    // En un pago el capital facturado viene como "N/A", así que solo hay UN monto: el de la transacción.
    if (negativo) {
      if (incluirNegativos && descripcion != null && montos.length && montos[0] > 0) {
        out.push({ dia, mes, fecha: mf[1] + '-' + mf[2] + '-' + mf[3], descripcion,
          monto: montos[0], tasa, negativo: true, raw: [lineas[i]].concat(campos.map(x => x.v)).join(' | ') });
      }
      continue;
    }
    if (descripcion == null || !montos.length) continue;
    // 2º monto = capital facturado del periodo; si el bloque viene corto, cae al único disponible.
    // Si el capital es $0,00 (una compra que el extracto lista pero NO cobra en este periodo: ya venía
    // saldada) se cae al VALOR de la transacción, para que la compra igual cruce contra la de la app.
    // Descartarla la dejaría "sin cruce" y podría inducir un falso `compra_no_facturada`, que hoy es
    // una acción DESTRUCTIVA.
    let monto = montos.length >= 2 ? montos[1] : montos[0];
    if (!(monto > 0)) monto = montos[0];
    if (!(monto > 0)) continue;
    out.push({ dia, mes, descripcion, monto, tasa, raw: [lineas[i]].concat(campos.map(x => x.v)).join(' | ') });
  }
  return out;
}

// --- Movimientos NEGATIVOS (pagos de factura, reversos) -------------------------------------------
// Los detectores deterministas de la conciliacion los buscaban por su cuenta en el texto crudo, con
// una regex que exige la fecha en formato DD/MM/YYYY. RappiCard la imprime en ISO, asi que esa regex
// no casaba NUNCA: los pagos de esta tarjeta se quedaban sin cruce determinista y el comentario de
// arriba delegaba en alguien que estructuralmente no podia verlos. Aqui se emiten ya aplanados y con
// la fecha normalizada, que es lo que el detector necesita.
//
// Cubre los DOS layouts observados en PDF reales — cual sale depende de como el documento alinee sus
// celdas al extraer el texto, asi que hay que soportar ambos:
//   HORIZONTAL: "- 2025-09-26 PAGOS RAPPIPAY APP $-99.711,66 N/A N/A N/A 0% 0,00%"
//   VERTICAL:   un campo por linea, con la fecha ISO en su propio renglon (ver doc del banco, 1.1)
// Lo COMUN a los dos, y el ancla de este parser, es que la fecha va en ISO.
//
// Esa fecha es ademas lo que separa un MOVIMIENTO de la linea de RESUMEN que el extracto imprime unas
// lineas antes ("- Pagos (incluye abonos y cancelaciones) $-99.711,66"): el resumen NO lleva fecha, y
// contarlo sumaria el mismo pago dos veces.
const RE_NEG_ISO = /(\d{4})-(\d{2})-(\d{2})\s+(.+?)\s+\$\s*-\s*([\d][\d.]*(?:,\d{1,2})?)/;

function parsearNegativos(texto) {
  const out = [];
  const vistos = Object.create(null);
  const agregar = (fecha, concepto, monto) => {
    const c = String(concepto || '').replace(/\s{2,}/g, ' ').trim();
    const m = Math.round(Number(monto) || 0);
    // Debe haber texto de comercio/concepto, no solo numeros: evita tomar un renglon de cifras sueltas.
    if (!c || !/[A-Za-zÁÉÍÓÚÑáéíóúñ]{3,}/.test(c) || !(m > 0)) return;
    const k = fecha + '|' + m;
    if (vistos[k]) return;                       // el mismo pago puede caer por los dos layouts
    vistos[k] = 1;
    out.push({ fecha: fecha || null, concepto: c, monto: m });
  };
  String(texto || '').split(/\r?\n/).forEach(raw => {
    const m = raw.trim().match(RE_NEG_ISO);
    if (m) agregar(m[1] + '-' + m[2] + '-' + m[3], m[4], parseMontoCol(m[5]));
  });
  parsearVertical(texto, { incluirNegativos: true }).forEach(b => {
    if (b.negativo) agregar(b.fecha, b.descripcion, b.monto);
  });
  return out;
}

const MESES = { ENE: 1, FEB: 2, MAR: 3, ABR: 4, MAY: 5, JUN: 6, JUL: 7, AGO: 8, SEP: 9, OCT: 10, NOV: 11, DIC: 12 };

// Extractor de fecha de RappiCard: DD/MM (o DD-MM) o "DD MMM", SIEMPRE anclado al inicio de la línea.
function parsearFechaRappi(linea) {
  const s = String(linea);
  // DD/MM | DD-MM (año opcional) al inicio.
  let m = s.match(/^(\d{1,2})[\/\-](\d{1,2})(?:[\/\-]\d{2,4})?\b/);
  if (m) {
    const dia = parseInt(m[1], 10), mes = parseInt(m[2], 10);
    if (dia >= 1 && dia <= 31 && mes >= 1 && mes <= 12) return { dia, mes, raw: m[0] };
  }
  // "DD MMM" con mes en español abreviado al inicio (ej. "19 SEP", "20 OCT"). Se exige que el mes
  // sea EXACTAMENTE una de las 12 abreviaturas + límite de palabra, para no confundir una
  // descripción que empiece con número + palabra (ej. "20 MARMOLES") con una fecha "20 MAR".
  m = s.match(/^(\d{1,2})\s+(ENE|FEB|MAR|ABR|MAY|JUN|JUL|AGO|SEP|OCT|NOV|DIC)\b/i);
  if (m) {
    const dia = parseInt(m[1], 10);
    const mes = MESES[m[2].toUpperCase()];
    if (dia >= 1 && dia <= 31 && mes) return { dia, mes, raw: m[0] };
  }
  return null;
}

module.exports = {
  id: 'rappi_card',

  // RappiCard se identifica por el emisor Davivienda (mismo criterio que esRappiCard en el motor).
  aplica(banco /*, franquicia */) {
    const b = String(banco || '').toLowerCase();
    return b.includes('rappi') || b.includes('davivienda');
  },

  parsearLineas(texto) {
    // El cashback (~0,1% del consumo) aparece como línea propia pero NO es una compra: se descarta
    // antes de parsear. Sin limpiezaExtra (no hay VR MONEDA ORIG) y con el extractor de fecha propio.
    const limpio = String(texto || '')
      .split(/\r?\n/)
      .filter(l => !/cashback/i.test(l))
      .join('\n');
    // Layout VERTICAL primero (el que produce el PDF real, un campo por línea); si no reconoce nada
    // cae al tabular de siempre → un layout distinto no rompe nada (se comporta como antes del cambio).
    const vertical = parsearVertical(limpio);
    if (vertical.length) return vertical;
    return parsearTabular(limpio, { parsearFecha: parsearFechaRappi });
  },

  // Movimientos NEGATIVOS ya aplanados y con la fecha en ISO, para los detectores deterministas de la
  // conciliacion (routes/ia/_detectores.js). Metodo OPCIONAL del contrato: quien no lo implemente deja
  // al detector con su parseo del texto crudo, que es lo que siempre hizo.
  parsearNegativos,

  // Lee las cifras OFICIALES del encabezado del extracto (v5.7.0). Determinista: NO pasa por el LLM.
  // El layout vertical pone la etiqueta en una línea y el valor en la siguiente, así que se busca la
  // etiqueta y se toma el primer monto de las líneas siguientes. Se ignoran las líneas del "Detalle
  // pago mínimo" (que repiten la etiqueta) tomando la PRIMERA aparición, que es la del encabezado.
  parsearResumen(texto) {
    const ls = String(texto || '').split(/\r?\n/).map(l => l.trim());
    // Normaliza la etiqueta antes de comparar: espacio duro (U+00A0), dos puntos y el asterisco de
    // "Pago alternativo*" no deben impedir el match por una diferencia tipográfica.
    const norm = (s) => String(s).toLowerCase().replace(/ /g, ' ').replace(/[\s:*]+$/, '').replace(/\s+/g, ' ').trim();
    // El monto DEBE venir en formato colombiano estricto (miles de 3 en 3). Sin esa exigencia,
    // "$320.582.14" (el PDF imprime algunos ceros como "$0.00", con punto decimal) se leería como
    // 32.058.214 — cien veces el valor — porque parseMontoCol trata todos los puntos como miles.
    const RE_IMPORTE = /^\$\s*(-)?\s*(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?)$/;
    // Otra etiqueta del encabezado corta la búsqueda. CRÍTICO: "Pago alternativo" está a solo 3 líneas
    // de "Pago mínimo" y vale 3,3 veces menos ($96.174 vs $320.582 en julio); si el importe propio no
    // matcheara por cualquier variación de render, la ventana caería sobre ÉL y se guardaría como
    // mínimo oficial un número plausible pero peligrosamente bajo. Al cortar, se cae a la segunda
    // aparición de la etiqueta (el bloque "Detalle pago mínimo"), que trae el MISMO valor correcto.
    const esOtraEtiqueta = (s) => /^(pago|saldo|cupo|periodo|fecha|total)\b/i.test(String(s).trim());
    const buscar = (etiquetas, ventana) => {
      for (let i = 0; i < ls.length; i++) {
        if (!etiquetas.includes(norm(ls[i]))) continue;
        for (let j = i + 1; j < Math.min(i + 1 + (ventana || 4), ls.length); j++) {
          if (!ls[j]) continue;
          const m = ls[j].match(RE_IMPORTE);
          if (m) { const v = parseMontoCol(ls[j].replace('-', '')); if (v != null) return m[1] ? -v : v; }
          if (esOtraEtiqueta(ls[j])) break;   // no invadir el importe de la etiqueta vecina
        }
      }
      return null;
    };
    const out = {};
    const pm = buscar(['pago mínimo', 'pago minimo']);
    const pt = buscar(['pago total']);
    if (pm != null) out.pago_minimo = pm;
    if (pt != null) out.pago_total = pt;
    return out;
  },

  // Reglas específicas de RappiCard para el system prompt de la IA.
  reglasPrompt() {
    return [
      'R1. RappiCard (emisor Davivienda) usa un extracto UNICO en COP: NO existe seccion USD ni "compra internacional" con interes especial. Las compras hechas en el exterior ya vienen convertidas a COP y se muestran como compras normales. Por eso "tasas_intl_extracto" debe ser {} (vacio) y NUNCA reportes discrepancias de clasificacion internacional ni cobros de interes intl.',
      'R2. Las compras a 1 cuota aparecen con tasa 0,0000% (no generan interes si se pagan en el ciclo). Las compras diferidas (2 o mas cuotas) usan la tasa MV vigente y SI cobran interes desde la cuota 1 (a diferencia de Bancolombia, RappiCard no difiere el interes de la primera cuota).',
      'R3. El cashback (~0,1% del consumo, suele aparecer como "Cashback") NO es una compra ni un abono accionable: ignoralo por completo, nunca lo reportes como discrepancia.',
      'R4. Los movimientos "PAGOS RAPPIPAY APP" con valor NEGATIVO son el PAGO de la factura del mes anterior (no una compra ni un desembolso): reportalos en "pagos_detectados" y NUNCA como compra faltante. Si alguna vez aparece uno POSITIVO, es un desembolso del producto Rappi: tratalo como este registrado en la app, no lo marques como compra faltante por defecto.',
      'R5. COMPOSICION DEL PAGO MINIMO EN RAPPICARD (usala para cuantificar el impacto de cada discrepancia): pago minimo = capital facturado consumos del mes + intereses corrientes + intereses de mora + cuota de avances + otros cargos - saldo a favor. El "capital facturado consumos del mes" incluye las compras de 1 cuota por su valor COMPLETO (al 100%, NO un porcentaje) mas el capital de la cuota de cada diferida. Por lo tanto, una compra de contado de $X que sobra o falta en la app desplaza el pago minimo en $X exactos. NUNCA apliques un porcentaje (10%, 5%, etc.) que no aparezca impreso en el bloque "Detalle pago minimo" del extracto: ese bloque es la fuente de verdad y viene desglosado en el propio PDF.'
    ];
  }
};
