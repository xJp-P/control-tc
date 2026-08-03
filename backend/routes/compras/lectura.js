'use strict';
// backend/routes/compras/lectura.js
//
// Rutas movidas VERBATIM desde compras.js. Se registran sobre el MISMO router que crea el
// archivo padre, no sobre un sub-router montado: asi el stack de Express conserva su
// forma y su ORDEN exactos, y el contrato que se ve desde fuera no cambia ni un apice.
const { hoyLocal, daysBetween } = require('../../helpers/dates');
const { calcularAmortizacionDiferida } = require('../../engine/amortizacion');
const { nuOptsDif, aplicaIntInternacional } = require('../../helpers/banco');

module.exports = function(router, ctx) {
  const { db, logAction, tjNombre, calcCiclo, avisoCifraOficial, esCicloPagado, esCicloCerrado, targetBolsillo } = ctx;

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
    // Orden de display: fecha DESC; ante misma fecha, última EDICIÓN MANUAL primero (updated_at DESC,
    // COALESCE con created_at para filas viejas); id DESC como desempate determinista final. El frontend
    // (purchaseRows) replica exactamente este criterio para reordenar EN VIVO al guardar sin recargar.
    sql += ' ORDER BY c.fecha DESC, COALESCE(c.updated_at, c.created_at) DESC, c.id DESC';
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
      // Snapshot histórico: si la compra tiene su tasa congelada (tasa_intl), se usa esa; si no, la
      // tasa global actual de la tarjeta. Evita reescribir el interés de compras ya facturadas.
      const tasaIntl = (c.tasa_intl != null ? c.tasa_intl : (c._tj_tasa_intl || 0.01911));
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
      const amort = calcularAmortizacionDiferida(c.valor_cop, dif.tasa_mv, dif.num_cuotas, dif.fecha_compra, dif.fecha_primer_corte, null, nuOptsDif(db, dif));
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
        reprog_total: dif.reprog_total || null,
        // Marca de diferida HIJA de reprogramacion de saldo: el frontend la OCULTA de la tabla de Compras
        // (la compra renacida no es una compra real, es el saldo vivo del plan -> vive solo en Diferidas).
        sin_gracia_cuota1: dif.sin_gracia_cuota1 || 0,
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

  // Asistente INTL: devuelve descripciones (deduplicadas, lowercase, trimmed) que ACTUALMENTE
  // tienen al menos una compra marcada como es_internacional=1. La consulta es en tiempo real:
  // si el usuario desmarca el flag intl de una compra y no quedan más con esa descripcion
  // marcadas, ya no aparecerá en este listado en la siguiente petición (auto-desaprendizaje).
  router.get('/intl-descripciones', (req, res) => {
    const rows = db.prepare(`
      SELECT DISTINCT LOWER(TRIM(descripcion)) as descripcion
      FROM compras
      WHERE es_internacional = 1
        AND descripcion IS NOT NULL
        AND TRIM(descripcion) != ''
      ORDER BY descripcion
    `).all();
    res.json(rows.map(r => r.descripcion));
  });

  // Autocompletado del campo "Nombre en el Extracto": nombres distintos ya usados en compras
  // (case original preservado, ej. "APPLE.COM/US"), ordenados alfabéticamente. Alimenta el
  // <datalist> del CompraForm. Va aquí (con los GET de metadatos) antes de las rutas con :id.
  router.get('/nombres-unicos', (req, res) => {
    // Aislamiento por tarjeta: con ?tarjeta_id solo se sugieren descripciones YA usadas en ESA tarjeta
    // (evita mezclar el historial entre tarjetas, ej. estando en la Visa no sugerir nombres de la
    // RappiCard). Sin tarjeta_id → histórico global (compatibilidad con cualquier otro consumidor).
    const { tarjeta_id } = req.query;
    let sql = "SELECT DISTINCT descripcion FROM compras WHERE descripcion IS NOT NULL AND TRIM(descripcion) != ''";
    const params = [];
    if (tarjeta_id) { sql += ' AND tarjeta_id = ?'; params.push(tarjeta_id); }
    sql += ' ORDER BY descripcion ASC';
    const rows = db.prepare(sql).all(...params);
    res.json(rows.map(r => r.descripcion));
  });
};
