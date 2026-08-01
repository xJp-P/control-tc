'use strict';
// verificacion/detectores/frontend.js — F1..F5
//
// El frontend es un unico <script> inline de ~7.771 lineas sin build, sin JSX y sin modulos ES.
// Se verifica con cuatro angulos distintos porque cada uno se queda ciego de una forma:
//   F1 parsea cada pieza por separado  -> no ve colisiones entre piezas.
//   F2 parsea la concatenacion         -> ve las colisiones, no ve el orden de evaluacion.
//   F3 EJECUTA la carga con dobles     -> ve el orden y la TDZ, no ve si falta un simbolo.
//   F4 pregunta por cada identificador -> ve los simbolos, no ve su tamano.
//   F5 mide el tamano de cada simbolo  -> mata el stub vacio que satisface a los otros cuatro.

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
  defecto: 'index.html reducido a un <script> con solo el bootstrap (simula el codigo mudado a archivos externos que el detector ya no mira)',
  mutar(raiz) {
    const p = INDEX(raiz);
    const html = leer(p);
    const desde = html.indexOf('<script>');
    const hasta = html.indexOf('</script>', desde);
    fs.writeFileSync(p, html.slice(0, desde) + '<script>\nReactDOM.createRoot(document.getElementById("root")).render(e(App));\n' + html.slice(hasta), 'utf8');
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
function cargarFrontend(raiz) {
  const { piezas } = piezasEnOrden(raiz);
  const fuentes = piezas.filter(p => p.fuente);
  if (!fuentes.length) throw new Error('no hay codigo que cargar');
  const texto = fuentes.map(p => p.fuente).join('\n;\n');

  const marcas = { render: 0, createRoot: 0 };
  const hook = () => [undefined, () => {}];
  const React = {
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
    const p = INDEX(raiz);
    let html = leer(p);
    // Mueve la declaracion de BANCOS_PRESETS por encima de DEFAULT_BANCO_URLS.
    const iPres = html.indexOf('const BANCOS_PRESETS');
    const fin = html.indexOf('\n];', iPres) + 3;
    const bloque = html.slice(iPres, fin);
    html = html.slice(0, iPres) + html.slice(fin);
    const iUrls = html.indexOf('const DEFAULT_BANCO_URLS');
    fs.writeFileSync(p, html.slice(0, iUrls) + bloque + '\n' + html.slice(iUrls), 'utf8');
  },
};

// ─── F4: manifiesto de simbolos ─────────────────────────────────────────────
const RUTA_SIMBOLOS = path.join(__dirname, '..', 'simbolos_base.json');

const F4 = {
  id: 'F4',
  nombre: 'Manifiesto de simbolos por identificador (68 exactos)',
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
    const p = INDEX(raiz);
    const html = leer(p);
    const i = html.indexOf('function CardResumen(');
    const j = html.indexOf('\nfunction ', i + 10);
    fs.writeFileSync(p, html.slice(0, i) + 'function CardResumen() { return null; }\n' + html.slice(j), 'utf8');
  },
};

module.exports = [F1, F2, F3, F4, F5];
module.exports.medirSimbolos = medirSimbolos;
module.exports.piezasEnOrden = piezasEnOrden;
module.exports.RUTA_SIMBOLOS = RUTA_SIMBOLOS;
