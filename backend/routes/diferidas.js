// backend/routes/diferidas.js — CRUD /api/diferidas
const { Router } = require('express');
const { hoyLocal, calcCicloLocal } = require('../helpers/dates');
const { cicloConCorte, getCortesCustomMap, corteDeCiclo } = require('../helpers/cortes');
const { calcularAmortizacionDiferida } = require('../engine/amortizacion');
const { nuOpts, nuOptsDif } = require('../helpers/banco');
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
      const amort = calcularAmortizacionDiferida(d.monto, d.tasa_mv, d.num_cuotas, d.fecha_compra, d.fecha_primer_corte, null, nuOptsDif(db, d));
      const cuotaCiclo = ciclo
        ? amort.tabla.find(r => r.fechaCorte.slice(0, 7) === ciclo)
        : amort.tabla.find(r => r.fechaCorte >= hoyDif);
      const compraPersona = db.prepare(`SELECT c.persona_id, p.nombre, p.color FROM compras c
        LEFT JOIN personas p ON c.persona_id = p.id
        WHERE c.diferida_id = ? AND c.persona_id IS NOT NULL LIMIT 1`).get(d.id);
      // Compra vinculada a esta diferida (para gestionar bolsillo + mostrar su nota personal en la
      // tabla). Toma la primera/principal.
      const compraVinc = db.prepare(`SELECT id, monto_bolsillo, valor_cop, grupo_id, nota_personal FROM compras WHERE diferida_id = ? ORDER BY id LIMIT 1`).get(d.id);
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
        persona_id: compraPersona ? compraPersona.persona_id : null,
        persona_nombre: compraPersona ? compraPersona.nombre : null,
        persona_color: compraPersona ? compraPersona.color : null,
        compra_id: compraVinc ? compraVinc.id : null,
        grupo_id: compraVinc ? compraVinc.grupo_id : null,
        // Nota personal de la compra vinculada (se muestra junto al nombre en la tabla, igual que en Compras).
        nota_personal: compraVinc ? (compraVinc.nota_personal || null) : null,
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
    const amort = calcularAmortizacionDiferida(d.monto, d.tasa_mv, d.num_cuotas, d.fecha_compra, d.fecha_primer_corte, null, nuOptsDif(db, d));
    // Info de la compra vinculada para la UI de "Reprogramar Cuotas" (necesita el compra_id para el
    // POST /compras/:id/reprogramar-saldo y saber si es elegible: no grupo, no tercero, no USD pura).
    const compraVinc = db.prepare('SELECT id, grupo_id, persona_id, valor_cop, valor_usd, monto_abonado FROM compras WHERE diferida_id=? ORDER BY id LIMIT 1').get(d.id);
    res.json({
      ...d, amortizacion: amort.tabla, resumen: amort.resumen,
      compra_id: compraVinc ? compraVinc.id : null,
      grupo_id: compraVinc ? compraVinc.grupo_id : null,
      es_de_tercero: !!(compraVinc && compraVinc.persona_id),
      // tercero_con_reembolso: SOLO bloquea reprogramar cuando el tercero YA reembolsó algo (bolsillo,
      // abono directo, marcado pagado, o bolsillo per-cuota). Un tercero SIN reembolso SÍ es elegible:
      // el "Sellar y Renacer" hereda su persona_id en las selladas y la renacida (deuda preservada).
      tercero_con_reembolso: !!(compraVinc && compraTerceroConReembolso(db, compraVinc.id)),
      es_usd_pura: !!(compraVinc && compraVinc.valor_usd > 0 && !(compraVinc.valor_cop > 0)),
      tiene_abono_parcial: !!(compraVinc && (compraVinc.monto_abonado || 0) > 0)
    });
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

  // POST /crear-omitida — crea una diferida OMITIDA como STANDALONE (sin compra vinculada, estilo
  // RappiCard) a partir de una CUOTA "N de M" que el Asistente IA detectó en el extracto y la app NO
  // tenía. Deriva de forma DETERMINISTA el valor TOTAL y el ciclo/fechas de ORIGEN de la compra a partir
  // de { capital (el de la línea = 1 cuota), num_cuotas M, cuota_actual N, ciclo conciliado }. Al ser
  // standalone NO siembra ninguna compra en ciclos pasados/pagados: solo PROYECTA (el dashboard la cuenta
  // vía saldoActual + deudaImpaga, que excluyen las cuotas ya facturadas) → seguro aunque su origen sea un
  // ciclo pagado; no toca ningún extracto. Por eso NO lleva candado de ciclo. desde_conciliacion se acepta
  // por consistencia con las demás acciones IA (aquí no hay candado que eximir).
  router.post('/crear-omitida', (req, res) => {
    const { tarjeta_id, descripcion, capital, num_cuotas, cuota_actual, ciclo, cobrar_intereses } = req.body || {};
    const M = parseInt(num_cuotas, 10);
    const N = parseInt(cuota_actual, 10);
    const cap = Number(capital);
    if (!tarjeta_id) return res.status(400).json({ error: 'Falta tarjeta_id.' });
    if (!descripcion || !String(descripcion).trim()) return res.status(400).json({ error: 'Falta la descripción.' });
    if (!M || M < 2 || M > 120) return res.status(400).json({ error: 'El número de cuotas debe ser un entero entre 2 y 120.' });
    if (!N || N < 1 || N > M) return res.status(400).json({ error: 'La cuota actual debe estar entre 1 y ' + M + '.' });
    if (!(cap > 0)) return res.status(400).json({ error: 'El capital de la cuota debe ser mayor que 0.' });
    if (!ciclo || !/^\d{4}-\d{2}$/.test(String(ciclo))) return res.status(400).json({ error: 'Falta el ciclo conciliado (YYYY-MM).' });
    const tj = db.prepare('SELECT dia_corte, tasa_mv_diferidas FROM tarjetas WHERE id=?').get(tarjeta_id);
    if (!tj) return res.status(404).json({ error: 'Tarjeta no encontrada.' });
    const diaCorte = tj.dia_corte || 30;
    // Aritmética de ciclos (YYYY-MM) sin Date. Ciclo de ORIGEN = ciclo conciliado − (N−1) meses:
    // la cuota N se factura N−1 meses después de la cuota 1.
    const restarMeses = (cic, n) => { const p = String(cic).split('-'); let y = Number(p[0]), m = Number(p[1]) - n; while (m < 1) { m += 12; y -= 1; } return y + '-' + String(m).padStart(2, '0'); };
    const cicloOrigen = restarMeses(ciclo, N - 1);
    const fechaPrimerCorte = corteDeCiclo(cicloOrigen, diaCorte);
    // fecha_compra ~30 días antes del primer corte (corte del ciclo anterior al de origen) → la cuota 1
    // cobra ~1 mes de interés, no un período inflado (mismo criterio que la hija de reprogramar-saldo).
    const fechaCompra = corteDeCiclo(restarMeses(cicloOrigen, 1), diaCorte);
    const total = Math.round(cap * M);
    const tasaMv = cobrar_intereses ? ((tj.tasa_mv_diferidas) || 0) : 0;
    const notas = 'Diferida omitida (conciliación): detectada en la cuota ' + N + '/' + M + ' del ciclo ' + ciclo + '; origen ' + cicloOrigen + '.';
    const r = db.prepare(`INSERT INTO diferidas (tarjeta_id, etiqueta, monto, tasa_mv, num_cuotas, fecha_compra, fecha_primer_corte, estado, notas)
                          VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(tarjeta_id, String(descripcion).trim(), total, tasaMv, M, fechaCompra, fechaPrimerCorte, 'activo', notas);
    const fmt = new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(total);
    logAction('crear', tjNombre(tarjeta_id) + 'Diferida omitida creada (conciliación): ' + descripcion + ' por ' + fmt + ' a ' + M + ' cuotas (origen ' + cicloOrigen + ')');
    res.json({ ok: true, id: r.lastInsertRowid, total, num_cuotas: M, ciclo_origen: cicloOrigen, fecha_compra: fechaCompra, fecha_primer_corte: fechaPrimerCorte, tasa_mv: tasaMv });
  });

  // Helper: chequear inmutabilidad de una diferida.
  // Bloquea si el extracto del ciclo de origen (fecha_compra) está pagado.
  function validateDiferidaMutable(difRow) {
    if (!difRow) return null;
    const tj = db.prepare('SELECT dia_corte FROM tarjetas WHERE id=?').get(difRow.tarjeta_id);
    const diaCorte = tj ? tj.dia_corte : 30;
    // Ciclo de ORIGEN = el del PRIMER CORTE (donde se factura la cuota 1). Se deriva de fecha_primer_corte
    // (siempre cae dentro del ciclo de origen), NO de fecha_compra: en las diferidas OMITIDAS la fecha_compra
    // se fija ~30 dias antes (corte del mes anterior), y calcCicloLocal la ubicaria un mes antes del origen
    // real → el candado inspeccionaria el extracto equivocado. Fallback a fecha_compra si no hay primer corte.
    const cicloOrigen = difRow.fecha_primer_corte ? String(difRow.fecha_primer_corte).slice(0, 7) : calcCicloLocal(difRow.fecha_compra, diaCorte);
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

    // Inmutabilidad estructural (edición MANUAL): la reprogramación solo aplica si la compra pertenece
    // al ciclo VIGENTE — un ciclo anterior ya cerró (extracto generado) aunque no esté pagado. La
    // CONCILIACIÓN IA queda exenta (desde_conciliacion=true): corrige planes que el BANCO ya reprogramó
    // en extractos pasados; su candado de ciclos PAGADOS (abajo) sigue aplicando igual.
    if (!(req.body && req.body.desde_conciliacion)) {
      const tjRep = db.prepare('SELECT dia_corte FROM tarjetas WHERE id=?').get(d.tarjeta_id);
      const diaCorteRep = (tjRep && tjRep.dia_corte) || 30;
      const compraVincRep = db.prepare('SELECT ciclo FROM compras WHERE diferida_id=? LIMIT 1').get(req.params.id);
      const cicloOrigenRep = (compraVincRep && compraVincRep.ciclo) || calcCicloLocal(d.fecha_compra, diaCorteRep);
      const cicloVigRep = cicloConCorte(hoyLocal(), diaCorteRep, getCortesCustomMap(db, d.tarjeta_id));
      if (cicloOrigenRep < cicloVigRep) {
        return res.status(403).json({ error: 'No se puede reprogramar: la compra pertenece al ciclo ' + cicloOrigenRep + ', que ya cerró (el vigente es ' + cicloVigRep + '). El banco ya facturó ese extracto.' });
      }
    }

    const amortPrev = calcularAmortizacionDiferida(d.monto, d.tasa_mv, d.num_cuotas, d.fecha_compra, d.fecha_primer_corte, null, nuOptsDif(db, d));
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
    const comprasVinc = db.prepare('SELECT id, notas FROM compras WHERE diferida_id=?').all(req.params.id);
    comprasVinc.forEach(c => {
      db.prepare('DELETE FROM bolsillo_cuotas WHERE compra_id=? AND cuota_num > ?').run(c.id, nuevoN);
      const sumCop = db.prepare("SELECT COALESCE(SUM(monto),0) as t FROM bolsillo_cuotas WHERE compra_id=? AND COALESCE(moneda,'COP')='COP'").get(c.id);
      const sumUsd = db.prepare("SELECT COALESCE(SUM(monto),0) as t FROM bolsillo_cuotas WHERE compra_id=? AND moneda='USD'").get(c.id);
      db.prepare('UPDATE compras SET monto_bolsillo=?, monto_bolsillo_usd=? WHERE id=?').run(sumCop.t, sumUsd.t, c.id);
      // Sincronizar el sufijo informativo de notas ("Diferida a X cuotas") con el nuevo total —
      // necesario ahora que la reprogramación también se dispara desde la edición manual (N→M).
      if (c.notas && /Diferida a \d+ cuotas/.test(c.notas)) {
        db.prepare('UPDATE compras SET notas=? WHERE id=?').run(c.notas.replace(/Diferida a \d+ cuotas/g, 'Diferida a ' + nuevoN + ' cuotas'), c.id);
      }
    });

    const nuevaAmort = calcularAmortizacionDiferida(d.monto, d.tasa_mv, nuevoN, d.fecha_compra, nuevaFPC, null, nuOptsDif(db, d));
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
    const d = db.prepare('SELECT etiqueta, tarjeta_id, fecha_compra, fecha_primer_corte FROM diferidas WHERE id=?').get(req.params.id);
    const err = validateDiferidaMutable(d);
    if (err) return res.status(403).json({ error: err });
    db.prepare('DELETE FROM diferidas WHERE id=?').run(req.params.id);
    logAction('eliminar', tjNombre(d ? d.tarjeta_id : null) + 'Diferida eliminada: ' + (d ? d.etiqueta : 'ID ' + req.params.id));
    res.json({ ok: true });
  });

  return router;
};
