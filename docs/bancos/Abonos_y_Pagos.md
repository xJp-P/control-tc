# Abonos y Pagos — guía de conciliación

> Documento de reglas de negocio para el Asistente de Conciliación de Extractos.
> El motor lo carga junto al `.md` del banco para que la IA no confunda **pagos** con **compras**.
> Verificado contra el código actual (`routes/extractos.js`, `routes/abonoCapital.js`, `routes/compras.js`) — v3.6.

---

## 1. Dos conceptos distintos que el banco a veces etiqueta igual

En el extracto, el banco suele rotular los ingresos del cliente con etiquetas genéricas como
**"ABONO SUCURSAL VIRTUAL"**, **"PAGO PSE"**, **"ABONO"**, **"PAGO ATH"**, etc. Esa etiqueta
**no distingue** entre los dos casos siguientes. La diferencia es de **contexto**, no de texto:

### a) Pago del extracto (pago de la factura)
Es el dinero con el que el cliente cubre el **pago mínimo** (o el pago total) del extracto del
**ciclo anterior**. Es lo más común. A veces el cliente lo paga **fraccionado** en varias fechas,
y entonces aparecen **varios** "ABONO SUCURSAL VIRTUAL" en el extracto que **sumados** dan el pago.

En la app:
- Se registra con `PUT /api/extractos/:id/pagar` → tabla `pagos` con `tipo = 'abono_extracto'`
  (o `'pago_total'`), y nota "Abono a extracto" / "Pago completo extracto".
- **Pago mínimo indivisible:** las compras del ciclo se marcan `pagado` solo cuando el monto
  acumulado alcanza el **pago mínimo completo** del extracto (cubre compras + cuotas + intereses
  como bloque, igual que el banco).

### b) Abono a capital
Es dinero **extra**, por encima del pago de la factura, que el cliente entrega para **reducir el
saldo de la deuda** (capital) directamente. Es menos frecuente.

En la app:
- Se registra con `POST /api/abono-capital` → tabla `pagos` con `tipo = 'abono_capital'`.
- **Prerrequisito (código real):** si existe un extracto pendiente cuyo `fecha_corte <= fecha del
  abono` y cuyo `monto_pagado < pago_minimo`, el endpoint responde **400** y exige pagar primero
  ese extracto. O sea: **no se puede abonar a capital con la factura del ciclo sin cubrir.**
- **Orden de aplicación (cascada, código real `buildDeudas`):** el monto se reparte entre las
  deudas vivas en este orden, de la **más antigua a la más reciente** dentro de cada grupo:
  1. **Compras COP** pendientes (`pendiente`/`bolsillo`/`bolsillo_parcial`), por fecha.
  2. **Compras USD** pendientes, por fecha.
  3. **Diferidas** activas (saldo de la amortización), por `fecha_compra`.
  4. **Avances** activos (saldo), por `fecha_desembolso`.
  Cada deuda recibe `min(restante, su saldo)`; al cubrirse, la compra pasa a `pagado` y la
  diferida/avance a `liquidado`. Las diferidas/avances registran el abono en
  `abonos_diferida` / `abonos_avance`.

---

## 2. Regla CRÍTICA para el Asistente de IA

> **Los "ABONO SUCURSAL VIRTUAL" (y etiquetas equivalentes) NO son compras faltantes ni
> discrepancias accionables.**

Cuando la IA analice el extracto:

1. **Nunca** trates un abono/pago del extracto como una "compra omitida" ni como un cargo que
   falta registrar. Es dinero que **entró**, no un gasto.
2. **Por defecto**, un "ABONO SUCURSAL VIRTUAL" es el **pago del extracto del ciclo anterior**
   (posiblemente fraccionado en varias fechas que hay que **sumar**).
3. **Crúzalo con los pagos ya registrados en la app** (los que vienen en los movimientos con
   `tipo` `abono_extracto`/`pago_total`/`abono_capital`). Si coincide, repórtalo en
   `pagos_detectados` con `coincide_con_pago_app: true`.
4. Solo si un abono es claramente **adicional** al pago de la factura y reduce capital, trátalo
   como **abono a capital** — y aun así, **informativo**, no como discrepancia.
5. Ante la duda, **pago del extracto anterior**. No inventes un abono a capital que no esté
   respaldado por el contexto.

---

## 3. Resumen de `tipo` en la tabla `pagos`

| `tipo` | Qué es | Endpoint |
|---|---|---|
| `abono_extracto` | Pago (parcial o total) de la factura del ciclo | `PUT /api/extractos/:id/pagar` |
| `pago_total` | Pago del extracto marcado como total | `PUT /api/extractos/:id/pagar` |
| `abono_capital` | Dinero extra que reduce el saldo de la deuda | `POST /api/abono-capital` |

> Nota: una versión antigua de las reglas mencionaba un estado `por_cobrar`. **No existe** en el
> código actual; los estados reales de una compra son `pendiente`, `bolsillo`, `bolsillo_parcial`,
> `pagado` y `diferida`.

---

## 4. Pendiente de validación (experimento del usuario)

Para afinar estas reglas, el usuario hará el siguiente experimento con el extracto del próximo mes:
pagar el pago mínimo **completo** y luego un **abono a capital pequeño e identificable** (un monto
"raro", p. ej. $51.234), registrándolo en la app como abono a capital. Cuando llegue el extracto
siguiente, se analizará **cómo el banco etiqueta y aplica** ese abono (orden, si reduce capital o
intereses) para validar/corregir el orden de aplicación documentado arriba.
