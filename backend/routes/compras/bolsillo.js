'use strict';
// backend/routes/compras/bolsillo.js
//
// Rutas movidas VERBATIM desde compras.js. Se registran sobre el MISMO router que crea el
// archivo padre, no sobre un sub-router montado: asi el stack de Express conserva su
// forma y su ORDEN exactos, y el contrato que se ve desde fuera no cambia ni un apice.
const { cicloYaPagado } = require('../../helpers/bolsillo');

module.exports = function(router, ctx) {
  const { db, logAction, tjNombre, calcCiclo, avisoCifraOficial, esCicloPagado, esCicloCerrado, targetBolsillo } = ctx;

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
    // Candado de saldo a favor (v4.8.1): si la compra recibió un cruce, el bolsillo puede SUBIR (agregar
    // efectivo para completar un cruce PARCIAL) pero NUNCA bajar de lo ya cruzado — reducirlo descuadraría
    // el crédito del tercero (para eso se deshace el cruce desde "Dinero a favor"). El piso se valida abajo,
    // tras aplicar el cap a nuevoMonto.
    // El piso se mide en la MISMA unidad que la escritura. Con una diferida la escritura es de UNA
    // cuota, asi que compararla contra el total de cruces de toda la compra bloquearia ediciones
    // legitimas o dejaria borrar un cruce; se filtra por cuota. Para 1 cuota los cruces tienen
    // cuota_num NULL, asi que la suma es la de siempre -> sin regresion.
    const escrituraPorCuota = (cuota_num != null && c.estado === 'diferida');
    const cruceCubierto = (escrituraPorCuota
      ? db.prepare("SELECT COALESCE(SUM(monto),0) as s FROM aplicaciones_saldo_favor WHERE compra_destino_id=? AND tipo='cruce' AND cuota_num=?").get(req.params.id, cuota_num)
      : db.prepare("SELECT COALESCE(SUM(monto),0) as s FROM aplicaciones_saldo_favor WHERE compra_destino_id=? AND tipo='cruce'").get(req.params.id)).s || 0;
    // Inferir moneda: explícita > heurística (compra USD pura).
    const compraEsUsd = (c.valor_usd && c.valor_usd > 0) && !c.valor_cop;
    const monedaPago = moneda === 'USD' ? 'USD' : (moneda === 'COP' ? 'COP' : (compraEsUsd ? 'USD' : 'COP'));
    let nuevoMonto = monedaPago === 'USD'
      ? (Math.round((parseFloat(monto_bolsillo) || 0) * 100) / 100)
      : Math.round(parseFloat(monto_bolsillo) || 0);

    // CAP: nunca apartar más que lo que la compra va a costar (valor [+ interés intl] / cuota).
    let capped = false;
    let tope = targetBolsillo(c, monedaPago, cuota_num);
    // Si la compra ya tiene un abono a capital (COP), el tope baja al saldo restante: no se debe apartar
    // más de lo que aún se debe (valor [+ interés] − abonado). Para abonado=0 el tope no cambia.
    // NUNCA en compras de TERCERO (!c.persona_id): ahí monto_abonado es lo que YO le pagué al BANCO
    // (libro del banco), mientras monto_bolsillo es SU reembolso (libro del tercero) y él me sigue
    // debiendo capital+interés. Restarlo dejaba el tope en 0 en una cuota SELLADA de ciclo pagado
    // (monto_abonado=capital) → guardar el bolsillo lo BORRABA y su deuda saltaba de $0 al capital
    // completo, en silencio. Hallazgo CRÍTICO de la revisión adversarial de v5.6.0.
    if (monedaPago === 'COP' && tope != null && !c.persona_id && (c.monto_abonado || 0) > 0) tope = Math.max(0, tope - (c.monto_abonado || 0));
    if (tope != null && nuevoMonto > tope) { nuevoMonto = tope; capped = true; }

    // Piso del cruce: el bolsillo COP no puede quedar por debajo de lo cubierto por un saldo a favor
    // cruzado (descuadraría el crédito). Subir por encima = agregar efectivo para completar el cruce = OK.
    if (cruceCubierto > 0 && monedaPago === 'COP' && nuevoMonto < cruceCubierto - 0.5) {
      return res.status(409).json({ error: 'Esta compra tiene ' + new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(cruceCubierto) + ' cubiertos por un saldo a favor cruzado. No puedes dejar el bolsillo por debajo de ese monto; para reducirlo, deshaz el cruce desde "Dinero a favor".' });
    }

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
      // Non-diferida: bolsillo global. Para compras USD comparamos contra valor_usd; COP contra el SALDO
      // restante (valor − abonado), no el valor completo: si hay un abono a capital previo, un bolsillo
      // que cubra el saldo restante debe marcar 'bolsillo' (no 'bolsillo_parcial'). Para abonado=0 es igual.
      // El objetivo de estado = el MISMO tope intl-aware ya calculado arriba (valor [+ intl] − abonado).
      // Antes se recomputaba como valor_cop − abonado, ignorando el intl → una compra internacional
      // marcaba 'bolsillo' cubriendo solo el capital, incoherente con el cap y con Terceros (v4.8.2).
      const target = tope != null ? tope : (monedaPago === 'USD' ? (c.valor_usd || 0) : Math.max(0, c.valor_cop - (c.monto_abonado || 0)));
      // El estado con el BANCO se CONGELA si el ciclo ya se pagó (v5.6.1): es el invariante que syncData
      // paso 6 impone en cada arranque, y el bolsillo no puede reabrir un mes cerrado. Antes se derivaba
      // igual → una compra de un ciclo pagado quedaba con el badge en "Pendiente" hasta el próximo
      // arranque (sin afectar la deuda, porque monto_abonado ya cubría el valor, pero confundiendo).
      const nuevoEstado = c.estado === 'diferida' ? 'diferida'
        : cicloYaPagado(db, c) ? c.estado
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
};
