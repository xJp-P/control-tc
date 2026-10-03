'use strict';
// verificacion/detectores/bancolombia.js — Las reglas de Bancolombia MEDIDAS en extractos reales
// (Fase B, oct-2026). Cada una salio de cuadrar al centavo el cargo "INTERESES CORRIENTES" de los
// extractos de jul/ago/sep-2026 de la Visa Infinite, que el banco imprime como UNA sola linea (no da
// el interes por compra). Por eso son faciles de romper sin que nada mas lo note: un refactor que
// "simplifique" el motor devolveria la deuda de siempre, solo que $20.000 corta cada mes.
//
//   R11  Motor de interes: la cuota FACTURADA devenga hasta el dia del pago (y la ultima cuota de un
//        plan lo cobra al mes siguiente), y "Sellar y Renacer" ARRASTRA el interes diferido de la
//        cuota 1 a la hija en vez de perderlo.
//   R12  Las correcciones de la conciliacion de septiembre: fecha limite de pago (corte + 17 dias,
//        al siguiente habil), reprogramar limpia el calendario irregular viejo, convertir a cuotas usa
//        la tasa del mes de la compra, y un reverso de "MERCADO PAGO*..." ya no se descarta como pago.
//
// Todo se SIEMBRA (criterio de R6/R8/R9/R10) sobre una copia, en tarjetas propias y en fechas lejanas
// (2029) o anteriores al reloj congelado, para no depender de lo que tenga la BD del usuario. Los
// asertos van en PARES (antes/despues, o la misma deuda en un banco que NO es Bancolombia): sin el par,
// un aserto que espera "0" o "lo de siempre" pasaria en vacio.
const fs = require('fs');
const path = require('path');
const { conApp, pedir, resultado, leer } = require('../lib');

const r2 = (n) => Math.round(n * 100) / 100;
const casi = (a, b) => Math.abs(Number(a) - Number(b)) < 0.011;

// Siembra una tarjeta y LIMPIA la cache de banco: es por id y vive lo que vive el proceso, y todos los
// detectores siembran sobre copias de la MISMA BD -> la tarjeta de otro detector pudo dejar cacheado
// este mismo id con otro banco o sin la bandera de gracia.
function sembrarTarjeta(raiz, db, nombre, banco, franquicia, difiere, tasa) {
  const id = db.prepare(`INSERT INTO tarjetas (nombre, banco, franquicia, dia_corte, dia_pago, cupo_total, tasa_mv_avances, tasa_mv_diferidas, estado, difiere_intereses_cuota1)
                         VALUES (?,?,?,30,16,40000000,?,?,'activa',?)`).run(nombre, banco, franquicia, tasa, tasa, difiere).lastInsertRowid;
  require(path.join(raiz, 'backend', 'helpers', 'banco.js')).clearBancoCache();
  return id;
}

function sembrarDiferida(db, tj, etiqueta, monto, tasa, n, fechaCompra, primerCorte) {
  return db.prepare(`INSERT INTO diferidas (tarjeta_id, etiqueta, monto, tasa_mv, num_cuotas, fecha_compra, fecha_primer_corte, estado, notas)
                     VALUES (?,?,?,?,?,?,?,'activo','sembrada')`).run(tj, etiqueta, monto, tasa, n, fechaCompra, primerCorte).lastInsertRowid;
}

function tabla(raiz, db, difId) {
  const { calcularAmortizacionDiferida } = require(path.join(raiz, 'backend', 'engine', 'amortizacion.js'));
  const { nuOptsDif } = require(path.join(raiz, 'backend', 'helpers', 'banco.js'));
  const d = db.prepare('SELECT * FROM diferidas WHERE id=?').get(difId);
  return calcularAmortizacionDiferida(d.monto, d.tasa_mv, d.num_cuotas, d.fecha_compra, d.fecha_primer_corte, null, nuOptsDif(db, d)).tabla;
}

// ─── R11 ────────────────────────────────────────────────────────────────────────────────────────
const R11 = {
  id: 'R11',
  nombre: 'Interes Bancolombia: la cuota facturada devenga hasta el pago y Sellar y Renacer no pierde el diferido',
  async medir(raiz) {
    const notas = [];
    const cifras = {};
    const A = (cond, msg) => { if (!cond) notas.push('FALLO ' + msg); };
    try {
      await conApp(raiz, 'R11', async (port, db) => {
        const tjB = sembrarTarjeta(raiz, db, 'R11 VISA BANCOLOMBIA', 'Bancolombia', 'Visa', 1, 0.02);
        const tjO = sembrarTarjeta(raiz, db, 'R11 OTRO BANCO', 'Otro Banco', 'Visa', null, 0.02);

        // ── (1) Cuota facturada hasta el pago. 300.000 a 3 cuotas, cuota 1 al corte del 30-ene-2029. ──
        const dB = sembrarDiferida(db, tjB, 'R11 PLAN', 300000, 0.02, 3, '2029-01-15', '2029-01-30');
        const dO = sembrarDiferida(db, tjO, 'R11 PLAN', 300000, 0.02, 3, '2029-01-15', '2029-01-30');
        // El extracto de enero se PAGO el 11-feb: 12 dias despues del corte (como septiembre-2026).
        const insExt = db.prepare("INSERT INTO extractos (tarjeta_id, ciclo, fecha_corte, fecha_pago, pago_minimo, pago_total, estado, monto_pagado, fecha_pagado) VALUES (?,?,?,?,1,1,'pagado',1,?)");
        insExt.run(tjB, '2029-01', '2029-01-30', '2029-02-16', '2029-02-11');
        insExt.run(tjO, '2029-01', '2029-01-30', '2029-02-16', '2029-02-11');
        const tB = tabla(raiz, db, dB), tO = tabla(raiz, db, dO);
        // Cuota 2: 100.000 facturados el 30-ene, pagados el 11-feb -> 100.000 x 2% x 12/30 = 800.
        const esp2 = r2(100000 * 0.02 * 12 / 30);
        cifras.cuota2 = (tB[1] && tB[1].interesCuotaFacturada) + ' (esperado ' + esp2 + ')';
        A(tO[1] && tO[1].interesCuotaFacturada === 0, '[PAR]: un banco que NO es Bancolombia tambien cobra la cuota facturada hasta el pago (' + (tO[1] && tO[1].interesCuotaFacturada) + ') -> la regla se escapo de su alcance');
        A(tB[1] && casi(tB[1].interesCuotaFacturada, esp2), '[PAGADO]: la cuota 2 cobra ' + (tB[1] && tB[1].interesCuotaFacturada) + ' por la cuota 1 facturada; esperado ' + esp2 + ' (100.000 x 2% x 12 dias hasta el pago REAL)');
        // Total de la cuota 2 = su periodo (200.000 x 29 dias) + la cuota facturada + el diferido de la
        // cuota 1 (300.000 x 15 dias). Formula explicita: el par de otro banco no sirve aqui porque ese
        // banco tampoco difiere la cuota 1, asi que la resta mezclaria las dos reglas.
        const espTot2 = r2(200000 * 0.02 * 29 / 30 + esp2 + 300000 * 0.02 * 15 / 30);
        A(tB[1] && casi(tB[1].interesTotal, espTot2), '[TOTAL]: la cuota 2 cobra ' + (tB[1] && tB[1].interesTotal) + ' de interes; esperado ' + espTot2 + ' (periodo + cuota facturada + diferido de la cuota 1)');
        // Cuota 3: el extracto de febrero NO esta pagado -> fecha limite proyectada. Corte 28-feb + 17 =
        // 17-mar (sabado); 19-mar es San Jose (lunes festivo) -> martes 20-mar: 20 dias.
        const esp3 = r2(100000 * 0.02 * 20 / 30);
        A(tB[2] && casi(tB[2].interesCuotaFacturada, esp3), '[PROYECTADO]: con el extracto sin pagar, la cuota 3 cobra ' + (tB[2] && tB[2].interesCuotaFacturada) + '; esperado ' + esp3 + ' (20 dias hasta el 20-mar-2029: sabado, domingo y San Jose)');

        // ── (2) Cola: la ULTIMA cuota (marzo) devenga hasta el 16-abr y lo cobra el extracto de ABRIL. ──
        const { calcExtracto } = require(path.join(raiz, 'backend', 'engine', 'extracto.js'));
        const espCola = r2(100000 * 0.02 * 17 / 30);
        const eB = calcExtracto(db, tjB, '2029-04', false), eO = calcExtracto(db, tjO, '2029-04', false);
        cifras.cola = (eB && eB.interesCuotasFinales) + ' (esperado ' + espCola + ')';
        A(eO && !(eO.interesCuotasFinales > 0), '[COLA/PAR]: un banco que no es Bancolombia cobra cola (' + (eO && eO.interesCuotasFinales) + ')');
        A(eB && casi(eB.interesCuotasFinales, espCola), '[COLA]: el extracto de abril cobra ' + (eB && eB.interesCuotasFinales) + ' por la ultima cuota del plan; esperado ' + espCola + ' (100.000 x 2% x 17 dias)');
        const dash = (await pedir(port, 'GET', '/api/dashboard?tarjeta_id=' + tjB + '&ciclo=2029-04')).j || {};
        A(eB && casi(dash.interesesMesCuotasFinales, eB.interesCuotasFinales), '[COLA/PARIDAD]: la card de intereses del dashboard dice ' + dash.interesesMesCuotasFinales + ' y el extracto ' + (eB && eB.interesCuotasFinales) + ' -> las dos vistas cuentan distinto');

        // ── (3) Sellar y Renacer arrastra el interes diferido de la cuota 1 (plan de 4 cuotas -> 3 en total). ──
        const d2 = sembrarDiferida(db, tjB, 'R11 REPROGRAMABLE', 60000, 0.021285, 4, '2026-07-06', '2026-07-30');
        const c2 = db.prepare("INSERT INTO compras (tarjeta_id, fecha, descripcion, valor_cop, estado, ciclo, diferida_id, notas) VALUES (?,?,?,?,'diferida','2026-07',?,'Diferida a 4 cuotas')")
          .run(tjB, '2026-07-06', 'R11 REPROGRAMABLE', 60000, d2).lastInsertRowid;
        const diferido = r2(60000 * 0.021285 * 24 / 30);   // cuota 1: del 06-jul al corte del 30-jul
        const t2 = tabla(raiz, db, d2);
        A(t2[0] && t2[0].interesTotal === 0 && casi(t2[0].interesPeriodo, diferido), '[SANIDAD/ANTES]: la cuota 1 del plan original no difiere ' + diferido + ' (interesTotal ' + (t2[0] && t2[0].interesTotal) + ', periodo ' + (t2[0] && t2[0].interesPeriodo) + ') -> el arrastre de despues no probaria nada');
        const rr = await pedir(port, 'POST', '/api/compras/' + c2 + '/reprogramar-saldo', { num_cuotas_nuevas: 3, ciclo_efectivo: '2026-08', num_cuotas_original: 4 });
        A(rr.s === 200 && rr.j && rr.j.ok, '[REPROGRAMAR]: el endpoint rechazo la reprogramacion: ' + JSON.stringify(rr.j));
        const hija = db.prepare('SELECT d.* FROM diferidas d JOIN compras c ON c.diferida_id = d.id WHERE c.id=?').get(c2);
        cifras.arrastre = (hija && hija.interes_arrastrado) + ' (esperado ' + diferido + ')';
        A(hija && casi(hija.interes_arrastrado, diferido), '[ARRASTRE]: la hija guardo interes_arrastrado=' + (hija && hija.interes_arrastrado) + '; esperado ' + diferido + ' -> el interes diferido de la cuota 1 se pierde al reprogramar (el banco lo cobra igual)');
        A(hija && casi(hija.capital_facturado_previo, 15000), '[CUOTA SELLADA]: la hija no sabe que la cuota sellada (15.000) sigue devengando hasta el pago (capital_facturado_previo=' + (hija && hija.capital_facturado_previo) + ')');
        if (hija) {
          const th = tabla(raiz, db, hija.id);
          // Cuota 1 de la hija = su periodo (45.000 x 31 dias) + el diferido + la cuota sellada hasta el
          // pago proyectado del extracto de julio (30-jul + 17 = 16-ago domingo, 17-ago festivo -> 18-ago).
          const esp = r2(45000 * 0.021285 * 31 / 30 + diferido + 15000 * 0.021285 * 19 / 30);
          cifras.cuota1Hija = (th[0] && th[0].interesTotal) + ' (esperado ' + esp + ')';
          A(th[0] && casi(th[0].interesTotal, esp), '[HIJA]: la cuota 1 de la hija cobra ' + (th[0] && th[0].interesTotal) + '; esperado ' + esp + ' (periodo + diferido + cuota sellada hasta el 18-ago)');
        }
      });
    } catch (e) {
      return resultado(false, cifras, ['FALLO ejecutando el escenario: ' + e.message]);
    }
    return resultado(notas.length === 0, cifras, notas);
  },
  defecto: 'la cuota facturada deja de devengar hasta el pago (el motor vuelve a quedarse ~$20.000 corto cada mes)',
  mutar(raiz) {
    const p = path.join(raiz, 'backend', 'engine', 'amortizacion.js');
    const src = leer(p);
    const aguja = 'if (!fechaPagoDe || !(capFacturadoPrev > 0)) return 0;';
    if (src.indexOf(aguja) === -1) throw new Error('no se encontro la guarda de interesCuotaFacturadaHastaPago');
    fs.writeFileSync(p, src.replace(aguja, 'return 0;'), 'utf8');
  },
};

// ─── R12 ────────────────────────────────────────────────────────────────────────────────────────
const R12 = {
  id: 'R12',
  nombre: 'Correcciones de septiembre: fecha de pago, reprogramar, tasa del mes y reversos de MERCADO PAGO',
  async medir(raiz) {
    const notas = [];
    const cifras = {};
    const A = (cond, msg) => { if (!cond) notas.push('FALLO ' + msg); };

    // ── (1) Fecha limite: las CUATRO fechas reales medidas, y las demas tarjetas sin cambio. ──
    const { fechaPagoProyectada } = require(path.join(raiz, 'backend', 'helpers', 'fechaPago.js'));
    const visa = { banco: 'Bancolombia', franquicia: 'Visa', dia_pago: 16 };
    [['2026-04', '2026-04-30', '2026-05-19'], ['2026-07', '2026-07-30', '2026-08-18'],
     ['2026-08', '2026-08-30', '2026-09-16'], ['2026-09', '2026-09-30', '2026-10-19']].forEach(([ci, co, real]) => {
      const f = fechaPagoProyectada(visa, ci, co);
      A(f === real, '[FECHA ' + ci + ']: la app calcula ' + f + ' y el extracto real dice ' + real + ' (corte + 17 dias calendario, al siguiente habil)');
    });
    A(fechaPagoProyectada({ banco: 'RappiCard', dia_pago: 31 }, '2026-09', '2026-09-20') === '2026-10-04', '[FECHA/RAPPI]: RappiCard dejo de ser corte + 14');
    // Un mes donde las dos reglas DIFIEREN (con el corte del 15-sep coincidian en el 2-oct y el aserto
    // pasaba en vacio aunque la regla se escapara): 15-oct + 17 = domingo 1-nov, 2-nov festivo -> 3-nov
    // con la de Visa; 2-nov con su dia_pago.
    A(fechaPagoProyectada({ banco: 'Bancolombia', franquicia: 'Mastercard', dia_pago: 2 }, '2026-10', '2026-10-15') === '2026-11-02', '[FECHA/MASTERCARD]: la regla de Visa se aplico a una Mastercard (no medida: conserva su dia_pago)');

    try {
      await conApp(raiz, 'R12', async (port, db) => {
        const tj = sembrarTarjeta(raiz, db, 'R12 VISA BANCOLOMBIA', 'Bancolombia', 'Visa', 1, 0.021155);
        const { calcExtracto } = require(path.join(raiz, 'backend', 'engine', 'extracto.js'));
        const e = calcExtracto(db, tj, '2029-02', false);
        A(e && e.fechaPago === '2029-03-20', '[FECHA/EXTRACTO]: el extracto de febrero-2029 vence el ' + (e && e.fechaPago) + '; esperado 2029-03-20 (28-feb + 17 = sabado 17; lunes 19 es San Jose)');

        // ── (2) Reprogramar uniforme limpia el calendario irregular y conserva la numeracion del banco. ──
        const d3 = db.prepare(`INSERT INTO diferidas (tarjeta_id, etiqueta, monto, tasa_mv, num_cuotas, fecha_compra, fecha_primer_corte, estado, notas, sin_gracia_cuota1, reprog_total)
                               VALUES (?,?,10000,0.021852,2,'2029-05-30','2029-06-30','activo','Saldo reprogramado (36->3)',1,3)`).run(tj, 'R12 HIJA').lastInsertRowid;
        db.prepare('INSERT INTO capital_cuotas (diferida_id, cuota_num, capital) VALUES (?,1,5200),(?,2,4800)').run(d3, d3);
        db.prepare("INSERT INTO compras (tarjeta_id, fecha, descripcion, valor_cop, estado, ciclo, diferida_id, ciclo_manual, notas) VALUES (?, '2029-05-20', 'R12 HIJA', 10000, 'diferida', '2029-06', ?, 1, 'Diferida a 2 cuotas | Saldo reprogramado 36->3')").run(tj, d3);
        const antes = tabla(raiz, db, d3);
        A(antes[0] && casi(antes[0].cuotaCapital, 5200), '[SANIDAD/ANTES]: la hija sembrada no factura 5.200 en su cuota 1 (' + (antes[0] && antes[0].cuotaCapital) + ')');
        const rp = await pedir(port, 'POST', '/api/diferidas/' + d3 + '/reprogramar', { num_cuotas: 1 });
        A(rp.s === 200, '[REPROGRAMAR]: el endpoint respondio ' + rp.s + ' ' + JSON.stringify(rp.j));
        const mapa = db.prepare('SELECT COUNT(*) n FROM capital_cuotas WHERE diferida_id=?').get(d3).n;
        const fila = db.prepare('SELECT num_cuotas, reprog_total FROM diferidas WHERE id=?').get(d3);
        const despues = tabla(raiz, db, d3);
        cifras.reprogramar = 'mapa=' + mapa + ' cuota1=' + (despues[0] && despues[0].cuotaCapital) + ' reprog_total=' + fila.reprog_total;
        A(mapa === 0, '[MAPA]: quedaron ' + mapa + ' filas del calendario irregular viejo tras una reprogramacion uniforme');
        A(despues[0] && casi(despues[0].cuotaCapital, 10000), '[CAPITAL]: la cuota unica factura ' + (despues[0] && despues[0].cuotaCapital) + ' en vez del saldo completo (10.000): manda la cuota del plan viejo');
        A(fila.reprog_total === 2, '[NUMERACION]: reprog_total=' + fila.reprog_total + '; esperado 2 (1 sellada + 1 que queda: el banco la factura "2/2", no "1/1")');

        // ── (3) Convertir a cuotas con la tasa del MES de la compra, no la vigente de la tarjeta. ──
        const insC = db.prepare("INSERT INTO compras (tarjeta_id, fecha, descripcion, valor_cop, estado, ciclo, tasa_intl) VALUES (?,?,?,12000,'pendiente',?,?)");
        const cMes = insC.run(tj, '2029-07-10', 'R12 CONVERTIBLE', '2029-07', 0.021593).lastInsertRowid;
        const cSin = insC.run(tj, '2029-09-10', 'R12 SIN TASA', '2029-09', null).lastInsertRowid;
        const convertir = async (id) => {
          const r = await pedir(port, 'POST', '/api/compras/' + id + '/convertir-a-diferida', { num_cuotas: 36, cobrar_intereses: true });
          const d = r.j && r.j.diferida_id ? db.prepare('SELECT tasa_mv FROM diferidas WHERE id=?').get(r.j.diferida_id) : null;
          return d ? d.tasa_mv : null;
        };
        const tMes = await convertir(cMes), tSin = await convertir(cSin);
        cifras.tasas = 'del mes=' + tMes + ' sin dato=' + tSin;
        A(tSin === 0.021155, '[TASA/PAR]: sin tasa del mes conocida la conversion no cae a la de la tarjeta (' + tSin + ')');
        A(tMes === 0.021593, '[TASA]: la compra de julio se convirtio a ' + tMes + ' y no a la de su mes (0.021593): tomo la vigente de la tarjeta');

        // ── (4) Un reverso de un comercio de MERCADO PAGO ya no se descarta como si fuera un pago. ──
        const cRev = db.prepare("INSERT INTO compras (tarjeta_id, fecha, descripcion, valor_cop, estado, ciclo) VALUES (?, '2029-08-16', 'MERCADO PAGO*FARMACIA R12', 51300, 'pendiente', '2029-08')").run(tj).lastInsertRowid;
        const ia = require(path.join(raiz, 'backend', 'routes', 'ia.js'));
        const rev = ia.detectarReversos(db, '16/08/2029  MERCADO PAGO*FARMACIA R12   $ -51.300,00', tj);
        A(rev.some(x => x.compra_id === cRev), '[REVERSO]: el reverso de "MERCADO PAGO*FARMACIA" se descarto (' + rev.length + ' detectados) -> la palabra PAGO dentro del nombre del comercio lo hace pasar por un pago');
        const pago = ia.detectarReversos(db, '16/08/2029  PAGO PSE BANCOLOMBIA   $ -51.300,00', tj);
        A(pago.length === 0, '[REVERSO/PAR]: una linea de PAGO del usuario se tomo como reverso de un comercio');
      });
    } catch (e) {
      return resultado(false, cifras, ['FALLO ejecutando el escenario: ' + e.message]);
    }
    return resultado(notas.length === 0, cifras, notas);
  },
  defecto: 'el detector de reversos vuelve a tratar como PAGO cualquier concepto que contenga la palabra (el reverso de MERCADO PAGO*... se pierde)',
  mutar(raiz) {
    const p = path.join(raiz, 'backend', 'routes', 'ia', '_detectores.js');
    const src = leer(p);
    const aguja = 'return /^(ABONOS?|PAGOS?)\\b/i.test(t) || /\\b(SU PAGO|SALDO A FAVOR|A FAVOR)\\b/i.test(t);';
    if (src.indexOf(aguja) === -1) throw new Error('no se encontro esConceptoDePago');
    fs.writeFileSync(p, src.replace(aguja, 'return /\\b(ABONOS?|PAGOS?|SU PAGO|SALDO A FAVOR|A FAVOR)/i.test(t);'), 'utf8');
  },
};

module.exports = [R11, R12];
