'use strict';
// verificacion/run.js — Orquestador. Un solo comando, un solo codigo de salida.
//
//   npm test
//   (equivale a: ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe verificacion/run.js)
//
// Tiene que correr bajo Electron porque better-sqlite3 esta compilado para su ABI. Si algun dia
// falla con NODE_MODULE_VERSION, la salida facil es sustituir better-sqlite3 por un doble: NO
// HACERLO. Con el doble, initDb, syncData, los 82 endpoints y las huellas dejan de tocar la capa
// de datos y la suite pasa a verificar unicamente que los archivos parsean.

const fs = require('fs');
const path = require('path');
const lib = require('./lib');
const B = require('./linea_base');

// ─── LO PRIMERO DE TODO: congelar el reloj ──────────────────────────────────
// Antes de que se cargue un solo modulo del backend. Los consumidores hacen
// `const { hoyLocal } = require('../helpers/dates')`, o sea capturan la referencia cuando ELLOS se
// cargan: si el parche llega tarde, no tiene efecto y no avisa de nada.
lib.congelarReloj(B.FECHA_CONGELADA);

const DETECTORES = []
  .concat(require('./detectores/frontend'))
  .concat(require('./detectores/backend'))
  .concat(require('./detectores/runtime'))
  .concat(require('./detectores/escrituras'))
  .concat(require('./detectores/conciliacion'));

async function principal() {
  const L = console.log;
  const t0 = Date.now();

  L('');
  L('='.repeat(96));
  L('  SUITE DE VERIFICACION — Control TC');
  L('  Objetivo: correr VERDE sobre el codigo intacto, para que a partir de aqui');
  L('  cualquier rojo signifique "lo rompi yo" y no "esto ya estaba asi".');
  L('='.repeat(96));

  const aTiempo = lib.verificarCongeladoATiempo();
  if (!aTiempo.ok) {
    L('  ABORTADO: el reloj se congelo TARDE. Estos modulos ya estaban cargados y capturaron');
    L('  el hoyLocal original: ' + aTiempo.cargados.slice(0, 4).join(', '));
    process.exit(1);
  }
  L('  reloj congelado en ' + B.FECHA_CONGELADA + ' (antes de cargar el backend: OK)');

  // Dos copias IDENTICAS de la BD: la A y la B alimentan el control de determinismo de R4.
  // Nunca se toca el archivo de produccion; se comprueba su hash antes y despues.
  fs.mkdirSync(lib.TMP, { recursive: true });
  const bdA = lib.copiarBd('A');
  const bdB = lib.copiarBd('B');
  L('  BD de origen: ' + bdA.origen);
  L('  copias de trabajo: ' + path.basename(bdA.destino) + ' y ' + path.basename(bdB.destino));
  L('');

  const ctxReal = { bd: bdA.destino, bdB: bdB.destino, tmp: lib.TMP };
  const registro = new lib.Registro();

  for (const det of DETECTORES) {
    process.stdout.write('  ejecutando ' + det.id + ' ... ');
    let real = null, mutado = null;

    // 1. CONTROL POSITIVO: el arbol intacto tiene que dar verde y cumplir los pisos exactos.
    try { real = await det.medir(lib.RAIZ, ctxReal); }
    catch (e) { real = lib.resultado(false, {}, ['EXCEPCION: ' + e.message]); }

    // 2. CONTROL NEGATIVO: con el defecto inyectado, el detector TIENE que ponerse rojo.
    //    Si no lo detecta, el detector es INVALIDO y la suite entera cae, aunque el positivo
    //    haya salido verde: un detector que no sabe fallar no sirve para lo que existe.
    //
    //    CRITICO — la PREPARACION va en su propio try, separada de la MEDICION. Si se mezclan,
    //    un fallo del andamiaje (una copia que revienta, un enlace que no se crea) se contabiliza
    //    como "el detector encontro el defecto" y la suite declara sano un detector que no miro
    //    nada. Ese error exacto ya ocurrio en la primera corrida de esta suite: 13 de 14 controles
    //    negativos "detectaron" porque fs.cpSync se negaba a copiar el repo dentro de si mismo.
    let raizMut = lib.RAIZ, ctxMut = null, prepOk = true, prepErr = '';
    try {
      if (det.mutarDatos) {
        const bdC = lib.copiarBd('C');
        ctxMut = { bd: bdA.destino, bdB: bdC.destino, tmp: lib.TMP };
        await det.mutarDatos(ctxMut);
      } else {
        raizMut = lib.copiarArbol('_' + det.id);
        // Se comprueba que la mutacion CAMBIE algo. Una mutacion anclada al archivo donde un
        // simbolo vivia ayer se aplica a la nada en cuanto el refactor lo mueve: el arbol
        // "defectuoso" queda identico al bueno y el detector, sano, aparece como INVALIDO.
        const antes = lib.huellaArbol(raizMut);
        det.mutar(raizMut);
        if (lib.huellaArbol(raizMut) === antes) {
          throw new Error('la mutacion no cambio NADA del codigo (probablemente esta anclada a un archivo donde el simbolo ya no vive)');
        }
        const bdM = lib.copiarBd('M' + det.id);
        ctxMut = { bd: bdM.destino, bdB: bdM.destino, tmp: lib.TMP };
      }
    } catch (e) { prepOk = false; prepErr = e.message; }

    if (!prepOk) {
      // No se pudo inyectar el defecto: el control negativo NO se ejecuto. Se marca como no
      // detectado a proposito, para que la suite caiga y nadie lo confunda con un exito.
      mutado = lib.resultado(true, {}, ['CONTROL NEGATIVO NO EJECUTABLE: ' + prepErr]);
    } else {
      try { mutado = await det.medir(raizMut, ctxMut); }
      catch (e) {
        // Aqui SI: una excepcion al MEDIR el arbol defectuoso es una deteccion legitima.
        mutado = lib.resultado(false, {}, ['lo detecto lanzando: ' + e.message]);
      }
    }

    registro.anotar(det, real, mutado, det.defecto);
    L((real && real.ok ? 'verde' : 'ROJO') + ' / negativo ' + (mutado && mutado.ok === false ? 'detectado' : 'NO DETECTADO'));
  }

  registro.imprimir();

  // El archivo de produccion no se toco: se demuestra, no se afirma.
  const hashFinal = lib.hashArchivo(bdA.origen);
  const intacta = hashFinal === bdA.hashOrigen;
  console.log('  BD de produccion intacta: ' + (intacta ? 'SI (hash identico antes y despues)' : 'NO — ' + bdA.hashOrigen.slice(0, 12) + ' -> ' + hashFinal.slice(0, 12)));

  const verde = registro.todoVerde && intacta;
  console.log('');
  console.log('='.repeat(96));
  if (registro.invalidos.length) {
    console.log('  DETECTORES INVALIDOS (no supieron fallar con el defecto inyectado): ' + registro.invalidos.join(', '));
  }
  console.log('  ' + (verde ? 'TODO VERDE' : 'HAY ROJOS') +
    '  —  ' + registro.filas.filter(f => f.okReal).length + '/' + registro.filas.length + ' detectores en verde, ' +
    registro.filas.filter(f => f.detectaDefecto).length + '/' + registro.filas.length + ' saben fallar' +
    '  (' + Math.round((Date.now() - t0) / 1000) + 's)');
  console.log('='.repeat(96));
  console.log('');
  return verde ? 0 : 1;
}

principal()
  .then((codigo) => {
    if (!lib.limpiarTmp()) console.log('  (temporales no borrados: ' + lib.TMP + ' — conexiones sqlite aun abiertas)');
    process.exit(codigo);
  })
  .catch((e) => {
    console.error('\n  EXCEPCION NO CONTROLADA: ' + (e && e.stack || e));
    lib.limpiarTmp();
    process.exit(1);
  });
