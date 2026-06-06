// backend/services/extracto/strategies/bancolombiaVisa.js
// Estrategia de extracto para Bancolombia Visa (el layout y las reglas con las que se calibró
// originalmente el cruce determinista). Encapsula DOS cosas específicas de este banco:
//   1) parsearLineas: parser tabular + la limpieza propia del sub-renglón "VR MONEDA ORIG ..." y
//      del valor en moneda origen ("11.6 FI" / "79.0 US"), que solo aparecen en Bancolombia.
//   2) reglasPrompt: las reglas del system prompt que asumen el modelo Bancolombia Visa
//      (intereses corrientes residuales y la tasa de interés internacional / INT INTL).

const { parsearTabular } = require('../motorCruce');
const { isDualExtracto } = require('../../../helpers/banco');

// Limpieza ESPECÍFICA de Bancolombia (se aplica antes de extraer monto/descripción):
//   - el sub-renglón "VR MONEDA ORIG ..." hasta el fin de línea.
//   - el valor en moneda origen tipo "11.6 FI" / "79.0 US".
const LIMPIEZA_BANCOLOMBIA = [
  /VR\s+MONEDA\s+ORIG.*$/i,
  /\b\d+[.,]\d+\s+[A-Z]{2}\b/g
];

module.exports = {
  id: 'bancolombia_visa',

  // Bancolombia + Visa (excluye Mastercard/Amex, que usan extracto dual y tendrán su estrategia).
  aplica(banco, franquicia) {
    const b = String(banco || '').toLowerCase();
    const f = String(franquicia || '').toLowerCase();
    return b.includes('bancolombia') && f.includes('visa') && !isDualExtracto(franquicia);
  },

  parsearLineas(texto) {
    return parsearTabular(texto, { limpiezaExtra: LIMPIEZA_BANCOLOMBIA });
  },

  // Reglas que solo aplican a Bancolombia Visa (antes fijas en ia.js como 2c y 4c).
  reglasPrompt() {
    return [
      '2c. Las cuotas de avances y diferidas que recibes YA incluyen su interes corriente (campos "interes"/"total" de cada una). Por eso los "intereses corrientes" del extracto en su mayoria YA estan reflejados en esas cuotas; NO asumas que la app no los incluye. La diferencia tipica es solo un residual pequeno (revolving / intl no modelado).',
      '4c. TASA DE INTERES INTERNACIONAL (puede haber DOS por ciclo): la Tasa de Usura cambia el 1° de cada mes, asi que un ciclo que abarca dos meses calendario puede traer una tasa por mes. En el extracto cada compra intl trae su tasa como porcentaje con coma decimal (ej. "2,0849%"); las nacionales a 1 cuota muestran "0,0000%" (no las uses). Convierte cada tasa a DECIMAL con punto ("2,0849%" -> 0.020849) y devuelve un MAPA por mes en el campo raiz "tasas_intl_extracto", con clave "YYYY-MM" segun el mes calendario de las compras de esa tasa (ej. {"2026-05":0.0191,"2026-06":0.0199}). Si todas las compras intl son del mismo mes, devuelve un solo par. Si no hay compras internacionales con tasa > 0, devuelve {} (vacio). NUNCA uses la EFECTIVA ANUAL (E.A., ~25%); es la mensual. No inventes tasas: la app ademas cruza por la tasa leida en cada linea del PDF.'
    ];
  }
};
