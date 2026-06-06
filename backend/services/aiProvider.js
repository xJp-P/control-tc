// backend/services/aiProvider.js
// Adaptador AGNÓSTICO de proveedor de IA. Usa fetch nativo (Node 18+/Electron) contra los
// REST oficiales; NO instala SDKs. Devuelve { resultado, raw, modelo } donde `resultado` es
// el JSON parseado del esquema de conciliación. Maneja errores tipados (sin_key, http, timeout).
//
// Proveedores: 'mock' (Demo, sin red), 'openai', 'anthropic', 'gemini'.

const TIMEOUT_MS = 60000;

function fetchConTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms || TIMEOUT_MS);
  return fetch(url, Object.assign({}, opts, { signal: ctrl.signal })).finally(() => clearTimeout(t));
}

async function safeText(res) { try { return await res.text(); } catch (_) { return ''; } }

function errorProveedor(status, body) {
  let msg = 'Error del proveedor de IA (HTTP ' + status + ').';
  if (status === 401 || status === 403) msg = 'API key invalida o sin permisos.';
  else if (status === 429) msg = 'Limite de uso alcanzado (rate limit) o sin credito disponible.';
  else if (status >= 500) msg = 'El proveedor de IA tuvo un error temporal. Intenta de nuevo en un momento.';
  const e = new Error(msg); e.tipo = 'http'; e.status = status; e.body = String(body || '').slice(0, 300);
  return e;
}

// Extrae el primer objeto JSON de la respuesta del modelo (tolera ```json ... ``` o texto extra).
function extraerJson(texto) {
  if (!texto) return null;
  let s = String(texto).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  try { return JSON.parse(s); } catch (_) { /* sigue */ }
  const i = s.indexOf('{'), j = s.lastIndexOf('}');
  if (i >= 0 && j > i) { try { return JSON.parse(s.slice(i, j + 1)); } catch (_) { /* sigue */ } }
  return null;
}

// Resultado Demo (sin red): coherente con los movimientos recibidos, para validar la UI.
function mockResultado(mockContexto) {
  const mv = (mockContexto && mockContexto.movimientos) || {};
  const pmApp = Number(mv.pago_minimo_app || 0);
  const pmExtracto = pmApp ? Math.round(pmApp * 1.018) : 250000; // simula ~1.8% mas
  const dif = pmExtracto - pmApp;
  const compras = Array.isArray(mv.compras) ? mv.compras : [];
  const ej = compras[0] || null;
  // Demo: simula que el extracto trae una tasa intl ~3% menor a la registrada en la app, para que
  // se vea la discrepancia de tasa internacional en la UI sin gastar tokens. Si no hay compras
  // intl en el ciclo, devuelve null (no aplica).
  const intlEj = compras.find(c => c && (c.es_internacional || Number(c.interes_intl) > 0));
  const tasaBase = (intlEj && intlEj.tasa_intl != null) ? Number(intlEj.tasa_intl) : 0.02;
  const tasaDemoIntl = intlEj ? Math.round(tasaBase * 0.97 * 1e6) / 1e6 : null;
  // Demo: simula que el extracto cerro 1 dia antes (corte desfasado) y que la fecha de pago se movio
  // 2 dias (festivo), para ver las discrepancias de fechas en la UI sin gastar tokens.
  const addDiasISO = (iso, n) => { if (!iso) return null; const dt = new Date(String(iso).slice(0, 10) + 'T00:00:00'); if (isNaN(dt.getTime())) return null; dt.setDate(dt.getDate() + n); return dt.toISOString().slice(0, 10); };
  return {
    conciliacion_pago_minimo: {
      pago_minimo_extracto: pmExtracto,
      pago_minimo_app: pmApp,
      diferencia: dif,
      explicacion: [
        'Demo: el pago minimo del extracto resulta ~1.8% mayor al calculado por la app.',
        'La mayor parte se explica por intereses corrientes que la app aun no modela.'
      ],
      residual_no_explicado: Math.max(0, Math.round(dif * 0.1))
    },
    // Mapa mes->tasa (split del día 1°). Demo: misma tasa para cada mes con compras intl en el ciclo.
    tasas_intl_extracto: (() => {
      if (tasaDemoIntl == null) return {};
      const m = {};
      compras.filter(c => c && (c.es_internacional || Number(c.interes_intl) > 0))
        .forEach(c => { const k = String(c.fecha || '').slice(0, 7); if (k) m[k] = tasaDemoIntl; });
      return m;
    })(),
    fecha_corte_extracto: addDiasISO(mv.fecha_corte, -1),
    fecha_pago_extracto: addDiasISO(mv.fecha_pago, -2),
    pagos_detectados: [
      { fecha: mv.fecha_corte || '', monto: pmApp, etiqueta_extracto: 'ABONO SUCURSAL VIRTUAL', coincide_con_pago_app: true }
    ],
    discrepancias: ej ? [{
      tipo: 'monto_erroneo',
      descripcion: 'Demo: la compra "' + (ej.descripcion || 'EJEMPLO') + '" aparece con un valor distinto en el extracto.',
      valor_extracto: Math.round((ej.total || 0) * 1.05),
      valor_app: ej.total || 0,
      compra_id: ej.id || null,
      severidad: 'media',
      accion_sugerida: { operacion: 'editar_valor', parametros: { compra_id: ej.id || null, valor_cop: Math.round((ej.total || 0) * 1.05) } }
    }] : []
  };
}

/**
 * @param {object} args { provider, model, key, system, user, mockContexto }
 * @returns {Promise<{resultado:object|null, raw:string, modelo:string}>}
 */
async function analizar(args) {
  const { provider, model, key, system, user, mockContexto } = args || {};

  if (provider === 'mock') {
    return { resultado: mockResultado(mockContexto), raw: '(demo)', modelo: 'demo' };
  }
  if (!key) { const e = new Error('No hay API key configurada.'); e.tipo = 'sin_key'; throw e; }

  let res, data, txt, modelo = model;
  try {
    if (provider === 'openai') {
      res = await fetchConTimeout('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({
          model: model || 'gpt-4o',
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          response_format: { type: 'json_object' },
          temperature: 0.1
        })
      });
      if (!res.ok) throw errorProveedor(res.status, await safeText(res));
      data = await res.json();
      txt = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      modelo = (data && data.model) || model;
    } else if (provider === 'deepseek') {
      // DeepSeek expone una API compatible con OpenAI: mismo payload, endpoint oficial propio.
      res = await fetchConTimeout('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + key },
        body: JSON.stringify({
          model: model || 'deepseek-chat',
          messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
          response_format: { type: 'json_object' },
          temperature: 0.1
        })
      });
      if (!res.ok) throw errorProveedor(res.status, await safeText(res));
      data = await res.json();
      txt = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      modelo = (data && data.model) || model;
    } else if (provider === 'anthropic') {
      res = await fetchConTimeout('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: model || 'claude-3-5-sonnet-latest',
          max_tokens: 2048,
          system: system + '\nResponde UNICAMENTE con el objeto JSON pedido, sin texto adicional ni explicaciones fuera del JSON.',
          messages: [{ role: 'user', content: user }]
        })
      });
      if (!res.ok) throw errorProveedor(res.status, await safeText(res));
      data = await res.json();
      txt = data && data.content && data.content[0] && data.content[0].text;
      modelo = (data && data.model) || model;
    } else if (provider === 'gemini') {
      const mdl = model || 'gemini-1.5-pro';
      const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(mdl) + ':generateContent?key=' + encodeURIComponent(key);
      res = await fetchConTimeout(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: user }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
        })
      });
      if (!res.ok) throw errorProveedor(res.status, await safeText(res));
      data = await res.json();
      txt = data && data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text;
      modelo = mdl;
    } else {
      const e = new Error('Proveedor no soportado: ' + provider); e.tipo = 'provider'; throw e;
    }
  } catch (err) {
    if (err && err.name === 'AbortError') { const e = new Error('La IA tardo demasiado en responder (timeout).'); e.tipo = 'timeout'; throw e; }
    throw err;
  }

  return { resultado: extraerJson(txt), raw: txt || '', modelo: modelo };
}

module.exports = { analizar, extraerJson };
