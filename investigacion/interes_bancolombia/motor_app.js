// investigacion/interes_bancolombia/motor_app.js
// Lo que el motor REAL de la app calcula para unos ciclos y unas diferidas, contra una BD abierta
// en modo SOLO LECTURA (better-sqlite3 lanza si algo intentara escribir). Sirve para comparar el
// interes del motor con el que imprime el banco sin tocar la BD viva ni ejecutar el backend.
//
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe \
//     investigacion/interes_bancolombia/motor_app.js <data.db> <tarjeta_id> <ciclo,ciclo> [diferida_id,...]
//
// Con Electron y no con node: better-sqlite3 esta compilado contra el ABI de Electron.
'use strict';
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const Database = require(path.join(ROOT, 'node_modules/better-sqlite3'));
const { calcExtracto } = require(path.join(ROOT, 'backend/engine/extracto.js'));
const { calcularAmortizacionDiferida } = require(path.join(ROOT, 'backend/engine/amortizacion.js'));
const { nuOptsDif } = require(path.join(ROOT, 'backend/helpers/banco.js'));

const [dbPath, tarjetaId, ciclos, diferidas] = process.argv.slice(2);
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

for (const ciclo of ciclos.split(',')) {
  const e = calcExtracto(db, Number(tarjetaId), ciclo, true);
  const intAv = e.detalleAvances.reduce((s, a) => s + a.interes, 0);
  const intDif = e.detalleDiferidas.reduce((s, a) => s + a.interes, 0);
  console.log(`\n== ${ciclo} (corte ${e.fechaCorte})`);
  e.detalleAvances.forEach(a => console.log(`  avance ${a.fecha}  interes ${a.interes}`));
  e.detalleDiferidas.filter(d => d.interes).forEach(d => console.log(`  diferida ${d.etiqueta}  interes ${d.interes}`));
  // Ojo: con incluirPagadas el interes intl de las compras 1/1 ya pagadas sale en 0 (el motor solo
  // lo calcula sobre las pendientes), asi que en un ciclo cerrado este total lo EXCLUYE.
  console.log(`  interes del motor: avances ${intAv} + diferidas ${intDif} + intl ${e.interesesComprasIntl} = ${intAv + intDif + e.interesesComprasIntl}`);
}

for (const id of (diferidas ? diferidas.split(',') : [])) {
  const d = db.prepare('SELECT * FROM diferidas WHERE id=?').get(Number(id));
  if (!d) { console.log(`\n#${id}: no existe`); continue; }
  const a = calcularAmortizacionDiferida(d.monto, d.tasa_mv, d.num_cuotas, d.fecha_compra, d.fecha_primer_corte, [], nuOptsDif(db, d));
  console.log(`\n#${d.id} ${d.etiqueta}  monto ${d.monto}  tasa ${d.tasa_mv}  sin_gracia_cuota1 ${d.sin_gracia_cuota1}`);
  a.tabla.forEach(r => console.log(`  cuota ${r.numCuota}  ${r.fechaCorte}  ${r.dias} dias  capital ${r.cuotaCapital}  interes ${r.interesTotal}`));
}
db.close();
