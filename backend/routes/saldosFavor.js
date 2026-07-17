// backend/routes/saldosFavor.js — /api/saldos-favor
// Saldos a Favor de terceros (Fase 2 — reversos). Ledger de dos tablas:
//   saldos_favor_tercero      → los créditos (nacen de un reverso de compra ya reembolsada).
//   aplicaciones_saldo_favor  → a qué deuda del MISMO tercero (o cashout) se adjudicó cada crédito.
// La app NUNCA cruza el crédito de un tercero con deudas de OTRO (regla de negocio v4.7.5).
const { Router } = require('express');
const { hoyLocal } = require('../helpers/dates');
const { objetivoBolsilloCop, cicloYaPagado } = require('../helpers/bolsillo');

module.exports = function(db, { logAction }) {
  const router = Router();
  const fmt = (n) => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(Math.round(n));
  const r2 = (n) => Math.round((n || 0) * 100) / 100;

  // Aplica a la compra el resultado de un cruce/deshacer respetando los DOS libros (v5.6.1):
  //   BANCO   → `estado`: si el ciclo YA se pagó, se CONGELA (es el invariante de syncData paso 6; el
  //             bolsillo del tercero no puede reabrir un mes cerrado). Si no, se deriva como siempre.
  //   TERCERO → `monto_bolsillo` + `tercero_pagado`: se recalculan SIEMPRE, incluso en un ciclo pagado.
  //             `tercero_pagado` sale del estado DERIVADO (lo que el bolsillo dice de su deuda), nunca
  //             del congelado: si no, retirarle el reembolso a una compra de un mes pagado lo dejaría
  //             marcado como que pagó.
  // Así deshacer un cruce histórico retira el dinero y lo devuelve al crédito sin tocar el cierre del
  // ciclo — que es justo lo que ya se puede hacer con el botón "Bolsillo" normal.
  function aplicarBolsilloATercero(destino, nuevoBolsillo, opts) {
    opts = opts || {};
    const estadoDerivado = derivarEstadoCompra(destino, nuevoBolsillo);
    const estadoFinal = cicloYaPagado(db, destino) ? destino.estado : estadoDerivado;
    const saldado = (estadoDerivado === 'bolsillo' || estadoDerivado === 'pagado');
    // `conservarTerceroPagado` (solo al APLICAR): un cruce PARCIAL no borra un "Recibido" que el usuario
    // hubiera marcado a mano (v4.8.2). Al DESHACER no se conserva: retirarle el reembolso debe devolverlo
    // a deudor.
    const terceroPagado = saldado ? 1 : (opts.conservarTerceroPagado ? (destino.tercero_pagado || 0) : 0);
    db.prepare('UPDATE compras SET monto_bolsillo=?, estado=?, tercero_pagado=? WHERE id=?')
      .run(nuevoBolsillo, estadoFinal, terceroPagado, destino.id);
    return { estadoFinal, estadoDerivado, terceroPagado };
  }

  // Re-deriva el estado de una compra de 1 cuota tras cambiar su monto_bolsillo (reembolso del tercero).
  // Las diferidas conservan 'diferida' (usan bolsillo per-cuota, fuera del alcance de v1).
  function derivarEstadoCompra(c, nuevoBolsillo) {
    if (c.estado === 'diferida') return 'diferida';
    // El tercero no queda saldado hasta cubrir valor + interés (intl, o el de una cuota SELLADA vía
    // interes_sellado) — no solo el capital. Mismo objetivo que el cap de /bolsillo, la tabla principal
    // y la card "Me Deben" del dashboard (v4.8.2).
    // NO se resta monto_abonado en compras de TERCERO: ahí es lo que YO le pagué al banco, no algo que
    // reduzca lo que él me debe. Restarlo hacía que un cruce sobre una cuota sellada de ciclo pagado
    // (monto_abonado=capital) marcara 'pagado'/tercero_pagado=1 y BORRARA su deuda real.
    const saldo = r2(objetivoBolsilloCop(db, c) - (c.persona_id ? 0 : (c.monto_abonado || 0)));
    if (saldo <= 0) return 'pagado';
    return nuevoBolsillo >= saldo ? 'bolsillo' : (nuevoBolsillo > 0 ? 'bolsillo_parcial' : 'pendiente');
  }

  // GET / — créditos (con disponible + persona) + resumen por persona. ?persona_id opcional.
  router.get('/', (req, res) => {
    const { persona_id } = req.query;
    let sql = `SELECT s.*, (s.monto - s.monto_aplicado) as disponible,
                 p.nombre as persona_nombre, p.color as persona_color
               FROM saldos_favor_tercero s JOIN personas p ON s.persona_id = p.id`;
    const params = [];
    if (persona_id) { sql += ' WHERE s.persona_id = ?'; params.push(persona_id); }
    sql += ' ORDER BY s.fecha DESC, s.id DESC';
    const creditos = db.prepare(sql).all(...params);
    // Adjunta las aplicaciones (cruces/liquidaciones) de cada crédito → ledger + deshacer en el modal.
    // `compra_estado`/`compra_ciclo` son informativos (la UI muestra de qué mes es cada movimiento).
    // TODO movimiento es deshacible: el deshacer respeta el cierre del ciclo en vez de bloquearse (v5.6.1).
    const apStmt = db.prepare(`SELECT a.*, c.descripcion as compra_desc, c.estado as compra_estado,
                                      c.ciclo as compra_ciclo
                               FROM aplicaciones_saldo_favor a
                               LEFT JOIN compras c ON a.compra_destino_id = c.id
                               WHERE a.saldo_favor_id = ? ORDER BY a.fecha, a.id`);
    creditos.forEach(cr => { cr.aplicaciones = apStmt.all(cr.id); });
    // porPersona: total disponible de créditos ACTIVOS (el monto que muestra el chip en verde). Con
    // disponible 0 el chip sigue visible pero en gris ("Ver historial"): el ledger se puede consultar y
    // deshacer, pero sin aparentar plata por gestionar.
    const porPersona = {};
    db.prepare(`SELECT persona_id, COALESCE(SUM(monto - monto_aplicado), 0) as disponible
                FROM saldos_favor_tercero WHERE estado = 'activo' GROUP BY persona_id`).all()
      .forEach(row => { porPersona[row.persona_id] = Math.round(row.disponible); });
    res.json({ creditos, porPersona });
  });

  // GET /:id/aplicaciones — ledger de un crédito (detalle + para deshacer). Hoy sin consumidores (el
  // modal usa las `aplicaciones` que ya adjunta GET /); se mantiene alineado con el mismo contrato.
  router.get('/:id/aplicaciones', (req, res) => {
    const aps = db.prepare(`SELECT a.*, c.descripcion as compra_desc, c.estado as compra_estado,
                                   c.ciclo as compra_ciclo
                            FROM aplicaciones_saldo_favor a
                            LEFT JOIN compras c ON a.compra_destino_id = c.id
                            WHERE a.saldo_favor_id = ? ORDER BY a.fecha, a.id`).all(req.params.id);
    res.json(aps);
  });

  // POST / — crear un crédito (reverso manual, script LATAM o, a futuro, la acción IA aplicar_reversion_compra).
  router.post('/', (req, res) => {
    const { persona_id, monto, origen_tipo, origen_compra_id, tarjeta_id, descripcion, fecha, notas } = req.body;
    if (!persona_id || !(Number(monto) > 0)) return res.status(400).json({ error: 'persona_id y monto (>0) son requeridos' });
    const persona = db.prepare('SELECT id, nombre FROM personas WHERE id=?').get(persona_id);
    if (!persona) return res.status(404).json({ error: 'Persona no encontrada' });
    const info = db.prepare(`INSERT INTO saldos_favor_tercero
        (persona_id, monto, origen_tipo, origen_compra_id, tarjeta_id, descripcion, fecha, notas)
        VALUES (?,?,?,?,?,?,?,?)`)
      .run(persona_id, r2(monto), origen_tipo || 'reverso', origen_compra_id || null, tarjeta_id || null, descripcion || null, fecha || hoyLocal(), notas || null);
    logAction('crear', 'Saldo a favor creado: ' + persona.nombre + ' +' + fmt(monto) + (descripcion ? ' (' + descripcion + ')' : ''));
    res.json({ ok: true, id: info.lastInsertRowid });
  });

  // POST /:id/aplicar — CRUCE DE CUENTAS: aplica $monto del crédito a una deuda 1-cuota del MISMO tercero.
  router.post('/:id/aplicar', (req, res) => {
    const { compra_destino_id, monto, fecha, notas } = req.body;
    const credito = db.prepare('SELECT * FROM saldos_favor_tercero WHERE id=?').get(req.params.id);
    if (!credito) return res.status(404).json({ error: 'Credito no encontrado' });
    const disponible = r2(credito.monto - credito.monto_aplicado);
    const m = r2(monto);
    if (!(m > 0)) return res.status(400).json({ error: 'Monto invalido' });
    if (m > disponible + 0.01) return res.status(400).json({ error: 'El credito solo tiene ' + fmt(disponible) + ' disponible.' });
    const destino = db.prepare('SELECT * FROM compras WHERE id=?').get(compra_destino_id);
    if (!destino) return res.status(404).json({ error: 'Compra destino no encontrada' });
    if (destino.persona_id !== credito.persona_id) return res.status(400).json({ error: 'La compra no pertenece al mismo tercero del credito (no se cruza entre personas).' });
    if (destino.estado === 'diferida') return res.status(400).json({ error: 'Por ahora el cruce solo aplica a compras de 1 cuota (las diferidas quedan para una siguiente version).' });
    const deudaTercero = r2(destino.valor_cop - (destino.monto_bolsillo || 0));
    if (deudaTercero <= 0) return res.status(400).json({ error: 'Esa compra ya no tiene deuda del tercero.' });
    if (m > deudaTercero + 0.01) return res.status(400).json({ error: 'La deuda del tercero en esa compra es ' + fmt(deudaTercero) + '.' });

    const nuevoBolsillo = r2((destino.monto_bolsillo || 0) + m);
    const nuevoAplicado = r2(credito.monto_aplicado + m);
    const nuevoEstadoCredito = nuevoAplicado >= r2(credito.monto) - 0.01 ? 'consumido' : 'activo';
    db.transaction(() => {
      db.prepare(`INSERT INTO aplicaciones_saldo_favor (saldo_favor_id, compra_destino_id, tipo, monto, fecha, notas)
                  VALUES (?,?,?,?,?,?)`).run(credito.id, compra_destino_id, 'cruce', m, fecha || hoyLocal(), notas || null);
      db.prepare('UPDATE saldos_favor_tercero SET monto_aplicado=?, estado=? WHERE id=?').run(nuevoAplicado, nuevoEstadoCredito, credito.id);
      // Los dos libros por separado (v5.6.1): el estado con el BANCO se congela si el ciclo ya se pagó
      // (antes se pisaba 'pagado' → 'bolsillo'); el reembolso del tercero se aplica siempre.
      aplicarBolsilloATercero(destino, nuevoBolsillo, { conservarTerceroPagado: true });
    })();

    logAction('editar', 'Saldo a favor aplicado: ' + fmt(m) + ' a "' + destino.descripcion + '"');
    res.json({ ok: true, disponible: r2(disponible - m) });
  });

  // POST /:id/liquidar — CASHOUT: consume TODO el saldo restante (devolucion en efectivo/transferencia),
  // sin vincular a una compra. Deja el credito en 'liquidado'.
  router.post('/:id/liquidar', (req, res) => {
    const { notas, fecha } = req.body;
    const credito = db.prepare('SELECT * FROM saldos_favor_tercero WHERE id=?').get(req.params.id);
    if (!credito) return res.status(404).json({ error: 'Credito no encontrado' });
    const disponible = r2(credito.monto - credito.monto_aplicado);
    if (disponible <= 0) return res.status(400).json({ error: 'El credito ya no tiene saldo disponible.' });
    db.transaction(() => {
      db.prepare(`INSERT INTO aplicaciones_saldo_favor (saldo_favor_id, compra_destino_id, tipo, monto, fecha, notas)
                  VALUES (?,?,?,?,?,?)`).run(credito.id, null, 'liquidacion', disponible, fecha || hoyLocal(), notas || 'Devolucion en efectivo/transferencia');
      db.prepare("UPDATE saldos_favor_tercero SET monto_aplicado=monto, estado='liquidado' WHERE id=?").run(credito.id);
    })();
    logAction('editar', 'Saldo a favor liquidado (efectivo): ' + fmt(disponible));
    res.json({ ok: true });
  });

  // DELETE /aplicaciones/:aplId — DESHACER una aplicacion (cruce o liquidacion): revierte los pasos.
  // SIEMPRE permitido, tambien sobre compras de ciclos ya pagados (v5.6.1): es lo mismo que ya se puede
  // hacer con el boton "Bolsillo" normal, y retirar un reembolso mal aplicado no toca el cierre del mes
  // — `aplicarBolsilloATercero` congela el estado con el banco y solo devuelve al tercero a deudor.
  router.delete('/aplicaciones/:aplId', (req, res) => {
    const apl = db.prepare('SELECT * FROM aplicaciones_saldo_favor WHERE id=?').get(req.params.aplId);
    if (!apl) return res.status(404).json({ error: 'Aplicacion no encontrada' });
    const credito = db.prepare('SELECT * FROM saldos_favor_tercero WHERE id=?').get(apl.saldo_favor_id);
    db.transaction(() => {
      if (credito) {
        const nuevoAplicado = Math.max(0, r2(credito.monto_aplicado - apl.monto));
        db.prepare("UPDATE saldos_favor_tercero SET monto_aplicado=?, estado='activo' WHERE id=?").run(nuevoAplicado, credito.id);
      }
      if (apl.tipo === 'cruce' && apl.compra_destino_id) {
        const destino = db.prepare('SELECT * FROM compras WHERE id=?').get(apl.compra_destino_id);
        if (destino) {
          const nuevoBolsillo = Math.max(0, r2((destino.monto_bolsillo || 0) - apl.monto));
          aplicarBolsilloATercero(destino, nuevoBolsillo);
        }
      }
      db.prepare('DELETE FROM aplicaciones_saldo_favor WHERE id=?').run(apl.id);
    })();
    logAction('eliminar', 'Aplicacion de saldo a favor revertida: ' + fmt(apl.monto));
    res.json({ ok: true });
  });

  return router;
};
