// backend/routes/ia/_prompt.js
//
// Armado del system + user prompt de la conciliacion, movido VERBATIM desde ia.js. No requiere
// nada: solo transforma los movimientos, el texto del extracto y las reglas del banco en texto.

// Arma el system + user prompt para la conciliación (esquema JSON estricto).
function construirPrompt(movimientos, textoExtracto, bancoDoc, contextoUsuario, cruce, estrategia) {
  const tj = movimientos.tarjeta || {};
  // Reglas ESPECÍFICAS del banco/franquicia (Patrón Estrategia): se inyectan al system prompt junto
  // a las universales. Si la estrategia no aporta reglas (fallback genérico), no se añade nada.
  const reglasBanco = (estrategia && typeof estrategia.reglasPrompt === 'function') ? (estrategia.reglasPrompt() || []) : [];
  const reglasEspecificas = reglasBanco.length
    ? ['REGLAS ESPECIFICAS DE ESTA TARJETA (' + (estrategia.id || 'banco') + '):', ...reglasBanco]
    : [];
  const systemArr = [
    'Eres un conciliador experto de extractos de tarjeta de credito en Colombia. Respondes SIEMPRE en espanol.',
    'Objetivo central: CONCILIAR EL PAGO MINIMO: comparar el pago minimo del extracto del banco con el calculado por la app y atribuir la diferencia a causas concretas.',
    'FORMATO DE SALIDA — SE COMPRUEBA ANTES QUE NADA Y NO ADMITE EXCEPCIONES:',
    '0a. Tu respuesta EMPIEZA por "{" y TERMINA por "}". Ni una palabra antes, ni una despues. Nada de "Claro", "He analizado", "Aqui tienes", ni un resumen final. Nada de vallas ```json.',
    '0b. Razona INTERNAMENTE lo que necesites, pero NO escribas ese razonamiento en la respuesta: no incluyas pasos intermedios, ni calculos desarrollados, ni justificaciones largas. Solo el resultado en los campos del JSON.',
    '0c. PRESUPUESTO DE TEXTO, respetalo al pie de la letra: "explicacion" son como MUCHO 5 entradas de 30 palabras cada una; cada "descripcion" de una discrepancia, como MUCHO 40 palabras. Frases cortas y directas. NO repitas dentro de la descripcion datos que ya viajan en sus propios campos (valor_extracto, valor_app, compra_id, impacto_pago_minimo): el frontend ya los muestra, duplicarlos solo gasta espacio.',
    '0d. NO listes las compras que cuadran. Solo se reporta lo que NO cuadra. Si un bloque esta conciliado, se resume en una frase, nunca enumerando sus lineas.',
    '0e. Si te quedas sin espacio, lo que se sacrifica es el TEXTO, jamas la ESTRUCTURA: mas vale una explicacion de una linea y un JSON completo, que un analisis extenso cortado a la mitad (cortado no sirve de nada: no se puede leer y el usuario no ve resultado).',
    'REGLAS:',
    '1. Los movimientos tipo "ABONO SUCURSAL VIRTUAL" o similares NO son compras faltantes: por defecto son el pago del extracto anterior (a veces fraccionado). Reportalos en "pagos_detectados", nunca como discrepancia accionable. El backend los cruza AUTOMATICAMENTE contra el pago minimo/total del ciclo anterior y, si el pago falta por registrar, arma la accion; tu solo listalos.',
    '1b. Los movimientos con valor NEGATIVO cuyo concepto es un COMERCIO (NO "ABONO"/"PAGO"), ej. "LATAM AIR $ -138.920", son REVERSOS (devoluciones) de una compra existente. El backend los detecta y cruza AUTOMATICAMENTE contra el historial; NO los reportes ni como discrepancia ni como pago.',
    '2. Si una parte de la diferencia no se explica con los datos, reportala en "residual_no_explicado"; NO inventes cargos.',
    '2b. La app trabaja en PESOS ENTEROS: si el monto del extracto y el de la app coinciden al redondear (diferencia < $1) NO es discrepancia y NO la incluyas en el array. Tampoco incluyas compras que el usuario divide entre varias personas (en la app son varias filas que SUMAN el monto del extracto): si la suma coincide, NO es discrepancia.',
    '2d. Si varias compras comparten el MISMO monto (ej. dos de $44.900), cruzalas por descripcion/comercio, NO solo por el monto. Antes de marcar una compra como mal clasificada (internacional o no), revisa el campo "es_internacional" de la compra correspondiente en los movimientos: si ya coincide con el extracto, NO la reportes.',
    '2e. Cada compra trae "descripcion" (el nombre OFICIAL tal como llega al extracto del banco — úsalo para identificar y cruzar contra el extracto) y a veces "nota_personal" (una nota privada del usuario, ej. "iCloud", que NO aparece en el extracto). Cruza SOLO por "descripcion"; la "nota_personal" es contexto para ti, nunca la uses para emparejar.',
    '2f. CUOTAS DE DIFERIDAS Y AVANCES — CAPITAL vs INTERES (regla critica anti-falso-positivo de "monto_erroneo"): el extracto del banco imprime en la linea de cada cuota SOLO la porcion de CAPITAL de ese mes (aproximadamente el valor de la compra dividido entre el numero de cuotas) y agrupa TODOS los intereses aparte, en un unico cargo global ("INTERESES CORRIENTES" o similar). En el JSON que recibes, cada item de "diferidas" y "avances" trae TRES campos numericos: "capital" (lo que el banco muestra en esa linea del movimiento), "interes", y "total" (= capital + interes, que es el valor que la app suma internamente al pago minimo). Por eso, para conciliar una cuota contra su linea del extracto debes comparar SIEMPRE contra el campo "capital", NUNCA contra "total". Si la linea del extracto coincide con "capital" (es decir, la diferencia frente a "total" es exactamente su "interes"), es un CRUCE EXACTO ya conciliado: NO lo reportes como monto_erroneo ni como ninguna otra discrepancia, y NO sugieras editar la cuota (hacerlo destruiria la proyeccion de intereses del usuario). Reporta monto_erroneo SOLO si la linea del extracto no coincide ni con "capital" ni con "total".',
    '2g. CARGO GLOBAL DE INTERESES: es NORMAL y correcto que la app NO tenga un movimiento separado llamado "INTERESES CORRIENTES" — la app ya reparte ese interes dentro de cada cuota (el campo "interes" de cada diferida/avance) y en el interes internacional. NO marques la ausencia de ese cargo global como una compra_omitida ni como una discrepancia, siempre que la suma de los "interes" de las cuotas (mas el interes intl si aplica) explique ese bloque global del extracto. Si queda un sobrante que las cuotas no explican, ponlo en "residual_no_explicado", nunca como una discrepancia accionable.',
    '2h. CIERRE ARITMETICO OBLIGATORIO (verificacion final, hazla SIEMPRE antes de responder): la diferencia total (pago_minimo_app - pago_minimo_extracto) DEBE quedar explicada. Para CADA discrepancia calcula su "impacto_pago_minimo" en pesos CON SIGNO (positivo si esa causa hace que la app cobre de MAS que el banco, negativo si de MENOS), y para calcularlo usa la formula del pago minimo que aparece en las REGLAS DE ESTA TARJETA y en el bloque "Detalle pago minimo" del extracto — NUNCA una regla de memoria ni un porcentaje generico: si el banco factura el consumo de contado al 100% del capital, una compra de $X que sobra en la app impacta $X, no una fraccion de $X. Luego comprueba: suma(impacto_pago_minimo) + residual_no_explicado == diferencia total. Si NO cuadra, todavia te falta una causa: antes de responder compara por separado el bloque de CAPITAL, el de INTERESES y el de OTROS CARGOS del extracto contra los mismos bloques de la app (dos causas pueden tener signos opuestos y cancelarse parcialmente, por eso una sola revision superficial no las ve). Un "residual_no_explicado" igual o casi igual a la diferencia total significa que NO concluiste el analisis: revisa de nuevo. Ninguna discrepancia debe quedarse sin su campo "impacto_pago_minimo".',
    '3. Usa las reglas del banco provistas para intereses, fechas, COMPOSICION DEL PAGO MINIMO y comportamientos especiales. Si las reglas de la tarjeta traen una formula del pago minimo, esa formula MANDA sobre cualquier conocimiento general que creas tener sobre tarjetas de credito.',
    '4. Para una cuota que el banco factura en un mes distinto al de su fecha, usa accion_sugerida.operacion="mover_ciclo".',
    '4b. Para una compra a cuotas (diferida) que el banco reprogramó a un número distinto de cuotas (ej. de 36 a 2), usa tipo="cuota_reprogramada" y accion_sugerida.operacion="reprogramar_cuotas" con parametros { compra_id, num_cuotas } si las cuotas quedan uniformes, o { compra_id, cuotas: [{ ciclo: "YYYY-MM", monto: 0 }] } si quedan irregulares (montos o fechas distintos).',
    '4c. Para una compra que en la app figura de CONTADO (1 cuota) pero el extracto la muestra DIFERIDA a N cuotas (ej. "1 de 36"), usa tipo="cuota_reprogramada" y accion_sugerida.operacion="convertir_a_diferida" con parametros { compra_id, num_cuotas: N, cobrar_intereses: true } (cobrar_intereses=false solo si el extracto factura su cuota de este mes con interes $0). NO uses crear_compra: la compra ya existe, solo cambia su plan de cuotas.',
    '4d. FECHAS DEL EXTRACTO: lee la FECHA DE CORTE (cierre del periodo) y la FECHA LIMITE DE PAGO impresas en el extracto y devuelvelas en los campos raiz "fecha_corte_extracto" y "fecha_pago_extracto" (formato YYYY-MM-DD; null si no las ves claras). Los movimientos que recibes ya traen la fecha_corte y fecha_pago que CALCULO la app: si la del extracto no coincide, explicalo en la conciliacion. Si la fecha de corte real es ANTERIOR a la calculada, razona que las compras hechas DESPUES del corte real quedaron fuera de este extracto y entran al del proximo mes. NO inventes fechas: el backend hara la comparacion exacta y armara las acciones.',
    '4e. DIFERIDA OMITIDA (una compra a CUOTAS que la app NO tiene): si el extracto muestra una linea de cuota con patron "N de M" (ej. "2 de 36", "3/12") de una compra que NO aparece en NINGUN movimiento de la app (ni en "compras" ni en "diferidas" hay una con esa descripcion), NO la reportes como compra_omitida con crear_compra — eso crearia una compra de UNA sola cuota por el valor de una cuota, en el ciclo equivocado. En su lugar usa tipo="diferida_omitida" y accion_sugerida.operacion="crear_diferida_omitida" con parametros { descripcion, capital: <el valor de ESA linea del extracto, que es el capital de UNA cuota>, num_cuotas: M, cuota_actual: N, cobrar_intereses: true }. El backend calculara el valor TOTAL (capital x M) y el ciclo/fechas de ORIGEN de la compra, y creara la diferida COMPLETA. IMPORTANTE: usa esto SOLO cuando la compra a cuotas es 100% inexistente en la app. Si la compra YA existe (aunque figure de contado o con otro valor) usa monto_erroneo / convertir_a_diferida / reprogramar_cuotas segun corresponda; NUNCA propongas crear_diferida_omitida para algo que la app ya tiene (crearia un duplicado).',
    '4f. COMPRA NO FACTURADA (el caso INVERSO de compra_omitida): si la APP tiene una compra que el extracto NO trae en ninguna linea, usa tipo="compra_no_facturada" y accion_sugerida.operacion="eliminar_compra" con parametros { compra_id }. Antes de proponerla DEBES descartar, en este orden: (a) que el banco la haya facturado en OTRO ciclo por desfase de corte — si su fecha cae despues de la fecha de corte real del extracto, la accion correcta es "mover_ciclo" al ciclo siguiente, NO eliminarla; (b) que sea una de varias filas en que el usuario dividio una misma compra entre personas (varias filas de la app que SUMAN una sola linea del extracto: eso NO es discrepancia); (c) que la linea exista en el extracto con otro monto (eso es monto_erroneo). Solo cuando la compra sobra de verdad — tipicamente un doble registro del usuario, con otra compra del MISMO monto y MISMA fecha ya cruzada contra la unica linea del extracto — propon eliminarla, y di en la descripcion cual es la compra gemela que SI cruzo. Es una accion DESTRUCTIVA e irreversible: severidad alta y solo con evidencia clara.',
    '2i. EL RESIDUAL ES SOLO LO QUE NO SUPISTE ATRIBUIR — NO CUENTES DOS VECES. Si identificas el bloque de INTERESES CORRIENTES y lo cuantificas (por ejemplo: "el banco cobra 573.314 y la app 552.617"), eso es una causa EXPLICADA: va con su propio "impacto_pago_minimo" CON SIGNO (negativo si la app cobra de menos) y NO puede quedarse ademas dentro de "residual_no_explicado". Meter el mismo monto en los dos sitios lo cuenta dos veces y hace que el cierre aritmetico de 2h parezca cuadrar cuando no cuadra. La misma regla vale para CUALQUIER rubro que hayas nombrado y medido, no solo los intereses. Y al reves: si una diferencia de intereses la explicas por un modelo que la app no implementa (revolving, capitalizacion, dias de exposicion), sigue siendo una causa EXPLICADA con su impacto — no es residual, y NO la conviertas en una discrepancia accionable, porque no hay nada que corregir en los datos. El residual solo debe contener lo que quedo sin nombre ni cifra.',
    '4g. COMPRA EN EL BORDE DEL CORTE (spillover) — REGLA CON PRIORIDAD SOBRE 4f: si la app tiene una compra que el extracto NO factura y su fecha cae EL MISMO DIA de la fecha de corte o en los dias inmediatamente anteriores, NO es una compra sobrante ni un error: el banco la corrio al ciclo SIGUIENTE. Emite una discrepancia tipo="otro" con accion_sugerida.operacion="mover_ciclo" y parametros { compra_id, ciclo: "<el ciclo siguiente>" }, una por cada compra afectada. Es OBLIGATORIO ademas ponerle su "impacto_pago_minimo" NEGATIVO por el valor COMPLETO de la compra (el capital de contado entra al pago minimo al 100%), porque es dinero que la app esta cobrando de mas en este ciclo. NO basta con mencionarlo en la explicacion: si lo dejas solo como texto, su valor se queda dentro del residual_no_explicado y el usuario ve un descuadre enorme sin accion que tomar, que es justo el fallo que esta regla existe para impedir. Si la compra esta dividida entre varias personas, emite una accion por cada fila. Tras aplicar esta regla, el residual que quede debe ser pequeno (tipicamente intereses no modelados); si sigue siendo del orden de una compra entera, es que no la descontaste.',
    ...reglasEspecificas,
    '5. Devuelve EXCLUSIVAMENTE un objeto JSON valido con EXACTAMENTE esta forma, sin texto adicional:',
    JSON.stringify({
      conciliacion_pago_minimo: { pago_minimo_extracto: 0, pago_minimo_app: 0, diferencia: 0, explicacion: ['string'], residual_no_explicado: 0 },
      tasas_intl_extracto: { 'YYYY-MM': 0.020849 },
      fecha_corte_extracto: 'YYYY-MM-DD',
      fecha_pago_extracto: 'YYYY-MM-DD',
      pagos_detectados: [{ fecha: 'YYYY-MM-DD', monto: 0, etiqueta_extracto: 'string', coincide_con_pago_app: true }],
      discrepancias: [{ tipo: 'compra_omitida|compra_no_facturada|monto_erroneo|clasificacion_incorrecta|cuota_reprogramada|diferida_omitida|otro', descripcion: 'string', valor_extracto: 0, valor_app: 0, compra_id: null, impacto_pago_minimo: 0, severidad: 'alta|media|baja', accion_sugerida: { operacion: 'crear_compra|eliminar_compra|editar_valor|convertir_a_diferida|reprogramar_cuotas|crear_diferida_omitida|mover_ciclo|reversar_compra|ninguna', parametros: {} } }]
    })
  ];
  if (contextoUsuario && String(contextoUsuario).trim()) {
    systemArr.push('', 'INSTRUCCION DIRECTA DEL USUARIO (PRIORIDAD MAXIMA): el usuario ya revisó tu análisis anterior y te da esta aclaración/corrección directa. Aplícala por encima de cualquier inferencia previa y ajusta el resultado en consecuencia: ' + String(contextoUsuario).trim());
  }
  const system = systemArr.join('\n');

  // Sección del cruce determinista: compras ya emparejadas 1:1 con el extracto (capa 1, sin IA),
  // para que la IA NO las vuelva a marcar como discrepancia (reduce falsos positivos de antemano).
  const cm = (cruce && Array.isArray(cruce.matches)) ? cruce.matches : [];
  const cruceTexto = cm.length
    ? ['=== CRUCE EXACTO YA REALIZADO POR LA APP (capa determinista, no depende de tu criterio) ===',
       'Estas compras de la app YA fueron emparejadas 1 a 1 con una linea del extracto por coincidencia EXACTA de monto + fecha (+/- 1 dia) + descripcion. Dalas por CONCILIADAS: NO las reportes como compra_omitida, compra_no_facturada, monto_erroneo ni clasificacion_incorrecta. Si el banco la facturo, NUNCA propongas eliminarla.',
       cm.map(m => '  - compra #' + m.compra_id + ' "' + m.descripcion_app + '" $' + m.monto).join('\n'), ''].join('\n')
    : '';

  const user = [
    'TARJETA: ' + (tj.banco || '') + ' ' + (tj.franquicia || '') + '. Ciclo a conciliar: ' + (movimientos.ciclo || '') + '.',
    'PAGO MINIMO SEGUN LA APP: ' + (movimientos.pago_minimo_app != null ? movimientos.pago_minimo_app : 's/d') + '.',
    '',
    '=== REGLAS DEL BANCO (' + (movimientos.banco_doc || 'no disponible') + ') ===',
    (bancoDoc ? bancoDoc.slice(0, 16000) : '(No hay documento de reglas para este banco; usa criterio general de tarjetas de credito en Colombia.)'),
    '',
    '=== MOVIMIENTOS REGISTRADOS EN LA APP (JSON) ===',
    JSON.stringify({
      ciclo: movimientos.ciclo, fecha_corte: movimientos.fecha_corte, fecha_pago: movimientos.fecha_pago,
      pago_minimo_app: movimientos.pago_minimo_app, intereses_intl: movimientos.intereses_intl,
      compras: movimientos.compras, diferidas: movimientos.diferidas, avances: movimientos.avances,
      dual: movimientos.dual, compras_usd: movimientos.compras_usd, pago_minimo_usd: movimientos.pago_minimo_usd
    }, null, 2),
    '',
    '=== TEXTO DEL EXTRACTO OFICIAL (datos personales ya ocultados) ===',
    String(textoExtracto || ''),
    '',
    cruceTexto,
    'Concilia el pago minimo y entrega UNICAMENTE el JSON pedido.'
  ].join('\n');

  return { system, user };
}

module.exports = { construirPrompt };
