// backend/helpers/cortes.js — Lectura de cortes_custom + nucleo del desvio de ciclo por corte
// adelantado (fecha de corte REAL por ciclo cuando el banco corta antes del dia_corte teorico).
//
// A diferencia de fechas_pago_custom (solo display), estos overrides SI afectan el calculo de a
// que ciclo pertenece una compra. La escritura (upsert/delete) vivira en su endpoint (Paso 3).

const { calcCicloLocal } = require('./dates');

// Ciclo siguiente a 'YYYY-MM' (aritmetica directa, sin Date para no arrastrar zona horaria).
function siguienteCiclo(ciclo) {
  const a = String(ciclo).split('-');
  let y = Number(a[0]), m = Number(a[1]) + 1;
  if (m > 12) { m = 1; y += 1; }
  return y + '-' + String(m).padStart(2, '0');
}

// NUCLEO COMPARTIDO (funcion PURA — sin db) del desvio por corte adelantado. Lo usan tanto
// routes/compras.js (calcCiclo, al crear/editar) como config/db.js (syncData paso 5, al arrancar),
// para que ambos coincidan SIEMPRE y syncData no pise el desvio.
//   1. cicloTeorico = calcCicloLocal(fecha, diaCorte)  (regla normal por dia_corte global)
//   2. si hay corte real para ese ciclo en cortesMap Y la compra es POSTERIOR a ese corte
//      (fecha > corte, comparacion ISO YYYY-MM-DD) -> salta al ciclo siguiente.
//   3. si no hay override (o la compra es <= corte) -> queda en el ciclo teorico.
// Solo ADELANTO: una compra del 19-jun con corte real 18-jun y dia_corte 20 va al ciclo siguiente.
// fecha: 'YYYY-MM-DD'. diaCorte: numero. cortesMap: { 'YYYY-MM': 'YYYY-MM-DD' } (puede ser {}).
function cicloConCorte(fecha, diaCorte, cortesMap) {
  const cicloTeorico = calcCicloLocal(fecha, diaCorte);
  const corte = cortesMap && cortesMap[cicloTeorico];
  if (corte && fecha > corte) return siguienteCiclo(cicloTeorico);
  return cicloTeorico;
}

// Fecha de corte 'YYYY-MM-DD' de un ciclo 'YYYY-MM' dado el dia de corte, capada al ultimo dia del mes
// (feb -> 28/29). Construccion por STRING (sin toISOString) para no depender de la zona horaria del
// proceso. Espejo del helper corteDeCiclo del frontend (mismo output). Se usa para realinear el primer
// corte de una diferida con el ciclo FIJADO MANUALMENTE de su compra (spillover / canje retrasado), en
// vez del corte natural de la fecha, cuando se edita la fecha/tarjeta de esa compra.
function corteDeCiclo(ciclo, diaCorte) {
  const p = String(ciclo).split('-');
  const y = Number(p[0]), m = Number(p[1]);
  const lastDay = new Date(y, m, 0).getDate(); // ultimo dia del mes m (solo .getDate() -> sin zona horaria)
  const day = Math.min(diaCorte || 30, lastDay);
  return y + '-' + String(m).padStart(2, '0') + '-' + String(day).padStart(2, '0');
}

// Fecha de corte real de UN (tarjeta, ciclo), o null si no hay override.
function getCorteCustom(db, tarjetaId, ciclo) {
  if (!db || !tarjetaId || !ciclo) return null;
  const row = db.prepare('SELECT fecha_corte FROM cortes_custom WHERE tarjeta_id=? AND ciclo=?').get(tarjetaId, ciclo);
  return row ? row.fecha_corte : null;
}

// Mapa { ciclo: fecha_corte } de TODOS los cortes custom de una tarjeta. Util para procesos que
// iteran muchas compras (ej. syncData) y no deben hacer una query por compra.
function getCortesCustomMap(db, tarjetaId) {
  const map = {};
  if (!db || !tarjetaId) return map;
  db.prepare('SELECT ciclo, fecha_corte FROM cortes_custom WHERE tarjeta_id=?').all(tarjetaId)
    .forEach(r => { map[r.ciclo] = r.fecha_corte; });
  return map;
}

module.exports = { getCorteCustom, getCortesCustomMap, cicloConCorte, siguienteCiclo, corteDeCiclo };
