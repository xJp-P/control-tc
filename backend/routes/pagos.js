// backend/routes/pagos.js — CRUD /api/pagos (includes revert logic on delete)
const { Router } = require('express');

module.exports = function(db, { logAction, tjNombre }) {
  const router = Router();

  router.get('/', (req, res) => {
    const { ciclo, tarjeta_id } = req.query;
    let sql = 'SELECT * FROM pagos WHERE 1=1';
    const params = [];
    if (tarjeta_id) { sql += ' AND tarjeta_id = ?'; params.push(tarjeta_id); }
    if (ciclo) { sql += ' AND ciclo = ?'; params.push(ciclo); }
    sql += ' ORDER BY fecha DESC, id DESC';
    res.json(db.prepare(sql).all(...params));
  });

  router.post('/', (req, res) => {
    const { tarjeta_id, fecha, monto, tipo, ciclo, notas } = req.body;
    const r = db.prepare('INSERT INTO pagos (tarjeta_id, fecha, monto, tipo, ciclo, notas) VALUES (?,?,?,?,?,?)')
      .run(tarjeta_id || null, fecha, monto, tipo || 'pago_total', ciclo || null, notas || null);
    const fmt = new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',maximumFractionDigits:0}).format(monto);
    logAction('crear', tjNombre(tarjeta_id) + 'Pago registrado: ' + fmt + ' (' + (tipo || 'pago_total') + ')');
    res.json({ id: r.lastInsertRowid });
  });

  router.put('/:id', (req, res) => {
    const { tarjeta_id, fecha, monto, tipo, ciclo, notas } = req.body;
    db.prepare('UPDATE pagos SET tarjeta_id=?, fecha=?, monto=?, tipo=?, ciclo=?, notas=? WHERE id=?')
      .run(tarjeta_id, fecha, monto, tipo, ciclo, notas, req.params.id);
    logAction('editar', 'Pago editado');
    res.json({ ok: true });
  });

  router.delete('/:id', (req, res) => {
    const pago = db.prepare('SELECT * FROM pagos WHERE id=?').get(req.params.id);
    if (!pago) return res.status(404).json({ error: 'Pago no encontrado' });

    const fmt = new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',maximumFractionDigits:0}).format(pago.monto);

    if (pago.tipo === 'abono_capital') {
      // Revertir abono a capital
      const comprasAfectadas = db.prepare("SELECT id, valor_cop, monto_abonado, estado FROM compras WHERE tarjeta_id=? AND monto_abonado > 0 AND estado='pagado'").all(pago.tarjeta_id);
      comprasAfectadas.forEach(c => {
        db.prepare("UPDATE compras SET estado='pendiente', monto_abonado=0 WHERE id=?").run(c.id);
      });
      const comprasParciales = db.prepare("SELECT id FROM compras WHERE tarjeta_id=? AND monto_abonado > 0 AND estado NOT IN ('pagado','diferida')").all(pago.tarjeta_id);
      comprasParciales.forEach(c => {
        db.prepare("UPDATE compras SET monto_abonado=0 WHERE id=?").run(c.id);
      });
      const avances = db.prepare("SELECT id FROM avances WHERE tarjeta_id=?").all(pago.tarjeta_id);
      avances.forEach(av => {
        db.prepare("DELETE FROM abonos_avance WHERE avance_id=? AND fecha=?").run(av.id, pago.fecha);
      });
      const diferidas = db.prepare("SELECT id FROM diferidas WHERE tarjeta_id=?").all(pago.tarjeta_id);
      diferidas.forEach(d => {
        db.prepare("DELETE FROM abonos_diferida WHERE diferida_id=? AND fecha=?").run(d.id, pago.fecha);
      });
      logAction('revertir', tjNombre(pago.tarjeta_id) + 'Abono a capital revertido: ' + fmt);

    } else if (pago.tipo === 'abono_extracto') {
      const ext = db.prepare("SELECT * FROM extractos WHERE tarjeta_id=? AND ciclo=?").get(pago.tarjeta_id, pago.ciclo);
      if (ext) {
        const nuevoMonto = Math.max(0, (ext.monto_pagado || 0) - pago.monto);
        if (ext.estado === 'pagado') {
          db.prepare("UPDATE extractos SET estado='pendiente', monto_pagado=?, fecha_pagado=NULL WHERE id=?").run(nuevoMonto, ext.id);
          db.prepare("UPDATE compras SET estado='pendiente', monto_abonado=0 WHERE tarjeta_id=? AND ciclo=? AND estado='pagado' AND monto_abonado=valor_cop").run(pago.tarjeta_id, pago.ciclo);
        } else {
          db.prepare("UPDATE extractos SET monto_pagado=? WHERE id=?").run(nuevoMonto, ext.id);
        }
      }
      logAction('revertir', tjNombre(pago.tarjeta_id) + 'Abono a extracto revertido: ' + fmt + ' (' + pago.ciclo + ')');

    } else {
      logAction('eliminar', tjNombre(pago.tarjeta_id) + 'Pago eliminado: ' + fmt);
    }

    db.prepare('DELETE FROM pagos WHERE id=?').run(req.params.id);
    res.json({ ok: true });
  });

  return router;
};
