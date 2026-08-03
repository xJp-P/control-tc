'use strict';
// backend/routes/extractos/_compartido.js — Helpers internos del router de extractos.
//
// Cuerpos movidos VERBATIM desde extractos.js. Se exponen por una factory porque son CLOSURES
// sobre el contexto del router: recibirlo entero es la unica forma de moverlos sin tocar
// su codigo. Recibe logAction y tjNombre ademas de db aunque algun helper no los use:
// pagarExtracto (extractos) SI los llama, y pasarle solo `db` lo dejaba con logAction
// indefinido -> HTTP 500 al registrar un pago. Lo caza R6, que es el unico detector que
// ejercita rutas de ESCRITURA; ninguno de los otros catorce lo habria visto.
const { minimoEfectivo, pagoMinimoOficial } = require('../../helpers/extractoOficial');
// Margen que el pago de un extracto puede desviarse del mínimo estimado y aun así darse por completo.
// Existe porque el estimado NO puede ser exacto por diseño (el banco cobra interés sobre la cuota ya
// facturada hasta el día del pago). Calibrado con 10 extractos reales: los desfases medidos van de
// −$1.628 a +$1.060. Un abono parcial de verdad es de otro orden de magnitud y queda fuera.
const TOLERANCIA_PAGO_COP = 2000;
const { hoyLocal } = require('../../helpers/dates');
const { calcExtracto } = require('../../engine/extracto');

module.exports = function(db, logAction, tjNombre) {

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
    // Mínimo EFECTIVO: si se conoce la cifra oficial del extracto (v5.7.0) manda esa, no el estimado.
    // Es imprescindible para el caso en que la app SOBREESTIMA (medido: junio-2026, app $238.099 vs
    // banco $237.136,05): sin esto, el usuario paga el valor correcto del banco, la comparación lo ve
    // por debajo del estimado y el extracto NO se sella — queda como abono parcial, sin formar la
    // tríada del blindaje, y el usuario cree que ya pagó. `ext` viene del SELECT crudo de la tabla, que
    // conserva el valor calculado, así que la resolución se hace aquí.
    const minimoRef = minimoEfectivo(db, ext.tarjeta_id, ext.ciclo, ext.pago_minimo);

    if (monedaPago === 'COP') {
      const montoAbono = parseFloat(monto_pagado) || minimoRef;
      const nuevoMontoPagado = (ext.monto_pagado || 0) + montoAbono;
      // MARGEN DE TOLERANCIA (v5.7.1). Conciliar el PDF es OPCIONAL; pagar no lo es. Sin esto, un mes
      // sin conciliar dejaba al usuario ante un estimado que se sabe imperfecto por diseño (el banco
      // cobra interés sobre la cuota facturada hasta el día del pago, dato del futuro — ver
      // docs/bancos/RappiCard_Visa.md §4.3.2) y el extracto NO sellaba al pagar el valor REAL del banco.
      // El backtesting de 10 extractos midió esos desfases entre −$1.628 y +$1.060, así que $2.000
      // los cubre con holgura sin tragarse un abono parcial de verdad (que es de otro orden).
      const yaHabiaOficial = pagoMinimoOficial(db, ext.tarjeta_id, ext.ciclo) != null;
      const faltante = minimoRef - nuevoMontoPagado;
      // La banda solo tiene sentido cuando la referencia es un ESTIMADO. Si ya se conoce la cifra
      // impresa del banco, un faltante NO es imprecisión del modelo: es plata que falta, y no cubrir
      // el mínimo pone en mora la obligación COMPLETA. Ahí queda solo un epsilon para el redondeo
      // (la cifra oficial trae centavos: $237.136,05 vs los $237.136 que el usuario teclea).
      // Piso RELATIVO además del absoluto: sin él, un ciclo cuyo mínimo es de por sí menor a $2.000
      // (ej. la cuota 1/5 de $1.180 del experimento) se sellaba entero con un pago simbólico.
      const banda = yaHabiaOficial ? 1 : Math.min(TOLERANCIA_PAGO_COP, Math.round(minimoRef * 0.02));
      const dentroTolerancia = faltante > 0 && faltante <= banda;
      const pagadoCompleto = (nuevoMontoPagado >= minimoRef) || dentroTolerancia || sellarFactura;
      // Auto-ajuste: cuando el pago cae en la banda de tolerancia, lo que el usuario pagó ES el mínimo
      // real del banco, así que se ADOPTA como cifra oficial del ciclo. Con eso la matemática cierra en
      // TODAS las vistas (Pagos, card del dashboard y "Próximos Pagos" leen el mismo valor vía
      // helpers/extractoOficial) y no queda un "Falta: $963" fantasma. Solo cuando NO hay ya una cifra
      // oficial del PDF (esa es más confiable y no se pisa) y solo dentro de la banda: un pago total o
      // un abono parcial de verdad quedan fuera por magnitud.
      const desfase = Math.round(nuevoMontoPagado - minimoRef);
      // Nunca adoptar un "mínimo" mayor que el pago total del ciclo — es el mismo guard de coherencia
      // que la vía manual impone con un 400.
      const coherente = !(ext.pago_total > 0 && nuevoMontoPagado > ext.pago_total);
      const ajustaPorTolerancia = !yaHabiaOficial && coherente && desfase !== 0
        && Math.abs(desfase) <= TOLERANCIA_PAGO_COP;

      if (pagadoCompleto) {
        if (ajustaPorTolerancia) {
          db.prepare(`INSERT INTO extractos_oficiales (tarjeta_id, ciclo, pago_minimo, pago_total, fuente)
                      VALUES (?,?,?,NULL,?)
                      ON CONFLICT(tarjeta_id, ciclo) DO UPDATE SET pago_minimo=excluded.pago_minimo, fuente=excluded.fuente`)
            .run(ext.tarjeta_id, ext.ciclo, nuevoMontoPagado, 'ajuste por dias de interes');
          logAction('editar', tjNombre(ext.tarjeta_id) + 'Ajuste por dias de interes en ' + ext.ciclo + ': '
            + (desfase > 0 ? '+' : '') + Math.round(desfase).toLocaleString('es-CO'));
        }
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
      // `ajuste` viaja al frontend para que el toast explique por qué se dio por completo un pago que
      // no coincide al peso con el estimado, en vez de que el número cambie sin aviso.
      return { ok: true, pagadoCompleto, nuevoMontoPagado, moneda: 'COP',
        ajuste: (pagadoCompleto && ajustaPorTolerancia) ? desfase : 0,
        absorbido_por_tolerancia: !!(pagadoCompleto && dentroTolerancia), faltante_absorbido: (pagadoCompleto && dentroTolerancia) ? Math.round(faltante) : 0 };
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

  return { pagarExtracto };
};
