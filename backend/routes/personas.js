// backend/routes/personas.js — CRUD /api/personas
const { Router } = require('express');

module.exports = function(db, { logAction }) {
  const router = Router();

  router.get('/', (req, res) => {
    res.json(db.prepare('SELECT * FROM personas ORDER BY orden, nombre').all());
  });

  router.post('/', (req, res) => {
    const { nombre, color, orden, telefono, notas } = req.body;
    const r = db.prepare('INSERT INTO personas (nombre, color, orden, telefono, notas) VALUES (?,?,?,?,?)')
      .run(nombre, color || '#666', orden || 0, telefono || null, notas || null);
    logAction('crear', 'Persona creada: ' + nombre);
    res.json({ id: r.lastInsertRowid });
  });

  router.put('/:id', (req, res) => {
    const { nombre, color, orden, telefono, notas } = req.body;
    db.prepare('UPDATE personas SET nombre=?, color=?, orden=?, telefono=?, notas=? WHERE id=?')
      .run(nombre, color, orden, telefono, notas, req.params.id);
    logAction('editar', 'Persona editada: ' + nombre);
    res.json({ ok: true });
  });

  router.delete('/:id', (req, res) => {
    const p = db.prepare('SELECT nombre FROM personas WHERE id=?').get(req.params.id);
    db.prepare('DELETE FROM personas WHERE id=?').run(req.params.id);
    logAction('eliminar', 'Persona eliminada: ' + (p ? p.nombre : 'ID ' + req.params.id));
    res.json({ ok: true });
  });

  return router;
};
