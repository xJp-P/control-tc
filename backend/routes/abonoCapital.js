// backend/routes/abonoCapital.js — /api/abono-capital
const { Router } = require('express');
const { hoyLocal } = require('../helpers/dates');
const { calcularAmortizacionAvance } = require('../engine/amortizacion');
const { calcularAmortizacionDiferida } = require('../engine/amortizacion');
const { nuOpts, avanceOpts } = require('../helpers/banco');
const { liberarBolsilloDiferida, liberarBolsilloAvance } = require('../helpers/bolsillo');

module.exports = function(db, { logAction, tjNombre }) {
  const router = Router();

  const sortFecha = (a, b) => a.fecha.localeCompare(b.fecha) || (a.created_at || '').localeCompare(b.created_at || '');

  function buildDeudas(tarjeta_id, comprasPendientes, avancesActivos, diferidasActivas) {
    const deudas = [];
    comprasPendientes
      .filter(c => (c.valor_cop - (c.monto_abonado || 0)) > 0 && (!c.valor_usd || c.valor_usd === 0))
      .sort(sortFecha)
      .forEach(c => { const s = c.valor_cop - (c.monto_abonado || 0); deudas.push({ tipo: 'compra', fecha: c.fecha, created_at: c.created_at, id: c.id, descripcion: c.descripcion, monto: s, montoOriginal: c.valor_cop, persona_id: c.persona_id, bolsillo: (c.persona_id == null) ? (c.monto_bolsillo || 0) : 0, montoBolsillo: c.monto_bolsillo || 0 }); });
    comprasPendientes
      .filter(c => (c.valor_cop - (c.monto_abonado || 0)) > 0 && c.valor_usd && c.valor_usd > 0)
      .sort(sortFecha)
      .forEach(c => { const s = c.valor_cop - (c.monto_abonado || 0); deudas.push({ tipo: 'compra', fecha: c.fecha, created_at: c.created_at, id: c.id, descripcion: c.descripcion, monto: s, montoOriginal: c.valor_cop, persona_id: c.persona_id, bolsillo: (c.persona_id == null) ? (c.monto_bolsillo || 0) : 0, montoBolsillo: c.monto_bolsillo || 0 }); });
    diferidasActivas
      .sort((a, b) => a.fecha_compra.localeCompare(b.fecha_compra) || (a.created_at || '').localeCompare(b.created_at || ''))
      .forEach(d => {
        const abonosDif = db.prepare('SELECT * FROM abonos_diferida WHERE diferida_id=? ORDER BY fecha').all(d.id);
        const amort = calcularAmortizacionDiferida(d.monto, d.tasa_mv, d.num_cuotas, d.fecha_compra, d.fecha_primer_corte, abonosDif, nuOpts(db, d.tarjeta_id));
        const saldo = amort.resumen.saldoActual;
        if (saldo > 0) {
          const bolDif = db.prepare('SELECT COALESCE(SUM(COALESCE(monto_bolsillo,0)),0) AS t FROM compras WHERE diferida_id=? AND persona_id IS NULL').get(d.id);
          deudas.push({ tipo: 'diferida', fecha: d.fecha_compra, created_at: d.created_at, id: d.id, descripcion: d.etiqueta, monto: saldo, bolsillo: bolDif ? bolDif.t : 0 });
        }
      });
    avancesActivos
      .sort((a, b) => a.fecha_desembolso.localeCompare(b.fecha_desembolso) || (a.created_at || '').localeCompare(b.created_at || ''))
      .forEach(av => {
        const abonos = db.prepare('SELECT * FROM abonos_avance WHERE avance_id=? ORDER BY fecha').all(av.id);
        const amort = calcularAmortizacionAvance(av.monto, av.tasa_mv, av.plazo, av.fecha_desembolso, av.dia_corte, abonos, av.comision, avanceOpts(db, av.tarjeta_id));
        const saldo = amort.resumen.saldoActual;
        if (saldo > 0) deudas.push({ tipo: 'avance', fecha: av.fecha_desembolso, created_at: av.created_at, id: av.id, descripcion: av.etiqueta, monto: saldo, bolsillo: av.monto_bolsillo || 0 });
      });
    return deudas;
  }

  router.get('/preview', (req, res) => {
    const { tarjeta_id, monto: montoStr, fecha } = req.query;
    const monto = parseFloat(montoStr);
    if (!tarjeta_id || !monto || monto <= 0) return res.status(400).json({ error: 'tarjeta_id y monto son requeridos' });
    const fechaAbono = fecha || hoyLocal();

    const extPendiente = db.prepare("SELECT ciclo, pago_minimo, COALESCE(monto_pagado,0) as monto_pagado FROM extractos WHERE tarjeta_id=? AND estado='pendiente' AND fecha_corte <= ? ORDER BY ciclo ASC LIMIT 1").get(tarjeta_id, fechaAbono);
    if (extPendiente && extPendiente.monto_pagado < extPendiente.pago_minimo) {
      const falta = extPendiente.pago_minimo - extPendiente.monto_pagado;
      return res.status(400).json({ error: 'Debes pagar el extracto del ciclo ' + extPendiente.ciclo + ' antes de hacer un abono a capital. Falta: $' + new Intl.NumberFormat('es-CO').format(Math.round(falta)) });
    }

    const comprasPendientes = db.prepare("SELECT id, fecha, descripcion, valor_cop, valor_usd, COALESCE(monto_abonado,0) as monto_abonado, COALESCE(monto_bolsillo,0) as monto_bolsillo, estado, persona_id, created_at FROM compras WHERE tarjeta_id=? AND estado IN ('pendiente','bolsillo','bolsillo_parcial')").all(tarjeta_id);
    const avancesActivos = db.prepare("SELECT * FROM avances WHERE tarjeta_id=? AND estado='activo'").all(tarjeta_id);
    const diferidasActivas = db.prepare("SELECT * FROM diferidas WHERE tarjeta_id=? AND estado='activo'").all(tarjeta_id);
    const deudas = buildDeudas(tarjeta_id, comprasPendientes, avancesActivos, diferidasActivas);

    let restante = monto;
    const detalle = [];
    let bolsilloLiberado = 0;
    for (const d of deudas) {
      if (restante <= 0) break;
      const montoAplicar = Math.min(restante, d.monto);
      restante -= montoAplicar;
      // Bolsillo liberado estimado (espejo de la lógica del POST):
      //   - compra personal, abono TOTAL  → se libera todo el bolsillo.
      //   - compra personal, abono PARCIAL → solo el excedente que queda por encima del nuevo saldo.
      //   - compra de tercero             → 0 (el reembolso del deudor nunca se libera).
      //   - diferida/avance               → el helper libera el bolsillo per-cuota al tocar el capital.
      let liberado;
      if (d.tipo === 'compra') {
        const esPersonal = (d.persona_id == null);
        const bol = d.montoBolsillo || 0;
        if (!esPersonal) liberado = 0;
        else if (montoAplicar >= d.monto) liberado = bol;
        else liberado = Math.max(0, Math.round((bol - (d.monto - montoAplicar)) * 100) / 100);
      } else {
        liberado = d.bolsillo || 0;
      }
      if (liberado > 0) bolsilloLiberado += liberado;
      detalle.push({ tipo: d.tipo, id: d.id, descripcion: d.descripcion, saldoOriginal: d.monto, montoAplicado: montoAplicar, cubierto: montoAplicar >= d.monto ? 'total' : 'parcial', bolsilloLiberado: liberado });
    }
    res.json({ aplicado: monto - restante, restante, detalle, bolsilloLiberado });
  });

  router.post('/', (req, res) => {
    const { tarjeta_id, monto, fecha } = req.body;
    if (!tarjeta_id || !monto || monto <= 0) return res.status(400).json({ error: 'tarjeta_id y monto son requeridos' });
    const fechaAbono = fecha || hoyLocal();

    const extPendiente = db.prepare("SELECT ciclo, pago_minimo, COALESCE(monto_pagado,0) as monto_pagado FROM extractos WHERE tarjeta_id=? AND estado='pendiente' AND fecha_corte <= ? ORDER BY ciclo ASC LIMIT 1").get(tarjeta_id, fechaAbono);
    if (extPendiente && extPendiente.monto_pagado < extPendiente.pago_minimo) {
      const falta = extPendiente.pago_minimo - extPendiente.monto_pagado;
      return res.status(400).json({ error: 'Debes pagar el extracto del ciclo ' + extPendiente.ciclo + ' antes de hacer un abono a capital. Falta: $' + new Intl.NumberFormat('es-CO').format(Math.round(falta)) });
    }

    const comprasPendientes = db.prepare("SELECT id, fecha, descripcion, valor_cop, valor_usd, COALESCE(monto_abonado,0) as monto_abonado, COALESCE(monto_bolsillo,0) as monto_bolsillo, estado, persona_id, created_at FROM compras WHERE tarjeta_id=? AND estado IN ('pendiente','bolsillo','bolsillo_parcial')").all(tarjeta_id);
    const avancesActivos = db.prepare("SELECT * FROM avances WHERE tarjeta_id=? AND estado='activo'").all(tarjeta_id);
    const diferidasActivas = db.prepare("SELECT * FROM diferidas WHERE tarjeta_id=? AND estado='activo'").all(tarjeta_id);
    const deudas = buildDeudas(tarjeta_id, comprasPendientes, avancesActivos, diferidasActivas);

    let restante = monto;
    const detalle = [];
    let bolsilloLiberado = 0;

    for (const d of deudas) {
      if (restante <= 0) break;

      if (d.tipo === 'compra') {
        const montoAplicar = Math.min(restante, d.monto);
        restante -= montoAplicar;
        const nuevoAbonado = (d.montoOriginal - d.monto) + montoAplicar;
        const nuevoSaldo = Math.round((d.monto - montoAplicar) * 100) / 100; // deuda restante tras el abono
        const esPersonal = (d.persona_id == null);
        const bolsilloActual = d.montoBolsillo || 0; // monto_bolsillo real (en compras de tercero = reembolso del deudor)

        if (montoAplicar >= d.monto) {
          // ABONO TOTAL → deuda saldada ('pagado'). En personales se libera TODO el bolsillo (ya no se
          // necesita apartar nada). En terceros el reembolso (monto_bolsillo) se conserva intacto: es la
          // contabilidad del deudor (la vista Terceros lo usa como valor_cop - monto_bolsillo), no plata propia.
          const liberado = esPersonal ? bolsilloActual : 0;
          if (liberado > 0) bolsilloLiberado += liberado;
          const setBol = esPersonal ? ', monto_bolsillo=0, monto_bolsillo_usd=0' : '';
          db.prepare("UPDATE compras SET estado='pagado', monto_abonado=?" + setBol + " WHERE id=?").run(nuevoAbonado, d.id);
          detalle.push({ tipo: 'compra', id: d.id, descripcion: d.descripcion, saldoOriginal: d.monto, montoAplicado: montoAplicar, cubierto: 'total', bolsilloLiberado: liberado });
        } else {
          // ABONO PARCIAL → la compra mantiene saldo. NO se vacía el bolsillo: se conserva, y solo si por
          // la reducción de la deuda quedó por encima del nuevo saldo se cap-ea a ese saldo (el excedente
          // se libera). El estado se DERIVA de cuánto cubre el bolsillo del saldo restante (>= saldo →
          // 'bolsillo'; > 0 → 'bolsillo_parcial'; si no → 'pendiente'), en vez de forzar 'pendiente'.
          // En terceros el reembolso no se toca, pero igual decide el estado (puede cubrir la deuda).
          let nuevoBolsillo = bolsilloActual;
          let liberado = 0;
          if (esPersonal && bolsilloActual > nuevoSaldo) {
            nuevoBolsillo = nuevoSaldo;
            liberado = Math.round((bolsilloActual - nuevoSaldo) * 100) / 100;
            if (liberado > 0) bolsilloLiberado += liberado;
          }
          const bolParaEstado = esPersonal ? nuevoBolsillo : bolsilloActual;
          const nuevoEstado = bolParaEstado >= nuevoSaldo ? 'bolsillo' : (bolParaEstado > 0 ? 'bolsillo_parcial' : 'pendiente');
          if (esPersonal) {
            db.prepare("UPDATE compras SET estado=?, monto_abonado=?, monto_bolsillo=? WHERE id=?").run(nuevoEstado, nuevoAbonado, nuevoBolsillo, d.id);
          } else {
            db.prepare("UPDATE compras SET estado=?, monto_abonado=? WHERE id=?").run(nuevoEstado, nuevoAbonado, d.id);
          }
          detalle.push({ tipo: 'compra', id: d.id, descripcion: d.descripcion, saldoOriginal: d.monto, montoAplicado: montoAplicar, cubierto: 'parcial', bolsilloLiberado: liberado });
        }
      } else if (d.tipo === 'diferida') {
        const montoAbono = Math.min(restante, d.monto);
        restante -= montoAbono;
        db.prepare('INSERT INTO abonos_diferida (diferida_id, fecha, monto, notas) VALUES (?,?,?,?)').run(d.id, fechaAbono, montoAbono, 'Abono a capital');
        // Liberar el bolsillo per-cuota: el abono redujo el capital, así que la plata apartada
        // queda libre (siempre que se toque, total o parcial; no proporcional).
        const liberado = liberarBolsilloDiferida(db, d.id);
        if (liberado > 0) bolsilloLiberado += liberado;
        const cubierto = montoAbono >= d.monto ? 'total' : 'parcial';
        detalle.push({ tipo: 'diferida', id: d.id, descripcion: d.descripcion, saldoOriginal: d.monto, montoAplicado: montoAbono, cubierto, bolsilloLiberado: liberado });
        if (montoAbono >= d.monto) db.prepare("UPDATE diferidas SET estado='liquidado' WHERE id=?").run(d.id);
      } else if (d.tipo === 'avance') {
        const montoAbono = Math.min(restante, d.monto);
        restante -= montoAbono;
        db.prepare('INSERT INTO abonos_avance (avance_id, fecha, monto, notas) VALUES (?,?,?,?)').run(d.id, fechaAbono, montoAbono, 'Abono a capital');
        const liberado = liberarBolsilloAvance(db, d.id);
        if (liberado > 0) bolsilloLiberado += liberado;
        const cubierto = montoAbono >= d.monto ? 'total' : 'parcial';
        detalle.push({ tipo: 'avance', id: d.id, descripcion: d.descripcion, saldoOriginal: d.monto, montoAplicado: montoAbono, cubierto, bolsilloLiberado: liberado });
        if (montoAbono >= d.monto) db.prepare("UPDATE avances SET estado='liquidado' WHERE id=?").run(d.id);
      }
    }

    const ciclo = fechaAbono.slice(0, 7);
    db.prepare('INSERT INTO pagos (tarjeta_id, fecha, monto, tipo, ciclo, notas) VALUES (?,?,?,?,?,?)')
      .run(tarjeta_id, fechaAbono, monto, 'abono_capital', ciclo, 'Abono a capital - ' + detalle.map(d => d.descripcion).join(', '));

    const fmt = new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',maximumFractionDigits:0}).format(monto);
    const fmtLib = new Intl.NumberFormat('es-CO',{style:'currency',currency:'COP',maximumFractionDigits:0}).format(bolsilloLiberado);
    logAction('pago', tjNombre(tarjeta_id) + 'Abono a capital: ' + fmt + ' distribuido en ' + detalle.length + ' deuda(s)' + (bolsilloLiberado > 0 ? ' (bolsillo liberado: ' + fmtLib + ')' : ''));
    res.json({ ok: true, aplicado: monto - restante, restante, detalle, bolsilloLiberado });
  });

  return router;
};
