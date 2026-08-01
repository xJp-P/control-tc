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


async function api(path, opts) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts && opts.body ? JSON.stringify(opts.body) : undefined
  });
  return res.json();
}
