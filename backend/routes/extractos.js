// backend/routes/extractos.js — /api/extractos + pagar
const { Router } = require('express');
const { hoyLocal } = require('../helpers/dates');
const { calcularAmortizacionAvance, calcularAmortizacionDiferida } = require('../engine/amortizacion');
const { nuOpts, nuOptsDif, avanceOpts } = require('../helpers/banco');
const { calcExtracto } = require('../engine/extracto');

module.exports = function(db, { logAction, tjNombre }) {
  const router = Router();

  router.get('/', (req, res) => {
    const { tarjeta_id } = req.query;
    if (!tarjeta_id) return res.status(400).json({ error: 'tarjeta_id requerido' });

    const extractos = db.prepare('SELECT * FROM extractos WHERE tarjeta_id=? ORDER BY ciclo DESC').all(tarjeta_id);
    const hoy = new Date();
    const ciclosConDeuda = new Set();

    const comprasCiclos = db.prepare("SELECT DISTINCT ciclo FROM compras WHERE tarjeta_id=? AND estado NOT IN ('pagado','diferida') AND ciclo IS NOT NULL").all(tarjeta_id);
    comprasCiclos.forEach(c => ciclosConDeuda.add(c.ciclo));

    const avancesAll = db.prepare("SELECT * FROM avances WHERE tarjeta_id=? AND estado='activo'").all(tarjeta_id);
    avancesAll.forEach(av => {
      const abonos = db.prepare('SELECT * FROM abonos_avance WHERE avance_id=? ORDER BY fecha').all(av.id);
      const amort = calcularAmortizacionAvance(av.monto, av.tasa_mv, av.plazo, av.fecha_desembolso, av.dia_corte, abonos, av.comision, avanceOpts(db, av.tarjeta_id));
      amort.tabla.forEach(r => ciclosConDeuda.add(r.fechaCorte.slice(0, 7)));
    });

    const diferidasAll = db.prepare("SELECT * FROM diferidas WHERE tarjeta_id=? AND estado='activo'").all(tarjeta_id);
    diferidasAll.forEach(d => {
      const amort = calcularAmortizacionDiferida(d.monto, d.tasa_mv, d.num_cuotas, d.fecha_compra, d.fecha_primer_corte, null, nuOptsDif(db, d));
      amort.tabla.forEach(r => ciclosConDeuda.add(r.fechaCorte.slice(0, 7)));
    });

    ciclosConDeuda.add(hoy.getFullYear() + '-' + String(hoy.getMonth() + 1).padStart(2, '0'));

    ciclosConDeuda.forEach(ciclo => {
      const exists = db.prepare('SELECT id FROM extractos WHERE tarjeta_id=? AND ciclo=?').get(tarjeta_id, ciclo);
      if (!exists) {
        const calc = calcExtracto(db, tarjeta_id, ciclo);
        if (calc && (calc.pagoTotal > 0 || calc.pagoMinimo > 0)) {
          db.prepare('INSERT OR IGNORE INTO extractos (tarjeta_id, ciclo, fecha_corte, fecha_pago, pago_minimo, pago_total, intereses_intl) VALUES (?,?,?,?,?,?,?)')
            .run(tarjeta_id, ciclo, calc.fechaCorte, calc.fechaPago, calc.pagoMinimo, calc.pagoTotal, calc.interesesComprasIntl || 0);
        }
      }
    });

    const result = db.prepare(`
      SELECT ext.*, fpc.fecha_pago as fecha_pago_custom, cc.fecha_corte as fecha_corte_custom
      FROM extractos ext
      LEFT JOIN fechas_pago_custom fpc ON fpc.tarjeta_id = ext.tarjeta_id AND fpc.ciclo = ext.ciclo
      LEFT JOIN cortes_custom cc ON cc.tarjeta_id = ext.tarjeta_id AND cc.ciclo = ext.ciclo
      WHERE ext.tarjeta_id = ? ORDER BY ext.ciclo DESC
    `).all(tarjeta_id);
    result.forEach(ext => {
      // Si hay override manual de fecha de pago, lo aplicamos al campo display.
      // El valor "auto" original sigue intacto en la columna extractos.fecha_pago.
      if (ext.fecha_pago_custom) {
        ext.fecha_pago_auto = ext.fecha_pago;
        ext.fecha_pago = ext.fecha_pago_custom;
        ext.es_fecha_pago_manual = true;
      } else {
        ext.es_fecha_pago_manual = false;
      }
      // Corte adelantado (cortes_custom): mismo patrón que la fecha de pago manual — se aplica al
      // campo display y se marca con un flag para que la UI muestre "(ADELANTADO)". El valor teórico
      // original queda en fecha_corte_auto. Solo display: no recalcula intereses ni pago mínimo.
      if (ext.fecha_corte_custom) {
        ext.fecha_corte_auto = ext.fecha_corte;
        ext.fecha_corte = ext.fecha_corte_custom;
        ext.es_corte_adelantado = true;
      } else {
        ext.es_corte_adelantado = false;
      }
      const calc = calcExtracto(db, tarjeta_id, ext.ciclo, ext.estado === 'pagado');
      if (calc) {
        ext.compras = calc.compras;
        ext.detalle_compras = calc.detalleCompras;
        ext.cuotas_capital = calc.cuotasCapital;
        ext.cuotas_interes = calc.cuotasInteres;
        ext.avances_total = calc.avancesTotal;
        ext.diferidas_total = calc.diferidasTotal;
        ext.detalle_avances = calc.detalleAvances;
        ext.detalle_diferidas = calc.detalleDiferidas;
        ext.dual_extracto = calc.dualExtracto || false;
        ext.compras_usd = calc.comprasUsd || 0;
        ext.intereses_compras_usd = calc.interesesComprasUsd || 0;
        ext.detalle_compras_usd = calc.detalleComprasUsd || [];
        if (ext.estado === 'pendiente') {
          ext.pago_minimo = calc.pagoMinimo;
          ext.pago_total = calc.pagoTotal;
          ext.intereses_intl = calc.interesesComprasIntl || 0;
          ext.pago_minimo_usd = calc.pagoMinimoUsd || 0;
          db.prepare('UPDATE extractos SET pago_minimo=?, pago_total=?, fecha_corte=?, fecha_pago=?, intereses_intl=?, pago_minimo_usd=? WHERE id=?')
            .run(calc.pagoMinimo, calc.pagoTotal, calc.fechaCorte, calc.fechaPago, calc.interesesComprasIntl || 0, calc.pagoMinimoUsd || 0, ext.id);
        }
        // Para extractos PAGADOS conservamos intereses_intl y pago_minimo_usd que
        // se persistieron al cerrar. Ya vienen desde el SELECT inicial y NO se
        // sobreescriben acá.

        // Campo derivado: el ciclo está completamente cerrado cuando ambas porciones
        // (COP y USD) están al día (o USD es 'no_aplica' para tarjetas no-duales).
        ext.cerrado_completo = ext.estado === 'pagado' && (ext.estado_usd === 'pagado' || ext.estado_usd === 'no_aplica');
      }
    });

    const filtered = result.filter(ext => ext.estado === 'pagado' || ext.pago_minimo > 0 || ext.pago_total > 0);
    result.forEach(ext => {
      if (ext.estado === 'pendiente' && ext.pago_minimo <= 0 && ext.pago_total <= 0) {
        db.prepare('DELETE FROM extractos WHERE id=?').run(ext.id);
      }
    });

    res.json(filtered);
  });

  // Núcleo de registro de pago/abono a un extracto (COP o USD). Lo comparten PUT /:id/pagar y
  // POST /registrar-pago. Recibe la fila del extracto ya resuelta y devuelve el objeto de respuesta
  // (el caller hace res.json). Efecto: acumula monto_pagado; al alcanzar el mínimo sella el extracto
  // (marca las compras del ciclo como pagadas, limpia bolsillo personal y congela tasa intl).
  function pagarExtracto(ext, body) {
    const { monto_pagado, fecha_pagado, tipo, moneda } = body || {};
    const monedaPago = (moneda === 'USD') ? 'USD' : 'COP';
    const fechaPagado = fecha_pagado || hoyLocal();
    const tipoPago = tipo || 'abono_extracto';
    // sellar: fuerza el cierre del extracto aunque el monto quede levemente por debajo del pago_minimo
    // que CALCULA la app. Lo usa POST /registrar-pago: el detector determinista ya confirmo que la linea
    // es un pago-de-factura (cuadra ~1% con el minimo/total real del banco), y el minimo de la app puede
    // SOBREESTIMAR el real (interes revolvente / diferidas balloon modeladas uniformes). Sin esto, un pago
    // dentro de la banda pero < al minimo calculado quedaria como abono PARCIAL (no sella, no forma la
    // triada del blindaje) y el reintento se auto-bloquearia (409 + detector devuelve []). Se registra el
    // monto REAL del PDF (no se infla el ledger). PUT /:id/pagar NO lo envia -> los abonos parciales
    // manuales siguen sin sellar.
    const sellarFactura = !!(body && body.sellar);

    if (monedaPago === 'COP') {
      const montoAbono = parseFloat(monto_pagado) || ext.pago_minimo;
      const nuevoMontoPagado = (ext.monto_pagado || 0) + montoAbono;
      const pagadoCompleto = (nuevoMontoPagado >= ext.pago_minimo) || sellarFactura;

      if (pagadoCompleto) {
        const calcCierre = calcExtracto(db, ext.tarjeta_id, ext.ciclo, false);
        const interesesIntlFinal = calcCierre ? (calcCierre.interesesComprasIntl || 0) : (ext.intereses_intl || 0);
        db.prepare("UPDATE extractos SET estado='pagado', monto_pagado=?, fecha_pagado=?, intereses_intl=? WHERE id=?")
          .run(nuevoMontoPagado, fechaPagado, interesesIntlFinal, ext.id);
        // Solo marca como pagadas las compras COP del ciclo (sin USD). Las compras
        // USD se marcan cuando se cierre la porción USD.
        db.prepare(`UPDATE compras SET estado='pagado', monto_abonado=valor_cop
          WHERE tarjeta_id=? AND ciclo=? AND estado NOT IN ('pagado','diferida')
            AND (valor_usd IS NULL OR valor_usd = 0)`)
          .run(ext.tarjeta_id, ext.ciclo);
        // Limpiar bolsillo SOLO de compras personales recién pagadas (plata propia que ya cumplió su
        // fin). En compras de tercero, monto_bolsillo es el reembolso del deudor → no se toca.
        db.prepare(`UPDATE compras SET monto_bolsillo=0, monto_bolsillo_usd=0
          WHERE tarjeta_id=? AND ciclo=? AND estado='pagado' AND persona_id IS NULL
            AND (valor_usd IS NULL OR valor_usd = 0)`)
          .run(ext.tarjeta_id, ext.ciclo);
        // Freeze al cerrar: congela la tasa intl ACTUAL de la tarjeta en las compras internacionales
        // de este ciclo que aún no tengan tasa propia (piso de seguridad contra drift futuro). Si el
        // usuario o la IA ya fijaron una tasa por compra, no se toca.
        const tjRateCop = db.prepare('SELECT tasa_mv_avances FROM tarjetas WHERE id=?').get(ext.tarjeta_id);
        if (tjRateCop && tjRateCop.tasa_mv_avances != null) {
          db.prepare(`UPDATE compras SET tasa_intl=?
            WHERE tarjeta_id=? AND ciclo=? AND tasa_intl IS NULL
              AND (es_internacional=1 OR (valor_usd IS NOT NULL AND valor_usd > 0))`)
            .run(tjRateCop.tasa_mv_avances, ext.tarjeta_id, ext.ciclo);
        }
      } else {
        db.prepare("UPDATE extractos SET monto_pagado=?, fecha_pagado=? WHERE id=?")
          .run(nuevoMontoPagado, fechaPagado, ext.id);
      }

      db.prepare("INSERT INTO pagos (tarjeta_id, fecha, monto, tipo, ciclo, notas, moneda) VALUES (?,?,?,?,?,?,'COP')")
        .run(ext.tarjeta_id, fechaPagado, montoAbono, tipoPago, ext.ciclo,
          (pagadoCompleto ? 'Pago completo extracto COP ' : 'Abono a extracto COP ') + ext.ciclo);

      const fmt = new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',maximumFractionDigits:0}).format(montoAbono);
      logAction('pago', tjNombre(ext.tarjeta_id) + (pagadoCompleto ? 'Extracto pagado COP: ' : 'Abono a extracto COP: ') + ext.ciclo + ' por ' + fmt);
      return { ok: true, pagadoCompleto, nuevoMontoPagado, moneda: 'COP' };
    }

    // moneda === 'USD'
    const montoAbonoUsd = parseFloat(monto_pagado) || ext.pago_minimo_usd || 0;
    const nuevoMontoPagadoUsd = (ext.monto_pagado_usd || 0) + montoAbonoUsd;
    const pagadoCompletoUsd = (nuevoMontoPagadoUsd >= (ext.pago_minimo_usd || 0)) || sellarFactura;

    if (pagadoCompletoUsd) {
      db.prepare("UPDATE extractos SET estado_usd='pagado', monto_pagado_usd=?, fecha_pagado_usd=? WHERE id=?")
        .run(nuevoMontoPagadoUsd, fechaPagado, ext.id);
      // Solo marca como pagadas las compras USD del ciclo.
      db.prepare(`UPDATE compras SET estado='pagado', monto_abonado=valor_cop
        WHERE tarjeta_id=? AND ciclo=? AND estado NOT IN ('pagado','diferida')
          AND valor_usd IS NOT NULL AND valor_usd > 0`)
        .run(ext.tarjeta_id, ext.ciclo);
      // Limpiar bolsillo SOLO de compras personales USD recién pagadas (no toca las de tercero).
      db.prepare(`UPDATE compras SET monto_bolsillo=0, monto_bolsillo_usd=0
        WHERE tarjeta_id=? AND ciclo=? AND estado='pagado' AND persona_id IS NULL
          AND valor_usd IS NOT NULL AND valor_usd > 0`)
        .run(ext.tarjeta_id, ext.ciclo);
    } else {
      db.prepare("UPDATE extractos SET monto_pagado_usd=?, fecha_pagado_usd=? WHERE id=?")
        .run(nuevoMontoPagadoUsd, fechaPagado, ext.id);
    }

    db.prepare("INSERT INTO pagos (tarjeta_id, fecha, monto, tipo, ciclo, notas, moneda) VALUES (?,?,?,?,?,?,'USD')")
      .run(ext.tarjeta_id, fechaPagado, montoAbonoUsd, tipoPago, ext.ciclo,
        (pagadoCompletoUsd ? 'Pago completo extracto USD ' : 'Abono a extracto USD ') + ext.ciclo);

    const fmtUsd = 'USD $' + new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(montoAbonoUsd);
    logAction('pago', tjNombre(ext.tarjeta_id) + (pagadoCompletoUsd ? 'Extracto pagado USD: ' : 'Abono a extracto USD: ') + ext.ciclo + ' por ' + fmtUsd);
    return { ok: true, pagadoCompleto: pagadoCompletoUsd, nuevoMontoPagado: nuevoMontoPagadoUsd, moneda: 'USD' };
  }

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

  return router;
};
