'use strict';
// verificacion/detectores/frontend.js — F1..F8
//
// El frontend son 19 archivos clasicos sin build, sin JSX y sin modulos ES, que comparten un unico
// ambito global. Se verifica con angulos distintos porque cada uno se queda ciego de una forma:
//   F1 parsea cada pieza por separado  -> no ve colisiones entre piezas.
//   F2 parsea la concatenacion         -> ve las colisiones, no ve el orden de evaluacion.
//   F3 EJECUTA la carga con dobles     -> ve el orden y la TDZ, no ve si falta un simbolo.
//   F4 pregunta por cada identificador -> ve los simbolos, no ve su tamano.
//   F5 mide el tamano de cada simbolo  -> mata el stub vacio que satisface a los otros cuatro.
//   F6 busca simbolos de MAS           -> caza el duplicado que F4/F5 no pueden ver.
//   F7 DIBUJA el panel de IA           -> ejecuta el render, no solo la carga.
//   F8 DIBUJA la vista principal       -> lo mismo para la tabla de Compras/Diferidas y las cards,
//                                         que es donde se colaron los defectos de v6.0.0 y v6.1.0.

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { leer, analizarIndexHtml, resultado, conApp, pedir } = require('../lib');
const B = require('../linea_base');

const INDEX = (raiz) => path.join(raiz, 'public', 'index.html');

// Aplica una sustitucion en la pieza que REALMENTE contiene la aguja (index.html o cualquier
// public/js/*.js). Devuelve false si no la encuentra en ninguna, para que el control negativo
// falle ruidosamente en vez de mutar la nada.
function mutarEnAlgunaPieza(raiz, aguja, reemplazo) {
  const candidatos = [INDEX(raiz)];
  const dirJs = path.join(raiz, 'public', 'js');
  if (fs.existsSync(dirJs)) {
    for (const f of fs.readdirSync(dirJs)) if (f.endsWith('.js')) candidatos.push(path.join(dirJs, f));
  }
  for (const p of candidatos) {
    const src = leer(p);
    if (src.indexOf(aguja) !== -1) { fs.writeFileSync(p, src.replace(aguja, reemplazo), 'utf8'); return true; }
  }
  return false;
}

// Devuelve la ruta de la pieza que contiene la aguja, o null. Las mutaciones lo usan para no
// quedarse ancladas al archivo donde un simbolo vivia AYER.
function piezaQueContiene(raiz, aguja) {
  const candidatos = [INDEX(raiz)];
  const dirJs = path.join(raiz, 'public', 'js');
  if (fs.existsSync(dirJs)) {
    for (const f of fs.readdirSync(dirJs)) if (f.endsWith('.js')) candidatos.push(path.join(dirJs, f));
  }
  for (const p of candidatos) if (leer(p).indexOf(aguja) !== -1) return p;
  return null;
}

// Junta las piezas de JavaScript EN EL ORDEN EN QUE EL NAVEGADOR LAS EJECUTA.
// Es el orden de las etiquetas en el documento: los <script> clasicos son bloqueantes y
// secuenciales, asi que ese orden es el contrato real.
function piezasEnOrden(raiz) {
  const info = analizarIndexHtml(INDEX(raiz));
  const piezas = [];
  const publico = path.join(raiz, 'public');
  for (const t of info.tags) {
    if (t.src && /^https?:\/\//i.test(t.src)) continue;      // CDN: no es codigo nuestro
    if (t.src) {
      const p = path.join(publico, t.src.replace(/^\//, ''));
      // Un <script src> declarado pero inexistente es un FALLO, jamas un "no habia nada que mirar".
      if (!fs.existsSync(p)) { piezas.push({ nombre: t.src, fuente: null, falta: true }); continue; }
      piezas.push({ nombre: t.src, fuente: leer(p), ruta: p });
    } else if (info.inline) {
      piezas.push({ nombre: '<inline>', fuente: info.inline });
    }
  }
  return { info, piezas };
}

function volumen(piezas) {
  let bytes = 0, lineas = 0;
  for (const p of piezas) {
    if (!p.fuente) continue;
    bytes += Buffer.byteLength(p.fuente, 'utf8');
    lineas += p.fuente.split('\n').length;
  }
  return { bytes, lineas };
}

// ─── F1: sintaxis, descubriendo las entradas ────────────────────────────────
const F1 = {
  id: 'F1',
  nombre: 'Sintaxis del frontend (descubre sus entradas, no las asume)',
  medir(raiz) {
    const notas = [];
    let piezas, info;
    try { ({ piezas, info } = piezasEnOrden(raiz)); }
    catch (e) { return resultado(false, {}, ['FALLO leyendo index.html: ' + e.message]); }

    const faltantes = piezas.filter(p => p.falta);
    for (const f of faltantes) notas.push('FALLO: <script src="' + f.nombre + '"> declarado pero el archivo NO existe');

    let okSintaxis = true;
    for (const p of piezas) {
      if (!p.fuente) continue;
      try { new vm.Script(p.fuente, { filename: p.nombre }); }
      catch (e) { okSintaxis = false; notas.push('FALLO de sintaxis en ' + p.nombre + ': ' + e.message); }
    }

    const v = volumen(piezas);
    // EL PISO ES EL CORAZON DE ESTE DETECTOR. Sin el, cuando el codigo se mude a archivos
    // externos este mismo detector encontraria el par <script></script> con el bootstrap dentro
    // (~60 bytes), imprimiria "1 pieza validada, OK" y saldria con exito habiendo dejado de mirar
    // el 99,99% del codigo. No se dispararia ni siquiera una heuristica de "cero piezas".
    const cumpleBytes = v.bytes >= B.PISO_FRONTEND_BYTES;
    const cumpleLineas = v.lineas >= B.PISO_FRONTEND_LINEAS;
    if (!cumpleBytes) notas.push('FALLO: solo se validaron ' + v.bytes + ' bytes, por debajo del piso ' + B.PISO_FRONTEND_BYTES + ' -> el detector se quedo ciego');
    if (!cumpleLineas) notas.push('FALLO: solo se validaron ' + v.lineas + ' lineas, piso ' + B.PISO_FRONTEND_LINEAS);

    return resultado(okSintaxis && !faltantes.length && cumpleBytes && cumpleLineas,
      { piezas: piezas.length, locales: info.locales.length, cdn: info.cdn.length, bytes: v.bytes, lineas: v.lineas }, notas);
  },
  defecto: 'se borran las etiquetas <script src> y el inline queda solo con el bootstrap (el detector deja de ver el codigo)',
  mutar(raiz) {
    const p = INDEX(raiz);
    let html = leer(p);
    // Se quitan PRIMERO las etiquetas de los modulos externos. Sin este paso, la mutacion original
    // -reducir el inline al bootstrap- se convierte en un NO-OP en cuanto el refactor deja el
    // inline con solo el bootstrap: el arbol "defectuoso" sale identico al bueno y F1 se declara
    // invalido sin que nada este mal. La ceguera que este detector persigue es "dejo de mirar el
    // codigo", y desde la Etapa 2 el codigo vive en los archivos externos.
    const antes = html;
    html = html.replace(/[ \t]*<script src="js\/[^"]+"><\/script>\r?\n?/g, '');
    if (html === antes && /<script src="js\//.test(antes)) {
      throw new Error('la mutacion no pudo quitar las etiquetas <script src>');
    }
    const desde = html.indexOf('<script>');
    const hasta = html.indexOf('</script>', desde);
    html = html.slice(0, desde) + '<script>\nReactDOM.createRoot(document.getElementById("root")).render(e(App));\n' + html.slice(hasta);
    fs.writeFileSync(p, html, 'utf8');
  },
};

// ─── F2: validacion CONCATENADA ─────────────────────────────────────────────
const F2 = {
  id: 'F2',
  nombre: 'Concatenacion en orden de tags (colision de const entre archivos)',
  medir(raiz) {
    const notas = [];
    let piezas;
    try { ({ piezas } = piezasEnOrden(raiz)); }
    catch (e) { return resultado(false, {}, ['FALLO: ' + e.message]); }
    const fuentes = piezas.filter(p => p.fuente);
    if (!fuentes.length) return resultado(false, { piezas: 0 }, ['FALLO: no hay ninguna pieza que concatenar']);

    const texto = fuentes.map(p => p.fuente).join('\n;\n');
    // Varios <script> CLASICOS comparten el mismo ambito lexico global. Si dos archivos declaran
    // `const e`, el segundo lanza SyntaxError y NO EJECUTA NI UNA LINEA: se pierden de golpe todos
    // los componentes de ese archivo, con la app en blanco. Validar archivo por archivo da N/N
    // correcto porque cada uno es impecable en aislamiento; solo la concatenacion lo ve, igual que
    // lo veria el navegador. `e` (React.createElement) tiene ~2.168 usos: es el candidato numero
    // uno a que alguien lo copie en la cabecera de cada archivo nuevo.
    try { new vm.Script(texto, { filename: '<concatenado>' }); }
    catch (e) {
      notas.push('FALLO al concatenar: ' + e.message);
      return resultado(false, { piezas: fuentes.length, bytes: Buffer.byteLength(texto, 'utf8') }, notas);
    }
    return resultado(true, { piezas: fuentes.length, bytes: Buffer.byteLength(texto, 'utf8') }, notas);
  },
  defecto: 'se anade un segundo `const e` al final del script (la redeclaracion que produciria copiar la cabecera en dos archivos)',
  mutar(raiz) {
    const p = INDEX(raiz);
    const html = leer(p);
    const i = html.lastIndexOf('</script>');
    fs.writeFileSync(p, html.slice(0, i) + '\nconst e = 1;\n' + html.slice(i), 'utf8');
  },
};

// ─── Carga real con dobles (compartida por F3 y F4) ─────────────────────────
function cargarFrontend(raiz, opts) {
  const { piezas } = piezasEnOrden(raiz);
  const fuentes = piezas.filter(p => p.fuente);
  if (!fuentes.length) throw new Error('no hay codigo que cargar');
  const texto = fuentes.map(p => p.fuente).join('\n;\n');

  const marcas = { render: 0, createRoot: 0 };
  const hook = () => [undefined, () => {}];
  // `opts.React` deja que F7 monte el MISMO sandbox con hooks que si guardan estado. Sin este
  // parametro habria que copiar aqui abajo la lista entera de globales, y dos sandboxes que se
  // separan sin que nadie lo note es justo lo que este archivo evita en otros sitios.
  const React = (opts && opts.React) || {
    createElement: (t) => ({ __el: t }),
    useState: hook, useEffect: () => {}, useCallback: (f) => f, useRef: () => ({ current: null }),
    useMemo: (f) => (typeof f === 'function' ? f() : undefined), Fragment: 'Fragment',
  };
  const ReactDOM = { createRoot: () => { marcas.createRoot++; return { render: () => { marcas.render++; } }; } };
  // `opts.fetch` deja que F9 ejercite la capa api() con un doble instrumentado. Mismo motivo que
  // opts.React: un sandbox aparte acabaria teniendo su propia lista de globales, y dos listas que
  // se separan sin que nadie lo note es justo lo que este archivo evita.
  const fetchDoble = (opts && opts.fetch) || (() => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }));
  const almacen = {};
  const localStorage = {
    getItem: (k) => (k in almacen ? almacen[k] : null),
    setItem: (k, v) => { almacen[k] = String(v); },
    removeItem: (k) => { delete almacen[k]; },
  };
  const documento = {
    getElementById: () => ({}), activeElement: null,
    documentElement: { setAttribute: () => {}, getAttribute: () => null },
    addEventListener: () => {}, createElement: () => ({ style: {}, appendChild: () => {} }),
  };
  const ventana = { localStorage, addEventListener: () => {}, matchMedia: () => ({ matches: false, addEventListener: () => {} }) };
  const ctx = vm.createContext({
    React, ReactDOM, document: documento, window: ventana, localStorage,
    fetch: fetchDoble,
    console: { log: () => {}, warn: () => {}, error: () => {} },
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0,
    navigator: { clipboard: { writeText: () => Promise.resolve() } },
    crypto: { randomUUID: () => 'x'.repeat(36) },
    FileReader: function () {}, URL, Intl, JSON, Math, Date, Promise, Object, Array, String, Number,
    parseFloat, parseInt, isNaN, encodeURIComponent, Boolean, RegExp, Error, Map, Set,
  });
  ctx.globalThis = ctx;
  new vm.Script(texto, { filename: '<carga>' }).runInContext(ctx, { timeout: 20000 });
  return { ctx, marcas, texto };
}

// ─── F3: ejecucion de la carga ──────────────────────────────────────────────
const F3 = {
  id: 'F3',
  nombre: 'Ejecucion de la carga con dobles (orden entre archivos y TDZ)',
  medir(raiz) {
    const notas = [];
    let r;
    // Esto ejercita lo UNICO que corre en tiempo de carga: el alias `e`, la destructuracion de
    // hooks, los dos Object.freeze y -sobre todo- BANCOS_PRESETS, que LEE DEFAULT_BANCO_URLS y
    // DEFAULT_BANCO_COLORS al construirse. Es la unica dependencia const->const de todo el
    // monolito: si el reparto deja BANCOS_PRESETS en un archivo que carga antes, salta un
    // ReferenceError por TDZ y la app no monta. Ni vm.Script (que solo parsea) ni node --check
    // pueden verlo, y un smoke HTTP tampoco.
    try { r = cargarFrontend(raiz); }
    catch (e) { return resultado(false, {}, ['FALLO ejecutando la carga: ' + e.message]); }
    if (r.marcas.createRoot !== 1) notas.push('FALLO: createRoot se llamo ' + r.marcas.createRoot + ' veces (esperado 1)');
    if (r.marcas.render !== 1) notas.push('FALLO: render se llamo ' + r.marcas.render + ' veces (esperado 1) -> el bootstrap no llego a montar');
    return resultado(r.marcas.render === 1 && r.marcas.createRoot === 1,
      { createRoot: r.marcas.createRoot, render: r.marcas.render }, notas);
  },
  defecto: 'BANCOS_PRESETS se mueve ANTES de los dos Object.freeze que lee (rompe el unico orden de carga obligatorio)',
  mutar(raiz) {
    // Se localiza la pieza que contiene BANCOS_PRESETS en vez de asumir index.html: es el simbolo
    // que sostiene la UNICA dependencia de tiempo de carga del frontend, y el refactor lo mueve.
    // Si no se encuentra, se LANZA: mutar la nada daria un falso "no detectado" que parece culpa
    // del detector cuando en realidad el control negativo no llego a ejecutarse.
    const p = piezaQueContiene(raiz, 'const BANCOS_PRESETS');
    if (!p) throw new Error('no se encontro BANCOS_PRESETS en ninguna pieza');
    let src = leer(p);
    const iPres = src.indexOf('const BANCOS_PRESETS');
    const fin = src.indexOf('\n];', iPres) + 3;
    const bloque = src.slice(iPres, fin);
    src = src.slice(0, iPres) + src.slice(fin);
    const iUrls = src.indexOf('const DEFAULT_BANCO_URLS');
    if (iUrls === -1) {
      throw new Error('DEFAULT_BANCO_URLS no vive en la misma pieza que BANCOS_PRESETS: el orden de carga ENTRE archivos ya no lo cubre este control');
    }
    fs.writeFileSync(p, src.slice(0, iUrls) + bloque + '\n' + src.slice(iUrls), 'utf8');
  },
};

// ─── F4: manifiesto de simbolos ─────────────────────────────────────────────
const RUTA_SIMBOLOS = path.join(__dirname, '..', 'simbolos_base.json');

const F4 = {
  id: 'F4',
  // El rotulo decia "(68 exactos)" mientras la unica comparacion numerica era contra 67, y esa
  // yuxtaposicion con "vistos=67 esperados=67" hacia parecer inconsistente una salida correcta.
  nombre: 'Manifiesto de simbolos por identificador (68 + el bootstrap, que cubre F3)',
  medir(raiz) {
    const notas = [];
    // Un archivo de la suite AUSENTE es un FALLO, jamas un exito por omision.
    if (!fs.existsSync(RUTA_SIMBOLOS)) {
      return resultado(false, {}, ['FALLO: falta ' + path.basename(RUTA_SIMBOLOS) + ' (sin manifiesto no hay nada que comprobar)']);
    }
    const base = JSON.parse(leer(RUTA_SIMBOLOS));
    let r;
    try { r = cargarFrontend(raiz); }
    catch (e) { return resultado(false, {}, ['FALLO cargando: ' + e.message]); }

    // CLAVE: se evalua el IDENTIFICADOR, no se enumera el global. Los 12 const y el let de nivel
    // superior viven en el global lexical environment y NO aparecen como propiedades del objeto
    // global; un detector basado en Object.keys(contexto) no veria ninguno de los 13, y en cuanto
    // el refactor envolviera algo en una IIFE perderia tambien los 54 declarados con function,
    // sin un solo error. Evaluar `typeof <nombre>` si los ve.
    // La destructuracion `const { useState, ... } = React` no es un identificador evaluable: se
    // comprueban los seis hooks que introduce, que es lo que de verdad tiene que existir.
    const HOOKS = ['useState', 'useEffect', 'useCallback', 'useRef', 'useMemo', 'Fragment'];
    const faltan = [];
    for (const s of base.simbolos) {
      if (s.tipo === 'bootstrap') continue;
      const nombres = (s.tipo === 'destructuring') ? HOOKS : [s.nombre];
      for (const n of nombres) {
        let t;
        try { t = vm.runInContext('typeof ' + n, r.ctx); } catch (e) { t = 'error'; }
        if (t === 'undefined' || t === 'error') faltan.push(n);
      }
    }
    const vistos = base.simbolos.filter(s => s.tipo !== 'bootstrap').length - faltan.length;
    const esperados = B.EXACTO_SIMBOLOS - 1; // el bootstrap es una sentencia, no un identificador
    if (faltan.length) notas.push('FALLO: no se encontraron ' + faltan.length + ' simbolos: ' + faltan.slice(0, 8).join(', ') + (faltan.length > 8 ? '...' : ''));
    if (vistos !== esperados) notas.push('FALLO: ESPERADO ' + esperados + ' simbolos, vistos ' + vistos);
    return resultado(faltan.length === 0 && vistos === esperados, { vistos, esperados, faltan: faltan.length }, notas);
  },
  defecto: 'se renombra la declaracion de fmtUsd alli donde viva (un simbolo desaparece sin error de sintaxis)',
  mutar(raiz) {
    // La mutacion busca su objetivo en TODAS las piezas, no solo en index.html. Anclarla al archivo
    // donde el simbolo vivia ayer es la forma de que deje de aplicarse en silencio en cuanto el
    // refactor lo mueva: paso con este mismo detector al sacar fmtUsd a public/js/formato.js — la
    // sustitucion no encontraba nada, el arbol "defectuoso" era identico al bueno y F4 se declaraba
    // invalido sin que nada estuviera mal en el codigo.
    if (!mutarEnAlgunaPieza(raiz, 'function fmtUsd(', 'function fmtUsd_RENOMBRADA_POR_LA_MUTACION(')) {
      throw new Error('no se encontro fmtUsd en ninguna pieza: la mutacion no se pudo aplicar');
    }
  },
};

// ─── F5: piso de VOLUMEN por simbolo ────────────────────────────────────────
// Escanea las declaraciones de nivel superior y mide cuanto ocupa cada una.
function medirSimbolos(fuente) {
  const lineas = fuente.split('\n');
  const re = /^(const|let|var|class|function|async function)\s+([A-Za-z_$][\w$]*)/;
  const reDestr = /^const\s*\{/;
  const marcas = [];
  for (let i = 0; i < lineas.length; i++) {
    const m = lineas[i].match(re);
    if (m) { marcas.push({ nombre: m[2], tipo: m[1], desde: i }); continue; }
    if (reDestr.test(lineas[i])) marcas.push({ nombre: '{hooks}', tipo: 'destructuring', desde: i });
  }
  const out = [];
  for (let k = 0; k < marcas.length; k++) {
    let hasta = (k + 1 < marcas.length ? marcas[k + 1].desde : lineas.length) - 1;
    // ENDURECIMIENTO PREVENTIVO (auditoria previa a la Etapa 1 del refactor).
    // La medida ingenua "desde la declaracion hasta la siguiente menos uno" incluye las lineas en
    // blanco y los comentarios que preceden al simbolo SIGUIENTE, asi que el tamano de un simbolo
    // depende de lo que venga detras. En cuanto el refactor mueve un simbolo a otro archivo, el
    // que quedaba justo antes ABSORBE su hueco y F5 da un rojo que no corresponde a ningun cambio
    // de codigo — un falso positivo que empuja a relajar la tolerancia, que es justo como se
    // pierde el detector. Recortando hacia atras las lineas en blanco y de comentario, la medida
    // pasa a depender solo del propio simbolo y sobrevive a que se le mueva de archivo.
    // Ejemplo medido: bandaToleranciaCop daba 7 lineas porque se llevaba el comentario de
    // CHANGELOG; con el recorte da 5, y sigue dando 5 despues de sacar CHANGELOG del archivo.
    while (hasta > marcas[k].desde) {
      const t = (lineas[hasta] || '').trim();
      if (t === '' || t.indexOf('//') === 0) hasta--;
      else break;
    }
    // SEGUNDO ENDURECIMIENTO: buscar el CIERRE REAL del simbolo, no fiarse de lo que venga detras.
    // El recorte de arriba solo quita blancos y comentarios, asi que cualquier codigo de nivel
    // superior que NO sea una declaracion queda absorbido por el simbolo anterior. En este frontend
    // hay exactamente uno: el bootstrap ReactDOM.createRoot(...).render(e(App)), que se contabilizaba
    // dentro de App (410 lineas en vez de 407). Al mover App a su archivo el bootstrap se queda en
    // index.html y F5 canta un cambio de tamano que no corresponde a ninguna modificacion de codigo.
    // Con el cierre real -la primera llave o corchete en columna 0 despues de la declaracion- la
    // medida deja de depender del entorno del simbolo.
    const decl = (lineas[marcas[k].desde] || '').trim();
    if (/[};]$/.test(decl)) {
      hasta = marcas[k].desde;                       // declaracion de una sola linea
    } else {
      for (let j = marcas[k].desde + 1; j <= hasta; j++) {
        if (/^[}\]]/.test(lineas[j] || '')) { hasta = j; break; }
      }
    }
    out.push({ nombre: marcas[k].nombre, tipo: marcas[k].tipo, lineas: hasta - marcas[k].desde + 1 });
  }
  return out;
}

const F5 = {
  id: 'F5',
  nombre: 'Piso de VOLUMEN por simbolo (mata el stub vacio)',
  medir(raiz) {
    const notas = [];
    if (!fs.existsSync(RUTA_SIMBOLOS)) return resultado(false, {}, ['FALLO: falta simbolos_base.json']);
    const base = JSON.parse(leer(RUTA_SIMBOLOS));
    const { piezas } = piezasEnOrden(raiz);
    // Se miden todas las piezas juntas: tras el refactor cada simbolo vivira en su archivo, y lo
    // que importa es que su TAMANO no haya cambiado, no donde este.
    const actuales = {};
    for (const p of piezas) {
      if (!p.fuente) continue;
      for (const s of medirSimbolos(p.fuente)) actuales[s.nombre] = s.lineas;
    }
    // Un piso por UNIDADES (">= N simbolos") se satisface con N stubs de 8 bytes. Este exige que
    // cada simbolo siga pesando lo mismo: un refactor que solo MUEVE lo cumple por definicion;
    // un borrado, un stub o una "mejora" colada de contrabando, no.
    const desviados = [];
    let ausentes = 0;
    for (const s of base.simbolos) {
      if (s.tipo === 'bootstrap' || s.tipo === 'destructuring') continue;
      const act = actuales[s.nombre];
      if (act === undefined) { ausentes++; desviados.push(s.nombre + ': AUSENTE'); continue; }
      const d = Math.abs(act - s.lineas);
      if (d > B.TOLERANCIA_LINEAS_SIMBOLO) desviados.push(s.nombre + ': ' + s.lineas + ' -> ' + act + ' (delta ' + d + ')');
    }
    if (desviados.length) notas.push('FALLO: ' + desviados.length + ' simbolos cambiaron de tamano: ' + desviados.slice(0, 6).join(' | '));
    return resultado(desviados.length === 0,
      { medidos: Object.keys(actuales).length, base: base.simbolos.length, desviados: desviados.length, ausentes }, notas);
  },
  defecto: 'el cuerpo de CardResumen (el simbolo mas grande, ~1.792 lineas) se sustituye por un stub de una linea',
  mutar(raiz) {
    // Se localiza la pieza que contiene el simbolo. Anclarla a index.html tenia un fallo peor que
    // no encontrarlo: con indexOf devolviendo -1, el slice(0,-1)+slice(-1) inyectaba el stub al
    // final del HTML, FUERA de cualquier <script>. El arbol quedaba "mutado" sin que el codigo
    // cambiara, F5 medira lo mismo y el control negativo daba un falso "no detectado".
    const p = piezaQueContiene(raiz, 'function CardResumen(');
    if (!p) throw new Error('no se encontro CardResumen en ninguna pieza');
    const src = leer(p);
    const i = src.indexOf('function CardResumen(');
    const j = src.indexOf('\nfunction ', i + 10);
    const cola = (j === -1) ? '' : src.slice(j);   // es el ultimo simbolo de su archivo
    fs.writeFileSync(p, src.slice(0, i) + 'function CardResumen() { return null; }\n' + cola, 'utf8');
  },
};

// ─── F6: el arbol no tiene simbolos de MAS (sobrantes ni duplicados) ────────
// LA MITAD QUE FALTABA DEL CONTRATO. linea_base.js declara que el conteo de simbolos es EXACTO
// porque "mover codigo no crea ni destruye simbolos de nivel superior", pero F4 y F5 solo
// recorren base -> arbol: comprueban que nada se DESTRUYO. Nadie recorria arbol -> base, asi que
// un simbolo AÑADIDO o DUPLICADO pasaba invisible.
//
// El caso peligroso es el duplicado, porque ningun otro detector puede verlo: en scripts clasicos
// una `function` se puede redeclarar sin error (F2 solo caza la colision de `const`), F1 tiene
// cotas inferiores de volumen, y el mapa de F5 es ultima-escritura-gana, asi que una copia
// colocada en una pieza ANTERIOR a la original queda tapada por el valor de la original. Un
// refactor que copia en vez de mover es exactamente lo que produce ese estado.
const F6 = {
  id: 'F6',
  nombre: 'El arbol no tiene simbolos de MAS (sobrantes ni duplicados)',
  medir(raiz) {
    const notas = [];
    if (!fs.existsSync(RUTA_SIMBOLOS)) return resultado(false, {}, ['FALLO: falta simbolos_base.json']);
    const base = JSON.parse(leer(RUTA_SIMBOLOS));
    const enBase = new Set(base.simbolos.map(s => s.nombre));
    const { piezas } = piezasEnOrden(raiz);

    const primeraVez = {};
    const duplicados = [], sobrantes = [];
    let halladas = 0;
    for (const p of piezas) {
      if (!p.fuente) continue;
      for (const s of medirSimbolos(p.fuente)) {
        halladas++;
        if (primeraVez[s.nombre] !== undefined) {
          duplicados.push(s.nombre + ' (en ' + primeraVez[s.nombre] + ' y en ' + p.nombre + ')');
        } else {
          primeraVez[s.nombre] = p.nombre;
        }
        if (!enBase.has(s.nombre)) sobrantes.push(s.nombre + ' (en ' + p.nombre + ')');
      }
    }

    if (duplicados.length) notas.push('FALLO: ' + duplicados.length + ' simbolos DUPLICADOS entre piezas: ' + duplicados.slice(0, 5).join(' | '));
    if (sobrantes.length) notas.push('FALLO: ' + sobrantes.length + ' simbolos en el arbol que NO estan en el manifiesto: ' + sobrantes.slice(0, 5).join(' | '));
    // EXACTO, no un piso: si aparece una declaracion de nivel superior que la base no conoce, o el
    // refactor la creo (y entonces ya no es "solo movimiento") o el manifiesto se quedo viejo. Las
    // dos cosas tienen que resolverse a mano, nunca en silencio.
    if (halladas !== B.EXACTO_DECLARACIONES) {
      notas.push('FALLO: ESPERADAS ' + B.EXACTO_DECLARACIONES + ' declaraciones de nivel superior, halladas ' + halladas);
    }
    return resultado(duplicados.length === 0 && sobrantes.length === 0 && halladas === B.EXACTO_DECLARACIONES,
      { halladas: halladas, esperadas: B.EXACTO_DECLARACIONES, duplicados: duplicados.length, sobrantes: sobrantes.length }, notas);
  },
  defecto: 'se copia una funcion existente en una pieza ANTERIOR a la original (un refactor que copia en vez de mover): ningun otro detector puede verlo',
  mutar(raiz) {
    // La copia va en la PRIMERA pieza a proposito. Como el mapa de F5 es ultima-escritura-gana, el
    // tamano que acaba comparando es el de la declaracion original -que sigue intacta-, asi que F5
    // no ve nada; F4 tampoco (el identificador existe), ni F2 (redeclarar una function es legal),
    // ni F1 (sus pisos son cotas inferiores). Si la copia se pusiera en una pieza POSTERIOR, F5 la
    // cazaria por el cambio de tamano y este control negativo dejaria de ser especifico de F6.
    const { piezas } = piezasEnOrden(raiz);
    const conRuta = piezas.filter(p => p.fuente && p.ruta);
    if (conRuta.length < 2) throw new Error('hacen falta al menos dos piezas con archivo propio para inyectar el duplicado');
    const primera = conRuta[0];
    // Se duplica un simbolo declarado en una pieza POSTERIOR a la primera, para que la original
    // gane en el mapa de F5 y el defecto quede invisible para todos menos para F6.
    let objetivo = null;
    for (let i = 1; i < conRuta.length && !objetivo; i++) {
      for (const s of medirSimbolos(conRuta[i].fuente)) {
        if (s.tipo === 'function') { objetivo = s.nombre; break; }
      }
    }
    if (!objetivo) throw new Error('no se encontro ninguna funcion en las piezas posteriores para duplicar');
    fs.writeFileSync(primera.ruta,
      leer(primera.ruta) + '\nfunction ' + objetivo + '() { return null; }\n', 'utf8');
  },
};

// ─── Andamiaje de F7: montar el frontend con hooks que SI guardan estado ────
// Reusa el sandbox de cargarFrontend (una sola lista de globales) y solo cambia el objeto React.
// `semilla` permite fijar el valor inicial de un useState por su posicion; `ctx.__hooks` devuelve los
// valores iniciales EN ORDEN DE LLAMADA, que es lo que permite localizar una ranura sin escribir su
// indice a mano y sin quedarse callado si alguien reordena los hooks.
function montarConEstado(raiz, semilla, opts) {
  const store = (semilla || []).slice();
  const orden = [];
  const llamadas = [];
  const efectos = [];
  const refs = [];
  let idx = 0;
  const React = {
    createElement: (t, props, ...hijos) => ({ type: t, props: props || {}, hijos }),
    useState: (init) => {
      const i = idx++;
      // React INVOCA el inicializador lazy (useState(() => ...)) y guarda su RESULTADO. El doble
      // guardaba la funcion tal cual, asi que un estado lazy -como los `splits` de CompraForm-
      // llegaba al render como funcion y reventaba en el primer .map. Es la trampa que ya mordio
      // en v6.1.0: aqui el doble se alinea con React en vez de obligar a esquivarla.
      const valor = typeof init === 'function' ? init() : init;
      orden[i] = valor;
      if (!(i in store) || store[i] === undefined) store[i] = valor;
      // Los setters siguen SIN re-renderizar, pero ahora dejan constancia de con que se les llamo.
      // Eso permite auditar la aritmetica de un onClick que actualiza estado (el "repartir en partes
      // iguales") aplicando su updater al valor actual, sin tener que montar un React de verdad.
      return [store[i], (v) => { llamadas.push({ ranura: i, valor: v }); }];
    },
    // Los efectos NO se ejecutan al montar (igual que antes): se RECOGEN, para que el detector
    // decida cuales corre y cuando. Ejecutarlos aqui dispararia peticiones y setState en todos los
    // detectores que ya usan este sandbox, que es justo lo que no debe cambiar.
    useEffect: (fn, deps) => { efectos.push({ fn: fn, deps: deps }); },
    useCallback: (f) => f,
    // useRef respeta su valor inicial (React lo hace) y ademas queda accesible: el seguro anti-bucle
    // de la cadena USD vive en un ref, y sin poder leerlo no hay forma de comprobar que se armo.
    useRef: (init) => { const r = { current: init === undefined ? null : init }; refs.push(r); return r; },
    // useLayoutEffect NO esta desestructurado en core.js: se usa via React.* (el FLIP del
    // reordenamiento de v6.0.0). Sin el, CardResumen revienta antes de dibujar una sola fila.
    useLayoutEffect: () => {},
    useMemo: (f) => (typeof f === 'function' ? f() : undefined), Fragment: 'Fragment',
  };
  const { ctx } = cargarFrontend(raiz, { React, fetch: opts && opts.fetch });
  ctx.__hooks = orden;
  ctx.__setState = llamadas;
  ctx.__efectos = efectos;
  ctx.__refs = refs;
  return ctx;
}

// Recorrido del arbol de elementos que devuelve el createElement de arriba.
function recorrerArbol(nodo, fn) {
  if (nodo == null || typeof nodo === 'boolean') return;
  if (Array.isArray(nodo)) { for (const n of nodo) recorrerArbol(n, fn); return; }
  if (typeof nodo !== 'object') return;
  fn(nodo);
  if (nodo.hijos) for (const h of nodo.hijos) recorrerArbol(h, fn);
}
function textoDe(nodo) {
  let t = '';
  recorrerArbol(nodo, n => { if (n.hijos) for (const h of n.hijos) if (typeof h === 'string') t += h + ' '; });
  return t;
}
function buscarNodo(arbol, pred) {
  let hallado = null;
  recorrerArbol(arbol, n => { if (!hallado && pred(n)) hallado = n; });
  return hallado;
}
function botonesDe(arbol) {
  const out = [];
  recorrerArbol(arbol, n => {
    if (n.type === 'button') out.push({ texto: textoDe(n).trim(), disabled: !!n.props.disabled, onClick: typeof n.props.onClick === 'function' });
  });
  return out;
}

// ─── F7: RENDER real del panel de conciliacion IA ───────────────────────────
//
// POR QUE EXISTE: F3 ejercita el TIEMPO DE CARGA (el alias `e`, los Object.freeze, el orden entre
// archivos) y ahi se queda. Nadie DIBUJA un componente. `IaResultado` es la superficie mas compleja
// del frontend -es la que decide que botones se pueden pulsar sobre el dinero del usuario- y un
// identificador mal escrito dentro de su render no revienta hasta que alguien abre el modal en la
// app real: F1 lo ve sintacticamente correcto, F5 no nota el cambio de tamano y F4/F6 solo miran
// declaraciones de nivel superior. Probado con mutacion cruzada: el defecto de aqui abajo deja los
// otros 17 detectores en VERDE.
//
// Los dobles de F3 no sirven para esto: su `useState` devuelve [undefined, noop], asi que el primer
// `aplicadas[i]` del render lanza TypeError sobre undefined. Aqui los hooks tienen ESTADO real,
// indexados por orden de llamada (que es estable por las reglas de React) y con el contenido de cada
// posicion COMPROBADO antes de usarlo: si alguien reordena los useState, el detector lo dice en vez
// de sembrar en la ranura equivocada y medir otra cosa.
const F7 = {
  id: 'F7',
  nombre: 'Render real del panel de conciliacion IA (ningun otro detector lo dibuja)',
  async medir(raiz) {
    const notas = [];
    const cifras = {};
    let ctx;
    try { ctx = montarConEstado(raiz, []); }
    catch (e) { return resultado(false, {}, ['FALLO cargando el frontend: ' + e.message]); }
    if (typeof ctx.IaResultado !== 'function') {
      return resultado(false, {}, ['FALLO: IaResultado no es alcanzable en el ambito global']);
    }

    // Fixture con las tres formas que conviven en la lista: una accion normal, una sobre compra
    // DIVIDIDA (dos partes del mismo grupo) y la cifra oficial, que es la que la jerarquia bloquea.
    const GRUPO = 'g-test';
    const compras = [
      { id: 501, descripcion: 'COMERCIO A', ciclo: '2026-07', valor_cop: 400000, grupo_id: GRUPO, persona_id: 1, tarjeta_id: 4, fecha: '2026-07-30' },
      { id: 502, descripcion: 'COMERCIO A', ciclo: '2026-07', valor_cop: 277853, grupo_id: GRUPO, persona_id: 2, tarjeta_id: 4, fecha: '2026-07-30' },
      { id: 503, descripcion: 'COMERCIO B', ciclo: '2026-07', valor_cop: 39800, grupo_id: null, persona_id: null, tarjeta_id: 4, fecha: '2026-07-26' },
    ];
    const resultadoIa = {
      conciliacion_pago_minimo: { pago_minimo_extracto: 3539098, pago_minimo_app: 4207929, diferencia: 668831, explicacion: ['linea de prueba'] },
      pagos_detectados: [],
      discrepancias: [
        { tipo: 'otro', severidad: 'media', descripcion: 'parte de compra dividida', valor_extracto: 0, valor_app: 400000,
          accion_sugerida: { operacion: 'mover_ciclo', parametros: { compra_id: 501, ciclo: '2026-08' } } },
        { tipo: 'monto_erroneo', severidad: 'alta', descripcion: 'valor distinto', valor_extracto: 39900, valor_app: 39800,
          accion_sugerida: { operacion: 'editar_valor', parametros: { compra_id: 503, valor_cop: 39900 } } },
        { tipo: 'pago_minimo_oficial', severidad: 'media', descripcion: 'cifra del extracto', valor_extracto: 3539098, valor_app: 4207929,
          accion_sugerida: { operacion: 'fijar_pago_minimo_oficial', parametros: { pago_minimo: 3539098, ciclo: '2026-07' } } },
      ],
    };
    const props = { resultado: resultadoIa, isMock: false, tarjetaId: 4, ciclo: '2026-07',
      onAplicada: () => {}, onReanalizar: () => {}, reanalizando: false };

    // ── a) lista de discrepancias, con la tabla de compras ya cargada ────────
    let arbol;
    const semilla = [];
    try {
      const sonda = montarConEstado(raiz, []);
      const orden = sonda.__hooks;                       // valores iniciales, en orden de llamada
      sonda.IaResultado(props);
      const iCompras = orden.findIndex(v => Array.isArray(v));
      if (iCompras < 0) {
        return resultado(false, {}, ['FALLO: ningun useState de IaResultado arranca con un array -> ' +
          'la lista de compras ya no se guarda asi y este detector estaria sembrando en la ranura equivocada']);
      }
      semilla[iCompras] = compras;
      cifras.ranuraCompras = iCompras;
    } catch (e) {
      return resultado(false, {}, ['FALLO sondeando el orden de los hooks: ' + e.message]);
    }
    try {
      const c2 = montarConEstado(raiz, semilla);
      arbol = c2.IaResultado(props);
    } catch (e) {
      return resultado(false, cifras, ['FALLO renderizando IaResultado: ' + e.message]);
    }
    if (!arbol || arbol.type !== 'div') notas.push('FALLO: el render no devolvio un elemento');

    const bts = botonesDe(arbol);
    const aplicar = bts.filter(b => b.texto === 'Aplicar');
    cifras.botones = bts.length;
    cifras.aplicar = aplicar.length;
    if (aplicar.length !== 3) notas.push('FALLO: se esperaban 3 botones "Aplicar" (uno por discrepancia), hay ' + aplicar.length);
    // La cifra oficial va de ULTIMA y tiene que estar BLOQUEADA mientras haya estructurales sin
    // resolver: es el candado que evita sellar el mes sobre una lista de compras incompleta.
    if (aplicar.length === 3) {
      if (aplicar[0].disabled) notas.push('FALLO: el mover_ciclo de una compra dividida quedo deshabilitado');
      if (!aplicar[2].disabled) notas.push('FALLO: "fijar cifra oficial" NO esta bloqueado habiendo cambios estructurales pendientes');
      if (aplicar[2].onClick) notas.push('FALLO: el boton bloqueado conserva onClick -> se puede disparar igual');
    }
    const desc = bts.filter(b => b.texto === 'Descartar').length;
    cifras.descartar = desc;
    // Invariante del candado: todo lo que bloquea tiene que poder resolverse, o es una trampa.
    if (desc !== 2) notas.push('FALLO: se esperaban 2 botones "Descartar" (uno por estructural pendiente), hay ' + desc);

    // ── b) modal de confirmacion: es donde corre resumenAccion ──────────────
    try {
      const iAccion = 0;   // accionSel es el primer useState del componente
      const s2 = semilla.slice();
      s2[iAccion] = { d: resultadoIa.discrepancias[0], idx: 0 };
      const c3 = montarConEstado(raiz, s2);
      const arbol2 = c3.IaResultado(props);
      const modal = buscarNodo(arbol2, n => n.props && n.props.title === 'Confirmar accion');
      if (!modal) {
        notas.push('FALLO: con accionSel puesto no se renderizo el modal de confirmacion -> resumenAccion no se ejercita');
      } else {
        const t = textoDe(modal);
        cifras.modal = t.length;
        if (t.indexOf('#501') === -1 || t.indexOf('#502') === -1) {
          notas.push('FALLO: el modal de una compra DIVIDIDA no lista sus dos partes (#501 y #502): ' + t.slice(0, 160));
        }
      }
    } catch (e) {
      notas.push('FALLO renderizando el modal de confirmacion: ' + e.message);
    }

    // ── c) el PAYLOAD de la reprogramacion: a QUE endpoint va y con que cuerpo ─────
    // Es el fallo que el PO vio en pantalla el 1-sep-2026. Un plan que YA facturo cuotas no se puede
    // reprogramar regenerandolo desde el origen (/diferidas/:id/reprogramar): eso reescribe las
    // cuotas que el banco ya cobro, y el backend lo rechaza en cuanto una cayo en un mes pagado
    // ("la diferida ya tiene cuotas facturadas en ciclos pagados"). Ese caso es Sellar y Renacer.
    // Y tiene que declarar el ciclo EFECTIVO -el del extracto que se concilia-, porque un extracto
    // llega SIEMPRE despues de su corte: sin declararlo el endpoint sella un mes de mas y corre la
    // compresion al mes siguiente (medido con NETFLIX). Se mide el cuerpo que sale por fetch, no el
    // endpoint invocado a mano: la leccion de F9/F12 es que el camino real es el que falla.
    for (const caso of [
      { etiqueta: 'plan con cuotas ya facturadas', cortes: ['2026-05-30', '2026-06-30', '2026-07-30'], destino: '/compras/601/reprogramar-saldo' },
      { etiqueta: 'plan sin nada facturado', cortes: ['2026-07-30', '2026-08-30'], destino: '/diferidas/71/reprogramar' },
    ]) {
      const enviados = [];
      const espia = (url, opts) => {
        const u = String(url);
        const metodo = (opts && opts.method) || 'GET';
        let cuerpo = null;
        try { cuerpo = opts && opts.body ? JSON.parse(opts.body) : null; } catch (e2) { cuerpo = opts && opts.body; }
        enviados.push({ url: u, metodo: metodo, cuerpo: cuerpo });
        let datos = { ok: true };
        if (metodo === 'GET' && u.indexOf('/compras?') !== -1) {
          datos = [{ id: 601, descripcion: 'NETFLIX', diferida_id: 71, ciclo: '2026-07', tarjeta_id: 4 }];
        } else if (metodo === 'GET' && u.indexOf('/diferidas/71') !== -1) {
          datos = { id: 71, num_cuotas: caso.cortes.length, monto: 44900, compra_id: 601,
            amortizacion: caso.cortes.map((fc, i) => ({ numCuota: i + 1, fechaCorte: fc, cuotaCapital: 44900 / caso.cortes.length })) };
        }
        return Promise.resolve({ ok: true, json: () => Promise.resolve(datos) });
      };
      const dRepro = { tipo: 'cuota_reprogramada', severidad: 'media', descripcion: 'el banco comprimio la cuota',
        valor_extracto: 22450, valor_app: 14967, compra_id: 601,
        accion_sugerida: { operacion: 'reprogramar_cuotas', parametros: { compra_id: 601, num_cuotas: 3 } } };
      const sC = semilla.slice();
      sC[0] = { d: dRepro, idx: 0 };
      const cC = montarConEstado(raiz, sC, { fetch: espia });
      if (cC.window) cC.window.__addToast = () => {};
      let btnC = null;
      try {
        const arbolC = cC.IaResultado(props);
        btnC = buscarNodo(arbolC, n => n.type === 'button' && /Confirmar y aplicar/.test(textoDe(n)));
      } catch (e3) {
        notas.push('FALLO [REPRO/' + caso.etiqueta + '] renderizando el modal: ' + e3.message);
        continue;
      }
      if (!btnC || typeof btnC.props.onClick !== 'function') {
        notas.push('FALLO de sanidad [REPRO/' + caso.etiqueta + ']: no se encontro el boton "Confirmar y aplicar" del modal');
        continue;
      }
      await btnC.props.onClick();
      const post = enviados.filter(x => x.metodo === 'POST')[0];
      if (!post) {
        const dicho = cC.__setState.map(x => x.valor).filter(v => typeof v === 'string' && v.length > 3);
        notas.push('FALLO [REPRO/' + caso.etiqueta + ']: confirmar la reprogramacion no envio ningun POST' +
          (dicho.length ? ' (la vista reporto: ' + dicho[0] + ')' : ''));
        continue;
      }
      if (post.url.indexOf(caso.destino) === -1) {
        notas.push('FALLO [REPRO/' + caso.etiqueta + ']: la reprogramacion fue a ' + post.url + ' y tenia que ir a ' + caso.destino +
          (caso.destino.indexOf('reprogramar-saldo') !== -1
            ? ' -> regenerar el plan desde el origen reescribe cuotas ya facturadas: el backend lo rechaza si alguna cayo en un mes pagado'
            : ' -> sin nada facturado no hay nada que sellar'));
        continue;
      }
      cifras['repro_' + (caso.destino.indexOf('saldo') !== -1 ? 'sellado' : 'plan')] = post.metodo + ' ' + post.url.replace(/^.*\/api/, '/api');
      if (caso.destino.indexOf('reprogramar-saldo') === -1) continue;
      const cu = post.cuerpo || {};
      if (cu.ciclo_efectivo !== props.ciclo) {
        notas.push('FALLO [REPRO/ciclo efectivo]: viaja ciclo_efectivo=' + JSON.stringify(cu.ciclo_efectivo) + ' en vez de ' + props.ciclo +
          ' -> el backend sella un mes de mas y corre la compresion al mes siguiente');
      }
      if (Number(cu.capital_cuota_extracto) !== 22450) {
        notas.push('FALLO [REPRO/capital del extracto]: viaja capital_cuota_extracto=' + JSON.stringify(cu.capital_cuota_extracto) +
          ' en vez de 22450 -> sin esa cifra el backend no puede deducir el plan original del banco y reparte uniforme');
      }
      if (Number(cu.num_cuotas_nuevas) !== 3) {
        notas.push('FALLO [REPRO/total]: viaja num_cuotas_nuevas=' + JSON.stringify(cu.num_cuotas_nuevas) + ' en vez de 3');
      }
    }

    return resultado(notas.length === 0, cifras, notas);
  },
  defecto: 'se rompe un identificador DENTRO del render de IaResultado (un typo que ningun otro detector puede ver)',
  mutar(raiz) {
    // Se busca por CONTENIDO y se LANZA si no aparece: una mutacion que no se aplica daria un falso
    // "no detectado" que parece culpa del detector. Se elige una llamada que ocurre en el camino de
    // render de la lista, no en un manejador de eventos (esos no se ejecutan al dibujar).
    const { piezas } = piezasEnOrden(raiz);
    const pieza = piezas.find(p => p.ruta && p.fuente && p.fuente.indexOf('function IaResultado') !== -1);
    if (!pieza) throw new Error('no se encontro la pieza que declara IaResultado');
    const src = leer(pieza.ruta);
    const aguja = 'fmtOperacion(op)';
    if (src.indexOf(aguja) === -1) throw new Error('no se encontro "' + aguja + '" dentro del render de IaResultado');
    fs.writeFileSync(pieza.ruta, src.replace(aguja, 'fmtOperacionQueNoExiste(op)'), 'utf8');
  },
};

// ─── Andamiaje de F8: escenario SEMBRADO para la vista principal ────────────
// Los 33 campos escalares que el render de CardResumen llega a leer de `data`. Se descubrieron
// instrumentando el render con un Proxy, no a ojo. Van a 0 y el caso de prueba sobrescribe solo lo
// que mide: asi el fixture es corto y cada cifra que aparece en un aserto esta puesta a proposito.
const CAMPOS_DATA_F8 = ['comprasCiclo', 'comprasTotalPendientes', 'comprasTotalPendientesUsd', 'cuotasCorte',
  'deudaAvances', 'deudaDiferidas', 'deudaDiferidasUsd', 'deudaPersonal', 'deudaPersonalAvances',
  'deudaPersonalCompras', 'deudaPersonalDiferidas', 'deudaPersonalIntIntl', 'deudaPersonalUsd', 'deudaTotal',
  'deudaTotalEnCop', 'deudaUsd', 'dualExtracto', 'interesesComprasIntl', 'interesesComprasUsd', 'interesesMes',
  'interesesMesAvances', 'interesesMesDiferidas', 'interesesMesDiferidasUsd', 'interesesMesUsd', 'minimoUsd',
  'montoPagadoExtracto', 'pagoMinimo', 'saldoBolsillo', 'saldoBolsilloAbonado', 'saldoBolsilloBruto',
  'saldoBolsilloUsd', 'saldoBolsilloUsdAbonado', 'saldoBolsilloUsdBruto'];

// El escenario NO sale de la BD real, a proposito: asi este detector no caduca cada vez que el
// usuario registra una compra. Mide REGRESIONES DE UI, no el estado de los datos (de eso ya se
// ocupan R4 y R5).
function fixtureDataF8(over) {
  const d = {};
  CAMPOS_DATA_F8.forEach(k => { d[k] = 0; });
  d.extractoCiclo = { estado: 'pendiente', pago_minimo: 3000000, monto_pagado: 0, fecha_pagado: null };
  d.meDeben = { total: 0, totalUsd: 0, detalle: [] };
  d.meDebenCorte = { total: 0, totalUsd: 0, detalle: [] };
  d.proximoCorte = { fecha: '2026-08-30', diasFaltan: 16 };
  d.fechaPago = { fecha: '2026-09-15', diasFaltan: 32, esManual: false };
  d.proximosPagos = [];
  d.extractosVencidos = [];
  // Cifras redondas para que los asertos de las cards sean legibles: 10M sobre un cupo de 40M
  // son 25.0% usado y 30M disponibles.
  d.deudaTotal = 10000000; d.deudaTotalEnCop = 10000000;
  d.pagoMinimo = 3000000;
  // Caso REAL que motivo el rediseno de la card (julio de la Visa): se aparto dinero y ya se abono
  // mas que eso al extracto, asi que el NETO esta saturado en 0. Con el neto como valor principal,
  // la card se quedaba clavada en $0 mientras el usuario seguia apartando.
  d.saldoBolsilloBruto = 534078; d.saldoBolsilloAbonado = 1400000; d.saldoBolsillo = 0;
  return Object.assign(d, over || {});
}
const TARJETA_F8 = { id: 4, nombre: 'Tarjeta F8', dia_corte: 30, banco: 'Bancolombia', franquicia: 'Visa',
  cupo_total: 40000000, ciclo_vigente: '2026-08', ciclo_sugerido: '2026-08', cortes_custom: {} };
// Las cuatro formas que conviven en la tabla de Compras y que se tratan DISTINTO al dibujar.
// Nombres distinguibles entre tablas: la misma cuota se ve en Compras y en Diferidas, y con el
// mismo texto un aserto no podria decir en cual de las dos esta mirando.
const COMPRAS_F8 = [
  { id: 901, fecha: '2026-08-05', descripcion: 'COMPRA NORMAL F8', valor_cop: 120000, estado: 'pendiente', ciclo: '2026-08', notas: null, monto_abonado: 0, monto_bolsillo: 0, persona_id: null },
  { id: 902, fecha: '2026-08-04', descripcion: 'CUOTA SELLADA COMPRA F8', valor_cop: 11225, estado: 'pendiente', ciclo: '2026-08', notas: 'Cuota 1/3 sellada por reprogramacion de saldo (4->3)', monto_abonado: 0, monto_bolsillo: 0, persona_id: null },
  { id: 903, fecha: '2026-08-03', descripcion: 'SALDO RENACIDO F8', valor_cop: 33675, estado: 'diferida', ciclo: '2026-08', notas: 'Saldo reprogramado', sin_gracia_cuota1: 1, diferida_id: 801, cuota_num: 1, cuotas_total: 2, monto_abonado: 0, monto_bolsillo: 0, persona_id: null },
  { id: 904, fecha: '2026-08-02', descripcion: 'COMPRA TERCERO F8', valor_cop: 50000, estado: 'pendiente', ciclo: '2026-08', notas: null, monto_abonado: 0, monto_bolsillo: 0, persona_id: 7, persona_nombre: 'Tercero F8', persona_color: '#ff0000' },
  // ANULADA por el banco: la neutralizacion la deja en 'pagado' con monto_abonado = valor (asi su
  // deuda es CERO en toda consulta sin tocar ninguna), que es exactamente la forma que la tabla
  // interpretaba como "Pagado". El cargo NUNCA entro a la facturacion: no es algo que se pagara.
  { id: 905, fecha: '2026-08-01', descripcion: 'COMPRA ANULADA F8', valor_cop: 882000, estado: 'pagado', ciclo: '2026-08', notas: 'Anulada por el banco (no entro al extracto)', monto_abonado: 882000, monto_bolsillo: 0, persona_id: null, anulada: 1 },
];
const DIFERIDAS_F8 = [
  { id: 801, etiqueta: 'PLAN LIBRE F8', monto: 300000, tasa_mv: 0.02, num_cuotas: 3, fecha_compra: '2026-08-01',
    saldoActual: 200000, cuotaCorte: 100000, cuotasRestantes: 2, ciclos: ['2026-08'], compra_id: 903, grupo_id: null,
    es_de_tercero: false, persona_id: null, monto_bolsillo: 0, bolsillo_por_cuota: {}, bloqueo_banco: null,
    es_usd_pura: false, tiene_abono_parcial: false, tercero_con_reembolso: false, reprog_total: null },
  { id: 802, etiqueta: 'PLAN BLOQUEADO F8', monto: 400000, tasa_mv: 0.018, num_cuotas: 24, fecha_compra: '2025-11-01',
    saldoActual: 250000, cuotaCorte: 16000, cuotasRestantes: 15, ciclos: ['2026-08'], compra_id: null, grupo_id: null,
    es_de_tercero: false, persona_id: null, monto_bolsillo: 0, bolsillo_por_cuota: {},
    bloqueo_banco: 'RappiCard no permite cambiar las cuotas de un extracto ya cerrado (2025-11).',
    es_usd_pura: false, tiene_abono_parcial: false, tercero_con_reembolso: false, reprog_total: null },
  { id: 'sellada-902', _sellada: true, etiqueta: 'CUOTA SELLADA DIF F8', fecha_compra: '2026-08-04', cuotaCorte: 11225,
    saldoActual: 11225, cuotasRestantes: 0, ciclos: ['2026-08'], cuota_num_sellada: 1, reprog_total_sellada: 3,
    estado_sellada: 'pendiente', es_de_tercero: false, persona_id: null, compra_id: 902, valor_cop: 11225,
    interes_sellado: 0, monto_bolsillo: 0, bolsillo_por_cuota: {} },
];

// Dibuja CardResumen con el escenario sembrado. Devuelve { arbol, texto, ranuras } o lanza.
function dibujarCardResumen(raiz, over) {
  const sonda = montarConEstado(raiz, []);
  if (typeof sonda.CardResumen !== 'function') throw new Error('CardResumen no es alcanzable en el ambito global');
  const semilla = [];
  semilla[0] = fixtureDataF8(over && over.data);
  semilla[1] = COMPRAS_F8;
  semilla[6] = DIFERIDAS_F8;
  const c = montarConEstado(raiz, semilla);
  const arbol = c.CardResumen({ tarjeta: TARJETA_F8, onDataChange: () => {} });
  // Las ranuras se siembran por posicion, asi que hay que COMPROBAR que se sembro donde se cree:
  // los tipos iniciales de las tres (null, [], []) y, sobre todo, que el contenido llego al dibujo.
  const orden = c.__hooks || [];
  const ranuras = { data: orden[0] === null, compras: Array.isArray(orden[1]), diferidas: Array.isArray(orden[6]) };
  return { arbol, ranuras };
}

// ─── F8: RENDER real de la vista principal (tabla de Compras/Diferidas + cards) ──
//
// POR QUE EXISTE: F7 dibuja el panel de IA y ahi se acaba la cobertura de render. La VISTA
// PRINCIPAL -la tabla de Compras, la de Diferidas y las cards de arriba- no la dibujaba nadie, y es
// donde se han colado los defectos de verdad: los tres del reordenamiento manual de v6.0.0 pasaron
// un 18/18 en VERDE, y los dos de v6.1.0 (el saldo $0 quemado en la fila sellada y el boton de
// bolsillo ausente) los encontro el usuario mirando la pantalla. Ninguno era invisible por sutil:
// eran invisibles porque ningun detector ejecutaba ese codigo.
//
// El escenario se SIEMBRA (no sale de la BD) para que este detector no caduque cuando el usuario
// registra una compra: mide regresiones de UI, no el estado de los datos.
const F8 = {
  id: 'F8',
  nombre: 'Render real de la vista principal (tabla de Compras/Diferidas y cards)',
  medir(raiz) {
    const notas = [];
    const cifras = {};

    // ── a) ciclo IMPAGO: es el estado en que la tabla muestra mas cosas ──────
    let r1;
    try { r1 = dibujarCardResumen(raiz, {}); }
    catch (e) { return resultado(false, {}, ['FALLO renderizando CardResumen: ' + e.message]); }
    if (!r1.ranuras.data) notas.push('FALLO: la ranura 0 ya no es `data` (useState(null)) -> el fixture se estaria sembrando en otra variable');
    if (!r1.ranuras.compras) notas.push('FALLO: la ranura 1 ya no es `compras` (useState([]))');
    if (!r1.ranuras.diferidas) notas.push('FALLO: la ranura 6 ya no es `diferidas` (useState([]))');

    const t1 = textoDe(r1.arbol);
    cifras.textoImpago = t1.length;
    // Aserto de sanidad del montaje: si lo sembrado no llega al dibujo, todo lo de abajo mediria
    // la nada y saldria verde por omision.
    if (t1.indexOf('COMPRA NORMAL F8') === -1) {
      return resultado(false, cifras, ['FALLO: la compra sembrada no aparece en el render -> el escenario no llego a la tabla y ningun aserto valdria']);
    }

    // Tabla de Compras: que se ve y que NO.
    if (t1.indexOf('CUOTA SELLADA COMPRA F8') === -1) notas.push('FALLO: con el ciclo IMPAGO la cuota sellada NO aparece en Compras (es deuda viva: hay que poder apartarle bolsillo)');
    if (t1.indexOf('SALDO RENACIDO F8') !== -1) notas.push('FALLO: la compra RENACIDA aparece en Compras (no es una compra, es el saldo vivo del plan)');
    if (t1.indexOf('COMPRA TERCERO F8') === -1) notas.push('FALLO: la compra de tercero no aparece en la tabla');

    // Cards de arriba: deuda, cupo y bolsillo con cifras puestas a proposito.
    if (t1.indexOf('$10.000.000') === -1) notas.push('FALLO: la card de deuda no muestra la deuda total sembrada ($10.000.000)');
    if (t1.indexOf('25.0') === -1) notas.push('FALLO: el cupo usado no sale al 25.0% (10M sobre un cupo de 40M)');
    if (t1.indexOf('$30.000.000') === -1) notas.push('FALLO: no aparece el cupo disponible ($30.000.000 = 40M - 10M)');
    // La card muestra el BRUTO apartado en grande; el neto saturado baja al detalle, junto a los
    // abonos que lo explican. Si se vuelve a poner el neto arriba, con este escenario la card
    // marcaria $0 -que es el defecto que el usuario reporto- y estos tres asertos lo dicen.
    if (t1.indexOf('$534.078') === -1) notas.push('FALLO: la card "Saldo en Bolsillo" no muestra el BRUTO apartado ($534.078) como valor principal');
    if (t1.indexOf('Neto Restante') === -1) notas.push('FALLO: la card no desglosa el "Neto Restante" (el saturado) -> se pierde la lectura de cuanto queda tras los abonos');
    if (t1.indexOf('Abonos Realizados') === -1) notas.push('FALLO: la card no muestra los abonos, que son los que explican por que el neto es menor que lo apartado');

    // Badges de bolsillo: los personales se pueden pulsar, el de un tercero NO (se gestiona en Terceros).
    const badges = [];
    recorrerArbol(r1.arbol, n => {
      if (n.type === 'span' && n.props && typeof n.props.className === 'string' && n.props.className.indexOf('badge') !== -1 && n.props.onClick) {
        badges.push({ txt: textoDe(n).trim(), clickable: n.props.className.indexOf('badge-clickable') !== -1, title: n.props.title || '' });
      }
    });
    cifras.badgesBolsillo = badges.length;
    if (!badges.length) notas.push('FALLO: ningun badge de bolsillo quedo pulsable en toda la vista');
    const deTercero = badges.filter(b => /Terceros/i.test(b.title));
    if (!deTercero.length) notas.push('FALLO: el badge de la compra de TERCERO no lleva el aviso de gestionarlo desde Terceros');
    if (deTercero.some(b => b.clickable)) notas.push('FALLO: el badge de un TERCERO quedo como badge-clickable -> deja editar un reembolso que no es plata propia');

    // ── Una compra ANULADA no se lee "Pagado" ────────────────────────────────
    // El endpoint de anular neutraliza la fila (estado 'pagado' + monto_abonado = valor) para que su
    // deuda sea cero sin tocar ninguna consulta, y por esa puerta la tabla la anunciaba como pagada:
    // el usuario leia que habia pagado 882.000 que el banco nunca le cobro. Anulacion y reverso son
    // caminos distintos (misma autorizacion y fecha vs otra), asi que el badge tambien es propio.
    let filaAnulada = null;
    recorrerArbol(r1.arbol, n => { if (!filaAnulada && n.type === 'tr' && textoDe(n).indexOf('COMPRA ANULADA F8') !== -1) filaAnulada = n; });
    if (!filaAnulada) {
      notas.push('FALLO de sanidad [ANULADA]: la compra anulada sembrada no llego a la tabla -> los asertos de abajo medirian la nada');
    } else {
      const tA = textoDe(filaAnulada);
      cifras.anulada = tA.trim().slice(0, 60);
      if (tA.indexOf('Anulada') === -1) {
        notas.push('FALLO [ANULADA]: la fila de una compra que el banco ANULO no dice "Anulada" (dice: "' + tA.trim().slice(0, 120) + '")');
      }
      if (tA.indexOf('Pagado') !== -1) {
        notas.push('FALLO [ANULADA]: la fila anulada sigue mostrando el badge "Pagado" -> el cargo nunca entro a la facturacion, no es algo que el usuario haya pagado');
      }
      let btnRev = null;
      recorrerArbol(filaAnulada, n => { if (!btnRev && n.type === 'button' && /Reversar/i.test(String((n.props && n.props.title) || ''))) btnRev = n; });
      if (btnRev) {
        notas.push('FALLO [ANULADA]: la fila anulada ofrece el boton "Reversar" -> una anulacion y un reverso no se acumulan y el backend lo rechaza con 409');
      }
    }

    // Tabla de Diferidas: el boton de reprogramar y el motivo del banco.
    const botones = botonesDe(r1.arbol);
    cifras.botones = botones.length;
    const bloqueados = [];
    recorrerArbol(r1.arbol, n => {
      if (n.type === 'button' && n.props && typeof n.props.title === 'string' && /no permite cambiar las cuotas/.test(n.props.title)) {
        bloqueados.push(!!n.props.disabled);
      }
    });
    cifras.reprogBloqueados = bloqueados.length;
    if (!bloqueados.length) notas.push('FALLO: la diferida con bloqueo_banco no muestra el motivo del banco en su boton');
    if (bloqueados.some(d => !d)) notas.push('FALLO: el boton con el motivo del banco quedo HABILITADO -> ofrece algo que el backend rechaza con 403');
    // La fila SELLADA inyectada tiene que mostrar su saldo real, no un 0 fijo.
    if (t1.indexOf('$11.225') === -1) notas.push('FALLO: la cuota sellada impaga no muestra su saldo real ($11.225) en Diferidas');

    // ── b) ciclo PAGADO: la sellada pasa a ser historial y se retira de Compras ──
    try {
      const r2 = dibujarCardResumen(raiz, { data: { extractoCiclo: { estado: 'pagado', pago_minimo: 3000000, monto_pagado: 3000000, fecha_pagado: '2026-09-15' } } });
      const t2 = textoDe(r2.arbol);
      if (t2.indexOf('COMPRA NORMAL F8') === -1) notas.push('FALLO: con el ciclo PAGADO desaparecio hasta la compra normal (el filtro se paso de largo)');
      if (t2.indexOf('CUOTA SELLADA COMPRA F8') !== -1) notas.push('FALLO: con el ciclo PAGADO la cuota sellada sigue en Compras (ahi ya es historial cerrado)');
    } catch (e) {
      notas.push('FALLO renderizando el caso de ciclo pagado: ' + e.message);
    }

    // ── b2) mes ya PAGADO: el bolsillo llega en 0 y la card no debe desglosar nada ──
    // Con el bruto en cero (el bolsillo cumplio su fin al pagarse el extracto) un desglose de abonos
    // bajo un principal de $0 no explica nada. El calculo de ese cero lo vigila R8, contra la BD;
    // aqui solo se comprueba que la card no pinte un desglose incongruente cuando llega asi.
    try {
      const r2b = dibujarCardResumen(raiz, { data: { saldoBolsilloBruto: 0, saldoBolsillo: 0, saldoBolsilloAbonado: 1400000 } });
      const t2b = textoDe(r2b.arbol);
      if (t2b.indexOf('Neto Restante') !== -1 || t2b.indexOf('Abonos Realizados') !== -1) {
        notas.push('FALLO: con el bolsillo en 0 la card sigue desglosando abonos/neto -> desglose vacio sobre un principal de $0');
      }
    } catch (e) {
      notas.push('FALLO renderizando el caso de bolsillo en cero: ' + e.message);
    }

    // ── c) SOBRECUPO: la deuda supera el cupo ────────────────────────────────
    try {
      const r3 = dibujarCardResumen(raiz, { data: { deudaTotal: 45000000, deudaTotalEnCop: 45000000 } });
      const t3 = textoDe(r3.arbol);
      if (!/Sobrecupo/i.test(t3)) notas.push('FALLO: con la deuda por encima del cupo no aparece "Sobrecupo"');
    } catch (e) {
      notas.push('FALLO renderizando el caso de sobrecupo: ' + e.message);
    }

    return resultado(notas.length === 0, cifras, notas);
  },
  defecto: 'se rompe un identificador DENTRO del render de la tabla de Diferidas (invisible para los otros detectores)',
  mutar(raiz) {
    // Por CONTENIDO y lanzando si no aparece: una mutacion que no se aplica daria un falso "no
    // detectado". Se elige una llamada del camino de DIBUJO (no de un manejador de eventos, que no
    // se ejecuta al renderizar) y que ademas vive DENTRO de CardResumen, asi que F4/F5/F6 -que solo
    // miran declaraciones de nivel superior y tamanos- no pueden verla.
    const { piezas } = piezasEnOrden(raiz);
    const pieza = piezas.find(p => p.ruta && p.fuente && p.fuente.indexOf('function CardResumen') !== -1);
    if (!pieza) throw new Error('no se encontro la pieza que declara CardResumen');
    const src = leer(pieza.ruta);
    const aguja = 'const motivo = motivoNoReprogramable(d);';
    if (src.indexOf(aguja) === -1) throw new Error('no se encontro "' + aguja + '" en el render de la fila de Diferidas');
    fs.writeFileSync(pieza.ruta, src.replace(aguja, 'const motivo = motivoNoReprogramableQueNoExiste(d);'), 'utf8');
  },
};

// ─── F9: la capa api(), ejecutada de verdad ─────────────────────────────────
//
// POR QUE EXISTE: `api()` es el unico camino por el que el frontend habla con el backend -122
// llamadas, 70 de ellas de ESCRITURA- y ningun detector la ejecutaba. Los smokes que se escriben a
// mano suelen invocar el handler directamente, asi que prueban el backend y NO el camino real: por
// ahi paso el doble `JSON.stringify` de v6.0.0, que ademas fallaba EN SILENCIO (body-parser
// respondia 400, la respuesta no era JSON, `res.json()` lanzaba y la promesa se rechazaba sin
// `.catch`: ni toast, ni consola, ni pista).
//
// Los tres contratos que fija, y que son faciles de romper sin que nada mas se entere:
//   1. api() SERIALIZA ELLA MISMA. Un llamador que pase `body: JSON.stringify(x)` serializa dos
//      veces y el backend recibe una cadena escapada.
//   2. api() NO LANZA en 4xx/5xx: resuelve con el cuerpo de error. Por eso los llamadores tienen
//      que mirar `resp.error` -lo aprendio v5.7.1, cuando un pago fallido mostraba toast de exito-.
//   3. api() SI RECHAZA cuando el cuerpo no es JSON (un 404 en HTML, por ejemplo). Ese rechazo es
//      el que exige `.catch` en el llamador.
const F9 = {
  id: 'F9',
  nombre: 'Capa api() ejecutada: serializacion, promesas y fallos que no se ven',
  async medir(raiz) {
    const notas = [];
    const cifras = {};

    // Doble de fetch: anota lo que se le pasa y responde lo que pida el caso de prueba.
    let ultima = null;
    let guion = () => ({ ok: true, status: 200, json: () => Promise.resolve({ ok: true }) });
    const fetchEspia = (url, init) => { ultima = { url, init }; return Promise.resolve(guion()); };

    let ctx;
    try { ({ ctx } = cargarFrontend(raiz, { fetch: fetchEspia })); }
    catch (e) { return resultado(false, {}, ['FALLO cargando el frontend: ' + e.message]); }
    if (typeof ctx.api !== 'function') return resultado(false, {}, ['FALLO: api() no es alcanzable en el ambito global']);

    // ── 1) lo que api() ENVIA ────────────────────────────────────────────────
    try {
      const cuerpo = { num_cuotas: 3, nota: 'con "comillas" y acentos: ñ' };
      await ctx.api('/compras/1/reprogramar', { method: 'POST', body: cuerpo });
      const enviado = ultima && ultima.init ? ultima.init.body : undefined;
      cifras.tipoBody = typeof enviado;
      if (typeof enviado !== 'string') {
        notas.push('FALLO: api() no serializo el body (llego ' + typeof enviado + ') -> el backend recibiria [object Object]');
      } else {
        let una;
        try { una = JSON.parse(enviado); } catch (e) { una = null; }
        if (!una || typeof una !== 'object') {
          notas.push('FALLO: el body enviado no es JSON valido: ' + String(enviado).slice(0, 60));
        } else if (typeof una === 'string' || typeof JSON.parse(enviado) === 'string') {
          notas.push('FALLO: DOBLE serializacion -> el backend recibe una cadena escapada, no un objeto');
        } else if (una.num_cuotas !== 3) {
          notas.push('FALLO: el body llego alterado: ' + enviado.slice(0, 80));
        }
        // La firma exacta del bug de v6.0.0: si alguien vuelve a stringificar en el llamador, el
        // valor que ve fetch es la cadena YA escapada, y parsearla una vez devuelve un string.
        if (typeof una === 'string') notas.push('FALLO: parsear el body una vez devuelve un string -> venia stringificado dos veces');
      }
      const ct = ultima && ultima.init && ultima.init.headers ? ultima.init.headers['Content-Type'] : null;
      if (ct !== 'application/json') notas.push('FALLO: falta el Content-Type application/json (llego ' + ct + ')');
      if (!ultima || String(ultima.url).indexOf('/api/compras/1/reprogramar') === -1) {
        notas.push('FALLO: la URL no se compuso sobre la base /api: ' + (ultima && ultima.url));
      }
      if (ultima.init.method !== 'POST') notas.push('FALLO: el method no se propago (llego ' + ultima.init.method + ')');
    } catch (e) {
      notas.push('FALLO ejecutando api() con body: ' + e.message);
    }

    // ── 2) sin body no se inventa uno ────────────────────────────────────────
    try {
      ultima = null;
      await ctx.api('/compras?tarjeta_id=4');
      const b = ultima && ultima.init ? ultima.init.body : 'SIN-INIT';
      if (b !== undefined) notas.push('FALLO: una peticion sin body mando body=' + JSON.stringify(b) + ' (un GET con cuerpo puede ser rechazado)');
    } catch (e) {
      notas.push('FALLO ejecutando api() sin body: ' + e.message);
    }

    // ── 3) 4xx: RESUELVE con el error, no lanza ──────────────────────────────
    // Es el contrato que obliga a los llamadores a mirar `resp.error`. Si algun dia api() pasara a
    // lanzar, decenas de `.then(r => ...)` dejarian de ejecutarse en silencio.
    try {
      guion = () => ({ ok: false, status: 403, json: () => Promise.resolve({ error: 'ciclo pagado' }) });
      const r = await ctx.api('/compras/1', { method: 'PUT', body: { x: 1 } });
      if (!r || r.error !== 'ciclo pagado') notas.push('FALLO: con 403 api() no devolvio el cuerpo de error: ' + JSON.stringify(r));
      cifras.err4xx = 'resuelve';
    } catch (e) {
      notas.push('FALLO: api() LANZO ante un 403 -> los llamadores que hacen .then(r => r.error) dejarian de ejecutarse: ' + e.message);
      cifras.err4xx = 'lanza';
    }

    // ── 4) cuerpo no-JSON: RECHAZA (y por eso hace falta .catch) ─────────────
    // El toast global vive en api(), asi que hay que capturarlo donde el frontend lo emite:
    // toast() lee window.__addToast EN CADA LLAMADA, de modo que basta con ponerlo ahora.
    const avisos = [];
    if (ctx.window) ctx.window.__addToast = (msg, tipo) => avisos.push({ msg: String(msg), tipo });

    let rechazo = false;
    try {
      guion = () => ({ ok: false, status: 404, json: () => Promise.reject(new SyntaxError('Unexpected token <')) });
      await ctx.api('/ruta/que/no/existe');
    } catch (e) { rechazo = true; }
    cifras.noJson = rechazo ? 'rechaza' : 'silencioso';
    if (!rechazo) {
      notas.push('FALLO: con un cuerpo que no es JSON api() NO rechaza -> el fallo se vuelve invisible ' +
        'para el usuario y para la consola (es exactamente como se comporto el bug del doble stringify)');
    }
    // Una LECTURA que falla no debe molestar: varias son opcionales a proposito (autocompletado,
    // TRM, el fallback offline del asistente) y su .catch las silencia deliberadamente.
    if (avisos.length) notas.push('FALLO: una LECTURA fallida saco un toast (' + avisos[0].msg + ') -> ruido sobre algo que el codigo ya decide ignorar');

    // ── 5) una ESCRITURA fallida SI avisa, y ademas RELANZA ──────────────────
    // Las dos mitades importan: sin el aviso, 56 escrituras fallan mudas; sin el relanzamiento,
    // los .catch que ya existen dejarian de recibir su error y de ejecutar su logica.
    avisos.length = 0;
    let relanzo = false, errRecibido = null;
    try {
      guion = () => ({ ok: false, status: 500, json: () => Promise.reject(new SyntaxError('Unexpected token <')) });
      await ctx.api('/compras/1/mover', { method: 'POST', body: { direccion: 'arriba' } });
    } catch (e) { relanzo = true; errRecibido = e; }
    cifras.avisoEscritura = avisos.length;
    if (!avisos.length) {
      notas.push('FALLO: una ESCRITURA fallida NO avisa al usuario -> vuelve el boton mudo que costo la depuracion de v6.0.0');
    } else if (!/error/i.test(avisos[0].msg) || avisos[0].tipo !== 'error') {
      notas.push('FALLO: el aviso de escritura no se emite como error legible: ' + JSON.stringify(avisos[0]));
    }
    if (!relanzo) {
      notas.push('FALLO: api() se TRAGO el rechazo tras avisar -> los .catch existentes dejan de ejecutar su logica ' +
        '(rollbacks, estados de carga, mensajes mas concretos)');
    }
    // La marca es la que evita el mensaje duplicado en los llamadores que ya tienen el suyo.
    if (relanzo && !(errRecibido && errRecibido.__avisado)) {
      notas.push('FALLO: el error relanzado no viene marcado como avisado -> los catch propios repetiran el toast');
    }

    // ── 6) ningun llamador vuelve a serializar por su cuenta ─────────────────
    // El aserto es de CERO, no un umbral: hoy no queda ninguno y cualquier reaparicion es el bug.
    const { piezas } = piezasEnOrden(raiz);
    const dobles = [];
    for (const p of piezas) {
      if (!p.fuente) continue;
      const re = /body:\s*JSON\.stringify/g;
      let m;
      while ((m = re.exec(p.fuente)) !== null) {
        const linea = p.fuente.slice(0, m.index).split('\n').length;
        dobles.push(p.nombre + ':' + linea);
      }
    }
    cifras.dobleStringify = dobles.length;
    if (dobles.length) {
      notas.push('FALLO: ' + dobles.length + ' llamada(s) serializan el body ANTES de api(), que ya serializa -> ' +
        'el backend recibe una cadena escapada y responde 400 sin JSON: ' + dobles.slice(0, 4).join(', '));
    }

    return resultado(notas.length === 0, cifras, notas);
  },
  defecto: 'api() deja de serializar el body (lo pasa crudo a fetch): rompe las 70 escrituras del frontend y ningun otro detector lo ve',
  mutar(raiz) {
    // Por CONTENIDO y lanzando si no aparece. Se elige el corazon de la capa: sin el stringify,
    // fetch recibe un objeto y el backend un "[object Object]". F1 lo ve sintacticamente correcto,
    // F5 no nota el cambio (mismas lineas) y F4/F6 siguen viendo el simbolo `api` en su sitio.
    const aguja = 'JSON.stringify(opts.body)';
    if (!mutarEnAlgunaPieza(raiz, aguja, 'opts.body')) {
      throw new Error('no se encontro "' + aguja + '" en la capa api()');
    }
  },
};

// ─── F10: la pestaña Pagos anuncia lo que el backend va a hacer ─────────────
//
// POR QUE EXISTE: es la unica pantalla donde un error de display cuesta MORA. Y ya paso dos veces:
// v5.7.1 (submitPago no cortaba ante resp.error y celebraba un pago fallido) y v5.7.2 (el aviso
// prometia $2.000 de margen cuando la banda real era $1, porque habia cifra oficial cargada: quien
// le creyera pagaria de menos y el extracto NO sellaria). Las dos son el mismo patron -la UI
// prometiendo algo que el backend no hace- y ninguna prueba lo vigilaba.
//
// Por eso este detector no comprueba el boton contra si mismo: usa el BACKEND REAL como oraculo.
// Para cada monto renderiza la pestaña, lee lo que anuncia el boton, y ejecuta ese mismo pago
// contra una copia limpia de la BD. Si el boton dice "Completar Pago", el extracto tiene que quedar
// sellado; si dice "Registrar Abono", no. Cualquier separacion entre las dos capas sale roja.
const F10 = {
  id: 'F10',
  nombre: 'Pestaña Pagos: el boton anuncia lo que el backend hara (paridad real)',
  async medir(raiz) {
    const notas = [];
    const cifras = {};

    // Los dos regimenes de la banda de tolerancia son distintos y hay que probar los dos:
    //   sin cifra oficial -> min($2.000, 2% del minimo): el estimado no puede ser exacto por diseño.
    //   con cifra oficial -> $1: ahi un faltante no es imprecision del modelo, es plata que falta.
    let escenarios;
    try {
      escenarios = await conApp(raiz, 'F10base', async (port, db) => {
        const out = [];
        const tjs = db.prepare('SELECT id FROM tarjetas').all();
        for (const t of tjs) {
          const r = await pedir(port, 'GET', '/api/extractos?tarjeta_id=' + t.id);
          if (!r.j || !Array.isArray(r.j)) continue;
          for (const ext of r.j) {
            if (ext.estado === 'pagado') continue;
            const restante = Math.round((ext.pago_minimo || 0) - (ext.monto_pagado || 0));
            if (!(restante > 5000)) continue;   // margen suficiente para separar los tres montos
            out.push({ id: ext.id, tarjeta_id: t.id, ciclo: ext.ciclo, tiene_oficial: !!ext.tiene_oficial, restante, ext });
          }
        }
        return out;
      });
    } catch (e) { return resultado(false, {}, ['FALLO leyendo los extractos: ' + e.message]); }

    const conOficial = escenarios.find(x => x.tiene_oficial);
    const sinOficial = escenarios.find(x => !x.tiene_oficial);
    cifras.candidatos = escenarios.length;
    if (!sinOficial) {
      return resultado(false, cifras, ['FALLO: no hay ningun extracto pendiente SIN cifra oficial -> no se puede probar la banda del 2%']);
    }
    // El caso "con cifra oficial" se SIEMBRA si no existe: dejarlo sin probar es el hueco silencioso
    // que la regla madre prohibe, y es justo el regimen donde el margen cae a $1.
    const casos = [];
    casos.push({ nombre: 'sin cifra oficial', base: sinOficial, sembrarOficial: false });
    if (conOficial) casos.push({ nombre: 'con cifra oficial', base: conOficial, sembrarOficial: false });
    else casos.push({ nombre: 'con cifra oficial (sembrada)', base: sinOficial, sembrarOficial: true });
    cifras.casos = casos.length;

    const { ctx } = (() => { try { return cargarFrontend(raiz, {}); } catch (e) { return { ctx: null }; } })();
    if (!ctx || typeof ctx.bandaToleranciaCop !== 'function') {
      return resultado(false, cifras, ['FALLO: bandaToleranciaCop no es alcanzable -> el frontend ya no comparte la banda con el backend']);
    }

    let comparaciones = 0, discrepancias = 0;
    for (const caso of casos) {
      // La banda que el FRONTEND anuncia, calculada con su propia funcion (no con una copia).
      const extFront = Object.assign({}, caso.base.ext, caso.sembrarOficial ? { tiene_oficial: true } : {});
      const minimoCompleto = Math.round(extFront.pago_minimo || 0);
      const banda = ctx.bandaToleranciaCop(extFront, minimoCompleto);
      const R = caso.base.restante;
      // Tres montos alrededor del borde: dentro, justo en el borde, y un peso fuera.
      const montos = [
        { monto: R, espera: true, que: 'el restante exacto' },
        { monto: Math.max(1, R - banda), espera: true, que: 'el borde de la banda (' + banda + ')' },
        { monto: Math.max(1, R - banda - 1), espera: false, que: 'un peso MAS ABAJO del borde' },
      ];
      for (const m of montos) {
        // ── lo que ANUNCIA el boton, leido del render real ──
        let etiqueta = null;
        try {
          const semilla = [];
          semilla[3] = extFront;                 // pagoExtracto
          semilla[4] = String(m.monto);          // pagoMonto
          const c = montarConEstado(raiz, semilla);
          const arbol = c.Pagos({ tarjeta: { id: caso.base.tarjeta_id, nombre: 'T', dia_corte: 30, banco: 'Bancolombia', franquicia: 'Visa' }, onDataChange: () => {} });
          // Las ranuras se comprueban DESPUES de renderizar: los useState solo se ejecutan al
          // invocar el componente, asi que antes de esa llamada `__hooks` esta vacio y el aserto
          // mediria la nada. Si alguien reordena los hooks, esto grita en vez de sembrar en otra
          // variable y dar por bueno un render que no es el que se cree.
          const orden = c.__hooks || [];
          if (orden[3] !== null || orden[4] !== '') {
            notas.push('FALLO: las ranuras de Pagos cambiaron de orden (se esperaba 3=pagoExtracto null, 4=pagoMonto "") -> el fixture sembraria otra variable');
            break;
          }
          recorrerArbol(arbol, n => {
            if (etiqueta) return;
            if (n.type === 'button') {
              const t = textoDe(n);
              if (/Completar Pago/.test(t)) etiqueta = 'completa';
              else if (/Registrar Abono/.test(t)) etiqueta = 'abona';
            }
          });
        } catch (e) {
          notas.push('FALLO renderizando la pestaña Pagos (' + caso.nombre + '): ' + e.message);
          break;
        }
        if (!etiqueta) { notas.push('FALLO: no se encontro el boton de pago en el render (' + caso.nombre + ')'); break; }

        // ── lo que HACE el backend con ese mismo monto, sobre una copia limpia ──
        let sello = null;
        try {
          sello = await conApp(raiz, 'F10_' + comparaciones, async (port, db) => {
            if (caso.sembrarOficial) {
              const r0 = await pedir(port, 'PUT', '/api/extractos/pago-oficial', null);   // sonda: existe la ruta?
              db.prepare("INSERT OR REPLACE INTO extractos_oficiales (tarjeta_id, ciclo, pago_minimo, pago_total, fuente) VALUES (?,?,?,?,'conciliacion')")
                .run(caso.base.tarjeta_id, caso.base.ciclo, minimoCompleto, Math.max(minimoCompleto, Math.round(extFront.pago_total || minimoCompleto)));
              void r0;
            }
            // Los nombres del body son los del contrato REAL de pagarExtracto: monto_pagado y
            // fecha_pagado. Con `monto` a secas el campo llega undefined, el endpoint cae a su
            // valor por defecto y el detector acabaria midiendo siempre el pago del minimo completo.
            const r = await pedir(port, 'PUT', '/api/extractos/' + caso.base.id + '/pagar', { monto_pagado: m.monto, fecha_pagado: '2026-08-14', moneda: 'COP' });
            if (!r.j) return null;
            return !!r.j.pagadoCompleto;
          });
        } catch (e) {
          notas.push('FALLO ejecutando el pago real (' + caso.nombre + '): ' + e.message);
          break;
        }
        if (sello === null) { notas.push('FALLO: el backend no devolvio pagadoCompleto (' + caso.nombre + ')'); break; }

        comparaciones++;
        const anuncia = etiqueta === 'completa';
        if (anuncia !== sello) {
          discrepancias++;
          notas.push('FALLO [' + caso.nombre + ' / ' + m.que + ']: el boton dice "' +
            (anuncia ? 'Completar Pago' : 'Registrar Abono') + '" y el backend ' +
            (sello ? 'SI' : 'NO') + ' sella el mes -> el usuario paga creyendo otra cosa (monto ' + m.monto + ', banda ' + banda + ')');
        }
        // Ademas de la paridad, el sentido: el borde tiene que caer del lado que dice el contrato.
        if (sello !== m.espera) {
          notas.push('FALLO [' + caso.nombre + ' / ' + m.que + ']: el backend ' + (sello ? 'sella' : 'no sella') +
            ' cuando se esperaba lo contrario (monto ' + m.monto + ', restante ' + R + ', banda ' + banda + ')');
        }
      }
    }
    cifras.comparaciones = comparaciones;
    cifras.discrepancias = discrepancias;
    if (comparaciones < 6) notas.push('FALLO: solo se pudieron comparar ' + comparaciones + ' escenarios de 6 -> el detector se quedo corto sin decirlo');

    return resultado(notas.length === 0, cifras, notas);
  },
  defecto: 'el boton usa el tope fijo de tolerancia en vez de la banda real (el defecto EXACTO de v5.7.2: promete margen donde no lo hay)',
  mutar(raiz) {
    // Se reproduce el bug historico: anunciar TOLERANCIA_PAGO_COP en lugar de la banda que calcula
    // bandaToleranciaCop. Con una cifra oficial cargada la banda real es $1, asi que el boton diria
    // "Completar Pago" sobre un pago que NO sella. F1/F5 no lo ven: es un identificador valido y el
    // simbolo conserva su tamaño.
    const aguja = 'var bandaCop = bandaToleranciaCop(pagoExtracto, pagoMinimoActual);';
    if (!mutarEnAlgunaPieza(raiz, aguja, 'var bandaCop = TOLERANCIA_PAGO_COP;')) {
      throw new Error('no se encontro "' + aguja + '" en la pestaña Pagos');
    }
  },
};

// ─── Andamiaje de F11: escenario de TERCEROS sembrado y servido por el backend REAL ──
//
// ORACULO HIBRIDO, y no por comodidad: los defectos de esta pantalla dependen de campos que CALCULA
// el backend (valor_pendiente, cubierta_bolsillo, monto_bolsillo_cuota y las aplicaciones de saldo a
// favor). Inventar ese `data` a mano es lo que produjo media docena de fallos de andamiaje en
// v6.1.0/v6.1.1: obliga a adivinar campos, y entonces el fixture revienta por lo que falta y no por
// lo que se mide. Aqui el escenario se SIEMBRA en la copia (criterio de R6/R8), se le preguntan los
// DOS GET que la pestaña consume de verdad, y con ESAS respuestas se dibuja.
//
// Se siembran tarjeta y persona PROPIAS: la respuesta trae solo el escenario, asi que las cifras son
// exactas y no dependen de que la BD del usuario tenga hoy una cuota con reembolso parcial ni de que
// no la complete mañana.
//
// tasa_mv = 0 a proposito: con interes cero cada cuota vale monto/num_cuotas EXACTO, asi que ninguna
// afirmacion de F11 depende del motor de amortizacion ni de las reglas por banco.
const F11_CICLO = '2029-06';              // lejano: sin extracto, asi que la visibilidad no oculta nada
const F11_DIA_CORTE = 30;
const F11_FECHA = '2029-05-31';           // 30 dias EXACTOS antes del corte -> intl = valor x tasa x 1

// Bancolombia + Visa es la unica combinacion donde aplicaIntl es true, que es la condicion de E2.
const TARJETA_F11 = { nombre: 'F11 TARJETA', banco: 'Bancolombia', franquicia: 'Visa',
  dia_corte: F11_DIA_CORTE, tasa_mv_avances: 0.02, cupo_total: 10000000, estado: 'activa' };

function sembrarTerceros(db) {
  const tj = db.prepare("INSERT INTO tarjetas (nombre, banco, franquicia, dia_corte, cupo_total, tasa_mv_avances, estado) VALUES (?,?,?,?,?,?, 'activa')")
    .run(TARJETA_F11.nombre, TARJETA_F11.banco, TARJETA_F11.franquicia, F11_DIA_CORTE, 10000000, 0.02).lastInsertRowid;
  const per = db.prepare("INSERT INTO personas (nombre, color) VALUES ('F11 DEUDOR', '#888888')").run().lastInsertRowid;

  // E1 — diferida de tercero con UNA cuota reembolsada del todo y otra a MEDIAS. Las dos ramas del
  // agregado (cubierta / no cubierta) quedan ejercitadas, y las dos cifras del encabezado salen > 0
  // (la de "Recibido" solo se dibuja si lo es).
  const dif = db.prepare("INSERT INTO diferidas (tarjeta_id, etiqueta, monto, tasa_mv, num_cuotas, fecha_compra, fecha_primer_corte, estado, notas) VALUES (?,?,?,0,2,?,?, 'activo','F11')")
    .run(tj, 'F11 DIFERIDA', 200000, F11_FECHA, F11_CICLO + '-' + F11_DIA_CORTE).lastInsertRowid;
  const cDif = db.prepare("INSERT INTO compras (tarjeta_id, fecha, descripcion, valor_cop, estado, ciclo, persona_id, diferida_id, monto_bolsillo, notas) VALUES (?,?,?,?, 'diferida', ?,?,?,?, 'Diferida a 2 cuotas')")
    .run(tj, F11_FECHA, 'F11 DIFERIDA', 200000, F11_CICLO, per, dif, 140000).lastInsertRowid;
  db.prepare("INSERT INTO bolsillo_cuotas (compra_id, cuota_num, monto, moneda) VALUES (?,1,?, 'COP')").run(cDif, 40000);
  db.prepare("INSERT INTO bolsillo_cuotas (compra_id, cuota_num, monto, moneda) VALUES (?,2,?, 'COP')").run(cDif, 100000);

  // E2 — compra INTERNACIONAL cuyo cruce cubre EXACTAMENTE el capital y deja el recargo intl fuera.
  // Es el defecto de v4.8.2: derivar "saldado" contra valor_cop en vez de contra el objetivo.
  const cIntl = db.prepare("INSERT INTO compras (tarjeta_id, fecha, descripcion, valor_cop, estado, ciclo, persona_id, es_internacional, tasa_intl, monto_bolsillo) VALUES (?,?,?,?, 'bolsillo', ?,?,1,?,?)")
    .run(tj, F11_FECHA, 'F11 INTL', 100000, F11_CICLO, per, 0.01, 100000).lastInsertRowid;

  // E3 — dos compras NACIONALES con cruce: una PARCIAL (el boton tiene que seguir vivo para completar
  // en efectivo) y otra al 100% (ahi si va atenuado). El PAR es lo que fija "solo al 100%" = v4.8.1;
  // con una sola de las dos, invertir la condicion seguiria pareciendo correcto.
  const cParc = db.prepare("INSERT INTO compras (tarjeta_id, fecha, descripcion, valor_cop, estado, ciclo, persona_id, monto_bolsillo) VALUES (?,?,?,?, 'bolsillo_parcial', ?,?,?)")
    .run(tj, F11_FECHA, 'F11 PARCIAL', 100000, F11_CICLO, per, 60000).lastInsertRowid;
  const cTot = db.prepare("INSERT INTO compras (tarjeta_id, fecha, descripcion, valor_cop, estado, ciclo, persona_id, monto_bolsillo) VALUES (?,?,?,?, 'bolsillo', ?,?,?)")
    .run(tj, F11_FECHA, 'F11 TOTAL', 80000, F11_CICLO, per, 80000).lastInsertRowid;

  // Un credito de reverso y sus TRES cruces: es lo unico que alimenta compraIdsConCruce.
  const sf = db.prepare("INSERT INTO saldos_favor_tercero (persona_id, monto, monto_aplicado, origen_tipo, tarjeta_id, descripcion, fecha, estado) VALUES (?,?,?, 'reverso', ?, 'F11 REVERSO', ?, 'activo')")
    .run(per, 400000, 240000, tj, F11_FECHA).lastInsertRowid;
  const cruce = db.prepare("INSERT INTO aplicaciones_saldo_favor (saldo_favor_id, compra_destino_id, tipo, monto, fecha) VALUES (?,?, 'cruce', ?, ?)");
  cruce.run(sf, cIntl, 100000, F11_FECHA);
  cruce.run(sf, cParc, 60000, F11_FECHA);
  cruce.run(sf, cTot, 80000, F11_FECHA);

  return { tarjeta_id: tj, persona_id: per, compra_dif: cDif, compra_parcial: cParc, credito: sf };
}

// Recolector propio: botonesDe() solo mira `disabled`, y el boton ATENUADO de un cruce al 100% NO
// esta disabled — lleva opacity 0.5 + cursor not-allowed y ADEMAS un onClick que abre el chip.
// Distinguirlos por `disabled` daria los dos como iguales, que es justo el defecto de v4.8.1.
function botonesConEstilo(nodo) {
  const out = [];
  recorrerArbol(nodo, n => {
    if (n.type !== 'button') return;
    const st = n.props.style || {};
    out.push({
      texto: textoDe(n).trim(),
      atenuado: st.cursor === 'not-allowed' || Number(st.opacity) === 0.5,
      onClick: typeof n.props.onClick === 'function',
      title: n.props.title || '',
    });
  });
  return out;
}
function filaConTexto(arbol, texto) {
  let hallada = null;
  recorrerArbol(arbol, n => {
    if (!hallada && n.type === 'tr' && textoDe(n).indexOf(texto) !== -1) hallada = n;
  });
  return hallada;
}
// Las dos ultimas celdas de toda fila son Dinero y la accion, con o sin las columnas intl.
function celdasDe(fila) { return (fila.hijos || []).filter(h => h && h.type === 'td'); }
function celdaDinero(fila) { const c = celdasDe(fila); return c[c.length - 2] || null; }
function celdaAccion(fila) { const c = celdasDe(fila); return c[c.length - 1] || null; }

function numeroDe(s) { const d = String(s).replace(/[^\d]/g, ''); return d ? parseInt(d, 10) : null; }
function montosDe(texto) {
  const out = [];
  const re = /\$\s*([\d.,]+)/g;
  let m;
  while ((m = re.exec(texto)) !== null) out.push(numeroDe(m[1]));
  return out;
}
function montoTras(texto, etiqueta) {
  const m = new RegExp(etiqueta.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\$\\s*([\\d.,]+)').exec(texto);
  return m ? numeroDe(m[1]) : null;
}

// ─── F11: RENDER real de la pestaña Terceros (la plata del deudor no se oculta ni se bloquea) ──
//
// POR QUE EXISTE: es la unica pantalla que lleva DOS libros a la vez -lo que debo al banco y lo que
// me deben a mi- y calcula el segundo POR SU CUENTA en el frontend: objetivoTerceroCop duplica a
// proposito la formula de "Me Deben" del backend. Cada vez que esa duplicacion derivo aparecio un
// defecto, y ninguna prueba dibujaba esta vista. Los tres escenarios son defectos REALES:
//   E1  reembolso PARCIAL de una cuota de diferida (la mina del todo-o-nada).
//   E2  v4.8.2: un cruce que cubre solo el capital marcaba la compra "Pagado" y atenuaba el boton,
//       dejando el recargo intl imposible de completar.
//   E3  v4.8.1: el candado del cruce era ciego y atenuaba el boton con CUALQUIER cruce, asi que un
//       cruce parcial no se podia terminar de pagar por ninguna via de la UI.
//
// MINA DESARMADA el 24-ago-2026 (decision del PO). Hasta entonces el agregado era TODO-O-NADA: con
// un reembolso parcial contaba la cuota ENTERA como pendiente e ignoraba lo ya recibido, mientras la
// fila de esa misma cuota si declaraba el abono — la app se contradecia consigo misma en la misma
// pantalla. Ahora es PROPORCIONAL en los seis sitios, migrando LOS DOS LADOS a la vez: se reparten el
// mismo coste, asi que tocar solo uno habria producido doble conteo o plata perdida.
// El cable trampa que vigilaba aquella deuda cumplio su funcion: al hacer la cirugia se puso rojo y
// obligo a actualizar los dos asertos a la vez. Los de abajo fijan ya la conducta CORRECTA, y el
// invariante de particion sigue siendo el que impide volver a migrar un solo lado.
const F11 = {
  id: 'F11',
  nombre: 'Render de Terceros: el dinero del deudor no se oculta ni se bloquea',
  async medir(raiz) {
    const notas = [];
    const cifras = {};

    // ── ETAPA 1: sembrar y preguntarle al backend REAL ──
    let esc;
    try {
      esc = await conApp(raiz, 'F11', async (port, db) => {
        const ids = sembrarTerceros(db);
        const t = await pedir(port, 'GET', '/api/terceros?tarjeta_id=' + ids.tarjeta_id);
        const s = await pedir(port, 'GET', '/api/saldos-favor');
        return { ids: ids, compras: t.j, saldos: s.j };
      });
    } catch (e) { return resultado(false, cifras, ['FALLO montando el escenario sembrado: ' + e.message]); }

    if (!Array.isArray(esc.compras)) return resultado(false, cifras, ['FALLO: /api/terceros no devolvio una lista']);
    cifras.comprasEnRespuesta = esc.compras.length;

    // ── Sanidad del escenario: corta ANTES de medir nada. Si lo sembrado no llego tal como se
    //    espera, el detector lo dice en vez de seguir y salir verde midiendo la nada.
    const porNombre = (n) => esc.compras.filter(c => c.descripcion === n)[0];
    const dif = porNombre('F11 DIFERIDA'), intl = porNombre('F11 INTL');
    const parc = porNombre('F11 PARCIAL'), tot = porNombre('F11 TOTAL');
    if (!dif || !intl || !parc || !tot) {
      return resultado(false, cifras, ['FALLO de sanidad: la respuesta no trae las 4 compras sembradas (llegaron: ' +
        esc.compras.map(c => c.descripcion).join(', ') + ')']);
    }
    const qs = dif.cuotas || [];
    if (qs.length !== 2 || qs[0].total !== 100000 || qs[1].total !== 100000) {
      return resultado(false, cifras, ['FALLO de sanidad: se esperaban 2 cuotas de 100000 y llegaron ' +
        JSON.stringify(qs.map(q => q.total)) + ' -> con tasa_mv=0 la cuota debe ser monto/num_cuotas exacto']);
    }
    if (qs[0].monto_bolsillo_cuota !== 40000 || qs[0].cubierta_bolsillo || qs[1].monto_bolsillo_cuota !== 100000 || !qs[1].cubierta_bolsillo) {
      return resultado(false, cifras, ['FALLO de sanidad: el reembolso per-cuota no llego como se sembro (cuota1=' +
        qs[0].monto_bolsillo_cuota + '/cubierta=' + qs[0].cubierta_bolsillo + ', cuota2=' + qs[1].monto_bolsillo_cuota + '/cubierta=' + qs[1].cubierta_bolsillo + ')']);
    }
    const cruzadas = [];
    ((esc.saldos && esc.saldos.creditos) || []).forEach(cr => (cr.aplicaciones || []).forEach(ap => {
      if (ap.tipo === 'cruce' && ap.compra_destino_id != null) cruzadas.push(ap.compra_destino_id);
    }));
    for (const c of [intl, parc, tot]) {
      if (cruzadas.indexOf(c.id) === -1) {
        return resultado(false, cifras, ['FALLO de sanidad: el cruce de "' + c.descripcion + '" no llego en /api/saldos-favor -> compraIdsConCruce saldria vacio y E2/E3 medirian otra cosa']);
      }
    }
    cifras.cuotaParcial = qs[0].monto_bolsillo_cuota;
    cifras.valorPendienteBackend = dif.valor_pendiente;

    // ── ETAPA 2: dibujar con esas respuestas ──
    const tarjeta = Object.assign({ id: esc.ids.tarjeta_id }, TARJETA_F11);
    // Las ranuras se localizan por el TIPO del valor inicial, no por un indice escrito a mano: si
    // alguien reordena los useState, esto grita en vez de sembrar en otra variable y dar por bueno
    // un render que no es el que se cree. Hace falta un render de descubrimiento porque los useState
    // solo se ejecutan al invocar el componente.
    let iCompras = -1, iSaldos = -1;
    try {
      const disc = montarConEstado(raiz, []);
      disc.Terceros({ tarjeta: tarjeta });
      const orden = disc.__hooks || [];
      iCompras = orden.findIndex(v => Array.isArray(v));
      iSaldos = orden.findIndex(v => v && typeof v === 'object' && !Array.isArray(v) && 'creditos' in v);
    } catch (e) { return resultado(false, cifras, ['FALLO en el render de descubrimiento de ranuras: ' + e.message]); }
    if (iCompras < 0 || iSaldos < 0) {
      return resultado(false, cifras, ['FALLO: no se localizaron las ranuras de Terceros por el tipo de su valor inicial (compras=' +
        iCompras + ', saldosFavor=' + iSaldos + ') -> los useState cambiaron de forma']);
    }
    cifras.ranuras = iCompras + '/' + iSaldos;

    const dibujar = (items) => {
      const semilla = [];
      semilla[iCompras] = items;
      semilla[iSaldos] = esc.saldos;
      const c = montarConEstado(raiz, semilla);
      return c.Terceros({ tarjeta: tarjeta });
    };

    // ══ E1: la diferida, SOLA, para que el agregado de la persona sea exactamente el suyo ══
    try {
      const arbol = dibujar([dif]);
      const f1 = filaConTexto(arbol, 'Cuota 1/2');
      const f2 = filaConTexto(arbol, 'Cuota 2/2');
      if (!f1 || !f2) {
        notas.push('FALLO de sanidad: lo sembrado no aparece en el dibujo (no se hallaron las filas "Cuota 1/2"/"Cuota 2/2")');
      } else {
        // La cuota a medias NO puede leerse como saldada, y tiene que declarar las DOS cifras: lo
        // que ya entro y lo que falta. Es lo que F11 no negocia.
        const dinero1 = textoDe(celdaDinero(f1));
        if (/Pagado/.test(dinero1)) notas.push('FALLO [E1]: la cuota con reembolso PARCIAL se lee "Pagado" -> se da por saldada plata que el deudor no ha puesto');
        const falta = montoTras(dinero1, 'Falta:');
        if (falta !== 60000) notas.push('FALLO [E1]: la cuota parcial deberia declarar "Falta: $60.000" y declara ' + (falta === null ? 'NADA -> el dinero que falta queda oculto' : '$' + falta));
        if (montosDe(dinero1).indexOf(40000) === -1) notas.push('FALLO [E1]: la fila no muestra los $40.000 ya reembolsados (' + dinero1.trim() + ') -> el abono del deudor queda invisible');
        // Y el boton tiene que seguir vivo: si no, no hay forma de completar el resto.
        const b1 = botonesConEstilo(celdaAccion(f1));
        if (b1.length !== 1 || b1[0].texto !== 'Bolsillo' || !b1[0].onClick || b1[0].atenuado) {
          notas.push('FALLO [E1]: la cuota parcial no ofrece un boton Bolsillo utilizable (' + JSON.stringify(b1) + ')');
        }
        // La cuota cubierta si va como saldada.
        if (!/Pagado/.test(textoDe(celdaDinero(f2)))) notas.push('FALLO [E1]: la cuota REEMBOLSADA del todo no se lee "Pagado"');
      }
      // Agregado de la persona.
      const cab = buscarNodo(arbol, n => n.props && n.props.className === 'persona-card-header');
      if (!cab) notas.push('FALLO de sanidad: no se dibujo el encabezado de la persona');
      else {
        const txt = textoDe(cab);
        const pend = montoTras(txt, 'Pendiente'), reci = montoTras(txt, 'Recibido');
        // El escenario: cuota 1 cuesta 100.000 y el tercero puso 40.000; la cuota 2 esta reembolsada
        // del todo. Lo que debe es 60.000 y lo que ha puesto son 140.000. Con el viejo todo-o-nada
        // salian 100.000 y 100.000: la cuota a medias contaba entera y sus 40.000 no aparecian.
        if (pend !== 60000) notas.push('FALLO [E1/DEUDA]: el "Pendiente" de la persona deberia ser 60000 (100000 de la cuota a medias menos los 40000 que ya puso) y es ' + pend +
          (pend === 100000 ? ' -> volvio el todo-o-nada: la cuota parcial cuenta ENTERA y se le cobra de mas al tercero' : ''));
        if (reci !== 140000) notas.push('FALLO [E1/DEUDA]: el "Recibido" de la persona deberia ser 140000 (los 40000 parciales mas la cuota cubierta) y es ' + reci +
          (reci === 100000 ? ' -> el reembolso parcial no se esta contando como recibido' : ''));
        // INVARIANTE DE PARTICION: pendiente y recibido parten el coste del plan sin solaparse. Es
        // lo que se rompe si alguien vuelve proporcional un solo lado.
        const costePlan = qs.reduce((s, q) => s + q.total, 0);
        if (pend !== null && reci !== null && pend + reci !== costePlan) {
          notas.push('FALLO [E1/PARTICION]: Pendiente(' + pend + ') + Recibido(' + reci + ') = ' + (pend + reci) +
            ' y el coste del plan es ' + costePlan + ' -> hay doble conteo o plata perdida entre los dos lados');
        }
        cifras.pendientePersona = pend;
        cifras.recibidoPersona = reci;
      }
    } catch (e) { notas.push('FALLO dibujando el escenario E1: ' + e.message); }

    // ══ E2 y E3: las tres compras simples con cruce ══
    try {
      const arbol = dibujar([intl, parc, tot]);
      const fIntl = filaConTexto(arbol, 'F11 INTL');
      const fParc = filaConTexto(arbol, 'F11 PARCIAL');
      const fTot = filaConTexto(arbol, 'F11 TOTAL');
      if (!fIntl || !fParc || !fTot) {
        notas.push('FALLO de sanidad: no se dibujaron las tres filas simples sembradas');
      } else {
        // E2 — el cruce cubre el capital pero NO el recargo intl (100.000 de 101.000).
        const dIntl = textoDe(celdaDinero(fIntl));
        if (/Pagado/.test(dIntl)) notas.push('FALLO [E2]: la compra internacional se lee "Pagado" con el cruce cubriendo solo el capital -> el recargo intl desaparece de la deuda (defecto de v4.8.2)');
        const faltaIntl = montoTras(dIntl, 'Falta:');
        if (faltaIntl !== 1000) notas.push('FALLO [E2]: deberia faltar el recargo intl ($1.000) y declara ' + (faltaIntl === null ? 'NADA' : '$' + faltaIntl) +
          ' -> el objetivo del tercero no esta sumando el interes');
        const bIntl = botonesConEstilo(celdaAccion(fIntl));
        if (bIntl.length !== 1 || bIntl[0].atenuado) notas.push('FALLO [E2]: el boton queda atenuado con el cruce incompleto -> no hay forma de poner el resto en efectivo (' + JSON.stringify(bIntl) + ')');

        // E3 — el par: parcial vivo, total atenuado.
        const bParc = botonesConEstilo(celdaAccion(fParc));
        if (bParc.length !== 1 || bParc[0].texto !== 'Bolsillo' || bParc[0].atenuado || !bParc[0].onClick) {
          notas.push('FALLO [E3]: con un cruce PARCIAL el boton Bolsillo tiene que seguir activo y esta ' + JSON.stringify(bParc) + ' (defecto de v4.8.1)');
        }
        const bTot = botonesConEstilo(celdaAccion(fTot));
        if (bTot.length !== 1 || !bTot[0].atenuado) {
          notas.push('FALLO [E3]: con el cruce al 100% el boton tiene que ir atenuado y protegido, y esta ' + JSON.stringify(bTot) +
            ' -> se podria bajar el bolsillo por la via directa y descuadrar el credito');
        } else if (!/Dinero a favor/.test(bTot[0].title)) {
          notas.push('FALLO [E3]: el boton atenuado no dice donde gestionarlo (title="' + bTot[0].title + '")');
        }
        cifras.escenarios = 3;
      }
    } catch (e) { notas.push('FALLO dibujando los escenarios E2/E3: ' + e.message); }

    // ══ E4 y E5 (Fase 2) — necesitan filas en `extractos`, asi que van sobre su PROPIA siembra ══
    //
    // Se monta aparte para no alterar el escenario de E1/E2/E3: sellar un extracto cambia la regla de
    // visibilidad de las compras de ese ciclo, y con la siembra compartida las afirmaciones anteriores
    // pasarian a medir otra cosa.
    //
    // ⚠️ CORRECCION de lo que se anoto al cerrar la Fase 1: se dijo que sin fila en `extractos` el
    // predicado de `gestionables` quedaba en NULL y el cruce no contaba. Es FALSO — la consulta usa
    // COALESCE(e.estado, '') <> 'pagado', asi que sin extracto el cruce SI sostiene el chip. Lo que
    // hay que sembrar para cerrar el libro es un extracto PAGADO.
    try {
      await conApp(raiz, 'F11b', async (port, db) => {
        const ids = sembrarTerceros(db);
        const tj = ids.tarjeta_id;
        const tarjetaB = Object.assign({ id: tj }, TARJETA_F11);
        const traerCompras = async () => (await pedir(port, 'GET', '/api/terceros?tarjeta_id=' + tj)).j || [];
        const traerSaldos = async () => (await pedir(port, 'GET', '/api/saldos-favor')).j || {};
        const dib = (items, saldos) => {
          const semilla = [];
          semilla[iCompras] = items;
          semilla[iSaldos] = saldos;
          const c = montarConEstado(raiz, semilla);
          return c.Terceros({ tarjeta: tarjetaB });
        };
        const chipDe = (arbol) => buscarNodo(arbol, n => n.props && n.props.className === 'badge-clickable' && /Dinero a favor/.test(textoDe(n)));

        // ── E4: la cuota 2 cae en 2029-07. Sellado ese extracto y ya reembolsada, el dinero
        //    apartado se consumio al pagar: no hay bolsillo que tocar, solo historia.
        db.prepare("INSERT INTO extractos (tarjeta_id, ciclo, fecha_corte, fecha_pago, pago_minimo, pago_total, estado, monto_pagado) VALUES (?,?,?,?,?,?, 'pagado', ?)")
          .run(tj, '2029-07', '2029-07-30', '2029-08-15', 100000, 200000, 100000);
        const compras = await traerCompras();
        const dif = compras.filter(c => c.descripcion === 'F11 DIFERIDA')[0];
        if (!dif || !dif.cuotas || !dif.cuotas[1] || !dif.cuotas[1].ciclo_pagado || dif.cuotas[0].ciclo_pagado) {
          notas.push('FALLO de sanidad [E4]: se esperaba la cuota 2 con ciclo_pagado y la 1 sin el, y llegaron ' +
            JSON.stringify((dif && dif.cuotas || []).map(q => q.ciclo_pagado)) + ' -> el escenario no quedo montado');
        } else {
          const arbol = dib([dif], await traerSaldos());
          const f1 = filaConTexto(arbol, 'Cuota 1/2');
          const f2 = filaConTexto(arbol, 'Cuota 2/2');
          if (!f1 || !f2) notas.push('FALLO de sanidad [E4]: no se dibujaron las dos cuotas');
          else {
            const accion2 = textoDe(celdaAccion(f2));
            if (!/Saldada/.test(accion2)) {
              notas.push('FALLO [E4]: la cuota de un mes YA PAGADO y ya reembolsada deberia quedar como "Saldada" y dice "' + accion2.trim() + '"');
            }
            if (botonesConEstilo(celdaAccion(f2)).length !== 0) {
              notas.push('FALLO [E4]: esa cuota sigue ofreciendo un boton -> invita a mover un bolsillo que ya se consumio al pagar el extracto');
            }
            // El PAR: la cuota del mes NO pagado conserva su boton. Sin esto, ocultar el boton
            // SIEMPRE tambien pasaria la comprobacion de arriba.
            const b1 = botonesConEstilo(celdaAccion(f1));
            if (b1.length !== 1 || b1[0].texto !== 'Bolsillo' || b1[0].atenuado) {
              notas.push('FALLO [E4]: la cuota del mes aun ABIERTO perdio su boton Bolsillo (' + JSON.stringify(b1) + ')');
            }
          }
        }

        // ── E5: el chip "Dinero a favor" solo aparece si hay algo que hacer (regla de v5.6.1) ──
        // (a) queda dinero sin repartir -> chip VERDE con el monto.
        {
          const arbol = dib(await traerCompras(), await traerSaldos());
          const chip = chipDe(arbol);
          if (!chip) notas.push('FALLO [E5a]: con dinero a favor sin repartir el chip no aparece');
          else {
            const t = textoDe(chip);
            if (montosDe(t).indexOf(160000) === -1) notas.push('FALLO [E5a]: el chip no muestra el disponible ($160.000): "' + t.trim() + '"');
            if (/Ver historial/.test(t)) notas.push('FALLO [E5a]: con dinero disponible el chip se dibuja como historial');
          }
        }
        // (b) sin disponible, pero con cruces sobre un ciclo ABIERTO -> chip GRIS, "Ver historial".
        db.prepare('UPDATE saldos_favor_tercero SET monto_aplicado = monto WHERE persona_id=?').run(ids.persona_id);
        {
          const saldos = await traerSaldos();
          const arbol = dib(await traerCompras(), saldos);
          const chip = chipDe(arbol);
          if (!chip) {
            notas.push('FALLO [E5b]: sin saldo disponible pero con cruces sobre un mes ABIERTO el chip desaparecio -> no hay forma de deshacer un cruce mal aplicado');
          } else if (!/Ver historial/.test(textoDe(chip))) {
            notas.push('FALLO [E5b]: el chip deberia ofrecer "Ver historial" y dice "' + textoDe(chip).trim() + '"');
          }
        }
        // (c) sin disponible y con TODOS los cruces en meses ya PAGADOS -> el libro esta cerrado y el
        //     chip DESAPARECE. Es la mitad de la regla que de verdad cuesta: es la que borra ruido.
        db.prepare("INSERT INTO extractos (tarjeta_id, ciclo, fecha_corte, fecha_pago, pago_minimo, pago_total, estado, monto_pagado) VALUES (?,?,?,?,?,?, 'pagado', ?)")
          .run(tj, F11_CICLO, F11_CICLO + '-30', '2029-07-15', 100000, 200000, 100000);
        {
          const saldos = await traerSaldos();
          const comprasC = await traerCompras();
          const arbol = dib(comprasC, saldos);
          // Sanidad: la persona tiene que seguir en pantalla (si no, el chip faltaria por otra razon).
          if (!buscarNodo(arbol, n => n.props && n.props.className === 'persona-card-header')) {
            notas.push('FALLO de sanidad [E5c]: la persona ya no se dibuja, asi que la ausencia del chip no prueba nada');
          } else if (chipDe(arbol)) {
            notas.push('FALLO [E5c]: con el saldo agotado y todos los cruces en meses ya pagados el chip sigue ahi -> ofrece entrar a deshacer pagos de meses cerrados');
          }
          cifras.comprasVisiblesE5c = comprasC.length;
        }
      });
    } catch (e) { notas.push('FALLO ejecutando los escenarios E4/E5: ' + e.message); }

    // ══ E6 — el modal "Dinero a favor" ofrece CUOTAS, y su tope es el que el backend acepta ══
    //
    // Va sobre su PROPIA siembra porque APLICA un cruce: mover dinero dentro del escenario de E1-E5
    // haria que las afirmaciones anteriores midieran otra cosa (mismo criterio que la Fase 2).
    //
    // El tope del modal es un ESPEJO del cap del servidor, y v5.6.0 dejo escrito lo que pasa cuando se
    // tocan por separado: el modal ofrece un maximo que el backend rechaza con 400 y el usuario ve un
    // "no" sin motivo. Asi que aqui el modal no se compara consigo mismo — se lee lo que OFRECE y se
    // manda ESE monto al endpoint REAL, que es el oraculo de F10.
    try {
      await conApp(raiz, 'F11c', async (port, db) => {
        const ids = sembrarTerceros(db);
        const tarjetaC = Object.assign({ id: ids.tarjeta_id }, TARJETA_F11);
        const compras = (await pedir(port, 'GET', '/api/terceros?tarjeta_id=' + ids.tarjeta_id)).j || [];
        const saldos = (await pedir(port, 'GET', '/api/saldos-favor')).j || {};
        const cred = (saldos.creditos || []).filter(c => c.persona_id === ids.persona_id)[0];
        if (!cred) { notas.push('FALLO de sanidad [E6]: no llego el credito sembrado'); return; }

        const dibujarModal = (aplicarSel) => {
          const semilla = [];
          semilla[iCompras] = compras;
          semilla[iSaldos] = saldos;
          semilla[3] = { persona_id: ids.persona_id, nombre: 'F11 DEUDOR', color: '#888888' };
          semilla[4] = aplicarSel;
          const c = montarConEstado(raiz, semilla);
          return c.Terceros({ tarjeta: tarjetaC });
        };

        const arbol = dibujarModal({ creditoId: cred.id, compra_destino_id: '', cuota_num: null, monto: '' });
        const sel = buscarNodo(arbol, n => n.type === 'select');
        if (!sel) {
          notas.push('FALLO de sanidad [E6]: no se dibujo el selector de deudas -> las ranuras de favorModal/aplicarSel se movieron y el fixture mide otra cosa');
          return;
        }
        const opciones = (sel.hijos[0] || []).map(o => ({ valor: String(o.props.value), texto: textoDe(o).trim() }));
        // La diferida entra por CUOTAS: la 1 aun debe 60.000 (100.000 menos los 40.000 reembolsados) y
        // la 2 esta cubierta del todo, asi que no se ofrece.
        const deCuota = opciones.filter(o => o.valor.indexOf(':') !== -1);
        if (deCuota.length !== 1) {
          notas.push('FALLO [E6]: se esperaba UNA cuota ofrecida (la que aun debe) y se ofrecen ' + deCuota.length + ' -> ' + JSON.stringify(opciones));
          return;
        }
        if (montosDe(deCuota[0].texto).indexOf(60000) === -1) {
          notas.push('FALLO [E6]: la cuota se ofrece con una deuda distinta de $60.000: "' + deCuota[0].texto + '"');
        }
        if (!/cuota/i.test(deCuota[0].texto)) notas.push('FALLO [E6]: la opcion no dice que es una cuota: "' + deCuota[0].texto + '"');
        if (opciones.some(o => o.valor === ids.compra_dif + ':2')) notas.push('FALLO [E6]: se ofrece una cuota ya reembolsada del todo');
        // Y la compra a cuotas NO puede ofrecerse entera: cruzar contra ella sin decir la cuota es lo
        // que el backend rechaza.
        if (opciones.some(o => o.valor === String(ids.compra_dif))) {
          notas.push('FALLO [E6]: la diferida se ofrece como compra entera, sin cuota -> el backend rechazaria ese cruce');
        }

        // ── PARIDAD: el maximo que anuncia el modal es exactamente el que el backend acepta ──
        const partes = deCuota[0].valor.split(':');
        const dest = { compra_destino_id: parseInt(partes[0], 10), cuota_num: parseInt(partes[1], 10) };
        const arbol2 = dibujarModal({ creditoId: cred.id, compra_destino_id: partes[0], cuota_num: dest.cuota_num, monto: '' });
        const m = /M.ximo aqu.:\s*\$\s*([\d.,]+)/.exec(textoDe(arbol2));
        const maxOfrecido = m ? numeroDe(m[1]) : null;
        if (maxOfrecido == null) {
          notas.push('FALLO de sanidad [E6]: el modal no anuncia un "Maximo aqui" con la cuota elegida');
          return;
        }
        if (maxOfrecido !== 60000) notas.push('FALLO [E6]: el maximo ofrecido para esa cuota es ' + maxOfrecido + ' y deberia ser 60000');
        const rMas = await pedir(port, 'POST', '/api/saldos-favor/' + cred.id + '/aplicar', Object.assign({ monto: maxOfrecido + 1 }, dest));
        if (!(rMas.j && rMas.j.error)) {
          notas.push('FALLO [E6/PARIDAD]: el backend acepto ' + (maxOfrecido + 1) + ', un peso POR ENCIMA del maximo que anuncia el modal -> el modal se queda corto y el usuario no puede cruzar todo lo que podria');
        }
        const rExacto = await pedir(port, 'POST', '/api/saldos-favor/' + cred.id + '/aplicar', Object.assign({ monto: maxOfrecido }, dest));
        if (!(rExacto.j && rExacto.j.ok)) {
          notas.push('FALLO [E6/PARIDAD]: el modal ofrece hasta ' + maxOfrecido + ' y el backend lo rechaza (' + JSON.stringify(rExacto.j) + ') -> el usuario ve un "no" sin motivo, que es la leccion de v5.6.0');
        } else {
          const tras = (await pedir(port, 'GET', '/api/terceros?tarjeta_id=' + ids.tarjeta_id)).j || [];
          const difTras = tras.filter(x => x.descripcion === 'F11 DIFERIDA')[0];
          const q1 = difTras && difTras.cuotas[0];
          if (!q1 || q1.monto_bolsillo_cuota !== 100000) {
            notas.push('FALLO [E6]: tras cruzar el maximo, la cuota 1 deberia quedar reembolsada del todo (100000) y quedo en ' + (q1 && q1.monto_bolsillo_cuota));
          }
          if (difTras && difTras.valor_pendiente !== 0) {
            notas.push('FALLO [E6]: con las dos cuotas reembolsadas la deuda deberia ser 0 y es ' + difTras.valor_pendiente);
          }
        }

        // ── Y el POST que construye el MODAL, no el que arma el detector: el `cuota_num` viaja en
        //    `aplicarSaldo`, asi que comprobar solo el endpoint prueba el backend y no el camino real
        //    (la leccion de F12/F9). Se pulsa el boton con un espia de fetch y se lee el cuerpo.
        {
          const enviados = [];
          const espia = (url, opts) => {
            let cuerpo = null;
            try { cuerpo = opts && opts.body ? JSON.parse(opts.body) : null; } catch (e) { cuerpo = opts && opts.body; }
            enviados.push({ url: String(url), cuerpo: cuerpo });
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
          };
          const semilla = [];
          semilla[iCompras] = compras;
          semilla[iSaldos] = saldos;
          semilla[3] = { persona_id: ids.persona_id, nombre: 'F11 DEUDOR', color: '#888888' };
          semilla[4] = { creditoId: cred.id, compra_destino_id: partes[0], cuota_num: dest.cuota_num, monto: '25000' };
          const cE = montarConEstado(raiz, semilla, { fetch: espia });
          const arbolE = cE.Terceros({ tarjeta: tarjetaC });
          const btn = buscarNodo(arbolE, n => n.type === 'button' && /Aplicar cruce/.test(textoDe(n)));
          if (!btn) notas.push('FALLO de sanidad [E6]: no se encontro el boton "Aplicar cruce" en el modal');
          else {
            await btn.props.onClick();
            const post = enviados.filter(x => x.url.indexOf('/aplicar') !== -1)[0];
            if (!post) notas.push('FALLO [E6/PAYLOAD]: pulsar "Aplicar cruce" no envio nada');
            else {
              if (post.cuerpo.cuota_num !== dest.cuota_num) {
                notas.push('FALLO [E6/PAYLOAD]: el modal manda cuota_num=' + JSON.stringify(post.cuerpo.cuota_num) + ' en vez de ' + dest.cuota_num +
                  ' -> el backend rechaza el cruce a una diferida porque no sabe a que cuota va');
              }
              if (post.cuerpo.compra_destino_id !== dest.compra_destino_id) {
                notas.push('FALLO [E6/PAYLOAD]: el modal manda la compra ' + post.cuerpo.compra_destino_id + ' en vez de ' + dest.compra_destino_id);
              }
              if (Math.round(post.cuerpo.monto) !== 25000) notas.push('FALLO [E6/PAYLOAD]: el monto no viaja como se escribio (' + post.cuerpo.monto + ')');
            }
          }
        }
        cifras.maxOfrecido = maxOfrecido;

        // ── E7: una escritura RECHAZADA no puede anunciarse como exito ──
        // Lo encontro el PO en el QA de v6.3.0: 'Quitar de bolsillo' sobre una cuota con un cruce
        // devolvia el 409 del piso y la UI mostraba el aviso VERDE de siempre; el dinero no se movia
        // y el usuario creia que si. Es la clase exacta de defecto de v5.7.1 en Pagos: api() NO lanza
        // en un 4xx con cuerpo JSON -lo devuelve como {error}, contrato de v6.1.1-, asi que un
        // .then(() => toast('...')) canta victoria pase lo que pase. Cinco escrituras de esta pantalla
        // lo tenian, mientras las tres de saldo a favor ya lo comprobaban: la asimetria era el olor.
        //
        // ORACULO HIBRIDO: el rechazo NO se inventa. Se le pide al backend REAL y ESA respuesta es la
        // que sirve el espia de red, para que el detector siga al contrato y no a una copia suya.
        {
          const rechazo = (await pedir(port, 'PUT', '/api/compras/' + dest.compra_destino_id + '/bolsillo',
            { monto_bolsillo: 0, cuota_num: dest.cuota_num, desde_terceros: true })).j;
          if (!(rechazo && rechazo.error)) {
            notas.push('FALLO de sanidad [E7]: el backend deberia rechazar quitar el bolsillo de una cuota con cruce y respondio ' + JSON.stringify(rechazo));
          } else {
            const avisos = [];
            const espia = () => Promise.resolve({ ok: true, json: () => Promise.resolve(rechazo) });
            const semilla = [];
            semilla[iCompras] = compras;
            semilla[iSaldos] = saldos;
            semilla[1] = { compra: { id: dest.compra_destino_id, descripcion: 'F11 DIFERIDA', es_diferida: true, monto_bolsillo: 100000, _cuota_num: dest.cuota_num }, target: 100000, monto: '' };
            const cQ = montarConEstado(raiz, semilla, { fetch: espia });
            cQ.window.__addToast = (msg, tipo) => avisos.push({ msg: String(msg), tipo: tipo });
            const arbolQ = cQ.Terceros({ tarjeta: tarjetaC });
            const btnQ = buscarNodo(arbolQ, n => n.type === 'button' && /Quitar de bolsillo/.test(textoDe(n)));
            if (!btnQ) {
              notas.push('FALLO de sanidad [E7]: no se dibujo el boton "Quitar de bolsillo" -> la ranura de bolsilloModal se movio');
            } else {
              await btnQ.props.onClick();
              await new Promise(r => setTimeout(r, 0));
              const exito = avisos.filter(a => /Bolsillo quitado/.test(a.msg));
              const error = avisos.filter(a => a.tipo === 'error');
              if (exito.length) {
                notas.push('FALLO [E7]: el backend rechazo la escritura y la UI anuncio "Bolsillo quitado" -> el usuario cree que movio dinero que sigue donde estaba');
              }
              if (!error.length) {
                notas.push('FALLO [E7]: la escritura fue rechazada y no se le dijo nada al usuario (avisos: ' + JSON.stringify(avisos) + ')');
              }
            }
            cifras.rechazoAvisado = 'si';
          }
        }
      });
    } catch (e) { notas.push('FALLO ejecutando el escenario E6: ' + e.message); }

    return resultado(notas.length === 0, cifras, notas);
  },
  defecto: 'objetivoTerceroCop vuelve a derivar la deuda del tercero contra valor_cop pelado (el defecto EXACTO de v4.8.2)',
  mutar(raiz) {
    // Con el objetivo en capital pelado, la compra internacional cuyo cruce cubre valor_cop pasa a
    // "Pagado" y su boton se atenua: la plata del recargo intl desaparece de la vista y no hay forma
    // de completarla. F1/F5 no lo ven -es una expresion valida y el simbolo casi no cambia de tamaño-
    // y F8 tampoco, porque siembra su propio `data` y no dibuja esta pestaña.
    const aguja = 'const objetivoTerceroCop = (c) => (c.valor_cop || 0) + Math.round(c.interes_sellado || 0) + calcInteresIntlTercero(c);';
    if (!mutarEnAlgunaPieza(raiz, aguja, 'const objetivoTerceroCop = (c) => (c.valor_cop || 0);')) {
      throw new Error('no se encontro objetivoTerceroCop en la pestaña Terceros');
    }
  },
};

// ─── Andamiaje de F12: CompraForm medido por el PAYLOAD que construye ───────
//
// POR QUE ES DISTINTO DE F8/F11: aquellas vigilan pantallas que MUESTRAN dinero. CompraForm
// CONSTRUYE el objeto que lo crea. Todo su trabajo termina en una linea -onSave(payload)- y onSave
// es un PROP, asi que se le puede inyectar un espia y quedarse con exactamente lo que el formulario
// decidio. Ese es el oraculo: no "se dibujo bien" sino "que va a guardar". Cuando hace falta cerrar
// el circulo, ese mismo payload se manda a los endpoints REALES y se audita la BD.
//
// El otro espia es el de los avisos: toast() lee window.__addToast en el momento de llamarse, asi
// que basta publicarlo en el sandbox para saber no solo QUE se bloqueo, sino que se le dijo al
// usuario. Un bloqueo mudo y uno que explica no son lo mismo.
const F12_CICLO = '2029-06';
const TARJETA_F12 = { id: null, nombre: 'F12 TARJETA', banco: 'Bancolombia', franquicia: 'Visa',
  dia_corte: 30, tasa_mv_avances: 0.02, cupo_total: 10000000, ciclo_vigente: F12_CICLO, cortes_custom: {} };

// Huella de las ranuras de useState. Con 20 estados y tipos repetidos, localizar "por el tipo" es
// ambiguo, asi que se fija la huella COMPLETA y se comprueba tras el render de descubrimiento: si
// alguien reordena, añade o quita un hook, esto dice EXACTAMENTE que ranura se movio en vez de
// sembrar en otra variable y dar por bueno un render que no es el que se cree.
// OJO con la ranura 0: su valor inicial es todayISO(), o sea la fecha REAL. Se comprueba su FORMA,
// nunca su valor — fijar el valor haria que F12 caducara cada dia, que es el defecto que se acaba
// de sellar en R4.
const RANURAS_F12 = [
  { n: 'fecha', t: 'string', re: /^\d{4}-\d{2}-\d{2}$/ },
  { n: 'descripcion', t: 'string', v: '' },
  { n: 'notaPersonal', t: 'string', v: '' },
  { n: 'tasaIntl', t: 'string', v: '' },
  { n: 'valorCop', t: 'string', v: '' },
  { n: 'valorUsd', t: 'string', v: '' },
  { n: 'tasaUsd', t: 'string', v: '' },
  { n: 'personaId', t: 'string', v: '' },
  { n: 'notas', t: 'string', v: '' },
  { n: 'cicloManualVal', t: 'string', v: '' },
  { n: 'facturaSiguienteCorte', t: 'boolean', v: false },
  { n: 'esInternacional', t: 'boolean', v: false },
  { n: 'numCuotas', t: 'number', v: 1 },
  { n: 'cobrarIntereses', t: 'boolean', v: true },
  { n: 'dividir', t: 'boolean', v: false },
  { n: 'splits', t: 'splits' },
  { n: 'intlDescripciones', t: 'array' },
  { n: 'nombresUnicos', t: 'array' },
  { n: 'descSugAbierto', t: 'boolean', v: false },
  { n: 'trmInfo', t: 'null' },
];
const IDX = {};
RANURAS_F12.forEach((r, i) => { IDX[r.n] = i; });

function huellaRanuraOk(esp, val) {
  if (esp.t === 'null') return val === null;
  if (esp.t === 'array') return Array.isArray(val);
  if (esp.t === 'splits') return Array.isArray(val) && val.length === 1 && val[0] && 'persona_id' in val[0] && 'monto' in val[0];
  if (esp.t === 'string') return typeof val === 'string' && (esp.re ? esp.re.test(val) : val === esp.v);
  if (esp.t === 'boolean') return val === esp.v;
  if (esp.t === 'number') return val === esp.v;
  return false;
}

function semillaF12(campos) {
  const s = [];
  Object.keys(campos || {}).forEach(k => {
    if (!(k in IDX)) throw new Error('ranura desconocida en el fixture: ' + k);
    s[IDX[k]] = campos[k];
  });
  return s;
}

// Envia el formulario invocando el onSubmit REAL del <form>. submit(ev) tolera ev undefined (lo
// re-disparaba el modal de confirmacion de v4.7.5), asi que no hace falta fabricar un evento.
async function enviarForm(arbol) {
  const form = buscarNodo(arbol, n => n.type === 'form' && typeof n.props.onSubmit === 'function');
  if (!form) throw new Error('no se encontro el <form> con onSubmit');
  await form.props.onSubmit(undefined);
}
// El campo Cuotas se localiza por su contrato de rango (min 1, max 60), no por su posicion.
function inputCuotas(arbol) {
  return buscarNodo(arbol, n => n.type === 'input' && n.props.type === 'number' && n.props.max === 60);
}
function opcionesAutocompletado(arbol) {
  const out = [];
  recorrerArbol(arbol, n => { if (n.props && n.props.className === 'autocomplete-option') out.push(textoDe(n).trim() || n.props.title); });
  return out;
}
function botonPorTexto(arbol, aguja) {
  return buscarNodo(arbol, n => n.type === 'button' && textoDe(n).indexOf(aguja) !== -1);
}

// ─── F12: el formulario de compras, medido por lo que va a guardar ──────────
//
// Cubre los cinco frentes donde un fallo aqui crea o pierde dinero:
//   C1  DIVISION: la suma de las partes es EXACTAMENTE el Valor COP, y sin fila "Mi parte" el
//       titular NO asume el faltante en silencio (regla de v4.5.1).
//   C2  SPILLOVER: cicloConCorteFront es una copia declarada de helpers/cortes; aqui se enfrenta al
//       ORIGINAL del backend. Y el ciclo destino viaja con ciclo_manual=1: sin el, syncData paso 5
//       recalcula el ciclo y el desvio se revierte solo en el siguiente arranque, sin avisar.
//   C3  GATE DE CUOTAS (v6.1.0), con su modo de fallo silencioso: cuotasFacturadas sale de un
//       parseInt sobre un campo del backend; si ese campo deja de llegar da 0 y el candado se abre.
//   C4  El aviso contextual ANUNCIA una de tres transiciones y el payload lleva su marca. Si se
//       separan, el usuario lee una cosa y ocurre otra (el patron que cazo v5.7.2 en Pagos).
//   C5  Asistente INTL y filtro del autocompletado.
const F12 = {
  id: 'F12',
  nombre: 'CompraForm: el payload que construye (division, spillover, cuotas)',
  async medir(raiz) {
    const notas = [];
    const cifras = {};
    const cortes = require(path.join(raiz, 'backend', 'helpers', 'cortes'));
    const { syncData } = require(path.join(raiz, 'backend', 'config', 'db', 'syncData'));

    try {
      await conApp(raiz, 'F12', async (port, db) => {
        // ── Siembra: tarjeta y personas propias, para que los ids del payload existan de verdad
        //    cuando se cierre el circulo contra la BD.
        const tjId = db.prepare("INSERT INTO tarjetas (nombre, banco, franquicia, dia_corte, cupo_total, tasa_mv_avances, estado) VALUES (?,?,?,?,?,?, 'activa')")
          .run(TARJETA_F12.nombre, TARJETA_F12.banco, TARJETA_F12.franquicia, 30, 10000000, 0.02).lastInsertRowid;
        const pA = db.prepare("INSERT INTO personas (nombre, color) VALUES ('F12 UNO', '#111111')").run().lastInsertRowid;
        const pB = db.prepare("INSERT INTO personas (nombre, color) VALUES ('F12 DOS', '#222222')").run().lastInsertRowid;
        const tarjeta = Object.assign({}, TARJETA_F12, { id: tjId });
        const personas = [{ id: pA, nombre: 'F12 UNO' }, { id: pB, nombre: 'F12 DOS' }];

        const montar = (campos, props) => {
          const c = montarConEstado(raiz, semillaF12(campos));
          const avisos = [];
          const guardado = [];
          c.window.__addToast = (msg, tipo) => avisos.push({ msg: String(msg), tipo: tipo });
          const arbol = c.CompraForm(Object.assign({
            item: null, personas: personas, ciclo: F12_CICLO, tarjeta: tarjeta,
            onSave: (p) => guardado.push(p), onCancel: () => {},
          }, props || {}));
          return { c: c, arbol: arbol, avisos: avisos, guardado: guardado };
        };

        // ── Huella de ranuras: corta antes que todo lo demas ──
        const disc = montar({});
        const orden = disc.c.__hooks || [];
        if (orden.length !== RANURAS_F12.length) {
          notas.push('FALLO de sanidad: CompraForm declara ' + orden.length + ' useState y la huella fija ' +
            RANURAS_F12.length + ' -> se añadio o quito un hook; revisar RANURAS_F12 antes de fiarse de nada');
          return;
        }
        const desalineadas = [];
        RANURAS_F12.forEach((esp, i) => { if (!huellaRanuraOk(esp, orden[i])) desalineadas.push(i + ':' + esp.n + ' (llego ' + JSON.stringify(orden[i]) + ')'); });
        if (desalineadas.length) {
          notas.push('FALLO de sanidad: las ranuras de useState no coinciden con la huella -> el fixture sembraria otra variable. Desalineadas: ' + desalineadas.join(', '));
          return;
        }
        cifras.ranuras = orden.length;

        // ══ C1 — DIVISION: conservacion del dinero ══
        const dividido = (splits, valor) => montar({ valorCop: valor || '100000', dividir: true, splits: splits });

        // C1a: cuadre exacto -> el payload reparte el total sin perder ni inventar un peso.
        {
          const r = dividido([{ persona_id: String(pA), monto: '60000' }, { persona_id: 'personal', monto: '40000' }]);
          await enviarForm(r.arbol);
          if (r.guardado.length !== 1 || !Array.isArray(r.guardado[0])) {
            notas.push('FALLO [C1a]: con el cuadre exacto no se guardo un array de compras (' + JSON.stringify(r.avisos) + ')');
          } else {
            const partes = r.guardado[0];
            const suma = partes.reduce((s, p) => s + p.valor_cop, 0);
            if (suma !== 100000) notas.push('FALLO [C1a/CONSERVACION]: las partes suman ' + suma + ' y el Valor COP es 100000 -> el reparto crea o pierde dinero');
            const dePersona = partes.filter(p => p.persona_id === pA)[0];
            const personal = partes.filter(p => p.persona_id === null)[0];
            if (!dePersona || dePersona.valor_cop !== 60000) notas.push('FALLO [C1a]: la parte del tercero no llego como 60000 (' + JSON.stringify(dePersona) + ')');
            if (!personal || personal.valor_cop !== 40000) notas.push('FALLO [C1a]: la fila "Mi parte" no viaja como parte personal de 40000 (' + JSON.stringify(personal) + ')');
            // Cierre contra la BD: lo que el formulario construyo tiene que sobrevivir al backend.
            for (const p of partes) await pedir(port, 'POST', '/api/compras', Object.assign({}, p, { tarjeta_id: tjId }));
            const enBd = db.prepare('SELECT COALESCE(SUM(valor_cop),0) t, COUNT(*) n FROM compras WHERE grupo_id=?').get(partes[0].grupo_id);
            if (enBd.n !== 2 || Math.round(enBd.t) !== 100000) {
              notas.push('FALLO [C1a/BD]: tras guardar, el grupo tiene ' + enBd.n + ' partes que suman ' + enBd.t + ' (se esperaban 2 y 100000)');
            }
            cifras.grupoEnBd = enBd.t;
          }
        }

        // C1b: SIN fila "Mi parte" y con faltante -> el titular NO lo asume. Bloquea y lo explica.
        {
          const r = dividido([{ persona_id: String(pA), monto: '60000' }]);
          await enviarForm(r.arbol);
          if (r.guardado.length !== 0) {
            const p = r.guardado[0];
            notas.push('FALLO [C1b/CONSERVACION]: faltaban 40000 y sin fila "Mi parte" el formulario guardo igual -> el titular asume el faltante en silencio (' +
              (Array.isArray(p) ? JSON.stringify(p.map(x => [x.persona_id, x.valor_cop])) : JSON.stringify(p)) + ')');
          } else if (!r.avisos.some(a => /Falta asignar/.test(a.msg))) {
            notas.push('FALLO [C1b]: bloqueo sin decir que falta asignar (' + JSON.stringify(r.avisos) + ')');
          } else if (!r.avisos.some(a => /Mi parte/.test(a.msg))) {
            notas.push('FALLO [C1b]: el aviso no sugiere agregar la fila "Mi parte", que es la unica salida correcta');
          }
        }

        // C1c: exceso -> tambien bloquea (la simetria importa: sobrar es tan corrupto como faltar).
        {
          const r = dividido([{ persona_id: String(pA), monto: '60000' }, { persona_id: String(pB), monto: '60000' }]);
          await enviarForm(r.arbol);
          if (r.guardado.length !== 0 || !r.avisos.some(a => /exceden/.test(a.msg))) {
            notas.push('FALLO [C1c]: las partes exceden el total y no se bloqueo con ese motivo (guardo=' + r.guardado.length + ', avisos=' + JSON.stringify(r.avisos) + ')');
          }
        }

        // C1d/C1e: filas sin responsable y responsables repetidos.
        {
          const r = dividido([{ persona_id: '', monto: '100000' }]);
          await enviarForm(r.arbol);
          if (r.guardado.length !== 0 || !r.avisos.some(a => /responsable/.test(a.msg))) {
            notas.push('FALLO [C1d]: una fila sin responsable deberia bloquear (guardo=' + r.guardado.length + ')');
          }
          const r2 = dividido([{ persona_id: String(pA), monto: '50000' }, { persona_id: String(pA), monto: '50000' }]);
          await enviarForm(r2.arbol);
          if (r2.guardado.length !== 0 || !r2.avisos.some(a => /mismo responsable/.test(a.msg))) {
            notas.push('FALLO [C1e]: el mismo responsable dos veces deberia bloquear (guardo=' + r2.guardado.length + ')');
          }
        }

        // C1f: "repartir en partes iguales" cuadra POR CONSTRUCCION, incluso con totales que no
        // dividen exacto. El boton actualiza estado, asi que se captura su updater y se aplica al
        // valor actual: se audita su aritmetica sin montar un React de verdad.
        {
          let repartos = 0;
          for (const total of ['100000', '100001', '99999']) {
            for (let n = 2; n <= 7; n++) {
              const filas = [];
              for (let i = 0; i < n; i++) filas.push({ persona_id: i === 0 ? 'personal' : String(i === 1 ? pA : pB) + '_' + i, monto: '' });
              const r = dividido(filas, total);
              const boton = botonPorTexto(r.arbol, 'Repartir en partes iguales');
              if (!boton) { notas.push('FALLO [C1f]: no se encontro el boton de repartir'); break; }
              boton.props.onClick();
              const ult = r.c.__setState[r.c.__setState.length - 1];
              if (!ult || ult.ranura !== IDX.splits) { notas.push('FALLO [C1f]: el boton no actualizo la ranura de splits'); break; }
              const nuevos = typeof ult.valor === 'function' ? ult.valor(filas) : ult.valor;
              const suma = nuevos.reduce((s, x) => s + Math.round(parseFloat(x.monto) || 0), 0);
              if (suma !== Math.round(parseFloat(total))) {
                notas.push('FALLO [C1f/CONSERVACION]: repartir ' + total + ' entre ' + n + ' da ' + suma +
                  ' -> el residuo del redondeo se pierde y el cuadre estricto bloqueara al usuario');
              }
              repartos++;
            }
          }
          cifras.repartos = repartos;
        }

        // ══ C2 — SPILLOVER: el espejo del ciclo contra el ORIGINAL del backend ══
        {
          db.prepare("INSERT INTO cortes_custom (tarjeta_id, ciclo, fecha_corte) VALUES (?,?,?)").run(tjId, '2029-06', '2029-06-18');
          const mapa = cortes.getCortesCustomMap(db, tjId);
          const casos = [
            { fecha: '2029-06-15', cortes: {} },
            { fecha: '2029-06-30', cortes: {} },          // el dia del corte pertenece al ciclo que cierra
            { fecha: '2029-05-31', cortes: {} },          // ultimo dia de mes
            { fecha: '2029-12-31', cortes: {} },          // cruce de año
            { fecha: '2029-06-20', cortes: mapa },        // ya paso el corte REAL adelantado (18)
          ];
          let comprobados = 0;
          for (const caso of casos) {
            const tj = Object.assign({}, tarjeta, { cortes_custom: caso.cortes });
            const r = montar({ fecha: caso.fecha, valorCop: '50000', facturaSiguienteCorte: true }, { tarjeta: tj });
            await enviarForm(r.arbol);
            if (r.guardado.length !== 1) { notas.push('FALLO [C2]: no se guardo nada para ' + caso.fecha + ' (' + JSON.stringify(r.avisos) + ')'); continue; }
            const p = r.guardado[0];
            // ORACULO: el original del backend, no una copia de la formula en el detector.
            const natural = cortes.cicloConCorte(caso.fecha, 30, caso.cortes);
            const esperado = cortes.siguienteCiclo(natural);
            if (p.ciclo !== esperado) {
              notas.push('FALLO [C2/ESPEJO]: para ' + caso.fecha + ' el formulario manda la compra a ' + p.ciclo +
                ' y el backend la facturaria en ' + natural + ', o sea el destino es ' + esperado + ' -> cicloConCorteFront se separo de helpers/cortes');
            }
            if (p.ciclo_manual !== 1) {
              notas.push('FALLO [C2/CICLO_MANUAL]: el spillover de ' + caso.fecha + ' viaja con ciclo_manual=' + p.ciclo_manual +
                ' -> syncData recalculara el ciclo por la fecha y el desvio se revertira solo en el proximo arranque');
            }
            if (p.fecha !== caso.fecha) notas.push('FALLO [C2]: el spillover movio la FECHA real de la compra (' + p.fecha + ' en vez de ' + caso.fecha + ')');
            comprobados++;
          }
          cifras.spillover = comprobados;

          // Y la prueba de fuego: guardarlo y dejar que syncData opine.
          const r = montar({ fecha: '2029-06-15', valorCop: '50000', facturaSiguienteCorte: true });
          await enviarForm(r.arbol);
          if (r.guardado.length === 1) {
            const p = r.guardado[0];
            const resp = await pedir(port, 'POST', '/api/compras', Object.assign({}, p, { tarjeta_id: tjId, descripcion: 'F12 SPILLOVER' }));
            const id = resp.j && resp.j.id;
            const antes = id ? db.prepare('SELECT ciclo FROM compras WHERE id=?').get(id) : null;
            syncData(db);
            const despues = id ? db.prepare('SELECT ciclo FROM compras WHERE id=?').get(id) : null;
            if (!antes || !despues) notas.push('FALLO [C2]: no se pudo releer la compra del spillover tras guardarla');
            else if (antes.ciclo !== despues.ciclo) {
              notas.push('FALLO [C2/SYNCDATA]: syncData movio la compra de ' + antes.ciclo + ' a ' + despues.ciclo +
                ' -> el "canje retrasado" no sobrevive a un reinicio');
            }
            cifras.cicloTrasSync = despues ? despues.ciclo : null;
          }
        }

        // ══ C3 — GATE DE CUOTAS, con su modo de fallo silencioso ══
        {
          const itemBase = { id: 999001, fecha: '2029-06-10', descripcion: 'F12 DIF', valor_cop: 300000,
            estado: 'diferida', diferida_id: 555, cuotas_total: 3, ciclo: F12_CICLO, monto_abonado: 0 };
          const libre = montar({}, { item: Object.assign({}, itemBase, { cuotas_facturadas: 0 }) });
          const inpLibre = inputCuotas(libre.arbol);
          if (!inpLibre) notas.push('FALLO [C3]: no se encontro el campo Cuotas (min 1 / max 60)');
          else if (inpLibre.props.disabled) notas.push('FALLO [C3]: con 0 cuotas facturadas el campo Cuotas esta bloqueado -> se impide una operacion legitima');

          const bloq = montar({}, { item: Object.assign({}, itemBase, { cuotas_facturadas: 2 }) });
          const inpBloq = inputCuotas(bloq.arbol);
          if (!inpBloq || !inpBloq.props.disabled) {
            notas.push('FALLO [C3]: con 2 cuotas ya facturadas el campo Cuotas sigue editable -> rehacer el plan desde el origen borraria lo que el banco ya cobro');
          }
          if (!/Reprogramar saldo restante/.test(textoDe(bloq.arbol))) {
            notas.push('FALLO [C3]: el bloqueo no desvia a "Reprogramar saldo restante" -> es un no sin salida');
          }
          // El campo del que depende el candado tiene que LLEGAR de verdad: si el backend deja de
          // enviarlo, parseInt(undefined)||0 da 0 y el candado se abre sin que nada falle.
          const difs = db.prepare("SELECT c.id FROM compras c JOIN diferidas d ON c.diferida_id=d.id LIMIT 1").get();
          if (difs) {
            const lista = (await pedir(port, 'GET', '/api/compras?tarjeta_id=' + (db.prepare('SELECT tarjeta_id FROM compras WHERE id=?').get(difs.id) || {}).tarjeta_id)).j || [];
            const fila = lista.filter(x => x.id === difs.id)[0];
            if (!fila || !('cuotas_facturadas' in fila)) {
              notas.push('FALLO [C3/CONTRATO]: GET /api/compras ya no envia cuotas_facturadas -> el candado del formulario se abre en silencio');
            }
            cifras.contratoCuotas = fila && ('cuotas_facturadas' in fila) ? 'ok' : 'ausente';
          }
        }

        // ══ C4 — el aviso ANUNCIA la transicion que el payload dispara ══
        {
          const base = { id: 999002, fecha: '2029-06-10', descripcion: 'F12 TRANS', valor_cop: 300000,
            ciclo: F12_CICLO, monto_abonado: 0, cuotas_facturadas: 0 };
          const casos = [
            { nombre: 'convertir 1->3', item: Object.assign({}, base, { estado: 'pendiente' }), cuotas: 3,
              anuncia: /se convertir. en diferida/i, marca: '_convertirCuotas' },
            { nombre: 'reprogramar 3->5', item: Object.assign({}, base, { estado: 'diferida', diferida_id: 556, cuotas_total: 3 }), cuotas: 5,
              anuncia: /Cambiar plan completo/i, marca: '_reprogramarCuotas' },
            { nombre: 'revertir 3->1', item: Object.assign({}, base, { estado: 'diferida', diferida_id: 557, cuotas_total: 3 }), cuotas: 1,
              anuncia: /volver. a ser de 1 cuota/i, marca: '_revertirCuotas' },
          ];
          for (const caso of casos) {
            const r = montar({ numCuotas: caso.cuotas, valorCop: '300000' }, { item: caso.item });
            const texto = textoDe(r.arbol);
            const anuncia = caso.anuncia.test(texto);
            await enviarForm(r.arbol);
            const p = r.guardado[0];
            const lleva = !!(p && p[caso.marca]);
            if (!anuncia) notas.push('FALLO [C4]: en "' + caso.nombre + '" el formulario no anuncia la transicion que va a ocurrir');
            if (!lleva) notas.push('FALLO [C4]: en "' + caso.nombre + '" el payload no lleva ' + caso.marca + ' (' + JSON.stringify(p && Object.keys(p).filter(k => k[0] === '_')) + ')');
            if (anuncia !== lleva) {
              notas.push('FALLO [C4/PARIDAD]: en "' + caso.nombre + '" lo que se anuncia y lo que se ejecuta no coinciden -> el usuario lee una cosa y ocurre otra');
            }
          }
        }

        // ══ C5 — asistente INTL y filtro del autocompletado ══
        {
          const conPista = montar({ descripcion: 'AMAZ', intlDescripciones: ['amazon com mktp'] });
          if (!/inter.s internacional/i.test(textoDe(conPista.arbol))) {
            notas.push('FALLO [C5]: el asistente INTL no avisa con un nombre que historicamente cobro interes internacional');
          }
          const yaMarcada = montar({ descripcion: 'AMAZ', intlDescripciones: ['amazon com mktp'], esInternacional: true });
          if (/inter.s internacional. Considera/i.test(textoDe(yaMarcada.arbol))) {
            notas.push('FALLO [C5]: el asistente INTL sigue avisando con el check ya marcado (aviso redundante)');
          }
          const corta = montar({ descripcion: 'AM', intlDescripciones: ['amazon com mktp'] });
          if (/Considera marcar/i.test(textoDe(corta.arbol))) {
            notas.push('FALLO [C5]: el asistente INTL dispara con menos de 3 caracteres -> falsos positivos');
          }
          // Autocompletado: substring, sin la coincidencia exacta, tope 8.
          // DOCE candidatos que casan, no ocho: con exactamente 8 el tope nunca se ejercita y el
          // aserto pasa aunque alguien lo suba. Lo destapo su propio control negativo.
          const nombres = ['NETFLIX'];
          for (let i = 2; i <= 13; i++) nombres.push('NETFLIX ' + i);
          nombres.push('OTRO');
          const auto = montar({ descripcion: 'netflix', nombresUnicos: nombres, descSugAbierto: true });
          const ops = opcionesAutocompletado(auto.arbol);
          if (ops.length !== 8) notas.push('FALLO [C5]: el autocompletado ofrece ' + ops.length + ' sugerencias y el tope es 8');
          if (ops.indexOf('NETFLIX') !== -1) notas.push('FALLO [C5]: el autocompletado sugiere el nombre exacto que ya esta escrito');
          if (ops.indexOf('OTRO') !== -1) notas.push('FALLO [C5]: el autocompletado sugiere un nombre que no contiene lo escrito');
          cifras.sugerencias = ops.length;
        }
      });
    } catch (e) {
      return resultado(false, cifras, ['FALLO ejecutando el escenario: ' + e.message]);
    }

    return resultado(notas.length === 0, cifras, notas);
  },
  defecto: 'sin fila "Mi parte", el titular absorbe el faltante de una compra dividida en silencio',
  mutar(raiz) {
    // Deroga la regla de v4.5.1: el faltante deja de bloquear y se le carga al titular. Es el defecto
    // mas caro de esta pantalla porque no falla ni avisa — solo aparece meses despues, cuando la
    // deuda de alguien no cuadra. F1/F5 no lo ven: es codigo valido y el simbolo casi no cambia.
    const aguja = 'const diff = Math.round(totalCop) - sumTerceros - miParteFinal;';
    if (!mutarEnAlgunaPieza(raiz, aguja, 'if (!hayFilaPersonal) miParteFinal = Math.round(totalCop) - sumTerceros;\n      const diff = Math.round(totalCop) - sumTerceros - miParteFinal;')) {
      throw new Error('no se encontro el cuadre del modo dividido en CompraForm');
    }
  },
};

// ─── Andamiaje de F13: efectos ejecutados y red espiada ─────────────────────
//
// F12 mide lo que CompraForm decide de forma SINCRONA (el payload). Lo que queda vive en el ciclo de
// vida y en la red: la cadena USD, la TRM por fecha, el aislamiento del autocompletado y la rama de
// division CON cuotas, que hace `await api(...)` ANTES del POST. Es otro oraculo y otro andamiaje,
// asi que es otro detector — y de paso gana su propio control negativo en la suite, en vez de
// compartir el de F12.
//
// Los efectos se RECOGEN al montar y se ejecutan aqui a proposito: asi el detector elige cuando
// corren y puede leer que setter se llamo y con que. La red se sirve con un doble que registra cada
// peticion (metodo, url y cuerpo ya deserializado) y responde lo que el escenario necesite.
function espiaRed(responder) {
  const peticiones = [];
  const fetchDoble = (url, opts) => {
    let cuerpo = null;
    try { cuerpo = opts && opts.body ? JSON.parse(opts.body) : null; } catch (e) { cuerpo = opts.body; }
    peticiones.push({ url: String(url), metodo: (opts && opts.method) || 'GET', cuerpo: cuerpo });
    const data = responder ? responder(String(url), cuerpo) : {};
    return Promise.resolve({ ok: true, json: () => Promise.resolve(data) });
  };
  return { fetch: fetchDoble, peticiones: peticiones };
}
function correrEfectos(c) {
  const errores = [];
  (c.__efectos || []).forEach((ef, i) => { try { ef.fn(); } catch (e) { errores.push('efecto ' + i + ': ' + e.message); } });
  return errores;
}
// Deja que se resuelvan las cadenas de promesas que arrancan los efectos (el fallback de la TRM
// encadena un segundo api()). El setTimeout del sandbox es un stub, asi que se usa el de Node.
function vaciarCola() { return new Promise(r => setTimeout(r, 0)); }

// Los tres campos de la cadena USD se localizan por su contrato visible, no por su posicion.
const SEL_USD = (n) => n.type === 'input' && n.props.placeholder === 'Ej: 9.99';
const SEL_TASA = (n) => n.props && n.props.placeholder === 'Ej: 4.150';
function refDe(c, valor) { return (c.__refs || []).filter(r => r.current === valor)[0] || null; }

// ─── F13: CompraForm en su ciclo de vida y en la red ────────────────────────
//
//   C6  cadena USD↔tasa↔COP (v4.5.4), sus cuatro ramas, el seguro anti-bucle que vive en un ref y
//       la excepcion de las tarjetas duales (donde auto-calcular COP pisaria el 0 esperado).
//   C7  la TRM se pide por la FECHA DE LA COMPRA, no por la de hoy (v5.8.0). El desfase medido
//       entonces entre una y otra fue ~6%: pedir la de hoy no falla, solo miente.
//   C8  el autocompletado se pide por tarjeta (v4.9.0): sin el parametro, la Visa sugiere comercios
//       de la RappiCard.
//   C9  division CON cuotas: cada parte crea SU diferida antes del POST. El invariante es que cada
//       una lleve el monto de SU parte y no el total — si no, la proyeccion de intereses se infla
//       por cada persona y nadie lo ve hasta que llega el extracto.
const F13 = {
  id: 'F13',
  nombre: 'CompraForm: efectos y red (cadena USD, TRM por fecha, division con cuotas)',
  async medir(raiz) {
    const notas = [];
    const cifras = {};
    const cortes = require(path.join(raiz, 'backend', 'helpers', 'cortes'));
    const tarjeta = Object.assign({}, TARJETA_F12, { id: 4242, tasa_mv_diferidas: 0.02 });

    const montar = (campos, props, responder) => {
      const red = espiaRed(responder);
      const c = montarConEstado(raiz, semillaF12(campos), { fetch: red.fetch });
      const avisos = [];
      const guardado = [];
      c.window.__addToast = (msg, tipo) => avisos.push({ msg: String(msg), tipo: tipo });
      const arbol = c.CompraForm(Object.assign({
        item: null, personas: [{ id: 7, nombre: 'F13 UNO' }, { id: 8, nombre: 'F13 DOS' }],
        ciclo: F12_CICLO, tarjeta: tarjeta, onSave: (p) => guardado.push(p), onCancel: () => {},
      }, props || {}));
      return { c: c, arbol: arbol, red: red, avisos: avisos, guardado: guardado };
    };

    // ══ C6 — cadena USD ↔ tasa ↔ COP ══
    {
      // (a) Edita USD teniendo tasa -> deriva COP.
      const a = montar({ esInternacional: true, valorUsd: '100', tasaUsd: '4000', valorCop: '' });
      const inpUsd = buscarNodo(a.arbol, SEL_USD);
      if (!inpUsd) notas.push('FALLO [C6]: no se encontro el campo Valor USD');
      else {
        inpUsd.props.onChange({ target: { value: '100' } });   // wiring real: esto arma el ref
        if (!refDe(a.c, 'usd')) notas.push('FALLO [C6]: editar Valor USD no deja constancia de cual fue el ultimo campo tocado');
        correrEfectos(a.c);
        const puesto = a.c.__setState.filter(x => x.ranura === IDX.valorCop).pop();
        if (!puesto || puesto.valor !== 400000) {
          notas.push('FALLO [C6/USD->COP]: con 100 USD a 4000 el COP deberia quedar en 400000 y quedo en ' + (puesto ? puesto.valor : 'NADA'));
        }
      }

      // (b) Edita COP teniendo USD -> deriva la tasa.
      const b = montar({ esInternacional: true, valorUsd: '100', tasaUsd: '', valorCop: '400000' });
      const inpCop = buscarNodo(b.arbol, (n) => n.props && n.props.required === true && typeof n.props.onChange === 'function' && n.props.value === '400000');
      if (!inpCop) notas.push('FALLO [C6]: no se encontro el campo Valor COP');
      else {
        inpCop.props.onChange('400000');
        correrEfectos(b.c);
        const puesto = b.c.__setState.filter(x => x.ranura === IDX.tasaUsd).pop();
        if (!puesto || puesto.valor !== 4000) {
          notas.push('FALLO [C6/COP->TASA]: 400000 COP por 100 USD deberia dar una tasa de 4000 y dio ' + (puesto ? puesto.valor : 'NADA'));
        }
      }

      // (c) Edita USD SIN tasa pero con COP -> deriva la tasa Y arma el seguro anti-bucle. Sin el,
      //     la siguiente pasada recalcularia COP y pisaria el valor que el usuario escribio.
      const cc = montar({ esInternacional: true, valorUsd: '100', tasaUsd: '', valorCop: '400000' });
      const inpUsd2 = buscarNodo(cc.arbol, SEL_USD);
      if (inpUsd2) {
        inpUsd2.props.onChange({ target: { value: '100' } });
        correrEfectos(cc.c);
        const puesto = cc.c.__setState.filter(x => x.ranura === IDX.tasaUsd).pop();
        if (!puesto || puesto.valor !== 4000) {
          notas.push('FALLO [C6/USD-SIN-TASA]: deberia derivar la tasa (4000) y derivo ' + (puesto ? puesto.valor : 'NADA'));
        }
        if (!refDe(cc.c, 'cop')) {
          notas.push('FALLO [C6/BUCLE]: tras derivar la tasa, el seguro anti-bucle no quedo armado -> la siguiente pasada recalcularia COP y pisaria lo que escribio el usuario');
        }
        // Y la comprobacion de verdad: una segunda pasada no puede tocar el COP.
        const antes = cc.c.__setState.filter(x => x.ranura === IDX.valorCop).length;
        correrEfectos(cc.c);
        const despues = cc.c.__setState.filter(x => x.ranura === IDX.valorCop).length;
        if (despues !== antes) notas.push('FALLO [C6/BUCLE]: una segunda pasada del efecto volvio a escribir el Valor COP (' + antes + ' -> ' + despues + ')');
      }

      // (d) Edita la tasa -> recalcula COP.
      const d = montar({ esInternacional: true, valorUsd: '100', tasaUsd: '4200', valorCop: '400000' });
      const inpTasa = buscarNodo(d.arbol, SEL_TASA);
      if (!inpTasa) notas.push('FALLO [C6]: no se encontro el campo Tasa USD');
      else {
        inpTasa.props.onChange('4200');
        correrEfectos(d.c);
        const puesto = d.c.__setState.filter(x => x.ranura === IDX.valorCop).pop();
        if (!puesto || puesto.valor !== 420000) {
          notas.push('FALLO [C6/TASA->COP]: 100 USD a 4200 deberia dar 420000 y dio ' + (puesto ? puesto.valor : 'NADA'));
        }
      }

      // (e) Tarjeta DUAL: nada de auto-calculo reciproco (el COP en 0 es un valor esperado, no un hueco).
      const dual = Object.assign({}, tarjeta, { franquicia: 'Mastercard' });
      const e5 = montar({ esInternacional: true, valorUsd: '100', tasaUsd: '4000', valorCop: '' }, { tarjeta: dual });
      const inpUsd3 = buscarNodo(e5.arbol, SEL_USD);
      if (inpUsd3) {
        inpUsd3.props.onChange({ target: { value: '100' } });
        correrEfectos(e5.c);
        if (e5.c.__setState.some(x => x.ranura === IDX.valorCop)) {
          notas.push('FALLO [C6/DUAL]: en una tarjeta dual el efecto auto-calculo el Valor COP -> pisa el 0 que la moneda nativa USD deja a proposito');
        }
      }
      cifras.ramasUsd = 5;
    }

    // ══ C7 — la TRM se pide por la FECHA DE LA COMPRA ══
    {
      const fechaCompra = '2029-06-15';
      const r = montar({ fecha: fechaCompra }, null, (url) => (url.indexOf('/trm-fecha') !== -1 ? { ok: true, trm: 3900 } : { trm: 3100 }));
      correrEfectos(r.c);
      await vaciarCola();
      const porFecha = r.red.peticiones.filter(p => p.url.indexOf('/trm-fecha') !== -1);
      if (porFecha.length === 0) {
        notas.push('FALLO [C7]: no se pidio la TRM por fecha -> se usaria la de hoy para una compra de otro dia');
      } else if (porFecha[0].url.indexOf('fecha=' + fechaCompra) === -1) {
        notas.push('FALLO [C7/FECHA]: la TRM se pidio con "' + porFecha[0].url + '" en vez de la fecha de la compra (' + fechaCompra + ')');
      }
      // Fallback: si no hay TRM para esa fecha, cae a la actual. Es lo que evita quedarse sin dato.
      const r2 = montar({ fecha: fechaCompra }, null, (url) => (url.indexOf('/trm-fecha') !== -1 ? { ok: false } : { trm: 3100 }));
      correrEfectos(r2.c);
      await vaciarCola();
      if (!r2.red.peticiones.some(p => p.url.indexOf('/trm-actual') !== -1)) {
        notas.push('FALLO [C7/FALLBACK]: sin TRM para esa fecha no se recurrio a la actual -> el formulario se queda sin tasa');
      }
      cifras.trm = porFecha.length;
    }

    // ══ C8 — el autocompletado se pide POR TARJETA ══
    {
      const r = montar({});
      correrEfectos(r.c);
      await vaciarCola();
      const nombres = r.red.peticiones.filter(p => p.url.indexOf('nombres-unicos') !== -1);
      if (nombres.length === 0) notas.push('FALLO [C8]: no se pidieron los nombres para el autocompletado');
      else if (nombres[0].url.indexOf('tarjeta_id=' + tarjeta.id) === -1) {
        notas.push('FALLO [C8/AISLAMIENTO]: los nombres se piden con "' + nombres[0].url + '", sin acotar a la tarjeta -> una tarjeta sugiere comercios de otra');
      }
      const otra = Object.assign({}, tarjeta, { id: 9999 });
      const r2 = montar({}, { tarjeta: otra });
      correrEfectos(r2.c);
      await vaciarCola();
      const nombres2 = r2.red.peticiones.filter(p => p.url.indexOf('nombres-unicos') !== -1);
      if (nombres2.length && nombres2[0].url.indexOf('tarjeta_id=9999') === -1) {
        notas.push('FALLO [C8/AISLAMIENTO]: al cambiar de tarjeta la peticion no cambio de tarjeta_id (' + nombres2[0].url + ')');
      }
      cifras.autocompletado = nombres.length;
    }

    // ══ C9 — division CON cuotas: una diferida por parte, ANTES del POST ══
    {
      let seq = 0;
      const responder = (url) => (url.indexOf('/diferidas') !== -1 ? { id: ++seq } : {});
      const splits = [{ persona_id: '7', monto: '60000' }, { persona_id: 'personal', monto: '30000' }];
      const r = montar({ valorCop: '90000', dividir: true, numCuotas: 3, splits: splits, facturaSiguienteCorte: true, fecha: '2029-06-15' }, null, responder);
      await enviarForm(r.arbol);

      const difs = r.red.peticiones.filter(p => p.url.indexOf('/diferidas') !== -1);
      if (difs.length !== 2) {
        notas.push('FALLO [C9]: se esperaba una diferida por parte (2) y se crearon ' + difs.length);
      } else {
        const montos = difs.map(d => d.cuerpo.monto).sort((x, y) => x - y);
        if (montos[0] !== 30000 || montos[1] !== 60000) {
          notas.push('FALLO [C9/CONSERVACION]: cada parte debe amortizar SU monto (30000 y 60000) y se pidieron ' + JSON.stringify(montos) +
            (montos.some(m => m === 90000) ? ' -> se le paso el TOTAL a una parte: su proyeccion de intereses queda inflada' : ''));
        }
        if (montos[0] + montos[1] !== 90000) notas.push('FALLO [C9/CONSERVACION]: los montos de las diferidas suman ' + (montos[0] + montos[1]) + ' y el total es 90000');
        if (difs.some(d => d.cuerpo.num_cuotas !== 3)) notas.push('FALLO [C9]: alguna diferida no se creo a 3 cuotas');
        // Spillover Fase 2 (v5.0.0): cada plan arranca en el corte del ciclo DESTINO, no en el natural.
        const destino = cortes.siguienteCiclo(cortes.cicloConCorte('2029-06-15', 30, {}));
        const corteEsperado = cortes.corteDeCiclo(destino, 30);
        const malCorte = difs.filter(d => d.cuerpo.fecha_primer_corte !== corteEsperado);
        if (malCorte.length) {
          notas.push('FALLO [C9/SPILLOVER]: con "canje retrasado" el plan debe arrancar en el corte de ' + destino + ' (' + corteEsperado +
            ') y arranca en ' + JSON.stringify(malCorte.map(d => d.cuerpo.fecha_primer_corte)));
        }
        // La fecha REAL de la compra se conserva: es lo que evita que syncData paso 11 reajuste el corte.
        if (difs.some(d => d.cuerpo.fecha_compra !== '2029-06-15')) {
          notas.push('FALLO [C9]: la diferida no conserva la fecha real de la compra -> syncData reajustaria su primer corte');
        }
      }
      // Y el payload: cada parte vinculada a SU diferida, ninguna compartiendo plan.
      const partes = r.guardado[0];
      if (!Array.isArray(partes) || partes.length !== 2) {
        notas.push('FALLO [C9]: no se guardaron las dos partes (' + JSON.stringify(r.avisos) + ')');
      } else {
        const ids = partes.map(p => p.diferida_id);
        if (ids.some(x => !x) || ids[0] === ids[1]) {
          notas.push('FALLO [C9/VINCULO]: las partes no quedaron vinculadas a diferidas distintas (' + JSON.stringify(ids) + ')');
        }
        if (partes.reduce((s, p) => s + p.valor_cop, 0) !== 90000) notas.push('FALLO [C9/CONSERVACION]: las partes guardadas no suman el total');
        if (partes.some(p => p.ciclo !== destinoDe(cortes, '2029-06-15') || p.ciclo_manual !== 1)) {
          notas.push('FALLO [C9/SPILLOVER]: alguna parte no viaja al ciclo destino con ciclo_manual=1');
        }
      }
      cifras.diferidasPorParte = difs.length;
    }

    // ══ C10 — el plan arranca en el corte del ciclo de SU compra (dia del corte incluido) ══
    //
    // Hasta el 24-ago-2026 el primer corte se calculaba con un bloque inline propio que usaba
    // ">= diaCorte", mientras el ciclo de la compra sale de calcCicloLocal, que usa "> diaCorte".
    // Divergian en UNA fecha por mes -el propio dia del corte- y ahi la compra quedaba en el ciclo
    // que cierra con su plan arrancando un mes despues: la primera cuota no se facturaba en el
    // extracto donde aparece la compra. El bloque vivia TRIPLICADO (dividida, individual y
    // DiferidaForm), asi que se comprueban los tres caminos.
    //
    // El oraculo es la derivacion del BACKEND para esa fecha, no el `ciclo` del payload: en el
    // camino natural ese campo es el ciclo de la VISTA (el backend deriva el real de la fecha).
    {
      const diaCorte = 30;
      const corteCanonico = (f) => cortes.corteDeCiclo(cortes.cicloConCorte(f, diaCorte, {}), diaCorte);
      const responder = (url) => (url.indexOf('/diferidas') !== -1 ? { id: 1 } : {});
      let comprobadas = 0;
      for (const f of ['2029-06-15', '2029-06-29', '2029-06-30', '2029-07-01', '2029-05-31']) {
        const esperado = corteCanonico(f);

        const div = montar({ valorCop: '90000', dividir: true, numCuotas: 3, fecha: f,
          splits: [{ persona_id: '7', monto: '60000' }, { persona_id: 'personal', monto: '30000' }] }, null, responder);
        await enviarForm(div.arbol);
        const pDiv = div.red.peticiones.filter(x => x.url.indexOf('/diferidas') !== -1);
        const malDiv = pDiv.filter(x => x.cuerpo.fecha_primer_corte !== esperado);
        if (!pDiv.length) notas.push('FALLO [C10]: la compra dividida a cuotas del ' + f + ' no creo ningun plan');
        else if (malDiv.length) {
          notas.push('FALLO [C10/COHERENCIA]: compra DIVIDIDA del ' + f + ' -> su plan arranca en ' +
            malDiv[0].cuerpo.fecha_primer_corte + ' y su ciclo cierra el ' + esperado +
            ' -> la primera cuota no se facturaria en el extracto donde aparece la compra');
        }

        const uni = montar({ valorCop: '90000', numCuotas: 3, fecha: f }, null, responder);
        await enviarForm(uni.arbol);
        const pUni = uni.red.peticiones.filter(x => x.url.indexOf('/diferidas') !== -1);
        if (!pUni.length) notas.push('FALLO [C10]: la compra individual a cuotas del ' + f + ' no creo su plan');
        else if (pUni[0].cuerpo.fecha_primer_corte !== esperado) {
          notas.push('FALLO [C10/COHERENCIA]: compra INDIVIDUAL del ' + f + ' -> su plan arranca en ' +
            pUni[0].cuerpo.fecha_primer_corte + ' y deberia arrancar el ' + esperado);
        }
        comprobadas++;
      }

      // Tercer camino: DiferidaForm (standalone) llevaba el mismo bloque por tercera vez.
      const red = espiaRed(() => ({}));
      const semDf = [];
      semDf[4] = '2029-06-30';                       // fechaCompra: el dia del corte, el caso que fallaba
      const cdf = montarConEstado(raiz, semDf, { fetch: red.fetch });
      cdf.DiferidaForm({ item: null, tarjeta: tarjeta, onSave: () => {}, onCancel: () => {} });
      const ordenDf = cdf.__hooks || [];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(ordenDf[4])) || ordenDf[5] !== '') {
        notas.push('FALLO de sanidad: las ranuras de DiferidaForm se movieron (4=fechaCompra, 5=fechaPrimerCorte); el fixture mediria otra variable');
      } else {
        correrEfectos(cdf);
        const puesto = cdf.__setState.filter(x => x.ranura === 5).pop();
        const esperadoDf = corteCanonico('2029-06-30');
        if (!puesto || puesto.valor !== esperadoDf) {
          notas.push('FALLO [C10/COHERENCIA]: DiferidaForm propone arrancar el plan en ' + (puesto ? puesto.valor : 'NADA') +
            ' para una compra del dia del corte, y le corresponde ' + esperadoDf);
        }
      }
      cifras.coherenciaCorte = comprobadas;
    }

    return resultado(notas.length === 0, cifras, notas);
  },
  defecto: 'cada parte de una compra dividida a cuotas amortiza el TOTAL en vez de su propia parte',
  mutar(raiz) {
    // Defecto silencioso y caro: la compra se guarda bien (las partes suman el total) pero CADA plan
    // de cuotas proyecta el total, asi que los intereses se multiplican por el numero de personas y
    // no se ve hasta que llega el extracto. Nada sincrono lo detecta: hay que mirar la peticion.
    const aguja = 'tarjeta_id: tarjeta.id, etiqueta: descripcion, monto: part.monto,';
    if (!mutarEnAlgunaPieza(raiz, aguja, 'tarjeta_id: tarjeta.id, etiqueta: descripcion, monto: Math.round(totalCop),')) {
      throw new Error('no se encontro la creacion de diferidas por parte en CompraForm');
    }
  },
};
function destinoDe(cortes, fecha) { return cortes.siguienteCiclo(cortes.cicloConCorte(fecha, 30, {})); }

// ─── F14: ReprogramarForm — el PAYLOAD de "Sellar y Renacer" ────────────────
//
// POR QUE EXISTE: es el formulario con el que se reprograma un plan teniendo el extracto delante, y
// desde v6.5.0 decide DOS cosas que el backend no puede adivinar: cual era el plan ORIGINAL del
// banco -de ahi sale la cuota base con la que comprime- y en que ciclo fue EFECTIVA la
// reprogramacion. Lo segundo no es cosmetico: un extracto llega SIEMPRE despues de su corte, asi
// que sin declararlo el endpoint sella un mes de mas y corre la compresion al siguiente (medido con
// NETFLIX en agosto-2026). Ninguna otra pieza de la suite dibuja este formulario -F12/F13 cubren
// CompraForm y F8 la vista principal-, asi que hasta un ReferenceError en su render salia en VERDE.
// Se mide como F12: capturando el payload que sale por `onSave`, que es un prop, en vez de fiarse
// de lo que el formulario dibuja.
const F14 = {
  id: 'F14',
  nombre: 'ReprogramarForm: el payload de Sellar y Renacer (plan original + ciclo efectivo)',
  medir(raiz) {
    const notas = [];
    const cifras = {};
    // Escenario SEMBRADO (criterio de R6/R8/F8), y es el caso real que destapo el sprint: NETFLIX de
    // 44.900 que la app tiene a 3 cuotas y el banco venia de un plan de 4 (cuota base 11.225).
    const item = { id: 71, compra_id: 678, etiqueta: 'NETFLIX', monto: 44900, tasa_mv: 0.021285, num_cuotas: 3,
      amortizacion: [
        { numCuota: 1, fechaCorte: '2026-07-30', cuotaCapital: 14966.67 },
        { numCuota: 2, fechaCorte: '2026-08-30', cuotaCapital: 14966.67 },
        { numCuota: 3, fechaCorte: '2026-09-30', cuotaCapital: 14966.66 },
      ] };
    const tarjeta = { id: 4, dia_corte: 30, ciclo_vigente: '2026-09' };
    const props = { item: item, tarjeta: tarjeta, onSave: () => {}, onCancel: () => {} };

    // Huella de ranuras: se comprueba DESPUES de un render de descubrimiento (antes __hooks esta
    // vacio) y por la FORMA del valor inicial, nunca por un indice escrito a mano.
    let sonda;
    try {
      sonda = montarConEstado(raiz, []);
      if (typeof sonda.ReprogramarForm !== 'function') {
        return resultado(false, {}, ['FALLO: ReprogramarForm no es alcanzable en el ambito global']);
      }
      sonda.ReprogramarForm(props);
    } catch (e) {
      return resultado(false, {}, ['FALLO renderizando ReprogramarForm: ' + e.message]);
    }
    const h = sonda.__hooks;
    const forma = h.map(v => typeof v).join(',');
    cifras.hooks = h.length;
    if (h.length !== 6 || forma !== 'number,boolean,string,boolean,string,string') {
      return resultado(false, cifras, ['FALLO: la huella de ranuras es [' + forma + '] (' + h.length + ') y se esperaba ' +
        '[number,boolean,string,boolean,string,string] (6) -> alguien reordeno, anadio o quito un useState y el detector estaria sembrando en la ranura equivocada']);
    }
    if (h[4] !== '3') notas.push('FALLO: el campo del plan original no arranca con el plan que la app tiene hoy (llego "' + h[4] + '", se esperaba "3")');
    if (h[5] !== tarjeta.ciclo_vigente) notas.push('FALLO: el ciclo efectivo no arranca en el vigente (llego "' + h[5] + '")');

    // La pantalla de confirmacion (ranura 3) es donde vive el boton que llama a onSave.
    const payloadDe = (slots) => {
      const capt = [];
      const semilla = [];
      semilla[3] = true;
      Object.keys(slots).forEach(i => { semilla[i] = slots[i]; });
      const c = montarConEstado(raiz, semilla);
      let arbol;
      try { arbol = c.ReprogramarForm({ item: item, tarjeta: tarjeta, onSave: (d) => capt.push(d), onCancel: () => {} }); }
      catch (e) { return { error: 'reventó al dibujar: ' + e.message }; }
      const btn = buscarNodo(arbol, n => n.type === 'button' && /Confirmar reprogramacion/.test(textoDe(n)));
      if (!btn || typeof btn.props.onClick !== 'function') return { error: 'no se hallo el boton "Confirmar reprogramacion"', texto: textoDe(arbol) };
      btn.props.onClick();
      return { payload: capt[0], texto: textoDe(arbol) };
    };

    // ── A) POR DEFECTO: el plan original es el de la app y el ciclo es el vigente ──────
    // El ciclo efectivo NO debe viajar: sin el, el endpoint se comporta exactamente como siempre.
    const A = payloadDe({});
    if (A.error) notas.push('FALLO [A/defecto]: ' + A.error);
    else if (!A.payload) notas.push('FALLO [A/defecto]: confirmar no llamo a onSave');
    else {
      cifras.defecto = JSON.stringify(A.payload);
      if (Number(A.payload.num_cuotas_original) !== 3) {
        notas.push('FALLO [A/defecto]: viaja num_cuotas_original=' + JSON.stringify(A.payload.num_cuotas_original) + ' en vez de 3');
      }
      if ('ciclo_efectivo' in A.payload) {
        notas.push('FALLO [A/defecto]: viaja ciclo_efectivo=' + JSON.stringify(A.payload.ciclo_efectivo) + ' aunque es el vigente -> el camino de siempre deja de ser el de siempre');
      }
    }

    // ── B) CONCILIANDO: plan original 4 y la reprogramacion efectiva en el ciclo del extracto ──
    const Bp = payloadDe({ 4: '4', 5: '2026-08' });
    if (Bp.error) notas.push('FALLO [B/conciliando]: ' + Bp.error);
    else if (!Bp.payload) notas.push('FALLO [B/conciliando]: confirmar no llamo a onSave');
    else {
      cifras.conciliando = JSON.stringify(Bp.payload);
      if (Bp.payload.ciclo_efectivo !== '2026-08') {
        notas.push('FALLO [B/ciclo efectivo]: viaja ciclo_efectivo=' + JSON.stringify(Bp.payload.ciclo_efectivo) + ' en vez de 2026-08 ' +
          '-> el backend sellaria la cuota de agosto y correria la compresion a septiembre, al reves que el banco');
      }
      if (Number(Bp.payload.num_cuotas_original) !== 4) {
        notas.push('FALLO [B/plan original]: viaja num_cuotas_original=' + JSON.stringify(Bp.payload.num_cuotas_original) + ' en vez de 4 ' +
          '-> la cuota base saldria del plan de la app (14.967) y no del banco (11.225)');
      }
      // Y lo que ENSEÑA antes de aplicar: con el original en 4 la cuota base es 11.225. Si la
      // pantalla no lo dice, el usuario confirma a ciegas un reparto que no puede prever.
      if (String(Bp.texto || '').indexOf('11.225') === -1) {
        notas.push('FALLO [B/vista previa]: la confirmacion no muestra la cuota base 11.225 que implica el plan original declarado: ' + String(Bp.texto || '').slice(0, 200));
      }
    }

    // ── C) ESCAPE: vaciar el plan original vuelve al reparto uniforme de siempre ───────
    // El modelo de compresion descansa hoy en UNA sola observacion; tiene que poder apagarse.
    const C = payloadDe({ 4: '' });
    if (C.error) notas.push('FALLO [C/uniforme]: ' + C.error);
    else if (!C.payload) notas.push('FALLO [C/uniforme]: confirmar no llamo a onSave');
    else {
      cifras.uniforme = JSON.stringify(C.payload);
      if ('num_cuotas_original' in C.payload) {
        notas.push('FALLO [C/uniforme]: con el campo vacio sigue viajando num_cuotas_original=' + JSON.stringify(C.payload.num_cuotas_original) +
          ' -> no hay forma de pedir el reparto en partes iguales');
      }
    }

    return resultado(notas.length === 0, cifras, notas);
  },
  defecto: 'el formulario deja de declarar el ciclo EFECTIVO (vuelve a mandar solo el total de cuotas)',
  mutar(raiz) {
    // Se busca por CONTENIDO y se LANZA si no aparece. Ancla de UNA linea: los archivos estan en CRLF
    // y una aguja con salto de linea no casa nunca.
    const ruta = require('path').join(raiz, 'public', 'js', 'formularios.js');
    const src = leer(ruta);
    const aguja = "if (cicloEfectivo && cicloEfectivo !== vigente) data.ciclo_efectivo = cicloEfectivo;";
    if (src.indexOf(aguja) === -1) throw new Error('no se encontro la linea que manda ciclo_efectivo en ReprogramarForm');
    fs.writeFileSync(ruta, src.replace(aguja, "if (false) data.ciclo_efectivo = cicloEfectivo;"), 'utf8');
  },
};

module.exports = [F1, F2, F3, F4, F5, F6, F7, F8, F9, F10, F11, F12, F13, F14];
module.exports.medirSimbolos = medirSimbolos;
module.exports.piezasEnOrden = piezasEnOrden;
module.exports.RUTA_SIMBOLOS = RUTA_SIMBOLOS;
