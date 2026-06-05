// backend/services/extracto/strategies/nu.js
// Estrategia de extracto para Nu Colombia (franquicia Mastercard). Es el caso límite que valida la
// flexibilidad de la arquitectura: el extracto de Nu es NARRATIVO (no una tabla "fecha desc monto
// cuotas tasa"), con un "Resumen de tu extracto" en prosa. Un parser determinista tabular sería
// frágil y propenso a falsos cruces, así que esta estrategia APAGA el matcher determinista:
// parsearLineas devuelve SIEMPRE [] → el motor de cruce no empareja nada y la IA concilia el 100%
// (sin errores, sin ruido). Lo que sí aporta Nu son sus reglasPrompt específicas.
//
// Detección: por banco que contenga 'nu' (mismo criterio que esNuBank en helpers/banco.js). Nu usa
// Mastercard, pero NO activa la lógica de extracto dual (esNuBank tiene precedencia en el motor).

module.exports = {
  id: 'nu',

  aplica(banco /*, franquicia */) {
    return String(banco || '').toLowerCase().includes('nu');
  },

  // Formato narrativo → sin parseo determinista. El array vacío deja el cruce en cero y la IA
  // (con las reglas de abajo) hace toda la conciliación. Demuestra el "apagado" por estrategia.
  parsearLineas() {
    return [];
  },

  // Reglas específicas de Nu para el system prompt de la IA.
  reglasPrompt() {
    return [
      'N1. Nu (franquicia Mastercard) usa un extracto UNICO en COP con formato NARRATIVO (un "Resumen de tu extracto" en prosa: Deuda + Intereses + Comisiones - Abonos = Pago Minimo). NO hay seccion USD ni "compra internacional" con interes especial estilo Bancolombia (no existe INT INTL). Las compras del exterior ya vienen convertidas a COP. Por eso "tasa_intl_extracto" debe ser null y NUNCA reportes discrepancias de clasificacion internacional.',
      'N2. COMISION POR CAMBIO DE MONEDA: Mastercard cobra 0,45% sobre cada compra internacional, UNA sola vez por transaccion y SIN generar intereses. Puede aparecer como linea "Comision por cambio de moneda" o ir implicita dentro del valor en COP. Es un cargo ESPERADO: NO lo reportes como compra faltante ni como discrepancia.',
      'N3. CUOTA 1 SIN INTERES: en las compras diferidas de Nu la cuota 1 es capital puro (no cobra interes); el primer interes aparece en la cuota 2. La app ya modela esto. NO marques la cuota 1 como discrepancia de interes ni como monto erroneo.',
      'N4. RETIROS EN EFECTIVO: cobran interes desde el primer mes (a la tasa MV vigente) y ademas una COMISION FIJA por retiro (aprox $6.800) que aparece en la linea "Comisiones por servicio" del resumen. No confundas el retiro ni su comision con una compra; no son compras faltantes.',
      'N5. INTERES POR CAPITALIZACION DIARIA: el interes real de Nu se calcula dia a dia sobre el saldo, mientras la app lo aproxima por cuota; esto produce diferencias de hasta ~5%. Reporta esa diferencia pequena en "residual_no_explicado", NUNCA como una discrepancia accionable.'
    ];
  }
};
