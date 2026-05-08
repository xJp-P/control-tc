// backend/helpers/log.js — Log/audit helper factory (requires DB)

/**
 * Creates logAction and tjNombre helpers bound to a specific DB instance.
 * @param {import('better-sqlite3').Database} db
 */
function createLogHelpers(db) {
  function logAction(accion, descripcion, detalles) {
    try {
      db.prepare('INSERT INTO historial (accion, descripcion, detalles) VALUES (?,?,?)')
        .run(accion, descripcion, detalles || null);
    } catch (e) {
      console.error('logAction error:', e);
    }
  }

  function tjNombre(tarjetaId) {
    if (!tarjetaId) return '';
    const t = db.prepare('SELECT nombre FROM tarjetas WHERE id=?').get(tarjetaId);
    return t ? '[' + t.nombre + '] ' : '';
  }

  return { logAction, tjNombre };
}

module.exports = { createLogHelpers };
