// backend/routes/ia.js — /api/ia (Asistente de Conciliación de Extractos)
//
// Solo compone: crea el router, arma el contexto y llama a los sub-modulos EN EL MISMO ORDEN en
// que las rutas estaban declaradas. El orden importa porque es el que Express usa para emparejar.
//
// LA FIRMA NO CAMBIA: app.js lo invoca con (db, ctx) y este es el unico de los 17 routers que
// recibe el segundo argumento sin destructurarlo en la firma, y el unico consumidor de readIaKey.
const { Router } = require('express');
const { detectarReversos, detectarPagosOmitidos } = require('./ia/_detectores');
const extraer = require('./ia/extraer.js');
const movimientos = require('./ia/movimientos.js');
const analizar = require('./ia/analizar.js');

module.exports = function(db, ctx) {
  const router = Router();
  const { readIaKey } = ctx || {};
  const ctxSub = { db, readIaKey };

  // El orden de estas llamadas ES el orden de registro de las rutas.
  extraer(router, ctxSub);
  movimientos(router, ctxSub);
  analizar(router, ctxSub);

  return router;
};

// Export auxiliar para pruebas unitarias de los detectores deterministas (no afecta el factory).
module.exports.detectarReversos = detectarReversos;
module.exports.detectarPagosOmitidos = detectarPagosOmitidos;
