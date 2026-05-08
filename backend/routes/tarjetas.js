// backend/routes/tarjetas.js — CRUD /api/tarjetas + rate scraping
const { Router } = require('express');
const { calcularAmortizacionAvance } = require('../engine/amortizacion');
const { calcularAmortizacionDiferida } = require('../engine/amortizacion');
const { hoyLocal } = require('../helpers/dates');
const { nuOpts, avanceOpts, clearBancoCache } = require('../helpers/banco');
const { scrapeTasas } = require('../helpers/scraper');

module.exports = function(db, { logAction }) {
  const router = Router();

  router.get('/', (req, res) => {
    const tarjetas = db.prepare('SELECT * FROM tarjetas ORDER BY created_at DESC').all();
    const hoy = hoyLocal();
    const cicloActual = hoy.slice(0, 7);

    const result = tarjetas.map(t => {
      const comprasCiclo = db.prepare("SELECT COALESCE(SUM(valor_cop - COALESCE(monto_abonado,0)),0) as total FROM compras WHERE tarjeta_id=? AND ciclo=? AND estado NOT IN ('pagado','diferida')").get(t.id, cicloActual);

      const avancesActivos = db.prepare("SELECT * FROM avances WHERE tarjeta_id=? AND estado='activo'").all(t.id);
      let deudaAvances = 0;
      avancesActivos.forEach(av => {
        const abonos = db.prepare('SELECT * FROM abonos_avance WHERE avance_id=? ORDER BY fecha').all(av.id);
        const amort = calcularAmortizacionAvance(av.monto, av.tasa_mv, av.plazo, av.fecha_desembolso, av.dia_corte, abonos, av.comision, avanceOpts(db, av.tarjeta_id));
        deudaAvances += amort.resumen.saldoActual;
      });

      const diferidasActivas = db.prepare("SELECT * FROM diferidas WHERE tarjeta_id=? AND estado='activo'").all(t.id);
      let deudaDiferidas = 0;
      diferidasActivas.forEach(d => {
        const abonosDif = db.prepare('SELECT * FROM abonos_diferida WHERE diferida_id=? ORDER BY fecha').all(d.id);
        const amort = calcularAmortizacionDiferida(d.monto, d.tasa_mv, d.num_cuotas, d.fecha_compra, d.fecha_primer_corte, abonosDif, nuOpts(db, d.tarjeta_id));
        deudaDiferidas += amort.resumen.saldoActual;
      });

      const extractosImpagos = db.prepare("SELECT ciclo FROM extractos WHERE tarjeta_id=? AND estado='pendiente' AND fecha_corte <= ?").all(t.id, hoy);
      extractosImpagos.forEach(ext => {
        avancesActivos.forEach(av => {
          const ab = db.prepare('SELECT * FROM abonos_avance WHERE avance_id=? ORDER BY fecha').all(av.id);
          const am = calcularAmortizacionAvance(av.monto, av.tasa_mv, av.plazo, av.fecha_desembolso, av.dia_corte, ab, av.comision, avanceOpts(db, av.tarjeta_id));
          const c = am.tabla.find(r => r.fechaCorte.slice(0, 7) === ext.ciclo);
          if (c) deudaAvances += c.cuotaCapital;
        });
        diferidasActivas.forEach(d => {
          const abonosDif = db.prepare('SELECT * FROM abonos_diferida WHERE diferida_id=? ORDER BY fecha').all(d.id);
          const am = calcularAmortizacionDiferida(d.monto, d.tasa_mv, d.num_cuotas, d.fecha_compra, d.fecha_primer_corte, abonosDif, nuOpts(db, d.tarjeta_id));
          const c = am.tabla.find(r => r.fechaCorte.slice(0, 7) === ext.ciclo);
          if (c) deudaDiferidas += c.cuotaCapital;
        });
      });

      const todasComprasPend = db.prepare("SELECT COALESCE(SUM(valor_cop - COALESCE(monto_abonado,0)),0) as total FROM compras WHERE tarjeta_id=? AND estado NOT IN ('pagado','diferida')").get(t.id);
      const extPagadoParcial = db.prepare("SELECT COALESCE(SUM(monto_pagado),0) as total FROM extractos WHERE tarjeta_id=? AND estado='pendiente' AND monto_pagado > 0").get(t.id);
      const deudaTotal = todasComprasPend.total + deudaAvances + deudaDiferidas - (extPagadoParcial.total || 0);

      return {
        ...t,
        comprasCiclo: Math.round(comprasCiclo.total),
        deudaAvances: Math.round(deudaAvances),
        deudaDiferidas: Math.round(deudaDiferidas),
        deudaTotal: Math.round(deudaTotal),
        numAvancesActivos: avancesActivos.length,
        numDiferidasActivas: diferidasActivas.length
      };
    });

    res.json(result);
  });

  // Tarjetas Bancolombia que aún no tienen configurado el flag difiere_intereses_cuota1.
  // El frontend usa este endpoint al iniciar para mostrar un modal bloqueante.
  router.get('/pendientes-config', (req, res) => {
    const pendientes = db.prepare(
      "SELECT id, nombre, banco, color, imagen FROM tarjetas WHERE banco LIKE '%Bancolombia%' AND difiere_intereses_cuota1 IS NULL AND estado='activa'"
    ).all();
    res.json(pendientes);
  });

  router.get('/:id', (req, res) => {
    const t = db.prepare('SELECT * FROM tarjetas WHERE id=?').get(req.params.id);
    if (!t) return res.status(404).json({ error: 'Tarjeta no encontrada' });
    res.json(t);
  });

  router.post('/', (req, res) => {
    const { nombre, banco, dia_corte, dia_pago, color, imagen, tasa_mv_avances, tasa_mv_diferidas, url_tasas, cupo_total, notas, franquicia, difiere_intereses_cuota1 } = req.body;
    // Solo guardar el flag si banco es Bancolombia; en otros casos null
    const esBanco = banco && banco.toLowerCase().includes('bancolombia');
    const flagDifiere = esBanco && (difiere_intereses_cuota1 === 0 || difiere_intereses_cuota1 === 1) ? difiere_intereses_cuota1 : null;
    const r = db.prepare(`INSERT INTO tarjetas (nombre, banco, dia_corte, dia_pago, color, imagen, tasa_mv_avances, tasa_mv_diferidas, url_tasas, cupo_total, notas, franquicia, difiere_intereses_cuota1)
                          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(nombre, banco || null, dia_corte || 30, dia_pago || 16, color || '#4f8cff', imagen || null,
           tasa_mv_avances || 0.01911, tasa_mv_diferidas || 0.0188, url_tasas || null, cupo_total || 0, notas || null, franquicia || null, flagDifiere);
    logAction('crear', 'Tarjeta creada: ' + nombre, banco || null);
    res.json({ id: r.lastInsertRowid });
  });

  router.put('/:id', (req, res) => {
    const { nombre, banco, dia_corte, dia_pago, color, imagen, tasa_mv_avances, tasa_mv_diferidas, url_tasas, cupo_total, estado, notas, franquicia, difiere_intereses_cuota1 } = req.body;
    const esBanco = banco && banco.toLowerCase().includes('bancolombia');
    const flagDifiere = esBanco && (difiere_intereses_cuota1 === 0 || difiere_intereses_cuota1 === 1) ? difiere_intereses_cuota1 : null;
    db.prepare(`UPDATE tarjetas SET nombre=?, banco=?, dia_corte=?, dia_pago=?, color=?, imagen=?, tasa_mv_avances=?, tasa_mv_diferidas=?, url_tasas=?, cupo_total=?, estado=?, notas=?, franquicia=?, difiere_intereses_cuota1=? WHERE id=?`)
      .run(nombre, banco, dia_corte, dia_pago || 16, color, imagen, tasa_mv_avances, tasa_mv_diferidas, url_tasas, cupo_total, estado, notas, franquicia || null, flagDifiere, req.params.id);
    clearBancoCache(parseInt(req.params.id));
    logAction('editar', 'Tarjeta editada: ' + nombre);
    res.json({ ok: true });
  });

  // Endpoint específico para el modal bloqueante: solo actualiza el flag.
  router.put('/:id/difiere-intereses', (req, res) => {
    const { difiere } = req.body;
    if (difiere !== 0 && difiere !== 1) return res.status(400).json({ error: 'difiere debe ser 0 o 1' });
    const t = db.prepare('SELECT nombre, banco FROM tarjetas WHERE id=?').get(req.params.id);
    if (!t) return res.status(404).json({ error: 'Tarjeta no encontrada' });
    if (!t.banco || !t.banco.toLowerCase().includes('bancolombia')) {
      return res.status(400).json({ error: 'Solo aplica a tarjetas Bancolombia' });
    }
    db.prepare('UPDATE tarjetas SET difiere_intereses_cuota1=? WHERE id=?').run(difiere, req.params.id);
    clearBancoCache(parseInt(req.params.id));
    logAction('editar', 'Tarjeta "' + t.nombre + '": difiere intereses cuota 1 = ' + (difiere ? 'Sí' : 'No'));
    res.json({ ok: true });
  });

  router.delete('/:id', (req, res) => {
    const tj = db.prepare('SELECT nombre FROM tarjetas WHERE id=?').get(req.params.id);
    const avances = db.prepare('SELECT id FROM avances WHERE tarjeta_id=?').all(req.params.id);
    avances.forEach(a => db.prepare('DELETE FROM abonos_avance WHERE avance_id=?').run(a.id));
    db.prepare('DELETE FROM avances WHERE tarjeta_id=?').run(req.params.id);
    db.prepare('DELETE FROM diferidas WHERE tarjeta_id=?').run(req.params.id);
    db.prepare('DELETE FROM compras WHERE tarjeta_id=?').run(req.params.id);
    db.prepare('DELETE FROM pagos WHERE tarjeta_id=?').run(req.params.id);
    db.prepare('DELETE FROM extractos WHERE tarjeta_id=?').run(req.params.id);
    db.prepare('DELETE FROM tarjetas WHERE id=?').run(req.params.id);
    logAction('eliminar', 'Tarjeta eliminada: ' + (tj ? tj.nombre : 'ID ' + req.params.id));
    res.json({ ok: true });
  });

  router.post('/:id/actualizar-tasas', async (req, res) => {
    const t = db.prepare('SELECT * FROM tarjetas WHERE id=?').get(req.params.id);
    if (!t) return res.status(404).json({ error: 'Tarjeta no encontrada' });
    if (!t.url_tasas) return res.status(400).json({ error: 'Esta tarjeta no tiene URL de tasas configurada' });

    const result = await scrapeTasas(t.url_tasas);
    if (!result.ok) return res.status(500).json({ error: result.error });
    if (!result.found) {
      return res.json({ ok: true, found: false, rates: result.rates, message: 'No se encontraron tasas en la pagina. Ingresalas manualmente.' });
    }

    const updates = {};
    if (result.rates.avances_mv) {
      updates.tasa_mv_avances = result.rates.avances_mv / 100;
      db.prepare('UPDATE tarjetas SET tasa_mv_avances=? WHERE id=?').run(updates.tasa_mv_avances, t.id);
    }
    if (result.rates.compras_mv) {
      updates.tasa_mv_diferidas = result.rates.compras_mv / 100;
      db.prepare('UPDATE tarjetas SET tasa_mv_diferidas=? WHERE id=?').run(updates.tasa_mv_diferidas, t.id);
    }

    logAction('actualizar', 'Tasas actualizadas desde la web: ' + t.nombre,
      'Compras MV: ' + (result.rates.compras_mv || 'N/A') + '% | Avances MV: ' + (result.rates.avances_mv || 'N/A') + '%');
    res.json({ ok: true, found: true, updates, rates: result.rates });
  });

  return router;
};
