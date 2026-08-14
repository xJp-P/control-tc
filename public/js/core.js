// public/js/core.js — Cimientos que TODO lo demas usa: el alias de createElement, los hooks,
// la URL del backend y el cliente HTTP.
//
// `const e = React.createElement` tiene ~2.168 usos en el frontend. Se declara AQUI y en NINGUN
// otro sitio: los <script> clasicos comparten el mismo ambito lexico global, asi que una segunda
// declaracion lanza SyntaxError y ese archivo entero deja de ejecutarse (no la linea: el archivo).
// Es la razon de que este modulo cargue primero y de que el detector F2 valide la CONCATENACION
// de todas las piezas, no cada archivo por separado: en aislamiento todos parsean perfecto.

// ═══════════════════════════════════════════════════════════════════
// GLOBALS & HELPERS
// ═══════════════════════════════════════════════════════════════════
const e = React.createElement;
const { useState, useEffect, useCallback, useRef, useMemo, Fragment } = React;
const API = 'http://127.0.0.1:3500/api';
// Espejo de TOLERANCIA_PAGO_COP (backend/routes/extractos.js): margen con el que un pago se da por
// completo aunque no coincida al peso con el estimado. El estimado no puede ser exacto por diseno
// (el banco cobra interes sobre la cuota facturada hasta el dia del pago). Solo afecta el TEXTO del
// boton y el aviso; quien decide es el backend.
const TOLERANCIA_PAGO_COP = 2000;
// Espejo EXACTO de la banda de backend/routes/extractos.js (pagarExtracto). Anunciar el tope absoluto
// cuando la banda real es otra convierte el aviso en una promesa falsa: con cifra oficial del PDF el
// margen cae a $1 (un faltante ahi no es imprecision del modelo, es plata que falta) y en ciclos de
// minimo bajo manda el piso relativo del 2%. Devuelve 0 si no hay minimo (nada que tolerar).
function bandaToleranciaCop(ext, minimo) {
  if (!(minimo > 0)) return 0;
  if (ext && ext.tiene_oficial) return 1;
  return Math.min(TOLERANCIA_PAGO_COP, Math.round(minimo * 0.02));
}


// El body lo serializa ESTA funcion: quien la llama pasa el objeto tal cual. Volver a
// stringificarlo fuera manda una cadena escapada, body-parser responde 400 y la respuesta ya no es
// JSON -> el fallo se vuelve mudo (paso en v6.0.0). Lo vigila el detector F9.
async function api(path, opts) {
  // Una ESCRITURA que falla en silencio es un boton que no hace nada y no dice por que. Una LECTURA
  // que falla, no: varias son opcionales a proposito (autocompletado, TRM, el fallback offline del
  // asistente) y avisar de ellas seria ruido sobre algo que el codigo ya decidio ignorar.
  const esEscritura = !!(opts && opts.method && String(opts.method).toUpperCase() !== 'GET');
  try {
    const res = await fetch(API + path, {
      headers: { 'Content-Type': 'application/json' },
      ...opts,
      body: opts && opts.body ? JSON.stringify(opts.body) : undefined
    });
    // `await` y no `return res.json()`: sin el, el rechazo al parsear escapa de este try y el aviso
    // de abajo no llega a ejecutarse nunca — que es justo el caso que este bloque viene a cubrir.
    return await res.json();
  } catch (err) {
    // OJO: aqui NO entran los 4xx/5xx con cuerpo JSON. api() NO lanza con ellos: los devuelve como
    // {error} y el llamador debe mirarlo (v5.7.1). Esto cubre el otro caso: red caida, backend sin
    // responder, o una respuesta que no es JSON (un 404 en HTML).
    if (esEscritura) {
      // Se MARCA el error antes de avisar para que un catch propio del llamador no repita el mensaje.
      const yaAvisado = err && err.__avisado;
      if (err && typeof err === 'object') err.__avisado = true;
      if (!yaAvisado && typeof toastErr === 'function') {
        toastErr('Error de comunicacion: ' + ((err && err.message) || 'no se pudo completar la operacion'));
      }
    }
    // RELANZA siempre: los .catch que ya existen siguen recibiendo su error y ejecutando su logica.
    throw err;
  }
}
