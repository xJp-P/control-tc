// backend/helpers/dates.js — Date utilities (pure functions, no side effects)

function hoyLocal() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function addMonths(dateStr, months) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setMonth(d.getMonth() + months);
  const originalDay = new Date(dateStr + 'T12:00:00').getDate();
  if (d.getDate() !== originalDay) d.setDate(0);
  return d.toISOString().slice(0, 10);
}

function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T12:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(dateA, dateB) {
  const a = new Date(dateA + 'T12:00:00');
  const b = new Date(dateB + 'T12:00:00');
  return Math.round((b - a) / 86400000);
}

function primerCorteAvance(fechaDesembolso, diaCorte) {
  const d = new Date(fechaDesembolso + 'T12:00:00');
  const day = d.getDate();
  let year = d.getFullYear();
  let month = d.getMonth();
  if (day >= diaCorte) {
    month += 1;
    if (month > 11) { month = 0; year += 1; }
  }
  const lastDay = new Date(year, month + 1, 0).getDate();
  const actualDay = Math.min(diaCorte, lastDay);
  return new Date(year, month, actualDay).toISOString().slice(0, 10);
}

// Calcula el ciclo (YYYY-MM) en el que cae una fecha según el día de corte de la tarjeta.
// Si el día de la fecha es > diaCorte, se cuenta para el ciclo del mes siguiente.
// Equivalente a calcCicloLocal del frontend — mantener sincronizados.
function calcCicloLocal(fechaStr, diaCorte) {
  const d = new Date(fechaStr + 'T12:00:00');
  if (d.getDate() > (diaCorte || 30)) d.setMonth(d.getMonth() + 1);
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

// Devuelve el ciclo del mes calendario actual (YYYY-MM).
function cicloActualStr() {
  const d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
}

module.exports = { hoyLocal, addMonths, addDays, daysBetween, primerCorteAvance, calcCicloLocal, cicloActualStr };
