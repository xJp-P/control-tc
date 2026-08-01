// public/js/formato.js — Formateo puro: moneda, fechas, ciclos legibles y etiquetas de cuota.
//
// Funciones sin efectos: misma entrada, misma salida. No tocan red, ni DOM, ni estado.


function fmtCOP(n) {
  if (n == null || isNaN(n)) return '$0';
  const abs = Math.abs(Math.round(n));
  const s = abs.toLocaleString('es-CO');
  return (n < 0 ? '-' : '') + '$' + s;
}

// Etiqueta de numeracion de cuota para el badge. Una diferida HIJA de reprogramacion de saldo lleva
// reprog_total = M (total del plan nuevo del banco); su cuota local i se muestra como continuacion del
// plan: (i + (M - num_cuotas)) / M. Ej. Temu 36->2, k=1: hija num_cuotas=1, reprog_total=2, local=1 => "2/2".
// Diferida normal (reprogTotal nulo) cae a la numeracion local "local/num_cuotas". Solo DISPLAY: nunca
// altera cuota_num (la clave real de bolsillo_cuotas que se envia al backend).
function badgeCuotaLabel(cuotaLocal, numCuotas, reprogTotal) {
  if (reprogTotal && numCuotas) return (cuotaLocal + (reprogTotal - numCuotas)) + '/' + reprogTotal;
  return cuotaLocal + '/' + numCuotas;
}

// Format number with thousand separators for input display (supports decimals with comma)
function fmtNumInput(val) {
  if (val === '' || val == null) return '';
  const str = String(val);
  // Handle decimal: could be '.' or ','
  const normalized = str.replace(',', '.');
  const parts = normalized.split('.');
  const intPart = parts[0].replace(/[^\d]/g, '');
  if (!intPart && !parts[1]) return '';
  const formatted = intPart ? parseInt(intPart).toLocaleString('es-CO') : '0';
  if (parts.length > 1) return formatted + ',' + parts[1].replace(/[^\d]/g, '');
  return formatted;
}

function fmtCOPDec(n) {
  if (n == null || isNaN(n)) return '$0';
  const parts = Math.abs(n).toFixed(2).split('.');
  const intPart = parseInt(parts[0]).toLocaleString('es-CO');
  return (n < 0 ? '-' : '') + '$' + intPart + ',' + parts[1];
}

// Un ciclo ('2026-06') como lo lee un humano ('junio de 2026'). Vivia dentro del .map() de personas de
// Terceros; se elevo a helper global (patron de fmtCOP) para que el ledger de "Dinero a favor" muestre el
// mes con el MISMO formato que los encabezados de esa pestana, sin duplicar la funcion.
function fmtCicloLabel(cic) {
  if (!cic || cic === 'Sin ciclo') return cic || '';
  const [y, m] = String(cic).split('-');
  return new Date(y, m - 1).toLocaleDateString('es-CO', { month: 'long', year: 'numeric' });
}

function fmtDate(d) {
  if (!d) return '';
  const parts = d.split('-');
  return parts[2] + '/' + parts[1] + '/' + parts[0];
}

// Helper para cards bimonetarias (COP arriba, divisor horizontal, USD abajo).
// Devuelve el JSX completo de una card con cabecera, dos pisos y footer opcional.
// Si `hasUsd` es false, solo renderiza el piso COP (igual que una card normal).
function fmtUsd(n) {
  return 'USD $' + new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0);
}


// Celda "Tasa" para las tablas de Compras/Terceros: muestra la tasa efectiva de interés intl de la
// compra. Congelada (tasa_intl) → texto normal; fallback a la tasa global viva → itálica/gris (señal
// de "actualízala desde el extracto"). En blanco si la compra no es internacional.
function tasaIntlTd(c, tarjeta) {
  // Celda vacía → guion gris, igual que la columna "Valor USD" (consistencia visual).
  const dash = e('td', { className: 'text-right text-mono', style: { fontSize: 12 } }, e('span', { style: { color: 'var(--text-muted)' } }, '—'));
  const esIntl = !!(c.es_internacional || (c.valor_usd && c.valor_usd > 0));
  if (!esIntl) return dash;
  const frozen = (c.tasa_intl != null);
  const tasa = frozen ? c.tasa_intl : (tarjeta && tarjeta.tasa_mv_avances ? tarjeta.tasa_mv_avances : 0);
  if (!tasa) return dash;
  return e('td', {
    className: 'text-right text-mono',
    style: Object.assign({ fontSize: 12 }, frozen ? {} : { fontStyle: 'italic', color: 'var(--text-muted)' }),
    title: frozen ? 'Tasa congelada de esta compra (la del extracto)' : 'Usando la tasa ACTUAL de la tarjeta (no congelada). Edita la compra y fija la del extracto.'
  }, (Number(tasa) * 100).toFixed(4) + '%');
}

// Color del estado real de una compra (para bordes/acentos). Mismas correspondencias que .badge-*.
function estadoColor(estado) {
  return estado === 'bolsillo' ? 'var(--success)'
    : estado === 'bolsillo_parcial' ? 'var(--purple)'
    : estado === 'pagado' ? 'var(--success)'
    : estado === 'pendiente' ? 'var(--warning)'
    : estado === 'vencido' ? 'var(--danger)'
    : 'var(--border)';
}
