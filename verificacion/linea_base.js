'use strict';
// verificacion/linea_base.js — Cifras MEDIDAS sobre el arbol intacto, con su procedencia.
//
// Por que existe este archivo: un detector que se queda ciego sigue diciendo que todo esta bien.
// La unica defensa es que cada detector declare de antemano CUANTO tiene que ver y falle si ve
// menos. Los pisos de aqui son de dos clases y no se deben confundir:
//
//   EXACTO_*  -> tiene que coincidir al numero. Si cambia, o el refactor perdio algo o el
//                detector dejo de mirar. Ninguna de las dos es aceptable en silencio.
//   PISO_*    -> cota inferior de VOLUMEN. Existe porque un piso por unidades (">= 10 archivos")
//                se satisface con diez ficheros de 8 bytes; un piso de bytes/lineas, no.
//
// Medido el 2026-08-01 sobre el commit 4db9232 (v5.8.1), arbol limpio.

module.exports = {
  // ─── Frontend: public/index.html ────────────────────────────────────────────
  // wc -l public/index.html
  PISO_INDEX_LINEAS: 8000,
  // El script inline vive entre las etiquetas <script> y </script> SOLAS en su linea.
  // Medido: L254-L8026 = 7771 lineas / 595.875 bytes.
  // Los pisos van al 95% para tolerar el trasiego normal del refactor sin dejar de morder:
  // si el validador se queda mirando solo el bootstrap (~60 bytes) el piso lo mata.
  PISO_FRONTEND_BYTES: 566000,   // 95% de 595.875
  PISO_FRONTEND_LINEAS: 7380,    // 95% de 7.771

  // 67 declaraciones en columna 0 (51 function + 3 async function + 12 const + 1 let)
  // + 1 sentencia de bootstrap (ReactDOM.createRoot(...).render(e(App))) = 68 unidades.
  // Es EXACTO: mover codigo no crea ni destruye simbolos de nivel superior.
  //
  // LAS DOS MITADES DE ESE CONTRATO LAS COMPRUEBAN DETECTORES DISTINTOS, y durante un tiempo solo
  // existio una: F4 y F5 recorren la base y comprueban que cada simbolo siga en el arbol ("no
  // destruye"), pero NINGUNO hacia el camino inverso, asi que un simbolo AÑADIDO o DUPLICADO
  // pasaba invisible ("no crea" no lo implementaba nadie). Peor con las funciones: en scripts
  // clasicos una `function` se puede redeclarar sin error, asi que F2 -que existe para cazar la
  // colision de `const e`- tampoco la ve, y F1 solo tiene cotas INFERIORES de volumen. F6 cierra
  // ese lado contando las declaraciones que hay REALMENTE en el arbol.
  // 69 = 68 declaraciones + el bootstrap. Subio de 68 en v5.9.3 al anadir `avisoTasasBloqueadas`
  // (public/js/avisos.js). Este numero se toca A MANO y a proposito: es el contrato que hace que
  // aparecer un simbolo nuevo sea una decision, no un descuido — regenerar el manifiesto por si solo
  // NO lo mueve, y por eso F4/F6 siguen en rojo hasta que alguien viene aqui.
  EXACTO_SIMBOLOS: 70,
  // Lo que cuenta F6: declaraciones de nivel superior halladas en el arbol, sin el bootstrap (que
  // es una sentencia, no una declaracion; a ese lo cubre F3 EJECUTANDO la carga).
  EXACTO_DECLARACIONES: 69,

  // Tolerancia de tamano POR SIMBOLO. Un refactor que solo MUEVE cumple esto por definicion;
  // un stub, un borrado o una "mejora" colada, no. Son 2 lineas para absorber el ajuste de
  // llaves o un comentario de cabecera al reubicar, nada mas.
  TOLERANCIA_LINEAS_SIMBOLO: 2,

  // ─── Backend ───────────────────────────────────────────────────────────────
  // git ls-files '*.js' | wc -l  ->  43 archivos, 9.077 lineas, 558.891 bytes.
  // El barrido sustituye a la lista escrita a mano: historicamente este proyecto validaba con
  // "node --check (N archivos)" donde N eran los TOCADOS en ese cambio, nunca todos.
  PISO_BACKEND_ARCHIVOS: 43,
  PISO_BACKEND_BYTES: 530000,    // 95% de 558.891
  PISO_BACKEND_LINEAS: 8620,     // 95% de 9.077

  // ─── Contrato HTTP ─────────────────────────────────────────────────────────
  // Recorriendo el stack del router devuelto por createApp.
  // EXACTO: repartir un router no puede perder ni inventar una ruta.
  EXACTO_ENDPOINTS: 84,
  EXACTO_PREFIJOS: 17,
  // Reparto por prefijo, para que un fallo diga DONDE y no solo "faltan rutas".
  ENDPOINTS_POR_PREFIJO: {
    '/api/config': 3, '/api/tarjetas': 8, '/api/personas': 4, '/api/compras': 18,
    '/api/avances': 8, '/api/abonos': 2, '/api/diferidas': 8, '/api/pagos': 4,
    '/api/extractos': 5, '/api/abono-capital': 2, '/api/terceros': 3, '/api/saldos-favor': 6,
    '/api/dashboard': 1, '/api/proyecciones': 1, '/api/calculadora': 1, '/api/ia': 3,
    '/api': 7,
  },

  // ─── Contratos NO-HTTP ─────────────────────────────────────────────────────
  // Lo que un split rompe en silencio: nadie mira estos exports y no hay error de carga.
  // ia.js es el UNICO archivo del backend que cuelga propiedades del factory ya asignado
  // (module.exports = function ... y despues module.exports.detectarX = ...). Si el split
  // deja un re-export tipo module.exports = require('./ia/router'), desaparecen sin ruido.
  CONTRATOS_MODULO: [
    { modulo: 'backend/routes/ia.js', factory: true, props: ['detectarReversos', 'detectarPagosOmitidos'] },
    { modulo: 'backend/config/db.js', factory: false, props: ['DEFAULT_DB_DIR', 'getDbPath', 'getDbConfigPath', 'ensureDir', 'initDb', 'syncData'] },
    { modulo: 'backend/engine/extracto.js', factory: false, props: ['calcExtracto'] },
    { modulo: 'backend/engine/amortizacion.js', factory: false, props: ['calcularAmortizacionAvance', 'calcularAmortizacionDiferida'] },
    { modulo: 'backend/helpers/extractoOficial.js', factory: false, props: ['pagoMinimoOficial', 'minimoEfectivo'] },
    { modulo: 'backend/helpers/cortes.js', factory: false, props: ['getCorteCustom', 'getCortesCustomMap', 'cicloConCorte', 'siguienteCiclo', 'corteDeCiclo'] },
    { modulo: 'backend/services/extracto/motorCruce.js', factory: false, props: ['parseMontoCol', 'normalizarDesc', 'dice', 'fechaCercana', 'parsearTabular', 'parsearFechaDDMM', 'cruzar'] },
    { modulo: 'backend/services/extracto/index.js', factory: false, props: ['getEstrategiaExtracto', 'ESTRATEGIAS', 'estrategiaBase'] },
  ],

  // Aridad de los factories de routes/. Hay TRES variantes incompatibles y 12 de los 17
  // DESTRUCTURAN el segundo argumento en la firma: invocarlos con uno solo lanza TypeError
  // al MONTAR, o sea al arrancar la app entera. Un router escrito copiando la cabecera
  // equivocada revienta en casa del usuario, no en la suite.
  FACTORIES_UN_ARGUMENTO: ['calculadora.js', 'config.js', 'dashboard.js', 'proyecciones.js'],

  // ─── Conciliacion IA ───────────────────────────────────────────────────────
  // Asertos minimos de R7. El handler POST /api/ia/analizar tiene NUEVE bloques deterministas y
  // seis de ellos estan envueltos en su propio try/catch que traga la excepcion: un ReferenceError
  // ahi devuelve 200 con el bloque silenciado. Por eso R7 exige la huella observable de cada uno y
  // este piso impide que el detector se quede corto sin avisar (un escenario no encontrado, un 500
  // que corta la cadena de comprobaciones).
  PISO_ASERTOS_IA: 13,

  // ─── Base de datos ─────────────────────────────────────────────────────────
  // grep -c 'CREATE TABLE IF NOT EXISTS' backend/config/db/schema.js  -> 21
  // (21 desde v6.0.0: se anade creditos_reverso)
  // La BD real tiene 21 = esas 20 + sqlite_sequence (que crea SQLite sola por los AUTOINCREMENT).
  EXACTO_TABLAS: 22,   // +capital_cuotas (v6.4.0: calendario de capital irregular)
  // El sello de sanidad que este proyecto ya usa: sobre una copia intacta, syncData no debe
  // tener nada que corregir. Si devuelve > 0, algo movio datos.
  EXACTO_SYNCDATA_CORRECCIONES: 0,

  // ─── Boot protegido (desktop/main.js, 4 fases) ─────────────────────────────
  // Dos require diferidos A PROPOSITO, que es justo lo que un "ordenar los imports"
  // corrige con toda naturalidad. Al hacerlo, la BD se abre ANTES del chequeo de
  // actualizaciones y se pierde la garantia entera: la app arranca igual y ningun test falla.
  CENTINELA_BOOT: {
    // require('../backend/app') debe aparecer 1 vez y DENTRO de startBackend()
    requireApp: { archivo: 'desktop/main.js', patron: "require('../backend/app')", veces: 1, dentroDe: 'startBackend' },
    // require('better-sqlite3') debe aparecer 1 sola vez en TODO el repo, dentro de initDb()
    requireSqlite: { patron: "require('better-sqlite3')", veces: 1, archivo: 'backend/config/db.js', dentroDe: 'initDb' },
  },

  // ─── Empaquetado ───────────────────────────────────────────────────────────
  // El array "files" de electron-builder es una ALLOWLIST: como declara patrones positivos,
  // el empaquetador NO agrega el "**/*" por defecto. Un archivo nuevo dentro de estas raices
  // entra solo (los globstar cubren cualquier profundidad); una carpeta NUEVA fuera de ellas
  // (src/, shared/, lib/) funciona en desarrollo y desaparece del instalador.
  RAICES_EMPAQUETADAS: ['desktop', 'backend', 'public'],
  // Exclusiones por defecto de electron-builder que muerden a un refactor.
  EXTENSIONES_PROHIBIDAS: ['.d.ts'],

  // ─── Reloj congelado ───────────────────────────────────────────────────────
  // 8 endpoints y el propio motor de amortizacion (calcularAmortizacionAvance y ...Diferida
  // llaman hoyLocal() para derivar saldoActual) leen la fecha de hoy. Sin congelarla, un
  // corpus capturado hoy deja de coincidir manana sin que nadie toque codigo, y ese rojo
  // espurio es indistinguible de una regresion real del refactor.
  FECHA_CONGELADA: '2026-08-01',

  // Ciclos explicitos para los golden masters. Se fijan a mano porque el ciclo vigente se
  // deriva de hoy: dejarlo implicito reintroduce por la puerta de atras la dependencia del
  // reloj que FECHA_CONGELADA acaba de cerrar.
  GOLDEN_TARJETAS: [4, 5],
  GOLDEN_CICLOS: ['2026-06', '2026-07'],
};
