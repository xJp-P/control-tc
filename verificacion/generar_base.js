'use strict';
// verificacion/generar_base.js — Genera las TRES referencias que la suite compara:
//   simbolos_base.json   -> inventario de simbolos del frontend (lo usan F4 y F5)
//   huella_motores.json  -> cifras de calcExtracto y de las amortizaciones (lo usa R5)
//   golden_base.json     -> hash por respuesta de los GET inocuos (lo usa R4)
//
// SE EJECUTA A MANO Y A PROPOSITO, nunca desde la suite. Una referencia que se regenera sola no
// vale nada: el dia que el refactor borre un simbolo o mueva un peso, la suite lo "aprenderia" en
// vez de gritarlo. Regenerar es una decision que debe quedar en el diff, y solo tiene sentido
// cuando un cambio YA APROBADO altera de verdad el inventario o las cifras.
//
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe verificacion/generar_base.js [cual...]
//
// SELECTIVO (v5.9.1). Sin argumentos regenera las tres, como siempre. Con argumentos regenera solo
// las nombradas: `simbolos`, `huella`, `golden`. El todo-o-nada era un footgun: las referencias
// caducan por motivos INDEPENDIENTES —simbolos por CODIGO, huella y golden por DATOS— y un cambio de
// UI que solo mueve el tamano de un simbolo obligaba a re-baselinar de paso `huella_motores.json`,
// que es justo la senal que nunca debe re-baselinarse a la ligera. Poder regenerar una sola es lo
// que permite arreglar lo que cambio sin enmascarar lo que no.
//   ... generar_base.js simbolos     -> solo el inventario del frontend
//   ... generar_base.js huella golden -> solo las dos referencias atadas a los datos

const fs = require('fs');
const lib = require('./lib');
const B = require('./linea_base');

const CUALES = new Set(['simbolos', 'huella', 'golden']);
const pedidas = process.argv.slice(2).filter(a => !a.startsWith('-'));
for (const a of pedidas) {
  if (!CUALES.has(a)) {
    console.error('Referencia desconocida: "' + a + '". Validas: ' + [...CUALES].join(', '));
    process.exit(1);
  }
}
// Sin argumentos = las tres (comportamiento historico).
const hacer = (cual) => pedidas.length === 0 || pedidas.indexOf(cual) !== -1;
console.log('Regenerando: ' + [...CUALES].filter(hacer).join(', '));

// El mismo reloj congelado que usa la suite: si la referencia se generara con la fecha real y la
// comprobacion con la congelada, no coincidirian jamas y el desajuste pareceria una regresion.
lib.congelarReloj(B.FECHA_CONGELADA);

const frontend = require('./detectores/frontend');
const runtime = require('./detectores/runtime');

// ─── 1. Simbolos del frontend ────────────────────────────────────────────────
if (hacer('simbolos')) {
  const { piezas } = frontend.piezasEnOrden(lib.RAIZ);
  const simbolos = [];
  for (const p of piezas) {
    if (!p.fuente) continue;
    for (const s of frontend.medirSimbolos(p.fuente)) {
      simbolos.push({ nombre: s.nombre, tipo: s.tipo, lineas: s.lineas, pieza: p.nombre });
    }
  }
  // El bootstrap no es una declaracion: es la unica sentencia ejecutable de nivel superior de todo
  // el script. Se registra aparte para que el conteo cuadre con EXACTO_SIMBOLOS.
  simbolos.push({ nombre: '<bootstrap ReactDOM.createRoot>', tipo: 'bootstrap', lineas: 1, pieza: '<inline>' });

  fs.writeFileSync(frontend.RUTA_SIMBOLOS, JSON.stringify({
    generado: B.FECHA_CONGELADA,
    nota: 'Inventario de simbolos de nivel superior del frontend. F4 comprueba que existen; F5, que conservan su tamano. NO regenerar sin una razon aprobada.',
    total: simbolos.length,
    simbolos,
  }, null, 2) + '\n', 'utf8');

  console.log('simbolos_base.json: ' + simbolos.length + ' simbolos');
  const porTipo = {};
  for (const s of simbolos) porTipo[s.tipo] = (porTipo[s.tipo] || 0) + 1;
  console.log('  por tipo: ' + Object.keys(porTipo).map(k => k + '=' + porTipo[k]).join('  '));
}

// ─── 2. Huella de los motores de dinero ──────────────────────────────────────
// Sobre una COPIA de la BD real: initDb corre syncData (30 sentencias de escritura) y no se toca
// jamas el archivo de produccion.
if (hacer('huella')) {
  const bd = lib.copiarBd('GEN');
  const h = runtime.calcularHuella(lib.RAIZ, bd.destino);
  fs.writeFileSync(runtime.RUTA_HUELLA, JSON.stringify({
    generado: B.FECHA_CONGELADA,
    nota: 'Cifras de calcExtracto y de las amortizaciones sobre los datos reales, con el reloj congelado. Si el refactor solo mueve codigo, esta huella NO puede cambiar. NO regenerar sin una razon aprobada.',
    huella: h.huella,
    filas: h.lineas.length,
    lineas: h.lineas,
  }, null, 2) + '\n', 'utf8');

  console.log('huella_motores.json: ' + h.lineas.length + ' filas (extractos=' + h.okExt + ' diferidas=' + h.okDif + ' avances=' + h.okAv + ')');
  console.log('  huella: ' + h.huella);
  if (h.notas.length) console.log('  AVISOS: ' + h.notas.join(' | '));
}

// --- 3. Golden masters: hash por endpoint ---
// Se guarda el HASH de cada respuesta, no el cuerpo: el corpus pesa cientos de kB y lo que hay que
// congelar es "esta respuesta no cambio", no su contenido literal.
(async () => {
  if (!hacer('golden')) { if (!lib.limpiarTmp()) console.log('  (temporales no borrados: ' + lib.TMP + ')'); return; }
  const bdG = lib.copiarBd('GOLD');
  const corpus = await runtime.capturar(lib.RAIZ, bdG.destino);
  const claves = {};
  let vacias = 0;
  for (const k of Object.keys(corpus)) {
    if (corpus[k].s === 'TIMEOUT') { console.log('  AVISO: timeout en ' + k); continue; }
    if (!corpus[k].b) vacias++;
    claves[k] = lib.hashTexto(corpus[k].b);
  }
  fs.writeFileSync(runtime.RUTA_GOLDEN, JSON.stringify({
    generado: B.FECHA_CONGELADA,
    nota: 'Hash por respuesta de los GET inocuos, con el reloj congelado y ciclos explicitos. Si el refactor solo mueve codigo, ninguno puede cambiar. NO regenerar sin una razon aprobada.',
    total: Object.keys(claves).length,
    // Huella del estado de la BD al generar: si cambia, la referencia caduco por DATOS y no por codigo.
    datos: runtime.huellaDeDatos(lib.RAIZ, bdG.destino),
    claves,
  }, null, 2) + '\n', 'utf8');
  console.log('golden_base.json: ' + Object.keys(claves).length + ' respuestas' + (vacias ? ' (' + vacias + ' vacias!)' : ''));
  if (!lib.limpiarTmp()) console.log('  (temporales no borrados: ' + lib.TMP + ')');
})();

