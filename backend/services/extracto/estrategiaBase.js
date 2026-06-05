// backend/services/extracto/estrategiaBase.js
// CONTRATO de una estrategia de extracto + estrategia GENÉRICA de fallback.
//
// Una estrategia es un objeto con esta forma:
//   {
//     id: string,                                  // identificador legible
//     aplica(banco, franquicia) -> boolean,        // ¿esta estrategia maneja esta tarjeta?
//     parsearLineas(texto) -> [{ dia, mes, descripcion, monto }],  // parseo del layout del banco
//     reglasPrompt() -> string[]                   // reglas ESPECÍFICAS para el system prompt de la IA
//   }
//
// El motor de cruce (motorCruce.cruzar) solo necesita parsearLineas; ia.js usa además reglasPrompt.
//
// La estrategia BASE es el fallback final del dispatcher: aplica a cualquier banco que no tenga una
// estrategia propia. Usa el parser tabular genérico (sin limpieza específica de ningún banco) y NO
// aporta reglas de prompt (solo las universales del system prompt). Es conservadora: si el layout no
// es tabular, parsearTabular simplemente no extrae líneas y el cruce queda vacío → la IA concilia sola.

const { parsearTabular } = require('./motorCruce');

const estrategiaBase = {
  id: 'generica',
  aplica() { return true; },                       // fallback: siempre aplica (se evalúa de último)
  parsearLineas(texto) { return parsearTabular(texto, {}); },
  reglasPrompt() { return []; }
};

module.exports = estrategiaBase;
