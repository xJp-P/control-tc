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

const { daysBetween } = require('./dates');
const { aplicaIntInternacional } = require('./banco');

// Objetivo de bolsillo (COP) de una compra de 1 CUOTA = valor_cop + interés intl atribuido.
// Es el "costo real" de la compra: una internacional (Bancolombia Visa) no queda cubierta hasta
// apartar/reembolsar también su interés. Espejo EXACTO del branch COP de targetBolsillo (compras.js);
// se centraliza aquí para que el cruce de saldo a favor (saldosFavor.js) y el cap de /bolsillo usen
// el MISMO objetivo (evita el drift del interés intl que documenta CLAUDE.md). Nacional → valor_cop.
// NO resta monto_abonado: eso lo hace cada llamador según su contexto (saldo restante).
function objetivoBolsilloCop(db, c) {
  let tgt = c.valor_cop || 0;
  // Cuota SELLADA por reprogramación de saldo: su costo REAL es capital (valor_cop) + el interés que el
  // banco facturó por esa cuota (interes_sellado). Sin sumarlo, el tope del bolsillo se queda en el
  // capital y un tercero NO puede registrar su reembolso completo (el modal lo capa) → su deuda por esa
  // cuota nunca se salda. NULL en toda compra no sellada → COALESCE a 0 → cero regresión.
  tgt += Math.round(c.interes_sellado || 0);
  if (c.es_internacional && c.ciclo) {
    const tj = db.prepare('SELECT banco, franquicia, tasa_mv_avances, dia_corte FROM tarjetas WHERE id=?').get(c.tarjeta_id);
    if (tj && aplicaIntInternacional(tj.banco, tj.franquicia)) {
      const tasaIntl = (c.tasa_intl != null ? c.tasa_intl : (tj.tasa_mv_avances || 0.01911));
      const diaCorte = tj.dia_corte || 30;
      const [yr, mo] = c.ciclo.split('-').map(Number);
      const lastDay = new Date(yr, mo, 0).getDate();
      const fCorte = new Date(yr, mo - 1, Math.min(diaCorte, lastDay)).toISOString().slice(0, 10);
      const dias = daysBetween(c.fecha, fCorte);
      if (dias > 0) tgt += Math.round((c.valor_cop || 0) * tasaIntl * (dias / 30));
    }
  }
  return tgt;
}

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

// ¿La compra pertenece a un ciclo cuyo extracto YA se pagó? (v5.6.1)
//
// Es el invariante que `syncData` paso 6 (config/db.js) impone en CADA arranque: toda compra de un
// ciclo con extracto pagado DEBE estar en estado='pagado' (y su monto_abonado = valor_cop). Replica su
// criterio EXACTO, incluida la separación por moneda del extracto dual (estado → compras COP;
// estado_usd → compras con valor_usd > 0), para no divergir de él.
//
// Para qué sirve: el "Estado TC" de una compra es su estado CON EL BANCO, y NO lo decide el bolsillo
// (en una compra de tercero el bolsillo es el reembolso del deudor: otro libro, ver v4.4.1). Toda ruta
// que escriba el bolsillo debe CONGELAR el estado cuando el ciclo ya se pagó, en vez de re-derivarlo:
// si lo re-deriva, la fila queda contradiciendo el invariante (badge "Pendiente" en un mes ya pagado)
// hasta que el próximo arranque la repare. El libro del TERCERO (monto_bolsillo/tercero_pagado) sí se
// recalcula siempre: retirarle un reembolso debe volver a mostrarlo como deudor de inmediato.
function cicloYaPagado(db, c) {
  if (!c || !c.ciclo || !c.tarjeta_id) return false;
  const ext = db.prepare('SELECT estado, estado_usd FROM extractos WHERE tarjeta_id=? AND ciclo=?').get(c.tarjeta_id, c.ciclo);
  if (!ext) return false;
  const esUsd = c.valor_usd != null && c.valor_usd > 0;
  return esUsd ? ext.estado_usd === 'pagado' : ext.estado === 'pagado';
}

module.exports = { liberarBolsilloDiferida, liberarBolsilloAvance, compraTerceroConReembolso, objetivoBolsilloCop, cicloYaPagado };
