// backend/routes/ia.js — /api/ia (Asistente de Conciliación de Extractos)
const { Router } = require('express');
const { extraerTextoPdf } = require('../services/pdfExtract');
const { redactarPII } = require('../services/redactPII');
const { construirMovimientos, leerBancoDoc } = require('../services/movimientos');
const { analizar: analizarIA } = require('../services/aiProvider');
const { cruzar, parseMontoCol, dice, normalizarDesc } = require('../services/extracto/motorCruce');
const { getEstrategiaExtracto } = require('../services/extracto');

// ── Detección determinista de REVERSOS (devoluciones/refunds) ──────────────────
// Un reverso aparece en el extracto como un movimiento de valor NEGATIVO cuyo concepto es un
// COMERCIO (no "ABONO"/"PAGO"), con el nombre ACORTADO por el banco (ej. "LATAM AIR" por
// "LATAM AIRLINES COLOM"). Se cruza contra el HISTORIAL de la tarjeta por monto (valor absoluto,
// ±$2) + descripción difusa (Dice ≥ 0.4). Devuelve discrepancias tipo 'reverso_detectado' con
// accion_sugerida.operacion='reversar_compra' (o 'ninguna' + ya_aplicado si la compra ya está
// reversada -> idempotencia). Alcance v1: compras de 1 cuota en COP (las que el endpoint reversa).
function detectarReversos(db, texto, tarjetaId) {
  if (!texto || !tarjetaId) return [];
  const fmt = (n) => '$' + Math.round(n).toLocaleString('es-CO');
  const esPago = (c) => /\b(ABONO|PAGO|SU PAGO|SALDO A FAVOR|A FAVOR|NU\b)/i.test(c);
  // Líneas con valor NEGATIVO en pesos: [auth] DD/MM/YYYY  CONCEPTO  $ -NNN.NNN,NN
  const reNeg = /(\d{1,2}\/\d{1,2}\/\d{2,4})\s+(.+?)\s+\$\s*-\s*([\d][\d.]*(?:,\d{1,2})?)/;
  const candidatos = [];
  String(texto).split(/\r?\n/).forEach(raw => {
    const linea = raw.trim();
    const m = linea.match(reNeg);
    if (!m) return;
    const concepto = m[2].replace(/\s{2,}/g, ' ').trim();
    if (!concepto || concepto.length < 3 || esPago(concepto)) return;
    if (!/[A-Za-zÁÉÍÓÚÑ]{3,}/.test(concepto)) return; // debe tener texto de comercio, no solo números
    const monto = parseMontoCol(m[3]);
    if (!(monto > 0)) return;
    candidatos.push({ concepto, monto });
  });
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

// Arma el system + user prompt para la conciliación (esquema JSON estricto).
function construirPrompt(movimientos, textoExtracto, bancoDoc, contextoUsuario, cruce, estrategia) {
  const tj = movimientos.tarjeta || {};
  // Reglas ESPECÍFICAS del banco/franquicia (Patrón Estrategia): se inyectan al system prompt junto
  // a las universales. Si la estrategia no aporta reglas (fallback genérico), no se añade nada.
  const reglasBanco = (estrategia && typeof estrategia.reglasPrompt === 'function') ? (estrategia.reglasPrompt() || []) : [];
  const reglasEspecificas = reglasBanco.length
    ? ['REGLAS ESPECIFICAS DE ESTA TARJETA (' + (estrategia.id || 'banco') + '):', ...reglasBanco]
    : [];
  const systemArr = [
    'Eres un conciliador experto de extractos de tarjeta de credito en Colombia. Respondes SIEMPRE en espanol.',
    'Objetivo central: CONCILIAR EL PAGO MINIMO: comparar el pago minimo del extracto del banco con el calculado por la app y atribuir la diferencia a causas concretas.',
    'REGLAS:',
    '1. Los movimientos tipo "ABONO SUCURSAL VIRTUAL" o similares NO son compras faltantes: por defecto son el pago del extracto anterior (a veces fraccionado). Reportalos en "pagos_detectados", nunca como discrepancia accionable.',
    '1b. Los movimientos con valor NEGATIVO cuyo concepto es un COMERCIO (NO "ABONO"/"PAGO"), ej. "LATAM AIR $ -138.920", son REVERSOS (devoluciones) de una compra existente. El backend los detecta y cruza AUTOMATICAMENTE contra el historial; NO los reportes ni como discrepancia ni como pago.',
    '2. Si una parte de la diferencia no se explica con los datos, reportala en "residual_no_explicado"; NO inventes cargos.',
    '2b. La app trabaja en PESOS ENTEROS: si el monto del extracto y el de la app coinciden al redondear (diferencia < $1) NO es discrepancia y NO la incluyas en el array. Tampoco incluyas compras que el usuario divide entre varias personas (en la app son varias filas que SUMAN el monto del extracto): si la suma coincide, NO es discrepancia.',
    '2d. Si varias compras comparten el MISMO monto (ej. dos de $44.900), cruzalas por descripcion/comercio, NO solo por el monto. Antes de marcar una compra como mal clasificada (internacional o no), revisa el campo "es_internacional" de la compra correspondiente en los movimientos: si ya coincide con el extracto, NO la reportes.',
    '2e. Cada compra trae "descripcion" (el nombre OFICIAL tal como llega al extracto del banco — úsalo para identificar y cruzar contra el extracto) y a veces "nota_personal" (una nota privada del usuario, ej. "iCloud", que NO aparece en el extracto). Cruza SOLO por "descripcion"; la "nota_personal" es contexto para ti, nunca la uses para emparejar.',
    '2f. CUOTAS DE DIFERIDAS Y AVANCES — CAPITAL vs INTERES (regla critica anti-falso-positivo de "monto_erroneo"): el extracto del banco imprime en la linea de cada cuota SOLO la porcion de CAPITAL de ese mes (aproximadamente el valor de la compra dividido entre el numero de cuotas) y agrupa TODOS los intereses aparte, en un unico cargo global ("INTERESES CORRIENTES" o similar). En el JSON que recibes, cada item de "diferidas" y "avances" trae TRES campos numericos: "capital" (lo que el banco muestra en esa linea del movimiento), "interes", y "total" (= capital + interes, que es el valor que la app suma internamente al pago minimo). Por eso, para conciliar una cuota contra su linea del extracto debes comparar SIEMPRE contra el campo "capital", NUNCA contra "total". Si la linea del extracto coincide con "capital" (es decir, la diferencia frente a "total" es exactamente su "interes"), es un CRUCE EXACTO ya conciliado: NO lo reportes como monto_erroneo ni como ninguna otra discrepancia, y NO sugieras editar la cuota (hacerlo destruiria la proyeccion de intereses del usuario). Reporta monto_erroneo SOLO si la linea del extracto no coincide ni con "capital" ni con "total".',
    '2g. CARGO GLOBAL DE INTERESES: es NORMAL y correcto que la app NO tenga un movimiento separado llamado "INTERESES CORRIENTES" — la app ya reparte ese interes dentro de cada cuota (el campo "interes" de cada diferida/avance) y en el interes internacional. NO marques la ausencia de ese cargo global como una compra_omitida ni como una discrepancia, siempre que la suma de los "interes" de las cuotas (mas el interes intl si aplica) explique ese bloque global del extracto. Si queda un sobrante que las cuotas no explican, ponlo en "residual_no_explicado", nunca como una discrepancia accionable.',
    '3. Usa las reglas del banco provistas para intereses, fechas y comportamientos especiales.',
    '4. Para una cuota que el banco factura en un mes distinto al de su fecha, usa accion_sugerida.operacion="mover_ciclo".',
    '4b. Para una compra a cuotas (diferida) que el banco reprogramó a un número distinto de cuotas (ej. de 36 a 2), usa tipo="cuota_reprogramada" y accion_sugerida.operacion="reprogramar_cuotas" con parametros { compra_id, num_cuotas } si las cuotas quedan uniformes, o { compra_id, cuotas: [{ ciclo: "YYYY-MM", monto: 0 }] } si quedan irregulares (montos o fechas distintos).',
    '4c. Para una compra que en la app figura de CONTADO (1 cuota) pero el extracto la muestra DIFERIDA a N cuotas (ej. "1 de 36"), usa tipo="cuota_reprogramada" y accion_sugerida.operacion="convertir_a_diferida" con parametros { compra_id, num_cuotas: N, cobrar_intereses: true } (cobrar_intereses=false solo si el extracto factura su cuota de este mes con interes $0). NO uses crear_compra: la compra ya existe, solo cambia su plan de cuotas.',
    '4d. FECHAS DEL EXTRACTO: lee la FECHA DE CORTE (cierre del periodo) y la FECHA LIMITE DE PAGO impresas en el extracto y devuelvelas en los campos raiz "fecha_corte_extracto" y "fecha_pago_extracto" (formato YYYY-MM-DD; null si no las ves claras). Los movimientos que recibes ya traen la fecha_corte y fecha_pago que CALCULO la app: si la del extracto no coincide, explicalo en la conciliacion. Si la fecha de corte real es ANTERIOR a la calculada, razona que las compras hechas DESPUES del corte real quedaron fuera de este extracto y entran al del proximo mes. NO inventes fechas: el backend hara la comparacion exacta y armara las acciones.',
    '4e. DIFERIDA OMITIDA (una compra a CUOTAS que la app NO tiene): si el extracto muestra una linea de cuota con patron "N de M" (ej. "2 de 36", "3/12") de una compra que NO aparece en NINGUN movimiento de la app (ni en "compras" ni en "diferidas" hay una con esa descripcion), NO la reportes como compra_omitida con crear_compra — eso crearia una compra de UNA sola cuota por el valor de una cuota, en el ciclo equivocado. En su lugar usa tipo="diferida_omitida" y accion_sugerida.operacion="crear_diferida_omitida" con parametros { descripcion, capital: <el valor de ESA linea del extracto, que es el capital de UNA cuota>, num_cuotas: M, cuota_actual: N, cobrar_intereses: true }. El backend calculara el valor TOTAL (capital x M) y el ciclo/fechas de ORIGEN de la compra, y creara la diferida COMPLETA. IMPORTANTE: usa esto SOLO cuando la compra a cuotas es 100% inexistente en la app. Si la compra YA existe (aunque figure de contado o con otro valor) usa monto_erroneo / convertir_a_diferida / reprogramar_cuotas segun corresponda; NUNCA propongas crear_diferida_omitida para algo que la app ya tiene (crearia un duplicado).',
    ...reglasEspecificas,
    '5. Devuelve EXCLUSIVAMENTE un objeto JSON valido con EXACTAMENTE esta forma, sin texto adicional:',
    JSON.stringify({
      conciliacion_pago_minimo: { pago_minimo_extracto: 0, pago_minimo_app: 0, diferencia: 0, explicacion: ['string'], residual_no_explicado: 0 },
      tasas_intl_extracto: { 'YYYY-MM': 0.020849 },
      fecha_corte_extracto: 'YYYY-MM-DD',
      fecha_pago_extracto: 'YYYY-MM-DD',
      pagos_detectados: [{ fecha: 'YYYY-MM-DD', monto: 0, etiqueta_extracto: 'string', coincide_con_pago_app: true }],
      discrepancias: [{ tipo: 'compra_omitida|monto_erroneo|clasificacion_incorrecta|cuota_reprogramada|diferida_omitida|otro', descripcion: 'string', valor_extracto: 0, valor_app: 0, compra_id: null, severidad: 'alta|media|baja', accion_sugerida: { operacion: 'crear_compra|editar_valor|convertir_a_diferida|reprogramar_cuotas|crear_diferida_omitida|mover_ciclo|reversar_compra|ninguna', parametros: {} } }]
    })
  ];
  if (contextoUsuario && String(contextoUsuario).trim()) {
    systemArr.push('', 'INSTRUCCION DIRECTA DEL USUARIO (PRIORIDAD MAXIMA): el usuario ya revisó tu análisis anterior y te da esta aclaración/corrección directa. Aplícala por encima de cualquier inferencia previa y ajusta el resultado en consecuencia: ' + String(contextoUsuario).trim());
  }
  const system = systemArr.join('\n');

  // Sección del cruce determinista: compras ya emparejadas 1:1 con el extracto (capa 1, sin IA),
  // para que la IA NO las vuelva a marcar como discrepancia (reduce falsos positivos de antemano).
  const cm = (cruce && Array.isArray(cruce.matches)) ? cruce.matches : [];
  const cruceTexto = cm.length
    ? ['=== CRUCE EXACTO YA REALIZADO POR LA APP (capa determinista, no depende de tu criterio) ===',
       'Estas compras de la app YA fueron emparejadas 1 a 1 con una linea del extracto por coincidencia EXACTA de monto + fecha (+/- 1 dia) + descripcion. Dalas por CONCILIADAS: NO las reportes como compra_omitida, monto_erroneo ni clasificacion_incorrecta.',
       cm.map(m => '  - compra #' + m.compra_id + ' "' + m.descripcion_app + '" $' + m.monto).join('\n'), ''].join('\n')
    : '';

  const user = [
    'TARJETA: ' + (tj.banco || '') + ' ' + (tj.franquicia || '') + '. Ciclo a conciliar: ' + (movimientos.ciclo || '') + '.',
    'PAGO MINIMO SEGUN LA APP: ' + (movimientos.pago_minimo_app != null ? movimientos.pago_minimo_app : 's/d') + '.',
    '',
    '=== REGLAS DEL BANCO (' + (movimientos.banco_doc || 'no disponible') + ') ===',
    (bancoDoc ? bancoDoc.slice(0, 16000) : '(No hay documento de reglas para este banco; usa criterio general de tarjetas de credito en Colombia.)'),
    '',
    '=== MOVIMIENTOS REGISTRADOS EN LA APP (JSON) ===',
    JSON.stringify({
      ciclo: movimientos.ciclo, fecha_corte: movimientos.fecha_corte, fecha_pago: movimientos.fecha_pago,
      pago_minimo_app: movimientos.pago_minimo_app, intereses_intl: movimientos.intereses_intl,
      compras: movimientos.compras, diferidas: movimientos.diferidas, avances: movimientos.avances,
      dual: movimientos.dual, compras_usd: movimientos.compras_usd, pago_minimo_usd: movimientos.pago_minimo_usd
    }, null, 2),
    '',
    '=== TEXTO DEL EXTRACTO OFICIAL (datos personales ya ocultados) ===',
    String(textoExtracto || ''),
    '',
    cruceTexto,
    'Concilia el pago minimo y entrega UNICAMENTE el JSON pedido.'
  ].join('\n');

  return { system, user };
}

module.exports = function(db, ctx) {
  const router = Router();
  const { readIaKey } = ctx || {};

  // Perfil de datos del titular a ocultar (config key 'pii_perfil'). Permite redactar
  // nombre/ciudad/dirección aunque el banco los imprima en bruto, sin etiquetas.
  function leerPerfilPII() {
    try {
      const row = db.prepare("SELECT value FROM config WHERE key='pii_perfil'").get();
      if (row && row.value) return JSON.parse(row.value);
    } catch (_) { /* perfil ausente o inválido → solo reglas genéricas */ }
    return {};
  }

  // POST /api/ia/extraer
  // Body: { tarjeta_id, ciclo, pdf_base64, password? }
  // Flujo: extraer texto del PDF → redactar PII → armar movimientos del ciclo.
  // NO llama a la IA: devuelve todo para la vista previa y la confirmación del usuario.
  router.post('/extraer', async (req, res) => {
    try {
      const { tarjeta_id, ciclo, pdf_base64, password } = req.body || {};
      if (!tarjeta_id || !ciclo || !pdf_base64) {
        return res.status(400).json({ error: 'Faltan datos: se requieren tarjeta_id, ciclo y pdf_base64.' });
      }

      let buffer;
      try { buffer = Buffer.from(String(pdf_base64), 'base64'); }
      catch (_) { return res.status(400).json({ error: 'El PDF no se pudo decodificar.' }); }
      if (!buffer || buffer.length === 0) return res.status(400).json({ error: 'El PDF llegó vacío.' });

      const ext = await extraerTextoPdf(buffer, password);
      // PDF protegido: pedir contraseña (o avisar que la ingresada es incorrecta).
      if (ext.necesita_password) {
        return res.json({ necesita_password: true, password_incorrecta: !!ext.password_incorrecta });
      }
      // PDF escaneado sin capa de texto: no hay OCR.
      if (ext.sin_texto) {
        return res.json({ sin_texto: true });
      }

      // Ofuscar PII del titular ANTES de devolver nada (la vista previa muestra ya redactado).
      const perfil = leerPerfilPII();
      const perfilConfigurado = !!(perfil && (perfil.nombre || perfil.direccion || perfil.ciudad));
      const { texto, conteo } = redactarPII(ext.texto, perfil);
      const movimientos = construirMovimientos(db, tarjeta_id, ciclo);
      if (movimientos && movimientos.error) return res.status(404).json({ error: movimientos.error });

      return res.json({
        ok: true,
        paginas: ext.paginas || 0,
        texto_redactado: texto,
        redaccion: conteo,
        perfil_configurado: perfilConfigurado,
        movimientos,
        banco_doc: movimientos.banco_doc,
        banco_doc_existe: movimientos.banco_doc_existe
      });
    } catch (err) {
      console.log('[ia/extraer] error:', err && err.message);
      return res.status(500).json({ error: 'No se pudo procesar el PDF: ' + ((err && err.message) || 'error desconocido') });
    }
  });

  // GET /api/ia/movimientos?tarjeta_id&ciclo — movimientos del ciclo SIN PDF. Sirve para
  // refrescar la vista tras aplicar una accion y ver el nuevo pago minimo de la app.
  router.get('/movimientos', (req, res) => {
    const { tarjeta_id, ciclo } = req.query;
    if (!tarjeta_id || !ciclo) return res.status(400).json({ error: 'tarjeta_id y ciclo son requeridos.' });
    const mv = construirMovimientos(db, tarjeta_id, ciclo);
    if (mv && mv.error) return res.status(404).json(mv);
    res.json(mv);
  });

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
      try {
        const idsConciliados = new Set((cruce.matches || []).map(m => Number(m.compra_id)));
        if (Array.isArray(resu.discrepancias) && idsConciliados.size) {
          const antes = resu.discrepancias.length;
          resu.discrepancias = resu.discrepancias.filter(d => {
            const cid = d && (d.compra_id != null ? d.compra_id : (d.accion_sugerida && d.accion_sugerida.parametros && d.accion_sugerida.parametros.compra_id));
            if (cid != null && idsConciliados.has(Number(cid)) && (d.tipo === 'compra_omitida' || d.tipo === 'monto_erroneo')) return false;
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

  return router;
};

// Export auxiliar para pruebas unitarias del detector de reversos (no afecta el factory por defecto).
module.exports.detectarReversos = detectarReversos;
