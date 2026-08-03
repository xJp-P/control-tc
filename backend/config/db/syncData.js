// backend/config/db/syncData.js — FASE 4 del arranque: auto-correccion de datos.
//
// Doce pasos numerados que comparten un unico acumulador (`fixes`) y cuyo ORDEN produce
// resultados distintos, asi que se mueven juntos y en bloque. Corre al final de initDb, cuando
// el esquema y las columnas ya estan completos.
const { calcularAmortizacionAvance } = require('../../engine/amortizacion');
const { calcularAmortizacionDiferida } = require('../../engine/amortizacion');
const { nuOptsDif, avanceOpts } = require('../../helpers/banco');
const { primerCorteAvance } = require('../../helpers/dates');
const { liberarBolsilloDiferida, liberarBolsilloAvance } = require('../../helpers/bolsillo');
const { getCortesCustomMap, cicloConCorte, corteDeCiclo } = require('../../helpers/cortes');

// ─── Data Sync / Integrity Check ──────────────────────────────────
function syncData(db) {
  console.log('[Sync] Ejecutando sincronizacion de datos...');
  let fixes = 0;

  // 1. Recalcular valor_cop de compras USD donde falte o sea incorrecto
  const usdFixes = db.prepare(`UPDATE compras SET valor_cop = ROUND(valor_usd * tasa_usd)
    WHERE valor_usd IS NOT NULL AND tasa_usd IS NOT NULL
    AND (valor_cop IS NULL OR valor_cop != ROUND(valor_usd * tasa_usd))
    AND tarjeta_id NOT IN (SELECT id FROM tarjetas WHERE franquicia IN ('Mastercard','American Express'))`).run();
  if (usdFixes.changes > 0) { fixes += usdFixes.changes; console.log('[Sync] Corregidas ' + usdFixes.changes + ' compras USD con valor_cop incorrecto'); }

  // 2. Avances: verificar estado vs saldo real
  const avancesActivos = db.prepare("SELECT * FROM avances WHERE estado='activo'").all();
  avancesActivos.forEach(av => {
    const abonos = db.prepare('SELECT * FROM abonos_avance WHERE avance_id=? ORDER BY fecha').all(av.id);
    const amort = calcularAmortizacionAvance(av.monto, av.tasa_mv, av.plazo, av.fecha_desembolso, av.dia_corte, abonos, av.comision, avanceOpts(db, av.tarjeta_id));
    if (amort.resumen.saldoActual <= 0) {
      db.prepare("UPDATE avances SET estado='liquidado' WHERE id=?").run(av.id);
      fixes++; console.log('[Sync] Avance "' + av.etiqueta + '" marcado como liquidado (saldo=0)');
    }
  });

  // 3. Avances liquidados: verificar que no deberían estar activos
  const avancesLiquidados = db.prepare("SELECT * FROM avances WHERE estado='liquidado'").all();
  avancesLiquidados.forEach(av => {
    const abonos = db.prepare('SELECT * FROM abonos_avance WHERE avance_id=? ORDER BY fecha').all(av.id);
    const amort = calcularAmortizacionAvance(av.monto, av.tasa_mv, av.plazo, av.fecha_desembolso, av.dia_corte, abonos, av.comision, avanceOpts(db, av.tarjeta_id));
    if (amort.resumen.saldoActual > 0) {
      db.prepare("UPDATE avances SET estado='activo' WHERE id=?").run(av.id);
      fixes++; console.log('[Sync] Avance "' + av.etiqueta + '" reactivado (saldo > 0)');
    }
  });

  // 4. Diferidas: liquidar solo cuando todas las cuotas hayan sido pagadas vía
  //    extractos. saldoActual basado en fecha vs hoy NO es suficiente porque
  //    una cuota cuyo corte ya pasó puede estar pendiente de pago en el extracto.
  const diferidasActivas = db.prepare("SELECT * FROM diferidas WHERE estado='activo'").all();
  diferidasActivas.forEach(d => {
    const amort = calcularAmortizacionDiferida(d.monto, d.tasa_mv, d.num_cuotas, d.fecha_compra, d.fecha_primer_corte, null, nuOptsDif(db, d));
    if (amort.resumen.saldoActual > 0) return;
    const ciclos = [...new Set(amort.tabla.map(c => c.fechaCorte.slice(0, 7)))];
    const allPaid = ciclos.every(ciclo => {
      const ext = db.prepare("SELECT estado FROM extractos WHERE tarjeta_id=? AND ciclo=?").get(d.tarjeta_id, ciclo);
      return ext && ext.estado === 'pagado';
    });
    if (allPaid) {
      db.prepare("UPDATE diferidas SET estado='liquidado' WHERE id=?").run(d.id);
      fixes++; console.log('[Sync] Diferida "' + d.etiqueta + '" marcada como liquidada');
    }
  });

  // 5. Compras: recalcular ciclo basado en fecha + dia_corte de la tarjeta (+ corte adelantado).
  const todasComprasSync = db.prepare("SELECT c.id, c.fecha, c.ciclo, c.tarjeta_id, COALESCE(c.ciclo_manual,0) as ciclo_manual, t.dia_corte FROM compras c JOIN tarjetas t ON c.tarjeta_id = t.id").all();
  // Cache de cortes_custom por tarjeta: 1 query por tarjeta (NO por compra). Misma fuente de verdad
  // que calcCiclo (helper compartido cicloConCorte) → syncData NUNCA pisa el desvío por corte.
  const cortesPorTarjeta = {};
  todasComprasSync.forEach(c => {
    if (!c.fecha) return;
    // ciclo_manual=1: el ciclo fue asignado a mano (ej. cuota reprogramada por el banco que
    // se paga en un ciclo distinto al de su fecha real). Prevalece SIEMPRE → NO se recalcula.
    if (c.ciclo_manual) return;
    const diaCorte = c.dia_corte || 30;
    if (!cortesPorTarjeta[c.tarjeta_id]) cortesPorTarjeta[c.tarjeta_id] = getCortesCustomMap(db, c.tarjeta_id);
    // Mismo núcleo que calcCiclo: regla normal por dia_corte (aritmética año/mes directa, evita el
    // desborde 31-may→1-jul) + desvío por corte adelantado. Auto-heal: corrige retroactivamente
    // cualquier compra cuyo ciclo quedó mal (bug previo) o que deba moverse por un corte registrado.
    const cicloCorrect = cicloConCorte(c.fecha, diaCorte, cortesPorTarjeta[c.tarjeta_id]);
    if (c.ciclo !== cicloCorrect) {
      db.prepare("UPDATE compras SET ciclo=? WHERE id=?").run(cicloCorrect, c.id);
      fixes++;
      console.log('[Sync] Compra #' + c.id + ' ciclo corregido: ' + c.ciclo + ' -> ' + cicloCorrect);
    }
  });

  // 6. Compras de extractos pagados: marcar como pagadas según la moneda.
  //    estado='pagado'      → marca compras COP del ciclo (valor_usd vacío o 0).
  //    estado_usd='pagado'  → marca compras USD del ciclo (valor_usd > 0).
  //    Esto permite que pagar la porción COP no cierre las compras USD y viceversa.
  const extsPagadosCop = db.prepare("SELECT tarjeta_id, ciclo FROM extractos WHERE estado='pagado'").all();
  extsPagadosCop.forEach(ext => {
    const fix = db.prepare(`UPDATE compras SET estado='pagado', monto_abonado=valor_cop
      WHERE tarjeta_id=? AND ciclo=? AND estado NOT IN ('pagado','diferida')
        AND (valor_usd IS NULL OR valor_usd = 0)`).run(ext.tarjeta_id, ext.ciclo);
    if (fix.changes > 0) { fixes += fix.changes; console.log('[Sync] ' + fix.changes + ' compras COP de extracto pagado ' + ext.ciclo + ' marcadas como pagadas'); }
  });
  const extsPagadosUsd = db.prepare("SELECT tarjeta_id, ciclo FROM extractos WHERE estado_usd='pagado'").all();
  extsPagadosUsd.forEach(ext => {
    const fix = db.prepare(`UPDATE compras SET estado='pagado', monto_abonado=valor_cop
      WHERE tarjeta_id=? AND ciclo=? AND estado NOT IN ('pagado','diferida')
        AND valor_usd IS NOT NULL AND valor_usd > 0`).run(ext.tarjeta_id, ext.ciclo);
    if (fix.changes > 0) { fixes += fix.changes; console.log('[Sync] ' + fix.changes + ' compras USD de extracto pagado ' + ext.ciclo + ' marcadas como pagadas'); }
  });

  // 6b. Limpieza de bolsillo huérfano SOLO en compras PERSONALES ya pagadas (plata propia apartada
  //     que ya cumplió su fin; el dashboard solo cuenta el bolsillo de compras NO pagadas). NUNCA
  //     toca compras de tercero (persona_id IS NOT NULL): ahí monto_bolsillo es el reembolso del
  //     deudor (lo usan la vista Terceros y la card "Me Deben" como valor_cop - monto_bolsillo) y
  //     debe conservarse. Limpia retroactivamente y en cada arranque (también auto-cura otras DBs).
  const bolsilloPagadoHuerfano = db.prepare(`UPDATE compras SET monto_bolsillo=0, monto_bolsillo_usd=0
    WHERE estado='pagado' AND persona_id IS NULL
      AND (COALESCE(monto_bolsillo,0) > 0 OR COALESCE(monto_bolsillo_usd,0) > 0)`).run();
  if (bolsilloPagadoHuerfano.changes > 0) { fixes += bolsilloPagadoHuerfano.changes; console.log('[Sync] ' + bolsilloPagadoHuerfano.changes + ' compras personales pagadas con bolsillo residual limpiadas'); }

  // 7. Compras vinculadas a diferidas: marcar como 'diferida'
  // AND diferida_id IS NOT NULL: una compra legitimamente diferida SIEMPRE tiene diferida_id poblado
  // (convertir-a-diferida, flujo de creacion, reprogramar-saldo). Sin este guard, una compra de 1 cuota
  // cuyas notas contengan por accidente "Diferida a N cuotas" (ej. sufijo residual o texto del usuario en
  // el campo legado) se re-marcaria 'diferida' SIN plan vinculado -> diferida huerfana cuya deuda
  // desaparece del dashboard. Endurece tambien el camino de revertir-diferida.
  const comprasDiferidas = db.prepare("UPDATE compras SET estado='diferida' WHERE estado NOT IN ('pagado','diferida') AND diferida_id IS NOT NULL AND notas LIKE '%Diferida a%cuotas%'").run();
  if (comprasDiferidas.changes > 0) { fixes += comprasDiferidas.changes; console.log('[Sync] ' + comprasDiferidas.changes + ' compras marcadas como diferidas'); }

  // 8. Compras huérfanas: persona_id que no existe en personas
  const huerfanas = db.prepare(`UPDATE compras SET persona_id = NULL
    WHERE persona_id IS NOT NULL AND persona_id NOT IN (SELECT id FROM personas)`).run();
  if (huerfanas.changes > 0) { fixes += huerfanas.changes; console.log('[Sync] ' + huerfanas.changes + ' compras con persona inexistente corregidas'); }

  // 9. Corregir abono mal distribuido
  const abonosAvance = db.prepare("SELECT aa.*, a.tarjeta_id, a.fecha_desembolso, a.etiqueta FROM abonos_avance aa JOIN avances a ON aa.avance_id = a.id").all();
  abonosAvance.forEach(ab => {
    const pago = db.prepare("SELECT * FROM pagos WHERE tarjeta_id=? AND tipo='abono_capital' AND fecha=?").get(ab.tarjeta_id, ab.fecha);
    if (!pago) return;

    const comprasPagadas = db.prepare("SELECT SUM(COALESCE(monto_abonado,0)) as total FROM compras WHERE tarjeta_id=? AND estado='pagado' AND monto_abonado > 0").all(ab.tarjeta_id);
    const totalComprasPagadas = comprasPagadas[0] ? comprasPagadas[0].total : 0;
    const totalDistribuido = totalComprasPagadas + ab.monto;
    if (Math.abs(totalDistribuido - pago.monto) > 1) return;

    const comprasPendientes = db.prepare("SELECT id, fecha, descripcion, valor_cop, COALESCE(monto_abonado,0) as monto_abonado, estado, created_at FROM compras WHERE tarjeta_id=? AND estado IN ('pendiente','bolsillo','bolsillo_parcial') AND (valor_cop - COALESCE(monto_abonado,0)) > 0").all(ab.tarjeta_id);
    if (comprasPendientes.length === 0) return;

    console.log('[Sync] Redistribuyendo abono a capital: $' + pago.monto + ' - avance tenia $' + ab.monto + ', hay ' + comprasPendientes.length + ' compras pendientes');

    db.prepare('DELETE FROM abonos_avance WHERE id=?').run(ab.id);

    const ciclosPagados = db.prepare("SELECT ciclo FROM extractos WHERE tarjeta_id=? AND estado='pagado'").all(ab.tarjeta_id).map(e => e.ciclo);
    const comprasAbonadas = db.prepare("SELECT * FROM compras WHERE tarjeta_id=? AND estado='pagado' AND monto_abonado > 0").all(ab.tarjeta_id);
    comprasAbonadas.forEach(c => {
      if (ciclosPagados.includes(c.ciclo)) return;
      db.prepare("UPDATE compras SET estado='pendiente', monto_abonado=0 WHERE id=?").run(c.id);
    });

    let restante = pago.monto;
    const detalleNuevo = [];

    // Exención de la reprogramación de saldo: las cuotas SELLADAS (registro histórico facturado) y las
    // diferidas HIJA (sin_gracia_cuota1=1, con bolsillo fijado a propósito) se excluyen de esta
    // redistribución automática — re-pagar una cuota facturada o auto-liberar el bolsillo de la hija en
    // el arranque corrompería lo que la reprogramación acaba de sembrar. El abono MANUAL sí puede
    // afectarlas (lo dispara el usuario). Radio: solo filas de reprogramación; el oldest-first del resto
    // queda intacto.
    // Grupo 1: Compras nacionales
    const comprasNacionales = db.prepare("SELECT id, fecha, descripcion, valor_cop, valor_usd, COALESCE(monto_abonado,0) as monto_abonado, created_at FROM compras WHERE tarjeta_id=? AND estado IN ('pendiente','bolsillo','bolsillo_parcial') AND (valor_cop - COALESCE(monto_abonado,0)) > 0 AND (valor_usd IS NULL OR valor_usd = 0) AND (notas IS NULL OR notas NOT LIKE '%sellada por reprogramacion%') ORDER BY fecha ASC, created_at ASC").all(ab.tarjeta_id);
    for (const c of comprasNacionales) {
      if (restante <= 0) break;
      const saldo = c.valor_cop - c.monto_abonado;
      const aplicar = Math.min(restante, saldo);
      restante -= aplicar;
      if (aplicar >= saldo) {
        db.prepare("UPDATE compras SET estado='pagado', monto_abonado=? WHERE id=?").run(c.monto_abonado + aplicar, c.id);
      } else {
        db.prepare("UPDATE compras SET monto_abonado=? WHERE id=?").run(c.monto_abonado + aplicar, c.id);
      }
      detalleNuevo.push(c.descripcion);
      fixes++;
    }

    // Grupo 2: Compras internacionales
    if (restante > 0) {
      const comprasIntl = db.prepare("SELECT id, fecha, descripcion, valor_cop, COALESCE(monto_abonado,0) as monto_abonado, created_at FROM compras WHERE tarjeta_id=? AND estado IN ('pendiente','bolsillo','bolsillo_parcial') AND (valor_cop - COALESCE(monto_abonado,0)) > 0 AND valor_usd IS NOT NULL AND valor_usd > 0 AND (notas IS NULL OR notas NOT LIKE '%sellada por reprogramacion%') ORDER BY fecha ASC, created_at ASC").all(ab.tarjeta_id);
      for (const c of comprasIntl) {
        if (restante <= 0) break;
        const saldo = c.valor_cop - c.monto_abonado;
        const aplicar = Math.min(restante, saldo);
        restante -= aplicar;
        if (aplicar >= saldo) {
          db.prepare("UPDATE compras SET estado='pagado', monto_abonado=? WHERE id=?").run(c.monto_abonado + aplicar, c.id);
        } else {
          db.prepare("UPDATE compras SET monto_abonado=? WHERE id=?").run(c.monto_abonado + aplicar, c.id);
        }
        detalleNuevo.push(c.descripcion);
        fixes++;
      }
    }

    // Grupo 3: Diferidas
    if (restante > 0) {
      const difs = db.prepare("SELECT * FROM diferidas WHERE tarjeta_id=? AND estado='activo' AND COALESCE(sin_gracia_cuota1,0)=0 ORDER BY fecha_compra ASC, created_at ASC").all(ab.tarjeta_id);
      for (const d of difs) {
        if (restante <= 0) break;
        const abonosDif = db.prepare('SELECT * FROM abonos_diferida WHERE diferida_id=? ORDER BY fecha').all(d.id);
        const amort = calcularAmortizacionDiferida(d.monto, d.tasa_mv, d.num_cuotas, d.fecha_compra, d.fecha_primer_corte, abonosDif, nuOptsDif(db, d));
        const saldo = amort.resumen.saldoActual;
        if (saldo <= 0) continue;
        const aplicar = Math.min(restante, saldo);
        restante -= aplicar;
        db.prepare('INSERT INTO abonos_diferida (diferida_id, fecha, monto, notas) VALUES (?,?,?,?)').run(d.id, ab.fecha, aplicar, 'Abono a capital (redistribuido)');
        liberarBolsilloDiferida(db, d.id);
        detalleNuevo.push(d.etiqueta);
        fixes++;
      }
    }

    // Grupo 4: Avances
    if (restante > 0) {
      const avances = db.prepare("SELECT * FROM avances WHERE tarjeta_id=? AND estado='activo' ORDER BY fecha_desembolso ASC, created_at ASC").all(ab.tarjeta_id);
      for (const av of avances) {
        if (restante <= 0) break;
        const abonos2 = db.prepare('SELECT * FROM abonos_avance WHERE avance_id=? ORDER BY fecha').all(av.id);
        const amort = calcularAmortizacionAvance(av.monto, av.tasa_mv, av.plazo, av.fecha_desembolso, av.dia_corte, abonos2, av.comision, avanceOpts(db, av.tarjeta_id));
        const saldo = amort.resumen.saldoActual;
        if (saldo <= 0) continue;
        const aplicar = Math.min(restante, saldo);
        restante -= aplicar;
        db.prepare('INSERT INTO abonos_avance (avance_id, fecha, monto, notas) VALUES (?,?,?,?)').run(av.id, ab.fecha, aplicar, 'Abono a capital (redistribuido)');
        liberarBolsilloAvance(db, av.id);
        detalleNuevo.push(av.etiqueta);
        fixes++;
      }
    }

    db.prepare("UPDATE pagos SET notas=? WHERE id=?").run('Abono a capital (redistribuido) - ' + detalleNuevo.join(', '), pago.id);
    console.log('[Sync] Redistribucion completada: ' + detalleNuevo.length + ' deudas cubiertas, restante: $' + restante);
  });

  // 10. Verificar orden de abono a capital: si hay compras intl cubiertas pero nacionales sin cubrir
  const pagosAbono = db.prepare("SELECT * FROM pagos WHERE tipo='abono_capital'").all();
  const ciclosPagadosGlobal = db.prepare("SELECT tarjeta_id, ciclo FROM extractos WHERE estado='pagado'").all();
  const esCicloPagado = (tid, ciclo) => ciclosPagadosGlobal.some(e => e.tarjeta_id === tid && e.ciclo === ciclo);
  pagosAbono.forEach(pago => {
    const intlCubiertas = db.prepare("SELECT id, ciclo FROM compras WHERE tarjeta_id=? AND valor_usd IS NOT NULL AND valor_usd > 0 AND monto_abonado > 0 AND estado NOT IN ('diferida')").all(pago.tarjeta_id)
      .filter(c => !esCicloPagado(pago.tarjeta_id, c.ciclo));
    if (intlCubiertas.length === 0) return;

    const nacSinCubrir = db.prepare("SELECT id, ciclo FROM compras WHERE tarjeta_id=? AND (valor_usd IS NULL OR valor_usd = 0) AND estado IN ('pendiente','bolsillo','bolsillo_parcial') AND (valor_cop - COALESCE(monto_abonado,0)) > 0").all(pago.tarjeta_id)
      .filter(c => !esCicloPagado(pago.tarjeta_id, c.ciclo));
    if (nacSinCubrir.length === 0) return;

    console.log('[Sync] Redistribuyendo abono con orden de 4 grupos (intl cubiertas antes que nacionales)');

    const comprasReset = db.prepare("SELECT id, ciclo, estado, monto_abonado, monto_bolsillo FROM compras WHERE tarjeta_id=? AND monto_abonado > 0").all(pago.tarjeta_id);
    comprasReset.forEach(c => {
      if (esCicloPagado(pago.tarjeta_id, c.ciclo)) return;
      let estadoOriginal = 'pendiente';
      if (c.monto_bolsillo && c.monto_bolsillo > 0) {
        const compraFull = db.prepare('SELECT valor_cop FROM compras WHERE id=?').get(c.id);
        estadoOriginal = c.monto_bolsillo >= compraFull.valor_cop ? 'bolsillo' : 'bolsillo_parcial';
      }
      db.prepare("UPDATE compras SET estado=?, monto_abonado=0 WHERE id=? AND estado != 'diferida'").run(estadoOriginal, c.id);
    });

    const avances = db.prepare("SELECT id FROM avances WHERE tarjeta_id=?").all(pago.tarjeta_id);
    avances.forEach(av => { db.prepare("DELETE FROM abonos_avance WHERE avance_id=? AND fecha=?").run(av.id, pago.fecha); });
    const diferidas = db.prepare("SELECT id FROM diferidas WHERE tarjeta_id=?").all(pago.tarjeta_id);
    diferidas.forEach(d => { db.prepare("DELETE FROM abonos_diferida WHERE diferida_id=? AND fecha=?").run(d.id, pago.fecha); });

    let restante = pago.monto;
    const detalleNuevo = [];

    // Grupo 1: Nacionales. (Excluye cuotas SELLADAS y, en Grupo 3, las diferidas HIJA de reprogramación
    // —sin_gracia_cuota1=1—: no re-pagar una cuota facturada ni auto-liberar el bolsillo de la hija al
    // arrancar. El abono MANUAL sí puede afectarlas. Radio: solo filas de reprogramación.)
    const comprasNac = db.prepare("SELECT id, fecha, descripcion, valor_cop, COALESCE(monto_abonado,0) as monto_abonado, persona_id, created_at FROM compras WHERE tarjeta_id=? AND estado IN ('pendiente','bolsillo','bolsillo_parcial') AND (valor_cop - COALESCE(monto_abonado,0)) > 0 AND (valor_usd IS NULL OR valor_usd = 0) AND (notas IS NULL OR notas NOT LIKE '%sellada por reprogramacion%') ORDER BY fecha ASC, created_at ASC").all(pago.tarjeta_id);
    for (const c of comprasNac) {
      if (restante <= 0) break;
      const saldo = c.valor_cop - c.monto_abonado;
      const aplicar = Math.min(restante, saldo);
      restante -= aplicar;
      if (aplicar >= saldo) {
        db.prepare("UPDATE compras SET estado='pagado', monto_abonado=? WHERE id=?").run(c.monto_abonado + aplicar, c.id);
      } else {
        db.prepare("UPDATE compras SET monto_abonado=? WHERE id=?").run(c.monto_abonado + aplicar, c.id);
      }
      detalleNuevo.push(c.descripcion);
      fixes++;
    }

    // Grupo 2: Internacionales
    if (restante > 0) {
      const comprasIntl = db.prepare("SELECT id, fecha, descripcion, valor_cop, COALESCE(monto_abonado,0) as monto_abonado, created_at FROM compras WHERE tarjeta_id=? AND estado IN ('pendiente','bolsillo','bolsillo_parcial') AND (valor_cop - COALESCE(monto_abonado,0)) > 0 AND valor_usd IS NOT NULL AND valor_usd > 0 AND (notas IS NULL OR notas NOT LIKE '%sellada por reprogramacion%') ORDER BY fecha ASC, created_at ASC").all(pago.tarjeta_id);
      for (const c of comprasIntl) {
        if (restante <= 0) break;
        const saldo = c.valor_cop - c.monto_abonado;
        const aplicar = Math.min(restante, saldo);
        restante -= aplicar;
        if (aplicar >= saldo) {
          db.prepare("UPDATE compras SET estado='pagado', monto_abonado=? WHERE id=?").run(c.monto_abonado + aplicar, c.id);
        } else {
          db.prepare("UPDATE compras SET monto_abonado=? WHERE id=?").run(c.monto_abonado + aplicar, c.id);
        }
        detalleNuevo.push(c.descripcion);
        fixes++;
      }
    }

    // Grupo 3: Diferidas
    if (restante > 0) {
      const difs = db.prepare("SELECT * FROM diferidas WHERE tarjeta_id=? AND estado='activo' AND COALESCE(sin_gracia_cuota1,0)=0 ORDER BY fecha_compra ASC").all(pago.tarjeta_id);
      for (const d of difs) {
        if (restante <= 0) break;
        const abonosDif = db.prepare('SELECT * FROM abonos_diferida WHERE diferida_id=? ORDER BY fecha').all(d.id);
        const amort = calcularAmortizacionDiferida(d.monto, d.tasa_mv, d.num_cuotas, d.fecha_compra, d.fecha_primer_corte, abonosDif, nuOptsDif(db, d));
        const saldo = amort.resumen.saldoActual;
        if (saldo <= 0) continue;
        const aplicar = Math.min(restante, saldo);
        restante -= aplicar;
        db.prepare('INSERT INTO abonos_diferida (diferida_id, fecha, monto, notas) VALUES (?,?,?,?)').run(d.id, pago.fecha, aplicar, 'Abono a capital (redistribuido)');
        liberarBolsilloDiferida(db, d.id);
        detalleNuevo.push(d.etiqueta);
        fixes++;
      }
    }

    // Grupo 4: Avances
    if (restante > 0) {
      const avs = db.prepare("SELECT * FROM avances WHERE tarjeta_id=? AND estado='activo' ORDER BY fecha_desembolso ASC").all(pago.tarjeta_id);
      for (const av of avs) {
        if (restante <= 0) break;
        const abonos2 = db.prepare('SELECT * FROM abonos_avance WHERE avance_id=? ORDER BY fecha').all(av.id);
        const amort = calcularAmortizacionAvance(av.monto, av.tasa_mv, av.plazo, av.fecha_desembolso, av.dia_corte, abonos2, av.comision, avanceOpts(db, av.tarjeta_id));
        const saldo = amort.resumen.saldoActual;
        if (saldo <= 0) continue;
        const aplicar = Math.min(restante, saldo);
        restante -= aplicar;
        db.prepare('INSERT INTO abonos_avance (avance_id, fecha, monto, notas) VALUES (?,?,?,?)').run(av.id, pago.fecha, aplicar, 'Abono a capital (redistribuido)');
        liberarBolsilloAvance(db, av.id);
        detalleNuevo.push(av.etiqueta);
        fixes++;
      }
    }

    db.prepare("UPDATE pagos SET notas=? WHERE id=?").run('Abono a capital (redistribuido) - ' + detalleNuevo.join(', '), pago.id);
    console.log('[Sync] Redistribucion 4-grupos completada: ' + detalleNuevo.length + ' deudas, restante: $' + restante);
  });

  // 11. Auto-heal: compras a cuotas con su diferida desincronizada (fecha o tarjeta).
  //     Bug histórico: antes de v2.8.1, editar la fecha o tarjeta de una compra
  //     no actualizaba la diferida vinculada → la amortización quedaba calculada
  //     desde la fecha vieja y las cuotas caían en meses equivocados.
  //     Este paso detecta y realinea cualquier desincronización existente.
  const desyncedRows = db.prepare(`
    SELECT c.id as compra_id, c.descripcion, c.fecha as compra_fecha, c.tarjeta_id as compra_tarjeta_id,
           c.ciclo as compra_ciclo, COALESCE(c.ciclo_manual,0) as compra_ciclo_manual,
           d.id as dif_id, d.fecha_compra as dif_fecha, d.tarjeta_id as dif_tarjeta_id,
           t.dia_corte
    FROM compras c
    JOIN diferidas d ON c.diferida_id = d.id
    JOIN tarjetas t ON c.tarjeta_id = t.id
    WHERE (c.fecha != d.fecha_compra OR c.tarjeta_id != d.tarjeta_id)
      -- Excepcion: una diferida HIJA de reprogramacion de saldo (sin_gracia_cuota1=1) tiene su
      -- fecha_compra fijada a proposito ~30 dias antes del corte del vigente (corte(V-1)) para que su
      -- cuota 1 cobre ~1 mes de interes, NO la fecha real de la compra. Re-alinearla aqui reinflaria
      -- ese interes cada arranque. Su fecha_primer_corte ya es correcto y no depende de este paso.
      AND COALESCE(d.sin_gracia_cuota1,0) = 0
  `).all();
  desyncedRows.forEach(row => {
    const diaCorte = row.dia_corte || 30;
    // Con ciclo_manual (spillover / canje retrasado), el primer corte de la diferida sigue el ciclo
    // FIJADO de la compra (corteDeCiclo), no el corte natural de la fecha — mantiene las cuotas alineadas
    // con el ciclo de la compra (también auto-sana un desvío que se hubiera roto por un edit previo).
    const nuevaFechaPrimerCorte = row.compra_ciclo_manual ? corteDeCiclo(row.compra_ciclo, diaCorte) : primerCorteAvance(row.compra_fecha, diaCorte);
    db.prepare('UPDATE diferidas SET tarjeta_id=?, fecha_compra=?, fecha_primer_corte=? WHERE id=?')
      .run(row.compra_tarjeta_id, row.compra_fecha, nuevaFechaPrimerCorte, row.dif_id);
    fixes++;
    console.log('[Sync] Diferida #' + row.dif_id + ' (' + row.descripcion + ') resincronizada con compra #' + row.compra_id + ': fecha ' + row.dif_fecha + ' → ' + row.compra_fecha + ', primer corte → ' + nuevaFechaPrimerCorte);
  });

  console.log('[Sync] Sincronizacion completada. ' + fixes + ' correcciones aplicadas.');
  return fixes;
}

module.exports = { syncData };
