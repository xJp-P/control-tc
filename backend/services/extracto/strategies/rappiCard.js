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

function parsearVertical(texto) {
  const lineas = String(texto || '').split(/\r?\n/).map(l => l.trim());
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
      if (lineas[j]) campos.push(lineas[j]);
    }
    let descripcion = null, tasa = null, negativo = false;
    const montos = [];
    campos.forEach(c => {
      if (RE_CUOTAS.test(c)) return;
      const mm = c.match(RE_MONTO_SOLO);
      if (mm) {
        if (mm[1] || mm[2]) negativo = true;     // "$-237.136,05" → pago/reverso, no es una compra
        const v = parseMontoCol(c.replace('-', ''));
        if (v != null) montos.push(v);
        return;
      }
      if (RE_PCT_SOLO.test(c)) {
        const v = parseFloat(c.replace('%', '').replace(',', '.')) / 100;
        if (v > 0 && tasa == null) tasa = Math.round(v * 1e6) / 1e6;
        return;
      }
      if (/^N\/A$/i.test(c)) return;
      // Primer campo con texto real = la descripción del comercio.
      if (descripcion == null && /[A-Za-zÁÉÍÓÚÑáéíóúñ]{3,}/.test(c)) descripcion = c;
    });
    // Los movimientos NEGATIVOS (pagos, reversos) los detectan sus propios detectores en routes/ia.js
    // a partir del texto crudo; aquí se descartan para no ensuciar el pool del matcher.
    if (negativo || descripcion == null || !montos.length) continue;
    // 2º monto = capital facturado del periodo; si el bloque viene corto, cae al único disponible.
    const monto = montos.length >= 2 ? montos[1] : montos[0];
    if (!(monto > 0)) continue;
    out.push({ dia, mes, descripcion, monto, tasa, raw: lineas.slice(i, i + campos.length + 1).join(' | ') });
  }
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
