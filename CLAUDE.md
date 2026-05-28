# Control-TC — Convenciones para Agentes

Este archivo lo lee automáticamente Claude Code (y herramientas compatibles) al iniciar una sesión en esta carpeta. Sigue estas reglas en TODAS las interacciones con este proyecto.

---

## Comunicación

- **Idioma**: español siempre.
- **Tono**: directo, técnico, sin verbosidad innecesaria.
- **No usar emojis** en código, UI, mensajes ni commits. Para iconos visuales usar siempre el componente `Ico` con SVG (ver `public/index.html`, objeto `ICONS`). Si necesitas un icono nuevo, agrégalo a `ICONS` siguiendo el patrón existente (path SVG en viewBox 24×24).

---

## Versionado (`package.json`)

- Convención: **patch capado en 9**. Después de `2.X.9` → `2.(X+1).0`, NO `2.X.10`. Análogo para minor → major.
- Bump según magnitud del cambio:
  - **Patch** (X.Y.Z+1): fix puntual, ajuste UX menor, cambio de copy, optimización interna sin cambio de comportamiento.
  - **Minor** (X.Y+1.0): feature nuevo, refactor que cambia comportamiento observable, nueva tabla/columna en DB, nuevo endpoint, bundle de varios cambios relacionados.
  - **Major** (X+1.0.0): breaking change, rediseño arquitectónico, paradigma nuevo, migración de datos riesgosa.
- Cuando uses bump distinto al patch normal, **explica la decisión** en el mismo mensaje del commit.
- Si dudas entre dos niveles, optar por el menor.
- La instrucción explícita del usuario ("lánzalo como v2.X.Y") siempre prevalece sobre el juicio del agente.

---

## CHANGELOG (`public/index.html`, objeto `CHANGELOG`)

El changelog lo lee el usuario final cuando se actualiza la app. Debe ser entendible para alguien sin conocimientos de programación.

- **Evitar**:
  - Nombres de archivos, rutas, endpoints (`/api/...`, `public/index.html`).
  - Nombres de tablas o columnas de DB (`bolsillo_cuotas`, `monto_bolsillo`).
  - Términos técnicos: "refactor", "backend", "frontend", "UI", "badge", "modal", "endpoint", "upsert", "schema", "migración", "patch".
  - Inglés técnico mezclado con español.
  - Detalles de implementación que solo importan al desarrollador.

- **Hacer**:
  - Describir qué cambia desde la perspectiva del usuario (qué ve, qué puede hacer ahora).
  - Usar términos del dominio del producto (cuota, bolsillo, avance, extracto, corte, tarjeta).
  - Cuando un fix ataca un comportamiento confuso, explicar **qué pasaba antes** y **qué pasa ahora**.
  - Mantener cada ítem en una sola idea, breve.

**Ejemplo:**
- ❌ "Refactor backend: `/api/avances` devuelve `bolsillo_por_cuota`; `/avances/:id/bolsillo` acepta `cuota_num` para upsert per-cuota."
- ✅ "Cada cuota mensual de un avance guarda su propio bolsillo, igual que ya funcionaba con las compras diferidas."

---

## Flujo de commit & push

1. **Antes de push**: esperar a que el usuario verifique con `npm start` y confirme explícitamente. NO empujar cambios sin la luz verde del usuario.
2. **Siempre** hacer bump de versión en `package.json` antes de push. El auto-updater de electron-updater detecta cambios solo cuando cambia la versión.
3. **Siempre** agregar entrada nueva al objeto `CHANGELOG` en `public/index.html` (en lenguaje accesible — ver sección arriba).
4. **NUNCA** crear releases desde CLI (`gh release ...`). El usuario lanza el release manualmente desde GitHub Actions → Run Workflow.
5. **NUNCA** ejecutar `git push --force` ni reescribir historia sin permiso explícito.
6. **Nunca** usar `--no-verify` ni `--amend` salvo petición explícita.
7. Si el workflow aún no se ha ejecutado, los siguientes cambios pueden ir bajo la misma versión (push adicional). Si ya se ejecutó, bump nuevo.
8. **Mantener docs sincronizados (siempre que se haga commit & push)**: en el mismo commit del cambio, actualizar los documentos del proyecto cuando aplique:
   - `CLAUDE.md` — cronología "Decisiones recientes" + sección "Lógica de negocio sensible" si se agregó/cambió una regla.
   - `ESTADO_DEL_PROYECTO.md` — versión del encabezado, tabla de historial de versiones, funcionalidades.
   - `README.md` — solo si cambió una feature visible al usuario o la estructura del proyecto.
   Los `.md` NO se empaquetan en la app (no están en `files` de electron-builder), así que no disparan el auto-updater ni requieren bump de versión por sí solos. Incluirlos junto al código del mismo cambio mantiene el historial coherente.

### Plantilla de commit
```
<tipo>: <descripción concisa en español> (v<VERSION>)
```

Tipos: `feat`, `fix`, `docs`, `chore`, `refactor`.

---

## Estructura del proyecto

```
backend/                    # Node.js + Express + SQLite
├── routes/                 # Endpoints por recurso
│   ├── compras.js          # CRUD compras, intl-descripciones
│   ├── diferidas.js        # CRUD diferidas (per-cuota bolsillo)
│   ├── avances.js          # CRUD avances (per-cuota bolsillo)
│   ├── dashboard.js        # Cálculos agregados, cards principales
│   ├── extractos.js        # Listado de extractos, /pagar, fecha-pago-custom
│   ├── pagos.js            # Histórico de pagos
│   ├── terceros.js         # Vista por persona, abonos de terceros
│   ├── personas.js
│   ├── tarjetas.js
│   ├── abonoCapital.js     # Distribución multi-deuda de un abono
│   ├── abonos.js           # PUT/DELETE de abonos_avance
│   ├── proyecciones.js
│   ├── calculadora.js
│   ├── config.js           # config global + sync-bank-url
│   └── misc.js             # historial, scrape tasas
├── engine/
│   └── amortizacion.js     # Motor cuotas (Bancolombia, Nu esNu, Rappi)
├── helpers/
│   ├── banco.js            # esNuBank, nuOpts, avanceOpts, isDualExtracto, aplicaIntInternacional
│   ├── dates.js            # hoyLocal, addMonths, primerCorteAvance, calcCicloLocal, cicloActualStr
│   ├── log.js
│   └── scraper.js
├── config/
│   └── db.js               # Schema, migraciones, syncData() de auto-corrección
└── app.js                  # Entrypoint Express

public/index.html           # Frontend React monolítico (~5800 líneas, sin build, vía CDN)
desktop/main.js             # Electron main process (boot protegido de 4 fases — ver abajo)
docs/bancos/                # Documentación técnica por banco (Bancolombia Visa/MC/Amex, Nu, RappiCard)
build/                      # Iconos del instalador
package.json                # version + electron-builder config
```

- **DB**: SQLite vía `better-sqlite3`. Ruta resuelta dinámicamente vía `db_location.json` en `%APPDATA%\CreditCardManager\` (puede apuntar a una ubicación custom como Desktop/backup).

---

## Lógica de negocio sensible (no romper)

### Inmutabilidad de registros
- Compras, diferidas y avances en ciclos con extracto **pagado** NO se pueden editar ni eliminar.
- Backend devuelve **403 Forbidden** con mensaje claro; frontend oculta botones edit/delete.
- **Avances**: regla adicional — solo editables/eliminables si su `fecha_desembolso` cae en el ciclo actual (antigüedad < 1 mes).

### Reglas por banco
- **Nu**: flag `esNu` (helpers/banco.js) hace que la cuota 1 de diferidas tenga interés $0.
- **Bancolombia Visa**: única tarjeta que cobra intereses sobre compras internacionales en COP (`aplicaIntInternacional`). Mastercard/Amex Bancolombia tienen extracto dual USD/COP, no acumulan intereses intl en COP.
- **RappiCard**: cobra intereses sobre todas las compras; fecha pago = corte + 14 días.
- **Bancolombia**: flag `difiere_intereses_cuota1` por tarjeta — algunas Visa difieren intereses de cuota 1 → cuota 2.

### Bolsillo per-cuota
- Tablas: `bolsillo_cuotas` (diferidas) y `bolsillo_cuotas_avance`.
- Cada cuota mensual proyectada guarda su propio monto apartado.
- La columna `monto_bolsillo` en `avances` y en `compras` se mantiene como **cache = SUM** de los per-cuota (la usa el dashboard para "Saldo en Bolsillo").

### Sincronización compra ↔ diferida
- Al editar `fecha` o `tarjeta_id` de una compra con `diferida_id`, el endpoint `PUT /api/compras/:id` actualiza también `diferidas.fecha_compra`, `fecha_primer_corte` (recalculado) y `tarjeta_id`. Sin esto, las cuotas quedan en meses equivocados.
- `syncData()` en `config/db.js` tiene auto-heal retroactivo que detecta y arregla cualquier desincronización al arrancar la app.

### Fechas de pago manuales
- Tabla `fechas_pago_custom(tarjeta_id, ciclo, fecha_pago)` permite override visual de la fecha calculada (festivos, fines de semana). NO afecta cálculos de intereses, pago mínimo, etc. — solo display.

### Soporte bimonetario (COP/USD)
- Mastercard y Amex Bancolombia usan **extracto dual**: la deuda USD se rastrea aparte de la COP. El usuario puede saldar una porción sin la otra (`extractos.estado` para COP, `extractos.estado_usd` para USD).
- Compras USD puras: `valor_usd > 0` con `valor_cop = 0`. Bolsillo en USD vía `compras.monto_bolsillo_usd` y `bolsillo_cuotas.moneda`.
- TRM diaria: `GET /api/trm-actual` consulta el dataset abierto del Banco de la República (datos.gov.co) con fallback a config. Se usa para estimar cupo usado en COP y como tasa por defecto al registrar compras USD en tarjetas duales.

### Conversión compra dividida → personal
- Endpoint transaccional `POST /api/compras/grupo/:grupoId/merge-personal`: funde las partes de un `grupo_id` en una sola compra personal (`persona_id=NULL`), suma valores y bolsillo, recompone `estado`. Soporta 1 cuota y diferidas (merge de diferidas + `bolsillo_cuotas`, limpio por linealidad de la amortización).
- **Bloqueo crítico**: si una parte tiene reembolso real de tercero (`tercero_pagado=1` o `tercero_monto_abonado>0`) → **409** con detalle; solo procede con `force:true` (doble confirmación en UI que lista los abonos a eliminar). NO confundir con `monto_bolsillo` (plata propia apartada — se conserva al fundir).
- El número de cuotas (1↔N) **solo se define al crear** la compra; el campo se bloquea en edición para no dejar registros "a medias" entre contado y diferida. Al editar, el `estado` de bolsillo se recalcula dinámicamente (no se fuerza a `pendiente`).

### Boot protegido (desktop/main.js)
- El arranque pasa por 4 fases: (1) preflight sin BD, (2) splash inmediato, (3) chequeo de actualizaciones boot-blocking (max 60s; Win: `autoUpdater`, Mac: GitHub API), (4) recién ahí `startBackend()` conecta la BD. Esto blinda la BD: si hay una actualización con un fix crítico, se instala ANTES de que código viejo toque los datos.
- `createApp` se hace **lazy require** dentro de `startBackend()` (no en el top-level) para garantizar que la BD no se abra antes del chequeo.
- Sin internet (timeout) → vista offline con Continuar/Cerrar. Error de descarga → vista con "Cerrar app"/"Continuar de todos modos". El banner in-app post-boot (Configurador) sigue vivo vía `setupAutoUpdater()` en fase 4.

---

## Antes de tocar datos en la DB

1. **Auditar primero**: crear script temporal en `scripts/` que use Electron + `better-sqlite3` para inspeccionar el estado real.
   - Plantilla: `scripts/audit_X.js` + `scripts/audit_X_main.js` (este último arranca Electron y requiere el primero).
   - Ejecutar: `npx electron scripts/audit_X_main.js`.
2. **Explicar la causa raíz** al usuario con datos concretos antes de proponer fix.
3. **Proponer la acción** (mostrar el SQL o el código) y esperar confirmación antes de ejecutar destructivos.
4. **Cleanup**: borrar scripts temporales (`rm -f scripts/audit_X*.js scripts/fix_X*.js`) al terminar.
5. Si el fix amerita prevenir recurrencia, añadir un paso al `syncData()` en `config/db.js` para auto-heal de DBs de otros usuarios.

---

## Asistente Inteligente INTL (referencia rápida)

Implementado en v2.9.0. Endpoint `GET /api/compras/intl-descripciones` devuelve descripciones (lowercased, deduplicadas) que actualmente tienen ≥1 compra con `es_internacional=1`. Frontend (`CompraForm`) lo fetcha al montar y muestra un aviso naranja con icono `bulb` cuando: tarjeta es Bancolombia Visa (`aplicaIntlForm`), descripción tiene ≥3 chars, hay match substring case-insensitive, y el checkbox aún no está marcado. Aprende/desaprende solo (query en tiempo real).

---

## Memoria operativa

- **No usar herramientas de preview** en chat (configuración del usuario).
- **No crear documentación** (`*.md`, READMEs) salvo petición explícita.
- Para tareas con muchos pasos, considera `TaskCreate` para tracking.
- Si dudas sobre comportamiento, **lee el código fuente actual** antes de asumir — el proyecto evoluciona y las memorias pueden estar desactualizadas.

---

## Decisiones recientes (cronología abreviada)

- **v2.7.x**: integración Nu (esNu, interés $0 cuota 1), fixes de inmutabilidad temporal en navegación, fechas de pago manuales, refactor bolsillo per-cuota para avances.
- **v2.8.0**: inmutabilidad de registros (403 en backend, ocultar botones en frontend), badge "Pagado" unificado en columna Estado.
- **v2.8.1**: sync compra↔diferida + auto-heal retroactivo.
- **v2.8.2**: nueva columna "Responsable" en tablas, reordenamientos, badge "Dividida" en azul.
- **v2.8.3**: fusión de columnas Bolsillo+Estado en Diferidas y Avances; alineación pixel-perfect entre tablas Compras y Diferidas vía `<colgroup>`.
- **v2.9.0**: asistente INTL proactivo en `CompraForm` + iconos del CHANGELOG más legibles.
- **v3.0.0**: convenciones para agentes (`CLAUDE.md` en raíz del proyecto) + campo `orden` en tarjetas con migration y backfill + sección colapsable "Historial / Inactivas" en nav bar + exclusión de tarjetas inactivas en aggregates del Dashboard global. Bump a major por convención cap-at-9 (de `2.9.X` siguiente es `3.0.0`, no `2.10.0`).
- **v3.1.0**: soporte bimonetario integral (COP/USD) en compras, extractos, pagos y bolsillo (Mastercard/Amex Bancolombia con extracto dual) + integración TRM diaria del Banco de la República (datos.gov.co) + rediseño de cards del dashboard en formato "dos pisos" cuando hay saldo USD.
- **v3.1.1–3.1.2**: bolsillo en USD; filtro de terceros pulido (visibilidad según ciclo pagado + reembolso); desglose de la card "Deuda Personal" (Compras/Avances/Diferidas/Int Intl).
- **v3.2.0–3.2.3**: boot protegido (splash + chequeo de actualizaciones pre-BD, 4 fases en `desktop/main.js`) — protege la BD de bugs en código viejo. Vista offline sin internet; error de descarga con "Cerrar app" o "Continuar de todos modos"; porcentaje de descarga visible.
- **v3.3.0**: convertir compra dividida → 100% personal (endpoint `merge-personal` transaccional + bloqueo 409 si un tercero ya reembolsó, con escape hatch `force:true`) + fix de estado de bolsillo al editar + campo cuotas bloqueado en edición + validaciones de división (sin filas vacías ni personas duplicadas).

## Próxima sesión (pendiente)
- **Parser de extractos**: el usuario va a importar el histórico de una tarjeta antigua. Diseñar `backend/helpers/extractoParser.js` (pure function texto/CSV → array de compras + metadata), endpoint `POST /api/extractos/import`, y UI de subida en vista de tarjeta inactiva o sección Configuración. Antes de implementar, pedir al usuario el formato exacto del extracto (PDF copiado / CSV / Excel) y una muestra representativa.
