// backend/routes/diferidas.js — CRUD /api/diferidas
const { Router } = require('express');
const { hoyLocal, calcCicloLocal } = require('../helpers/dates');
const { calcularAmortizacionDiferida } = require('../engine/amortizacion');
const { nuOpts } = require('../helpers/banco');
const { compraTerceroConReembolso } = require('../helpers/bolsillo');

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
      const compraPersona = db.prepare(`SELECT c.persona_id, p.nombre, p.color FROM compras c
        LEFT JOIN personas p ON c.persona_id = p.id
        WHERE c.diferida_id = ? AND c.persona_id IS NOT NULL LIMIT 1`).get(d.id);
      // Compra vinculada a esta diferida (para gestionar bolsillo). Toma la primera/principal.
      const compraVinc = db.prepare(`SELECT id, monto_bolsillo, valor_cop, grupo_id FROM compras WHERE diferida_id = ? ORDER BY id LIMIT 1`).get(d.id);
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
        persona_color: compraPersona ? compraPersona.color : null,
        compra_id: compraVinc ? compraVinc.id : null,
        grupo_id: compraVinc ? compraVinc.grupo_id : null,
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

  // EDICION RESTRINGIDA: solo se actualizan el nombre (etiqueta) y la nota. El resto (monto, tasa,
  // num_cuotas, fechas, estado) es INMUTABLE: cambiarlo reescribiria la tabla de amortizacion. Cualquier
  // otro campo del payload se IGNORA. Renombrar/anotar es seguro SIEMPRE (no afecta ningun calculo), por
  // eso NO pasa por validateDiferidaMutable: permite ajustar el nombre al texto del extracto aunque la
  // diferida sea de un ciclo pagado (necesario para el cruce del Asistente IA).
  router.put('/:id', (req, res) => {
    const current = db.prepare('SELECT tarjeta_id FROM diferidas WHERE id=?').get(req.params.id);
    if (!current) return res.status(404).json({ error: 'Diferida no encontrada' });
    const etiqueta = (req.body && req.body.etiqueta != null) ? String(req.body.etiqueta).trim() : '';
    if (!etiqueta) return res.status(400).json({ error: 'La etiqueta no puede estar vacia.' });
    const notas = (req.body && req.body.notas != null) ? String(req.body.notas) : null;
    // Cascada del NOMBRE a `compras` (la diferida se vincula via compras.diferida_id). Sin esto, vistas
    // como Terceros —que leen compras.descripcion— mostrarian el nombre viejo. Si la compra es parte de
    // una compra dividida (grupo_id), el nombre se aplica a TODO el grupo: todas las compras del grupo y
    // todas sus diferidas hermanas, para que la BD quede 100% sincronizada. Si no hay compra vinculada
    // (ej. diferida directa de RappiCard), no hay cascada. Solo se propaga la descripcion; las notas son
    // privadas de cada registro. Transaccional para que nombre y cascada queden atomicos.
    const aplicar = db.transaction(() => {
      db.prepare('UPDATE diferidas SET etiqueta=?, notas=? WHERE id=?').run(etiqueta, notas, req.params.id);
      const compraVinc = db.prepare('SELECT id, grupo_id FROM compras WHERE diferida_id=? LIMIT 1').get(req.params.id);
      if (compraVinc) {
        if (compraVinc.grupo_id) {
          db.prepare('UPDATE compras SET descripcion=? WHERE grupo_id=?').run(etiqueta, compraVinc.grupo_id);
          db.prepare('UPDATE diferidas SET etiqueta=? WHERE id IN (SELECT diferida_id FROM compras WHERE grupo_id=? AND diferida_id IS NOT NULL)').run(etiqueta, compraVinc.grupo_id);
        } else {
          db.prepare('UPDATE compras SET descripcion=? WHERE id=?').run(etiqueta, compraVinc.id);
        }
      }
    });
    aplicar();
    logAction('editar', tjNombre(current.tarjeta_id) + 'Diferida renombrada: ' + etiqueta);
    res.json({ ok: true });
  });

  // ── Reprogramar cuotas (Ruta A: reprogramación uniforme) ──────────
  // Cambia num_cuotas de una diferida existente (ej. el banco la pasó de 36 a 2 cuotas) y regenera
  // la amortización (función pura: no hay tabla de cuotas persistida, se recalcula al vuelo). Limpia
  // el bolsillo per-cuota huérfano (cuota_num > nuevo total) y recachea. Blinda la inmutabilidad
  // por-cuota: si alguna cuota ya cayó en un ciclo con extracto pagado, bloquea (cambiar num_cuotas
  // reescribe la cuota fija = monto/n y descuadraría un cierre real) → 403 sugiriendo Ruta C.
  router.post('/:id/reprogramar', (req, res) => {
    const { num_cuotas, fecha_primer_corte } = req.body || {};
    const d = db.prepare('SELECT * FROM diferidas WHERE id=?').get(req.params.id);
    if (!d) return res.status(404).json({ error: 'Diferida no encontrada' });
    const nuevoN = parseInt(num_cuotas, 10);
    if (!nuevoN || nuevoN < 1 || nuevoN > 120) return res.status(400).json({ error: 'El número de cuotas debe ser un entero entre 1 y 120.' });

    // Guard de Terceros: no reprogramar si alguna compra vinculada es de un tercero con reembolsos
    // registrados (reestructurar las cuotas perdería ese libro de deuda). Gestiónalos en Terceros.
    const vincDif = db.prepare('SELECT id FROM compras WHERE diferida_id=?').all(req.params.id);
    if (vincDif.some(cv => compraTerceroConReembolso(db, cv.id))) {
      return res.status(403).json({ error: 'No se puede reprogramar: esta compra es de un tercero y ya tiene reembolsos registrados. Gestiona o retira esos abonos desde la pestaña Terceros antes de reprogramar.' });
    }

    const amortPrev = calcularAmortizacionDiferida(d.monto, d.tasa_mv, d.num_cuotas, d.fecha_compra, d.fecha_primer_corte, null, nuOpts(db, d.tarjeta_id));
    const ciclosPagados = [...new Set(amortPrev.tabla.map(c => c.fechaCorte.slice(0, 7)))].filter(ci => {
      const ext = db.prepare("SELECT estado FROM extractos WHERE tarjeta_id=? AND ciclo=?").get(d.tarjeta_id, ci);
      return ext && ext.estado === 'pagado';
    });
    if (ciclosPagados.length > 0) {
      return res.status(403).json({ error: 'No se puede reprogramar: la diferida ya tiene cuotas facturadas en ciclos pagados (' + ciclosPagados.join(', ') + '). Usa "dividir en cuotas" para reprogramar solo el saldo restante.' });
    }

    const nuevaFPC = fecha_primer_corte || d.fecha_primer_corte;
    db.prepare('UPDATE diferidas SET num_cuotas=?, fecha_primer_corte=? WHERE id=?').run(nuevoN, nuevaFPC, req.params.id);

    // Limpiar bolsillo per-cuota huérfano (cuota_num > nuevoN) de las compras vinculadas y recachear.
    const comprasVinc = db.prepare('SELECT id FROM compras WHERE diferida_id=?').all(req.params.id);
    comprasVinc.forEach(c => {
      db.prepare('DELETE FROM bolsillo_cuotas WHERE compra_id=? AND cuota_num > ?').run(c.id, nuevoN);
      const sumCop = db.prepare("SELECT COALESCE(SUM(monto),0) as t FROM bolsillo_cuotas WHERE compra_id=? AND COALESCE(moneda,'COP')='COP'").get(c.id);
      const sumUsd = db.prepare("SELECT COALESCE(SUM(monto),0) as t FROM bolsillo_cuotas WHERE compra_id=? AND moneda='USD'").get(c.id);
      db.prepare('UPDATE compras SET monto_bolsillo=?, monto_bolsillo_usd=? WHERE id=?').run(sumCop.t, sumUsd.t, c.id);
    });

    const nuevaAmort = calcularAmortizacionDiferida(d.monto, d.tasa_mv, nuevoN, d.fecha_compra, nuevaFPC, null, nuOpts(db, d.tarjeta_id));
    logAction('editar', tjNombre(d.tarjeta_id) + 'Diferida reprogramada: ' + d.etiqueta + ' (' + d.num_cuotas + ' -> ' + nuevoN + ' cuotas)');
    res.json({ ok: true, num_cuotas: nuevoN, amortizacion: nuevaAmort.tabla, resumen: nuevaAmort.resumen });
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
