// backend/routes/terceros.js — /api/terceros
const { Router } = require('express');
const { hoyLocal } = require('../helpers/dates');
const { calcularAmortizacionDiferida } = require('../engine/amortizacion');
const { nuOpts } = require('../helpers/banco');

module.exports = function(db, { logAction, tjNombre }) {
  const router = Router();

  router.get('/', (req, res) => {
    const { tarjeta_id } = req.query;
    let sql = `SELECT c.id, c.fecha, c.descripcion, c.valor_cop, c.valor_usd, c.estado, c.ciclo, c.tercero_pagado,
               COALESCE(c.tercero_monto_abonado, 0) as tercero_monto_abonado,
               COALESCE(c.monto_bolsillo, 0) as monto_bolsillo,
               COALESCE(c.es_internacional, 0) as es_internacional,
               c.diferida_id, c.tarjeta_id,
               p.nombre as persona_nombre, p.color as persona_color, p.id as persona_id
               FROM compras c JOIN personas p ON c.persona_id = p.id
               WHERE c.persona_id IS NOT NULL
                 AND NOT (c.estado = 'pagado' AND c.tercero_pagado = 1)`;
    const params = [];
    if (tarjeta_id) { sql += ' AND c.tarjeta_id = ?'; params.push(tarjeta_id); }
    sql += ' ORDER BY c.tercero_pagado ASC, c.fecha DESC';
    const compras = db.prepare(sql).all(...params);
    const hoy = hoyLocal();

    const result = compras.map(c => {
      if (c.estado !== 'diferida') return c;
      let dif = c.diferida_id
        ? db.prepare('SELECT * FROM diferidas WHERE id=?').get(c.diferida_id)
        : db.prepare('SELECT * FROM diferidas WHERE tarjeta_id=? AND etiqueta=? AND fecha_compra=?').get(c.tarjeta_id, c.descripcion, c.fecha);
      if (!dif) return c;
      const amort = calcularAmortizacionDiferida(c.valor_cop, dif.tasa_mv, dif.num_cuotas, dif.fecha_compra, dif.fecha_primer_corte, null, nuOpts(db, c.tarjeta_id));
      const bolsillo = Math.round(c.monto_bolsillo || 0);
      const cuotasBase = amort.tabla.map(r => ({
        num: r.numCuota,
        fecha_corte: r.fechaCorte,
        capital: Math.round(r.cuotaCapital),
        interes: Math.round(r.interesTotal),
        total: Math.round(r.totalPagar),
        pagada: r.fechaCorte < hoy
      }));
      // Per-cuota bolsillo: cada cuota tiene su propio monto apartado
      const bolCuotasRows = db.prepare('SELECT cuota_num, monto FROM bolsillo_cuotas WHERE compra_id=?').all(c.id);
      const bolMap = {};
      bolCuotasRows.forEach(b => { bolMap[b.cuota_num] = Math.round(b.monto); });
      const cuotas = cuotasBase.map(q => ({
        ...q,
        monto_bolsillo_cuota: bolMap[q.num] || 0,
        cubierta_bolsillo: (bolMap[q.num] || 0) >= q.total
      }));
      const pendiente = cuotas.filter(q => !q.pagada && !q.cubierta_bolsillo).reduce((s, q) => s + q.total, 0);
      // USD: prorrateo del valor_usd entre cuotas pendientes (mismo plazo que COP)
      const pendientesCount = cuotas.filter(q => !q.pagada && !q.cubierta_bolsillo).length;
      const valor_usd_pendiente = (c.valor_usd && c.valor_usd > 0)
        ? Math.round((c.valor_usd / dif.num_cuotas) * pendientesCount * 100) / 100
        : 0;
      return { ...c, es_diferida: true, cuotas, valor_pendiente: Math.round(pendiente), valor_usd_pendiente };
    });

    res.json(result);
  });

  router.put('/:id/toggle', (req, res) => {
    const compra = db.prepare('SELECT * FROM compras WHERE id=?').get(req.params.id);
    if (!compra) return res.status(404).json({ error: 'Compra no encontrada' });
    if (!compra.persona_id) return res.status(400).json({ error: 'Solo compras de terceros' });
    const nuevo = compra.tercero_pagado ? 0 : 1;
    db.prepare('UPDATE compras SET tercero_pagado=?, tercero_monto_abonado=? WHERE id=?').run(nuevo, nuevo ? compra.valor_cop : 0, req.params.id);
    const persona = compra.persona_id ? db.prepare('SELECT nombre FROM personas WHERE id=?').get(compra.persona_id) : null;
    logAction('editar', tjNombre(compra.tarjeta_id) + (nuevo ? 'Tercero pago: ' : 'Tercero marcado como pendiente: ') + compra.descripcion + (persona ? ' (' + persona.nombre + ')' : ''));
    res.json({ ok: true, tercero_pagado: nuevo });
  });

  router.put('/:id/abonar', (req, res) => {
    const { monto } = req.body;
    if (!monto || monto <= 0) return res.status(400).json({ error: 'Monto invalido' });
    const compra = db.prepare('SELECT * FROM compras WHERE id=?').get(req.params.id);
    if (!compra) return res.status(404).json({ error: 'Compra no encontrada' });
    if (!compra.persona_id) return res.status(400).json({ error: 'Solo compras de terceros' });
    const nuevoAbono = Math.min((compra.tercero_monto_abonado || 0) + monto, compra.valor_cop);
    const pagado = nuevoAbono >= compra.valor_cop ? 1 : 0;
    db.prepare('UPDATE compras SET tercero_monto_abonado=?, tercero_pagado=? WHERE id=?').run(nuevoAbono, pagado, req.params.id);
    const persona = compra.persona_id ? db.prepare('SELECT nombre FROM personas WHERE id=?').get(compra.persona_id) : null;
    logAction('editar', tjNombre(compra.tarjeta_id) + 'Abono tercero: ' + compra.descripcion + (persona ? ' (' + persona.nombre + ')' : '') + ' +' + monto);
    res.json({ ok: true, tercero_monto_abonado: nuevoAbono, tercero_pagado: pagado });
  });

  return router;
};
