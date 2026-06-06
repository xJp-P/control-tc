// backend/services/extracto/strategies/bancolombiaDual.js
// Estrategia de extracto para Bancolombia con extracto DUAL: Mastercard y American Express. El banco
// emite dos estados de cuenta por ciclo (uno en PESOS, otro en DOLARES) que pueden venir como dos
// PDFs separados o unidos en uno solo. El parser segmenta el texto por sus marcadores de sección y
// etiqueta cada línea con su moneda ('COP' | 'USD'); el motor de cruce (multi-moneda) compara cada
// línea SOLO con las compras de su misma moneda — USD contra valor_usd nativo, sin convertir por TRM.
//
// Detalle del formato (ver docs/bancos/Bancolombia_{Mastercard,Amex}.md):
//   - Línea COP:  "13/10 NETFLIX DL $44.900 1/1 0,0000%"            (idéntica a Visa)
//   - Línea USD:  "10/09 APPLE.COM/BILL $11,50 1/1 ... VR MONEDA ORIG 44900.0 USA"
//     El monto facturado es el USD ($11,50); el "VR MONEDA ORIG 44900.0" es el COP original
//     (informativo) — se limpia antes de extraer el monto, para no confundirlo con el cargo USD.

const { parsearTabular } = require('../motorCruce');
const { isDualExtracto } = require('../../../helpers/banco');

// Limpieza específica del dual: el sub-renglón "VR MONEDA ORIG ..." y el valor en moneda origen
// ("44900.0 USA" / "79.0 US"). Se quita ANTES de extraer el monto.
const LIMPIEZA_DUAL = [
  /VR\s+MONEDA\s+ORIG.*$/i,
  /\b\d+[.,]\d+\s+[A-Z]{2,3}\b/g
];

// Marcadores de cambio de sección. El extracto titula "Estado de cuenta en PESOS" / "... en DOLARES".
// Se aceptan variantes cortas como respaldo. (Calibrar con un PDF real si el layout difiere.)
const RE_DOLARES = /ESTADO\s+DE\s+CUENTA\s+EN\s+D[OÓ]LARES|\bEN\s+D[OÓ]LARES\b/i;
const RE_PESOS = /ESTADO\s+DE\s+CUENTA\s+EN\s+PESOS|\bEN\s+PESOS\b/i;

module.exports = {
  id: 'bancolombia_dual',

  // Bancolombia con extracto dual: Mastercard o American Express (Visa NO es dual).
  aplica(banco, franquicia) {
    return String(banco || '').toLowerCase().includes('bancolombia') && isDualExtracto(franquicia);
  },

  // Segmenta el texto por sección y parsea cada bloque etiquetando la moneda. Por defecto COP; al
  // cruzar un marcador DOLARES, el bloque siguiente es USD (y viceversa). Así funciona con un PDF de
  // solo pesos, uno de solo dólares (el bloque COP inicial queda vacío) o ambos unidos.
  parsearLineas(texto) {
    const segmentos = [{ moneda: 'COP', lineas: [] }];
    String(texto || '').split(/\r?\n/).forEach(raw => {
      const l = raw.trim();
      if (RE_DOLARES.test(l)) { segmentos.push({ moneda: 'USD', lineas: [] }); return; }
      if (RE_PESOS.test(l)) { segmentos.push({ moneda: 'COP', lineas: [] }); return; }
      segmentos[segmentos.length - 1].lineas.push(raw);
    });
    const out = [];
    segmentos.forEach(seg => {
      if (!seg.lineas.length) return;
      const parsed = parsearTabular(seg.lineas.join('\n'), {
        limpiezaExtra: LIMPIEZA_DUAL,
        montoMin: seg.moneda === 'USD' ? 0.01 : 1   // en USD los montos son chicos (decenas de dólares)
      });
      parsed.forEach(p => { p.moneda = seg.moneda; out.push(p); });
    });
    return out;
  },

  // Reglas específicas del extracto dual para el system prompt de la IA.
  reglasPrompt() {
    return [
      'D1. EXTRACTO DUAL: Bancolombia Mastercard/Amex emite DOS estados de cuenta independientes por ciclo (uno en PESOS y otro en DOLARES), cada uno con su propio Pago Minimo y Pago Total. NO sumes ni mezcles las dos monedas: concilia cada universo por separado.',
      'D2. Las compras INTERNACIONALES (Apple, Habbo, PayPal, Hoyoverse, etc.) viven en el extracto en DOLARES, NO en el de pesos. En la app son compras con valor_usd > 0. No las reportes como faltantes en el extracto en pesos ni viceversa.',
      'D3. "VR MONEDA ORIG <valor> USA" dentro de una linea en dolares es el valor ORIGINAL en COP (solo informativo); el monto facturado real es el USD de la linea (ej. "$11,50"). Usa el monto USD para conciliar, nunca el VR MONEDA ORIG.',
      'D4. Las compras a 1 cuota muestran 0,0000% y no generan interes si se pagan al vencimiento (igual en COP y en USD). Los intereses corrientes se facturan como UN movimiento agregado el dia del corte (capitalizacion diaria); la app los aproxima por cuota, asi que una diferencia pequena va en "residual_no_explicado", no como discrepancia.',
      'D5. tasas_intl_extracto debe ser {} (vacio): Bancolombia Mastercard/Amex NO cobran el cargo "INT INTL" estilo Visa. El interes sobre compras en USD solo se cobra (en el extracto en dolares) si el saldo no se paga al vencimiento, no como un cargo automatico por ser internacional.'
    ];
  }
};
