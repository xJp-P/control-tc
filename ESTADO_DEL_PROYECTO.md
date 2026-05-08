# Estado del Proyecto — Control TC

**Versión:** 2.7.4  
**Fecha de pausa:** 2026-05-XX  
**Repositorio:** https://github.com/xJp-P/control-tc

---

## Resumen Ejecutivo

App de escritorio (Electron + React + SQLite) para gestión personal de tarjetas de crédito. Soporta múltiples bancos con motores de cálculo diferenciados, extractos mensuales, amortización de avances y diferidas, bolsillo, deudas de terceros y actualizaciones automáticas desde GitHub Releases.

La versión 2.6.5 es la última versión funcional y estable. Este archivo documenta el estado exacto en que se archivó el proyecto.

---

## Stack Tecnológico

| Componente      | Tecnología                                  |
|-----------------|---------------------------------------------|
| Escritorio      | Electron 33                                 |
| Backend         | Express 4 (local en `127.0.0.1:3500`)       |
| Base de datos   | SQLite via `better-sqlite3`                 |
| Frontend        | React 18 UMD (sin build step, todo en `public/index.html`) |
| Instalador Win  | NSIS (electron-builder)                     |
| Instalador Mac  | DMG + ZIP (electron-builder)                |
| Auto-update     | electron-updater + GitHub Releases          |
| CI/CD           | GitHub Actions (`.github/workflows/build.yml`) |

### Comandos para levantar el entorno

```bash
# Instalar dependencias (una sola vez)
npm install

# Ejecutar en desarrollo
npm start          # Electron completo
npm run dev        # Electron con NODE_ENV=development (abre DevTools)
npm run server     # Solo el backend Express (para depurar sin Electron)

# Compilar instaladores (requiere push a GitHub y lanzar workflow manualmente)
# GitHub Actions > Build Instaladores > Run workflow
```

> **Nota:** Los releases/instaladores NO se crean localmente. El usuario lanza el workflow `Build Instaladores` manualmente desde GitHub Actions. El workflow construye para Windows (NSIS) y Mac (DMG + ZIP) y publica el release en GitHub.

---

## Estructura del Proyecto

```
├── desktop/
│   ├── main.js          # Proceso principal Electron: ventana, IPC handlers, auto-updater
│   └── preload.js       # Bridge seguro Electron ↔ frontend (contextBridge)
├── backend/
│   ├── app.js           # Factory createApp: monta Express y todas las rutas
│   ├── config/
│   │   └── db.js        # Paths de BD, initDb (schema + migraciones + syncData)
│   ├── engine/
│   │   └── amortizacion.js  # Motores de cálculo: avances y diferidas (funciones puras)
│   ├── helpers/
│   │   ├── dates.js     # Utilidades de fecha: hoyLocal, addMonths, daysBetween
│   │   ├── banco.js     # Detección de banco/franquicia: esNuBank, nuOpts, isDualExtracto
│   │   ├── scraper.js   # Web scraping y extracción de texto PDF para tasas
│   │   └── log.js       # Factory de logAction y tjNombre (requiere DB)
│   └── routes/
│       ├── config.js        # GET/PUT /api/config
│       ├── tarjetas.js      # CRUD /api/tarjetas + actualizar-tasas
│       ├── personas.js      # CRUD /api/personas
│       ├── compras.js       # CRUD /api/compras + bolsillo
│       ├── avances.js       # CRUD /api/avances + abonos
│       ├── abonos.js        # PUT/DELETE /api/abonos/:id
│       ├── diferidas.js     # CRUD /api/diferidas
│       ├── pagos.js         # CRUD /api/pagos (con lógica de reversión)
│       ├── extractos.js     # /api/extractos + pagar (incluye helper calcExtracto)
│       ├── abonoCapital.js  # /api/abono-capital (preview + apply)
│       ├── terceros.js      # /api/terceros (toggle + abonar)
│       ├── dashboard.js     # /api/dashboard
│       ├── proyecciones.js  # /api/proyecciones
│       └── misc.js          # /api/backup, /api/log, /api/sync, /api/scrape-tasas
├── public/
│   └── index.html       # UI completa en React 18 UMD (un solo archivo, ~9500 líneas)
├── build/
│   ├── icon.ico         # Icono Windows
│   └── icon.png         # Icono general (Mac y otros)
├── .github/
│   └── workflows/
│       └── build.yml    # CI/CD: compila y publica releases en GitHub
├── .claudesignore       # Excluye node_modules, dist, build, archivos .db
├── package.json         # v2.3.0 — main: "desktop/main.js", files apunta a desktop/ y backend/
└── ESTADO_DEL_PROYECTO.md  # Este archivo — versión actual, changelog y arquitectura
```


---

## Bancos Soportados

| Banco                  | Franquicia        | Compras                             | Diferidas             | Extracto                | Tasas automáticas |
|------------------------|-------------------|-------------------------------------|-----------------------|-------------------------|-------------------|
| Bancolombia            | Visa, MC, Amex    | 1-de-1 sin intereses corrientes     | Configurable por tarjeta: difiere cuota 1→2, o cobra desde cuota 1 | Dual COP/USD (MC, Amex) | Web scraping      |
| Nu Colombia            | Mastercard        | 1-de-1 sin intereses corrientes     | Cuota 1 sin intereses | COP único               | PDF oficial       |
| RappiCard (Davivienda) | Visa              | 1-de-1 COP sin intereses corrientes | Interés desde cuota 1 | COP único               | PDF               |

---

## Funcionalidades Completas y Operativas (v2.3.0)

### Multi-banco y Multi-tarjeta
- Motor de cálculo diferenciado por banco y franquicia
- Tasas MV independientes por tarjeta (avances y diferidas)
- Actualización automática de tasas desde web/PDF de cada banco

### Compras
- Compras en COP y USD con conversión automática por tasa
- Estado de **bolsillo**: apartar dinero para una compra (total o parcial)
- **Bolsillo per-cuota para diferidas**: cada cuota (1/3, 2/3, 3/3) tiene su propio estado de bolsillo independiente, almacenado en tabla `bolsillo_cuotas`
- **Dividir compras** entre varias personas con desglose visual
- Bolsillo por parte individual en compras divididas (incluyendo cuotas de diferidas divididas)

### Avances
- Tabla de amortización completa (capital fijo + interés por tramos)
- Abonos a capital con redistribución cronológica automática

### Diferidas
- Amortización a X cuotas con seguimiento por ciclo
- Badge con número de cuota actual (1/3, 2/3...)
- Diferidas divididas: cuota proporcional por persona

### Extractos
- Auto-generados mensualmente por tarjeta
- Pago mínimo y pago total calculados automáticamente
- Historial de pagos (abonos parciales y pago completo)
- Compras marcadas como pagadas solo al completar el pago mínimo

### Sincronización de datos (`syncData`)
- Se ejecuta al iniciar la app para corregir inconsistencias
- Redistribuye abonos a capital cronológicamente
- Compras de extractos pagados no se revierten en sincronización
- Pasos 1-10 bien definidos en `server.js`

### Dashboard
- Mega card Cupo Total con barra de progreso (color dinámico según uso)
- Deuda vs Disponible en la misma card
- Desglose: avances, diferidas, compras
- Cards: Compras del Ciclo, Me Deben (con desglose por persona), Intereses del Mes
- Grid de tarjetas con stats por tarjeta

### Terceros
- Compras asignadas a personas con colores identificativos
- Tracking de deuda: "Me debe" / "Te pagó"
- Abonos parciales de terceros
- Vista consolidada por persona y ciclo (solo card "Me Deben")

### Proyecciones
- Proyección de pagos futuros a N meses

### Sistema
- Tema claro/oscuro
- Backup y restauración de la base de datos
- Mover BD a ubicación personalizada (iCloud, OneDrive, etc.)
- Actualizaciones automáticas desde GitHub Releases (Windows y Mac)
- Changelog en-app al actualizar
- Historial de acciones (log de operaciones)

---

## Pendientes y Decisiones de Diseño Conocidas

### Pendientes menores (no bloqueantes)
- El cache `_nuCache` en `server.js` no se invalida si cambia el banco de una tarjeta — requiere reiniciar la app para reflejar el cambio.
- El workflow `build.yml` en Windows no declara explícitamente `setup-python` (aunque `windows-latest` lo trae preinstalado). No ha causado problemas.

### Decisiones de diseño importantes
- **Pago mínimo es indivisible**: las compras solo se marcan como `pagado` cuando se paga el pago mínimo completo, respetando la lógica real de Bancolombia (el pago mínimo cubre compras + cuotas + intereses como un bloque).
- **Revertir extracto eliminado**: no existe botón "Revertir" en el historial de extractos porque en la realidad bancaria un pago no se puede deshacer.
- **Extracto dual solo para MC y Amex**: Bancolombia Visa convierte USD a COP directamente, sin extracto dual.

---

## Base de Datos

El esquema SQLite se crea y migra automáticamente en `server.js` al iniciar. Las migraciones están implementadas con bloques `try/catch` sobre `ALTER TABLE`.

**La BD NO está en el repositorio.** El usuario gestiona sus propios backups. La ruta por defecto es:
- Windows: `%APPDATA%\control-tc\data.db`
- Mac: `~/Library/Application Support/control-tc/data.db`

---

## Historial de Versiones Relevante

| Versión | Cambios clave |
|---------|---------------|
| 2.6.5   | **Reconciliación matemática con extracto Bancolombia abril 2026 Visa Platinum**: cerramos ~80% del desfase histórico ($32,790 → $6,801 en pago mínimo) · **Modelo "saldo facturado" para avances Bancolombia**: el banco cobra intereses sobre `saldoInicio + cuotaCapital` (cycle 2+), no sobre saldo amortizado — confirmado matemáticamente vs extracto · Nuevo helper `avanceOpts(db, tarjetaId)` similar a `nuOpts` para diferidas · Engine `calcularAmortizacionAvance` acepta opts.esBancolombia · Todas las rutas que llaman al engine pasan los opts correctos · **Nuevo flag `es_internacional` en compras**: marca compras de Apple/Rappi/MercadoPago etc. que cobran en COP pero el banco trata como intl (acumulan intereses MV) · Migration en db.js, columna en SQL, checkbox UI debajo de "Compra en USD" · Fix syncData diferidas: solo liquidar si TODOS los ciclos involucrados tienen extracto pagado (antes liquidaba apenas las cuotas pasaban su corte, ocultando cuotas pendientes en el ciclo activo) |
| 2.6.4   | Bolsillo per-cuota + cambios v2.6.2 (mismo changelog que 2.6.2 — bump para forzar update) |
| 2.6.3   | Docs: actualización de ESTADO_DEL_PROYECTO con changelog completo de v2.6.1 y v2.6.2 |
| 2.6.2   | **Bolsillo per-cuota (refactor arquitectural)**: nueva tabla `bolsillo_cuotas (compra_id, cuota_num, monto)` con `UNIQUE(compra_id, cuota_num)` — el estado del bolsillo es completamente independiente para cada cuota (1/3, 2/3, 3/3) de una diferida · Fix crítico: modal personales (botones "Apartar todo", "Apartar restante", "Quitar") no enviaban `cuota_num` al backend → guardaban globalmente sin registrar la cuota específica · Fix: "Cuota 1/undefined" en modal → "Cuota 1/3" (faltaba `cuotas_total` en objeto pasado al modal) · Terceros: reemplazada lógica acumulativa (`bolConsumed`/`bolRestante`/`primerNoCub`) por lookup per-cuota directo desde `monto_bolsillo_cuota` · Dashboard `meDebenCorte`: lookup por cuota específica desde `bolsillo_cuotas` · Diferidas: nuevo campo `bolsillo_por_cuota` (`{cuota_num: monto}`) en respuesta API · Backend `compras.js GET`: enriquece diferidas con `monto_bolsillo_cuota` para la cuota activa · Upsert garantizado con `ON CONFLICT DO UPDATE` · Fix endpoint modal: detecta `_isDiferida` para diferidas sin compra vinculada (usa `/diferidas/:id/bolsillo` en vez de `/compras/`) · Limpieza de dato residual en BD (monto_bolsillo global incorrecto en compra personal) |
| 2.6.1   | Fix "Me Deben Corte": amortización de diferidas divididas usaba `dif.monto` (total) en vez de `c.valor_cop` (porción del tercero) → cuota inflada, bolsillo insuficiente para cubrirla · Fix Compras: badge cuota "N/X" usaba `hoy` para encontrar la cuota activa en vez del `ciclo` consultado → mostraba "2/3" al ver abril desde mayo · Fix badges bolsillo: eliminada lógica que forzaba "Pagado" por fecha/ciclo en vez de por estado real del bolsillo (`esPassCuota` y `q.pagada → "Pagado"` removidos) |
| 2.6.0   | Reorganización Resumen: card "Me Deben" (total histórico) movida a la fila superior junto a Deuda Total, Cupo, Próximo Corte, Tasas MV · "Datos del Corte" ahora tiene dos cards nuevas: **Deuda Personal** (compras + cuotas avances + cuotas diferidas no-tercero del ciclo + intereses USD) y **Me Deben Corte** (lo que cada tercero debe SOLO en este ciclo, con desglose por persona, calculado por amortización de cuotas para diferidas) · Backend dashboard.js: nuevos campos `deudaPersonal` y `meDebenCorte` · La card "Me Deben" del Resumen replica EXACTAMENTE la fórmula de la card "Me deben" en Terceros — diferidas usan cuotas no pagadas no cubiertas por bolsillo, 1-cuota usa `valor_cop - monto_bolsillo`, así apartar al bolsillo afecta consistentemente ambas cards |
| 2.5.2   | Resumen: bolsillo habilitado también para partes de tercero en compras divididas a 1 cuota — los botones de Bolsillo en Resumen y Terceros quedan conectados (misma fuente: `monto_bolsillo`) · Pagos: el extracto expandido agrupa diferidas divididas como fila padre + hijas (capital/interés/total por persona), igual que las compras a 1 cuota · Backend `extractos.js` enriquece `detalle_diferidas` con `compra_id`/`grupo_id`/`persona_id`/`persona_nombre`/`persona_color` (LEFT JOIN con la compra vinculada) |
| 2.5.1   | Pagos: extracto expandido agrupa compras divididas por `grupo_id` (fila padre + hijas con persona, igual que en Resumen) · Bolsillo habilitado para parte "Personal" de compras divididas a 1 cuota (antes solo las partes de tercero podían ir a bolsillo) · Backend `extractos.js` enriquece `detalleCompras` con `grupo_id`/`persona_id`/`persona_nombre` |
| 2.5.0   | **Bancolombia diferidas configurable por tarjeta**: nueva columna `difiere_intereses_cuota1` en `tarjetas` (solo aplica a Bancolombia) · Cuando es 1, cuota 1 acumula intereses y cuota 2 los cobra junto con los suyos; cuando es 0, comportamiento estándar (cobra desde cuota 1) · Modal bloqueante al iniciar la app para que el usuario configure cada tarjeta Bancolombia · Nuevo campo en `TarjetaForm` visible solo para Bancolombia · Endpoints `/api/tarjetas/pendientes-config` y `/api/tarjetas/:id/difiere-intereses` · Helper `clearBancoCache(id)` |
| 2.4.4   | Bolsillo modal simplificado: eliminado toggle "+ Agregar / = Establecer total" — siempre suma al monto existente cuando hay bolsillo parcial · Aplica en Resumen (Compras, Avances, Diferidas) y en Terceros |
| 2.4.3   | Terceros: modal de bolsillo completo (parcial/total/quitar) para diferidas y compras normales · Badge morado de progreso para abonos parciales · Totales reflejan bolsillo en tiempo real |
| 2.4.2   | Terceros diferidas: ecosistema limpio — botones "Pagado" y "Abonar" reemplazados por un único botón "Bolsillo" conectado con Resumen · Misma fuente de verdad (`monto_bolsillo`) en ambas secciones · Simplificación interna: eliminada lógica `cubierta_abono`/`abonadoRestante` |
| 2.4.1   | Fix terceros: "Pagado" en cuota diferida ya solo registra esa cuota (antes marcaba todas las futuras) · Badge "En bolsillo" → "Pagado" cuando el bolsillo cubre la cuota |
| 2.4.0   | Avances: botón de editar solo aparece si el avance se desembolsó en el ciclo actual — ciclos pasados y futuros son de solo lectura |
| 2.3.9   | Editar compras divididas: botón de editar en fila padre (grupo), agrega/quita personas, cambia montos · Fix bug cupo: borrar compra ahora también borra diferida huérfana · Hijas del grupo sin botón de editar individual |
| 2.3.8   | Bolsillo universal para diferidas: diferidas sin compra vinculada (ej: RappiCard) ahora tienen columna Bolsillo clickable · endpoint PUT /diferidas/:id/bolsillo · dashboard suma monto_bolsillo de diferidas directas |
| 2.3.7   | Fix RappiCard/Davivienda: fecha_pago = fecha_corte + 14 días (helper addDays) · Compras "1 de 1" en COP sin intereses (solo USD y diferidas devengan) · pago_total ahora suma intereses corrientes del mes · Reducción del desbalance vs PDF de ~$24K a <0.07% |
| 2.3.6   | Nueva sección Calculadora: amortización de avances y diferidas con auto-carga de tasas desde tarjeta seleccionada |
| 2.3.5   | Dashboard: mini-columnas en Cupo Total + desglose Intereses del Mes (Diferidas/Avances) · "Int Intl" renombrado en Pago Mínimo |
| 2.3.4   | Cards de tarjeta: mini-columnas en subtexto (Deuda Total, Tasas MV, Pago Mínimo, Me Deben) · Terceros: totales por ciclo inline al lado del mes · Header de persona rediseñado |
| 2.3.3   | Fix bolsillo_parcial falso en diferidas divididas (redondeo centavos) · Bolsillo para Diferidas en Movimientos · Cuota Corte en rojo en tabla Diferidas |
| 2.3.2   | Bolsillo para avances: apartar el valor de la cuota del corte · Dashboard suma bolsillo de avances al cupo disponible · Badges PAGADO en ciclos pasados (avances, diferidas, compras) |
| 2.3.1   | Refactorización arquitectónica: server.js → 20 módulos en backend/ · main.js/preload.js → desktop/ · scripts/ · .claudesignore |
| 2.3.0   | Mega card Cupo Total con barra de progreso · Bolsillo para diferidas · Limpieza general de código |
| 2.2.5   | Fix syncData: compras pagadas no se revierten · Pago mínimo all-or-nothing · Eliminar botón Revertir |
| 2.2.4   | Card naranja próximos pagos (≤5 días) · Fix modal cerrar |
| 2.2.2   | Fix: Visa no muestra mínimo USD/COP separado |
| 2.2.1   | Cuota del ciclo en diferidas (1/3, 2/3…) · Fix arranque DB |
| 2.2.0   | Soporte Nu Bank · Parser PDF ToUnicode CMap · Tasas automáticas Nu |
| 2.1.5   | Compras diferidas divididas muestran cuota del corte |
| 2.1.4   | Dividir compras entre personas con desglose visual |
| 2.0.0   | Arquitectura multi-banco · RappiCard/Davivienda |
