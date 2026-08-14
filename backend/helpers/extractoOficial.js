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
const { creditosDeCiclo } = require('./creditoReverso');

function pagoMinimoOficial(db, tarjetaId, ciclo) {
  if (!db || !tarjetaId || !ciclo) return null;
  try {
    const r = db.prepare('SELECT pago_minimo FROM extractos_oficiales WHERE tarjeta_id=? AND ciclo=?')
      .get(tarjetaId, ciclo);
    return (r && r.pago_minimo > 0) ? r.pago_minimo : null;
  } catch (e) { return null; }   // BD anterior a la migración: cae al calculado
}

// Devuelve la cifra oficial si existe; si no, el valor calculado que se le pase. Después descuenta
// los créditos por reverso imputados a ESE ciclo (v5.9.9): el banco los aplica a la deuda más vieja
// exigible, así que rebajan lo que hay que pagar para cerrar el mes. Va aquí, en el punto único, para
// que el sellado, el GET de extractos y las tres cards del dashboard lo hereden a la vez — sin esto,
// la app pediría de más y el ciclo no llegaría a sellar nunca.
function minimoEfectivo(db, tarjetaId, ciclo, calculado) {
  const of = pagoMinimoOficial(db, tarjetaId, ciclo);
  const base = of != null ? of : calculado;
  const credito = creditosDeCiclo(db, tarjetaId, ciclo);
  if (!credito) return base;
  return Math.max(0, Math.round((base || 0) - credito));
}

module.exports = { pagoMinimoOficial, minimoEfectivo };
