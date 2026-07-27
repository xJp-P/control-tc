# RappiCard — Franquicia Visa (emisor: Davivienda)

**Fuente:** 7 extractos consolidados de la tarjeta Virtual `[RappiCard_Virtual]` / Física `[RappiCard_Fisica]` ([USUARIO_PRINCIPAL]), períodos:

| # | Periodo facturado | Fecha de pago | Días entre corte y pago |
|---|-------------------|---------------|-------------------------|
| 1 | 19 sep – 20 oct 2025 | 31 oct 2025 | 11 |
| 2 | 21 oct – 20 nov 2025 | 30 nov 2025 | 10 |
| 3 | 21 nov – 18 dic 2025 | 31 dic 2025 | 13 |
| 4 | 19 dic 2025 – 20 ene 2026 | 30 ene 2026 | 10 |
| 5 | 21 ene – 19 feb 2026 | 02 mar 2026 | 11 |
| 6 | 20 feb – 19 mar 2026 | 31 mar 2026 | 12 |
| 7 | 20 mar – 20 abr 2026 | 04 may 2026 | 14 |

**Estado del análisis:** documento VIVO. La versión original fue documentación pre-implementación (sin cambios de código). **Actualizado en v5.6.3** con la auditoría del extracto de julio-2026: el layout real del texto extraído (§1.1) y la calibración de los intereses (§4.3), que **deroga** la explicación anterior de "capitalización diaria". Esa versión **sí** modificó código (el parser de conciliación) y dejó identificado —pero NO implementado— un ajuste pendiente en el conteo de días del motor. Las conclusiones de §8 y §10 quedan matizadas por §4.3.

---

## 1. Estructura general del extracto

RappiCard genera un **extracto único en pesos colombianos (COP)**. No existe un extracto USD ni una sección dual. Las compras realizadas en el exterior se convierten a COP el día de la transacción usando la TRM/tasa propia de Davivienda y se mezclan con las compras nacionales sin distinción.

Características del documento físico:
- Diseño visual completamente distinto al de Bancolombia (formato Davivienda).
- Cabecera con número de tarjeta Virtual y Física (modelo dual de RappiCard).
- Cashback acumulativo ~0,1% del consumo del mes (no relevante para el motor).
- Estado: Normal / Mora.

> **Implicación en el motor:**
> - `isDualExtracto('Visa')` → `false` ✓
> - `aplicaIntInternacional('RappiCard'/'Davivienda', 'Visa')` → `false` ✓ (no hay `INT INTL` estilo Bancolombia)
> - Detección actual: `banco.toLowerCase().includes('rappi') || banco.toLowerCase().includes('davivienda')` activa la rama `esRappiCardCalc` / `esRappiDash`.

### 1.1 Layout del TEXTO extraído — vertical, no tabular (confirmado con un PDF real)

Dato clave para la conciliación IA, confirmado al extraer el PDF de julio-2026 (el archivo viene
**cifrado**: la contraseña es el número de documento del titular). El "Detalle de transacciones" se ve
como una tabla en pantalla, pero al extraer el texto **cada celda cae en su propia línea**, en bloques
de 9 campos por movimiento:

```
Virtual          <- canal (Virtual | Fisica | "-" en los pagos)
2026-07-15       <- fecha, formato ISO YYYY-MM-DD
RAPPI            <- descripcion del comercio
$36.300,00       <- valor de la transaccion
$36.300,00       <- capital facturado del periodo   <-- lo que cobra ESTE ciclo
1 de 1           <- cuotas ("9 de 24" en diferidas)
$0,00            <- capital pendiente por facturar
0,0000%          <- tasa M.V de la linea
0,00%            <- tasa E.A
```

Los pagos usan la misma estructura con `-` como canal, valor **negativo** y `N/A` en los campos de
cuotas: `- | 2026-06-29 | PAGOS RAPPIPAY APP | $-237.136,05 | N/A | N/A | N/A | 0% | 0,00%`.

> **Implicación en el motor (corregida en v5.6.3):** `parsearTabular` exige fecha **y** monto en la
> MISMA línea, así que con este layout no cruzaba NADA y toda la conciliación de RappiCard caía sobre
> el LLM, sin la red determinista. `strategies/rappiCard.js` tiene ahora un `parsearVertical` propio
> que reconstruye los bloques (con fallback al tabular si el layout difiere). Emite el **capital
> facturado** (2º monto), no el valor de la transacción: es lo que el banco cobra en el ciclo y lo que
> el motor compara — las cuotas de diferida se cruzan por `campo_monto:'capital'`, y en una compra de
> contado ambos valores coinciden. Los movimientos negativos se descartan del pool del matcher.
>
> **⚠️ Pendiente conocido:** esos negativos hoy **tampoco llegan** a `detectarReversos` /
> `detectarPagosOmitidos` — ambos parsean el texto crudo con una regex que exige fecha `DD/MM/YYYY`,
> concepto y monto **en la misma línea**, y aquí la fecha es ISO y cada campo va en su renglón. O sea:
> en RappiCard un pago o un reverso **no tienen cruce determinista** (el arreglo de plurales
> `PAGOS?` de v5.6.3 es necesario pero no suficiente). Fix natural: alimentar esos detectores con las
> líneas ya reconstruidas por la estrategia del banco en vez de re-parsear el texto. Ver BACKLOG.

---

## 2. Tasas de interés

| Categoría | Tasa MV (ciclos analizados) | Tasa EA |
|-----------|------------------------------|---------|
| Compra a 1 cuota | **0,0000%** | 0,00% |
| Compras a cuotas (≥ 2) | **1,8334%** | 24,36% |

### 2.1 Contexto macroeconómico — TODOS los bancos actualizan tasas mensualmente

> ⚠️ **Aclaración importante:** las tasas de las tarjetas de crédito en Colombia **NO son fijas en ningún banco**. El **Banco de la República** publica la **Tasa de Usura** máxima permitida cada mes, y todos los emisores (Bancolombia, Davivienda/RappiCard, Nu, etc.) **actualizan sus tasas el día 1° de cada mes** ajustándose al límite vigente.
>
> **¿Por qué los 7 extractos de RappiCard analizados muestran la misma tasa 1,8334%?** Porque las fechas de corte de esta tarjeta caen entre el 18 y el 21 del mes (de un mes a otro). Cada ciclo abarca días de **dos meses calendario distintos** que pueden tener la misma o distinta tasa publicada por el Banco de la República. La tasa que aparece en el extracto es la **vigente el día de cada movimiento** (no una tasa "fija" del producto).
>
> **¿Por qué los extractos de Bancolombia analizados muestran tasas que sí cambian (1,8895% → 1,9110% → 1,9915%)?** Idéntica razón: cada ciclo en los datos de Bancolombia abarcó meses calendario donde el Banco de la República publicó tasas distintas, y eso se reflejó en el extracto. **No es una característica del banco, es una coincidencia del calendario de cortes vs. el calendario de publicación de tasa de usura.**
>
> **Conclusión:** Bancolombia, RappiCard y Nu son funcionalmente equivalentes en este aspecto: **todos actualizan tasas el día 1° de cada mes, todos respetan la Tasa de Usura del Banco de la República**. Lo único que cambia entre franquicias es **dónde** caen los días de corte respecto al cambio de tasa.

### 2.2 Categorización en RappiCard
- **No existe categoría "Compra Internacional"** diferenciada en la tabla de tasas — la franquicia trata todas las compras como nacionales una vez convertidas a COP.
- La tasa que aplica a una diferida ya creada se mantiene constante a lo largo de las cuotas restantes (es la tasa vigente el día del desembolso/compra). Ese sí es un comportamiento "lockeado" — pero no porque la tasa del producto no cambie globalmente, sino porque cada deuda particular hereda la tasa de su día de origen.

---

## 3. Compras a 1 cuota (1/1)

### 3.1 Comportamiento confirmado
- Tasa mostrada: **0,0000%** (todas las compras 1/1 sin excepción en los 7 extractos).
- **No generan intereses** si se pagan dentro del ciclo (al cubrir el Pago Mínimo o el Pago Total).
- Si no se pagan, entran al saldo del siguiente ciclo y a partir de ahí sí pueden generar interés (no se observó este caso en los datos).

Ejemplos del ciclo 7 (todas a 0%):
- `RAPPI $26.500 1/1 0,0000%`
- `EURO SUPERMERCADO PLAC $331.975 1/1 0,0000%`
- `DROGUERIA INGLESA 159 $35.200 1/1 0,0000%`
- `RAPPI $62.883 1/1 0,0000%`

### 3.2 Compras "internacionales" en 1/1
- Comercios como **HoYoverse**, **BPAY GLOBAL**, **BFINITY BITFI** procesan en USD pero RappiCard las convierte a COP el día de la compra y las muestra como compras COP normales.
- Cuando son 1/1, aparecen con tasa **0,0000%** — confirmado en ciclo 2 con HoYoverse.
- Cuando se difieren a más de 1 cuota (típicamente 24), aparecen con tasa **1,8334%** y siguen el modelo de diferidas (§4).

> **Conclusión clave:** RappiCard **no diferencia** internamente entre compras nacionales e internacionales una vez hechas. El concepto de "compra internacional con cobro de interés especial" como en Bancolombia Visa **NO existe aquí**.

---

## 4. Compras diferidas (2 a 36 cuotas)

### 4.1 Patrón de cuotas observado

Diferida ejemplo: `BFINITY BITFI TECHNOLO $397.419,29` a 24 cuotas, ciclos 2-7:

| Ciclo | Cuota | Capital cuota | Saldo pendiente al cierre |
|-------|-------|---------------|---------------------------|
| 2 | 1/24 | $16.559,13 | $380.860,16 |
| 3 | 2/24 | $16.559,13 | $364.301,03 |
| 4 | 3/24 | $16.559,13 | $347.741,90 |
| 5 | 4/24 | $16.559,13 | $331.182,77 |
| 6 | 5/24 | $16.559,13 | $314.623,64 |
| 7 | 6/24 | $16.559,13 | $298.064,51 |

`$397.419,29 ÷ 24 = $16.559,14` — la cuota mostrada es **CAPITAL puro** (igual que Bancolombia y Mastercard).

Otras diferidas verificadas, todas cuadran al peso:
- `BPAY GLOBAL $210.632,22 ÷ 24 = $8.776,34` ✓
- `BPAY GLOBAL $329.858,02 ÷ 24 = $13.744,08` ✓
- `BPAY GLOBAL $330.863,13 ÷ 24 = $13.785,96` ✓
- `PAGOS RAPPIPAY APP $244.298,94 ÷ 24 = $10.179,12` ✓

### 4.2 La cuota 1 SÍ cobra intereses (no hay diferimiento)

A diferencia de Bancolombia (donde la cuota 1 difiere su interés a la cuota 2), **RappiCard cobra interés en la cuota 1 desde el primer ciclo**.

Verificación con el ciclo 2 (primer ciclo donde aparecen 5 diferidas nuevas):
- Capital del mes (cuotas 1/24): $63.044,63
- Compras 1/1: $119.502,61 (HoYoverse + RAPPI)
- **Total capital facturado del mes:** $182.547,24 ✓
- **Intereses corrientes del mes:** $27.037,64

Los $27.037,64 son intereses sobre las diferidas (incluyendo cuota 1), porque las compras 1/1 están a 0% y no aportan intereses.

> **Implicación en el motor:** la flag `difiere_intereses_cuota1` debe quedar en **`0` o `null`** para tarjetas RappiCard. Esto hace que `nuOpts(db, tarjetaId)` retorne `undefined` y `calcularAmortizacionDiferida` use el modelo estándar (`interesTotal = interesPeriodo` desde i=0).

### 4.3 Fórmula de los intereses — CALIBRADA (auditoría del extracto de julio-2026)

> **Corrección importante (27-jul-2026).** Este apartado afirmaba antes que el residual se debía a
> *"capitalización diaria sobre saldo pendiente diario"*. **Es FALSO** y se deroga: la E.A. impresa
> (24,36%) es exactamente la misma tasa que 1,8334% M.V. (`1,018334^12 = 1,2436`), así que no hay
> capitalización extra que explicar; en convención base-30 aporta ~$12 y en convención 365 días va en
> **dirección contraria**. La causa real es el **número de días del periodo**.

**La fórmula del banco es la misma del motor** — `interés = saldo × tasaMV × (días / 30)`, por cuota y
sumada. Lo que difiere es el insumo **días**.

**Prueba de calibración (ciclo 2, nov-2025).** Es el ciclo de nacimiento de las 5 diferidas, sin saldo
previo que contamine. Con los días REALES (contando el día de la transacción, inclusive):

| Grupo | Capital | Días | Interés |
|---|---|---|---|
| 3 compras del 22-oct → corte 20-nov | $937.909,53 | 30 | $17.195,62 |
| 2 compras del 24-oct → corte 20-nov | $575.162,07 | 28 | $9.842,03 |
| **Total calculado** | | | **$27.037,65** |
| **Total impreso en el PDF** | | | **$27.037,64** |

Error: **$0,013** sobre 5 términos. La forma de la fórmula queda confirmada al centavo. Con el conteo
que hace hoy el motor (`daysBetween` exclusivo: 29 y 27 días) daría $26.112,96 → **−$924,68**.

Dos convenciones rivales quedaron descartadas con este mismo ciclo: sin prorrateo por día → $27.740,66;
`días_vivos / días_del_periodo` → $26.165,30.

#### La causa raíz: cortes sintéticos vs. cortes reales

`calcularAmortizacionDiferida` ([backend/engine/amortizacion.js](../../backend/engine/amortizacion.js))
genera los cortes con `addMonths(fechaPrimerCorte, i)` → siempre el **día fijo**, siempre **30 días**.
Pero RappiCard **adelanta el corte** cuando cae en fin de semana, y entonces el periodo facturado no
mide 30 días.

Caso medido — ciclo julio-2026, periodo impreso *"desde 19 jun 2026 hasta 20 jul 2026"* (**32 días**,
porque el corte de junio fue el **18**, un jueves: el 20-jun cayó sábado):

| | Interés |
|---|---|
| App (30 días sintéticos) | $18.493,77 |
| Con 32 días reales | $19.726,69 |
| **Banco (PDF)** | **$20.150,51** |

El conteo de días explica **~74%** del desfase. El residual restante (**$423,82**, 2,1% del interés y
0,13% del pago mínimo) **sigue abierto**: es recurrente (≈0,18% del saldo facturado anterior, ~3 días
de interés) y para desempatar sus candidatos —rotación parcial, cambio de tasa a mitad de ciclo (el
periodo abarca dos meses calendario y la usura cambia el 1°), o convención distinta para saldos
arrastrados— haría falta el PDF del extracto de junio. **Decisión del usuario (27-jul-2026): se acepta
como margen de error, no se persigue.**

**Lo irónico:** la app **ya conoce** el corte real — está en `cortes_custom` (`2026-06 → 2026-06-18`,
motor de cortes adelantados de v4.6.0) y lo usan los candados y el display desde v4.7.0. Simplemente
**no llega al motor de amortización**.

> **Fix identificado pero NO implementado** (decisión del usuario, 27-jul-2026): pasar los cortes
> reales al motor vía un `opts.cortesReales` opcional. Es un **sub-proyecto de alto riesgo**: la firma
> de `calcularAmortizacionDiferida` la consumen ~24 call sites y alimenta deuda, cupo, pago mínimo y
> conciliación IA; las `fechaCorte` generadas son además la CLAVE con que `engine/extracto.js` asigna
> cada cuota a un ciclo, así que un corte que cruce el límite de mes podría duplicar una cuota en un
> extracto y borrarla del siguiente. Corregirlo mueve números históricos en AMBAS direcciones.
> Además, el sub-fix del día inclusivo en la cuota 1 **contaminaría el experimento de campo abierto**
> (APPLE #70 / NETFLIX #71), cuya pregunta central es justamente desde qué fecha arranca el interés de
> la primera cuota. Debe ir gateado por banco y esperar al extracto de agosto.

**Efecto práctico mientras tanto:** la app **subestima** el interés de RappiCard cuando el banco
adelanta el corte. En julio-2026 fueron $1.657 de un pago mínimo de $320.582 (0,5%).

---

## 5. Avances

En los 7 extractos analizados **no se observaron avances tradicionales** (`AVANCE SUCURSAL VIRTUAL` con monto grande a 24 cuotas).

Lo que sí aparecen son movimientos de tipo `PAGOS RAPPIPAY APP` que en algunos casos se difieren a 24 cuotas y en otros aparecen como 1/1 con tasa 1,8334%. Posiblemente son desembolsos especiales del producto Rappi pero **no existe la línea separada `+ Cuota de Avances` con valor diferente de $0** en ningún ciclo.

> **Implicación:** RappiCard parece tratar los avances como diferidas más (mismo modelo de cálculo `capital + interés mensual`). Hasta tener un extracto con un avance explícito, asumimos que el modelo es **idéntico al de diferidas**: cuota = capital puro, interés desde la cuota 1, tasa 1,8334% MV.

---

## 6. Cálculo del Pago Mínimo (fórmula exacta)

### 6.1 Estructura del Detalle del Pago Mínimo (RappiCard)

```
Pago Mínimo =
    Saldo en mora
  + Saldo pendiente de pago mínimo                (de ciclos anteriores no cubiertos)
  + Capital facturado consumos del mes            (compras 1/1 + cuota capital de diferidas)
  + Intereses corrientes del mes                  (cargo agregado sobre saldos)
  + Intereses de mora
  + Cuota de Avances                              (si existieran avances tradicionales)
  + Otros cargos (comisiones de avance, reexpedición)
  − Saldo a favor (incluye abonos y cancelaciones)
```

### 6.2 Verificación con el ciclo 2

| Concepto | Valor |
|----------|-------|
| Saldo en mora | $0,00 |
| Saldo pendiente de pago mínimo | $0,00 |
| Capital facturado consumos del mes | $182.547,24 |
| Intereses corrientes del mes | $27.037,64 |
| Intereses de mora | $0,00 |
| Cuota de Avances | $0,00 |
| Otros cargos | $0,00 |
| Saldo a favor | $0,00 |
| **Suma** | **$209.584,88** |
| **Pago Mínimo extracto** | **$209.584,88** ✓ |

Cuadra al peso. ✓

### 6.3 Verificación con ciclos 3-7

| Ciclo | Capital | Intereses | Mora | Total calculado | Pago Mínimo extracto | Diff |
|-------|---------|-----------|------|-----------------|----------------------|------|
| 3     | $84.294,63  | $25.197,77 | $342,51 | $109.834,91 | $109.834,91 | 0 ✓ |
| 4     | $127.944,63 | $29.032,28 | $0     | $156.976,91 | $156.976,91 | 0 ✓ |
| 5     | $87.534,63  | $24.619,84 | $0     | $112.154,47 | $112.154,47 | 0 ✓ |
| 6     | $96.034,63  | $21.999,88 | $0     | $118.034,51 | $118.034,51 | 0 ✓ |
| 7     | $646.952,63 | $23.940,45 | $0     | $670.893,08 | $670.893,08 | 0 ✓ |

**La fórmula es exacta. Los componentes individuales (capital e intereses) son los aproximados.**

### 6.4 Pago Total

```
Pago Total =
    Saldo del periodo anterior
  + Consumos del mes
  + Intereses corrientes
  + Intereses de mora
  + Avances
  + Otros cargos
  − Pagos (incluye abonos y cancelaciones)
```

### 6.5 Pago Alternativo (concepto único de RappiCard)

A partir del ciclo 3 aparece una tercera línea llamada **"Pago alternativo"**:

| Ciclo | Pago Mínimo | Pago Alternativo | Ratio |
|-------|-------------|------------------|-------|
| 3 | $109.834,91 | $32.950,47 | **30,0%** |
| 4 | $156.976,91 | $47.093,07 | **30,0%** |
| 5 | $112.154,47 | $33.646,34 | **30,0%** |
| 6 | $118.034,51 | $35.410,35 | **30,0%** |
| 7 | $670.893,08 | $201.267,92 | **30,0%** |

**Pago Alternativo = 30% del Pago Mínimo**, exacto en los 5 ciclos donde aparece.

> Concepto del banco: *"El pago alternativo es lo mínimo que puedes pagar para no entrar en mora. Si pagas este valor, la diferencia con tu pago mínimo será enviada al siguiente mes con cobro de intereses."*

> **Implicación:** este es un concepto **exclusivo de RappiCard** que no existe en Bancolombia. **No está modelado en nuestra app actualmente.** Podría añadirse como feature futura (mostrar las dos opciones de pago al usuario). No es crítico para la operación normal del motor.

---

## 7. Fecha de pago: aproximación vs realidad

La memoria del proyecto y el código actual usan: `fecha_pago = fecha_corte + 14 días` (helper `addDays` en `backend/helpers/dates.js`).

**Realidad observada en los 7 ciclos:**

| Ciclo | Días corte→pago real |
|-------|----------------------|
| 1 | 11 |
| 2 | 10 |
| 3 | 13 |
| 4 | 10 |
| 5 | 11 |
| 6 | 12 |
| 7 | 14 |
| **Promedio** | **11,6** |

El patrón aparente es: la fecha de pago cae en el **último día calendario del mes natural siguiente al corte** (con ajustes a día hábil cuando el último cae en sábado/domingo). Por ejemplo:
- Corte 20/oct → pago 31/oct (último día de octubre)
- Corte 19/feb → pago 02/mar (1 marzo es domingo, ajusta al lunes)

**Implicación:** la regla `+14 días` es una sobre-aproximación segura (siempre da una fecha posterior o igual a la real). En la práctica el usuario tiene un colchón pequeño porque la app le muestra una fecha límite ligeramente más generosa que la real. Decidir si refinar es una conversación aparte; **el residual del 0,07%** mencionado en la memoria refleja este comportamiento.

---

## 8. Tabla resumen del comportamiento de RappiCard

| Aspecto | RappiCard (Davivienda) Visa |
|---------|------------------------------|
| Banco emisor | Davivienda |
| Franquicia | Visa |
| Extracto dual COP/USD | ❌ No (único en COP) |
| TRM aplicada | Día de la compra (Davivienda) |
| Cargo `INT INTL` | ❌ No existe |
| Categorización "Compra Internacional" en tabla de tasas | ❌ No existe (solo nacional) |
| Compras 1/1 cobran intereses | ❌ No (tasa 0% si se paga al corte) |
| Compras diferidas: cuota 1 cobra intereses | ✅ **Sí (sin diferimiento)** ← diferencia con Bancolombia |
| Cuota mostrada en diferidas | Capital puro (`monto/N`) |
| Tasa de diferidas (al día del desembolso) | 1,8334% MV / 24,36% EA en los datos vistos. Se actualiza el 1° de cada mes según Tasa de Usura del Banco de la República |
| Modelo de cálculo de intereses | `saldo × tasaMV × (días/30)` por cuota — la MISMA fórmula del motor. **No es capitalización diaria** (derogado en §4.3); el desfase viene del número de días del periodo |
| Avances tradicionales | Modelados como diferidas (sin evidencia clara aún) |
| Comisión de avance | No observada |
| Pago Mínimo: fórmula | Capital + Intereses + Mora + Otros − Saldo a favor |
| Pago Alternativo | Sí, 30% del Pago Mínimo (no modelado en app) |
| Fecha de pago | Aprox `corte + 14 días`; real: último día hábil del mes siguiente |
| Mora gradual | 1,30% / 5,80% / 12% / 20% según rango de días |

---

## 9. Contraste con Bancolombia Visa

Esta es la sección clave que justifica las decisiones de diseño en la UI.

| Aspecto | **Bancolombia Visa** | **RappiCard Visa** |
|---------|----------------------|---------------------|
| **Estructura del extracto** | Único en COP | Único en COP |
| **Compras intl en COP marcadas con tasa** | ✅ Sí (genera `INT INTL`) | ❌ **No (todas las compras tras conversión COP son tratadas iguales)** |
| **`aplicaIntInternacional` retorna** | `true` | `false` |
| **Cuota 1 de diferidas cobra intereses** | ❌ No (con flag `difiere_intereses_cuota1=1`) | ✅ Sí (siempre desde la cuota 1) |
| **Modelo de avances** | "Saldo facturado" (cuota 2+ cobra sobre saldo + cuotaCapital) | Igual que diferidas (cuota = capital, interés sobre saldo) |
| **Tasa MV** | Se actualiza el 1° de cada mes (Tasa de Usura BanRep) — igual que RappiCard | Se actualiza el 1° de cada mes (Tasa de Usura BanRep) — igual que Bancolombia |
| **Por qué los datos parecen mostrar comportamientos distintos** | Sus ciclos abarcan meses con cambios de tasa, así que "se nota" entre cuotas | En los 7 ciclos analizados el día de corte cae cerca del 20 y los movimientos del mismo ciclo cayeron mayoritariamente en el mismo mes, así que se ve más estable — pero la tasa real del producto SÍ cambia mes a mes |
| **Compra a 1 cuota** | 0% MV (igual) | 0% MV (igual) |
| **Comisión de avance** | $6.840 (Visa Platinum) | No observada en datos |
| **Concepto "Pago Alternativo"** | ❌ No existe | ✅ Sí (30% del Pago Mínimo) |
| **Fecha de pago** | `dia_pago` configurado en la tarjeta (ej. 16 del mes) | `corte + ~14 días` (último día hábil del mes siguiente) |

### 9.1 Por qué el checkbox "Compra Internacional" en RappiCard NO debe decir "(acumula intereses)"

**Razón técnica:** en Bancolombia Visa, marcar `es_internacional = 1` activa el cálculo `valor × tasa × días/30` en el motor (rama `aplicaIntl=true` en `backend/routes/extractos.js`), que se suma al `interesesComprasIntl` del ciclo y aparece como una línea separada en el desglose y en el Pago Mínimo.

En RappiCard, en cambio:
- El motor NO calcula nada para `es_internacional = 1` porque `aplicaIntInternacional('Davivienda', 'Visa')` retorna `false`.
- La compra se trata como cualquier compra COP nacional. Si es 1/1 → 0%; si es diferida → cae en el flujo normal de diferidas.
- El usuario marcaría el checkbox **solo como dato informativo** (recordar que esa compra fue de origen extranjero), pero el sistema no le suma ni un peso de interés extra.

**Razón de UX:** mostrar "(acumula intereses)" cuando el sistema no acumula nada generaría confusión. Por eso desde la implementación del label dinámico (v2.7.1), tarjetas con `aplicaIntInternacional=false` muestran únicamente **"Compra Internacional"**, dejando claro que el flag es informativo y los campos USD/Tasa de abajo son opcionales.

Esta decisión está implementada en `public/index.html` línea ~2509:
```js
const aplicaIntlForm = !!(tarjeta && tarjeta.banco
  && tarjeta.banco.toLowerCase().includes('bancolombia') && !_dualForm);
const intlCheckboxLabel = aplicaIntlForm
  ? 'Compra internacional (acumula intereses)'
  : 'Compra Internacional';
```

✓ Para RappiCard, `aplicaIntlForm` retorna `false` (porque `banco.includes('bancolombia')` es falso). Resultado: label "Compra Internacional" sin paréntesis.

---

## 10. Validación: ¿necesita ajustes el motor de cálculo?

### 10.1 Lo que ya está bien implementado ✓

1. **`backend/helpers/banco.js`**:
   - `aplicaIntInternacional('Davivienda', 'Visa')` → `false` ✓
   - `isDualExtracto('Visa')` → `false` ✓
   - `nuOpts(db, tarjetaId)` retorna `undefined` para RappiCard (porque `esNu=false` y `esBancolombia=false`) → diferidas usan modelo estándar ✓
   - `avanceOpts(db, tarjetaId)` retorna `undefined` → avances usan modelo estándar (no "saldo facturado" de Bancolombia) ✓

2. **`backend/engine/amortizacion.js → calcularAmortizacionDiferida`**:
   - Sin flag `esBancolombia`, cae en `interesTotal = interesPeriodo` desde i=0 → la cuota 1 **sí** cobra intereses ✓
   - Fórmula `saldoInicial × tasaMV × (dias/30)`: la **FORMA** está confirmada al centavo contra el PDF (§4.3) ✓, pero el insumo `dias` **NO** — usa cortes sintéticos de 30 días y conteo exclusivo. Ver §4.3.

3. **`backend/routes/extractos.js`**:
   - Detección `esRappiCardCalc` por `banco.includes('rappi')` o `'davivienda'` ✓
   - Fecha pago: `addDays(fechaCorte, 14)` ✓ (aproximación aceptable)
   - Compras 1/1 (no diferidas) **no acumulan intereses** porque `aplicaIntl=false` impide que se entre a la rama de cálculo ✓

4. **`backend/routes/dashboard.js`**:
   - Mismo comportamiento que extractos.js ✓
   - `interesesComprasUsdDash` no se calcula para RappiCard (porque `dualExtractoDash=false` y `aplicaIntlDash=false`) ✓

5. **`public/index.html`**:
   - Label dinámico del checkbox ya implementado en v2.7.1 ✓
   - Card "Deuda USD" oculta para RappiCard (porque `data.dualExtracto=false`) ✓
   - Columnas "Int Intl" y "Total" ocultas en tablas de Compras y Terceros para RappiCard (porque `aplicaIntl=false`) ✓

### 10.2 Lo que NO requiere cambios (con UNA excepción abierta)

✅ **La arquitectura actual ya distingue correctamente RappiCard** de las otras franquicias: la detección por banco, los flags y las ramas de cálculo están bien.

⚠️ **La excepción:** el **conteo de días** del motor de amortización cuando el banco adelanta el corte (§4.3). Está identificado y cuantificado ($1.657 en el ciclo de julio-2026, el 74% del desfase de intereses), y **NO implementado por decisión del usuario** — es un sub-proyecto de alto riesgo que además contaminaría un experimento de campo en curso. No dar por cerrado este documento sin leer §4.3.

### 10.3 Mejoras opcionales (no bloqueantes)

1. **Refinar la fecha de pago**: en lugar de `corte + 14 días`, calcular "último día calendario del mes siguiente al corte (ajustado a hábil)". Acercaría más al comportamiento real del banco. Residual actual: ~0,07% (despreciable).
2. **Mostrar "Pago Alternativo" (30% del Pago Mínimo)**: feature opcional que puede añadirse al detalle del extracto para tarjetas RappiCard. Ayudaría al usuario a saber el mínimo absoluto antes de mora.
3. **Lockeo de tasa por diferida (correcto)**: cada diferida individual conserva la tasa del día de su desembolso. La tasa "del producto" sí cambia el 1° de cada mes según la Tasa de Usura del BanRep, pero las diferidas vivas no se re-calculan retroactivamente. El motor ya hace esto correctamente almacenando `tasa_mv` en la fila de `diferidas` al momento de crearla.
4. **Auto-actualización mensual de tasas**: ya implementada vía `tarjetas.url_tasas` + scraping. Al inicio del mes el sistema consulta la página oficial (Bancolombia, RappiCard, Nu) y actualiza `tasa_mv_avances` y `tasa_mv_diferidas` de la tarjeta para que las nuevas compras/diferidas hereden la tasa actualizada del mes.

---

## 11. Apéndice — Datos crudos de los 7 extractos

### Saldos al cierre por ciclo

| Ciclo | Saldo a corte | Pago Total | Pago Mínimo | Pago Alternativo |
|-------|---------------|------------|-------------|------------------|
| 1 | $28.188 | $28.188 | $28.188 | n/a |
| 2 | $1.659.611,85 | $1.659.611,85 | $209.584,88 | n/a |
| 3 | $1.496.817,25 | $1.496.817,25 | $109.834,91 | $32.950,47 |
| 4 | $1.480.914,62 | $1.480.914,62 | $156.976,91 | $47.093,07 |
| 5 | $1.373.047,55 | $1.373.047,55 | $112.154,47 | $33.646,34 |
| 6 | $1.315.882,96 | $1.315.882,96 | $118.034,51 | $35.410,35 |
| 7 | $1.805.696,90 | $1.805.696,90 | $670.893,08 | $201.267,92 |

### Diferidas activas a lo largo de los ciclos (todas con tasa 1,8334%)

| Comercio | Monto | Plazo | Capital cuota | Ciclo desembolso |
|----------|-------|-------|---------------|------------------|
| BFINITY BITFI TECHNOLO | $397.419,29 | 24 | $16.559,13 | 22/10/2025 (ciclo 2) |
| BPAY GLOBAL | $210.632,22 | 24 | $8.776,34 | 22/10/2025 (ciclo 2) |
| BPAY GLOBAL | $329.858,02 | 24 | $13.744,08 | 22/10/2025 (ciclo 2) |
| BPAY GLOBAL | $330.863,13 | 24 | $13.785,96 | 24/10/2025 (ciclo 2) |
| PAGOS RAPPIPAY APP | $244.298,94 | 24 | $10.179,12 | 24/10/2025 (ciclo 2) |

Suma de cuotas mensuales constante: **$63.044,63** mes a mes (durante 24 meses) — confirma que la cuota es capital puro y no se ajusta por intereses.

---

**Mantenedor:** este documento se construyó a partir del análisis de `EXTRACTO RAPPICARD COMPLETO.pdf` y revisión cruzada con:
- `backend/engine/amortizacion.js` (rama estándar de diferidas, sin flag `esBancolombia`/`esNu`)
- `backend/routes/extractos.js` (detección `esRappiCardCalc`, fecha de pago)
- `backend/routes/dashboard.js` (rama no-dual, `aplicaIntInternacional=false`)
- `backend/helpers/banco.js` (helpers de detección)
- `backend/helpers/dates.js` (`addDays` para fecha de pago)
- Memoria del proyecto: `reference_rappicard_logic.md` (validada y actualizada con los datos del PDF)
- `docs/bancos/Bancolombia_Visa.md` (referencia comparativa)
