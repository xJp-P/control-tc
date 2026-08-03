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
        const r = await pedir(port, 'PUT', '/api/extractos/' + ext.id + '/pagar',
          { monto_pagado: Number(ext.pago_minimo) - 500, fecha_pagado: '2026-08-01' });
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

module.exports = [R6];
