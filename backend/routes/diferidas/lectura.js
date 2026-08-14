'use strict';
// backend/routes/diferidas/lectura.js
//
// Rutas movidas VERBATIM desde diferidas.js. Se registran sobre el MISMO router que crea el
// archivo padre, no sobre un sub-router montado: asi el stack de Express conserva su
// forma y su ORDEN exactos, y el contrato que se ve desde fuera no cambia ni un apice.
const { hoyLocal } = require('../../helpers/dates');
const { calcularAmortizacionDiferida } = require('../../engine/amortizacion');
const { nuOptsDif } = require('../../helpers/banco');
const { compraTerceroConReembolso } = require('../../helpers/bolsillo');

module.exports = function(router, ctx) {
  const { db, logAction, tjNombre, validateDiferidaMutable } = ctx;

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
      // valor_usd/monto_abonado se traen para los flags de elegibilidad de abajo: el boton
      // "Reprogramar saldo" vive ahora en la FILA, asi que su estado no puede depender de haber
      // abierto antes el detalle (GET /:id, el unico sitio donde existian estos flags).
      const compraVinc = db.prepare(`SELECT id, monto_bolsillo, valor_cop, valor_usd, monto_abonado, grupo_id, nota_personal FROM compras WHERE diferida_id = ? ORDER BY id LIMIT 1`).get(d.id);
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
        // Elegibilidad para "Reprogramar saldo" — MISMOS tres flags y MISMA definicion que GET /:id,
        // para que la fila y el detalle no puedan discrepar sobre si el boton va habilitado.
        es_usd_pura: !!(compraVinc && compraVinc.valor_usd > 0 && !(compraVinc.valor_cop > 0)),
        tiene_abono_parcial: !!(compraVinc && (compraVinc.monto_abonado || 0) > 0),
        tercero_con_reembolso: !!(compraVinc && compraTerceroConReembolso(db, compraVinc.id)),
        // Nota personal de la compra vinculada (se muestra junto al nombre en la tabla, igual que en Compras).
        nota_personal: compraVinc ? (compraVinc.nota_personal || null) : null,
        // Bolsillo total (cache) y per-cuota
        monto_bolsillo: compraVinc ? (compraVinc.monto_bolsillo || 0) : (d.monto_bolsillo || 0),
        bolsillo_por_cuota: bolPorCuota
      };
    });

    // Cuotas SELLADAS por reprogramacion de saldo del ciclo consultado: son compras (diferida_id=NULL,
    // notas "sellada por reprogramacion") = cuotas YA facturadas del plan viejo. La diferida original se
    // borro al "Sellar y Renacer", asi que sin esto el historial del plan DESAPARECE de la pestaña
    // Diferidas al navegar a un mes pasado. Se inyectan como filas READ-ONLY (id string 'sellada-N', sin
    // amortizacion ni acciones) SOLO cuando se consulta ese ciclo. No son diferidas reales ni afectan
    // calculos (deuda/pago minimo salen del backend); es puro historial visual. La compra sellada se
    // conserva ademas en la tabla de Compras (es un pago historico real).
    if (ciclo) {
      const paramsS = [ciclo];
      let sqlS = "SELECT c.*, pe.nombre AS _pnom, pe.color AS _pcol FROM compras c LEFT JOIN personas pe ON c.persona_id=pe.id WHERE c.ciclo=? AND c.notas LIKE '%sellada por reprogramacion%'";
      if (tarjeta_id) { sqlS += ' AND c.tarjeta_id=?'; paramsS.push(tarjeta_id); }
      db.prepare(sqlS).all(...paramsS).forEach(s => {
        const mm = /\(cuota\s+(\d+)\/(\d+)\)/i.exec(s.descripcion || '') || /Cuota\s+(\d+)\/(\d+)/i.exec(s.notas || '') || [];
        const base = String(s.descripcion || '').replace(/\s*\(cuota\s+\d+\/\d+\)\s*$/i, '').trim();
        result.push({
          id: 'sellada-' + s.id, _sellada: true, tarjeta_id: s.tarjeta_id,
          etiqueta: base || s.descripcion, fecha_compra: s.fecha,
          // saldoActual = lo que AUN se debe por esa cuota con el banco, no un 0 fijo. La fila nacio
          // pensada para selladas de ciclos ya PAGADOS, donde 0 es correcto; desde que v5.8.0 permite
          // reprogramar un ciclo cerrado pero IMPAGO, una sellada puede seguir viva y el 0 decia
          // "no debes nada" sobre una cuota que el extracto de ese mes SI esta cobrando.
          // La resta cubre los dos casos sin ramificar: si esta pagada, monto_abonado == valor_cop -> 0.
          // Es deuda con el BANCO, asi que el bolsillo no la reduce (dinero apartado no es dinero pagado).
          cuotaCorte: Math.round(s.valor_cop || 0),
          saldoActual: Math.max(0, Math.round((s.valor_cop || 0) - (s.monto_abonado || 0))),
          cuotasRestantes: 0, ciclos: [ciclo],
          cuota_num_sellada: mm[1] ? parseInt(mm[1], 10) : 1,
          reprog_total_sellada: mm[2] ? parseInt(mm[2], 10) : null,
          estado_sellada: s.estado,
          es_de_tercero: !!s.persona_id, persona_id: s.persona_id || null,
          persona_nombre: s._pnom || null, persona_color: s._pcol || null,
          monto_bolsillo: 0, bolsillo_por_cuota: {}
        });
      });
    }
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
};
