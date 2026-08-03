'use strict';
// backend/routes/extractos/pagar.js
//
// Rutas movidas VERBATIM desde extractos.js. Se registran sobre el MISMO router que crea el
// archivo padre, no sobre un sub-router montado: asi el stack de Express conserva su
// forma y su ORDEN exactos, y el contrato que se ve desde fuera no cambia ni un apice.
// Margen que el pago de un extracto puede desviarse del mínimo estimado y aun así darse por completo.
// Existe porque el estimado NO puede ser exacto por diseño (el banco cobra interés sobre la cuota ya
// facturada hasta el día del pago). Calibrado con 10 extractos reales: los desfases medidos van de
// −$1.628 a +$1.060. Un abono parcial de verdad es de otro orden de magnitud y queda fuera.
const TOLERANCIA_PAGO_COP = 2000;
const { calcExtracto } = require('../../engine/extracto');

module.exports = function(router, ctx) {
  const { db, logAction, tjNombre, pagarExtracto } = ctx;

  router.put('/:id/pagar', (req, res) => {
    const ext = db.prepare('SELECT * FROM extractos WHERE id=?').get(req.params.id);
    if (!ext) return res.status(404).json({ error: 'Extracto no encontrado' });
    return res.json(pagarExtracto(ext, req.body));
  });

  // ── Override manual de fecha de pago por ciclo ──────────────────────
  // PUT /api/extractos/fecha-pago-custom
  // Body: { tarjeta_id, ciclo, fecha_pago }  → si fecha_pago es null/vacía, elimina el override.
  // Es un "display override": no toca extractos.fecha_pago ni recalcula intereses ni pago mínimo.
  router.put('/fecha-pago-custom', (req, res) => {
    const { tarjeta_id, ciclo, fecha_pago } = req.body;
    if (!tarjeta_id || !ciclo) return res.status(400).json({ error: 'tarjeta_id y ciclo son requeridos' });
    const fp = fecha_pago && String(fecha_pago).trim() ? String(fecha_pago).slice(0, 10) : null;
    if (fp) {
      db.prepare('INSERT INTO fechas_pago_custom (tarjeta_id, ciclo, fecha_pago) VALUES (?,?,?) ON CONFLICT(tarjeta_id, ciclo) DO UPDATE SET fecha_pago=?')
        .run(tarjeta_id, ciclo, fp, fp);
      logAction('editar', tjNombre(tarjeta_id) + 'Fecha de pago manual fijada para ' + ciclo + ': ' + fp);
      res.json({ ok: true, fecha_pago: fp, esManual: true });
    } else {
      db.prepare('DELETE FROM fechas_pago_custom WHERE tarjeta_id=? AND ciclo=?').run(tarjeta_id, ciclo);
      logAction('editar', tjNombre(tarjeta_id) + 'Override de fecha de pago eliminado para ' + ciclo);
      res.json({ ok: true, fecha_pago: null, esManual: false });
    }
  });

  // ── Fijar las cifras OFICIALES impresas en el extracto del banco (v5.7.0) ────────────────────
  // POST /api/extractos/pago-oficial   Body: { tarjeta_id, ciclo, pago_minimo, pago_total? }
  // El modelo de la app NO puede predecir el mínimo al peso: el banco cobra además interés sobre la
  // cuota ya facturada hasta el día en que el usuario paga (dato del FUTURO al proyectar; probado
  // contra 10 extractos, ver docs/bancos/RappiCard_Visa.md §4.3). Al conciliar el PDF se guarda aquí
  // el valor real y la app deja de pedirle al usuario que lo transcriba a mano.
  // NO toca `extractos` ni el cálculo: la deuda, el cupo y las proyecciones siguen saliendo del motor.
  router.post('/pago-oficial', (req, res) => {
    const { tarjeta_id, ciclo, pago_minimo, pago_total, fuente } = req.body || {};
    if (!tarjeta_id || !ciclo) return res.status(400).json({ error: 'tarjeta_id y ciclo son requeridos' });
    if (!/^\d{4}-\d{2}$/.test(String(ciclo))) return res.status(400).json({ error: 'ciclo debe tener formato YYYY-MM' });
    // pago_minimo null/vacío ELIMINA el override (mismo patrón que fecha-pago-custom). Es la salida
    // si alguna vez se fija una cifra equivocada: sin esto quedaría clavada, el extracto no sellaría
    // nunca al pagar lo real y solo se podría corregir editando la BD a mano.
    if (pago_minimo === null || pago_minimo === '' || pago_minimo === undefined) {
      db.prepare('DELETE FROM extractos_oficiales WHERE tarjeta_id=? AND ciclo=?').run(tarjeta_id, ciclo);
      logAction('editar', tjNombre(tarjeta_id) + 'Pago minimo oficial eliminado para ' + ciclo);
      return res.json({ ok: true, ciclo, pago_minimo: null, eliminado: true });
    }
    const pm = parseFloat(pago_minimo);
    if (!(pm > 0)) return res.status(400).json({ error: 'pago_minimo debe ser un valor positivo' });
    const pt = (pago_total != null && parseFloat(pago_total) > 0) ? parseFloat(pago_total) : null;
    if (pt != null && pt < pm) return res.status(400).json({ error: 'el pago total no puede ser menor que el pago minimo' });
    const tj = db.prepare('SELECT id FROM tarjetas WHERE id=?').get(tarjeta_id);
    if (!tj) return res.status(404).json({ error: 'Tarjeta no encontrada' });
    db.prepare(`INSERT INTO extractos_oficiales (tarjeta_id, ciclo, pago_minimo, pago_total, fuente)
                VALUES (?,?,?,?,?)
                ON CONFLICT(tarjeta_id, ciclo) DO UPDATE SET
                  pago_minimo=excluded.pago_minimo, pago_total=excluded.pago_total, fuente=excluded.fuente`)
      .run(tarjeta_id, ciclo, pm, pt, fuente || 'conciliacion');
    logAction('editar', tjNombre(tarjeta_id) + 'Pago minimo oficial del extracto ' + ciclo + ': ' + Math.round(pm).toLocaleString('es-CO'));
    res.json({ ok: true, ciclo, pago_minimo: pm, pago_total: pt });
  });

  // ── Registrar el pago que saldó un extracto (conciliación IA: acción registrar_pago) ──────────
  // POST /api/extractos/registrar-pago   Body: { tarjeta_id, ciclo, monto, fecha?, moneda? }
  // Resuelve-o-crea el extracto del ciclo (típicamente el ANTERIOR al que se concilia) y registra el
  // pago reusando la MISMA lógica de PUT /:id/pagar (pagarExtracto). Idempotente: 409 si ese extracto ya
  // está pagado o ya tiene un abono registrado (no duplica el pago del usuario). El detector determinista
  // de ia.js solo propone esta acción para pagos-de-factura que cuadran con el mínimo/total del ciclo.
  router.post('/registrar-pago', (req, res) => {
    const { tarjeta_id, ciclo, monto, fecha, moneda } = req.body || {};
    if (!tarjeta_id || !ciclo) return res.status(400).json({ error: 'tarjeta_id y ciclo son requeridos' });
    const montoNum = parseFloat(monto);
    if (!(montoNum > 0)) return res.status(400).json({ error: 'monto invalido' });
    const monedaPago = (moneda === 'USD') ? 'USD' : 'COP';

    // Resolver o crear el extracto del ciclo (mismo patrón de siembra que GET /: usa calcExtracto).
    let ext = db.prepare('SELECT * FROM extractos WHERE tarjeta_id=? AND ciclo=?').get(tarjeta_id, ciclo);
    if (!ext) {
      const calc = calcExtracto(db, tarjeta_id, ciclo);
      if (!calc || (!(calc.pagoTotal > 0) && !(calc.pagoMinimo > 0))) {
        return res.status(400).json({ error: 'No hay un extracto con saldo para el ciclo ' + ciclo + '.' });
      }
      db.prepare('INSERT OR IGNORE INTO extractos (tarjeta_id, ciclo, fecha_corte, fecha_pago, pago_minimo, pago_total, intereses_intl) VALUES (?,?,?,?,?,?,?)')
        .run(tarjeta_id, ciclo, calc.fechaCorte, calc.fechaPago, calc.pagoMinimo, calc.pagoTotal, calc.interesesComprasIntl || 0);
      ext = db.prepare('SELECT * FROM extractos WHERE tarjeta_id=? AND ciclo=?').get(tarjeta_id, ciclo);
    }
    if (!ext) return res.status(500).json({ error: 'No se pudo resolver el extracto del ciclo.' });

    // Idempotencia: no re-registrar si ese extracto (en la moneda dada) ya está pagado, ya tiene algún
    // abono acumulado, o ya existe una fila de pago abono_extracto del ciclo.
    const yaPagado = monedaPago === 'USD' ? (ext.estado_usd === 'pagado') : (ext.estado === 'pagado');
    const mpPrev = monedaPago === 'USD' ? (ext.monto_pagado_usd || 0) : (ext.monto_pagado || 0);
    const dup = db.prepare("SELECT COUNT(*) n FROM pagos WHERE tarjeta_id=? AND ciclo=? AND tipo='abono_extracto' AND (moneda = ? OR (? = 'COP' AND moneda IS NULL))")
      .get(tarjeta_id, ciclo, monedaPago, monedaPago);
    if (yaPagado || mpPrev > 0 || (dup && dup.n > 0)) {
      return res.status(409).json({ error: 'El pago del ciclo ' + ciclo + ' ya esta registrado en la app.', ya_registrado: true });
    }

    // sellar: true → el detector ya confirmo que es un pago-de-factura (cuadra con el minimo/total).
    // Cierra el extracto registrando el monto REAL aunque quede levemente bajo el minimo calculado.
    const out = pagarExtracto(ext, { monto_pagado: montoNum, fecha_pagado: fecha, tipo: 'abono_extracto', moneda: monedaPago, sellar: true });
    return res.json(Object.assign({ ok: true, ciclo }, out));
  });
};
