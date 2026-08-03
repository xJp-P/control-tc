// public/js/changelog.js — Novedades por version que la app muestra tras actualizarse.
//
// Extraido de public/index.html en la Etapa 1 del refactor de modularizacion. Es un LITERAL
// puro de cadenas: no llama a nada, no lee ningun otro simbolo y su unico consumidor lo usa
// dentro de un efecto, o sea en tiempo de evento, nunca durante la carga. Por eso el orden de
// esta etiqueta <script> frente a las demas es indiferente; se coloca primero por claridad.
//
// Se carga como script CLASICO, sin modulos: `const CHANGELOG` vive en el mismo ambito lexico
// global que el resto del codigo, asi que se sigue leyendo igual que cuando estaba en linea.
// No declarar este mismo nombre en ningun otro archivo: en scripts clasicos la redeclaracion
// es un SyntaxError que anula el archivo ENTERO, no solo la linea.

// Changelog por version (se muestra al abrir la app despues de actualizar)
const CHANGELOG = {
  '5.9.1': [
    'EL ASISTENTE YA MUEVE DE MES UNA COMPRA DIVIDIDA, SIN SACARTE DE LA PANTALLA. Cuando el asistente detectaba que el banco facturo en otro mes una compra repartida entre varias personas, te lo decia pero dejaba el boton apagado con un "editala a mano en la tabla". Ahora el boton funciona: mueve la compra COMPLETA, con todas sus partes juntas, conservando el reparto entre personas, las fechas reales y el dinero que tengas apartado. Si la lista traia una fila por cada parte, al mover una se marcan todas como resueltas.',
    'LA CIFRA DEL EXTRACTO YA NO SE PUEDE FIJAR ANTES DE ARREGLAR LAS COMPRAS. Era el riesgo mas serio de la pantalla: los cambios de compras podian quedar bloqueados y el unico boton disponible era el de fijar el pago minimo del banco. Y esa cifra es justo la que permite dar el mes por pagado; si la fijabas antes de mover una compra que era del mes siguiente, al pagar quedaba marcada como pagada en el mes equivocado y eso no tiene vuelta atras. Ahora ese boton espera a que resuelvas los cambios de compras pendientes y te dice cuantos faltan.',
    'Y para no dejarte encerrado, cada hallazgo de ese tipo trae un boton "Descartar": si el asistente se equivoco, lo marcas como revisado y dejas de tenerlo bloqueando. Siempre puedes deshacer el descarte.',
    'YA NO DICE "ACCION APLICADA" CUANDO NO HIZO NADA. Al mover una compra de mes, si el asistente no indicaba a que mes llevarla, la app la reasignaba a su mismo mes: no se movia nada y el mensaje decia que todo habia salido bien. Ahora avisa que no hay nada que mover y te pide volver a analizar.',
    'LAS VENTANAS DE CONFIRMACION MUESTRAN CIFRAS AL DIA. Antes repetian los numeros tal como estaban cuando se analizo el extracto, asi que despues de aplicar un cambio quedaban desfasadas: al fijar el pago minimo del banco te mostraba el estimado viejo, de antes de mover las compras. Ahora ese dato se vuelve a leer despues de cada cambio y se anade la diferencia entre lo que exige el banco y lo que calcula la app.'
  ],
  '5.9.0': [
    'LA APP LEE EL PAGO MINIMO DIRECTO DE TU EXTRACTO. Al conciliar el PDF, ahora reconoce la cifra que imprime el banco y te ofrece fijarla con un clic. Desde ese momento la app te muestra ESE valor como pago minimo, no su estimacion. Antes tenias que abrir el PDF, buscar el numero y escribirlo a mano porque el calculo propio nunca puede ser exacto: el banco cobra intereses que dependen del dia en que pagas. Ahora pagas lo que ves en pantalla y coincide con el banco. El estimado de la app se sigue guardando aparte, para comparar.',
    'YA PUEDES MOVER DE MES UNA COMPRA DIVIDIDA. El campo "Ciclo (avanzado)" solo aparecia en compras de una sola persona, asi que una compra repartida entre varios que el banco facturo en el mes siguiente no habia forma de moverla. Ahora se mueve completa, con todas sus partes, sin perder el reparto ni el dinero que tengas apartado.',
    'EL MODELO DE INTELIGENCIA ARTIFICIAL SE ELIGE DE UNA LISTA. En Configuracion, el modelo predeterminado era un campo de texto donde habia que escribir su nombre exacto; una letra de mas y el analisis fallaba sin explicacion. Ahora se elige de un menu con nombres cortos y claros, que cambia segun el proveedor.',
    'Se revisaron uno a uno los modelos que ofrecia la app y se quitaron SEIS que sus proveedores ya habian retirado. Dos de ellos eran los que se usaban por defecto, asi que quien no eligiera modelo estaba llamando a uno que ya no existe.',
    'EL ASISTENTE DE EXTRACTOS FALLA MUCHO MENOS Y AVISA MEJOR. Se corrigieron varios problemas que dejaban el analisis a medias: se quedaba esperando demasiado poco y se rendia antes de tiempo, se quedaba sin espacio para responder, y a veces descartaba una respuesta que en realidad era correcta. Ademas, cuando algo falla, ahora lo dice con detalle en vez de quedarse callado.',
    'LA APP SE REORGANIZO POR DENTRO DE ARRIBA A ABAJO. Lo que antes eran cuatro archivos enormes ahora son piezas pequenas y ordenadas por su funcion. No cambia nada de lo que ves ni de lo que calcula: se comprobo, cuenta por cuenta, que ni una sola cifra se movio. El objetivo es que los cambios futuros sean mas rapidos y mas seguros.',
    'Y con la reorganizacion viaja tambien una bateria de comprobaciones automaticas que revisa la app entera antes de cada cambio. Durante este trabajo ya evito que dos fallos serios llegaran hasta ti.'
  ],
  '5.8.1': [
    'SI ALGO NO CARGA, LA APP AHORA LO DICE EN VEZ DE QUEDARSE PENSANDO. Cuando la pantalla le pedia al programa algo que no existia, se quedaba esperando una respuesta que nunca llegaba: el boton giraba para siempre, sin aviso ni mensaje de error. Ahora responde de inmediato diciendo que no lo encontro, asi que un fallo se nota apenas ocurre en vez de parecer que la app se colgo.'
  ],
  '5.8.0': [
    'UN MES SOLO SE CIERRA CUANDO LO PAGAS, NO CUANDO PASA LA FECHA DE CORTE. Antes, apenas cortaba el mes la app dejaba de aceptar movimientos suyos, aunque faltaran dos semanas para pagarlo: si el 2 de agosto te acordabas de una compra del 29 de julio, no habia forma de registrarla. Ahora puedes registrarla, editarla, borrarla, ponerla a cuotas o reprogramarla mientras ese mes siga sin pagar. Los meses ya pagados siguen completamente bloqueados, igual que siempre.',
    'Se quitaron de paso el aviso y la confirmacion que aparecian al tocar una compra de un mes ya cortado: no estabas alterando ningun cierre, asi que sobraba el susto.',
    'LAS COMPRAS VIEJAS YA NO SE REGISTRAN CON LAS TASAS DE HOY. Al registrar una compra de dias atras, la app busca ahora la tasa de interes y el valor del dolar que regian EN LA FECHA DE LA COMPRA, no los del dia en que la escribes. La diferencia es real: el dolar del 6 de julio estaba en 3.334 pesos y el 1 de agosto en 3.144, casi un 6% de error. Para la tasa de interes usa la que el banco cobro ese mes, tomandola de tus propias compras ya conciliadas.',
    'Si registras algo en un mes cuyo pago minimo tomaste del extracto en PDF, la app te avisa: esa cifra viene del banco y no incluye lo que acabas de registrar. Tu decides si la dejas como esta o vuelves al calculo de la app.'
  ],
  '5.7.2': [
    'EL AVISO DEL MARGEN AL PAGAR AHORA DICE LA VERDAD DE CADA MES. Cuando ya tienes cargada la cifra del extracto del banco, la app te avisa que ese valor va tal cual y que ahi no hay margen: antes te ofrecia dos mil pesos de holgura que en ese caso no existian, y pagar de menos confiando en eso dejaba el mes sin saldar.',
    'Cuando el valor todavia es un estimado, el aviso y el boton muestran el margen real de ESE mes en vez de una cifra fija. En meses de cuota pequena el margen es menor a dos mil pesos, y antes se anunciaba siempre lo mismo.',
    'Nota: el margen nunca fue algo de una tarjeta en particular. Aplica a todas las tarjetas mientras el valor sea un estimado de la app, porque el estimado no puede ser exacto por diseno.'
  ],
  '5.7.1': [
    'PAGAR YA NO DEPENDE DE CONCILIAR. Conciliar el PDF es opcional; pagar no. Ahora puedes escribir el valor exacto que te pide el banco y la app lo acepta como pago completo aunque no coincida con su estimado, siempre que la diferencia sea menor a dos mil pesos. El extracto queda saldado y las compras del mes marcadas como pagadas, sin tener que subir ningun documento.',
    'Cuando eso pasa, la app ajusta sola el mes con la cifra que pagaste y te avisa cuanto absorbio, para que no te quede un aviso de "Falta" fantasma dando vueltas. Ese margen sale de haber medido 10 extractos: la diferencia nunca paso de mil seiscientos pesos, unas veces de mas y otras de menos, porque el banco cobra intereses por los dias que pasan hasta que pagas.',
    'Lo que NO cambia: un abono parcial de verdad sigue siendo un abono y no cierra el mes. Y si ya conciliaste el extracto de ese mes, la app conoce la cifra exacta del banco: ahi exige esa cifra y no aplica ningun margen, porque un faltante ya no seria un desfase de calculo sino plata que falta.'
  ],
  '5.7.0': [
    'SE ACABO TENER QUE MIRAR EL PDF PARA PAGAR (por ahora en RappiCard). Al conciliar un extracto de esa tarjeta, la app ahora LEE el pago minimo oficial impreso en el documento y lo guarda. Cuando le das a Pagar, te propone ese valor exacto, no un estimado: le das aceptar y listo. En la lista de extractos ese valor aparece marcado como "DEL EXTRACTO" para que sepas que es la cifra del banco y no un calculo; pasando el mouse por encima ves cuanto estimaba la app. En las demas tarjetas todo sigue igual que antes.',
    'POR QUE HACIA FALTA: revisamos 10 extractos de RappiCard, desde que abriste la tarjeta, y descubrimos por que la app nunca daba el numero exacto. Ademas de los intereses del plan de cuotas, el banco cobra intereses sobre la cuota que ya te facturo por cada dia que pasa hasta que pagas. Con el saldo de julio, esa parte vale 38 pesos si pagas el primer dia y 771 si pagas el dia 20: es decir, el valor depende de CUANDO pagues, algo que la app no puede saber por adelantado. Por eso ahora lee la cifra en vez de adivinarla.',
    'Tu estimado no desaparece: la app sigue calculando la deuda, el cupo y las proyecciones con su propio motor. La cifra del banco solo manda en el momento de pagar.',
    'Los nombres de tus compras de RappiCard quedaron alineados con los del extracto, para que la conciliacion los cruce sin dudas. Donde el banco solo dice "RAPPI" y tu tenias el nombre del sitio, ese nombre se movio a la nota personal: sigue visible bajo la compra, no se perdio nada.',
    'La app entiende mejor los extractos de RappiCard: ya reconoce los nombres de comercio que el banco parte en dos lineas y las compras que aparecen listadas pero sin cobro en el mes.'
  ],
  '5.6.3': [
    'El asistente de conciliacion ahora esta obligado a CUADRAR las cuentas: antes de mostrarte el analisis debe verificar que las diferencias que encontro sumen exactamente el descuadre del pago minimo. Si no cuadra, sigue buscando en vez de decirte "no se pudo explicar". Ademas cada diferencia te muestra cuanto explica en pesos, para que veas de donde sale cada peso del total.',
    'El asistente ya no se inventa reglas de otros bancos. Ahora recibe la formula EXACTA con la que cada banco arma su pago minimo y tiene prohibido aplicar porcentajes que no aparezcan impresos en tu extracto. Antes, en un extracto de RappiCard, calculo que una compra pesaba solo el 10% del pago minimo cuando en realidad pesa el 100%, y por eso reporto como inexplicable una diferencia que ya tenia resuelta.',
    'Nueva accion de 1 clic: ELIMINAR una compra que el banco NO facturo. Si registraste una compra dos veces por error, el asistente lo detecta y te ofrece borrar la sobrante, incluso si el mes ya cerro (que es justo cuando llega el extracto y no se puede borrar a mano). Antes solo sabia avisarte de compras que FALTABAN, nunca de las que sobraban. Como es una accion que no se puede deshacer, siempre pide confirmacion mostrandote los datos reales de la compra.',
    'La conciliacion de RappiCard ahora si cruza las compras automaticamente. El extracto de esa tarjeta tiene un formato distinto que la app no sabia leer, asi que todo el trabajo quedaba en manos de la inteligencia artificial, sin la verificacion automatica previa. Ahora la app empareja sola cada compra y cada cuota con su linea del extracto, y te indica con precision cual sobra o cual falta.'
  ],
  '5.6.2': [
    'Tus compras ya no se agrupan solas. Si registrabas dos o mas compras del mismo comercio, el mismo dia y en la misma tarjeta, y alguna tenia un responsable asignado, la app las unia por su cuenta en una sola "compra dividida" la siguiente vez que la abrias. Nunca fue algo que hicieras tu: era un arreglo antiguo que se quedo activo y se ejecutaba en cada arranque. Ya no existe, y las compras que registras separadas se quedan separadas.',
    'Esto ademas destraba esas compras: mientras estaban unidas por error, la app no te dejaba reversarlas, diferirlas a cuotas ni reprogramarlas, porque las trataba como parte de una compra dividida.',
    'Si ya tienes una compra unida por error, esta correccion evita que vuelva a pasar, pero no la separa sola: borrala y registra de nuevo cada compra por separado, siempre que el mes de esa compra siga abierto. Si ese mes ya cerro o ya lo pagaste, la app no te dejara borrarla (para no descuadrar un extracto ya facturado) y tocara dejarla como esta. Importante: usa "eliminar", no "editar".'
  ],
  '5.6.1': [
    'En "Dinero a favor" ya puedes deshacer CUALQUIER movimiento, incluidos los que aplicaste a compras de meses que ya pagaste. Si cruzaste un dinero por error, lo retiras y vuelve a quedar disponible para aplicarlo donde toca. La compra NO se reabre como pendiente con el banco: el mes cerrado queda intacto y esa persona simplemente vuelve a aparecer debiendote lo que le retiraste.',
    'El boton "Dinero a favor" de una persona ya no aparece cuando no le queda saldo Y todo ese dinero se uso en meses que ya pagaste: ese libro esta cerrado y esas compras ni siquiera siguen en la tabla, asi que solo generaba ruido. Sigue apareciendo si le queda dinero sin repartir (en verde con el monto) o si algun movimiento se aplico a una compra de un mes que aun no has pagado, que es donde si tiene sentido corregir.',
    'Dentro de "Dinero a favor", cada movimiento muestra de que mes es la compra, y los de meses que ya pagaste se ven marcados como "Mes pagado" en vez de ofrecerte deshacerlos: ese libro esta cerrado. Si un mismo dinero cubrio compras de varios meses, los del mes abierto conservan su boton para que puedas corregirlos.',
    'Corregido un detalle que confundia: al apartar o quitar dinero del bolsillo de una compra de un mes ya pagado, su estado dejaba de decir "Pagado" hasta que reiniciaras la app. Ahora se mantiene correcto al instante.',
    'Arreglado un caso en que el dinero de una persona se contaba DOBLE: si el banco reversaba una compra que ella ya te habia reembolsado, ese dinero volvia a quedar a su favor (correcto), pero el movimiento antiguo con el que se lo habias cruzado seguia siendo reversible, y deshacerlo le sumaba la misma plata otra vez. Ahora la app lo impide y te dice donde quedo ese dinero para que lo apliques desde ahi. Ademas, una compra que el banco reverso ya no reaparece como si esa persona te la debiera.'
  ],
  '5.6.0': [
    'REPROGRAMAR COMPRAS DE UN TERCERO. Ahora puedes cambiar el numero de cuotas de una compra que le prestaste a alguien, incluso si esa persona ya te reembolso parte o todo. Antes el boton "Reprogramar" estaba bloqueado para cualquier compra con responsable y tocaba retirarle los reembolsos a mano, uno por uno, para poder tocarla.',
    'COMO FUNCIONA: las cuotas que el banco ya te facturo quedan congeladas tal como se pagaron (no se vuelven a tocar) y el saldo que sigue vivo renace con el plan de cuotas nuevo. Lo que le debes al banco no cambia ni un peso: solo cambia en cuantas cuotas te queda repartido, y por eso el interes total se recalcula.',
    'DOS CUENTAS SEPARADAS: cada cuota congelada guarda por un lado lo que el banco te cobro y por otro el reembolso que esa persona ya te hizo, con sus intereses. Asi nunca se le vuelve a cobrar lo que ya pago; y si solo te reembolso una parte, sigues viendo que te debe el resto de esa cuota CON sus intereses (antes ese interes se perdia de su cuenta). El dinero de mas que aporto por los intereses de esas cuotas no le queda a favor, porque el banco ya te lo cobro.',
    'DINERO A FAVOR AUTOMATICO: si esa persona te habia adelantado cuotas que con el plan nuevo desaparecen, ese dinero ya no se mete solo en la cuota que queda. Pasa completo a su saldo a favor, con una nota de que compra salio, para que seas tu quien decida a que deuda suya aplicarlo desde "Dinero a favor" en Terceros. Lo mismo si te adelanto mas de lo que cuesta el plan nuevo.',
    'TODO EN UN SOLO LUGAR: cualquier deuda que venga de una reprogramacion se gestiona ahora desde Diferidas. La cuota final aparece SOLO ahi, ya no duplicada tambien en la lista de Compras; y aunque quede una sola cuota se muestra con su tabla de amortizacion y bien etiquetada como la ultima del plan (por ejemplo "Cuota 2/2"), en vez de quedar suelta como una compra corriente.',
    'HISTORIAL SIN PERDER EL HILO: al navegar a un mes pasado, las cuotas ya facturadas de una compra reprogramada se muestran en Diferidas con su estado "Pagado" y su numero de cuota, igual que cualquier otra cuota pagada, y desaparecen de la lista de Compras de ese mes. Asi ves el plan completo sin encontrarte la misma deuda dos veces.',
    'Arreglado un detalle de centavos: una cuota reembolsada al peso exacto ya no aparece como "no cubierta" en la pestana Terceros.'
  ],
  '5.5.3': [
    'Las cuotas ya facturadas de una compra a cuotas reprogramada ya no aparecen en la lista de Compras del mes pasado: viven solo en la seccion de Diferidas, donde ahora se ven igual que cualquier otra cuota pagada (sin resaltados especiales), manteniendo su estado "Pagado" y su numero de cuota.'
  ],
  '5.5.2': [
    'Las compras a cuotas reprogramadas ahora se ven de forma coherente: la cuota final (el saldo reprogramado) aparece SOLO en la seccion de Diferidas, ya no duplicada tambien en la lista de Compras.',
    'Al navegar a un mes pasado, las cuotas ya facturadas de una diferida reprogramada ahora tambien se muestran en la seccion de Diferidas (como historial, marcadas "sellada"), para que no se pierda el hilo del plan.'
  ],
  '5.5.1': [
    'Cuando reprogramas una compra a cuotas y queda una sola cuota pendiente, esa cuota ahora vive en la seccion de Diferidas (con su tabla de amortizacion), etiquetada correctamente como la ultima del plan (ej. "Cuota 2/2"), en vez de aparecer suelta como una compra corriente. Asi toda deuda que viene de una reprogramacion se gestiona siempre desde Diferidas.'
  ],
  '5.5.0': [
    'Ahora puedes reprogramar el numero de cuotas de una compra que tiene un responsable (un tercero), siempre que esa persona AUN no te haya reembolsado nada de esa compra. Antes el boton "Reprogramar" estaba deshabilitado para las compras con responsable; ahora funciona igual que con tus compras personales: las cuotas que ya te facturaron quedan como estan y el saldo restante se reparte en las cuotas nuevas, manteniendo a esa persona como responsable de la deuda.',
    'Si el tercero ya te habia reembolsado algo de esa compra, el boton sigue bloqueado a proposito (para no descuadrar esa cuenta): en ese caso, gestionala desde la pestana Terceros.'
  ],
  '5.4.0': [
    'La tabla de Compras ahora se reordena al instante: cuando registras una compra nueva o editas una existente, la fila salta de inmediato al primer lugar de su dia, sin recargar ni cerrar la vista. Asi ves el cambio en vivo apenas guardas.',
    'El criterio es: primero por fecha (las mas recientes arriba) y, dentro del mismo dia, la que acabas de crear o editar queda de primera. Esto solo pasa por tus ediciones manuales; las correcciones automaticas del Asistente IA y los pagos no te reordenan la tabla.'
  ],
  '5.3.0': [
    'El Asistente IA ahora detecta los PAGOS de tu tarjeta que aparecen en el extracto pero que olvidaste registrar en la app. Cuando el extracto muestra un pago (tipo "ABONO SUCURSAL VIRTUAL") que salda el extracto del mes ANTERIOR y la app no lo tiene, te lo propone para registrarlo con un clic: marca ese mes como pagado y lo suma al historial de Pagos.',
    'Solo te propone los pagos que cuadran con el pago minimo o el pago total del mes anterior (los que de verdad saldan la factura). Los abonos sueltos a la deuda quedan solo como informativos, sin boton, para que tu los revises con calma.'
  ],
  '5.2.0': [
    'El Asistente IA ahora reconoce las compras a cuotas que te faltaba registrar: cuando el extracto muestra una cuota tipo "2 de 36" de una compra a cuotas que no tienes en la app, te la propone como una diferida COMPLETA para crearla con un clic — calculando por ti el valor total de la compra, el numero de cuotas y el mes en que empezo. Antes la registraba mal, como una compra suelta por el valor de una sola cuota y en el mes equivocado.',
    'Ese mismo asistente evita crear duplicados: si la compra a cuotas ya existe en la app (aunque este saldada o sus cuotas caigan en otro mes), no te la vuelve a proponer.',
    'En el modo Demo del Asistente, las acciones de ejemplo ya no se aplican a tus datos: antes, darle "Aplicar" a un resultado de ejemplo podia modificar tu informacion real.'
  ],
  '5.1.0': [
    'Nueva opcion "Reprogramar" en las compras a cuotas: cuando el banco te cambia el numero de cuotas de una compra despues de haberte facturado alguna (por ejemplo, pasarla de 12 a 3 cuotas), ahora la app lo refleja con un clic. Las cuotas que ya te facturaron quedan como estan (tu historial no se toca) y el saldo restante se reparte en las cuotas nuevas. Abrela desde el detalle de la compra a cuotas; incluye una vista previa de como queda y una confirmacion antes de aplicar.',
    'La reprogramacion respeta el dinero que ya tenias apartado (bolsillo): lo traslada a las cuotas nuevas y, si el plan nuevo cuesta menos, te libera el excedente para que quede disponible.'
  ],
  '5.0.0': [
    'La casilla "El banco facturó esta compra en el siguiente corte" ahora funciona también con compras a cuotas (diferidas) y con compras divididas entre varias personas, no solo con las de una sola cuota. Igual que antes, la compra (y sus cuotas) quedan contadas en el corte correcto conservando su fecha real.',
    'Arreglado: al editar una compra dividida que usa el canje retrasado, los cambios (por ejemplo la fecha) ahora sí se guardan. Antes la compra se quedaba congelada sin avisar de ningún error.'
  ],
  '4.9.0': [
    'Nueva casilla al registrar una compra: "El banco facturó esta compra en el siguiente corte". Márcala cuando compras cerca del día de cierre y el banco la carga hasta el extracto del mes siguiente: la compra queda contada en el corte correcto conservando su fecha real, sin tener que cambiarle la fecha a mano. Disponible para compras de una sola cuota.',
    'El autocompletado del "Nombre en el Extracto" ahora está separado por tarjeta: al registrar una compra solo te sugiere comercios que ya habías usado en ESA tarjeta. Antes se mezclaban los de todas (por ejemplo, estando en la Visa te aparecían nombres de la RappiCard).'
  ],
  '4.8.3': [
    'Arreglado un caso en Terceros con compras internacionales: cuando el "Dinero a favor" de una persona (un reverso) cubria solo el valor de la compra pero no su interes, la app la marcaba como Pagada antes de tiempo y bloqueaba el boton para completar lo que faltaba. Ahora queda como pago parcial y puedes agregar el interes restante desde el boton Bolsillo hasta saldarla del todo.',
    'En Terceros, las compras internacionales de un tercero ahora tienen en cuenta su interes al calcular cuanto falta por cubrir, igual que la card "Me Deben". Antes ese interes no se contaba y la compra parecia saldada aunque faltara un poco.',
    'En la tabla de compras, cuando el banco te reversa una compra de un tercero que ya te habian reembolsado, ese movimiento ahora se marca con la etiqueta "reverso" (antes decia "abono parcial"), para que quede claro de donde viene.',
    'Al aplicar el "Dinero a favor" contra una deuda de la persona, el monto que se muestra que debe ahora incluye el interes internacional, para reflejar la deuda total real.'
  ],
  '4.8.2': [
    'Arreglado un caso en Terceros con compras internacionales: cuando el "Dinero a favor" de una persona (un reverso) cubria solo el valor de la compra pero no su interes, la app la marcaba como Pagada antes de tiempo y bloqueaba el boton para completar lo que faltaba. Ahora queda como pago parcial y puedes agregar el interes restante desde el boton Bolsillo hasta saldarla del todo.',
    'En Terceros, las compras internacionales de un tercero ahora tienen en cuenta su interes al calcular cuanto falta por cubrir, igual que la card "Me Deben". Antes ese interes no se contaba y la compra parecia saldada aunque faltara un poco.',
    'En la tabla de compras, cuando el banco te reversa una compra de un tercero que ya te habian reembolsado, ese movimiento ahora se marca con la etiqueta "reverso" (antes decia "abono parcial"), para que quede claro de donde viene.',
    'Al aplicar el "Dinero a favor" contra una deuda de la persona, el monto que se muestra que debe ahora incluye el interes internacional, para reflejar la deuda total real.'
  ],
  '4.8.1': [
    'En la pestaña Terceros, cuando el "Dinero a favor" de una persona (de un reverso) alcanzó a cubrir solo una parte de una compra, ahora puedes registrar en efectivo el resto que te pagó desde el botón Bolsillo, hasta dejarla en Pagado. Antes ese botón quedaba bloqueado y la compra se quedaba trabada en pago parcial.'
  ],
  '4.8.0': [
    'Ahora puedes registrar cuando el banco te devuelve (reversa) una compra: con un botón la marcas como devuelta, deja de contar como deuda y libera cupo, conservando su registro histórico.',
    'Si un tercero ya te había reembolsado una compra que el banco luego reversó, ese dinero queda guardado como "Dinero a favor" de esa persona. Desde la pestaña Terceros puedes cruzarlo contra otras deudas suyas, marcarlo como devuelto en efectivo, o deshacer el movimiento si te equivocaste.',
    'El Asistente de Conciliación detecta automáticamente los reversos en el extracto (aunque el banco acorte el nombre del comercio) y te deja aplicarlos con un clic.',
    'En Terceros, la columna "Dinero" ahora muestra "Pendiente" o "Pagado" de forma consistente para compras de contado y para cuotas de compras a plazos. Además, las cuotas que ya pagaste al banco dejan de mostrar el botón para apartar dinero, porque ya no hay nada que reservar.',
    'Ajustamos el cálculo de los intereses de los avances para que coincida exactamente con lo que cobra el banco en el extracto.',
    'Ahora puedes editar los datos de una compra de un mes ya cerrado (por ejemplo, corregir un error de tipeo antiguo). La app te pide confirmación antes de guardar; los meses ya pagados al banco siguen totalmente bloqueados.',
    'El Asistente de Conciliación ya no intenta modificar una compra dividida entre varias personas: te avisa que la edites a mano desde la tabla, evitando errores.'
  ],
  '4.7.4': [
    'La tabla de movimientos quedó más limpia cuando una compra tiene un abono parcial: la columna de Valor muestra solo el valor original y, debajo en texto gris, cuánto llevas abonado; el saldo que aún debes pasó a la columna Total. Antes todo se amontonaba en la columna de Valor.',
    'Corregido: al registrar un abono parcial, el estado de la compra ya no se queda en "Pendiente" por error. Ahora, si el dinero apartado en el bolsillo (o el reembolso de un tercero) cubre el saldo que queda, la compra se muestra correctamente como "Bolsillo".',
    'Corregido: hacer un abono parcial ya no borra el dinero que tenías apartado en el bolsillo de esa compra. Ese dinero se conserva (ajustado al nuevo saldo si quedaba de más) en lugar de desaparecer.'
  ],
  '4.7.3': [
    'Ahora puedes elegir qué modelo de inteligencia artificial usa el Asistente de Conciliación: toda la familia de Claude (Opus, Sonnet y Haiku) está disponible, tanto en la configuración como en cada análisis. Los modelos más potentes razonan mejor; los más rápidos consumen menos. La lista se actualizó a las versiones más recientes.',
    'El Asistente de Conciliación ya no marca como "monto erróneo" las cuotas de tus compras a plazos: ahora entiende que el banco muestra en cada cuota solo el capital y cobra todos los intereses juntos en un cargo aparte, así que da las cuotas por correctas en lugar de sugerir cambiarlas (lo que habría dañado tu proyección de intereses).'
  ],
  '4.7.1': [
    'El Asistente de Conciliación ahora puede convertir una compra de contado en una compra a cuotas con un solo botón ("Aplicar"), cuando el extracto del banco la trae diferida (por ejemplo, una suscripción que el banco pasó a 36 cuotas). Antes solo mostraba un mensaje pidiendo hacerlo a mano desde la tarjeta, lo cual era imposible si el mes ya estaba cerrado; ahora la conciliación lo resuelve directamente, respetando siempre los meses que ya pagaste.',
    'Corregido un error que impedía abrir la aplicación al cargar una copia de seguridad antigua: si a la base de datos le faltaban tablas recientes, el arranque fallaba. Ahora la app actualiza sola la estructura de cualquier base de datos vieja al abrirla, sin trabarse.'
  ],
  '4.7.0': [
    'Los meses que el banco cierra antes de tiempo (corte adelantado) ahora quedan tan protegidos como cualquier mes ya facturado: las compras de ese mes quedan selladas y no se les puede cambiar el valor, la fecha o el responsable, ni dividirlas en cuotas, reprogramarlas o eliminarlas (solo se permite corregir el nombre o la nota). Antes esta protección se guiaba únicamente por la fecha de corte habitual de la tarjeta; ahora reconoce la fecha real en la que el banco cortó.',
    'Las compras que caen en los días siguientes al corte adelantado —y que la app pasa automáticamente al mes siguiente— siguen siendo totalmente editables, como debe ser: el sellado se aplica solo a las que de verdad quedaron dentro del mes ya cerrado, sin bloquear por error las del mes nuevo.',
    'Toda la app refleja ahora el mes en curso real cuando el banco adelanta el corte: el resumen, la lista de pagos (donde la fecha aparece marcada como "ADELANTADO") y el Asistente de Conciliación muestran el ciclo correcto y no se quedan en un mes anterior que aún tengas sin pagar.'
  ],
  '4.6.0': [
    'Cuando el banco adelanta el corte de un mes (por ejemplo, porque la fecha caía en fin de semana), ahora puedes dejarlo registrado: la app aprende esa fecha de corte real y, a partir de ahí, las compras que hagas después de ese día entran automáticamente al mes siguiente, sin que tengas que moverlas a mano. Las compras que ya habías registrado en esa ventana también se reubican solas.',
    'El Asistente de IA detecta el corte adelantado al leer tu extracto y te ofrece aplicarlo con un solo botón ("Aplicar corte adelantado").',
    'La pantalla de conciliación quedó más limpia y profesional: ya no se duplican sugerencias para el mismo caso, se respeta la fecha de pago que hayas fijado a mano (no la vuelve a sugerir) y los títulos de las observaciones se muestran con un texto claro y legible.'
  ],
  '4.5.6': [
    'El Asistente de IA ahora te deja conciliar también el mes en curso, no solo los meses ya cerrados. Es útil cuando el banco adelanta el corte (por ejemplo, si la fecha cae en fin de semana) y ya te envió el extracto antes de tiempo: en el menú "Periodo a conciliar" verás el mes actual marcado como "Ciclo en curso / Corte adelantado", listo para analizar tu PDF.'
  ],
  '4.5.5': [
    'Corregido un error importante en el cálculo de la "Deuda Total" y el "Cupo Usado": las compras a cuotas internacionales facturadas en pesos (ej. de Visa) no estaban sumando su saldo completo, así que el cupo mostraba disponible de más. Ahora la deuda refleja el saldo real de todas tus cuotas.',
    'Cuando la deuda supera el cupo de la tarjeta, la app ahora lo avisa con claridad: muestra el estado de "Sobrecupo" con el valor disponible en negativo (ej. -$1.500.000) y la barra de cupo en rojo, sin desbordarse del recuadro.',
    'Nuevo autocompletado al escribir el "Nombre en el Extracto": mientras escribes, la app te sugiere nombres de compras que ya registraste antes (ej. al teclear "A" te ofrece APPLE.COM/US, AMAZON, etc.), en un menú con el mismo estilo visual de la aplicación. Puedes elegir una sugerencia o seguir escribiendo un nombre nuevo.'
  ],
  '4.5.4': [
    'Ahora puedes cambiar el número de cuotas de una compra internacional (la que se factura en pesos, ej. de Visa) mientras el mes esté abierto, igual que cualquier otra compra. Antes el sistema lo impedía por error solo porque la compra tenía además un valor de referencia en dólares.',
    'Al registrar una compra internacional, si escribes el valor en pesos y el valor en dólares, la app ahora calcula sola la tasa de cambio (pesos por dólar). Antes esto solo funcionaba al revés (escribiendo la tasa para obtener los pesos).'
  ],
  '4.5.3': [
    'Las tablas se ven más limpias: el nombre de la compra, su nota personal y la etiqueta de cuota (ej. "Cuota 2/12") ahora van juntos en una sola línea compacta, en vez de apilarse y estirar la fila al doble de alto.',
    'La pestaña "Diferidas" ahora también muestra la nota personal de cada compra junto a su nombre, igual que la tabla principal — así tienes el mismo contexto en ambas vistas (ej. ver "MacBook" al lado de "APPLE.COM/US").'
  ],
  '4.5.2': [
    'Corregido un detalle visual de ordenamiento: cuando una compra dividida y una compra normal tenían la misma fecha, la dividida podía aparecer por debajo aunque se hubiera registrado después. Ahora, ante la misma fecha, manda el orden real de registro (la más reciente arriba en la tabla de compras, y el orden cronológico correcto en el desglose del extracto).'
  ],
  '4.5.1': [
    'Los meses que ya cerraron quedan ahora protegidos por completo, también en el servidor: no se puede crear una compra nueva en un mes ya facturado, ni eliminarla, ni dividirla en cuotas, ni fusionar una compra dividida, ni mover una compra de un mes abierto hacia uno cerrado. La app lo bloquea con un mensaje claro: lo que el banco ya facturó no se cambia.',
    'Al editar una compra de un mes cerrado solo quedan activos el nombre y las notas; el resto de campos se ve en gris y bloqueado, con un aviso que explica el motivo. El Asistente de Conciliación conserva su permiso especial para corregir el pasado (siempre con tu confirmación), porque su trabajo es justamente cuadrar la app contra el extracto real del banco.',
    'La división de compras entre personas se rediseñó por completo: tu propia porción ("Mi parte (Yo)") ahora es una fila más de la lista, igual que las de los demás. Puedes escribir exactamente cuánto asumes tú, borrar tu fila si no pagas nada, y repartir el total en partes iguales con un solo botón. Las partes siempre deben sumar el valor exacto de la compra: si falta o sobra dinero, la app lo muestra en rojo y no deja guardar (lo que falte nunca se te asigna solo).',
    'En la tabla de compras, las compras a cuotas ya no muestran la etiqueta genérica "Diferida" en la columna de estado: ahora ves su estado real (Pendiente, Bolsillo o Pagado) con su color, igual que cualquier otra compra. El contador "Cuota X/Y" sigue indicando que es una compra a cuotas.'
  ],
  '4.5.0': [
    'Libertad total de cuotas: mientras el ciclo esté en curso, ya puedes cambiar el número de cuotas de una compra directamente desde su edición, sin borrarla ni recrearla. Puedes pasar una compra de contado a cuotas, cambiar de un número de cuotas a otro, o devolverla a una sola cuota — las veces que necesites. La compra conserva siempre su fecha original, y el dinero que tuvieras apartado en el bolsillo se reparte entre las cuotas (o se vuelve a juntar al revertir), sin perder un peso.',
    'Protección de ciclos ya cerrados: una vez que un ciclo cierra (el banco genera su extracto), aunque todavía no lo hayas pagado, su estructura queda sellada. Por eso el número de cuotas de las compras de meses anteriores ya no se puede cambiar a mano, para no descuadrar el extracto del banco. Lo que sí puedes seguir haciendo en esas compras es corregir su nombre o su nota. (El Asistente de Conciliación mantiene su propia vía para ajustar cuotas del pasado cuando el banco las reprogramó).'
  ],
  '4.4.2': [
    'La pestaña Terceros se ve más clara en las compras a cuotas: el contador de cada cuota (ej. "Cuota 1/3") ahora es una etiqueta visual sutil en vez de texto suelto, para separarlo mejor del nombre del comercio.',
    'Además, en esas cuotas la columna de estado ahora muestra el estado real frente al banco de cada una —"Pagado" si ya pagaste el extracto de ese mes, o "Pendiente" si no— en lugar del genérico "Diferida" que no aportaba información. Así distingues de un vistazo lo que ya pagaste al banco de lo que el tercero aún te debe (que sigue en su propia columna).'
  ],
  '4.4.1': [
    'Corregido: en la pestaña de Diferidas, las cuotas que pertenecen a un tercero (alguien que te debe) dejaban apartar dinero en tu bolsillo, cuando ese dinero solo debe gestionarse desde la pestaña Terceros. Ahora esa cuota se ve en gris y bloqueada (se sigue gestionando desde Terceros, como debe ser), mientras que tu parte personal de una compra dividida se maneja con normalidad.',
    'Detalle visual: en las compras divididas, tu parte "Personal" ahora muestra el mismo punto de color (en gris) que las partes de las demás personas, para que la lista quede pareja y alineada.'
  ],
  '4.4.0': [
    'Si tu fecha de corte cae a mitad de mes, tu extracto abarca días de dos meses distintos; y como la tasa de interés que regula el banco cambia el 1° de cada mes, una misma factura puede traer dos tasas diferentes. Ahora el Asistente de Conciliación lee la tasa exacta de cada compra internacional directamente de su línea en el extracto y le asigna a cada una la que le corresponde según su mes, en lugar de usar una sola tasa para todo el ciclo. Cuando detecta dos tasas, te muestra las compras agrupadas por su tasa y las sincronizas con un solo clic. Si tu ciclo cae dentro de un mismo mes, todo funciona igual que antes.'
  ],
  '4.3.2': [
    'El Asistente de Conciliación ahora maneja el desfase de la fecha de corte en los dos sentidos. Antes solo entendía cuando el banco cerraba el mes ANTES de lo calculado (y movía tus compras al mes siguiente); ahora también detecta cuando el banco cierra DESPUÉS y te trae al mes actual las compras que la app había puesto en el siguiente. En ambos casos te las muestra una por una para moverlas con un clic, al mes en que el banco realmente las factura.',
    'Las compras a cuotas (diferidas) y los avances ahora se cuadran con el extracto usando su capital (el valor sin intereses), que es justo lo que el banco imprime en cada línea. Antes la app comparaba el valor con los intereses ya incluidos y esas líneas no lograban cruzarse; ahora coinciden de forma exacta.',
    'Ya puedes corregir el nombre de una compra a cuotas o de un avance en curso (y agregarle una nota), sin riesgo de tocar sus montos, fechas o tasas, que quedan fijos. Al cambiar el nombre, este se actualiza en toda la app a la vez: si era una compra dividida entre varias personas, el nuevo nombre aparece también en la pestaña Terceros y en cada una de sus partes.',
    'La pestaña de Diferidas ahora agrupa las compras divididas igual que el resto de la app: una fila principal con la etiqueta "Dividida" y debajo cada parte (cada persona), en vez de mostrarlas sueltas. Además, al editar una compra a cuotas o un avance, los campos que no se pueden cambiar (monto, fecha, tasa, cuotas) se ven en gris para que quede claro de un vistazo cuáles son fijos.'
  ],
  '4.3.1': [
    'El Asistente de Conciliación ahora detecta si el banco movió la fecha límite de pago de un ciclo (por ejemplo por un festivo o un fin de semana) y te deja ajustarla con un solo clic, sin entrar a los ajustes. Es solo un cambio visual: no altera tus intereses ni el pago mínimo.',
    'También te avisa cuando la fecha de corte del banco no coincide con la calculada por la app: te explica qué compras quedaron por fuera de este extracto (porque las hiciste después del corte real) y te ofrece moverlas, una por una, al mes en que el banco realmente las factura.'
  ],
  '4.3.0': [
    'El Asistente de Conciliación ahora entiende los extractos de más tarjetas, no solo Bancolombia Visa. Reconoce el formato de Bancolombia Mastercard y American Express (que traen dos extractos, uno en pesos y otro en dólares), el de RappiCard y el de Nu, cada uno con sus reglas propias: por ejemplo, que RappiCard no maneja un cobro de interés internacional aparte, o la comisión por cambio de moneda de Nu.',
    'En las tarjetas Mastercard y American Express, las compras en dólares ahora se cuadran con el extracto comparando dólar contra dólar (sin pasar por la tasa de cambio), que es la forma exacta de hacerlo. Además se corrigió un error que, en compras cuyo nombre incluye un número de referencia largo (como algunas de PayPal), tomaba ese número como si fuera el valor de la compra.'
  ],
  '4.2.1': [
    'El Asistente de Conciliación ahora cruza tus compras con el extracto de forma más precisa: primero empareja por su cuenta las que coinciden exactamente en monto, fecha y nombre del comercio, antes de pedirle ayuda a la IA. Así, cuando tienes dos compras por el mismo valor (por ejemplo dos viajes del mismo día), ya no las confunde entre sí, y deja de marcar como "diferencia" compras que en realidad ya están bien registradas. Verás un aviso de cuántas compras se conciliaron automáticamente.'
  ],
  '4.2.0': [
    'El interés de tus compras internacionales ahora se calcula igual en todos lados: el pago mínimo del inicio, el de la sección de Pagos y el detalle de cada compra siempre coinciden. Antes, cuando la tasa de la tarjeta subía o bajaba, el pago mínimo podía mostrar un interés internacional un poco distinto al del detalle de las compras; ahora ambos usan la tasa real congelada de cada compra y cuadran al peso.',
    'El Asistente de Conciliación ahora lee del extracto la tasa de interés de tus compras internacionales (por ejemplo 2,0849 %) y, si no coincide con la que tienes guardada, te lo señala: te muestra a qué compras afecta y cómo cambiaría el interés de cada una. Con un clic, y tu confirmación, la app actualiza esa tasa en esas compras. Como siempre, la IA solo lo sugiere: nada cambia sin que lo apruebes, y si el extracto de ese mes ya está pagado, no se toca.'
  ],
  '4.1.1': [
    'Corregido un error en lo que te deben tus terceros por compras a cuotas (diferidas): cuando ya había pasado la fecha de corte de una cuota, la app la descontaba de la deuda del tercero como si estuviera saldada, aunque el tercero no te la hubiera reembolsado. Ahora una cuota solo se considera pagada cuando el tercero realmente te la devuelve, no por el simple paso del tiempo. Ejemplo: una compra a 3 cuotas de la que tu tercero solo te pagó 1 ahora muestra correctamente las 2 que aún te debe, tanto en la pestaña Terceros como en la tarjeta "Me Deben" del inicio.'
  ],
  '4.1.0': [
    'El Asistente de IA ahora puede reprogramar las cuotas de una compra con un clic. Cuando el banco cambia el número de cuotas de una compra (por ejemplo, de 36 a 2), la app lo detecta en el extracto y te propone ajustarlo: puedes dejar las cuotas parejas o, si el banco las dejó con montos o fechas distintos, dividir la compra en cuotas individuales. Siempre con una confirmación que te muestra qué se va a cambiar, y sin tocar los meses que ya pagaste.',
    'Nuevo "Re-analizar con tu contexto": después de ver el análisis de la IA, puedes escribirle una aclaración (por ejemplo, "la compra de Apple la pasé a 2 cuotas en el banco") y volver a analizar al instante, con el mismo PDF y datos, sin subir nada de nuevo. La IA toma tu aclaración como una instrucción directa para corregir su análisis anterior.',
    'El dinero que apartas para tus propias compras se ordena solo: cuando pagas el extracto de un mes, lo que habías reservado para esas compras tuyas se libera automáticamente (y se limpian de una vez los apartados que habían quedado de meses anteriores). Importante: esto aplica solo a tus compras propias; lo que te deben tus terceros (la pestaña Terceros) queda siempre intacto.',
    'Un abono a capital sobre una compra a cuotas o un avance propios también libera el dinero que tenías apartado, igual que con las compras de una sola cuota, y te avisa cuánto quedó disponible. Las deudas de terceros nunca se ven afectadas.',
    'Ahora separas el "Nombre en el Extracto" (cómo llega la compra al banco, por ejemplo APPLE.COM/BILL) de una "Nota personal" opcional (tu recordatorio, por ejemplo "iCloud"). El nombre del extracto ayuda a que la IA cruce bien tus compras, y tu nota aparece en letra pequeña bajo el nombre en las pestañas Resumen y Terceros.',
    'En el Asistente de IA puedes elegir el modelo de cada proveedor desde un menú desplegable. Los modelos más avanzados razonan mejor, pero consumen más tokens.',
    'Más protección para tus terceros: el dinero apartado en una compra de un tercero (lo que te ha reembolsado) solo se gestiona desde la pestaña Terceros; en las demás vistas se indica así. Además, si una compra de un tercero ya tiene reembolsos, la app no permite reprogramar ni dividir sus cuotas, para no descuadrar esa cuenta.',
    'Las compras internacionales ahora pueden "congelar" la tasa de interés que el banco les aplicó. Al registrar o editar una compra internacional puedes escribir la tasa exacta del extracto (por ejemplo 2,0849 %) y su interés queda fijo: ya no se recalcula si después sube o baja la tasa de la tarjeta. Antes, al actualizar la tasa, el interés de compras de meses anteriores se reescribía con la tasa nueva y descuadraba las cuentas (sobre todo lo que te deben tus terceros). Las compras internacionales nuevas guardan automáticamente la tasa vigente al registrarlas (nacen congeladas), y una nueva columna "Tasa" en Resumen y Terceros muestra la de cada compra: en gris y cursiva cuando todavía usa la tasa actual de la tarjeta y conviene que la fijes desde el extracto.'
  ],
  '4.0.0': [
    'Nuevo Asistente de IA para conciliar tus extractos. Subes el PDF del extracto del banco y la app lo compara con tus movimientos para explicarte por qué el pago mínimo del banco no coincide con el de la app y señalarte posibles diferencias (una compra que falta, un monto distinto o algo mal clasificado).',
    'Funciona con la IA que prefieras: conectas tu cuenta de OpenAI, Anthropic (Claude), Google Gemini o DeepSeek usando tu clave. La clave se guarda cifrada en tu equipo y nunca se incluye en las copias de seguridad. También hay un modo Demo, sin conexión, para ver cómo funciona sin gastar nada.',
    'Tu privacidad primero: antes de enviar nada a la IA, la app oculta tus datos personales del extracto (nombre, dirección, ciudad, documento, teléfono y número de tarjeta). Solo tienes que cargar tus datos una vez en Configuración para que se oculten siempre.',
    'Revisas antes de enviar: tras leer el PDF ves una vista previa de lo extraído (ya sin tus datos personales). Si prefieres no conectar una IA, puedes copiar con un botón un texto ya armado para pegarlo en cualquier IA por tu cuenta.',
    'Soporta extractos protegidos con contraseña: si tu PDF está bloqueado, la app te pide la clave para abrirlo (no se guarda en ningún lado).',
    'Las diferencias que encuentra la IA se pueden aplicar con un clic (crear o corregir una compra), siempre con una confirmación que te muestra exactamente qué se va a cambiar. La IA solo sugiere; los cambios los aplicas tú.',
    'Abono a Capital: si haces un abono a capital y alguna de las compras afectadas tenía dinero apartado en el bolsillo, ese dinero ahora se libera automáticamente y la app te avisa cuánto quedó disponible de nuevo (antes ese dinero quedaba apartado para una compra que ya habías pagado).'
  ],
  '3.5.0': [
    'Nuevo campo "Ciclo (avanzado)" al editar una compra de una cuota: te permite fijar a mano a qué mes pertenece la compra, sin importar su fecha. Es útil cuando el banco reprograma una cuota a otro mes (por ejemplo, una compra que cambiaste de 36 a 2 cuotas y cuyo saldo se paga el mes siguiente): así la compra conserva su fecha real en el historial pero cuenta para el mes correcto. Si lo dejas vacío, el mes se calcula solo según la fecha, como siempre.'
  ],
  '3.4.1': [
    'Abono a Capital ahora muestra un resumen en vivo: a medida que escribes el monto, ves al instante a qué compras, cuotas, diferidas o avances se va a aplicar, cuánto a cada uno y si quedan saldados o parciales. Si cambias el monto, el resumen se actualiza solo. Ya no hay que pulsar "Ver resumen" como paso aparte.'
  ],
  '3.4.0': [
    'La sección "Próximos Pagos" del inicio ahora muestra siempre el pago mínimo al día: se recalcula en el momento, sin que tengas que entrar a la pestaña de Pagos de la tarjeta para que se actualice.',
    'Pantalla de carga más limpia: se quitaron los puntos suspensivos de los mensajes ("Buscando actualizaciones", "Instalando", "Iniciando") y, durante una descarga, el porcentaje ahora aparece al lado de la barra de progreso en vez de pegado al texto.'
  ],
  '3.3.3': [
    'Corregido un error que asignaba algunas compras al mes equivocado: las hechas en días de fin de mes (como el 31) podían quedar registradas un mes más adelante de lo debido (por ejemplo una compra del 31 de mayo aparecía en julio en vez de junio) y no se veían en el historial. Ya quedan en el ciclo correcto, y la app reacomoda automáticamente las que se habían guardado mal.',
    'Al entrar a una tarjeta, ahora se muestra por defecto el ciclo que está corriendo según su fecha de corte (no el mes del calendario). Excepción: si el extracto del ciclo anterior todavía no lo has pagado por completo, la app te muestra primero ese ciclo pendiente, para que veas lo que debes antes de pasar al mes en curso.',
    'Ya no se pueden agregar compras a un ciclo cuyo extracto ya está pagado. Si lo intentas, la app te avisa y no la registra, para no descuadrar un corte que ya cerraste con el banco (igual que ya no se podían editar ni borrar compras de ciclos pagados).',
    'Detalle visual: el valor principal de las tarjetas del dashboard (Deuda Total, Me Deben, Saldo en Bolsillo, Me Deben Corte, Deuda Personal e Intereses del Mes) ahora usa la misma tipografía que el resto, para que todas se vean consistentes. Además, el prefijo "COP" solo aparece en las tarjetas que manejan pesos y dólares a la vez (donde hay que distinguir ambas monedas); en las demás se muestra el valor directo.'
  ],
  '3.3.2': [
    'Corregido un caso en "Me Deben Corte": cuando apartabas en el bolsillo el valor de una compra internacional de un tercero MÁS su interés, la card seguía mostrando el interés como si el tercero te debiera (ej. $3.651) aunque ya estuviera cubierto. Ahora el dinero apartado de más absorbe correctamente el interés y la deuda queda en cero, igual que en la card "Me Deben".',
    'El bolsillo ya no permite apartar más de lo que cuesta la compra. Si intentas guardar un monto mayor, se ajusta automáticamente al máximo (el valor de la compra, o el valor más su interés en compras internacionales) y te avisa. Además, si luego editas la compra y le bajas el valor, el dinero apartado se reajusta solo para no quedar por encima del nuevo valor.',
    'Corregido el "Cupo Usado": el día del corte la app podía mostrar un falso sobrecupo (más de 100%) porque contaba dos veces la cuota de avances y diferidas de ese mes. Ahora el cupo usado y el disponible se calculan bien también el mismo día del corte.',
    'Sección "Próximos Pagos" rediseñada: ahora muestra únicamente el pago pendiente de cada tarjeta, y solo después de que cierra su corte (por ejemplo, una tarjeta con corte el día 30 aparece a partir del 31 con su fecha límite de pago). El pago desaparece de la lista cuando lo registras. Se quitó la cuenta regresiva al próximo corte para dejar la vista enfocada en lo que realmente debes pagar.'
  ],
  '3.3.1': [
    'La card "Cupo Usado" ahora muestra también cuánto cupo te queda disponible, resaltado en verde (ej. "Disponible: $1.500.000"). Si la deuda supera el cupo, aparece en rojo como "Sobrecupo". Antes solo veías cuánto habías usado del total.'
  ],
  '3.3.0': [
    'Ahora puedes convertir una compra dividida entre personas de vuelta a una compra 100% personal: abre la compra dividida, desmarca "Dividir entre personas" y guarda. Las partes se fusionan en una sola compra tuya y el dinero que tuvieras apartado en el bolsillo se conserva sumado. Antes tocaba borrar la compra y volverla a crear.',
    'Funciona igual para compras de una sola cuota y para compras a cuotas (diferidas).',
    'Protección de datos: si alguno de tus terceros ya te había reembolsado dinero por esa compra, la app te avisa con el detalle de cuánto y de quién, y te pide una confirmación extra antes de eliminar ese registro al convertir.',
    'Corregido: al editar una compra (fecha, descripción, monto, persona, etc.) el estado de Bolsillo ya no se pierde. Antes, editar cualquier detalle de una compra que tenías en "Bolsillo" o "Bolsillo Parcial" la devolvía a "Pendiente" aunque el dinero apartado siguiera ahí. Ahora el estado se recalcula solo según lo que tengas apartado frente al total.',
    'Al editar una compra, el número de cuotas queda fijo (solo se define al crear). Para cambiar una compra de contado a cuotas o viceversa, elimínala y créala de nuevo. Esto evita que una compra quede "a medias" entre los dos tipos.',
    'Compras divididas más seguras: ahora la app no te deja guardar si dejas una división sin persona asignada, ni si repites a la misma persona en varias filas (te pide sumar sus montos en una sola). Así no se crean registros incompletos o duplicados.'
  ],
  '3.2.3': [
    'Si la descarga de una actualización falla, ahora puedes elegir entre dos opciones: "Cerrar app" (lo recomendado, para reintentar luego) o "Continuar de todos modos" (abrir la app con la versión actual cuando necesitas usarla sí o sí, por ejemplo si el servidor de actualizaciones está temporalmente caído). Antes solo podías cerrar.',
    'Durante la descarga, el splash ahora muestra el porcentaje en texto junto a la barra (ej. "Descargando v3.2.3... 45%"), no solo en la barra de progreso.'
  ],
  '3.2.2': [
    'Si la descarga de una actualización falla, la app ya no arranca silenciosamente con la versión anterior. Ahora muestra un mensaje claro y un único botón "Cerrar app" para que la abras de nuevo y reintente — así no te quedas atrapado en una versión vieja sin darte cuenta.'
  ],
  '3.2.1': [
    'Pantalla de carga arreglada: ahora se ve correctamente durante todo el chequeo de actualizaciones, sin parpadeos. La ventana principal solo aparece cuando la pantalla de carga termina y se cierra.',
    'Vista de "Problemas de conexión" arreglada: ahora aparece correctamente cuando no hay internet (antes la app pensaba que un error de red rápido era "no hay actualización disponible" y arrancaba sin preguntar).'
  ],
  '3.2.0': [
    'Nueva pantalla de carga al iniciar la app: antes de abrir tus datos, ahora primero busca actualizaciones disponibles (espera hasta 60 segundos). Si hay una actualización pendiente, se descarga e instala automáticamente — esto protege tu información de bugs que podrían afectarla.',
    'Si no tienes conexión a internet, la app te muestra una ventana donde puedes elegir entre "Continuar" (abrir la app con la versión actual) o "Cerrar app" (salir sin abrir nada).',
    'Durante la descarga e instalación de actualizaciones automáticas, la pantalla de carga muestra el progreso para que sepas qué está pasando.'
  ],
  '3.1.2': [
    'Card "Deuda Personal" ahora muestra el desglose de a qué corresponde el valor (Compras, Avances, Diferidas e Int Intl cuando aplique), igual que ya lo hace la card "Pago Mínimo". Así puedes ver de un vistazo qué parte de tu deuda del corte viene de cada concepto.',
    'Ventana de "Novedades de la Versión" arreglada: cuando hay muchos cambios, ahora la ventana mantiene un tamaño compacto y solo la lista del medio hace scroll. El título y el botón "Entendido" quedan siempre visibles.'
  ],
  '3.1.1': [
    'Bolsillo en dólares: ahora puedes apartar dinero en USD para compras internacionales de tus tarjetas Mastercard y Amex Bancolombia. El modal detecta automáticamente la moneda y la card "Saldo en Bolsillo" muestra el total apartado en pesos y dólares por separado.',
    'TRM del día automática: la app consulta diariamente la Tasa Representativa del Mercado oficial publicada por el Banco de la República y la usa para estimar el cupo usado de tus tarjetas con cuenta en dólares.',
    'Al registrar una compra internacional en Mastercard o Amex, el campo "Valor USD" ahora es obligatorio (la moneda nativa de la deuda) y el campo "Valor COP" pasa a opcional. Si dejas "Tasa USD" vacía, la app la completa con la TRM del día.',
    'Rediseño visual de las cards principales del dashboard: cuando hay deuda en dólares, Deuda Total, Deuda Personal, Me Deben, Me Deben Corte, Saldo en Bolsillo e Intereses del Mes ahora se ven en formato "dos pisos" — pesos arriba, dólares abajo, separados por una línea limpia. Las tarjetas sin saldo USD mantienen su diseño compacto original.',
    'Cards "Me Deben" y "Me Deben Corte": el desglose por persona ahora se ve como una tabla compacta con columnas Persona / COP / USD. Si una persona solo te debe en una moneda, la otra columna muestra un guion discreto.',
    'Card "Cupo Usado" ahora considera la deuda en dólares: la convierte a pesos con la TRM de referencia para mostrarte un porcentaje real de ocupación del cupo. Debajo aparece una nota cyan con el cálculo usado para que sea transparente.',
    'Card "Deuda Total" en tarjetas con dólares: el desglose por tipo de movimiento (Avances, Diferidas, Compras) aparece tanto en pesos como en dólares. En dólares omitimos Avances porque la app no los maneja en USD.',
    'Card "Intereses del Mes" ahora muestra los intereses en pesos y los intereses en dólares por separado cuando aplica.',
    'Card "Pago Mínimo USD": la barra de progreso de pago ahora es cian (coherente con la moneda) y el valor del monto se pone cian solo cuando la deuda USD está totalmente saldada, igual que la card COP cambia de amarillo a verde.',
    'En tarjetas duales, ahora siempre aparecen ambas cards "Pago Mínimo COP" y "Pago Mínimo USD", aunque el valor sea $0. Antes la card USD desaparecía cuando no había saldo.',
    'Tablas de compras (tarjeta y terceros): la columna "Valor" se renombró a "Valor COP" y se agregó una nueva columna "Valor USD" en cian. Las celdas de la moneda que no aplica a la compra muestran un guion suave en lugar de $0.',
    'Limpieza visual: se quitó la repetición del valor USD junto a la descripción de la compra. Ahora cada moneda vive en su propia columna sin redundancia.',
    'Pestaña Terceros: corregido el filtro de visibilidad. Una deuda ahora se oculta de la lista solo cuando el ciclo de la tarjeta ya se pagó al banco Y el tercero ya te saldó la compra (sea porque tocaste el botón "Recibido" o porque cubriste el total con bolsillo). Las compras en bolsillo parcial siempre siguen visibles. Para diferidas, se ocultan cuando todas sus cuotas terminaron de pagarse y el tercero saldó la deuda.',
    'Bug fix: el badge "Recibido" en una compra con bolsillo completo ya no engaña — ahora el filtro lo reconoce correctamente como saldado y la oculta.',
  ],
  '3.1.0': [
    'Soporte bimonetario integral para las tarjetas con cuentas en pesos y dólares (Mastercard y Amex Bancolombia). El banco emite un solo extracto por ciclo pero con la deuda dividida, y ahora la app refleja esa realidad: puedes saldar primero la parte en pesos y dejar los dólares para otro día, o viceversa.',
    'Al darle al botón Pagar de un ciclo con saldo en ambas monedas, el modal muestra dos pestañas — Pago COP y Pago USD — con su propio monto mínimo, restante y barra de progreso. La pestaña ya saldada se marca como "SALDADO" y queda deshabilitada. El ciclo solo se considera totalmente cerrado cuando ambas monedas están al día (o cuando no hay saldo en dólares).',
    'En la lista de Pagos, cada ciclo ahora muestra dos badges independientes (COP PAGADO / USD PENDIENTE, etc.) para tarjetas con cuenta en dólares. Las columnas Pago Mínimo, Pago Total y Monto Abonado tienen una segunda línea en cian con los valores en dólares.',
    'Rediseño visual de las tarjetas del dashboard (Deuda Total, Me Deben, Me Deben Corte, Deuda Personal, Saldo en Bolsillo): ahora cuando hay saldo en dólares se muestran en formato "dos pisos" con COP arriba, divisor horizontal y USD abajo. Las tarjetas sin saldo USD mantienen su diseño original.',
    'El Bolsillo ahora entiende dólares: cuando apartas dinero para una compra internacional, el modal cambia a formato USD automáticamente y guarda el monto separado del bolsillo en pesos. La card "Saldo en Bolsillo" suma ambos por separado.',
    'Las tablas de compras (en cada tarjeta y en Terceros) renombraron la columna "Valor" a "Valor COP" y agregaron una nueva columna "Valor USD" en cian. Si la compra está registrada en dólares, su monto original aparece allí en lugar de mostrar $0.',
    'Sección Terceros: cada persona ahora muestra el monto pendiente y recibido en dólares cuando aplica, sin chips nuevos (la info va dentro del mismo chip existente).',
    'Card Pago Mínimo USD: arreglada para que aparezca correctamente al navegar ciclos pagados de tarjetas históricas (antes el cálculo daba cero porque las compras ya estaban marcadas como pagadas).',
    'Cargué el histórico completo de tres tarjetas antiguas (MasterCard Joven, American Express Gold, Mastercard Platinum) en la sección Historial / Inactivas, con todos sus extractos, compras, diferidas, avances y pagos hasta la fecha de cierre.',
    'Para diferidas y avances que no completaron su plazo original (porque la tarjeta se cerró o porque se hizo un abono a capital), el histórico incluye automáticamente el abono final que liquidó el saldo restante — así no quedan cuotas fantasma proyectadas hacia el futuro.',
  ],
  '3.0.0': [
    'Reordenamiento manual de tarjetas: cada tarjeta tiene un nuevo campo "Orden" en el formulario de edición. El número menor aparece primero en la barra lateral y en el Dashboard. Si lo dejas vacío, la tarjeta cae al final por fecha de creación.',
    'Tus tarjetas existentes recibieron un orden inicial automático según la fecha en que las creaste, así que el ordenamiento ya funciona desde la primera vez que abras esta versión.',
    'Nueva sección "Historial / Inactivas" en la barra lateral: aparece debajo de "Mis Tarjetas" cuando tienes al menos una tarjeta marcada como inactiva. Es un acordeón colapsable (cerrado por defecto) que te muestra las tarjetas archivadas sin saturar la vista principal.',
    'Las tarjetas inactivas ya no cuentan para los totales del Dashboard general (cupo total, cupo usado, deuda total, intereses, Me Deben, Saldo en Bolsillo). Si necesitas consultar el historial de una tarjeta archivada, basta con hacer clic en ella desde la sección Historial — entras a su vista normal con extractos, compras y todo intacto.',
    'Para archivar una tarjeta basta con editarla y cambiar su Estado a "inactiva". Para reactivarla, lo mismo en reversa.',
  ],
  '2.9.0': [
    'Asistente inteligente de Interés Internacional: al registrar una compra en tu Bancolombia Visa, si el nombre del establecimiento coincide con compras anteriores que marcaste como internacionales (ej. Netflix, Amazon, Apple), aparece un aviso recordándote considerar marcar el check de INTL.',
    'El asistente aprende y desaprende solo: si dejas de marcar un comercio como internacional, deja de sugerírtelo. Si empiezas a marcar uno nuevo, queda registrado para futuras compras.',
    'El aviso solo se activa en tarjetas Bancolombia Visa (las únicas que cobran ese interés). En Nu, RappiCard, Mastercard y Amex no aparece para no generar ruido.',
    'El aviso es informativo: nunca marca el check automáticamente ni bloquea el guardado — tú decides.',
    'Iconos del CHANGELOG ahora se ven proporcionados al texto: aumentamos su tamaño y mejoramos la alineación para que sean más legibles.',
  ],
  '2.8.3': [
    'Tabla más compacta en Diferidas y Avances: las columnas "Bolsillo" y "Estado" se unieron en una sola columna "Estado" que ya captura todo (pendiente, bolsillo apartado, ciclo pagado, etc.). Ya no aparece el badge redundante "activo" en cada fila.',
    'Alineación visual entre las tablas de Compras y Diferidas: ahora las columnas Fecha, Descripción, Responsable, Valor/Saldo Actual, Estado y Acciones quedan perfectamente alineadas verticalmente — la sensación al mirar las dos tablas es la de una sola cuadrícula limpia.',
    'La alineación funciona tanto para Bancolombia Visa (con sus columnas extra Int Intl y Total) como para Nu, RappiCard, Mastercard y Amex (que tienen tablas más simples). Sin importar la tarjeta, los bordes derechos cuadran al pixel.',
  ],
  '2.8.2': [
    'Nueva columna "Responsable" en las tablas de Compras y Diferidas del Resumen: el nombre del tercero ya no aparece apretado al lado de la descripción, ahora tiene su propio espacio con el color de identificación de cada persona.',
    'Compras divididas: la fila madre muestra un badge azul "Dividida" (antes verde) — el verde queda reservado para "Pagado" y así se distinguen mejor los dos estados.',
    'Reordenamiento del Resumen: la sección de Compras Diferidas ahora aparece justo después de las Compras normales, y los Avances al final. Antes el orden era distinto.',
    'Tabla Diferidas reorganizada: la fecha de compra ahora es la primera columna (igual que en Compras), seguida de Descripción, Responsable, Cuota Corte, Cuotas, Tasa MV, Saldo Actual, Bolsillo y Estado.',
    'Headers de Diferidas y Avances: la columna "Etiqueta" se renombró a "Descripción" para mantener consistencia con la tabla de Compras.',
    'Card "Intereses del Mes": la mini-columna "Int Intl" ya no aparece en verde — usa los mismos colores que las otras mini-columnas (Diferidas, Avances) para mantener consistencia visual.',
  ],
  '2.8.1': [
    'Arreglado un bug que dejaba mal calculadas las cuotas al editar la fecha de una compra a cuotas: si registrabas una compra con una fecha equivocada y luego la corregías, las cuotas seguían apareciendo en los meses originales y no en los nuevos.',
    'Ahora, cuando editas la fecha (o cambias la tarjeta) de una compra a cuotas, la diferida vinculada se actualiza automáticamente y la primera cuota cae en el ciclo correcto desde el primer momento.',
    'Auto-corrección al actualizar: si tu base de datos tenía compras a cuotas que arrastraban este bug desde antes, la app las detecta y las realinea sola al abrir esta versión por primera vez. No necesitas hacer nada manualmente.',
  ],
  '2.8.0': [
    'Inmutabilidad de registros: cuando el extracto de un ciclo ya fue pagado, los botones de editar y eliminar desaparecen automáticamente en compras, compras divididas, diferidas y avances de ese ciclo. Si alguien intenta editar o borrar desde otra herramienta, el backend también lo bloquea.',
    'Avances: ahora la regla de "solo se puede editar/eliminar dentro del primer mes" también se aplica al botón de eliminar (antes solo bloqueaba el de editar).',
    'Badge "Pagado" unificado: en lugar de aparecer disperso entre varias columnas, ahora se muestra exclusivamente en la columna "Estado" con un check elegante. Más limpio y sin duplicaciones.',
    'Compras divididas: arreglado el badge de "Pagado" cuando el extracto se cierra — ahora la fila madre y las hijas se ven correctamente como pagadas (antes esto solo funcionaba para diferidas, no para compras de una sola cuota).',
    'Compras divididas: el estado "Bolsillo Parcial" en la compra madre ahora se calcula correctamente sumando lo que tienes apartado de cada parte. Si solo apartaste lo de una persona, la madre ya no dice "Bolsillo" completo erróneamente.',
    'Color verde en columna "INT INTL" y "TOTAL" reemplazado por color blanco normal — más consistente con el resto de la tabla. El valor de los intereses internacionales sigue siendo identificable porque está en su propia columna dedicada.',
  ],
  '2.7.16': [
    'Dividir compras 100% entre terceros: ahora puedes asignar toda la compra a otras personas y que tu parte quede en $0, sin tener que asumir un porcentaje obligatorio.',
    'Nuevo botón "÷ Solo terceros" en el modal de división: reparte el total exacto entre las personas que agregaste, sin reservar nada para ti.',
    'El botón anterior "÷ Partes iguales" ahora se llama "÷ Incluyéndome" para distinguir claramente las dos formas de dividir.',
    'Cuando logras dividir el 100% entre terceros, el indicador te confirma: "Dividido 100% entre terceros — tu parte queda en $0".',
    'Funciona tanto para compras de una sola cuota como para diferidas, y también al editar una compra dividida existente (la parte personal se elimina automáticamente).',
  ],
  '2.7.15': [
    'Nota explicativa en las cards "Cupo Usado" y "Cupo Total": ahora se aclara que el disponible puede diferir del banco por intereses devengados sin facturar y cuota de manejo del mes.',
    'Esto explica por qué la app puede mostrar un disponible distinto al de la app del banco — los cálculos siguen siendo correctos, pero el banco va sumando intereses día a día y carga la cuota de manejo, mientras la app solo refleja lo que ya quedó en algún extracto.',
  ],
  '2.7.14': [
    'Arreglada la mega-card "Cupo Total" del Dashboard general: el porcentaje y el monto disponible ahora coinciden con la suma de las cards individuales de cada tarjeta.',
    'Antes, la vista global no descontaba los abonos parciales hechos a extractos ni sumaba las cuotas pendientes de extractos vencidos — eso hacía que el Disponible y el porcentaje del Dashboard fueran distintos a los de las tarjetas individuales.',
    'Si entras a una tarjeta y luego vuelves al Dashboard, los números ahora cuadran exactamente.',
  ],
  '2.7.13': [
    'Ahora puedes editar manualmente la fecha de pago de cualquier mes desde la card "Fecha Limite de Pago": haz clic en el icono de lápiz, escoges la fecha real que aparece en tu extracto y listo.',
    'Útil cuando el banco mueve la fecha de pago uno o dos días por festivos o fines de semana — la app ya no muestra una fecha tentativa cuando tú conoces la real.',
    'La fecha que modificas es independiente por mes: cambiar la de abril no afecta la de mayo, ni viceversa.',
    'Cuando una fecha es manual, aparece la etiqueta "(MANUAL)" junto al campo para que sepas que fue fijada a mano, no calculada.',
    'El cambio se refleja en todas las vistas que muestran esa fecha: card del Resumen, tabla de Pagos, y la sección de Próximos Pagos del Dashboard global.',
    'Los cálculos de intereses, pago mínimo y demás siguen funcionando igual — esto solo es un ajuste visual.',
  ],
  '2.7.12': [
    'La card "Saldo en Bolsillo" ahora muestra el desglose: cuánto apartaste en total para el ciclo y cuánto ya abonaste al extracto.',
    'Si abonas $1.400.000 al extracto y tenías $2.450.000 apartados, ahora ves claramente que el saldo restante es $1.050.000 — sin tener que sacar la calculadora.',
    'El desglose se actualiza automáticamente al registrar un nuevo abono o al navegar entre ciclos: cada mes muestra sus propios números independientes.',
  ],
  '2.7.11': [
    'Arreglada la card "Saldo en Bolsillo" para avances: cuando apartabas dinero para la cuota de un mes específico, ese monto seguía apareciendo sumado al navegar a otros meses.',
    'Ahora la card refleja únicamente el dinero apartado para el mes que tienes en pantalla — coherente con el indicador de bolsillo de la fila del avance.',
    'Las compras y diferidas no cambian — siguen calculando su bolsillo igual de bien que antes.',
  ],
  '2.7.10': [
    'Arreglada la card "Me Deben Corte" en ciclos pasados: cuando navegabas a un mes anterior, las cuotas pendientes de compras diferidas a terceros no se sumaban en esa card aunque seguían apareciendo como pendientes en la tabla de Diferidas.',
    'Ahora "Me Deben Corte" muestra el monto correcto en cualquier ciclo que estés viendo (pasado, presente o futuro), siempre que el tercero todavía no te haya pagado y no hayas apartado dinero al bolsillo para cubrir esa cuota.',
    'Las cards "Me Deben" (total general) y la sección de Terceros no cambian — siguen funcionando igual de bien.',
  ],
  '2.7.9': [
    'Bolsillo de avances independiente por mes: ahora puedes apartar dinero para la cuota de un mes específico sin que aparezca como apartado en los demás meses.',
    'Cada cuota mensual de un avance guarda su propio bolsillo, igual que ya funcionaba con las compras diferidas.',
    'El indicador de "bolsillo" en la tabla de avances solo se ilumina en los meses donde realmente apartaste dinero — se acabaron los falsos positivos al navegar a meses futuros.',
    'Al abrir el modal del bolsillo desde cualquier mes (pasado, presente o futuro), ves exactamente cuánto apartaste para esa cuota — sin mezclas con otros meses.',
    'El modal del bolsillo de avances ahora indica claramente la cuota que estás gestionando (ej. "Cuota 3/24").',
  ],
  '2.7.7': [
    'Fix navegación temporal: al avanzar al futuro en Resumen, las cuotas de Avances y Diferidas ya no se quedan estáticas — ahora muestran el monto correcto de cada ciclo.',
    'Backend: los endpoints /api/avances y /api/diferidas aceptan el parámetro ciclo y devuelven la cuota de ese mes específico (compatible con la lógica especial de Nu y Bancolombia).',
    'Las cuotas decrecientes de diferidas (donde el interés baja con el saldo) ahora se reflejan correctamente al navegar mes a mes.',
  ],
  '2.7.6': [
    'Soporte Completo Nu: interés $0 en la primera cuota de compras diferidas.',
    'Historial Extendido: integración de 25 ciclos históricos de tarjetas Nu.',
    'Propagación de URLs: actualización masiva de tasas desde Configuración.',
    'Fix de Seguridad: eliminado enlace roto de Superfinanciera (ahora PDF oficial Nu).',
    'Auditoría: limpieza y optimización de base de datos completada.',
    'Fix visual: changelog de v2.7.5 mostraba el código SVG en crudo — ahora se renderiza limpio.',
  ],
  '2.7.5': [
    'Soporte Completo Nu: interés $0 en la primera cuota de compras diferidas.',
    'Historial Extendido: integración de 25 ciclos históricos de tarjetas Nu.',
    'Propagación de URLs: actualización masiva de tasas desde Configuración.',
    'Fix de Seguridad: eliminado enlace roto de Superfinanciera (ahora PDF oficial Nu).',
    'Auditoría: limpieza y optimización de base de datos completada.',
  ],
  '2.7.4': [
    'URLs de tasas a prueba de errores: si borras la URL de un banco predefinido (Bancolombia, Nu, RappiCard) en la configuración, ahora la app la restaura automáticamente al valor oficial en vez de quedarse sin enlace para auto-actualizar tasas',
    'Configuración de URLs: los bancos predefinidos ahora muestran la etiqueta "(predefinido)" y un botón "Restaurar" cuando su URL fue modificada, para volver al enlace oficial en un clic',
    'Restaurar Backup: ahora se aplican automáticamente las migraciones de esquema cuando restauras un backup de una versión anterior. Si tu backup es de v2.6.x o anterior, las columnas nuevas (intereses internacionales, persistencia de pagos, etc.) se agregan solas sin errores',
    'Restaurar Backup: ahora pide confirmación antes de iniciar y muestra la pantalla de reinicio obligatorio al terminar, en lugar de un toast que se podía ignorar',
    'Documentación: corregida la premisa sobre la variabilidad de tasas. Todos los emisores en Colombia (Bancolombia, RappiCard, Nu) actualizan tasas el día 1° de cada mes siguiendo la Tasa de Usura del Banco de la República — no es exclusivo de un solo banco',
    'Nueva base de conocimiento técnica para RappiCard (Visa) en docs/bancos/RappiCard_Visa.md con análisis de 7 ciclos consolidados',
  ],
  '2.7.3': [
    'Limpieza visual: se removió un emoji que se había quedado en el desglose de la sección dólares del extracto. La app vuelve a usar exclusivamente iconos SVG en toda la interfaz',
    'Documentación interna: nueva base de conocimiento técnica para las tres franquicias de Bancolombia (Visa, Mastercard, American Express) en docs/bancos/ — análisis matemático completo de cada extracto y su correspondencia con la lógica del motor',
  ],
  '2.7.2': [
    'Bancolombia Mastercard: las compras en USD a 1 cuota ya no devengan intereses si se pagan al vencimiento. Antes el sistema sumaba un interés proporcional por días que el banco realmente no cobra',
    'Dashboard: nueva mini-columna "Deuda USD" en la card de Deuda Total para tarjetas Mastercard/Amex Bancolombia, mostrando la deuda en dólares por separado tal como aparece en el extracto del banco',
    'Vista del extracto Mastercard: el desglose ahora replica la estructura del PDF — primero cierra el bloque COP (Compras → Avances → Diferidas → Intereses Corrientes → Pago Mínimo COP) y luego abre la sección dólares (Compras USD → Intereses USD → Pago Mínimo USD)',
    'Vista del extracto Mastercard/Amex: los intereses corrientes se agrupan en una sola línea "Intereses Corrientes" igual que en el extracto del banco, en lugar de aparecer fragmentados',
    'Documentación: nuevo manual técnico en docs/bancos/Bancolombia_Mastercard.md con análisis detallado de cómo funciona la franquicia Mastercard de Bancolombia',
  ],
  '2.7.1': [
    'Fix: al convertir una compra individual en compra dividida durante la edición ya no se duplica el registro — la original se borra y se recrean las partes (Borrar y Recrear)',
    'Fix: al editar una compra dividida y marcar/desmarcar el checkbox de "Compra internacional", el cambio ahora se aplica a todas las partes del grupo y se recalcula el interés correctamente',
    'UX: el texto del checkbox de compra internacional cambia según la tarjeta — en Bancolombia Visa dice "Compra internacional (acumula intereses)" y en otras (RappiCard, Nu, Bancolombia MC/Amex) solo "Compra Internacional", para evitar confusión sobre dónde se generan intereses',
  ],
  '2.7.0': [
    'Intereses internacionales: ahora se cobran únicamente en tarjetas Bancolombia Visa (validado con extracto real). Otras franquicias o bancos como RappiCard y Nu ya no acumulan estos intereses hasta tener evidencia',
    'Deuda Personal corregida: ya no incluye intereses de compras de terceros. Si una compra internacional es de un tercero, su interés ahora aparece en "Me Deben Corte"',
    'Sección Pagos: nueva columna "Intereses Int." en la tabla de extractos. Ves de un vistazo cuánto pagaste por intereses internacionales en cada ciclo',
    'Historial de pagos: los intereses internacionales se guardan permanentemente al cerrar el extracto. El valor queda fiel aunque luego cambien las compras o las tasas',
    'Modal de pago: muestra el rubro de intereses internacionales incluidos antes de confirmar el pago, para que sepas exactamente qué estás pagando',
    'Compras divididas: cada parte (Personal o tercero) muestra ahora su porción proporcional del interés internacional y su total individual',
    'Desglose de extracto: las compras internacionales muestran su interés en la columna "Intereses" del desglose, igual que avances y diferidas',
    'Limpieza visual: se removió el badge "intl" de la descripción y los tags "Te debe/Pagado" redundantes en compras divididas (ya están en la columna Estado)',
    'Formulario de compra: se unificaron los dos checkboxes en uno solo: "Compra internacional". Los campos de USD y tasa aparecen opcionales si quieres registrarlos',
    'Columnas "Int Intl" y "Total" se ocultan automáticamente en tarjetas que no aplican (RappiCard, Nu, Bancolombia MC/Amex), manteniendo la tabla limpia',
    'Fix: la columna "Total" ya no muestra un guion cuando una compra no es internacional — ahora replica el valor de la compra',
    'Fix: ya no se pega un "0" al nombre de compras nuevas al guardarlas (ej: "NETFLIX0" → "NETFLIX")',
  ],
  '2.6.7': [
    'Dashboard: las cards "Intereses del Mes" y "Me Deben" intercambiaron posición — ahora el orden es Compras del Ciclo → Intereses del Mes → Me Deben',
  ],
  '2.6.6': [
    'Intereses internacionales en dashboard: las cards "Me Deben", "Me Deben Corte" e "Intereses del Mes" ahora incluyen los intereses de compras internacionales en la vista global (sin filtro de tarjeta)',
    'Intereses del Mes con desglose "Int Intl": el card púrpura muestra el detalle de intereses internacionales junto a Diferidas y Avances, tanto en el Dashboard General como en el Resumen por tarjeta',
    'Bolsillo: "Apartar todo" ahora incluye los intereses internacionales en el monto sugerido — si la compra genera interés, el botón propone valor + interés para cubrir el cargo real del banco',
    'Bolsillo compras divididas: el target de bolsillo de cada parte también incluye el interés internacional cuando aplica',
    'Fix backend: el cálculo de intereses del ciclo ahora cubre tanto compras USD (valor_usd > 0) como compras COP marcadas como internacionales (es_internacional = 1)',
  ],
  '2.6.5': [
    'Reconciliación con Bancolombia: el cálculo del pago mínimo ahora replica con mucho mayor precisión lo que cobra el banco (cerramos ~80% del desfase histórico)',
    'Avances Bancolombia: los intereses ahora se calculan sobre el saldo "facturado" (saldo + cuota capital del período), modelo confirmado vs extracto Visa Platinum abril 2026',
    'Nuevo flag "Compra internacional" en el formulario de compras: marca compras de Apple, Rappi, MercadoPago, etc. que el banco trata como internacionales aunque cobren en COP — ahora generan intereses correctos',
    'Fix Diferidas: el sync ya no liquida diferidas automáticamente cuando las cuotas vencen; espera a que todos los ciclos involucrados tengan extracto pagado',
  ],
  '2.6.4': [
    'Bolsillo per-cuota: el estado del bolsillo es ahora independiente para cada cuota (1/3, 2/3, 3/3) de una compra diferida',
    'Fix: el botón "Apartar todo" y "Quitar de bolsillo" en el modal ya guardan correctamente la cuota específica para compras personales diferidas',
    'Fix: el modal de bolsillo ahora muestra "Cuota 1/3" en vez de "Cuota 1/undefined"',
    'Terceros: el estado de bolsillo por cuota ya no depende de cálculos acumulativos — cada cuota refleja su propio monto apartado de forma directa',
  ],
  '2.6.3': [
    'Changelog en-app actualizado con los cambios de v2.6.1 y v2.6.2',
  ],
  '2.6.2': [
    'Bolsillo per-cuota: el estado del bolsillo es ahora independiente para cada cuota (1/3, 2/3, 3/3) de una compra diferida',
    'Fix: el botón "Apartar todo" y "Quitar de bolsillo" en el modal ya guardan correctamente la cuota específica para compras personales diferidas',
    'Fix: el modal de bolsillo ahora muestra "Cuota 1/3" en vez de "Cuota 1/undefined"',
    'Terceros: el estado de bolsillo por cuota ya no depende de cálculos acumulativos — cada cuota refleja su propio monto apartado de forma directa',
  ],
  '2.6.1': [
    'Fix "Me Deben Corte": para diferidas divididas el cálculo ahora usa la porción del tercero en vez del total de la diferida — el bolsillo ya cubre correctamente la cuota',
    'Fix Compras: el badge de cuota "N/X" ahora muestra el número correcto al ver ciclos pasados — ya no forzaba siempre la cuota del mes actual',
  ],
  '2.6.0': [
    'Resumen reorganizado: la card "Me Deben" (total histórico) ahora está en la fila superior junto a Deuda Total, Cupo, Próximo Corte y Tasas MV',
    'Datos del Corte: nueva card "Deuda Personal" con la sumatoria de compras y cuotas (avances + diferidas) personales del ciclo, sin contar las partes de terceros',
    'Datos del Corte: nueva card "Me Deben Corte" con lo que cada tercero te debe SOLO en este ciclo, con desglose por persona — se actualiza al recibir pagos o apartar al bolsillo',
    '"Me Deben" arriba ahora replica exactamente la lógica de la card "Me deben" en Terceros: para diferidas suma cuotas no pagadas no cubiertas por bolsillo, para 1 cuota resta bolsillo del valor — al apartar al bolsillo el total visual baja',
  ],
  '2.5.2': [
    'Resumen: las partes de tercero en compras divididas a 1 cuota ahora también pueden ir a Bolsillo desde Resumen',
    'Los botones de Bolsillo en Resumen y Terceros quedan conectados — hacen exactamente lo mismo y comparten la misma fuente de verdad',
    'Pagos: el extracto expandido también agrupa diferidas divididas (fila padre + hijas con persona y su capital/interés/total), igual que ya hacía con las compras a 1 cuota',
  ],
  '2.5.1': [
    'Pagos: las compras divididas ya no aparecen como compras separadas en el extracto expandido — ahora se ven como una sola compra padre con sus partes (igual que en Resumen)',
    'Bolsillo habilitado para la parte "Personal" de compras divididas a 1 cuota (antes solo las partes de terceros podían ir a bolsillo)',
  ],
  '2.5.0': [
    'Fix Bancolombia diferidas: nueva lógica por tarjeta para el cobro de intereses en la cuota 1',
    'Algunas tarjetas Bancolombia difieren los intereses de cuota 1 → cuota 2 (cuota 2 cobra interés_1 + interés_2); otras los cobran desde la cuota 1',
    'Al iniciar la app, modal bloqueante para que indiques el comportamiento de cada tarjeta Bancolombia activa',
    'Nuevo campo en el formulario de tarjeta (solo visible para Bancolombia): "¿Difiere intereses de la cuota 1?"',
    'Nu y RappiCard mantienen su comportamiento actual — solo afecta a Bancolombia',
  ],
  '2.4.4': [
    'Modal de bolsillo simplificado: eliminado el toggle "+ Agregar / = Establecer total"',
    'Cuando hay un monto parcial en bolsillo, el input siempre suma al monto existente — sin necesidad de elegir modo',
    'Aplica en Resumen (Compras, Avances, Diferidas) y en Terceros',
  ],
  '2.4.3': [
    'Terceros — botón "Bolsillo" ahora abre el mismo modal que en Resumen: apartar todo de un clic o ingresar un monto parcial',
    'Bolsillo parcial en diferidas: badge morado muestra cuánto va apartado vs el total de la cuota',
    'Compras normales de terceros: un solo botón "Bolsillo" (igual que diferidas) — el badge muestra el estado sin botón "Pagado" separado',
    'Fix: badge "Te debe" en compras divididas ya no aparece cuando el bolsillo cubre la cuota del tercero — ahora muestra "Pagado" en verde',
    'Totales por persona y por ciclo reflejan el bolsillo en tiempo real para todos los tipos de compra',
  ],
  '2.4.2': [
    'Terceros — diferidas: ecosistema limpio con una única fuente de verdad para el bolsillo',
    'Los botones "Pagado" y "Abonar" en cuotas diferidas se reemplazaron por un solo botón "Bolsillo" (mismo botón que en Resumen)',
    'Meter la cuota al bolsillo desde Terceros o desde Resumen ahora hace exactamente lo mismo — los cambios se ven en ambas secciones',
    'Botón "Quitar" cuando la cuota ya está en bolsillo para revertir con un clic',
  ],
  '2.4.1': [
    'Fix terceros: marcar "Pagado" en una cuota diferida ya solo registra esa cuota — antes marcaba todas las cuotas futuras como recibidas',
    'Fix terceros: cuando el bolsillo cubre la cuota de una diferida, el badge ahora dice "Pagado" en lugar de "En bolsillo"',
  ],
  '2.4.0': [
    'Avances: el botón de editar solo aparece si el avance fue desembolsado en el ciclo actual — ciclos pasados y futuros quedan como solo lectura para proteger el historial de amortización',
    'Editar compras divididas: el botón de editar ahora es del grupo completo — agrega o quita personas, cambia montos, actualiza descripción/fecha desde un solo lugar',
    'Fix: al borrar una compra el cupo disponible ahora vuelve correctamente — antes quedaban diferidas huérfanas sumando deuda',
    'Las filas de personas (partes del grupo) ya no tienen botón de editar individual — todo desde la fila principal',
    'El grupo completo también puede borrarse con el ícono de basura en la fila principal',
  ],
  '2.3.9': [
    'Editar compras divididas: el botón de editar ahora es del grupo completo — agrega o quita personas, cambia montos, actualiza descripción/fecha desde un solo lugar',
    'Fix: al borrar una compra el cupo disponible ahora vuelve correctamente — antes quedaban diferidas huérfanas sumando deuda',
    'Las filas de personas (partes del grupo) ya no tienen botón de editar individual — todo desde la fila principal',
    'El grupo completo también puede borrarse con el ícono de basura en la fila principal',
  ],
  '2.3.8': [
    'Bolsillo para diferidas directas (ej: RappiCard): ahora puedes apartar la cuota del corte en diferidas registradas sin compra vinculada',
    'El bolsillo de diferidas ya suma al Saldo Bolsillo del dashboard (cupo disponible)',
    'El botón de bolsillo en diferidas ya funciona para todos los bancos por igual',
  ],
  '2.3.7': [
    'Fix RappiCard/Davivienda: fecha de pago ahora es fecha de corte + 14 días (antes usaba el día 16 fijo, generaba diferencia con el extracto real)',
    'Fix RappiCard: compras "1 de 1" en COP ya no devengan intereses corrientes — solo diferidas multi-cuota y compras USD generan intereses (alineado con extracto PDF oficial)',
    'Pago Total ahora suma los intereses corrientes del mes (cuotas de diferidas/avances + intereses USD), antes solo sumaba capital',
    'Resultado: desbalance vs PDF reducido de ~$24K a <0.07% en el extracto real de RappiCard abr 2026',
    'Backend: nuevo helper addDays para cálculos de fecha por días calendario',
  ],
  '2.3.6': [
    'Nueva sección Calculadora: simula amortización de avances (24 cuotas fijas) y compras diferidas (cuotas a elección)',
    'Calculadora: al seleccionar tarjeta se auto-cargan tasa MV, día de corte y cuotas (fijas en avances)',
    'Calculadora: monto con formato COP automático mientras escribes (puntos de miles)',
    'Calculadora: selector de tipo rediseñado como cards con ícono y descripción',
    'Cards de tarjeta: subtexto con separadores mejorados — Intereses del Mes muestra desglose Diferidas/Avances',
  ],
  '2.3.5': [
    'Dashboard: desglose Deuda Total con mini-columnas (Avances / Diferidas / Compras) en la mega-card de Cupo Total',
    'Dashboard y Resumen: card Intereses del Mes ahora muestra desglose Diferidas / Avances',
    'Resumen: campo "Int" en Pago Mínimo renombrado a "Int Intl" (intereses sobre compras internacionales en COP)',
    'Backend: dashboard ahora expone interesesMesAvances e interesesMesDiferidas por separado',
  ],
  '2.3.4': [
    'Terceros: totales por ciclo (Pendiente / Recibido) ahora aparecen inline al lado del nombre del mes',
    'Terceros: nuevo diseño de header de persona con etiqueta "Total Deudor" y mini-cards Pendiente / Recibido',
    'Cards de tarjeta: subtexto rediseñado con mini-columnas (label arriba, valor abajo) para Deuda Total, Tasas MV, Pago Minimo y Me Deben — elimina separadores | y evita desbordamiento de texto',
  ],
  '2.3.3': [
    'Diferidas en Movimientos: columna Bolsillo con badge clickable para apartar la cuota del corte',
    'Diferidas en Movimientos: columna Cuota Corte ahora muestra el monto en rojo (pendiente) o verde (pagado)',
    'Fix: badge "Bolsillo Parcial" con Falta $0 en compras diferidas divididas — causado por diferencia de centavos entre cuotaCorte redondeada y monto apartado sin redondear',
    'Backend: monto_bolsillo ahora se guarda siempre redondeado al peso mas cercano',
    'Migracion automatica: redondea montos_bolsillo existentes con decimales al arrancar la app',
  ],
  '2.3.2': [
    'Bolsillo para avances: ahora puedes apartar el valor de la cuota del corte (igual que compras y diferidas)',
    'Avances: nueva columna Cuota y Bolsillo en la tabla del Resumen',
    'Avances en ciclos pagados: muestran badge PAGADO cuando el extracto del ciclo ya fue pagado',
    'Diferidas en ciclos pagados: las compras diferidas (incluyendo divididas y grupos) ahora muestran badge PAGADO al navegar a meses cuyo extracto ya fue pagado',
    'Diferidas: nueva columna Bolsillo en la tabla de Movimientos para apartar el valor de la cuota del corte directamente',
    'Saldo en Bolsillo del dashboard ahora suma tambien el bolsillo apartado de avances',
    'Restauracion del README.md con la estructura modular v2.3.1 e instrucciones para Mac',
  ],
  '2.3.1': [
    'Refactorizacion arquitectonica: server.js (2622 lineas) dividido en 20 modulos en backend/',
    'Procesos de Electron movidos a desktop/ (main.js + preload.js)',
    'Scripts standalone reorganizados en scripts/',
    'Nuevo factory pattern: createApp(dbPath) para inyeccion de dependencias',
    'Sin cambios funcionales: solo limpieza interna y mejor mantenibilidad',
  ],
  '2.3.0': [
    'Dashboard: mega card Cupo Total con barra de progreso, deuda y disponible',
    'Dashboard: desglose Me Deben con nombre y monto por persona',
    'Bolsillo para diferidas: ahora puedes apartar dinero de compras a cuotas (cuota como objetivo)',
    'Bolsillo en compras divididas: cada parte tiene su propio badge de bolsillo',
    'Badge diferida con color azul cielo distintivo',
    'Terceros: eliminado card Dinero Recibido (solo queda Me Deben)',
    'Extractos: eliminado boton Revertir del historial',
    'Fix: compras de extractos pagados ya no se reinician a pendiente en sincronizacion',
    'Fix: pago de extracto solo marca compras como pagadas al completar pago minimo',
  ],
  '2.2.4': [
    'Proximos Pagos: card naranja cuando faltan 5 dias o menos para el limite de pago',
    'Fix: boton cerrar del modal Abonar a deuda ahora se muestra correctamente',
  ],
  '2.2.2': [
    'Fix: Visa ya no muestra Minimo USD / Minimo COP separados (solo aplica a MC/Amex con extracto dual)',
  ],
  '2.2.1': [
    'Diferidas: columna Cuotas muestra cuota del ciclo seleccionado (1/3, 2/3...) en vez de restantes',
    'Fix: app no arrancaba por referencia a DB antes de inicializar',
  ],
  '2.2.0': [
    'Soporte Nu Bank: motor de calculo integrado (diferidas cuota 1 sin intereses, sin extracto dual)',
    'Actualizacion automatica de tasas Nu: extrae E.A. y M.V. desde el PDF oficial de Nu',
    'Parser de PDF mejorado: soporta glifos hex con mapas ToUnicode CMap',
    'URL de tasas Nu actualizada al PDF oficial de cdn.nubank.com.br',
  ],
  '2.1.5': [
    'Compras diferidas divididas: muestra cuota del corte en vez del total (ej: $83.048 = $41.524 x 2)',
    'Fila padre muestra "Cuota 1/3 · 2 partes" con el monto de la cuota del mes',
    'Filas hijas muestran nombre + "Cuota 1/3" + monto proporcional por persona',
    'Fix: eliminado el "0" que aparecia junto al badge "Te debe" en compras diferidas',
  ],
  '2.1.4': [
    'Dividir compras: nueva opcion para dividir una compra entre varias personas con desglose visual',
    'Boton "Partes iguales": reparte el monto equitativamente entre todos los participantes',
    'Compras divididas + diferidas: al dividir una compra a cuotas, se crea una diferida por cada parte',
    'Resumen y Pagos: las compras divididas muestran el total con sub-filas por persona',
    'Terceros: cuotas de diferidas aparecen agrupadas por su mes de pago (no todas bajo el ciclo de compra)',
    'Terceros: boton Abonar disponible en cuotas pendientes de diferidas',
    'Diferidas en Resumen: muestra Cuota Corte en vez de Monto total, cuotas restantes y nombre del tercero',
    'Me Deben: ahora descuenta los abonos parciales ya recibidos del total mostrado',
    'Selector de ciclo: nuevo diseno tipo pill con navegacion por flechas',
  ],
  '2.1.3': [
    'Soporte multi-banco: motor de calculo diferenciado para Bancolombia y RappiCard/Davivienda',
    'RappiCard: intereses corrientes aplican a TODAS las compras (no solo USD como Bancolombia)',
    'Extracto dual para Mastercard y American Express: seccion COP y seccion USD separadas',
    'MC/Amex: compras en dolares permanecen en USD con pago minimo independiente en dolares',
    'MC/Amex: intereses de compras USD calculados sobre el monto en dolares',
    'Desglose de extracto: nueva seccion Dolares (USD) con subtotales, intereses y pago minimo USD',
    'Dashboard: card Pago Minimo USD para tarjetas con extracto dual',
    'Extractos pagados ahora conservan historial completo de compras y movimientos',
    'Terceros: compras agrupadas por ciclo con subtotales de pendiente y recibido',
    'Resumen: badge PAGADO con fecha y pago minimo historico en ciclos pasados',
    'Proximos Pagos: corte real del ciclo actual + diferenciacion VENCIDO vs PROXIMO A VENCER',
    'Abono a Capital: preview de distribucion antes de confirmar',
    'Me Deben: total global de todos los ciclos, independiente del banco',
  ],
  '1.6.0': [
    'Abono a capital corregido: los pagos se aplican a compras primero, luego avances (segun logica bancaria)',
    'Pagos parciales al extracto: ahora puedes abonar al pago minimo en varias cuotas con barra de progreso',
    'Deuda Total se actualiza en tiempo real al registrar abonos al extracto',
    'Comision de avance: nuevo campo al registrar avances, se incluye en la primera cuota',
  ],
  '1.5.3': [
    'Desglose del extracto mejorado: todos los movimientos en orden cronologico con fecha y tipo',
    'Columna de moneda: muestra el valor en USD cuando aplica',
    'Subtotales por tipo (Compras, Avances, Diferidas) al final del desglose',
  ],
  '1.5.2': [
    'Datos del Corte ahora cambian segun el ciclo seleccionado',
    'Pagos reorganizado: Falta por Pagar, Ciclo Actual, Proximos Ciclos e Historial',
    'Correccion de zona horaria: el dia ya no cambia a las 7pm',
  ],
  '1.5.1': [
    'Pago minimo desglosado: ahora se separa en COP y USD cuando tienes compras en dolares',
    'Las compras en USD muestran su equivalente en pesos colombianos',
    'Bolsillo interactivo: haz clic en el estado de cualquier compra para apartar dinero (total o parcial)',
    'Puedes agregar o retirar dinero del bolsillo en cualquier momento',
    'Las compras pagadas por abono a capital ya no muestran estado de bolsillo',
  ],
  '1.4.9': [
    'Dashboard: "Proximos Pagos" ahora muestra el pago minimo pendiente por tarjeta',
    'El pago minimo desaparece automaticamente cuando registras el pago',
    'Seccion de Avances muestra el total de la cuota del corte (capital + intereses)',
  ],
  '1.4.8': [
    'Resumen de tarjeta reorganizado: info general arriba, datos del corte abajo',
    'Dashboard: nueva seccion "Proximos Pagos" con cuenta regresiva por tarjeta',
    'Abono a capital corregido: ahora respeta el orden en que registraste tus movimientos',
    'Nuevo dato: "Saldo en Bolsillo" muestra el total de compras apartadas',
    'Nuevo dato en avances: "Interes Ahorrado" muestra cuanto te ahorras con abonos a capital',
    'El estado "Pagado" ahora aparece junto al nombre de la compra, separado del estado de bolsillo',
    'Tabla de amortizacion simplificada y mas facil de leer',
    'Consulta de tasas de Bancolombia corregida',
    'Actualizacion automatica en Mac ahora funciona correctamente',
    'Todos los emojis reemplazados por iconos SVG'
  ],
  '1.4.1': [
    'Bancos pre-configurados: al crear una tarjeta selecciona tu banco (Bancolombia, Nu, RappiCard) y se autocompleta la URL de tasas',
    'Consulta de tasas mejorada: funciona con RappiCard (PDF) y Nu (PDF desde nu.com.br)',
    'Puedes ingresar tasas en formato anual (EA) o mensual (MV) y se convierten automaticamente',
    'Seccion en Configuracion para agregar, editar y eliminar bancos con sus URLs',
    'Los modales ahora tienen boton de cerrar (X) y no se cierran al hacer click afuera',
    'Nota de advertencia para verificar tasas manualmente'
  ],
  '1.3.1': [
    'Nuevo icono de la aplicacion'
  ],
  '1.3.0': [
    'Historial de acciones: registro de todo lo que haces en la app',
    'Los valores ahora se muestran con puntos de miles mientras escribes (ej: 2.000.000)',
    'Soporte para decimales en valores COP (ej: 44.900,53)',
    'Iconos SVG en la barra lateral (mas limpios y profesionales)',
    'Cada accion registra a que tarjeta pertenece'
  ],
  '1.2.0': [
    'Compras en USD: ahora calcula la tasa automaticamente si pones el valor en COP',
    'Notificaciones de actualizacion con barra de progreso',
    'Pantalla de reinicio al mover la base de datos',
    'Animaciones mejoradas en modales y notificaciones',
    'Seccion "Info del sistema" en Configuracion',
    'Mejoras visuales generales'
  ]
};
