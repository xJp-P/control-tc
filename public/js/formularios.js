// public/js/formularios.js — Formularios de captura: compra, avance, abono, diferida,
// reprogramacion de saldo y persona.


function CompraForm({ item, personas, ciclo, tarjeta, onSave, onCancel }) {
  const [fecha, setFecha] = useState(item ? item.fecha : todayISO());
  const [descripcion, setDescripcion] = useState(item ? item.descripcion : '');
  const [notaPersonal, setNotaPersonal] = useState(item ? (item.nota_personal || '') : '');
  // Tasa de interés intl congelada por compra (se muestra/edita como % mensual). Vacío = usa la global.
  const [tasaIntl, setTasaIntl] = useState(item && item.tasa_intl != null ? String(parseFloat((item.tasa_intl * 100).toFixed(6))) : '');
  const [valorCop, setValorCop] = useState(item ? item.valor_cop : '');
  const [valorUsd, setValorUsd] = useState(item ? (item.valor_usd || '') : '');
  const [tasaUsd, setTasaUsd] = useState(item ? (item.tasa_usd || '') : '');
  const [personaId, setPersonaId] = useState(item ? (item.persona_id || '') : '');
  const [notas, setNotas] = useState(item ? (item.notas || '') : '');
  // Ciclo manual (avanzado): vacío = el ciclo se deriva de la fecha. Con valor "YYYY-MM" la
  // compra pertenece a ese ciclo sin importar su fecha (cuotas reprogramadas por el banco que
  // se pagan en otro ciclo). Solo se ofrece al editar una compra individual de 1 cuota.
  const [cicloManualVal, setCicloManualVal] = useState(item && item.ciclo_manual ? item.ciclo : '');
  // Spillover / "canje retrasado" al corte siguiente: el banco a veces factura una compra hecha el
  // último día del corte en el extracto del mes SIGUIENTE. Al marcar este checkbox (SOLO al crear una
  // compra individual de 1 cuota), la compra se registra en el ciclo siguiente al natural de su fecha
  // (ciclo_manual=1) conservando su fecha real; el candado de "ciclo cerrado" se evalúa entonces contra
  // ese ciclo destino (que está abierto), tanto en el frontend como en el backend (que ya valida el destino).
  const [facturaSiguienteCorte, setFacturaSiguienteCorte] = useState(false);
  // Checkbox unificado: marca la compra como internacional (acumula intereses) y opcionalmente
  // permite registrar valor USD + tasa (datos informativos, no obligatorios).
  const [esInternacional, setEsInternacional] = useState(item ? !!(item.es_internacional || item.valor_usd) : false);
  // Al editar una diferida, el número real de cuotas viene en cuotas_total (num_cuotas no
  // existe en la fila compra). Lo usamos para que el campo (bloqueado en edición) muestre
  // el valor correcto y la lógica de estado trate la compra como diferida.
  const [numCuotas, setNumCuotas] = useState(item ? (item.num_cuotas || item.cuotas_total || 1) : 1);
  const [cobrarIntereses, setCobrarIntereses] = useState(true);
  const [dividir, setDividir] = useState(item && item._isGrupo ? true : false);
  // División "first-class": UN solo arreglo de filas donde el titular es una fila más con el
  // valor especial persona_id='personal' (los terceros usan su id real). Cada fila se elige en
  // el mismo dropdown, se borra con el mismo "×" y entra en la misma matemática: la suma de
  // TODAS las filas debe ser exactamente el Valor COP. Si no hay fila "Mi parte", el titular no
  // asume nada (un faltante se muestra en rojo y bloquea el guardado — no se le asigna solo).
  const [splits, setSplits] = useState(() => {
    if (item && item._isGrupo) {
      const sp = item._partes.map(p => ({ persona_id: p.persona_id ? String(p.persona_id) : 'personal', monto: String(p.valor_cop) }));
      return sp.length > 0 ? sp : [{ persona_id: '', monto: '' }];
    }
    return [{ persona_id: '', monto: '' }];
  });
  const lastUsdField = useRef(null); // tracks which field was edited last: 'usd', 'tasa', 'cop'
  // Soft lock de ciclo cerrado: confirmación con MODAL NATIVO (no window.confirm). El ref evita el
  // desfase asíncrono de setState al re-disparar submit() desde el botón "Confirmar edición".

  // Candado estructural de ciclo CERRADO (≠ pagado): la compra pertenece a un ciclo anterior al
  // vigente de su tarjeta — el banco YA generó ese extracto, esté pagado o no. Todos los campos
  // estructurales (fecha, valores, persona, intl, dividir, ciclo, cuotas) van bloqueados y opacos;
  // solo quedan editables el Nombre en el Extracto y las notas (el backend ignora el resto de
  // todas formas: PUT endurecido, espejo del form de Avances). Los grupos sin .ciclo propio usan
  // el ciclo de la vista desde la que se abrieron.
  // El vigente CONSCIENTE del corte adelantado lo entrega el backend (ciclo_vigente, derivado de
  // cortes_custom). item.ciclo ya viene del motor consciente del corte → comparar ambos sella sólo
  // los ciclos realmente cerrados y deja 100% editables las compras que el corte empujó al vigente
  // (ej. las del 19-20 que pasaron al mes siguiente). Fallback al cálculo teórico local sólo si el
  // backend no envió ciclo_vigente (robustez).
  const vigenteTarjeta = tarjeta && (tarjeta.ciclo_vigente || cicloVigente(tarjeta.dia_corte));
  // v5.8.0: la detección de "ciclo cerrado por tiempo" quedó DEROGADA como fuente de bloqueos. Un mes
  // que ya cortó pero sigue impago es plenamente editable — entre el corte y la fecha límite hay ~2
  // semanas en las que registrar lo que faltó es lo normal. El único cierre es el ciclo PAGADO, y de eso
  // manda el backend (403), que es quien conoce el estado real del extracto: el formulario ya no
  // pre-bloquea ni pide confirmaciones por el calendario.
  // SOFT LOCK (v4.7.5): downgrade del candado. Los campos estructurales de un ciclo cerrado YA NO se
  // deshabilitan — el usuario puede corregir errores de tipeo del pasado; al guardar se confirma (submit)
  // y el backend acepta el PUT completo (solo conserva el candado de PAGADOS). Por eso isCicloCerrado
  // —que gobierna disabled/opacidad de TODOS los inputs de abajo— queda fijo en false.
  const isCicloCerrado = false;
  const lockStyle = undefined;
  // "Libertad total" de cuotas: en edición el campo Cuotas queda libre para compras individuales
  // sin abonos — 1→N convierte, N→M reprograma y N→1 revierte; cada acción la ejecuta su
  // endpoint transaccional DESPUÉS del PUT, conservando SIEMPRE la fila original de la compra
  // (fecha/registro intactos: la prelación de pagos del banco depende del orden cronológico real).
  // v5.8.0: ya NO se exige el ciclo vigente. Si la compra se puede registrar en un mes impago, se puede
  // poner a cuotas ahí mismo; el endpoint rechaza solo si el extracto está PAGADO.
  // Grupos, abonos parciales y terceros con reembolso siguen fuera (cada endpoint
  // los rechaza). USD: una compra internacional de Visa (valor_cop>0 + USD informativo) SÍ puede
  // diferirse (la amortización corre sobre el COP); solo se excluye la compra USD PURA (sin valor
  // en pesos, ej. MC/Amex dual), que no es amortizable en COP.
  const esUsdPura = !!(item && item.valor_usd > 0 && !(item.valor_cop > 0));
  const cuotasEditables = !!item && !item._isGrupo && !esUsdPura && !((item.monto_abonado || 0) > 0);
  // Cuotas con las que la compra está HOY en la BD (diferida → su total real; si no, 1).
  const cuotasOriginales = item ? ((item.estado === 'diferida' || item.diferida_id) ? (parseInt(item.cuotas_total || item.num_cuotas, 10) || 1) : 1) : 1;

  // Asistente INTL: cargamos al montar el form la lista de descripciones que ya tienen
  // alguna compra marcada como es_internacional=1 en la DB (real-time, auto-aprende/desaprende).
  const [intlDescripciones, setIntlDescripciones] = useState([]);
  useEffect(() => {
    api('/compras/intl-descripciones').then(setIntlDescripciones).catch(() => setIntlDescripciones([]));
  }, []);

  // Autocompletado del "Nombre en el Extracto": nombres distintos ya usados en compras, para
  // sugerirlos en un dropdown custom mientras el usuario escribe (ej. "A" → APPLE.COM/US, AMAZON).
  const [nombresUnicos, setNombresUnicos] = useState([]);
  useEffect(() => {
    // Aislado por tarjeta: solo descripciones ya usadas en ESTA tarjeta (no mezcla el historial entre
    // tarjetas — estando en la Visa no sugiere nombres de la RappiCard). Sin tarjeta → global (fallback
    // defensivo; al registrar un movimiento siempre hay una tarjeta activa). Re-fetch si cambia la tarjeta.
    const tid = tarjeta && tarjeta.id;
    api('/compras/nombres-unicos' + (tid ? '?tarjeta_id=' + tid : '')).then(setNombresUnicos).catch(() => setNombresUnicos([]));
  }, [tarjeta && tarjeta.id]);
  // Visibilidad del dropdown de autocompletado (solo con foco + coincidencias).
  const [descSugAbierto, setDescSugAbierto] = useState(false);

  // TRM del día (Tasa Representativa del Mercado) — se consulta del backend que la trae
  // del dataset abierto del Banco República. Si no responde, usa el valor guardado en config.
  // Se usa como fallback automático cuando el usuario marca compra internacional en una
  // tarjeta dual (Mastercard/Amex Bancolombia) y deja vacío el campo Tasa USD.
  // v5.8.0: la TRM se pide para la FECHA DE LA COMPRA, no para hoy. Al poder registrar días atrás, usar
  // la de hoy metía un error real (6-jul-2026: $3.334,93 vs $3.144,14 el 1-ago, ~6%). Se re-consulta al
  // cambiar la fecha. Si esa fecha no tiene dato (feriado sin publicar, sin conexión) se cae a la TRM
  // del día, marcándolo, en vez de dejar al usuario sin referencia.
  const [trmInfo, setTrmInfo] = useState(null);
  // /trm-actual es el ÚNICO escritor de la TRM que el dashboard usa para estimar el cupo en pesos, y
  // este formulario era su único llamador. Al pasar a pedir la TRM por fecha, ese caché se habría
  // quedado congelado envejeciendo en silencio: se conserva una llamada al montar solo para refrescarlo.
  useEffect(() => { api('/trm-actual').catch(() => {}); }, []);
  useEffect(() => {
    let vivo = true;
    const aplicar = (r, deFecha) => { if (vivo) setTrmInfo(r && r.trm ? Object.assign({}, r, { de_fecha_compra: !!deFecha }) : null); };
    if (fecha && /^\d{4}-\d{2}-\d{2}$/.test(fecha)) {
      api('/trm-fecha?fecha=' + fecha)
        .then(r => {
          if (r && r.ok && r.trm) return aplicar(r, true);
          return api('/trm-actual').then(r2 => aplicar(r2, false));
        })
        .catch(() => { if (vivo) setTrmInfo(null); });
    } else {
      api('/trm-actual').then(r => aplicar(r, false)).catch(() => { if (vivo) setTrmInfo(null); });
    }
    return () => { vivo = false; };
  }, [fecha]);

  function onUsdChange(val) { lastUsdField.current = 'usd'; setValorUsd(val); }
  function onTasaChange(val) { lastUsdField.current = 'tasa'; setTasaUsd(val); }
  function onCopUsdChange(val) { lastUsdField.current = 'cop'; setValorCop(val); }

  // Auto-calculate the missing field based on the other two — solo si la compra es intl
  // y el usuario está completando los campos USD opcionales.
  // En tarjetas duales (MC/Amex) la moneda nativa es USD y valor_cop puede quedar en 0,
  // por lo que NO auto-calculamos COP a partir de USD*tasa (evita pisar el 0 esperado).
  const _frEarly = tarjeta && tarjeta.franquicia ? tarjeta.franquicia.toLowerCase() : '';
  const _isDualEarly = _frEarly.includes('mastercard') || _frEarly.includes('amex') || _frEarly.includes('american express');
  useEffect(() => {
    if (!esInternacional) return;
    if (_isDualEarly) return; // no auto-cálculo recíproco en tarjetas duales
    const field = lastUsdField.current;
    if (!field) return;
    const usd = parseFloat(valorUsd);
    const tasa = parseFloat(tasaUsd);
    const cop = parseFloat(valorCop);
    if (field === 'cop' && usd > 0 && cop > 0) {
      // Editó COP teniendo USD → deriva la tasa (COP/USD).
      const calc = Math.round(cop / usd);
      if (calc !== Math.round(tasa)) setTasaUsd(calc);
    } else if (field === 'usd' && usd > 0) {
      // Editó USD: si ya hay tasa, recalcula COP (USD×tasa). Si NO hay tasa pero sí COP, deriva la
      // tasa (COP/USD) — el caso que faltaba. Tras derivarla marcamos 'cop' como último campo para
      // que la siguiente pasada de este efecto NO vuelva a recalcular COP: evita pisar el valor que
      // el usuario escribió (por el redondeo de ida y vuelta) y corta el posible loop.
      if (tasa > 0) {
        const calc = Math.round(usd * tasa);
        if (calc !== Math.round(cop)) setValorCop(calc);
      } else if (cop > 0) {
        const calc = Math.round(cop / usd);
        if (calc !== Math.round(tasa)) { setTasaUsd(calc); lastUsdField.current = 'cop'; }
      }
    } else if (field === 'tasa' && usd > 0 && tasa > 0) {
      // Editó la tasa → recalcula COP (USD×tasa).
      const calc = Math.round(usd * tasa);
      if (calc !== Math.round(cop)) setValorCop(calc);
    }
  }, [valorUsd, tasaUsd, valorCop, esInternacional, _isDualEarly]);

  async function submit(ev) {
    if (ev) ev.preventDefault(); // ev puede venir undefined cuando lo re-dispara el modal de confirmación
    const totalCop = parseFloat(valorCop) || 0;

    // USD/Tasa son opcionales — solo se guardan si la compra es intl y el usuario los proveyó.
    const usdNum = esInternacional && valorUsd !== '' && !isNaN(parseFloat(valorUsd)) ? parseFloat(valorUsd) : null;
    // Fallback de tasa: si la compra es internacional + tarjeta dual + tasaUsd vacía,
    // usamos la TRM del día (consultada en mount). Se guarda como tasa_usd informativa.
    let tasaNum = esInternacional && tasaUsd !== '' && !isNaN(parseFloat(tasaUsd)) ? parseFloat(tasaUsd) : null;
    if (tasaNum == null && esInternacional && _isDualEarly && trmInfo && trmInfo.trm) {
      tasaNum = Math.round(trmInfo.trm);
    }
    // Tasa de interés intl congelada (snapshot): el usuario la escribe como % (ej. 2.0849) y se guarda
    // como decimal (0.020849). Solo si la compra es internacional y el usuario la proveyó.
    const tasaIntlNum = (esInternacional && tasaIntl !== '' && !isNaN(parseFloat(tasaIntl))) ? (parseFloat(tasaIntl) / 100) : null;

    // Spillover / "canje retrasado": ciclo destino cuando el banco factura la compra en el corte
    // SIGUIENTE (checkbox, al CREAR — Fase 2: aplica a 1 cuota, DIFERIDAS y DIVIDIDAS). Es el ciclo
    // siguiente al natural de la fecha (consciente del corte adelantado). null si no aplica → el ciclo
    // se auto-deriva de la fecha (comportamiento normal). Se reutiliza en la validación, el payload de
    // la compra (ciclo + ciclo_manual) y el fecha_primer_corte de las diferidas (corte del ciclo destino).
    const cicloSpilloverBody = (!item && facturaSiguienteCorte && tarjeta)
      ? cicloSiguiente(cicloConCorteFront(fecha, tarjeta.dia_corte, tarjeta.cortes_custom || {}))
      : null;

    // Candado de ciclo cerrado al CREAR: si la fecha cae en un ciclo anterior al vigente, el banco
    // ya facturó ese extracto (el backend rechaza el POST con 403). Validar ANTES de crear nada
    // evita dejar una diferida huérfana (en el flujo de cuotas la diferida se crea primero).
    // v5.8.0: se retiraron DOS fricciones que nacían del calendario y no del estado real de la deuda:
    // la validación que impedía CREAR con una fecha de un ciclo ya cortado, y el modal de confirmación
    // al EDITAR una compra de ese mes. Mientras el extracto no esté pagado no hay nada que proteger, y
    // el backend sigue siendo la autoridad: si el mes está pagado responde 403 y el error se muestra.

    // Conversión: grupo dividido con "Dividir" DESMARCADO → fusionar en compra personal.
    // El backend hace el merge transaccional (suma valores + bolsillo, maneja diferidas).
    if (item && item._isGrupo && !dividir) {
      onSave({ _mergePersonal: true, _grupoId: item._grupoId });
      return;
    }

    // ── Validaciones estrictas del modo dividido (blindan la BD contra registros corruptos) ──
    // Aplican tanto al crear como al editar un grupo. NO aplican al merge-personal (dividir=false).
    if (dividir) {
      // 1) Toda fila debe tener un responsable elegido (evita "registros fantasma" sin nombre).
      if (splits.length === 0 || splits.some(sp => !sp.persona_id)) {
        toastErr('Cada fila debe tener un responsable (una persona o "Mi parte (Yo)"); elimina las filas sobrantes o desmarca la casilla de dividir.');
        return;
      }
      // 2) Sin repetidos: ni la misma persona ni "Mi parte" pueden ir en dos filas
      //    (el dropdown ya los excluye; esto es la defensa al guardar).
      const idsSeleccionados = splits.map(sp => String(sp.persona_id));
      if (new Set(idsSeleccionados).size !== idsSeleccionados.length) {
        toastErr('No puedes asignar al mismo responsable varias veces en una compra dividida. Por favor, suma sus montos en una sola fila.');
        return;
      }
    }

    // ── Cuadre del modo dividido (first-class) ──
    // La suma de TODAS las filas (terceros + "Mi parte" si existe) debe ser EXACTAMENTE el
    // Valor COP. Redondeo POR PARTE: cada monto se valida con el valor que realmente se guardará
    // (el payload hace Math.round por parte) — el cuadre nunca falla por decimales. Si no hay
    // fila "Mi parte", el titular no asume nada: el faltante bloquea aquí con error.
    let miParteFinal = 0;
    if (dividir) {
      const hayFilaPersonal = splits.some(sp => sp.persona_id === 'personal');
      miParteFinal = Math.round(parseFloat((splits.find(sp => sp.persona_id === 'personal') || {}).monto) || 0);
      const sumTerceros = splits.reduce((s, sp) => s + (sp.persona_id !== 'personal' ? Math.round(parseFloat(sp.monto) || 0) : 0), 0);
      const diff = Math.round(totalCop) - sumTerceros - miParteFinal;
      if (diff !== 0) {
        toastErr((diff > 0 ? 'Falta asignar ' + fmtCOP(diff) : 'Las partes exceden el total en ' + fmtCOP(Math.abs(diff)))
          + ': las filas suman ' + fmtCOP(sumTerceros + miParteFinal) + ' y el Valor COP es ' + fmtCOP(Math.round(totalCop)) + '. '
          + ((diff > 0 && !hayFilaPersonal) ? 'Ajusta los montos o agrega una fila "Mi parte (Yo)" si vas a asumir lo que falta.' : 'Ajusta los montos de las filas.'));
        return;
      }
    }

    // Edicion de grupo existente: diff splits vs originales, sin crear nuevas diferidas.
    // Desglose first-class → contrato del backend: la fila "Mi parte" viaja como remainder
    // (parte personal) y las demás como splits de terceros.
    if (dividir && splits.length > 0 && item && item._isGrupo) {
      const remainder = miParteFinal;
      onSave({
        _editGrupo: true,
        _grupoId: item._grupoId,
        _partesOriginales: item._partes,
        fecha, descripcion,
        valor_usd: usdNum,
        tasa_usd: tasaNum,
        es_internacional: esInternacional ? 1 : 0,
        splits: splits.filter(sp => sp.persona_id && sp.persona_id !== 'personal' && parseFloat(sp.monto) > 0),
        remainder,
        // Ciclo del grupo. Si el usuario fijó uno a mano en "Ciclo (avanzado)", viaja y se aplica a
        // TODAS las partes; si lo dejó vacío, va null y handleEditGrupo conserva el que ya tenían.
        ciclo: cicloManualVal || null,
        ciclo_manual: cicloManualVal ? 1 : 0
      });
      return;
    }

    // Split purchase: create one compra per persona + personal remainder ("Mi parte")
    if (dividir && splits.length > 0) {
      const remainder = miParteFinal;
      const grupoId = (crypto.randomUUID ? crypto.randomUUID() : 'g' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10));
      const isDiferida = numCuotas > 1;

      // Si es diferida, crear una diferida por cada parte
      const diferidaIds = {};
      if (isDiferida && tarjeta) {
        const diaCorte = tarjeta.dia_corte || 30;
        // Spillover Fase 2: si el banco factura en el corte SIGUIENTE, cada diferida arranca en el corte
        // del ciclo DESTINO; si no, en el corte natural de la fecha. fecha_compra se conserva en la fecha
        // real (abajo) para que syncData paso 11 no reajuste este primer corte (solo recalcula si
        // fecha_compra != compra.fecha; aquí SIEMPRE coinciden → el desvío del spillover sobrevive).
        let fechaPrimerCorte;
        if (cicloSpilloverBody) {
          fechaPrimerCorte = corteDeCiclo(cicloSpilloverBody, diaCorte);
        } else {
          const d = new Date(fecha + 'T12:00:00');
          let year = d.getFullYear(), month = d.getMonth();
          if (d.getDate() >= diaCorte) { month += 1; if (month > 11) { month = 0; year += 1; } }
          const lastDay = new Date(year, month + 1, 0).getDate();
          const day = Math.min(diaCorte, lastDay);
          fechaPrimerCorte = new Date(year, month, day).toISOString().slice(0, 10);
        }

        const allParts = splits.filter(sp => sp.persona_id && sp.persona_id !== 'personal' && parseFloat(sp.monto) > 0)
          .map(sp => ({ key: sp.persona_id, monto: Math.round(parseFloat(sp.monto)) }));
        if (remainder > 0) allParts.push({ key: 'personal', monto: remainder });

        for (const part of allParts) {
          const dif = await api('/diferidas', { method: 'POST', body: {
            tarjeta_id: tarjeta.id, etiqueta: descripcion, monto: part.monto,
            tasa_mv: cobrarIntereses ? tarjeta.tasa_mv_diferidas : 0,
            num_cuotas: parseInt(numCuotas), fecha_compra: fecha,
            fecha_primer_corte: fechaPrimerCorte, estado: 'activo', notas: 'Creada desde compra dividida'
          }});
          diferidaIds[part.key] = dif.id;
        }
        toast('Diferidas creadas a ' + numCuotas + ' cuotas' + (cobrarIntereses ? '' : ' (sin intereses)'));
      }

      // Spillover Fase 2: cada parte de la compra dividida se registra en el ciclo DESTINO (siguiente)
      // con ciclo_manual=1 (para que syncData paso 5 no la re-derive de la fecha). El backend POST /compras
      // respeta ciclo_manual+ciclo por compra. Sin spillover → ciclo natural, sin ciclo_manual (igual que antes).
      const base = { fecha, descripcion, valor_usd: usdNum, tasa_usd: tasaNum, estado: isDiferida ? 'diferida' : 'pendiente', ciclo: cicloSpilloverBody || ciclo, ciclo_manual: cicloSpilloverBody ? 1 : 0, notas, nota_personal: notaPersonal || null, tasa_intl: tasaIntlNum, grupo_id: grupoId, es_internacional: esInternacional ? 1 : 0 };
      const compras = splits
        .filter(sp => sp.persona_id && sp.persona_id !== 'personal' && parseFloat(sp.monto) > 0)
        .map(sp => ({ ...base, persona_id: parseInt(sp.persona_id), valor_cop: Math.round(parseFloat(sp.monto)), diferida_id: diferidaIds[sp.persona_id] || null }));
      if (remainder > 0) compras.push({ ...base, persona_id: null, valor_cop: remainder, diferida_id: diferidaIds['personal'] || null });
      if (compras.length === 0) { toastErr('Agrega al menos una persona con monto'); return; }
      // Conversión: el usuario abrió una compra individual existente y activó "dividir".
      // Marcamos la compra original para que saveCompra la elimine antes de crear las
      // nuevas, evitando duplicados. (DELETE en cascada limpia diferida_id y bolsillo_cuotas.)
      if (item && !item._isGrupo && item.id) {
        compras._replaceItemId = item.id;
      }
      onSave(compras);
      return;
    }

    // Si tiene cuotas: crear diferida PRIMERO para obtener su id, luego la compra
    let diferida_id = null;
    if (numCuotas > 1 && !item && tarjeta) {
      const diaCorte = tarjeta.dia_corte || 30;
      // Spillover Fase 2: si el banco factura en el corte SIGUIENTE, la diferida arranca en el corte del
      // ciclo DESTINO; si no, en el corte natural de la fecha. fecha_compra se conserva en la fecha real
      // (abajo) para que syncData paso 11 no reajuste este primer corte. La compra vinculada toma el ciclo
      // destino via el payload (ciclo: cicloSpilloverBody || ... , ya existente).
      let fechaPrimerCorte;
      if (cicloSpilloverBody) {
        fechaPrimerCorte = corteDeCiclo(cicloSpilloverBody, diaCorte);
      } else {
        const d = new Date(fecha + 'T12:00:00');
        let year = d.getFullYear(), month = d.getMonth();
        if (d.getDate() >= diaCorte) { month += 1; if (month > 11) { month = 0; year += 1; } }
        const lastDay = new Date(year, month + 1, 0).getDate();
        const day = Math.min(diaCorte, lastDay);
        fechaPrimerCorte = new Date(year, month, day).toISOString().slice(0, 10);
      }
      const dif = await api('/diferidas', { method: 'POST', body: {
        tarjeta_id: tarjeta.id,
        etiqueta: descripcion,
        monto: totalCop,
        tasa_mv: cobrarIntereses ? tarjeta.tasa_mv_diferidas : 0,
        num_cuotas: parseInt(numCuotas),
        fecha_compra: fecha,
        fecha_primer_corte: fechaPrimerCorte,
        estado: 'activo',
        notas: 'Creada desde compra'
      }});
      // Si el plan no se pudo crear (p.ej. el mes ya está pagado), CORTAR aquí: seguir adelante
      // registraría la compra sin su plan de cuotas. El backend es quien decide (v5.8.0).
      if (!dif || dif.error || !dif.id) { toastErr((dif && dif.error) || 'No se pudo crear el plan de cuotas'); return; }
      diferida_id = dif.id;
      toast('Diferida creada a ' + numCuotas + ' cuotas' + (cobrarIntereses ? '' : ' (sin intereses)'));
    }

    // Estado dinámico:
    //  - Diferida (cuotas > 1, o se edita una compra que ya es diferida): siempre 'diferida'.
    //    Nota: al editar una diferida, item.num_cuotas viene undefined (el dato real es
    //    cuotas_total), por eso numCuotas cae a 1 — de ahí el chequeo de item.estado/diferida_id.
    //  - 1 cuota: se DERIVA del bolsillo ya apartado vs el total. Evita el bug de resetear
    //    'bolsillo'/'bolsillo_parcial' a 'pendiente' al editar cualquier detalle de la compra.
    // Libertad total de cuotas: la transición estructural NO la hace el PUT (solo guarda campos)
    // sino el endpoint dedicado que corresponda, después y de forma transaccional:
    //   1→N convertir-a-diferida · N→M reprogramar · N→1 revertir-diferida.
    const nuevasCuotas = parseInt(numCuotas, 10) || 1;
    const esConversion = !!(item && cuotasEditables && cuotasOriginales === 1 && nuevasCuotas > 1);
    const esReprogramacion = !!(item && cuotasEditables && cuotasOriginales > 1 && nuevasCuotas > 1 && nuevasCuotas !== cuotasOriginales && item.diferida_id);
    const esReversion = !!(item && cuotasEditables && cuotasOriginales > 1 && nuevasCuotas === 1);
    const esDiferidaFinal = (!esConversion && numCuotas > 1) || (item && (item.estado === 'diferida' || item.diferida_id));
    let estadoCalculado;
    if (esDiferidaFinal) {
      estadoCalculado = 'diferida';
    } else {
      const mbCop = item ? (item.monto_bolsillo || 0) : 0;
      const mbUsd = item ? (item.monto_bolsillo_usd || 0) : 0;
      const esUsdPura = (usdNum > 0) && !totalCop;
      const target = esUsdPura ? usdNum : totalCop;
      const bol = esUsdPura ? mbUsd : mbCop;
      estadoCalculado = (target > 0 && bol >= target) ? 'bolsillo' : (bol > 0 ? 'bolsillo_parcial' : 'pendiente');
    }

    // Save the compra con diferida_id vinculado
    const compraData = {
      fecha, descripcion, valor_cop: totalCop,
      valor_usd: usdNum,
      tasa_usd: tasaNum,
      persona_id: personaId ? parseInt(personaId) : null,
      estado: estadoCalculado,
      // Ciclo destino: prioridad al spillover ("canje retrasado": el banco facturó en el corte
      // siguiente) → ciclo_manual con el ciclo SIGUIENTE al natural de la fecha; luego el campo
      // "Ciclo (avanzado)" (edición); si ninguno, el backend auto-deriva el ciclo de la fecha.
      ciclo: cicloSpilloverBody || cicloManualVal || ciclo,
      ciclo_manual: (cicloSpilloverBody || cicloManualVal) ? 1 : 0,
      // El sufijo "Diferida a N cuotas" solo se añade al CREAR: en conversión lo pone su endpoint,
      // en reprogramación se sincroniza y en una edición normal de diferida no debe re-añadirse.
      notas: (!item && numCuotas > 1) ? (notas ? notas + ' | ' : '') + 'Diferida a ' + numCuotas + ' cuotas' : notas,
      diferida_id,
      es_internacional: esInternacional ? 1 : 0,
      nota_personal: notaPersonal || null,
      tasa_intl: tasaIntlNum
    };
    if (esConversion) compraData._convertirCuotas = { num_cuotas: nuevasCuotas, cobrar_intereses: !!cobrarIntereses };
    else if (esReprogramacion) compraData._reprogramarCuotas = { diferida_id: item.diferida_id, num_cuotas: nuevasCuotas };
    else if (esReversion) compraData._revertirCuotas = true;
    onSave(compraData);
  }

  const totalCopNum = parseFloat(valorCop) || 0;
  // Suma de TODAS las filas (incluida "Mi parte" si existe) con redondeo POR PARTE (= lo que
  // se guardará), igual que el submit. cuadreDiff: falta (>0) o sobra (<0) para el Valor COP.
  const totalSplits = splits.reduce((s, sp) => s + Math.round(parseFloat(sp.monto) || 0), 0);
  const miParteNum = Math.round(parseFloat((splits.find(sp => sp.persona_id === 'personal') || {}).monto) || 0);
  const cuadreDiff = Math.round(totalCopNum) - totalSplits;

  // ¿La tarjeta de la compra acumula intereses sobre compras intl en COP?
  // Por ahora solo Bancolombia Visa (validado contra extracto real).
  const _frForm = tarjeta && tarjeta.franquicia ? tarjeta.franquicia.toLowerCase() : '';
  const _dualForm = _frForm.includes('mastercard') || _frForm.includes('amex') || _frForm.includes('american express');
  const aplicaIntlForm = !!(tarjeta && tarjeta.banco && tarjeta.banco.toLowerCase().includes('bancolombia') && !_dualForm);
  const intlCheckboxLabel = aplicaIntlForm ? 'Compra internacional (acumula intereses)' : 'Compra Internacional';

  // Asistente INTL — el hint solo se muestra si:
  //   1) La tarjeta seleccionada es Bancolombia Visa (candado por tarjeta: aplicaIntlForm).
  //   2) El usuario lleva al menos 3 caracteres en la descripción (evita falsos positivos).
  //   3) Alguna descripción histórica intl coincide (substring case-insensitive bidireccional).
  //   4) El checkbox de intl aún NO está marcado (sino el hint sería redundante).
  const descNorm = (descripcion || '').toLowerCase().trim();
  const intlHistMatch = descNorm.length >= 3 && intlDescripciones.some(d => d.includes(descNorm) || descNorm.includes(d));
  const showIntlHint = aplicaIntlForm && intlHistMatch && !esInternacional;
  // Ciclo destino que verá una compra marcada como "canje retrasado" (spillover al corte siguiente):
  // el ciclo siguiente al natural de la fecha (consciente del corte adelantado). Solo alimenta el hint
  // del checkbox (que ya está gated a crear/1-cuota/no-dividida). null si falta la fecha o es edición.
  const cicloSpilloverDestino = (!item && tarjeta && fecha) ? cicloSiguiente(cicloConCorteFront(fecha, tarjeta.dia_corte, tarjeta.cortes_custom || {})) : null;

  return e('form', { onSubmit: submit },
    // v5.8.0: se retiraron el modal de confirmación y el aviso ámbar de "ciclo cerrado". Ambos nacían
    // del calendario: mientras el extracto no esté pagado no se está alterando ningún cierre real, así
    // que advertirlo era ruido en el flujo normal de registrar lo del mes que acaba de cortar.
    e('div', { className: 'form-row' },
      e('div', { className: 'form-group' },
        e('label', { className: 'form-label' }, 'Fecha'),
        e('input', { type: 'date', className: 'form-input', value: fecha, onChange: ev => setFecha(ev.target.value), required: true, disabled: isCicloCerrado, style: lockStyle })
      ),
      !dividir && !(item && item._isGrupo) && e('div', { className: 'form-group' },
        e('label', { className: 'form-label' }, 'Persona'),
        e('select', { className: 'form-select', value: personaId, onChange: ev => setPersonaId(ev.target.value), disabled: isCicloCerrado, style: lockStyle },
          e('option', { value: '' }, 'Personal'),
          personas.map(p => e('option', { key: p.id, value: p.id }, p.nombre))
        )
      )
    ),
    // Canje retrasado / spillover: checkbox opcional al CREAR (Fase 2: 1 cuota, DIFERIDAS y DIVIDIDAS)
    // para cuando el banco factura una compra cercana al corte en el extracto del mes siguiente. Al
    // marcarlo, la compra (y las cuotas de su diferida) se registran en el ciclo destino (siguiente)
    // conservando su fecha real → esquiva el candado del ciclo natural cerrado (el backend valida el destino).
    !item && e('div', { className: 'form-group' },
      e('label', { style: { cursor: 'pointer', fontSize: 13 } },
        e('input', { type: 'checkbox', checked: facturaSiguienteCorte, onChange: ev => setFacturaSiguienteCorte(ev.target.checked), style: { marginRight: 6, cursor: 'pointer' } }),
        'El banco facturó esta compra en el siguiente corte'
      ),
      facturaSiguienteCorte && cicloSpilloverDestino && e('div', { className: 'form-hint', style: { color: 'var(--warning)' } },
        'Se registrará en el ciclo ' + cicloSpilloverDestino + ' (conserva su fecha real). Úsalo cuando compras cerca del cierre y el banco la factura en el extracto del mes siguiente.'
      ),
      facturaSiguienteCorte && !cicloSpilloverDestino && e('div', { className: 'form-hint', style: { color: 'var(--text-muted)' } },
        'Ingresa la fecha de la compra para calcular el ciclo destino.'
      )
    ),
    e('div', { className: 'form-group' },
      e('label', { className: 'form-label' }, 'Nombre en el Extracto'),
      // Wrapper RELATIVE que envuelve SOLO el input + el dropdown → el menú (absolute, top:100%)
      // se ancla al borde inferior del INPUT, no del form-group completo (que también contiene la
      // "Nota personal"; por eso antes el dropdown caía debajo de la nota).
      e('div', { style: { position: 'relative' } },
        // Autocompletado: dropdown custom (no <datalist> nativo, que ignora el tema). Filtra los
        // nombres ya usados por substring; solo aparece con foco + coincidencias. autoComplete='off'
        // evita que el navegador encime su propio historial del PC.
        e('input', { type: 'text', className: 'form-input', value: descripcion,
          onChange: ev => { setDescripcion(ev.target.value); setDescSugAbierto(true); },
          onFocus: () => setDescSugAbierto(true),
          // setTimeout en el blur: deja que el onMouseDown de una opción registre antes de cerrar.
          onBlur: () => setTimeout(() => setDescSugAbierto(false), 150),
          required: true, placeholder: 'Tal como llega al banco/correo (ej. APPLE.COM/BILL)', autoComplete: 'off' }),
        (function() {
          const q = (descripcion || '').trim().toLowerCase();
          const matches = q.length >= 1
            ? nombresUnicos.filter(n => n.toLowerCase().includes(q) && n.toLowerCase() !== q).slice(0, 8)
            : [];
          if (!descSugAbierto || matches.length === 0) return null;
          return e('div', { className: 'autocomplete-dropdown' },
            matches.map(n => e('div', {
              key: n, className: 'autocomplete-option', title: n,
              // onMouseDown + preventDefault: aplica la sugerencia sin que el input pierda el foco
              // (el blur se dispararía antes de un onClick y cerraría el dropdown primero).
              onMouseDown: (ev) => { ev.preventDefault(); setDescripcion(n); setDescSugAbierto(false); }
            }, n))
          );
        })()
      ),
      e('div', { className: 'form-hint', style: { color: 'var(--text-muted)' } }, 'Regístralo exactamente como aparece en el extracto: así la IA puede cruzarlo bien.'),
      e('label', { className: 'form-label', style: { marginTop: 10, display: 'block' } }, 'Nota personal (opcional)'),
      e('input', { type: 'text', className: 'form-input', value: notaPersonal, onChange: ev => setNotaPersonal(ev.target.value), placeholder: 'Tu nota privada (ej. iCloud). No se usa para cruzar con el banco.' }),
      // Asistente INTL: aviso proactivo cuando estamos en Bancolombia Visa y la descripción coincide con histórico intl.
      showIntlHint && e('div', {
        style: { fontSize: 12, color: '#fb923c', marginTop: 6, display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: 'rgba(251,146,60,0.08)', border: '1px solid rgba(251,146,60,0.25)', borderRadius: 6 }
      },
        e('span', { style: { flexShrink: 0, display: 'inline-flex' } }, e(Ico, { name: 'bulb', size: 14, color: 'currentColor' })),
        e('span', null, 'Compras anteriores con este nombre cobraron interés internacional. Considera marcar el check abajo.')
      )
    ),
    e('div', { style: { marginBottom: 12 } },
      e('label', { style: { cursor: isCicloCerrado ? 'not-allowed' : 'pointer', fontSize: 13, opacity: isCicloCerrado ? 0.6 : 1 } },
        e('input', { type: 'checkbox', checked: esInternacional, onChange: ev => setEsInternacional(ev.target.checked), style: { marginRight: 6, cursor: isCicloCerrado ? 'not-allowed' : 'pointer' }, disabled: isCicloCerrado }),
        intlCheckboxLabel
      ),
      esInternacional && e('div', { style: { fontSize: 11, color: 'var(--text-muted)', marginTop: 2, marginLeft: 20 } },
        aplicaIntlForm
          ? 'El banco cobra interés sobre el saldo. Si la compra fue en USD, puedes registrar valor y tasa abajo (opcional).'
          : 'Esta tarjeta no genera intereses internacionales en este sistema, pero puedes registrar el valor en USD y la tasa abajo (opcional).'
      ),
      esInternacional && aplicaIntlForm && e('div', { style: { marginTop: 8, marginLeft: 20 } },
        e('label', { className: 'form-label', style: { fontSize: 12 } }, 'Tasa de interés del extracto (% mensual)'),
        e('input', { type: 'number', step: '0.0001', className: 'form-input', value: tasaIntl, onChange: ev => setTasaIntl(ev.target.value), disabled: isCicloCerrado, style: lockStyle,
          placeholder: tarjeta && tarjeta.tasa_mv_avances ? (tarjeta.tasa_mv_avances * 100).toFixed(4) + '  (tasa actual)' : 'Ej: 2.0849' }),
        e('div', { className: 'form-hint', style: { color: 'var(--text-muted)' } },
          'Congela la tasa que el banco aplicó a ESTA compra (la imprime el extracto, ej. 2,0849). Así su interés no cambia si la tasa de la tarjeta fluctúa después. Si lo dejas vacío, la app busca la tasa que regía en la FECHA de la compra.')
      )
    ),
    // ── Inputs de valores según moneda ──────────────────────────────
    // Para tarjetas duales (Mastercard/Amex Bancolombia) + compra internacional:
    // el VALOR USD es la moneda nativa de la deuda → obligatorio. Valor COP queda
    // opcional (default 0, ya que el banco no convierte a pesos).
    // Para no-duales (Visa, etc.): comportamiento original — COP obligatorio,
    // USD/Tasa opcionales con auto-cálculo recíproco.
    (function() {
      const isDualIntl = _dualForm && esInternacional;
      // Si es dual+intl, mostramos USD primero (obligatorio), tasa al lado, COP al final opcional.
      if (isDualIntl) {
        return [
          e('div', { key: 'usd-row', className: 'form-row' },
            e('div', { className: 'form-group' },
              e('label', { className: 'form-label' }, 'Valor USD ',
                e('span', { style: { color: '#4FC3F7', fontWeight: 700, fontSize: 10, letterSpacing: 0.5 } }, '(obligatorio)')
              ),
              e('input', { type: 'number', step: '0.01', className: 'form-input', value: valorUsd, onChange: ev => onUsdChange(ev.target.value), placeholder: 'Ej: 9.99', required: true, disabled: isCicloCerrado, style: isCicloCerrado ? { borderColor: '#4FC3F7', opacity: 0.6, cursor: 'not-allowed' } : { borderColor: '#4FC3F7' } })
            ),
            e('div', { className: 'form-group' },
              e('label', { className: 'form-label' }, 'Tasa USD ',
                e('span', { style: { color: 'var(--text-muted)', fontWeight: 400 } }, '(recomendado)')
              ),
              e(MoneyInput, { value: tasaUsd, onChange: val => onTasaChange(val), disabled: isCicloCerrado, style: lockStyle, placeholder: trmInfo && trmInfo.trm ? (trmInfo.de_fecha_compra ? 'TRM del ' + trmInfo.fecha + ': ' : 'TRM día: ') + new Intl.NumberFormat('es-CO').format(Math.round(trmInfo.trm)) : 'Ej: 4.150' }),
              !tasaUsd && trmInfo && trmInfo.trm && e('div', { className: 'form-hint', style: { color: '#4FC3F7' } },
                'Si lo dejas vacío, se usará la TRM ' + (trmInfo.de_fecha_compra ? 'de la fecha de la compra' : 'del día') + ': $' + new Intl.NumberFormat('es-CO').format(Math.round(trmInfo.trm)) +
                (trmInfo.fecha ? ' (' + trmInfo.fecha + ')' : '') +
                (trmInfo.ok === false ? ' [valor de caché — sin conexión]' : '') +
                (!trmInfo.de_fecha_compra && fecha && fecha < todayISO() ? ' — no se encontró la TRM de esa fecha, revisa el valor' : '')
              )
            )
          ),
          e('div', { key: 'cop-row', className: 'form-group' },
            e('label', { className: 'form-label' }, 'Valor COP ',
              e('span', { style: { color: 'var(--text-muted)', fontWeight: 400 } }, '(opcional — el banco facturará en USD)')
            ),
            e(MoneyInput, { value: valorCop, onChange: val => setValorCop(val), placeholder: '0', disabled: isCicloCerrado, style: lockStyle })
          )
        ];
      }
      // Caso no-dual o no internacional: COP obligatorio + USD/Tasa opcionales si aplica.
      return [
        e('div', { key: 'cop-row', className: 'form-group' },
          e('label', { className: 'form-label' }, 'Valor COP'),
          e(MoneyInput, { value: valorCop, onChange: val => esInternacional ? onCopUsdChange(val) : setValorCop(val), required: true, disabled: isCicloCerrado, style: lockStyle }),
          esInternacional && lastUsdField.current === 'cop' && tasaUsd && e('div', { className: 'form-hint' }, 'Tasa calculada: ' + fmtCOP(tasaUsd) + ' por USD')
        ),
        esInternacional && e('div', { key: 'usd-row', className: 'form-row' },
          e('div', { className: 'form-group' },
            e('label', { className: 'form-label' }, 'Valor USD ',
              e('span', { style: { color: 'var(--text-muted)', fontWeight: 400 } }, '(opcional)')
            ),
            e('input', { type: 'number', step: '0.01', className: 'form-input', value: valorUsd, onChange: ev => onUsdChange(ev.target.value), placeholder: 'Ej: 9.99', disabled: isCicloCerrado, style: lockStyle })
          ),
          e('div', { className: 'form-group' },
            e('label', { className: 'form-label' }, 'Tasa USD ',
              e('span', { style: { color: 'var(--text-muted)', fontWeight: 400 } }, '(opcional)')
            ),
            e(MoneyInput, { value: tasaUsd, onChange: val => onTasaChange(val), placeholder: 'Ej: 4.150', disabled: isCicloCerrado, style: lockStyle })
          )
        )
      ];
    })(),
    e('div', { style: { marginBottom: dividir ? 6 : 12 } },
      e('label', { style: { cursor: isCicloCerrado ? 'not-allowed' : 'pointer', fontSize: 13, opacity: isCicloCerrado ? 0.6 : 1 } },
        e('input', { type: 'checkbox', checked: dividir, onChange: ev => setDividir(ev.target.checked), style: { marginRight: 6, cursor: isCicloCerrado ? 'not-allowed' : 'pointer' }, disabled: isCicloCerrado }),
        'Dividir entre personas'
      ),
      dividir && e('div', { style: { fontSize: 11, color: 'var(--text-muted)', marginTop: 4, marginLeft: 20 } },
        item && item._isGrupo
          ? 'Edita los montos o agrega/quita filas; tu porción es la fila "Mi parte (Yo)" de la lista. Las filas deben sumar el total exacto. Cuotas no se modifican.'
          : 'Agrega una fila por cada parte y elige quién la asume — tu porción es la opción "Mi parte (Yo)". Las filas deben sumar el Valor COP exacto; si no asumes nada, simplemente no agregues tu fila.'
      ),
      // Aviso de conversión: grupo dividido con el check desmarcado.
      item && item._isGrupo && !dividir && e('div', {
        style: { fontSize: 11, color: '#fb923c', marginTop: 6, marginLeft: 20, padding: '6px 10px', background: 'rgba(251,146,60,0.08)', border: '1px solid rgba(251,146,60,0.25)', borderRadius: 6 }
      }, 'Al guardar, esta compra dividida se fusionará en una sola compra 100% personal. Las partes de terceros desaparecerán.')
    ),
    dividir && e('div', { style: { background: 'var(--bg-tertiary)', borderRadius: 8, padding: '12px', marginBottom: 12 } },
      // División "first-class": una fila por parte. El titular es una fila más ("Mi parte (Yo)",
      // valor 'personal' en el mismo dropdown); las opciones ya usadas en OTRAS filas se excluyen
      // de los demás selects. Todas las filas se borran con el mismo botón — si el titular no
      // asume nada, simplemente borra su fila (el faltante bloquea el guardado, no se le asigna).
      splits.map((sp, i) => {
        // Responsables ya elegidos en OTRAS filas: se excluyen de este dropdown (la selecci\u00F3n
        // propia de la fila siempre queda visible para no romper el select controlado).
        const usadas = new Set(splits.filter((s, j) => j !== i).map(s => String(s.persona_id)));
        return e('div', { key: i, style: { display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 } },
          e('div', { style: { flex: 2 } },
            e('select', { className: 'form-select', value: sp.persona_id, disabled: isCicloCerrado, style: lockStyle,
              onChange: ev => setSplits(prev => prev.map((s, j) => j === i ? { ...s, persona_id: ev.target.value } : s)) },
              e('option', { value: '' }, 'Seleccionar'),
              !usadas.has('personal') && e('option', { value: 'personal' }, 'Mi parte (Yo)'),
              personas.filter(p => !usadas.has(String(p.id))).map(p => e('option', { key: p.id, value: p.id }, p.nombre))
            )
          ),
          e('div', { style: { flex: 1 } },
            e(MoneyInput, { value: sp.monto, placeholder: '0', disabled: isCicloCerrado, style: lockStyle,
              onChange: val => setSplits(prev => prev.map((s, j) => j === i ? { ...s, monto: val } : s)) })
          ),
          splits.length > 1 && !isCicloCerrado && e('button', { type: 'button', className: 'btn btn-sm btn-danger',
            onClick: () => setSplits(prev => prev.filter((_, j) => j !== i)) }, '\u00D7')
        );
      }),
      !isCicloCerrado && e('div', { style: { display: 'flex', gap: 8, marginBottom: 8, flexWrap: 'wrap' } },
        e('button', { type: 'button', className: 'btn btn-sm',
          onClick: () => setSplits(prev => [...prev, { persona_id: '', monto: '' }]) }, '+ Agregar persona'),
        totalCopNum > 0 && splits.length > 0 && e('button', { type: 'button', className: 'btn btn-sm',
          onClick: () => {
            // Reparte el Valor COP en partes iguales entre las filas actuales; el residuo del
            // redondeo lo absorbe la primera fila (el total queda cuadrado por construcci\u00F3n).
            const n = splits.length;
            const cuota = Math.floor(Math.round(totalCopNum) / n);
            const resto = Math.round(totalCopNum) - cuota * n;
            setSplits(prev => prev.map((s, i) => ({ ...s, monto: String(i === 0 ? cuota + resto : cuota) })));
          },
          title: 'Divide el Valor COP en partes iguales entre las filas actuales (la primera absorbe el redondeo)'
        }, '\u00F7 Repartir en partes iguales')
      ),
      totalCopNum > 0 && e('div', { style: { fontSize: 12, marginTop: 4 } },
        e('span', { style: { color: cuadreDiff !== 0 ? 'var(--danger)' : miParteNum === 0 ? 'var(--success)' : 'var(--text-secondary)' } },
          cuadreDiff < 0 ? 'Las partes exceden el total en ' + fmtCOP(Math.abs(cuadreDiff))
            : cuadreDiff > 0 ? 'Falta asignar ' + fmtCOP(cuadreDiff) + ' entre las partes'
            : miParteNum === 0 ? 'Dividido 100% entre terceros \u2014 tu parte queda en $0'
            : 'Cuadra exacto \u2014 tu parte: ' + fmtCOP(miParteNum)
        )
      )
    ),
    e('div', { className: 'form-row' },
      !(item && item._isGrupo) && e('div', { className: 'form-group' },
        e('label', { className: 'form-label' }, 'Cuotas'),
        // Libertad total: 1→N convierte, N→M reprograma, N→1 revierte (endpoints dedicados tras el
        // PUT; la fila original queda intacta). Bloqueado solo para grupos, USD o con abono parcial.
        e('input', { type: 'number', className: 'form-input', value: numCuotas, onChange: ev => setNumCuotas(ev.target.value), min: 1, max: 60, disabled: !!item && !cuotasEditables, style: (item && !cuotasEditables) ? { opacity: 0.6, cursor: 'not-allowed' } : undefined }),
        item && !cuotasEditables && e('div', { className: 'form-hint', style: { color: 'var(--text-muted)' } },
          'Las cuotas no se pueden cambiar aquí: la compra es de un ciclo ya cerrado, es dividida, tiene abonos o es una compra solo en dólares (sin valor en pesos).'
        ),
        item && cuotasEditables && (parseInt(numCuotas, 10) || 1) !== cuotasOriginales && e('div', { className: 'form-hint', style: { color: 'var(--warning)' } },
          cuotasOriginales === 1
            ? 'Esta compra se convertirá en diferida a ' + numCuotas + ' cuotas conservando su fecha original.'
            : (parseInt(numCuotas, 10) || 1) === 1
              ? 'Esta compra volverá a ser de 1 cuota: se elimina su plan de cuotas y el dinero apartado por cuota se consolida en el bolsillo de la compra.'
              : 'El plan de cuotas se reprogramará de ' + cuotasOriginales + ' a ' + numCuotas + ' cuotas (la proyección se regenera con la misma tasa).'
        ),
        ((!item && numCuotas > 1) || (item && cuotasEditables && cuotasOriginales === 1 && numCuotas > 1)) && e('div', null,
          e('div', { style: { marginTop: 6, marginBottom: 4 } },
            e('label', { style: { cursor: 'pointer', fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 } },
              e('input', { type: 'checkbox', checked: cobrarIntereses, onChange: ev => setCobrarIntereses(ev.target.checked) }),
              'Cobrar intereses'
            )
          ),
          e('div', { className: 'form-hint', style: { color: cobrarIntereses ? 'var(--accent)' : 'var(--success)' } },
            cobrarIntereses
              ? 'Tasa: ' + (tarjeta ? (tarjeta.tasa_mv_diferidas * 100).toFixed(4) : '?') + '% MV'
              : 'Sin intereses (0% MV)'
          )
        )
      ),
      e('div', { className: 'form-group' },
        e('label', { className: 'form-label', style: { color: 'var(--text-muted)' } }, 'Notas del Sistema (Legado/Automático)'),
        e('input', { type: 'text', className: 'form-input', value: notas, onChange: ev => setNotas(ev.target.value), style: { opacity: 0.6, color: 'var(--text-muted)' } }),
        e('div', { className: 'form-hint', style: { color: 'var(--text-muted)' } }, 'Campo automático del sistema (ej. marca de diferida). Para tus descripciones usa "Nota personal" arriba.')
      )
    ),
    // Ciclo manual (avanzado): al editar una compra de 1 cuota, sea individual o DIVIDIDA. Antes se
    // excluían los grupos (!item._isGrupo) y no había forma de mover una compra dividida de ciclo:
    // el caso real es una compra partida entre personas hecha el día del corte, que el banco factura
    // en el ciclo siguiente. Crear ya lo soportaba (el checkbox de spillover cubre divididas desde
    // v5.0.0); editar no, y esa asimetría dejaba el caso sin salida por la interfaz.
    item && numCuotas <= 1 && e('div', { className: 'form-group', style: { marginTop: 4 } },
      e('label', { className: 'form-label' }, 'Ciclo (avanzado)'),
      e('input', { type: 'month', className: 'form-input', value: cicloManualVal, onChange: ev => setCicloManualVal(ev.target.value), disabled: isCicloCerrado, style: lockStyle }),
      e('div', { className: 'form-hint', style: { color: cicloManualVal ? 'var(--warning)' : 'var(--text-muted)' } },
        isCicloCerrado
          ? 'El ciclo no se puede cambiar: la compra pertenece a un extracto que el banco ya generó.'
          : cicloManualVal
            ? 'Ciclo fijado a mano: esta compra contará en ' + cicloManualVal + ' sin importar su fecha. Útil para cuotas que el banco reprogramó a otro mes.'
            : 'Vacío = el ciclo se calcula solo según la fecha. Llénalo solo si el banco factura esta compra en un mes distinto al de su fecha.'
      )
    ),
    e('div', { className: 'modal-actions' },
      e('button', { type: 'button', className: 'btn', onClick: onCancel }, 'Cancelar'),
      e('button', { type: 'submit', className: 'btn btn-primary' }, 'Guardar')
    )
  );
}

function AvanceForm({ item, tarjeta, onSave, onCancel }) {
  const [etiqueta, setEtiqueta] = useState(item ? item.etiqueta : '');
  const [monto, setMonto] = useState(item ? item.monto : '');
  const [tasaMv, setTasaMv] = useState(item ? (item.tasa_mv * 100).toFixed(4) : (tarjeta.tasa_mv_avances * 100).toFixed(4));
  const [fechaDesembolso, setFechaDesembolso] = useState(item ? item.fecha_desembolso : todayISO());
  const [comision, setComision] = useState(item ? (item.comision || '') : '');
  const [notas, setNotas] = useState(item ? (item.notas || '') : '');
  const [fetchingRate, setFetchingRate] = useState(false);
  // En edicion solo se permiten nombre y nota; el resto es fijo (reescribiria la amortizacion).
  const isEdit = !!item;

  async function fetchRate() {
    if (!tarjeta.url_tasas) { toastErr('Esta tarjeta no tiene URL de tasas configurada'); return; }
    setFetchingRate(true);
    try {
      const r = await api('/scrape-tasas?url=' + encodeURIComponent(tarjeta.url_tasas));
      if (r.ok && r.found && r.rates && r.rates.avances_mv) {
        setTasaMv(r.rates.avances_mv.toFixed(4));
        toast('Tasa actualizada: ' + r.rates.avances_mv.toFixed(4) + '%');
      } else {
        toastErr('No se encontraron tasas en la pagina. Ingresa la tasa manualmente.');
      }
    } catch (err) { toastErr(err.message); }
    setFetchingRate(false);
  }

  function submit(ev) {
    ev.preventDefault();
    if (isEdit) { onSave({ etiqueta, notas }); return; } // edicion restringida: solo nombre + nota
    onSave({ etiqueta, monto: parseFloat(monto), tasa_mv: parseFloat(tasaMv) / 100, plazo: 24, fecha_desembolso: fechaDesembolso, dia_corte: tarjeta.dia_corte, estado: 'activo', notas, comision: parseFloat(comision) || 0 });
  }

  return e('form', { onSubmit: submit },
    e('div', { className: 'form-group' },
      e('label', { className: 'form-label' }, 'Etiqueta'),
      e('input', { type: 'text', className: 'form-input', value: etiqueta, onChange: ev => setEtiqueta(ev.target.value), required: true, placeholder: 'Ej: Avance 5M Marzo' })
    ),
    e('div', { className: 'form-row' },
      e('div', { className: 'form-group' },
        e('label', { className: 'form-label' }, 'Monto'),
        isEdit
          ? e('input', { type: 'text', className: 'form-input', value: fmtNumInput(monto), disabled: true })
          : e(MoneyInput, { value: monto, onChange: val => setMonto(val), required: true })
      ),
      e('div', { className: 'form-group' },
        e('label', { className: 'form-label' }, 'Tasa Mensual (MV %)'),
        e('div', { style: { display: 'flex', gap: 6 } },
          e('input', { type: 'number', step: '0.0001', className: 'form-input', value: tasaMv, onChange: ev => setTasaMv(ev.target.value), required: true, disabled: isEdit }),
          !isEdit && tarjeta.url_tasas && e('button', { type: 'button', className: 'rate-fetch-btn' + (fetchingRate ? ' loading' : ''), onClick: fetchRate, disabled: fetchingRate, title: 'Consultar tasa actual desde la web' }, e(Ico, { name: 'globe', size: 14, color: 'currentColor' }))
        )
      )
    ),
    e('div', { className: 'form-row' },
      e('div', { className: 'form-group' },
        e('label', { className: 'form-label' }, 'Fecha Desembolso'),
        e('input', { type: 'date', className: 'form-input', value: fechaDesembolso, onChange: ev => setFechaDesembolso(ev.target.value), required: true, disabled: isEdit })
      ),
      e('div', { className: 'form-group' },
        e('label', { className: 'form-label' }, 'Plazo'),
        e('div', { className: 'form-input', style: { display: 'flex', alignItems: 'center', background: 'var(--bg-card)', opacity: 0.8 } }, '24 meses (fijo)')
      )
    ),
    e('div', { className: 'form-row' },
      e('div', { className: 'form-group' },
        e('label', { className: 'form-label' }, 'Comision del Avance'),
        isEdit
          ? e('input', { type: 'text', className: 'form-input', value: fmtNumInput(comision), disabled: true })
          : e(MoneyInput, { value: comision, onChange: val => setComision(val), placeholder: 'Ej: 6840' })
      ),
      e('div', { className: 'form-group' },
        e('label', { className: 'form-label' }, 'Notas'),
        e('input', { type: 'text', className: 'form-input', value: notas, onChange: ev => setNotas(ev.target.value) })
      )
    ),
    isEdit && e('div', { style: { fontSize: 12, color: 'var(--text-muted)', marginTop: 4 } }, 'En una transaccion en curso solo se puede cambiar el nombre y la nota; lo demas es fijo.'),
    e('div', { className: 'modal-actions' },
      e('button', { type: 'button', className: 'btn', onClick: onCancel }, 'Cancelar'),
      e('button', { type: 'submit', className: 'btn btn-primary' }, 'Guardar')
    )
  );
}

function AbonoForm({ onSave, onCancel }) {
  const [fecha, setFecha] = useState(todayISO());
  const [monto, setMonto] = useState('');
  const [notas, setNotas] = useState('');
  function submit(ev) { ev.preventDefault(); onSave({ fecha, monto: parseFloat(monto), notas }); }
  return e('form', { onSubmit: submit },
    e('div', { className: 'form-row' },
      e('div', { className: 'form-group' }, e('label', { className: 'form-label' }, 'Fecha'), e('input', { type: 'date', className: 'form-input', value: fecha, onChange: ev => setFecha(ev.target.value), required: true })),
      e('div', { className: 'form-group' }, e('label', { className: 'form-label' }, 'Monto'), e(MoneyInput, { value: monto, onChange: val => setMonto(val), required: true }))
    ),
    e('div', { className: 'form-group' }, e('label', { className: 'form-label' }, 'Notas'), e('input', { type: 'text', className: 'form-input', value: notas, onChange: ev => setNotas(ev.target.value) })),
    e('div', { className: 'modal-actions' },
      e('button', { type: 'button', className: 'btn', onClick: onCancel }, 'Cancelar'),
      e('button', { type: 'submit', className: 'btn btn-primary' }, 'Registrar Abono')
    )
  );
}

function DiferidaForm({ item, tarjeta, onSave, onCancel }) {
  const [etiqueta, setEtiqueta] = useState(item ? item.etiqueta : '');
  const [monto, setMonto] = useState(item ? item.monto : '');
  const [tasaMv, setTasaMv] = useState(item ? (item.tasa_mv * 100).toFixed(4) : (tarjeta.tasa_mv_diferidas * 100).toFixed(4));
  const [numCuotas, setNumCuotas] = useState(item ? item.num_cuotas : 12);
  const [fechaCompra, setFechaCompra] = useState(item ? item.fecha_compra : todayISO());
  const [fechaPrimerCorte, setFechaPrimerCorte] = useState(item ? item.fecha_primer_corte : '');
  const [estado, setEstado] = useState(item ? item.estado : 'activo');
  const [notas, setNotas] = useState(item ? (item.notas || '') : '');
  const [fetchingRate, setFetchingRate] = useState(false);
  // En edicion solo se permiten nombre y nota; el resto es fijo (reescribiria la amortizacion).
  const isEdit = !!item;

  useEffect(() => {
    if (fechaCompra && !item) {
      const d = new Date(fechaCompra + 'T12:00:00');
      const diaCorte = tarjeta.dia_corte;
      let year = d.getFullYear(), month = d.getMonth();
      if (d.getDate() >= diaCorte) { month += 1; if (month > 11) { month = 0; year += 1; } }
      const lastDay = new Date(year, month + 1, 0).getDate();
      const day = Math.min(diaCorte, lastDay);
      setFechaPrimerCorte(new Date(year, month, day).toISOString().slice(0, 10));
    }
  }, [fechaCompra]);

  async function fetchRate() {
    if (!tarjeta.url_tasas) { toastErr('Esta tarjeta no tiene URL de tasas configurada'); return; }
    setFetchingRate(true);
    try {
      const r = await api('/scrape-tasas?url=' + encodeURIComponent(tarjeta.url_tasas));
      if (r.ok && r.found && r.rates && r.rates.compras_mv) {
        setTasaMv(r.rates.compras_mv.toFixed(4));
        toast('Tasa actualizada: ' + r.rates.compras_mv.toFixed(4) + '%');
      } else { toastErr('No se encontraron tasas en la pagina. Ingresa la tasa manualmente.'); }
    } catch (err) { toastErr(err.message); }
    setFetchingRate(false);
  }

  function submit(ev) {
    ev.preventDefault();
    if (isEdit) { onSave({ etiqueta, notas }); return; } // edicion restringida: solo nombre + nota
    onSave({ etiqueta, monto: parseFloat(monto), tasa_mv: parseFloat(tasaMv) / 100, num_cuotas: parseInt(numCuotas), fecha_compra: fechaCompra, fecha_primer_corte: fechaPrimerCorte, estado, notas });
  }

  return e('form', { onSubmit: submit },
    e('div', { className: 'form-group' },
      e('label', { className: 'form-label' }, 'Etiqueta'),
      e('input', { type: 'text', className: 'form-input', value: etiqueta, onChange: ev => setEtiqueta(ev.target.value), required: true })
    ),
    e('div', { className: 'form-row' },
      e('div', { className: 'form-group' },
        e('label', { className: 'form-label' }, 'Monto'),
        isEdit
          ? e('input', { type: 'text', className: 'form-input', value: fmtNumInput(monto), disabled: true })
          : e(MoneyInput, { value: monto, onChange: val => setMonto(val), required: true })
      ),
      e('div', { className: 'form-group' },
        e('label', { className: 'form-label' }, 'Tasa Mensual (MV %)'),
        e('div', { style: { display: 'flex', gap: 6 } },
          e('input', { type: 'number', step: '0.0001', className: 'form-input', value: tasaMv, onChange: ev => setTasaMv(ev.target.value), required: true, disabled: isEdit }),
          !isEdit && tarjeta.url_tasas && e('button', { type: 'button', className: 'rate-fetch-btn' + (fetchingRate ? ' loading' : ''), onClick: fetchRate, disabled: fetchingRate, title: 'Consultar tasa actual' }, e(Ico, { name: 'globe', size: 14, color: 'currentColor' }))
        )
      ),
      e('div', { className: 'form-group' },
        e('label', { className: 'form-label' }, 'Numero de Cuotas'),
        e('input', { type: 'number', className: 'form-input', value: numCuotas, onChange: ev => setNumCuotas(ev.target.value), required: true, disabled: isEdit })
      )
    ),
    e('div', { className: 'form-row' },
      e('div', { className: 'form-group' },
        e('label', { className: 'form-label' }, 'Fecha Compra'),
        e('input', { type: 'date', className: 'form-input', value: fechaCompra, onChange: ev => setFechaCompra(ev.target.value), required: true, disabled: isEdit })
      ),
      e('div', { className: 'form-group' },
        e('label', { className: 'form-label' }, 'Fecha Primer Corte'),
        e('input', { type: 'date', className: 'form-input', value: fechaPrimerCorte, onChange: ev => setFechaPrimerCorte(ev.target.value), required: true, disabled: isEdit })
      ),
      e('div', { className: 'form-group' },
        e('label', { className: 'form-label' }, 'Estado'),
        e('select', { className: 'form-select', value: estado, onChange: ev => setEstado(ev.target.value), disabled: isEdit },
          e('option', { value: 'activo' }, 'Activo'), e('option', { value: 'liquidado' }, 'Liquidado')
        )
      )
    ),
    e('div', { className: 'form-group' }, e('label', { className: 'form-label' }, 'Notas'), e('input', { type: 'text', className: 'form-input', value: notas, onChange: ev => setNotas(ev.target.value) })),
    isEdit && e('div', { style: { fontSize: 12, color: 'var(--text-muted)', marginTop: 4 } }, 'En una transaccion en curso solo se puede cambiar el nombre y la nota; lo demas es fijo.'),
    e('div', { className: 'modal-actions' },
      e('button', { type: 'button', className: 'btn', onClick: onCancel }, 'Cancelar'),
      e('button', { type: 'submit', className: 'btn btn-primary' }, 'Guardar')
    )
  );
}

// Reprogramacion RETROACTIVA de saldo ("Sellar y Renacer"). item = diferidaDetail (trae amortizacion,
// monto, num_cuotas, tasa_mv, etiqueta, compra_id). El preview se calcula en el cliente desde la
// amortizacion ya cargada + el ciclo vigente de la tarjeta (el POST del backend es la fuente de verdad).
function ReprogramarForm({ item, tarjeta, onSave, onCancel }) {
  const vigente = tarjeta.ciclo_vigente || cicloVigente(tarjeta.dia_corte);
  const tabla = item.amortizacion || [];
  // k = cuotas ya facturadas (fechaCorte en un ciclo anterior al vigente). Saldo = monto - Σ capital(k).
  const k = tabla.filter(q => q.fechaCorte.slice(0, 7) < vigente).length;
  let sumSellado = 0;
  for (let i = 0; i < k; i++) sumSellado += Math.round(tabla[i].cuotaCapital);
  const montoR = Math.round((item.monto || 0) * 100) / 100;
  const saldoRestante = Math.round((montoR - sumSellado) * 100) / 100;

  const [numCuotas, setNumCuotas] = useState(item.num_cuotas || (k + 1));
  const [cobrarInt, setCobrarInt] = useState(true);
  const [tasaMv, setTasaMv] = useState(((item.tasa_mv || 0) * 100).toFixed(4)); // hereda la tasa del plan
  const [confirmando, setConfirmando] = useState(false);

  const M = parseInt(numCuotas, 10);
  const remanente = (M && M > k) ? (M - k) : 0;
  const tasaNum = cobrarInt ? (parseFloat(tasaMv) / 100) : 0;
  const cuotaCapitalAprox = remanente > 0 ? Math.round(saldoRestante / remanente) : 0;
  const interesPrimerMes = Math.round(saldoRestante * (tasaNum || 0)); // ~1 mes sobre el saldo (aprox)

  let err = null;
  if (!M || M < 1 || M > 120) err = 'Indica un total de cuotas entre 1 y 120.';
  else if (M <= k) err = 'El nuevo total debe ser MAYOR que las ' + k + ' cuota(s) ya facturada(s).';
  else if (!(saldoRestante > 0)) err = 'No queda saldo por reprogramar en esta diferida.';
  else if (cobrarInt && !(tasaNum >= 0 && tasaNum < 1)) err = 'Tasa invalida (entre 0 y 100% MV).';
  const valido = !err;

  function aplicar() { onSave({ num_cuotas_nuevas: M, tasa_mv: tasaNum, cobrar_intereses: cobrarInt }); }

  if (confirmando && valido) {
    return e('div', null,
      e('div', { style: { fontSize: 13.5, color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: 16 } },
        e('div', { style: { display: 'inline-flex', alignItems: 'center', gap: 8, fontWeight: 600, color: 'var(--text-primary)', marginBottom: 8 } },
          e(Ico, { name: 'alert', size: 18, color: 'var(--warning)' }), 'Confirmar reprogramacion'),
        e('div', null, item.etiqueta, ':'),
        e('ul', { style: { margin: '10px 0', paddingLeft: 18 } },
          e('li', null, 'Se sellaran ', e('strong', null, String(k)), ' cuota(s) ya facturada(s) como registro historico (intocables).'),
          e('li', null, 'El saldo de ', e('strong', null, fmtCOP(saldoRestante)), ' se reprograma a ', e('strong', null, String(remanente)), ' cuota(s)', cobrarInt ? (' al ' + parseFloat(tasaMv).toFixed(4) + '% MV.') : ' sin intereses.'),
          e('li', { style: { color: 'var(--text-muted)' } }, 'Crea un plan nuevo y elimina el actual. No es facilmente reversible.')
        )
      ),
      e('div', { className: 'modal-actions' },
        e('button', { type: 'button', className: 'btn', onClick: () => setConfirmando(false) }, 'Volver'),
        e('button', { type: 'button', className: 'btn btn-primary', onClick: aplicar }, 'Confirmar reprogramacion')
      )
    );
  }

  return e('form', { onSubmit: (ev) => { ev.preventDefault(); if (valido) setConfirmando(true); } },
    e('div', { style: { fontSize: 13, color: 'var(--text-muted)', marginBottom: 12, lineHeight: 1.5 } },
      'Plan actual: ' + (item.num_cuotas || '?') + ' cuotas. Ya facturadas (se sellaran): ' + k + '. Saldo a reprogramar: ' + fmtCOP(saldoRestante) + '.'),
    e('div', { className: 'form-row' },
      e('div', { className: 'form-group' },
        e('label', { className: 'form-label' }, 'Nuevo total de cuotas'),
        e('input', { type: 'number', className: 'form-input', min: k + 1, max: 120, value: numCuotas, onChange: ev => setNumCuotas(ev.target.value), required: true }),
        e('div', { style: { fontSize: 11, color: 'var(--text-muted)', marginTop: 3 } }, 'Incluye las ' + k + ' ya facturada(s). Ej: banco 12->2 con 1 facturada => escribe 2.')
      ),
      e('div', { className: 'form-group' },
        e('label', { className: 'form-label' }, 'Tasa Mensual (MV %)'),
        e('input', { type: 'number', step: '0.0001', className: 'form-input', value: tasaMv, onChange: ev => setTasaMv(ev.target.value), disabled: !cobrarInt, style: !cobrarInt ? { opacity: 0.6, cursor: 'not-allowed' } : {} })
      )
    ),
    e('div', { className: 'form-group' },
      e('label', { style: { display: 'flex', alignItems: 'center', gap: 8, fontSize: 13.5, cursor: 'pointer' } },
        e('input', { type: 'checkbox', checked: cobrarInt, onChange: ev => setCobrarInt(ev.target.checked) }),
        'Cobrar intereses sobre el saldo reprogramado')
    ),
    (() => {
      if (err) return e('div', { style: { marginTop: 4, padding: '10px 12px', background: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: 8, fontSize: 13, lineHeight: 1.4 } }, err);
      return e('div', { style: { marginTop: 4, padding: '12px', background: 'var(--bg-tertiary)', borderRadius: 8, fontSize: 13, lineHeight: 1.7 } },
        e('div', { style: { fontWeight: 600, marginBottom: 6 } }, 'Vista previa'),
        e('div', null, 'Cuotas selladas (facturadas): ', e('strong', null, String(k))),
        e('div', null, 'Saldo a reprogramar: ', e('strong', null, fmtCOP(saldoRestante))),
        e('div', null, 'Nuevas cuotas del saldo: ', e('strong', null, String(remanente)), ' de ~', e('strong', null, fmtCOP(cuotaCapitalAprox)), ' de capital c/u'),
        cobrarInt
          ? e('div', { style: { color: 'var(--text-muted)' } }, 'Interes 1a cuota (~1 mes, aprox): ~' + fmtCOP(interesPrimerMes) + '. El detalle exacto se calcula al aplicar.')
          : e('div', { style: { color: 'var(--text-muted)' } }, 'Sin intereses (0%).')
      );
    })(),
    e('div', { style: { fontSize: 11.5, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.5 } },
      'El interes que reliquida el banco puede variar; ajusta la tasa con tu extracto reprogramado real cuando llegue.'),
    e('div', { className: 'modal-actions' },
      e('button', { type: 'button', className: 'btn', onClick: onCancel }, 'Cancelar'),
      e('button', { type: 'submit', className: 'btn btn-primary', disabled: !valido }, 'Reprogramar')
    )
  );
}

function PersonaForm({ item, onSave, onCancel }) {
  const [nombre, setNombre] = useState(item ? item.nombre : '');
  const [color, setColor] = useState(item ? item.color : '#4f8cff');
  const [telefono, setTelefono] = useState(item ? (item.telefono || '') : '');
  const [notas, setNotas] = useState(item ? (item.notas || '') : '');
  function submit(ev) { ev.preventDefault(); onSave({ nombre, color, orden: 0, telefono, notas }); }
  return e('form', { onSubmit: submit },
    e('div', { className: 'form-row' },
      e('div', { className: 'form-group' }, e('label', { className: 'form-label' }, 'Nombre'), e('input', { type: 'text', className: 'form-input', value: nombre, onChange: ev => setNombre(ev.target.value), required: true })),
      e('div', { className: 'form-group' }, e('label', { className: 'form-label' }, 'Color'), e('input', { type: 'color', className: 'form-input', value: color, onChange: ev => setColor(ev.target.value), style: { height: 40, padding: 4 } }))
    ),
    e('div', { className: 'form-row' },
      e('div', { className: 'form-group' }, e('label', { className: 'form-label' }, 'Telefono'), e('input', { type: 'text', className: 'form-input', value: telefono, onChange: ev => setTelefono(ev.target.value) })),
      e('div', { className: 'form-group' }, e('label', { className: 'form-label' }, 'Notas'), e('input', { type: 'text', className: 'form-input', value: notas, onChange: ev => setNotas(ev.target.value) }))
    ),
    e('div', { className: 'modal-actions' },
      e('button', { type: 'button', className: 'btn', onClick: onCancel }, 'Cancelar'),
      e('button', { type: 'submit', className: 'btn btn-primary' }, 'Guardar')
    )
  );
}
