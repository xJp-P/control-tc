// backend/routes/ia/_detectores.js
//
// Los bloques DETERMINISTAS de la conciliacion que no dependen del router ni del ctx: los dos
// detectores movidos VERBATIM desde ia.js (reversos y pagos omitidos) y, desde la Fase C (oct-2026),
// lo que el codigo sabe y no se le deja a la IA: la severidad por monto, el cargo de intereses contra
// el desglose de la app y las fechas corridas junto al corte. El factory de ia.js vuelve a colgar los
// dos detectores de module.exports porque son exports del backend pensados para pruebas.
const { parseMontoCol, dice, normalizarDesc } = require('../../services/extracto/motorCruce');
const { calcExtracto } = require('../../engine/extracto');
const { addMonths } = require('../../helpers/dates');

// ── Detección determinista de REVERSOS (devoluciones/refunds) ──────────────────
// Un reverso aparece en el extracto como un movimiento de valor NEGATIVO cuyo concepto es un
// COMERCIO (no "ABONO"/"PAGO"), con el nombre ACORTADO por el banco (ej. "LATAM AIR" por
// "LATAM AIRLINES COLOM"). Se cruza contra el HISTORIAL de la tarjeta por monto (valor absoluto,
// ±$2) + descripción difusa (Dice ≥ 0.4). Devuelve discrepancias tipo 'reverso_detectado' con
// accion_sugerida.operacion='reversar_compra' (o 'ninguna' + ya_aplicado si la compra ya está
// reversada -> idempotencia). Alcance v1: compras de 1 cuota en COP (las que el endpoint reversa).
// `lineasBanco` (OPCIONAL): mismos movimientos negativos aplanados por la estrategia del banco que
// consume detectarPagosOmitidos. Sin ese argumento se parsea el texto crudo, como siempre. Los dos
// detectores REPARTEN esas líneas a partir de UNA sola definición de pago (esConceptoDePago), así que
// cada línea la procesa uno solo: aquí se descartan las de PAGO/ABONO y allí se descartan las demás.

// Concepto de una línea NEGATIVA que es un PAGO del usuario (o un ajuste a su favor), no el reverso de
// un comercio. Las etiquetas reales de pago EMPIEZAN por ABONO o PAGO ("ABONO SUCURSAL VIRTUAL",
// "PAGO PSE", "PAGO ATH", "PAGOS RAPPIPAY APP") o dicen "SU PAGO" / "A FAVOR". Antes bastaba con que
// PAGO apareciera EN CUALQUIER PARTE, y el reverso de un comercio de Mercado Pago ("MERCADO
// PAGO*<comercio>") se descartaba en silencio como si fuera un pago (conciliación de sep-2026;
// "MERCADOPAGO" junto sí pasaba). La comparten los DOS detectores: es lo que sostiene el reparto.
function esConceptoDePago(c) {
  const t = String(c || '').trim();
  return /^(ABONOS?|PAGOS?)\b/i.test(t) || /\b(SU PAGO|SALDO A FAVOR|A FAVOR)\b/i.test(t);
}

function detectarReversos(db, texto, tarjetaId, lineasBanco) {
  if (!texto || !tarjetaId) return [];
  const fmt = (n) => '$' + Math.round(n).toLocaleString('es-CO');
  // + "NU": las líneas de Nu no son reversos de comercio (el detector de pagos no las toma).
  const esPago = (c) => esConceptoDePago(c) || /\bNU\b/i.test(c);
  // Líneas con valor NEGATIVO en pesos: [auth] DD/MM/YYYY  CONCEPTO  $ -NNN.NNN,NN
  const reNeg = /(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(.+?)\s+\$\s*-\s*([\d][\d.]*(?:,\d{1,2})?)/;
  const candidatos = [];
  const admitir = (concepto, monto) => {
    const c = String(concepto || '').replace(/\s{2,}/g, ' ').trim();
    if (!c || c.length < 3 || esPago(c)) return;
    if (!/[A-Za-zÁÉÍÓÚÑ]{3,}/.test(c)) return;  // debe tener texto de comercio, no solo números
    const m = Number(monto);
    if (!(m > 0)) return;
    candidatos.push({ concepto: c, monto: m });
  };
  if (Array.isArray(lineasBanco) && lineasBanco.length) {
    lineasBanco.forEach(l => admitir(l && l.concepto, l && l.monto));
  } else {
    String(texto).split(/\r?\n/).forEach(raw => {
      const m = raw.trim().match(reNeg);
      if (m) admitir(m[2], parseMontoCol(m[3]));
    });
  }
  if (!candidatos.length) return [];
  // Historial de compras EJECUTABLES por el endpoint de reverso (1 cuota, COP, sin grupo/diferida).
  const compras = db.prepare(
    "SELECT id, descripcion, valor_cop, fecha, ciclo, persona_id, COALESCE(monto_bolsillo,0) AS monto_bolsillo, COALESCE(reversada,0) AS reversada " +
    "FROM compras WHERE tarjeta_id=? AND grupo_id IS NULL AND diferida_id IS NULL AND estado != 'diferida' AND COALESCE(valor_cop,0) > 0"
  ).all(tarjetaId);
  const usados = {}, out = [];
  candidatos.forEach(cand => {
    let best = null;
    compras.forEach(c => {
      if (usados[c.id]) return;
      if (Math.abs(Math.round(c.valor_cop) - Math.round(cand.monto)) > 2) return;   // monto exacto (±$2)
      const score = dice(normalizarDesc(cand.concepto), normalizarDesc(c.descripcion)); // difuso: banco acorta
      if (score < 0.4) return;
      if (!best || score > best.score) best = { c, score };
    });
    if (!best) return;
    usados[best.c.id] = 1;
    const c = best.c;
    const esTercero = c.persona_id != null;
    out.push({
      tipo: 'reverso_detectado',
      descripcion: 'El banco reversó "' + cand.concepto + '" por ' + fmt(cand.monto) + '. Coincide con la compra #' + c.id + ' "' + c.descripcion + '"' + (esTercero ? ' (de un tercero que ya reembolsó)' : '') + '.',
      valor_extracto: -Math.round(cand.monto),
      valor_app: Math.round(c.valor_cop),
      compra_id: c.id,
      severidad: 'alta',
      ya_aplicado: !!c.reversada,
      reverso: {
        concepto_extracto: cand.concepto, monto: Math.round(cand.monto),
        compra_descripcion: c.descripcion, es_tercero: esTercero,
        reembolso: esTercero ? Math.round(c.monto_bolsillo) : 0, score: Math.round(best.score * 100) / 100
      },
      accion_sugerida: c.reversada
        ? { operacion: 'ninguna', parametros: {} }
        : { operacion: 'reversar_compra', parametros: { compra_id: c.id } }
    });
  });
  return out;
}

// ── Detección determinista de PAGOS-DE-FACTURA omitidos ────────────────────────
// Un "ABONO SUCURSAL VIRTUAL" (negativo) suele ser el pago que saldó el extracto ANTERIOR (regla 1).
// Este detector reconoce esas líneas (mismo parser que reversos, pero quedándose con los conceptos de
// PAGO/ABONO en vez de excluirlos) y las clasifica de forma DETERMINISTA: si el monto de una línea —o
// la suma de varias líneas fraccionadas— cuadra (~1%) con el pago mínimo o el pago total que la app
// calcula para el ciclo anterior, es un PAGO-DE-FACTURA; si ese extracto aún NO está registrado en la
// app, propone la acción registrar_pago (marca ese ciclo como pagado vía POST /extractos/registrar-pago).
// La tolerancia es ~1% (no ±$2) porque el mínimo/total que calcula la app diverge del real del banco por
// el interés revolvente no modelado (ver "Limitaciones Conocidas"): 1% cubre esa divergencia (~0,7%
// observada) y aún separa limpiamente un abono-a-capital, que es un orden de magnitud menor. Los pagos
// que NO cuadran (abonos a capital, remanentes, parciales) NO se auto-registran: quedan informativos en
// "pagos_detectados" por la ambigüedad de "liquidación dirigida" (documentada). Alcance v1: COP.
// `lineasBanco` (OPCIONAL) son los movimientos negativos que la estrategia del banco ya aplanó, con la
// fecha normalizada a ISO — hoy solo RappiCard, vía estrategia.parsearNegativos. Sin ese argumento el
// detector parsea el texto crudo, que es lo que siempre hizo (Bancolombia y el resto, sin cambio).
// Hacía falta porque `reNeg` exige la fecha en DD/MM/YYYY y RappiCard la imprime en ISO: ahí la regex
// no casaba NUNCA y los pagos de esa tarjeta no tenían cruce determinista.
function detectarPagosOmitidos(db, texto, tarjetaId, ciclo, lineasBanco) {
  if (!texto || !tarjetaId || !ciclo) return [];
  const fmt = (n) => '$' + Math.round(n).toLocaleString('es-CO');
  // Conceptos de PAGO/ABONO (subconjunto del esPago de reversos, SIN "NU"): las líneas que toma este
  // detector son justo las que reversos excluye → ninguna línea la procesan ambos.
  // PLURALES: el `\b` de cierre hacía que "\bPAGO\b" NO matcheara "PAGOS RAPPIPAY APP" (el concepto real
  // de RappiCard/Davivienda), así que esa línea se caía de los DOS detectores y rompía el invariante de
  // arriba (el de reversos sí la matchea: su regex no lleva `\b` final, así que casa por prefijo).
  // La MISMA definición que usa detectarReversos (esConceptoDePago): antes cada uno tenía su regex y
  // el reparto dependía de mantenerlas sincronizadas a mano.
  const esPago = esConceptoDePago;
  const reNeg = /(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(.+?)\s+\$\s*-\s*([\d][\d.]*(?:,\d{1,2})?)/;
  const aISO = (s) => { const m = String(s).match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); if (!m) return null; let y = m[3]; if (y.length === 2) y = '20' + y; return y + '-' + String(m[2]).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0'); };
  const lineas = [];
  if (Array.isArray(lineasBanco) && lineasBanco.length) {
    // Se aplica el MISMO filtro esPago que a las líneas crudas: es lo que sostiene el reparto con
    // detectarReversos (cada línea la procesa uno solo de los dos). Un reverso de comercio que llegue
    // por aquí no lleva ABONO/PAGO en el concepto y queda fuera, igual que en la rama cruda.
    lineasBanco.forEach(l => {
      const concepto = String((l && l.concepto) || '').replace(/\s{2,}/g, ' ').trim();
      const monto = Math.round(Number(l && l.monto) || 0);
      if (!concepto || !esPago(concepto) || !(monto > 0)) return;
      lineas.push({ concepto, monto, fecha: (l && l.fecha) || null });
    });
  } else {
    String(texto).split(/\r?\n/).forEach(raw => {
      const linea = raw.trim();
      const m = linea.match(reNeg);
      if (!m) return;
      const concepto = m[2].replace(/\s{2,}/g, ' ').trim();
      if (!concepto || !esPago(concepto)) return;
      const monto = parseMontoCol(m[3]);
      if (!(monto > 0)) return;
      lineas.push({ concepto, monto: Math.round(monto), fecha: aISO(m[1]) });
    });
  }
  if (!lineas.length) return [];

  // Ciclo anterior: el pago del extracto se aplica al mes previo (regla 1).
  const cicloPrev = addMonths(ciclo + '-01', -1).slice(0, 7);
  const extPrev = db.prepare('SELECT id, estado, COALESCE(monto_pagado,0) mp FROM extractos WHERE tarjeta_id=? AND ciclo=?').get(tarjetaId, cicloPrev);
  // Si el extracto anterior ya está pagado o tiene algún abono registrado, el pago YA está reflejado en
  // la app → nada que proponer (evita duplicar el pago del usuario). Belt-and-suspenders con el endpoint.
  if (extPrev && (extPrev.estado === 'pagado' || extPrev.mp > 0)) return [];
  const pagosReg = db.prepare("SELECT 1 FROM pagos WHERE tarjeta_id=? AND ciclo=? AND tipo='abono_extracto' AND (moneda='COP' OR moneda IS NULL) LIMIT 1").get(tarjetaId, cicloPrev);
  if (pagosReg) return []; // ya hay un pago de factura registrado para ese ciclo

  let pmPrev = 0, ptPrev = 0;
  try { const calc = calcExtracto(db, tarjetaId, cicloPrev, false); if (calc) { pmPrev = Math.round(calc.pagoMinimo || 0); ptPrev = Math.round(calc.pagoTotal || 0); } } catch (e) { return []; }
  if (!(pmPrev > 0) && !(ptPrev > 0)) return [];

  const cuadra = (monto, ancla) => ancla > 0 && Math.abs(monto - ancla) <= Math.max(5, Math.round(ancla * 0.01));
  const clasif = (monto) => cuadra(monto, ptPrev) ? 'total' : (cuadra(monto, pmPrev) ? 'minimo' : null);
  const mkDisc = (monto, fecha, tipoPago, descripcion) => ({
    tipo: 'pago_omitido',
    descripcion,
    severidad: 'media',
    pago: { ciclo: cicloPrev, monto, tipo_pago: tipoPago, fecha: fecha || null },
    accion_sugerida: { operacion: 'registrar_pago', parametros: { tarjeta_id: tarjetaId, ciclo: cicloPrev, monto, fecha: fecha || null, moneda: 'COP' } }
  });
  const txt = (monto, tipoPago, concepto) => 'El extracto muestra un pago de ' + fmt(monto) + ' ("' + concepto + '") que salda el extracto del ciclo ' + cicloPrev + ' (' + (tipoPago === 'total' ? 'pago total' : 'pago minimo') + '). La app aun no lo tiene registrado.';

  // Caso 1: una línea individual cuadra con el mínimo o el total.
  const matched = lineas.map(l => ({ l, tp: clasif(l.monto) })).filter(x => x.tp);
  if (matched.length) {
    return matched.map(x => mkDisc(x.l.monto, x.l.fecha, x.tp, txt(x.l.monto, x.tp, x.l.concepto)));
  }
  // Caso 2: pago fraccionado — ninguna línea cuadra sola, pero la SUMA sí (ej. mínimo pagado en varios abonos).
  if (lineas.length >= 2) {
    const suma = lineas.reduce((s, l) => s + l.monto, 0);
    const tp = clasif(suma);
    if (tp) {
      const fecha = lineas[lineas.length - 1].fecha;
      return [mkDisc(suma, fecha, tp, 'El extracto muestra ' + lineas.length + ' abonos que suman ' + fmt(suma) + ' y saldan el extracto del ciclo ' + cicloPrev + ' (' + (tp === 'total' ? 'pago total' : 'pago minimo') + '). La app aun no lo tiene registrado.')];
    }
  }
  return [];
}

// ── SEVERIDAD por monto (escala del director, oct-2026) ─────────────────────────────────────────────
// La IA calificaba a ojo: en la conciliacion de septiembre-2026 una diferencia de intereses de decenas de
// miles de pesos salio como BAJA. La severidad de una discrepancia que mueve plata la decide su impacto en el pago
// minimo, no el modelo: mas de ALTA -> alta; desde MEDIA hasta ALTA -> media; por debajo -> baja.
const UMBRAL_SEVERIDAD_ALTA = 20000;
const UMBRAL_SEVERIDAD_MEDIA = 2000;
function severidadPorMonto(monto) {
  const a = Math.abs(Number(monto) || 0);
  if (a > UMBRAL_SEVERIDAD_ALTA) return 'alta';
  if (a >= UMBRAL_SEVERIDAD_MEDIA) return 'media';
  return 'baja';
}
// Recalcula la severidad de toda discrepancia con impacto en dinero y deja la de la IA en `severidad_ia`
// cuando no coincide. Las que no mueven el pago minimo (fechas, cifra oficial, reversos) conservan la
// suya, y un posible falso positivo sigue en baja: ahi la severidad dice "dudoso", no "cuanto".
function calibrarSeveridad(discrepancias) {
  let cambiadas = 0;
  (discrepancias || []).forEach(d => {
    if (!d || d.posible_falso_positivo) return;
    const imp = Number(d.impacto_pago_minimo);
    if (!isFinite(imp) || imp === 0) return;
    const s = severidadPorMonto(imp);
    if (d.severidad !== s) { d.severidad_ia = d.severidad || null; d.severidad = s; cambiadas++; }
  });
  return cambiadas;
}

// ── El cargo INTERESES CORRIENTES contra el DESGLOSE de la app ───────────────────────────────────────
// La cifra del banco la lee la estrategia (parsearIntereses) y la de la app viene con su desglose por
// causa (services/movimientos.js). Con las dos, la diferencia y su severidad son aritmetica: no se le
// dejan al modelo, que en septiembre-2026 la atribuyo a "revolving" y la califico baja. Reemplaza el
// item de intereses que haya armado la IA (el que trae la cifra del banco como valor_extracto y no
// propone ninguna accion): nunca toca una discrepancia accionable.
function conciliarIntereses(resu, mv, interesBanco) {
  const dg = mv && mv.desglose_intereses;
  if (!(Number(interesBanco) >= 0) || !dg || !Array.isArray(resu.discrepancias)) return null;
  const fmt = (n) => '$' + Math.round(n).toLocaleString('es-CO');
  const banco = Math.round(Number(interesBanco) * 100) / 100;
  const app = Number(dg.total_app) || 0;
  const impacto = Math.round(app - banco);          // + la app cobra de MAS que el banco, - de MENOS
  const antes = resu.discrepancias.length;
  resu.discrepancias = resu.discrepancias.filter(d => {
    if (!d || d.valor_extracto == null || Math.abs(Number(d.valor_extracto) - banco) > 2) return true;
    const op = d.accion_sugerida && d.accion_sugerida.operacion;
    return !!(op && op !== 'ninguna');
  });
  const reemplazadas = antes - resu.discrepancias.length;
  const c = dg.componentes || {};
  const fp = dg.cuota_facturada;
  const partes = [
    ['periodo', c.periodo], ['cuota facturada hasta el pago' + (fp && fp.devenga_hasta ? ' (' + fp.devenga_hasta + ')' : ''), c.cuota_facturada_hasta_pago],
    ['interes diferido de cuotas 1', c.interes_cuota1_diferido], ['arrastre de reprogramaciones', c.arrastre_reprogramacion],
    ['ultima cuota de planes terminados', c.cola_ultima_cuota], ['intl de compras 1/1', c.intl_compras_1_1],
  ].filter(p => Math.round(Number(p[1]) || 0) !== 0).map(p => p[0] + ' ' + fmt(p[1]));
  let lectura;
  if (Math.abs(impacto) < UMBRAL_SEVERIDAD_MEDIA) lectura = 'La diferencia (' + fmt(Math.abs(impacto)) + ') esta dentro del margen del modelo.';
  else {
    lectura = 'Quedan ' + fmt(Math.abs(impacto)) + (impacto < 0 ? ' que el banco cobra de mas' : ' que la app cobra de mas') + ' sin causa identificada por la app.';
    const abonos = (fp && Array.isArray(fp.abonos_al_extracto_anterior)) ? fp.abonos_al_extracto_anterior.filter(a => fp.devenga_hasta && a.fecha < fp.devenga_hasta) : [];
    if (abonos.length && impacto > 0) lectura += ' El extracto anterior tuvo abonos antes del ' + fp.devenga_hasta + ': si el banco descuenta la cuota facturada el dia de cada abono, cobra menos (sin medir todavia).';
    const desfase = dg.intl_desfase ? Math.abs((dg.intl_desfase.de_este_ciclo_segun_app || 0) - (dg.intl_desfase.del_ciclo_anterior || 0)) : 0;
    if (desfase > 0 && Math.abs(impacto) <= desfase + 1) lectura += ' Es del tamano del desfase del intl entre ciclos.';
  }
  const item = {
    tipo: 'intereses_corrientes',
    descripcion: 'El extracto cobra ' + fmt(banco) + ' de intereses corrientes y la app ' + fmt(app) + (partes.length ? ' (' + partes.join(' + ') + ')' : '') + '. ' + lectura,
    valor_extracto: banco, valor_app: app, impacto_pago_minimo: impacto,
    severidad: severidadPorMonto(impacto), compra_id: null, desglose: c,
    accion_sugerida: { operacion: 'ninguna', parametros: {} },
  };
  resu.discrepancias.push(item);
  return { extracto: banco, app, diferencia: Math.round(banco - app), reemplazo_ia: reemplazadas };
}

// ── Compras con la FECHA CORRIDA junto al corte ─────────────────────────────────────────────────────
// Que la app y el banco difieran en un dia en la fecha de una compra es inocuo... salvo en el borde
// del corte, que es justo donde un dia la cambia de mes (hubo un caso real en jul-2026).
// Se avisa solo ahi, para no llenar la lista de ruido. Informativo: no hay nada que aplicar.
function detectarFechasCorridas(cruce, fechaCorte) {
  if (!cruce || !fechaCorte) return [];
  const dias = (a, b) => Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000);
  const out = [];
  (cruce.matches || []).forEach(m => {
    if (!m || (m.tipo && m.tipo !== 'compra') || !m.fecha_app || m.dia_extracto == null || m.mes_extracto == null) return;
    const fa = String(m.fecha_app).slice(0, 10);
    const mesA = Number(fa.slice(5, 7)), mesE = Number(m.mes_extracto);
    let y = Number(fa.slice(0, 4));
    if (mesA === 1 && mesE === 12) y -= 1; else if (mesA === 12 && mesE === 1) y += 1;
    const fe = y + '-' + String(mesE).padStart(2, '0') + '-' + String(Number(m.dia_extracto)).padStart(2, '0');
    const d = dias(fa, fe);
    if (!d || Math.abs(d) > 2) return;
    const aCorte = Math.min(dias(fa, fechaCorte), dias(fe, fechaCorte));
    if (aCorte < 0 || aCorte > 2) return;
    out.push({
      tipo: 'fecha_corrida',
      descripcion: 'Compra "' + (m.descripcion_app || ('#' + m.compra_id)) + '": la app la tiene el ' + fa + ' y el banco el ' + fe + ', a ' + aCorte
        + ' dia(s) del corte (' + fechaCorte + '). Hoy cuadra, pero en el borde del corte un dia la cambia de mes: confirma la fecha.',
      severidad: 'baja', compra_id: m.compra_id, fecha_app: fa, fecha_extracto: fe,
      accion_sugerida: { operacion: 'ninguna', parametros: {} },
    });
  });
  return out;
}

module.exports = { detectarReversos, detectarPagosOmitidos, severidadPorMonto, calibrarSeveridad, conciliarIntereses, detectarFechasCorridas,
  UMBRAL_SEVERIDAD_ALTA, UMBRAL_SEVERIDAD_MEDIA };
