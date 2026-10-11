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
        const linea = (fecha, desc, valor) => fecha.slice(8, 10) + '/' + fecha.slice(5, 7) + '  ' + desc + '   $' + Math.round(valor).toLocaleString('es-CO') + '   1/1   0,0000%';
        const texto = ['EXTRACTO SINTETICO R13', '+ Intereses corrientes ' + pesos(bancoCobra),
          linea('2029-02-28', 'R13 BORDE', 50000), linea('2029-02-13', 'R13 MITAD', 40000),
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
      });
    } catch (e) { chk('escenario sembrado', false, 'excepcion: ' + e.message); }

    const PISO = 45;
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
