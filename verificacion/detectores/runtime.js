'use strict';
// verificacion/detectores/runtime.js — R1..R5 (cargan la app REAL contra una COPIA de la BD)
//
// Nada de esto se puede stubear. Si better-sqlite3 falla por ABI la salida facil es sustituirlo
// por un doble, y entonces initDb, syncData, los 82 endpoints y las huellas dejan de ejercitar la
// capa de datos: la suite pasaria a validar unicamente que los archivos parsean, que es
// exactamente lo que ya hacia antes. Por eso corre bajo ELECTRON_RUN_AS_NODE.

const fs = require('fs');
const path = require('path');
const { leer, resultado, hashTexto, copiarBd } = require('../lib');
const B = require('../linea_base');

// Lee la tabla de montaje del propio app.js: [prefijo, archivo de router].
// Se parsea la fuente en vez de introspeccionar los internos de Express porque lo que hay que
// congelar es el CONTRATO declarado, y porque asi el detector nombra el prefijo que falla.
function tablaDeMontaje(raiz) {
  // Se descartan las lineas comentadas ANTES de buscar. Sin esto, un `app.use` que alguien deja
  // comentado -el olvido tipico al repartir un router- sigue contando como montado y el detector
  // da 82 endpoints sobre una app a la que le falta un prefijo entero.
  const src = leer(path.join(raiz, 'backend', 'app.js'))
    .split('\n').filter(l => !/^\s*\/\//.test(l)).join('\n');
  const re = /app\.use\(\s*'([^']+)'\s*,\s*require\('\.\/routes\/([A-Za-z0-9_]+)'\)\s*\(([^)]*)\)\s*\)/g;
  const out = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    out.push({ prefijo: m[1], modulo: m[2], args: m[3].split(',').map(s => s.trim()).filter(Boolean) });
  }
  return out;
}

function rutasDeRouter(router) {
  const out = [];
  const stack = (router && router.stack) || [];
  for (const capa of stack) {
    if (!capa.route) continue;
    const metodos = Object.keys(capa.route.methods || {}).filter(k => capa.route.methods[k]);
    for (const met of metodos) out.push(met.toUpperCase() + ' ' + capa.route.path);
  }
  return out;
}

// Instancia la app real y cada router por separado. Devuelve todo lo que R1..R5 necesitan.
function abrirApp(raiz, rutaBd) {
  const createApp = require(path.join(raiz, 'backend', 'app.js'));
  // Si alguna factory tuviera la aridad equivocada, esto revienta AQUI con TypeError al
  // destructurar undefined: es el mismo fallo que veria el usuario al arrancar. 12 de los 17
  // routers destructuran su segundo argumento en la firma y 4 se invocan con uno solo.
  const { app, db, logAction } = createApp(rutaBd);
  return { createApp, app, db, logAction };
}

// ─── R1: contrato HTTP ──────────────────────────────────────────────────────
const R1 = {
  id: 'R1',
  nombre: 'Contrato HTTP: 82 endpoints exactos en 17 prefijos',
  medir(raiz, ctx) {
    const notas = [];
    let db;
    try { ({ db } = abrirApp(raiz, ctx.bd)); }
    catch (e) { return resultado(false, {}, ['FALLO instanciando la app: ' + e.message]); }

    const { createLogHelpers } = require(path.join(raiz, 'backend', 'helpers', 'log.js'));
    const { logAction, tjNombre } = createLogHelpers(db);
    const contexto = { logAction, tjNombre, readIaKey: null };

    const montaje = tablaDeMontaje(raiz);
    const porPrefijo = {};
    let total = 0;
    for (const m of montaje) {
      const factory = require(path.join(raiz, 'backend', 'routes', m.modulo + '.js'));
      // misc recibe la RUTA del .db como segundo argumento, no el contexto: "uniformar" las
      // firmas romperia GET /api/backup. Se respeta la variante real de cada uno.
      const segundo = (m.modulo === 'misc') ? db.name : contexto;
      let router;
      try { router = (m.args.length >= 2) ? factory(db, segundo) : factory(db); }
      catch (e) { notas.push('FALLO instanciando ' + m.modulo + ': ' + e.message); continue; }
      const rutas = rutasDeRouter(router);
      porPrefijo[m.prefijo] = (porPrefijo[m.prefijo] || 0) + rutas.length;
      total += rutas.length;
    }

    if (montaje.length !== B.EXACTO_PREFIJOS) notas.push('FALLO: ESPERADO ' + B.EXACTO_PREFIJOS + ' prefijos montados, hay ' + montaje.length);
    if (total !== B.EXACTO_ENDPOINTS) notas.push('FALLO: ESPERADO ' + B.EXACTO_ENDPOINTS + ' endpoints, contados ' + total);
    for (const p of Object.keys(B.ENDPOINTS_POR_PREFIJO)) {
      const esp = B.ENDPOINTS_POR_PREFIJO[p], act = porPrefijo[p] || 0;
      if (esp !== act) notas.push('FALLO en ' + p + ': ESPERADO ' + esp + ', hay ' + act);
    }
    return resultado(total === B.EXACTO_ENDPOINTS && montaje.length === B.EXACTO_PREFIJOS && !notas.length,
      { prefijos: montaje.length, endpoints: total }, notas);
  },
  defecto: 'se comenta el montaje de /api/saldos-favor en app.js (un app.use olvidado al repartir)',
  mutar(raiz) {
    const p = path.join(raiz, 'backend', 'app.js');
    // Sustitucion literal, no anclada a ^...$: el repo usa finales de linea CRLF y en JavaScript
    // el punto NO casa con \r (es terminador de linea), asi que /^(\s*app\.use.*)$/m no matchea
    // nunca aqui. La mutacion se aplicaba en silencio a nada y el control negativo daba un falso
    // "no detectado" que parecia culpa del detector.
    fs.writeFileSync(p, leer(p).replace("app.use('/api/saldos-favor'", "// app.use('/api/saldos-favor'"), 'utf8');
  },
};

// ─── R2: contratos de modulo (lo que un split rompe sin ruido) ──────────────
const R2 = {
  id: 'R2',
  nombre: 'Contratos NO-HTTP de los modulos (exports auxiliares)',
  medir(raiz) {
    const notas = [];
    let ok = 0, mal = 0;
    for (const c of B.CONTRATOS_MODULO) {
      let mod;
      try { mod = require(path.join(raiz, c.modulo)); }
      catch (e) { notas.push('FALLO cargando ' + c.modulo + ': ' + e.message); mal += c.props.length; continue; }
      if (c.factory && typeof mod !== 'function') { notas.push('FALLO: ' + c.modulo + ' ya no exporta una factory'); mal++; }
      for (const prop of c.props) {
        // AUSENTE ES ROJO, nunca "omitido". Una prueba escrita a la defensiva
        // (typeof fn === 'function' ? correr : saltar) se auto-desactiva y el informe sale verde
        // con menos casos ejecutados, que es la ceguera mas dificil de notar.
        if (typeof mod[prop] !== 'function' && typeof mod[prop] !== 'string' && typeof mod[prop] !== 'object') {
          notas.push('FALLO: ' + c.modulo + ' ya no expone ' + prop);
          mal++;
        } else ok++;
      }
    }
    return resultado(mal === 0, { contratos: B.CONTRATOS_MODULO.length, propsOk: ok, propsRotas: mal }, notas);
  },
  defecto: 'ia.js pasa a re-exportar solo el router (pierde detectarReversos y detectarPagosOmitidos, que hoy cuelgan del factory)',
  mutar(raiz) {
    const p = path.join(raiz, 'backend', 'routes', 'ia.js');
    fs.writeFileSync(p, leer(p).replace(/^module\.exports\.detectar.*$/gm, ''), 'utf8');
  },
};

// ─── R3: invariantes de BD, independientes de la forma del codigo ───────────
const R3 = {
  id: 'R3',
  nombre: 'Invariantes de BD: 20 tablas, BD degradada se recupera, syncData = 0',
  medir(raiz, ctx) {
    const notas = [];
    const { initDb, syncData } = require(path.join(raiz, 'backend', 'config', 'db.js'));
    const cif = {};

    // (a) BD VACIA -> initDb debe levantar el esquema completo.
    // Contar CREATE TABLE con una expresion regular sobre db.js daria 0 en cuanto el archivo se
    // reparta en schema.js + migraciones.js; contar las tablas RESULTANTES sobrevive a cualquier
    // reparto porque mira el efecto, no la forma.
    const vacia = path.join(path.dirname(ctx.bd), 'vacia.db');
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(vacia + s); } catch (e) {} }
    let dbV;
    try { dbV = initDb(vacia); }
    catch (e) { return resultado(false, {}, ['FALLO: initDb sobre BD vacia lanzo ' + e.message]); }
    const tablasV = dbV.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().c;
    cif.tablasBdVacia = tablasV;
    if (tablasV !== B.EXACTO_TABLAS) notas.push('FALLO: BD vacia produjo ' + tablasV + ' tablas, ESPERADO ' + B.EXACTO_TABLAS);

    // (b) BD DEGRADADA (sin 5 tablas) -> initDb debe recrearlas sin excepcion.
    // Es el escenario exacto del arreglo de v4.7.1: la migracion de una columna corria ANTES del
    // CREATE de su tabla y reventaba con "no such table" en BDs viejas. Ninguna prueba sobre la
    // BD actual del usuario puede ver esto, porque ahi las tablas ya existen.
    const degradada = path.join(path.dirname(ctx.bd), 'degradada.db');
    for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(degradada + s); } catch (e) {} }
    fs.copyFileSync(ctx.bd, degradada);
    const Database = require('better-sqlite3');
    const dRaw = new Database(degradada);
    const aBorrar = ['bolsillo_cuotas', 'bolsillo_cuotas_avance', 'fechas_pago_custom', 'cortes_custom', 'historial'];
    dRaw.pragma('foreign_keys = OFF');
    for (const t of aBorrar) { try { dRaw.exec('DROP TABLE IF EXISTS ' + t); } catch (e) {} }
    dRaw.close();
    let dbD, recreadas = 0;
    try { dbD = initDb(degradada); }
    catch (e) { return resultado(false, cif, ['FALLO: initDb sobre BD degradada lanzo ' + e.message + ' (el orden CREATE-antes-de-migraciones se rompio)']); }
    for (const t of aBorrar) {
      const r = dbD.prepare("SELECT COUNT(*) c FROM sqlite_master WHERE type='table' AND name=?").get(t);
      if (r.c === 1) recreadas++;
    }
    cif.recreadasTrasDegradar = recreadas;
    if (recreadas !== aBorrar.length) notas.push('FALLO: solo se recrearon ' + recreadas + '/' + aBorrar.length + ' tablas borradas');

    // (c) syncData sobre copia INTACTA debe no tener nada que corregir.
    // Es el sello de sanidad que este proyecto ya usa como criterio de que nada se movio.
    const dbR = initDb(ctx.bd);
    const correcciones = syncData(dbR);
    cif.syncData = typeof correcciones === 'number' ? correcciones : 'n/d';
    if (typeof correcciones === 'number' && correcciones !== B.EXACTO_SYNCDATA_CORRECCIONES) {
      notas.push('FALLO: syncData aplico ' + correcciones + ' correcciones sobre una copia intacta (ESPERADO ' + B.EXACTO_SYNCDATA_CORRECCIONES + ')');
    }
    return resultado(!notas.length, cif, notas);
  },
  defecto: 'se elimina el CREATE TABLE de bolsillo_cuotas del esquema (la BD vacia sale incompleta y la degradada no se recupera)',
  mutar(raiz) {
    const p = path.join(raiz, 'backend', 'config', 'db.js');
    const src = leer(p);
    const i = src.indexOf('CREATE TABLE IF NOT EXISTS bolsillo_cuotas');
    if (i === -1) return;
    const j = src.indexOf(');', i) + 2;
    fs.writeFileSync(p, src.slice(0, i) + 'SELECT 1;' + src.slice(j), 'utf8');
  },
};

// ─── R4: golden masters deterministas ───────────────────────────────────────
// Los 23 GET que no escriben ni salen a la red. OJO con los que se quedan fuera y por que:
//   GET /api/extractos SIEMBRA, ACTUALIZA y BORRA filas de extractos en cada llamada.
//   GET /api/backup lee el .db entero del disco.
//   /api/scrape-tasas, /api/trm-actual y /api/trm-fecha salen a Internet.
const GETS = (t, c) => [
  '/api/config', '/api/tarjetas', '/api/tarjetas/pendientes-config', '/api/tarjetas/' + t,
  '/api/personas', '/api/compras?tarjeta_id=' + t + '&ciclo=' + c,
  '/api/compras/resumen?tarjeta_id=' + t + '&ciclo=' + c,
  '/api/compras/intl-descripciones', '/api/compras/nombres-unicos?tarjeta_id=' + t,
  '/api/avances?tarjeta_id=' + t, '/api/diferidas?tarjeta_id=' + t + '&ciclo=' + c,
  '/api/pagos?tarjeta_id=' + t, '/api/terceros?tarjeta_id=' + t,
  '/api/saldos-favor', '/api/dashboard?tarjeta_id=' + t + '&ciclo=' + c,
  '/api/dashboard', '/api/proyecciones?tarjeta_id=' + t + '&meses=6',
  '/api/abono-capital/preview?tarjeta_id=' + t + '&monto=100000&fecha=' + B.FECHA_CONGELADA,
  '/api/log?limit=5',
];

function capturar(raiz, rutaBd) {
  const http = require('http');
  const { app } = abrirApp(raiz, rutaBd);
  return new Promise((resolve, reject) => {
    const srv = app.listen(0, '127.0.0.1', async () => {
      const port = srv.address().port;
      const corpus = {};
      try {
        for (const t of B.GOLDEN_TARJETAS) {
          for (const c of B.GOLDEN_CICLOS) {
            for (const ruta of GETS(t, c)) {
              const cuerpo = await new Promise((res, rej) => {
                const rq = http.get({ host: '127.0.0.1', port, path: ruta }, (rs) => {
                  let b = ''; rs.on('data', d => { b += d; }); rs.on('end', () => res({ s: rs.statusCode, b }));
                });
                // Un TIMEOUT es ROJO, jamas "omitido": una ruta /api que quede sin montar solia
                // dejar la peticion colgada en vez de dar 404, y un runner sin tope se pega.
                rq.setTimeout(8000, () => { rq.destroy(); res({ s: 'TIMEOUT', b: '' }); });
                rq.on('error', e => rej(e));
              });
              corpus[t + '|' + c + '|' + ruta] = cuerpo;
            }
          }
        }
        srv.close(); resolve(corpus);
      } catch (e) { srv.close(); reject(e); }
    });
  });
}

const R4 = {
  id: 'R4',
  nombre: 'Golden masters deterministas (A/B en la misma corrida)',
  async medir(raiz, ctx) {
    const notas = [];
    let a, b;
    try { a = await capturar(raiz, ctx.bd); }
    catch (e) { return resultado(false, {}, ['FALLO capturando el corpus A: ' + e.message]); }
    try { b = await capturar(raiz, ctx.bdB); }
    catch (e) { return resultado(false, {}, ['FALLO capturando el corpus B: ' + e.message]); }

    const claves = Object.keys(a);
    let distintos = 0, timeouts = 0, vacios = 0, html = 0;
    for (const k of claves) {
      if (a[k].s === 'TIMEOUT' || (b[k] && b[k].s === 'TIMEOUT')) { timeouts++; continue; }
      if (!a[k].b || !a[k].b.length) vacios++;
      if (a[k].b && a[k].b.trim()[0] === '<') html++;
      if (!b[k] || a[k].b !== b[k].b) distintos++;
    }
    if (timeouts) notas.push('FALLO: ' + timeouts + ' peticiones agotaron el tiempo (un timeout es ROJO, no un caso omitido)');
    if (vacios) notas.push('FALLO: ' + vacios + ' respuestas vacias');
    if (html) notas.push('FALLO: ' + html + ' respuestas devolvieron HTML donde se esperaba JSON');
    if (distintos) notas.push('FALLO: ' + distintos + ' respuestas difieren entre dos copias IDENTICAS -> el corpus no es determinista');

    // CONTRA LA REFERENCIA COMMITEADA, no solo A contra B. La comparacion A/B demuestra que el
    // corpus es DETERMINISTA, pero no que siga siendo el MISMO: si el refactor cambia una
    // respuesta, las dos capturas cambian igual y A/B sigue coincidiendo. Se descubrio con una
    // prueba de mutacion: invertir el ORDER BY de GET /api/compras sobrevivia intacto.
    let cambiadas = 0;
    if (!fs.existsSync(RUTA_GOLDEN)) {
      notas.push('FALLO: falta ' + path.basename(RUTA_GOLDEN) + ' (sin referencia no hay golden master, solo un test de determinismo)');
    } else {
      const ref = JSON.parse(leer(RUTA_GOLDEN));
      const dif = [];
      for (const k of claves) {
        if (a[k].s === 'TIMEOUT') continue;
        const h = hashTexto(a[k].b);
        if (ref.claves[k] === undefined) dif.push('NUEVA ' + k);
        else if (ref.claves[k] !== h) dif.push(k);
      }
      for (const k of Object.keys(ref.claves)) if (!(k in a)) dif.push('AUSENTE ' + k);
      cambiadas = dif.length;
      if (cambiadas) notas.push('FALLO: ' + cambiadas + ' respuestas cambiaron respecto a la referencia: ' + dif.slice(0, 4).join(' | '));
    }
    return resultado(!notas.length, {
      capturas: claves.length, distintos, cambiadas, timeouts, vacios,
      huella: hashTexto(claves.sort().map(k => k + '=' + a[k].b).join('\n')).slice(0, 16),
    }, notas);
  },
  defecto: 'se altera el valor de una compra en la copia B, de modo que los dos corpus dejan de coincidir',
  async mutarDatos(ctx) {
    const Database = require('better-sqlite3');
    const d = new Database(ctx.bdB);
    d.prepare('UPDATE compras SET valor_cop = valor_cop + 12345 WHERE id = (SELECT MIN(id) FROM compras WHERE ciclo = ?)').run('2026-07');
    d.close();
  },
};

// ─── R5: huella numerica de los motores de dinero ───────────────────────────
const RUTA_HUELLA = path.join(__dirname, '..', 'huella_motores.json');
const RUTA_GOLDEN = path.join(__dirname, '..', 'golden_base.json');

// Calculo de la huella, COMPARTIDO por R5 y por generar_base.js. Si cada uno llevara su copia, la
// referencia y la comprobacion podrian derivar sin que nadie se entere: el detector compararia
// contra un valor calculado de otra forma y el desajuste pareceria una regresion del refactor.
function calcularHuella(raiz, rutaBd) {
    const notas = [];
    const ctx = { bd: rutaBd };
    const { initDb } = require(path.join(raiz, 'backend', 'config', 'db.js'));
    const { calcExtracto } = require(path.join(raiz, 'backend', 'engine', 'extracto.js'));
    const { calcularAmortizacionDiferida, calcularAmortizacionAvance } = require(path.join(raiz, 'backend', 'engine', 'amortizacion.js'));
    const { nuOptsDif, avanceOpts } = require(path.join(raiz, 'backend', 'helpers', 'banco.js'));
    const db = initDb(ctx.bd);

    // Que la suite pase NO prueba que las cifras no se movieron: hay que hashear las salidas
    // sobre datos reales y comparar. Esto recorre TODOS los (tarjeta, ciclo) con extracto y TODAS
    // las diferidas y avances, y reduce cada resultado a numeros.
    const lineas = [];
    const ext = db.prepare('SELECT tarjeta_id, ciclo FROM extractos ORDER BY tarjeta_id, ciclo').all();
    let okExt = 0;
    for (const e of ext) {
      try {
        const r = calcExtracto(db, e.tarjeta_id, e.ciclo, false);
        lineas.push(['EXT', e.tarjeta_id, e.ciclo, r.pagoMinimo, r.pagoTotal, r.cuotasCapital, r.cuotasInteres, r.avancesTotal, r.diferidasTotal, r.interesesComprasIntl].join('|'));
        okExt++;
      } catch (err) { notas.push('FALLO calcExtracto(' + e.tarjeta_id + ',' + e.ciclo + '): ' + err.message); }
    }
    const difs = db.prepare('SELECT * FROM diferidas ORDER BY id').all();
    let okDif = 0;
    for (const d of difs) {
      try {
        const abonos = db.prepare('SELECT * FROM abonos_diferida WHERE diferida_id=? ORDER BY id').all(d.id);
        const r = calcularAmortizacionDiferida(d.monto, d.tasa_mv, d.num_cuotas, d.fecha_compra, d.fecha_primer_corte, abonos, nuOptsDif(db, d));
        // OJO: los dos motores de amortizacion devuelven { tabla, resumen: {...} }. Leer
        // r.saldoActual / r.totalIntereses da undefined, y una huella de undefined es una huella
        // de nada: parece que mide 46 diferidas y no mide ninguna. El guard de abajo lo impide.
        const s = r.resumen || {};
        lineas.push(['DIF', d.id, s.saldoActual, s.totalIntereses, s.cuotaCapitalFija, s.cuotasRestantes,
          (r.tabla || []).length, (r.tabla || []).reduce((x, y) => x + y.capital, 0)].join('|'));
        okDif++;
      } catch (err) { notas.push('FALLO amortizacion diferida ' + d.id + ': ' + err.message); }
    }
    const avs = db.prepare('SELECT * FROM avances ORDER BY id').all();
    let okAv = 0;
    for (const a of avs) {
      try {
        const tj = db.prepare('SELECT dia_corte FROM tarjetas WHERE id=?').get(a.tarjeta_id) || {};
        const abonos = db.prepare('SELECT * FROM abonos_avance WHERE avance_id=? ORDER BY id').all(a.id);
        const r = calcularAmortizacionAvance(a.monto, a.tasa_mv, a.plazo_meses, a.fecha_desembolso, tj.dia_corte, abonos, a.comision, avanceOpts(db, a.tarjeta_id));
        const s = r.resumen || {};
        lineas.push(['AVA', a.id, s.saldoActual, s.totalIntereses, s.interesesPagados, s.cuotasRestantes,
          s.abonoSobrante, (r.tabla || []).length].join('|'));
        okAv++;
      } catch (err) { notas.push('FALLO amortizacion avance ' + a.id + ': ' + err.message); }
    }

    // GUARD CONTRA LA HUELLA VACIA. Un 'undefined' en una fila significa que se leyo una
    // propiedad que no existe: la fila se hashea igual y el detector reporta que midio N
    // entidades, pero su valor es constante y NINGUNA mutacion lo mueve. Es el mismo fallo que
    // este propio detector tuvo (leia r.totalIntereses cuando el motor devuelve
    // r.resumen.totalIntereses) y que solo se descubrio porque el control negativo no detectaba.
    const conUndefined = lineas.filter(l => l.indexOf('undefined') !== -1 || l.indexOf('|null') !== -1);
    if (conUndefined.length) {
      notas.push('FALLO: ' + conUndefined.length + ' filas de la huella contienen undefined/null -> se esta hasheando la ausencia de un campo, no una cifra. Ejemplo: ' + conUndefined[0]);
    }
    return { lineas, huella: hashTexto(lineas.join('\n')), okExt, okDif, okAv, notas };
}

const R5 = {
  id: 'R5',
  nombre: 'Huella numerica de los motores (calcExtracto y amortizacion)',
  medir(raiz, ctx) {
    const { lineas, huella, okExt, okDif, okAv, notas } = calcularHuella(raiz, ctx.bd);
    if (okExt === 0 || okDif === 0) notas.push('FALLO: no se pudo calcular nada (ext=' + okExt + ' dif=' + okDif + ')');

    // Comparacion contra la REFERENCIA COMMITEADA. Sin este contraste el detector solo comprobaba
    // que los motores no lanzan excepcion: la huella cambiaba y devolvia verde igual. Que la suite
    // pase no prueba que las cifras no se movieron; hay que compararlas contra un valor fijado.
    if (!fs.existsSync(RUTA_HUELLA)) {
      notas.push('FALLO: falta ' + path.basename(RUTA_HUELLA) + ' (sin referencia no hay nada contra que comparar)');
      return resultado(false, { filas: lineas.length, huella: huella.slice(0, 16) }, notas);
    }
    const ref = JSON.parse(leer(RUTA_HUELLA));
    if (ref.huella !== huella) {
      // Se nombran las filas concretas que se movieron: "la huella cambio" no sirve para actuar.
      const antes = new Map(ref.lineas.map(l => [l.split('|').slice(0, 3).join('|'), l]));
      const movidas = lineas.filter(l => antes.get(l.split('|').slice(0, 3).join('|')) !== l);
      notas.push('FALLO: la huella de los motores CAMBIO (' + movidas.length + ' filas distintas). ' +
        'Primeras: ' + movidas.slice(0, 3).join(' || '));
    }
    return resultado(!notas.length && ref.huella === huella,
      { extractos: okExt, diferidas: okDif, avances: okAv, filas: lineas.length, huella: huella.slice(0, 16), coincide: ref.huella === huella }, notas);
  },
  defecto: 'se invierte el signo del interes en la amortizacion de diferidas (cambia toda la huella sin romper la sintaxis)',
  mutar(raiz) {
    const p = path.join(raiz, 'backend', 'engine', 'amortizacion.js');
    const src = leer(p);
    fs.writeFileSync(p, src.replace('const totalIntereses = tabla.reduce((s, r) => s + r.interesTotal, 0);',
      'const totalIntereses = tabla.reduce((s, r) => s - r.interesTotal, 0);'), 'utf8');
  },
};

module.exports = [R1, R2, R3, R4, R5];
module.exports.abrirApp = abrirApp;
module.exports.RUTA_HUELLA = RUTA_HUELLA;
module.exports.calcularHuella = calcularHuella;
module.exports.RUTA_GOLDEN = RUTA_GOLDEN;
module.exports.capturar = capturar;
module.exports.R5 = R5;
module.exports.tablaDeMontaje = tablaDeMontaje;
