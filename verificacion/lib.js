'use strict';
// verificacion/lib.js — Andamiaje comun de la suite.
//
// LA REGLA MADRE, implementada aqui: ningun detector puede opinar sin haber demostrado antes que
// SABE FALLAR. Cada detector se ejecuta DOS veces: contra el arbol real (control positivo, debe
// dar verde y cumplir sus pisos) y contra una copia con un defecto inyectado a proposito (control
// negativo, debe dar ROJO). Si el control negativo no falla, el detector se declara INVALIDO y la
// suite entera se marca en rojo aunque todo lo demas pase.
//
// Sin esto, un detector que dejo de mirar sigue imprimiendo "OK" indefinidamente.

const fs = require('fs');
const path = require('path');

const RAIZ = path.resolve(__dirname, '..');
// El temporal va FUERA del repo: fs.cpSync se niega a copiar un directorio dentro de si mismo
// (EINVAL), y ese error hacia que TODOS los controles negativos "detectaran" el defecto por la
// excepcion de la copia en vez de por el defecto. Un falso verde dentro del propio instrumental.
const TMP = path.join(require('os').tmpdir(), 'controltc_verificacion');

// ─── Reloj congelado ─────────────────────────────────────────────────────────
// hoyLocal() y cicloActualStr() son las DOS unicas lecturas del reloj en helpers/dates.
// Los consumidores hacen `const { hoyLocal } = require('../helpers/dates')`, o sea capturan la
// referencia EN EL MOMENTO en que ellos se cargan: por eso hay que parchear ANTES de que se
// cargue nada del backend. Si se llama tarde, el parche no tiene efecto y no avisa.
let relojCongelado = false;
function congelarReloj(fecha) {
  const dates = require(path.join(RAIZ, 'backend', 'helpers', 'dates.js'));
  dates.hoyLocal = () => fecha;
  dates.cicloActualStr = () => fecha.slice(0, 7);
  relojCongelado = true;
  return dates;
}
// Guard: detecta el error de haber congelado tarde. Si algun modulo del backend ya estaba en la
// cache de require ANTES del parche, su destructuring apunta al hoyLocal original.
function verificarCongeladoATiempo() {
  const cargados = Object.keys(require.cache).filter(p =>
    p.indexOf(path.join(RAIZ, 'backend')) === 0 &&
    p.indexOf(path.join(RAIZ, 'backend', 'helpers', 'dates.js')) !== 0);
  return { ok: cargados.length === 0, cargados };
}

// ─── Arbol temporal para los controles negativos ─────────────────────────────
// El arbol se copia fuera del repo y se le engancha node_modules con una JUNCTION (en Windows no
// necesita permisos de administrador). Sin ella, Node no resolveria `require('express')` desde el
// arbol copiado, porque los busca subiendo directorios hasta encontrar un node_modules.
function copiarArbol(sufijo) {
  const destino = path.join(TMP, 'arbol' + (sufijo || ''));
  fs.rmSync(destino, { recursive: true, force: true });
  fs.mkdirSync(destino, { recursive: true });
  const excluir = new Set(['node_modules', '.git', 'dist', 'build']);
  // OJO: fs.cpSync entrega las rutas con el prefijo de ruta larga de Windows (\\?\C:\...). Si se
  // comparan tal cual contra RAIZ (que viene sin prefijo y con separadores normalizados),
  // path.relative NO devuelve una ruta relativa sino la absoluta entera, el primer segmento pasa a
  // ser "\\?\C:" y el filtro deja de excluir NADA. Sintoma: intenta copiar node_modules y muere
  // con ENOTDIR al toparse con un .asar. Hay que normalizar los dos lados antes de comparar.
  const sinPrefijo = (p) => String(p).replace(/^\\\\\?\\/, '');
  const raizNorm = path.resolve(RAIZ);
  fs.cpSync(RAIZ, destino, {
    recursive: true,
    filter: (src) => {
      const rel = path.relative(raizNorm, path.resolve(sinPrefijo(src)));
      if (!rel) return true;
      return !excluir.has(rel.split(path.sep)[0]);
    },
  });
  const nm = path.join(destino, 'node_modules');
  if (!fs.existsSync(nm)) {
    try { fs.symlinkSync(path.join(RAIZ, 'node_modules'), nm, 'junction'); }
    catch (e) { throw new Error('no se pudo enlazar node_modules en el arbol de prueba: ' + e.message); }
  }
  return destino;
}

// Copia de la BD. SIEMPRE sobre copia: instanciar la app llama a initDb, que termina en syncData
// con 30 sentencias de escritura, y ademas GET /api/extractos siembra, actualiza y BORRA filas.
// Capturar golden masters contra el archivo de produccion alteraria justo lo que se quiere
// congelar. Los sidecars del WAL se copian tambien: un -wal viejo sin resetear ya produjo un
// falso positivo en este proyecto (v5.2.0).
function copiarBd(sufijo) {
  const { getDbPath } = require(path.join(RAIZ, 'backend', 'config', 'db.js'));
  const origen = getDbPath();
  if (!fs.existsSync(origen)) throw new Error('No existe la BD de origen: ' + origen);
  fs.mkdirSync(TMP, { recursive: true });
  const destino = path.join(TMP, 'bd' + (sufijo || '') + '.db');
  for (const s of ['', '-wal', '-shm']) { try { fs.unlinkSync(destino + s); } catch (e) {} }
  fs.copyFileSync(origen, destino);
  // Los sidecars se copian en lo posible: el -shm puede estar bloqueado por otro proceso y su
  // ausencia no invalida la copia (SQLite lo regenera). Fallar aqui abortaria el detector entero.
  for (const s of ['-wal', '-shm']) {
    try { if (fs.existsSync(origen + s)) fs.copyFileSync(origen + s, destino + s); } catch (e) {}
  }
  return { destino, origen, hashOrigen: hashArchivo(origen) };
}

function hashArchivo(p) {
  return require('crypto').createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}
function hashTexto(t) {
  return require('crypto').createHash('sha256').update(String(t)).digest('hex');
}

// Las conexiones de better-sqlite3 abiertas por los detectores mantienen bloqueados los .db, asi
// que en Windows el borrado da EBUSY. No es un fallo de la verificacion: se informa y se sigue.
function limpiarTmp() {
  try { fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 3, retryDelay: 120 }); return true; }
  catch (e) { return false; }
}

// ─── Utilidades de lectura ───────────────────────────────────────────────────
function leer(p) { return fs.readFileSync(p, 'utf8'); }

// Lista los .js propios (sin node_modules) recorriendo el disco, NO una lista escrita a mano.
// El patron historico del proyecto era "node --check <los 4 archivos que toque>", que por
// construccion nunca comprueba los archivos que un refactor acaba de crear.
// raices: por defecto SOLO el codigo de la aplicacion. La suite tambien se comprueba a si misma
// (llamando con ['verificacion']), pero nunca se mezcla con el codigo de la app: sus fuentes
// contienen literales como require('better-sqlite3') dentro de las mutaciones, y contarlos como
// si fueran del backend rompia el centinela del boot y el grafo de requires.
function listarJs(raiz, raices) {
  const out = [];
  raices = raices || ['backend', 'desktop'];
  for (const r of raices) {
    const base = path.join(raiz, r);
    if (!fs.existsSync(base)) continue;
    (function anda(d) {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') anda(p); }
        else if (e.name.endsWith('.js')) out.push(p);
      }
    })(base);
  }
  return out.sort();
}

// Extrae el script inline de un index.html. Descubre TODAS las etiquetas <script>, no asume que
// haya una sola: ese fue el modo de fallo exacto que dejo ciego al validador historico cuando el
// codigo se mudo a archivos externos y el par <script></script> siguio existiendo, vacio.
function analizarIndexHtml(rutaHtml) {
  const html = leer(rutaHtml);
  const tags = [];
  const re = /<script([^>]*)>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const attrs = m[1] || '';
    const src = (attrs.match(/src\s*=\s*["']([^"']+)["']/i) || [])[1] || null;
    tags.push({ attrs: attrs.trim(), src, indice: m.index });
  }
  // El inline es el que no tiene src.
  const inlineTag = tags.filter(t => !t.src);
  let inline = '';
  if (inlineTag.length) {
    const desde = html.indexOf('>', inlineTag[0].indice) + 1;
    const hasta = html.indexOf('</script>', desde);
    inline = html.slice(desde, hasta);
  }
  const locales = tags
    .filter(t => t.src && !/^https?:\/\//i.test(t.src))
    .map(t => t.src);
  const cdn = tags.filter(t => t.src && /^https?:\/\//i.test(t.src)).map(t => t.src);
  return { html, tags, inline, locales, cdn };
}

// ─── Registro y formato del informe ──────────────────────────────────────────
class Registro {
  constructor() { this.filas = []; this.invalidos = []; }

  // resultadoReal:    { ok, cifras, notas }  medido contra el arbol intacto
  // resultadoMutado:  { ok, cifras, notas }  medido contra el arbol con el defecto inyectado
  anotar(det, real, mutado, defecto) {
    const detectaDefecto = mutado && mutado.ok === false;
    if (!detectaDefecto) this.invalidos.push(det.id);
    this.filas.push({
      id: det.id, nombre: det.nombre,
      okReal: !!(real && real.ok), cifras: (real && real.cifras) || {},
      notas: (real && real.notas) || [],
      detectaDefecto, defecto,
      motivoMutado: (mutado && mutado.notas && mutado.notas.join(' ; ')) || '',
      motivoReal: (real && real.notas && real.notas.find(n => /FALLO|FALTA|ESPERADO/.test(n))) || '',
    });
  }

  imprimir() {
    const L = console.log;
    L('');
    L('='.repeat(96));
    L('  RESULTADO POR DETECTOR');
    L('='.repeat(96));
    L('');
    L('  ' + 'ID'.padEnd(5) + 'DETECTOR'.padEnd(52) + 'REAL'.padEnd(8) + 'SABE FALLAR');
    L('  ' + '-'.repeat(92));
    for (const f of this.filas) {
      L('  ' + f.id.padEnd(5) + f.nombre.slice(0, 50).padEnd(52) +
        (f.okReal ? 'VERDE ' : 'ROJO  ').padEnd(8) +
        (f.detectaDefecto ? 'si' : 'NO -> DETECTOR INVALIDO'));
      const cif = Object.keys(f.cifras);
      if (cif.length) {
        L('       cifras: ' + cif.map(k => k + '=' + f.cifras[k]).join('  '));
      }
      if (!f.okReal && f.motivoReal) L('       motivo: ' + f.motivoReal);
      L('       control negativo: ' + f.defecto);
      // Se imprime el desenlace SIEMPRE, detecte o no. Ocultar el motivo cuando NO detecta deja
      // al detector invalido sin explicacion, que es la forma mas rapida de acabar ignorandolo.
      L('         -> ' + (f.detectaDefecto ? 'lo detecto asi: ' : 'NO lo detecto. Motivo: ') +
        (f.motivoMutado || '(el detector devolvio verde sobre el arbol defectuoso)').slice(0, 150));
    }
    L('');
  }

  get todoVerde() {
    return this.filas.every(f => f.okReal) && this.invalidos.length === 0;
  }
}

// Helper para construir resultados uniformes.
function resultado(ok, cifras, notas) {
  return { ok: !!ok, cifras: cifras || {}, notas: notas || [] };
}

module.exports = {
  RAIZ, TMP,
  congelarReloj, verificarCongeladoATiempo, relojCongelado: () => relojCongelado,
  copiarArbol, copiarBd, limpiarTmp,
  hashArchivo, hashTexto, leer, listarJs, analizarIndexHtml,
  Registro, resultado,
};
