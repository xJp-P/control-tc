// backend/config/db/schema.js — FASE 1 del arranque: TODOS los CREATE TABLE.
//
// Se reparte POR FASE DE EJECUCION, jamas por entidad. Agrupar el CREATE de una tabla con las
// migraciones de sus columnas parece lo natural y es exactamente lo que reintrodujo el crash de
// v4.7.1: la migracion de la columna `moneda` corria ANTES del CREATE de bolsillo_cuotas y
// reventaba con "no such table" en las BDs que venian de una version vieja. No se ve con la BD
// actual del usuario ni con una vacia; solo con una degradada, que es justo lo que prueba R3.
//
// El orden que initDb tiene que respetar es: (1) CREATE de TODO, (2) ALTER de columnas,
// (3) migraciones de DATOS, (4) syncData.

function crearEsquema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS config (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS tarjetas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      banco TEXT,
      dia_corte INTEGER DEFAULT 30,
      dia_pago INTEGER DEFAULT 16,
      color TEXT DEFAULT '#4f8cff',
      imagen TEXT,
      tasa_mv_avances REAL DEFAULT 0.01911,
      tasa_mv_diferidas REAL DEFAULT 0.0188,
      url_tasas TEXT,
      cupo_total REAL DEFAULT 0,
      estado TEXT DEFAULT 'activa',
      notas TEXT,
      franquicia TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS personas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nombre TEXT NOT NULL,
      color TEXT DEFAULT '#666',
      orden INTEGER DEFAULT 0,
      telefono TEXT,
      notas TEXT
    );

    CREATE TABLE IF NOT EXISTS compras (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tarjeta_id INTEGER REFERENCES tarjetas(id),
      fecha TEXT NOT NULL,
      descripcion TEXT NOT NULL,
      valor_cop REAL NOT NULL,
      valor_usd REAL,
      persona_id INTEGER REFERENCES personas(id),
      estado TEXT DEFAULT 'pendiente',
      ciclo TEXT NOT NULL,
      notas TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS avances (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tarjeta_id INTEGER REFERENCES tarjetas(id),
      etiqueta TEXT NOT NULL,
      monto REAL NOT NULL,
      tasa_mv REAL NOT NULL,
      plazo INTEGER NOT NULL DEFAULT 24,
      fecha_desembolso TEXT NOT NULL,
      dia_corte INTEGER NOT NULL DEFAULT 30,
      estado TEXT DEFAULT 'activo',
      notas TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS abonos_avance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      avance_id INTEGER NOT NULL REFERENCES avances(id) ON DELETE CASCADE,
      fecha TEXT NOT NULL,
      monto REAL NOT NULL,
      notas TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS diferidas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tarjeta_id INTEGER REFERENCES tarjetas(id),
      etiqueta TEXT NOT NULL,
      monto REAL NOT NULL,
      tasa_mv REAL NOT NULL,
      num_cuotas INTEGER NOT NULL,
      fecha_compra TEXT NOT NULL,
      fecha_primer_corte TEXT NOT NULL,
      estado TEXT DEFAULT 'activo',
      notas TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS abonos_diferida (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      diferida_id INTEGER NOT NULL REFERENCES diferidas(id) ON DELETE CASCADE,
      fecha TEXT NOT NULL,
      monto REAL NOT NULL,
      notas TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS pagos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tarjeta_id INTEGER REFERENCES tarjetas(id),
      fecha TEXT NOT NULL,
      monto REAL NOT NULL,
      tipo TEXT DEFAULT 'pago_total',
      ciclo TEXT,
      notas TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS extractos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tarjeta_id INTEGER REFERENCES tarjetas(id),
      ciclo TEXT NOT NULL,
      fecha_corte TEXT NOT NULL,
      fecha_pago TEXT NOT NULL,
      pago_minimo REAL DEFAULT 0,
      pago_total REAL DEFAULT 0,
      monto_pagado REAL DEFAULT 0,
      estado TEXT DEFAULT 'pendiente',
      fecha_pagado TEXT,
      notas TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(tarjeta_id, ciclo)
    );

    CREATE TABLE IF NOT EXISTS bolsillo_cuotas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      compra_id INTEGER NOT NULL REFERENCES compras(id) ON DELETE CASCADE,
      cuota_num INTEGER NOT NULL,
      monto REAL NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(compra_id, cuota_num)
    );

    CREATE TABLE IF NOT EXISTS bolsillo_cuotas_avance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      avance_id INTEGER NOT NULL REFERENCES avances(id) ON DELETE CASCADE,
      cuota_num INTEGER NOT NULL,
      monto REAL NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(avance_id, cuota_num)
    );

    CREATE TABLE IF NOT EXISTS fechas_pago_custom (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tarjeta_id INTEGER NOT NULL REFERENCES tarjetas(id) ON DELETE CASCADE,
      ciclo TEXT NOT NULL,
      fecha_pago TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(tarjeta_id, ciclo)
    );

    -- Cifras OFICIALES impresas en el extracto del banco (v5.7.0). La app CALCULA el pago mínimo con
    -- su modelo, pero ese modelo nunca puede ser exacto: el banco cobra además interés sobre la cuota
    -- ya facturada hasta el día en que el usuario PAGA — información del futuro al proyectar (probado
    -- contra 10 extractos de RappiCard, ver docs/bancos/RappiCard_Visa.md §4.3). Cuando se concilia un
    -- PDF se guarda aquí el valor real, y la UI de pago lo usa en vez del estimado. NO reemplaza el
    -- cálculo (que sigue alimentando deuda, cupo y proyecciones): solo manda al registrar el pago.
    CREATE TABLE IF NOT EXISTS extractos_oficiales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tarjeta_id INTEGER NOT NULL REFERENCES tarjetas(id) ON DELETE CASCADE,
      ciclo TEXT NOT NULL,
      pago_minimo REAL,
      pago_total REAL,
      fuente TEXT DEFAULT 'conciliacion',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(tarjeta_id, ciclo)
    );

    -- Créditos por REVERSO de una compra PERSONAL (v5.9.9). Un reverso no es "tachar una compra":
    -- es dinero que entra, y el banco lo imputa a la deuda más vieja exigible. Por eso el crédito
    -- vive fuera del ciclo de su compra y lleva su propio destino: la compra se factura en SU ciclo
    -- (el banco la cobra) y el crédito reduce el mínimo de un ciclo ANTERIOR.
    -- Gemela de saldos_favor_tercero, que hace lo mismo para terceros; se separa porque aquella
    -- tiene persona_id NOT NULL y su ledger de terceros ya está en producción.
    CREATE TABLE IF NOT EXISTS creditos_reverso (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tarjeta_id INTEGER NOT NULL REFERENCES tarjetas(id) ON DELETE CASCADE,
      origen_compra_id INTEGER REFERENCES compras(id) ON DELETE SET NULL,
      monto REAL NOT NULL,
      fecha TEXT NOT NULL,
      ciclo_origen TEXT,
      ciclo_destino TEXT,
      estado TEXT NOT NULL DEFAULT 'activo',
      descripcion TEXT,
      notas TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS cortes_custom (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tarjeta_id INTEGER NOT NULL REFERENCES tarjetas(id) ON DELETE CASCADE,
      ciclo TEXT NOT NULL,
      fecha_corte TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(tarjeta_id, ciclo)
    );

    -- Saldo a Favor de terceros (Fase 2 — reversos). Crédito flotante que nace al reversar una compra
    -- de tercero que YA había reembolsado: esa plata queda a favor del tercero. Es por-PERSONA (su
    -- plata, sin importar la tarjeta). disponible = monto - monto_aplicado (derivado, no se persiste).
    CREATE TABLE IF NOT EXISTS saldos_favor_tercero (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      persona_id INTEGER NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
      monto REAL NOT NULL,
      monto_aplicado REAL NOT NULL DEFAULT 0,
      origen_tipo TEXT NOT NULL DEFAULT 'reverso',
      origen_compra_id INTEGER REFERENCES compras(id) ON DELETE SET NULL,
      tarjeta_id INTEGER REFERENCES tarjetas(id) ON DELETE SET NULL,
      descripcion TEXT,
      fecha TEXT NOT NULL,
      estado TEXT NOT NULL DEFAULT 'activo',
      notas TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- Ledger de "cruce de cuentas": a qué deuda del MISMO tercero (o a un cashout, con destino NULL) se
    -- adjudicó cada crédito. Permite auditar y DESHACER una aplicación. Espejo de abonos_diferida.
    CREATE TABLE IF NOT EXISTS aplicaciones_saldo_favor (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      saldo_favor_id INTEGER NOT NULL REFERENCES saldos_favor_tercero(id) ON DELETE CASCADE,
      compra_destino_id INTEGER REFERENCES compras(id) ON DELETE SET NULL,
      tipo TEXT NOT NULL DEFAULT 'cruce',
      monto REAL NOT NULL,
      fecha TEXT NOT NULL,
      notas TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    -- ─── MOTOR ROTATIVO (Libro Mayor de deuda) ─────────────────────────────────
    -- Un renglón por extracto (cierre mensual). Es la "masa que rueda": la deuda ya no se
    -- deriva sumando filas pendientes de UN ciclo, sino que hereda el saldo del cierre previo.
    -- Identidad de rotación: deuda_corte(N) = saldo_anterior(N) + compras + avances + otros +
    -- int_corriente - pagos ; y saldo_anterior(N+1) = deuda_corte(N). (Ver CLAUDE.md "Arquitectura
    -- Futura: Motor Rotativo".) NO alimenta la UI todavía (Fase 1 = infra + motor core).
    CREATE TABLE IF NOT EXISTS cierres_mensuales (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tarjeta_id INTEGER NOT NULL REFERENCES tarjetas(id) ON DELETE CASCADE,
      ciclo TEXT NOT NULL,
      fecha_corte TEXT,
      saldo_anterior REAL NOT NULL DEFAULT 0,
      compras_mes REAL NOT NULL DEFAULT 0,
      avances_mes REAL NOT NULL DEFAULT 0,
      otros_cargos REAL NOT NULL DEFAULT 0,
      int_corriente REAL NOT NULL DEFAULT 0,
      int_mora REAL NOT NULL DEFAULT 0,
      pagos_abonos REAL NOT NULL DEFAULT 0,
      deuda_corte REAL NOT NULL DEFAULT 0,
      pago_minimo REAL NOT NULL DEFAULT 0,
      cuota_transacciones REAL NOT NULL DEFAULT 0,
      cuota_avances REAL NOT NULL DEFAULT 0,
      estado TEXT NOT NULL DEFAULT 'pendiente',
      created_at TEXT DEFAULT (datetime('now','localtime')),
      UNIQUE(tarjeta_id, ciclo)
    );

    -- Pagos GLOBALES a la tarjeta (abonos "a la tarjeta", no a una compra específica). La cascada
    -- de pagos (waterfall) los reparte: mora -> int_corriente -> otros -> cuotas -> prepago capital.
    CREATE TABLE IF NOT EXISTS pagos_tarjeta (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tarjeta_id INTEGER NOT NULL REFERENCES tarjetas(id) ON DELETE CASCADE,
      fecha TEXT NOT NULL,
      monto REAL NOT NULL,
      ciclo TEXT,
      tipo TEXT NOT NULL DEFAULT 'pago_extracto',
      notas TEXT,
      created_at TEXT DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS historial (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      accion TEXT NOT NULL,
      descripcion TEXT NOT NULL,
      detalles TEXT,
      fecha TEXT DEFAULT (datetime('now','localtime'))
    );
  `);
}

module.exports = { crearEsquema };
