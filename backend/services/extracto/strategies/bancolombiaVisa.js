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

  // Lee del encabezado las cifras que el banco IMPRIME, para que la app pueda mostrar el pago
  // minimo real en vez de su estimacion. El estimado no puede ser exacto por diseno (el banco cobra
  // interes revolvente sobre las compras de contado que rotan al pagar solo el minimo), y obligar
  // al usuario a abrir el PDF y teclear una cifra distinta a la que ve en pantalla no es una opcion
  // de producto: o la app sabe el numero, o el usuario paga de menos y entra en mora.
  //
  // LAYOUT (verificado sobre los extractos de mayo, junio y julio de 2026): Bancolombia repite cada
  // celda TRES veces en el texto extraido, y las etiquetas viven en una linea distinta a sus
  // importes. Las dos cifras se leen asi:
  //
  //   [10] 30 jun - 30 jul. 2026 $ 30.613.000,00 $ 30.613.000,00 $ 30.613.000,00   <- Pago Total
  //   [12] Pagar antes de: Pago mínimo:
  //   [14] Disponible: $ 0,00 ago. 18, 2026 (x3) $ 3.539.098,00 $ 3.539.098,00 $ 3.539.098,00
  //
  // OJO con la trampa de la linea del minimo: empieza con "Disponible: $ 0,00", asi que quedarse
  // con el PRIMER importe daria cero. Por eso no se toma ni el primero ni el ultimo por posicion,
  // sino el importe que aparece REPETIDO (>=2 veces) en la linea, que es la marca del layout
  // triplicado. Es el mismo tipo de trampa que el "Pago alternativo" de RappiCard.
  parsearResumen(texto) {
    const ls = String(texto || '').split(/\r?\n/).map(l => l.trim());
    const RE_IMPORTE = /\$\s*(\d{1,3}(?:\.\d{3})*(?:,\d{1,2})?)/g;
    const aNumero = (s) => {
      const n = parseFloat(String(s).replace(/\./g, '').replace(',', '.'));
      return isFinite(n) ? n : null;
    };
    // Importe dominante de una linea: el que se repite (layout triplicado). Si ninguno se repite,
    // no se devuelve nada: es preferible no fijar cifra a fijar una equivocada.
    const importeRepetido = (linea) => {
      const vistos = {};
      let m; RE_IMPORTE.lastIndex = 0;
      while ((m = RE_IMPORTE.exec(linea)) !== null) {
        const v = aNumero(m[1]);
        if (v != null && v > 0) vistos[v] = (vistos[v] || 0) + 1;
      }
      const repetidos = Object.keys(vistos).filter(k => vistos[k] >= 2).map(Number);
      return repetidos.length ? Math.max.apply(null, repetidos) : null;
    };
    // Busca en las `ventana` lineas siguientes a la etiqueta el primer importe repetido.
    const trasEtiqueta = (re, ventana) => {
      for (let i = 0; i < ls.length; i++) {
        if (!re.test(ls[i])) continue;
        for (let j = i; j < Math.min(i + 1 + (ventana || 3), ls.length); j++) {
          const v = importeRepetido(ls[j]);
          if (v != null) return v;
        }
      }
      return null;
    };
    const out = {};
    const pm = trasEtiqueta(/Pago\s+m[ií]nimo\s*:/i, 3);
    const pt = trasEtiqueta(/Pago\s+Total\s*:/i, 3);
    if (pm != null) out.pago_minimo = pm;
    if (pt != null) out.pago_total = pt;
    // Coherencia: un minimo mayor que el total significa que se leyo mal alguna de las dos.
    if (out.pago_minimo != null && out.pago_total != null && out.pago_minimo > out.pago_total) return {};
    return out;
  },

  // Reglas que solo aplican a Bancolombia Visa (antes fijas en ia.js como 2c y 4c).
  reglasPrompt() {
    return [
      '2c. Las cuotas de avances y diferidas que recibes YA incluyen su interes corriente (campos "interes"/"total" de cada una). Por eso los "intereses corrientes" del extracto en su mayoria YA estan reflejados en esas cuotas; NO asumas que la app no los incluye. La diferencia tipica es solo un residual pequeno (revolving / intl no modelado).',
      '4c. TASA DE INTERES INTERNACIONAL (puede haber DOS por ciclo): la Tasa de Usura cambia el 1° de cada mes, asi que un ciclo que abarca dos meses calendario puede traer una tasa por mes. En el extracto cada compra intl trae su tasa como porcentaje con coma decimal (ej. "2,0849%"); las nacionales a 1 cuota muestran "0,0000%" (no las uses). Convierte cada tasa a DECIMAL con punto ("2,0849%" -> 0.020849) y devuelve un MAPA por mes en el campo raiz "tasas_intl_extracto", con clave "YYYY-MM" segun el mes calendario de las compras de esa tasa (ej. {"2026-05":0.0191,"2026-06":0.0199}). Si todas las compras intl son del mismo mes, devuelve un solo par. Si no hay compras internacionales con tasa > 0, devuelve {} (vacio). NUNCA uses la EFECTIVA ANUAL (E.A., ~25%); es la mensual. No inventes tasas: la app ademas cruza por la tasa leida en cada linea del PDF.'
    ];
  }
};
