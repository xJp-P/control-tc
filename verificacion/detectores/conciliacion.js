'use strict';
// verificacion/detectores/conciliacion.js — R7
//
// POR QUE EXISTE: hasta ahora NINGUN detector ejecutaba el cuerpo de POST /api/ia/analizar, el
// handler mas grande del backend (~480 lineas). R1 instancia el router de ia pero no invoca la
// ruta; R4 solo hace GET; R6 escribe, pero sobre extractos y compras. El cuerpo del handler
// simplemente no se ejecutaba nunca.
//
// El modo de fallo que esto deja pasar es CONCRETO y ya ocurrio una vez en este refactor: al
// repartir un archivo en sub-modulos, un simbolo se queda usado pero SIN IMPORTAR. No lo ve B1
// (la sintaxis es valida), no lo ve B2 (un require que falta no es una arista rota, es una arista
// que no existe), no lo ve R1 (instanciar el router no ejecuta sus handlers) y no lo ve R2 (mira
// los exports). En la Etapa 4 ese mismo fallo dio un HTTP 500 al registrar un pago y lo cazo R6
// nada mas que porque R6 ejercita escrituras. Para /api/ia no habia equivalente.
//
// Y NO BASTA CON COMPROBAR QUE RESPONDE 200: seis de los nueve bloques deterministas del handler
// estan envueltos en su propio try/catch que traga la excepcion con un console.log y deja el
// analisis continuar. Un ReferenceError dentro de cualquiera de ellos devuelve 200 con el bloque
// SILENCIADO. Por eso cada aserto de aqui exige la HUELLA OBSERVABLE del bloque en la respuesta.
//
// Se usa el proveedor 'mock', que devuelve un resultado sintetico sin red ni API key
// (backend/services/aiProvider.js: `if (provider === 'mock') return {...}`), asi que la suite no
// depende de internet, de credenciales ni de gastar tokens.

const fs = require('fs');
const path = require('path');
const { resultado, leer, pedir, conApp } = require('../lib');
const B = require('../linea_base');

// ─── Texto de extracto sintetico ────────────────────────────────────────────
// Se fabrica a partir de los movimientos REALES del ciclo, en el formato tabular que el motor de
// cruce sabe parsear (DD/MM  DESCRIPCION  $MONTO). No se usa ningun PDF del usuario: el objetivo
// es ejercitar el camino de codigo, no validar la conciliacion de un extracto concreto.
const dd = (iso) => { const p = String(iso).slice(0, 10).split('-'); return p[2] + '/' + p[1]; };
const cop = (n) => '$' + Math.round(n).toLocaleString('es-CO');

function textoSintetico(mv, compraReverso, montoAbono) {
  // Encabezado con etiqueta e importe en lineas separadas: es lo que lee `parsearResumen` de las
  // estrategias que saben extraer la cifra oficial del pago minimo (bloque 6).
  const pmOficial = Math.round((mv.pago_minimo_app || 100000) * 1.03);
  const ls = [
    'EXTRACTO SINTETICO - SUITE DE VERIFICACION', '',
    'Pago mínimo', '$' + pmOficial.toLocaleString('es-CO') + ',00',
    'Pago total', '$' + Math.round(pmOficial * 2).toLocaleString('es-CO') + ',00', '',
  ];
  (mv.compras || []).slice(0, 8).forEach(c => {
    ls.push(dd(c.fecha) + '  ' + String(c.descripcion || 'X').slice(0, 22) + '   ' + cop(c.total) + '   1/1   0,0000%');
  });
  (mv.diferidas || []).slice(0, 4).forEach(d => {
    ls.push(dd(d.fecha) + '  ' + String(d.etiqueta || 'X').slice(0, 22) + '   ' + cop(d.capital) + '   2/12   2,1285%');
  });
  // Linea NEGATIVA de comercio -> reverso (bloque 7).
  if (compraReverso) {
    ls.push('15/07/2026  ' + compraReverso.descripcion + '   $ -' +
      Math.round(compraReverso.valor_cop).toLocaleString('es-CO') + ',00');
  }
  // Linea NEGATIVA de ABONO que cuadra con el minimo del ciclo anterior -> pago omitido (bloque 8).
  if (montoAbono > 0) {
    ls.push('10/07/2026  ABONO SUCURSAL VIRTUAL   $ -' + Math.round(montoAbono).toLocaleString('es-CO') + ',00');
  }
  return { texto: ls.join('\n'), pmOficial };
}

const cicloMenosUno = (c) => {
  const [y, m] = String(c).split('-').map(Number);
  return (m === 1 ? y - 1 : y) + '-' + String(m === 1 ? 12 : m - 1).padStart(2, '0');
};

const R7 = {
  id: 'R7',
  nombre: 'Ejecucion real de POST /api/ia/analizar (huella de cada bloque)',
  async medir(raiz) {
    const notas = [];
    let ok = 0, total = 0;
    const chk = (nombre, cond, detalle) => {
      total++;
      if (cond) ok++;
      else notas.push('FALLO [' + nombre + ']: ' + detalle);
    };

    // Los escenarios se ELIGEN de la BD, no se escriben a mano: un (tarjeta, ciclo) fijo caduca en
    // cuanto el usuario paga un extracto, y ese rojo espurio es indistinguible de una regresion.
    // Si no se encuentra escenario, es FALLO explicito, nunca una omision silenciosa.
    function elegirEscenarios(db) {
      const conCompras = (tj, ciclo) => {
        const r = db.prepare("SELECT COUNT(*) n FROM compras WHERE tarjeta_id=? AND ciclo=? AND estado != 'diferida'").get(tj, ciclo);
        return (r && r.n) || 0;
      };
      // (A) Ciclo con compras INTERNACIONALES: el mock devuelve una tasa ~3% menor a la registrada,
      //     asi que el bloque 3 tiene que emitir tasa_intl_incorrecta.
      const intl = db.prepare(
        "SELECT tarjeta_id, ciclo, COUNT(*) n FROM compras " +
        "WHERE es_internacional=1 AND estado != 'diferida' AND COALESCE(valor_cop,0) > 0 " +
        "GROUP BY tarjeta_id, ciclo HAVING n >= 1 ORDER BY n DESC, ciclo DESC LIMIT 1").get();
      // (B) Ciclo cuyo ANTERIOR sigue impago: es la precondicion de detectarPagosOmitidos (si ya
      //     esta pagado, el detector devuelve [] por dedup y el bloque 8 no dejaria huella).
      let previoImpago = null;
      const pend = db.prepare(
        "SELECT tarjeta_id, ciclo FROM extractos WHERE estado != 'pagado' AND COALESCE(monto_pagado,0)=0 " +
        "ORDER BY ciclo ASC").all();
      for (const p of pend) {
        const yaPago = db.prepare("SELECT 1 FROM pagos WHERE tarjeta_id=? AND ciclo=? AND tipo='abono_extracto' LIMIT 1").get(p.tarjeta_id, p.ciclo);
        if (yaPago) continue;
        const [y, m] = p.ciclo.split('-').map(Number);          // el ciclo A CONCILIAR es el siguiente
        const sig = (m === 12 ? y + 1 : y) + '-' + String(m === 12 ? 1 : m + 1).padStart(2, '0');
        if (conCompras(p.tarjeta_id, sig) < 1) continue;         // hace falta al menos una compra
        previoImpago = { tarjeta_id: p.tarjeta_id, ciclo: sig };
        break;
      }
      return { intl, previoImpago };
    }

    // Ejecuta un escenario completo y devuelve el `resultado` del handler.
    async function correr(port, db, tj, ciclo) {
      const rm = await pedir(port, 'GET', '/api/ia/movimientos?tarjeta_id=' + tj + '&ciclo=' + ciclo, null, 20000);
      if (rm.s !== 200 || !rm.j) return { error: 'GET /movimientos -> ' + rm.s + ' ' + rm.b.slice(0, 120) };
      const mv = rm.j;
      const cRev = db.prepare(
        "SELECT id, descripcion, valor_cop FROM compras WHERE tarjeta_id=? AND grupo_id IS NULL " +
        "AND diferida_id IS NULL AND estado != 'diferida' AND COALESCE(valor_cop,0) > 1000 " +
        "AND COALESCE(reversada,0)=0 ORDER BY id DESC LIMIT 1").get(tj);
      // El monto del abono se toma del minimo que la app calcula para el ciclo anterior: es la
      // referencia contra la que detectarPagosOmitidos cuadra la linea (tolerancia ~1%).
      const { calcExtracto } = require(path.join(raiz, 'backend', 'engine', 'extracto.js'));
      let pmPrev = 0;
      try { const c = calcExtracto(db, tj, cicloMenosUno(ciclo), false); pmPrev = Math.round((c && c.pagoMinimo) || 0); } catch (e) {}
      const { texto, pmOficial } = textoSintetico(mv, cRev, pmPrev);
      const r = await pedir(port, 'POST', '/api/ia/analizar',
        { provider: 'mock', movimientos: mv, texto_redactado: texto }, 30000);
      return { r, mv, cRev, pmPrev, pmOficial };
    }

    let esc = null;
    try {
      await conApp(raiz, 'IA0', async (port, db) => { esc = elegirEscenarios(db); });
    } catch (e) { chk('seleccion de escenarios', false, 'excepcion: ' + e.message); }

    // ── Escenario A: ciclo con compras internacionales ───────────────────────
    // Ejercita el tramo pre-IA completo (construirMovimientos, getEstrategiaExtracto, cruzar,
    // construirPrompt, analizarIA) y los bloques 1-5, 7 y 9.
    if (!esc || !esc.intl) {
      chk('escenario A disponible', false, 'no se encontro ningun ciclo con compras internacionales en la BD');
    } else {
      try {
        await conApp(raiz, 'IA1', async (port, db) => {
          const { r, cRev } = await correr(port, db, esc.intl.tarjeta_id, esc.intl.ciclo);
          const donde = ' (tarjeta ' + esc.intl.tarjeta_id + ', ciclo ' + esc.intl.ciclo + ')';
          if (!r) { chk('escenario A' + donde, false, 'no se pudo preparar'); return; }
          chk('POST /analizar responde 200' + donde, r.s === 200, 'status=' + r.s + ' ' + String(r.b).slice(0, 160));
          const R = (r.j && r.j.resultado) || null;
          if (!R) { chk('el handler devuelve un resultado' + donde, false, 'sin resultado en la respuesta'); return; }
          const tipos = (R.discrepancias || []).map(d => d.tipo);

          // Tramo pre-IA: si `construirPrompt` o `analizarIA` faltaran, ni se llegaria aqui (no hay
          // try/catch que los tape: el fallo seria un 500, que el aserto de arriba ya caza).
          chk('conciliacion_pago_minimo presente' + donde, !!R.conciliacion_pago_minimo, 'falta el bloque de conciliacion');

          // Bloque 9 (transparencia del cruce): prueba que `cruzar` corrio y encontro matches. Si
          // devolviera 0 conciliadas, el motor no estaria viendo el texto y media docena de asertos
          // de abajo pasarian a ser vacios.
          chk('bloque 9: cruce determinista con matches' + donde,
            !!(R.cruce_determinista && R.cruce_determinista.conciliadas > 0),
            'conciliadas=' + (R.cruce_determinista && R.cruce_determinista.conciliadas));

          // Bloque 3 (tasa intl): usa cruce.matches + la tabla tarjetas. El mock siempre devuelve una
          // tasa distinta a la registrada, asi que con compras intl en el ciclo TIENE que emitirla.
          chk('bloque 3: tasa_intl_incorrecta' + donde, tipos.indexOf('tasa_intl_incorrecta') !== -1,
            'no se emitio; tipos=' + JSON.stringify(tipos));

          // Bloque 4 (refuerzo del cruce): descarta el monto_erroneo del mock porque su compra SI
          // cruzo 1:1 contra el extracto. Su huella es el contador de omitidas.
          chk('bloque 4: descarta la discrepancia de una compra ya conciliada' + donde,
            Number(R.discrepancias_omitidas) > 0, 'discrepancias_omitidas=' + R.discrepancias_omitidas);

          // Bloque 5 (fechas): el mock devuelve corte -1 dia y pago -2 dias.
          chk('bloque 5: fecha_pago_movida' + donde, tipos.indexOf('fecha_pago_movida') !== -1, 'tipos=' + JSON.stringify(tipos));
          chk('bloque 5: corte_desfasado' + donde, tipos.indexOf('corte_desfasado') !== -1, 'tipos=' + JSON.stringify(tipos));

          // Bloque 7 (reversos): detectarReversos cruza la linea negativa contra el historial.
          // Es el bloque que usa parseMontoCol + dice + normalizarDesc.
          chk('bloque 7: reverso detectado' + donde, Number(R.reversos_detectados) > 0,
            'reversos_detectados=' + R.reversos_detectados + ' (linea sembrada para la compra #' + (cRev && cRev.id) + ')');
          chk('bloque 7: la discrepancia apunta a la compra sembrada' + donde,
            !!(cRev && (R.discrepancias || []).some(d => d.tipo === 'reverso_detectado' && Number(d.compra_id) === Number(cRev.id))),
            'ninguna discrepancia reverso_detectado con compra_id=' + (cRev && cRev.id));
        });
      } catch (e) { chk('escenario A', false, 'excepcion: ' + e.message); }
    }

    // ── Escenario B: ciclo cuyo anterior sigue impago ────────────────────────
    // Es el unico contexto donde el bloque 8 puede dejar huella, y de paso ejercita el bloque 6
    // cuando la estrategia del banco sabe leer la cifra oficial del pago minimo.
    if (!esc || !esc.previoImpago) {
      chk('escenario B disponible', false, 'no se encontro ningun ciclo cuyo anterior siga impago y sin abono registrado');
    } else {
      try {
        await conApp(raiz, 'IA2', async (port, db) => {
          const { tarjeta_id, ciclo } = esc.previoImpago;
          const { r, pmPrev, pmOficial } = await correr(port, db, tarjeta_id, ciclo);
          const donde = ' (tarjeta ' + tarjeta_id + ', ciclo ' + ciclo + ')';
          if (!r) { chk('escenario B' + donde, false, 'no se pudo preparar'); return; }
          chk('POST /analizar responde 200' + donde, r.s === 200, 'status=' + r.s + ' ' + String(r.b).slice(0, 160));
          const R = (r.j && r.j.resultado) || null;
          if (!R) { chk('el handler devuelve un resultado' + donde, false, 'sin resultado'); return; }
          const tipos = (R.discrepancias || []).map(d => d.tipo);

          // Bloque 8 (pagos omitidos): usa calcExtracto y addMonths, que NINGUN otro bloque usa. Es
          // el aserto que caza un require perdido al repartir los detectores en otro archivo.
          chk('bloque 8: pago omitido detectado' + donde, Number(R.pagos_omitidos_detectados) > 0,
            'pagos_omitidos_detectados=' + R.pagos_omitidos_detectados + ' (se sembro un abono de ' + pmPrev + ')');
          chk('bloque 8: la discrepancia apunta al ciclo anterior' + donde,
            (R.discrepancias || []).some(d => d.tipo === 'pago_omitido' && d.pago && d.pago.ciclo === cicloMenosUno(ciclo)),
            'ninguna discrepancia pago_omitido para el ciclo ' + cicloMenosUno(ciclo));

          // Bloque 6 (cifra oficial del pago minimo): solo lo puede emitir una estrategia con
          // parsearResumen. Si esta tarjeta no la tiene, el aserto se convierte en su contrario
          // -exigir que NO aparezca- para que nunca quede como un caso sin comprobar.
          const estrategiaLee = !!R.pago_minimo_oficial;
          if (estrategiaLee) {
            chk('bloque 6: lee la cifra oficial del encabezado' + donde,
              Math.abs(Number(R.pago_minimo_oficial.valor) - pmOficial) < 1,
              'leyo ' + JSON.stringify(R.pago_minimo_oficial) + ' y se sembro ' + pmOficial);
          } else {
            chk('bloque 6: sin parsearResumen no inventa cifra oficial' + donde,
              R.pago_minimo_oficial == null && tipos.indexOf('pago_minimo_oficial') === -1,
              'la estrategia no lee resumenes pero aparecio una cifra oficial');
          }
        });
      } catch (e) { chk('escenario B', false, 'excepcion: ' + e.message); }
    }

    // Piso: si el numero de asertos ejecutados cae, el detector se quedo corto (un escenario que no
    // se encontro, un handler que devolvio 500 y corto la cadena de comprobaciones).
    if (total < B.PISO_ASERTOS_IA) {
      notas.push('FALLO: solo se ejecutaron ' + total + ' asertos, piso ' + B.PISO_ASERTOS_IA + ' -> el detector dejo de mirar');
    }
    return resultado(ok === total && total >= B.PISO_ASERTOS_IA, { asertos: total, ok, fallidos: total - ok }, notas);
  },

  defecto: 'se rompe el import de addMonths en el archivo que define detectarPagosOmitidos (el bloque 8 queda silenciado por su try/catch y el handler sigue respondiendo 200)',
  mutar(raiz) {
    // La mutacion busca su objetivo POR CONTENIDO dentro de backend/routes, no anclada a ia.js:
    // este detector nace justo antes del reparto de ese archivo, asi que anclarla al nombre seria
    // dejarla apuntando a un archivo que manana no contiene el simbolo.
    //
    // Se elige addMonths a proposito: es el simbolo que SOLO usa detectarPagosOmitidos, dentro de un
    // bloque envuelto en try/catch. El handler sigue devolviendo 200 y el bloque desaparece en
    // silencio — exactamente el fallo mudo que este detector existe para cazar.
    const base = path.join(raiz, 'backend', 'routes');
    const pendientes = [base];
    while (pendientes.length) {
      const d = pendientes.pop();
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { pendientes.push(p); continue; }
        if (!e.name.endsWith('.js')) continue;
        const src = leer(p);
        if (src.indexOf('function detectarPagosOmitidos') === -1) continue;
        if (src.indexOf('{ addMonths }') === -1) {
          throw new Error('el archivo que define detectarPagosOmitidos ya no importa addMonths con la forma esperada');
        }
        // `addMonths` queda sin declarar: al usarlo lanza ReferenceError dentro del try del bloque 8.
        fs.writeFileSync(p, src.replace('{ addMonths }', '{ addMonths: __noImportado }'), 'utf8');
        return;
      }
    }
    throw new Error('no se encontro detectarPagosOmitidos en ningun archivo de backend/routes');
  },
};

module.exports = [R7];
