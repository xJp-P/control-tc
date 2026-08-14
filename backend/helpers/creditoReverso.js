// backend/helpers/creditoReverso.js
// Créditos por REVERSO de una compra PERSONAL (v5.9.9).
//
// EL PROBLEMA QUE RESUELVE. Hasta v5.9.8 un reverso se modelaba como un atributo de la compra:
// `estado='pagado', monto_abonado=valor_cop`, o sea "esta compra ya está saldada". Eso la neutraliza
// DENTRO de su propio ciclo. Pero el banco no tacha la compra: la factura igual en su ciclo y trata
// el reverso como dinero que ENTRA, imputándolo a la deuda más vieja exigible (el mismo waterfall
// oldest-first que rige los abonos, confirmado con el banco el 7-jul-2026).
//
// Caso real que lo destapó (AMAZON COM #735, $80.554 del 02-ago, reversada días después): el banco
// bajó el pago mínimo exigible de JULIO en esos $80.554, mientras la app los había descontado de
// AGOSTO. El total cuadraba; la distribución por ciclo no. Pagando lo que decía la app se giraban
// $80.554 de más.
//
// EL MODELO. Se separa lo VISUAL de lo CONTABLE:
//   · la compra conserva `reversada=1` y su badge "Reversada" — nunca vuelve a parecer normal —
//     pero su cargo PESA en su ciclo, porque el banco lo va a facturar;
//   · el crédito viaja a un ciclo anterior y reduce lo exigible allí.
// Son los dos renglones que el extracto imprime (un cargo y un reverso que se anulan), no un
// renglón borrado. Si se hicieran las dos cosas —anular la compra Y acreditar el ciclo anterior— se
// descontaría el dinero DOS veces.
//
// ALCANCE: compras PERSONALES. En una compra de tercero el reverso ya tiene su propio circuito
// (saldos_favor_tercero, v4.8.0): el banco devuelve dinero que el tercero ya te había reembolsado,
// así que el crédito es A FAVOR DE ÉL, no tuyo. Ese flujo no se toca.

// Ciclo anterior a uno dado ('2026-08' -> '2026-07'). Aritmética directa año/mes: usar Date con
// meses desbordados es la fuente del bug de fin de mes que este proyecto ya corrigió en v3.3.3.
function cicloAnterior(ciclo) {
  const m = String(ciclo || '').match(/^(\d{4})-(\d{2})$/);
  if (!m) return null;
  const t = (+m[1]) * 12 + (+m[2]) - 1 - 1;      // -1 para pasar a índice 0, -1 para retroceder
  return Math.floor(t / 12) + '-' + String((t % 12) + 1).padStart(2, '0');
}

// Suma de créditos ya imputados a un (tarjeta, ciclo). Es lo que reduce el mínimo exigible de ESE
// ciclo. Tolera una BD anterior a la migración devolviendo 0.
function creditosDeCiclo(db, tarjetaId, ciclo) {
  if (!db || !tarjetaId || !ciclo) return 0;
  try {
    const r = db.prepare("SELECT COALESCE(SUM(monto),0) t FROM creditos_reverso " +
      "WHERE tarjeta_id=? AND ciclo_destino=? AND estado='aplicado'").get(tarjetaId, ciclo);
    return Math.round((r && r.t) || 0);
  } catch (e) { return 0; }
}

// Suma de TODOS los créditos vivos de una tarjeta (o de todas si no se pasa ninguna). Se resta de la
// deuda total: el banco ya devolvió ese dinero, así que revivir el cargo sin restar el crédito
// dejaría la deuda —y por tanto el cupo— inflada exactamente en el monto del reverso.
function creditosDeTarjeta(db, tarjetaId) {
  if (!db) return 0;
  try {
    const sql = "SELECT COALESCE(SUM(monto),0) t FROM creditos_reverso WHERE estado IN ('activo','aplicado')" +
      (tarjetaId ? ' AND tarjeta_id=?' : '');
    const r = tarjetaId ? db.prepare(sql).get(tarjetaId) : db.prepare(sql).get();
    return Math.round((r && r.t) || 0);
  } catch (e) { return 0; }
}

// Elige a qué ciclo imputar un crédito nacido en `cicloOrigen`: el extracto NO sellado más reciente
// ANTERIOR al origen. Se recorre hacia atrás desde el ciclo previo.
//   · Un ciclo con extracto 'pagado' NO se toca: su histórico está sellado y blindado (decisión del
//     PO). Se sigue buscando más atrás por si hubiera uno anterior aún abierto.
//   · Sin destino (todo sellado, o no hay extracto anterior) devuelve null y el crédito queda
//     'activo' a la espera; NUNCA se imputa al propio ciclo de la compra, que es justo el error que
//     este modelo viene a corregir.
function elegirCicloDestino(db, tarjetaId, cicloOrigen, maxAtras) {
  if (!db || !tarjetaId || !cicloOrigen) return null;
  let c = cicloAnterior(cicloOrigen);
  const tope = maxAtras || 24;
  for (let i = 0; i < tope && c; i++) {
    let ext = null;
    try { ext = db.prepare('SELECT estado FROM extractos WHERE tarjeta_id=? AND ciclo=?').get(tarjetaId, c); }
    catch (e) { return null; }
    if (ext && ext.estado !== 'pagado') return c;   // primer ciclo abierto hacia atrás
    c = cicloAnterior(c);
  }
  return null;
}

module.exports = { cicloAnterior, creditosDeCiclo, creditosDeTarjeta, elegirCicloDestino };
