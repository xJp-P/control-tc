// backend/helpers/banco.js — Bank and franchise detection helpers

// Cache: tarjeta_id → { esNu, esBancolombia, difiereInteresesCuota1 }
// Module-level cache survives for the lifetime of the process.
// Invalidar manualmente con clearBancoCache(id) cuando se edite una tarjeta.
const _bancoCache = {};

function _bancoInfo(db, tarjetaOrBancoOrId) {
  if (typeof tarjetaOrBancoOrId === 'number') {
    if (_bancoCache[tarjetaOrBancoOrId] === undefined) {
      const t = db && db.prepare('SELECT banco, difiere_intereses_cuota1 FROM tarjetas WHERE id=?').get(tarjetaOrBancoOrId);
      const b = t ? (t.banco || '').toLowerCase() : '';
      _bancoCache[tarjetaOrBancoOrId] = {
        esNu: b.includes('nu'),
        esBancolombia: b.includes('bancolombia'),
        // null = no configurado, 0 = no difiere, 1 = sí difiere
        difiereInteresesCuota1: t ? t.difiere_intereses_cuota1 : null
      };
    }
    return _bancoCache[tarjetaOrBancoOrId];
  }
  // String banco o objeto tarjeta — sin acceso a flag de BD, asumimos null
  const banco = (typeof tarjetaOrBancoOrId === 'string'
    ? tarjetaOrBancoOrId
    : (tarjetaOrBancoOrId && tarjetaOrBancoOrId.banco) || '').toLowerCase();
  const difiere = (tarjetaOrBancoOrId && typeof tarjetaOrBancoOrId === 'object')
    ? (tarjetaOrBancoOrId.difiere_intereses_cuota1 !== undefined ? tarjetaOrBancoOrId.difiere_intereses_cuota1 : null)
    : null;
  return {
    esNu: banco.includes('nu'),
    esBancolombia: banco.includes('bancolombia'),
    difiereInteresesCuota1: difiere
  };
}

/**
 * Determines if a tarjeta belongs to Nu Colombia.
 * Accepts: numeric id (looks up DB), string banco name, or tarjeta object.
 */
function esNuBank(db, tarjetaOrBancoOrId) {
  return _bancoInfo(db, tarjetaOrBancoOrId).esNu;
}

/**
 * Determines if a tarjeta belongs to Bancolombia.
 * Same input formats as esNuBank.
 */
function esBancolombiaBank(db, tarjetaOrBancoOrId) {
  return _bancoInfo(db, tarjetaOrBancoOrId).esBancolombia;
}

/**
 * Returns opts object for calcularAmortizacionDiferida based on the bank
 * AND the per-tarjeta flag `difiere_intereses_cuota1` (solo Bancolombia).
 *
 * Nombre original "nuOpts" — generalizado a múltiples bancos.
 *   - Nu Colombia                                   → { esNu: true }
 *   - Bancolombia con difiere_intereses_cuota1 = 1  → { esBancolombia: true }
 *   - Bancolombia con difiere = 0 ó null            → undefined (default conservador)
 *   - Otros bancos (RappiCard, etc.)                → undefined
 */
function nuOpts(db, tarjetaOrId) {
  const info = _bancoInfo(db, tarjetaOrId);
  if (info.esNu) return { esNu: true };
  if (info.esBancolombia && info.difiereInteresesCuota1 === 1) return { esBancolombia: true };
  return undefined;
}

/**
 * opts de amortización para una DIFERIDA CONCRETA (recibe la fila de la diferida, no un id).
 * Igual que nuOpts salvo por el "escape hatch" de la reprogramación de saldo: si la diferida trae
 * la bandera `sin_gracia_cuota1` (nació de POST /compras/:id/reprogramar-saldo), se amortiza SIN la
 * gracia de cuota 1 (ni Nu ni difiere_intereses_cuota1) → el banco no re-regala esa gracia sobre un
 * saldo ya en curso. Con la bandera en 0/ausente devuelve EXACTAMENTE nuOpts(db, dif.tarjeta_id)
 * (fallback idéntico → cero regresión en las diferidas existentes).
 */
function nuOptsDif(db, dif) {
  if (dif && dif.sin_gracia_cuota1) return undefined;
  const tid = (dif && typeof dif === 'object') ? dif.tarjeta_id : dif;
  return nuOpts(db, tid);
}

/**
 * Returns opts object for calcularAmortizacionAvance.
 * Bancolombia usa modelo "saldo facturado" para intereses de avances:
 *   cycle N >= 2 cobra intereses sobre (saldoInicio + cuotaCapital), no sobre
 *   saldoInicio amortizado. Reconciliado con extracto Visa Platinum abril 2026.
 *   Otros bancos usan modelo estándar (interés sobre saldo amortizado).
 */
function avanceOpts(db, tarjetaOrId) {
  const info = _bancoInfo(db, tarjetaOrId);
  if (info.esBancolombia) return { esBancolombia: true };
  return undefined;
}

/**
 * Limpia el cache de una tarjeta (o todo el cache si no se pasa id).
 * Llamar después de editar una tarjeta o cambiar su flag.
 */
function clearBancoCache(tarjetaId) {
  if (tarjetaId === undefined) {
    Object.keys(_bancoCache).forEach(k => delete _bancoCache[k]);
  } else {
    delete _bancoCache[tarjetaId];
  }
}

/**
 * Mastercard y American Express usan extracto dual (COP + USD separados).
 * Visa convierte USD a COP en un único extracto.
 */
function isDualExtracto(franquicia) {
  if (!franquicia) return false;
  const f = franquicia.toLowerCase();
  return f.includes('mastercard') || f.includes('american express') || f.includes('amex');
}

/**
 * ¿Aplica el cobro de intereses sobre compras internacionales en COP (es_internacional=1)?
 * Por ahora solo confirmado para Bancolombia Visa según extracto real reconciliado.
 * Mastercard y Amex usan extracto dual (USD separado), por lo que no aplican aquí.
 * Otros bancos (RappiCard, Nu, etc.) no han sido validados con extractos reales,
 * por lo que se excluyen hasta que el usuario provea evidencia.
 */
function aplicaIntInternacional(banco, franquicia) {
  if (!banco) return false;
  const b = String(banco).toLowerCase();
  if (!b.includes('bancolombia')) return false;
  return !isDualExtracto(franquicia);
}

module.exports = { esNuBank, esBancolombiaBank, nuOpts, nuOptsDif, avanceOpts, clearBancoCache, isDualExtracto, aplicaIntInternacional };
