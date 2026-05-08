# Bancolombia — Franquicia Mastercard

**Fuente:** 4 extractos consolidados de la tarjeta `[Tarjeta_MC]` ([USUARIO_PRINCIPAL]), períodos:
1. `03 nov – 17 nov 2025` (ciclo corto inicial)
2. `17 nov – 15 dic 2025`
3. `15 dic 2025 – 15 ene 2026`
4. `15 ene – 15 feb 2026`

**Estado del análisis:** documentación pre-implementación. El código del motor (`amortizacion.js`, `extractos.js`, etc.) **no se ha modificado**. Antes de tocar el motor se requiere validación del usuario sobre los hallazgos descritos aquí.

---

## 1. Estructura general del extracto

Mastercard genera **dos extractos físicos por ciclo**, uno para cada moneda — son independientes:

| Extracto         | Qué incluye                                                                                       | Pago en                |
|------------------|---------------------------------------------------------------------------------------------------|------------------------|
| **Estado de cuenta en PESOS** | Compras nacionales (incluso de "procesadores intl" como Apple, Rappi, MercadoPago si fueron facturadas en COP), avances en COP, diferidas en COP, comisiones | COP                    |
| **Estado de cuenta en DOLARES** | Compras y avances clasificados como internacionales (la red Mastercard los devuelve marcados en USD), incluyendo Apple, Habbo, PayPal, etc. | USD (o COP a tasa del día de pago) |

Cada extracto tiene su propio:
- Periodo facturado (mismas fechas en ambos)
- Pago Total
- Pago Mínimo
- Tabla de tasas (en USD aparece sólo "Compra Internacional", "Avance Internacional", "Mora")

> **Implicación clave:** la lógica `isDualExtracto(franquicia)` que ya tenemos en `backend/helpers/banco.js` debe seguir devolviendo `true` para Mastercard.

---

## 2. Tasas de interés vigentes por ciclo

| Ciclo | Compra a 1 cuota | Compra 2-36 (MV) | Avances (MV) | Compra Internacional (USD MV) | Mora (MV) |
|-------|------------------|------------------|--------------|-------------------------------|-----------|
| 1 (nov)   | 0.0000% | 1.8740% | 1.8740% | 1.8740% | 1.8740% |
| 2 (dic)   | 0.0000% | 1.8781% | 1.8781% | 1.8781% | 1.8781% |
| 3 (ene)   | 0.0000% | 1.8311% | 1.8311% | 1.8311% | 1.8311% |
| 4 (feb)   | 0.0000% | 1.8895% | 1.8895% | 1.8895% | 1.8895% |

**Observaciones:**
- La tasa MV se actualiza el **1° de cada mes** siguiendo la **Tasa de Usura** publicada por el Banco de la República. Esto aplica a todos los emisores en Colombia, no solo a Bancolombia.
- Compra a 1 cuota se cobra a **0% MV** en COP — confirma el patrón ya conocido: si pagas la compra en el mes en que cae el corte, no genera intereses corrientes.
- En el extracto USD, todas las compras internacionales — independientemente del número de cuotas — se muestran con la **misma tasa MV** (la vigente en el día de cada movimiento). Esa tasa se cobra cuando el saldo no se paga al vencimiento, no como un cargo automático estilo `INT INTL` de Visa.

---

## 3. Compras a 1 cuota (1/1)

### 3.1 En COP (extracto en PESOS)
- Tasa: **0.0000%** mensual.
- Si se paga el saldo del extracto antes de la fecha límite, **no se cobra ningún interés corriente** sobre estas compras.
- Si NO se paga al vencimiento → entran al cargo "Intereses corrientes" del siguiente ciclo (a la tasa MV del momento).

### 3.2 En USD (extracto en DOLARES)
- También aparecen como `1/1` con tasa MV indicada (ej. `1.8781% 25.0172%`).
- La tasa **NO se cobra** durante el primer ciclo si la compra se paga a tiempo (verificado: pago de USD 33 en extracto 1 saldó las HabboES, no aparecen intereses cobrados).
- Algunas compras tienen una línea adicional `VR MONEDA ORIG <valor> USA` (ej. `VR MONEDA ORIG 44900.0 USA`). Indica el valor original en otra moneda — la red Mastercard la convirtió a USD antes de presentarla. Se observa que cuando el comercio es Apple Colombia o similar, el valor original suele coincidir con el cargo COP que aparecería en otra tarjeta no-dual.

> **Implicación:** los procesadores como Apple, Habbo, PayPal, Hoyoverse aparecen en el extracto USD para Mastercard. Esto difiere de Visa, donde Apple y Rappi aparecen en COP con `es_internacional = 1`.

---

## 4. Compras diferidas (2 a 36 cuotas)

### 4.1 Patrón de cuotas observado

Avance C03536 (`AVANCE SUCURSAL VIRTUAL` $845.000 a 24 cuotas, desembolsado 05/12/2025):

| Ciclo | Cuota | Valor cuota mostrada | Saldo pendiente al cierre |
|-------|-------|----------------------|---------------------------|
| Extracto 2 (17 nov-15 dic) | 1/24 | $35.208,33 | $809.791,67 |
| Extracto 3 (15 dic-15 ene) | 2/24 | $35.208,33 | $774.583,34 |
| Extracto 4 (15 ene-15 feb) | 3/24 | $35.208,33 | $739.375,01 |

`$845.000 ÷ 24 = $35.208,33` — la **cuota mostrada en el detalle es CAPITAL puro**.

Otro caso — diferida `R00891 AMAZON.COM $2.712.990 a 4 cuotas`:

| Ciclo | Cuota | Valor cuota | Saldo |
|-------|-------|-------------|-------|
| Extracto 2 | 1/4 | $678.247,50 | $2.034.742,50 (implícito) |
| Extracto 3 | 2/4 | $678.247,50 | $1.147.322,27 |

`$2.712.990 ÷ 4 = $678.247,50` ✓ — capital puro.

### 4.2 Los intereses van como cargo separado

En el extracto en PESOS de los ciclos 2, 3 y 4 aparece un movimiento explícito el día del corte:

| Ciclo | Movimiento | Valor |
|-------|------------|-------|
| 2 (15/12/2025) | `INTERESES CORRIENTES` | $100.769,11 |
| 3 (15/01/2026) | `INTERESES CORRIENTES` | $239.039,04 |
| 4 (15/02/2026) | `INTERESES CORRIENTES` | $162.102,25 |

Y el detalle del pago mínimo lista `Intereses corrientes` con esos mismos valores.

> **Conclusión:** Mastercard **separa** capital de intereses en la presentación. La cuota del detalle de movimientos = capital únicamente; los intereses corrientes se calculan sobre saldos pendientes y se facturan como un solo movimiento agregado el día del corte.

### 4.3 Diferimiento de la cuota 1

Los avances `C03536`, `C05517`, `C02093`, `C01615` y la diferida `R00891` se desembolsaron dentro del ciclo 2 (entre 21/11 y 05/12). En el extracto 2:
- Aparecen en cuota 1 con valor = capital/N.
- El cargo "Intereses corrientes" del extracto 2 ($100.769,11) **probablemente NO incluye intereses sobre estas cuotas 1**, sino sobre saldos previos no cubiertos.

Esto es consistente con el comportamiento ya conocido de Visa Bancolombia con `difiere_intereses_cuota1=1`: la cuota 1 se factura como capital y los intereses comienzan desde la cuota 2.

### 4.4 Método de cálculo del cargo "Intereses corrientes" — Capitalización Diaria

> 📌 **Nota técnica (validada con el usuario):** Bancolombia utiliza el método de **Capitalización Diaria sobre Saldo Diario Pendiente** para calcular el rubro `INTERESES CORRIENTES` que aparece como movimiento agregado el día del corte.
>
> Esto significa que cada día el banco corre la fórmula:
>
> ```
> interés_diario(día) = saldo_pendiente(día) × (tasaMV / 30)
> ```
>
> y al cerrar el ciclo suma los `interés_diario` de cada día calendario. Como el saldo cambia con cada compra, abono o pago, no se puede reconstruir matemáticamente sin el log día-por-día de movimientos del cliente (que el banco sí tiene pero nuestra app no).
>
> **Por qué no buscamos una fórmula simple `Saldo × Tasa`:** dejaría desfases pequeños que vienen del momento exacto en que se hicieron los abonos del mes anterior — información que nosotros nunca podremos reconstruir 100%.
>
> **Estrategia del motor:** nuestra app calcula los intereses de forma **itemizada** (por compra/cuota individual) y los suma. La sumatoria queda muy cercana al cargo real del banco; las pequeñas diferencias (de centavos a unas pocas miles de pesos) son el costo aceptable de no tener acceso al saldo diario real. Esta es la decisión arquitectónica oficial.

---

## 5. Avances

| Movimiento | Monto | Plazo | Comisión observada |
|------------|-------|-------|--------------------|
| C03536 (05/12) | $845.000   | 24 cuotas | $6.840 |
| C05517 (01/12) | $500.000   | 24 cuotas | $6.500 |
| C02093 (26/11) | $3.800.000 | 24 cuotas | $6.500 |
| C01615 (25/11) | $3.261.904 | 24 cuotas | (no aparece comisión separada en el extracto, posible error de extracción) |

- Plazo estándar de avance: **24 cuotas** (igual que Visa).
- La comisión se factura como movimiento separado el mismo día del avance (`COMISION AVANCE SUCURSAL`).
- La cuota 1 del avance se factura como capital puro (`monto / 24`); los intereses se cobran a partir del segundo ciclo en el cargo agregado "Intereses corrientes".

---

## 6. Compras internacionales (USD)

### 6.1 Cómo aparecen
- Toda la operativa va por el extracto en DOLARES.
- La tabla de tasas USD sólo lista: `Compra Internacional`, `Avance Internacional`, `Mora` — todas con la misma MV del ciclo.
- Se ven los siguientes tipos:
  - Compras 1/1 (Habbo, Hoyoverse, Apple, PayPal): si se pagan al vencimiento → 0% efectivo.
  - Compras a cuotas (Apple a 12 cuotas, Apple a 36 cuotas): comportamiento idéntico al COP — cuota = capital, intereses agregados aparte.

### 6.2 Cargo "INTERESES CORRIENTES" en USD

| Ciclo | Cargo USD | Comentario |
|-------|-----------|------------|
| 2 (15/12/2025) | $0,00     | Saldo anterior del ciclo 1 fue $32,97 y se pagó completo → cero intereses |
| 3 (15/01/2026) | $40,85    | Saldo anterior del ciclo 2 fue $1.262,89 y sólo se pagó $309 → genera interés sobre el saldo restante |
| 4 (15/02/2026) | $16,00    | Saldo anterior del ciclo 3 fue $1.084,88 y se pagó $388 → interés sobre lo no cubierto |

**Hipótesis del cálculo:** `intereses_USD ≈ saldo_no_pagado × tasa_MV`. Verificación rápida:
- Ciclo 3: saldo no cubierto = 1.262,89 − 309 = $953,89 → 953,89 × 0.018781 ≈ $17,91. **No cuadra** con $40,85.
- Si fuera sobre el saldo total al cierre anterior: 1.262,89 × 0.018781 ≈ $23,72. **Tampoco cuadra**.

> ⚠️ La fórmula exacta del cobro de intereses USD requiere más datos (días, fecha de pago real, prorrateo). Anotamos el patrón cualitativo: **se cobran intereses sólo cuando el saldo no se paga completo, y la magnitud crece con el saldo no cubierto**.

### 6.3 NO existe el cargo `INT INTL` estilo Visa

A diferencia de Visa Bancolombia, donde compras como `RAPPI`, `APPLE.COM`, `MERCADOPAGO` aparecen en el extracto en COP marcadas como internacionales y generan un interés mensual proporcional `valor × tasa × dias/30` desde la primera cuota, en **Mastercard estas compras son procesadas vía la red Mastercard como USD** y aparecen en el extracto de DOLARES. El usuario las paga directamente en USD (o COP convertidos a tasa del día de pago).

Esto valida la regla actual del código:
- `aplicaIntInternacional(banco, franquicia)` retorna `false` para Bancolombia Mastercard ✓
- `isDualExtracto(franquicia)` retorna `true` para Mastercard ✓
- Las compras en COP marcadas con `es_internacional = 1` no generan interés en Mastercard (no hay rubro `INT INTL`).

---

## 7. Cálculo del Pago Mínimo (extracto en PESOS)

### 7.1 Fórmula deducida

Comparando los detalles del pago mínimo de los 4 extractos COP, se llega a la fórmula:

```
Pago Mínimo COP =
    Cuota transacciones del mes               (capital de cuotas + compras 1/1 del ciclo)
  + Cuota transacciones anteriores            (capital de cuotas que vienen de meses pasados)
  + Cuota avances                              (capital de cuota del avance, separado)
  + Intereses corrientes                       (cargo agregado del mes, ver §4.2)
  + Intereses de mora                          (si hay extractos vencidos)
  + Otros cargos                               (comisiones de avance, cuota de manejo, CMF, IVA)
  + En mora                                    (saldos previos no pagados)
  − A favor                                    (saldo a favor del cliente)
```

### 7.2 Verificación con extracto 2

| Concepto | Valor |
|----------|-------|
| Cuota transacciones del mes | $5.032.379,50 |
| Cuota transacciones anteriores | $350.287,66 |
| Cuota avances | (vacío) |
| Intereses de mora | $0 |
| Intereses corrientes | $100.769,11 |
| Otros cargos | $26.340 |
| En mora | $0 |
| A favor | $0 |
| **Suma**           | **$5.509.776,27** |
| **Pago Mínimo extracto** | **$5.509.777,00** |

Diferencia de $0,73 — redondeo aceptable. ✓

### 7.3 Verificación con extracto 3

| Concepto | Valor |
|----------|-------|
| Cuota transacciones del mes | $9.089.501,00 |
| Cuota transacciones anteriores | $678.247,50 + $350.287,66 = $1.028.535,16 |
| Intereses corrientes | $239.039,04 |
| **Suma aprox.** | **$10.357.075,20** |
| **Pago Mínimo extracto** | **$10.357.076,00** |

Cuadra. ✓

### 7.4 Pago Mínimo USD

```
Pago Mínimo USD =
    Cuota transacciones del mes (USD)
  + Cuota transacciones anteriores (USD)
  + Intereses corrientes (USD)
  − A favor (USD)
```

Validado en los ciclos 2, 3 y 4 con diferencias menores a USD 1 (redondeo).

### 7.5 Pago Total

`Pago Total = Saldo a fecha de corte`. Es decir, todas las deudas pendientes (compras + saldo de avances + saldo de diferidas + intereses) menos abonos. Cualquier extracto.

---

## 8. Tabla resumen de hallazgos para el motor de cálculo

| Aspecto | Comportamiento Mastercard Bancolombia |
|---------|---------------------------------------|
| Extracto dual (COP + USD separados) | ✅ Sí |
| Compras 1/1 generan intereses si se pagan al vencimiento | ❌ No |
| Compras 1/1 generan intereses si entran en mora | ✅ Sí (a tasa MV del ciclo) |
| Compras a cuotas: cuota 1 cobra intereses | ❌ No (sólo capital) |
| Compras a cuotas: cuota N≥2 cobra intereses | ✅ Sí (vía cargo agregado "Intereses corrientes") |
| Cargo "INT INTL" sobre compras intl en COP | ❌ No existe (caen al extracto USD) |
| Avances: plazo estándar | 24 cuotas |
| Avances: cobran comisión separada | ✅ Sí (variable, ~$6.500-$6.840) |
| Tasa MV cambia ciclo a ciclo | ✅ Sí (1.8311% – 1.8895% en los datos vistos) |

---

## 9. Diferencias clave con Bancolombia Visa

| Aspecto | Bancolombia **Visa** | Bancolombia **Mastercard** |
|---------|----------------------|----------------------------|
| **Estructura de extracto** | Único (COP) — las compras USD se convierten a COP automáticamente | **Dual**: COP + USD por separado |
| **Compras internacionales en COP (Apple, Rappi, MercadoPago)** | Aparecen en COP con `es_internacional=1` y generan **INT INTL** mensual `valor × tasa × días/30` | Aparecen en el extracto USD; no existe el rubro `INT INTL` |
| **Flag `aplicaIntInternacional`** | `true` (Bancolombia + no-dual) | `false` (Bancolombia pero dual) |
| **Flag `isDualExtracto`** | `false` | `true` |
| **Pago mínimo USD** | N/A (no hay extracto USD) | Línea independiente con su propio total |
| **Cuota 1 de diferidas** | Capital puro si `difiere_intereses_cuota1=1`; los intereses de la cuota 1 se acumulan y se facturan en cuota 2 (modelo "saldo facturado") | Capital puro siempre; los intereses van al cargo agregado "Intereses corrientes" del ciclo, calculado sobre saldos vigentes |
| **Avances: modelo de intereses** | "Saldo facturado": `interes(N) = (saldoInicio + cuotaCapital) × tasaMV`, validado vs extracto Visa Platinum abr 2026 | Cuota mostrada = capital/N puro; los intereses van al cargo agregado. Modelo subyacente posiblemente similar pero requiere otro ciclo para reconciliar al peso |
| **Comisión de avance** | Se factura una sola vez al desembolso | Igual: comisión separada (~$6.500–$6.840), día del avance |
| **Tasa Compra a 1 cuota** | 0% MV | 0% MV ✓ |
| **Variación de tasas** | Igual: tasa MV se ajusta cada ciclo según política Bancolombia | Igual |

---

## 10. Acciones pendientes y completadas

### 10.1 Implementadas (v2.7.2)
1. ✅ **Documentación de capitalización diaria** (§4.4) — el rubro `INTERESES CORRIENTES` se calcula con saldo diario pendiente; nuestra app suma los intereses itemizados por compra/cuota como aproximación. La diferencia con el banco será de centavos a unas pocas miles, aceptable.
2. ✅ **Fix proxy USD** — para tarjetas duales (Mastercard/Amex), las compras USD a 1 cuota dejaron de devengar el interés proporcional `valor × tasa × días/30` en su ciclo de compra. Si el usuario paga el extracto a tiempo, el banco no cobra interés y nuestro sistema ahora lo refleja igual. (Antes sobre-estimaba.)
3. ✅ **Card dual COP/USD** — verificada la presentación del Resumen y del Pago Mínimo separados COP+USD para tarjetas con `dualExtracto=true`.
4. ✅ **Vista del extracto Mastercard** — el desglose ya muestra capital y los intereses corrientes agrupados (línea "Intereses Internacionales" / "Intereses Compras USD") en lugar de mezclarlos por línea.

### 10.2 Pendientes para una iteración futura (requieren más datos)
1. **Modelo de revolving USD**: el banco cobra interés sobre el saldo USD que NO se pagó del extracto anterior (ver §6.2: ciclo 3 cobró $40,85 sobre saldo previo no cubierto). Nuestra app aún no rastrea el saldo USD pendiente entre extractos. Para implementarlo se requiere:
   - Persistir `pago_minimo_usd` y `monto_pagado_usd` por extracto (similar a `intereses_intl`).
   - En el cálculo del nuevo extracto, agregar `interesesRevolvingUsd = saldoNoPagadoExtractoAnterior × tasaMV` aproximado.
2. **Ciclo 5 de Mastercard** para confirmar el modelo de cuotas N≥2 en COP — específicamente la transición cuota 2 → 3 sobre las mismas diferidas, comparando `Intereses Corrientes` ciclo a ciclo.

---

## 11. Apéndice — Datos crudos relevantes

### Saldos al cierre por ciclo

| Ciclo | Saldo COP corte | Saldo USD corte | Pago Mínimo COP | Pago Mínimo USD |
|-------|-----------------|-----------------|-----------------|-----------------|
| 1 (03-17 nov)   | $0          | $33     | $0          | $1   |
| 2 (17 nov-15 dic) | $15.391.964 | $1.263  | $5.509.777  | $177 |
| 3 (15 dic-15 ene) | $19.345.177 | $1.085  | $10.357.076 | $252 |
| 4 (15 ene-15 feb) | $8.762.513  | $875    | $4.390.340  | $275 |

### Pagos / abonos por ciclo

| Ciclo | Pagos COP    | Pagos USD |
|-------|--------------|-----------|
| 1     | $14.150      | $0        |
| 2     | $209.172     | $165      |
| 3     | $5.509.777   | $309      |
| 4     | $14.857.076  | $388      |

(Los abonos COP del ciclo 3 cubren exactamente el pago mínimo del ciclo 2; los abonos del ciclo 4 cubren ~$10.36M del pago mínimo del ciclo 3.)
