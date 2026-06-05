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

const { parsearTabular } = require('../motorCruce');

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
    return parsearTabular(limpio, { parsearFecha: parsearFechaRappi });
  },

  // Reglas específicas de RappiCard para el system prompt de la IA.
  reglasPrompt() {
    return [
      'R1. RappiCard (emisor Davivienda) usa un extracto UNICO en COP: NO existe seccion USD ni "compra internacional" con interes especial. Las compras hechas en el exterior ya vienen convertidas a COP y se muestran como compras normales. Por eso "tasa_intl_extracto" debe ser null y NUNCA reportes discrepancias de clasificacion internacional ni cobros de interes intl.',
      'R2. Las compras a 1 cuota aparecen con tasa 0,0000% (no generan interes si se pagan en el ciclo). Las compras diferidas (2 o mas cuotas) usan la tasa MV vigente y SI cobran interes desde la cuota 1 (a diferencia de Bancolombia, RappiCard no difiere el interes de la primera cuota).',
      'R3. El cashback (~0,1% del consumo, suele aparecer como "Cashback") NO es una compra ni un abono accionable: ignoralo por completo, nunca lo reportes como discrepancia.',
      'R4. Los movimientos "PAGOS RAPPIPAY APP" son desembolsos del producto Rappi (a veces a 1 cuota, a veces diferidos); trátalos como esten registrados en la app, no los marques como compras faltantes por defecto.'
    ];
  }
};
