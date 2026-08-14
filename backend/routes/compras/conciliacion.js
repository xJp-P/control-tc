'use strict';
// backend/routes/compras/conciliacion.js
//
// Rutas movidas VERBATIM desde compras.js. Se registran sobre el MISMO router que crea el
// archivo padre, no sobre un sub-router montado: asi el stack de Express conserva su
// forma y su ORDEN exactos, y el contrato que se ve desde fuera no cambia ni un apice.
const { hoyLocal } = require('../../helpers/dates');
const { getCortesCustomMap, cicloConCorte } = require('../../helpers/cortes');
const { elegirCicloDestino } = require('../../helpers/creditoReverso');

module.exports = function(router, ctx) {
  const { db, logAction, tjNombre, calcCiclo, avisoCifraOficial, esCicloPagado, esCicloCerrado, targetBolsillo } = ctx;

  // POST /api/compras/aplicar-tasa-intl — acción 1-clic del Asistente de Conciliación IA.
  // Body: { tarjeta_id, ciclo, tasa_intl, compra_ids }
  // Fija el snapshot de tasa internacional (compras.tasa_intl) de un conjunto de compras del
  // ciclo con la tasa REAL leída del extracto, para que el interés intl deje de calcularse con la
  // tasa global. Quirúrgico: SOLO toca tasa_intl (no bolsillo, estado ni nada más). Respeta la
  // inmutabilidad (403 si el extracto del ciclo ya está pagado). La IA solo PROPONE; este UPDATE
  // lo dispara el usuario tras confirmar en el modal — nunca el flujo de análisis.
  router.post('/aplicar-tasa-intl', (req, res) => {
    const { tarjeta_id, ciclo } = req.body || {};
    // Multi-grupo (split del día 1°): { grupos: [{ tasa_intl, compra_ids }] } aplica una tasa distinta
    // por mes. Compatibilidad: el formato viejo { tasa_intl, compra_ids } se trata como un solo grupo.
    let grupos = Array.isArray(req.body && req.body.grupos) ? req.body.grupos : null;
    if (!grupos && req.body && req.body.tasa_intl != null && req.body.tasa_intl !== '' && Array.isArray(req.body.compra_ids)) {
      grupos = [{ tasa_intl: req.body.tasa_intl, compra_ids: req.body.compra_ids }];
    }
    if (!tarjeta_id || !ciclo || !Array.isArray(grupos) || grupos.length === 0) {
      return res.status(400).json({ error: 'Faltan datos: se requieren tarjeta_id, ciclo y al menos un grupo (tasa_intl + compra_ids).' });
    }
    // Normalizar y validar cada grupo: tasa decimal mensual (> 0 y < 1, atrapa el error de mandar 2.0849
    // como porcentaje) + ids enteros válidos.
    const limpios = [];
    for (const g of grupos) {
      const tasa = Number(g && g.tasa_intl);
      if (!(tasa > 0) || tasa >= 1) {
        return res.status(400).json({ error: 'Cada tasa debe ser un decimal mensual válido (ej. 0.020849), no un porcentaje.' });
      }
      const ids = (Array.isArray(g.compra_ids) ? g.compra_ids : []).map(Number).filter(n => Number.isInteger(n) && n > 0);
      if (ids.length) limpios.push({ tasa, ids });
    }
    if (!limpios.length) return res.status(400).json({ error: 'Ningún grupo trae compra_ids válidos.' });
    // Inmutabilidad: un ciclo cerrado/pagado no admite cambios (espejo del resto de endpoints).
    const ext = db.prepare("SELECT estado FROM extractos WHERE tarjeta_id=? AND ciclo=?").get(tarjeta_id, ciclo);
    if (ext && ext.estado === 'pagado') {
      return res.status(403).json({ error: 'No se puede aplicar: el extracto del ciclo ' + ciclo + ' ya está pagado.' });
    }
    // Transacción: cada grupo fija SU tasa en sus compras, acotado a esta tarjeta+ciclo (el WHERE evita
    // tocar nada fuera del alcance conciliado).
    let total = 0;
    const aplicar = db.transaction(() => {
      for (const g of limpios) {
        const placeholders = g.ids.map(() => '?').join(',');
        const info = db.prepare(`UPDATE compras SET tasa_intl=? WHERE tarjeta_id=? AND ciclo=? AND id IN (${placeholders})`)
          .run(g.tasa, tarjeta_id, ciclo, ...g.ids);
        total += info.changes;
      }
    });
    aplicar();
    logAction('editar', tjNombre(tarjeta_id) + 'Tasa internacional del ciclo ' + ciclo + ' sincronizada (' + limpios.length + ' tasa(s)) para ' + total + ' compra(s)');
    res.json({ ok: true, actualizadas: total, grupos: limpios.length });
  });

  // ── Aplicar corte ADELANTADO de un ciclo (cortes_custom) ──────────────────────
  // POST /aplicar-corte-ciclo  Body: { tarjeta_id, ciclo, fecha_corte }
  // Persiste la fecha de corte REAL de un ciclo (el banco adelantó el corte) y re-evalúa las compras
  // de la tarjeta para que las hechas DESPUÉS de ese corte salten al ciclo siguiente de inmediato; las
  // futuras se auto-asignarán al crearse (calcCiclo ya consulta cortes_custom). Lo dispara la
  // conciliación IA (discrepancia fecha_corte_movida); NO toca el dia_corte global de la tarjeta.
  router.post('/aplicar-corte-ciclo', (req, res) => {
    const { tarjeta_id, ciclo, fecha_corte } = req.body || {};
    if (!tarjeta_id || !ciclo || !fecha_corte) {
      return res.status(400).json({ error: 'Faltan datos: tarjeta_id, ciclo y fecha_corte son requeridos.' });
    }
    const fc = String(fecha_corte).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fc)) return res.status(400).json({ error: 'fecha_corte debe tener formato YYYY-MM-DD.' });
    // Sanity: el corte real debe caer dentro del mes del ciclo afectado.
    if (fc.slice(0, 7) !== ciclo) return res.status(400).json({ error: 'La fecha de corte (' + fc + ') no pertenece al ciclo ' + ciclo + '.' });
    // Inmutabilidad: un ciclo ya pagado no se reabre.
    const extC = db.prepare("SELECT estado FROM extractos WHERE tarjeta_id=? AND ciclo=?").get(tarjeta_id, ciclo);
    if (extC && extC.estado === 'pagado') {
      return res.status(403).json({ error: 'No se puede fijar el corte: el extracto del ciclo ' + ciclo + ' ya está pagado.' });
    }
    let movidas = 0;
    const aplicar = db.transaction(() => {
      // 1. Persistir el corte real (upsert: un registro por tarjeta+ciclo).
      db.prepare('INSERT INTO cortes_custom (tarjeta_id, ciclo, fecha_corte) VALUES (?,?,?) ON CONFLICT(tarjeta_id, ciclo) DO UPDATE SET fecha_corte=excluded.fecha_corte')
        .run(tarjeta_id, ciclo, fc);
      // 2. Re-evaluar las compras de la tarjeta (mismo núcleo que syncData paso 5): las de la ventana
      //    saltan al ciclo siguiente; el resto queda igual. ciclo_manual prevalece (no se toca) y no se
      //    mueve nada HACIA un ciclo ya pagado (protege cierres reales).
      const tj = db.prepare('SELECT dia_corte FROM tarjetas WHERE id=?').get(tarjeta_id);
      const diaCorte = (tj && tj.dia_corte) || 30;
      const cortesMap = getCortesCustomMap(db, tarjeta_id);
      const compras = db.prepare("SELECT id, fecha, ciclo, COALESCE(ciclo_manual,0) as ciclo_manual FROM compras WHERE tarjeta_id=?").all(tarjeta_id);
      for (const c of compras) {
        if (!c.fecha || c.ciclo_manual) continue;
        const nuevo = cicloConCorte(c.fecha, diaCorte, cortesMap);
        if (nuevo !== c.ciclo) {
          const extDest = db.prepare("SELECT estado FROM extractos WHERE tarjeta_id=? AND ciclo=?").get(tarjeta_id, nuevo);
          if (extDest && extDest.estado === 'pagado') continue;
          db.prepare('UPDATE compras SET ciclo=? WHERE id=?').run(nuevo, c.id);
          movidas++;
        }
      }
    });
    aplicar();
    logAction('editar', tjNombre(tarjeta_id) + 'Corte adelantado fijado para ' + ciclo + ': ' + fc + ' (' + movidas + ' compra(s) reubicada(s))');
    res.json({ ok: true, fecha_corte: fc, movidas });
  });

  // ── Reverso manual de una compra (Fase 3, reversos/refunds) ───────────────
  // POST /:id/reversar  → el banco devolvió (reversó) la compra.
  //   • Neutraliza la compra como deuda SIN borrar su valor histórico: estado='pagado',
  //     monto_abonado=valor_cop. Tercero → tercero_pagado=1 (sale de "Me deben"). Personal →
  //     libera el bolsillo apartado (ya no hay que pagarla).
  //   • Tercero que YA reembolsó (monto_bolsillo>0): crea un Saldo a Favor a su nombre por ese
  //     monto (el banco te devolvió dinero que el tercero ya te había pagado — caso LATAM).
  //   • Marca compras.reversada=1 (idempotencia + badge). NO aplica los candados de ciclo cerrado/
  //     pagado: un reverso es un evento real del banco sobre cualquier compra, nueva o antigua.
  // Alcance v1: solo compras de 1 cuota en COP (diferidas, divididas y USD puras quedan fuera).
  router.post('/:id/reversar', (req, res) => {
    const c = db.prepare('SELECT * FROM compras WHERE id=?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Compra no encontrada' });
    // Idempotencia: por el flag y por un crédito de reverso ya existente (ej. el crédito LATAM
    // sembrado antes de existir la columna reversada).
    const yaCredito = db.prepare("SELECT id FROM saldos_favor_tercero WHERE origen_tipo='reverso' AND origen_compra_id=?").get(c.id);
    if (c.reversada || yaCredito) return res.status(409).json({ error: 'Esta compra ya fue reversada.' });
    if (c.grupo_id) return res.status(400).json({ error: 'Para reversar una compra dividida, revierte primero la división o reversa cada parte por separado.' });
    if (c.estado === 'diferida' || c.diferida_id) return res.status(400).json({ error: 'El reverso de compras diferidas aún no está soportado (solo compras de 1 cuota).' });
    if ((c.valor_usd || 0) > 0 && !(c.valor_cop > 0)) return res.status(400).json({ error: 'El reverso de compras en dólares aún no está soportado (solo COP).' });

    const esTercero = c.persona_id != null;
    const reembolso = esTercero ? Math.round(c.monto_bolsillo || 0) : 0; // lo que el tercero ya te reembolsó
    let creditoId = null, creditoReversoId = null, cicloDestino = null;
    db.transaction(() => {
      if (esTercero) {
        // Conserva monto_bolsillo (registro del reembolso); tercero_pagado=1 lo saca de "Me deben".
        db.prepare("UPDATE compras SET reversada=1, estado='pagado', monto_abonado=valor_cop, tercero_pagado=1 WHERE id=?").run(c.id);
      } else {
        // PERSONAL (v5.9.9): el cargo SIGUE VIVO en su ciclo — el banco lo factura igual — y el
        // dinero devuelto sale como crédito hacia un ciclo anterior. Antes se ponía
        // monto_abonado=valor_cop, que lo anulaba en SU ciclo: el total cuadraba pero el mes no.
        // `reversada=1` se conserva y es lo que pinta el badge, así que la compra nunca vuelve a
        // parecer una compra normal. Se libera el bolsillo: ya no hay que apartar para pagarla.
        db.prepare("UPDATE compras SET reversada=1, monto_bolsillo=0, monto_bolsillo_usd=0 WHERE id=?").run(c.id);
        const monto = Math.round(c.valor_cop);
        // Imputación AUTOMÁTICA al ciclo abierto más reciente anterior al de la compra (waterfall
        // oldest-first del banco). Sin destino disponible el crédito queda 'activo' esperando.
        cicloDestino = elegirCicloDestino(db, c.tarjeta_id, c.ciclo);
        const info = db.prepare(`INSERT INTO creditos_reverso
            (tarjeta_id, origen_compra_id, monto, fecha, ciclo_origen, ciclo_destino, estado, descripcion, notas)
            VALUES (?,?,?,?,?,?,?,?,?)`)
          .run(c.tarjeta_id, c.id, monto, hoyLocal(), c.ciclo, cicloDestino,
               cicloDestino ? 'aplicado' : 'activo',
               'Reverso de ' + c.descripcion,
               cicloDestino
                 ? 'El banco devolvio esta compra y aplico el dinero al ciclo ' + cicloDestino + '.'
                 : 'El banco devolvio esta compra. Sin ciclo anterior abierto al que aplicarlo.');
        creditoReversoId = info.lastInsertRowid;
      }
      if (reembolso > 0) {
        const info = db.prepare(`INSERT INTO saldos_favor_tercero
            (persona_id, monto, origen_tipo, origen_compra_id, tarjeta_id, descripcion, fecha, notas)
            VALUES (?,?, 'reverso', ?,?,?,?,?)`)
          .run(c.persona_id, reembolso, c.id, c.tarjeta_id, 'Reverso de ' + c.descripcion, hoyLocal(),
               'Reverso manual: el banco devolvió esta compra que el tercero ya había reembolsado.');
        creditoId = info.lastInsertRowid;
      }
    })();
    logAction('editar', tjNombre(c.tarjeta_id) + 'Compra reversada: ' + c.descripcion +
      (creditoId ? ' → saldo a favor de ' + reembolso : '') +
      (cicloDestino ? ' → credito de ' + Math.round(c.valor_cop) + ' aplicado al ciclo ' + cicloDestino : ''));
    res.json({ ok: true, credito_creado: creditoId != null, credito_id: creditoId, monto_favor: reembolso, persona_id: c.persona_id,
      credito_reverso_id: creditoReversoId, ciclo_destino: cicloDestino, monto_credito: esTercero ? 0 : Math.round(c.valor_cop) });
  });
};
