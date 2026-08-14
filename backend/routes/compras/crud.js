'use strict';
// backend/routes/compras/crud.js
//
// Rutas movidas VERBATIM desde compras.js. Se registran sobre el MISMO router que crea el
// archivo padre, no sobre un sub-router montado: asi el stack de Express conserva su
// forma y su ORDEN exactos, y el contrato que se ve desde fuera no cambia ni un apice.
const { primerCorteAvance } = require('../../helpers/dates');
const { aplicaIntInternacional } = require('../../helpers/banco');
const { corteDeCiclo } = require('../../helpers/cortes');
const { tasaIntlEnFecha } = require('../../helpers/tasas');

module.exports = function(router, ctx) {
  const { db, logAction, tjNombre, calcCiclo, avisoCifraOficial, esCicloPagado, esCicloCerrado, targetBolsillo } = ctx;

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
    // v5.8.0: DEROGADO el candado por TIEMPO (ciclo anterior al vigente). Mientras el extracto no esté
    // pagado la deuda sigue viva y registrar lo que faltó es legítimo — el guard de PAGADO de arriba es
    // el único cierre. Ver esCicloPagado.
    // "Snapshot al nacer": si no se especifica tasa_intl y la tarjeta cobra interés sobre compras
    // internacionales (Bancolombia Visa), congela la tasa ACTUAL de la tarjeta en la compra → nace
    // inmune a cambios futuros de la tasa global. El fallback (?? tasa_global) queda SOLO para las
    // compras históricas que ya quedaron en NULL antes de esta función.
    // v5.8.0 — la tasa se resuelve por la FECHA DE LA COMPRA, no por el día en que se digita. Al poder
    // registrar en un ciclo pasado impago, "la tasa actual de la tarjeta" es el dato equivocado: la
    // usura cambia el 1° de cada mes. Cascada (helpers/tasas.js): tasa explícita del usuario → tasa ya
    // congelada en otras compras del MISMO ciclo (la puso el extracto si se concilió) → tasa publicada
    // en esa fecha (serie del scraper en `historial`) → tasa vigente de la tarjeta (comportamiento
    // previo, para que esto nunca resuelva peor que antes).
    let tasaIntlFinal = (tasa_intl != null && tasa_intl !== '') ? Number(tasa_intl) : null;
    let tasaIntlFuente = tasaIntlFinal != null ? 'valor indicado' : null;
    if (tasaIntlFinal == null) {
      const tjRate = db.prepare('SELECT banco, franquicia, tasa_mv_avances FROM tarjetas WHERE id=?').get(tarjeta_id);
      if (tjRate && aplicaIntInternacional(tjRate.banco, tjRate.franquicia)) {
        const hist = tasaIntlEnFecha(db, tarjeta_id, ciclo, fecha, null);
        if (hist.tasa != null) {
          tasaIntlFinal = hist.tasa;
          tasaIntlFuente = hist.fuente;
        } else if (tjRate.tasa_mv_avances != null) {
          tasaIntlFinal = tjRate.tasa_mv_avances;
          tasaIntlFuente = 'tasa actual de la tarjeta';
        }
      }
    }
    // updated_at = ahora al crear: una compra nueva es lo más reciente de su día en la tabla (display).
    const r = db.prepare(`INSERT INTO compras (tarjeta_id, fecha, descripcion, valor_cop, valor_usd, tasa_usd, persona_id, estado, ciclo, notas, nota_personal, diferida_id, grupo_id, es_internacional, ciclo_manual, tasa_intl, updated_at)
                          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'))`)
      .run(tarjeta_id || null, fecha, descripcion, valor_cop, valor_usd || null, tasa_usd || null, persona_id || null, estado || 'pendiente', ciclo, notas || null, nota_personal || null, diferida_id || null, grupo_id || null, es_internacional ? 1 : 0, cicloManual, tasaIntlFinal);
    const fmt = new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',maximumFractionDigits:0}).format(valor_cop);
    logAction('crear', tjNombre(tarjeta_id) + 'Compra registrada: ' + descripcion + ' por ' + fmt);
    res.json({ id: r.lastInsertRowid, tasa_intl_aplicada: tasaIntlFinal, tasa_intl_fuente: tasaIntlFuente,
               aviso_cifra_oficial: avisoCifraOficial(tarjeta_id, ciclo) });
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
    // SOFT LOCK de ciclos CERRADOS (≠ pagados) — downgrade de v4.7.5: editar una compra que YA está en
    // un ciclo cerrado se permite AHORA COMPLETO (corregir errores de tipeo del pasado, ej. un valor mal
    // digitado). Se derogó el "modo cosmético" (antes solo dejaba renombrar). El candado de ciclos
    // PAGADOS (arriba) sigue firme e independiente. La ÚNICA restricción estructural que se conserva es
    // la FUGA INVERSA: mover una compra de un ciclo ABIERTO hacia uno CERRADO (inyectaría un movimiento
    // NUEVO en un extracto ya facturado, igual que crearla allá). La conciliación IA sigue exenta
    // (desde_conciliacion). El frontend pide confirmación explícita antes de guardar en ciclo cerrado.
    // OJO tasa_intl: el UPDATE de abajo conserva el snapshot histórico (finalTasaIntl ← body || current),
    // nunca lo recalcula con la tasa global vigente.
    // GUARD DE DESTINO PAGADO (v5.8.0, sin exención — ni la IA lo salta). Hasta v5.7.x este endpoint
    // solo validaba "pagado" contra el ciclo ORIGEN (`current.ciclo`); mover una compra a un ciclo
    // PAGADO lo impedía de rebote el candado por TIEMPO, que aquí se deroga. Sin este guard quedaba
    // abierta una fuga que EVAPORA DEUDA EN SILENCIO: al cambiarle la fecha a una compra para mandarla
    // a un ciclo ya pagado, `syncData` paso 6 (config/db.js) la marca `estado='pagado'` con
    // `monto_abonado=valor_cop` en el siguiente arranque, sin que ninguna vista lo muestre.
    if (current && (tarjeta_id != current.tarjeta_id || ciclo !== current.ciclo) && esCicloPagado(tarjeta_id, ciclo)) {
      return res.status(403).json({ error: 'No se puede mover la compra al ciclo ' + ciclo + ': el extracto de ese ciclo ya está pagado.' });
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
      // interes_sellado se propaga desde la fila actual (el PUT no lo edita): sin él, el objeto armado a
      // mano deja el tope en el capital pelado y el re-cap DESTRUIRÍA la parte del reembolso de un
      // tercero que corresponde al interés de una cuota sellada.
      const topeEdit = targetBolsillo({ valor_cop, valor_usd, es_internacional: finalIntl, ciclo, fecha, tarjeta_id, tasa_intl: finalTasaIntl, persona_id: current.persona_id, interes_sellado: current.interes_sellado }, 'COP', null);
      if (topeEdit != null) {
        if (finalBolsillo > topeEdit) finalBolsillo = topeEdit;
        finalEstado = (topeEdit > 0 && finalBolsillo >= topeEdit) ? 'bolsillo' : (finalBolsillo > 0 ? 'bolsillo_parcial' : 'pendiente');
      }
    }
    // updated_at=ahora: BUMP de display — la compra editada por el usuario en el FORMULARIO salta al
    // primer lugar de su día en la tabla de Compras. Se GATEA por desde_conciliacion: las acciones de la
    // IA de conciliación (mover_ciclo / editar_valor) reusan ESTE mismo PUT con ese flag y NO deben
    // reordenar la tabla (son correcciones de extractos pasados, no una edición manual). La edición manual
    // del formulario (saveCompra / edición de grupo dividido) nunca envía el flag → sí bumpea. El POST de
    // crear SÍ bumpea siempre (aunque crear_compra de la IA lo envíe: una compra nueva es lo más reciente).
    const bumpUpdated = !(req.body && req.body.desde_conciliacion);
    // Si la compra CAMBIA DE DÍA, su orden manual deja de tener sentido: el número pertenecía al
    // orden de otro día y ahí chocaría con las filas que ya lo tienen. Se limpia y la compra aterriza
    // en la posición natural de su nuevo día, desde donde el usuario puede reordenarla si quiere.
    const cambioDeDia = String(fecha) !== String(current && current.fecha);
    const resetOrden = cambioDeDia ? ', orden_dia=NULL' : '';
    db.prepare(`UPDATE compras SET tarjeta_id=?, fecha=?, descripcion=?, valor_cop=?, valor_usd=?, tasa_usd=?, persona_id=?, estado=?, ciclo=?, notas=?, nota_personal=?, tasa_intl=?, monto_bolsillo=?, es_internacional=?, ciclo_manual=?${resetOrden}${bumpUpdated ? ", updated_at=datetime('now','localtime')" : ''} WHERE id=?`)
      .run(tarjeta_id, fecha, descripcion, valor_cop, valor_usd, tasa_usd, persona_id, finalEstado, ciclo, notas, finalNota, finalTasaIntl, finalBolsillo, finalIntl, cicloManual, req.params.id);

    // SINCRONIZAR diferida vinculada: si la compra tiene diferida_id, mantener
    // alineadas fecha_compra y fecha_primer_corte (y tarjeta_id si cambió).
    // Sin esto, editar la fecha de una compra a cuotas dejaba la diferida con su
    // amortización original — las cuotas se mostraban en el mes equivocado.
    if (current && current.diferida_id && (current.fecha !== fecha || current.tarjeta_id !== tarjeta_id)) {
      const tjRow = db.prepare('SELECT dia_corte FROM tarjetas WHERE id=?').get(tarjeta_id);
      const diaCorte = tjRow ? (tjRow.dia_corte || 30) : 30;
      // Si la compra tiene ciclo MANUAL (ej. spillover / canje retrasado), su diferida debe seguir el
      // ciclo FIJADO por el usuario (corteDeCiclo(ciclo)), NO el corte natural de la fecha — así las
      // cuotas quedan alineadas con el ciclo de la compra tras editar la fecha/tarjeta. Sin ciclo manual,
      // el corte natural de la fecha (comportamiento previo, intacto).
      const fechaPrimerCorte = cicloManual ? corteDeCiclo(ciclo, diaCorte) : primerCorteAvance(fecha, diaCorte);
      db.prepare('UPDATE diferidas SET tarjeta_id=?, fecha_compra=?, fecha_primer_corte=? WHERE id=?')
        .run(tarjeta_id, fecha, fechaPrimerCorte, current.diferida_id);
      logAction('editar', tjNombre(tarjeta_id) + 'Diferida sincronizada con compra editada (fecha → ' + fecha + ', primer corte → ' + fechaPrimerCorte + ')');
    }

    logAction('editar', tjNombre(tarjeta_id) + 'Compra editada: ' + descripcion);
    // El aviso va del ciclo DESTINO; si la compra cambió de ciclo, el origen también quedó alterado.
    const avisoDestino = avisoCifraOficial(tarjeta_id, ciclo);
    const avisoOrigen = (current && (tarjeta_id != current.tarjeta_id || ciclo !== current.ciclo))
      ? avisoCifraOficial(current.tarjeta_id, current.ciclo) : null;
    res.json({ ok: true, aviso_cifra_oficial: avisoDestino || avisoOrigen });
  });

  // POST /api/compras/:id/mover  { direccion: 'arriba' | 'abajo' }  (v6.0.0)
  // Sube o baja una compra UNA posición dentro de su MISMO DÍA. El orden manual se guarda en
  // `compras.orden_dia` y manda sobre el salto automático por última edición.
  //
  // Solo dentro del día a propósito: la fecha es el criterio principal de la tabla, así que mover
  // una fila más allá del límite de su día no puede hacerse reordenando — hay que cambiarle la
  // fecha. En ese borde se responde 409 con ese mensaje en vez de mover a medias.
  //
  // Una compra DIVIDIDA cuenta como UNA sola unidad: todas las partes de un grupo comparten el
  // mismo `orden_dia` y se mueven juntas, igual que se ven juntas en la tabla.
  router.post('/:id/mover', (req, res) => {
    const c = db.prepare('SELECT * FROM compras WHERE id=?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Compra no encontrada' });
    const dir = String((req.body && req.body.direccion) || '').toLowerCase();
    if (dir !== 'arriba' && dir !== 'abajo') return res.status(400).json({ error: 'Direccion invalida (arriba | abajo).' });

    // Las filas del día, con los MISMOS filtros que aplica la tabla: la compra renacida de una
    // reprogramación y las cuotas selladas se ven en Diferidas, no aquí. Si el backend las contara,
    // "una posición" saltaría por encima de filas que el usuario no ve.
    // `sin_gracia_cuota1` vive en DIFERIDAS, no en compras (el GET la expone por join), así que la
    // compra RENACIDA de una reprogramación se detecta por ahí.
    const filas = db.prepare(
      "SELECT c.id, c.grupo_id, c.orden_dia, COALESCE(c.updated_at, c.created_at) ts FROM compras c " +
      "LEFT JOIN diferidas d ON d.id = c.diferida_id " +
      "WHERE c.tarjeta_id=? AND c.fecha=? AND COALESCE(d.sin_gracia_cuota1,0)=0 " +
      "  AND (c.notas IS NULL OR c.notas NOT LIKE '%sellada por reprogramacion%')"
    ).all(c.tarjeta_id, c.fecha);
    if (!filas.length) return res.status(404).json({ error: 'No hay compras en ese dia.' });

    // Se agrupa en UNIDADES (un grupo = una unidad) y se ordenan por el criterio VISIBLE.
    const porClave = new Map();
    filas.forEach(f => {
      const k = f.grupo_id || ('c' + f.id);
      if (!porClave.has(k)) porClave.set(k, { clave: k, ids: [], orden: null, ts: '', minId: f.id });
      const u = porClave.get(k);
      u.ids.push(f.id);
      if (f.orden_dia != null && (u.orden == null || f.orden_dia < u.orden)) u.orden = f.orden_dia;
      if (String(f.ts || '') > u.ts) u.ts = String(f.ts || '');
      if (f.id < u.minId) u.minId = f.id;
    });
    const unidades = [...porClave.values()].sort((a, b) => {
      const oa = a.orden == null ? 999999 : a.orden, ob = b.orden == null ? 999999 : b.orden;
      if (oa !== ob) return oa - ob;
      const t = String(b.ts).localeCompare(String(a.ts));
      if (t !== 0) return t;
      return b.minId - a.minId;
    });

    const clave = c.grupo_id || ('c' + c.id);
    const i = unidades.findIndex(u => u.clave === clave);
    if (i < 0) return res.status(400).json({ error: 'Esa compra no se ordena desde aqui.' });
    const j = dir === 'arriba' ? i - 1 : i + 1;
    if (j < 0 || j >= unidades.length) {
      return res.status(409).json({
        error: 'Para mover esta compra a otro dia, por favor edite la fecha manualmente.',
        borde: dir, total_dia: unidades.length
      });
    }

    // Se MATERIALIZA el orden del día (1..N) con la disposición que ya se ve, y después se
    // intercambia. Así el primer clic no reordena nada por sorpresa: solo fija lo que había.
    const set = db.prepare('UPDATE compras SET orden_dia=? WHERE id=?');
    db.transaction(() => {
      unidades.forEach((u, k) => u.ids.forEach(id => set.run(k + 1, id)));
      const a = unidades[i], b = unidades[j];
      a.ids.forEach(id => set.run(j + 1, id));
      b.ids.forEach(id => set.run(i + 1, id));
    })();
    logAction('editar', tjNombre(c.tarjeta_id) + 'Orden manual: ' + c.descripcion + ' movida ' + dir + ' en el dia ' + c.fecha);
    res.json({ ok: true, direccion: dir, posicion: j + 1, total_dia: unidades.length });
  });
};
