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
const http = require('http');
const { resultado, copiarBd, leer } = require('../lib');

function pedir(port, metodo, ruta, cuerpo) {
  return new Promise((resolve) => {
    const datos = cuerpo ? Buffer.from(JSON.stringify(cuerpo), 'utf8') : null;
    const req = http.request({
      host: '127.0.0.1', port, path: ruta, method: metodo,
      headers: datos ? { 'Content-Type': 'application/json', 'Content-Length': datos.length } : {},
    }, (res) => {
      let b = '';
      res.on('data', d => { b += d; });
      res.on('end', () => { let j = null; try { j = JSON.parse(b); } catch (e) {} resolve({ s: res.statusCode, j, b }); });
    });
    req.setTimeout(8000, () => { req.destroy(); resolve({ s: 'TIMEOUT', j: null, b: '' }); });
    req.on('error', (e) => resolve({ s: 'ERROR', j: null, b: String(e.message) }));
    if (datos) req.write(datos);
    req.end();
  });
}

// Abre la app sobre una copia FRESCA y ejecuta `fn` con un cliente HTTP ya listo.
async function conApp(raiz, sufijo, fn) {
  const createApp = require(path.join(raiz, 'backend', 'app.js'));
  // El nombre de la copia incluye el arbol: sin esto, la corrida real y la del control negativo
  // reutilizan los MISMOS archivos .db mientras las conexiones de la primera siguen abiertas, y el
  // control negativo "detecta" por un disk I/O error en vez de por el defecto que se le inyecto.
  const bd = copiarBd('W' + sufijo + '_' + path.basename(raiz));
  const { app, db } = createApp(bd.destino);
  return await new Promise((resolve, reject) => {
    const srv = app.listen(0, '127.0.0.1', async () => {
      try { const r = await fn(srv.address().port, db); srv.close(); resolve(r); }
      catch (e) { srv.close(); reject(e); }
    });
  });
}

const R6 = {
  id: 'R6',
  nombre: 'Invariantes de ESCRITURA (sellado del extracto y candados)',
  async medir(raiz, ctx) {
    const notas = [];
    let ok = 0, total = 0;
    const chk = (nombre, cond, detalle) => {
      total++;
      if (cond) ok++;
      else notas.push('FALLO [' + nombre + ']: ' + detalle);
    };

    // Busca un extracto pendiente y devuelve su fila tal como la ve el frontend.
    async function extractoDe(port, tarjeta, ciclo) {
      const r = await pedir(port, 'GET', '/api/extractos?tarjeta_id=' + tarjeta);
      const lista = Array.isArray(r.j) ? r.j : (r.j && r.j.extractos) || [];
      return lista.find(e => e.ciclo === ciclo) || null;
    }

    // ── 1. Pagar el minimo EXACTO tiene que SELLAR el mes ────────────────────
    // Es el aserto que mata el mutante `>=` -> `>`: con `>`, pagar exactamente el minimo dejaria
    // el extracto sin sellar. La decision de diseno del proyecto es que el pago minimo es
    // indivisible y se cubre COMPLETO; pagarlo al peso cierra el mes.
    try {
      await conApp(raiz, '1', async (port) => {
        const ext = await extractoDe(port, 4, '2026-07');
        if (!ext) { chk('exacto', false, 'no se encontro el extracto (4, 2026-07)'); return; }
        const min = Number(ext.pago_minimo);
        const r = await pedir(port, 'PUT', '/api/extractos/' + ext.id + '/pagar', { monto_pagado: min, fecha_pagado: '2026-08-01' });
        chk('minimo exacto responde 200', r.s === 200, 'status=' + r.s + ' ' + r.b.slice(0, 90));
        // Guard contra el error que tuvo esta misma prueba: si el nombre del campo del body no es
        // el que el handler lee, el backend aplica su valor por defecto y el aserto mide otra cosa.
        chk('el backend uso el monto que se le envio', !!(r.j && Math.abs(Number(r.j.nuevoMontoPagado) - min) < 1),
          'enviado=' + min + ' aplicado=' + (r.j && r.j.nuevoMontoPagado) + ' -> el campo del body no llego al handler');
        chk('minimo exacto SELLA el mes', !!(r.j && r.j.pagadoCompleto),
          'pagadoCompleto=' + (r.j && r.j.pagadoCompleto) + ' (pagar el minimo al peso debe cerrar el ciclo)');
        const post = await extractoDe(port, 4, '2026-07');
        chk('el extracto queda en estado pagado', !!(post && post.estado === 'pagado'), 'estado=' + (post && post.estado));
      });
    } catch (e) { chk('exacto', false, 'excepcion: ' + e.message); }

    // ── 2. Faltante DENTRO de la banda: sella igual (tolerancia de v5.7.1) ───
    // El estimado no puede ser exacto por diseno: el banco cobra interes sobre la cuota facturada
    // hasta el dia del pago. Por eso se acepta un faltante de hasta min(2000, 2% del minimo)
    // cuando la referencia es el ESTIMADO.
    try {
      await conApp(raiz, '2', async (port) => {
        const ext = await extractoDe(port, 4, '2026-07');
        if (!ext) { chk('tolerancia', false, 'sin extracto'); return; }
        const r = await pedir(port, 'PUT', '/api/extractos/' + ext.id + '/pagar',
          { monto_pagado: Number(ext.pago_minimo) - 1500, fecha_pagado: '2026-08-01' });
        chk('faltante de 1.500 (dentro de banda) SELLA', !!(r.j && r.j.pagadoCompleto),
          'pagadoCompleto=' + (r.j && r.j.pagadoCompleto));
      });
    } catch (e) { chk('tolerancia', false, 'excepcion: ' + e.message); }

    // ── 3. Faltante FUERA de la banda: NO debe sellar ────────────────────────
    // La contraparte del aserto anterior. Sin el, una tolerancia infinita pasaria igual de verde.
    try {
      await conApp(raiz, '3', async (port) => {
        const ext = await extractoDe(port, 4, '2026-07');
        if (!ext) { chk('fuera de banda', false, 'sin extracto'); return; }
        const r = await pedir(port, 'PUT', '/api/extractos/' + ext.id + '/pagar',
          { monto_pagado: Number(ext.pago_minimo) - 25000, fecha_pagado: '2026-08-01' });
        chk('faltante de 25.000 NO sella', !(r.j && r.j.pagadoCompleto),
          'pagadoCompleto=' + (r.j && r.j.pagadoCompleto) + ' (un faltante asi es un abono parcial, no un pago)');
      });
    } catch (e) { chk('fuera de banda', false, 'excepcion: ' + e.message); }

    // ── 4. Con cifra OFICIAL del PDF la banda cae a $1 ───────────────────────
    // Ahi un faltante no es imprecision del modelo: es plata que falta. Unico caso real en la BD:
    // RappiCard 2026-07 con pago_minimo oficial 320.582,14.
    try {
      await conApp(raiz, '4', async (port) => {
        const ext = await extractoDe(port, 5, '2026-07');
        if (!ext) { chk('cifra oficial', false, 'sin extracto (5, 2026-07)'); return; }
        chk('el extracto declara que trae cifra oficial', !!ext.tiene_oficial, 'tiene_oficial=' + ext.tiene_oficial);
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
        if (!c) { chk('bolsillo tercero', false, 'no hay compra de tercero en la BD'); return; }
        const r = await pedir(port, 'PUT', '/api/compras/' + c.id + '/bolsillo', { monto: 1000 });
        chk('bolsillo de tercero sin desde_terceros -> 403', r.s === 403, 'status=' + r.s + ' ' + r.b.slice(0, 90));
      });
    } catch (e) { chk('bolsillo tercero', false, 'excepcion: ' + e.message); }

    // Piso: si el numero de asertos ejecutados cae, el detector dejo de mirar.
    const PISO = 9;
    if (total < PISO) notas.push('FALLO: solo se ejecutaron ' + total + ' asertos, piso ' + PISO + ' -> el detector se quedo corto');
    return resultado(ok === total && total >= PISO, { asertos: total, ok, fallidos: total - ok }, notas);
  },
  defecto: 'se cambia `>=` por `>` en el sellado del pago minimo (pagar el minimo exacto dejaria de cerrar el mes)',
  mutar(raiz) {
    const p = path.join(raiz, 'backend', 'routes', 'extractos.js');
    fs.writeFileSync(p, leer(p).replace('(nuevoMontoPagado >= minimoRef)', '(nuevoMontoPagado > minimoRef)'), 'utf8');
  },
};

module.exports = [R6];
