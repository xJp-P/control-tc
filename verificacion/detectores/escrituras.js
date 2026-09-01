'use strict';
// verificacion/detectores/escrituras.js — R6
//
// POR QUE EXISTE: los otros trece detectores solo LEEN. Una prueba de mutacion sobre el codigo
// real lo demostro: cambiar `nuevoMontoPagado >= minimoRef` por `>` en el sellado del extracto
// sobrevivio a la suite entera en verde. Ese operador decide si un mes queda pagado o se queda
// como abono parcial — con `>`, pagar el minimo EXACTO ya no cerraria el mes, la deuda y el cupo
// quedarian inflados y la triada del blindaje no se formaria.
//
// Cada aserto corre sobre su PROPIA copia de la BD: son escrituras, y compartir copia haria que
// el resultado de una dependiera del orden de la anterior.

const fs = require('fs');
const path = require('path');
// `pedir` y `conApp` viven ahora en lib.js: R7 (conciliacion) tambien ejecuta handlers y tener dos
// copias del andamiaje HTTP es la via mas comoda para que se separen sin que nadie lo note.
const { resultado, leer, pedir, conApp } = require('../lib');

const R6 = {
  id: 'R6',
  nombre: 'Invariantes de ESCRITURA (sellado del extracto y candados)',
  async medir(raiz, ctx) {
    const notas = [];
    let ok = 0, total = 0, caducados = 0;
    const chk = (nombre, cond, detalle) => {
      total++;
      if (cond) ok++;
      else notas.push('FALLO [' + nombre + ']: ' + detalle);
    };
    // AUTODIAGNOSTICO (item D2). R6 no tiene una referencia que caduque: lo que se le agota son las
    // PRECONDICIONES. Cuando la BD deja de tener un caso con la forma que un invariante necesita, el
    // codigo puede estar perfecto y el detector gritaba igual "FALLO [cifra oficial]: no hay ningun
    // extracto pendiente CON cifra oficial fijada", indistinguible de una regresion.
    //
    // OJO, y es la diferencia importante con R5: aqui "caduco por datos" NO es la respuesta buena.
    // R6 trabaja sobre una COPIA, asi que casi siempre puede SEMBRAR el caso que necesita, y eso es
    // lo que hace. Degradar a un aviso amarillo dejaria el invariante SIN PROBAR — un hueco de
    // cobertura silencioso, que es justo lo que la regla madre de esta suite prohibe. `sinDatos` es
    // el ULTIMO recurso, para una BD tan degenerada que ni sembrando se puede montar el caso.
    const sinDatos = (nombre, motivo) => {
      caducados++;
      notas.push('CADUCADO POR DATOS [' + nombre + ']: ' + motivo + ' -> NO es una regresion del codigo: ' +
        'la BD ya no tiene ningun caso con esa precondicion y tampoco se pudo sembrar. El invariante quedo SIN probar.');
    };

    // Busca un extracto pendiente y devuelve su fila tal como la ve el frontend.
    async function extractoDe(port, tarjeta, ciclo) {
      const r = await pedir(port, 'GET', '/api/extractos?tarjeta_id=' + tarjeta);
      const lista = Array.isArray(r.j) ? r.j : (r.j && r.j.extractos) || [];
      return lista.find(e => e.ciclo === ciclo) || null;
    }

    // La banda de tolerancia depende de si el extracto tiene la cifra OFICIAL del banco: con ella
    // vale $1, y sin ella min(2000, 2% del minimo). Por eso los asertos 2 y 4 necesitan cada uno un
    // extracto con la precondicion CONTRARIA, y fijarlos a un (tarjeta, ciclo) escrito a mano los
    // rompe en cuanto el usuario concilia ese mes: fue justo lo que paso al fijar la cifra oficial
    // de la Visa de julio-2026, que era el extracto del aserto 2. Se eligen de la BD.
    // conOficial: true / false / null (= da igual, sirve cualquiera).
    async function buscarExtracto(port, db, conOficial) {
      const tarjetas = db.prepare('SELECT id FROM tarjetas ORDER BY id').all();
      for (const t of tarjetas) {
        const r = await pedir(port, 'GET', '/api/extractos?tarjeta_id=' + t.id);
        const lista = Array.isArray(r.j) ? r.j : (r.j && r.j.extractos) || [];
        const cand = lista.find(e => e.estado !== 'pagado' && Number(e.pago_minimo) > 50000 &&
          (conOficial === null || !!e.tiene_oficial === conOficial));
        if (cand) return { ext: cand, tarjeta: t.id };
      }
      return null;
    }

    // Devuelve un extracto pendiente CON cifra oficial, SEMBRANDOLA si en la BD no queda ninguno.
    // Es la parte importante del arreglo: la precondicion del aserto 4 se la lleva por delante el uso
    // normal de la app (basta pagar ese mes, o que el usuario no haya conciliado ningun PDF todavia),
    // y sin siembra el invariante de la banda de $1 se quedaba sin probar cada vez que eso pasaba.
    async function conCifraOficial(port, db) {
      const ya = await buscarExtracto(port, db, true);
      if (ya) return { c: ya, sembrado: false };
      const sin = await buscarExtracto(port, db, false);
      if (!sin) return null;
      const pm = Math.round(Number(sin.ext.pago_minimo));
      const pt = Number(sin.ext.pago_total);
      const r = await pedir(port, 'POST', '/api/extractos/pago-oficial', {
        tarjeta_id: sin.tarjeta, ciclo: sin.ext.ciclo, pago_minimo: pm,
        pago_total: (pt > pm ? pt : pm), fuente: 'suite de verificacion',
      });
      if (r.s !== 200) return null;
      const tras = await buscarExtracto(port, db, true);
      return tras ? { c: tras, sembrado: true } : null;
    }

    // ── 1. Pagar el minimo EXACTO tiene que SELLAR el mes ────────────────────
    // Es el aserto que mata el mutante `>=` -> `>`: con `>`, pagar exactamente el minimo dejaria
    // el extracto sin sellar. La decision de diseno del proyecto es que el pago minimo es
    // indivisible y se cubre COMPLETO; pagarlo al peso cierra el mes.
    try {
      await conApp(raiz, '1', async (port, db) => {
        // El (tarjeta, ciclo) se ELIGE de la BD, no se escribe a mano: fijado a (4, 2026-07) este
        // aserto moria en cuanto el usuario pagara ese mes, y el mensaje ("no se encontro el
        // extracto") parecia un fallo del codigo. Sirve CUALQUIER extracto pendiente: pagar el
        // minimo exacto tiene que sellar tanto si la referencia es el estimado como si es la cifra
        // oficial del banco.
        const c = await buscarExtracto(port, db, null);
        if (!c) { sinDatos('minimo exacto', 'no hay ningun extracto pendiente con minimo > 50.000 en toda la BD'); return; }
        const ext = c.ext;
        const min = Number(ext.pago_minimo);
        const r = await pedir(port, 'PUT', '/api/extractos/' + ext.id + '/pagar', { monto_pagado: min, fecha_pagado: '2026-08-01' });
        chk('minimo exacto responde 200', r.s === 200, 'status=' + r.s + ' ' + r.b.slice(0, 90));
        // Guard contra el error que tuvo esta misma prueba: si el nombre del campo del body no es
        // el que el handler lee, el backend aplica su valor por defecto y el aserto mide otra cosa.
        chk('el backend uso el monto que se le envio', !!(r.j && Math.abs(Number(r.j.nuevoMontoPagado) - min) < 1),
          'enviado=' + min + ' aplicado=' + (r.j && r.j.nuevoMontoPagado) + ' -> el campo del body no llego al handler');
        chk('minimo exacto SELLA el mes (' + c.tarjeta + ', ' + ext.ciclo + ')', !!(r.j && r.j.pagadoCompleto),
          'pagadoCompleto=' + (r.j && r.j.pagadoCompleto) + ' (pagar el minimo al peso debe cerrar el ciclo)');
        const post = await extractoDe(port, c.tarjeta, ext.ciclo);
        chk('el extracto queda en estado pagado', !!(post && post.estado === 'pagado'), 'estado=' + (post && post.estado));
      });
    } catch (e) { chk('exacto', false, 'excepcion: ' + e.message); }

    // ── 2. Faltante DENTRO de la banda: sella igual (tolerancia de v5.7.1) ───
    // El estimado no puede ser exacto por diseno: el banco cobra interes sobre la cuota facturada
    // hasta el dia del pago. Por eso se acepta un faltante de hasta min(2000, 2% del minimo)
    // cuando la referencia es el ESTIMADO.
    try {
      await conApp(raiz, '2', async (port, db) => {
        const c = await buscarExtracto(port, db, false);   // SIN cifra oficial -> banda amplia
        if (!c) { sinDatos('tolerancia', 'no hay ningun extracto pendiente SIN cifra oficial con que probar la banda amplia'); return; }
        const banda = Math.min(2000, Math.round(Number(c.ext.pago_minimo) * 0.02));
        const falta = Math.max(1, banda - 1);              // dentro de banda por construccion
        const r = await pedir(port, 'PUT', '/api/extractos/' + c.ext.id + '/pagar',
          { monto_pagado: Number(c.ext.pago_minimo) - falta, fecha_pagado: '2026-08-01' });
        chk('faltante de ' + falta + ' (dentro de banda) SELLA en (' + c.tarjeta + ', ' + c.ext.ciclo + ')',
          !!(r.j && r.j.pagadoCompleto), 'pagadoCompleto=' + (r.j && r.j.pagadoCompleto));
      });
    } catch (e) { chk('tolerancia', false, 'excepcion: ' + e.message); }

    // ── 3. Faltante FUERA de la banda: NO debe sellar ────────────────────────
    // La contraparte del aserto anterior. Sin el, una tolerancia infinita pasaria igual de verde.
    try {
      await conApp(raiz, '3', async (port, db) => {
        const c = await buscarExtracto(port, db, false);
        if (!c) { sinDatos('fuera de banda', 'no hay ningun extracto pendiente SIN cifra oficial'); return; }
        const ext = c.ext;
        const r = await pedir(port, 'PUT', '/api/extractos/' + ext.id + '/pagar',
          { monto_pagado: Number(ext.pago_minimo) - 25000, fecha_pagado: '2026-08-01' });
        chk('faltante de 25.000 NO sella', !(r.j && r.j.pagadoCompleto),
          'pagadoCompleto=' + (r.j && r.j.pagadoCompleto) + ' (un faltante asi es un abono parcial, no un pago)');
      });
    } catch (e) { chk('fuera de banda', false, 'excepcion: ' + e.message); }

    // ── 4. Con cifra OFICIAL del PDF la banda cae a $1 ───────────────────────
    // Ahi un faltante no es imprecision del modelo: es plata que falta. La precondicion se SIEMBRA
    // si la BD no la trae (ver conCifraOficial): depender de que el usuario tenga un PDF conciliado
    // y sin pagar dejaba este invariante sin probar la mitad del tiempo.
    try {
      await conApp(raiz, '4', async (port, db) => {
        const r0 = await conCifraOficial(port, db);        // CON cifra oficial -> banda de $1
        if (!r0) { sinDatos('cifra oficial', 'no hay extracto pendiente con cifra oficial y tampoco se pudo sembrar uno'); return; }
        const c = r0.c, ext = c.ext;
        chk('el extracto declara que trae cifra oficial (' + c.tarjeta + ', ' + ext.ciclo + ')' + (r0.sembrado ? ' [sembrada por la suite]' : ''),
          !!ext.tiene_oficial, 'tiene_oficial=' + ext.tiene_oficial);
        // Se paga el FALTANTE menos 500, no el minimo completo: si el extracto ya traia abonos
        // (un pago parcial del usuario), pagar el minimo entero lo sella de largo y el aserto medía
        // otra cosa. Paso en ago-2026 con el pago parcial de 1.400.000 sobre la Visa de julio.
        const yaAbonado = Number(ext.monto_pagado || 0);
        const faltante = Number(ext.pago_minimo) - yaAbonado;
        chk('el extracto elegido deja un faltante > 500 con que probar la banda', faltante > 500,
          'faltante=' + faltante + ' (minimo ' + ext.pago_minimo + ' - abonado ' + yaAbonado + ')');
        const r = await pedir(port, 'PUT', '/api/extractos/' + ext.id + '/pagar',
          { monto_pagado: faltante - 500, fecha_pagado: '2026-08-01' });
        chk('con cifra oficial, faltar 500 NO sella', !(r.j && r.j.pagadoCompleto),
          'pagadoCompleto=' + (r.j && r.j.pagadoCompleto) + ' (con la cifra del banco la banda es de $1)');
      });
    } catch (e) { chk('cifra oficial', false, 'excepcion: ' + e.message); }

    // ── 5. Candado: no se puede crear una compra en un ciclo PAGADO ──────────
    // Es el unico candado que sobrevivio entero a v5.8.0 y aplica siempre, sin exencion.
    try {
      await conApp(raiz, '5', async (port) => {
        const r = await pedir(port, 'POST', '/api/compras', {
          tarjeta_id: 4, fecha: '2026-06-15', descripcion: 'PRUEBA SUITE', valor_cop: 10000, cuotas: 1,
        });
        chk('POST /compras en ciclo pagado -> 403', r.s === 403, 'status=' + r.s + ' ' + r.b.slice(0, 90));
      });
    } catch (e) { chk('ciclo pagado', false, 'excepcion: ' + e.message); }

    // ── 6. Candado: el bolsillo de un tercero exige desde_terceros ───────────
    // `monto_bolsillo` esta SOBRECARGADO: en una compra de tercero no es plata propia, es el
    // reembolso del deudor. Sin este candado, la vista general puede corromper la contabilidad
    // de terceros (paso de verdad en v4.1.0).
    try {
      await conApp(raiz, '6', async (port, db) => {
        const c = db.prepare("SELECT id FROM compras WHERE persona_id IS NOT NULL AND estado != 'diferida' ORDER BY id DESC LIMIT 1").get();
        if (!c) { sinDatos('bolsillo tercero', 'no hay ninguna compra de tercero (persona_id no nulo) en la BD'); return; }
        const r = await pedir(port, 'PUT', '/api/compras/' + c.id + '/bolsillo', { monto: 1000 });
        chk('bolsillo de tercero sin desde_terceros -> 403', r.s === 403, 'status=' + r.s + ' ' + r.b.slice(0, 90));
      });
    } catch (e) { chk('bolsillo tercero', false, 'excepcion: ' + e.message); }

    // Piso: si el numero de asertos ejecutados cae, el detector dejo de mirar. Se distingue el
    // motivo: quedarse corto POR DATOS (invariantes que no se pudieron montar) no es lo mismo que
    // quedarse corto porque alguien borro asertos, y confundirlos manda a investigar el codigo.
    const PISO = 9;
    if (total < PISO) {
      notas.push('FALLO: solo se ejecutaron ' + total + ' asertos, piso ' + PISO +
        (caducados ? ' -> ' + caducados + ' invariante(s) se quedaron SIN DATOS con que probarse (ver arriba), no es una regresion del codigo'
                   : ' -> el detector se quedo corto'));
    }
    // Un caducado NO puede dar verde: caducar no es pasar. Pero el mensaje ya dice que la causa son
    // los datos, para no mandar a nadie a buscar una regresion que no existe.
    return resultado(ok === total && total >= PISO && caducados === 0,
      { asertos: total, ok, fallidos: total - ok, sinDatos: caducados }, notas);
  },
  defecto: 'se cambia `>=` por `>` en el sellado del pago minimo (pagar el minimo exacto dejaria de cerrar el mes)',
  mutar(raiz) {
    // Se busca el operador ALLI DONDE VIVA dentro de backend/routes, en vez de anclarlo a
    // extractos.js: la Etapa 4 lo movio a extractos/_compartido.js y la mutacion se quedo
    // apuntando a un archivo que ya no lo contiene. El guard sistematico del runner lo nombro
    // (la mutacion no cambiaba nada) en lugar de dejar que pareciera un detector roto.
    const base = path.join(raiz, 'backend', 'routes');
    const pendientes = [base];
    while (pendientes.length) {
      const d = pendientes.pop();
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { pendientes.push(p); continue; }
        if (!e.name.endsWith('.js')) continue;
        const src = leer(p);
        if (src.indexOf('(nuevoMontoPagado >= minimoRef)') === -1) continue;
        fs.writeFileSync(p, src.replace('(nuevoMontoPagado >= minimoRef)', '(nuevoMontoPagado > minimoRef)'), 'utf8');
        return;
      }
    }
    throw new Error('no se encontro el comparador del sellado en ningun archivo de backend/routes');
  },
};

// ─── R9: el saldo a favor cruzado a una CUOTA ni se duplica ni se pierde ────
//
// POR QUE EXISTE: hasta v6.2.0 un credito de reverso NO se podia cruzar contra una diferida, y el
// motivo de fondo no era falta de ganas sino que el ledger no podia expresarlo: en una diferida el
// reembolso vive POR CUOTA en bolsillo_cuotas y `compras.monto_bolsillo` es solo un cache = SUM,
// mientras `aplicaciones_saldo_favor` solo guardaba la compra. Al abrirlo hay DOS formas de perder
// o duplicar plata del tercero, y las dos son silenciosas:
//   · deshacer restando del CACHE en vez de la cuota -> la siguiente escritura per-cuota lo recalcula
//     y el reembolso resucita, con el credito ya devuelto: la misma plata dos veces.
//   · medir el piso del cruce contra el total de la compra cuando la escritura es de UNA cuota ->
//     o bloquea ediciones legitimas o deja borrar un cruce.
// Ninguna de las dos rompe nada visible en el momento: aparecen despues, cuando alguien vuelve a
// tocar el bolsillo. Por eso el invariante se audita contra la BD y no en pantalla (eso es F11).
//
// El escenario se SIEMBRA entero (criterio de R6/R8): tarjeta, persona, diferida de 2 cuotas con
// tasa 0 -asi cada cuota vale monto/2 EXACTO y ninguna afirmacion depende del motor- y un credito.
const R9 = {
  id: 'R9',
  nombre: 'Saldo a favor cruzado a una cuota: aplicar y deshacer es inverso fiel',
  async medir(raiz) {
    const notas = [];
    const cifras = {};
    const A = (cond, msg) => { if (!cond) notas.push('FALLO ' + msg); };

    try {
      await conApp(raiz, 'R9', async (port, db) => {
        // ── Siembra ──
        const tj = db.prepare("INSERT INTO tarjetas (nombre, banco, franquicia, dia_corte, cupo_total, tasa_mv_avances, estado) VALUES ('R9 TARJETA','Bancolombia','Visa',30,10000000,0.02,'activa')").run().lastInsertRowid;
        const per = db.prepare("INSERT INTO personas (nombre, color) VALUES ('R9 DEUDOR','#333333')").run().lastInsertRowid;
        const dif = db.prepare("INSERT INTO diferidas (tarjeta_id, etiqueta, monto, tasa_mv, num_cuotas, fecha_compra, fecha_primer_corte, estado, notas) VALUES (?,?,?,0,2,?,?, 'activo','R9')")
          .run(tj, 'R9 DIFERIDA', 200000, '2029-05-31', '2029-06-30').lastInsertRowid;
        const compra = db.prepare("INSERT INTO compras (tarjeta_id, fecha, descripcion, valor_cop, estado, ciclo, persona_id, diferida_id, notas, monto_bolsillo) VALUES (?,?,?,?, 'diferida', ?,?,?, 'Diferida a 2 cuotas', 0)")
          .run(tj, '2029-05-31', 'R9 DIFERIDA', 200000, '2029-06', per, dif).lastInsertRowid;
        const cred = db.prepare("INSERT INTO saldos_favor_tercero (persona_id, monto, monto_aplicado, origen_tipo, tarjeta_id, descripcion, fecha, estado) VALUES (?,?,0, 'reverso', ?, 'R9 REVERSO', '2029-05-31', 'activo')")
          .run(per, 200000, tj).lastInsertRowid;

        const bolCuota = (n) => { const r = db.prepare("SELECT COALESCE(monto,0) m FROM bolsillo_cuotas WHERE compra_id=? AND cuota_num=?").get(compra, n); return r ? Math.round(r.m) : 0; };
        const cache = () => Math.round(db.prepare('SELECT COALESCE(monto_bolsillo,0) m FROM compras WHERE id=?').get(compra).m);
        const sumaCuotas = () => Math.round(db.prepare("SELECT COALESCE(SUM(monto),0) t FROM bolsillo_cuotas WHERE compra_id=? AND COALESCE(moneda,'COP')='COP'").get(compra).t);
        const credito = () => db.prepare('SELECT monto, monto_aplicado, estado FROM saldos_favor_tercero WHERE id=?').get(cred);
        const cruces = () => db.prepare("SELECT COALESCE(SUM(monto),0) t FROM aplicaciones_saldo_favor WHERE saldo_favor_id=? AND tipo='cruce'").get(cred).t;
        // INVARIANTE MADRE: lo que el credito dice haber repartido y lo que el ledger tiene vivo son
        // lo mismo, y el cache es SIEMPRE la suma de las cuotas (nunca un valor escrito a mano).
        const invariantes = (etapa) => {
          const c = credito();
          A(Math.round(c.monto_aplicado) === Math.round(cruces()), '[' + etapa + '/LEDGER]: el credito dice haber repartido ' + c.monto_aplicado + ' y sus cruces vivos suman ' + cruces());
          A(cache() === sumaCuotas(), '[' + etapa + '/CACHE]: monto_bolsillo (' + cache() + ') dejo de ser la suma de las cuotas (' + sumaCuotas() + ') -> el proximo guardado per-cuota lo recalcula y el cambio se evapora');
        };

        // ── 1. Cruce de 40.000 a la CUOTA 1 ──
        const r1 = await pedir(port, 'POST', '/api/saldos-favor/' + cred + '/aplicar', { compra_destino_id: compra, monto: 40000, cuota_num: 1 });
        A(r1.j && r1.j.ok, '[APLICAR]: el cruce a una cuota fue rechazado: ' + JSON.stringify(r1.j));
        A(bolCuota(1) === 40000, '[APLICAR]: la cuota 1 deberia tener 40000 reembolsados y tiene ' + bolCuota(1));
        A(bolCuota(2) === 0, '[APLICAR]: el cruce toco una cuota que no era (cuota 2 = ' + bolCuota(2) + ')');
        const fila = db.prepare("SELECT cuota_num FROM aplicaciones_saldo_favor WHERE saldo_favor_id=? AND tipo='cruce'").get(cred);
        A(fila && fila.cuota_num === 1, '[APLICAR/LEDGER]: el movimiento no anoto a que cuota fue (cuota_num=' + (fila && fila.cuota_num) + ') -> deshacerlo no sabria de donde restar');
        invariantes('APLICAR');
        cifras.trasCruce = bolCuota(1);

        // ── 2. Sin cuota no se puede cruzar a una diferida (la elige el usuario, no el sistema) ──
        const rSin = await pedir(port, 'POST', '/api/saldos-favor/' + cred + '/aplicar', { compra_destino_id: compra, monto: 10000 });
        A(rSin.j && rSin.j.error, '[APLICAR]: se acepto un cruce a una diferida sin decir la cuota');

        // ── 3. El tope es el de LA CUOTA, no el de la compra ──
        const rTope = await pedir(port, 'POST', '/api/saldos-favor/' + cred + '/aplicar', { compra_destino_id: compra, monto: 90000, cuota_num: 1 });
        A(rTope.j && rTope.j.error, '[TOPE]: se acepto cruzar 90000 a una cuota que solo debe 60000');

        // ── 4. El piso, medido en la MISMA unidad que la escritura ──
        //    (a) subir con efectivo esta permitido (completar un cruce parcial, v4.8.1)
        const rSube = await pedir(port, 'PUT', '/api/compras/' + compra + '/bolsillo', { monto_bolsillo: 100000, cuota_num: 1, moneda: 'COP', desde_terceros: true });
        A(rSube.j && !rSube.j.error, '[PISO]: no se pudo completar la cuota con efectivo por encima del cruce: ' + JSON.stringify(rSube.j));
        A(bolCuota(1) === 100000, '[PISO]: la cuota 1 deberia quedar en 100000 y quedo en ' + bolCuota(1));
        //    (b) bajar por debajo de lo cruzado NO
        const rBaja = await pedir(port, 'PUT', '/api/compras/' + compra + '/bolsillo', { monto_bolsillo: 20000, cuota_num: 1, moneda: 'COP', desde_terceros: true });
        A(rBaja.j && rBaja.j.error, '[PISO]: se dejo bajar la cuota por debajo del saldo cruzado -> el credito queda descuadrado');
        A(bolCuota(1) === 100000, '[PISO]: el intento de bajar modifico la cuota igualmente (' + bolCuota(1) + ')');
        //    (c) y el piso de la cuota 1 NO puede bloquear a la cuota 2: es el fallo de unidades.
        //    El monto va POR DEBAJO del total cruzado en la compra (40.000) A PROPOSITO: por encima,
        //    un piso mal medido tampoco bloquearia y el aserto pasaria en vacio.
        const rOtra = await pedir(port, 'PUT', '/api/compras/' + compra + '/bolsillo', { monto_bolsillo: 30000, cuota_num: 2, moneda: 'COP', desde_terceros: true });
        A(rOtra.j && !rOtra.j.error, '[PISO/UNIDAD]: el cruce de la cuota 1 bloqueo una edicion de la cuota 2 -> el piso se esta midiendo contra el total de la compra');
        A(bolCuota(2) === 30000, '[PISO/UNIDAD]: la cuota 2 no quedo en 30000 (' + bolCuota(2) + ')');
        invariantes('PISO');

        // ── 5. Deshacer: retira de SU cuota y devuelve el credito ──
        const apl = db.prepare("SELECT id FROM aplicaciones_saldo_favor WHERE saldo_favor_id=? AND tipo='cruce'").get(cred);
        const rDes = await pedir(port, 'DELETE', '/api/saldos-favor/aplicaciones/' + apl.id, null);
        A(rDes.j && rDes.j.ok, '[DESHACER]: fue rechazado: ' + JSON.stringify(rDes.j));
        A(bolCuota(1) === 60000, '[DESHACER]: la cuota 1 deberia quedar con los 60000 de efectivo y quedo en ' + bolCuota(1) +
          (bolCuota(1) === 100000 ? ' -> el credito se devolvio pero el dinero sigue en el bolsillo: la misma plata dos veces' : ''));
        A(bolCuota(2) === 30000, '[DESHACER]: deshacer toco una cuota ajena (cuota 2 = ' + bolCuota(2) + ')');
        A(Math.round(credito().monto_aplicado) === 0, '[DESHACER]: el credito no quedo disponible otra vez (aplicado=' + credito().monto_aplicado + ')');
        invariantes('DESHACER');
        cifras.trasDeshacer = bolCuota(1);

        // ── 6. INVERSO FIEL: aplicar y deshacer devuelve las filas a como estaban ──
        const foto = () => JSON.stringify({
          cuotas: db.prepare('SELECT cuota_num, monto, moneda FROM bolsillo_cuotas WHERE compra_id=? ORDER BY cuota_num').all(compra),
          compra: db.prepare('SELECT monto_bolsillo, monto_bolsillo_usd, estado, tercero_pagado FROM compras WHERE id=?').get(compra),
          credito: credito(),
        });
        const antes = foto();
        const rA = await pedir(port, 'POST', '/api/saldos-favor/' + cred + '/aplicar', { compra_destino_id: compra, monto: 25000, cuota_num: 2 });
        A(rA.j && rA.j.ok, '[INVERSO]: no se pudo aplicar el segundo cruce: ' + JSON.stringify(rA.j));
        const apl2 = db.prepare("SELECT id FROM aplicaciones_saldo_favor WHERE saldo_favor_id=? AND tipo='cruce' ORDER BY id DESC").get(cred);
        await pedir(port, 'DELETE', '/api/saldos-favor/aplicaciones/' + apl2.id, null);
        const despues = foto();
        A(antes === despues, '[INVERSO]: aplicar y deshacer no dejo las filas como estaban.' +
          '\n           antes:   ' + antes + '\n           despues: ' + despues);
        cifras.inversoFiel = antes === despues ? 'si' : 'no';
      });
    } catch (e) {
      return resultado(false, cifras, ['FALLO ejecutando el escenario: ' + e.message]);
    }
    return resultado(notas.length === 0, cifras, notas);
  },
  defecto: 'deshacer un cruce resta del CACHE en vez de la cuota (el dinero del tercero se cuenta dos veces)',
  mutar(raiz) {
    // Es la unica forma de deshacer que existia antes de tener cuota_num, y es silenciosa: no falla
    // nada en el momento. El cache deja de ser la suma de las cuotas, asi que el credito vuelve a
    // estar disponible mientras el reembolso sigue vivo en bolsillo_cuotas.
    const p = path.join(raiz, 'backend', 'routes', 'saldosFavor.js');
    const src = fs.readFileSync(p, 'utf8');
    const aguja = 'aplicarBolsilloACuota(destino, apl.cuota_num, Math.max(0, r2(actual - apl.monto)));';
    if (src.indexOf(aguja) === -1) throw new Error('no se encontro el deshacer per-cuota en saldosFavor.js');
    fs.writeFileSync(p, src.replace(aguja, 'aplicarBolsilloATercero(destino, Math.max(0, r2((destino.monto_bolsillo || 0) - apl.monto)));'), 'utf8');
  },
};

// ─── R10: una compra ANULADA no deja plata colgando en NINGUNA card ─────────
//
// POR QUE EXISTE: anular no borra la fila -el rastro es auditable-, la NEUTRALIZA: estado 'pagado'
// con monto_abonado = valor_cop. Eso pone su deuda a CERO en toda consulta sin tocar ninguna... y
// por eso es una trampa: donde la deuda NO se mide restando `monto_abonado`, la compra sigue
// contando entera. Paso de verdad: la card "Me Deben" cargaba $882.000 de una compra que el banco
// anulo y nunca facturo, mientras la pestaña Terceros -que si filtra desde v6.4.0- decia otra cosa.
// Las dos vistas se contradecian en la misma pantalla, que es el sintoma clasico de la duplicacion
// deliberada de esa formula.
//
// El escenario se SIEMBRA entero (criterio de R6/R8/R9) y en el CICLO VIGENTE del reloj congelado,
// que es la unica forma de que la compra entre a la vez en "Me Deben" y en "Me Deben Corte".
// Los asertos van en PARES antes/despues: sin comprobar que la compra pesaba ANTES, el aserto de
// despues pasaria en vacio con cualquier fixture que no llegue a la card.
const R10 = {
  id: 'R10',
  nombre: 'Una compra ANULADA deja de pesar en las cards (Me Deben, corte, deuda) sin perder el rastro',
  async medir(raiz) {
    const notas = [];
    const cifras = {};
    const A = (cond, msg) => { if (!cond) notas.push('FALLO ' + msg); };

    try {
      await conApp(raiz, 'R10', async (port, db) => {
        const VALOR = 500000;
        // Ciclo vigente segun el reloj congelado, leido del backend real (nunca calculado aqui).
        const hoy = require(path.join(raiz, 'backend', 'helpers', 'dates')).hoyLocal();
        const tj = db.prepare("INSERT INTO tarjetas (nombre, banco, franquicia, dia_corte, cupo_total, tasa_mv_avances, estado) VALUES ('R10 TARJETA','Bancolombia','Visa',30,40000000,0.02,'activa')").run().lastInsertRowid;
        const tjInfo = await pedir(port, 'GET', '/api/tarjetas');
        const mia = (Array.isArray(tjInfo.j) ? tjInfo.j : []).find(t => t.id === tj);
        const ciclo = (mia && (mia.ciclo_vigente || mia.ciclo_sugerido)) || hoy.slice(0, 7);
        const per = db.prepare("INSERT INTO personas (nombre, color) VALUES ('R10 DEUDOR','#444444')").run().lastInsertRowid;
        const compra = db.prepare("INSERT INTO compras (tarjeta_id, fecha, descripcion, valor_cop, estado, ciclo, persona_id, monto_bolsillo, tercero_pagado) VALUES (?,?,?,?,'pendiente',?,?,0,0)")
          .run(tj, ciclo + '-05', 'R10 COMPRA ANULABLE', VALOR, ciclo, per).lastInsertRowid;

        const cards = async () => {
          const d = await pedir(port, 'GET', '/api/dashboard?tarjeta_id=' + tj);
          const t = await pedir(port, 'GET', '/api/terceros?tarjeta_id=' + tj);
          const j = d.j || {};
          return {
            meDeben: Math.round((j.meDeben && j.meDeben.total) || 0),
            meDebenCorte: Math.round((j.meDebenCorte && j.meDebenCorte.total) || 0),
            deudaTotal: Math.round(j.deudaTotal || 0),
            filas: Array.isArray(t.j) ? t.j.filter(x => x.id === compra).length : -1,
          };
        };

        // ── ANTES: la compra tiene que PESAR en las tres cards y salir en Terceros ──
        const antes = await cards();
        cifras.antes = JSON.stringify(antes);
        A(antes.meDeben === VALOR, '[SANIDAD/ANTES]: la compra sembrada no llega a "Me Deben" (' + antes.meDeben + ' en vez de ' + VALOR + ') -> el aserto de despues pasaria en vacio');
        A(antes.meDebenCorte === VALOR, '[SANIDAD/ANTES]: la compra sembrada no llega a "Me Deben Corte" (' + antes.meDebenCorte + ' en vez de ' + VALOR + ') -> el ciclo del fixture no es el vigente y el aserto de despues no probaria nada');
        A(antes.deudaTotal === VALOR, '[SANIDAD/ANTES]: la compra sembrada no llega a la deuda total (' + antes.deudaTotal + ')');
        A(antes.filas === 1, '[SANIDAD/ANTES]: la compra sembrada no aparece en la pestaña Terceros');

        // ── ANULAR con el endpoint REAL ──
        const rAn = await pedir(port, 'POST', '/api/compras/' + compra + '/anular-plan', {});
        A(rAn.s === 200 && rAn.j && rAn.j.ok, '[ANULAR]: el endpoint rechazo la anulacion: ' + JSON.stringify(rAn.j));

        // ── DESPUES: cero en todas las cards, y fuera de Terceros ──
        const despues = await cards();
        cifras.despues = JSON.stringify(despues);
        A(despues.meDeben === 0, '[ME DEBEN]: la card sigue cobrando ' + despues.meDeben + ' de una compra ANULADA -> el banco nunca la facturo y el tercero no debe nada; la neutralizacion no basta porque esta card no resta monto_abonado');
        A(despues.meDebenCorte === 0, '[ME DEBEN CORTE]: la card del corte sigue cobrando ' + despues.meDebenCorte + ' de una compra ANULADA');
        A(despues.deudaTotal === 0, '[DEUDA]: la deuda total sigue contando ' + despues.deudaTotal + ' de una compra ANULADA');
        A(despues.filas === 0, '[TERCEROS]: la compra anulada sigue listada en la pestaña Terceros');

        // ── El rastro NO se pierde: la fila sigue ahi, marcada ──
        const fila = db.prepare('SELECT id, estado, anulada, monto_abonado, valor_cop FROM compras WHERE id=?').get(compra);
        A(!!fila, '[RASTRO]: la anulacion BORRO la fila -> se pierde la auditoria de lo que paso');
        A(fila && fila.anulada === 1, '[RASTRO]: la fila no quedo marcada como anulada (anulada=' + (fila && fila.anulada) + ')');
        A(fila && Math.round(fila.monto_abonado) === Math.round(fila.valor_cop), '[RASTRO]: la fila no quedo neutralizada (abonado ' + (fila && fila.monto_abonado) + ' vs valor ' + (fila && fila.valor_cop) + ')');

        // ── Idempotencia: anular dos veces no acumula ──
        const rDos = await pedir(port, 'POST', '/api/compras/' + compra + '/anular-plan', {});
        A(rDos.s === 409, '[IDEMPOTENCIA]: anular una compra ya anulada devolvio ' + rDos.s + ' en vez de 409');
      });
    } catch (e) {
      return resultado(false, cifras, ['FALLO ejecutando el escenario: ' + e.message]);
    }
    return resultado(notas.length === 0, cifras, notas);
  },
  defecto: 'la card "Me Deben" deja de excluir las compras anuladas (vuelve a contar plata que el banco nunca facturo)',
  mutar(raiz) {
    // Ancla de UNA linea (los archivos van en CRLF) y por CONTENIDO: si el filtro se muda, la
    // mutacion LANZA en vez de aplicarse a la nada.
    const p = path.join(raiz, 'backend', 'routes', 'dashboard.js');
    const src = leer(p);
    const aguja = 'WHERE c.tercero_pagado = 0 AND COALESCE(c.anulada, 0) = 0${tjFilter}';
    if (src.indexOf(aguja) === -1) throw new Error('no se encontro el filtro de anuladas en la consulta de "Me Deben"');
    fs.writeFileSync(p, src.replace(aguja, 'WHERE c.tercero_pagado = 0${tjFilter}'), 'utf8');
  },
};

module.exports = [R6, R9, R10];
