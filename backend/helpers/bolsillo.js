// backend/helpers/bolsillo.js — Liberación de bolsillo al abonar a capital / liquidar deudas.
//
// Cuando un abono a capital toca una diferida o un avance, su bolsillo per-cuota queda sin
// función: la plata apartada para esas cuotas se libera (igual que ya ocurre con las compras de
// 1 cuota). Estos helpers ponen ese bolsillo en 0 (per-cuota + cache) y devuelven el monto
// liberado en COP para reportarlo en la UI ("bolsillo liberado").
//
// Decisión de negocio (acordada): se libera SIEMPRE que el abono toque la deuda (total o parcial),
// no proporcional. Si queda saldo, el usuario re-aparta si quiere.
//
// GUARD CRÍTICO de Terceros: el bolsillo SOLO se libera en compras PERSONALES (persona_id IS NULL).
// En una compra de tercero, monto_bolsillo NO es plata propia: es cuánto me ha reembolsado el deudor
// (la vista Terceros y la card "Me Deben" calculan la deuda como valor_cop - monto_bolsillo).
// Vaciarlo borraría ese libro de deuda → jamás se toca.

// Diferida: el bolsillo vive en bolsillo_cuotas (vía la(s) compra(s) vinculada(s)) y se cachea en
// compras.monto_bolsillo / monto_bolsillo_usd. Libera solo las partes personales y devuelve el
// total liberado (COP). Las partes de tercero conservan su bolsillo intacto.
function liberarBolsilloDiferida(db, difId) {
  const comprasVinc = db.prepare('SELECT id, persona_id, COALESCE(monto_bolsillo,0) AS mb FROM compras WHERE diferida_id=?').all(difId);
  let liberado = 0;
  let huboTercero = false;
  for (const c of comprasVinc) {
    if (c.persona_id != null) { huboTercero = true; continue; } // tercero: reembolso del deudor, no tocar
    liberado += c.mb;
    db.prepare('DELETE FROM bolsillo_cuotas WHERE compra_id=?').run(c.id);
    db.prepare('UPDATE compras SET monto_bolsillo=0, monto_bolsillo_usd=0 WHERE id=?').run(c.id);
  }
  // Columna legacy en diferidas (standalone, sin compra vinculada). Solo si no hay partes de tercero.
  if (!huboTercero) db.prepare('UPDATE diferidas SET monto_bolsillo=0 WHERE id=?').run(difId);
  return Math.round(liberado);
}

// Avance: el bolsillo vive en bolsillo_cuotas_avance y se cachea en avances.monto_bolsillo.
function liberarBolsilloAvance(db, avId) {
  const row = db.prepare('SELECT COALESCE(monto_bolsillo,0) AS mb FROM avances WHERE id=?').get(avId);
  const liberado = row ? Math.round(row.mb) : 0;
  db.prepare('DELETE FROM bolsillo_cuotas_avance WHERE avance_id=?').run(avId);
  db.prepare('UPDATE avances SET monto_bolsillo=0 WHERE id=?').run(avId);
  return liberado;
}

// ¿Una compra de TERCERO ya tiene reembolsos registrados? (bolsillo, abono directo, marcada como
// pagada por el tercero, o bolsillo per-cuota con monto). Se usa para bloquear reprogramar/dividir
// y no destruir esa contabilidad. Para compras personales (persona_id NULL) devuelve false.
function compraTerceroConReembolso(db, compraId) {
  const c = db.prepare('SELECT persona_id, COALESCE(monto_bolsillo,0) mb, COALESCE(monto_bolsillo_usd,0) mbu, COALESCE(tercero_monto_abonado,0) tma, COALESCE(tercero_pagado,0) tp FROM compras WHERE id=?').get(compraId);
  if (!c || c.persona_id == null) return false;
  if (c.mb > 0 || c.mbu > 0 || c.tma > 0 || c.tp === 1) return true;
  const bc = db.prepare('SELECT COUNT(*) n FROM bolsillo_cuotas WHERE compra_id=? AND monto > 0').get(compraId);
  return !!(bc && bc.n > 0);
}

module.exports = { liberarBolsilloDiferida, liberarBolsilloAvance, compraTerceroConReembolso };
