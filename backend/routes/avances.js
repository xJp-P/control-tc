// backend/routes/avances.js — CRUD /api/avances + abonos
const { Router } = require('express');
const { hoyLocal, calcCicloLocal, cicloActualStr } = require('../helpers/dates');
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
      // Per-cuota bolsillo: mapa { cuota_num: monto } igual que diferidas
      const bolPorCuota = {};
      db.prepare('SELECT cuota_num, monto FROM bolsillo_cuotas_avance WHERE avance_id=?').all(av.id)
        .forEach(b => { bolPorCuota[b.cuota_num] = Math.round(b.monto); });
      return {
        ...av,
        saldoActual: amort.resumen.saldoActual,
        cuotasRestantes: amort.resumen.cuotasRestantes,
        cuotaCorte: cuotaCiclo ? cuotaCiclo.totalExtracto : 0,
        proximoPago: amort.tabla.find(r => r.saldoFinal > 0),
        ciclos: amort.tabla.map(r => r.fechaCorte.slice(0, 7)),
        bolsillo_por_cuota: bolPorCuota
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

  // Helper: validar inmutabilidad de un avance (antigüedad + extracto pagado).
  // Mismo criterio que el frontend (canEditAvance) para que UI y API coincidan.
  function validateAvanceMutable(avanceRow) {
    if (!avanceRow) return null;
    const cicloDesembolso = calcCicloLocal(avanceRow.fecha_desembolso, avanceRow.dia_corte);
    if (cicloDesembolso !== cicloActualStr()) {
      return 'No se puede modificar: el avance tiene más de un mes de antigüedad (desembolsado en el ciclo ' + cicloDesembolso + ').';
    }
    const ext = db.prepare("SELECT estado FROM extractos WHERE tarjeta_id=? AND ciclo=?").get(avanceRow.tarjeta_id, cicloDesembolso);
    if (ext && ext.estado === 'pagado') {
      return 'No se puede modificar: el extracto del ciclo ' + cicloDesembolso + ' ya está pagado.';
    }
    return null;
  }

  // EDICION RESTRINGIDA: solo se actualizan el nombre (etiqueta) y la nota. El resto (monto, tasa,
  // plazo, fecha, comision) es INMUTABLE: cambiarlo reescribiria la tabla de amortizacion de un avance
  // en curso. Cualquier otro campo del payload se IGNORA. Renombrar/anotar es seguro SIEMPRE (no afecta
  // ningun calculo), por eso NO pasa por validateAvanceMutable: permite ajustar el nombre al texto del
  // extracto aunque el avance sea de un ciclo viejo o pagado (necesario para el cruce del Asistente IA).
  router.put('/:id', (req, res) => {
    const av = db.prepare('SELECT tarjeta_id FROM avances WHERE id=?').get(req.params.id);
    if (!av) return res.status(404).json({ error: 'Avance no encontrado' });
    const etiqueta = (req.body && req.body.etiqueta != null) ? String(req.body.etiqueta).trim() : '';
    if (!etiqueta) return res.status(400).json({ error: 'La etiqueta no puede estar vacia.' });
    const notas = (req.body && req.body.notas != null) ? String(req.body.notas) : null;
    db.prepare('UPDATE avances SET etiqueta=?, notas=? WHERE id=?').run(etiqueta, notas, req.params.id);
    logAction('editar', tjNombre(av.tarjeta_id) + 'Avance renombrado: ' + etiqueta);
    res.json({ ok: true });
  });

  router.delete('/:id', (req, res) => {
    const av = db.prepare('SELECT etiqueta, tarjeta_id, fecha_desembolso, dia_corte FROM avances WHERE id=?').get(req.params.id);
    const err = validateAvanceMutable(av);
    if (err) return res.status(403).json({ error: err });
    db.prepare('DELETE FROM abonos_avance WHERE avance_id=?').run(req.params.id);
    db.prepare('DELETE FROM avances WHERE id=?').run(req.params.id);
    logAction('eliminar', tjNombre(av ? av.tarjeta_id : null) + 'Avance eliminado: ' + (av ? av.etiqueta : 'ID ' + req.params.id));
    res.json({ ok: true });
  });

  // ── Bolsillo de avance (per-cuota) ─────────────────────────────────
  // Acepta { monto_bolsillo, cuota_num }. Igual al patrón de bolsillo_cuotas
  // de diferidas: upsert por (avance_id, cuota_num), y mantiene la columna
  // global avances.monto_bolsillo como cache = SUMA de todas las cuotas
  // (la usa el dashboard para "Saldo en Bolsillo").
  router.put('/:id/bolsillo', (req, res) => {
    const { monto_bolsillo, cuota_num } = req.body;
    const av = db.prepare('SELECT * FROM avances WHERE id=?').get(req.params.id);
    if (!av) return res.status(404).json({ error: 'Avance no encontrado' });
    const nuevoMonto = Math.round(parseFloat(monto_bolsillo) || 0);

    if (cuota_num != null) {
      // Per-cuota: upsert
      if (nuevoMonto > 0) {
        db.prepare('INSERT INTO bolsillo_cuotas_avance (avance_id, cuota_num, monto) VALUES (?,?,?) ON CONFLICT(avance_id, cuota_num) DO UPDATE SET monto=?')
          .run(av.id, cuota_num, nuevoMonto, nuevoMonto);
      } else {
        db.prepare('DELETE FROM bolsillo_cuotas_avance WHERE avance_id=? AND cuota_num=?').run(av.id, cuota_num);
      }
      const sum = db.prepare('SELECT COALESCE(SUM(monto),0) as total FROM bolsillo_cuotas_avance WHERE avance_id=?').get(av.id);
      db.prepare('UPDATE avances SET monto_bolsillo=? WHERE id=?').run(sum.total, av.id);
      const fmt = new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',maximumFractionDigits:0}).format(nuevoMonto);
      logAction('editar', tjNombre(av.tarjeta_id) + 'Bolsillo cuota ' + cuota_num + ': ' + av.etiqueta + ' - Apartado: ' + fmt);
      return res.json({ ok: true, monto_bolsillo: sum.total, cuota_num, monto_cuota: nuevoMonto });
    }

    // Compat: si no llega cuota_num (cliente viejo), trata como bolsillo global y lo
    // refleja en la cuota próxima desde HOY de la tabla de amortización.
    const abonos = db.prepare('SELECT * FROM abonos_avance WHERE avance_id=? ORDER BY fecha').all(av.id);
    const amort = calcularAmortizacionAvance(av.monto, av.tasa_mv, av.plazo, av.fecha_desembolso, av.dia_corte, abonos, av.comision, avanceOpts(db, av.tarjeta_id));
    const hoyL = require('../helpers/dates').hoyLocal();
    const cuotaProxima = amort.tabla.find(r => r.fechaCorte >= hoyL) || amort.tabla[0];
    const cnFallback = cuotaProxima ? cuotaProxima.numCuota : 1;
    if (nuevoMonto > 0) {
      db.prepare('INSERT INTO bolsillo_cuotas_avance (avance_id, cuota_num, monto) VALUES (?,?,?) ON CONFLICT(avance_id, cuota_num) DO UPDATE SET monto=?')
        .run(av.id, cnFallback, nuevoMonto, nuevoMonto);
    } else {
      db.prepare('DELETE FROM bolsillo_cuotas_avance WHERE avance_id=? AND cuota_num=?').run(av.id, cnFallback);
    }
    const sum2 = db.prepare('SELECT COALESCE(SUM(monto),0) as total FROM bolsillo_cuotas_avance WHERE avance_id=?').get(av.id);
    db.prepare('UPDATE avances SET monto_bolsillo=? WHERE id=?').run(sum2.total, av.id);
    const fmt = new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',maximumFractionDigits:0}).format(nuevoMonto);
    logAction('editar', tjNombre(av.tarjeta_id) + 'Bolsillo de avance actualizado: ' + av.etiqueta + ' - Apartado: ' + fmt);
    res.json({ ok: true, monto_bolsillo: sum2.total });
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
