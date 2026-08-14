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
const { leer, analizarIndexHtml, resultado } = require('../lib');
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
    fetch: () => Promise.resolve({ ok: true, json: () => Promise.resolve({}) }),
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
function montarConEstado(raiz, semilla) {
  const store = (semilla || []).slice();
  const orden = [];
  let idx = 0;
  const React = {
    createElement: (t, props, ...hijos) => ({ type: t, props: props || {}, hijos }),
    useState: (init) => {
      const i = idx++;
      orden[i] = init;
      if (!(i in store) || store[i] === undefined) store[i] = init;
      return [store[i], () => {}];
    },
    useEffect: () => {}, useCallback: (f) => f, useRef: () => ({ current: null }),
    // useLayoutEffect NO esta desestructurado en core.js: se usa via React.* (el FLIP del
    // reordenamiento de v6.0.0). Sin el, CardResumen revienta antes de dibujar una sola fila.
    useLayoutEffect: () => {},
    useMemo: (f) => (typeof f === 'function' ? f() : undefined), Fragment: 'Fragment',
  };
  const { ctx } = cargarFrontend(raiz, { React });
  ctx.__hooks = orden;
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
  medir(raiz) {
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
  d.saldoBolsillo = 500000; d.saldoBolsilloBruto = 500000;
  d.pagoMinimo = 3000000;
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
    if (t1.indexOf('$500.000') === -1) notas.push('FALLO: la card "Saldo en Bolsillo" no muestra los $500.000 sembrados');

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

module.exports = [F1, F2, F3, F4, F5, F6, F7, F8];
module.exports.medirSimbolos = medirSimbolos;
module.exports.piezasEnOrden = piezasEnOrden;
module.exports.RUTA_SIMBOLOS = RUTA_SIMBOLOS;
