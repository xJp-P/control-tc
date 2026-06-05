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
      '4c. TASA DE INTERES INTERNACIONAL: extrae del extracto la tasa de interes CORRIENTE MENSUAL (M.V., mes vencido) aplicada a las compras INTERNACIONALES del ciclo. En el extracto cada compra trae su tasa como porcentaje con coma decimal (ej. "2,0849%"); las compras nacionales a 1 cuota muestran "0,0000%" (sin interes) y NO debes usar esas. Toma la tasa vigente (>0) de las compras internacionales y conviertela a DECIMAL con punto: "2,0849%" -> 0.020849. Devuelvela en el campo raiz "tasa_intl_extracto". Si el extracto solo muestra 0,0000% o no hay compras internacionales con tasa, devuelve null. NUNCA uses la tasa EFECTIVA ANUAL (E.A., ~25%); es la mensual. No inventes una tasa: si no la ves clara, null.'
    ];
  }
};
