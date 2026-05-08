// backend/routes/avances.js — CRUD /api/avances + abonos
const { Router } = require('express');
const { hoyLocal } = require('../helpers/dates');
const { calcularAmortizacionAvance } = require('../engine/amortizacion');
const { avanceOpts } = require('../helpers/banco');

module.exports = function(db, { logAction, tjNombre }) {
  const router = Router();

  router.get('/', (req, res) => {
    const { tarjeta_id, ciclo } = req.query;
    let sql = 'SELECT * FROM avances WHERE 1=1';
    const params = [];
    if (tarjeta_id) { sql += ' AND tarjeta_id = ?'; params.push(tarjeta_id); }
    sql += ' ORDER BY created_at DESC';
    const avances = db.prepare(sql).all(...params);
    const hoy = hoyLocal();
    const result = avances.map(av => {
      const abonos = db.prepare('SELECT * FROM abonos_avance WHERE avance_id=? ORDER BY fecha').all(av.id);
      const amort = calcularAmortizacionAvance(av.monto, av.tasa_mv, av.plazo, av.fecha_desembolso, av.dia_corte, abonos, av.comision, avanceOpts(db, av.tarjeta_id));
      const cuotaCiclo = ciclo
        ? amort.tabla.find(r => r.fechaCorte.slice(0, 7) === ciclo)
        : amort.tabla.find(r => r.fechaCorte >= hoy);
      return {
        ...av,
        saldoActual: amort.resumen.saldoActual,
        cuotasRestantes: amort.resumen.cuotasRestantes,
        cuotaCorte: cuotaCiclo ? cuotaCiclo.totalExtracto : 0,
        proximoPago: amort.tabla.find(r => r.saldoFinal > 0),
        ciclos: amort.tabla.map(r => r.fechaCorte.slice(0, 7))
      };
    });
    res.json(result);
  });

  router.get('/:id', (req, res) => {
    const av = db.prepare('SELECT * FROM avances WHERE id=?').get(req.params.id);
    if (!av) return res.status(404).json({ error: 'Avance no encontrado' });
    const abonos = db.prepare('SELECT * FROM abonos_avance WHERE avance_id=? ORDER BY fecha').all(av.id);
    const amort = calcularAmortizacionAvance(av.monto, av.tasa_mv, av.plazo, av.fecha_desembolso, av.dia_corte, abonos, av.comision, avanceOpts(db, av.tarjeta_id));
    res.json({ ...av, abonos, amortizacion: amort.tabla, resumen: amort.resumen });
  });

  router.post('/', (req, res) => {
    const { tarjeta_id, etiqueta, monto, tasa_mv, plazo, fecha_desembolso, dia_corte, estado, notas, comision } = req.body;
    const r = db.prepare(`INSERT INTO avances (tarjeta_id, etiqueta, monto, tasa_mv, plazo, fecha_desembolso, dia_corte, estado, notas, comision)
                          VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(tarjeta_id || null, etiqueta, monto, tasa_mv, plazo || 24, fecha_desembolso, dia_corte || 30, estado || 'activo', notas || null, comision || 0);
    const fmt = new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',maximumFractionDigits:0}).format(monto);
    logAction('crear', tjNombre(tarjeta_id) + 'Avance registrado: ' + etiqueta + ' por ' + fmt);
    res.json({ id: r.lastInsertRowid });
  });

  router.put('/:id', (req, res) => {
    const { tarjeta_id, etiqueta, monto, tasa_mv, plazo, fecha_desembolso, dia_corte, estado, notas, comision } = req.body;
    db.prepare(`UPDATE avances SET tarjeta_id=?, etiqueta=?, monto=?, tasa_mv=?, plazo=?, fecha_desembolso=?, dia_corte=?, estado=?, notas=?, comision=? WHERE id=?`)
      .run(tarjeta_id, etiqueta, monto, tasa_mv, plazo, fecha_desembolso, dia_corte, estado, notas, comision || 0, req.params.id);
    logAction('editar', tjNombre(tarjeta_id) + 'Avance editado: ' + etiqueta);
    res.json({ ok: true });
  });

  router.delete('/:id', (req, res) => {
    const av = db.prepare('SELECT etiqueta, tarjeta_id FROM avances WHERE id=?').get(req.params.id);
    db.prepare('DELETE FROM abonos_avance WHERE avance_id=?').run(req.params.id);
    db.prepare('DELETE FROM avances WHERE id=?').run(req.params.id);
    logAction('eliminar', tjNombre(av ? av.tarjeta_id : null) + 'Avance eliminado: ' + (av ? av.etiqueta : 'ID ' + req.params.id));
    res.json({ ok: true });
  });

  // ── Bolsillo de avance (apartar dinero para la cuota del corte) ────
  router.put('/:id/bolsillo', (req, res) => {
    const { monto_bolsillo } = req.body;
    const av = db.prepare('SELECT * FROM avances WHERE id=?').get(req.params.id);
    if (!av) return res.status(404).json({ error: 'Avance no encontrado' });
    const nuevoMonto = Math.round(parseFloat(monto_bolsillo) || 0);
    db.prepare('UPDATE avances SET monto_bolsillo=? WHERE id=?').run(nuevoMonto, av.id);
    const fmt = new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',maximumFractionDigits:0}).format(nuevoMonto);
    logAction('editar', tjNombre(av.tarjeta_id) + 'Bolsillo de avance actualizado: ' + av.etiqueta + ' - Apartado: ' + fmt);
    res.json({ ok: true, monto_bolsillo: nuevoMonto });
  });

  // ── Abonos de avance ──────────────────────────────────────────────
  router.get('/:id/abonos', (req, res) => {
    res.json(db.prepare('SELECT * FROM abonos_avance WHERE avance_id=? ORDER BY fecha').all(req.params.id));
  });

  router.post('/:id/abonos', (req, res) => {
    const { fecha, monto, notas } = req.body;
    const r = db.prepare('INSERT INTO abonos_avance (avance_id, fecha, monto, notas) VALUES (?,?,?,?)')
      .run(req.params.id, fecha, monto, notas || null);
    const av = db.prepare('SELECT etiqueta, tarjeta_id FROM avances WHERE id=?').get(req.params.id);
    const fmt = new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',maximumFractionDigits:0}).format(monto);
    logAction('crear', tjNombre(av ? av.tarjeta_id : null) + 'Abono a avance: ' + fmt + ' en ' + (av ? av.etiqueta : 'ID ' + req.params.id));
    res.json({ id: r.lastInsertRowid });
  });

  return router;
};
