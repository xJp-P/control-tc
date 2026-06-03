// backend/services/movimientos.js
// Arma el JSON de movimientos de un ciclo para que la IA lo contraste con el extracto.
// Reutiliza calcExtracto (único punto de verdad) y resuelve el doc de reglas del banco.
const path = require('path');
const fs = require('fs');
const { calcExtracto } = require('../engine/extracto');

// Mapea banco + franquicia (texto libre en la BD) al archivo docs/bancos/{Banco}_{Franquicia}.md
// Archivos existentes: Bancolombia_{Visa,Mastercard,Amex}, Nu_Mastercard, RappiCard_Visa.
function resolveBancoDoc(banco, franquicia) {
  const b = String(banco || '').toLowerCase();
  const f = String(franquicia || '').toLowerCase();
  if (b.includes('bancolombia')) {
    if (f.includes('visa')) return 'Bancolombia_Visa';
    if (f.includes('master')) return 'Bancolombia_Mastercard';
    if (f.includes('amex') || f.includes('american')) return 'Bancolombia_Amex';
    return null;
  }
  if (b.includes('nu')) return 'Nu_Mastercard';
  if (b.includes('rappi') || b.includes('davivienda')) return 'RappiCard_Visa';
  return null;
}

function docPathDe(nombre) {
  if (!nombre) return null;
  return path.join(__dirname, '..', '..', 'docs', 'bancos', nombre + '.md');
}

// Devuelve el objeto de movimientos del ciclo (sin tocar la BD).
function construirMovimientos(db, tarjetaId, ciclo) {
  const tj = db.prepare('SELECT * FROM tarjetas WHERE id=?').get(tarjetaId);
  if (!tj) return { error: 'Tarjeta no encontrada' };

  const calc = calcExtracto(db, tarjetaId, ciclo, false);
  const docNombre = resolveBancoDoc(tj.banco, tj.franquicia);
  const dPath = docPathDe(docNombre);
  const docExiste = dPath ? fs.existsSync(dPath) : false;

  return {
    tarjeta: {
      id: tj.id, nombre: tj.nombre, banco: tj.banco, franquicia: tj.franquicia || null,
      dia_corte: tj.dia_corte, dia_pago: tj.dia_pago
    },
    ciclo,
    fecha_corte: calc ? calc.fechaCorte : null,
    fecha_pago: calc ? calc.fechaPago : null,
    pago_minimo_app: calc ? calc.pagoMinimo : null,
    pago_total_app: calc ? calc.pagoTotal : null,
    intereses_intl: calc ? calc.interesesComprasIntl : 0,
    dual: calc ? !!calc.dualExtracto : false,
    compras: calc ? calc.detalleCompras : [],
    diferidas: calc ? calc.detalleDiferidas : [],
    avances: calc ? calc.detalleAvances : [],
    compras_usd: calc ? calc.detalleComprasUsd : [],
    pago_minimo_usd: calc ? calc.pagoMinimoUsd : 0,
    banco_doc: docNombre,
    banco_doc_existe: docExiste
  };
}

// Lee el contenido del .md de reglas del banco (para la Fase 3 / análisis). Puede ser null.
function leerBancoDoc(nombre) {
  const dPath = docPathDe(nombre);
  if (!dPath || !fs.existsSync(dPath)) return null;
  try { return fs.readFileSync(dPath, 'utf8'); } catch (_) { return null; }
}

module.exports = { construirMovimientos, resolveBancoDoc, leerBancoDoc };
