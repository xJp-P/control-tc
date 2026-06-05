// backend/services/extracto/index.js
// Dispatcher del Patrón Estrategia para la conciliación de extractos. Dado el banco + franquicia
// de la tarjeta, devuelve la estrategia que sabe parsear ese layout y aportar sus reglas de prompt.
//
// La resolución se apoya en los predicados aplica() de cada estrategia, que a su vez reutilizan los
// helpers de detección de banco del proyecto (helpers/banco.js — isDualExtracto, etc.), el mismo
// criterio con el que el resto del motor discrimina por banco. Si ninguna estrategia específica
// aplica, cae a estrategiaBase (fallback genérico) → cero ruptura para bancos aún no soportados.
//
// Para añadir un banco (Fase 2): crear strategies/<banco>.js con el contrato de estrategiaBase y
// registrarlo en ESTRATEGIAS. NO se toca el motor ni ia.js.

const estrategiaBase = require('./estrategiaBase');
const bancolombiaVisa = require('./strategies/bancolombiaVisa');
const rappiCard = require('./strategies/rappiCard');
const nu = require('./strategies/nu');

// Estrategias específicas, en orden de evaluación (la primera cuyo aplica() sea true gana).
const ESTRATEGIAS = [
  bancolombiaVisa,
  rappiCard,
  nu
  // Pendiente: bancolombiaDual (MC/Amex) — hoy cae a la estrategia generica.
];

function getEstrategiaExtracto(banco, franquicia) {
  for (const s of ESTRATEGIAS) {
    try { if (s.aplica(banco, franquicia)) return s; } catch (_) { /* estrategia defensiva */ }
  }
  return estrategiaBase;
}

module.exports = { getEstrategiaExtracto, ESTRATEGIAS, estrategiaBase };
