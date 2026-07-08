// backend/config/db.js — Database path resolution, schema creation, migrations, and syncData

const path = require('path');
const fs = require('fs');
const { calcularAmortizacionAvance } = require('../engine/amortizacion');
const { calcularAmortizacionDiferida } = require('../engine/amortizacion');
const { esNuBank, nuOpts, nuOptsDif, avanceOpts } = require('../helpers/banco');
const { primerCorteAvance } = require('../helpers/dates');
const { liberarBolsilloDiferida, liberarBolsilloAvance } = require('../helpers/bolsillo');
const { getCortesCustomMap, cicloConCorte, corteDeCiclo } = require('../helpers/cortes');

const DEFAULT_DB_DIR = path.join(require('os').homedir(), 'AppData', 'Roaming', 'CreditCardManager');
const DB_CONFIG_FILE = path.join(DEFAULT_DB_DIR, 'db_location.json');

function getDbPath() {
  try {
    if (fs.existsSync(DB_CONFIG_FILE)) {
      const config = JSON.parse(fs.readFileSync(DB_CONFIG_FILE, 'utf8'));
      if (config.dbPath && fs.existsSync(config.dbPath)) {
        return config.dbPath;
      }
    }
  } catch (e) { /* fallback to default */ }
  return path.join(DEFAULT_DB_DIR, 'data.db');
}

function getDbConfigPath() {
  return DB_CONFIG_FILE;
}

function ensureDir(filePath) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
}

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

// ─── Database initialization: schema + migrations ─────────────────
function initDb(dbPathOverride) {
  const Database = require('better-sqlite3');
  const dbPath = dbPathOverride || getDbPath();
  ensureDir(dbPath);
  const db = new Database(dbPath);

  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS tarjetas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      banco TEXT,
      dia_corte INTEGER DEFAULT 30,
      dia_pago INTEGER DEFAULT 16,
      color TEXT DEFAULT '#4f8cff',
      imagen TEXT,
      tasa_mv_avances REAL DEFAULT 0.01911,
      tasa_mv_diferidas REAL DEFAULT 0.0188,
      url_tasas TEXT,
      cupo_total REAL DEFAULT 0,
      estado TEXT DEFAULT 'activa',
      notas TEXT,
      franquicia TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS personas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      color TEXT DEFAULT '#666',
      orden INTEGER DEFAULT 0,
      telefono TEXT,
      notas TEXT
    );

    CREATE TABLE IF NOT EXISTS compras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tarjeta_id INTEGER REFERENCES tarjetas(id),
      fecha TEXT NOT NULL,
      descripcion TEXT NOT NULL,
      valor_cop REAL NOT NULL,
      valor_usd REAL,
      persona_id INTEGER REFERENCES personas(id),
      estado TEXT DEFAULT 'pendiente',
      ciclo TEXT NOT NULL,
      notas TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS avances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tarjeta_id INTEGER REFERENCES tarjetas(id),
      etiqueta TEXT NOT NULL,
      monto REAL NOT NULL,
      tasa_mv REAL NOT NULL,
      plazo INTEGER NOT NULL DEFAULT 24,
      fecha_desembolso TEXT NOT NULL,
      dia_corte INTEGER NOT NULL DEFAULT 30,
      estado TEXT DEFAULT 'activo',
      notas TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS abonos_avance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      avance_id INTEGER NOT NULL REFERENCES avances(id) ON DELETE CASCADE,
      fecha TEXT NOT NULL,
      monto REAL NOT NULL,
      notas TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS diferidas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tarjeta_id INTEGER REFERENCES tarjetas(id),
      etiqueta TEXT NOT NULL,
      monto REAL NOT NULL,
      tasa_mv REAL NOT NULL,
      num_cuotas INTEGER NOT NULL,
      fecha_compra TEXT NOT NULL,
      fecha_primer_corte TEXT NOT NULL,
      estado TEXT DEFAULT 'activo',
      notas TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS abonos_diferida (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      diferida_id INTEGER NOT NULL REFERENCES diferidas(id) ON DELETE CASCADE,
      fecha TEXT NOT NULL,
      monto REAL NOT NULL,
      notas TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS pagos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tarjeta_id INTEGER REFERENCES tarjetas(id),
      fecha TEXT NOT NULL,
      monto REAL NOT NULL,
      tipo TEXT DEFAULT 'pago_total',
      ciclo TEXT,
      notas TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS extractos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tarjeta_id INTEGER REFERENCES tarjetas(id),
      ciclo TEXT NOT NULL,
      fecha_corte TEXT NOT NULL,
      fecha_pago TEXT NOT NULL,
      pago_minimo REAL DEFAULT 0,
      pago_total REAL DEFAULT 0,
      monto_pagado REAL DEFAULT 0,
      estado TEXT DEFAULT 'pendiente',
      fecha_pagado TEXT,
      notas TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(tarjeta_id, ciclo)
    );

    CREATE TABLE IF NOT EXISTS bolsillo_cuotas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      compra_id INTEGER NOT NULL REFERENCES compras(id) ON DELETE CASCADE,
      cuota_num INTEGER NOT NULL,
      monto REAL NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(compra_id, cuota_num)
    );

    CREATE TABLE IF NOT EXISTS bolsillo_cuotas_avance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      avance_id INTEGER NOT NULL REFERENCES avances(id) ON DELETE CASCADE,
      cuota_num INTEGER NOT NULL,
      monto REAL NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(avance_id, cuota_num)
    );

    CREATE TABLE IF NOT EXISTS fechas_pago_custom (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tarjeta_id INTEGER NOT NULL REFERENCES tarjetas(id) ON DELETE CASCADE,
      ciclo TEXT NOT NULL,
      fecha_pago TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(tarjeta_id, ciclo)
    );

    CREATE TABLE IF NOT EXISTS cortes_custom (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tarjeta_id INTEGER NOT NULL REFERENCES tarjetas(id) ON DELETE CASCADE,
      ciclo TEXT NOT NULL,
      fecha_corte TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(tarjeta_id, ciclo)
    );

    -- Saldo a Favor de terceros (Fase 2 — reversos). Crédito flotante que nace al reversar una compra
    -- de tercero que YA había reembolsado: esa plata queda a favor del tercero. Es por-PERSONA (su
    -- plata, sin importar la tarjeta). disponible = monto - monto_aplicado (derivado, no se persiste).
    CREATE TABLE IF NOT EXISTS saldos_favor_tercero (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      persona_id INTEGER NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
      monto REAL NOT NULL,
      monto_aplicado REAL NOT NULL DEFAULT 0,
      origen_tipo TEXT NOT NULL DEFAULT 'reverso',
      origen_compra_id INTEGER REFERENCES compras(id) ON DELETE SET NULL,
      tarjeta_id INTEGER REFERENCES tarjetas(id) ON DELETE SET NULL,
      descripcion TEXT,
      fecha TEXT NOT NULL,
      estado TEXT NOT NULL DEFAULT 'activo',
      notas TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- Ledger de "cruce de cuentas": a qué deuda del MISMO tercero (o a un cashout, con destino NULL) se
    -- adjudicó cada crédito. Permite auditar y DESHACER una aplicación. Espejo de abonos_diferida.
    CREATE TABLE IF NOT EXISTS aplicaciones_saldo_favor (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      saldo_favor_id INTEGER NOT NULL REFERENCES saldos_favor_tercero(id) ON DELETE CASCADE,
      compra_destino_id INTEGER REFERENCES compras(id) ON DELETE SET NULL,
      tipo TEXT NOT NULL DEFAULT 'cruce',
      monto REAL NOT NULL,
      fecha TEXT NOT NULL,
      notas TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- ─── MOTOR ROTATIVO (Libro Mayor de deuda) ─────────────────────────────────
    -- Un renglón por extracto (cierre mensual). Es la "masa que rueda": la deuda ya no se
    -- deriva sumando filas pendientes de UN ciclo, sino que hereda el saldo del cierre previo.
    -- Identidad de rotación: deuda_corte(N) = saldo_anterior(N) + compras + avances + otros +
    -- int_corriente - pagos ; y saldo_anterior(N+1) = deuda_corte(N). (Ver CLAUDE.md "Arquitectura
    -- Futura: Motor Rotativo".) NO alimenta la UI todavía (Fase 1 = infra + motor core).
    CREATE TABLE IF NOT EXISTS cierres_mensuales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tarjeta_id INTEGER NOT NULL REFERENCES tarjetas(id) ON DELETE CASCADE,
      ciclo TEXT NOT NULL,
      fecha_corte TEXT,
      saldo_anterior REAL NOT NULL DEFAULT 0,
      compras_mes REAL NOT NULL DEFAULT 0,
      avances_mes REAL NOT NULL DEFAULT 0,
      otros_cargos REAL NOT NULL DEFAULT 0,
      int_corriente REAL NOT NULL DEFAULT 0,
      int_mora REAL NOT NULL DEFAULT 0,
      pagos_abonos REAL NOT NULL DEFAULT 0,
      deuda_corte REAL NOT NULL DEFAULT 0,
      pago_minimo REAL NOT NULL DEFAULT 0,
      cuota_transacciones REAL NOT NULL DEFAULT 0,
      cuota_avances REAL NOT NULL DEFAULT 0,
      estado TEXT NOT NULL DEFAULT 'pendiente',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(tarjeta_id, ciclo)
    );

    -- Pagos GLOBALES a la tarjeta (abonos "a la tarjeta", no a una compra específica). La cascada
    -- de pagos (waterfall) los reparte: mora -> int_corriente -> otros -> cuotas -> prepago capital.
    CREATE TABLE IF NOT EXISTS pagos_tarjeta (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tarjeta_id INTEGER NOT NULL REFERENCES tarjetas(id) ON DELETE CASCADE,
      fecha TEXT NOT NULL,
      monto REAL NOT NULL,
      ciclo TEXT,
      tipo TEXT NOT NULL DEFAULT 'pago_extracto',
      notas TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS historial (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      accion TEXT NOT NULL,
      descripcion TEXT NOT NULL,
      detalles TEXT,
      fecha TEXT DEFAULT (datetime('now','localtime'))
    );
  `);

  // ─── Migrations ──────────────────────────────────────────────────
  const migrate = (table) => {
    try {
      db.prepare(`SELECT tarjeta_id FROM ${table} LIMIT 1`).get();
    } catch (e) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN tarjeta_id INTEGER REFERENCES tarjetas(id)`);
    }
  };
  migrate('compras');
  migrate('avances');
  migrate('diferidas');
  migrate('pagos');

  try { db.prepare('SELECT imagen FROM tarjetas LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE tarjetas ADD COLUMN imagen TEXT'); }

  try { db.prepare('SELECT dia_pago FROM tarjetas LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE tarjetas ADD COLUMN dia_pago INTEGER DEFAULT 16'); }

  try { db.prepare('SELECT tasa_usd FROM compras LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE compras ADD COLUMN tasa_usd REAL'); }

  db.prepare(`UPDATE compras SET valor_cop = ROUND(valor_usd * tasa_usd)
    WHERE valor_usd IS NOT NULL AND tasa_usd IS NOT NULL AND valor_cop != ROUND(valor_usd * tasa_usd)
    AND tarjeta_id NOT IN (SELECT id FROM tarjetas WHERE franquicia IN ('Mastercard','American Express'))`).run();

  db.prepare(`UPDATE compras SET valor_cop = 0
    WHERE valor_usd IS NOT NULL AND valor_usd > 0 AND valor_cop > 0
    AND tarjeta_id IN (SELECT id FROM tarjetas WHERE franquicia IN ('Mastercard','American Express'))`).run();

  db.prepare(`UPDATE compras SET estado = 'bolsillo' WHERE estado = 'en_bolsillo'`).run();
  db.prepare(`UPDATE compras SET estado = 'bolsillo_parcial' WHERE estado = 'en_bolsillo_parcial'`).run();

  try { db.prepare('SELECT monto_abonado FROM compras LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE compras ADD COLUMN monto_abonado REAL DEFAULT 0'); }

  try { db.prepare('SELECT tercero_pagado FROM compras LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE compras ADD COLUMN tercero_pagado INTEGER DEFAULT 0'); }

  try { db.prepare('SELECT tercero_monto_abonado FROM compras LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE compras ADD COLUMN tercero_monto_abonado INTEGER DEFAULT 0'); }

  try { db.prepare('SELECT diferida_id FROM compras LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE compras ADD COLUMN diferida_id INTEGER REFERENCES diferidas(id)'); }

  try { db.prepare('SELECT franquicia FROM tarjetas LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE tarjetas ADD COLUMN franquicia TEXT'); }

  // difiere_intereses_cuota1: solo aplica a tarjetas Bancolombia.
  // NULL = no configurado (el frontend obliga a configurarlo)
  // 0    = no difiere (cada cuota cobra su propio interés)
  // 1    = sí difiere (cuota 1 acumula, cuota 2 cobra interés_1 + interés_2)
  try { db.prepare('SELECT difiere_intereses_cuota1 FROM tarjetas LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE tarjetas ADD COLUMN difiere_intereses_cuota1 INTEGER'); }

  // orden: posición manual de la tarjeta en listados. NULL = sin orden definido (cae al final).
  // El backfill asigna 1, 2, 3, ... a las tarjetas existentes según created_at.
  let nuevaColumnaOrden = false;
  try { db.prepare('SELECT orden FROM tarjetas LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE tarjetas ADD COLUMN orden INTEGER'); nuevaColumnaOrden = true; }
  // Backfill solo la primera vez (o si quedan tarjetas con orden NULL).
  const sinOrden = db.prepare('SELECT COUNT(*) as n FROM tarjetas WHERE orden IS NULL').get();
  if (sinOrden && sinOrden.n > 0) {
    const tarjetasParaOrdenar = db.prepare('SELECT id FROM tarjetas WHERE orden IS NULL ORDER BY created_at ASC').all();
    const maxActual = db.prepare('SELECT COALESCE(MAX(orden), 0) as max FROM tarjetas WHERE orden IS NOT NULL').get();
    let siguiente = (maxActual ? maxActual.max : 0) + 1;
    tarjetasParaOrdenar.forEach(t => {
      db.prepare('UPDATE tarjetas SET orden=? WHERE id=?').run(siguiente, t.id);
      siguiente++;
    });
    if (nuevaColumnaOrden) console.log('[Migration] Columna `orden` agregada y backfill aplicado a ' + tarjetasParaOrdenar.length + ' tarjetas.');
  }

  try { db.prepare('SELECT monto_bolsillo FROM compras LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE compras ADD COLUMN monto_bolsillo REAL DEFAULT 0'); }

  try { db.prepare('SELECT grupo_id FROM compras LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE compras ADD COLUMN grupo_id TEXT'); }

  // Flag: compra internacional (genera intereses corrientes aunque no tenga valor_usd)
  // Útil para procesadores como Rappi/Apple/MercadoPago que cobran en COP pero el banco
  // las clasifica como internacionales y les cobra tasa MV.
  try { db.prepare('SELECT es_internacional FROM compras LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE compras ADD COLUMN es_internacional INTEGER DEFAULT 0'); }

  // Flag: ciclo asignado manualmente. Cuando es 1, el ciclo de la compra NO se deriva de la
  // fecha ni lo recalcula syncData (paso 5). Sirve para cuotas reprogramadas por el banco que
  // se pagan en un ciclo distinto al de su fecha real (la compra conserva su fecha real para
  // ordenar/mostrar, pero pertenece al ciclo que se le asigne).
  try { db.prepare('SELECT ciclo_manual FROM compras LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE compras ADD COLUMN ciclo_manual INTEGER DEFAULT 0'); }

  // nota_personal: nota privada del usuario (ej. "iCloud") separada del nombre OFICIAL del extracto
  // (columna descripcion). El nombre oficial es el que se cruza con el extracto del banco; la nota
  // es solo display/contexto (se muestra bajo el nombre en las tablas y se envía a la IA como tal).
  try { db.prepare('SELECT nota_personal FROM compras LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE compras ADD COLUMN nota_personal TEXT'); }

  // tasa_intl: tasa de interés mensual CONGELADA por compra internacional (snapshot histórico). El
  // banco fija la tasa al facturar y NO la cambia retroactivamente; la tasa global de la tarjeta sí
  // fluctúa. Si tasa_intl está seteada, el interés intl de esa compra se calcula con ELLA (no con la
  // global) → el histórico no se reescribe al cambiar la tasa. NULL = no capturada → usa la global
  // actual (fallback). La fija el usuario (CompraForm), el cierre de extracto (piso) o la IA (futuro).
  try { db.prepare('SELECT tasa_intl FROM compras LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE compras ADD COLUMN tasa_intl REAL'); }

  // reversada=1: el banco reversó (devolvió) esta compra. Se neutraliza como deuda
  // (estado='pagado', monto_abonado=valor_cop) SIN borrar valor_cop; si un tercero ya la había
  // reembolsado, se genera un Saldo a Favor a su nombre. Marca para idempotencia + badge "Reversada".
  try { db.prepare('SELECT reversada FROM compras LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE compras ADD COLUMN reversada INTEGER DEFAULT 0'); }
  // Backfill: marca reversada=1 las compras que ya tienen un Saldo a Favor de origen 'reverso'
  // (ej. el crédito LATAM sembrado antes de existir la columna) → idempotencia del botón Reversar.
  try {
    db.exec("UPDATE compras SET reversada=1 WHERE COALESCE(reversada,0)=0 AND id IN " +
            "(SELECT origen_compra_id FROM saldos_favor_tercero WHERE origen_tipo='reverso' AND origen_compra_id IS NOT NULL)");
  } catch (e) {}

  // Retroactively assign grupo_id to existing split compras
  (() => {
    const splitGroups = db.prepare(`
      SELECT fecha, descripcion, tarjeta_id, COALESCE(diferida_id, -1) as dif_id, GROUP_CONCAT(id) as ids
      FROM compras
      WHERE grupo_id IS NULL
      GROUP BY fecha, descripcion, tarjeta_id, COALESCE(diferida_id, -1)
      HAVING COUNT(*) > 1 AND SUM(CASE WHEN persona_id IS NOT NULL THEN 1 ELSE 0 END) > 0
    `).all();
    splitGroups.forEach(g => {
      const grupoId = 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
      g.ids.split(',').forEach(id => {
        db.prepare('UPDATE compras SET grupo_id=? WHERE id=?').run(grupoId, parseInt(id));
      });
    });
  })();

  try { db.prepare('SELECT comision FROM avances LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE avances ADD COLUMN comision REAL DEFAULT 0'); }

  try { db.prepare('SELECT monto_bolsillo FROM avances LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE avances ADD COLUMN monto_bolsillo REAL DEFAULT 0'); }

  try { db.prepare('SELECT monto_bolsillo FROM diferidas LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE diferidas ADD COLUMN monto_bolsillo REAL DEFAULT 0'); }

  // sin_gracia_cuota1=1: diferida nacida de una REPROGRAMACIÓN DE SALDO (endpoint
  // /compras/:id/reprogramar-saldo). Su cuota 1 NO recibe la "gracia" de cuota 1 (Nu = cuota sin
  // interés; Bancolombia difiere_intereses_cuota1 = interés diferido a la cuota 2), porque el banco
  // NO re-otorga esa gracia sobre un saldo ya en curso — solo la da a compras nuevas. El helper
  // nuOptsDif(db, dif) lo respeta al amortizar. DEFAULT 0 → toda diferida existente conserva su
  // comportamiento (la gracia por-tarjeta vía nuOpts), sin regresión.
  try { db.prepare('SELECT sin_gracia_cuota1 FROM diferidas LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE diferidas ADD COLUMN sin_gracia_cuota1 INTEGER DEFAULT 0'); }

  // Intereses sobre compras internacionales: se persiste al cerrar el extracto
  // para que el historial mantenga el valor real cobrado por el banco aunque la
  // tasa o las compras cambien después.
  try { db.prepare('SELECT intereses_intl FROM extractos LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE extractos ADD COLUMN intereses_intl REAL DEFAULT 0'); }

  // Pago mínimo y pago total en USD del extracto (solo tarjetas con extracto dual:
  // Mastercard / Amex Bancolombia). Para tarjetas no-duales (ej. Visa) quedan en 0.
  // Permite mostrar la card "Pago Mínimo USD" y "Deuda USD" en el dashboard al
  // navegar ciclos históricos donde todas las compras ya están pagadas.
  try { db.prepare('SELECT pago_minimo_usd FROM extractos LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE extractos ADD COLUMN pago_minimo_usd REAL DEFAULT 0'); }
  try { db.prepare('SELECT pago_total_usd FROM extractos LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE extractos ADD COLUMN pago_total_usd REAL DEFAULT 0'); }

  // Pago en USD por separado del extracto (Mastercard / Amex Bancolombia):
  // permite saldar la porción COP y la USD de forma independiente dentro del
  // mismo ciclo. Para tarjetas no-duales, `estado_usd='no_aplica'`.
  //   estado_usd: 'pendiente' | 'pagado' | 'no_aplica'
  try { db.prepare('SELECT monto_pagado_usd FROM extractos LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE extractos ADD COLUMN monto_pagado_usd REAL DEFAULT 0'); }
  try { db.prepare('SELECT estado_usd FROM extractos LIMIT 1').get(); }
  catch (e) { db.exec("ALTER TABLE extractos ADD COLUMN estado_usd TEXT DEFAULT 'pendiente'"); }
  try { db.prepare('SELECT fecha_pagado_usd FROM extractos LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE extractos ADD COLUMN fecha_pagado_usd TEXT'); }

  // Backfill de estado_usd: ejecutar siempre que haya filas con estado_usd default
  // y datos USD coherentes (idempotente).
  //  - Si la fila no tiene saldo USD (pagoMinimoUsd y pagoTotalUsd en 0) → 'no_aplica'.
  //  - Si la fila estaba 'pagado' (COP) y tiene saldo USD, asumimos que la porción
  //    USD también se saldó al cerrar el extracto históricamente.
  db.prepare(`UPDATE extractos SET estado_usd='no_aplica'
    WHERE estado_usd='pendiente' AND COALESCE(pago_minimo_usd,0) <= 0 AND COALESCE(pago_total_usd,0) <= 0`).run();
  db.prepare(`UPDATE extractos SET estado_usd='pagado',
    monto_pagado_usd = COALESCE(NULLIF(monto_pagado_usd,0), pago_minimo_usd),
    fecha_pagado_usd = COALESCE(fecha_pagado_usd, fecha_pagado)
    WHERE estado_usd='pendiente' AND estado='pagado' AND COALESCE(pago_minimo_usd,0) > 0`).run();

  // Pagos: agregar columna moneda para distinguir entre pagos en COP y USD.
  // Default 'COP' para compatibilidad con todo lo que ya existe.
  try { db.prepare('SELECT moneda FROM pagos LIMIT 1').get(); }
  catch (e) { db.exec("ALTER TABLE pagos ADD COLUMN moneda TEXT DEFAULT 'COP'"); }

  // Bolsillo en USD: caché en compras + moneda en la tabla per-cuota.
  // Solo aplica a compras Mastercard/Amex con valor_usd > 0 (valor_cop = 0).
  // Para Visa, RappiCard, Nu: monto_bolsillo_usd siempre 0.
  try { db.prepare('SELECT monto_bolsillo_usd FROM compras LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE compras ADD COLUMN monto_bolsillo_usd REAL DEFAULT 0'); }
  try { db.prepare('SELECT moneda FROM bolsillo_cuotas LIMIT 1').get(); }
  catch (e) { db.exec("ALTER TABLE bolsillo_cuotas ADD COLUMN moneda TEXT DEFAULT 'COP'"); }

  // Redondear monto_bolsillo con decimales (fix comparacion cuotaCorte redondeada vs bolsillo decimal)
  db.prepare('UPDATE compras SET monto_bolsillo = ROUND(monto_bolsillo) WHERE monto_bolsillo != ROUND(monto_bolsillo)').run();
  db.prepare('UPDATE avances SET monto_bolsillo = ROUND(monto_bolsillo) WHERE monto_bolsillo != ROUND(monto_bolsillo)').run();
  db.prepare('UPDATE diferidas SET monto_bolsillo = ROUND(monto_bolsillo) WHERE monto_bolsillo IS NOT NULL AND monto_bolsillo != ROUND(monto_bolsillo)').run();

  // Migración de DATOS del estado legacy 'por_cobrar' → 'pagado'. El ESQUEMA de bolsillo_cuotas,
  // bolsillo_cuotas_avance, fechas_pago_custom, cortes_custom e historial ya se creó al INICIO de
  // initDb (antes de las migraciones), para tolerar BDs de versiones viejas que no tenían esas tablas.
  db.prepare("UPDATE compras SET tercero_pagado = 0 WHERE estado = 'por_cobrar' AND persona_id IS NOT NULL").run();
  db.prepare("UPDATE compras SET estado = 'pagado' WHERE estado = 'por_cobrar'").run();

  // Limpieza de la tabla 'log' legacy (reemplazada por 'historial', creada arriba).
  try { db.exec('DROP TABLE IF EXISTS log'); } catch (e) {}

  // Run sync
  syncData(db);

  const insertConfig = db.prepare('INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)');
  insertConfig.run('theme', 'dark');
  // TRM (Tasa Representativa del Mercado) USD→COP. Solo se usa para estimar el
  // cupo usado de tarjetas duales (la deuda USD se convierte a COP equivalentes
  // para calcular el % de cupo). El usuario puede actualizarla via SQL o futura UI.
  // Default ~4200 COP/USD (rango típico Colombia 2024-2026).
  insertConfig.run('trm_usd_cop', '4200');

  return db;
}

module.exports = { DEFAULT_DB_DIR, getDbPath, getDbConfigPath, ensureDir, initDb, syncData };
