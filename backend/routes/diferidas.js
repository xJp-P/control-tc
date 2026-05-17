// backend/routes/diferidas.js — CRUD /api/diferidas
const { Router } = require('express');
const { hoyLocal, calcCicloLocal } = require('../helpers/dates');
const { calcularAmortizacionDiferida } = require('../engine/amortizacion');
const { nuOpts } = require('../helpers/banco');

module.exports = function(db, { logAction, tjNombre }) {
  const router = Router();

  router.get('/', (req, res) => {
    const { tarjeta_id, ciclo } = req.query;
    let sql = 'SELECT * FROM diferidas WHERE 1=1';
    const params = [];
    if (tarjeta_id) { sql += ' AND tarjeta_id = ?'; params.push(tarjeta_id); }
    sql += ' ORDER BY created_at DESC';
    const diferidas = db.prepare(sql).all(...params);
    const hoyDif = hoyLocal();
    const result = diferidas.map(d => {
      const amort = calcularAmortizacionDiferida(d.monto, d.tasa_mv, d.num_cuotas, d.fecha_compra, d.fecha_primer_corte, null, nuOpts(db, d.tarjeta_id));
      const cuotaCiclo = ciclo
        ? amort.tabla.find(r => r.fechaCorte.slice(0, 7) === ciclo)
        : amort.tabla.find(r => r.fechaCorte >= hoyDif);
      const compraPersona = db.prepare(`SELECT c.persona_id, p.nombre FROM compras c
        LEFT JOIN personas p ON c.persona_id = p.id
        WHERE c.diferida_id = ? AND c.persona_id IS NOT NULL LIMIT 1`).get(d.id);
      // Compra vinculada a esta diferida (para gestionar bolsillo). Toma la primera/principal.
      const compraVinc = db.prepare(`SELECT id, monto_bolsillo, valor_cop FROM compras WHERE diferida_id = ? ORDER BY id LIMIT 1`).get(d.id);
      // Per-cuota bolsillo: mapa {cuota_num: monto} para la compra vinculada
      const bolPorCuota = {};
      if (compraVinc) {
        db.prepare('SELECT cuota_num, monto FROM bolsillo_cuotas WHERE compra_id=?').all(compraVinc.id)
          .forEach(b => { bolPorCuota[b.cuota_num] = Math.round(b.monto); });
      }
      return {
        ...d,
        saldoActual: amort.resumen.saldoActual,
        cuotaCorte: cuotaCiclo ? cuotaCiclo.totalPagar : 0,
        cuotasRestantes: amort.tabla.filter(r => r.fechaCorte >= hoyDif).length,
        ciclos: amort.tabla.map(r => r.fechaCorte.slice(0, 7)),
        es_de_tercero: !!compraPersona,
        persona_nombre: compraPersona ? compraPersona.nombre : null,
        compra_id: compraVinc ? compraVinc.id : null,
        // Bolsillo total (cache) y per-cuota
        monto_bolsillo: compraVinc ? (compraVinc.monto_bolsillo || 0) : (d.monto_bolsillo || 0),
        bolsillo_por_cuota: bolPorCuota
      };
    });
    res.json(result);
  });

  router.get('/:id', (req, res) => {
    const d = db.prepare('SELECT * FROM diferidas WHERE id=?').get(req.params.id);
    if (!d) return res.status(404).json({ error: 'Diferida no encontrada' });
    const amort = calcularAmortizacionDiferida(d.monto, d.tasa_mv, d.num_cuotas, d.fecha_compra, d.fecha_primer_corte, null, nuOpts(db, d.tarjeta_id));
    res.json({ ...d, amortizacion: amort.tabla, resumen: amort.resumen });
  });

  router.post('/', (req, res) => {
    const { tarjeta_id, etiqueta, monto, tasa_mv, num_cuotas, fecha_compra, fecha_primer_corte, estado, notas } = req.body;
    const r = db.prepare(`INSERT INTO diferidas (tarjeta_id, etiqueta, monto, tasa_mv, num_cuotas, fecha_compra, fecha_primer_corte, estado, notas)
                          VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(tarjeta_id || null, etiqueta, monto, tasa_mv, num_cuotas, fecha_compra, fecha_primer_corte, estado || 'activo', notas || null);
    const fmt = new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',maximumFractionDigits:0}).format(monto);
    logAction('crear', tjNombre(tarjeta_id) + 'Diferida registrada: ' + etiqueta + ' por ' + fmt + ' a ' + num_cuotas + ' cuotas');
    res.json({ id: r.lastInsertRowid });
  });

  // Helper: chequear inmutabilidad de una diferida.
  // Bloquea si el extracto del ciclo de origen (fecha_compra) está pagado.
  function validateDiferidaMutable(difRow) {
    if (!difRow) return null;
    const tj = db.prepare('SELECT dia_corte FROM tarjetas WHERE id=?').get(difRow.tarjeta_id);
    const diaCorte = tj ? tj.dia_corte : 30;
    const cicloOrigen = calcCicloLocal(difRow.fecha_compra, diaCorte);
    const ext = db.prepare("SELECT estado FROM extractos WHERE tarjeta_id=? AND ciclo=?").get(difRow.tarjeta_id, cicloOrigen);
    if (ext && ext.estado === 'pagado') {
      return 'No se puede modificar: el extracto del ciclo ' + cicloOrigen + ' (origen de la diferida) ya está pagado.';
    }
    return null;
  }

  router.put('/:id', (req, res) => {
    const { tarjeta_id, etiqueta, monto, tasa_mv, num_cuotas, fecha_compra, fecha_primer_corte, estado, notas } = req.body;
    const current = db.prepare('SELECT tarjeta_id, fecha_compra FROM diferidas WHERE id=?').get(req.params.id);
    const err = validateDiferidaMutable(current);
    if (err) return res.status(403).json({ error: err });
    db.prepare(`UPDATE diferidas SET tarjeta_id=?, etiqueta=?, monto=?, tasa_mv=?, num_cuotas=?, fecha_compra=?, fecha_primer_corte=?, estado=?, notas=? WHERE id=?`)
      .run(tarjeta_id, etiqueta, monto, tasa_mv, num_cuotas, fecha_compra, fecha_primer_corte, estado, notas, req.params.id);
    logAction('editar', tjNombre(tarjeta_id) + 'Diferida editada: ' + etiqueta);
    res.json({ ok: true });
  });

  // ── Bolsillo de diferida sin compra vinculada ─────────────────────
  router.put('/:id/bolsillo', (req, res) => {
    const { monto_bolsillo } = req.body;
    const d = db.prepare('SELECT * FROM diferidas WHERE id=?').get(req.params.id);
    if (!d) return res.status(404).json({ error: 'Diferida no encontrada' });
    const nuevoMonto = Math.round(parseFloat(monto_bolsillo) || 0);
    db.prepare('UPDATE diferidas SET monto_bolsillo=? WHERE id=?').run(nuevoMonto, d.id);
    const fmt = new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',maximumFractionDigits:0}).format(nuevoMonto);
    logAction('editar', tjNombre(d.tarjeta_id) + 'Bolsillo de diferida actualizado: ' + d.etiqueta + ' - Apartado: ' + fmt);
    res.json({ ok: true, monto_bolsillo: nuevoMonto });
  });

  router.delete('/:id', (req, res) => {
    const d = db.prepare('SELECT etiqueta, tarjeta_id, fecha_compra FROM diferidas WHERE id=?').get(req.params.id);
    const err = validateDiferidaMutable(d);
    if (err) return res.status(403).json({ error: err });
    db.prepare('DELETE FROM diferidas WHERE id=?').run(req.params.id);
    logAction('eliminar', tjNombre(d ? d.tarjeta_id : null) + 'Diferida eliminada: ' + (d ? d.etiqueta : 'ID ' + req.params.id));
    res.json({ ok: true });
  });

  return router;
};
