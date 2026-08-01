'use strict';
// backend/routes/compras.js — Factory del router de compras.
//
// Solo compone: crea el router, arma el contexto y llama a los sub-modulos EN EL MISMO
// ORDEN en que las rutas estaban declaradas. El orden importa porque es el que Express usa
// para emparejar, y mantenerlo hace que este reparto sea invisible desde fuera.
//
// LA FIRMA NO CAMBIA. app.js invoca este factory con (db, ctx) y 12 de los 17 routers
// destructuran ese segundo argumento en su firma: alterarlo revienta al MONTAR, o sea al
// arrancar la app entera.
const { Router } = require('express');
const crearCompartido = require('./compras/_compartido');
const lectura = require('./compras/lectura.js');
const crud = require('./compras/crud.js');
const bolsillo = require('./compras/bolsillo.js');
const division = require('./compras/division.js');
const eliminar = require('./compras/eliminar.js');
const cuotas = require('./compras/cuotas.js');
const conciliacion = require('./compras/conciliacion.js');

module.exports = function(db, { logAction, tjNombre }) {
  const router = Router();
  const compartido = crearCompartido(db, logAction, tjNombre);
  const ctx = Object.assign({ db, logAction, tjNombre }, compartido);

  // El orden de estas llamadas ES el orden de registro de las rutas.
  lectura(router, ctx);
  crud(router, ctx);
  bolsillo(router, ctx);
  division(router, ctx);
  eliminar(router, ctx);
  cuotas(router, ctx);
  conciliacion(router, ctx);

  return router;
};
