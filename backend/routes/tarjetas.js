// backend/routes/tarjetas.js — CRUD /api/tarjetas + rate scraping
const { Router } = require('express');
const { calcularAmortizacionAvance } = require('../engine/amortizacion');
const { calcularAmortizacionDiferida } = require('../engine/amortizacion');
const { hoyLocal, calcCicloLocal } = require('../helpers/dates');
const { nuOpts, avanceOpts, clearBancoCache } = require('../helpers/banco');
const { scrapeTasas } = require('../helpers/scraper');
const { getCortesCustomMap, cicloConCorte } = require('../helpers/cortes');

module.exports = function(db, { logAction }) {
  const router = Router();

  router.get('/', (req, res) => {
    // Orden: respeta el campo `orden` manual; las que no tengan caen al final por created_at.
    const tarjetas = db.prepare('SELECT * FROM tarjetas ORDER BY COALESCE(orden, 999999) ASC, created_at DESC').all();
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
        numDiferidasActivas: diferidasActivas.length,
        // Ciclo vigente PURO consciente del corte adelantado (cicloConCorte): el mes en curso real
        // (avanza si el banco ya cortó). Lo usan etiquetas/agrupaciones del frontend (vista Pagos,
        // dropdown IA). NO es ciclo_sugerido (ese retrocede al ciclo impago para la navegación).
        ciclo_vigente: cicloConCorte(hoy, t.dia_corte || 30, getCortesCustomMap(db, t.id))
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
    // ciclo_sugerido: el ciclo a mostrar por defecto al abrir la tarjeta.
    //   - Por defecto, el ciclo VIGENTE según el día de corte (el que está corriendo hoy).
    //   - PERO si el extracto del ciclo ANTERIOR sigue pendiente y no se cubrió el pago mínimo
    //     al 100%, se sugiere ese ciclo anterior (para que el usuario vea primero lo que debe).
    // Se calcula en el backend y se entrega junto a la tarjeta para que la vista arranque en el
    // ciclo correcto sin un salto visual (CardView carga la tarjeta antes de montar las pestañas).
    const hoy = hoyLocal();
    // Ciclo vigente CONSCIENTE del corte adelantado (cortes_custom): si el banco ya cortó este mes
    // antes de la fecha teórica, el ciclo vigente avanza al siguiente. Alimenta el DEFAULT de
    // navegación y, junto al mapa cortes_custom (abajo), los candados de inmutabilidad del frontend
    // (isCicloCerrado y la validación de creación), que ahora respetan el corte real igual que el backend.
    const cicloVig = cicloConCorte(hoy, t.dia_corte || 30, getCortesCustomMap(db, t.id));
    const [vy, vm] = cicloVig.split('-').map(Number);
    let py = vy, pm = vm - 1; if (pm < 1) { pm = 12; py -= 1; }
    const cicloPrev = py + '-' + String(pm).padStart(2, '0');
    const extPrev = db.prepare("SELECT pago_minimo, COALESCE(monto_pagado,0) as mp, estado FROM extractos WHERE tarjeta_id=? AND ciclo=?").get(t.id, cicloPrev);
    let ciclo_sugerido = cicloVig;
    if (extPrev && extPrev.estado === 'pendiente' && extPrev.pago_minimo > 0 && extPrev.mp < extPrev.pago_minimo) {
      ciclo_sugerido = cicloPrev;
    }
    // ciclo_vigente = el mes en curso PURO (consciente del corte, sin el retroceso por impago de
    // ciclo_sugerido). Para etiquetas/agrupaciones visuales que quieren "el ciclo actual real".
    res.json({ ...t, ciclo_sugerido, ciclo_vigente: cicloVig, cortes_custom: getCortesCustomMap(db, t.id) });
  });

  router.post('/', (req, res) => {
    const { nombre, banco, dia_corte, dia_pago, color, imagen, tasa_mv_avances, tasa_mv_diferidas, url_tasas, cupo_total, notas, franquicia, difiere_intereses_cuota1, orden } = req.body;
    // Solo guardar el flag si banco es Bancolombia; en otros casos null
    const esBanco = banco && banco.toLowerCase().includes('bancolombia');
    const flagDifiere = esBanco && (difiere_intereses_cuota1 === 0 || difiere_intereses_cuota1 === 1) ? difiere_intereses_cuota1 : null;
    const ordenFinal = (orden === 0 || (orden && !isNaN(parseInt(orden)))) ? parseInt(orden) : null;
    const r = db.prepare(`INSERT INTO tarjetas (nombre, banco, dia_corte, dia_pago, color, imagen, tasa_mv_avances, tasa_mv_diferidas, url_tasas, cupo_total, notas, franquicia, difiere_intereses_cuota1, orden)
                          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(nombre, banco || null, dia_corte || 30, dia_pago || 16, color || '#4f8cff', imagen || null,
           tasa_mv_avances || 0.01911, tasa_mv_diferidas || 0.0188, url_tasas || null, cupo_total || 0, notas || null, franquicia || null, flagDifiere, ordenFinal);
    logAction('crear', 'Tarjeta creada: ' + nombre, banco || null);
    res.json({ id: r.lastInsertRowid });
  });

  router.put('/:id', (req, res) => {
    const { nombre, banco, dia_corte, dia_pago, color, imagen, tasa_mv_avances, tasa_mv_diferidas, url_tasas, cupo_total, estado, notas, franquicia, difiere_intereses_cuota1, orden } = req.body;
    const esBanco = banco && banco.toLowerCase().includes('bancolombia');
    const flagDifiere = esBanco && (difiere_intereses_cuota1 === 0 || difiere_intereses_cuota1 === 1) ? difiere_intereses_cuota1 : null;
    // orden: si viene un número válido lo guardamos; si viene vacío/null lo dejamos en NULL.
    const ordenFinal = (orden === 0 || (orden && !isNaN(parseInt(orden)))) ? parseInt(orden) : null;
    db.prepare(`UPDATE tarjetas SET nombre=?, banco=?, dia_corte=?, dia_pago=?, color=?, imagen=?, tasa_mv_avances=?, tasa_mv_diferidas=?, url_tasas=?, cupo_total=?, estado=?, notas=?, franquicia=?, difiere_intereses_cuota1=?, orden=? WHERE id=?`)
      .run(nombre, banco, dia_corte, dia_pago || 16, color, imagen, tasa_mv_avances, tasa_mv_diferidas, url_tasas, cupo_total, estado, notas, franquicia || null, flagDifiere, ordenFinal, req.params.id);
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
