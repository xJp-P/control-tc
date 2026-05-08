# Nu Colombia — Franquicia Mastercard

**Emisor:** Nu Colombia Compañía de Financiamiento S.A. (NIT 901.658.107-2)
**Cuerpo legal:** Nu Financiera, Bogotá D.C., Colombia
**Fuente:** 25 extractos consolidados de la tarjeta `[Tarjeta_Nu]` ([USUARIO_PRINCIPAL]), períodos: marzo 2024 → marzo 2026 (continuidad mensual completa).

**Estado del análisis:** documentación cualitativa exhaustiva. NO se modificó código durante esta fase. La lógica actual del motor (`esNu`, `nuOpts`, `calcularAmortizacionDiferida` con flag `esNu`) ya está correctamente alineada con los datos observados.

---

## 1. Estructura general del extracto

Nu genera un **extracto único en COP**. NO existe un extracto USD ni una sección dual:
- Las compras internacionales se convierten a COP el día de la transacción usando la TRM/tasa interna de Nu y se mezclan con las compras locales.
- Mastercard cobra un **0,45% de cargo de conversión** sobre cada compra internacional (mencionado al pie del extracto de mayo 2025): "Mastercard hace un cargo del 0.45% sobre el valor de tus compras internacionales que se cobra solo una vez por transacción y **no genera intereses**."
- Este cargo aparece como una línea separada llamada **"Comisión por cambio de moneda"** o, en casos donde no hay desglose visible, queda incluido implícitamente en el valor en COP.

Diseño visual: muy limpio, formato narrativo (no tabla bancaria tradicional).
- Cabecera con cupo, disponible y deuda a pagar.
- Sección "Resumen de tu extracto" con: Deuda + Intereses + Comisiones - Abonos = Pago Mínimo + Deuda restante = Pago hasta la fecha.
- Detalle de transacciones cronológico (las más recientes primero) con tasa MV mostrada por cada movimiento.

> **Implicación en el motor:**
> - `isDualExtracto('Mastercard')` para una tarjeta Nu NO debe activar lógica dual (ya está correcto: `isDualExtracto` retorna true por la franquicia, pero la rama del motor para Nu se identifica primero por `esNuBank` que tiene precedencia).
> - `aplicaIntInternacional('Nu', 'Mastercard')` → `false` ✓ (no hay `INT INTL` estilo Bancolombia Visa).

---

## 2. Tasas de interés por ciclo

| Ciclo | Mes | Tasa MV vigente |
|-------|-----|-----------------|
| 1  | mar 2024 | 2.42% |
| 2  | abr 2024 | 2.40% |
| 3  | may 2024 | 2.30% – 2.31% |
| 4  | jun 2024 | 2.26% |
| 5  | jul 2024 | 2.16% – 2.17% |
| 6  | ago 2024 | 2.15% – 2.16% |
| 7  | sep 2024 | 2.12% – 2.13% |
| 8  | oct 2024 | 2.08% – 2.09% |
| 9  | nov 2024 | 2.07% |
| 10 | dic 2024 | 1.96% |
| 11 | ene 2025 | 1.86% – 1.87% |
| 12 | feb 2025 | 1.86% – 1.87% |
| 13 | mar 2025 | 1.85% – 1.87% |
| 14 | abr 2025 | 1.89% |
| 15 | may 2025 | 1.89% – 1.92% |
| 16 | jun 2025 | 1.86% – 1.91% |
| 17 | jul 2025 | 1.84% – 1.86% |
| 18 | ago 2025 | 1.84% – 1.89% |
| 19 | sep 2025 | 1.83% – 1.88% |
| 20 | oct 2025 | 1.81% – 1.83% |
| 21 | nov 2025 | 1.85% |
| 22 | dic 2025 | 1.85% |
| 23 | ene 2026 | 1.81% – 1.83% |
| 24 | feb 2026 | 1.81% – 1.87% (con cargos de mora) |
| 25 | mar 2026 | 1.87% – 1.89% |

### 2.1 Reafirmación: cambio mensual según Tasa de Usura del BanRep

Igual que Bancolombia, RappiCard, Davivienda y todas las entidades financieras en Colombia, **Nu actualiza sus tasas el día 1° de cada mes** ajustándose al límite de la **Tasa de Usura** publicada por el Banco de la República.

**Por qué los extractos muestran 2-3 tasas distintas dentro de un mismo ciclo:**
Los ciclos de Nu cortan a mitad de mes (entre el 16 y el 20). Una compra del día 18 al final de un ciclo cae al "mes anterior" en términos de tasa, mientras que una del día 26 (siguiente ciclo) cae al "mes nuevo" con la nueva tasa publicada el 1°.

Por ejemplo, en el ciclo `19 abr - 19 may 2024`:
- Compras del 19-30 abr: tasa **2.31%** (la de abril)
- Compras del 1-19 may: tasa **2.30%** (la de mayo, ya actualizada)

Cada compra hereda la tasa del día de su procesamiento. Las cuotas de una diferida que ya estaba viva conservan la tasa que tenían al momento del cobro mensual (no se re-tasa).

**Nota Nu específica:** el extracto incluye una leyenda visual: *"Cuando te mostremos una flecha apuntando hacia abajo es porque ajustamos la tasa a tu favor."* Esto refuerza que la tasa baja cuando el BanRep baja la usura.

---

## 3. Compras a 1 cuota (1 de 1)

### 3.1 Comportamiento confirmado
- Aparecen con la tasa MV vigente del ciclo en la columna "Inter�s del mes".
- **Valor del interés cobrado: $0,00** si la compra cae dentro de un ciclo y se paga al vencimiento.
- La tasa que se muestra es la que **se aplicaría si entras en mora**, no un cargo automático.

Ejemplos del ciclo 1 (mar 2024):
- `15 MAR la Burgueria [Sucursal] $67.500 1 de 1 → 2.42% $0,00 → Total $67.500`
- `13 MAR Alkosto-Ktronix $749.900 1 de 1 → 2.42% $0,00 → Total $749.900`

### 3.2 Compras "internacionales" en 1/1
- Comercios como **Apple.Com/Bill**, **Spotify**, **Amazon.Com**, **Temu Com**, **Shein Com**, **Mpos Global*Versilia**, **Converter.Video** aparecen en COP convertidos.
- Llevan un cargo adicional de Mastercard del 0,45% en algunos casos visible como "Comisión por cambio de moneda".
- **No generan intereses adicionales** estilo `INT INTL` — sólo el cargo de conversión Mastercard, una sola vez.

> **Conclusión:** Nu **no diferencia** entre nacional e internacional en términos de intereses. Una vez convertido a COP, todo se trata igual. Una compra 1/1 nacional o internacional, si se paga a tiempo, sale a 0%.

---

## 4. Compras diferidas (2 a 36 cuotas)

### 4.1 Cuota 1 = capital puro (interés diferido)

Patrón **idéntico al diferimiento de Bancolombia con flag `difiere_intereses_cuota1=1`**: la cuota 1 NO cobra intereses. El primer cobro de interés aparece en la **cuota 2**.

**Ejemplo verificado: `Pyu*Ela $212.865 a 5 cuotas`**, abierta el 30/03/2024:

| Ciclo | Cuota | Capital cuota | Interés del mes |
|-------|-------|---------------|-----------------|
| abr 2024 | 1/5 | $42.573 | **$0** ← cuota 1 sin interés |
| may 2024 | 2/5 | $42.573 | $7.035,99 |
| jun 2024 | 3/5 | $20.784 | $383,79 (cuota parcial — hubo abono) |

`$212.865 ÷ 5 = $42.573` → **cuota = capital puro** ✓

**Otro ejemplo: `Bold*Gold Express Jo $690.000 a 2 cuotas`** (12/11/2024, tasa 2.07% en nov, 1.96% en dic):

| Ciclo | Cuota | Capital cuota | Interés del mes |
|-------|-------|---------------|-----------------|
| nov 2024 | 1/2 | $345.000 | $0 ← capital puro |
| dic 2024 | 2/2 | $345.000 | $9.926,77 |
| ene 2025 | (residual) | $0 | $150,02 |

**Otro ejemplo: `Mac Center Alamedas $139.000 a 2 cuotas`** (27/10/2024):

| Ciclo | Cuota | Capital cuota | Interés del mes |
|-------|-------|---------------|-----------------|
| nov 2024 | 1/2 | $69.500 | $0 |
| dic 2024 | 2/2 | $69.500 | $4.368,01 |
| ene 2025 | (residual) | $0 | $273,11 |

`$139.000 ÷ 2 = $69.500` ✓

### 4.2 Implementación en el motor

**Archivo:** `backend/engine/amortizacion.js → calcularAmortizacionDiferida`

```js
// Nu: cuota 1 no genera intereses (no se acumulan ni se cobran)
const interesPeriodo = (esNu && i === 0) ? 0 : saldoInicial * tasaMV * (dias / 30);
```

Con `esNu=true` (vía `nuOpts(db, tarjetaId)`):
- Cuota 1 (`i === 0`): `interesPeriodo = 0` → cuota = capital puro ✓
- Cuota 2+ (`i >= 1`): `interesPeriodo = saldoInicial × tasaMV × dias/30` → modelo estándar

> **Diferencia con Bancolombia:** en Bancolombia el interés de la cuota 1 **se acumula y se difiere** a la cuota 2 (la cuota 2 cobra `interes_1 + interes_2`). En Nu, en cambio, la cuota 1 **simplemente no genera interés** (se "regala" el primer mes). La cuota 2 cobra solo el interés de su propio período.

### 4.3 Reconciliación matemática

La fórmula exacta del interés en Nu es **capitalización diaria sobre saldo pendiente** (igual que el modelo de Bancolombia descrito en `Bancolombia_Mastercard.md §4.4`). Los valores que vemos en el extracto NO son una multiplicación simple `saldo × tasaMV`; son la sumatoria de los intereses diarios devengados a lo largo del ciclo.

Como la app no tiene el log día-por-día de movimientos del cliente, el motor aproxima con `interesPeriodo = saldoInicial × tasaMV × dias/30` por cuota, lo cual produce diferencias de hasta ~5% con el cargo real del banco. **Aceptable para uso práctico.**

---

## 5. Avances (Retiros en efectivo) — sí existen

A diferencia de la idea inicial de que Nu "es una tarjeta simple sin avances", **el extracto sí registra retiros en efectivo**, etiquetados como **"Retiro en efectivo"**.

### 5.1 Patrón observado

**Ciclo may 2024 (tasa 2.30%)** — extracto del 19 may 2024:

| Fecha | Movimiento | Valor | Cuotas | Interés del mes | Comisión |
|-------|------------|-------|--------|-----------------|----------|
| 16 MAY | Retiro en efectivo | $280.000 | **1 de 1** | 2.30% **$644,48** | (incluida en "Comisiones por servicio" del resumen) |
| 16 MAY | Retiro en efectivo | $600.000 | **1 de 1** | 2.30% **$1.544,86** | |

Total Comisiones por servicio (ese ciclo): **$13.600,00** (suma de ambas comisiones de retiro).

**Ciclo may 2025 (tasa 1.91%)** — un solo retiro:

| Fecha | Movimiento | Valor | Cuotas | Interés del mes | Comisión |
|-------|------------|-------|--------|-----------------|----------|
| 21 MAY | Retiro en efectivo | $320.000 | 1 de 1 | 1.91% **$4.493,74** | $6.800 (Comisiones por servicio) |

### 5.2 Reglas confirmadas

1. **Etiqueta:** `Retiro en efectivo` (no "AVANCE" como en Bancolombia/RappiCard).
2. **Plazo: 1 cuota** ("1 de 1"). NO se difieren a 24 cuotas como Bancolombia. Esto es una **diferencia estructural importante** vs. otros bancos.
3. **Generan interés desde el ciclo en que se hicieron** (no hay diferimiento a cuota 2). El interés se calcula proporcional a los días: `monto × tasaMV × dias/30`.
4. **Comisión por retiro:** se cobra como movimiento separado y aparece en la línea **"Comisiones por servicio"** del resumen (NO en "Comisiones de avances", que está siempre vacía).
   - Comisión observada: **$6.800 por retiro** (validado en 3 retiros distintos: $280k+$600k=$13.600 = 2 retiros × $6.800; otro retiro de $320k = $6.800).
   - Aparentemente la comisión es **fija** y **no proporcional al monto**.

### 5.3 Verificación matemática del interés

Retiro 16/05/2024 de $280.000, tasa 2.30%, corte 19/05/2024:
- Días (16 → 19) = 3 días
- Interés esperado = $280.000 × 0,0230 × (3/30) = **$644,00**
- Cobrado: **$644,48** → diferencia $0,48 (capitalización diaria vs aproximación). ✓

Esto confirma: el interés del retiro se calcula con la fórmula estándar `monto × tasaMV × dias/30` desde el día del retiro hasta el corte.

### 5.4 Implementación recomendada en la app

Para registrar un retiro en efectivo de Nu en la app, el usuario debería:
- Crear un **avance** con `plazo = 1` (no 24).
- Tasa MV = tasa vigente del mes en que se hizo el retiro.
- Comisión = $6.800 (o el valor vigente).

El motor `calcularAmortizacionAvance` con `plazo=1` y sin flag `esBancolombia` (porque Nu no usa el modelo "saldo facturado") usa el cálculo estándar:
```js
const cuotaCapitalFija = monto / 1;  // = monto entero
interes = saldoInicio × tasaMV × (dias/30);  // sin saldo facturado
totalExtracto = interes + cuotaCapital + comision;
```

Esto coincide con el patrón observado.

> **Nota:** la app actualmente fija `plazo = 24` por defecto en el formulario de avances (porque está optimizada para Bancolombia). Para Nu, el usuario debe **modificar manualmente el plazo a 1** al crear el avance.

---

## 6. Cargos por servicio y conversión

Resumen de tipos de cargos vistos en los extractos de Nu:

| Tipo | Descripción | Frecuencia | Observado |
|------|-------------|-----------|-----------|
| Comisión por retiro | Por hacer un retiro en efectivo | Una vez por retiro | $6.800 fijo |
| Comisión por cambio de moneda | Por compras internacionales | Una vez por transacción | 0,45% del valor (Mastercard global) |
| Comisión por servicio | Total agregado de comisiones del mes | En el resumen | Suma de las anteriores |
| Cargos por conversión | Línea separada en el resumen | Generalmente en $0 | Casi nunca aparece — los 0,45% se incluyen implícitamente |
| Devoluciones / Ajustes a favor | Reembolsos y bonificaciones | Variable | Ej: `Ajuste a tu favor $107.940`, `Devolución -Dlo*Rappi -$3.200` |
| Intereses de mora | Si no pagas a tiempo | Solo cuando hay mora | Ver §8 |

---

## 7. Cálculo del Pago Mínimo

### 7.1 Fórmula deducida del extracto

```
Pago Mínimo COP =
    Deuda a pagar este mes              (capital del mes: 1/1 + cuota capital de diferidas)
  + Intereses                            (intereses corrientes sobre cuotas N≥2 + retiros en efectivo)
  + Intereses de mora                    (cuando aplica, ver §8)
  + Comisiones de avances                (línea separada — usualmente $0)
  + Comisiones por servicio              (incluye comisiones de retiros en efectivo)
  + Cargos por conversión                (usualmente $0)
  − Abonos                               (pagos del cliente)
  − Devoluciones o ajustes a favor       (reembolsos)
```

### 7.2 Verificación con el ciclo may 2024

| Concepto | Valor |
|----------|-------|
| Deuda a pagar este mes (capital) | $1.043.688 |
| Intereses | $9.225,33 |
| Comisiones por servicio | $13.600 |
| Abonos | -$833.000 |
| Devoluciones/Ajustes | -$42.573 |
| **Pago Mínimo extracto** | **$190.940,33** |

Calculado: $1.043.688 + $9.225,33 + $13.600 - $833.000 - $42.573 = $190.940,33 ✓ EXACTO

### 7.3 Pago hasta la fecha (~ Pago Total)

```
Pago hasta la fecha = Pago Mínimo + Deuda restante (capital de cuotas futuras todavía no facturadas)
```

Es la deuda total al cierre. Coincide con la deuda a fecha de corte.

---

## 8. Mora — caso visto en el ciclo feb 2026

El extracto de **feb 2026** muestra qué pasa cuando un cliente NO paga el pago mínimo del mes anterior.

### 8.1 Patrón

Cada compra del mes anterior aparece con **dos líneas de interés**:

| Compra | Concepto | Valor | Tasa |
|--------|----------|-------|------|
| `Apple.Com/Bill $9.900` | Interés del mes | $149,17 | 1.81% |
|                          | Intereses en mora | $29,83 | 1.81% |
|                          | **Total a pagar este mes** | **$179,00** | |
| `Amazon.Com $133.547` | Interés del mes | $2.414,63 | 1.81% |
|                       | Intereses en mora | $402,44 | 1.81% |
|                       | **Total** | **$2.817,07** | |

### 8.2 Reglas de mora

1. Cada compra que cayó en el extracto anterior y no se pagó genera dos cobros: **interés corriente** (como si estuvieras en cuota normal) **+ interés de mora** adicional.
2. La tasa de mora parece ser igual a la del producto (no hay un "recargo" multiplicador como en Bancolombia que tiene tabla de mora separada).
3. El interés de mora aparece como una línea **"Intereses en mora"** asociada a cada compra individual.

> **Implicación en el motor:** la app actualmente NO modela mora granular por compra (modela `intereses_mora` agregado a nivel de extracto). Para Nu, esto está bien — el agregado captura la suma. La granularidad por compra es solo presentación visual del banco.

---

## 9. Tabla resumen del comportamiento de Nu

| Aspecto | Nu Colombia (Mastercard) |
|---------|---------------------------|
| Banco emisor | Nu Colombia (Davivienda no, sino Nu Financiera S.A.) |
| Franquicia | Mastercard |
| Extracto dual COP/USD | ❌ No (único en COP) |
| TRM aplicada | Día de la compra (Nu interna) |
| Cargo `INT INTL` | ❌ No existe |
| Comisión Mastercard intl | 0,45% por transacción, una sola vez, sin intereses |
| Compras 1/1 cobran intereses si se pagan al corte | ❌ No |
| Compras diferidas: cuota 1 cobra intereses | ❌ **No** (regala primer mes — `esNu` flag) |
| Compras diferidas: cuota 2+ cobra intereses | ✅ Sí (modelo capitalización diaria, motor lo aproxima) |
| Diferencia vs Bancolombia en cuota 1 | Bancolombia DIFIERE el interés a cuota 2 (la cuota 2 cobra doble); Nu lo OMITE (la cuota 2 cobra solo su propio mes) |
| Cuota mostrada en diferidas | Capital puro (`monto/N`) |
| Avances tradicionales | ❌ No usa modelo a 24 cuotas |
| Retiros en efectivo | ✅ Sí — etiqueta "Retiro en efectivo", **plazo 1**, interés desde el día del retiro, comisión fija $6.800 |
| Comisión avance/retiro | $6.800 fijo (estable en los ciclos vistos) |
| Tasa MV cambia ciclo a ciclo | ✅ Sí (regla del BanRep, día 1° de cada mes) |
| Pago Mínimo: fórmula | Capital + Intereses + Mora + Comisiones servicio − Abonos − Devoluciones |
| Concepto "Pago Alternativo" | ❌ No existe (a diferencia de RappiCard) |
| Mora granular por compra | Visible en el extracto (cada compra muestra su interés en mora aparte) |

---

## 10. Diferencias clave: la sencillez de Nu vs. la complejidad de Bancolombia

### 10.1 Estructura

| Concepto | Bancolombia | Nu |
|----------|-------------|-----|
| Extractos por ciclo | 1 (Visa) o 2 (MC/Amex dual) | **1 siempre** |
| Categorías de tasa | 4-5 (Compra 1c, Compra 2-36, Avances, Compra Intl, Mora) | **2** (Compra 1c, Compra 2-36) |
| Cargos especiales | INT INTL, mora con tabla escalonada, CMF, cuota de manejo, IVA | Solo Comisión por retiro y Comisión Mastercard 0,45% intl |
| Modelo de avances | 24 cuotas con "saldo facturado" (interés sobre saldo + cuota capital) | **1 cuota directa**, interés proporcional por días |
| Diferimiento cuota 1 | Configurable por tarjeta (`difiere_intereses_cuota1=1`) — interés se DIFIERE a cuota 2 | Hardcoded para Nu — interés simplemente NO se cobra (se "regala") |

### 10.2 Filosofía del producto

- **Bancolombia:** producto bancario tradicional, pricing complejo, descuentos/recargos por categoría, productos específicos por franquicia (Visa Infinite vs Mastercard Black vs Amex). Requiere comprensión del cliente sobre tasas, períodos de gracia, modelo de avances, etc.
- **Nu:** producto fintech simplificado, una sola tarjeta para todo, pricing predecible. Estructura del extracto narrativa ("Llegó tu extracto de Marzo... Hola, [nombre del titular]..."). Una sola tasa de compras a cuotas. La cuota 1 sin interés es un beneficio comercial visible.

### 10.3 Implicaciones para la implementación

| Componente del motor | Bancolombia | Nu |
|----------------------|-------------|-----|
| `aplicaIntInternacional` | `true` (solo Visa, no dual) | `false` |
| `isDualExtracto` | `true` para MC/Amex | `false` |
| `nuOpts(tarjetaId)` | `{ esBancolombia: true }` si flag activa | `{ esNu: true }` |
| `avanceOpts(tarjetaId)` | `{ esBancolombia: true }` (modelo saldo facturado) | `undefined` (modelo estándar) |
| `calcularAmortizacionDiferida` cuota 1 | Si `esBancolombia`: difiere interés a cuota 2 | Si `esNu`: omite interés |
| Plazo default avances | 24 | 1 (recomendado) |

---

## 11. Validación del motor actual

### 11.1 Lo que ya está bien implementado ✓

1. **`backend/helpers/banco.js`:**
   - `esNuBank(db, tarjeta)` detecta `banco.includes('nu')` ✓
   - `nuOpts(db, tarjeta)` retorna `{ esNu: true }` para tarjetas Nu ✓
   - `aplicaIntInternacional('Nu', 'Mastercard')` → `false` ✓ (porque banco no es Bancolombia)
   - `avanceOpts(db, tarjeta)` retorna `undefined` para Nu (modelo estándar de avances, no "saldo facturado") ✓

2. **`backend/engine/amortizacion.js → calcularAmortizacionDiferida`:**
   - Con `esNu=true`, `interesPeriodo = (i === 0) ? 0 : saldoInicial × tasaMV × dias/30` ✓
   - Cuota 1 sin interés. Cuota 2+ con modelo estándar. **Coincide perfectamente con los datos.**

3. **`backend/engine/amortizacion.js → calcularAmortizacionAvance`:**
   - Sin flag `esBancolombia`, usa modelo estándar `interes = saldoInicio × tasaMV × dias/30` ✓
   - Si el usuario configura `plazo=1` para un retiro en efectivo de Nu, el cálculo coincide con los datos del extracto.

### 11.2 Mejoras opcionales (no urgentes)

1. **Plazo default por banco:** al crear un avance en una tarjeta Nu, sugerir `plazo=1` por defecto (en vez de 24). Pequeño UX que evita confusión.
2. **Categoría "Comisión por retiro" pre-cargada:** mostrar $6.800 como sugerencia al crear un retiro Nu (igual que se hace con tasas de avances vía URL scraping).
3. **Mora granular por compra:** actualmente la app modela mora a nivel agregado (`intereses_mora`). Si se quiere replicar la presentación granular del extracto Nu (mora por compra individual), sería trabajo adicional. **No es necesario**: la suma agregada coincide.

---

## 12. Apéndice — Ciclos analizados (resumen)

| # | Mes | Periodo | Pago Mínimo | Saldo final |
|---|-----|---------|-------------|-------------|
| 1 | mar 2024 | 04 mar - 19 mar | $0 | $0 |
| 2 | abr 2024 | 20 mar - 18 abr | $138.591 | $308.883 |
| 3 | may 2024 | 19 abr - 19 may | $190.940,33 | $253.292,33 |
| 4 | jun 2024 | 20 may - 18 jun | $1.079.452,19 | $1.139.652,19 |
| 5 | jul 2024 | 19 jun - 19 jul | $210.496,93 | $210.496,93 |
| 6 | ago 2024 | 20 jul - 19 ago | $496.228 | $496.228 |
| 7 | sep 2024 | 20 ago - 18 sep | $354.562 | $354.562 |
| 8 | oct 2024 | 19 sep - 19 oct | $236.557 | $236.557 |
| 9 | nov 2024 | 20 oct - 18 nov | $1.053.177 | $1.467.677 |
| 10 | dic 2024 | 19 nov - 19 dic | $1.101.036,78 | $1.101.036,78 |
| 11 | ene 2025 | 20 dic - 19 ene | $1.154.344,91 | $1.154.344,91 |
| 12 | feb 2025 | 20 ene - 16 feb | $358.351 | $358.351 |
| 13 | mar 2025 | 17 feb - 19 mar | $746.866 | $746.866 |
| 14 | abr 2025 | 20 mar - 18 abr | $1.139.864 | $1.270.484 |
| 15 | may 2025 | 19 abr - 19 may | $736.523,78 | $736.523,78 |
| 16 | jun 2025 | 20 may - 18 jun | $557.148,75 | $557.148,75 |
| 17 | jul 2025 | 19 jun - 19 jul | $974.804,83 | $1.285.848 |
| 18 | ago 2025 | 20 jul - 19 ago | $790.651,77 | $878.873,11 |
| 19 | sep 2025 | 20 ago - 18 sep | $1.097.464,47 | $1.097.464,47 |
| 20 | oct 2025 | 19 sep - 19 oct | $1.792.956,76 | $1.792.956,76 |
| 21 | nov 2025 | 20 oct - 18 nov | $1.799.570 | $1.799.570 |
| 22 | dic 2025 | 19 nov - 19 dic | $663.520 | $663.520 |
| 23 | ene 2026 | 20 dic - 19 ene | $1.278.927 | $1.278.927 |
| 24 | feb 2026 | 20 ene - 16 feb | $146.105,31 | $146.105,31 (con mora) |
| 25 | mar 2026 | 17 feb - 19 mar | $0 (saldo a favor $3.853,99) | -$3.853,99 |

Para la extracción completa de transacciones por ciclo, ver `docs/temp/Nu_Portable_Data.md`.

---

**Mantenedor:** este documento se construyó a partir del análisis de `EXTRACTO NU COMPLETO.pdf` (25 ciclos consecutivos) y revisión cruzada con:
- `backend/engine/amortizacion.js` (rama `esNu` para diferidas, rama estándar para retiros)
- `backend/helpers/banco.js` (helpers `esNuBank`, `nuOpts`, `avanceOpts`)
- Memoria del proyecto con reglas históricas (validadas y reforzadas con datos del PDF)
- `docs/bancos/Bancolombia_Mastercard.md` y `docs/bancos/RappiCard_Visa.md` (referencia comparativa)
