// backend/routes/ia.js — /api/ia (Asistente de Conciliación de Extractos)
const { Router } = require('express');
const { extraerTextoPdf } = require('../services/pdfExtract');
const { redactarPII } = require('../services/redactPII');
const { construirMovimientos, leerBancoDoc } = require('../services/movimientos');
const { analizar: analizarIA } = require('../services/aiProvider');

// Arma el system + user prompt para la conciliación (esquema JSON estricto).
function construirPrompt(movimientos, textoExtracto, bancoDoc, contextoUsuario) {
  const tj = movimientos.tarjeta || {};
  const systemArr = [
    'Eres un conciliador experto de extractos de tarjeta de credito en Colombia. Respondes SIEMPRE en espanol.',
    'Objetivo central: CONCILIAR EL PAGO MINIMO: comparar el pago minimo del extracto del banco con el calculado por la app y atribuir la diferencia a causas concretas.',
    'REGLAS:',
    '1. Los movimientos tipo "ABONO SUCURSAL VIRTUAL" o similares NO son compras faltantes: por defecto son el pago del extracto anterior (a veces fraccionado). Reportalos en "pagos_detectados", nunca como discrepancia accionable.',
    '2. Si una parte de la diferencia no se explica con los datos, reportala en "residual_no_explicado"; NO inventes cargos.',
    '2b. La app trabaja en PESOS ENTEROS: si el monto del extracto y el de la app coinciden al redondear (diferencia < $1) NO es discrepancia y NO la incluyas en el array. Tampoco incluyas compras que el usuario divide entre varias personas (en la app son varias filas que SUMAN el monto del extracto): si la suma coincide, NO es discrepancia.',
    '2c. Las cuotas de avances y diferidas que recibes YA incluyen su interes corriente (campos "interes"/"total" de cada una). Por eso los "intereses corrientes" del extracto en su mayoria YA estan reflejados en esas cuotas; NO asumas que la app no los incluye. La diferencia tipica es solo un residual pequeno (revolving / intl no modelado).',
    '2d. Si varias compras comparten el MISMO monto (ej. dos de $44.900), cruzalas por descripcion/comercio, NO solo por el monto. Antes de marcar una compra como mal clasificada (internacional o no), revisa el campo "es_internacional" de la compra correspondiente en los movimientos: si ya coincide con el extracto, NO la reportes.',
    '2e. Cada compra trae "descripcion" (el nombre OFICIAL tal como llega al extracto del banco — úsalo para identificar y cruzar contra el extracto) y a veces "nota_personal" (una nota privada del usuario, ej. "iCloud", que NO aparece en el extracto). Cruza SOLO por "descripcion"; la "nota_personal" es contexto para ti, nunca la uses para emparejar.',
    '3. Usa las reglas del banco provistas para intereses, fechas y comportamientos especiales.',
    '4. Para una cuota que el banco factura en un mes distinto al de su fecha, usa accion_sugerida.operacion="mover_ciclo".',
    '4b. Para una compra a cuotas (diferida) que el banco reprogramó a un número distinto de cuotas (ej. de 36 a 2), usa tipo="cuota_reprogramada" y accion_sugerida.operacion="reprogramar_cuotas" con parametros { compra_id, num_cuotas } si las cuotas quedan uniformes, o { compra_id, cuotas: [{ ciclo: "YYYY-MM", monto: 0 }] } si quedan irregulares (montos o fechas distintos).',
    '4c. TASA DE INTERES INTERNACIONAL: extrae del extracto la tasa de interes CORRIENTE MENSUAL (M.V., mes vencido) aplicada a las compras INTERNACIONALES del ciclo. En el extracto cada compra trae su tasa como porcentaje con coma decimal (ej. "2,0849%"); las compras nacionales a 1 cuota muestran "0,0000%" (sin interes) y NO debes usar esas. Toma la tasa vigente (>0) de las compras internacionales y conviertela a DECIMAL con punto: "2,0849%" -> 0.020849. Devuelvela en el campo raiz "tasa_intl_extracto". Si el extracto solo muestra 0,0000% o no hay compras internacionales con tasa, devuelve null. NUNCA uses la tasa EFECTIVA ANUAL (E.A., ~25%); es la mensual. No inventes una tasa: si no la ves clara, null.',
    '5. Devuelve EXCLUSIVAMENTE un objeto JSON valido con EXACTAMENTE esta forma, sin texto adicional:',
    JSON.stringify({
      conciliacion_pago_minimo: { pago_minimo_extracto: 0, pago_minimo_app: 0, diferencia: 0, explicacion: ['string'], residual_no_explicado: 0 },
      tasa_intl_extracto: 0.020849,
      pagos_detectados: [{ fecha: 'YYYY-MM-DD', monto: 0, etiqueta_extracto: 'string', coincide_con_pago_app: true }],
      discrepancias: [{ tipo: 'compra_omitida|monto_erroneo|clasificacion_incorrecta|cuota_reprogramada|otro', descripcion: 'string', valor_extracto: 0, valor_app: 0, compra_id: null, severidad: 'alta|media|baja', accion_sugerida: { operacion: 'crear_compra|editar_valor|convertir_a_diferida|reprogramar_cuotas|mover_ciclo|ninguna', parametros: {} } }]
    })
  ];
  if (contextoUsuario && String(contextoUsuario).trim()) {
    systemArr.push('', 'INSTRUCCION DIRECTA DEL USUARIO (PRIORIDAD MAXIMA): el usuario ya revisó tu análisis anterior y te da esta aclaración/corrección directa. Aplícala por encima de cualquier inferencia previa y ajusta el resultado en consecuencia: ' + String(contextoUsuario).trim());
  }
  const system = systemArr.join('\n');

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
      const { system, user } = construirPrompt(mv, texto_redactado, bancoDoc, contexto_usuario);

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
      // ── Discrepancia de TASA INTERNACIONAL (cruce determinista) ──
      // La IA solo extrae el numero (resu.tasa_intl_extracto); el backend lo contrasta contra el
      // snapshot tasa_intl de cada compra intl del ciclo y arma la discrepancia + accion. Asi el
      // emparejamiento compra<->extracto y el UPDATE no dependen del criterio del modelo.
      try {
        const tasaExtracto = (resu.tasa_intl_extracto != null && resu.tasa_intl_extracto !== '') ? Number(resu.tasa_intl_extracto) : null;
        if (tasaExtracto != null && tasaExtracto > 0 && tasaExtracto < 1 && mv && mv.tarjeta && Array.isArray(mv.compras)) {
          const tjRow = db.prepare('SELECT tasa_mv_avances FROM tarjetas WHERE id=?').get(mv.tarjeta.id);
          const tasaGlobal = (tjRow && tjRow.tasa_mv_avances != null) ? tjRow.tasa_mv_avances : 0.01911;
          const EPS = 1e-6;
          const intlComp = mv.compras.filter(c => c && (c.es_internacional || Number(c.interes_intl) > 0));
          const afectadas = intlComp.filter(c => {
            const actual = (c.tasa_intl != null) ? Number(c.tasa_intl) : null;
            return actual == null || Math.abs(actual - tasaExtracto) > EPS;
          });
          if (afectadas.length) {
            const compras_afectadas = afectadas.map(c => {
              const actualEfectiva = (c.tasa_intl != null) ? Number(c.tasa_intl) : tasaGlobal;
              const interes_actual = Math.round(Number(c.interes_intl) || 0);
              const interes_nuevo = actualEfectiva > 0 ? Math.round(interes_actual * (tasaExtracto / actualEfectiva)) : interes_actual;
              return { id: c.id, descripcion: c.descripcion, tasa_actual: (c.tasa_intl != null ? Number(c.tasa_intl) : null), interes_actual, interes_nuevo };
            });
            const algunaSinFijar = afectadas.some(c => c.tasa_intl == null);
            if (!Array.isArray(resu.discrepancias)) resu.discrepancias = [];
            resu.discrepancias.push({
              tipo: 'tasa_intl_incorrecta',
              descripcion: algunaSinFijar
                ? 'El extracto factura las compras internacionales a una tasa mensual que la app aun no tiene fijada (snapshot ausente o distinto). Sincronizala para que el interes intl use la tasa real del extracto.'
                : 'El extracto factura las compras internacionales con una tasa mensual distinta a la registrada en la app. Sincronizala para que el interes intl use la tasa real del extracto.',
              severidad: 'media',
              tasa_extracto: tasaExtracto,
              tasa_app: (afectadas[0].tasa_intl != null ? Number(afectadas[0].tasa_intl) : tasaGlobal),
              compra_id: null,
              compras_afectadas,
              accion_sugerida: { operacion: 'actualizar_tasa_intl', parametros: { tarjeta_id: mv.tarjeta.id, ciclo: mv.ciclo, tasa_intl: tasaExtracto, compra_ids: afectadas.map(c => c.id) } }
            });
          }
        }
      } catch (e) { console.log('[ia/analizar] comparacion tasa intl:', e && e.message); }
      return res.json({ ok: true, resultado: resu, modelo: r.modelo, provider: prov });
    } catch (err) {
      console.log('[ia/analizar] error:', err && err.message);
      return res.status(500).json({ error: 'Error en el analisis: ' + ((err && err.message) || 'desconocido') });
    }
  });

  return router;
};
