// herramientas/conciliacion/aplicar_plan.js
// Aplica un plan de conciliacion (JSON) sobre una BD, por la MISMA via que la interfaz: levanta la
// app real (createApp) en un puerto efimero y llama a sus endpoints, asi que rigen todos los candados
// y reglas del backend. Solo dos operaciones bajan a SQL, porque la API no las cubre:
//   - fijar_calendario: reescribe el calendario de capital de una diferida (capital_cuotas). Ningun
//     endpoint lo edita, y POST /diferidas/:id/reprogramar cambia num_cuotas SIN limpiar ese mapa (la
//     cuota vieja seguiria mandando sobre el capital). Lleva sus propios candados: no puede mover el
//     capital de una cuota que ya cayo en un ciclo pagado, y el plan nuevo debe sumar el monto.
//   - la tasa de una diferida recien convertida (convertir-a-diferida toma la tasa VIGENTE de la
//     tarjeta, no la del mes de la compra; el plan puede pedir la tasa_intl que la compra ya guarda).
// Toda escritura SQL queda en el Historial de la app (logAction), igual que las de los endpoints.
//
// Los registros se resuelven por descripcion + fecha (+ valor/estado), NUNCA por id: la BD maestra se
// reemplaza entre sesiones y los ids no son estables. Cada selector debe dar exactamente UNA fila.
// Las operaciones son idempotentes: lo que ya esta aplicado se reporta y se salta.
//
// El plan lleva datos reales del extracto, asi que vive FUERA del repo (docs/temp/, ignorado).
//
//   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe \
//     herramientas/conciliacion/aplicar_plan.js <data.db> <plan.json>
//
// Correr SIEMPRE primero sobre una copia, y con la app cerrada.
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..', '..');
const createApp = require(path.join(ROOT, 'backend', 'app.js'));
const { createLogHelpers } = require(path.join(ROOT, 'backend', 'helpers', 'log.js'));
const { calcularAmortizacionDiferida } = require(path.join(ROOT, 'backend', 'engine', 'amortizacion.js'));
const { nuOptsDif } = require(path.join(ROOT, 'backend', 'helpers', 'banco.js'));

const [dbPath, planPath] = process.argv.slice(2);
if (!dbPath || !planPath) { console.error('Uso: aplicar_plan.js <data.db> <plan.json>'); process.exit(2); }
const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
const r2 = n => Math.round(n * 100) / 100;

const { app, db } = createApp(dbPath);
const { logAction, tjNombre } = createLogHelpers(db);

const tj = db.prepare('SELECT id FROM tarjetas WHERE nombre=?').all(plan.tarjeta);
if (tj.length !== 1) { console.error('La tarjeta "' + plan.tarjeta + '" no es unica o no existe (' + tj.length + ').'); process.exit(1); }
const T = tj[0].id;

function unaCompra(sel) {
  const w = ['tarjeta_id=?', 'descripcion=?', 'fecha=?'], a = [T, sel.descripcion, sel.fecha];
  if (sel.valor_cop != null) { w.push('ABS(valor_cop-?)<0.005'); a.push(sel.valor_cop); }
  if (sel.estado) { w.push('estado=?'); a.push(sel.estado); }
  const filas = db.prepare('SELECT * FROM compras WHERE ' + w.join(' AND ')).all(...a);
  if (filas.length !== 1) throw new Error('El selector ' + JSON.stringify(sel) + ' encontro ' + filas.length + ' compras (se exige 1).');
  return filas[0];
}

function cicloPagado(ciclo) {
  const e = db.prepare("SELECT estado FROM extractos WHERE tarjeta_id=? AND ciclo=?").get(T, ciclo);
  return !!(e && e.estado === 'pagado');
}

async function api(port, metodo, ruta, cuerpo) {
  const r = await fetch('http://127.0.0.1:' + port + '/api' + ruta, {
    method: metodo, headers: { 'Content-Type': 'application/json' }, body: cuerpo ? JSON.stringify(cuerpo) : undefined });
  const j = await r.json();
  if (!r.ok || (j && j.error)) throw new Error(metodo + ' ' + ruta + ' -> ' + r.status + ': ' + (j && j.error));
  return j;
}

const OPS = {
  async crear_compra(port, o) {
    const ya = db.prepare('SELECT id FROM compras WHERE tarjeta_id=? AND fecha=? AND descripcion=? AND ABS(valor_cop-?)<0.005').get(T, o.fecha, o.descripcion, o.valor_cop);
    if (ya) return 'ya existia, se salta';
    // Sin ciclo_manual: la fecha cae dentro del periodo, asi que el ciclo lo deriva el backend.
    const r = await api(port, 'POST', '/compras', { tarjeta_id: T, fecha: o.fecha, descripcion: o.descripcion, valor_cop: o.valor_cop,
      es_internacional: o.es_internacional ? 1 : 0, persona_id: o.persona_id || null, desde_conciliacion: true });
    const c = db.prepare('SELECT ciclo, estado FROM compras WHERE id=?').get(r.id);
    return 'creada (ciclo ' + c.ciclo + ', ' + c.estado + ')';
  },

  async convertir_a_diferida(port, o) {
    const c = unaCompra(o.compra);
    let difId = c.diferida_id, msg;
    if (c.estado === 'diferida' && difId) msg = 'ya era diferida, se salta la conversion';
    else {
      const r = await api(port, 'POST', '/compras/' + c.id + '/convertir-a-diferida', { num_cuotas: o.num_cuotas, cobrar_intereses: true, desde_conciliacion: true });
      difId = r.diferida_id; msg = 'convertida a ' + r.num_cuotas + ' cuotas';
    }
    if (o.tasa_de_la_compra && c.tasa_intl > 0) {
      const d = db.prepare('SELECT tasa_mv FROM diferidas WHERE id=?').get(difId);
      if (Math.abs(d.tasa_mv - c.tasa_intl) > 1e-9) {
        db.prepare('UPDATE diferidas SET tasa_mv=? WHERE id=?').run(c.tasa_intl, difId);
        logAction('editar', tjNombre(T) + 'Conciliacion ' + plan.ciclo + ': tasa de la diferida ' + c.descripcion + ' = la de su mes (' + (c.tasa_intl * 100).toFixed(4) + '%), no la vigente de la tarjeta');
        msg += '; tasa ' + (d.tasa_mv * 100).toFixed(4) + '% -> ' + (c.tasa_intl * 100).toFixed(4) + '% (la de su mes)';
      }
    }
    return msg;
  },

  async fijar_calendario(port, o) {
    const c = unaCompra(o.compra);
    const d = c.diferida_id && db.prepare('SELECT * FROM diferidas WHERE id=?').get(c.diferida_id);
    if (!d) throw new Error('La compra no tiene diferida vinculada.');
    const caps = o.capitales.map(Number), n = caps.length;
    const monto = r2(caps.reduce((s, x) => s + x, 0));
    if (!o.ajustar_monto && Math.abs(monto - d.monto) > 0.005) throw new Error('El calendario suma ' + monto + ' y la diferida vale ' + d.monto + ' (usa ajustar_monto si el banco cambio el total).');
    if (o.ajustar_monto && Math.abs(c.valor_cop - d.monto) > 0.005) throw new Error('La compra (' + c.valor_cop + ') no refleja la diferida (' + d.monto + '); no se ajusta el monto a ciegas.');
    // Candado: una cuota que ya cayo en un ciclo PAGADO no puede cambiar de capital.
    const antes = calcularAmortizacionDiferida(d.monto, d.tasa_mv, d.num_cuotas, d.fecha_compra, d.fecha_primer_corte, null, nuOptsDif(db, d)).tabla;
    antes.forEach((q, i) => {
      if (cicloPagado(q.fechaCorte.slice(0, 7)) && !(i < n && Math.abs(caps[i] - q.cuotaCapital) < 0.005))
        throw new Error('La cuota ' + q.numCuota + ' cayo en ' + q.fechaCorte.slice(0, 7) + ' (pagado) y el plan le cambia el capital.');
    });
    const mapaActual = db.prepare('SELECT cuota_num, capital FROM capital_cuotas WHERE diferida_id=? ORDER BY cuota_num').all(d.id);
    const igual = mapaActual.length === n && mapaActual.every((m, i) => Math.abs(m.capital - caps[i]) < 0.005)
      && d.num_cuotas === n && Math.abs(d.monto - monto) < 0.005 && (o.reprog_total == null || d.reprog_total === o.reprog_total);
    if (igual) return 'el calendario ya era ' + caps.join(' + ') + ', se salta';
    db.transaction(() => {
      db.prepare('DELETE FROM capital_cuotas WHERE diferida_id=?').run(d.id);
      const ins = db.prepare('INSERT INTO capital_cuotas (diferida_id, cuota_num, capital) VALUES (?,?,?)');
      caps.forEach((cap, i) => ins.run(d.id, i + 1, cap));
      db.prepare('UPDATE diferidas SET num_cuotas=?, monto=? WHERE id=?').run(n, monto, d.id);
      if (o.reprog_total != null) db.prepare('UPDATE diferidas SET reprog_total=? WHERE id=?').run(o.reprog_total, d.id);
      if (o.notas_diferida) db.prepare('UPDATE diferidas SET notas=? WHERE id=?').run(o.notas_diferida, d.id);
      if (o.ajustar_monto) db.prepare('UPDATE compras SET valor_cop=? WHERE id=?').run(monto, c.id);
      // Mismo saneamiento que hace /diferidas/:id/reprogramar: fuera el bolsillo de cuotas que ya no existen.
      db.prepare('DELETE FROM bolsillo_cuotas WHERE compra_id=? AND cuota_num > ?').run(c.id, n);
      const sCop = db.prepare("SELECT COALESCE(SUM(monto),0) t FROM bolsillo_cuotas WHERE compra_id=? AND COALESCE(moneda,'COP')='COP'").get(c.id).t;
      const sUsd = db.prepare("SELECT COALESCE(SUM(monto),0) t FROM bolsillo_cuotas WHERE compra_id=? AND moneda='USD'").get(c.id).t;
      db.prepare('UPDATE compras SET monto_bolsillo=?, monto_bolsillo_usd=? WHERE id=?').run(sCop, sUsd, c.id);
      let notas = c.notas || '';
      if (/Diferida a \d+ cuotas/.test(notas)) notas = notas.replace(/Diferida a \d+ cuotas/g, 'Diferida a ' + n + ' cuotas');
      if (o.reemplazar_en_notas) notas = notas.split(o.reemplazar_en_notas[0]).join(o.reemplazar_en_notas[1]);
      if (notas !== (c.notas || '')) db.prepare('UPDATE compras SET notas=? WHERE id=?').run(notas, c.id);
      if (o.cuota_sellada) {
        const s = db.prepare("SELECT id FROM compras WHERE tarjeta_id=? AND descripcion=? AND estado='pagado'").all(T, o.cuota_sellada.descripcion);
        if (s.length !== 1) throw new Error('La cuota sellada "' + o.cuota_sellada.descripcion + '" encontro ' + s.length + ' filas (se exige 1).');
        db.prepare('UPDATE compras SET descripcion=?, notas=? WHERE id=?').run(o.cuota_sellada.nueva_descripcion, o.cuota_sellada.nuevas_notas, s[0].id);
      }
    })();
    logAction('editar', tjNombre(T) + 'Conciliacion ' + plan.ciclo + ': calendario de ' + c.descripcion + ' fijado al del banco: '
      + caps.map(x => x.toLocaleString('es-CO')).join(' + ') + (o.ajustar_monto ? ' (total ' + monto.toLocaleString('es-CO') + ')' : ''));
    const despues = calcularAmortizacionDiferida(monto, d.tasa_mv, n, d.fecha_compra, d.fecha_primer_corte, null, nuOptsDif(db, db.prepare('SELECT * FROM diferidas WHERE id=?').get(d.id))).tabla;
    return 'antes ' + antes.map(q => q.fechaCorte.slice(0, 7) + ':' + q.cuotaCapital).join(', ') + '  ->  ahora ' + despues.map(q => q.fechaCorte.slice(0, 7) + ':' + q.cuotaCapital).join(', ');
  },

  async pago_oficial(port, o) {
    const r = await api(port, 'POST', '/extractos/pago-oficial', { tarjeta_id: T, ciclo: plan.ciclo, pago_minimo: o.pago_minimo, pago_total: o.pago_total, fuente: 'conciliacion' });
    return 'minimo ' + r.pago_minimo + ', total ' + r.pago_total;
  },

  // Deja la BD como la deja la interfaz al abrir la pestana Pagos: GET /extractos recalcula y GUARDA
  // el pago minimo proyectado de cada ciclo pendiente. Sin este paso, un cambio hecho por script (una
  // cuota nueva que se suma a todos los meses futuros) deja esas filas con el valor viejo, y PUT
  // /extractos/:id/pagar -que lee la fila guardada, no la recalcula- compararia contra un minimo que ya
  // no es el que la interfaz muestra. Lo destapo F10 el 3-oct-2026: la interfaz anunciaba "abono" y el
  // backend sellaba el mes, porque cada uno miraba un minimo distinto del mismo ciclo.
  async refrescar_extractos(port) {
    const tjs = db.prepare('SELECT id FROM tarjetas').all();
    let n = 0;
    for (const t of tjs) { const r = await api(port, 'GET', '/extractos?tarjeta_id=' + t.id); n += Array.isArray(r) ? r.length : 0; }
    return n + ' extractos releidos en ' + tjs.length + ' tarjetas (proyecciones guardadas al dia)';
  },

  async fecha_pago(port, o) {
    const r = await api(port, 'PUT', '/extractos/fecha-pago-custom', { tarjeta_id: T, ciclo: plan.ciclo, fecha_pago: o.fecha_pago });
    return 'fecha limite ' + r.fecha_pago;
  },
};

const srv = app.listen(0, '127.0.0.1', async () => {
  const port = srv.address().port;
  let fallos = 0;
  console.log('BD: ' + dbPath + '\nTarjeta: ' + plan.tarjeta + ' · ciclo ' + plan.ciclo + '\n');
  for (const [i, o] of plan.operaciones.entries()) {
    const etq = (i + 1) + '. ' + o.op + (o.descripcion ? ' ' + o.descripcion : o.compra ? ' ' + o.compra.descripcion + ' ' + o.compra.fecha : '');
    try {
      if (!OPS[o.op]) throw new Error('operacion desconocida');
      console.log('OK    ' + etq + ': ' + await OPS[o.op](port, o));
    } catch (e) {
      fallos++;
      console.log('FALLO ' + etq + ': ' + e.message);
      break; // un paso fallido detiene el resto: el plan esta ordenado a proposito
    }
  }
  srv.close();
  db.close();
  console.log(fallos ? '\nSE DETUVO EN UN FALLO' : '\nPlan aplicado completo.');
  process.exit(fallos ? 1 : 0);
});
