// public/js/ciclos.js — Aritmetica de ciclos de facturacion.
//
// OJO: estas funciones son ESPEJO DELIBERADO de backend/helpers/dates.js y backend/helpers/
// cortes.js. La duplicacion es intencional y esta documentada; NO se unifica. Si una cambia sin
// la otra, el frontend y el backend discrepan sobre a que mes pertenece una compra.


function cicloActual() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0'); }
function todayISO() { const d = new Date(); return d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0') + '-' + String(d.getDate()).padStart(2,'0'); }
function calcCicloLocal(fechaStr, diaCorte) { var d = new Date(fechaStr + 'T12:00:00'); var year = d.getFullYear(); var month = d.getMonth(); if (d.getDate() > (diaCorte || 30)) { month += 1; if (month > 11) { month = 0; year += 1; } } return year + '-' + String(month + 1).padStart(2, '0'); }
// Ciclo VIGENTE de una tarjeta según su día de corte: el ciclo que está corriendo hoy.
// Tras pasar el corte, es el del mes siguiente (ej. RappiCard corte 20, hoy 31-may → 2026-06).
function cicloVigente(diaCorte) { return calcCicloLocal(todayISO(), diaCorte); }
// Ciclo siguiente a 'YYYY-MM' (aritmetica directa). Espejo de helpers/cortes.siguienteCiclo (backend).
function cicloSiguiente(ciclo) { var a = String(ciclo).split('-'); var y = Number(a[0]), m = Number(a[1]) + 1; if (m > 12) { m = 1; y += 1; } return y + '-' + String(m).padStart(2, '0'); }
// Ciclo destino de una fecha CONSCIENTE del corte adelantado: espejo de helpers/cortes.cicloConCorte.
// Si hay corte real para el ciclo teorico de la fecha y la compra es POSTERIOR a ese corte, salta al
// siguiente ciclo (solo ADELANTO). cortesMap: { 'YYYY-MM': 'YYYY-MM-DD' } = tarjeta.cortes_custom.
function cicloConCorteFront(fecha, diaCorte, cortesMap) { var teorico = calcCicloLocal(fecha, diaCorte); var corte = cortesMap && cortesMap[teorico]; return (corte && fecha > corte) ? cicloSiguiente(teorico) : teorico; }
// Fecha de corte 'YYYY-MM-DD' de un ciclo 'YYYY-MM' dado el dia de corte (capado al ultimo dia del mes,
// ej. feb -> 28/29). Se usa en el spillover de diferidas: la diferida arranca en el corte del ciclo DESTINO.
function corteDeCiclo(ciclo, diaCorte) { var p = String(ciclo).split('-'); var y = Number(p[0]), m = Number(p[1]); var lastDay = new Date(y, m, 0).getDate(); var day = Math.min(diaCorte, lastDay); return new Date(y, m - 1, day).toISOString().slice(0, 10); }
