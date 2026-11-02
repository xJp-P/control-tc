'use strict';
// verificacion/detectores/ia_contexto.js — R13: lo que la IA de conciliacion VE
//
// POR QUE EXISTE: R7 comprueba que cada bloque del handler deja huella, pero no QUE informacion le
// llega al modelo. La conciliacion de septiembre-2026 fallo justo ahi, sin un solo error de codigo:
//   - el documento de reglas del banco se cortaba a ciegas en 16.000 caracteres, y la IA nunca habia
//     leido la cuota facturada hasta el pago, la formula del pago minimo ni la fecha limite de la Visa
//     (ni el 61% de las reglas de RappiCard);
//   - el interes de la app le llegaba como un numero por cuota, sin causas, y atribuyo una diferencia
//     de decenas de miles a un "revolving" que no existe;
//   - la severidad la ponia el modelo a ojo (esa diferencia salio BAJA).
// Desde la Fase C (oct-2026) el documento va completo salvo sus secciones de consulta, el interes viaja
// con su DESGLOSE por causa, y lo aritmetico lo hace el backend: la diferencia de intereses contra el
// extracto, la severidad por monto y las fechas corridas junto al corte. R13 vigila las cinco cosas.
//
// Todo lo que depende de datos se SIEMBRA (criterio de R6/R8/R11) en una tarjeta propia y en 2029; lo
// demas usa los documentos reales de docs/bancos y las funciones del arbol que se mide (`raiz`), para
// que el control negativo las alcance.
const fs = require('fs');
const path = require('path');
const { conApp, pedir, resultado, leer } = require('../lib');
const { sembrarTarjeta, sembrarDiferida } = require('./bancolombia');

const DOCS = ['Bancolombia_Visa', 'Bancolombia_Mastercard', 'Bancolombia_Amex', 'Nu_Mastercard', 'RappiCard_Visa'];
// Secciones que la IA TIENE que leer, por documento (las que el corte de 16.000 se comia).
const CLAVE = {
  Bancolombia_Visa: ['### 6.4 La cuota facturada devenga hasta el día del pago', '## 7. Cálculo del Pago Mínimo', '### 7.5 Fecha límite de pago'],
  RappiCard_Visa: ['### 4.3.1 La fórmula COMPLETA', '## 6. Cálculo del Pago Mínimo', '## 7. Fecha de pago'],
};
const pesos = (n) => '$ ' + Number(n).toLocaleString('es-CO', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const R13 = {
  id: 'R13',
  nombre: 'Lo que la IA ve: reglas completas, interes con desglose, severidad por monto y fechas en el borde',
  async medir(raiz) {
    const notas = [];
    const cifras = {};
    let total = 0, ok = 0;
    const chk = (nombre, cond, detalle) => { total++; if (cond) ok++; else notas.push('FALLO [' + nombre + ']: ' + detalle); };
    const req = (rel) => require(path.join(raiz, rel));

    // ── (A) Las reglas del banco llegan ENTERAS al prompt ────────────────────────────────────────────
    try {
      const { construirPrompt } = req('backend/routes/ia/_prompt.js');
      const { reglasParaPrompt } = req('backend/services/movimientos.js');
      let reglasVistas = 0;
      for (const nombre of DOCS) {
        const p = path.join(raiz, 'docs', 'bancos', nombre + '.md');
        if (!fs.existsSync(p)) { chk('documento ' + nombre, false, 'no existe ' + p); continue; }
        const doc = leer(p);
        const mv = { tarjeta: { banco: nombre.split('_')[0], franquicia: nombre.split('_')[1] }, ciclo: '2029-01', banco_doc: nombre, compras: [], diferidas: [], avances: [] };
        const { user } = construirPrompt(mv, '', doc, null, null, null);
        const { omitidas } = reglasParaPrompt(doc);
        // Todo encabezado que NO sea de una seccion de consulta tiene que llegar; y la ultima linea de
        // reglas tambien, que es lo primero que se pierde con un recorte por tamano.
        const lineas = String(doc).split(/\r?\n/);
        let enConsulta = false, ultimaRegla = '';
        const faltan = [];
        lineas.forEach(l => {
          if (/^##\s/.test(l)) enConsulta = omitidas.indexOf(l.replace(/^##\s+/, '').trim()) !== -1;
          if (enConsulta) return;
          if (/^#{2,4}\s/.test(l) && user.indexOf(l.trim()) === -1) faltan.push(l.trim().slice(0, 60));
          if (l.trim()) ultimaRegla = l.trim();
        });
        chk(nombre + ': todas las secciones de reglas llegan al prompt', faltan.length === 0, faltan.length + ' encabezado(s) no llegan, p.ej. "' + faltan[0] + '" -> la IA concilia sin esas reglas');
        chk(nombre + ': llega hasta la ultima linea de reglas', !!ultimaRegla && user.indexOf(ultimaRegla) !== -1, 'falta "' + ultimaRegla.slice(0, 60) + '" -> el documento se esta recortando');
        (CLAVE[nombre] || []).forEach(k => chk(nombre + ': ve "' + k.slice(0, 40) + '"', user.indexOf(k) !== -1, 'no esta en el prompt'));
        if (omitidas.length) chk(nombre + ': nombra las secciones de consulta que omite', omitidas.every(o => user.indexOf(o) !== -1), 'omite sin decirlo: ' + omitidas.join(' | '));
        reglasVistas++;
      }
      cifras.documentos = reglasVistas;
    } catch (e) { chk('reglas del banco', false, 'excepcion: ' + e.message); }

    // ── (D) Severidad por monto y reemplazo del item de intereses de la IA (funciones puras) ─────────
    try {
      const D = req('backend/routes/ia/_detectores.js');
      const casos = [[25000, 'alta'], [20001, 'alta'], [20000, 'media'], [2000, 'media'], [1999, 'baja'], [-54000, 'alta']];
      casos.forEach(([m, s]) => chk('severidad de ' + m, D.severidadPorMonto(m) === s, 'da ' + D.severidadPorMonto(m) + ', esperado ' + s + ' (ALTA > 20.000, MEDIA 2.000-20.000, BAJA < 2.000)'));
      const ds = [
        { tipo: 'otro', impacto_pago_minimo: -54000, severidad: 'baja' },
        { tipo: 'monto_erroneo', impacto_pago_minimo: 1500, severidad: 'alta' },
        { tipo: 'clasificacion_incorrecta', impacto_pago_minimo: 90000, severidad: 'baja', posible_falso_positivo: true },
        { tipo: 'pago_minimo_oficial', impacto_pago_minimo: 0, severidad: 'media' },
      ];
      D.calibrarSeveridad(ds);
      chk('una diferencia de decenas de miles calificada BAJA por la IA pasa a ALTA', ds[0].severidad === 'alta' && ds[0].severidad_ia === 'baja', JSON.stringify(ds[0]));
      chk('una de 1.500 calificada ALTA pasa a BAJA', ds[1].severidad === 'baja', JSON.stringify(ds[1]));
      chk('un posible falso positivo sigue en baja', ds[2].severidad === 'baja', JSON.stringify(ds[2]));
      chk('sin impacto en dinero conserva su severidad', ds[3].severidad === 'media', JSON.stringify(ds[3]));

      const resu = { discrepancias: [
        { tipo: 'otro', descripcion: 'intereses mayores (revolving)', valor_extracto: 123457, valor_app: 69457, impacto_pago_minimo: -54000, severidad: 'baja', accion_sugerida: { operacion: 'ninguna', parametros: {} } },
        { tipo: 'compra_omitida', valor_extracto: 123458, valor_app: 0, impacto_pago_minimo: -123458, severidad: 'alta', accion_sugerida: { operacion: 'crear_compra', parametros: {} } },
      ] };
      const mv = { desglose_intereses: { total_app: 123500, componentes: { periodo: 100000, cuota_facturada_hasta_pago: 23500 } } };
      const ci = D.conciliarIntereses(resu, mv, 123456.78);
      const it = resu.discrepancias.find(d => d.tipo === 'intereses_corrientes');
      chk('el item de intereses de la IA se reemplaza por el del backend', !!ci && ci.reemplazo_ia === 1 && !resu.discrepancias.some(d => d.tipo === 'otro'), JSON.stringify(resu.discrepancias.map(d => d.tipo)));
      chk('nunca se descarta una discrepancia ACCIONABLE aunque coincida el monto', resu.discrepancias.some(d => d.tipo === 'compra_omitida'), 'se perdio la compra_omitida');
      chk('la diferencia de intereses sale de la aritmetica', !!it && it.impacto_pago_minimo === 43 && it.severidad === 'baja' && /periodo/.test(it.descripcion),
        JSON.stringify(it && { impacto: it.impacto_pago_minimo, sev: it.severidad, desc: it.descripcion }));

      // (G) Corte del banco distinto al de la app (oct-2026: cortó el 31). Primero se descuentan los
      // dias de periodo y SOLO despues se lee el resto; sin eso, el resto "parecia" el desfase del intl.
      const mvC = { desglose_intereses: { total_app: 100000, corte: '2026-10-30', corte_anterior: '2026-09-30',
        componentes: { periodo: 30000 }, intl_desfase: { de_este_ciclo_segun_app: 3000, del_ciclo_anterior: 0 },
        cuota_facturada: { devenga_hasta: '2026-10-16', abonos_al_extracto_anterior: [{ fecha: '2026-10-03', monto: 1 }] } } };
      const rC = { discrepancias: [] };
      const cC = D.conciliarIntereses(rC, mvC, 98000, '2026-10-31');
      const iC = rC.discrepancias[0] || {};
      chk('con el corte del banco un dia despues, descuenta ese dia de periodo', !!cC && cC.ajuste_corte === 1000 && cC.resto === -3000,
        JSON.stringify(cC) + ' (esperado ajuste 1000 = 30000 x 1/30 y resto -3000)');
      chk('y atribuye el resto a los abonos, no al desfase del intl', /corto el 2026-10-31/.test(iC.descripcion || '') && /abonos/.test(iC.descripcion || '') && !/desfase del intl/.test(iC.descripcion || ''),
        iC.descripcion);
      chk('el impacto en el pago minimo sigue siendo app - banco', iC.impacto_pago_minimo === 2000, 'impacto=' + iC.impacto_pago_minimo);
      const rC2 = { discrepancias: [] };
      const cC2 = D.conciliarIntereses(rC2, mvC, 98000, '2026-10-30');
      chk('con el mismo corte no ajusta nada (par)', !!cC2 && cC2.ajuste_corte === 0 && !/corto el/.test(rC2.discrepancias[0].descripcion), JSON.stringify(cC2));
    } catch (e) { chk('severidad e intereses', false, 'excepcion: ' + e.message); }

    // ── (B)(C)(E) Escenario sembrado: Visa Bancolombia con TODAS las causas de interes en 2029-02 ─────
    try {
      await conApp(raiz, 'R13', async (port, db) => {
        const T = sembrarTarjeta(raiz, db, 'R13 VISA', 'Bancolombia', 'Visa', 1, 0.02);
        const C = '2029-02', CORTE = '2029-02-28';
        sembrarDiferida(db, T, 'R13 TRES CUOTAS', 300000, 0.02, 3, '2029-01-15', '2029-01-30');  // cuota 2: diferido de la 1 + cuota facturada
        sembrarDiferida(db, T, 'R13 UNA CUOTA', 100000, 0.02, 1, '2028-12-20', '2029-01-30');     // termina en enero: cola en febrero
        const hija = sembrarDiferida(db, T, 'R13 HIJA', 30000, 0.02, 3, '2029-01-30', CORTE);      // hija de Sellar y Renacer: arrastre
        db.prepare('UPDATE diferidas SET sin_gracia_cuota1=1, reprog_total=4, interes_arrastrado=500, capital_facturado_previo=10000 WHERE id=?').run(hija);
        const irregular = sembrarDiferida(db, T, 'R13 IRREGULAR', 10000, 0.02, 2, '2029-02-05', CORTE);
        db.prepare('INSERT INTO capital_cuotas (diferida_id, cuota_num, capital) VALUES (?,1,6000),(?,2,4000)').run(irregular, irregular);
        db.prepare("INSERT INTO avances (tarjeta_id, etiqueta, monto, tasa_mv, plazo, fecha_desembolso, dia_corte, estado) VALUES (?, 'R13 AVANCE', 1000000, 0.02, 10, '2028-12-05', 30, 'activo')").run(T);
        const compra = (fecha, desc, valor, intl) => db.prepare("INSERT INTO compras (tarjeta_id, fecha, descripcion, valor_cop, estado, ciclo, es_internacional, tasa_intl) VALUES (?,?,?,?, 'pendiente', ?, ?, ?)")
          .run(T, fecha, desc, valor, C, intl ? 1 : 0, intl ? 0.02 : null).lastInsertRowid;
        compra('2029-02-10', 'R13 INTERNACIONAL', 80000, true);
        const enBorde = compra('2029-02-27', 'R13 BORDE', 50000, false);       // el banco la trae el 28 (dia del corte)
        const enMedio = compra('2029-02-12', 'R13 MITAD', 40000, false);       // el banco la trae el 13: lejos del corte
        // (F) Clasificacion: lo que el banco imprime al 0% o con tasa, contra lo que dice la app.
        const cero = compra('2029-02-15', 'R13 COBRA CERO', 40000, true);      // intl en la app, 0% en el banco
        const olvidada = compra('2029-02-17', 'R13 OLVIDADA', 50000, false);   // nacional en la app, con tasa en el banco
        const parte = (valor) => db.prepare("INSERT INTO compras (tarjeta_id, fecha, descripcion, valor_cop, estado, ciclo, es_internacional, tasa_intl, grupo_id) VALUES (?, '2029-02-16', 'R13 DIVIDIDA CERO', ?, 'pendiente', ?, 1, 0.02, 'r13-grupo')")
          .run(T, valor, C).lastInsertRowid;
        const partesCero = [parte(15000), parte(15000)];                       // dividida: UNA linea de 30.000 en el banco
        // Candado del endpoint: un ciclo PAGADO no se reclasifica.
        const enPagado = db.prepare("INSERT INTO compras (tarjeta_id, fecha, descripcion, valor_cop, estado, ciclo, es_internacional, tasa_intl) VALUES (?, '2029-01-10', 'R13 PAGADA', 20000, 'pagado', '2029-01', 1, 0.02)").run(T).lastInsertRowid;
        db.prepare("INSERT INTO extractos (tarjeta_id, ciclo, fecha_corte, fecha_pago, pago_minimo, pago_total, estado, monto_pagado, fecha_pagado) VALUES (?, '2029-01', '2029-01-30', '2029-02-16', 1, 1, 'pagado', 1, '2029-02-11')").run(T);
        // (H) Plan NUEVO y dividido que el banco fecha 3 dias despues; la hija (fecha del corte a proposito) no avisa.
        const planParte = (monto, desc) => {
          const d = sembrarDiferida(db, T, desc, monto, 0.02, 3, '2029-02-05', CORTE);
          return db.prepare("INSERT INTO compras (tarjeta_id, fecha, descripcion, valor_cop, estado, ciclo, diferida_id, grupo_id, notas) VALUES (?, '2029-02-05', ?, ?, 'diferida', ?, ?, 'r13-plan', 'Diferida a 3 cuotas')")
            .run(T, desc, monto, C, d).lastInsertRowid;
        };
        const partesPlan = [planParte(60000, 'R13 PLAN DIVIDIDO'), planParte(30000, 'R13 PLAN DIVIDIDO')];
        db.prepare("INSERT INTO compras (tarjeta_id, fecha, descripcion, valor_cop, estado, ciclo, diferida_id, notas) VALUES (?, '2029-01-30', 'R13 HIJA', 30000, 'diferida', ?, ?, 'saldo reprogramado')").run(T, C, hija);
        const compraIrr = db.prepare("INSERT INTO compras (tarjeta_id, fecha, descripcion, valor_cop, estado, ciclo, diferida_id, notas) VALUES (?, '2029-02-05', 'R13 IRREGULAR', 10000, 'diferida', ?, ?, 'Diferida a 2 cuotas')").run(T, C, irregular).lastInsertRowid;
        // (I) Reversos: uno ya aplicado en la app (aviso BAJA) y su par sin aplicar (ALTA).
        const reversada = db.prepare("INSERT INTO compras (tarjeta_id, fecha, descripcion, valor_cop, estado, ciclo, reversada) VALUES (?, '2029-02-12', 'R13 REVERSADA', 12345, 'pendiente', ?, 1)").run(T, C).lastInsertRowid;
        const porReversar = db.prepare("INSERT INTO compras (tarjeta_id, fecha, descripcion, valor_cop, estado, ciclo) VALUES (?, '2029-02-13', 'R13 POR REVERSAR', 23456, 'pendiente', ?)").run(T, C).lastInsertRowid;
        require(path.join(raiz, 'backend', 'helpers', 'banco.js')).clearBancoCache();

        // (B) El desglose: cada causa presente y el total al peso con el interes del pago minimo.
        const rm = await pedir(port, 'GET', '/api/ia/movimientos?tarjeta_id=' + T + '&ciclo=' + C, null, 20000);
        const mv = rm.j || {};
        const dg = mv.desglose_intereses || {};
        const c = dg.componentes || {};
        const { calcExtracto } = require(path.join(raiz, 'backend', 'engine', 'extracto.js'));
        const calc = calcExtracto(db, T, C, false);
        cifras.desglose = dg.total_app + ' vs motor ' + (calc && calc.cuotasInteres);
        chk('el desglose suma EXACTO el interes del pago minimo', rm.s === 200 && dg.total_app === calc.cuotasInteres,
          'desglose ' + dg.total_app + ' y el motor cobra ' + (calc && calc.cuotasInteres) + ' -> la IA recibiria un total que no es el de la app');
        [['periodo', 'el saldo por dias'], ['cuota_facturada_hasta_pago', 'la cuota de enero hasta su pago'], ['interes_cuota1_diferido', 'el diferido de la cuota 1 en la cuota 2'],
          ['arrastre_reprogramacion', 'el arrastre de la hija'], ['cola_ultima_cuota', 'la ultima cuota del plan que termino en enero'], ['intl_compras_1_1', 'la compra internacional']]
          .forEach(([k, que]) => chk('el desglose trae ' + k, Number(c[k]) > 0, k + '=' + c[k] + ' (sembrado: ' + que + ') -> esa causa no le llega a la IA'));
        const { construirPrompt } = req('backend/routes/ia/_prompt.js');
        const pr = construirPrompt(mv, '', null, null, null, null);
        chk('el desglose viaja DENTRO del prompt', pr.user.indexOf('"total_app": ' + dg.total_app) !== -1 && pr.user.indexOf('"cola_ultima_cuota"') !== -1,
          'el JSON del prompt no trae desglose_intereses -> la IA vuelve a ver solo un interes por cuota');
        const planIrr = (dg.planes || []).find(p => p.etiqueta === 'R13 IRREGULAR');
        chk('el calendario irregular viaja tal cual', !!planIrr && JSON.stringify(planIrr.calendario_capital) === '[6000,4000]',
          'calendario=' + JSON.stringify(planIrr && planIrr.calendario_capital) + ' -> la IA tendria que suponer el reparto');
        const planHija = (dg.planes || []).find(p => p.etiqueta === 'R13 HIJA');
        chk('la hija se numera como el banco (selladas + nuevas)', !!planHija && planHija.cuota === '2/4', 'cuota=' + (planHija && planHija.cuota));

        // (C) El cargo del banco contra el desglose, por el handler REAL (proveedor mock).
        const bancoCobra = Math.round(dg.total_app) + 25000;
        const linea = (fecha, desc, valor, tasa, cuotas, capital) => fecha.slice(8, 10) + '/' + fecha.slice(5, 7) + '  ' + desc + '   $' + Math.round(valor).toLocaleString('es-CO')
          + '   ' + (cuotas || '1/1') + (capital ? '   $' + Math.round(capital).toLocaleString('es-CO') : '') + '   ' + (tasa || '0,0000') + '%';
        const texto = ['EXTRACTO SINTETICO R13', '+ Intereses corrientes ' + pesos(bancoCobra),
          linea('2029-02-28', 'R13 BORDE', 50000), linea('2029-02-13', 'R13 MITAD', 40000),
          linea('2029-02-10', 'R13 INTERNACIONAL', 80000, '2,0000'), linea('2029-02-15', 'R13 COBRA CERO', 40000),
          linea('2029-02-17', 'R13 OLVIDADA', 50000, '2,0000'), linea('2029-02-16', 'R13 DIVIDIDA CERO', 30000),
          linea('2029-02-08', 'R13 PLAN DIVIDIDO', 90000, '2,0000', '1/3', 30000), linea('2029-02-07', 'R13 IRREGULAR', 10000, '2,0000', '1/2', 6000),
          linea('2029-01-26', 'R13 HIJA', 30000, '2,0000', '2/4', 10000),
          '20/02/2029  R13 REVERSADA   $ -12.345,00', '21/02/2029  R13 POR REVERSAR   $ -23.456,00',
          '28/02/2029 INTERESES CORRIENTES ' + pesos(bancoCobra) + ' ' + pesos(bancoCobra) + ' $ 0,00'].join('\n');
        const r = await pedir(port, 'POST', '/api/ia/analizar', { provider: 'mock', movimientos: mv, texto_redactado: texto }, 30000);
        const R = (r.j && r.j.resultado) || {};
        const it = (R.discrepancias || []).find(d => d.tipo === 'intereses_corrientes');
        cifras.intereses = it ? (it.impacto_pago_minimo + ' ' + it.severidad) : 'sin item';
        chk('el backend concilia el cargo de intereses del extracto', !!it, 'no hay item intereses_corrientes; tipos=' + JSON.stringify((R.discrepancias || []).map(d => d.tipo)));
        chk('con su diferencia exacta y severidad por monto', !!it && it.impacto_pago_minimo === -25000 && it.severidad === 'alta' && it.valor_app === dg.total_app,
          JSON.stringify(it && { impacto: it.impacto_pago_minimo, sev: it.severidad, app: it.valor_app }) + ' (esperado -25000, alta, ' + dg.total_app + ')');
        // Par: si el texto trae DOS cifras de intereses distintas, no se concilia contra ninguna.
        const r2 = await pedir(port, 'POST', '/api/ia/analizar', { provider: 'mock', movimientos: mv,
          texto_redactado: texto + '\n+ Intereses corrientes ' + pesos(bancoCobra + 1000) }, 30000);
        const R2 = (r2.j && r2.j.resultado) || {};
        chk('con dos cifras de intereses distintas no inventa la diferencia', !(R2.discrepancias || []).some(d => d.tipo === 'intereses_corrientes'), 'concilio contra una de las dos');

        // (E) Fecha corrida: solo la del borde del corte.
        const corr = (R.discrepancias || []).filter(d => d.tipo === 'fecha_corrida');
        chk('avisa la compra con la fecha corrida junto al corte', corr.some(d => Number(d.compra_id) === Number(enBorde)),
          'sin aviso para la compra del ' + '2029-02-27 que el banco trae el 28 (dia del corte); avisos=' + JSON.stringify(corr.map(d => d.compra_id)));
        chk('no avisa una fecha corrida lejos del corte', !corr.some(d => Number(d.compra_id) === Number(enMedio)), 'aviso tambien la del 12-feb (ruido)');

        // (F) Clasificacion contra la tasa que imprime el banco en cada linea.
        const clas = (R.discrepancias || []).filter(d => d.tipo === 'clasificacion_incorrecta' && d.determinista);
        const deIds = ids => clas.find(d => JSON.stringify((d.compra_ids || []).map(Number).sort()) === JSON.stringify(ids.map(Number).sort()));
        const dCero = deIds([cero]), dDiv = deIds(partesCero), dOlv = deIds([olvidada]);
        cifras.clasificaciones = clas.length;
        chk('la compra que el banco cobra al 0% se propone marcar nacional', !!dCero && dCero.accion_sugerida.operacion === 'marcar_nacional' && dCero.impacto_pago_minimo > 0,
          JSON.stringify(dCero || clas.map(d => d.compra_ids)));
        chk('una compra DIVIDIDA al 0% se detecta sumando sus partes y se corrigen las dos', !!dDiv && dDiv.accion_sugerida.parametros.compra_ids.length === 2,
          'sin aviso para las partes ' + JSON.stringify(partesCero) + ' (una linea de 30.000 en el banco)');
        chk('la que el banco cobra con tasa y la app tiene nacional se propone marcar internacional', !!dOlv && dOlv.accion_sugerida.operacion === 'marcar_internacional'
          && Math.abs(dOlv.accion_sugerida.parametros.tasa_intl - 0.02) < 1e-9 && dOlv.impacto_pago_minimo < 0, JSON.stringify(dOlv || null));
        chk('una internacional que el banco tambien cobra con tasa no se toca (par)', clas.length === 3, 'avisos=' + JSON.stringify(clas.map(d => d.compra_ids)));
        // El endpoint de la accion: corrige TODAS las partes, y no toca un ciclo pagado.
        const rx = await pedir(port, 'POST', '/api/compras/clasificar-intl', { tarjeta_id: T, ciclo: C, compra_ids: partesCero, es_internacional: 0 });
        const quedan = db.prepare('SELECT COUNT(*) n FROM compras WHERE id IN (?,?) AND es_internacional=1').get(partesCero[0], partesCero[1]).n;
        chk('marcar nacional corrige las partes', rx.s === 200 && quedan === 0, 'status=' + rx.s + ' ' + rx.b.slice(0, 90) + ' · quedan intl ' + quedan);
        const ry = await pedir(port, 'POST', '/api/compras/clasificar-intl', { tarjeta_id: T, ciclo: C, compra_ids: [olvidada], es_internacional: 1, tasa_intl: 0.02 });
        const ol = db.prepare('SELECT es_internacional e, tasa_intl t FROM compras WHERE id=?').get(olvidada);
        chk('marcar internacional fija la tasa del extracto', ry.s === 200 && ol.e === 1 && Math.abs(ol.t - 0.02) < 1e-9, JSON.stringify(ol));
        const rz = await pedir(port, 'POST', '/api/compras/clasificar-intl', { tarjeta_id: T, ciclo: '2029-01', compra_ids: [enPagado], es_internacional: 0 });
        chk('no reclasifica en un ciclo pagado', rz.s === 403 && db.prepare('SELECT es_internacional e FROM compras WHERE id=?').get(enPagado).e === 1, 'status=' + rz.s);

        // (H) Plan nuevo con la fecha corrida: el aviso trae el efecto del mes siguiente.
        const planes = corr.filter(d => /Plan nuevo/.test(d.descripcion || ''));
        const pDiv = planes.find(d => (d.compra_ids || []).map(Number).sort().join() === partesPlan.map(Number).sort().join());
        chk('avisa el plan nuevo DIVIDIDO que el banco fecha 3 dias despues, con el efecto del mes siguiente', !!pDiv && pDiv.efecto_mes_siguiente === -180,
          JSON.stringify(pDiv || planes.map(d => d.compra_ids)) + ' (esperado 90.000 x 2% x 3/30 = 180)');
        chk('y el plan nuevo suelto con 2 dias de diferencia', planes.some(d => Number(d.compra_id) === Number(compraIrr)), 'sin aviso para R13 IRREGULAR');
        chk('una hija de reprogramacion no avisa aunque su fecha difiera (par)', !planes.some(d => /HIJA/.test(d.descripcion || '')), 'aviso la hija');

        // (J) El asistente que sugiere "internacional" al registrar: manda la ULTIMA clasificacion del
        // comercio. Una marca vieja corregida a nacional deja de sugerirse; una nacional vieja que el banco
        // empezo a cobrar como intl (la mas reciente marcada) si se sugiere.
        const sembrarSug = (desc, fecha, intl) => db.prepare("INSERT INTO compras (tarjeta_id, fecha, descripcion, valor_cop, estado, ciclo, es_internacional) VALUES (?, ?, ?, 1000, 'pendiente', ?, ?)").run(T, fecha, desc, C, intl ? 1 : 0);
        sembrarSug('R13 CORREGIDA A NACIONAL', '2029-02-01', true); sembrarSug('R13 CORREGIDA A NACIONAL', '2029-02-20', false);
        sembrarSug('R13 AHORA INTERNACIONAL', '2029-02-01', false); sembrarSug('R13 AHORA INTERNACIONAL', '2029-02-20', true);
        const sug = ((await pedir(port, 'GET', '/api/compras/intl-descripciones')).j) || [];
        chk('el asistente deja de sugerir intl a un comercio cuya ultima compra se corrigio a nacional', Array.isArray(sug) && sug.indexOf('r13 corregida a nacional') === -1,
          'lo sigue sugiriendo -> una marca equivocada se propaga a todas las compras siguientes');
        chk('y sugiere el que ahora el banco cobra como internacional (par)', Array.isArray(sug) && sug.indexOf('r13 ahora internacional') !== -1, 'no lo sugiere');

        // (I) Reverso ya aplicado: aviso BAJA; el que falta aplicar sigue ALTA.
        const rev = (R.discrepancias || []).filter(d => d.tipo === 'reverso_detectado');
        const rA = rev.find(d => Number(d.compra_id) === Number(reversada)), rB = rev.find(d => Number(d.compra_id) === Number(porReversar));
        chk('un reverso que la app ya aplico sale en BAJA', !!rA && rA.ya_aplicado && rA.severidad === 'baja', JSON.stringify(rA || rev.map(d => d.compra_id)));
        chk('el que falta aplicar sigue en ALTA (par)', !!rB && !rB.ya_aplicado && rB.severidad === 'alta', JSON.stringify(rB || null));
      });
    } catch (e) { chk('escenario sembrado', false, 'excepcion: ' + e.message); }

    const PISO = 62;
    if (total < PISO) notas.push('FALLO: solo se ejecutaron ' + total + ' asertos, piso ' + PISO + ' -> el detector dejo de mirar');
    cifras.asertos = total;
    return resultado(ok === total && total >= PISO, cifras, notas);
  },
  defecto: 'vuelve el recorte ciego del documento del banco a 16.000 caracteres (la IA deja de ver la cuota facturada hasta el pago, el pago minimo y la fecha limite)',
  mutar(raiz) {
    const p = path.join(raiz, 'backend', 'routes', 'ia', '_prompt.js');
    const src = leer(p);
    const aguja = '(reglas.texto || ';
    if (src.indexOf(aguja) === -1) throw new Error('no se encontro el uso de las reglas del banco en _prompt.js');
    fs.writeFileSync(p, src.replace(aguja, '(reglas.texto.slice(0, 16000) || '), 'utf8');
  },
};

module.exports = [R13];
