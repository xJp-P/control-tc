'use strict';
// backend/routes/diferidas.js — Factory del router de diferidas.
//
// Solo compone: crea el router, arma el contexto y llama a los sub-modulos EN EL MISMO
// ORDEN en que las rutas estaban declaradas. El orden importa porque es el que Express usa
// para emparejar, y mantenerlo hace que este reparto sea invisible desde fuera.
//
// LA FIRMA NO CAMBIA. app.js invoca este factory con (db, ctx) y 12 de los 17 routers
// destructuran ese segundo argumento en su firma: alterarlo revienta al MONTAR, o sea al
// arrancar la app entera.
const { Router } = require('express');
const crearCompartido = require('./diferidas/_compartido');
const lectura = require('./diferidas/lectura.js');
const escritura = require('./diferidas/escritura.js');

module.exports = function(db, { logAction, tjNombre }) {
  const router = Router();
  const compartido = crearCompartido(db, logAction, tjNombre);
  const ctx = Object.assign({ db, logAction, tjNombre }, compartido);

  // El orden de estas llamadas ES el orden de registro de las rutas.
  lectura(router, ctx);
  escritura(router, ctx);

  return router;
};
