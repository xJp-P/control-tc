'use strict';
// verificacion/detectores/backend.js — B1..B4 (todos estaticos: no cargan la app)

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { leer, listarJs, analizarIndexHtml, resultado } = require('../lib');
const B = require('../linea_base');

// ─── B1: node --check por BARRIDO ───────────────────────────────────────────
const B1 = {
  id: 'B1',
  nombre: 'Sintaxis del backend por barrido del disco (no lista a mano)',
  medir(raiz) {
    const notas = [];
    const archivos = listarJs(raiz);                       // backend/ + desktop/ = la app
    const propios = listarJs(raiz, ['verificacion']);      // la suite se comprueba a si misma
    let bytes = 0, lineas = 0, malos = 0;
    for (const a of archivos.concat(propios)) {
      const src = leer(a);
      const esApp = archivos.indexOf(a) !== -1;
      if (esApp) { bytes += Buffer.byteLength(src, 'utf8'); lineas += src.split('\n').length; }
      try { new vm.Script(src, { filename: a }); }
      catch (e) { malos++; notas.push('FALLO de sintaxis en ' + path.relative(raiz, a) + ': ' + e.message); }
    }
    // El patron historico del proyecto era "node --check (los N archivos que toque)". Por
    // construccion, un archivo NUEVO nunca aparece en esa lista: el refactor puede crear veinte
    // modulos y ninguno se compila jamas. El barrido los incluye por definicion, y los pisos
    // garantizan que el barrido no se quedo corto.
    const cumple = archivos.length >= B.PISO_BACKEND_ARCHIVOS && bytes >= B.PISO_BACKEND_BYTES && lineas >= B.PISO_BACKEND_LINEAS;
    if (archivos.length < B.PISO_BACKEND_ARCHIVOS) notas.push('FALLO: solo ' + archivos.length + ' archivos, piso ' + B.PISO_BACKEND_ARCHIVOS);
    if (bytes < B.PISO_BACKEND_BYTES) notas.push('FALLO: solo ' + bytes + ' bytes, piso ' + B.PISO_BACKEND_BYTES);
    if (lineas < B.PISO_BACKEND_LINEAS) notas.push('FALLO: solo ' + lineas + ' lineas, piso ' + B.PISO_BACKEND_LINEAS);
    return resultado(malos === 0 && cumple, { archivosApp: archivos.length, archivosSuite: propios.length, bytes, lineas, malos }, notas);
  },
  defecto: 'se rompe la sintaxis de backend/helpers/dates.js (parentesis sin cerrar)',
  mutar(raiz) {
    const p = path.join(raiz, 'backend', 'helpers', 'dates.js');
    fs.writeFileSync(p, leer(p) + '\nfunction rota( {\n', 'utf8');
  },
};

// ─── B2: grafo de requires, resuelto con la CAJA EXACTA ─────────────────────
function aristasRequire(raiz) {
  const out = [];
  for (const a of listarJs(raiz)) {
    const src = leer(a);
    const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
    let m;
    while ((m = re.exec(src)) !== null) out.push({ desde: a, literal: m[1] });
  }
  return out;
}

// Resuelve comparando contra readdirSync, NUNCA con fs.existsSync: en NTFS existsSync miente
// sobre las mayusculas (encuentra 'App.js' pidiendo 'app.js'), mientras que el indice del asar
// del instalador resuelve por clave EXACTA. Un desajuste de caja pasa todo el QA en Windows y
// muere solo en el instalador, con un sintoma que no nombra el archivo.
function resuelveExacto(rutaSinExt) {
  const dir = path.dirname(rutaSinExt);
  const base = path.basename(rutaSinExt);
  if (!fs.existsSync(dir)) return null;
  const entradas = fs.readdirSync(dir);
  for (const cand of [base, base + '.js', base + '.json']) {
    if (entradas.indexOf(cand) !== -1) {
      const p = path.join(dir, cand);
      if (fs.statSync(p).isDirectory()) {
        const sub = fs.readdirSync(p);
        return sub.indexOf('index.js') !== -1 ? path.join(p, 'index.js') : null;
      }
      return p;
    }
  }
  return null;
}

const B2 = {
  id: 'B2',
  nombre: 'Grafo de requires resuelto con caja exacta',
  medir(raiz) {
    const notas = [];
    const aristas = aristasRequire(raiz);
    const rotas = [];
    for (const a of aristas) {
      const objetivo = path.resolve(path.dirname(a.desde), a.literal);
      if (!resuelveExacto(objetivo)) rotas.push(path.relative(raiz, a.desde) + ' -> ' + a.literal);
    }
    if (rotas.length) notas.push('FALLO: ' + rotas.length + ' requires no resuelven: ' + rotas.slice(0, 5).join(' | '));
    // Piso: si el numero de aristas examinadas se desploma, el detector dejo de mirar.
    const piso = 90;
    if (aristas.length < piso) notas.push('FALLO: solo ' + aristas.length + ' aristas examinadas, piso ' + piso);
    return resultado(rotas.length === 0 && aristas.length >= piso, { aristas: aristas.length, rotas: rotas.length }, notas);
  },
  defecto: 'se cambia la caja de un require existente (dates -> Dates), que NTFS resolveria y el asar no',
  mutar(raiz) {
    const p = path.join(raiz, 'backend', 'engine', 'amortizacion.js');
    fs.writeFileSync(p, leer(p).replace("require('../helpers/dates')", "require('../helpers/Dates')"), 'utf8');
  },
};

// ─── B3: centinela del arranque protegido ───────────────────────────────────
// Devuelve el rango [inicio, fin) del cuerpo de una funcion declarada en columna 0, buscando su
// llave de cierre tambien en columna 0. Es el estilo uniforme de este repo.
function cuerpoDeFuncion(src, nombre) {
  const i = src.indexOf('function ' + nombre);
  if (i === -1) return null;
  const lineas = src.slice(0, i).split('\n').length - 1;
  const todas = src.split('\n');
  let fin = todas.length;
  for (let k = lineas + 1; k < todas.length; k++) {
    if (/^\}/.test(todas[k])) { fin = k; break; }
  }
  return { desdeLinea: lineas, hastaLinea: fin };
}

function lineaDe(src, aguja) {
  const i = src.indexOf(aguja);
  return i === -1 ? -1 : src.slice(0, i).split('\n').length - 1;
}

const B3 = {
  id: 'B3',
  nombre: 'Centinela del boot protegido (los dos require diferidos)',
  medir(raiz) {
    const notas = [];
    const cif = {};

    // (1) require('../backend/app') debe estar DENTRO de startBackend, no en la cabecera.
    const main = leer(path.join(raiz, 'desktop', 'main.js'));
    const vecesApp = (main.match(/require\('\.\.\/backend\/app'\)/g) || []).length;
    cif.requireApp = vecesApp;
    const cuerpo = cuerpoDeFuncion(main, 'startBackend');
    const lnApp = lineaDe(main, "require('../backend/app')");
    const appDentro = !!(cuerpo && lnApp > cuerpo.desdeLinea && lnApp < cuerpo.hastaLinea);
    if (vecesApp !== 1) notas.push('FALLO: require de backend/app aparece ' + vecesApp + ' veces (esperado 1)');
    if (!appDentro) notas.push('FALLO: require de backend/app NO esta dentro de startBackend -> el grafo del backend se evaluaria en la fase 1, ANTES del chequeo de actualizaciones');

    // (2) require('better-sqlite3') debe aparecer 1 sola vez en TODO el repo, dentro de initDb.
    let vecesSqlite = 0, archivoSqlite = null;
    for (const a of listarJs(raiz)) {
      const n = (leer(a).match(/require\('better-sqlite3'\)/g) || []).length;
      if (n) { vecesSqlite += n; archivoSqlite = a; }
    }
    cif.requireSqlite = vecesSqlite;
    const db = leer(path.join(raiz, 'backend', 'config', 'db.js'));
    const cInit = cuerpoDeFuncion(db, 'initDb');
    const lnSq = lineaDe(db, "require('better-sqlite3')");
    const sqDentro = !!(cInit && lnSq > cInit.desdeLinea && lnSq < cInit.hastaLinea);
    if (vecesSqlite !== 1) notas.push('FALLO: require de better-sqlite3 aparece ' + vecesSqlite + ' veces en el repo (esperado 1)');
    if (!sqDentro) notas.push('FALLO: require de better-sqlite3 NO esta dentro de initDb -> el binding nativo se cargaria en la fase 1');

    // Por que esto merece un detector propio: la app arranca IGUAL de las dos formas y cualquier
    // smoke pasa. Lo que se pierde al "ordenar los imports" es la garantia de que una version con
    // un bug destructivo se ACTUALICE antes de abrir la BD del usuario, que es el motivo entero
    // del splash bloqueante. Es una prueba de ORDEN, no de resultado: ninguna otra la ve.
    return resultado(vecesApp === 1 && appDentro && vecesSqlite === 1 && sqDentro,
      Object.assign(cif, { appDentroDeStartBackend: appDentro, sqliteDentroDeInitDb: sqDentro }), notas);
  },
  defecto: 'el require de better-sqlite3 se sube a la cabecera de db.js (lo que haria cualquier "ordenar imports")',
  mutar(raiz) {
    const p = path.join(raiz, 'backend', 'config', 'db.js');
    const src = leer(p);
    fs.writeFileSync(p, "const Database = require('better-sqlite3');\n" + src.replace("const Database = require('better-sqlite3');", ''), 'utf8');
  },
};

// ─── B4: empaquetado (sin construir el instalador) ──────────────────────────
const B4 = {
  id: 'B4',
  nombre: 'Empaquetado: todo lo cargado en runtime cae en las 3 raices',
  medir(raiz) {
    const notas = [];
    // Recorre el grafo desde los DOS puntos de entrada reales y comprueba que cada archivo
    // alcanzable vive bajo desktop/, backend/ o public/. El array "files" de electron-builder es
    // una ALLOWLIST: como declara patrones positivos, el empaquetador NO agrega el "**/*" por
    // defecto. Una carpeta nueva (src/, shared/, lib/) funciona perfecto en desarrollo -donde se
    // lee el arbol crudo- y NO EXISTE dentro del asar: MODULE_NOT_FOUND en casa del usuario.
    const entradas = [path.join(raiz, 'desktop', 'main.js'), path.join(raiz, 'backend', 'app.js')];
    const vistos = new Set();
    const fuera = [];
    const pendientes = entradas.slice();
    while (pendientes.length) {
      const a = pendientes.pop();
      if (vistos.has(a)) continue;
      vistos.add(a);
      const rel = path.relative(raiz, a).split(path.sep)[0];
      if (B.RAICES_EMPAQUETADAS.indexOf(rel) === -1) fuera.push(path.relative(raiz, a));
      let src;
      try { src = leer(a); } catch (e) { continue; }
      const re = /require\(\s*['"](\.[^'"]+)['"]\s*\)/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        const r = resuelveExacto(path.resolve(path.dirname(a), m[1]));
        if (r) pendientes.push(r);
      }
    }
    if (fuera.length) notas.push('FALLO: ' + fuera.length + ' archivos cargados en runtime FUERA de las raices empaquetadas: ' + fuera.slice(0, 5).join(', '));

    // Subrecursos declarados por index.html: deben vivir bajo public/ y existir con la caja exacta.
    const info = analizarIndexHtml(path.join(raiz, 'public', 'index.html'));
    const malos = [];
    for (const src of info.locales) {
      const limpio = src.replace(/^\//, '');
      const p = path.join(raiz, 'public', limpio);
      if (!resuelveExacto(p)) malos.push(src);
    }
    if (malos.length) notas.push('FALLO: subrecursos de index.html que no resuelven con caja exacta: ' + malos.join(', '));

    // Extensiones que electron-builder excluye por defecto (los .d.ts se ven en el editor y
    // desaparecen del paquete).
    const prohibidos = [];
    for (const r of B.RAICES_EMPAQUETADAS) {
      const base = path.join(raiz, r);
      if (!fs.existsSync(base)) continue;
      (function anda(d) {
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) anda(p);
          else if (B.EXTENSIONES_PROHIBIDAS.some(x => e.name.endsWith(x))) prohibidos.push(path.relative(raiz, p));
        }
      })(base);
    }
    if (prohibidos.length) notas.push('FALLO: archivos con extension excluida por el empaquetador: ' + prohibidos.join(', '));

    return resultado(fuera.length === 0 && malos.length === 0 && prohibidos.length === 0,
      { alcanzables: vistos.size, fuera: fuera.length, subrecursos: info.locales.length, cdn: info.cdn.length }, notas);
  },
  defecto: 'un modulo del backend se mueve a una carpeta raiz nueva (shared/), que funciona en desarrollo y no entra al instalador',
  mutar(raiz) {
    const compartido = path.join(raiz, 'compartido');
    fs.mkdirSync(compartido, { recursive: true });
    const origen = path.join(raiz, 'backend', 'helpers', 'log.js');
    fs.copyFileSync(origen, path.join(compartido, 'log.js'));
    fs.rmSync(origen);
    const app = path.join(raiz, 'backend', 'app.js');
    fs.writeFileSync(app, leer(app).replace("require('./helpers/log')", "require('../compartido/log')"), 'utf8');
  },
};

module.exports = [B1, B2, B3, B4];
module.exports.resuelveExacto = resuelveExacto;
