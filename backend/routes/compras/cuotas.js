'use strict';
// backend/routes/compras/cuotas.js
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

  // ── Convertir compra de 1 cuota → diferida a N cuotas (in-place) ──────────
  // POST /:id/convertir-a-diferida  Body: { num_cuotas, cobrar_intereses }
  // La fila de `compras` NUNCA se borra ni recrea: conserva id, fecha y created_at originales
  // (la prelación de abonos del banco depende del orden cronológico real de las transacciones).
  // La conversión crea la diferida vinculada (mismos campos que el flujo de creación), traslada el
  // bolsillo ya apartado al per-cuota (secuencial desde la cuota 1, sin perder un peso) y muta
  // estado/diferida_id/notas. Transaccional: o todo o nada.
  // Alcance v1: solo compras COP individuales de 1 cuota; quedan fuera (bloqueadas) las partes de
  // grupo, USD, con abono parcial y terceros con reembolsos (mismo guard que reprogramar/dividir).
  router.post('/:id/convertir-a-diferida', (req, res) => {
    const { num_cuotas, cobrar_intereses } = req.body || {};
    const n = parseInt(num_cuotas, 10);
    if (!n || n < 2 || n > 60) return res.status(400).json({ error: 'El número de cuotas debe ser un entero entre 2 y 60.' });
    const c = db.prepare('SELECT * FROM compras WHERE id=?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Compra no encontrada' });
    if (c.estado === 'diferida' || c.diferida_id) return res.status(400).json({ error: 'La compra ya es diferida; su número de cuotas se cambia con la reprogramación.' });
    if (c.grupo_id) return res.status(403).json({ error: 'Esta compra es parte de una compra dividida; conviértela editando el grupo completo.' });
    if ((c.monto_abonado || 0) > 0) return res.status(400).json({ error: 'La compra tiene un abono parcial registrado; no se puede convertir a cuotas.' });
    // Una compra internacional de Visa (valor_cop>0 + USD informativo) SÍ se difiere: la amortización
    // corre sobre el COP. Solo se rechaza la compra USD PURA (sin valor en pesos, no amortizable en COP)
    // — lo cubre este guard de valor_cop (antes había además un guard de valor_usd>0 que bloqueaba de
    // más las compras internacionales con COP; se eliminó por redundante e incorrecto).
    if (!c.valor_cop || c.valor_cop <= 0) return res.status(400).json({ error: 'La compra no tiene valor en pesos para amortizar.' });
    if (compraTerceroConReembolso(db, c.id)) {
      return res.status(403).json({ error: 'No se puede convertir: esta compra es de un tercero y ya tiene reembolsos registrados. Gestiona o retira esos abonos desde la pestaña Terceros antes de convertir.' });
    }
    const tj = db.prepare('SELECT dia_corte, tasa_mv_diferidas FROM tarjetas WHERE id=?').get(c.tarjeta_id);
    const diaCorte = (tj && tj.dia_corte) || 30;
    // v5.8.0: DEROGADO el candado por TIEMPO (exigía que la compra viviera en el ciclo VIGENTE). Si se
    // puede registrar una compra en un ciclo impago, se puede ponerla a cuotas ahí mismo. El candado de
    // ciclo PAGADO (abajo) es el único cierre.
    const extConv = db.prepare("SELECT estado FROM extractos WHERE tarjeta_id=? AND ciclo=?").get(c.tarjeta_id, c.ciclo);
    if (extConv && extConv.estado === 'pagado') {
      return res.status(403).json({ error: 'No se puede convertir: el extracto del ciclo ' + c.ciclo + ' ya está pagado.' });
    }
    // Primer corte = la fecha de corte del CICLO EFECTIVO de la compra (c.ciclo respeta ciclo_manual):
    // la cuota 1 cae exactamente en el ciclo donde hoy cuenta la compra. String directo (sin Date →
    // sin sorpresas de zona horaria). Para el caso normal coincide con primerCorteAvance(c.fecha).
    const [cy, cm] = String(c.ciclo).split('-').map(Number);
    const lastDayConv = new Date(cy, cm, 0).getDate();
    const fechaPrimerCorte = cy + '-' + String(cm).padStart(2, '0') + '-' + String(Math.min(diaCorte, lastDayConv)).padStart(2, '0');
    const tasaMv = cobrar_intereses ? ((tj && tj.tasa_mv_diferidas) || 0) : 0;

    let difId = null, trasladado = 0;
    const convertir = db.transaction(() => {
      const rDif = db.prepare(`INSERT INTO diferidas (tarjeta_id, etiqueta, monto, tasa_mv, num_cuotas, fecha_compra, fecha_primer_corte, estado, notas)
                               VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(c.tarjeta_id, c.descripcion, c.valor_cop, tasaMv, n, c.fecha, fechaPrimerCorte, 'activo', 'Convertida desde compra a 1 cuota');
      difId = rDif.lastInsertRowid;
      // Traslado del bolsillo apartado (personal; un tercero con bolsillo no llega aquí por el guard):
      // se reparte secuencialmente desde la cuota 1, cap-eado al total de cada cuota. El cache
      // compras.monto_bolsillo queda igual (= SUM per-cuota): el usuario no pierde lo apartado.
      const mb = Math.round(c.monto_bolsillo || 0);
      db.prepare('DELETE FROM bolsillo_cuotas WHERE compra_id=?').run(c.id); // defensa: sin restos previos
      if (mb > 0) {
        const amort = calcularAmortizacionDiferida(c.valor_cop, tasaMv, n, c.fecha, fechaPrimerCorte, null, nuOpts(db, c.tarjeta_id));
        let restante = mb;
        for (const q of amort.tabla) {
          if (restante <= 0) break;
          const cap = Math.round(q.totalPagar);
          const monto = Math.min(restante, cap);
          if (monto <= 0) continue;
          db.prepare("INSERT INTO bolsillo_cuotas (compra_id, cuota_num, monto, moneda) VALUES (?,?,?,'COP') ON CONFLICT(compra_id, cuota_num) DO UPDATE SET monto=excluded.monto")
            .run(c.id, q.numCuota, monto);
          restante -= monto; trasladado += monto;
        }
        // Residuo de redondeo (raro): a la última cuota — no se pierde un peso de lo apartado.
        if (restante > 0 && amort.tabla.length) {
          const ult = amort.tabla[amort.tabla.length - 1].numCuota;
          db.prepare('UPDATE bolsillo_cuotas SET monto = monto + ? WHERE compra_id=? AND cuota_num=?').run(restante, c.id, ult);
          trasladado += restante;
        }
        const sum = db.prepare("SELECT COALESCE(SUM(monto),0) t FROM bolsillo_cuotas WHERE compra_id=? AND COALESCE(moneda,'COP')='COP'").get(c.id);
        db.prepare('UPDATE compras SET monto_bolsillo=? WHERE id=?').run(sum.t, c.id);
      }
      const nuevasNotas = (c.notas ? c.notas + ' | ' : '') + 'Diferida a ' + n + ' cuotas';
      db.prepare("UPDATE compras SET estado='diferida', diferida_id=?, notas=? WHERE id=?").run(difId, nuevasNotas, c.id);
    });
    convertir();
    logAction('editar', tjNombre(c.tarjeta_id) + 'Compra convertida a diferida: ' + c.descripcion + ' (1 -> ' + n + ' cuotas)');
    res.json({ ok: true, diferida_id: difId, num_cuotas: n, bolsillo_trasladado: trasladado });
  });

  // ── Revertir diferida → compra de 1 cuota (camino inverso de la conversión) ──
  // POST /:id/revertir-diferida  (sin body)
  // Destruye el plan de cuotas (fila en `diferidas`) y consolida el bolsillo per-cuota de vuelta en
  // compras.monto_bolsillo (no se pierde un peso; cap al costo real de la compra). La fila de
  // `compras` conserva id/fecha/created_at (prelación de pagos). Mismos candados universales que
  // convertir/reprogramar: grupo, USD, terceros con reembolso y ciclos pagados.
  router.post('/:id/revertir-diferida', (req, res) => {
    const c = db.prepare('SELECT * FROM compras WHERE id=?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Compra no encontrada' });
    if (!(c.estado === 'diferida' || c.diferida_id)) return res.status(400).json({ error: 'La compra no es diferida; no hay plan de cuotas que revertir.' });
    if (!c.diferida_id) return res.status(400).json({ error: 'La compra no tiene un plan de cuotas vinculado.' });
    if (c.grupo_id) return res.status(403).json({ error: 'Esta compra es parte de una compra dividida; gestiónala editando el grupo completo.' });
    // Solo se rechaza la compra USD PURA (sin valor en pesos): su bolsillo es en USD y la consolidación
    // de revertir opera en COP. Una internacional de Visa (valor_cop>0 + USD informativo) sí se revierte.
    if (c.valor_usd && c.valor_usd > 0 && (!c.valor_cop || c.valor_cop <= 0)) return res.status(400).json({ error: 'Revertir compras solo en dólares (sin valor en pesos) no está soportado.' });
    if (compraTerceroConReembolso(db, c.id)) {
      return res.status(403).json({ error: 'No se puede revertir: esta compra es de un tercero y ya tiene reembolsos registrados. Gestiona o retira esos abonos desde la pestaña Terceros antes de revertir.' });
    }
    const d = db.prepare('SELECT * FROM diferidas WHERE id=?').get(c.diferida_id);
    if (!d) return res.status(404).json({ error: 'No se encontró el plan de cuotas vinculado.' });
    const abonosDif = db.prepare('SELECT COUNT(*) n FROM abonos_diferida WHERE diferida_id=?').get(d.id);
    if (abonosDif && abonosDif.n > 0) return res.status(400).json({ error: 'El plan de cuotas tiene abonos registrados; no se puede revertir.' });
    // v5.8.0: DEROGADO el candado por TIEMPO (solo se revertía en el ciclo VIGENTE). El guard de abajo
    // —ninguna cuota puede haber caído en un ciclo PAGADO— es el que protege de verdad, y es más
    // preciso: mira los ciclos que la amortización realmente tocó, no el calendario.
    // Inmutabilidad: ninguna cuota puede haber caído ya en un ciclo con extracto pagado (revertir
    // reescribiría un cierre real) — mismo criterio que la reprogramación. Incluye el ciclo de la compra.
    const amortRev = calcularAmortizacionDiferida(d.monto, d.tasa_mv, d.num_cuotas, d.fecha_compra, d.fecha_primer_corte, null, nuOptsDif(db, d));
    const ciclosRev = [...new Set(amortRev.tabla.map(q => q.fechaCorte.slice(0, 7)).concat([c.ciclo]))];
    const cicloPagadoRev = ciclosRev.find(ci => { const e2 = db.prepare("SELECT estado FROM extractos WHERE tarjeta_id=? AND ciclo=?").get(c.tarjeta_id, ci); return e2 && e2.estado === 'pagado'; });
    if (cicloPagadoRev) return res.status(403).json({ error: 'No se puede revertir: la diferida ya tiene cuotas facturadas en el ciclo pagado ' + cicloPagadoRev + '.' });

    // Consolidar el bolsillo per-cuota → bolsillo global de 1 cuota, cap-eado al costo real
    // (valor [+ interés intl]), igual que el resto de la app.
    const sumBc = db.prepare("SELECT COALESCE(SUM(monto),0) t FROM bolsillo_cuotas WHERE compra_id=? AND COALESCE(moneda,'COP')='COP'").get(c.id);
    const tope = targetBolsillo({ ...c, estado: 'pendiente' }, 'COP', null);
    let mb = Math.round(sumBc.t || 0);
    const capped = (tope != null && mb > tope);
    if (capped) mb = tope;
    const nuevoEstado = (tope != null && tope > 0 && mb >= tope) ? 'bolsillo' : (mb > 0 ? 'bolsillo_parcial' : 'pendiente');
    // Notas: retirar el sufijo informativo de cuotas ("... | Diferida a N cuotas").
    const notasLimpias = String(c.notas || '').replace(/\s*\|\s*Diferida a \d+ cuotas/g, '').replace(/^\s*Diferida a \d+ cuotas\s*(\|\s*)?/, '').trim() || null;

    const revertir = db.transaction(() => {
      db.prepare('DELETE FROM bolsillo_cuotas WHERE compra_id=?').run(c.id);
      // Orden importa: primero DESVINCULAR la compra (diferida_id=NULL) y luego borrar el plan —
      // compras.diferida_id es FOREIGN KEY a diferidas(id) y la BD corre con foreign_keys=ON.
      db.prepare('UPDATE compras SET estado=?, diferida_id=NULL, monto_bolsillo=?, notas=? WHERE id=?').run(nuevoEstado, mb, notasLimpias, c.id);
      db.prepare('DELETE FROM diferidas WHERE id=?').run(d.id);
    });
    revertir();
    logAction('editar', tjNombre(c.tarjeta_id) + 'Diferida revertida a 1 cuota: ' + c.descripcion + ' (' + d.num_cuotas + ' -> 1)');
    res.json({ ok: true, estado: nuevoEstado, bolsillo_consolidado: mb, capped, tope });
  });

  // ── Reprogramación RETROACTIVA de saldo: "Sellar y Renacer" ─────────────────────────────────────
  // POST /:id/reprogramar-saldo  Body: { num_cuotas_nuevas (M = total del banco), tasa_mv?, cobrar_intereses? }
  //
  // Modela que el banco reprogramó el PLAN de una diferida DESPUÉS de facturar algunas cuotas (ej.
  // APPLE 12→2 tras el corte de junio). La amortización es MONOLÍTICA/PURA, así que NO se modifica la
  // diferida en el aire (evaporaría las cuotas pasadas). En su lugar:
  //   1) SELLAR el pasado: cada cuota YA facturada (ciclo < vigente) se congela como una compra de 1
  //      cuota (valor_cop = SU capital, ciclo_manual=1, diferida_id=NULL) — 'pagado' si el extracto de
  //      ese ciclo ya se pagó (la tríada del blindaje ya está: extracto pagado + su abono → syncData
  //      paso 10 la exime), 'pendiente' si el ciclo cerró impago (inmune al paso 10, monto_abonado=0).
  //      Registro histórico intocable que sigue cruzando por capital en la conciliación.
  //   2) RENACER el futuro: el saldo restante (capital puro) nace como diferida HIJA a `remanente`
  //      cuotas (sin_gracia_cuota1=1 → el banco NO re-otorga la gracia de cuota 1 sobre un saldo en
  //      curso). La compra ORIGINAL se re-destina a ese saldo vivo (conserva id/fecha/created_at →
  //      prelación oldest-first) y arranca en el ciclo vigente. Si remanente==1 se reusa la compra
  //      como 1 sola cuota (diferida_id=NULL), patrón exacto de la APPLE reprogramada 36→2.
  //   3) BORRAR la diferida original — tras re-vincular/nulificar la compra (orden FK, foreign_keys=ON).
  //
  // INVARIANTE: Σ(capital sellado) + saldoRestante == monto original (capital puro) → la deuda global
  // NO cambia, solo se re-reparte el calendario futuro. El GUARD DE DESTINO (extracto del ciclo VIGENTE
  // pagado → 403) aplica SIEMPRE; el ciclo ORIGEN cerrado es ESPERADO (por eso no hay candado de cerrado).
  // Alcance v1 (mismos guards que convertir/revertir): sin grupos, USD pura, abono parcial, tercero con
  // reembolso ni abonos_diferida. La calibración FINA del interés del saldo queda pendiente de un
  // extracto real reprogramado → tasa por defecto conservadora (hereda la del plan; editable en la UI).
  router.post('/:id/reprogramar-saldo', (req, res) => {
    const { num_cuotas_nuevas, tasa_mv, cobrar_intereses } = req.body || {};
    const M = parseInt(num_cuotas_nuevas, 10);
    if (!M || M < 1 || M > 120) return res.status(400).json({ error: 'El número total de cuotas debe ser un entero entre 1 y 120.' });
    const c = db.prepare('SELECT * FROM compras WHERE id=?').get(req.params.id);
    if (!c) return res.status(404).json({ error: 'Compra no encontrada' });
    if (!(c.estado === 'diferida' || c.diferida_id)) return res.status(400).json({ error: 'La compra no es una diferida; no hay plan de cuotas que reprogramar.' });
    if (!c.diferida_id) return res.status(400).json({ error: 'La compra no tiene un plan de cuotas vinculado.' });
    if (c.grupo_id) return res.status(403).json({ error: 'Esta compra es parte de una compra dividida; reprograma cada parte por separado.' });
    if ((c.monto_abonado || 0) > 0) return res.status(400).json({ error: 'La compra tiene un abono parcial registrado; no se puede reprogramar el saldo.' });
    // Solo se rechaza la compra USD PURA (sin valor en pesos): la amortización de la hija corre sobre el
    // COP. Una internacional de Visa (valor_cop>0 + USD informativo) SÍ se reprograma.
    if (c.valor_usd && c.valor_usd > 0 && (!c.valor_cop || c.valor_cop <= 0)) return res.status(400).json({ error: 'Reprogramar compras solo en dólares (sin valor en pesos) no está soportado.' });
    // Guard de tercero ACOTADO al canal que el sellado SÍ sabe repartir (v1). El guard genérico
    // (compraTerceroConReembolso, que conservan convertir/revertir/merge — endpoints que NO saben sellar)
    // bloqueaba los CUATRO canales de reembolso; aquí solo soportamos el del bolsillo COP per-cuota
    // (bolsillo_cuotas), que el sellado traslada íntegro cuota por cuota + interes_sellado. Los otros dos
    // se bloquean porque NO se sabe repartirlos entre las k selladas y la renacida:
    //   · tercero_pagado / tercero_monto_abonado: el toggle "Recibido" y los abonos directos son de la
    //     compra COMPLETA, no por cuota. Sellar sin propagarlos RESUCITA deuda fantasma (medido: un
    //     tercero en cero pasaba a deber +$212.913).
    //   · monto_bolsillo_usd / bolsillo_cuotas USD: el traslado solo mueve COP → el reembolso USD se
    //     perdería sin traza ni saldo a favor (medido: USD $50 evaporados).
    if (c.persona_id) {
      if (c.tercero_pagado || (c.tercero_monto_abonado || 0) > 0) {
        return res.status(403).json({ error: 'Esta compra es de un tercero marcado como "Recibido" (o con abonos directos): ese reembolso es de la compra completa y aún no se sabe repartir entre las cuotas al reprogramar. Gestiónalo desde la pestaña Terceros antes de reprogramar. El reembolso por bolsillo (cuota a cuota) SÍ está soportado.' });
      }
      const bolUsd = db.prepare("SELECT COALESCE(SUM(monto),0) t FROM bolsillo_cuotas WHERE compra_id=? AND COALESCE(moneda,'COP')='USD'").get(c.id);
      if ((c.monto_bolsillo_usd || 0) > 0 || (bolUsd && bolUsd.t > 0)) {
        return res.status(403).json({ error: 'Esta compra de tercero tiene reembolso en dólares. Reprogramar solo traslada el reembolso en pesos, así que el de dólares se perdería. Retíralo desde Terceros antes de reprogramar.' });
      }
    }
    const d = db.prepare('SELECT * FROM diferidas WHERE id=?').get(c.diferida_id);
    if (!d) return res.status(404).json({ error: 'No se encontró el plan de cuotas vinculado.' });
    const abonosDif = db.prepare('SELECT COUNT(*) n FROM abonos_diferida WHERE diferida_id=?').get(d.id);
    if (abonosDif && abonosDif.n > 0) return res.status(400).json({ error: 'El plan de cuotas tiene abonos a capital registrados; no se puede reprogramar el saldo.' });

    const tj = db.prepare('SELECT dia_corte, tasa_mv_diferidas FROM tarjetas WHERE id=?').get(c.tarjeta_id);
    const diaCorte = (tj && tj.dia_corte) || 30;
    const cortesMap = getCortesCustomMap(db, c.tarjeta_id);
    // Ciclo VIGENTE (consciente del corte adelantado) = destino del saldo reprogramado.
    const V = cicloConCorte(hoyLocal(), diaCorte, cortesMap);
    // GUARD DE DESTINO (SIEMPRE, ni la IA lo exime): no se inyecta el saldo vivo en un ciclo cuyo
    // extracto ya se cerró como total pagado.
    const extV = db.prepare("SELECT estado FROM extractos WHERE tarjeta_id=? AND ciclo=?").get(c.tarjeta_id, V);
    if (extV && extV.estado === 'pagado') {
      return res.status(403).json({ error: 'No se puede reprogramar: el extracto del ciclo vigente ' + V + ' ya está pagado.' });
    }
    // Idempotencia: si la diferida vinculada YA es un saldo reprogramado anclado al vigente (nació con
    // sin_gracia_cuota1=1 y su primer corte en V), un 2º POST (doble clic/reintento) crearía un "nieto" y
    // reemplazaría en silencio el plan recién creado. Se rechaza. Una reprogramación legítima futura tendrá
    // el vigente avanzado → su primer corte ya no será corte(V) actual → no se bloquea.
    if (d.sin_gracia_cuota1 && d.fecha_primer_corte === corteDeCiclo(V, diaCorte)) {
      return res.status(409).json({ error: 'Esta diferida ya es un saldo reprogramado al ciclo vigente ' + V + '. Para cambiarla de nuevo, revierte primero o espera al próximo ciclo.' });
    }

    // Amortizar la diferida ORIGINAL INTACTA (respeta su propia gracia de cuota 1 vía nuOptsDif).
    const amortOrig = calcularAmortizacionDiferida(d.monto, d.tasa_mv, d.num_cuotas, d.fecha_compra, d.fecha_primer_corte, null, nuOptsDif(db, d));
    const tabla = amortOrig.tabla;
    // k = cuotas ya FACTURADAS (fechaCorte en un ciclo estrictamente anterior al vigente). El corte del
    // vigente aún no llegó → su cuota NO se sella (es parte del saldo/hija).
    const k = tabla.filter(q => q.fechaCorte.slice(0, 7) < V).length;
    if (M <= k) return res.status(400).json({ error: 'El nuevo total (' + M + ') debe ser mayor que las ' + k + ' cuota(s) ya facturadas antes del ciclo vigente ' + V + '.' });
    const remanente = M - k;
    // Capital de cada cuota sellada (entero) + saldo restante EXACTO = monto − Σsellado. Así la
    // invariante Σ(sellado) + saldoRestante == monto se cumple AL PESO (sin drift de redondeo).
    const sealCapitals = tabla.slice(0, k).map(q => Math.round(q.cuotaCapital));
    const sumSellado = sealCapitals.reduce((s, x) => s + x, 0);
    const montoR = Math.round(d.monto * 100) / 100;
    const saldoRestante = Math.round((montoR - sumSellado) * 100) / 100;
    if (!(saldoRestante > 0.01)) return res.status(400).json({ error: 'No queda saldo por reprogramar en esta diferida.' });

    // Tasa de la HIJA: por defecto HEREDA la del plan; cobrar_intereses=false la anula (0%); tasa_mv
    // explícita la sobreescribe (ej. la del extracto reprogramado real).
    let tasaHija;
    if (cobrar_intereses === false) tasaHija = 0;
    else if (tasa_mv != null && tasa_mv !== '') tasaHija = Number(tasa_mv);
    else tasaHija = d.tasa_mv;
    if (!(tasaHija >= 0) || tasaHija >= 1) return res.status(400).json({ error: 'La tasa mensual debe ser un decimal entre 0 y 1 (ej. 0.021285).' });

    // Fechas de la HIJA: fecha_primer_corte = corte del vigente (la cuota 1 cae en V). fecha_compra =
    // ~30 días antes (corte del ciclo ANTERIOR a V) para que la cuota 1 cobre UN mes de interés, NO
    // (k+1) meses: la fecha REAL de la compra queda k+1 ciclos atrás → inflaría el interés de la cuota 1
    // sobre TODO el saldo. syncData paso 11 exime a las hijas (sin_gracia_cuota1=1) de re-alinear su
    // fecha_compra a la de la compra → este anclaje es estable en cada arranque.
    const fechaPrimerCorteHija = corteDeCiclo(V, diaCorte);
    let _vy = Number(V.split('-')[0]), _vm = Number(V.split('-')[1]) - 1;
    if (_vm < 1) { _vm = 12; _vy -= 1; }
    const fechaCompraHija = corteDeCiclo(_vy + '-' + String(_vm).padStart(2, '0'), diaCorte);
    // opts de la hija = SIN gracia de cuota 1 (nace con sin_gracia_cuota1=1).
    const optsHija = nuOptsDif(db, { tarjeta_id: c.tarjeta_id, sin_gracia_cuota1: 1 });
    // Notas base: quitar el sufijo "Diferida a N cuotas" del plan VIEJO. Sin esto, syncData paso 7
    // (marca 'diferida' toda compra con "Diferida a N cuotas" en notas) re-marcaría la compra reusada
    // de 1 cuota como 'diferida' al arrancar → quedaría 'diferida' sin plan y su deuda desaparecería.
    const notasBase = String(c.notas || '').replace(/\s*\|\s*Diferida a \d+ cuotas/g, '').replace(/^\s*Diferida a \d+ cuotas\s*(\|\s*)?/, '').trim();

    // Bolsillo per-cuota original (COP) por número de cuota.
    const bolMap = {};
    db.prepare("SELECT cuota_num, monto FROM bolsillo_cuotas WHERE compra_id=? AND COALESCE(moneda,'COP')='COP'").all(c.id)
      .forEach(b => { bolMap[b.cuota_num] = Math.round(b.monto); });

    const cicloPagado = (ci) => { const e = db.prepare("SELECT estado FROM extractos WHERE tarjeta_id=? AND ciclo=?").get(c.tarjeta_id, ci); return !!(e && e.estado === 'pagado'); };
    // Un TERCERO tiene DOS libros y hay que servirlos por separado (ver el bloque de sellado):
    //   BANCO   → valor_cop = capital, estado = estado del extracto. Invariante Σcapital+saldo==monto.
    //   TERCERO → monto_bolsillo = SU reembolso (no es plata mía) + interes_sellado = el interés que
    //             el banco me facturó por esa cuota y que él también me debe.
    const esTercero = !!c.persona_id;
    let hijaId = null, rollForward = 0, bolsilloLiberado = 0, saldoFavorCreado = 0;
    const sellados = [];

    const reprogramar = db.transaction(() => {
      // ── 1) SELLAR EL PASADO: k compras de 1 cuota congeladas (mecánica dividir-cuotas) ──
      for (let i = 0; i < k; i++) {
        const q = tabla[i];
        const ciCuota = q.fechaCorte.slice(0, 7);
        const capital = sealCapitals[i];
        let estadoSello, abonado = 0, bolSello = 0, intSellado = null;
        if (esTercero) {
          // TERCERO — los dos libros, desacoplados:
          //  (a) BANCO: el estado lo decide el EXTRACTO, nunca el bolsillo (convención v4.4.1: en una
          //      compra de tercero el "Estado TC" es el estado con el banco e ignora el bolsillo).
          //  (b) TERCERO: su reembolso se conserva COMPLETO — sin capar y SIN rodar. El excedente sobre
          //      el capital es el INTERÉS que él ya pagó: murió en esta cuota (el banco ya me lo cobró);
          //      rodarlo al saldo nuevo sería un crédito futuro por plata ya consumida (doble crédito).
          //      interes_sellado persiste ese interés para que su deuda por la cuota siga siendo
          //      capital+interés: si reembolsó a medias, sigue debiendo el remanente CON su interés.
          if (cicloPagado(ciCuota)) { estadoSello = 'pagado'; abonado = capital; }
          else { estadoSello = 'pendiente'; }
          bolSello = bolMap[i + 1] || 0;
          // POR RESTA, no Math.round(q.interesTotal): así capital + interes_sellado == round(totalPagar)
          // EXACTO. round(capital)+round(interés) puede diferir en $1 de round(capital+interés), y ese
          // round(totalPagar) es justo el tope con el que targetBolsillo dejó apartar el reembolso →
          // el objetivo quedaría $1 por encima de lo máximo reembolsable = deuda fantasma perpetua.
          intSellado = Math.round(q.totalPagar || 0) - capital;
        } else if (cicloPagado(ciCuota)) {
          // Personal: ese extracto ya se pagó → 'pagado' + monto_abonado=capital (tríada completa; el
          // bolsillo de esa cuota se consumió al pagar). No se roda (la plata fue al banco).
          estadoSello = 'pagado'; abonado = capital;
        } else {
          // Personal + ciclo cerrado IMPAGO → conserva su bolsillo (cap al capital); el exceso (si cubría
          // interés) se roda al saldo futuro para no perder un peso.
          const b = bolMap[i + 1] || 0;
          bolSello = Math.min(b, capital);
          if (b > bolSello) rollForward += (b - bolSello);
          estadoSello = (bolSello >= capital && capital > 0) ? 'bolsillo' : (bolSello > 0 ? 'bolsillo_parcial' : 'pendiente');
        }
        // es_internacional=0 / tasa_intl=NULL en la sellada (antes se heredaban): una cuota de diferida NO
        // lleva recargo intl extra — el banco la factura a puro capital + su tasa_mv (regla confirmada con
        // el extracto de junio). Heredarlos hacía que el recargo se RECALCULARA con la fecha ORIGINAL de la
        // compra contra el corte de la cuota k (dias≈30·k) → interés fantasma inflado ×k; sumado a
        // interes_sellado sería DOBLE COBRO al tercero. El interés real de la cuota vive en interes_sellado.
        const r = db.prepare(`INSERT INTO compras (tarjeta_id, fecha, descripcion, valor_cop, persona_id, estado, ciclo, notas, nota_personal, es_internacional, ciclo_manual, tasa_intl, monto_abonado, monto_bolsillo, interes_sellado)
                              VALUES (?,?,?,?,?,?,?,?,?,0,1,NULL,?,?,?)`)
          .run(c.tarjeta_id, c.fecha, c.descripcion + ' (cuota ' + (i + 1) + '/' + M + ')', capital, c.persona_id || null, estadoSello, ciCuota,
               'Cuota ' + (i + 1) + '/' + M + ' sellada por reprogramacion de saldo (' + d.num_cuotas + '->' + M + ')', c.nota_personal || null, abonado, bolSello, intSellado);
        sellados.push(r.lastInsertRowid);
      }

      // Limpiar el bolsillo per-cuota original de la compra que se reusará para el saldo vivo.
      db.prepare('DELETE FROM bolsillo_cuotas WHERE compra_id=?').run(c.id);

      { // ── 2) RENACER (Opcion A): SIEMPRE una diferida HIJA a `remanente` cuotas — incluso remanente==1
        //     (num_cuotas=1). Antes remanente==1 se reusaba como compra de CONTADO (diferida_id=NULL); ahora
        //     TODA deuda reprogramada vive en Diferidas con su amortizacion. reprog_total=M (total del plan
        //     nuevo del banco) -> el badge muestra la numeracion del plan "(k+1)/M" (ej. 2/2), no la local 1/1.
        const rDif = db.prepare(`INSERT INTO diferidas (tarjeta_id, etiqueta, monto, tasa_mv, num_cuotas, fecha_compra, fecha_primer_corte, estado, notas, sin_gracia_cuota1, reprog_total)
                                 VALUES (?,?,?,?,?,?,?,?,?,1,?)`)
          .run(c.tarjeta_id, c.descripcion, saldoRestante, tasaHija, remanente, fechaCompraHija, fechaPrimerCorteHija, 'activo', 'Saldo reprogramado (' + d.num_cuotas + '->' + M + ')', M);
        hijaId = rDif.lastInsertRowid;
        // Re-vincular la compra ORIGINAL al saldo vivo del vigente (conserva id/fecha/created_at).
        // valor_usd/tasa_usd=NULL → el saldo es COP puro; evita que syncData paso 1 lo reviva a
        // ROUND(valor_usd*tasa_usd) en tarjetas no duales. es_internacional/tasa_intl se conservan.
        db.prepare(`UPDATE compras SET estado='diferida', valor_cop=?, valor_usd=NULL, tasa_usd=NULL, ciclo=?, ciclo_manual=1, diferida_id=?, monto_bolsillo=0, monto_bolsillo_usd=0, notas=? WHERE id=?`)
          .run(saldoRestante, V, hijaId, (notasBase ? notasBase + ' | ' : '') + 'Diferida a ' + remanente + ' cuotas | Saldo reprogramado ' + d.num_cuotas + '->' + M, c.id);
        const amortHija = calcularAmortizacionDiferida(saldoRestante, tasaHija, remanente, fechaCompraHija, fechaPrimerCorteHija, null, optsHija);
        // Prepago FUTURO del plan viejo (cuotas k+1..N) + el excedente rodado del pasado (personal).
        let prepagoFuturo = rollForward;
        for (let j = k + 1; j <= d.num_cuotas; j++) prepagoFuturo += (bolMap[j] || 0);

        let restante;
        if (esTercero) {
          // TERCERO — el prepago de cuotas futuras NO se inyecta al bolsillo de la hija: esa plata es del
          // deudor y es ÉL (vía el usuario) quien decide a qué deuda se aplica, no el sistema. Nace COMPLETO
          // como crédito trazable a su favor y el bolsillo del saldo renacido queda en $0; se cruza a mano
          // desde "Dinero a favor" en Terceros. Antes se auto-inyectaba a la hija; además de decidir por el
          // usuario, dejaba la cuota de la hija con un reembolso PARCIAL — estado que la card "Me Deben"
          // representa TODO-O-NADA e ignora (ver BACKLOG "Reembolso parcial de cuota"), inflando su deuda.
          // Con el crédito aparte, la cuota queda limpia (bolsillo 0) y las dos vistas vuelven a coincidir.
          if (prepagoFuturo > 0) {
            db.prepare(`INSERT INTO saldos_favor_tercero
                (persona_id, monto, origen_tipo, origen_compra_id, tarjeta_id, descripcion, fecha, notas)
                VALUES (?,?, 'reprogramacion', ?,?,?,?,?)`)
              .run(c.persona_id, prepagoFuturo, c.id, c.tarjeta_id,
                   'Prepago de cuotas futuras por reprogramacion de ' + c.descripcion, hoyLocal(),
                   'Reprogramacion de saldo ' + d.num_cuotas + '->' + M + ': habia reembolsado cuotas del plan viejo que ya no existen. Ese prepago queda a su favor para aplicarlo a la deuda que elijas.');
            saldoFavorCreado += prepagoFuturo;
          }
          restante = 0;
        } else {
          // PERSONAL — el bolsillo es plata propia: se traslada al saldo vivo (cap por cuota, residuo a la
          // última, sin perder un peso). Tope global: nunca reservar más que el costo total de la hija
          // (convención "bolsillo <= costo"); si se fondearon más cuotas de las que quedan (reprogramación
          // a MENOS cuotas), el excedente se LIBERA como efectivo, no se sobre-reserva ni se descarta.
          restante = prepagoFuturo;
          const capacidadHija = amortHija.tabla.reduce((s, q) => s + Math.round(q.totalPagar), 0);
          if (restante > capacidadHija) {
            bolsilloLiberado += restante - capacidadHija;
            restante = capacidadHija;
          }
        }
        for (const qh of amortHija.tabla) {
          if (restante <= 0) break;
          const cap = Math.round(qh.totalPagar);
          const monto = Math.min(restante, cap);
          if (monto <= 0) continue;
          db.prepare("INSERT INTO bolsillo_cuotas (compra_id, cuota_num, monto, moneda) VALUES (?,?,?,'COP') ON CONFLICT(compra_id, cuota_num) DO UPDATE SET monto=excluded.monto").run(c.id, qh.numCuota, monto);
          restante -= monto;
        }
        if (restante > 0 && amortHija.tabla.length) {
          const ult = amortHija.tabla[amortHija.tabla.length - 1].numCuota;
          db.prepare('UPDATE bolsillo_cuotas SET monto = monto + ? WHERE compra_id=? AND cuota_num=?').run(restante, c.id, ult);
        }
        const sum = db.prepare("SELECT COALESCE(SUM(monto),0) t FROM bolsillo_cuotas WHERE compra_id=? AND COALESCE(moneda,'COP')='COP'").get(c.id);
        db.prepare('UPDATE compras SET monto_bolsillo=? WHERE id=?').run(sum.t, c.id);
      }

      // ── 3) Borrar la diferida ORIGINAL (nadie la referencia: la compra se re-vinculó a la hija o se
      //       nulificó; las selladas nacieron con diferida_id=NULL). Orden FK. ──
      db.prepare('DELETE FROM diferidas WHERE id=?').run(d.id);
    });
    reprogramar();

    logAction('editar', tjNombre(c.tarjeta_id) + 'Reprogramacion de saldo: ' + c.descripcion + ' (' + d.num_cuotas + ' -> ' + M + '; ' + k + ' selladas, saldo ' + Math.round(saldoRestante) + ' a ' + remanente + ')');
    res.json({ ok: true, k, remanente, saldo_restante: Math.round(saldoRestante), hija_id: hijaId, sellados, ciclo_vigente: V, tasa_hija: tasaHija, bolsillo_liberado: Math.round(bolsilloLiberado), saldo_favor_creado: Math.round(saldoFavorCreado) });
  });
};
