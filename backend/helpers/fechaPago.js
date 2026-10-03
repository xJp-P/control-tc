// backend/helpers/fechaPago.js — Fecha limite de pago de un extracto (pura, sin BD).
//
// REGLA DE BANCOLOMBIA VISA, medida en extractos reales (4 de 4): la fecha limite es el CORTE + 17
// DIAS CALENDARIO, corrida al siguiente dia HABIL (ni sabado, ni domingo, ni festivo de Colombia).
//   corte 30-abr-2026 + 17 = 17-may (domingo); 18-may festivo (Ascension)  -> 19-may
//   corte 30-jul-2026 + 17 = 16-ago (domingo); 17-ago festivo (Asuncion)   -> 18-ago
//   corte 30-ago-2026 + 17 = 16-sep (miercoles)                            -> 16-sep
//   corte 30-sep-2026 + 17 = 17-oct (sabado)                               -> 19-oct
// NO son 17 dias HABILES (darian 26-oct para el corte de septiembre) ni "el dia 16 del mes siguiente",
// que es lo que la app suponia: en un mes de 30 dias la regla cae en el 17, y el dia 16 de octubre de
// 2026 -viernes, habil- habria dado una fecha que el banco no usa.
//
// ALCANCE: solo Bancolombia VISA, que es lo medido. Las Mastercard/Amex de Bancolombia conservan su
// `dia_pago` configurado (sus valores -2, 3 y 4- no son coherentes con +17 y no hay extracto suyo que
// lo decida). RappiCard conserva su corte + 14. Cualquier otra tarjeta, su `dia_pago`.
'use strict';
const { addDays } = require('./dates');

const DIAS_CORTE_A_PAGO = 17;

const isoDe = (y, m, d) => y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
// Dia de la semana de una fecha ISO (0 = domingo). Mediodia UTC: inmune a la zona horaria.
const diaSemana = (iso) => new Date(iso + 'T12:00:00Z').getUTCDay();

// Domingo de Pascua (algoritmo anonimo gregoriano, Meeus/Jones/Butcher).
function pascua(y) {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4;
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return isoDe(y, mes, dia);
}

// Ley Emiliani (Ley 51 de 1983): el festivo que no cae en lunes se traslada al lunes siguiente.
const alLunes = (iso) => addDays(iso, (8 - diaSemana(iso)) % 7);

const _festivos = {};
// Festivos nacionales de Colombia de un año, como Set de fechas ISO.
function festivosColombia(y) {
  if (_festivos[y]) return _festivos[y];
  const p = pascua(y);
  const f = [
    isoDe(y, 1, 1), isoDe(y, 5, 1), isoDe(y, 7, 20), isoDe(y, 8, 7), isoDe(y, 12, 8), isoDe(y, 12, 25),   // fijos
    alLunes(isoDe(y, 1, 6)), alLunes(isoDe(y, 3, 19)), alLunes(isoDe(y, 6, 29)), alLunes(isoDe(y, 8, 15)), // Emiliani
    alLunes(isoDe(y, 10, 12)), alLunes(isoDe(y, 11, 1)), alLunes(isoDe(y, 11, 11)),
    addDays(p, -3), addDays(p, -2),                                                                        // jueves y viernes santo
    addDays(p, 43), addDays(p, 64), addDays(p, 71),                                                        // Ascension, Corpus, Sagrado Corazon (ya en lunes)
  ];
  _festivos[y] = new Set(f);
  return _festivos[y];
}

function esHabil(iso) {
  const ds = diaSemana(iso);
  return ds !== 0 && ds !== 6 && !festivosColombia(Number(iso.slice(0, 4))).has(iso);
}

function siguienteHabil(iso) {
  let d = iso;
  while (!esHabil(d)) d = addDays(d, 1);
  return d;
}

function esBancolombiaVisa(tj) {
  return String((tj && tj.banco) || '').toLowerCase().includes('bancolombia')
    && String((tj && tj.franquicia) || '').toLowerCase().includes('visa');
}

// Fecha limite PROYECTADA del extracto del ciclo `cicloStr` (YYYY-MM) cuyo corte es `fechaCorte`.
// `tj` necesita banco, franquicia y dia_pago. Las dos ramas que no son Bancolombia Visa son el calculo
// de siempre, copiado tal cual: para esas tarjetas el resultado no se mueve ni un dia.
function fechaPagoProyectada(tj, cicloStr, fechaCorte) {
  const banco = String((tj && tj.banco) || '').toLowerCase();
  if (banco.includes('rappi') || banco.includes('davivienda')) return addDays(fechaCorte, 14);
  if (esBancolombiaVisa(tj)) return siguienteHabil(addDays(fechaCorte, DIAS_CORTE_A_PAGO));
  const [year, month] = String(cicloStr).split('-').map(Number);
  return new Date(year, month, (tj && tj.dia_pago) || 16).toISOString().slice(0, 10);
}

module.exports = { fechaPagoProyectada, siguienteHabil, esHabil, festivosColombia, esBancolombiaVisa, DIAS_CORTE_A_PAGO };
