'use strict';
// backend/routes/compras/division.js
//
// Rutas movidas VERBATIM desde compras.js. Se registran sobre el MISMO router que crea el
// archivo padre, no sobre un sub-router montado: asi el stack de Express conserva su
// forma y su ORDEN exactos, y el contrato que se ve desde fuera no cambia ni un apice.
const { Router } = require('express');
const { hoyLocal, daysBetween, primerCorteAvance } = require('../../helpers/dates');
const { calcularAmortizacionDiferida } = require('../../engine/amortizacion');
const { nuOpts, nuOptsDif, aplicaIntInternacional } = require('../../helpers/banco');
const { compraTerceroConReembolso, objetivoBolsilloCop, cicloYaPagado } = require('../../helpers/bolsillo');
const { getCortesCustomMap, cicloConCorte, corteDeCiclo } = require('../../helpers/cortes');
const { tasaIntlEnFecha } = require('../../helpers/tasas');
const { pagoMinimoOficial } = require('../../helpers/extractoOficial');

module.exports = function(router, ctx) {
  const { db, logAction, tjNombre, calcCiclo, avisoCifraOficial, esCicloPagado, esCicloCerrado, targetBolsillo } = ctx;

  // ── Convertir compra dividida (grupo) → 100% personal ──────────────
  // Fusiona todas las partes de un grupo_id en una sola compra personal
  // (persona_id=NULL). Suma valores y bolsillo (= mi plata apartada, se conserva).
  // Soporta compras a 1 cuota y diferidas (merge matemáticamente limpio: la
  // amortización es lineal en el monto, así que el resultado per-cuota = suma
  // de las partes).
  //
  // Bloqueo crítico: si alguna parte tiene reembolso REAL de tercero
  // (tercero_pagado=1 o tercero_monto_abonado>0), responde 409 con el detalle y
  // NO procede — salvo que el cliente envíe { force: true } (escape hatch con
  // doble confirmación en la UI). force borra esos abonos de terceros.
  router.post('/grupo/:grupoId/merge-personal', (req, res) => {
    const grupoId = req.params.grupoId;
    const force = !!(req.body && req.body.force);

    const partes = db.prepare('SELECT * FROM compras WHERE grupo_id=?').all(grupoId);
    if (!partes || partes.length === 0) return res.status(404).json({ error: 'Grupo no encontrado' });

    // Inmutabilidad: ninguna parte puede caer en un ciclo con extracto pagado.
    for (const p of partes) {
      const ext = db.prepare("SELECT estado FROM extractos WHERE tarjeta_id=? AND ciclo=?").get(p.tarjeta_id, p.ciclo);
      if (ext && ext.estado === 'pagado') {
        return res.status(403).json({ error: 'No se puede convertir: el extracto del ciclo ' + p.ciclo + ' ya está pagado.' });
      }
    }
    // Inmutabilidad estructural (cerrado ≠ pagado): fundir el grupo borra las partes de terceros
    // de un extracto que el banco ya facturó. Sin exención: la conciliación IA no fusiona grupos.
    const parteCerrada = partes.find(p => esCicloCerrado(p.tarjeta_id, p.ciclo));
    if (parteCerrada) {
      return res.status(403).json({ error: 'No se puede convertir: la compra pertenece al ciclo ' + parteCerrada.ciclo + ', que ya cerró (el banco ya generó ese extracto).' });
    }

    // Bloqueo crítico: reembolsos reales de terceros (no confundir con bolsillo, que es mi plata).
    const conAbono = partes.filter(p => p.persona_id && (p.tercero_pagado || (p.tercero_monto_abonado || 0) > 0));
    if (conAbono.length > 0 && !force) {
      const detalle = conAbono.map(p => {
        const per = db.prepare('SELECT nombre FROM personas WHERE id=?').get(p.persona_id);
        const monto = (p.tercero_monto_abonado || 0) > 0 ? p.tercero_monto_abonado : p.valor_cop;
        return { persona_nombre: per ? per.nombre : 'Tercero', monto: Math.round(monto) };
      });
      const total = detalle.reduce((s, d) => s + d.monto, 0);
      return res.status(409).json({
        error: 'tercero_abonos',
        needsForce: true,
        detalle,
        total,
        message: 'Hay dinero reembolsado por terceros que se eliminará si continúas.'
      });
    }

    const esDiferida = partes.some(p => p.estado === 'diferida' && p.diferida_id);

    const compraIdFinal = db.transaction(() => {
      // Survivor: la parte personal si existe; si no, la primera parte.
      const survivor = partes.find(p => p.persona_id == null) || partes[0];
      const otras = partes.filter(p => p.id !== survivor.id);

      const sumCop = partes.reduce((s, p) => s + (p.valor_cop || 0), 0);
      const sumUsd = partes.reduce((s, p) => s + (p.valor_usd || 0), 0);

      let survivorDiferidaId = survivor.diferida_id || null;
      let bolsilloCop, bolsilloUsd;

      if (esDiferida) {
        // Diferida base: la del survivor, o la de cualquier parte que tenga.
        let baseDif = survivor.diferida_id ? db.prepare('SELECT * FROM diferidas WHERE id=?').get(survivor.diferida_id) : null;
        if (!baseDif) {
          const anyP = partes.find(p => p.diferida_id);
          if (anyP) baseDif = db.prepare('SELECT * FROM diferidas WHERE id=?').get(anyP.diferida_id);
        }
        if (baseDif) {
          survivorDiferidaId = baseDif.id;
          db.prepare('UPDATE diferidas SET monto=? WHERE id=?').run(sumCop, baseDif.id);
          // Merge bolsillo_cuotas por (cuota_num, moneda) hacia el survivor.
          const ph = partes.map(() => '?').join(',');
          const allBol = db.prepare(`SELECT cuota_num, monto, COALESCE(moneda,'COP') as moneda FROM bolsillo_cuotas WHERE compra_id IN (${ph})`).all(...partes.map(p => p.id));
          const agg = {};
          allBol.forEach(b => { const k = b.cuota_num + '|' + b.moneda; agg[k] = (agg[k] || 0) + b.monto; });
          db.prepare('DELETE FROM bolsillo_cuotas WHERE compra_id=?').run(survivor.id);
          const insBol = db.prepare('INSERT INTO bolsillo_cuotas (compra_id, cuota_num, monto, moneda) VALUES (?,?,?,?)');
          Object.keys(agg).forEach(k => {
            if (agg[k] <= 0) return;
            const [cn, mon] = k.split('|');
            insBol.run(survivor.id, parseInt(cn), agg[k], mon);
          });
        }
        // Recompute caches desde las cuotas agregadas del survivor.
        const cCop = db.prepare("SELECT COALESCE(SUM(monto),0) as t FROM bolsillo_cuotas WHERE compra_id=? AND COALESCE(moneda,'COP')='COP'").get(survivor.id);
        const cUsd = db.prepare("SELECT COALESCE(SUM(monto),0) as t FROM bolsillo_cuotas WHERE compra_id=? AND moneda='USD'").get(survivor.id);
        bolsilloCop = cCop.t;
        bolsilloUsd = cUsd.t;
      } else {
        // 1-cuota: bolsillo = suma de los caches de las partes.
        bolsilloCop = partes.reduce((s, p) => s + (p.monto_bolsillo || 0), 0);
        bolsilloUsd = partes.reduce((s, p) => s + (p.monto_bolsillo_usd || 0), 0);
      }

      // Survivor → personal.
      db.prepare(`UPDATE compras SET persona_id=NULL, valor_cop=?, valor_usd=?, monto_bolsillo=?, monto_bolsillo_usd=?, grupo_id=NULL, tercero_pagado=0, tercero_monto_abonado=0, diferida_id=? WHERE id=?`)
        .run(sumCop, sumUsd || null, bolsilloCop, bolsilloUsd, survivorDiferidaId, survivor.id);

      // Recompute estado para 1-cuota (las diferidas conservan estado='diferida').
      if (!esDiferida) {
        const esUsdPura = (sumUsd > 0) && !sumCop;
        const target = esUsdPura ? sumUsd : sumCop;
        const bolCmp = esUsdPura ? bolsilloUsd : bolsilloCop;
        const nuevoEstado = (target > 0 && bolCmp >= target) ? 'bolsillo' : (bolCmp > 0 ? 'bolsillo_parcial' : 'pendiente');
        db.prepare('UPDATE compras SET estado=? WHERE id=?').run(nuevoEstado, survivor.id);
      }

      // Borrar las otras partes (cascade limpia sus bolsillo_cuotas) y sus diferidas huérfanas.
      for (const p of otras) {
        db.prepare('DELETE FROM compras WHERE id=?').run(p.id);
        if (p.diferida_id && p.diferida_id !== survivorDiferidaId) {
          const ref = db.prepare('SELECT COUNT(*) as n FROM compras WHERE diferida_id=?').get(p.diferida_id);
          if (!ref || ref.n === 0) db.prepare('DELETE FROM diferidas WHERE id=?').run(p.diferida_id);
        }
      }

      return survivor.id;
    })();

    logAction('editar', tjNombre(partes[0].tarjeta_id) + 'Compra dividida convertida a 100% personal: ' + partes[0].descripcion + (force && conAbono.length > 0 ? ' (abonos de terceros eliminados)' : ''));
    res.json({ ok: true, compraId: compraIdFinal });
  });

  // ── Reprogramar dividiendo en cuotas individuales (Ruta C: irregular) ─────────
  // Convierte una compra a cuotas (diferida) en N compras de 1 cuota con ciclo_manual, cada una con
  // su propio monto/ciclo. Modela las reprogramaciones IRREGULARES del banco (cuotas de distinto
  // monto/fecha) que una diferida uniforme no representa. La diferida queda sin compras → se elimina.
  // Espejo del patrón manual previo (modelar con varios movimientos de 1 cuota).
  // Body: { cuotas: [{ ciclo, monto, fecha?, es_internacional? }] } (1+ elementos).
  router.post('/:id/dividir-cuotas', (req, res) => {
    const { cuotas } = req.body || {};
    const c = db.prepare('SELECT * FROM compras WHERE id=?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Compra no encontrada' });
    if (!Array.isArray(cuotas) || cuotas.length < 1) return res.status(400).json({ error: 'Se requiere un arreglo de cuotas con al menos un elemento.' });
    for (const q of cuotas) {
      if (!q || !q.ciclo || !(Number(q.monto) > 0)) return res.status(400).json({ error: 'Cada cuota requiere ciclo (YYYY-MM) y monto > 0.' });
    }

    // Guard de Terceros: no dividir si la compra es de un tercero con reembolsos registrados
    // (reestructurarla en cuotas individuales perdería ese libro de deuda). Gestiónalos en Terceros.
    if (compraTerceroConReembolso(db, c.id)) {
      return res.status(403).json({ error: 'No se puede dividir: esta compra es de un tercero y ya tiene reembolsos registrados. Gestiona o retira esos abonos desde la pestaña Terceros antes de dividir.' });
    }

    // Inmutabilidad: ni el ciclo actual de la compra ni ningún ciclo destino puede estar pagado.
    const ciclosCheck = [...new Set([c.ciclo, ...cuotas.map(q => q.ciclo)])];
    for (const ci of ciclosCheck) {
      const ext = db.prepare("SELECT estado FROM extractos WHERE tarjeta_id=? AND ciclo=?").get(c.tarjeta_id, ci);
      if (ext && ext.estado === 'pagado') {
        return res.status(403).json({ error: 'No se puede dividir: el extracto del ciclo ' + ci + ' ya está pagado.' });
      }
    }
    // v5.8.0: DEROGADO el candado por TIEMPO sobre el ciclo actual y los destinos. El guard de
    // PAGADOS de arriba (que cubre TODOS los ciclos involucrados) es el único cierre.

    const n = cuotas.length;
    const ids = db.transaction(() => {
      const difId = c.diferida_id;
      // Cuota 1: reutiliza la compra original (1 cuota, ciclo_manual). Se desvincula de la diferida
      // y se limpia su bolsillo per-cuota.
      const q0 = cuotas[0];
      db.prepare('DELETE FROM bolsillo_cuotas WHERE compra_id=?').run(c.id);
      db.prepare(`UPDATE compras SET estado='pendiente', valor_cop=?, valor_usd=NULL, tasa_usd=NULL, fecha=?, ciclo=?, ciclo_manual=1, es_internacional=?, diferida_id=NULL, monto_bolsillo=0, monto_bolsillo_usd=0, descripcion=? WHERE id=?`)
        .run(Math.round(q0.monto), q0.fecha || c.fecha, q0.ciclo, q0.es_internacional ? 1 : 0, c.descripcion + ' (cuota 1/' + n + ')', c.id);
      const out = [c.id];
      // Cuotas 2..N: nuevas compras de 1 cuota con ciclo_manual.
      for (let i = 1; i < n; i++) {
        const q = cuotas[i];
        const r = db.prepare(`INSERT INTO compras (tarjeta_id, fecha, descripcion, valor_cop, persona_id, estado, ciclo, notas, es_internacional, ciclo_manual)
                              VALUES (?,?,?,?,?,?,?,?,?,1)`)
          .run(c.tarjeta_id, q.fecha || c.fecha, c.descripcion + ' (cuota ' + (i + 1) + '/' + n + ')', Math.round(q.monto), c.persona_id || null, 'pendiente', q.ciclo, c.notas || null, q.es_internacional ? 1 : 0);
        out.push(r.lastInsertRowid);
      }
      // La diferida quedó sin compras vinculadas → eliminarla (cascade limpia sus bolsillo_cuotas).
      if (difId) {
        const ref = db.prepare('SELECT COUNT(*) as n FROM compras WHERE diferida_id=?').get(difId);
        if (!ref || ref.n === 0) db.prepare('DELETE FROM diferidas WHERE id=?').run(difId);
      }
      return out;
    })();

    logAction('editar', tjNombre(c.tarjeta_id) + 'Compra dividida en ' + n + ' cuotas individuales: ' + c.descripcion);
    res.json({ ok: true, ids });
  });
};
