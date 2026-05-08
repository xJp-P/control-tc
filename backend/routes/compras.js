// backend/routes/compras.js — CRUD /api/compras + bolsillo
const { Router } = require('express');
const { hoyLocal, daysBetween } = require('../helpers/dates');
const { calcularAmortizacionDiferida } = require('../engine/amortizacion');
const { nuOpts, aplicaIntInternacional } = require('../helpers/banco');

module.exports = function(db, { logAction, tjNombre }) {
  const router = Router();

  function calcCiclo(fecha, tarjetaId) {
    const tj = db.prepare('SELECT dia_corte FROM tarjetas WHERE id=?').get(tarjetaId);
    const diaCorte = tj ? tj.dia_corte : 30;
    const d = new Date(fecha + 'T12:00:00');
    const dia = d.getDate();
    if (dia > diaCorte) d.setMonth(d.getMonth() + 1);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }

  router.get('/', (req, res) => {
    const { ciclo, tarjeta_id } = req.query;
    let sql = `SELECT c.*, p.nombre as persona_nombre, p.color as persona_color,
                      t.banco as _tj_banco, t.franquicia as _tj_franquicia,
                      t.tasa_mv_avances as _tj_tasa_intl, t.dia_corte as _tj_dia_corte
               FROM compras c
               LEFT JOIN personas p ON c.persona_id = p.id
               LEFT JOIN tarjetas t ON c.tarjeta_id = t.id
               WHERE 1=1`;
    const params = [];
    if (tarjeta_id) { sql += ' AND c.tarjeta_id = ?'; params.push(tarjeta_id); }
    if (ciclo) { sql += ' AND c.ciclo = ?'; params.push(ciclo); }
    sql += ' ORDER BY c.fecha DESC, c.id DESC';
    const compras = db.prepare(sql).all(...params);
    const hoy = hoyLocal();

    // Calcula el interés INTL atribuido a una compra individual.
    // Para compras divididas (con grupo_id) cada hijo computa sobre su propio valor_cop,
    // por lo que `interes_hijo ≈ interes_padre * (valor_hijo / valor_padre)` se cumple
    // automáticamente al sumarse a partir de los hijos.
    const calcInteresIntlCompra = (c) => {
      if (!aplicaIntInternacional(c._tj_banco, c._tj_franquicia)) return 0;
      if (c.estado === 'diferida' || c.estado === 'pagado') return 0;
      const esIntl = c.es_internacional || (c.valor_usd && c.valor_usd > 0);
      if (!esIntl) return 0;
      const saldo = (c.valor_cop || 0) - (c.monto_abonado || 0);
      if (saldo <= 0) return 0;
      const tasaIntl = c._tj_tasa_intl || 0.01911;
      const diaCorte = c._tj_dia_corte || 30;
      if (!c.ciclo) return 0;
      const [yr, mo] = c.ciclo.split('-').map(Number);
      const lastDay = new Date(yr, mo, 0).getDate();
      const fCorte = new Date(yr, mo - 1, Math.min(diaCorte, lastDay)).toISOString().slice(0, 10);
      const dias = daysBetween(c.fecha, fCorte);
      if (dias <= 0) return 0;
      return Math.round(saldo * tasaIntl * (dias / 30));
    };

    const stripTj = (c) => {
      const { _tj_banco, _tj_franquicia, _tj_tasa_intl, _tj_dia_corte, ...rest } = c;
      return rest;
    };

    const result = compras.map(c => {
      const interes_intl = calcInteresIntlCompra(c);
      if (c.estado !== 'diferida' || !c.diferida_id) {
        return { ...stripTj(c), interes_intl };
      }
      const dif = db.prepare('SELECT * FROM diferidas WHERE id=?').get(c.diferida_id);
      if (!dif) return { ...stripTj(c), interes_intl };
      const amort = calcularAmortizacionDiferida(c.valor_cop, dif.tasa_mv, dif.num_cuotas, dif.fecha_compra, dif.fecha_primer_corte, null, nuOpts(db, c.tarjeta_id));
      const proxima = ciclo
        ? amort.tabla.find(r => r.fechaCorte.slice(0, 7) === ciclo)
        : amort.tabla.find(r => r.fechaCorte >= hoy);
      const cuotaNum = proxima ? proxima.numCuota : dif.num_cuotas;
      const bolCuota = db.prepare('SELECT monto FROM bolsillo_cuotas WHERE compra_id=? AND cuota_num=?').get(c.id, cuotaNum);
      return {
        ...stripTj(c),
        interes_intl,
        cuotaCorte: proxima ? Math.round(proxima.totalPagar) : 0,
        cuota_num: cuotaNum,
        cuotas_total: dif.num_cuotas,
        monto_bolsillo_cuota: bolCuota ? Math.round(bolCuota.monto) : 0
      };
    });
    res.json(result);
  });

  router.get('/resumen', (req, res) => {
    const { ciclo, tarjeta_id } = req.query;
    let sql = `SELECT p.id as persona_id, p.nombre, p.color,
                      COALESCE(SUM(c.valor_cop - COALESCE(c.monto_abonado,0)), 0) as total,
                      COUNT(c.id) as num_compras
               FROM compras c
               JOIN personas p ON c.persona_id = p.id WHERE c.estado NOT IN ('pagado','diferida')`;
    const params = [];
    if (tarjeta_id) { sql += ' AND c.tarjeta_id = ?'; params.push(tarjeta_id); }
    if (ciclo) { sql += ' AND c.ciclo = ?'; params.push(ciclo); }
    sql += ' GROUP BY c.persona_id ORDER BY total DESC';
    const rows = db.prepare(sql).all(...params);

    let sqlPersonal = "SELECT COALESCE(SUM(valor_cop - COALESCE(monto_abonado,0)), 0) as total, COUNT(id) as num_compras FROM compras WHERE persona_id IS NULL AND estado NOT IN ('pagado','diferida')";
    const pParams = [];
    if (tarjeta_id) { sqlPersonal += ' AND tarjeta_id = ?'; pParams.push(tarjeta_id); }
    if (ciclo) { sqlPersonal += ' AND ciclo = ?'; pParams.push(ciclo); }
    const personal = db.prepare(sqlPersonal).get(...pParams);

    const totalGeneral = rows.reduce((s, r) => s + r.total, 0) + (personal ? personal.total : 0);
    res.json({ porPersona: rows, personal, totalGeneral });
  });

  router.post('/', (req, res) => {
    const { tarjeta_id, fecha, descripcion, valor_cop, valor_usd, tasa_usd, persona_id, estado, notas, diferida_id, grupo_id, es_internacional } = req.body;
    const ciclo = calcCiclo(fecha, tarjeta_id);
    const r = db.prepare(`INSERT INTO compras (tarjeta_id, fecha, descripcion, valor_cop, valor_usd, tasa_usd, persona_id, estado, ciclo, notas, diferida_id, grupo_id, es_internacional)
                          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(tarjeta_id || null, fecha, descripcion, valor_cop, valor_usd || null, tasa_usd || null, persona_id || null, estado || 'pendiente', ciclo, notas || null, diferida_id || null, grupo_id || null, es_internacional ? 1 : 0);
    const fmt = new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',maximumFractionDigits:0}).format(valor_cop);
    logAction('crear', tjNombre(tarjeta_id) + 'Compra registrada: ' + descripcion + ' por ' + fmt);
    res.json({ id: r.lastInsertRowid });
  });

  router.put('/:id', (req, res) => {
    const { tarjeta_id, fecha, descripcion, valor_cop, valor_usd, tasa_usd, persona_id, estado, notas, monto_bolsillo, es_internacional } = req.body;
    const ciclo = calcCiclo(fecha, tarjeta_id);
    const current = db.prepare('SELECT estado, monto_bolsillo, es_internacional FROM compras WHERE id=?').get(req.params.id);
    const finalEstado = estado || (current ? current.estado : 'pendiente');
    const finalBolsillo = monto_bolsillo !== undefined ? (monto_bolsillo || 0) : (current ? current.monto_bolsillo : 0);
    const finalIntl = es_internacional !== undefined ? (es_internacional ? 1 : 0) : (current ? (current.es_internacional || 0) : 0);
    db.prepare(`UPDATE compras SET tarjeta_id=?, fecha=?, descripcion=?, valor_cop=?, valor_usd=?, tasa_usd=?, persona_id=?, estado=?, ciclo=?, notas=?, monto_bolsillo=?, es_internacional=? WHERE id=?`)
      .run(tarjeta_id, fecha, descripcion, valor_cop, valor_usd, tasa_usd, persona_id, finalEstado, ciclo, notas, finalBolsillo, finalIntl, req.params.id);
    logAction('editar', tjNombre(tarjeta_id) + 'Compra editada: ' + descripcion);
    res.json({ ok: true });
  });

  router.put('/:id/bolsillo', (req, res) => {
    const { monto_bolsillo, cuota_num } = req.body;
    const c = db.prepare('SELECT * FROM compras WHERE id=?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Compra no encontrada' });
    const nuevoMonto = Math.round(parseFloat(monto_bolsillo) || 0);

    if (cuota_num != null && c.estado === 'diferida') {
      // Per-cuota bolsillo para diferidas
      if (nuevoMonto > 0) {
        db.prepare('INSERT INTO bolsillo_cuotas (compra_id, cuota_num, monto) VALUES (?,?,?) ON CONFLICT(compra_id, cuota_num) DO UPDATE SET monto=?')
          .run(c.id, cuota_num, nuevoMonto, nuevoMonto);
      } else {
        db.prepare('DELETE FROM bolsillo_cuotas WHERE compra_id=? AND cuota_num=?').run(c.id, cuota_num);
      }
      // Actualizar cache en compras.monto_bolsillo como suma total
      const sum = db.prepare('SELECT COALESCE(SUM(monto),0) as total FROM bolsillo_cuotas WHERE compra_id=?').get(c.id);
      db.prepare('UPDATE compras SET monto_bolsillo=? WHERE id=?').run(sum.total, c.id);
      const fmt = new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',maximumFractionDigits:0}).format(nuevoMonto);
      logAction('editar', tjNombre(c.tarjeta_id) + 'Bolsillo cuota ' + cuota_num + ': ' + c.descripcion + ' - Apartado: ' + fmt);
      res.json({ ok: true, estado: 'diferida', monto_bolsillo: sum.total, cuota_num, monto_cuota: nuevoMonto });
    } else {
      // Non-diferida: bolsillo global
      const nuevoEstado = c.estado === 'diferida' ? 'diferida'
        : nuevoMonto >= c.valor_cop ? 'bolsillo' : nuevoMonto > 0 ? 'bolsillo_parcial' : 'pendiente';
      db.prepare('UPDATE compras SET monto_bolsillo=?, estado=? WHERE id=?').run(nuevoMonto, nuevoEstado, c.id);
      const fmt = new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',maximumFractionDigits:0}).format(nuevoMonto);
      logAction('editar', tjNombre(c.tarjeta_id) + 'Bolsillo actualizado: ' + c.descripcion + ' - Apartado: ' + fmt);
      res.json({ ok: true, estado: nuevoEstado, monto_bolsillo: nuevoMonto });
    }
  });

  router.delete('/:id', (req, res) => {
    const c = db.prepare('SELECT descripcion, tarjeta_id, diferida_id FROM compras WHERE id=?').get(req.params.id);
    db.prepare('DELETE FROM compras WHERE id=?').run(req.params.id);
    // Si la compra tenía diferida vinculada y ya no queda ninguna otra compra referenciándola,
    // borrar la diferida también para que no quede sumando en deudaDiferidas (bug: cupo total)
    if (c && c.diferida_id) {
      const ref = db.prepare('SELECT COUNT(*) as n FROM compras WHERE diferida_id=?').get(c.diferida_id);
      if (!ref || ref.n === 0) {
        db.prepare('DELETE FROM diferidas WHERE id=?').run(c.diferida_id);
      }
    }
    logAction('eliminar', tjNombre(c ? c.tarjeta_id : null) + 'Compra eliminada: ' + (c ? c.descripcion : 'ID ' + req.params.id));
    res.json({ ok: true });
  });

  return router;
};
