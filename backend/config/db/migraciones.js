// backend/config/db/migraciones.js — FASE 2 y 3 del arranque: ALTER de columnas y migraciones
// de DATOS, en el orden en que estaban.
//
// Corre SIEMPRE despues de crearEsquema: cada `try { SELECT col } catch { ALTER TABLE }` asume
// que la tabla ya existe. Invertir esos dos pasos es el crash de v4.7.1 (ver schema.js).

function aplicarMigraciones(db) {
  // ─── Migrations ──────────────────────────────────────────────────
  const migrate = (table) => {
    try {
      db.prepare(`SELECT tarjeta_id FROM ${table} LIMIT 1`).get();
    } catch (e) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN tarjeta_id INTEGER REFERENCES tarjetas(id)`);
    }
  };
  migrate('compras');
  migrate('avances');
  migrate('diferidas');
  migrate('pagos');

  try { db.prepare('SELECT imagen FROM tarjetas LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE tarjetas ADD COLUMN imagen TEXT'); }

  try { db.prepare('SELECT dia_pago FROM tarjetas LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE tarjetas ADD COLUMN dia_pago INTEGER DEFAULT 16'); }

  try { db.prepare('SELECT tasa_usd FROM compras LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE compras ADD COLUMN tasa_usd REAL'); }

  db.prepare(`UPDATE compras SET valor_cop = ROUND(valor_usd * tasa_usd)
    WHERE valor_usd IS NOT NULL AND tasa_usd IS NOT NULL AND valor_cop != ROUND(valor_usd * tasa_usd)
    AND tarjeta_id NOT IN (SELECT id FROM tarjetas WHERE franquicia IN ('Mastercard','American Express'))`).run();

  db.prepare(`UPDATE compras SET valor_cop = 0
    WHERE valor_usd IS NOT NULL AND valor_usd > 0 AND valor_cop > 0
    AND tarjeta_id IN (SELECT id FROM tarjetas WHERE franquicia IN ('Mastercard','American Express'))`).run();

  db.prepare(`UPDATE compras SET estado = 'bolsillo' WHERE estado = 'en_bolsillo'`).run();
  db.prepare(`UPDATE compras SET estado = 'bolsillo_parcial' WHERE estado = 'en_bolsillo_parcial'`).run();

  try { db.prepare('SELECT monto_abonado FROM compras LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE compras ADD COLUMN monto_abonado REAL DEFAULT 0'); }

  try { db.prepare('SELECT tercero_pagado FROM compras LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE compras ADD COLUMN tercero_pagado INTEGER DEFAULT 0'); }

  try { db.prepare('SELECT tercero_monto_abonado FROM compras LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE compras ADD COLUMN tercero_monto_abonado INTEGER DEFAULT 0'); }

  try { db.prepare('SELECT diferida_id FROM compras LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE compras ADD COLUMN diferida_id INTEGER REFERENCES diferidas(id)'); }

  try { db.prepare('SELECT franquicia FROM tarjetas LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE tarjetas ADD COLUMN franquicia TEXT'); }

  // difiere_intereses_cuota1: solo aplica a tarjetas Bancolombia.
  // NULL = no configurado (el frontend obliga a configurarlo)
  // 0    = no difiere (cada cuota cobra su propio interés)
  // 1    = sí difiere (cuota 1 acumula, cuota 2 cobra interés_1 + interés_2)
  try { db.prepare('SELECT difiere_intereses_cuota1 FROM tarjetas LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE tarjetas ADD COLUMN difiere_intereses_cuota1 INTEGER'); }

  // orden: posición manual de la tarjeta en listados. NULL = sin orden definido (cae al final).
  // El backfill asigna 1, 2, 3, ... a las tarjetas existentes según created_at.
  let nuevaColumnaOrden = false;
  try { db.prepare('SELECT orden FROM tarjetas LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE tarjetas ADD COLUMN orden INTEGER'); nuevaColumnaOrden = true; }
  // Backfill solo la primera vez (o si quedan tarjetas con orden NULL).
  const sinOrden = db.prepare('SELECT COUNT(*) as n FROM tarjetas WHERE orden IS NULL').get();
  if (sinOrden && sinOrden.n > 0) {
    const tarjetasParaOrdenar = db.prepare('SELECT id FROM tarjetas WHERE orden IS NULL ORDER BY created_at ASC').all();
    const maxActual = db.prepare('SELECT COALESCE(MAX(orden), 0) as max FROM tarjetas WHERE orden IS NOT NULL').get();
    let siguiente = (maxActual ? maxActual.max : 0) + 1;
    tarjetasParaOrdenar.forEach(t => {
      db.prepare('UPDATE tarjetas SET orden=? WHERE id=?').run(siguiente, t.id);
      siguiente++;
    });
    if (nuevaColumnaOrden) console.log('[Migration] Columna `orden` agregada y backfill aplicado a ' + tarjetasParaOrdenar.length + ' tarjetas.');
  }

  try { db.prepare('SELECT monto_bolsillo FROM compras LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE compras ADD COLUMN monto_bolsillo REAL DEFAULT 0'); }

  try { db.prepare('SELECT grupo_id FROM compras LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE compras ADD COLUMN grupo_id TEXT'); }

  // Flag: compra internacional (genera intereses corrientes aunque no tenga valor_usd)
  // Útil para procesadores como Rappi/Apple/MercadoPago que cobran en COP pero el banco
  // las clasifica como internacionales y les cobra tasa MV.
  try { db.prepare('SELECT es_internacional FROM compras LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE compras ADD COLUMN es_internacional INTEGER DEFAULT 0'); }

  // Flag: ciclo asignado manualmente. Cuando es 1, el ciclo de la compra NO se deriva de la
  // fecha ni lo recalcula syncData (paso 5). Sirve para cuotas reprogramadas por el banco que
  // se pagan en un ciclo distinto al de su fecha real (la compra conserva su fecha real para
  // ordenar/mostrar, pero pertenece al ciclo que se le asigne).
  try { db.prepare('SELECT ciclo_manual FROM compras LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE compras ADD COLUMN ciclo_manual INTEGER DEFAULT 0'); }

  // nota_personal: nota privada del usuario (ej. "iCloud") separada del nombre OFICIAL del extracto
  // (columna descripcion). El nombre oficial es el que se cruza con el extracto del banco; la nota
  // es solo display/contexto (se muestra bajo el nombre en las tablas y se envía a la IA como tal).
  try { db.prepare('SELECT nota_personal FROM compras LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE compras ADD COLUMN nota_personal TEXT'); }

  // tasa_intl: tasa de interés mensual CONGELADA por compra internacional (snapshot histórico). El
  // banco fija la tasa al facturar y NO la cambia retroactivamente; la tasa global de la tarjeta sí
  // fluctúa. Si tasa_intl está seteada, el interés intl de esa compra se calcula con ELLA (no con la
  // global) → el histórico no se reescribe al cambiar la tasa. NULL = no capturada → usa la global
  // actual (fallback). La fija el usuario (CompraForm), el cierre de extracto (piso) o la IA (futuro).
  try { db.prepare('SELECT tasa_intl FROM compras LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE compras ADD COLUMN tasa_intl REAL'); }

  // reversada=1: el banco reversó (devolvió) esta compra. Se neutraliza como deuda
  // (estado='pagado', monto_abonado=valor_cop) SIN borrar valor_cop; si un tercero ya la había
  // reembolsado, se genera un Saldo a Favor a su nombre. Marca para idempotencia + badge "Reversada".
  try { db.prepare('SELECT reversada FROM compras LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE compras ADD COLUMN reversada INTEGER DEFAULT 0'); }
  // Backfill: marca reversada=1 las compras que ya tienen un Saldo a Favor de origen 'reverso'
  // (ej. el crédito LATAM sembrado antes de existir la columna) → idempotencia del botón Reversar.
  try {
    db.exec("UPDATE compras SET reversada=1 WHERE COALESCE(reversada,0)=0 AND id IN " +
            "(SELECT origen_compra_id FROM saldos_favor_tercero WHERE origen_tipo='reverso' AND origen_compra_id IS NOT NULL)");
  } catch (e) {}

  // updated_at: timestamp de la ÚLTIMA edición MANUAL de la compra (POST al crear, PUT del formulario
  // al editar). Es SOLO para el ordenamiento de DISPLAY de la tabla de Compras (desempate ante misma
  // fecha: la compra recién editada sube al primer lugar de su día). NO lo tocan las operaciones
  // internas (sellar extracto, abono a capital, bolsillo, reverso, corte) ni afecta la prelación de
  // abonos (esa usa created_at, deuda más vieja primero — inamovible). Backfill: updated_at = created_at
  // para las filas existentes → el orden actual (por recencia de registro) se conserva para lo no editado.
  try { db.prepare('SELECT updated_at FROM compras LIMIT 1').get(); }
  catch (e) {
    db.exec('ALTER TABLE compras ADD COLUMN updated_at TEXT');
    db.exec('UPDATE compras SET updated_at = created_at WHERE updated_at IS NULL');
  }

  // [DEROGADO v5.6.2] Aqui vivia un backfill retroactivo que asignaba grupo_id agrupando por
  // (fecha, descripcion, tarjeta_id, diferida_id) cuando habia mas de una compra en el bucket y al
  // menos una era de un tercero. Se escribio para migrar divisiones ANTERIORES a la existencia de la
  // columna grupo_id, pero quedo como IIFE sin candado de "ya migrado" -> corria en CADA arranque
  // (initDb) y fusionaba compras INDEPENDIENTES del mismo comercio/dia/tarjeta en una compra dividida
  // fantasma. Caso real: AMAZON COM #700/#701/#702 del 15-jul-2026, tres registros manuales separados
  // por 26 y 29 segundos que aparecieron unidos como "DIVIDIDA 3 partes" tras un reinicio. Como se
  // probo: el grupo_id ('gmrpjmphtbtoopma4') codifica en base36 el instante en que se acuño, y ese
  // instante era 7 minutos POSTERIOR a la ultima compra. OJO al reusar esa tecnica: el FORMATO por si
  // solo no prueba nada (el fallback de crypto.randomUUID en CompraForm acuña el mismo patron); la
  // prueba es el DESFASE temporal, porque el frontend acuña su grupo_id al crear, nunca despues.
  // Efecto colateral grave: el grupo resultante podia tener DOS partes personales, estado imposible
  // desde la UI, que hace que handleEditGrupo BORRE una parte al editar el grupo (indexa por persona y
  // ambas colisionan en la clave 'personal'). Desde que el flujo de division del frontend (CompraForm)
  // manda su propio grupo_id en el body y POST /compras lo persiste en el INSERT, esta heuristica ya no
  // tiene poblacion legitima que migrar: su unica salida posible son falsos positivos. Si algun dia
  // aparece una BD anterior a la columna, el remedio es un UPDATE puntual y auditado sobre ESOS ids,
  // nunca un backfill automatico por (fecha, descripcion, tarjeta) en el arranque. NO REINTRODUCIR.

  try { db.prepare('SELECT comision FROM avances LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE avances ADD COLUMN comision REAL DEFAULT 0'); }

  try { db.prepare('SELECT monto_bolsillo FROM avances LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE avances ADD COLUMN monto_bolsillo REAL DEFAULT 0'); }

  try { db.prepare('SELECT monto_bolsillo FROM diferidas LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE diferidas ADD COLUMN monto_bolsillo REAL DEFAULT 0'); }

  // sin_gracia_cuota1=1: diferida nacida de una REPROGRAMACIÓN DE SALDO (endpoint
  // /compras/:id/reprogramar-saldo). Su cuota 1 NO recibe la "gracia" de cuota 1 (Nu = cuota sin
  // interés; Bancolombia difiere_intereses_cuota1 = interés diferido a la cuota 2), porque el banco
  // NO re-otorga esa gracia sobre un saldo ya en curso — solo la da a compras nuevas. El helper
  // nuOptsDif(db, dif) lo respeta al amortizar. DEFAULT 0 → toda diferida existente conserva su
  // comportamiento (la gracia por-tarjeta vía nuOpts), sin regresión.
  try { db.prepare('SELECT sin_gracia_cuota1 FROM diferidas LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE diferidas ADD COLUMN sin_gracia_cuota1 INTEGER DEFAULT 0'); }

  // reprog_total = M (total de cuotas del plan REPROGRAMADO por el banco). Solo lo setea la
  // reprogramacion de saldo (/compras/:id/reprogramar-saldo) en la diferida HIJA. Sirve para que el
  // badge muestre la numeracion del plan "(k+1)/M" (ej. 2/2) en vez de la local "1/1" cuando la hija
  // quedo con pocas (o 1) cuotas. NULL en toda diferida normal -> el badge cae a la numeracion local
  // (num_cuotas), sin regresion. Es metadato de DISPLAY: no afecta la amortizacion (que corre por num_cuotas).
  try { db.prepare('SELECT reprog_total FROM diferidas LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE diferidas ADD COLUMN reprog_total INTEGER'); }

  // interes_sellado = interes (en pesos ENTEROS) de la cuota que representa una compra SELLADA por
  // reprogramacion de saldo (/compras/:id/reprogramar-saldo). Es metadato del LIBRO DEL TERCERO: el
  // tercero me debe por esa cuota capital (valor_cop) + interes_sellado, porque el banco me facturo
  // AMBOS. El LIBRO DEL BANCO lo IGNORA por completo: valor_cop sigue siendo capital puro, para que se
  // mantengan el invariante Σ(capital sellado)+saldoRestante==monto y el cruce de la IA por capital.
  // Se guarda REDONDEADO A PESO a proposito: mas abajo syncData fuerza monto_bolsillo=ROUND(...) en cada
  // arranque, asi que un objetivo con centavos seria INALCANZABLE (bolsillo_parcial eterno + degradacion
  // recurrente). NULL en toda compra que no sea una sellada -> cero regresion.
  try { db.prepare('SELECT interes_sellado FROM compras LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE compras ADD COLUMN interes_sellado REAL'); }

  // Intereses sobre compras internacionales: se persiste al cerrar el extracto
  // para que el historial mantenga el valor real cobrado por el banco aunque la
  // tasa o las compras cambien después.
  try { db.prepare('SELECT intereses_intl FROM extractos LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE extractos ADD COLUMN intereses_intl REAL DEFAULT 0'); }

  // Pago mínimo y pago total en USD del extracto (solo tarjetas con extracto dual:
  // Mastercard / Amex Bancolombia). Para tarjetas no-duales (ej. Visa) quedan en 0.
  // Permite mostrar la card "Pago Mínimo USD" y "Deuda USD" en el dashboard al
  // navegar ciclos históricos donde todas las compras ya están pagadas.
  try { db.prepare('SELECT pago_minimo_usd FROM extractos LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE extractos ADD COLUMN pago_minimo_usd REAL DEFAULT 0'); }
  try { db.prepare('SELECT pago_total_usd FROM extractos LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE extractos ADD COLUMN pago_total_usd REAL DEFAULT 0'); }

  // Pago en USD por separado del extracto (Mastercard / Amex Bancolombia):
  // permite saldar la porción COP y la USD de forma independiente dentro del
  // mismo ciclo. Para tarjetas no-duales, `estado_usd='no_aplica'`.
  //   estado_usd: 'pendiente' | 'pagado' | 'no_aplica'
  try { db.prepare('SELECT monto_pagado_usd FROM extractos LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE extractos ADD COLUMN monto_pagado_usd REAL DEFAULT 0'); }
  try { db.prepare('SELECT estado_usd FROM extractos LIMIT 1').get(); }
  catch (e) { db.exec("ALTER TABLE extractos ADD COLUMN estado_usd TEXT DEFAULT 'pendiente'"); }
  try { db.prepare('SELECT fecha_pagado_usd FROM extractos LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE extractos ADD COLUMN fecha_pagado_usd TEXT'); }

  // Backfill de estado_usd: ejecutar siempre que haya filas con estado_usd default
  // y datos USD coherentes (idempotente).
  //  - Si la fila no tiene saldo USD (pagoMinimoUsd y pagoTotalUsd en 0) → 'no_aplica'.
  //  - Si la fila estaba 'pagado' (COP) y tiene saldo USD, asumimos que la porción
  //    USD también se saldó al cerrar el extracto históricamente.
  db.prepare(`UPDATE extractos SET estado_usd='no_aplica'
    WHERE estado_usd='pendiente' AND COALESCE(pago_minimo_usd,0) <= 0 AND COALESCE(pago_total_usd,0) <= 0`).run();
  db.prepare(`UPDATE extractos SET estado_usd='pagado',
    monto_pagado_usd = COALESCE(NULLIF(monto_pagado_usd,0), pago_minimo_usd),
    fecha_pagado_usd = COALESCE(fecha_pagado_usd, fecha_pagado)
    WHERE estado_usd='pendiente' AND estado='pagado' AND COALESCE(pago_minimo_usd,0) > 0`).run();

  // Pagos: agregar columna moneda para distinguir entre pagos en COP y USD.
  // Default 'COP' para compatibilidad con todo lo que ya existe.
  try { db.prepare('SELECT moneda FROM pagos LIMIT 1').get(); }
  catch (e) { db.exec("ALTER TABLE pagos ADD COLUMN moneda TEXT DEFAULT 'COP'"); }

  // Bolsillo en USD: caché en compras + moneda en la tabla per-cuota.
  // Solo aplica a compras Mastercard/Amex con valor_usd > 0 (valor_cop = 0).
  // Para Visa, RappiCard, Nu: monto_bolsillo_usd siempre 0.
  try { db.prepare('SELECT monto_bolsillo_usd FROM compras LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE compras ADD COLUMN monto_bolsillo_usd REAL DEFAULT 0'); }
  try { db.prepare('SELECT moneda FROM bolsillo_cuotas LIMIT 1').get(); }
  catch (e) { db.exec("ALTER TABLE bolsillo_cuotas ADD COLUMN moneda TEXT DEFAULT 'COP'"); }

  // Redondear monto_bolsillo con decimales (fix comparacion cuotaCorte redondeada vs bolsillo decimal)
  db.prepare('UPDATE compras SET monto_bolsillo = ROUND(monto_bolsillo) WHERE monto_bolsillo != ROUND(monto_bolsillo)').run();
  db.prepare('UPDATE avances SET monto_bolsillo = ROUND(monto_bolsillo) WHERE monto_bolsillo != ROUND(monto_bolsillo)').run();
  db.prepare('UPDATE diferidas SET monto_bolsillo = ROUND(monto_bolsillo) WHERE monto_bolsillo IS NOT NULL AND monto_bolsillo != ROUND(monto_bolsillo)').run();

  // Migración de DATOS del estado legacy 'por_cobrar' → 'pagado'. El ESQUEMA de bolsillo_cuotas,
  // bolsillo_cuotas_avance, fechas_pago_custom, cortes_custom e historial ya se creó al INICIO de
  // initDb (antes de las migraciones), para tolerar BDs de versiones viejas que no tenían esas tablas.
  db.prepare("UPDATE compras SET tercero_pagado = 0 WHERE estado = 'por_cobrar' AND persona_id IS NOT NULL").run();
  db.prepare("UPDATE compras SET estado = 'pagado' WHERE estado = 'por_cobrar'").run();

  // Orden MANUAL dentro de un mismo día (v6.0.0). NULL = sin orden fijado: la fila cae al criterio
  // automático de siempre (última edición, luego id). Solo se materializa cuando el usuario toca las
  // flechas, así que una BD que nunca las use se ordena exactamente igual que antes.
  // Mismo patrón que `tarjetas.orden`, que ya se resuelve con COALESCE(orden, 999999).
  try { db.prepare('SELECT orden_dia FROM compras LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE compras ADD COLUMN orden_dia INTEGER'); }

  // A que CUOTA se adjudico un cruce de saldo a favor. NULL = compra de 1 cuota (la semantica de
  // v4.8.0), asi que el historico no se toca. Hace falta porque en una diferida el reembolso vive
  // por cuota en bolsillo_cuotas y `compras.monto_bolsillo` es solo un cache = SUM: sin saber la
  // cuota, deshacer un cruce tendria que restar del cache, y cualquier escritura per-cuota
  // posterior lo recalcula y resucita el reembolso -> el credito vuelve a estar disponible
  // mientras el bolsillo conserva el dinero, o sea la misma plata contada dos veces.
  try { db.prepare('SELECT cuota_num FROM aplicaciones_saldo_favor LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE aplicaciones_saldo_favor ADD COLUMN cuota_num INTEGER'); }

  // ANULACION (no es lo mismo que un reverso). El banco a veces carga y ANULA un movimiento el
  // mismo dia con la MISMA autorizacion: nunca entra a la facturacion. La compra se conserva para
  // auditoria pero queda inactiva: no suma a proyecciones, ni a la deuda del tercero, ni al extracto.
  try { db.prepare('SELECT anulada FROM compras LIMIT 1').get(); }
  catch (e) { db.exec('ALTER TABLE compras ADD COLUMN anulada INTEGER DEFAULT 0'); }

  // Limpieza de la tabla 'log' legacy (reemplazada por 'historial', creada arriba).
  try { db.exec('DROP TABLE IF EXISTS log'); } catch (e) {}
}

module.exports = { aplicarMigraciones };
