// backend/helpers/banco.js — Bank and franchise detection helpers
const { cicloConCorte, getCortesCustomMap } = require('./cortes');
const { hoyLocal } = require('./dates');
const { fechaPagoProyectada } = require('./fechaPago');

// Cache: tarjeta_id → { esNu, esBancolombia, difiereInteresesCuota1 }
// Module-level cache survives for the lifetime of the process.
// Invalidar manualmente con clearBancoCache(id) cuando se edite una tarjeta.
const _bancoCache = {};

function _bancoInfo(db, tarjetaOrBancoOrId) {
  if (typeof tarjetaOrBancoOrId === 'number') {
    if (_bancoCache[tarjetaOrBancoOrId] === undefined) {
      const t = db && db.prepare('SELECT banco, franquicia, dia_pago, difiere_intereses_cuota1 FROM tarjetas WHERE id=?').get(tarjetaOrBancoOrId);
      const b = t ? (t.banco || '').toLowerCase() : '';
      _bancoCache[tarjetaOrBancoOrId] = {
        esNu: b.includes('nu'),
        esBancolombia: b.includes('bancolombia'),
        esRappi: b.includes('rappi') || b.includes('davivienda'),
        // null = no configurado, 0 = no difiere, 1 = sí difiere
        difiereInteresesCuota1: t ? t.difiere_intereses_cuota1 : null,
        // Lo que necesita la proyeccion de la fecha de pago (helpers/fechaPago.js).
        tj: t ? { banco: t.banco, franquicia: t.franquicia, dia_pago: t.dia_pago } : null
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
    esRappi: banco.includes('rappi') || banco.includes('davivienda'),
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
// Calendario de capital irregular de una diferida (null si su plan es uniforme, que es lo normal).
// El id llega como `id` (SELECT * FROM diferidas) o como `dif_id` (JOIN con compras en el dashboard):
// con solo `id`, ese JOIN se quedaba sin calendario irregular y sin nada de lo que se inyecta abajo.
const idDif = (dif) => (dif && typeof dif === 'object') ? (dif.id != null ? dif.id : (dif.dif_id != null ? dif.dif_id : null)) : null;

function capitalPorCuotaDe(db, dif) {
  if (!db || !dif || typeof dif !== 'object' || !idDif(dif)) return null;
  let filas;
  try { filas = db.prepare('SELECT cuota_num, capital FROM capital_cuotas WHERE diferida_id=?').all(idDif(dif)); }
  catch (e) { return null; }   // BD anterior a la tabla: se comporta como siempre
  if (!filas || !filas.length) return null;
  const m = {};
  filas.forEach(f => { m[f.cuota_num] = f.capital; });
  return m;
}

// ── Fecha en que se pago (o se pagara) el extracto de cada ciclo ─────────────────────────────────
// Bancolombia cobra interes sobre la cuota YA FACTURADA desde su corte hasta el dia en que se paga
// (saldo diario). Medido en tres extractos consecutivos de una Visa (jul/ago/sep-2026): sin ese termino
// el motor se quedaba corto en ~3% del interes de cada mes, y el termino se encogio justo en la
// proporcion en que se acorto el tiempo entre el corte y el pago (16 dias en agosto, 12 en septiembre). Devuelve una funcion
// (ciclo, fechaCorte) -> fecha ISO, que el motor puro consulta sin tocar la BD:
//   1) el dia REAL del pago, si el extracto del ciclo esta pagado (extractos.fecha_pagado);
//   2) la fecha limite impresa, si se fijo a mano o desde el PDF (fechas_pago_custom);
//   3) la fecha limite PROYECTADA (helpers/fechaPago.js): supone que se paga a tiempo.
const _sentencias = new WeakMap();
function _stmts(db) {
  let s = _sentencias.get(db);
  if (s === undefined) {
    // Una por una: si a la BD le falta UNA tabla o columna (anterior a su migracion), las demas siguen
    // sirviendo. Preparadas en bloque, la falta de la columna nueva tumbaba tambien la fecha REAL de pago.
    const prep = (sql) => { try { return db.prepare(sql); } catch (e) { return null; } };
    s = {
      ext: prep('SELECT estado, fecha_pagado FROM extractos WHERE tarjeta_id=? AND ciclo=?'),
      custom: prep('SELECT fecha_pago FROM fechas_pago_custom WHERE tarjeta_id=? AND ciclo=?'),
      dif: prep('SELECT tarjeta_id, interes_arrastrado, capital_facturado_previo FROM diferidas WHERE id=?'),
    };
    _sentencias.set(db, s);
  }
  return s;
}

function fechaPagoDeTarjeta(db, tarjetaId) {
  const info = _bancoInfo(db, Number(tarjetaId));
  if (!info.tj) return null;
  const st = _stmts(db);
  const memo = {};
  return (ciclo, fechaCorte) => {
    if (memo[ciclo] !== undefined) return memo[ciclo];
    let fp = null;
    const e = st.ext ? st.ext.get(tarjetaId, ciclo) : null;
    if (e && e.estado === 'pagado' && e.fecha_pagado) fp = String(e.fecha_pagado).slice(0, 10);
    if (!fp && st.custom) { const c = st.custom.get(tarjetaId, ciclo); if (c && c.fecha_pago) fp = String(c.fecha_pago).slice(0, 10); }
    if (!fp) fp = fechaPagoProyectada(info.tj, ciclo, fechaCorte);
    memo[ciclo] = fp;
    return fp;
  };
}

// Lo que se inyecta a la amortizacion de UNA diferida ademas de su gracia y su calendario:
//   fechaPagoDe        (solo Bancolombia) -> interes de la cuota facturada hasta el pago.
//   interesArrastrado  -> el interes de la cuota 1 que el plan ORIGINAL difirio y que esta hija de
//                         "Sellar y Renacer" cobra en su cuota 1 (si no, se perdia al reprogramar).
//   capitalFacturadoPrevio (solo Bancolombia) -> la ultima cuota SELLADA de esa reprogramacion, que
//                         devenga hasta el pago y lo cobra la cuota 1 de la hija.
// null = nada que inyectar (toda tarjeta que no es Bancolombia y no tiene arrastre).
function extrasDif(db, dif) {
  if (!db || !dif || typeof dif !== 'object') return null;
  let tarjetaId = dif.tarjeta_id, arrastrado = dif.interes_arrastrado, capPrevio = dif.capital_facturado_previo;
  const id = idDif(dif);
  if (id != null && (tarjetaId == null || arrastrado === undefined || capPrevio === undefined)) {
    const st = _stmts(db);
    const r = st.dif ? st.dif.get(id) : null;   // la fila llego sin esas columnas (JOIN o SELECT parcial)
    if (r) {
      if (tarjetaId == null) tarjetaId = r.tarjeta_id;
      if (arrastrado === undefined) arrastrado = r.interes_arrastrado;
      if (capPrevio === undefined) capPrevio = r.capital_facturado_previo;
    }
  }
  const out = {};
  if (tarjetaId != null && _bancoInfo(db, Number(tarjetaId)).esBancolombia) {
    const f = fechaPagoDeTarjeta(db, Number(tarjetaId));
    if (f) {
      out.fechaPagoDe = f;
      if (Number(capPrevio) > 0) out.capitalFacturadoPrevio = Number(capPrevio);
    }
  }
  if (Number(arrastrado) > 0) out.interesArrastrado = Number(arrastrado);
  return Object.keys(out).length ? out : null;
}

function nuOptsDif(db, dif) {
  // El calendario irregular se inyecta AQUI a proposito: este helper ya lo llaman los ~24 sitios que
  // amortizan una diferida almacenada, asi que el plan del banco llega a todos -extracto, dashboard,
  // terceros, proyecciones, syncData- sin tocar ninguno de ellos. Lo mismo el interes de la cuota
  // facturada y el arrastre de la cuota 1 (Fase B, oct-2026).
  const cap = capitalPorCuotaDe(db, dif);
  const extra = extrasDif(db, dif);
  if (!cap && !extra) {
    // Sin nada que inyectar se devuelve EXACTAMENTE lo de siempre (sin envolver en un objeto), para
    // que el comportamiento y la huella de los motores no se muevan ni un peso. Es el caso de toda
    // tarjeta que no es Bancolombia.
    if (dif && dif.sin_gracia_cuota1) return undefined;
    return nuOpts(db, (dif && typeof dif === 'object') ? dif.tarjeta_id : dif);
  }
  const base = (dif && dif.sin_gracia_cuota1) ? {} : (nuOpts(db, dif.tarjeta_id) || {});
  return Object.assign({}, base, cap ? { capitalPorCuota: cap } : {}, extra || {});
}

/**
 * Returns opts object for calcularAmortizacionAvance.
 * Bancolombia liquida sobre el SALDO DIARIO: el saldo sin facturar devenga el periodo completo y la
 * cuota ya facturada devenga hasta el dia en que se paga el extracto (fechaPagoDe). El viejo modelo
 * "saldo facturado" ((saldoInicio + cuotaCapital) x tasa) se descarto: contrastado contra tres
 * extractos consecutivos fallaba por mucho mas que este. Otros bancos: undefined (saldo amortizado).
 */
function avanceOpts(db, tarjetaOrId) {
  const info = _bancoInfo(db, tarjetaOrId);
  if (!info.esBancolombia) return undefined;
  // La cuota facturada de un avance tambien devenga hasta el pago (fue la mitad del termino medido).
  const f = (typeof tarjetaOrId === 'number') ? fechaPagoDeTarjeta(db, tarjetaOrId) : null;
  return f ? { esBancolombia: true, fechaPagoDe: f } : { esBancolombia: true };
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

/**
 * ¿El banco SOLO deja tocar el numero de cuotas mientras el extracto sigue ABIERTO?
 *
 * RappiCard/Davivienda: si. Confirmado por el Product Owner con el banco real — una vez cerrado el
 * extracto, la compra queda congelada y no acepta reprogramacion de ninguna clase. Bancolombia si
 * lo permite sobre meses cerrados (es justo lo que modela "Sellar y Renacer"), y por eso v5.8.0
 * derogo el candado por TIEMPO de forma global: aquella derogacion era correcta PARA BANCOLOMBIA.
 * La regla real siempre fue por banco, asi que aqui se reinstaura solo donde aplica.
 */
function soloCuotasCicloAbierto(db, tarjetaOrBancoOrId) {
  return _bancoInfo(db, tarjetaOrBancoOrId).esRappi;
}

/**
 * Aplica la regla anterior a un ciclo concreto. Devuelve el MENSAJE de bloqueo, o null si se puede.
 *
 * Punto UNICO de la regla: lo llaman los cuatro endpoints que alteran cuotas (convertir, revertir,
 * reprogramar y reprogramar-saldo) y tambien el GET que pinta la UI, para que el boton no ofrezca
 * jamas algo que el backend va a rechazar. "Cerrado" es el mismo criterio de esCicloCerrado:
 * ciclo < vigente CONSCIENTE del corte adelantado (cicloConCorte solo adelanta, nunca retrocede).
 */
function bloqueoCuotasCicloCerrado(db, tarjetaId, ciclo) {
  if (!ciclo || !soloCuotasCicloAbierto(db, tarjetaId)) return null;
  const tj = db.prepare('SELECT dia_corte, banco FROM tarjetas WHERE id=?').get(tarjetaId);
  const diaCorte = (tj && tj.dia_corte) || 30;
  const vigente = cicloConCorte(hoyLocal(), diaCorte, getCortesCustomMap(db, tarjetaId));
  if (ciclo >= vigente) return null;
  return (tj && tj.banco ? tj.banco : 'Esta tarjeta') + ' no permite cambiar las cuotas de un extracto ya cerrado (' + ciclo + '). Solo se pueden modificar las compras del extracto abierto (' + vigente + ').';
}

module.exports = { esNuBank, esBancolombiaBank, nuOpts, nuOptsDif, avanceOpts, clearBancoCache, isDualExtracto, aplicaIntInternacional, soloCuotasCicloAbierto, bloqueoCuotasCicloCerrado };
