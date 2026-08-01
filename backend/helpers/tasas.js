// Resolución de tasas POR LA FECHA DE LA COMPRA (v5.8.0).
//
// Desde que se puede registrar una compra en un ciclo ya cerrado pero impago (el banco corta el 30 y
// cobra el 15 del mes siguiente: dos semanas de ventana), estampar "la tasa vigente hoy" es
// sencillamente el dato equivocado. La tasa de usura cambia el 1° de cada mes, así que una compra del
// 29 de julio registrada el 2 de agosto nacía con la tasa de agosto.
//
// La app NO tiene una tabla de tasas históricas (la "Fase 2" de tasas_mv sigue en backlog), pero SÍ
// tiene dos fuentes reales de lo que regía en el pasado, y se usan en orden de fidelidad:
//   1. El snapshot ya congelado en otras compras del MISMO (tarjeta, ciclo). Es el mejor dato: cuando
//      ese ciclo se concilió contra el PDF, esa tasa la puso el extracto del banco.
//   2. La serie del scraper en `historial` ('Tasas actualizadas desde la web: <tarjeta>' con
//      'Compras MV: X% | Avances MV: Y%'), que registra con fecha la tasa publicada.
// Ambas se validaron cruzadas sobre la BD real: mayo 2,0849% y junio/julio 2,1285% coinciden al
// dígito entre `compras.tasa_intl` y el historial de la Visa Infinite.
//
// Si ninguna responde, el llamador cae a la tasa vigente de la tarjeta — el comportamiento previo—,
// así que esto nunca empeora respecto a v5.7.x.

const PREFIJO_SCRAPE = 'Tasas actualizadas desde la web: ';

// Extrae la tasa de avances del texto que escribe el scraper: 'Compras MV: 2.1285% | Avances MV: 2.1285%'
function parseDetallesTasa(detalles) {
  if (!detalles) return null;
  const m = /Avances MV:\s*([\d]+[.,]?[\d]*)\s*%/i.exec(detalles);
  if (!m) return null;
  const pct = parseFloat(String(m[1]).replace(',', '.'));
  if (!isFinite(pct) || pct <= 0) return null;
  const tasa = pct / 100;
  // Cordura: una MV mensual real vive muy por debajo de 1 (2,1285% -> 0.021285).
  return (tasa > 0 && tasa < 1) ? tasa : null;
}

// Tasa que otras compras ya tienen congelada, buscando por el MES CALENDARIO de la fecha — no por el
// ciclo. La distinción importa: la usura cambia el 1° de cada mes y un ciclo NO coincide con un mes
// (con corte 30, el ciclo 2026-08 arranca el 31-jul), así que resolver "por ciclo" le pegaría a una
// compra del 31 de julio la tasa de agosto. Por eso se cruza mes con mes, y el ciclo solo acota a
// compras contables del mismo periodo de facturación cuando coincide.
// Si dentro del mes hay varias tasas distintas gana la más frecuente. `excluirCompraId` evita que una
// compra se resuelva a sí misma.
function tasaDeCompraDelCiclo(db, tarjetaId, ciclo, fecha, excluirCompraId) {
  if (!fecha) return null;
  const mes = String(fecha).slice(0, 7);
  const row = db.prepare(
    `SELECT tasa_intl, COUNT(*) n FROM compras
      WHERE tarjeta_id = ? AND strftime('%Y-%m', fecha) = ? AND tasa_intl IS NOT NULL
        AND id <> COALESCE(?, -1)
      GROUP BY tasa_intl ORDER BY n DESC, tasa_intl DESC LIMIT 1`
  ).get(tarjetaId, mes, excluirCompraId != null ? excluirCompraId : null);
  return row && row.tasa_intl != null ? row.tasa_intl : null;
}

// Último scrape registrado en o antes de la fecha de la compra, para ESA tarjeta.
// `historial.fecha` es el instante en que se CONSULTÓ la web, no la vigencia de la tasa, así que el
// último scrape anterior a la compra puede ser del mes pasado y traer la tasa vieja. Por eso se exige
// que el scrape sea del MISMO MES CALENDARIO que la compra: dentro del mes la tasa no cambia, y si no
// hay ninguno se devuelve null para caer al fallback en vez de afirmar un número dudoso.
function tasaDeHistorial(db, tarjetaId, fecha) {
  if (!fecha) return null;
  const tj = db.prepare('SELECT nombre FROM tarjetas WHERE id=?').get(tarjetaId);
  if (!tj || !tj.nombre) return null;
  const row = db.prepare(
    `SELECT detalles FROM historial
      WHERE descripcion = ? AND date(fecha) <= date(?) AND strftime('%Y-%m', fecha) = ?
      ORDER BY fecha DESC LIMIT 1`
  ).get(PREFIJO_SCRAPE + tj.nombre, fecha, String(fecha).slice(0, 7));
  return row ? parseDetallesTasa(row.detalles) : null;
}

// Resuelve la tasa internacional que regía cuando se hizo la compra.
// Devuelve { tasa, fuente } — `fuente` sirve para explicarle al usuario de dónde salió el número.
// tasa === null significa "no se pudo determinar": el llamador decide el fallback.
function tasaIntlEnFecha(db, tarjetaId, ciclo, fecha, excluirCompraId) {
  const delCiclo = tasaDeCompraDelCiclo(db, tarjetaId, ciclo, fecha, excluirCompraId);
  if (delCiclo != null) return { tasa: delCiclo, fuente: 'otras compras del mismo mes' };
  const delHist = tasaDeHistorial(db, tarjetaId, fecha);
  if (delHist != null) return { tasa: delHist, fuente: 'tasa publicada en la fecha de la compra' };
  return { tasa: null, fuente: null };
}

module.exports = { tasaIntlEnFecha, tasaDeCompraDelCiclo, tasaDeHistorial, parseDetallesTasa };
