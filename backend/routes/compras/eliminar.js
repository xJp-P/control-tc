'use strict';
// backend/routes/compras/eliminar.js
//
// Rutas movidas VERBATIM desde compras.js. Se registran sobre el MISMO router que crea el
// archivo padre, no sobre un sub-router montado: asi el stack de Express conserva su
// forma y su ORDEN exactos, y el contrato que se ve desde fuera no cambia ni un apice.
const { Router } = require('express');
const { hoyLocal, daysBetween, primerCorteAvance } = require('../../helpers/dates');
const { calcularAmortizacionDiferida } = require('../../engine/amortizacion');
const { nuOpts, nuOptsDif, aplicaIntInternacional } = require('../../helpers/banco');
const { compraTerceroConReembolso, objetivoBolsilloCop, cicloYaPagado } = require('../../helpers/bolsillo');
const { getCortesCustomMap, cicloConCorte, corteDeCiclo } = require('../../helpers/cortes');
const { tasaIntlEnFecha } = require('../../helpers/tasas');
const { pagoMinimoOficial } = require('../../helpers/extractoOficial');

module.exports = function(router, ctx) {
  const { db, logAction, tjNombre, calcCiclo, avisoCifraOficial, esCicloPagado, esCicloCerrado, targetBolsillo } = ctx;

  router.delete('/:id', (req, res) => {
    const desdeIa = !!(req.body && req.body.desde_conciliacion);
    const c = db.prepare('SELECT id, descripcion, tarjeta_id, diferida_id, ciclo, grupo_id, persona_id, COALESCE(monto_bolsillo,0) mb, COALESCE(monto_bolsillo_usd,0) mbu, COALESCE(monto_abonado,0) ma, COALESCE(reversada,0) rev FROM compras WHERE id=?').get(req.params.id);
    // Un id inexistente NO es un borrado exitoso: antes respondía {ok:true} tras un DELETE en vacío, así
    // que una acción de la IA con un compra_id alucinado reportaba "aplicada" sin haber hecho nada.
    if (!c) return res.status(404).json({ error: 'No existe la compra ' + req.params.id + '.' });
    {
      const ext = db.prepare("SELECT estado FROM extractos WHERE tarjeta_id=? AND ciclo=?").get(c.tarjeta_id, c.ciclo);
      if (ext && ext.estado === 'pagado') {
        return res.status(403).json({ error: 'No se puede eliminar: el extracto del ciclo ' + c.ciclo + ' ya está pagado.' });
      }
      // v5.8.0: DEROGADO el candado por TIEMPO. El guard de PAGADOS de arriba es el único cierre.
      // Guards de CONTENIDO, solo para la vía de la IA: el borrado manual lo hace el usuario viendo la
      // fila y sus badges, pero la IA propone a ciegas sobre un id. Sin esto, un falso positivo podía
      // evaporar el reembolso de un tercero o dejar un crédito de saldo a favor inalcanzable (la
      // aplicación queda con compra_destino_id=NULL por el ON DELETE SET NULL y el chip desaparece).
      if (desdeIa) {
        if (c.grupo_id) return res.status(403).json({ error: 'Esta compra es una parte de una compra dividida: bórrala desde la tabla, no por conciliación.' });
        if (c.mb > 0 || c.mbu > 0) return res.status(409).json({ error: 'Esta compra tiene dinero apartado en el bolsillo; retíralo antes de eliminarla.' });
        if (c.ma > 0) return res.status(409).json({ error: 'Esta compra tiene un abono registrado; no se puede eliminar por conciliación.' });
        if (c.rev) return res.status(409).json({ error: 'Esta compra está reversada; su historial no se elimina.' });
        if (compraTerceroConReembolso(db, c.id)) return res.status(403).json({ error: 'Esta compra tiene reembolsos de un tercero; gestiónalos desde Terceros antes de eliminarla.' });
        const cruce = db.prepare("SELECT 1 FROM aplicaciones_saldo_favor WHERE compra_destino_id=? AND tipo='cruce' LIMIT 1").get(c.id);
        if (cruce) return res.status(409).json({ error: 'Esta compra recibió un cruce de saldo a favor; deshazlo desde "Dinero a favor" antes de eliminarla.' });
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
    res.json({ ok: true, aviso_cifra_oficial: avisoCifraOficial(c.tarjeta_id, c.ciclo) });
  });
};
