# Bancolombia — Franquicia Visa

**Fuente:** extractos consolidados de las tarjetas `[Tarjeta_Visa_A]` y `[Tarjeta_Visa_B]` ([USUARIO_PRINCIPAL]), períodos:
1. `31 ene – 28 feb 2026` (tarjeta `[Tarjeta_Visa_A]`)
2. `28 feb – 30 mar 2026` (tarjeta `[Tarjeta_Visa_B]`)
3. `30 mar – 30 abr 2026` (tarjeta `[Tarjeta_Visa_B]`)

**Estado:** documentación validada **vs código en producción**. Esta franquicia es la única hoy con motor de cálculo reconciliado al peso contra extractos reales del banco. Es el patrón de referencia del proyecto.

---

## 1. Estructura general del extracto

A diferencia de Mastercard, Visa Bancolombia genera un **único extracto en pesos (COP)**. Las compras realizadas en el exterior o por procesadores internacionales (SUSCRIPCION DIGITAL, JuegoWebA, DOMICILIOS DEMO, PASARELA PAGOS DEMO, DATOS ANALITICA LLC) se convierten automáticamente a COP el día de la transacción y se mezclan con las compras locales.

En consecuencia:
- **No** hay un extracto USD separado.
- **No** hay un Pago Mínimo USD.
- Las compras intl se identifican porque la línea trae una sub-fila `VR MONEDA ORIG <valor> <moneda>` (ej. `VR MONEDA ORIG 64.0 US`, `VR MONEDA ORIG 9.4 FI`) y porque su tasa de interés mensual mostrada es **distinta de 0%** (mientras que las compras nacionales 1/1 muestran 0,0000%).

> **Implicación en el motor:**
> - `isDualExtracto('Visa')` → `false` ✓ (helper en `backend/helpers/banco.js`)
> - `aplicaIntInternacional('Bancolombia', 'Visa')` → `true` ✓
> - El frontend no muestra columnas/cards USD para Visa.

---

## 2. Tasas de interés vigentes por ciclo

| Ciclo | Compra a 1 cuota | Compra 2-36 (MV) | Avances (MV) | Mora (MV) | Efectiva Anual |
|-------|------------------|------------------|--------------|-----------|----------------|
| 1 (ene-feb 2026, [Tarjeta_Visa_A]) | 0.0000% | 1.8895% | 1.8895% | 1.8895% | 25.1852% |
| 2 (feb-mar 2026, [Tarjeta_Visa_B]) | 0.0000% | 1.9110% | 1.9110% | 1.9110% | 25.5026% |
| 3 (mar-abr 2026, [Tarjeta_Visa_B]) | 0.0000% | 1.9915% | 1.9915% | 1.9915% | 26.6974% |

**Observaciones:**
- Las tres tasas (compras-cuotas / avances / mora) son siempre **iguales entre sí dentro de un mismo ciclo**.
- La tasa se actualiza el **1° de cada mes** según la **Tasa de Usura** publicada por el Banco de la República. Esto aplica para todos los emisores en Colombia (Bancolombia, RappiCard, Nu, etc.); no es exclusivo de Bancolombia.
- Como el ciclo de esta tarjeta abarca días de dos meses calendario distintos, los movimientos del ciclo pueden quedar registrados con dos tasas distintas (la del mes calendario en que cayó cada uno). Eso explica las diferencias intra-ciclo que se ven en los extractos.
- Visa Bancolombia, igual que Mastercard, fija la tasa de "Compra a una cuota" en **0,0000%**: pagar 1/1 al vencimiento es libre de interés.

---

## 3. Compras a 1 cuota (1/1)

### 3.1 Compras nacionales 1/1

Comportamiento observado:
- Tasa mostrada: `0,0000%` mensual.
- Si el usuario paga el extracto al vencimiento → 0 intereses.
- Si **no** se paga, el saldo pendiente entra al cargo "Intereses corrientes" del siguiente ciclo (ya no a 0%, sino a la tasa MV vigente).

Ejemplo del ciclo 3 (`30 mar - 30 abr`):
- `26/03 ENTIDAD GREMIAL DEMO $13.400 1/1 0,0000%` ← compra normal nacional
- `12/04 EDS ESTACION DOS $135.000 1/1 0,0000%`
- `04/04 PAYU*STREAMING DEMO $52.900 1/1 0,0000%`

### 3.2 Compras internacionales 1/1 (en COP)

Comportamiento observado en los extractos:
- Tasa mostrada: la **MV vigente del ciclo** (no 0%).
- Aparecen marcadas implícitamente porque el sub-renglón `VR MONEDA ORIG ...` indica el origen.
- Generan interés diferido al ciclo siguiente como parte del cargo agregado "INTERESES CORRIENTES".

Ejemplos del ciclo 2 (`28 feb - 30 mar 2026`, tasa 1,9110%):

| Fecha | Comercio | Valor COP | Cuotas | Tasa MV | VR Moneda Orig |
|-------|----------|-----------|--------|---------|----------------|
| 19/03 | SUSCRIPCION DIGITAL | 8.900   | 1/36 | 1,9110% | (diferida) |
| 16/03 | JuegoWebA           | 35.176,21 | 1/1  | 1,9110% | 9.4 FI |
| 16/03 | JuegoWebA           | 52.764,32 | 1/1  | 1,9110% | 14.1 FI |
| 16/03 | JuegoWebA           | 70.352,42 | 1/1  | 1,9110% | 18.8 FI |

Ejemplos del ciclo 3 (`30 mar - 30 abr`, tasa 1,9915%):

| Fecha | Comercio | Valor COP | Cuotas | Tasa MV | VR Moneda Orig |
|-------|----------|-----------|--------|---------|----------------|
| 19/04 | SUSCRIPCION DIGITAL  | 8.900     | 1/1 | 1,9915% | (sin sub-renglón) |
| 18/04 | DOMICILIOS DEMO      | 47.300    | 1/1 | 1,9915% | (sin sub-renglón) |
| 14/04 | DATOS ANALITICA LLC  | 233.235,52| 1/1 | 1,9915% | 64.0 US |
| 09/04 | SUSCRIPCION DIGITAL  | 39.900    | 1/1 | 1,9915% | (sin sub-renglón) |
| 04/04 | PAYU*STREAMING DEMO  | 52.900    | 1/1 | 0,0000% | (no es intl) |

> **Curiosidad:** DOMICILIOS DEMO y SUSCRIPCION DIGITAL aparecen marcados con tasa MV (intl) pero **sin** la sub-fila `VR MONEDA ORIG`. Parece que el banco los marca como intl por el código de comercio (MCC), no por el medio de pago. TIENDA ONLINE DEMO en cambio aparece a 0% en ese mismo ciclo: la clasificación es decisión interna de Bancolombia comercio por comercio.

> **Implicación en el motor:**
> Por eso el flag `es_internacional` en la tabla `compras` es manual (lo marca el usuario) y no se infiere de `valor_usd`. El usuario sabe cuáles van a generar `INT INTL` y cuáles no.

---

## 4. Cargo `INT INTL` — cómo se calcula y dónde aparece

### 4.1 Patrón observado en el extracto

Cada compra intl con tasa MV ≠ 0 aporta a un cargo agregado del ciclo siguiente, presentado en el detalle de movimientos como:

```
            <fecha de corte>   INTERESES CORRIENTES   $ <total>
```

Ejemplos:
- Ciclo 1 (28/02/2026): `INTERESES CORRIENTES $9.412,35` — sólo eran intereses sobre saldo del mes anterior, no había intl significativo
- Ciclo 2 (30/03/2026): `INTERESES CORRIENTES $274.318,60` — incluye intereses de avances + intl
- Ciclo 3 (30/04/2026): `INTERESES CORRIENTES $498.126,44` — avances + intl + diferida liquidada

Y en la sección "Detalle del pago mínimo" aparece el mismo monto bajo la línea `+ Intereses corrientes`.

### 4.2 Modelo subyacente del banco

Bancolombia usa **Capitalización Diaria sobre Saldo Diario Pendiente** (igual que para Mastercard). El interés diario de cada deuda se calcula:

```
interés_diario(día) = saldo_pendiente_de_esa_deuda(día) × (tasaMV / 30)
```

Y al cierre del ciclo se suman todos los interés_diario de todas las deudas (avances + diferidas + intl). Como el banco tiene el log día-por-día y nosotros no, replicarlo al peso es imposible sin esa información.

### 4.3 Cómo lo implementa el motor (aproximación itemizada)

**Archivo:** `backend/routes/extractos.js` y `backend/routes/dashboard.js`

Cada compra marcada con `es_internacional = 1` (o con `valor_usd > 0`) genera un interés calculado individualmente:

```js
interés_compra = saldo_compra × tasaMV × (días_compra_a_corte / 30)
```

Donde:
- `saldo_compra = valor_cop - monto_abonado`
- `días_compra_a_corte` = días entre la fecha de la compra y la fecha de corte del ciclo
- `tasaMV` = `tarjeta.tasa_mv_avances` (sí, usamos la tasa de avances, porque en Visa Bancolombia es la misma que la de intl, ver §2)

La **suma de todos los `interés_compra`** del ciclo se persiste en `extractos.intereses_intl` y se presenta en la app como una línea independiente "Intereses Internacionales" en el desglose.

### 4.4 Ajuste de presentación: ciclo de aparición

⚠️ **Detalle importante a tener en cuenta:**

- El **banco** factura el cargo `INTERESES CORRIENTES` en el ciclo **siguiente** a aquel donde apareció la compra (porque su capitalización es sobre saldos día-a-día).
- **Nuestro motor** muestra el `interés_intl` ya en el **mismo ciclo** de la compra (lo presenta de forma anticipada como parte del Pago Mínimo del ciclo de la compra).

Esto provoca que cuando un usuario compara la app contra el extracto del banco para un ciclo X:
- El **Pago Mínimo total** del ciclo X tiende a coincidir, porque incluye lo que se acumuló.
- Pero la **etiqueta** del cargo difiere: en el banco aparece como "Intereses corrientes" del ciclo X+1, mientras que en la app aparece como "Intereses Internacionales" del ciclo X.

Es una decisión arquitectónica deliberada: el usuario ve en el ciclo presente cuánto le va a costar el interés, antes de que el banco lo muestre como cargo.

### 4.5 Compras intl personales vs compras de terceros

El motor separa la porción de intereses intl que pertenece a compras "Personal" (sin `persona_id`) de las que pertenecen a compras de terceros.

**Archivo:** `backend/routes/dashboard.js`
- `interesesComprasIntl` (suma total) → alimenta la card "Intereses del Mes".
- `interesesComprasIntlPersonal` (sólo `persona_id IS NULL`) → suma a la card "Deuda Personal".
- La porción de terceros suma a "Me Deben Corte" (cada tercero recibe su porción proporcional).

En compras divididas (1 compra repartida entre varias personas), el interés se computa por cada hijo individualmente sobre su propio `valor_cop`, lo cual hace que la suma de hijos cuadre con el padre por construcción.

### 4.6 El interés corriente del banco puede exceder la aproximación del motor (revolving internacional)

Al conciliar un ciclo en el que hay **saldo internacional arrastrado** de ciclos anteriores, se observó que el cargo agregado "Intereses corrientes" del banco es **ligeramente mayor** que la suma que calcula el motor de:

```
interés_motor ≈ interés_avances + interés_intl_del_ciclo_actual
```

**Causa:** el banco aplica capitalización diaria sobre el **saldo internacional pendiente acumulado** (revolving), que incluye el remanente de compras internacionales de ciclos previos aún no saldadas por completo. El motor, en cambio, sólo calcula el interés internacional sobre las compras del **ciclo vigente** (proporcional a `días_compra_a_corte / 30`, ver §4.3), por lo que **subestima** el interés corriente cuando existe saldo internacional previo.

**Magnitud típica observada:** una fracción menor (orden de centésimas de punto porcentual del pago mínimo). Se considera **ruido aceptable**: modelar el revolving exacto exigiría el log día-a-día de saldos del banco, que no está disponible del lado del cliente. La conciliación del pago mínimo debe tolerar esta pequeña diferencia por debajo del componente de intereses.

---

## 5. Compras diferidas (2 a 36 cuotas) — la cuota 1 vs cuota 2

### 5.1 Comportamiento del banco

Para Bancolombia Visa con la flag `difiere_intereses_cuota1 = 1` (la más común), la regla es:

| Cuota | Capital cobrado | Interés cobrado |
|-------|-----------------|-----------------|
| 1     | `monto / N`     | **0** (el interés del período se acumula pero NO se factura) |
| 2     | `monto / N`     | `interés_periodo_2 + interés_acumulado_de_cuota_1` |
| 3+    | `monto / N`     | `interés_periodo` normal |

> **Por qué Bancolombia hace esto:** es un beneficio comercial — la cuota 1 sale "limpia" de capital. El interés del primer período se difiere a la cuota 2, donde se suma al interés normal de ese período.

### 5.2 Implementación en el motor

**Archivo:** `backend/engine/amortizacion.js` función `calcularAmortizacionDiferida`

```js
// Bancolombia: cuota 1 acumula intereses pero no se cobran (se difieren a cuota 2)
let interesPendienteCuota1 = 0;

for (let i = 0; i < numCuotas; i++) {
  const interesPeriodo = saldoInicial × tasaMV × (dias / 30);

  let interesTotal;
  if (esBancolombia && i === 0) {
    interesPendienteCuota1 = interesPeriodo;  // se guarda para cuota 2
    interesTotal = 0;                          // ← cuota 1 NO cobra interés
  } else if (esBancolombia && i === 1) {
    interesTotal = interesPeriodo + interesPendienteCuota1;  // cuota 2 = doble
  } else {
    interesTotal = interesPeriodo;
  }
  ...
}
```

La flag se activa cuando `nuOpts(db, tarjetaId)` devuelve `{ esBancolombia: true }`, lo cual ocurre solo si la tarjeta es Bancolombia Y tiene `difiere_intereses_cuota1 = 1` configurado en su registro.

> Tarjetas Bancolombia Visa con `difiere_intereses_cuota1 = 0` o `null` usan el modelo estándar (cada cuota cobra su propio interés desde el principio).

### 5.3 Validación con el extracto

Compra de prueba: `100001 - 19/03 SUSCRIPCION DIGITAL $8.900 a 36 cuotas`, ciclo 2 (tasa 1,9110%).
- Cuota 1 mostrada en extracto 2: `$247,22` ← exactamente `8900 / 36 = 247,22` (sólo capital, ✓)
- Cuota 2 mostrada en extracto 3 (sección "Movimientos antes de 30 mar"): `2/2 $8.652,61` ← saldo restante después de cuota 1 = `8900 - 247,22 = 8652,78` (la diferida fue **liquidada** en este ciclo).
- En extracto 3 también aparece un nuevo `SUSCRIPCION DIGITAL $8.900 1/1` que reemplaza la suscripción del mes — no es la misma compra.

El interés de la cuota 1 que se difirió y el interés del período 2 se cobran como parte del cargo agregado `INTERESES CORRIENTES $498.126,44` del ciclo 3.

### 5.4 Reprogramación del número de cuotas DESPUÉS del corte (cuotas irregulares)

El número de cuotas de una compra diferida puede cambiarse desde la banca virtual. Cuando el cambio se hace **después** de la fecha de corte del ciclo, el banco ya facturó la primera cuota según el **plan original**, y reprograma el saldo según el **plan nuevo**:

```
cuota_1 (ya facturada en el ciclo) = monto / N_original
saldo_restante                      = monto − cuota_1
                                     = se reprograma según N_nuevo en los ciclos siguientes
```

**Ejemplo genérico:** una compra diferida inicialmente a 36 cuotas y luego reducida a 2 cuotas, con el cambio aplicado tras el corte:
- Ciclo actual: se cobra `cuota_1 = monto / 36` (la del plan original, ya impresa en el extracto).
- Ciclo siguiente: se cobra `cuota_2 = monto − (monto / 36)` (todo el saldo restante de una vez).

Es decir, **las cuotas resultantes NO son iguales** (no es `monto / 2` cada una). 

> **Implicación en el motor:** desde v6.4.0 el motor representa el calendario irregular sin partir la compra: la reprogramación ("Sellar y Renacer") guarda el capital de cada cuota del plan nuevo en `capital_cuotas`, y `nuOptsDif` lo inyecta a la amortización en todos los sitios que la consumen. Conserva la cuota base del plan original y comprime el saldo en la **siguiente** cuota a facturar, que es lo que se midió en el banco.

**Arrastre del interés aplazado.** Con la gracia de la cuota 1, su interés se cobra en la cuota 2. Si se reprograma cuando solo la cuota 1 está facturada, esa cuota 2 deja de existir, pero el banco **no condona** el interés: lo cobra la primera cuota del plan nuevo, junto con lo que devengó la cuota 1 desde su corte hasta el pago. En la app, "Sellar y Renacer" guarda los dos datos en la diferida hija (`interes_arrastrado` y `capital_facturado_previo`) y su cuota 1 los cobra.

---

## 6. Avances — interés sobre el saldo diario

### 6.1 Comportamiento del banco

Avance ejemplo: `100002 - 10/03 AVANCE SUCURSAL VIRTUAL $18.000.000 a 24 cuotas`:

| Ciclo | Cuota | Cuota mostrada | Tasa MV | Saldo pendiente |
|-------|-------|----------------|---------|-----------------|
| Ciclo 2 (28 feb - 30 mar) | 1/24 | $750.000,00 | 1,9110% | $17.250.000,00 |
| Ciclo 3 (30 mar - 30 abr) | 2/24 | $750.000,00 | 1,9110% (la del ciclo de origen) | $16.500.000,00 |

`$18.000.000 ÷ 24 = $750.000,00` — la **cuota mostrada en el detalle es CAPITAL puro** (igual que en Mastercard).

**Tasa fija desde el desembolso:** la tasa MV asociada al avance queda fija a la del ciclo en que se desembolsó. Aunque el banco actualice su política de tasas en ciclos posteriores, los avances vivos siguen amortizando con su tasa original. Por eso en el extracto 3 se ve la cuota 2/24 del avance con `1,9110%` (la del ciclo 2) y no `1,9915%` (la del ciclo 3).

### 6.2 Implementación en el motor

**Archivo:** `backend/engine/amortizacion.js` función `calcularAmortizacionAvance`

El interés de cada ciclo tiene dos partes:

```
interés = saldo_sin_facturar × tasaMV × (días_del_periodo / 30)          ← capital que aún no se ha facturado
        + cuota_facturada_anterior × tasaMV × (días_hasta_el_pago / 30)  ← ver §6.4
```

> **Descartado: el modelo "saldo facturado"** (`(saldoInicio + cuotaCapital) × tasa`, sin contar días). Se usó un tiempo porque cuadraba en un mes concreto, pero sobreestimaba el interés en los meses siguientes y, contrastado contra tres extractos consecutivos, falla por mucho más que el modelo de saldo diario. El que sí cuadra los tres es el de arriba: lo que parecía "interés sobre la cuota del mes" era en realidad la cuota **anterior** devengando hasta que se pagó.

### 6.3 Comisiones de avance

- Cada avance trae una `COMISION AVANCE SUCURSA` separada el mismo día del desembolso.
- Valor observado: $6.840 por avance en Visa Platinum (ciclos 2026).
- En el motor: `comision` se almacena en la tabla `avances` y se factura una sola vez en la cuota 1 vía `comisionCuota = (i === 0 && comision) ? comision : 0`.

---

### 6.4 La cuota facturada devenga hasta el día del pago (avances y diferidas)

El banco liquida sobre el **saldo diario**: una cuota que se factura en el corte **no deja de devengar el día del corte**, sino el día en que se paga el extracto que la trajo. Ese interés aparece en el cargo agregado `INTERESES CORRIENTES` del **extracto siguiente**.

```
interés_cuota_facturada = capital_de_la_cuota × tasaMV × (días entre su corte y el pago) / 30
```

Ejemplo sintético: una cuota de $100.000 facturada el 30 a 2% MV y pagada 12 días después aporta `100.000 × 0,02 × 12/30 = $800` al interés del mes siguiente; pagada a los 16 días aportaría $1.066,67. Pagar antes **sí** baja el interés.

- **Fecha del pago:** la real si el extracto ya se pagó; si no, la fecha límite (§7.5), suponiendo pago a tiempo.
- **La última cuota de un plan** también devenga hasta el pago, pero ese interés llega en el extracto siguiente, cuando el plan ya no tiene cuotas. El motor lo suma como "cola" del plan (`backend/engine/colaCuotaFacturada.js`), y lo comparten el pago mínimo y la card de intereses del dashboard.
- **Validación:** contrastado contra tres extractos consecutivos de la Visa Infinite; sin este término el motor se quedaba corto en el orden del 3% del interés del mes, y el término se encogió en la misma proporción en que se acortó el tiempo entre corte y pago.
- **Alcance:** solo tarjetas Bancolombia (se inyecta por `nuOptsDif`/`avanceOpts`); RappiCard y Nu calculan como siempre.

---

## 7. Cálculo del Pago Mínimo (extracto en PESOS)

### 7.1 Fórmula deducida

```
Pago Mínimo COP =
    Cuota transacciones del mes              (capital de cuotas + compras 1/1 del ciclo)
  + Cuota transacciones anteriores           (capital de cuotas que vienen de meses pasados)
  + Cuota avances                            (capital de cuota del avance, en línea separada)
  + Intereses corrientes                     (cargo agregado: avances + diferidas + intl)
  + Intereses de mora
  + Otros cargos                             (comisiones de avance, cuota de manejo, IVA, CMF)
  + En mora
  − A favor
```

### 7.2 Verificación con ciclo 3 (mar-abr 2026)

| Concepto | Valor |
|----------|-------|
| Cuota transacciones del mes | $2.309.514,75 |
| Cuota transacciones anteriores | $8.652,61 |
| Cuota avances (separado) | $1.100.000,00 |
| Intereses corrientes | $498.126,44 |
| Otros cargos | $6.840 |
| **Suma** | **$3.923.133,80** |
| **Pago Mínimo extracto** | **$3.923.134,00** |

Diferencia de $0,20 — redondeo aceptable. **Cuadra al peso.** ✓

### 7.3 Implementación en el motor

**Archivo:** `backend/routes/extractos.js`

```js
const pagoMinimo = Math.round(comprasCiclo.total + cuotasTotal + interesesComprasIntl);
```

Donde:
- `comprasCiclo.total` = SUM(valor_cop − monto_abonado) WHERE estado NOT IN ('pagado','diferida')
- `cuotasTotal` = sum(`cuota.totalExtracto` de avances) + sum(`cuota.totalPagar` de diferidas) — incluye los intereses calculados con los modelos de §5 y §6
- `interesesComprasIntl` = sum de los intereses de compras intl COP

### 7.4 Pago Total

`Pago Total = Saldo a fecha de corte`. Es decir, todas las deudas pendientes (compras + saldo de avances + saldo de diferidas + intereses) menos abonos.

---

### 7.5 Fecha límite de pago

**Corte + 17 días calendario, corrida al siguiente día hábil** (sábado, domingo y festivos nacionales de Colombia). No son 17 días hábiles ni "el día 16 del mes siguiente": en un mes de 30 días la regla cae en el 17.

| Corte | + 17 días | Fecha límite del extracto |
|-------|-----------|---------------------------|
| 30-abr | 17-may (domingo); 18-may festivo | **19-may** |
| 30-jul | 16-ago (domingo); 17-ago festivo | **18-ago** |
| 30-ago | 16-sep (miércoles) | **16-sep** |
| 30-sep | 17-oct (sábado) | **19-oct** |

Festivos: fijos, los trasladables al lunes (Ley Emiliani) y los que dependen de la Pascua (Jueves y Viernes Santo, Ascensión, Corpus Christi, Sagrado Corazón). Implementado en `backend/helpers/fechaPago.js`. **Solo Visa**: las Mastercard/Amex de Bancolombia conservan el `dia_pago` configurado hasta medirlas con un extracto.

---

## 8. Tabla resumen del comportamiento de Visa

| Aspecto | Bancolombia Visa |
|---------|------------------|
| Extracto dual COP/USD | ❌ No — un solo extracto en COP |
| Compras 1/1 nacionales con tasa | 0,0000% MV |
| Compras 1/1 internacionales con tasa | Tasa MV vigente del ciclo (≠ 0%) |
| Compras 1/1 generan intereses si se pagan al vencimiento | ❌ Solo si NO se pagan |
| Cuota 1 de diferidas/avances cobra intereses | ❌ No (se difieren a cuota 2) |
| Cuota 2 cobra intereses doblados | ✅ Sí (período 1 + período 2) |
| Avances: modelo de cálculo | "Saldo facturado": `(saldoInicio + cuotaCapital) × tasaMV` desde cuota 2 |
| Avances: tasa | Fija desde el desembolso |
| Avances: comisión | Separada, una sola vez al desembolso (~$6.840 observado) |
| Cargo `INT INTL` | ✅ Sí — tasa MV × días/30 sobre cada compra intl |
| Tasa MV cambia ciclo a ciclo | ✅ Sí (1,8895% – 1,9915% en los ciclos vistos) |

---

## 9. Diferencias clave Visa vs Mastercard (Bancolombia)

| Aspecto | Bancolombia **Visa** | Bancolombia **Mastercard** |
|---------|----------------------|----------------------------|
| **Estructura del extracto** | Único en COP — todas las compras (incluso intl) se convierten a COP | Dual: COP y USD por separado |
| **Compras internacionales** | Aparecen en COP con tasa MV; sub-renglón `VR MONEDA ORIG` indica el origen | Aparecen en USD en el extracto separado; sub-renglón `VR MONEDA ORIG` también indica origen |
| **Cargo INT INTL** | ✅ Existe — agregado mensual sobre intl COP | ❌ No existe en COP — los intereses USD viven en el extracto USD |
| **Pago Mínimo USD** | N/A | Línea independiente con su propio total |
| **Helper `aplicaIntInternacional`** | `true` | `false` (porque es dual) |
| **Helper `isDualExtracto`** | `false` | `true` |
| **Cuota 1 de diferidas/avances** | Capital puro si `difiere_intereses_cuota1 = 1` (estándar) | Capital puro siempre — los intereses van al cargo agregado |
| **Modelo de intereses de avances** | "Saldo facturado" desde cuota 2 — validado al peso vs extracto Platinum abr 2026 | Mismo principio observado, pero la fórmula exacta requiere un quinto ciclo de validación |
| **Tasas MV** | Iguales: cambian mes a mes (1,8895% – 1,9915%) | Iguales: cambian mes a mes (1,8311% – 1,8895%) |
| **Comisión de avance** | $6.840 observado (fija) | Variable: $6.580 – $6.920 según el avance |

---

## 10. Curiosidades detectadas al contrastar con Mastercard

1. **Clasificación de comercios "intl"**: en el extracto de Visa, `DOMICILIOS DEMO` y `SUSCRIPCION DIGITAL` aparecen marcados como intl (tasa MV ≠ 0) **sin** sub-renglón `VR MONEDA ORIG`. En Mastercard sí aparece el sub-renglón. La clasificación parece depender del MCC del comercio + la red de la franquicia, no del modo de pago. Esto refuerza la decisión arquitectónica de que el flag `es_internacional` lo marque el usuario manualmente — no se puede inferir confiablemente del lado del cliente.

2. **`TIENDA ONLINE DEMO` aparece a 0%** en el ciclo 3 de Visa (`05/04/2026 TIENDA ONLINE DEMO $286.400 1/1 0,0000%`), pero en otros ciclos sí aparece como compra internacional. La clasificación de Bancolombia para ese comercio es inestable: a veces sale como nacional y a veces como intl, según cómo se enrutó la transacción (probablemente depende de si pasó por adquirente Colombia o adquirente USA). Conclusión: para ese comercio el usuario debe revisar caso por caso al marcar `es_internacional`.

3. **La línea `VR MONEDA ORIG` es informativa, no liquidadora**: en Visa, la conversión de USD a COP **ya está hecha** al momento de la transacción (a la TRM del día de la compra). El `VR MONEDA ORIG 64.0 US` para `DATOS ANALITICA LLC $233.235,52` significa que el comercio cobró 64 USD originalmente y el banco los convirtió a COP usando una TRM ≈ $3.644. En Mastercard, en cambio, esa misma información viene en el extracto USD y la conversión a COP se hace solo cuando el cliente paga.

4. **La cuota mostrada en el detalle es siempre capital puro** en ambas franquicias. Lo que cambia es **dónde** aparecen los intereses:
   - Visa: en una línea agregada "INTERESES CORRIENTES" que en el motor exponemos como `interesesComprasIntl` (intl) + `cuotasInteres` (avances/diferidas) por separado.
   - Mastercard: en una sola línea agrupada "INTERESES CORRIENTES" que en el motor exponemos junta bajo `cuotas_interes`.

5. **Avances en Visa Platinum: comisión fija $6.840.** En Mastercard observamos comisiones desde $6.580 hasta $6.920 según el avance (ver la tabla de §5 de `Bancolombia_Mastercard.md`), y en Amex $6.500 constante. La diferencia puede ser por categoría de tarjeta (Platinum vs Gold) o por el monto del avance. Es información a tener en cuenta si se diseña una calculadora de avances futura.

6. **El "corte de transacciones" es anterior a la fecha de fin de período impresa.** El período nominal del extracto (la leyenda "del día A al día B") **no** garantiza que todas las transacciones hasta el último día entren en ese ciclo. El banco cierra la captura de movimientos algunos días **antes** de la fecha de fin impresa; las compras de los últimos días del período pueden quedar facturadas en el extracto del ciclo **siguiente**.
   - **Implicación para la conciliación:** una compra registrada en la app en los últimos días del ciclo (según el `dia_corte` configurado) puede aparecer todavía "del mes" en la app, pero el banco la difiere al siguiente extracto. El pago mínimo de la app quedará por encima del extracto por el valor de esa compra, y la diferencia **se resuelve sola** cuando llega el extracto del ciclo siguiente.
   - **No es un error de datos:** la compra está bien registrada según la lógica de corte de la app; es un desfase de timing inherente a que el `dia_corte` del cliente es una aproximación del corte real de captura del banco. No debe "corregirse" moviendo la compra.

---

## 11. Apéndice — Datos crudos de los extractos analizados

### Saldos al cierre por ciclo

| Ciclo | Tarjeta | Saldo a corte | Pago Total | Pago Mínimo | Tasa MV |
|-------|---------|---------------|-----------|-------------|---------|
| 1 (ene-feb 2026) | [Tarjeta_Visa_A] | $9.412      | $9.412      | $9.412      | 1,8895% |
| 2 (feb-mar 2026) | [Tarjeta_Visa_B] | $27.845.190 | $27.845.190 | $6.312.408  | 1,9110% |
| 3 (mar-abr 2026) | [Tarjeta_Visa_B] | $28.117.455 | $28.117.455 | $3.923.134  | 1,9915% |

### Avances activos en ciclo 3 (referencia validación)

| Avance | Desembolso | Monto | Cuota actual | Capital cuota | Saldo |
|--------|------------|-------|--------------|----------------|-------|
| `100002` | 10/03/2026 | $18.000.000 | 2/24 | $750.000,00 | $16.500.000,00 |
| `100003` | 10/03/2026 | $4.800.000  | 2/24 | $200.000,00 | $4.400.000,00  |
| `100004` | 13/04/2026 | $3.600.000  | 1/24 | $150.000,00 | $3.450.000,00  |

Suma cuotas avances ciclo 3 = $1.100.000,00 → cuadra con la línea "+ Cuota avances" del detalle del pago mínimo.

---

**Mantenedor:** este documento se construyó a partir del análisis del PDF `EXTRACTO VISA COMPLETO.pdf` y revisión cruzada con el código de:
- `backend/engine/amortizacion.js` (motores de avances y diferidas)
- `backend/routes/extractos.js` (cálculo del pago mínimo)
- `backend/routes/dashboard.js` (split intl personal / tercero)
- `backend/helpers/banco.js` (helpers `aplicaIntInternacional`, `nuOpts`, `avanceOpts`, `isDualExtracto`)
