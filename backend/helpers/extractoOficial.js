// backend/helpers/extractoOficial.js
// Punto ÚNICO para resolver el pago mínimo que el usuario realmente debe pagar (v5.7.0).
//
// El motor de la app NO puede calcular el mínimo al peso: el banco cobra además interés sobre la
// cuota ya facturada hasta el día en que el usuario PAGA — información del futuro al proyectar
// (probado contra 10 extractos de RappiCard, ver docs/bancos/RappiCard_Visa.md §4.3.1/§4.3.2). Por eso,
// cuando se concilia un PDF se guarda la cifra impresa en `extractos_oficiales` y ESA manda.
//
// Existe como helper porque la resolución hace falta en TRES sitios que antes divergían (el GET de
// extractos, el sellado del pago y el dashboard): sin punto único, la próxima card que se agregue
// vuelve a mostrar el estimado mientras el resto muestra el oficial.
function pagoMinimoOficial(db, tarjetaId, ciclo) {
  if (!db || !tarjetaId || !ciclo) return null;
  try {
    const r = db.prepare('SELECT pago_minimo FROM extractos_oficiales WHERE tarjeta_id=? AND ciclo=?')
      .get(tarjetaId, ciclo);
    return (r && r.pago_minimo > 0) ? r.pago_minimo : null;
  } catch (e) { return null; }   // BD anterior a la migración: cae al calculado
}

// Devuelve la cifra oficial si existe; si no, el valor calculado que se le pase.
function minimoEfectivo(db, tarjetaId, ciclo, calculado) {
  const of = pagoMinimoOficial(db, tarjetaId, ciclo);
  return of != null ? of : calculado;
}

module.exports = { pagoMinimoOficial, minimoEfectivo };
