// backend/routes/ia/analizar.js
//
// Ruta movida VERBATIM desde ia.js, ENTERA. Su cuerpo tiene nueve bloques deterministas que
// comparten un unico acumulador (el objeto `resu` que devuelve la IA) y estan acoplados POR
// ORDEN: `discrepancias_omitidas` se ASIGNA en el filtro de ruido y se ACUMULA en el refuerzo
// del cruce; el dedupe `yaMover` lee lo que dejaron los bloques anteriores; y el filtro de
// redundancia barre los mover_ciclo que la cascada acaba de empujar. Partirlo obligaria a
// inventar una firma que hoy no existe y a convertir ese orden en un contrato tacito que nada
// verifica, que es el mismo motivo por el que dashboard.js no se reparte.
const { construirMovimientos, leerBancoDoc } = require('../../services/movimientos');
const { analizar: analizarIA } = require('../../services/aiProvider');
const { cruzar, dice, normalizarDesc } = require('../../services/extracto/motorCruce');
const { getEstrategiaExtracto } = require('../../services/extracto');
const { construirPrompt } = require('./_prompt');
const { detectarReversos, detectarPagosOmitidos } = require('./_detectores');

module.exports = function(router, ctx) {
  const { db, readIaKey } = ctx;

  // POST /api/ia/analizar
  // Body: { provider, model, texto_redactado, movimientos }
  // Carga el doc de reglas del banco, arma el prompt y llama al proveedor. La API key se
  // descifra aquí (readIaKey inyectada por main); NUNCA llega desde el frontend.
  router.post('/analizar', async (req, res) => {
    try {
      const { provider, model, texto_redactado, movimientos, contexto_usuario } = req.body || {};
      const prov = provider || 'mock';
      if (!movimientos) return res.status(400).json({ error: 'Faltan los movimientos a conciliar.' });
      if (prov !== 'mock' && !texto_redactado) return res.status(400).json({ error: 'Falta el texto del extracto.' });

      const key = (prov === 'mock') ? null : (readIaKey ? readIaKey() : null);
      if (prov !== 'mock' && !key) {
        return res.status(400).json({ error: 'No hay API key configurada. Guardala en Configuracion o usa el modo Demo.' });
      }

      // Refrescar los movimientos desde la BD: NO confiar en el caché que mandó el frontend. Si el
      // usuario editó compras (ej. agregó una nota personal o cambió un valor) después de extraer el
      // PDF, esos cambios deben reflejarse en el análisis. El texto del extracto sí viene del frontend
      // (no se puede re-derivar sin el PDF), pero los datos de la app se leen frescos de la BD.
      let mv = movimientos;
      if (movimientos.tarjeta && movimientos.tarjeta.id && movimientos.ciclo) {
        const fresh = construirMovimientos(db, movimientos.tarjeta.id, movimientos.ciclo);
        if (fresh && !fresh.error) mv = fresh;
      }

      const bancoDoc = mv.banco_doc ? leerBancoDoc(mv.banco_doc) : null;
      // Estrategia por banco/franquicia (Patrón Estrategia): define cómo parsear el extracto y qué
      // reglas específicas añadir al prompt. Cae a la estrategia genérica si el banco no tiene una propia.
      const estrategia = getEstrategiaExtracto(mv.tarjeta && mv.tarjeta.banco, mv.tarjeta && mv.tarjeta.franquicia);
      // Capa 1 — cruce determinista exacto (sin IA): empareja compras app<->extracto por
      // monto + fecha (+/-1) + descripcion, con pool. Alimenta el prompt y filtra falsos positivos.
      // Compras agrupadas por moneda: COP (mv.compras) y USD (mv.compras_usd, tarjetas duales). Para
      // tarjetas no duales el grupo USD va vacio y el cruce queda mono-moneda (comportamiento intacto).
      // Normaliza las CUOTAS del ciclo (diferidas y avances) al contrato del motor para que tambien
      // se crucen contra el extracto. Se emparejan por su CAPITAL (campo_monto='capital'): el banco
      // imprime el capital de la cuota en la linea y unifica los intereses en un bloque aparte, asi
      // que su `total` (capital+interes) nunca cuadraria con la linea. `tipo` marca el origen para que
      // la cascada de corte_desfasado (exclusiva de compras de 1 cuota) las ignore. Son montos en COP.
      const cuotasDif = ((mv && mv.diferidas) || []).map((d, i) => ({
        id: (d.compra_id != null ? d.compra_id : ('dif_' + i)),
        descripcion: d.etiqueta, fecha: d.fecha, capital: d.capital,
        campo_monto: 'capital', tipo: 'diferida'
      }));
      const cuotasAv = ((mv && mv.avances) || []).map((a, i) => ({
        id: 'av_' + i,
        descripcion: a.etiqueta, fecha: a.fecha, capital: a.capital,
        campo_monto: 'capital', tipo: 'avance'
      }));
      const cruce = cruzar(texto_redactado, {
        COP: [...((mv && mv.compras) || []), ...cuotasDif, ...cuotasAv],
        USD: (mv && mv.compras_usd) || []
      }, estrategia);
      const { system, user } = construirPrompt(mv, texto_redactado, bancoDoc, contexto_usuario, cruce, estrategia);

      console.log('[IA] Iniciando analisis. Proveedor: ' + prov + ', Modelo: ' + (model || '(default del proveedor)'));
      let r;
      try {
        r = await analizarIA({ provider: prov, model, key, system, user, mockContexto: { movimientos: mv } });
      } catch (err) {
        const tipo = err && err.tipo;
        const code = (tipo === 'sin_key') ? 400 : (tipo === 'timeout') ? 504 : ((err && err.status) || 502);
        return res.status(code).json({ error: (err && err.message) ? err.message : 'Error al consultar la IA.' });
      }

      if (!r || !r.resultado || !r.resultado.conciliacion_pago_minimo) {
        return res.status(502).json({ error: 'La IA respondio en un formato inesperado. Intenta de nuevo.' });
      }
      // Filtro determinista del "ruido" que la IA lista aunque se le pida ignorarlo:
      // diferencias de redondeo y compras divididas cuya suma coincide. Si los montos
      // coinciden al redondear a pesos enteros, no hay error real de monto ni de omision.
      // (No se filtran clasificacion_incorrecta/cuota_reprogramada: ahi el monto puede
      // coincidir y aun ser una discrepancia valida.)
      const resu = r.resultado;
      if (Array.isArray(resu.discrepancias)) {
        const antes = resu.discrepancias.length;
        resu.discrepancias = resu.discrepancias.filter(d => {
          if (d && (d.tipo === 'monto_erroneo' || d.tipo === 'compra_omitida') && d.valor_extracto != null && d.valor_app != null) {
            // Diferencia <= $2: redondeo (incluye el acumulado de varias cuotas/divisiones). No es error real.
            if (Math.abs(Number(d.valor_extracto) - Number(d.valor_app)) <= 2) return false;
          }
          return true;
        });
        const om = antes - resu.discrepancias.length;
        if (om > 0) resu.discrepancias_omitidas = om;
        // Marca posibles falsos positivos de clasificacion: si la app YA tiene una compra del
        // mismo monto con la clasificacion reclamada, la IA probablemente cruzo la compra
        // equivocada (dos compras del mismo monto). No se oculta: se anota + adjunta candidatas.
        const comprasMv = (mv && Array.isArray(mv.compras)) ? mv.compras : [];
        resu.discrepancias.forEach(d => {
          if (d && d.tipo === 'clasificacion_incorrecta' && d.valor_extracto != null) {
            const monto = Math.round(Number(d.valor_extracto));
            const cands = comprasMv.filter(c => Math.round(Number(c.total)) === monto);
            if (cands.length && cands.some(c => c.es_internacional || Number(c.interes_intl) > 0)) {
              d.posible_falso_positivo = true;
              d.severidad = 'baja';
              d.candidatas = cands.map(c => ({ id: c.id, descripcion: c.descripcion, es_internacional: !!c.es_internacional, interes_intl: c.interes_intl || 0, total: c.total }));
            }
          }
        });
      }
      // ── Guard anti-DUPLICADO de 'diferida_omitida' (candado determinista) ──────────────────────────
      // crear_diferida_omitida solo debe crear una diferida 100% inexistente. Si la app YA tiene una
      // diferida (misma descripcion difusa + capital de cuota ±$2) o una compra del mismo comercio cuyo
      // total cuadra con la cuota o con capital×M, la propuesta es un FALSO POSITIVO (seria un duplicado):
      // ese caso es monto_erroneo / convertir_a_diferida / reprogramar_cuotas. Se descarta aunque el LLM
      // la haya propuesto → nunca se crea un duplicado por esta via.
      if (Array.isArray(resu.discrepancias) && mv && mv.tarjeta && mv.tarjeta.id) {
        // Candado ROBUSTO: consulta TODAS las diferidas de la tarjeta (activas Y liquidadas, de CUALQUIER
        // ciclo) — no solo las cuotas del ciclo conciliado — para no dejar pasar un duplicado de una
        // diferida ya existente que este liquidada o cuya cuota de este mes quedo bucketeada en un ciclo
        // vecino (corte adelantado / mover_ciclo). comprasMv2 (compras del ciclo) cubre las compras sueltas.
        const difsCard = db.prepare("SELECT etiqueta, monto, num_cuotas FROM diferidas WHERE tarjeta_id=? AND estado IN ('activo','liquidado')").all(mv.tarjeta.id);
        const comprasMv2 = (mv && Array.isArray(mv.compras)) ? mv.compras : [];
        let descartadasDup = 0;
        resu.discrepancias = resu.discrepancias.filter(d => {
          if (!d || d.tipo !== 'diferida_omitida') return true;
          const p = (d.accion_sugerida && d.accion_sugerida.parametros) || {};
          const desc = normalizarDesc(String(p.descripcion || d.descripcion || ''));
          const capP = Number(p.capital);
          if (!desc || !(capP > 0)) return true; // sin datos para verificar → se deja (el endpoint valida)
          const M2 = Number(p.num_cuotas) || 1;
          const total = Math.round(capP * M2); // valor total que tendria la diferida propuesta
          // Duplicado si ya existe una diferida del mismo comercio (Dice≥0.55) cuyo monto TOTAL cuadra
          // (== capital×M) o cuya cuota (monto/num_cuotas) cuadra con el capital de la linea (±$2).
          const dupDif = difsCard.some(x => dice(normalizarDesc(String(x.etiqueta || '')), desc) >= 0.55 &&
            (Math.abs(Number(x.monto) - total) <= 2 || (x.num_cuotas > 0 && Math.abs(Number(x.monto) / x.num_cuotas - capP) <= 2)));
          // O una compra del mismo comercio cuyo TOTAL == el total de la diferida propuesta (es el MISMO
          // movimiento ya registrado → seria convertir_a_diferida, no un duplicado). NO se compara contra
          // el capital de UNA cuota (rama debil): descartaria una diferida nueva legitima de un comercio
          // recurrente cuyo valor por cuota coincida con una compra suelta del mismo comercio.
          const dupCompra = comprasMv2.some(x => Math.abs(Number(x.total) - total) <= 2 && dice(normalizarDesc(String(x.descripcion || '')), desc) >= 0.55);
          if (dupDif || dupCompra) { descartadasDup++; return false; }
          return true;
        });
        if (descartadasDup > 0) resu.diferidas_omitidas_descartadas = descartadasDup;
      }
      // ── Discrepancia de TASA INTERNACIONAL (cruce determinista, MULTI-MES / split del día 1°) ──
      // La Tasa de Usura cambia el 1° de cada mes: un ciclo que abarca dos meses puede traer DOS tasas.
      // Fuente de verdad por compra: la tasa que el MOTOR capturó en su línea del extracto
      // (cruce.matches[].tasa_extracto). Fallback: el mapa mes->tasa de la IA (resu.tasas_intl_extracto,
      // o el escalar viejo resu.tasa_intl_extracto por compatibilidad). Si ninguna fuente da una tasa
      // válida para una compra, se omite. Se agrupa por tasa objetivo → una sola acción con varios grupos.
      try {
        const validTasa = (t) => t != null && t > 0 && t < 1;
        const mapaIA = (resu.tasas_intl_extracto && typeof resu.tasas_intl_extracto === 'object') ? resu.tasas_intl_extracto : null;
        const escalarIA = (resu.tasa_intl_extracto != null && resu.tasa_intl_extracto !== '') ? Number(resu.tasa_intl_extracto) : null;
        // Tasa capturada por el motor en la línea del extracto, por compra_id (fuente PRIMARIA).
        const tasaDet = {};
        (cruce.matches || []).forEach(m => { if (m && m.compra_id != null && validTasa(Number(m.tasa_extracto))) tasaDet[Number(m.compra_id)] = Number(m.tasa_extracto); });

        if (mv && mv.tarjeta && Array.isArray(mv.compras)) {
          const tjRow = db.prepare('SELECT tasa_mv_avances FROM tarjetas WHERE id=?').get(mv.tarjeta.id);
          const tasaGlobal = (tjRow && tjRow.tasa_mv_avances != null) ? tjRow.tasa_mv_avances : 0.01911;
          const EPS = 1e-6;
          const tasaObjetivoDe = (c) => {
            const det = tasaDet[Number(c.id)];
            if (validTasa(det)) return det;                                          // 1) la de SU línea (motor)
            const mes = String(c.fecha || '').slice(0, 7);
            if (mapaIA && validTasa(Number(mapaIA[mes]))) return Number(mapaIA[mes]); // 2) la del mes (IA)
            if (validTasa(escalarIA)) return escalarIA;                              // 3) escalar viejo (compat)
            return null;                                                             // 4) sin fuente -> omitir
          };
          const actualEfectiva = (c) => (c.tasa_intl != null ? Number(c.tasa_intl) : tasaGlobal);
          const intlComp = mv.compras.filter(c => c && (c.es_internacional || Number(c.interes_intl) > 0));
          // Agrupar las afectadas (tasa objetivo != snapshot actual) por su tasa objetivo (clave: 6 dec).
          const porTasa = {};
          intlComp.forEach(c => {
            const obj = tasaObjetivoDe(c);
            if (obj == null) return;
            const actual = (c.tasa_intl != null) ? Number(c.tasa_intl) : null;
            if (actual != null && Math.abs(actual - obj) <= EPS) return; // ya correcta
            const key = obj.toFixed(6);
            (porTasa[key] = porTasa[key] || { tasa: obj, compras: [] }).compras.push(c);
          });
          const grupos = Object.keys(porTasa).map(k => {
            const g = porTasa[k];
            return {
              tasa_intl: g.tasa,
              compra_ids: g.compras.map(c => c.id),
              meses: [...new Set(g.compras.map(c => String(c.fecha || '').slice(0, 7)))],
              compras_afectadas: g.compras.map(c => {
                const ef = actualEfectiva(c);
                const interes_actual = Math.round(Number(c.interes_intl) || 0);
                const interes_nuevo = ef > 0 ? Math.round(interes_actual * (g.tasa / ef)) : interes_actual;
                return { id: c.id, descripcion: c.descripcion, mes: String(c.fecha || '').slice(0, 7), tasa_actual: (c.tasa_intl != null ? Number(c.tasa_intl) : null), interes_actual, interes_nuevo };
              })
            };
          });
          if (grupos.length) {
            const algunaSinFijar = grupos.some(g => g.compras_afectadas.some(c => c.tasa_actual == null));
            const multi = grupos.length > 1;
            if (!Array.isArray(resu.discrepancias)) resu.discrepancias = [];
            resu.discrepancias.push({
              tipo: 'tasa_intl_incorrecta',
              descripcion: (multi
                ? 'El ciclo abarca dos meses y el extracto factura las compras internacionales con una tasa por mes (la usura cambia el 1°). '
                : 'El extracto factura las compras internacionales con una tasa mensual distinta a la registrada en la app. ')
                + (algunaSinFijar ? 'Algunas compras aun no tienen su tasa fijada. ' : '')
                + 'Sincronizalas para que el interes intl use la tasa real de cada mes.',
              severidad: 'media',
              compra_id: null,
              grupos,
              accion_sugerida: { operacion: 'actualizar_tasa_intl', parametros: { tarjeta_id: mv.tarjeta.id, ciclo: mv.ciclo, grupos: grupos.map(g => ({ tasa_intl: g.tasa_intl, compra_ids: g.compra_ids })) } }
            });
          }
        }
      } catch (e) { console.log('[ia/analizar] comparacion tasa intl:', e && e.message); }

      // ── Refuerzo del cruce determinista: una compra emparejada 1:1 (monto+fecha+desc) no puede
      // ser ni faltante ni de monto erroneo; si la IA igual la reporto asi, se descarta. ──
      // `compra_no_facturada` entra aqui como CANDADO DE SEGURIDAD: es la unica accion DESTRUCTIVA
      // (borra la fila), asi que si el matcher SI emparejo esa compra contra una linea del extracto,
      // el banco si la facturo y la propuesta de borrarla es un falso positivo del LLM. El caso real
      // que motivo la feature (dos compras del mismo monto y fecha, una sola linea en el extracto) no
      // se ve afectado: el pool solo empareja UNA, y la sobrante queda fuera de idsConciliados.
      try {
        const idsConciliados = new Set((cruce.matches || []).map(m => Number(m.compra_id)));
        if (Array.isArray(resu.discrepancias) && idsConciliados.size) {
          const antes = resu.discrepancias.length;
          resu.discrepancias = resu.discrepancias.filter(d => {
            const cid = d && (d.compra_id != null ? d.compra_id : (d.accion_sugerida && d.accion_sugerida.parametros && d.accion_sugerida.parametros.compra_id));
            if (cid != null && idsConciliados.has(Number(cid)) && (d.tipo === 'compra_omitida' || d.tipo === 'monto_erroneo' || d.tipo === 'compra_no_facturada')) return false;
            return true;
          });
          const om = antes - resu.discrepancias.length;
          if (om > 0) resu.discrepancias_omitidas = (resu.discrepancias_omitidas || 0) + om;
        }
      } catch (e) { console.log('[ia/analizar] refuerzo cruce determinista:', e && e.message); }

      // ── Discrepancias de FECHAS (cruce determinista) ──
      // La IA extrae fecha_corte_extracto / fecha_pago_extracto; el backend las compara contra las
      // que calculo la app (mv.fecha_corte / mv.fecha_pago) y arma:
      //   - fecha_pago_movida (accionable): override visual via fechas_pago_custom (no toca calculos).
      //   - corte_desfasado (informativa) + cascada de mover_ciclo para las compras que cayeron fuera
      //     del corte real (compras_sin_cruce en la ventana corte_real < fecha <= corte_app), con dedupe.
      // Sanity: solo si el desfase es de 1..5 dias (mas alla = probable mala lectura del OCR/IA).
      try {
        const reFecha = /^\d{4}-\d{2}-\d{2}$/;
        const difDias = (a, b) => {
          if (!a || !b) return null;
          const da = new Date(String(a).slice(0, 10) + 'T00:00:00'), dbb = new Date(String(b).slice(0, 10) + 'T00:00:00');
          if (isNaN(da.getTime()) || isNaN(dbb.getTime())) return null;
          return Math.round((da.getTime() - dbb.getTime()) / 86400000);
        };
        const cicloMasUno = (ciclo) => {
          const [y, m] = String(ciclo).split('-').map(Number);
          if (!y || !m) return ciclo;
          const ny = m === 12 ? y + 1 : y, nm = m === 12 ? 1 : m + 1;
          return ny + '-' + String(nm).padStart(2, '0');
        };
        if (!Array.isArray(resu.discrepancias)) resu.discrepancias = [];

        // (a) Fecha de PAGO movida (accionable: override visual seguro).
        const fpExt = (resu.fecha_pago_extracto && reFecha.test(resu.fecha_pago_extracto)) ? resu.fecha_pago_extracto : null;
        const fpApp = mv.fecha_pago;
        if (fpExt && fpApp) {
          const d = difDias(fpExt, fpApp);
          // Si el usuario YA fijó manualmente la fecha de pago de este ciclo (fechas_pago_custom) y
          // coincide con la del extracto, el override ya está aplicado → no sugerir nada (sería
          // redundante: el dashboard ya muestra esa fecha como "MANUAL").
          const ovPago = db.prepare('SELECT fecha_pago FROM fechas_pago_custom WHERE tarjeta_id=? AND ciclo=?').get(mv.tarjeta.id, mv.ciclo);
          const pagoYaAplicado = !!(ovPago && ovPago.fecha_pago && String(ovPago.fecha_pago).slice(0, 10) === fpExt);
          if (d != null && d !== 0 && Math.abs(d) <= 5 && !pagoYaAplicado) {
            resu.discrepancias.push({
              tipo: 'fecha_pago_movida',
              descripcion: 'La fecha limite de pago del extracto (' + fpExt + ') no coincide con la calculada por la app (' + fpApp + '). Suele moverse por festivos o fines de semana.',
              severidad: 'media',
              fecha_app: fpApp,
              fecha_extracto: fpExt,
              compra_id: null,
              accion_sugerida: { operacion: 'actualizar_fecha_pago', parametros: { tarjeta_id: mv.tarjeta.id, ciclo: mv.ciclo, fecha_pago: fpExt } }
            });
          }
        }

        // (b) CORTE desfasado (informativa) + cascada de mover_ciclo para lo que cayo fuera.
        const fcExt = (resu.fecha_corte_extracto && reFecha.test(resu.fecha_corte_extracto)) ? resu.fecha_corte_extracto : null;
        const fcApp = mv.fecha_corte;
        if (fcExt && fcApp) {
          const d = difDias(fcExt, fcApp);
          if (d != null && d !== 0 && Math.abs(d) <= 5) {
            const cicloSig = cicloMasUno(mv.ciclo);
            // Dedupe: compra_ids que la IA YA marco con mover_ciclo (regla 4), para no duplicar.
            const yaMover = new Set();
            resu.discrepancias.forEach(dd => {
              const op = dd.accion_sugerida && dd.accion_sugerida.operacion;
              const cid = dd.compra_id != null ? dd.compra_id : (dd.accion_sugerida && dd.accion_sugerida.parametros && dd.accion_sugerida.parametros.compra_id);
              if (op === 'mover_ciclo' && cid != null) yaMover.add(Number(cid));
            });

            // Dos sentidos del desfase, segun el signo de d:
            //   d<0 (banco corto ANTES): compras de la app que cayeron fuera (cruce.comprasSinMatch,
            //        ventana (corte_real, corte_app]) -> mover al ciclo SIGUIENTE.
            //   d>0 (banco corto DESPUES, INVERSO): el banco facturo en ESTE ciclo compras que la app
            //        puso en el SIGUIENTE. Se detectan cruzando las lineas del PDF sin contraparte
            //        (cruce.lineasSinMatch) contra las compras del ciclo+1 (ventana (corte_app, corte_real])
            //        reutilizando el motor via una estrategia envoltorio -> traerlas al ciclo ACTUAL.
            const inverso = d > 0;
            const cicloDestino = inverso ? mv.ciclo : cicloSig;
            let afectadas = [];
            if (!inverso) {
              afectadas = (cruce.comprasSinMatch || []).filter(c => {
                // Solo compras de 1 cuota se "mueven de ciclo": las cuotas de diferida/avance (tipo !=
                // 'compra') tienen su propia amortizacion y no se reubican por desfase de corte.
                if (c.tipo && c.tipo !== 'compra') return false;
                if (!c.fecha || c.compra_id == null || yaMover.has(Number(c.compra_id))) return false;
                const dReal = difDias(c.fecha, fcExt), dApp = difDias(c.fecha, fcApp);
                return dReal != null && dApp != null && dReal > 0 && dApp <= 0;
              }).map(c => ({ compra_id: c.compra_id, descripcion: c.descripcion, fecha: c.fecha, total: c.total }));
            } else {
              try {
                const mvSig = construirMovimientos(db, mv.tarjeta.id, cicloSig);
                if (mvSig && !mvSig.error) {
                  // Estrategia envoltorio: el motor cruza las lineas sobrantes (ya parseadas) contra las
                  // compras de 1 cuota del ciclo+1, con su mismo algoritmo (monto + fecha +-1 + Dice), multi-moneda.
                  const cruceSig = cruzar('', { COP: (mvSig.compras || []), USD: (mvSig.compras_usd || []) }, { parsearLineas: () => (cruce.lineasSinMatch || []) });
                  afectadas = (cruceSig.matches || []).filter(m => {
                    if (m.compra_id == null || yaMover.has(Number(m.compra_id)) || !m.fecha_app) return false;
                    const dReal = difDias(m.fecha_app, fcExt), dApp = difDias(m.fecha_app, fcApp);
                    return dReal != null && dApp != null && dApp > 0 && dReal <= 0; // ventana (corte_app, corte_real]
                  }).map(m => ({ compra_id: m.compra_id, descripcion: m.descripcion_app, fecha: m.fecha_app, total: m.monto }));
                }
              } catch (e2) { console.log('[ia/analizar] cruce inverso de corte:', e2 && e2.message); }
            }

            // ¿Hay compras de la tarjeta DENTRO de la ventana del desfase (corte_real, corte_teorico]?
            // Se consulta la BD directamente (no `afectadas`, que depende del cruce y puede quedar
            // vacío aunque sí existan compras) para que el aviso no se contradiga en su texto. Solo
            // compras de 1 cuota sin ciclo manual (las que el corte realmente reubicaría).
            let hayComprasVentana = false;
            if (!inverso) {
              const rv = db.prepare("SELECT COUNT(*) n FROM compras WHERE tarjeta_id=? AND estado NOT IN ('diferida','pagado') AND COALESCE(ciclo_manual,0)=0 AND fecha > ? AND fecha <= ?").get(mv.tarjeta.id, fcExt, fcApp);
              hayComprasVentana = !!(rv && rv.n > 0);
            }
            resu.discrepancias.push({
              tipo: 'corte_desfasado',
              sentido: inverso ? 'inverso' : 'atras',
              hay_compras_ventana: hayComprasVentana,
              descripcion: inverso
                ? ('El banco cerro el ciclo el ' + fcExt + ', despues del ' + fcApp + ' que calculo la app. Compras que la app puso en ' + cicloSig + ' el banco las facturo en este ciclo (' + mv.ciclo + ').')
                : ('El banco cerro el ciclo el ' + fcExt + ', no el ' + fcApp + ' que calculo la app. Las compras hechas despues del ' + fcExt + ' entran al extracto de ' + cicloSig + '.'),
              severidad: 'media',
              fecha_app: fcApp,
              fecha_extracto: fcExt,
              ciclo_origen: inverso ? cicloSig : null,
              compra_id: null,
              // Adelanto (sentido 'atras'): ACCIONABLE → persiste el corte real en cortes_custom
              // (el motor reubica las compras de la ventana y auto-asigna las futuras). El caso
              // INVERSO (banco cortó después) se sigue resolviendo con los mover_ciclo en cascada,
              // así que ahí el aviso queda informativo (operacion 'ninguna').
              accion_sugerida: inverso
                ? { operacion: 'ninguna', parametros: {} }
                : { operacion: 'fecha_corte_movida', parametros: { tarjeta_id: mv.tarjeta.id, ciclo: mv.ciclo, fecha_corte: fcExt } },
              compras_afectadas: afectadas.map(c => ({ compra_id: c.compra_id, descripcion: c.descripcion, fecha: c.fecha, ciclo_destino: cicloDestino }))
            });
            // Cascada: una accion mover_ciclo por compra afectada (dedup garantizado).
            afectadas.forEach(c => {
              yaMover.add(Number(c.compra_id));
              resu.discrepancias.push({
                tipo: 'mover_ciclo',
                descripcion: inverso
                  ? ('Compra "' + (c.descripcion || ('#' + c.compra_id)) + '" del ' + c.fecha + ': el banco la facturo en este ciclo (' + cicloDestino + '), no en ' + cicloSig + ' donde la puso la app. Traela a este ciclo.')
                  : ('Compra "' + (c.descripcion || ('#' + c.compra_id)) + '" del ' + c.fecha + ': quedo despues del corte real (' + fcExt + '), el banco la factura en ' + cicloDestino + '. Muevela a ese ciclo.'),
                severidad: 'media',
                valor_app: c.total,
                compra_id: c.compra_id,
                motivo: 'corte_desfasado',
                accion_sugerida: { operacion: 'mover_ciclo', parametros: { compra_id: c.compra_id, ciclo: cicloDestino } }
              });
            });
            // FILTRO DE REDUNDANCIA (solo ADELANTO): el botón "Aplicar corte adelantado" (accion
            // fecha_corte_movida del aviso) YA reubica TODAS las compras de la ventana vía cortes_custom.
            // Por eso quitamos los mover_ciclo individuales —vengan de la cascada de arriba o de la
            // propia IA— cuya compra caiga ESTRICTAMENTE en la ventana (fecha > corte_real &&
            // fecha <= corte_teorico_app): ofrecer dos acciones para el mismo hueco confunde al usuario.
            if (!inverso) {
              resu.discrepancias = resu.discrepancias.filter(dd => {
                // Detectar por OPERACION además del tipo: la IA a veces clasifica el movimiento como
                // tipo='otro' pero con accion_sugerida.operacion='mover_ciclo'. Lo que reubica es la
                // operación, no la etiqueta, así que filtramos por ambas.
                const esMover = dd.tipo === 'mover_ciclo' || (dd.accion_sugerida && dd.accion_sugerida.operacion === 'mover_ciclo');
                if (!esMover) return true;
                const cid = dd.compra_id != null ? dd.compra_id : (dd.accion_sugerida && dd.accion_sugerida.parametros && dd.accion_sugerida.parametros.compra_id);
                if (cid == null) return true;
                const row = db.prepare('SELECT fecha FROM compras WHERE id=?').get(cid);
                if (!row || !row.fecha) return true;
                const enVentana = row.fecha > fcExt && row.fecha <= fcApp;
                return !enVentana; // fuera de la ventana se conserva; dentro la cubre el corte → se elimina
              });
            }
          }
        }
      } catch (e) { console.log('[ia/analizar] comparacion de fechas:', e && e.message); }

      // ── Cifra OFICIAL del pago mínimo, leída del PDF de forma DETERMINISTA (v5.7.0) ──
      // La app NO puede calcular el mínimo al peso: el banco cobra además interés sobre la cuota ya
      // facturada hasta el día en que el usuario paga (información del futuro al proyectar; probado
      // contra 10 extractos, ver docs/bancos/RappiCard_Visa.md §4.3). Así que el número se LEE del
      // extracto, sin pasar por el LLM (la estrategia del banco sabe dónde está impreso), y se ofrece
      // fijarlo con un clic para que al pagar no haya que transcribirlo a mano.
      try {
        const resumenPdf = (estrategia && typeof estrategia.parsearResumen === 'function')
          ? (estrategia.parsearResumen(texto_redactado) || {}) : {};
        const fmtPesos = (n) => '$' + Math.round(n || 0).toLocaleString('es-CO');
        if (resumenPdf.pago_minimo > 0) {
          const yaFijado = db.prepare('SELECT pago_minimo FROM extractos_oficiales WHERE tarjeta_id=? AND ciclo=?')
            .get(mv.tarjeta.id, mv.ciclo);
          const dif = Math.round(resumenPdf.pago_minimo - (mv.pago_minimo_app || 0));
          resu.pago_minimo_oficial = { valor: resumenPdf.pago_minimo, pago_total: resumenPdf.pago_total || null, diferencia: dif };
          // Solo se propone si aún no está fijado con ese mismo valor y difiere del cálculo.
          const yaIgual = yaFijado && Math.abs(yaFijado.pago_minimo - resumenPdf.pago_minimo) < 1;
          if (!yaIgual && Math.abs(dif) >= 1) {
            if (!Array.isArray(resu.discrepancias)) resu.discrepancias = [];
            resu.discrepancias.push({
              tipo: 'pago_minimo_oficial',
              descripcion: 'El extracto exige ' + fmtPesos(resumenPdf.pago_minimo) + ' de pago minimo y la app estima '
                + fmtPesos(mv.pago_minimo_app || 0) + '. Fija la cifra oficial para pagar el valor exacto sin transcribirlo a mano.',
              valor_extracto: resumenPdf.pago_minimo,
              valor_app: mv.pago_minimo_app || 0,
              compra_id: null,
              impacto_pago_minimo: 0,
              severidad: 'media',
              accion_sugerida: { operacion: 'fijar_pago_minimo_oficial', parametros: {
                tarjeta_id: mv.tarjeta.id, ciclo: mv.ciclo,
                pago_minimo: resumenPdf.pago_minimo, pago_total: resumenPdf.pago_total || null } }
            });
          }
        }
      } catch (e) { console.log('[ia/analizar] lectura del pago minimo oficial:', e && e.message); }

      // ── Detección determinista de REVERSOS (devoluciones) ──
      // Movimientos NEGATIVOS que NO son pagos (ej. "LATAM AIR $ -138.920") = devolución de una
      // compra. Se cruzan contra el historial por monto (abs, ±$2) + descripción difusa (el banco
      // acorta el nombre) y proponen la acción reversar_compra. Si la compra ya está reversada →
      // 'ya_aplicado' (idempotencia; el endpoint también responde 409 en ese caso).
      try {
        const reversos = detectarReversos(db, texto_redactado, mv && mv.tarjeta && mv.tarjeta.id);
        if (reversos.length) {
          if (!Array.isArray(resu.discrepancias)) resu.discrepancias = [];
          // No duplicar un reverso que la IA ya hubiera propuesto para la misma compra.
          const yaProp = new Set(resu.discrepancias
            .filter(d => d && d.accion_sugerida && d.accion_sugerida.operacion === 'reversar_compra' && d.compra_id != null)
            .map(d => d.compra_id));
          reversos.forEach(rv => { if (!yaProp.has(rv.compra_id)) resu.discrepancias.push(rv); });
          resu.reversos_detectados = reversos.length;
        }
      } catch (e) { console.log('[ia/analizar] deteccion de reversos:', e && e.message); }

      // ── Detección determinista de PAGOS-DE-FACTURA omitidos ──
      // Un "ABONO SUCURSAL VIRTUAL" (negativo) suele ser el pago que saldó el extracto ANTERIOR. Si su
      // monto (o la suma de varios fraccionados) cuadra (~1%) con el pago mínimo/total que la app calcula
      // para ese ciclo y la app aún NO lo tiene registrado, se propone registrar_pago. Los abonos/
      // remanentes que NO cuadran quedan informativos (pagos_detectados), por la ambigüedad de
      // "liquidación dirigida". El detector solo devuelve acciones (registrar_pago); si ya está reflejado
      // no devuelve nada. Se quitan de pagos_detectados los montos ya accionables (evita doble muestra).
      try {
        const pagosOm = detectarPagosOmitidos(db, texto_redactado, mv && mv.tarjeta && mv.tarjeta.id, mv && mv.ciclo);
        if (pagosOm.length) {
          if (!Array.isArray(resu.discrepancias)) resu.discrepancias = [];
          resu.discrepancias.push(...pagosOm);
          resu.pagos_omitidos_detectados = pagosOm.length;
          if (Array.isArray(resu.pagos_detectados)) {
            const montosAcc = new Set(pagosOm.map(p => Math.round((p.pago && p.pago.monto) || 0)));
            resu.pagos_detectados = resu.pagos_detectados.filter(pd => !montosAcc.has(Math.round(Number(pd.monto) || 0)));
          }
        }
      } catch (e) { console.log('[ia/analizar] deteccion de pagos omitidos:', e && e.message); }

      // Transparencia para la UI: cuántas concilió la capa determinista y qué quedó sin cruzar.
      resu.cruce_determinista = {
        conciliadas: cruce.matches.length,
        total_lineas_extracto: cruce.total_lineas_extracto,
        total_compras_app: cruce.total_compras_app,
        detalle: cruce.matches,
        compras_sin_cruce: cruce.comprasSinMatch,
        lineas_extracto_sin_cruce: cruce.lineasSinMatch
      };
      return res.json({ ok: true, resultado: resu, modelo: r.modelo, provider: prov });
    } catch (err) {
      console.log('[ia/analizar] error:', err && err.message);
      return res.status(500).json({ error: 'Error en el analisis: ' + ((err && err.message) || 'desconocido') });
    }
  });
};
