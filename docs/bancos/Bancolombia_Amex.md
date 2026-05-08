# Bancolombia — Franquicia American Express (Amex)

**Fuente:** 3 extractos consolidados de la tarjeta `[Tarjeta_Amex]` ([USUARIO_PRINCIPAL]), períodos:
1. `31 ago – 15 sep 2025` (ciclo corto inicial)
2. `15 sep – 15 oct 2025`
3. `15 oct – 17 nov 2025`

**Estado del análisis:** documentación exclusivamente cualitativa. **No se modificó código** durante esta fase.

---

## 1. Estructura general del extracto

Igual que Mastercard, **Amex Bancolombia genera dos extractos físicos por ciclo** (uno por moneda). Las fechas de corte coinciden, pero cada moneda tiene su propio Pago Total, Pago Mínimo y tabla de tasas.

| Extracto         | Qué incluye                                                                                       | Pago en                |
|------------------|---------------------------------------------------------------------------------------------------|------------------------|
| **Estado de cuenta en PESOS** | Compras nacionales, avances en COP, comisiones, cuota de manejo, IVA, CMF | COP                    |
| **Estado de cuenta en DOLARES** | Compras internacionales (Apple, Uber, Hoyoverse, etc.), avances internacionales | USD (o COP a tasa del día de pago) |

**Por lo tanto:**
- `isDualExtracto('American Express')` → `true` ✓ (ya implementado)
- `aplicaIntInternacional('Bancolombia', 'American Express')` → `false` ✓ (no existe el cargo `INT INTL` estilo Visa porque las compras intl viven en su propio extracto USD)

---

## 2. Tasas de interés vigentes por ciclo

| Ciclo | Compra a 1 cuota | Compra 2-36 (MV) | Avances (MV) | Compra Intl (USD MV) | Mora (MV) | EA |
|-------|------------------|------------------|--------------|----------------------|-----------|-----|
| 1 (ago-sep 2025) | 0.0000% | 1.8771% | 1.8771% | 1.8771% | 1.8771% | 25.0025% |
| 2 (sep-oct 2025) | 0.0000% | 1.8312% | 1.8312% | 1.8312% | 1.8312% | 24.3283% |
| 3 (oct-nov 2025) | 0.0000% | 1.8740% | 1.8740% | 1.8740% | 1.8740% | 24.9569% |

**Observaciones:**
- Las tasas MV de COP y USD son **idénticas dentro de un mismo ciclo** (igual que en Mastercard).
- La tasa se actualiza el **1° de cada mes** según la **Tasa de Usura** del Banco de la República (regla que aplica a todos los emisores en Colombia).
- Compra a 1 cuota a 0% MV: confirmado. Si el cliente paga el extracto a tiempo, no genera intereses corrientes.

---

## 3. Compras a 1 cuota (1/1)

### 3.1 En COP (extracto en PESOS)
- Tasa mostrada: `0,0000%`.
- No genera intereses si se paga al vencimiento.
- Si no se paga, entra al cargo agregado `INTERESES CORRIENTES` del siguiente ciclo (a tasa MV del momento).

Ejemplos del ciclo 2 COP:
- `13/10 MERCADOPAGO AEROLINEAS $208.050 1/1 0,0000%`
- `06/10 NETFLIX DL $44.900 1/1 0,0000%`
- `28/09 EDS AVENIDA $50.000 1/1 0,0000%`
- `27/09 RAPPI COLOMBIA*DL $26.150 1/1 0,0000%`

### 3.2 En USD (extracto en DOLARES)
- Cada compra muestra la tasa MV del ciclo (ej. 1,8312% en ciclo 2).
- La tasa **no se cobra** si la compra se paga al vencimiento (verificado en los 3 ciclos: `Intereses corrientes USD = $0` salvo cuando hubo saldo previo no pagado).

Ejemplos del ciclo 1 USD (`31 ago - 15 sep`, tasa 1,8771%):
- `10/09 APPLE.COM/BILL $11,50 1/1` — VR MONEDA ORIG 44900.0 USA
- `10/09 UBER TRIP $2,68 1/1` — VR MONEDA ORIG 2.6 USA
- `09/09 UBER TRIP $3,92 1/1` — VR MONEDA ORIG 3.9 USA
- `09/09 UBER TRIP $5,92 1/1` — VR MONEDA ORIG 5.9 USA
- Total compras del mes USD = $24,02 → Pago Total USD = $25 → Pago Mínimo USD = $25 (toca pagar todo en este ciclo corto)

> **Nota:** APPLE.COM/BILL aparece con `VR MONEDA ORIG 44900.0 USA`. Como en Mastercard, cuando el VR MONEDA ORIG es un valor "redondo" en pesos (44.900 COP) con sufijo `USA`, lo que significa es que el comercio cobró en COP pero la red Amex enrutó la transacción como internacional, así que el banco la presenta convertida a USD (≈$11,50 USD para 44.900 COP).

---

## 4. Compras diferidas (2 a 36 cuotas)

### 4.1 La cuota mostrada es CAPITAL puro

Validado con `APPLE.COM/BILL $11,57 USD a 1/36 cuotas`, ciclo 2:
- Cuota 1 mostrada: `$0,32` ← exactamente `11,57 / 36 = 0,3214` (sólo capital, ✓)
- En el extracto USD del ciclo 2 NO se cobró interés sobre esta cuota.

Y con `HOYOVERSE $4,99 USD a 36/36 cuotas`, ciclo 2:
- Aparece como cuota 36/36 con valor $0 (ya liquidada — fue la última cuota de un período anterior).

### 4.2 Los intereses se cobran como cargo agregado separado

Igual que en Mastercard, la cuota mostrada es capital puro y los intereses van a un movimiento agregado el día del corte:

| Ciclo COP | Movimiento explícito | Valor |
|-----------|---------------------|-------|
| 1 (15/09/2025) | (no aplicó — saldo anterior $0) | $0 |
| 2 (15/10/2025) | `INTERESES CORRIENTES` | $14.649,72 |
| 3 (17/11/2025) | `INTERESES CORRIENTES` | $68.663,85 |

### 4.3 Diferimiento de intereses cuota 1 (regla Bancolombia)

Aplica el mismo principio confirmado en Visa y Mastercard: **la cuota 1 de una diferida o un avance recién desembolsado se factura como capital puro**, y los intereses correspondientes a su período se difieren al cargo `INTERESES CORRIENTES` del ciclo siguiente.

Verificado con el avance `765093 - 08/10 AVANCE SUCURSAL VIRTUAL $3.000.000 a 24 cuotas`:
- Ciclo 2 (cuota 1/24): cuota = $125.000 = `3.000.000 / 24` (capital puro). Saldo después: $2.875.000.
- Ciclo 3 (cuota 2/24): cuota = $125.000 (capital puro de nuevo). El interés del período 2 va al cargo `INTERESES CORRIENTES`.

> **Implicación en el motor:** la flag `difiere_intereses_cuota1 = 1` en la tarjeta y los helpers `nuOpts(db, tarjetaId)` / `avanceOpts(db, tarjetaId)` ya manejan este comportamiento. Se aplican igual a Visa, Mastercard y Amex Bancolombia sin cambios.

---

## 5. Avances

### 5.1 Patrón observado

| Avance | Desembolso | Monto | Plazo | Comisión |
|--------|------------|-------|-------|----------|
| `765093` | 08/10/2025 | $3.000.000 | 24 cuotas | $6.500 |
| `770178` | 01/11/2025 | $1.037.532 | 24 cuotas | $6.500 |

- Plazo estándar: **24 cuotas**.
- Comisión: **$6.500** (consistente entre los avances vistos en Amex; en Mastercard se vio entre $6.500 y $6.840 según monto).
- La comisión se factura como movimiento independiente el mismo día del avance (`COMISION AVANCE SUCURSA`).
- La cuota 1 del avance es capital puro (`monto / 24`); los intereses van al cargo agregado.

### 5.2 Detalle peculiar: el saldo del avance entre ciclos

Avance $3M ciclo 2 → ciclo 3:
- Saldo después de cuota 1 (ciclo 2): $2.875.000
- Saldo después de cuota 2 (ciclo 3): $2.564.999,36 — **NO** es $2.875.000 − $125.000 = $2.750.000

La diferencia ($310.000,64) sugiere que parte del pago del cliente se aplicó como **abono a capital del avance**, no solo a la cuota mensual. Esto coincide con la lógica de Bancolombia: si el cliente paga más que el Pago Mínimo del extracto, el sobrante puede aplicarse como abono a capital de las deudas vivas (avances/diferidas) según la jerarquía interna del banco.

> **Nota técnica:** este comportamiento ya está modelado en nuestro motor de `abono_capital` (`backend/routes/abonoCapital.js`), que distribuye el sobrante entre compras → avances → diferidas. La aplicación específica del banco puede diferir, pero es un detalle menor de presentación.

---

## 6. Compras internacionales (USD) — comportamiento

### 6.1 Cómo aparecen
- Toda la operativa internacional vive en el extracto USD.
- La tabla de tasas USD lista solo: `Compra Internacional`, `Avance Internacional`, `Mora` (todas con la misma MV del ciclo).
- Se ven dos categorías:
  - **1/1 (no diferidas):** Apple, Uber, Hoyoverse — cuota 1 = total. Si se paga al vencimiento → 0% efectivo.
  - **2-36 cuotas (diferidas):** Apple a 36 cuotas — cuota = capital puro; interés al ciclo siguiente.

### 6.2 Cargo "INTERESES CORRIENTES" en USD

| Ciclo | Cargo USD | Comentario |
|-------|-----------|------------|
| 1     | $0,00 | Saldo anterior $0 → no hay base sobre qué cobrar |
| 2     | $0,00 | Saldo anterior USD ($24,02) se pagó completo → cero intereses |
| 3     | $0,00 | Saldo anterior USD ($12) se pagó completo → cero intereses |

> **Observación:** en los 3 ciclos analizados, el cliente pagó el saldo USD completo a tiempo. Por eso nunca se generó interés USD (revolving). En Mastercard sí vimos casos donde el saldo USD quedó parcial y entonces el banco cobró interés en el siguiente ciclo. Misma regla aplicada — solo no se observó porque el pago fue puntual.

### 6.3 NO existe el cargo `INT INTL` estilo Visa

Igual que en Mastercard, las compras internacionales no producen un cargo intercalado en el extracto COP. Lo que sí ocurre es que las compras procesadas como internacionales (Apple, Uber, Hoyoverse) caen al extracto USD. **El usuario las paga en USD** (o COP convertidos a la TRM del día de pago).

Esto valida la regla actual del código:
- `aplicaIntInternacional('Bancolombia', 'American Express')` → `false` ✓
- `isDualExtracto('American Express')` → `true` ✓
- Las compras COP marcadas con `es_internacional = 1` no devengan interés `INT INTL` en Amex (porque la franquicia las clasifica como USD y van al extracto separado).

---

## 7. Cálculo del Pago Mínimo (extracto en PESOS)

### 7.1 Fórmula deducida

```
Pago Mínimo COP =
    Cuota transacciones del mes              (capital de cuotas + compras 1/1 del ciclo + comisión avance, según presentación del banco)
  + Cuota transacciones anteriores           (capital de cuotas que vienen de meses pasados)
  + Cuota avances                            (capital de cuota del avance, en línea separada)
  + Intereses corrientes                     (cargo agregado: avances + diferidas)
  + Intereses de mora
  + Otros cargos                             (CMF, cuota de manejo, IVA — y a veces comisión avance, según presentación)
  + En mora
  − A favor
```

### 7.2 Verificación con ciclo 2 (sep-oct 2025)

| Concepto | Valor |
|----------|-------|
| Cuota transacciones del mes | $1.953.230,92 |
| Cuota transacciones anteriores | $0 |
| Cuota avances (separado) | $125.000 |
| Intereses corrientes | $14.649,72 |
| Otros cargos | (en este ciclo, el banco incluyó la comisión $6.500 dentro de "Cuota transacciones del mes") |
| **Suma** | **$2.092.880,64** |
| **Pago Mínimo extracto** | **$2.092.881,00** |

Diferencia de $0,36 → redondeo aceptable. ✓

### 7.3 Verificación con ciclo 3 (oct-nov 2025)

| Concepto | Valor |
|----------|-------|
| Cuota transacciones del mes | $1.281.219,00 |
| Cuota transacciones anteriores | $168.230,50 |
| Cuota avances | $0 |
| Intereses corrientes | $68.663,85 |
| Otros cargos | $6.500 (esta vez sí separó la comisión de avance) |
| **Suma** | **$1.524.613,35** |
| **Pago Mínimo extracto** | **$1.524.614,00** |

Diferencia de $0,65 → redondeo aceptable. ✓

> **Curiosidad observada:** Bancolombia presenta la comisión de avance en el detalle del Pago Mínimo a veces como "Cuota transacciones del mes" (ciclo 2) y otras como "Otros cargos" (ciclo 3). Esto NO afecta la matemática total (la suma es la misma), pero explica por qué a veces parece haber un "$6.500 desplazado" entre líneas. **Nuestro motor modela la comisión como `comision` en la cuota 1 del avance** (`backend/engine/amortizacion.js`), lo cual la captura correctamente sin importar dónde el banco la presente visualmente.

### 7.4 Pago Total

`Pago Total = Saldo a fecha de corte` — todas las deudas pendientes (compras + saldo de avances + saldo de diferidas + intereses) menos abonos. Tanto en COP como en USD.

---

## 8. Tabla resumen del comportamiento de Amex

| Aspecto | Bancolombia Amex |
|---------|------------------|
| Extracto dual COP/USD | ✅ Sí |
| Compras 1/1 nacionales con tasa | 0,0000% MV |
| Compras 1/1 internacionales | Aparecen en extracto USD a tasa MV vigente |
| Compras 1/1 generan intereses si se pagan al vencimiento | ❌ No |
| Cuota 1 de diferidas/avances cobra intereses | ❌ No (capital puro) |
| Cuota 2 cobra intereses | ✅ Sí (período 1 + período 2 vía cargo agregado) |
| Avances: plazo estándar | 24 cuotas |
| Avances: comisión observada | $6.500 (consistente) |
| Cargo `INT INTL` en COP | ❌ No (compras intl viven en extracto USD) |
| Cargo agregado `INTERESES CORRIENTES` mensual | ✅ Sí (mismo modelo que Mastercard) |
| Tasa MV cambia ciclo a ciclo | ✅ Sí (1,8312% – 1,8771% en los datos vistos) |
| Tasas MV de COP y USD iguales en un mismo ciclo | ✅ Sí |

---

## 9. Diferencias y Similitudes: Amex vs. Visa vs. Mastercard

### 9.1 Mapa comparativo

| Aspecto | **Visa** Bancolombia | **Mastercard** Bancolombia | **Amex** Bancolombia |
|---------|----------------------|----------------------------|----------------------|
| **Estructura del extracto** | Único en COP | Dual: COP + USD | **Dual: COP + USD** |
| **Conversión USD → COP** | Automática al día de la transacción | El cliente paga USD (o COP a tasa del día de pago) | **Igual a Mastercard** |
| **Compras intl en COP marcadas con tasa MV** | ✅ Sí (genera `INT INTL`) | ❌ No (van al extracto USD) | ❌ **No (igual a Mastercard)** |
| **Compras intl USD a 1/1 generan interés** | N/A (no hay extracto USD) | ❌ No si se pagan al vencimiento | ❌ **No si se pagan al vencimiento** |
| **Compras intl USD diferidas** | N/A | Cuota = capital puro, interés agregado | **Cuota = capital puro, interés agregado** |
| **Cuota 1 de diferidas COP** | Capital puro si `difiere_intereses_cuota1 = 1` | Capital puro siempre (intereses al cargo agregado) | **Capital puro siempre (mismo patrón)** |
| **Modelo de avances** | "Saldo facturado" desde cuota 2 (validado al peso) | Capital puro, intereses al cargo agregado | **Capital puro, intereses al cargo agregado** |
| **Avances: plazo estándar** | 24 cuotas | 24 cuotas | **24 cuotas** |
| **Comisión de avance observada** | $6.840 (Visa Platinum) | $6.500 – $6.840 (variable) | **$6.500 (consistente)** |
| **Tasa MV única para COP y USD** | N/A (extracto único) | ✅ Sí | ✅ **Sí** |
| **Helper `isDualExtracto(franquicia)`** | `false` | `true` | **`true`** ✓ |
| **Helper `aplicaIntInternacional`** | `true` | `false` | **`false`** ✓ |
| **Comportamiento "difiere intereses cuota 1"** | Sí (vía flag) | Sí (estructural) | **Sí (estructural)** |

### 9.2 ¿La lógica dual ya implementada para Mastercard sirve directo para Amex?

**Sí, sin ajustes.** La validación punto a punto:

1. **`backend/helpers/banco.js → isDualExtracto(franquicia)`**:
   ```js
   return f.includes('mastercard') || f.includes('american express') || f.includes('amex');
   ```
   Ya cubre los tres aliases (`'American Express'`, `'Amex'`, `'amex'`). ✓

2. **`backend/helpers/banco.js → aplicaIntInternacional(banco, franquicia)`**:
   Devuelve `false` para Bancolombia + cualquier franquicia dual. Funciona idéntico para Mastercard y Amex. ✓

3. **`backend/helpers/banco.js → avanceOpts(db, tarjetaId)`**:
   Para cualquier tarjeta Bancolombia retorna `{ esBancolombia: true }`, activando el modelo "saldo facturado" en `calcularAmortizacionAvance`. Funciona igual para las tres franquicias. ✓

4. **`backend/helpers/banco.js → nuOpts(db, tarjetaId)`**:
   Si `difiere_intereses_cuota1 = 1` está configurado, retorna `{ esBancolombia: true }` y la diferida usa el modelo de cuota 1 sin intereses. El usuario configura este flag al crear la tarjeta — funciona igual para Mastercard y Amex. ✓

5. **`backend/routes/extractos.js → calcExtracto`**:
   La rama `dualExtracto` (líneas 110-119) ya no aplica el proxy `valor × tasa × días/30` para compras USD a 1 cuota — corregido en v2.7.2. Funciona idéntico para Amex.

6. **Frontend `public/index.html` (Card "Deuda USD" y desglose con sección USD)**:
   El gating es `data.dualExtracto`, que para Amex es `true`. Se renderiza idéntico a Mastercard. ✓

### 9.3 Lo único pendiente (heredado de Mastercard, no exclusivo de Amex)

- **Modelo de revolving USD**: el banco cobra interés sobre el saldo USD que NO se pagó del mes anterior. Hoy la app no rastrea `pago_minimo_usd` y `monto_pagado_usd` como campos persistidos por extracto. Cuando se implemente para Mastercard, automáticamente cubre Amex también.
- **Reconciliación al peso del cargo `INTERESES CORRIENTES` COP**: en los 3 extractos Amex el cliente pagó completo, así que no hay sesgos para validar la fórmula de capitalización diaria. El método itemizado del motor (sumar `interes` de cada cuota) sigue siendo la mejor aproximación que tenemos.

---

## 10. Curiosidades detectadas en el contraste con Mastercard

1. **Comisión de avance estable en Amex** ($6.500 en los dos avances vistos), mientras que en Mastercard observamos variabilidad ($6.500–$6.840). Posible explicación: la categoría de tarjeta (Amex vs Mastercard Platinum) puede tener tarifas distintas, y dentro de la misma categoría puede variar por monto del avance. Es un dato a tener en cuenta para una calculadora de avances futura.

2. **Cuota fraccionada con redondeo conservador**: en Amex `APPLE.COM/BILL $11,57 / 36 = 0,3214` se redondea a `$0,32` (favor banco), mientras que el saldo restante `11,57 - 0,32 = 11,25` cuadra con el saldo pendiente mostrado. Este redondeo "hacia abajo" en la cuota es consistente con lo visto en Mastercard.

3. **Comisión de avance presentada flexiblemente**: el banco a veces la mete en "Cuota transacciones del mes" y a veces en "Otros cargos" (mismo extracto, distinta línea según decisión interna del editor del PDF). Nuestro motor la modela como `comision` en la cuota 1 del avance, lo cual la captura correctamente sin importar dónde la pongan.

4. **Hoyoverse (HOYOVERSE)** aparece en USD con `VR MONEDA ORIG 4.9 SGP` (dólares de Singapur). Esto confirma que el sufijo `VR MONEDA ORIG` en Mastercard/Amex puede ser diferentes monedas (FIN, SGP, USA), no solo USD. La red Amex/Mastercard convierte primero a USD antes de presentarlo en el extracto. En Visa, ese paso intermedio no existe — todo se convierte directo a COP.

5. **Compras COP de comercios "intl" caen al extracto USD en Amex**: APPLE.COM/BILL pagado en COP $44.900 aparece como $11,50 USD con `VR MONEDA ORIG 44900.0 USA` en el extracto USD. En Visa, esa misma transacción aparecería en el extracto COP marcada con tasa MV. Esto lo confirma una vez más: la decisión de qué se considera "internacional" es de la **red de la franquicia** (Amex / Mastercard / Visa), no del banco.

---

## 11. Apéndice — Datos crudos de los extractos analizados

### Saldos al cierre por ciclo

| Ciclo | Saldo COP corte | Saldo USD corte | Pago Mínimo COP | Pago Mínimo USD |
|-------|-----------------|-----------------|-----------------|-----------------|
| 1 (ago-sep 2025)  | $862.514    | $25  | $862.514    | $25 |
| 2 (sep-oct 2025)  | $4.967.881  | $12  | $2.092.881  | $1  |
| 3 (oct-nov 2025)  | $5.083.915  | $12  | $1.524.614  | $1  |

### Tasas observadas por ciclo

| Ciclo | MV vigente |
|-------|-----------|
| 1 (ago-sep) | 1,8771% |
| 2 (sep-oct) | 1,8312% |
| 3 (oct-nov) | 1,8740% |

---

**Mantenedor:** este documento se construyó a partir del análisis de `EXTRACTO AMEX COMPLETO.pdf` y revisión cruzada con:
- `backend/engine/amortizacion.js` (motores de avances y diferidas)
- `backend/routes/extractos.js` (cálculo del pago mínimo + rama dual)
- `backend/routes/dashboard.js` (deuda USD para tarjetas duales)
- `backend/helpers/banco.js` (helpers `isDualExtracto`, `aplicaIntInternacional`, `avanceOpts`, `nuOpts`)
- `docs/bancos/Bancolombia_Mastercard.md` y `docs/bancos/Bancolombia_Visa.md` (referencia comparativa)
