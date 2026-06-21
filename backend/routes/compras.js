// backend/routes/compras.js — CRUD /api/compras + bolsillo
const { Router } = require('express');
const { hoyLocal, daysBetween, primerCorteAvance } = require('../helpers/dates');
const { calcularAmortizacionDiferida } = require('../engine/amortizacion');
const { nuOpts, aplicaIntInternacional } = require('../helpers/banco');
const { compraTerceroConReembolso } = require('../helpers/bolsillo');
const { getCortesCustomMap, cicloConCorte } = require('../helpers/cortes');

module.exports = function(db, { logAction, tjNombre }) {
  const router = Router();

  function calcCiclo(fecha, tarjetaId) {
    const tj = db.prepare('SELECT dia_corte FROM tarjetas WHERE id=?').get(tarjetaId);
    const diaCorte = (tj && tj.dia_corte) || 30;
    // Ciclo = regla normal por dia_corte global + desvío por corte ADELANTADO (cortes_custom):
    // si el banco cortó antes del dia_corte teórico, las compras hechas después de ese corte real
    // saltan al ciclo siguiente. cicloConCorte cae al ciclo teórico normal si no hay override
    // (la aritmética año/mes directa de calcCicloLocal evita el desborde de día 31→mes+2).
    return cicloConCorte(fecha, diaCorte, getCortesCustomMap(db, tarjetaId));
  }

  // ¿El ciclo ya CERRÓ para la tarjeta? (cerrado ≠ pagado: el banco ya generó ese extracto,
  // esté pagado o no — su contenido queda sellado.) Punto único de la política de inmutabilidad
  // estructural de ciclos cerrados: crear/editar/borrar/mover/fusionar/dividir compras de un
  // ciclo cerrado descuadra lo facturado. La conciliación IA queda exenta caso por caso vía
  // desde_conciliacion=true (corrige el pasado con confirmación del usuario); el guard de
  // ciclos PAGADOS de cada endpoint es independiente y aplica siempre.
  function esCicloCerrado(tarjetaId, ciclo) {
    if (!ciclo) return false;
    const tj = db.prepare('SELECT dia_corte FROM tarjetas WHERE id=?').get(tarjetaId);
    const diaCorte = (tj && tj.dia_corte) || 30;
    // Vigente CONSCIENTE del corte adelantado (cortes_custom): si el banco cortó antes del día
    // teórico, el ciclo en curso avanza y el anterior queda CERRADO de inmediato (su extracto ya
    // se generó). cicloConCorte sólo ADELANTA (nunca retrocede) → no sella de más; sin override en
    // cortes_custom cae al ciclo teórico, idéntico al comportamiento previo. Las compras que el
    // motor empujó al ciclo siguiente (ventana post-corte) quedan en el vigente → NO se sellan.
    return ciclo < cicloConCorte(hoyLocal(), diaCorte, getCortesCustomMap(db, tarjetaId));
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
    const rows = db.prepare(`
      SELECT DISTINCT descripcion
      FROM compras
      WHERE descripcion IS NOT NULL AND TRIM(descripcion) != ''
      ORDER BY descripcion ASC
    `).all();
    res.json(rows.map(r => r.descripcion));
  });

  router.post('/', (req, res) => {
    const { tarjeta_id, fecha, descripcion, valor_cop, valor_usd, tasa_usd, persona_id, estado, notas, nota_personal, diferida_id, grupo_id, es_internacional, ciclo: cicloBody, ciclo_manual, tasa_intl } = req.body;
    // ciclo_manual=1 con un ciclo explícito → se respeta ese ciclo (ej. cuota reprogramada que
    // se paga en otro ciclo distinto al de su fecha). Si no, el ciclo se deriva de la fecha.
    const cicloManual = ciclo_manual ? 1 : 0;
    const ciclo = (cicloManual && cicloBody) ? cicloBody : calcCiclo(fecha, tarjeta_id);
    // Inmutabilidad: no permitir agregar una compra a un ciclo cuyo extracto ya está pagado/cerrado.
    // Agregar movimientos a un ciclo cerrado descuadra el total que ya se cerró con el banco.
    // (Espejo de la regla que ya bloquea editar/eliminar compras de ciclos pagados.)
    const extCiclo = db.prepare("SELECT estado FROM extractos WHERE tarjeta_id=? AND ciclo=?").get(tarjeta_id, ciclo);
    if (extCiclo && extCiclo.estado === 'pagado') {
      return res.status(403).json({ error: 'No se puede agregar la compra: el extracto del ciclo ' + ciclo + ' ya está pagado. Los ciclos cerrados no admiten nuevos movimientos.' });
    }
    // Inmutabilidad estructural (cerrado ≠ pagado): tampoco se crean compras en un ciclo anterior
    // al vigente — ese extracto el banco ya lo generó. La conciliación IA (crear_compra de una
    // compra que el extracto trae y la app no tiene) queda exenta vía desde_conciliacion.
    if (!(req.body && req.body.desde_conciliacion) && esCicloCerrado(tarjeta_id, ciclo)) {
      return res.status(403).json({ error: 'No se puede agregar la compra: el ciclo ' + ciclo + ' ya cerró (el banco ya generó ese extracto). Si el extracto real la incluye, usa el Asistente IA de conciliación.' });
    }
    // "Snapshot al nacer": si no se especifica tasa_intl y la tarjeta cobra interés sobre compras
    // internacionales (Bancolombia Visa), congela la tasa ACTUAL de la tarjeta en la compra → nace
    // inmune a cambios futuros de la tasa global. El fallback (?? tasa_global) queda SOLO para las
    // compras históricas que ya quedaron en NULL antes de esta función.
    let tasaIntlFinal = (tasa_intl != null && tasa_intl !== '') ? Number(tasa_intl) : null;
    if (tasaIntlFinal == null) {
      const tjRate = db.prepare('SELECT banco, franquicia, tasa_mv_avances FROM tarjetas WHERE id=?').get(tarjeta_id);
      if (tjRate && aplicaIntInternacional(tjRate.banco, tjRate.franquicia) && tjRate.tasa_mv_avances != null) {
        tasaIntlFinal = tjRate.tasa_mv_avances;
      }
    }
    const r = db.prepare(`INSERT INTO compras (tarjeta_id, fecha, descripcion, valor_cop, valor_usd, tasa_usd, persona_id, estado, ciclo, notas, nota_personal, diferida_id, grupo_id, es_internacional, ciclo_manual, tasa_intl)
                          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(tarjeta_id || null, fecha, descripcion, valor_cop, valor_usd || null, tasa_usd || null, persona_id || null, estado || 'pendiente', ciclo, notas || null, nota_personal || null, diferida_id || null, grupo_id || null, es_internacional ? 1 : 0, cicloManual, tasaIntlFinal);
    const fmt = new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',maximumFractionDigits:0}).format(valor_cop);
    logAction('crear', tjNombre(tarjeta_id) + 'Compra registrada: ' + descripcion + ' por ' + fmt);
    res.json({ id: r.lastInsertRowid });
  });

  router.put('/:id', (req, res) => {
    const { tarjeta_id, fecha, descripcion, valor_cop, valor_usd, tasa_usd, persona_id, estado, notas, nota_personal, monto_bolsillo, es_internacional, ciclo: cicloBody, ciclo_manual, tasa_intl } = req.body;
    const current = db.prepare('SELECT * FROM compras WHERE id=?').get(req.params.id);
    // ciclo_manual: si viene en el body lo usamos; si no, conservamos el de la compra. Con
    // ciclo_manual=1 y un ciclo explícito se respeta ese ciclo; si no, se deriva de la fecha.
    const cicloManual = ciclo_manual !== undefined ? (ciclo_manual ? 1 : 0) : (current ? (current.ciclo_manual || 0) : 0);
    const ciclo = (cicloManual && cicloBody) ? cicloBody : calcCiclo(fecha, tarjeta_id);
    // Inmutabilidad: si el extracto del ciclo actual de la compra ya está pagado, bloquear.
    if (current) {
      const ext = db.prepare("SELECT estado FROM extractos WHERE tarjeta_id=? AND ciclo=?").get(current.tarjeta_id, current.ciclo);
      if (ext && ext.estado === 'pagado') {
        return res.status(403).json({ error: 'No se puede editar: el extracto del ciclo ' + current.ciclo + ' ya está pagado.' });
      }
    }
    // Inmutabilidad estructural (ciclo CERRADO ≠ pagado): si la compra pertenece a un ciclo anterior
    // al vigente de su tarjeta, el banco YA generó ese extracto (esté pagado o no) — fecha, valores,
    // persona, flag intl, ciclo, etc. quedan sellados. Solo pasan los campos COSMÉTICOS (descripcion,
    // nota_personal, notas): renombrar es seguro siempre y mejora el cruce de la conciliación IA
    // (espejo del PUT restringido de avances/diferidas). La CONCILIACIÓN IA queda exenta
    // (desde_conciliacion=true): corrige valores/ciclos de extractos pasados con confirmación del
    // usuario; su candado de ciclos PAGADOS (arriba) sigue aplicando igual.
    if (current && !(req.body && req.body.desde_conciliacion)) {
      if (esCicloCerrado(current.tarjeta_id, current.ciclo)) {
        const descCerr = descripcion !== undefined ? descripcion : current.descripcion;
        const notaCerr = nota_personal !== undefined ? (nota_personal || null) : (current.nota_personal || null);
        const notasCerr = notas !== undefined ? (notas || null) : (current.notas || null);
        db.prepare('UPDATE compras SET descripcion=?, nota_personal=?, notas=? WHERE id=?')
          .run(descCerr, notaCerr, notasCerr, req.params.id);
        logAction('editar', tjNombre(current.tarjeta_id) + 'Compra editada (solo nombre/nota — ciclo ' + current.ciclo + ' cerrado): ' + descCerr);
        return res.json({ ok: true, solo_cosmetico: true });
      }
      // Fuga inversa: la compra está en un ciclo abierto pero el DESTINO (derivado de la nueva
      // fecha/tarjeta o del ciclo manual) ya cerró — moverla ahí inyectaría un movimiento a un
      // extracto ya facturado, igual que crearla allá. Mismo candado, misma exención.
      if (esCicloCerrado(tarjeta_id, ciclo)) {
        return res.status(403).json({ error: 'No se puede mover la compra al ciclo ' + ciclo + ': ese ciclo ya cerró (el banco ya generó ese extracto). Si el extracto real la incluye, usa el Asistente IA de conciliación.' });
      }
    }
    let finalEstado = estado || (current ? current.estado : 'pendiente');
    let finalBolsillo = monto_bolsillo !== undefined ? (monto_bolsillo || 0) : (current ? current.monto_bolsillo : 0);
    const finalIntl = es_internacional !== undefined ? (es_internacional ? 1 : 0) : (current ? (current.es_internacional || 0) : 0);
    const finalNota = nota_personal !== undefined ? (nota_personal || null) : (current ? (current.nota_personal || null) : null);
    // tasa_intl congelada: si viene en el body se usa (null/'' la limpia); si no, se conserva la actual.
    const finalTasaIntl = tasa_intl !== undefined ? (tasa_intl != null && tasa_intl !== '' ? Number(tasa_intl) : null) : (current ? (current.tasa_intl != null ? current.tasa_intl : null) : null);
    // Reconciliar el bolsillo COP al editar una compra NO diferida: si cambió el valor, la
    // moneda o el flag internacional, el monto apartado podría superar el nuevo tope
    // (valor [+ interés intl]). Lo re-cap-eamos y recalculamos el estado contra ese tope real
    // (incluye interés), para que editar el valor —sobre todo bajarlo— no deje el bolsillo
    // inflado ni un estado "cubierto" falso. Las diferidas usan bolsillo per-cuota
    // (bolsillo_cuotas) y no se tocan aquí.
    if (current && current.estado !== 'diferida' && finalEstado !== 'diferida') {
      const topeEdit = targetBolsillo({ valor_cop, valor_usd, es_internacional: finalIntl, ciclo, fecha, tarjeta_id, tasa_intl: finalTasaIntl }, 'COP', null);
      if (topeEdit != null) {
        if (finalBolsillo > topeEdit) finalBolsillo = topeEdit;
        finalEstado = (topeEdit > 0 && finalBolsillo >= topeEdit) ? 'bolsillo' : (finalBolsillo > 0 ? 'bolsillo_parcial' : 'pendiente');
      }
    }
    db.prepare(`UPDATE compras SET tarjeta_id=?, fecha=?, descripcion=?, valor_cop=?, valor_usd=?, tasa_usd=?, persona_id=?, estado=?, ciclo=?, notas=?, nota_personal=?, tasa_intl=?, monto_bolsillo=?, es_internacional=?, ciclo_manual=? WHERE id=?`)
      .run(tarjeta_id, fecha, descripcion, valor_cop, valor_usd, tasa_usd, persona_id, finalEstado, ciclo, notas, finalNota, finalTasaIntl, finalBolsillo, finalIntl, cicloManual, req.params.id);

    // SINCRONIZAR diferida vinculada: si la compra tiene diferida_id, mantener
    // alineadas fecha_compra y fecha_primer_corte (y tarjeta_id si cambió).
    // Sin esto, editar la fecha de una compra a cuotas dejaba la diferida con su
    // amortización original — las cuotas se mostraban en el mes equivocado.
    if (current && current.diferida_id && (current.fecha !== fecha || current.tarjeta_id !== tarjeta_id)) {
      const tjRow = db.prepare('SELECT dia_corte FROM tarjetas WHERE id=?').get(tarjeta_id);
      const diaCorte = tjRow ? (tjRow.dia_corte || 30) : 30;
      const fechaPrimerCorte = primerCorteAvance(fecha, diaCorte);
      db.prepare('UPDATE diferidas SET tarjeta_id=?, fecha_compra=?, fecha_primer_corte=? WHERE id=?')
        .run(tarjeta_id, fecha, fechaPrimerCorte, current.diferida_id);
      logAction('editar', tjNombre(tarjeta_id) + 'Diferida sincronizada con compra editada (fecha → ' + fecha + ', primer corte → ' + fechaPrimerCorte + ')');
    }

    logAction('editar', tjNombre(tarjeta_id) + 'Compra editada: ' + descripcion);
    res.json({ ok: true });
  });

  // Calcula el target máximo del bolsillo de una compra (lo que realmente costará):
  //   - Diferida per-cuota: el total de esa cuota (COP) o valor_usd/num_cuotas (USD).
  //   - 1 cuota COP: valor_cop + interés intl (si la tarjeta lo cobra, ej. Bancolombia Visa).
  //   - 1 cuota USD: valor_usd.
  // Se usa para CAP-ear el monto apartado: no tiene sentido guardar en el bolsillo más de lo
  // que la compra va a costar. Para intl el tope incluye el interés (por eso no es solo valor_cop).
  function targetBolsillo(c, monedaPago, cuotaNum) {
    if (cuotaNum != null && c.estado === 'diferida') {
      const dif = c.diferida_id ? db.prepare('SELECT * FROM diferidas WHERE id=?').get(c.diferida_id) : null;
      if (!dif) return null; // sin diferida vinculada no podemos calcular el tope → no cap-eamos
      if (monedaPago === 'USD') return Math.round(((c.valor_usd || 0) / dif.num_cuotas) * 100) / 100;
      const amort = calcularAmortizacionDiferida(c.valor_cop, dif.tasa_mv, dif.num_cuotas, dif.fecha_compra, dif.fecha_primer_corte, null, nuOpts(db, c.tarjeta_id));
      const cuotaObj = amort.tabla.find(r => r.numCuota === cuotaNum);
      return cuotaObj ? Math.round(cuotaObj.totalPagar) : null;
    }
    if (monedaPago === 'USD') return Math.round((c.valor_usd || 0) * 100) / 100;
    let tgt = c.valor_cop;
    if (c.es_internacional && c.ciclo) {
      const tj = db.prepare('SELECT banco, franquicia, tasa_mv_avances, dia_corte FROM tarjetas WHERE id=?').get(c.tarjeta_id);
      if (tj && aplicaIntInternacional(tj.banco, tj.franquicia)) {
        const tasaIntl = (c.tasa_intl != null ? c.tasa_intl : (tj.tasa_mv_avances || 0.01911));
        const diaCorte = tj.dia_corte || 30;
        const [yr, mo] = c.ciclo.split('-').map(Number);
        const lastDay = new Date(yr, mo, 0).getDate();
        const fCorte = new Date(yr, mo - 1, Math.min(diaCorte, lastDay)).toISOString().slice(0, 10);
        const dias = daysBetween(c.fecha, fCorte);
        if (dias > 0) tgt += Math.round(c.valor_cop * tasaIntl * (dias / 30));
      }
    }
    return tgt;
  }

  router.put('/:id/bolsillo', (req, res) => {
    const { monto_bolsillo, cuota_num, moneda } = req.body;
    const c = db.prepare('SELECT * FROM compras WHERE id=?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Compra no encontrada' });
    // Candado de Terceros: el bolsillo de una compra de tercero ES su reembolso y SOLO se gestiona
    // desde la pestaña Terceros (que envía desde_terceros=true). Desde las vistas generales
    // (Movimientos/Diferidas) no se permite tocarlo, para no corromper la contabilidad del deudor.
    if (c.persona_id && !(req.body && req.body.desde_terceros)) {
      return res.status(403).json({ error: 'El bolsillo de una compra de tercero se gestiona desde la pestaña Terceros.' });
    }
    // Inferir moneda: explícita > heurística (compra USD pura).
    const compraEsUsd = (c.valor_usd && c.valor_usd > 0) && !c.valor_cop;
    const monedaPago = moneda === 'USD' ? 'USD' : (moneda === 'COP' ? 'COP' : (compraEsUsd ? 'USD' : 'COP'));
    let nuevoMonto = monedaPago === 'USD'
      ? (Math.round((parseFloat(monto_bolsillo) || 0) * 100) / 100)
      : Math.round(parseFloat(monto_bolsillo) || 0);

    // CAP: nunca apartar más que lo que la compra va a costar (valor [+ interés intl] / cuota).
    let capped = false;
    const tope = targetBolsillo(c, monedaPago, cuota_num);
    if (tope != null && nuevoMonto > tope) { nuevoMonto = tope; capped = true; }

    if (cuota_num != null && c.estado === 'diferida') {
      // Per-cuota bolsillo para diferidas
      if (nuevoMonto > 0) {
        db.prepare('INSERT INTO bolsillo_cuotas (compra_id, cuota_num, monto, moneda) VALUES (?,?,?,?) ON CONFLICT(compra_id, cuota_num) DO UPDATE SET monto=?, moneda=?')
          .run(c.id, cuota_num, nuevoMonto, monedaPago, nuevoMonto, monedaPago);
      } else {
        db.prepare('DELETE FROM bolsillo_cuotas WHERE compra_id=? AND cuota_num=?').run(c.id, cuota_num);
      }
      // Caches separados por moneda
      const sumCop = db.prepare("SELECT COALESCE(SUM(monto),0) as total FROM bolsillo_cuotas WHERE compra_id=? AND COALESCE(moneda,'COP')='COP'").get(c.id);
      const sumUsd = db.prepare("SELECT COALESCE(SUM(monto),0) as total FROM bolsillo_cuotas WHERE compra_id=? AND moneda='USD'").get(c.id);
      db.prepare('UPDATE compras SET monto_bolsillo=?, monto_bolsillo_usd=? WHERE id=?').run(sumCop.total, sumUsd.total, c.id);
      const fmt = monedaPago === 'USD'
        ? 'USD $' + new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(nuevoMonto)
        : new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(nuevoMonto);
      logAction('editar', tjNombre(c.tarjeta_id) + 'Bolsillo cuota ' + cuota_num + ' (' + monedaPago + '): ' + c.descripcion + ' - Apartado: ' + fmt);
      res.json({ ok: true, estado: 'diferida', moneda: monedaPago, monto_bolsillo: sumCop.total, monto_bolsillo_usd: sumUsd.total, cuota_num, monto_cuota: nuevoMonto, capped, tope });
    } else {
      // Non-diferida: bolsillo global. Para compras USD comparamos contra valor_usd; COP contra valor_cop.
      const target = monedaPago === 'USD' ? (c.valor_usd || 0) : c.valor_cop;
      const nuevoEstado = c.estado === 'diferida' ? 'diferida'
        : nuevoMonto >= target ? 'bolsillo' : nuevoMonto > 0 ? 'bolsillo_parcial' : 'pendiente';
      if (monedaPago === 'USD') {
        db.prepare('UPDATE compras SET monto_bolsillo_usd=?, estado=? WHERE id=?').run(nuevoMonto, nuevoEstado, c.id);
      } else {
        db.prepare('UPDATE compras SET monto_bolsillo=?, estado=? WHERE id=?').run(nuevoMonto, nuevoEstado, c.id);
      }
      const fmt = monedaPago === 'USD'
        ? 'USD $' + new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(nuevoMonto)
        : new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(nuevoMonto);
      logAction('editar', tjNombre(c.tarjeta_id) + 'Bolsillo (' + monedaPago + '): ' + c.descripcion + ' - Apartado: ' + fmt);
      res.json({ ok: true, estado: nuevoEstado, moneda: monedaPago, monto_bolsillo: monedaPago === 'COP' ? nuevoMonto : (c.monto_bolsillo || 0), monto_bolsillo_usd: monedaPago === 'USD' ? nuevoMonto : (c.monto_bolsillo_usd || 0), capped, tope });
    }
  });

  // ── Convertir compra dividida (grupo) → 100% personal ──────────────
  // Fusiona todas las partes de un grupo_id en una sola compra personal
  // (persona_id=NULL). Suma valores y bolsillo (= mi plata apartada, se conserva).
  // Soporta compras a 1 cuota y diferidas (merge matemáticamente limpio: la
  // amortización es lineal en el monto, así que el resultado per-cuota = suma
  // de las partes).
  //
  // Bloqueo crítico: si alguna parte tiene reembolso REAL de tercero
  // (tercero_pagado=1 o tercero_monto_abonado>0), responde 409 con el detalle y
  // NO procede — salvo que el cliente envíe { force: true } (escape hatch con
  // doble confirmación en la UI). force borra esos abonos de terceros.
  router.post('/grupo/:grupoId/merge-personal', (req, res) => {
    const grupoId = req.params.grupoId;
    const force = !!(req.body && req.body.force);

    const partes = db.prepare('SELECT * FROM compras WHERE grupo_id=?').all(grupoId);
    if (!partes || partes.length === 0) return res.status(404).json({ error: 'Grupo no encontrado' });

    // Inmutabilidad: ninguna parte puede caer en un ciclo con extracto pagado.
    for (const p of partes) {
      const ext = db.prepare("SELECT estado FROM extractos WHERE tarjeta_id=? AND ciclo=?").get(p.tarjeta_id, p.ciclo);
      if (ext && ext.estado === 'pagado') {
        return res.status(403).json({ error: 'No se puede convertir: el extracto del ciclo ' + p.ciclo + ' ya está pagado.' });
      }
    }
    // Inmutabilidad estructural (cerrado ≠ pagado): fundir el grupo borra las partes de terceros
    // de un extracto que el banco ya facturó. Sin exención: la conciliación IA no fusiona grupos.
    const parteCerrada = partes.find(p => esCicloCerrado(p.tarjeta_id, p.ciclo));
    if (parteCerrada) {
      return res.status(403).json({ error: 'No se puede convertir: la compra pertenece al ciclo ' + parteCerrada.ciclo + ', que ya cerró (el banco ya generó ese extracto).' });
    }

    // Bloqueo crítico: reembolsos reales de terceros (no confundir con bolsillo, que es mi plata).
    const conAbono = partes.filter(p => p.persona_id && (p.tercero_pagado || (p.tercero_monto_abonado || 0) > 0));
    if (conAbono.length > 0 && !force) {
      const detalle = conAbono.map(p => {
        const per = db.prepare('SELECT nombre FROM personas WHERE id=?').get(p.persona_id);
        const monto = (p.tercero_monto_abonado || 0) > 0 ? p.tercero_monto_abonado : p.valor_cop;
        return { persona_nombre: per ? per.nombre : 'Tercero', monto: Math.round(monto) };
      });
      const total = detalle.reduce((s, d) => s + d.monto, 0);
      return res.status(409).json({
        error: 'tercero_abonos',
        needsForce: true,
        detalle,
        total,
        message: 'Hay dinero reembolsado por terceros que se eliminará si continúas.'
      });
    }

    const esDiferida = partes.some(p => p.estado === 'diferida' && p.diferida_id);

    const compraIdFinal = db.transaction(() => {
      // Survivor: la parte personal si existe; si no, la primera parte.
      const survivor = partes.find(p => p.persona_id == null) || partes[0];
      const otras = partes.filter(p => p.id !== survivor.id);

      const sumCop = partes.reduce((s, p) => s + (p.valor_cop || 0), 0);
      const sumUsd = partes.reduce((s, p) => s + (p.valor_usd || 0), 0);

      let survivorDiferidaId = survivor.diferida_id || null;
      let bolsilloCop, bolsilloUsd;

      if (esDiferida) {
        // Diferida base: la del survivor, o la de cualquier parte que tenga.
        let baseDif = survivor.diferida_id ? db.prepare('SELECT * FROM diferidas WHERE id=?').get(survivor.diferida_id) : null;
        if (!baseDif) {
          const anyP = partes.find(p => p.diferida_id);
          if (anyP) baseDif = db.prepare('SELECT * FROM diferidas WHERE id=?').get(anyP.diferida_id);
        }
        if (baseDif) {
          survivorDiferidaId = baseDif.id;
          db.prepare('UPDATE diferidas SET monto=? WHERE id=?').run(sumCop, baseDif.id);
          // Merge bolsillo_cuotas por (cuota_num, moneda) hacia el survivor.
          const ph = partes.map(() => '?').join(',');
          const allBol = db.prepare(`SELECT cuota_num, monto, COALESCE(moneda,'COP') as moneda FROM bolsillo_cuotas WHERE compra_id IN (${ph})`).all(...partes.map(p => p.id));
          const agg = {};
          allBol.forEach(b => { const k = b.cuota_num + '|' + b.moneda; agg[k] = (agg[k] || 0) + b.monto; });
          db.prepare('DELETE FROM bolsillo_cuotas WHERE compra_id=?').run(survivor.id);
          const insBol = db.prepare('INSERT INTO bolsillo_cuotas (compra_id, cuota_num, monto, moneda) VALUES (?,?,?,?)');
          Object.keys(agg).forEach(k => {
            if (agg[k] <= 0) return;
            const [cn, mon] = k.split('|');
            insBol.run(survivor.id, parseInt(cn), agg[k], mon);
          });
        }
        // Recompute caches desde las cuotas agregadas del survivor.
        const cCop = db.prepare("SELECT COALESCE(SUM(monto),0) as t FROM bolsillo_cuotas WHERE compra_id=? AND COALESCE(moneda,'COP')='COP'").get(survivor.id);
        const cUsd = db.prepare("SELECT COALESCE(SUM(monto),0) as t FROM bolsillo_cuotas WHERE compra_id=? AND moneda='USD'").get(survivor.id);
        bolsilloCop = cCop.t;
        bolsilloUsd = cUsd.t;
      } else {
        // 1-cuota: bolsillo = suma de los caches de las partes.
        bolsilloCop = partes.reduce((s, p) => s + (p.monto_bolsillo || 0), 0);
        bolsilloUsd = partes.reduce((s, p) => s + (p.monto_bolsillo_usd || 0), 0);
      }

      // Survivor → personal.
      db.prepare(`UPDATE compras SET persona_id=NULL, valor_cop=?, valor_usd=?, monto_bolsillo=?, monto_bolsillo_usd=?, grupo_id=NULL, tercero_pagado=0, tercero_monto_abonado=0, diferida_id=? WHERE id=?`)
        .run(sumCop, sumUsd || null, bolsilloCop, bolsilloUsd, survivorDiferidaId, survivor.id);

      // Recompute estado para 1-cuota (las diferidas conservan estado='diferida').
      if (!esDiferida) {
        const esUsdPura = (sumUsd > 0) && !sumCop;
        const target = esUsdPura ? sumUsd : sumCop;
        const bolCmp = esUsdPura ? bolsilloUsd : bolsilloCop;
        const nuevoEstado = (target > 0 && bolCmp >= target) ? 'bolsillo' : (bolCmp > 0 ? 'bolsillo_parcial' : 'pendiente');
        db.prepare('UPDATE compras SET estado=? WHERE id=?').run(nuevoEstado, survivor.id);
      }

      // Borrar las otras partes (cascade limpia sus bolsillo_cuotas) y sus diferidas huérfanas.
      for (const p of otras) {
        db.prepare('DELETE FROM compras WHERE id=?').run(p.id);
        if (p.diferida_id && p.diferida_id !== survivorDiferidaId) {
          const ref = db.prepare('SELECT COUNT(*) as n FROM compras WHERE diferida_id=?').get(p.diferida_id);
          if (!ref || ref.n === 0) db.prepare('DELETE FROM diferidas WHERE id=?').run(p.diferida_id);
        }
      }

      return survivor.id;
    })();

    logAction('editar', tjNombre(partes[0].tarjeta_id) + 'Compra dividida convertida a 100% personal: ' + partes[0].descripcion + (force && conAbono.length > 0 ? ' (abonos de terceros eliminados)' : ''));
    res.json({ ok: true, compraId: compraIdFinal });
  });

  // ── Reprogramar dividiendo en cuotas individuales (Ruta C: irregular) ─────────
  // Convierte una compra a cuotas (diferida) en N compras de 1 cuota con ciclo_manual, cada una con
  // su propio monto/ciclo. Modela las reprogramaciones IRREGULARES del banco (cuotas de distinto
  // monto/fecha) que una diferida uniforme no representa. La diferida queda sin compras → se elimina.
  // Espejo del patrón manual previo (modelar con varios movimientos de 1 cuota).
  // Body: { cuotas: [{ ciclo, monto, fecha?, es_internacional? }] } (1+ elementos).
  router.post('/:id/dividir-cuotas', (req, res) => {
    const { cuotas } = req.body || {};
    const c = db.prepare('SELECT * FROM compras WHERE id=?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Compra no encontrada' });
    if (!Array.isArray(cuotas) || cuotas.length < 1) return res.status(400).json({ error: 'Se requiere un arreglo de cuotas con al menos un elemento.' });
    for (const q of cuotas) {
      if (!q || !q.ciclo || !(Number(q.monto) > 0)) return res.status(400).json({ error: 'Cada cuota requiere ciclo (YYYY-MM) y monto > 0.' });
    }

    // Guard de Terceros: no dividir si la compra es de un tercero con reembolsos registrados
    // (reestructurarla en cuotas individuales perdería ese libro de deuda). Gestiónalos en Terceros.
    if (compraTerceroConReembolso(db, c.id)) {
      return res.status(403).json({ error: 'No se puede dividir: esta compra es de un tercero y ya tiene reembolsos registrados. Gestiona o retira esos abonos desde la pestaña Terceros antes de dividir.' });
    }

    // Inmutabilidad: ni el ciclo actual de la compra ni ningún ciclo destino puede estar pagado.
    const ciclosCheck = [...new Set([c.ciclo, ...cuotas.map(q => q.ciclo)])];
    for (const ci of ciclosCheck) {
      const ext = db.prepare("SELECT estado FROM extractos WHERE tarjeta_id=? AND ciclo=?").get(c.tarjeta_id, ci);
      if (ext && ext.estado === 'pagado') {
        return res.status(403).json({ error: 'No se puede dividir: el extracto del ciclo ' + ci + ' ya está pagado.' });
      }
    }
    // Inmutabilidad estructural (cerrado ≠ pagado): ni el ciclo actual ni los destinos pueden ser
    // ciclos ya cerrados. La conciliación IA (ruta C de reprogramar_cuotas: el banco reprogramó en
    // extractos pasados) queda exenta vía desde_conciliacion; el guard de pagados (arriba) le aplica.
    if (!(req.body && req.body.desde_conciliacion)) {
      const cicloCerr = ciclosCheck.find(ci => esCicloCerrado(c.tarjeta_id, ci));
      if (cicloCerr) {
        return res.status(403).json({ error: 'No se puede dividir: el ciclo ' + cicloCerr + ' ya cerró (el banco ya generó ese extracto). Las reprogramaciones del pasado se corrigen con el Asistente IA de conciliación.' });
      }
    }

    const n = cuotas.length;
    const ids = db.transaction(() => {
      const difId = c.diferida_id;
      // Cuota 1: reutiliza la compra original (1 cuota, ciclo_manual). Se desvincula de la diferida
      // y se limpia su bolsillo per-cuota.
      const q0 = cuotas[0];
      db.prepare('DELETE FROM bolsillo_cuotas WHERE compra_id=?').run(c.id);
      db.prepare(`UPDATE compras SET estado='pendiente', valor_cop=?, valor_usd=NULL, tasa_usd=NULL, fecha=?, ciclo=?, ciclo_manual=1, es_internacional=?, diferida_id=NULL, monto_bolsillo=0, monto_bolsillo_usd=0, descripcion=? WHERE id=?`)
        .run(Math.round(q0.monto), q0.fecha || c.fecha, q0.ciclo, q0.es_internacional ? 1 : 0, c.descripcion + ' (cuota 1/' + n + ')', c.id);
      const out = [c.id];
      // Cuotas 2..N: nuevas compras de 1 cuota con ciclo_manual.
      for (let i = 1; i < n; i++) {
        const q = cuotas[i];
        const r = db.prepare(`INSERT INTO compras (tarjeta_id, fecha, descripcion, valor_cop, persona_id, estado, ciclo, notas, es_internacional, ciclo_manual)
                              VALUES (?,?,?,?,?,?,?,?,?,1)`)
          .run(c.tarjeta_id, q.fecha || c.fecha, c.descripcion + ' (cuota ' + (i + 1) + '/' + n + ')', Math.round(q.monto), c.persona_id || null, 'pendiente', q.ciclo, c.notas || null, q.es_internacional ? 1 : 0);
        out.push(r.lastInsertRowid);
      }
      // La diferida quedó sin compras vinculadas → eliminarla (cascade limpia sus bolsillo_cuotas).
      if (difId) {
        const ref = db.prepare('SELECT COUNT(*) as n FROM compras WHERE diferida_id=?').get(difId);
        if (!ref || ref.n === 0) db.prepare('DELETE FROM diferidas WHERE id=?').run(difId);
      }
      return out;
    })();

    logAction('editar', tjNombre(c.tarjeta_id) + 'Compra dividida en ' + n + ' cuotas individuales: ' + c.descripcion);
    res.json({ ok: true, ids });
  });

  router.delete('/:id', (req, res) => {
    const c = db.prepare('SELECT descripcion, tarjeta_id, diferida_id, ciclo FROM compras WHERE id=?').get(req.params.id);
    // Inmutabilidad: bloquear si el extracto del ciclo ya está pagado.
    if (c) {
      const ext = db.prepare("SELECT estado FROM extractos WHERE tarjeta_id=? AND ciclo=?").get(c.tarjeta_id, c.ciclo);
      if (ext && ext.estado === 'pagado') {
        return res.status(403).json({ error: 'No se puede eliminar: el extracto del ciclo ' + c.ciclo + ' ya está pagado.' });
      }
      // Inmutabilidad estructural (cerrado ≠ pagado): borrar una compra de un ciclo que ya cerró
      // descuadra el extracto que el banco ya facturó. Exención desde_conciliacion reservada para
      // la conciliación IA (hoy ninguna acción IA elimina compras; queda latente por consistencia).
      if (!(req.body && req.body.desde_conciliacion) && esCicloCerrado(c.tarjeta_id, c.ciclo)) {
        return res.status(403).json({ error: 'No se puede eliminar: la compra pertenece al ciclo ' + c.ciclo + ', que ya cerró (el banco ya generó ese extracto).' });
      }
    }
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

  // ── Convertir compra de 1 cuota → diferida a N cuotas (in-place) ──────────
  // POST /:id/convertir-a-diferida  Body: { num_cuotas, cobrar_intereses }
  // La fila de `compras` NUNCA se borra ni recrea: conserva id, fecha y created_at originales
  // (la prelación de abonos del banco depende del orden cronológico real de las transacciones).
  // La conversión crea la diferida vinculada (mismos campos que el flujo de creación), traslada el
  // bolsillo ya apartado al per-cuota (secuencial desde la cuota 1, sin perder un peso) y muta
  // estado/diferida_id/notas. Transaccional: o todo o nada.
  // Alcance v1: solo compras COP individuales de 1 cuota; quedan fuera (bloqueadas) las partes de
  // grupo, USD, con abono parcial y terceros con reembolsos (mismo guard que reprogramar/dividir).
  router.post('/:id/convertir-a-diferida', (req, res) => {
    const { num_cuotas, cobrar_intereses } = req.body || {};
    const n = parseInt(num_cuotas, 10);
    if (!n || n < 2 || n > 60) return res.status(400).json({ error: 'El número de cuotas debe ser un entero entre 2 y 60.' });
    const c = db.prepare('SELECT * FROM compras WHERE id=?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Compra no encontrada' });
    if (c.estado === 'diferida' || c.diferida_id) return res.status(400).json({ error: 'La compra ya es diferida; su número de cuotas se cambia con la reprogramación.' });
    if (c.grupo_id) return res.status(403).json({ error: 'Esta compra es parte de una compra dividida; conviértela editando el grupo completo.' });
    if ((c.monto_abonado || 0) > 0) return res.status(400).json({ error: 'La compra tiene un abono parcial registrado; no se puede convertir a cuotas.' });
    // Una compra internacional de Visa (valor_cop>0 + USD informativo) SÍ se difiere: la amortización
    // corre sobre el COP. Solo se rechaza la compra USD PURA (sin valor en pesos, no amortizable en COP)
    // — lo cubre este guard de valor_cop (antes había además un guard de valor_usd>0 que bloqueaba de
    // más las compras internacionales con COP; se eliminó por redundante e incorrecto).
    if (!c.valor_cop || c.valor_cop <= 0) return res.status(400).json({ error: 'La compra no tiene valor en pesos para amortizar.' });
    if (compraTerceroConReembolso(db, c.id)) {
      return res.status(403).json({ error: 'No se puede convertir: esta compra es de un tercero y ya tiene reembolsos registrados. Gestiona o retira esos abonos desde la pestaña Terceros antes de convertir.' });
    }
    const tj = db.prepare('SELECT dia_corte, tasa_mv_diferidas FROM tarjetas WHERE id=?').get(c.tarjeta_id);
    const diaCorte = (tj && tj.dia_corte) || 30;
    // Inmutabilidad estructural: la compra debe pertenecer al ciclo VIGENTE (el que corre). Un ciclo
    // anterior ya CERRÓ (el banco generó ese extracto) aunque no esté pagado: su estructura de cuotas
    // queda sellada. Las ediciones estéticas (PUT regular) no pasan por aquí y siguen permitidas.
    const cicloVig = cicloConCorte(hoyLocal(), diaCorte, getCortesCustomMap(db, c.tarjeta_id));
    if (c.ciclo < cicloVig) {
      return res.status(403).json({ error: 'No se puede convertir: la compra pertenece al ciclo ' + c.ciclo + ', que ya cerró (el vigente es ' + cicloVig + '). El banco ya facturó ese extracto.' });
    }
    // Y dentro del vigente, tampoco si su extracto ya se pagó (pago anticipado).
    const extConv = db.prepare("SELECT estado FROM extractos WHERE tarjeta_id=? AND ciclo=?").get(c.tarjeta_id, c.ciclo);
    if (extConv && extConv.estado === 'pagado') {
      return res.status(403).json({ error: 'No se puede convertir: el extracto del ciclo ' + c.ciclo + ' ya está pagado.' });
    }
    // Primer corte = la fecha de corte del CICLO EFECTIVO de la compra (c.ciclo respeta ciclo_manual):
    // la cuota 1 cae exactamente en el ciclo donde hoy cuenta la compra. String directo (sin Date →
    // sin sorpresas de zona horaria). Para el caso normal coincide con primerCorteAvance(c.fecha).
    const [cy, cm] = String(c.ciclo).split('-').map(Number);
    const lastDayConv = new Date(cy, cm, 0).getDate();
    const fechaPrimerCorte = cy + '-' + String(cm).padStart(2, '0') + '-' + String(Math.min(diaCorte, lastDayConv)).padStart(2, '0');
    const tasaMv = cobrar_intereses ? ((tj && tj.tasa_mv_diferidas) || 0) : 0;

    let difId = null, trasladado = 0;
    const convertir = db.transaction(() => {
      const rDif = db.prepare(`INSERT INTO diferidas (tarjeta_id, etiqueta, monto, tasa_mv, num_cuotas, fecha_compra, fecha_primer_corte, estado, notas)
                               VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(c.tarjeta_id, c.descripcion, c.valor_cop, tasaMv, n, c.fecha, fechaPrimerCorte, 'activo', 'Convertida desde compra a 1 cuota');
      difId = rDif.lastInsertRowid;
      // Traslado del bolsillo apartado (personal; un tercero con bolsillo no llega aquí por el guard):
      // se reparte secuencialmente desde la cuota 1, cap-eado al total de cada cuota. El cache
      // compras.monto_bolsillo queda igual (= SUM per-cuota): el usuario no pierde lo apartado.
      const mb = Math.round(c.monto_bolsillo || 0);
      db.prepare('DELETE FROM bolsillo_cuotas WHERE compra_id=?').run(c.id); // defensa: sin restos previos
      if (mb > 0) {
        const amort = calcularAmortizacionDiferida(c.valor_cop, tasaMv, n, c.fecha, fechaPrimerCorte, null, nuOpts(db, c.tarjeta_id));
        let restante = mb;
        for (const q of amort.tabla) {
          if (restante <= 0) break;
          const cap = Math.round(q.totalPagar);
          const monto = Math.min(restante, cap);
          if (monto <= 0) continue;
          db.prepare("INSERT INTO bolsillo_cuotas (compra_id, cuota_num, monto, moneda) VALUES (?,?,?,'COP') ON CONFLICT(compra_id, cuota_num) DO UPDATE SET monto=excluded.monto")
            .run(c.id, q.numCuota, monto);
          restante -= monto; trasladado += monto;
        }
        // Residuo de redondeo (raro): a la última cuota — no se pierde un peso de lo apartado.
        if (restante > 0 && amort.tabla.length) {
          const ult = amort.tabla[amort.tabla.length - 1].numCuota;
          db.prepare('UPDATE bolsillo_cuotas SET monto = monto + ? WHERE compra_id=? AND cuota_num=?').run(restante, c.id, ult);
          trasladado += restante;
        }
        const sum = db.prepare("SELECT COALESCE(SUM(monto),0) t FROM bolsillo_cuotas WHERE compra_id=? AND COALESCE(moneda,'COP')='COP'").get(c.id);
        db.prepare('UPDATE compras SET monto_bolsillo=? WHERE id=?').run(sum.t, c.id);
      }
      const nuevasNotas = (c.notas ? c.notas + ' | ' : '') + 'Diferida a ' + n + ' cuotas';
      db.prepare("UPDATE compras SET estado='diferida', diferida_id=?, notas=? WHERE id=?").run(difId, nuevasNotas, c.id);
    });
    convertir();
    logAction('editar', tjNombre(c.tarjeta_id) + 'Compra convertida a diferida: ' + c.descripcion + ' (1 -> ' + n + ' cuotas)');
    res.json({ ok: true, diferida_id: difId, num_cuotas: n, bolsillo_trasladado: trasladado });
  });

  // ── Revertir diferida → compra de 1 cuota (camino inverso de la conversión) ──
  // POST /:id/revertir-diferida  (sin body)
  // Destruye el plan de cuotas (fila en `diferidas`) y consolida el bolsillo per-cuota de vuelta en
  // compras.monto_bolsillo (no se pierde un peso; cap al costo real de la compra). La fila de
  // `compras` conserva id/fecha/created_at (prelación de pagos). Mismos candados universales que
  // convertir/reprogramar: grupo, USD, terceros con reembolso y ciclos pagados.
  router.post('/:id/revertir-diferida', (req, res) => {
    const c = db.prepare('SELECT * FROM compras WHERE id=?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Compra no encontrada' });
    if (!(c.estado === 'diferida' || c.diferida_id)) return res.status(400).json({ error: 'La compra no es diferida; no hay plan de cuotas que revertir.' });
    if (!c.diferida_id) return res.status(400).json({ error: 'La compra no tiene un plan de cuotas vinculado.' });
    if (c.grupo_id) return res.status(403).json({ error: 'Esta compra es parte de una compra dividida; gestiónala editando el grupo completo.' });
    // Solo se rechaza la compra USD PURA (sin valor en pesos): su bolsillo es en USD y la consolidación
    // de revertir opera en COP. Una internacional de Visa (valor_cop>0 + USD informativo) sí se revierte.
    if (c.valor_usd && c.valor_usd > 0 && (!c.valor_cop || c.valor_cop <= 0)) return res.status(400).json({ error: 'Revertir compras solo en dólares (sin valor en pesos) no está soportado.' });
    if (compraTerceroConReembolso(db, c.id)) {
      return res.status(403).json({ error: 'No se puede revertir: esta compra es de un tercero y ya tiene reembolsos registrados. Gestiona o retira esos abonos desde la pestaña Terceros antes de revertir.' });
    }
    const d = db.prepare('SELECT * FROM diferidas WHERE id=?').get(c.diferida_id);
    if (!d) return res.status(404).json({ error: 'No se encontró el plan de cuotas vinculado.' });
    const abonosDif = db.prepare('SELECT COUNT(*) n FROM abonos_diferida WHERE diferida_id=?').get(d.id);
    if (abonosDif && abonosDif.n > 0) return res.status(400).json({ error: 'El plan de cuotas tiene abonos registrados; no se puede revertir.' });
    // Inmutabilidad estructural: solo se revierte en el ciclo VIGENTE — un ciclo anterior ya cerró
    // (extracto generado) aunque no esté pagado.
    const tjRev = db.prepare('SELECT dia_corte FROM tarjetas WHERE id=?').get(c.tarjeta_id);
    const cicloVigRev = cicloConCorte(hoyLocal(), (tjRev && tjRev.dia_corte) || 30, getCortesCustomMap(db, c.tarjeta_id));
    if (c.ciclo < cicloVigRev) {
      return res.status(403).json({ error: 'No se puede revertir: la compra pertenece al ciclo ' + c.ciclo + ', que ya cerró (el vigente es ' + cicloVigRev + '). El banco ya facturó ese extracto.' });
    }
    // Inmutabilidad: ninguna cuota puede haber caído ya en un ciclo con extracto pagado (revertir
    // reescribiría un cierre real) — mismo criterio que la reprogramación. Incluye el ciclo de la compra.
    const amortRev = calcularAmortizacionDiferida(d.monto, d.tasa_mv, d.num_cuotas, d.fecha_compra, d.fecha_primer_corte, null, nuOpts(db, d.tarjeta_id));
    const ciclosRev = [...new Set(amortRev.tabla.map(q => q.fechaCorte.slice(0, 7)).concat([c.ciclo]))];
    const cicloPagadoRev = ciclosRev.find(ci => { const e2 = db.prepare("SELECT estado FROM extractos WHERE tarjeta_id=? AND ciclo=?").get(c.tarjeta_id, ci); return e2 && e2.estado === 'pagado'; });
    if (cicloPagadoRev) return res.status(403).json({ error: 'No se puede revertir: la diferida ya tiene cuotas facturadas en el ciclo pagado ' + cicloPagadoRev + '.' });

    // Consolidar el bolsillo per-cuota → bolsillo global de 1 cuota, cap-eado al costo real
    // (valor [+ interés intl]), igual que el resto de la app.
    const sumBc = db.prepare("SELECT COALESCE(SUM(monto),0) t FROM bolsillo_cuotas WHERE compra_id=? AND COALESCE(moneda,'COP')='COP'").get(c.id);
    const tope = targetBolsillo({ ...c, estado: 'pendiente' }, 'COP', null);
    let mb = Math.round(sumBc.t || 0);
    const capped = (tope != null && mb > tope);
    if (capped) mb = tope;
    const nuevoEstado = (tope != null && tope > 0 && mb >= tope) ? 'bolsillo' : (mb > 0 ? 'bolsillo_parcial' : 'pendiente');
    // Notas: retirar el sufijo informativo de cuotas ("... | Diferida a N cuotas").
    const notasLimpias = String(c.notas || '').replace(/\s*\|\s*Diferida a \d+ cuotas/g, '').replace(/^\s*Diferida a \d+ cuotas\s*(\|\s*)?/, '').trim() || null;

    const revertir = db.transaction(() => {
      db.prepare('DELETE FROM bolsillo_cuotas WHERE compra_id=?').run(c.id);
      // Orden importa: primero DESVINCULAR la compra (diferida_id=NULL) y luego borrar el plan —
      // compras.diferida_id es FOREIGN KEY a diferidas(id) y la BD corre con foreign_keys=ON.
      db.prepare('UPDATE compras SET estado=?, diferida_id=NULL, monto_bolsillo=?, notas=? WHERE id=?').run(nuevoEstado, mb, notasLimpias, c.id);
      db.prepare('DELETE FROM diferidas WHERE id=?').run(d.id);
    });
    revertir();
    logAction('editar', tjNombre(c.tarjeta_id) + 'Diferida revertida a 1 cuota: ' + c.descripcion + ' (' + d.num_cuotas + ' -> 1)');
    res.json({ ok: true, estado: nuevoEstado, bolsillo_consolidado: mb, capped, tope });
  });

  // POST /api/compras/aplicar-tasa-intl — acción 1-clic del Asistente de Conciliación IA.
  // Body: { tarjeta_id, ciclo, tasa_intl, compra_ids }
  // Fija el snapshot de tasa internacional (compras.tasa_intl) de un conjunto de compras del
  // ciclo con la tasa REAL leída del extracto, para que el interés intl deje de calcularse con la
  // tasa global. Quirúrgico: SOLO toca tasa_intl (no bolsillo, estado ni nada más). Respeta la
  // inmutabilidad (403 si el extracto del ciclo ya está pagado). La IA solo PROPONE; este UPDATE
  // lo dispara el usuario tras confirmar en el modal — nunca el flujo de análisis.
  router.post('/aplicar-tasa-intl', (req, res) => {
    const { tarjeta_id, ciclo } = req.body || {};
    // Multi-grupo (split del día 1°): { grupos: [{ tasa_intl, compra_ids }] } aplica una tasa distinta
    // por mes. Compatibilidad: el formato viejo { tasa_intl, compra_ids } se trata como un solo grupo.
    let grupos = Array.isArray(req.body && req.body.grupos) ? req.body.grupos : null;
    if (!grupos && req.body && req.body.tasa_intl != null && req.body.tasa_intl !== '' && Array.isArray(req.body.compra_ids)) {
      grupos = [{ tasa_intl: req.body.tasa_intl, compra_ids: req.body.compra_ids }];
    }
    if (!tarjeta_id || !ciclo || !Array.isArray(grupos) || grupos.length === 0) {
      return res.status(400).json({ error: 'Faltan datos: se requieren tarjeta_id, ciclo y al menos un grupo (tasa_intl + compra_ids).' });
    }
    // Normalizar y validar cada grupo: tasa decimal mensual (> 0 y < 1, atrapa el error de mandar 2.0849
    // como porcentaje) + ids enteros válidos.
    const limpios = [];
    for (const g of grupos) {
      const tasa = Number(g && g.tasa_intl);
      if (!(tasa > 0) || tasa >= 1) {
        return res.status(400).json({ error: 'Cada tasa debe ser un decimal mensual válido (ej. 0.020849), no un porcentaje.' });
      }
      const ids = (Array.isArray(g.compra_ids) ? g.compra_ids : []).map(Number).filter(n => Number.isInteger(n) && n > 0);
      if (ids.length) limpios.push({ tasa, ids });
    }
    if (!limpios.length) return res.status(400).json({ error: 'Ningún grupo trae compra_ids válidos.' });
    // Inmutabilidad: un ciclo cerrado/pagado no admite cambios (espejo del resto de endpoints).
    const ext = db.prepare("SELECT estado FROM extractos WHERE tarjeta_id=? AND ciclo=?").get(tarjeta_id, ciclo);
    if (ext && ext.estado === 'pagado') {
      return res.status(403).json({ error: 'No se puede aplicar: el extracto del ciclo ' + ciclo + ' ya está pagado.' });
    }
    // Transacción: cada grupo fija SU tasa en sus compras, acotado a esta tarjeta+ciclo (el WHERE evita
    // tocar nada fuera del alcance conciliado).
    let total = 0;
    const aplicar = db.transaction(() => {
      for (const g of limpios) {
        const placeholders = g.ids.map(() => '?').join(',');
        const info = db.prepare(`UPDATE compras SET tasa_intl=? WHERE tarjeta_id=? AND ciclo=? AND id IN (${placeholders})`)
          .run(g.tasa, tarjeta_id, ciclo, ...g.ids);
        total += info.changes;
      }
    });
    aplicar();
    logAction('editar', tjNombre(tarjeta_id) + 'Tasa internacional del ciclo ' + ciclo + ' sincronizada (' + limpios.length + ' tasa(s)) para ' + total + ' compra(s)');
    res.json({ ok: true, actualizadas: total, grupos: limpios.length });
  });

  // ── Aplicar corte ADELANTADO de un ciclo (cortes_custom) ──────────────────────
  // POST /aplicar-corte-ciclo  Body: { tarjeta_id, ciclo, fecha_corte }
  // Persiste la fecha de corte REAL de un ciclo (el banco adelantó el corte) y re-evalúa las compras
  // de la tarjeta para que las hechas DESPUÉS de ese corte salten al ciclo siguiente de inmediato; las
  // futuras se auto-asignarán al crearse (calcCiclo ya consulta cortes_custom). Lo dispara la
  // conciliación IA (discrepancia fecha_corte_movida); NO toca el dia_corte global de la tarjeta.
  router.post('/aplicar-corte-ciclo', (req, res) => {
    const { tarjeta_id, ciclo, fecha_corte } = req.body || {};
    if (!tarjeta_id || !ciclo || !fecha_corte) {
      return res.status(400).json({ error: 'Faltan datos: tarjeta_id, ciclo y fecha_corte son requeridos.' });
    }
    const fc = String(fecha_corte).slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fc)) return res.status(400).json({ error: 'fecha_corte debe tener formato YYYY-MM-DD.' });
    // Sanity: el corte real debe caer dentro del mes del ciclo afectado.
    if (fc.slice(0, 7) !== ciclo) return res.status(400).json({ error: 'La fecha de corte (' + fc + ') no pertenece al ciclo ' + ciclo + '.' });
    // Inmutabilidad: un ciclo ya pagado no se reabre.
    const extC = db.prepare("SELECT estado FROM extractos WHERE tarjeta_id=? AND ciclo=?").get(tarjeta_id, ciclo);
    if (extC && extC.estado === 'pagado') {
      return res.status(403).json({ error: 'No se puede fijar el corte: el extracto del ciclo ' + ciclo + ' ya está pagado.' });
    }
    let movidas = 0;
    const aplicar = db.transaction(() => {
      // 1. Persistir el corte real (upsert: un registro por tarjeta+ciclo).
      db.prepare('INSERT INTO cortes_custom (tarjeta_id, ciclo, fecha_corte) VALUES (?,?,?) ON CONFLICT(tarjeta_id, ciclo) DO UPDATE SET fecha_corte=excluded.fecha_corte')
        .run(tarjeta_id, ciclo, fc);
      // 2. Re-evaluar las compras de la tarjeta (mismo núcleo que syncData paso 5): las de la ventana
      //    saltan al ciclo siguiente; el resto queda igual. ciclo_manual prevalece (no se toca) y no se
      //    mueve nada HACIA un ciclo ya pagado (protege cierres reales).
      const tj = db.prepare('SELECT dia_corte FROM tarjetas WHERE id=?').get(tarjeta_id);
      const diaCorte = (tj && tj.dia_corte) || 30;
      const cortesMap = getCortesCustomMap(db, tarjeta_id);
      const compras = db.prepare("SELECT id, fecha, ciclo, COALESCE(ciclo_manual,0) as ciclo_manual FROM compras WHERE tarjeta_id=?").all(tarjeta_id);
      for (const c of compras) {
        if (!c.fecha || c.ciclo_manual) continue;
        const nuevo = cicloConCorte(c.fecha, diaCorte, cortesMap);
        if (nuevo !== c.ciclo) {
          const extDest = db.prepare("SELECT estado FROM extractos WHERE tarjeta_id=? AND ciclo=?").get(tarjeta_id, nuevo);
          if (extDest && extDest.estado === 'pagado') continue;
          db.prepare('UPDATE compras SET ciclo=? WHERE id=?').run(nuevo, c.id);
          movidas++;
        }
      }
    });
    aplicar();
    logAction('editar', tjNombre(tarjeta_id) + 'Corte adelantado fijado para ' + ciclo + ': ' + fc + ' (' + movidas + ' compra(s) reubicada(s))');
    res.json({ ok: true, fecha_corte: fc, movidas });
  });

  return router;
};
