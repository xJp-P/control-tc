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

// Tasa publicada ESE MES, tomada del último scrape del mes para ESA tarjeta.
// `historial.fecha` es el instante en que se CONSULTÓ la web, no la vigencia de la tasa, así que un
// scrape de otro mes traería la tasa vieja. Por eso se exige el MISMO MES CALENDARIO.
//
// Ya NO se exige además que el scrape sea anterior a la compra (v5.9.4). Era una restricción de más y
// hacía daño: la premisa de todo este helper es que **dentro del mes la tasa no cambia**, así que un
// scrape del día 3 describe igual de bien una compra del día 1. Con el filtro anterior, las compras
// del 1 y 2 de agosto quedaban sin fuente —el primer scrape bueno del mes fue el día 3— y caían al
// fallback obsoleto. Se toma el ÚLTIMO del mes, no el más cercano: si el banco aún no había publicado
// la tasa nueva cuando se consultó el día 1, la lectura posterior es la que refleja el valor asentado.
function tasaDeHistorial(db, tarjetaId, fecha) {
  if (!fecha) return null;
  const tj = db.prepare('SELECT nombre FROM tarjetas WHERE id=?').get(tarjetaId);
  if (!tj || !tj.nombre) return null;
  const row = db.prepare(
    `SELECT detalles FROM historial
      WHERE descripcion = ? AND strftime('%Y-%m', fecha) = ?
      ORDER BY fecha DESC LIMIT 1`
  ).get(PREFIJO_SCRAPE + tj.nombre, String(fecha).slice(0, 7));
  return row ? parseDetallesTasa(row.detalles) : null;
}

// Resuelve la tasa internacional que regía cuando se hizo la compra.
// Devuelve { tasa, fuente } — `fuente` sirve para explicarle al usuario de dónde salió el número.
// tasa === null significa "no se pudo determinar": el llamador decide el fallback.
// ORDEN INVERTIDO en v5.9.4: manda el scrape, y las compras vecinas quedan de respaldo.
//
// El orden anterior (vecinas primero) partía de que su snapshot venía del extracto conciliado. Pero
// el snapshot NO guarda de dónde salió: lo escribe igual la conciliación —dato del banco— que el
// POST de una compra cuando resuelve por fallback. Cuando el fallback está mal, la primera compra del
// mes siembra el error y TODAS las siguientes lo copian como si fuera un hecho. Pasó de verdad: con
// el scraper roto (ver v5.9.3), las tres compras de agosto nacieron con la tasa de julio y se la
// habrían pasado a todo agosto, mientras el dato correcto ya estaba guardado en `historial`.
//
// El scrape, en cambio, es una observación FECHADA y de origen verificable: "el día X el banco
// publicaba Y". Por eso va primero.
//
// Comprobado sobre la BD real antes de invertirlo: en los meses donde existen las dos fuentes
// (2026-05, 06 y 07) coinciden al dígito, así que el cambio NO altera ningún mes del pasado — solo
// desempata el único donde discrepaban (2026-08: vecinas 2,1285% eco del fallo, historial 2,1852%).
//
// Lo que se pierde: si un extracto conciliado revelara una tasa distinta de la publicada, una compra
// NUEVA de ese mes tomaría la publicada. Es aceptable — la conciliación reescribe los snapshots de
// las compras afectadas directamente (acción `actualizar_tasa_intl`), así que ese dato no se pierde
// donde importa, y el mismo análisis vuelve a detectarlo en el ciclo siguiente.
function tasaIntlEnFecha(db, tarjetaId, ciclo, fecha, excluirCompraId) {
  const delHist = tasaDeHistorial(db, tarjetaId, fecha);
  if (delHist != null) return { tasa: delHist, fuente: 'tasa publicada ese mes' };
  const delCiclo = tasaDeCompraDelCiclo(db, tarjetaId, ciclo, fecha, excluirCompraId);
  if (delCiclo != null) return { tasa: delCiclo, fuente: 'otras compras del mismo mes' };
  return { tasa: null, fuente: null };
}

module.exports = { tasaIntlEnFecha, tasaDeCompraDelCiclo, tasaDeHistorial, parseDetallesTasa };
