// public/js/resumen.js — Vista Resumen de una tarjeta: cards, tablas y todas sus acciones.
//
// El simbolo mas grande del frontend (~1.790 lineas). Se mueve ENTERO y no se parte por dentro:
// sus ~26 funciones internas son closures sobre el estado de React del propio componente, asi
// que extraerlas no seria mover codigo sino redisenarlo.


// ═══════════════════════════════════════════════════════════════════
// CARD VIEW — Resumen per card
// ═══════════════════════════════════════════════════════════════════
function CardResumen({ tarjeta, onDataChange }) {
  const [data, setData] = useState(null);
  const [compras, setCompras] = useState([]);
  const [personas, setPersonas] = useState([]);
  const [resumen, setResumen] = useState(null);
  // Ciclo por defecto = ciclo_sugerido que calcula el backend: el vigente según el corte, salvo
  // que el extracto del ciclo anterior siga pendiente (pago mínimo sin cubrir al 100%), en cuyo
  // caso arranca en ese anterior para que el usuario vea primero lo que debe pagar. Fallback al
  // vigente si el backend no lo envió.
  const [ciclo, setCiclo] = useState(tarjeta.ciclo_sugerido || cicloVigente(tarjeta.dia_corte));
  const [avances, setAvances] = useState([]);
  const [diferidas, setDiferidas] = useState([]);
  const [selectedAvance, setSelectedAvance] = useState(null);
  const [avanceDetail, setAvanceDetail] = useState(null);
  const [selectedDiferida, setSelectedDiferida] = useState(null);
  const [diferidaDetail, setDiferidaDetail] = useState(null);
  const [showMovModal, setShowMovModal] = useState(false);
  const [editCompra, setEditCompra] = useState(null);
  const [showCompraModal, setShowCompraModal] = useState(false);
  const [showAvanceModal, setShowAvanceModal] = useState(false);
  const [editAvance, setEditAvance] = useState(null);
  const [showDiferidaModal, setShowDiferidaModal] = useState(false);
  const [editDiferida, setEditDiferida] = useState(null);
  const [showReprogramarModal, setShowReprogramarModal] = useState(false);
  // Animación del reordenamiento: qué filas acaban de moverse y en qué sentido. Se limpia sola con
  // el timer, cuyo handle vive en un ref para poder cancelarlo si el usuario encadena clics.
  const [filasMovidas, setFilasMovidas] = useState(null);
  const movTimer = useRef(null);
  // Posiciones de las filas ANTES de reordenar, para la técnica FLIP.
  const posPrevias = useRef(null);

  // FLIP (First, Last, Invert, Play): la unica forma de que se vea el RECORRIDO entre las dos
  // posiciones y no un simple desliz al aparecer ya colocada. Se mide donde estaba cada fila
  // (First), se deja que React pinte el orden nuevo (Last), se la devuelve visualmente a su sitio
  // viejo con un transform (Invert) y se suelta con transicion (Play).
  //
  // El transform va sobre las <td> y no sobre el <tr>: en layout de tabla el transform de una fila
  // lo ignoran varios motores, y las celdas se mueven igual de bien.
  function medirFilas() {
    const pos = {};
    document.querySelectorAll('tr[data-cid]').forEach(tr => {
      // Se limpia cualquier transform que siga vivo de un movimiento anterior ANTES de medir: si el
      // usuario encadena clics, getBoundingClientRect devolvería la posición a medio animar y el
      // siguiente salto arrancaría desde un punto falso.
      const celdas = tr.children;
      for (let i = 0; i < celdas.length; i++) { celdas[i].style.transition = ''; celdas[i].style.transform = ''; }
      pos[tr.getAttribute('data-cid')] = tr.getBoundingClientRect().top;
    });
    return pos;
  }
  function flipReordenar(previas) {
    if (!previas) return;
    document.querySelectorAll('tr[data-cid]').forEach(tr => {
      const antes = previas[tr.getAttribute('data-cid')];
      if (antes == null) return;
      const delta = antes - tr.getBoundingClientRect().top;
      if (!delta) return;                       // no se movio: nada que animar
      const celdas = tr.children;
      for (let i = 0; i < celdas.length; i++) {
        const td = celdas[i];
        td.style.transition = 'none';
        td.style.transform = 'translateY(' + delta + 'px)';
      }
      void tr.offsetHeight;                      // reflow: fija el punto de partida
      for (let i = 0; i < celdas.length; i++) {
        const td = celdas[i];
        td.style.transition = 'transform 700ms cubic-bezier(.4,0,.2,1)';
        td.style.transform = '';
      }
      setTimeout(() => {
        for (let i = 0; i < celdas.length; i++) { celdas[i].style.transition = ''; celdas[i].style.transform = ''; }
      }, 760);
    });
  }
  // useLayoutEffect corre con el DOM ya actualizado y ANTES de pintar: es justo el hueco donde el
  // FLIP tiene que invertir la posicion, para que el usuario nunca llegue a ver el salto.
  React.useLayoutEffect(() => {
    if (!posPrevias.current) return;
    flipReordenar(posPrevias.current);
    posPrevias.current = null;
  }, [compras]);
  const [reproDiferida, setReproDiferida] = useState(null);
  // Diferida STANDALONE cuyo plan completo se va a regenerar (via distinta de "Sellar y Renacer").
  const [planDiferida, setPlanDiferida] = useState(null);
  const [showPlanModal, setShowPlanModal] = useState(false);
  const [showAbonoModal, setShowAbonoModal] = useState(false);
  const [movType, setMovType] = useState('compra');
  const [showAbonoCapitalModal, setShowAbonoCapitalModal] = useState(false);
  const [abonoCapitalMonto, setAbonoCapitalMonto] = useState('');
  const [abonoCapitalFecha, setAbonoCapitalFecha] = useState(todayISO());
  const [abonoCapitalResult, setAbonoCapitalResult] = useState(null);
  const [abonoCapitalPreview, setAbonoCapitalPreview] = useState(null);
  const [abonoCapitalSaving, setAbonoCapitalSaving] = useState(false);
  const [showBolsilloModal, setShowBolsilloModal] = useState(false);
  const [showFechaPagoModal, setShowFechaPagoModal] = useState(false);
  const [fechaPagoInput, setFechaPagoInput] = useState('');
  const [bolsilloCompra, setBolsilloCompra] = useState(null);
  const [bolsilloMonto, setBolsilloMonto] = useState('');

  useEffect(() => { api('/dashboard?tarjeta_id=' + tarjeta.id + '&ciclo=' + ciclo).then(setData); }, [tarjeta.id, ciclo]);

  // Preview EN VIVO del abono a capital: cuando cambia el monto/fecha con el modal abierto,
  // consulta la distribución (sin aplicar) con un pequeño debounce. La respuesta puede traer
  // .detalle (distribución) o .error (ej. extracto pendiente); ambos se muestran en el form.
  useEffect(() => {
    if (!showAbonoCapitalModal || abonoCapitalResult) return;
    const monto = parseFloat(abonoCapitalMonto);
    if (!monto || monto <= 0) { setAbonoCapitalPreview(null); return; }
    let cancelado = false;
    const t = setTimeout(() => {
      const params = new URLSearchParams({ tarjeta_id: tarjeta.id, monto, fecha: abonoCapitalFecha });
      api('/abono-capital/preview?' + params).then(r => { if (!cancelado) setAbonoCapitalPreview(r); });
    }, 400);
    return () => { cancelado = true; clearTimeout(t); };
  }, [abonoCapitalMonto, abonoCapitalFecha, showAbonoCapitalModal, abonoCapitalResult, tarjeta.id]);

  const loadCompras = useCallback(() => {
    api('/compras?tarjeta_id=' + tarjeta.id + '&ciclo=' + ciclo).then(setCompras);
    api('/compras/resumen?tarjeta_id=' + tarjeta.id + '&ciclo=' + ciclo).then(setResumen);
    api('/personas').then(setPersonas);
  }, [ciclo, tarjeta.id]);
  const loadAvances = useCallback(() => { api('/avances?tarjeta_id=' + tarjeta.id + '&ciclo=' + ciclo).then(setAvances); }, [tarjeta.id, ciclo]);
  const loadDiferidas = useCallback(() => { api('/diferidas?tarjeta_id=' + tarjeta.id + '&ciclo=' + ciclo).then(setDiferidas); }, [tarjeta.id, ciclo]);

  useEffect(() => { loadCompras(); }, [loadCompras]);
  useEffect(() => { loadAvances(); }, [loadAvances]);
  useEffect(() => { loadDiferidas(); }, [loadDiferidas]);
  function refreshAll() { loadCompras(); loadAvances(); loadDiferidas(); api('/dashboard?tarjeta_id=' + tarjeta.id + '&ciclo=' + ciclo).then(setData); if (onDataChange) onDataChange(); }

  function saveCompra(compraData) {
    // Split purchase: array de nuevas compras
    if (Array.isArray(compraData)) {
      // Si la edición convierte una compra individual existente en dividida,
      // borramos la original primero para evitar duplicados (Delete & Recreate).
      const replaceId = compraData._replaceItemId;
      const prep = replaceId
        ? api('/compras/' + replaceId, { method: 'DELETE' })
        : Promise.resolve();
      prep.then(() => Promise.all(compraData.map(d => {
        d.tarjeta_id = tarjeta.id;
        return api('/compras', { method: 'POST', body: d });
      }))).then((resultados) => {
        const conError = (resultados || []).find(r => r && r.error);
        if (conError) { refreshAll(); toastErr(conError.error); return; }
        setShowCompraModal(false); setShowMovModal(false); refreshAll();
        toast(replaceId ? 'Compra convertida en dividida' : compraData.length + ' compras registradas');
      });
      return;
    }
    // Conversión grupo dividido → 100% personal
    if (compraData._mergePersonal) {
      handleMergePersonal(compraData._grupoId);
      return;
    }
    // Edición de grupo existente
    if (compraData._editGrupo) {
      handleEditGrupo(compraData).then((resultados) => {
        // Surface de errores: si algun PUT/POST fallo (ej. 403 de ciclo cerrado), avisa en vez de
        // mostrar un exito falso (antes el .then corria siempre aunque las ops fallaran).
        const conError = (resultados || []).find(r => r && r.error);
        if (conError) { refreshAll(); toastErr(conError.error); return; }
        setShowCompraModal(false); refreshAll(); toast('Compra dividida actualizada');
      });
      return;
    }
    compraData.tarjeta_id = tarjeta.id;
    // Libertad total de cuotas: la señal estructural viaja en _convertirCuotas / _reprogramarCuotas /
    // _revertirCuotas. Primero el PUT guarda los campos editados; luego el endpoint dedicado hace la
    // transición (transaccional), conservando la fila original — fecha y orden cronológico intactos
    // (prelación de pagos).
    const conv = compraData._convertirCuotas;
    const repro = compraData._reprogramarCuotas;
    const rever = compraData._revertirCuotas;
    delete compraData._convertirCuotas; delete compraData._reprogramarCuotas; delete compraData._revertirCuotas;
    const method = editCompra ? 'PUT' : 'POST';
    const url = editCompra ? '/compras/' + editCompra.id : '/compras';
    api(url, { method, body: compraData }).then(async (resp) => {
      // El backend bloquea (403) crear/editar en ciclos pagados; mostramos el motivo y no cerramos en falso.
      if (resp && resp.error) {
        // ROLLBACK: si el flujo de cuotas ya creó el plan y la compra no entró, esa diferida quedaría
        // HUÉRFANA — sin compra que la referencie, sumando a la deuda y al cupo, y sin forma de
        // borrarla desde la app. El guard de POST /diferidas cubre el caso del mes pagado; esto cubre
        // cualquier otro fallo del POST de la compra.
        if (!editCompra && compraData.diferida_id) {
          await api('/diferidas/' + compraData.diferida_id, { method: 'DELETE' }).catch(() => {});
        }
        toastErr(resp.error); return;
      }
      if (editCompra && (conv || repro || rever)) {
        const accion = conv
          ? api('/compras/' + editCompra.id + '/convertir-a-diferida', { method: 'POST', body: conv })
          : repro
            ? api('/diferidas/' + repro.diferida_id + '/reprogramar', { method: 'POST', body: { num_cuotas: repro.num_cuotas } })
            : api('/compras/' + editCompra.id + '/revertir-diferida', { method: 'POST', body: {} });
        accion.then((rc) => {
          if (rc && rc.error) { toastErr(rc.error); refreshAll(); return; }
          setShowCompraModal(false); setShowMovModal(false); refreshAll();
          toast(conv ? 'Compra convertida a ' + conv.num_cuotas + ' cuotas'
            : repro ? 'Cuotas reprogramadas a ' + repro.num_cuotas
            : 'Compra revertida a 1 cuota');
          // Pasar una compra a cuotas (o al revés) es lo que MÁS mueve el pago mínimo del mes, así que
          // es justo donde el aviso de cifra oficial más hace falta. `resp` es la respuesta del PUT.
          avisarCifraOficial(resp);
        });
        return;
      }
      setShowCompraModal(false); setShowMovModal(false); refreshAll(); toast('Compra guardada');
      avisarCifraOficial(resp);
    });
  }
  // v5.8.0 — Si el mes que se acaba de tocar tiene un pago mínimo tomado del PDF, esa cifra MANDA sobre
  // el cálculo, así que NO refleja el movimiento nuevo: el mínimo se queda quieto en Pagos y en el
  // dashboard y, al sellar el mes, la compra quedaría marcada como pagada sin haberse pagado. La app no
  // descarta esa cifra por su cuenta (conciliarla costó y es más confiable que el estimado): avisa y
  // deja decidir. "Usar el cálculo" borra el override vía el mismo endpoint que lo creó.
  async function avisarCifraOficial(resp) {
    const av = resp && resp.aviso_cifra_oficial;
    if (!av) return;
    const ok = await confirmDialog(
      'El pago minimo de ' + fmtCicloLabel(av.ciclo) + ' (' + fmtCOP(av.pago_minimo_oficial) + ') viene del extracto del banco, '
      + 'asi que no incluye este cambio.\n\nPuedes dejarlo como esta (si el extracto sigue siendo la cifra correcta) '
      + 'o volver al calculo de la app, que si tiene en cuenta lo que acabas de registrar.',
      { title: 'Este mes tiene el pago minimo del extracto', confirmText: 'Usar el calculo de la app',
        cancelText: 'Dejarlo como esta', danger: false }
    );
    if (!ok) return;
    const r = await api('/extractos/pago-oficial', { method: 'POST', body: { tarjeta_id: av.tarjeta_id, ciclo: av.ciclo, pago_minimo: null } });
    if (r && r.error) { toastErr(r.error); return; }
    refreshAll();
    toast('El pago minimo de ' + fmtCicloLabel(av.ciclo) + ' vuelve a calcularse con tus movimientos');
  }
  async function handleMergePersonal(grupoId) {
    // Primera confirmación (no destructiva).
    if (!await confirmDialog(
      'Esta compra dividida se fusionará en una sola compra 100% personal. El dinero que tengas apartado (bolsillo) de cada parte se conserva sumado. ¿Continuar?',
      { confirmText: 'Convertir a personal' }
    )) return;
    // Intento sin force.
    let resp = await api('/compras/grupo/' + grupoId + '/merge-personal', { method: 'POST', body: { force: false } });
    // Bloqueo crítico: hay reembolsos reales de terceros → segunda confirmación destructiva.
    if (resp && resp.needsForce) {
      const lista = (resp.detalle || []).map(d => '• ' + d.persona_nombre + ': ' + fmtCOP(d.monto)).join('\n');
      const ok = await confirmDialog(
        'ATENCIÓN: hay dinero que tus terceros ya te reembolsaron registrado en esta compra:\n\n' + lista +
        '\n\nTotal: ' + fmtCOP(resp.total) +
        '\n\nSi continúas, estos abonos se ELIMINARÁN y la compra quedará 100% personal. Esta acción no se puede deshacer.',
        { title: 'Confirmar conversión destructiva', confirmText: 'Eliminar abonos y convertir' }
      );
      if (!ok) return;
      resp = await api('/compras/grupo/' + grupoId + '/merge-personal', { method: 'POST', body: { force: true } });
    }
    if (resp && resp.ok) {
      setShowCompraModal(false); refreshAll(); toast('Compra convertida a 100% personal');
    } else {
      toastErr((resp && resp.error) || 'No se pudo convertir la compra');
    }
  }
  async function handleEditGrupo({ _grupoId, _partesOriginales, fecha, descripcion, valor_usd, tasa_usd, es_internacional, splits, remainder, ciclo: cicloForm, ciclo_manual: cicloManualForm }) {
    // Construir lista completa de nuevas partes: personas asignadas + parte personal
    const nuevasPartes = [
      ...splits.map(sp => ({ persona_id: parseInt(sp.persona_id), valor_cop: Math.round(parseFloat(sp.monto) || 0) })),
      ...(remainder > 0 ? [{ persona_id: null, valor_cop: remainder }] : [])
    ].filter(np => np.valor_cop > 0);
    // Índice de originales por persona_id ('personal' para la parte sin persona)
    const originalesByPersona = {};
    _partesOriginales.forEach(p => { originalesByPersona[p.persona_id != null ? p.persona_id : 'personal'] = p; });
    const intlFlag = es_internacional ? 1 : 0;
    // Ciclo del grupo: todas las partes comparten ciclo/ciclo_manual (se crearon juntas). Se CONSERVA
    // al editar para no perder un ciclo fijado a mano (ej. spillover / canje retrasado): sin esto el
    // backend recalcularia el ciclo desde la nueva fecha y, si ese ciclo natural ya cerro, cada PUT
    // fallaria con 403 y la edicion no se aplicaria. Para partes NUEVAS se usa el ciclo del grupo.
    // Si el form trae un ciclo fijado a mano, MANDA sobre el original y se aplica a todas las
    // partes (una compra dividida vive entera en un solo ciclo). Sin él, se conserva el que ya
    // tenían, que es lo que evita el 403 al reeditar una compra de un mes ya cerrado.
    const grupoCiclo = cicloForm || (_partesOriginales[0] ? _partesOriginales[0].ciclo : undefined);
    const grupoCicloManual = cicloForm ? (cicloManualForm ? 1 : 0)
      : (_partesOriginales[0] ? (_partesOriginales[0].ciclo_manual || 0) : 0);
    const ops = [];
    const idsVisitados = new Set();
    for (const np of nuevasPartes) {
      const key = np.persona_id != null ? np.persona_id : 'personal';
      const orig = originalesByPersona[key];
      if (orig) {
        idsVisitados.add(orig.id);
        ops.push(api('/compras/' + orig.id, { method: 'PUT', body: {
          tarjeta_id: tarjeta.id, fecha, descripcion,
          valor_cop: np.valor_cop,
          valor_usd: valor_usd || null, tasa_usd: tasa_usd || null,
          persona_id: orig.persona_id, estado: orig.estado, notas: orig.notas,
          es_internacional: intlFlag,
          ciclo: grupoCiclo, ciclo_manual: grupoCicloManual
        }}));
      } else {
        // Nueva persona agregada al grupo
        ops.push(api('/compras', { method: 'POST', body: {
          tarjeta_id: tarjeta.id, fecha, descripcion,
          valor_cop: np.valor_cop,
          valor_usd: valor_usd || null, tasa_usd: tasa_usd || null,
          persona_id: np.persona_id, estado: 'pendiente', grupo_id: _grupoId,
          es_internacional: intlFlag,
          ciclo: grupoCiclo, ciclo_manual: grupoCicloManual
        }}));
      }
    }
    // Eliminar partes que ya no están
    for (const p of _partesOriginales) {
      if (!idsVisitados.has(p.id)) ops.push(api('/compras/' + p.id, { method: 'DELETE' }));
    }
    return Promise.all(ops);
  }
  function editGrupo(grupoItem) {
    // Todas las partes de un grupo comparten el mismo flag es_internacional
    // (se asigna a partir del checkbox del form). Tomamos el de la primera parte.
    const esInternacionalGrupo = grupoItem.partes.length > 0 && !!grupoItem.partes[0].es_internacional;
    setEditCompra({
      _isGrupo: true,
      _grupoId: grupoItem.grupo_id,
      _partes: grupoItem.partes,
      fecha: grupoItem.fecha,
      descripcion: grupoItem.descripcion,
      valor_usd: grupoItem.valor_usd || null,
      tasa_usd: grupoItem.tasa_usd || null,
      valor_cop: grupoItem.partes.reduce((s, p) => s + p.valor_cop, 0),
      esDiferida: grupoItem.esDiferida,
      es_internacional: esInternacionalGrupo ? 1 : 0,
      // Las partes de un grupo comparten ciclo (se crearon juntas). Se expone el de la primera
      // para que el campo "Ciclo (avanzado)" pueda mostrarlo y editarlo, igual que en una compra
      // simple: una compra dividida hecha el dia del corte tambien se va al ciclo siguiente.
      ciclo: grupoItem.partes.length ? grupoItem.partes[0].ciclo : undefined,
      ciclo_manual: grupoItem.partes.length ? (grupoItem.partes[0].ciclo_manual || 0) : 0,
    });
    setShowCompraModal(true);
  }
  async function removeGrupo(partes) {
    if (!await confirmDialog('Eliminar toda la compra dividida (' + partes.length + ' parte' + (partes.length > 1 ? 's' : '') + ')?', { confirmText: 'Eliminar' })) return;
    await Promise.all(partes.map(p => api('/compras/' + p.id, { method: 'DELETE' })));
    refreshAll();
    toast('Compra eliminada');
  }
  function openBolsilloModal(compra) {
    // El bolsillo de una compra de tercero es su reembolso (la deuda se calcula como valor - bolsillo).
    // Su edición es EXCLUSIVA de la pestaña Terceros para no corromper esa contabilidad desde las
    // vistas generales (Resumen / Tarjeta).
    if (compra && compra.persona_id) {
      infoDialog('El monto apartado en una compra de un tercero representa lo que te ha reembolsado. Gestiónalo desde la pestaña Terceros.', 'Gestionar abono desde la pestaña Terceros');
      return;
    }
    const mb = compra.monto_bolsillo || 0;
    const target = compra._bolsilloTarget || compra.valor_cop;
    const isPartial = mb > 0 && mb < target;
    setBolsilloCompra(compra);
    setBolsilloMonto(isPartial ? '' : String(mb || ''));
    setShowBolsilloModal(true);
  }
  function openBolsilloAvanceModal(av, opts) {
    opts = opts || {};
    // Per-cuota: el bolsillo se identifica por cuota_num del ciclo navegado.
    // El target (meta) es la cuota proyectada de ESE mes específico.
    const cuotaNum = opts.cuota_num != null ? opts.cuota_num : 1;
    const target = opts.target != null ? opts.target : (av.cuotaCorte || 0);
    const mb = (av.bolsillo_por_cuota && av.bolsillo_por_cuota[cuotaNum]) || 0;
    const isPartial = mb > 0 && mb < target;
    setBolsilloCompra({
      _isAvance: true,
      id: av.id,
      descripcion: av.etiqueta,
      estado: 'avance',
      valor_cop: target,
      cuotaCorte: target,
      monto_bolsillo: mb,
      cuota_num: cuotaNum,
      cuotas_total: av.plazo
    });
    setBolsilloMonto(isPartial ? '' : String(mb || ''));
    setShowBolsilloModal(true);
  }
  function openBolsilloDiferidaModal(d) {
    // Defensa: una diferida de tercero gestiona su bolsillo (reembolso) en la pestaña Terceros.
    if (d && (d.es_de_tercero || d.persona_id)) {
      infoDialog('El monto apartado en una compra de un tercero representa lo que te ha reembolsado. Gestiónalo desde la pestaña Terceros.', 'Gestionar abono desde la pestaña Terceros');
      return;
    }
    const mb = d.monto_bolsillo || 0;
    const target = d.cuotaCorte || 0;
    const isPartial = mb > 0 && mb < target;
    setBolsilloCompra({
      _isDiferida: true,
      id: d.id,
      descripcion: d.etiqueta + (d.es_de_tercero ? ' (' + d.persona_nombre + ')' : ''),
      estado: 'diferida',
      valor_cop: target,
      cuotaCorte: target,
      monto_bolsillo: mb
    });
    setBolsilloMonto(isPartial ? '' : String(mb || ''));
    setShowBolsilloModal(true);
  }
  function saveBolsillo() {
    if (!bolsilloCompra) return;
    const _mb = bolsilloCompra.monto_bolsillo || 0;
    const _isAv = !!bolsilloCompra._isAvance;
    const _isDif = bolsilloCompra.estado === 'diferida' || !!bolsilloCompra._isDiferida;
    const _target = bolsilloCompra._bolsilloTarget || ((_isAv || _isDif) ? (bolsilloCompra.cuotaCorte || bolsilloCompra.valor_cop) : bolsilloCompra.valor_cop);
    const _isAgregar = (_isAv || _isDif) && _mb > 0 && _mb < _target;
    let monto;
    if (_isAgregar) {
      const adicional = parseFloat(bolsilloMonto) || 0;
      monto = _mb + adicional;
    } else {
      monto = parseFloat(bolsilloMonto) || 0;
    }
    if (monto < 0) return;
    const url = bolsilloCompra._isAvance
      ? '/avances/' + bolsilloCompra.id + '/bolsillo'
      : bolsilloCompra._isDiferida
        ? '/diferidas/' + bolsilloCompra.id + '/bolsillo'
        : '/compras/' + bolsilloCompra.id + '/bolsillo';
    // Detectar moneda: USD si la compra solo tiene valor_usd > 0.
    const esUsdSave = !!(bolsilloCompra.valor_usd && bolsilloCompra.valor_usd > 0 && !bolsilloCompra.valor_cop);
    const body = { monto_bolsillo: monto, moneda: esUsdSave ? 'USD' : 'COP' };
    // Per-cuota: enviar cuota_num para diferidas y avances (compras 1-cuota usan global)
    if (bolsilloCompra.cuota_num && (_isDif || _isAv)) body.cuota_num = bolsilloCompra.cuota_num;
    api(url, { method: 'PUT', body })
      .then((resp) => {
        setShowBolsilloModal(false); refreshAll();
        if (resp && resp.capped) {
          const topeFmt = resp.moneda === 'USD'
            ? 'USD $' + new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(resp.tope)
            : fmtCOP(resp.tope);
          toast('Se apartó el máximo de la compra: ' + topeFmt);
        } else {
          toast('Bolsillo actualizado');
        }
      });
  }
  async function removeCompra(id) {
    if (!await confirmDialog('Eliminar esta compra?', { confirmText: 'Eliminar' })) return;
    api('/compras/' + id, { method: 'DELETE' }).then(() => { refreshAll(); toast('Compra eliminada'); });
  }
  // Reverso manual: el banco devolvió la compra. La neutraliza como deuda (no se borra su valor
  // histórico) y, si un tercero ya la había reembolsado, crea un Saldo a Favor a su nombre
  // (visible en la pestaña Terceros). Confirmación con modal propio, nunca window.confirm.
  async function reverseCompra(c) {
    const reembolso = c.persona_id ? (c.monto_bolsillo || 0) : 0;
    let msg = 'Reversar «' + c.descripcion + '»?\n\nDejará de contar como deuda y saldrá del cupo (su valor histórico se conserva).';
    if (reembolso > 0) msg += '\n\n' + (c.persona_nombre || 'El tercero') + ' ya te reembolsó ' + fmtCOP(reembolso) + ' → se creará un saldo a favor a su nombre.';
    if (!await confirmDialog(msg, { confirmText: 'Reversar compra' })) return;
    api('/compras/' + c.id + '/reversar', { method: 'POST' }).then((r) => {
      if (r && r.error) { toastErr(r.error); return; }
      refreshAll();
      toast(r.credito_creado ? ('Compra reversada · saldo a favor de ' + fmtCOP(r.monto_favor) + ' creado') : 'Compra reversada');
    });
  }
  // Orden manual dentro del día (v6.0.0). El backend materializa el orden del día y hace el swap;
  // aquí solo se refresca. El 409 del borde trae su propio mensaje y se muestra tal cual.
  function moverCompra(c, direccion) {
    // `body` va como OBJETO: api() ya hace el JSON.stringify. Pasarlo stringificado lo envuelve dos
    // veces y el backend recibe una cadena, con lo que req.body.direccion queda undefined -> 400.
    api('/compras/' + c.id + '/mover', { method: 'POST', body: { direccion } }).then((r) => {
      if (r && r.error) { toastErr(r.error); return; }
      // Se ESPERA a tener las compras ya reordenadas antes de marcar la animación. Marcarla antes
      // (que es lo que se hacía) la arrancaba en la posición VIEJA: para cuando llegaban los datos
      // y la fila saltaba de sitio, la animación ya se había consumido y solo se veía el salto seco.
      // Ambos setState caen en el mismo tick, así que React pinta UNA vez: la fila ya en su sitio
      // nuevo y con la clase puesta.
      return api('/compras?tarjeta_id=' + tarjeta.id + '&ciclo=' + ciclo).then((nuevas) => {
        // FIRST: se fotografían las posiciones ANTES de que React repinte con el orden nuevo. El
        // useLayoutEffect de arriba las recoge y hace el resto del FLIP.
        posPrevias.current = medirFilas();
        setCompras(nuevas);
        setFilasMovidas({ dir: direccion, movidas: r.movida_ids || [c.id], cedieron: r.desplazada_ids || [], tick: Date.now() });
        if (movTimer.current) clearTimeout(movTimer.current);
        // Por encima de los 780ms que dura la animación: si el estado se limpiara antes, la clase
        // desaparecería a media transición y la fila daría un tirón justo al final.
        movTimer.current = setTimeout(() => setFilasMovidas(null), 1000);
        refreshAll();   // el resto de la vista (dashboard, diferidas) puede ir después
      });
    }).catch((err) => {
      // Sin este catch el clic era MUDO: ante un 400 la respuesta no es JSON, res.json() lanza y la
      // promesa se rechaza en silencio — ni toast ni rastro. Un boton que no hace nada y tampoco
      // dice por que es peor que uno que falla en voz alta.
      // api() ya avisa de los fallos de escritura y marca el error; este mensaje es MAS concreto,
      // asi que se muestra solo cuando el aviso generico no salio (o el error viene de otro sitio).
      if (!err || !err.__avisado) toastErr('No se pudo mover la compra: ' + (err && err.message ? err.message : 'error de conexion'));
    });
  }
  function saveAvance(data) {
    data.tarjeta_id = tarjeta.id; data.dia_corte = tarjeta.dia_corte;
    const method = editAvance ? 'PUT' : 'POST';
    const url = editAvance ? '/avances/' + editAvance.id : '/avances';
    api(url, { method, body: data }).then(() => { setShowAvanceModal(false); setShowMovModal(false); refreshAll(); if (selectedAvance) loadAvanceDetail(selectedAvance); toast('Avance guardado'); });
  }
  async function removeAvance(id) {
    if (!await confirmDialog('Eliminar este avance y todos sus abonos?', { confirmText: 'Eliminar' })) return;
    api('/avances/' + id, { method: 'DELETE' }).then(() => { refreshAll(); setSelectedAvance(null); setAvanceDetail(null); toast('Avance eliminado'); });
  }
  function saveDiferida(data) {
    data.tarjeta_id = tarjeta.id;
    const method = editDiferida ? 'PUT' : 'POST';
    const url = editDiferida ? '/diferidas/' + editDiferida.id : '/diferidas';
    api(url, { method, body: data }).then(() => { setShowDiferidaModal(false); setShowMovModal(false); refreshAll(); if (selectedDiferida) loadDiferidaDetail(selectedDiferida); toast('Diferida guardada'); });
  }
  async function removeDiferida(id) {
    if (!await confirmDialog('Eliminar esta diferida?', { confirmText: 'Eliminar' })) return;
    api('/diferidas/' + id, { method: 'DELETE' }).then(() => { refreshAll(); setSelectedDiferida(null); setDiferidaDetail(null); toast('Diferida eliminada'); });
  }
  // Elegibilidad de "Reprogramar saldo". UN SOLO punto para la FILA y para el DETALLE: si cada
  // superficie repitiera la cadena de ternarios, bastaria anadir un guard en una para que la otra
  // ofreciera un boton que el backend rechaza. No se bloquea por tercero_con_reembolso: el motor
  // preserva su libro (cada sellada conserva su reembolso + interes_sellado).
  function motivoNoReprogramable(d) {
    if (!d) return 'Sin datos de la diferida';
    // La regla del BANCO va primero y la resuelve el backend (bloqueo_banco). RappiCard no acepta
    // tocar cuotas de un extracto cerrado, asi que ahi no hay via alguna: ni el plan completo ni el
    // saldo. Mostrar el motivo real evita que parezca una limitacion de la app.
    if (d.bloqueo_banco) return d.bloqueo_banco;
    // Sin compra vinculada (STANDALONE) ya NO es un bloqueo: se reprograma por la via del plan
    // completo, que es la correcta cuando el banco aun no ha facturado nada. Lo decide planEsUniforme.
    if (!d.compra_id) return null;
    if (d.grupo_id) return 'Compra dividida: reprograma cada parte por separado';
    if (d.es_usd_pura) return 'Compra solo en dolares (no soportado)';
    if (d.tiene_abono_parcial) return 'Tiene un abono parcial registrado';
    return null;
  }
  // Una diferida SIN compra vinculada no puede pasar por "Sellar y Renacer" (ese endpoint opera
  // sobre la compra). Su camino es POST /diferidas/:id/reprogramar, que regenera el plan desde el
  // origen: correcto justo cuando no hay ninguna cuota facturada, que es el unico caso en que el
  // banco lo permite. Por eso las dos vias no compiten, se reparten el terreno.
  function planEsUniforme(d) { return !!d && !d.compra_id; }
  // El modal necesita `amortizacion` para calcular k y el saldo, y el LISTADO no la trae (seria una
  // tabla completa por cada diferida). Por eso la fila pide el detalle al abrir, en vez de exponer
  // la amortizacion en el listado: el modal siempre trabaja con datos frescos del backend.
  function abrirReprogramar(id) {
    api('/diferidas/' + id).then(dd => {
      if (!dd || dd.error) { toastErr((dd && dd.error) || 'No se pudo cargar el plan de cuotas.'); return; }
      const motivo = motivoNoReprogramable(dd);
      if (motivo) { toastErr(motivo); return; }
      // Dos destinos segun haya compra o no: plan completo (standalone) vs sellar y renacer.
      if (planEsUniforme(dd)) { setPlanDiferida(dd); setShowPlanModal(true); return; }
      setReproDiferida(dd); setShowReprogramarModal(true);
    }).catch(() => toastErr('No se pudo cargar el plan de cuotas.'));
  }
  // Plan COMPLETO de una diferida sin compra (regenera desde el origen). No sella nada porque no hay
  // nada facturado: el backend lo rechaza en cuanto alguna cuota cayo en un ciclo pagado, y el
  // candado del banco lo corta antes si el extracto ya cerro.
  function savePlanUniforme(data) {
    const did = planDiferida && planDiferida.id;
    if (!did) { toastErr('No se pudo identificar el plan de cuotas.'); return; }
    api('/diferidas/' + did + '/reprogramar', { method: 'POST', body: data }).then(r => {
      if (r && r.error) { toastErr(r.error); return; }
      setShowPlanModal(false); setPlanDiferida(null);
      setSelectedDiferida(null); setDiferidaDetail(null);
      refreshAll();
      toast('Plan de cuotas actualizado a ' + r.num_cuotas + ' cuota(s).');
    }).catch(() => toastErr('No se pudo actualizar el plan de cuotas.'));
  }
  // Reprogramacion RETROACTIVA de saldo (Sellar y Renacer): opera sobre la COMPRA vinculada.
  function saveReprograma(data) {
    const cid = reproDiferida && reproDiferida.compra_id;
    if (!cid) { toastErr('Esta diferida no tiene una compra vinculada para reprogramar.'); return; }
    api('/compras/' + cid + '/reprogramar-saldo', { method: 'POST', body: data }).then(r => {
      if (r && r.error) { toastErr(r.error); return; }
      setShowReprogramarModal(false); setReproDiferida(null);
      setSelectedDiferida(null); setDiferidaDetail(null);
      refreshAll();
      let msg = 'Saldo reprogramado: ' + r.k + ' cuota(s) sellada(s), saldo a ' + r.remanente + ' cuota(s).';
      if (r.bolsillo_liberado > 0) msg += ' Se liberaron ' + fmtCOP(r.bolsillo_liberado) + ' del bolsillo.';
      // Prepago de cuotas futuras de un TERCERO: no se inyecta al bolsillo del saldo renacido (queda en
      // $0) — nace como crédito a su favor para que el usuario lo aplique donde decida. Hay que AVISARLO
      // o el crédito se crea en silencio (las dos ramas son excluyentes: en un tercero bolsillo_liberado
      // es siempre 0, así que sin esto nunca se informaba).
      if (r.saldo_favor_creado > 0) msg += ' Su prepago de cuotas futuras (' + fmtCOP(r.saldo_favor_creado) + ') pasó a saldo a favor del responsable: aplícalo desde "Dinero a favor" en Terceros.';
      toast(msg);
    });
  }
  function loadAvanceDetail(id) {
    if (selectedAvance === id) { setSelectedAvance(null); setAvanceDetail(null); return; }
    setSelectedAvance(id); api('/avances/' + id).then(setAvanceDetail);
  }
  function loadDiferidaDetail(id) {
    if (selectedDiferida === id) { setSelectedDiferida(null); setDiferidaDetail(null); return; }
    setSelectedDiferida(id); api('/diferidas/' + id).then(setDiferidaDetail);
  }
  function saveAbono(data) {
    api('/avances/' + selectedAvance + '/abonos', { method: 'POST', body: data }).then(() => { setShowAbonoModal(false); loadAvanceDetail(selectedAvance); refreshAll(); toast('Abono registrado'); });
  }
  async function removeAbono(id) {
    if (!await confirmDialog('Eliminar este abono?', { confirmText: 'Eliminar' })) return;
    api('/abonos/' + id, { method: 'DELETE' }).then(() => { loadAvanceDetail(selectedAvance); refreshAll(); toast('Abono eliminado'); });
  }

  async function submitAbonoCapital() {
    setAbonoCapitalSaving(true);
    const result = await api('/abono-capital', { method: 'POST', body: { tarjeta_id: tarjeta.id, monto: parseFloat(abonoCapitalMonto), fecha: abonoCapitalFecha } });
    setAbonoCapitalSaving(false);
    if (result.error) { infoDialog(result.error, 'No se puede abonar'); return; }
    setAbonoCapitalPreview(null);
    setAbonoCapitalResult(result);
    refreshAll();
    toast(result.bolsilloLiberado > 0 ? ('Abono a capital aplicado. Se liberaron ' + fmtCOP(result.bolsilloLiberado) + ' del bolsillo') : 'Abono a capital aplicado');
  }
  function closeAbonoCapital() { setShowAbonoCapitalModal(false); setAbonoCapitalResult(null); setAbonoCapitalPreview(null); setAbonoCapitalMonto(''); }

  if (!data) return e('div', { className: 'loading' }, 'Cargando...');

  // Para tarjetas duales, deudaTotalEnCop incluye la deuda USD convertida a COP via TRM.
  // Para no-duales es igual a deudaTotal. Así el % de cupo refleja realmente cuánto ocupa
  // la deuda total (en moneda local equivalente) sobre el cupo de la tarjeta.
  const deudaParaCupo = data.deudaTotalEnCop != null ? data.deudaTotalEnCop : data.deudaTotal;
  const cupoUsado = tarjeta.cupo_total > 0 ? (deudaParaCupo / tarjeta.cupo_total * 100).toFixed(1) : null;
  // Cupo disponible = cupo total - deuda (en COP equivalente). Puede ser negativo si la
  // deuda supera el cupo (sobrecupo), caso que se muestra aparte en rojo.
  const cupoDisponible = (tarjeta.cupo_total || 0) - deudaParaCupo;
  const hoy = todayISO();
  // Ciclo VISUALIZADO ya pagado. Mismo criterio que cicloPagadoC/cicloPagadoDif mas abajo; se declara
  // aqui porque purchaseRows lo necesita para decidir si una cuota sellada es historial o deuda viva.
  const cicloEstaPagado = !!(data.extractoCiclo && data.extractoCiclo.estado === 'pagado');

  // Group split compras by grupo_id, singles stay individual
  const purchaseRows = (() => {
    const grupos = {};
    const singles = [];
    compras.forEach(c => {
      // (a) La compra RENACIDA (diferida HIJA) nunca va aqui: no es una compra real, es el saldo vivo
      // del plan, y se gestiona desde Diferidas.
      if (c.sin_gracia_cuota1) return;
      // (b) Las cuotas SELLADAS solo se ocultan si su ciclo YA ESTA PAGADO. Ahi son historial cerrado y
      // la fila read-only de Diferidas basta. Si el ciclo sigue abierto o impago son DEUDA VIVA: hay que
      // poder apartarles bolsillo y verlas al cuadrar el mes, asi que se renderizan como cualquier otra
      // compra. Ocultarlas siempre (v5.5.3) se decidio cuando toda sellada venia de un mes pagado; desde
      // que v5.8.0 permite reprogramar un ciclo cerrado impago, esa premisa dejo de ser cierta y la
      // cuota desaparecia de las dos pestañas a la vez.
      if (c.notas && c.notas.indexOf('sellada por reprogramacion') !== -1 && cicloEstaPagado) return;
      if (c.grupo_id) {
        if (!grupos[c.grupo_id]) grupos[c.grupo_id] = [];
        grupos[c.grupo_id].push(c);
      } else {
        singles.push({ tipo: 'single', data: c });
      }
    });
    const result = [...singles];
    Object.entries(grupos).forEach(([gid, items]) => {
      const esDiferida = items[0].estado === 'diferida' && items[0].cuotaCorte !== undefined;
      const total = esDiferida
        ? items.reduce((s, c) => s + (c.cuotaCorte || 0), 0)
        : items.reduce((s, c) => s + c.valor_cop, 0);
      result.push({
        tipo: 'grupo',
        grupo_id: gid,
        fecha: items[0].fecha,
        descripcion: items[0].descripcion,
        nota_personal: items[0].nota_personal || null,
        estado: items[0].estado,
        valor_usd: items[0].valor_usd,
        tasa_usd: items[0].tasa_usd,
        esDiferida,
        cuota_num: esDiferida ? items[0].cuota_num : null,
        cuotas_total: esDiferida ? items[0].cuotas_total : null,
        total,
        // id de orden del grupo = el menor id de sus partes (nacimiento de la compra dividida) —
        // desempate determinista FINAL ante misma fecha + misma última edición.
        _ordenId: Math.min(...items.map(c => c.id)),
        // Orden manual del grupo: todas sus partes comparten valor, así la dividida se mueve entera.
        _ordenDia: items.reduce((m, c) => (c.orden_dia != null && (m == null || c.orden_dia < m) ? c.orden_dia : m), null),
        // Timestamp de orden del grupo = la updated_at MÁS RECIENTE de sus partes: el grupo salta si
        // editas cualquier parte (mismo criterio que un single). Desempate primario ante misma fecha.
        _ordenTs: items.reduce((m, c) => { const t = c.updated_at || c.created_at || ''; return t > m ? t : m; }, ''),
        partes: items.sort((a, b) => (a.persona_id ? 1 : 0) - (b.persona_id ? 1 : 0))
      });
    });
    // Orden de la tabla (mismo criterio que el ORDER BY del backend, para reordenar EN VIVO al guardar):
    // 1) fecha DESC; 2) última EDICIÓN MANUAL (updated_at) DESC → la compra recién editada sube al primer
    // lugar de su día; 3) id DESC como desempate determinista final. Para grupos se usa la updated_at más
    // reciente de sus partes (_ordenTs) y el menor id (_ordenId). Sin desempate, el sort estable dejaba
    // todos los singles antes que todos los grupos (una dividida nueva caía bajo un single más viejo).
    result.sort((a, b) => {
      const fa = a.tipo === 'grupo' ? a.fecha : a.data.fecha;
      const fb = b.tipo === 'grupo' ? b.fecha : b.data.fecha;
      const byFecha = fb.localeCompare(fa);
      if (byFecha !== 0) return byFecha;
      // ORDEN MANUAL (v6.0.0): si el usuario fijó el orden de ese día con las flechas, MANDA sobre
      // el salto automático por última edición. Espejo exacto del ORDER BY del backend.
      const oa = (a.tipo === 'grupo' ? a._ordenDia : a.data.orden_dia);
      const ob = (b.tipo === 'grupo' ? b._ordenDia : b.data.orden_dia);
      const byOrden = (oa == null ? 999999 : oa) - (ob == null ? 999999 : ob);
      if (byOrden !== 0) return byOrden;
      const ta = a.tipo === 'grupo' ? a._ordenTs : (a.data.updated_at || a.data.created_at || '');
      const tb = b.tipo === 'grupo' ? b._ordenTs : (b.data.updated_at || b.data.created_at || '');
      const byTs = String(tb).localeCompare(String(ta));
      if (byTs !== 0) return byTs;
      const ia = a.tipo === 'grupo' ? a._ordenId : a.data.id;
      const ib = b.tipo === 'grupo' ? b._ordenId : b.data.id;
      return ib - ia;
    });
    // Bordes del día: con ellos las flechas se deshabilitan ANTES del clic y el aviso se lee en el
    // tooltip, en vez de descubrirlo al chocar contra el 409.
    result.forEach((r, i) => {
      const f = r.tipo === 'grupo' ? r.fecha : r.data.fecha;
      const fPrev = i > 0 ? (result[i - 1].tipo === 'grupo' ? result[i - 1].fecha : result[i - 1].data.fecha) : null;
      const fNext = i < result.length - 1 ? (result[i + 1].tipo === 'grupo' ? result[i + 1].fecha : result[i + 1].data.fecha) : null;
      r._primeroDia = fPrev !== f;
      r._ultimoDia = fNext !== f;
    });
    return result;
  })();

  return e('div', null,
    // ──── Fila 1: Info general de la tarjeta ────
    e('div', { className: 'cards-row' },
      (function() {
        // Helper para renderizar mini-cols a partir de una lista [{label, value}].
        // Permite mostrar 3 cols (COP: Avances/Diferidas/Compras) y 2 cols (USD: Diferidas/Compras)
        // sin código duplicado. flex: 1 distribuye proporcionalmente cuando son pocos items.
        const miniCols = (cols) => e('div', { style: { display: 'flex', gap: 14, marginTop: 8, flexWrap: 'wrap' } },
          cols.map(c => e('div', { key: c.label, style: { flex: '1 1 auto', minWidth: 90 } },
            e('div', { style: { fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 } }, c.label),
            e('div', { style: { fontSize: 12, color: 'var(--text-primary)', fontWeight: 600, fontFamily: 'monospace' } }, c.value)
          ))
        );
        return bimonCard({
          variant: 'danger',
          title: 'Deuda Total',
          copValue: fmtCOP(data.deudaTotal),
          usdValue: fmtUsd(data.deudaUsd || 0),
          hasUsd: !!(data.dualExtracto && data.deudaUsd > 0),
          copExtra: miniCols([
            { label: 'Avances',   value: fmtCOP(data.deudaAvances) },
            { label: 'Diferidas', value: fmtCOP(data.deudaDiferidas) },
            { label: 'Compras',   value: fmtCOP(data.comprasTotalPendientes || data.comprasCiclo) }
          ]),
          // USD: sin "Avances" — en dólares no se hacen avances en MC/Amex Bancolombia.
          // Orden: Compras primero (movimiento principal) → Diferidas después.
          usdExtra: miniCols([
            { label: 'Compras',   value: fmtUsd(data.comprasTotalPendientesUsd || 0) },
            { label: 'Diferidas', value: fmtUsd(data.deudaDiferidasUsd || 0) }
          ])
        });
      })(),
      cupoUsado && e('div', { className: 'card card-accent' },
        e('div', { className: 'card-label' }, 'Cupo Usado'),
        e('div', { className: 'card-value' }, cupoUsado + '%'),
        e('div', { className: 'card-sub' }, fmtCOP(deudaParaCupo) + ' de ' + fmtCOP(tarjeta.cupo_total)),
        // Si es dual y hay deuda USD, mostramos la TRM usada para que sea transparente.
        // Tipografía: hereda la sans-serif del sistema (Segoe UI en Windows) para
        // armonizar con el subtexto gris inferior. Color cyan para identificar USD.
        data.dualExtracto && data.deudaUsd > 0 && e('div', { style: { fontSize: 11, color: '#4FC3F7', marginTop: 4, lineHeight: 1.4 } },
          'Incluye USD $' + new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(data.deudaUsd) +
          ' × $' + new Intl.NumberFormat('es-CO').format(data.trmUsdCop) + ' (TRM ref.)'
        ),
        // Disponible destacado, con separación visual ("salto de línea", marginTop mayor)
        // respecto a lo de arriba — sea el subtexto gris (tarjetas COP) o la nota cyan USD
        // (tarjetas duales). Es el dato que el usuario quiere de un vistazo: cuánto puede
        // gastar aún. Verde si hay cupo, rojo si la deuda superó el cupo (sobrecupo).
        e('div', { className: 'card-sub', style: { color: cupoDisponible >= 0 ? 'var(--success)' : 'var(--danger)', fontWeight: 600, marginTop: 10 } },
          cupoDisponible >= 0 ? 'Disponible: ' + fmtCOP(cupoDisponible) : 'Sobrecupo: ' + fmtCOP(Math.abs(cupoDisponible))),
        e('div', { style: { fontSize: 10, color: 'var(--text-muted)', marginTop: 6, fontStyle: 'italic', lineHeight: 1.3 } }, 'El disponible puede diferir del banco por intereses devengados sin facturar y cuota de manejo del mes.')
      ),
      e('div', { className: 'card card-warning' },
        e('div', { className: 'card-label' }, 'Proximo Corte'),
        e('div', { className: 'card-value' }, fmtDate(data.proximoCorte.fecha)),
        e('div', { className: 'card-sub' }, 'Faltan ' + data.proximoCorte.diasFaltan + ' dias')
      ),
      data.fechaPago && e('div', { className: 'card', style: { borderColor: data.fechaPago.diasFaltan <= 5 && data.fechaPago.diasFaltan > 0 ? 'var(--danger)' : 'var(--border)', position: 'relative' } },
        e('button', {
          type: 'button',
          onClick: () => { setFechaPagoInput(data.fechaPago.fecha || ''); setShowFechaPagoModal(true); },
          title: 'Editar fecha de pago para este ciclo',
          style: { position: 'absolute', top: 8, right: 8, background: 'transparent', border: 'none', cursor: 'pointer', padding: 4, color: 'var(--text-muted)', display: 'flex', alignItems: 'center' }
        },
          e(Ico, { name: 'edit', size: 14, color: 'currentColor' })
        ),
        e('div', { className: 'card-label' }, 'Fecha Limite de Pago',
          data.fechaPago.esManual && e('span', { style: { marginLeft: 6, fontSize: 9, color: 'var(--accent)', fontWeight: 700, letterSpacing: 0.3 } }, '(MANUAL)')
        ),
        e('div', { className: 'card-value', style: { color: data.fechaPago.diasFaltan <= 5 && data.fechaPago.diasFaltan > 0 ? 'var(--danger)' : 'var(--text-primary)' } }, fmtDate(data.fechaPago.fecha)),
        e('div', { className: 'card-sub' }, data.fechaPago.diasFaltan < 0 ? Math.abs(data.fechaPago.diasFaltan) + ' dias atras' : data.fechaPago.diasFaltan === 0 ? 'Hoy' : 'Faltan ' + data.fechaPago.diasFaltan + ' dias')
      ),
      e('div', { className: 'card' },
        e('div', { className: 'card-label' }, 'Tasas MV'),
        e('div', { style: { display: 'flex', gap: 14, marginTop: 4 } },
          e('div', null,
            e('div', { style: { fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 } }, 'Avances'),
            e('div', { style: { fontSize: 15, color: 'var(--text-primary)', fontWeight: 700, fontFamily: 'monospace' } }, (tarjeta.tasa_mv_avances * 100).toFixed(4) + '%')
          ),
          e('div', null,
            e('div', { style: { fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 } }, 'Diferidas'),
            e('div', { style: { fontSize: 15, color: 'var(--text-primary)', fontWeight: 700, fontFamily: 'monospace' } }, (tarjeta.tasa_mv_diferidas * 100).toFixed(4) + '%')
          )
        ),
        e('div', { className: 'card-sub' }, 'Dia de corte: ' + tarjeta.dia_corte)
      ),
      // Me Deben (total histórico de la tarjeta — viejas y nuevas)
      bimonCard({
        variant: 'success',
        title: 'Me Deben',
        copValue: fmtCOP(data.meDeben.total),
        usdValue: fmtUsd(data.meDeben.totalUsd || 0),
        hasUsd: !!(data.dualExtracto && (data.meDeben.totalUsd || 0) > 0),
        footer: data.meDeben.detalle.length > 0
          ? personasTableBimon(data.meDeben.detalle)
          : e('div', { className: 'card-sub', style: { margin: 0 } }, 'Sin deudas')
      })
    ),

    // ──── Divisor: Datos del corte ────
    e('div', { style: { borderTop: '1px solid var(--border)', margin: '20px 0 16px', paddingTop: 16 } },
      e('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 } },
        e('div', { style: { fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 1 } }, 'Datos del Corte'),
        data.extractoCiclo && data.extractoCiclo.estado === 'pagado' && e('span', {
          style: { display: 'inline-flex', alignItems: 'center', gap: 5, background: 'var(--success-bg)', color: 'var(--success)', fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 12, letterSpacing: 0.5 }
        }, e(Ico, { name: 'check', size: 13, color: 'var(--success)' }), 'PAGADO' + (data.extractoCiclo.fecha_pagado ? ' el ' + fmtDate(data.extractoCiclo.fecha_pagado) : ''))
      )
    ),
    e('div', { className: 'cards-row' },
      // \u2500\u2500 Card COP \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
      // El label cambia a "Pago M\u00EDnimo COP" cuando la tarjeta es dual,
      // para que sea sim\u00E9trico con la card USD que aparece al lado.
      (function() {
        // Para tarjetas duales SIEMPRE renombramos a "Pago M\u00EDnimo COP" (aunque USD est\u00E9 en 0),
        // para que sea coherente con la card USD que tambi\u00E9n se muestra siempre.
        const labelCop = data.dualExtracto ? 'Pago M\u00EDnimo COP' : 'Pago Minimo';
        return data.extractoCiclo && data.extractoCiclo.estado === 'pagado'
          ? e('div', { className: 'card card-success' },
              e('div', { className: 'card-label' }, labelCop),
              e('div', { className: 'card-value' }, fmtCOP(data.pagoMinimoBruto || 0)),
              e('div', null,
                e('div', { className: 'card-sub', style: { color: 'var(--success)' } }, 'Pagado: ' + fmtCOP(data.montoPagadoExtracto)),
                e('div', { style: { marginTop: 4, background: 'var(--bg-secondary)', borderRadius: 4, height: 4, overflow: 'hidden' } },
                  e('div', { style: { width: '100%', height: '100%', background: 'var(--success)', borderRadius: 4 } })
                )
              )
            )
          : e('div', { className: 'card card-warning' },
              e('div', { className: 'card-label' }, data.montoPagadoExtracto > 0 ? labelCop + ' (Restante)' : labelCop),
              e('div', { className: 'card-value' }, fmtCOP(data.pagoMinimo || 0)),
              data.montoPagadoExtracto > 0
                ? e('div', null,
                    e('div', { className: 'card-sub', style: { color: 'var(--success)' } }, 'Abonado: ' + fmtCOP(data.montoPagadoExtracto) + ' de ' + fmtCOP(data.pagoMinimoBruto)),
                    e('div', { style: { marginTop: 4, background: 'var(--bg-secondary)', borderRadius: 4, height: 4, overflow: 'hidden' } },
                      e('div', { style: { width: Math.min(100, Math.round(data.montoPagadoExtracto / data.pagoMinimoBruto * 100)) + '%', height: '100%', background: 'var(--success)', borderRadius: 4 } })
                    )
                  )
                : e('div', { style: { display: 'flex', gap: 14, marginTop: 6 } },
                    e('div', null,
                      e('div', { style: { fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 } }, 'Compras'),
                      e('div', { style: { fontSize: 12, color: 'var(--text-primary)', fontWeight: 600, fontFamily: 'monospace' } }, fmtCOP(data.comprasCiclo))
                    ),
                    e('div', null,
                      e('div', { style: { fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 } }, 'Cuotas'),
                      e('div', { style: { fontSize: 12, color: 'var(--text-primary)', fontWeight: 600, fontFamily: 'monospace' } }, fmtCOP(data.cuotasCorte || 0))
                    ),
                    data.interesesComprasIntl > 0 && e('div', null,
                      e('div', { style: { fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 } }, 'Int Intl'),
                      e('div', { style: { fontSize: 12, color: 'var(--text-primary)', fontWeight: 600, fontFamily: 'monospace' } }, fmtCOP(data.interesesComprasIntl))
                    )
                  )
            );
      })(),
      // \u2500\u2500 Card USD \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
      // Sim\u00E9trica a la card COP: 3 variantes (pagado / abonado parcial /
      // pendiente sin abono). Solo se renderiza para tarjetas duales con
      // saldo USD. Para tarjetas no-duales con `data.minimoUsd > 0` se
      // conserva la card simple legacy.
      (function() {
        // Para tarjetas DUALES, la card USD siempre se renderiza (aunque pagoMinimoUsd=0).
        // El borde sigue la misma convenci\u00F3n de la COP: warning (amarillo) cuando pendiente,
        // success (verde) cuando 100% saldado. El valor num\u00E9rico es BLANCO por defecto
        // y pasa a CYAN solo cuando el USD est\u00E1 totalmente saldado (espejo invertido del
        // patr\u00F3n COP que es blanco \u2192 verde via borde de card).
        if (data.dualExtracto) {
          const pagadoUsd = data.estadoUsdExtractoCiclo === 'pagado'
            || (data.extractoCiclo && data.extractoCiclo.estado_usd === 'pagado');
          const abonadoUsd = data.montoPagadoExtractoUsd || 0;
          const restanteUsd = Math.max(0, (data.pagoMinimoUsd || 0) - abonadoUsd);
          // Cyan solo cuando est\u00E1 al 100% saldado; sino white default.
          const valStyle = pagadoUsd ? { color: '#4FC3F7' } : undefined;
          if (pagadoUsd) {
            return e('div', { className: 'card card-success' },
              e('div', { className: 'card-label' }, 'Pago M\u00EDnimo USD'),
              e('div', { className: 'card-value', style: valStyle }, fmtUsd(data.pagoMinimoUsd || 0)),
              e('div', null,
                e('div', { className: 'card-sub', style: { color: '#4FC3F7' } }, 'Pagado: ' + fmtUsd(abonadoUsd || data.pagoMinimoUsd || 0)),
                e('div', { style: { marginTop: 4, background: 'var(--bg-secondary)', borderRadius: 4, height: 4, overflow: 'hidden' } },
                  e('div', { style: { width: '100%', height: '100%', background: '#4FC3F7', borderRadius: 4 } })
                )
              )
            );
          }
          return e('div', { className: 'card card-warning' },
            e('div', { className: 'card-label' }, abonadoUsd > 0 ? 'Pago M\u00EDnimo USD (Restante)' : 'Pago M\u00EDnimo USD'),
            e('div', { className: 'card-value', style: valStyle }, fmtUsd(restanteUsd)),
            abonadoUsd > 0
              ? e('div', null,
                  e('div', { className: 'card-sub', style: { color: '#4FC3F7' } }, 'Abonado: ' + fmtUsd(abonadoUsd) + ' de ' + fmtUsd(data.pagoMinimoUsd || 0)),
                  e('div', { style: { marginTop: 4, background: 'var(--bg-secondary)', borderRadius: 4, height: 4, overflow: 'hidden' } },
                    e('div', { style: { width: Math.min(100, Math.round(abonadoUsd / (data.pagoMinimoUsd || 1) * 100)) + '%', height: '100%', background: '#4FC3F7', borderRadius: 4 } })
                  )
                )
              : e('div', { style: { display: 'flex', gap: 14, marginTop: 6 } },
                  e('div', null,
                    e('div', { style: { fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 } }, 'Compras USD'),
                    e('div', { style: { fontSize: 12, color: 'var(--text-primary)', fontWeight: 600, fontFamily: 'monospace' } }, fmtUsd(data.minimoUsd || 0))
                  ),
                  data.interesesComprasUsd > 0 && e('div', null,
                    e('div', { style: { fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 } }, 'Int Corr USD'),
                    e('div', { style: { fontSize: 12, color: 'var(--text-primary)', fontWeight: 600, fontFamily: 'monospace' } }, fmtUsd(data.interesesComprasUsd))
                  ),
                  data.deudaUsd > 0 && e('div', null,
                    e('div', { style: { fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 } }, 'Deuda Total USD'),
                    e('div', { style: { fontSize: 12, color: 'var(--text-primary)', fontWeight: 600, fontFamily: 'monospace' } }, fmtUsd(data.deudaUsd))
                  )
                )
          );
        }
        // Tarjeta no-dual con minimoUsd > 0 (caso legacy raro).
        if (data.minimoUsd > 0) {
          return e('div', { className: 'card card-warning' },
            e('div', { className: 'card-label' }, 'Minimo USD'),
            e('div', { className: 'card-value', style: { color: '#4FC3F7' } }, fmtUsd(data.minimoUsd)),
            e('div', { className: 'card-sub' }, 'En COP: ' + fmtCOP(data.minimoUsdEnCop))
          );
        }
        return null;
      })(),
      bimonCard({
        variant: 'purple',
        title: 'Intereses del Mes',
        copValue: fmtCOPDec(data.interesesMes),
        usdValue: fmtUsd(data.interesesMesUsd || 0),
        hasUsd: !!(data.dualExtracto && (data.interesesMesUsd || 0) > 0),
        copExtra: e('div', { style: { display: 'flex', gap: 14, marginTop: 8, flexWrap: 'wrap' } },
          e('div', null,
            e('div', { style: { fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 } }, 'Diferidas'),
            e('div', { style: { fontSize: 12, color: 'var(--text-primary)', fontWeight: 600, fontFamily: 'monospace' } }, fmtCOPDec(data.interesesMesDiferidas || 0))
          ),
          e('div', null,
            e('div', { style: { fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 } }, 'Avances'),
            e('div', { style: { fontSize: 12, color: 'var(--text-primary)', fontWeight: 600, fontFamily: 'monospace' } }, fmtCOPDec(data.interesesMesAvances || 0))
          ),
          data.interesesComprasIntl > 0 && e('div', null,
            e('div', { style: { fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 } }, 'Int Intl'),
            e('div', { style: { fontSize: 12, color: 'var(--text-primary)', fontWeight: 600, fontFamily: 'monospace' } }, fmtCOP(data.interesesComprasIntl))
          )
        ),
        usdExtra: ((data.interesesMesDiferidasUsd || 0) > 0 || (data.interesesComprasUsd || 0) > 0)
          ? e('div', { style: { display: 'flex', gap: 14, marginTop: 8, flexWrap: 'wrap' } },
              (data.interesesMesDiferidasUsd || 0) > 0 && e('div', null,
                e('div', { style: { fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 } }, 'Diferidas'),
                e('div', { style: { fontSize: 12, color: 'var(--text-primary)', fontWeight: 600, fontFamily: 'monospace' } }, fmtUsd(data.interesesMesDiferidasUsd))
              ),
              (data.interesesComprasUsd || 0) > 0 && e('div', null,
                e('div', { style: { fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 } }, 'Compras'),
                e('div', { style: { fontSize: 12, color: 'var(--text-primary)', fontWeight: 600, fontFamily: 'monospace' } }, fmtUsd(data.interesesComprasUsd))
              )
            )
          : null
      }),
      // Deuda Personal del corte (compras y avances "Personal" del ciclo, sin tercero)
      bimonCard({
        variant: 'danger',
        title: 'Deuda Personal',
        copValue: fmtCOP(data.deudaPersonal || 0),
        usdValue: fmtUsd(data.deudaPersonalUsd || 0),
        hasUsd: (data.deudaPersonalUsd || 0) > 0,
        copExtra: e('div', { style: { display: 'flex', gap: 14, marginTop: 6, flexWrap: 'wrap' } },
          (data.deudaPersonalCompras || 0) > 0 && e('div', null,
            e('div', { style: { fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 } }, 'Compras'),
            e('div', { style: { fontSize: 12, color: 'var(--text-primary)', fontWeight: 600, fontFamily: 'monospace' } }, fmtCOP(data.deudaPersonalCompras))
          ),
          (data.deudaPersonalAvances || 0) > 0 && e('div', null,
            e('div', { style: { fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 } }, 'Avances'),
            e('div', { style: { fontSize: 12, color: 'var(--text-primary)', fontWeight: 600, fontFamily: 'monospace' } }, fmtCOP(data.deudaPersonalAvances))
          ),
          (data.deudaPersonalDiferidas || 0) > 0 && e('div', null,
            e('div', { style: { fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 } }, 'Diferidas'),
            e('div', { style: { fontSize: 12, color: 'var(--text-primary)', fontWeight: 600, fontFamily: 'monospace' } }, fmtCOP(data.deudaPersonalDiferidas))
          ),
          (data.deudaPersonalIntIntl || 0) > 0 && e('div', null,
            e('div', { style: { fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 } }, 'Int Intl'),
            e('div', { style: { fontSize: 12, color: 'var(--text-primary)', fontWeight: 600, fontFamily: 'monospace' } }, fmtCOP(data.deudaPersonalIntIntl))
          )
        ),
        footerSub: 'Compras y cuotas del corte (sin terceros)'
      }),
      // Me Deben Corte (lo que terceros me deben en este ciclo, con desglose por persona)
      bimonCard({
        variant: 'success',
        title: 'Me Deben Corte',
        copValue: fmtCOP((data.meDebenCorte && data.meDebenCorte.total) || 0),
        usdValue: fmtUsd((data.meDebenCorte && data.meDebenCorte.totalUsd) || 0),
        hasUsd: !!(data.dualExtracto && ((data.meDebenCorte && data.meDebenCorte.totalUsd) || 0) > 0),
        footer: data.meDebenCorte && data.meDebenCorte.detalle.length > 0
          ? personasTableBimon(data.meDebenCorte.detalle)
          : e('div', { className: 'card-sub', style: { margin: 0 } }, 'Nadie debe en este ciclo')
      }),
      bimonCard({
        variant: 'accent',
        title: 'Saldo en Bolsillo',
        // El valor grande es el BRUTO apartado. Antes era el neto (bruto - abonos, capado en 0), y
        // con un abono parcial grande la card se quedaba clavada en $0: el usuario apartaba dinero
        // y no veia moverse nada, aunque el dato se guardaba perfecto. El neto no se pierde, baja a
        // la linea de detalle junto a los abonos, que es lo que lo explica.
        copValue: fmtCOP(data.saldoBolsilloBruto || 0),
        usdValue: fmtUsd(data.saldoBolsilloUsdBruto || 0),
        hasUsd: !!(data.dualExtracto && ((data.saldoBolsilloUsdBruto || 0) > 0 || (data.saldoBolsilloUsdAbonado || 0) > 0 || (data.saldoBolsilloUsd || 0) > 0)),
        // Solo cuando hay abonos Y queda algo apartado: sin abonos el neto ES el bruto y repetirlo
        // seria ruido; y con el bruto en 0 -mes ya pagado, donde el bolsillo cumplio su fin- un
        // desglose de abonos bajo un principal de $0 no explica nada, solo confunde.
        copExtra: ((data.saldoBolsilloAbonado || 0) > 0 && (data.saldoBolsilloBruto || 0) > 0)
          ? e('div', { style: { display: 'flex', gap: 14, marginTop: 8, flexWrap: 'wrap' } },
              e('div', null,
                e('div', { style: { fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 } }, 'Abonos Realizados'),
                e('div', { style: { fontSize: 12, color: 'var(--warning)', fontWeight: 600, fontFamily: 'monospace' } }, '-' + fmtCOP(data.saldoBolsilloAbonado || 0))
              ),
              e('div', null,
                e('div', { style: { fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 } }, 'Neto Restante'),
                e('div', { style: { fontSize: 12, color: 'var(--text-primary)', fontWeight: 600, fontFamily: 'monospace' } }, fmtCOP(data.saldoBolsillo || 0))
              )
            )
          : null,
        // Mismo criterio en el piso de dolares: el valor grande ya es el bruto, asi que aqui va lo
        // que lo explica (abonos y neto). Si los dos pisos no siguieran la misma regla, la card
        // diria una cosa arriba y otra abajo.
        usdExtra: ((data.saldoBolsilloUsdAbonado || 0) > 0 && (data.saldoBolsilloUsdBruto || 0) > 0)
          ? e('div', { style: { display: 'flex', gap: 14, marginTop: 8, flexWrap: 'wrap' } },
              e('div', null,
                e('div', { style: { fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 } }, 'Abonos Realizados'),
                e('div', { style: { fontSize: 12, color: 'var(--warning)', fontWeight: 600, fontFamily: 'monospace' } }, '-' + fmtUsd(data.saldoBolsilloUsdAbonado || 0))
              ),
              e('div', null,
                e('div', { style: { fontSize: 10, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: 0.4 } }, 'Neto Restante'),
                e('div', { style: { fontSize: 12, color: 'var(--text-primary)', fontWeight: 600, fontFamily: 'monospace' } }, fmtUsd(data.saldoBolsilloUsd || 0))
              )
            )
          : null,
        footerSub: !((data.saldoBolsilloBruto || 0) > 0 || (data.saldoBolsilloAbonado || 0) > 0 || (data.saldoBolsilloUsdBruto || 0) > 0)
          ? 'Compras apartadas'
          : null
      })
    ),

    // ──── Registrar Movimiento button ────
    e('div', { className: 'toolbar', style: { marginTop: 24 } },
      e('div', { className: 'section-title', style: { margin: 0 } }, e(Ico, { name: 'clipboard', size: 18, color: 'var(--accent)' }), ' Movimientos'),
      e('div', { className: 'toolbar-spacer' }),
      e('button', { className: 'btn btn-success', onClick: () => setShowAbonoCapitalModal(true), style: { marginRight: 8 } }, '$ Abono a Capital'),
      e('button', { className: 'btn btn-primary', onClick: () => { setEditCompra(null); setEditAvance(null); setMovType('compra'); setShowMovModal(true); } }, '+ Registrar Movimiento')
    ),

    // ──── COMPRAS SECTION ────
    e('div', { style: { marginTop: 16 } },
      e('div', { style: { display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 } },
        e('div', { style: { fontSize: 15, fontWeight: 700 } }, e(Ico, { name: 'cart', size: 16, color: 'var(--warning)' }), ' Compras'),
        e('div', { className: 'toolbar-spacer' }),
        e('label', { className: 'form-label', style: { margin: 0 } }, 'Ciclo: '),
        e(CicloPicker, { value: ciclo, onChange: setCiclo })
      ),
      (() => {
        if (purchaseRows.length === 0) return e('div', { className: 'empty-state' }, e('div', { className: 'icon' }, e(Ico, { name: 'cart', size: 48, color: 'var(--text-muted)' })), e('div', null, 'No hay compras en este ciclo'));
        const cicloPagadoC = !!(data.extractoCiclo && data.extractoCiclo.estado === 'pagado');
        const esFuturoCiclo = ciclo > cicloVigente(tarjeta.dia_corte);
        // Solo Bancolombia Visa cobra intereses sobre compras intl en COP (validado con extracto real).
        // Mastercard/Amex usan extracto dual; otros bancos (RappiCard/Nu) no se han validado todavía.
        const fr = tarjeta.franquicia ? tarjeta.franquicia.toLowerCase() : '';
        const dual = fr.includes('mastercard') || fr.includes('amex') || fr.includes('american express');
        const aplicaIntl = !!(tarjeta.banco && tarjeta.banco.toLowerCase().includes('bancolombia') && !dual);
        const calcInteresIntl = (compra) => {
          if (!aplicaIntl) return 0;
          if (compra.estado === 'diferida') return 0;
          if (!compra.es_internacional) return 0;
          const saldo = compra.valor_cop - (compra.monto_abonado || 0);
          if (saldo <= 0) return 0;
          // Snapshot histórico (v4.1.0): manda la tasa CONGELADA de la compra y solo se cae a la
          // global si no la tiene. Este sitio se quedó sin migrar cuando se introdujo el snapshot, y
          // el defecto era invisible mientras global == snapshot; al subir la tasa de la tarjeta,
          // esta tabla empezó a exigir más bolsillo del que el backend permite guardar (que sí usa el
          // snapshot vía objetivoBolsilloCop) → la compra no podía salir de "bolsillo parcial".
          // GEMELA: calcInteresIntlTercero en terceros.js. Si tocas la fórmula, toca las dos.
          const tasaIntl = (compra.tasa_intl != null ? compra.tasa_intl : tarjeta.tasa_mv_avances);
          if (!tasaIntl) return 0;
          const [yr, mo] = ciclo.split('-').map(Number);
          const lastDay = new Date(yr, mo, 0).getDate();
          const fechaCorteIntl = new Date(yr, mo - 1, Math.min(tarjeta.dia_corte, lastDay)).toISOString().slice(0, 10);
          const dias = Math.round((new Date(fechaCorteIntl + 'T12:00:00') - new Date(compra.fecha + 'T12:00:00')) / 86400000);
          if (dias <= 0) return 0;
          return Math.round(saldo * tasaIntl * (dias / 30));
        };
        // Flechas de orden manual. Se deshabilitan en los bordes del día con el aviso educativo en el
        // `title`, para que se lea ANTES de pulsar y no como un error después. `row` trae los bordes
        // que calculó purchaseRows; sin él (llamadas sin fila) no se pintan.
        // Clase de animacion de una fila recien reordenada. Devuelve '' cuando no hay movimiento en
        // curso, asi que no ensucia el className del resto del tiempo.
        // La key de una fila animada lleva el tick del movimiento: al cambiar, React DESMONTA y
        // remonta ese <tr>, que es lo unico que hace que el navegador lance la animacion otra vez.
        // Reordenar sin esto solo mueve el nodo, y mover un nodo no reinicia sus animaciones.
        const keyMov = (base, clase) => (clase && filasMovidas ? base + '~' + filasMovidas.tick : base);
        const claseMov = (id) => {
          if (!filasMovidas) return '';
          if ((filasMovidas.movidas || []).indexOf(id) !== -1) return 'fila-movida-' + filasMovidas.dir;
          if ((filasMovidas.cedieron || []).indexOf(id) !== -1) return 'fila-cedio';
          return '';
        };
        const AVISO_BORDE = 'Para mover esta compra a otro dia, por favor edite la fecha manualmente.';
        const flechasOrden = (c, row) => {
          if (!row) return null;
          const btn = (dir, icono, tope) => e('button', {
            key: dir,
            className: 'btn btn-sm',
            disabled: !!tope,
            title: tope ? AVISO_BORDE : ('Mover ' + dir + ' dentro del ' + fmtDate(c.fecha)),
            style: Object.assign({ padding: '2px 6px', lineHeight: 1 }, tope ? { opacity: 0.35, cursor: 'not-allowed' } : null),
            onClick: () => { if (tope) { toastErr(AVISO_BORDE); return; } moverCompra(c, dir); }
          }, e(Ico, { name: icono, size: 12, color: 'currentColor' }));
          return e('span', { style: { display: 'inline-flex', gap: 2, marginRight: 6, verticalAlign: 'middle' } },
            btn('arriba', 'chevron-up', row._primeroDia), btn('abajo', 'chevron-down', row._ultimoDia));
        };
        const renderSingleRow = (c, row) => {
          const abonado = c.monto_abonado || 0;
          const tieneParcial = abonado > 0 && c.estado !== 'pagado';
          const bolsillo = c.monto_bolsillo || 0;
          // Crédito de reverso (NO un abono a capital del usuario): compra de tercero cubierta por su
          // bolsillo pero con monto_abonado — el banco redujo la deuda al aplicar un reverso a esta compra.
          // El usuario no le hace abonos a capital a compras de tercero, así que ese abonado es el crédito.
          const esReverso = !!c.persona_id && c.estado === 'bolsillo' && abonado > 0;
          const isDif = c.estado === 'diferida';
          const isPaidLikePast = cicloPagadoC && isDif; // diferida en ciclo pagado
          const interesIntl = calcInteresIntl(c);
          const bolsilloTarget = isDif ? (c.cuotaCorte || c.valor_cop) : (c.valor_cop + (c.es_internacional && interesIntl > 0 ? interesIntl : 0));
          // Diferidas: el badge muestra el estado REAL (pendiente/bolsillo/pagado) igual que las
          // compras de 1 cuota — la etiqueta "Cuota X/Y" ya deja claro que es diferida (v4.4.2
          // hizo lo mismo en Terceros; el literal 'diferida' era redundante y sin color de estado).
          const badgeEstado = isPaidLikePast
            ? 'pagado'
            : isDif
              ? (esFuturoCiclo ? 'pendiente' : (Math.round(bolsillo) >= Math.round(bolsilloTarget) ? 'bolsillo' : bolsillo > 0 ? 'bolsillo_parcial' : 'pendiente'))
              : c.estado;
          const faltaBolsillo = (!esFuturoCiclo && badgeEstado === 'bolsillo_parcial') ? Math.round(bolsilloTarget - bolsillo) : 0;
          const showAsPaid = c.estado === 'pagado' || isPaidLikePast;
          const valorMostrar = isDif && c.cuotaCorte ? c.cuotaCorte : c.valor_cop;
          const claseFila = claseMov(c.id);
          return e('tr', { key: keyMov(c.id, claseFila), 'data-cid': 'c' + c.id, className: claseFila, style: showAsPaid ? { background: 'rgba(52,211,153,0.10)' } : tieneParcial ? { background: 'rgba(59,130,246,0.08)' } : null },
            e('td', null, fmtDate(c.fecha)),
            // Descripción compacta en UNA línea: nombre + nota personal (muted) + badge de cuota +
            // abono parcial, todos inline (flex, gap). Sin <div> en bloque para la nota → no infla
            // la altura de la fila. flexWrap permite el salto natural solo si de verdad no cabe.
            e('td', null,
              e('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                e('span', null, c.descripcion),
                c.nota_personal && e('span', { style: { fontSize: 11, color: 'var(--text-muted)' } }, c.nota_personal),
                // El valor USD vive en su propia columna; el responsable también.
                isDif && c.cuota_num && e('span', { style: { fontSize: 10, color: 'var(--accent)' } }, 'Cuota ' + badgeCuotaLabel(c.cuota_num, c.cuotas_total, c.reprog_total)),
                tieneParcial && e('span', { className: 'badge badge-active', style: { fontSize: 10 } }, esReverso ? 'reverso' : 'abono parcial')
              )
            ),
            // Responsable: tercero con persona-dot o "—" si es Personal.
            e('td', { style: { fontSize: 12 } },
              c.persona_id
                ? e('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
                    e('span', { style: { background: c.persona_color || 'var(--accent)', width: 8, height: 8, display: 'inline-block', borderRadius: '50%' } }),
                    e('span', { style: { color: 'var(--text-primary)' } }, c.persona_nombre))
                : e('span', { style: { color: 'var(--text-muted)' } }, '—')
            ),
            e('td', { className: 'text-right text-mono' },
              // Si la compra es USD-pura (valor_cop=0 y valor_usd>0) mostramos "—".
              (c.valor_usd && c.valor_usd > 0 && !valorMostrar)
                ? e('span', { style: { color: 'var(--text-muted)' } }, '—')
                : fmtCOP(valorMostrar),
              // Abono parcial: el valor original queda inmutable arriba; debajo, en texto silenciado, lo
              // abonado. El saldo neto vive en la columna Total (tarjetas con interés intl); si la tarjeta
              // no tiene esa columna, se muestra el saldo aquí como segunda línea para no perder el dato.
              tieneParcial && e('div', { style: { fontSize: 11, color: 'var(--text-muted)' } }, (esReverso ? 'Reverso: ' : 'Abonado: ') + fmtCOP(abonado)),
              tieneParcial && !aplicaIntl && e('div', { style: { fontSize: 11, color: 'var(--primary)' } }, 'Saldo: ' + fmtCOP(valorMostrar - abonado))
            ),
            e('td', { className: 'text-right text-mono', style: { color: '#4FC3F7', fontWeight: 600 } },
              c.valor_usd && c.valor_usd > 0
                ? 'USD $' + new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(c.valor_usd)
                : e('span', { style: { color: 'var(--text-muted)' } }, '—')
            ),
            aplicaIntl && tasaIntlTd(c, tarjeta),
            aplicaIntl && e('td', { className: 'text-right text-mono', style: { fontSize: 12 } }, interesIntl > 0 ? fmtCOP(interesIntl) : e('span', { style: { color: 'var(--text-muted)' } }, '—')),
            aplicaIntl && e('td', { className: 'text-right text-mono', style: { fontWeight: (interesIntl > 0 || tieneParcial) ? 600 : undefined } },
              // Deuda neta de la fila = valor + interés intl − abonado. En filas pagadas se muestra el
              // total bruto original (el badge "Pagado" ya indica saldo 0) para no mostrar $0 confuso.
              fmtCOP(showAsPaid ? valorMostrar : ((interesIntl > 0 ? valorMostrar + interesIntl : valorMostrar) - abonado))),
            e('td', null,
              // REVERSADA manda sobre cualquier otro estado (v6.0.0). Contablemente la compra sigue
              // pesando en su ciclo —el banco la factura y su reverso viaja como crédito al mes que
              // el banco descontó—, pero para el usuario el estado de esa fila es uno solo. Antes se
              // veía el badge de "pendiente" en esta columna y otro de "Reversada" colgando de la de
              // acciones, que descuadraba el layout y contaba dos estados para la misma compra.
              c.reversada
                ? e('span', { className: 'badge', title: 'El banco devolvio esta compra; el dinero se aplico como credito',
                    style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '4px 10px',
                             background: 'rgba(148,163,184,0.15)', color: 'var(--text-muted)', border: '1px solid var(--border)' } },
                    e(Ico, { name: 'undo', size: 12, color: 'currentColor' }), 'Reversada')
                : showAsPaid
                ? e('span', { className: 'badge badge-pagado', style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '4px 10px' } },
                    e(Ico, { name: 'check', size: 12, color: 'currentColor' }), 'Pagado')
                : (c.estado !== 'pagado'
                    ? e('span', {
                        className: c.persona_id ? 'badge' : ('badge badge-' + badgeEstado + ' badge-clickable'),
                        onClick: () => openBolsilloModal(c.es_internacional && interesIntl > 0 ? Object.assign({}, c, { _bolsilloTarget: bolsilloTarget }) : c),
                        title: c.persona_id ? 'Gestionar abono desde la pestaña Terceros' : 'Clic para gestionar bolsillo',
                        style: c.persona_id ? { background: 'var(--bg-input)', color: 'var(--text-muted)', cursor: 'not-allowed', border: '1px solid ' + estadoColor(badgeEstado) } : undefined
                      }, badgeEstado.replace(/_/g, ' '))
                    : null),
              !showAsPaid && faltaBolsillo > 0 && e('div', { style: { fontSize: 11, color: 'var(--warning)', marginTop: 2 } }, 'Falta: ' + fmtCOP(faltaBolsillo))
            ),
            e('td', { style: { whiteSpace: 'nowrap' } },
              // Editar/eliminar: solo mientras no esté pagada. Cuando el ciclo está pagado el badge
              // "Pagado" vive en la columna Estado (arriba); acá queda solo la acción Reversar.
              // Orden manual dentro del dia: va PRIMERO y no depende del estado de la compra
              // (una pagada tambien se coloca donde el usuario quiera).
              flechasOrden(c, row),
              !showAsPaid && e('button', { className: 'btn btn-sm', onClick: () => { setEditCompra(c); setShowCompraModal(true); } }, e(Ico, { name: 'edit', size: 14, color: 'currentColor' })),
              !showAsPaid && ' ',
              !showAsPaid && e('button', { className: 'btn btn-sm btn-danger', onClick: () => removeCompra(c.id) }, e(Ico, { name: 'trash', size: 14, color: 'currentColor' })),
              // Reversar (devolución del banco): disponible también en compras pagadas/antiguas — es su
              // caso de uso. No aplica a diferidas (v1). Si ya se reversó, el botón desaparece y el
              // estado se lee en la columna ESTADO, que pasa a decir "Reversada" (v6.0.0).
              // Ternario (no `cond &&`): c.reversada es un número (0/1); con `&&` React pintaría el "0".
              (!isDif && !c.reversada) ? ' ' : null,
              (!isDif && !c.reversada) ? e('button', { className: 'btn btn-sm', title: 'Reversar compra (devolución del banco)', onClick: () => reverseCompra(c) }, e(Ico, { name: 'undo', size: 14, color: 'currentColor' })) : null
              // El badge "Reversada" vive en la columna ESTADO, no aquí: es un estado, no una acción.
            )
          );
        };
        return e('div', { className: 'table-wrap' },
          e('table', null,
            // Anchos calibrados para alineación perfecta con la tabla de Diferidas (suma 1145px en ambos casos).
            //   Bancolombia Visa (aplicaIntl): Valor 140 + Int Intl 110 + Total 140 = 390 en el centro.
            //   Otras franquicias (Nu, RappiCard, MC, Amex sin aplicaIntl): Valor único 390 que llena el espacio.
            // Así el borde derecho de "Valor" (Compras) coincide con "Saldo Actual" (Diferidas) en cualquier tarjeta.
            e('colgroup', null,
              e('col', { style: { width: '95px' } }),
              e('col', { style: { width: '280px' } }),
              e('col', { style: { width: '160px' } }),
              e('col', { style: { width: aplicaIntl ? '120px' : '270px' } }),
              e('col', { style: { width: '110px' } }), // Valor USD
              aplicaIntl && e('col', { style: { width: '85px' } }),
              aplicaIntl && e('col', { style: { width: '100px' } }),
              aplicaIntl && e('col', { style: { width: '130px' } }),
              e('col', { style: { width: '130px' } }),
              e('col', { style: { width: '90px' } })
            ),
            e('thead', null, e('tr', null,
              e('th', null, 'Fecha'),
              e('th', null, 'Descripcion'),
              e('th', null, 'Responsable'),
              e('th', { className: 'text-right' }, 'Valor COP'),
              e('th', { className: 'text-right', style: { whiteSpace: 'nowrap', color: '#4FC3F7' } }, 'Valor USD'),
              aplicaIntl && e('th', { className: 'text-right', style: { whiteSpace: 'nowrap' } }, 'Tasa'),
              aplicaIntl && e('th', { className: 'text-right', style: { whiteSpace: 'nowrap' } }, 'Int Intl'),
              aplicaIntl && e('th', { className: 'text-right', style: { whiteSpace: 'nowrap' } }, 'Total'),
              e('th', null, 'Estado'),
              e('th', null, '')
            )),
            e('tbody', null,
              purchaseRows.flatMap(item => {
                if (item.tipo === 'grupo') {
                  // Estado "pagado" del grupo:
                  //   - Diferidas: aplica cuando el ciclo display está pagado (las hijas conservan estado='diferida').
                  //   - 1-cuota: aplica cuando TODAS las partes están en estado='pagado' (lo marca el sync al cerrar extracto).
                  //   - O cuando el extracto del ciclo display está pagado (fallback global).
                  var todasPartesPagadas = item.partes.length > 0 && item.partes.every(function(c) { return c.estado === 'pagado'; });
                  var grupoPaidPast = cicloPagadoC || (!item.esDiferida && todasPartesPagadas);

                  // Estado bolsillo del grupo: SIEMPRE calculado por agregado, no por items[0].estado.
                  var grupoBadge;
                  if (item.esDiferida) {
                    var grpBolTotal = item.partes.reduce(function(s, c) { return s + (c.monto_bolsillo || 0); }, 0);
                    var grpTarget = item.partes.reduce(function(s, c) { return s + (c.cuotaCorte || c.valor_cop); }, 0);
                    // Estado real (pendiente, no 'diferida'): el contador "Cuota X/Y" ya marca la diferida.
                    grupoBadge = grupoPaidPast
                      ? 'pagado'
                      : (Math.round(grpBolTotal) >= Math.round(grpTarget) ? 'bolsillo' : grpBolTotal > 0 ? 'bolsillo_parcial' : 'pendiente');
                  } else {
                    // Grupo 1-cuota: sumar bolsillo de todas las partes y comparar contra suma de valores.
                    // Antes leíamos items[0].estado, lo que producía "bolsillo" falso si solo una parte estaba apartada.
                    var grpBolTotal1c = item.partes.reduce(function(s, c) { return s + (c.monto_bolsillo || 0); }, 0);
                    var grpTarget1c = item.partes.reduce(function(s, c) { return s + c.valor_cop; }, 0);
                    grupoBadge = grupoPaidPast
                      ? 'pagado'
                      : (Math.round(grpBolTotal1c) >= Math.round(grpTarget1c) ? 'bolsillo' : grpBolTotal1c > 0 ? 'bolsillo_parcial' : 'pendiente');
                  }
                  const grpEsIntl = item.partes.length > 0 && !!(item.partes[0].es_internacional);
                  const grpInteres = item.partes.reduce((s, p) => s + calcInteresIntl(p), 0);
                  const claseGrupo = item.partes.map(p => claseMov(p.id)).find(Boolean) || '';
                  const parentRow = e('tr', { key: keyMov('grp-' + item.grupo_id, claseGrupo), 'data-cid': 'g' + item.grupo_id, className: claseGrupo, style: { background: grupoPaidPast ? 'rgba(52,211,153,0.10)' : 'var(--bg-tertiary)' } },
                    e('td', null, fmtDate(item.fecha)),
                    // Descripción compacta inline (igual que la fila simple): nombre + nota + cuota.
                    e('td', null,
                      e('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                        e('span', { style: { fontWeight: 700 } }, item.descripcion),
                        item.nota_personal && e('span', { style: { fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 } }, item.nota_personal),
                        item.esDiferida && e('span', { style: { fontSize: 10, color: 'var(--accent)' } }, 'Cuota ' + item.cuota_num + '/' + item.cuotas_total)
                      )
                    ),
                    // Responsable: badge "Dividida" en azul (reservamos verde para "pagado") + cantidad de partes.
                    e('td', { style: { fontSize: 12 } },
                      e('span', { className: 'badge', style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, padding: '3px 8px', background: 'rgba(56,189,248,0.15)', color: '#38bdf8' } },
                        e(Ico, { name: 'users', size: 10, color: 'currentColor' }), 'Dividida'),
                      e('span', { style: { fontSize: 10, color: 'var(--text-muted)', marginLeft: 6 } }, item.partes.length + ' partes')
                    ),
                    (function() {
                      const totalUsdGrupo = item.partes.reduce((s, p) => s + (p.valor_usd || 0), 0);
                      const esUsdPuro = totalUsdGrupo > 0 && !item.total;
                      return e('td', { className: 'text-right text-mono', style: { fontWeight: 700, color: grupoPaidPast ? 'var(--success)' : undefined } },
                        esUsdPuro ? e('span', { style: { color: 'var(--text-muted)' } }, '\u2014') : fmtCOP(item.total)
                      );
                    })(),
                    (function() {
                      const totalUsdGrupo = item.partes.reduce((s, p) => s + (p.valor_usd || 0), 0);
                      return e('td', { className: 'text-right text-mono', style: { color: '#4FC3F7', fontWeight: 700 } },
                        totalUsdGrupo > 0
                          ? 'USD $' + new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(totalUsdGrupo)
                          : e('span', { style: { color: 'var(--text-muted)' } }, '\u2014')
                      );
                    })(),
                    aplicaIntl && tasaIntlTd(item.partes[0] || {}, tarjeta),
                    aplicaIntl && e('td', { className: 'text-right text-mono', style: { fontSize: 12 } }, grpInteres > 0 ? fmtCOP(grpInteres) : e('span', { style: { color: 'var(--text-muted)' } }, '\u2014')),
                    aplicaIntl && e('td', { className: 'text-right text-mono', style: { fontWeight: 700 } }, fmtCOP(grpInteres > 0 ? item.total + grpInteres : item.total)),
                    // Estado: cuando el grupo está pagado, el badge "Pagado" vive aquí (estilo unificado).
                    e('td', null, grupoPaidPast
                      ? e('span', { className: 'badge badge-pagado', style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '4px 10px' } },
                          e(Ico, { name: 'check', size: 12, color: 'currentColor' }), 'Pagado')
                      : e('span', { className: 'badge badge-' + grupoBadge }, grupoBadge.replace(/_/g, ' '))),
                    e('td', { style: { whiteSpace: 'nowrap' } },
                      flechasOrden(item.partes[0], item),
                      !grupoPaidPast && e('button', { className: 'btn btn-sm', onClick: (ev) => { ev.stopPropagation(); editGrupo(item); }, title: 'Editar compra dividida' }, e(Ico, { name: 'edit', size: 14, color: 'currentColor' })),
                      !grupoPaidPast && ' ',
                      !grupoPaidPast && e('button', { className: 'btn btn-sm btn-danger', onClick: (ev) => { ev.stopPropagation(); removeGrupo(item.partes); }, title: 'Eliminar compra dividida' }, e(Ico, { name: 'trash', size: 14, color: 'currentColor' }))
                    )
                  );
                  const childRows = item.partes.map(c => {
                    // Per-cuota: usar monto_bolsillo_cuota para diferidas, monto_bolsillo para normales
                    var childBol = item.esDiferida ? (c.monto_bolsillo_cuota || 0) : (c.monto_bolsillo || 0);
                    var childIntl = (!item.esDiferida && c.es_internacional) ? calcInteresIntl(c) : 0;
                    var childTarget = item.esDiferida ? (c.cuotaCorte || c.valor_cop) : (c.valor_cop + childIntl);
                    // childPaidPast: aplica tanto a hijas diferidas (por ciclo pagado) como a hijas 1-cuota
                    // (estado='pagado' lo establece el sync al pagar el extracto, o fallback al cicloPagadoC).
                    var childPaidPast = cicloPagadoC || c.estado === 'pagado';
                    var childBadge;
                    if (item.esDiferida) {
                      // Estado real (pendiente, no 'diferida'): el contador "Cuota X/Y" ya marca la diferida.
                      childBadge = childPaidPast
                        ? 'pagado'
                        : (esFuturoCiclo ? 'pendiente' : (Math.round(childBol) >= Math.round(childTarget) ? 'bolsillo' : childBol > 0 ? 'bolsillo_parcial' : 'pendiente'));
                    } else {
                      // Compra dividida a 1 cuota: cualquier parte (Personal o Tercero) puede ir a bolsillo.
                      // Mismo monto_bolsillo que usa la sección Terceros — los botones quedan conectados.
                      childBadge = childPaidPast
                        ? 'pagado'
                        : (Math.round(childBol) >= Math.round(childTarget)
                            ? 'bolsillo'
                            : childBol > 0 ? 'bolsillo_parcial' : 'pendiente');
                    }
                    var childFalta = (!esFuturoCiclo && childBadge === 'bolsillo_parcial') ? Math.round(childTarget - childBol) : 0;
                    var childValor = item.esDiferida ? (c.cuotaCorte || 0) : c.valor_cop;
                    return e('tr', { key: keyMov(c.id, claseGrupo), 'data-cid': 'c' + c.id, className: claseGrupo, style: { background: childPaidPast ? 'rgba(52,211,153,0.08)' : 'rgba(99,102,241,0.04)' } },
                      e('td', null),
                      // Descripcion: vacía (la madre ya la muestra). Mantenemos indentación con muted "↳" para jerarquía visual.
                      e('td', { style: { paddingLeft: 24, fontSize: 12, color: 'var(--text-muted)' } },
                        '↳ parte',
                        item.esDiferida ? e('span', { style: { fontSize: 10, marginLeft: 6 } }, 'Cuota ' + c.cuota_num + '/' + c.cuotas_total) : null
                      ),
                      // Responsable: persona-dot + nombre (o "Personal" si no hay persona_id).
                      e('td', { style: { fontSize: 12 } },
                        e('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
                          e('span', { className: 'persona-dot', style: { background: c.persona_id ? c.persona_color : '#666', width: 8, height: 8, display: 'inline-block', borderRadius: '50%' } }),
                          e('span', { style: { color: 'var(--text-primary)' } }, c.persona_id ? c.persona_nombre : 'Personal'))
                      ),
                      e('td', { className: 'text-right text-mono', style: { fontSize: 13, color: childPaidPast ? 'var(--success)' : undefined } },
                        (c.valor_usd && c.valor_usd > 0 && !childValor)
                          ? e('span', { style: { color: 'var(--text-muted)' } }, '—')
                          : fmtCOP(childValor)
                      ),
                      e('td', { className: 'text-right text-mono', style: { fontSize: 13, color: '#4FC3F7', fontWeight: 600 } },
                        c.valor_usd && c.valor_usd > 0
                          ? 'USD $' + new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(c.valor_usd)
                          : e('span', { style: { color: 'var(--text-muted)' } }, '—')
                      ),
                      aplicaIntl && tasaIntlTd(c, tarjeta),
                      aplicaIntl && e('td', { className: 'text-right text-mono', style: { fontSize: 12 } }, childIntl > 0 ? fmtCOP(childIntl) : e('span', { style: { color: 'var(--text-muted)' } }, '—')),
                      aplicaIntl && e('td', { className: 'text-right text-mono', style: { fontSize: 13, fontWeight: childIntl > 0 ? 600 : undefined } }, fmtCOP(childIntl > 0 ? childValor + childIntl : childValor)),
                      // Estado de la hija: cuando está pagado, el badge "Pagado" vive aquí.
                      e('td', null,
                        childPaidPast
                          ? e('span', { className: 'badge badge-pagado', style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, padding: '3px 8px' } },
                              e(Ico, { name: 'check', size: 10, color: 'currentColor' }), 'Pagado')
                          : (childBadge
                              ? e('span', {
                                  className: c.persona_id ? 'badge' : ('badge badge-' + childBadge + ' badge-clickable'),
                                  onClick: function() { openBolsilloModal(Object.assign({}, c, { _bolsilloTarget: childTarget, monto_bolsillo: childBol, cuota_num: item.esDiferida ? c.cuota_num : undefined, cuotas_total: item.esDiferida ? c.cuotas_total : undefined })); },
                                  title: c.persona_id ? 'Gestionar abono desde la pestaña Terceros' : 'Clic para gestionar bolsillo',
                                  style: c.persona_id ? { fontSize: 10, background: 'var(--bg-input)', color: 'var(--text-muted)', cursor: 'not-allowed', border: '1px solid ' + estadoColor(childBadge) } : { fontSize: 10 }
                                }, childBadge.replace(/_/g, ' '))
                              : null),
                        childFalta > 0 && e('div', { style: { fontSize: 10, color: 'var(--warning)', marginTop: 2 } }, 'Falta: ' + fmtCOP(childFalta))
                      ),
                      // Actions: vacío para hijas (nunca tienen botones individuales).
                      e('td', null)
                    );
                  });
                  return [parentRow, ...childRows];
                }
                return [renderSingleRow(item.data, item)];
              })
            )
          )
        );
      })()
    ),

    // ──── DIFERIDAS SECTION ────
    (() => {
      const diferidasCiclo = diferidas.filter(d => d.ciclos && d.ciclos.includes(ciclo));
      const cicloPagadoDif = !!(data.extractoCiclo && data.extractoCiclo.estado === 'pagado');
      const esFuturoCicloDif = ciclo > cicloVigente(tarjeta.dia_corte);
      const totalCuotaDif = diferidasCiclo.reduce((s, d) => s + (d.cuotaCorte || 0), 0);
      return e('div', { style: { marginTop: 32 } },
      e('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 15, fontWeight: 700, marginBottom: 12 } },
        e('span', null, e(Ico, { name: 'calendar', size: 16, color: 'var(--purple)' }), ' Diferidas'),
        totalCuotaDif > 0 && e('span', { className: 'text-mono', style: { color: cicloPagadoDif ? 'var(--success)' : 'var(--purple)' } },
          fmtCOP(totalCuotaDif) + (cicloPagadoDif ? ' (pagado)' : ''))
      ),
      diferidasCiclo.length === 0
        ? e('div', { className: 'empty-state' }, e('div', { className: 'icon' }, e(Ico, { name: 'calendar', size: 48, color: 'var(--text-muted)' })), e('div', null, 'No hay diferidas en este ciclo'))
        : e('div', { className: 'table-wrap', style: { marginBottom: 16 } },
            e('table', null,
              // Anchos calibrados para alineación perfecta con la tabla de Compras:
              // Fecha 95 + Descripcion 280 + Responsable 160 = 535 (compartidas)
              // Cuota Corte 110 + Cuotas 60 + Tasa MV 80 = 250 (centro, equivale a Valor+IntIntl=250 en Compras)
              // Saldo Actual 140 + Estado 130 + Actions 90 = 360 (final, idéntico a Compras: Total+Estado+Actions)
              // Suma total: 1145px (= Compras con aplicaIntl).
              e('colgroup', null,
                e('col', { style: { width: '95px' } }),
                e('col', { style: { width: '280px' } }),
                e('col', { style: { width: '160px' } }),
                e('col', { style: { width: '110px' } }),
                e('col', { style: { width: '60px' } }),
                e('col', { style: { width: '80px' } }),
                e('col', { style: { width: '140px' } }),
                e('col', { style: { width: '130px' } }),
                e('col', { style: { width: '90px' } })
              ),
              e('thead', null, e('tr', null,
                e('th', null, 'Fecha'),
                e('th', null, 'Descripcion'),
                e('th', null, 'Responsable'),
                e('th', { className: 'text-right' }, 'Cuota Corte'),
                e('th', null, 'Cuotas'),
                e('th', null, 'Tasa MV'),
                e('th', { className: 'text-right' }, 'Saldo Actual'),
                e('th', null, 'Estado'),
                e('th', null, '')
              )),
              e('tbody', null,
                (() => {
                  // Agrupar las diferidas del ciclo por grupo_id (compra dividida = una diferida por parte):
                  // las que comparten grupo_id se muestran como madre virtual + hijas indentadas (igual que
                  // en Compras), evitando que aparezcan como items sueltos. El resto, filas individuales.
                  const dGrupos = {}, dSingles = [];
                  diferidasCiclo.forEach(d => { if (d.grupo_id) { (dGrupos[d.grupo_id] = dGrupos[d.grupo_id] || []).push(d); } else { dSingles.push(d); } });
                  Object.keys(dGrupos).forEach(gid => { if (dGrupos[gid].length < 2) { dGrupos[gid].forEach(x => dSingles.push(x)); delete dGrupos[gid]; } });

                  // Celda Estado/bolsillo de UNA diferida (cuota del corte). Reutilizada por filas
                  // individuales e hijas. El intercept de openBolsilloModal ya bloquea editar bolsillo de tercero.
                  const bolsilloCellDif = (d) => {
                    var cn = d.ciclos ? d.ciclos.indexOf(ciclo) + 1 : 1;
                    var bol = (d.bolsillo_por_cuota && d.bolsillo_por_cuota[cn]) || 0;
                    var target = d.cuotaCorte || 0;
                    var badge = cicloPagadoDif ? 'pagado' : esFuturoCicloDif ? 'pendiente' : (Math.round(bol) >= Math.round(target) && target > 0 ? 'bolsillo' : bol > 0 ? 'bolsillo_parcial' : 'pendiente');
                    var falta = (!esFuturoCicloDif && badge === 'bolsillo_parcial') ? Math.round(target - bol) : 0;
                    return e('td', null,
                      cicloPagadoDif
                        ? e('span', { className: 'badge badge-pagado', style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '4px 10px' } }, e(Ico, { name: 'check', size: 12, color: 'currentColor' }), 'Pagado')
                        : d.estado === 'liquidado'
                          ? e('span', { className: 'badge badge-liquidado' }, 'liquidado')
                          : e('span', {
                              // Tercero: badge gris/no-clickable (su bolsillo = reembolso, se gestiona en
                              // Terceros). Igual se pasa persona_id a openBolsilloModal para que el
                              // interceptor corte la accion y muestre el dialogo. Personal: badge normal.
                              className: d.es_de_tercero ? 'badge' : ('badge badge-' + badge + ' badge-clickable'),
                              onClick: (ev) => {
                                ev.stopPropagation();
                                if (d.compra_id) {
                                  openBolsilloModal({ id: d.compra_id, persona_id: d.persona_id || null, descripcion: d.etiqueta + (d.es_de_tercero ? ' (' + d.persona_nombre + ')' : ''), estado: 'diferida', valor_cop: target, cuotaCorte: target, monto_bolsillo: bol, _bolsilloTarget: target, cuota_num: cn, cuotas_total: d.num_cuotas, reprog_total: d.reprog_total || null });
                                } else { openBolsilloDiferidaModal(d); }
                              },
                              title: d.es_de_tercero ? 'Gestionar abono desde la pestaña Terceros' : 'Clic para gestionar bolsillo (cuota del corte)',
                              style: d.es_de_tercero ? { fontSize: 10, background: 'var(--bg-input)', color: 'var(--text-muted)', cursor: 'not-allowed', border: '1px solid ' + estadoColor(badge) } : { fontSize: 10 }
                            }, badge.replace(/_/g, ' ')),
                      !cicloPagadoDif && d.estado !== 'liquidado' && falta > 0 && e('div', { style: { fontSize: 10, color: 'var(--warning)', marginTop: 2 } }, 'Falta: ' + fmtCOP(falta))
                    );
                  };

                  // Fila de diferida INDIVIDUAL (sin grupo): editar siempre + borrar con guard de ciclo pagado.
                  const renderSingleDif = (d) => {
                    var rowStyleD = { cursor: 'pointer' };
                    if (cicloPagadoDif) rowStyleD.background = 'rgba(52,211,153,0.10)';
                    return e('tr', { key: d.id, onClick: () => loadDiferidaDetail(d.id), style: rowStyleD, className: selectedDiferida === d.id ? 'row-highlight' : '' },
                      e('td', null, fmtDate(d.fecha_compra)),
                      // Descripción compacta inline (igual que la tabla de Compras): nombre + nota personal.
                      e('td', null,
                        e('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                          e('span', { style: { fontWeight: 600 } }, d.etiqueta),
                          d.nota_personal && e('span', { style: { fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 } }, d.nota_personal)
                        )
                      ),
                      e('td', { style: { fontSize: 12 } },
                        d.es_de_tercero
                          ? e('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } }, e('span', { style: { background: d.persona_color || 'var(--accent)', width: 8, height: 8, display: 'inline-block', borderRadius: '50%' } }), e('span', { style: { color: 'var(--text-primary)' } }, d.persona_nombre))
                          : e('span', { style: { color: 'var(--text-muted)' } }, '—')
                      ),
                      e('td', { className: 'text-right text-mono', style: { fontWeight: 700, color: cicloPagadoDif ? 'var(--success)' : 'var(--danger)' } }, fmtCOP(d.cuotaCorte)),
                      e('td', null, badgeCuotaLabel((d.ciclos ? d.ciclos.indexOf(ciclo) + 1 : (d.num_cuotas - d.cuotasRestantes + 1)), d.num_cuotas, d.reprog_total)),
                      e('td', { className: 'text-mono' }, (d.tasa_mv * 100).toFixed(2) + '%'),
                      e('td', { className: 'text-right text-mono', style: { fontWeight: 700, color: d.saldoActual > 0 ? 'var(--danger)' : 'var(--success)' } }, fmtCOP(d.saldoActual)),
                      bolsilloCellDif(d),
                      e('td', { style: { whiteSpace: 'nowrap' } },
                        e('button', { className: 'btn btn-sm', title: 'Editar nombre y nota', onClick: (ev) => { ev.stopPropagation(); setEditDiferida(d); setShowDiferidaModal(true); } }, e(Ico, { name: 'edit', size: 14, color: 'currentColor' })),
                        ' ',
                        // "Reprogramar saldo" en la FILA: es la operacion correcta para una diferida que ya
                        // facturo cuotas, y hasta ahora obligaba a desplegar antes el detalle de amortizacion.
                        (() => {
                          const motivo = motivoNoReprogramable(d);
                          const titulo = motivo || (planEsUniforme(d)
                            ? 'Cambiar el numero de cuotas de este plan (se regenera desde el inicio)'
                            : 'Reprogramar el saldo restante a un nuevo numero de cuotas');
                          return e('button', { className: 'btn btn-sm', disabled: !!motivo, title: titulo, style: motivo ? { opacity: 0.5, cursor: 'not-allowed' } : undefined, onClick: (ev) => { ev.stopPropagation(); if (motivo) return; abrirReprogramar(d.id); } }, e(Ico, { name: 'refresh', size: 14, color: 'currentColor' }));
                        })(),
                        !cicloPagadoDif && ' ',
                        !cicloPagadoDif && e('button', { className: 'btn btn-sm btn-danger', onClick: (ev) => { ev.stopPropagation(); removeDiferida(d.id); } }, e(Ico, { name: 'trash', size: 14, color: 'currentColor' }))
                      )
                    );
                  };

                  // Grupo (compra dividida diferida): madre virtual con totales agregados + hijas indentadas.
                  const renderGrupoDif = (gid, partes) => {
                    var primera = partes[0];
                    var cuotaNumG = primera.ciclos ? primera.ciclos.indexOf(ciclo) + 1 : 1;
                    var totalCuota = partes.reduce((s, p) => s + (p.cuotaCorte || 0), 0);
                    var totalSaldo = partes.reduce((s, p) => s + (p.saldoActual || 0), 0);
                    var totalBol = partes.reduce((s, p) => { var cn = p.ciclos ? p.ciclos.indexOf(ciclo) + 1 : 1; return s + ((p.bolsillo_por_cuota && p.bolsillo_por_cuota[cn]) || 0); }, 0);
                    var grupoBadge = cicloPagadoDif ? 'pagado' : esFuturoCicloDif ? 'pendiente' : (Math.round(totalBol) >= Math.round(totalCuota) && totalCuota > 0 ? 'bolsillo' : totalBol > 0 ? 'bolsillo_parcial' : 'pendiente');
                    var madre = e('tr', { key: 'dgrp-' + gid, style: { background: cicloPagadoDif ? 'rgba(52,211,153,0.10)' : 'var(--bg-tertiary)' } },
                      e('td', null, fmtDate(primera.fecha_compra)),
                      // Descripción compacta inline: nombre del grupo + nota personal (compartida por las partes).
                      e('td', null,
                        e('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                          e('span', { style: { fontWeight: 700 } }, primera.etiqueta),
                          primera.nota_personal && e('span', { style: { fontSize: 11, color: 'var(--text-muted)', fontWeight: 400 } }, primera.nota_personal)
                        )
                      ),
                      e('td', { style: { fontSize: 12 } },
                        e('span', { className: 'badge', style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 10, padding: '3px 8px', background: 'rgba(56,189,248,0.15)', color: '#38bdf8' } }, e(Ico, { name: 'users', size: 10, color: 'currentColor' }), 'Dividida'),
                        e('span', { style: { fontSize: 10, color: 'var(--text-muted)', marginLeft: 6 } }, partes.length + ' partes')
                      ),
                      e('td', { className: 'text-right text-mono', style: { fontWeight: 700, color: cicloPagadoDif ? 'var(--success)' : 'var(--danger)' } }, fmtCOP(totalCuota)),
                      e('td', null, cuotaNumG + '/' + primera.num_cuotas),
                      e('td', { className: 'text-mono' }, (primera.tasa_mv * 100).toFixed(2) + '%'),
                      e('td', { className: 'text-right text-mono', style: { fontWeight: 700, color: totalSaldo > 0 ? 'var(--danger)' : 'var(--success)' } }, fmtCOP(totalSaldo)),
                      e('td', null, cicloPagadoDif
                        ? e('span', { className: 'badge badge-pagado', style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '4px 10px' } }, e(Ico, { name: 'check', size: 12, color: 'currentColor' }), 'Pagado')
                        : e('span', { className: 'badge badge-' + grupoBadge }, grupoBadge.replace(/_/g, ' '))),
                      e('td', { style: { whiteSpace: 'nowrap' } },
                        e('button', { className: 'btn btn-sm', title: 'Editar nombre y nota', onClick: (ev) => { ev.stopPropagation(); setEditDiferida(primera); setShowDiferidaModal(true); } }, e(Ico, { name: 'edit', size: 14, color: 'currentColor' })))
                    );
                    var hijas = partes.map(d => e('tr', { key: 'dchild-' + d.id, onClick: () => loadDiferidaDetail(d.id), style: { cursor: 'pointer', background: cicloPagadoDif ? 'rgba(52,211,153,0.08)' : 'rgba(99,102,241,0.04)' }, className: selectedDiferida === d.id ? 'row-highlight' : '' },
                      e('td', null),
                      e('td', { style: { paddingLeft: 24, fontSize: 12, color: 'var(--text-muted)' } }, '↳ parte', e('span', { style: { fontSize: 10, marginLeft: 6 } }, 'Cuota ' + (d.ciclos ? d.ciclos.indexOf(ciclo) + 1 : 1) + '/' + d.num_cuotas)),
                      e('td', { style: { fontSize: 12 } },
                        // Simetría: tercero y Personal SIEMPRE con punto (Personal en gris --text-muted).
                        e('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
                          e('span', { style: { background: d.es_de_tercero ? (d.persona_color || 'var(--accent)') : 'var(--text-muted)', width: 8, height: 8, display: 'inline-block', borderRadius: '50%' } }),
                          e('span', { style: { color: 'var(--text-primary)' } }, d.es_de_tercero ? d.persona_nombre : 'Personal'))
                      ),
                      e('td', { className: 'text-right text-mono', style: { fontSize: 13, fontWeight: 600, color: cicloPagadoDif ? 'var(--success)' : 'var(--danger)' } }, fmtCOP(d.cuotaCorte)),
                      e('td', null, (d.ciclos ? d.ciclos.indexOf(ciclo) + 1 : 1) + '/' + d.num_cuotas),
                      e('td', { className: 'text-mono' }, (d.tasa_mv * 100).toFixed(2) + '%'),
                      e('td', { className: 'text-right text-mono', style: { fontSize: 13, fontWeight: 600, color: d.saldoActual > 0 ? 'var(--danger)' : 'var(--success)' } }, fmtCOP(d.saldoActual)),
                      bolsilloCellDif(d),
                      e('td', null)
                    ));
                    return [madre].concat(hijas);
                  };

                  // Fila READ-ONLY de una cuota SELLADA por reprogramacion (historial del plan viejo): sin
                  // amortizacion, sin bolsillo editable, sin acciones; atenuada, con su badge de cuota (i/M)
                  // y su estado real (Pagado/Pendiente). Se inyecta desde GET /diferidas al ver su ciclo.
                  const renderSelladaDif = (s) => {
                    var pagada = s.estado_sellada === 'pagado';
                    // Se ve EXACTO a una diferida normal (misma fila que renderSingleDif): sin atenuado,
                    // sin badge "sellada", con su cuota "i/M" y su estado real.
                    // Unica diferencia: READ-ONLY (sin acciones editar/borrar) — es historia sellada.
                    // El saldo sale de saldoActual y NO es un 0 fijo: una sellada de un ciclo impago
                    // sigue siendo deuda viva, y el 0 quemado afirmaba lo contrario sobre plata que el
                    // extracto de ese mes si esta cobrando. Pagada, la resta del backend ya da 0.
                    return e('tr', { key: s.id, style: { background: pagada ? 'rgba(52,211,153,0.10)' : undefined } },
                      e('td', null, fmtDate(s.fecha_compra)),
                      e('td', null, e('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                        e('span', { style: { fontWeight: 600 } }, s.etiqueta)
                      )),
                      e('td', { style: { fontSize: 12 } }, s.es_de_tercero
                        ? e('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } }, e('span', { style: { background: s.persona_color || 'var(--accent)', width: 8, height: 8, display: 'inline-block', borderRadius: '50%' } }), e('span', { style: { color: 'var(--text-primary)' } }, s.persona_nombre))
                        : e('span', { style: { color: 'var(--text-muted)' } }, '—')),
                      e('td', { className: 'text-right text-mono', style: { fontWeight: 700, color: pagada ? 'var(--success)' : 'var(--danger)' } }, fmtCOP(s.cuotaCorte)),
                      e('td', null, (s.cuota_num_sellada || 1) + (s.reprog_total_sellada ? '/' + s.reprog_total_sellada : '')),
                      e('td', { className: 'text-mono' }, '—'),
                      e('td', { className: 'text-right text-mono', style: { fontWeight: 700, color: (s.saldoActual || 0) > 0 ? 'var(--danger)' : 'var(--success)' } }, fmtCOP(s.saldoActual || 0)),
                      // Estado + BOLSILLO, como en cualquier compra de 1 cuota. Mientras la cuota siga
                      // impaga hay que poder apartarle dinero desde aqui: se veia en Diferidas pero solo
                      // se podia gestionar desde Compras, y para eso hay que saber que la misma fila
                      // vive en las dos pestañas. Pagada ya no se toca (su bolsillo se consumio).
                      // El target lleva interes_sellado; el intercept de openBolsilloModal sigue
                      // desviando a Terceros cuando la cuota es de un tercero (por eso va persona_id).
                      e('td', null, (() => {
                        if (pagada) return e('span', { className: 'badge badge-pagado', style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '4px 10px' } }, e(Ico, { name: 'check', size: 12, color: 'currentColor' }), 'Pagado');
                        var objetivo = Math.round((s.valor_cop || 0) + (s.interes_sellado || 0));
                        var bol = Math.round(s.monto_bolsillo || 0);
                        var est = (objetivo > 0 && bol >= objetivo) ? 'bolsillo' : (bol > 0 ? 'bolsillo_parcial' : 'pendiente');
                        var falta = Math.max(0, objetivo - bol);
                        return e('div', null,
                          e('span', {
                            className: s.persona_id ? 'badge' : ('badge badge-' + est + ' badge-clickable'),
                            onClick: () => openBolsilloModal({ id: s.compra_id, persona_id: s.persona_id || null, descripcion: s.etiqueta + ' (cuota ' + (s.cuota_num_sellada || 1) + (s.reprog_total_sellada ? '/' + s.reprog_total_sellada : '') + ')', estado: est, valor_cop: s.valor_cop, monto_bolsillo: bol, _bolsilloTarget: objetivo }),
                            title: s.persona_id ? 'Gestionar abono desde la pestaña Terceros' : 'Clic para gestionar bolsillo',
                            style: s.persona_id ? { background: 'var(--bg-input)', color: 'var(--text-muted)', cursor: 'not-allowed', border: '1px solid ' + estadoColor(est) } : undefined
                          }, est.replace(/_/g, ' ')),
                          falta > 0 && bol > 0 && e('div', { style: { fontSize: 11, color: 'var(--warning)', marginTop: 2 } }, 'Falta: ' + fmtCOP(falta))
                        );
                      })()),
                      e('td', null)
                    );
                  };

                  var out = [];
                  dSingles.forEach(d => out.push(d._sellada ? renderSelladaDif(d) : renderSingleDif(d)));
                  Object.keys(dGrupos).forEach(gid => { renderGrupoDif(gid, dGrupos[gid]).forEach(r => out.push(r)); });
                  return out;
                })()
              )
            )
          ),
      // Diferida detail
      diferidaDetail && e('div', null,
        e('div', { className: 'toolbar' },
          e('div', { className: 'section-title', style: { margin: 0 } }, e(Ico, { name: 'clipboard', size: 18, color: 'var(--accent)' }), ' Amortizacion: ' + diferidaDetail.etiqueta),
          e('div', { className: 'toolbar-spacer' }),
          (() => {
            const dd = diferidaDetail;
            // Ya NO se bloquea por tercero_con_reembolso: reprogramar-saldo preserva el libro del tercero
            // (cada cuota sellada conserva su reembolso integro + interes_sellado, y la renacida hereda
            // su persona_id). El flag sigue expuesto por GET /diferidas/:id para otros usos.
            // El motivo sale del MISMO helper que usa la fila, y se abre por la MISMA via (que releé el
            // detalle): dos superficies, un solo criterio y un solo origen de datos para el modal.
            const noElegible = motivoNoReprogramable(dd);
            const uniforme = planEsUniforme(dd);
            return e('button', { className: 'btn btn-sm', disabled: !!noElegible, title: noElegible || (uniforme ? 'Regenera el plan completo desde el inicio' : 'Reprogramar el saldo restante a un nuevo numero de cuotas'), style: noElegible ? { opacity: 0.5, cursor: 'not-allowed', marginRight: 6 } : { marginRight: 6 }, onClick: () => { if (noElegible) return; abrirReprogramar(dd.id); } }, e(Ico, { name: 'refresh', size: 14, color: 'currentColor' }), uniforme ? ' Cambiar plan de cuotas' : ' Reprogramar saldo restante');
          })(),
          e('button', { className: 'btn btn-sm', onClick: () => { setSelectedDiferida(null); setDiferidaDetail(null); }, style: { fontSize: 18, padding: '4px 10px' } }, '\u{2715}')
        ),
        e('div', { className: 'table-wrap', style: { maxHeight: 500, overflowY: 'auto' } },
          e('table', null,
            e('thead', null, e('tr', null,
              e('th', null, '#'), e('th', null, 'Fecha Corte'), e('th', null, 'Dias'),
              e('th', { className: 'text-right' }, 'Saldo Inicial'), e('th', { className: 'text-right' }, 'Int. Periodo'),
              e('th', { className: 'text-right' }, 'Int. Diferido'), e('th', { className: 'text-right' }, 'Int. Total'),
              e('th', { className: 'text-right' }, 'Cuota Capital'), e('th', { className: 'text-right' }, 'Total a Pagar')
            )),
            e('tbody', null,
              diferidaDetail.amortizacion.map(r => {
                const isCurrent = r.fechaCorte >= hoy && (!diferidaDetail.amortizacion[r.numCuota - 2] || diferidaDetail.amortizacion[r.numCuota - 2].fechaCorte < hoy);
                return e('tr', { key: r.numCuota, className: isCurrent ? 'row-highlight' : '' },
                  e('td', null, r.numCuota), e('td', null, fmtDate(r.fechaCorte)), e('td', { className: 'text-center' }, r.dias),
                  e('td', { className: 'text-right text-mono' }, fmtCOP(r.saldoInicial)),
                  e('td', { className: 'text-right text-mono' }, fmtCOPDec(r.interesPeriodo)),
                  e('td', { className: 'text-right text-mono', style: { color: r.interesDiferido > 0 ? 'var(--warning)' : '' } }, r.interesDiferido > 0 ? fmtCOPDec(r.interesDiferido) : '-'),
                  e('td', { className: 'text-right text-mono' }, fmtCOPDec(r.interesTotal)),
                  e('td', { className: 'text-right text-mono' }, fmtCOP(r.cuotaCapital)),
                  e('td', { className: 'text-right text-mono', style: { fontWeight: 700 } }, fmtCOP(r.totalPagar))
                );
              })
            )
          )
        ),
        diferidaDetail.resumen && e('div', { className: 'summary-box' },
          e('div', { style: { fontWeight: 700, marginBottom: 12 } }, 'Resumen'),
          e('div', { className: 'summary-row' }, e('span', { className: 'summary-label' }, 'Cuota Capital Fija'), e('span', { className: 'summary-value' }, fmtCOP(diferidaDetail.resumen.cuotaCapitalFija))),
          e('div', { className: 'summary-row' }, e('span', { className: 'summary-label' }, 'Total Intereses'), e('span', { className: 'summary-value negative' }, fmtCOPDec(diferidaDetail.resumen.totalIntereses))),
          e('div', { className: 'summary-row' }, e('span', { className: 'summary-label' }, 'Saldo Actual'), e('span', { className: 'summary-value' }, fmtCOP(diferidaDetail.resumen.saldoActual)))
        )
      )
    );
    })(),

    // ──── AVANCES SECTION ────
    (() => {
      const avancesCiclo = avances.filter(a => a.ciclos && a.ciclos.includes(ciclo));
      const cicloPagado = !!(data.extractoCiclo && data.extractoCiclo.estado === 'pagado');
      const totalCuotaAvances = cicloPagado
        ? avancesCiclo.filter(a => a.estado === 'activo' || a.estado === 'liquidado').reduce((s, a) => s + (a.cuotaCorte || 0), 0)
        : avancesCiclo.filter(a => a.estado === 'activo').reduce((s, a) => s + (a.cuotaCorte || 0), 0);
      return e('div', { style: { marginTop: 32 } },
      e('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 15, fontWeight: 700, marginBottom: 12 } },
        e('span', null, e(Ico, { name: 'dollar', size: 16, color: 'var(--danger)' }), ' Avances'),
        totalCuotaAvances > 0 && e('span', { className: 'text-mono', style: { color: cicloPagado ? 'var(--success)' : 'var(--danger)' } },
          fmtCOP(totalCuotaAvances) + (cicloPagado ? ' (pagado)' : ''))
      ),
      avancesCiclo.length === 0
        ? e('div', { className: 'empty-state' }, e('div', { className: 'icon' }, e(Ico, { name: 'dollar', size: 48, color: 'var(--text-muted)' })), e('div', null, 'No hay avances en este ciclo'))
        : e('div', { className: 'table-wrap', style: { marginBottom: 16 } },
            e('table', null,
              e('thead', null, e('tr', null,
                e('th', null, 'Descripcion'), e('th', { className: 'text-right' }, 'Monto'), e('th', null, 'Tasa MV'),
                e('th', null, 'Plazo'), e('th', null, 'Desembolso'), e('th', { className: 'text-right' }, 'Saldo Actual'),
                e('th', { className: 'text-right' }, 'Cuota'),
                e('th', null, 'Estado'),
                e('th', null, '')
              )),
              e('tbody', null,
                avancesCiclo.map(a => {
                  // Per-cuota: cuota_num del ciclo navegado (1-indexed sobre la tabla)
                  var cuotaNumAv = a.ciclos ? a.ciclos.indexOf(ciclo) + 1 : 1;
                  var avBol = (a.bolsillo_por_cuota && a.bolsillo_por_cuota[cuotaNumAv]) || 0;
                  var avTarget = a.cuotaCorte || 0;
                  var avBolBadge = avTarget > 0
                    ? (Math.round(avBol) >= Math.round(avTarget) ? 'bolsillo' : avBol > 0 ? 'bolsillo_parcial' : 'pendiente')
                    : null;
                  var avFalta = avBolBadge === 'bolsillo_parcial' ? Math.round(avTarget - avBol) : 0;
                  var rowStyle = { cursor: 'pointer' };
                  if (cicloPagado) rowStyle.background = 'rgba(52,211,153,0.10)';
                  // Inmutabilidad de avances: solo se puede editar/eliminar si el desembolso es del ciclo actual
                  // (antigüedad < 1 mes) Y el extracto de ese ciclo aún no está pagado.
                  // Renombrar/anotar: SIEMPRE permitido (no toca la amortizacion; sirve para ajustar el
                  // nombre al texto del extracto y mejorar el cruce del Asistente IA). Eliminar: inmutable
                  // salvo ciclo vigente + extracto no pagado.
                  var canDeleteAvance = tarjeta && calcCicloLocal(a.fecha_desembolso, tarjeta.dia_corte) === cicloVigente(tarjeta.dia_corte) && !cicloPagado;
                  return e('tr', { key: a.id, onClick: () => loadAvanceDetail(a.id), style: rowStyle, className: selectedAvance === a.id ? 'row-highlight' : '' },
                    e('td', { style: { fontWeight: 600 } }, a.etiqueta),
                    e('td', { className: 'text-right text-mono' }, fmtCOP(a.monto)),
                    e('td', { className: 'text-mono' }, (a.tasa_mv * 100).toFixed(3) + '%'),
                    e('td', null, a.plazo + ' meses'),
                    e('td', null, fmtDate(a.fecha_desembolso)),
                    e('td', { className: 'text-right text-mono', style: { fontWeight: 700, color: a.saldoActual > 0 ? 'var(--danger)' : 'var(--success)' } }, fmtCOP(a.saldoActual)),
                    e('td', { className: 'text-right text-mono', style: { color: cicloPagado ? 'var(--success)' : 'var(--danger)' } }, avTarget > 0 ? fmtCOP(avTarget) : '-'),
                    // Estado: una sola columna que captura ciclo pagado / liquidado / bolsillo / bolsillo_parcial / pendiente.
                    // (Antes había una columna "Bolsillo" separada + otra "Estado" con "activo" redundante.)
                    e('td', null,
                      cicloPagado
                        ? e('span', { className: 'badge badge-pagado', style: { display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, padding: '4px 10px' } },
                            e(Ico, { name: 'check', size: 12, color: 'currentColor' }), 'Pagado')
                        : a.estado === 'liquidado'
                          ? e('span', { className: 'badge badge-liquidado' }, 'liquidado')
                          : (avBolBadge
                              ? e('span', {
                                  className: 'badge badge-' + avBolBadge + ' badge-clickable',
                                  onClick: (ev) => { ev.stopPropagation(); openBolsilloAvanceModal(a, { cuota_num: cuotaNumAv, target: avTarget }); },
                                  title: 'Clic para gestionar bolsillo de esta cuota'
                                }, avBolBadge.replace(/_/g, ' '))
                              : null),
                      !cicloPagado && a.estado !== 'liquidado' && avFalta > 0 && e('div', { style: { fontSize: 11, color: 'var(--warning)', marginTop: 2 } }, 'Falta: ' + fmtCOP(avFalta))
                    ),
                    e('td', { style: { whiteSpace: 'nowrap' } },
                      e('button', { className: 'btn btn-sm', title: 'Editar nombre y nota', onClick: (ev) => { ev.stopPropagation(); setEditAvance(a); setShowAvanceModal(true); } }, e(Ico, { name: 'edit', size: 14, color: 'currentColor' })),
                      canDeleteAvance && ' ',
                      canDeleteAvance && e('button', { className: 'btn btn-sm btn-danger', onClick: (ev) => { ev.stopPropagation(); removeAvance(a.id); } }, e(Ico, { name: 'trash', size: 14, color: 'currentColor' }))
                    )
                  );
                })
              )
            )
          ),
      // Avance detail
      avanceDetail && e('div', null,
        e('div', { className: 'toolbar' },
          e('div', { className: 'section-title', style: { margin: 0 } }, e(Ico, { name: 'clipboard', size: 18, color: 'var(--accent)' }), ' Amortizacion: ' + avanceDetail.etiqueta),
          e('div', { className: 'toolbar-spacer' }),
          e('button', { className: 'btn btn-sm', onClick: () => { setSelectedAvance(null); setAvanceDetail(null); }, style: { fontSize: 18, padding: '4px 10px' } }, '\u{2715}')
        ),
        avanceDetail.abonos && avanceDetail.abonos.length > 0 && e('div', { style: { marginBottom: 16 } },
          e('div', { style: { fontSize: 13, fontWeight: 600, marginBottom: 8, color: 'var(--text-secondary)' } }, 'Abonos a Capital:'),
          e('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
            avanceDetail.abonos.map(ab =>
              e('div', { key: ab.id, style: { background: 'var(--success-bg)', border: '1px solid var(--success)', borderRadius: 8, padding: '6px 12px', fontSize: 12, display: 'flex', gap: 8, alignItems: 'center' } },
                e('span', null, fmtDate(ab.fecha) + ' - ' + fmtCOP(ab.monto)),
                e('button', { className: 'btn btn-sm btn-danger', style: { padding: '2px 6px', fontSize: 10 }, onClick: () => removeAbono(ab.id) }, 'x')
              )
            )
          )
        ),
        e('div', { className: 'table-wrap', style: { maxHeight: 500, overflowY: 'auto' } },
          e('table', null,
            e('thead', null, e('tr', null,
              e('th', null, '#'), e('th', null, 'Fecha Corte'), e('th', null, 'Dias'),
              e('th', { className: 'text-right' }, 'Saldo Inicio'), e('th', { className: 'text-right' }, 'Abonos'),
              e('th', { className: 'text-right' }, 'Interes'), e('th', { className: 'text-right' }, 'Cuota Capital'),
              e('th', { className: 'text-right' }, 'Total Extracto'), e('th', { className: 'text-right' }, 'Saldo Final')
            )),
            e('tbody', null,
              avanceDetail.amortizacion.map(r => {
                const isCurrent = r.fechaCorte >= hoy && (!avanceDetail.amortizacion[r.numCuota - 2] || avanceDetail.amortizacion[r.numCuota - 2].fechaCorte < hoy);
                return e('tr', { key: r.numCuota, className: isCurrent ? 'row-highlight' : '' },
                  e('td', null, r.numCuota), e('td', null, fmtDate(r.fechaCorte)), e('td', { className: 'text-center' }, r.dias),
                  e('td', { className: 'text-right text-mono' }, fmtCOP(r.saldoInicio)),
                  e('td', { className: 'text-right text-mono', style: { color: r.abonos > 0 ? 'var(--success)' : '' } }, r.abonos > 0 ? fmtCOP(r.abonos) : '-'),
                  e('td', { className: 'text-right text-mono' }, fmtCOPDec(r.interes)),
                  e('td', { className: 'text-right text-mono' }, fmtCOP(r.cuotaCapital)),
                  e('td', { className: 'text-right text-mono', style: { fontWeight: 700 } }, fmtCOP(r.totalExtracto)),
                  e('td', { className: 'text-right text-mono' }, fmtCOP(r.saldoFinal))
                );
              })
            )
          )
        ),
        avanceDetail.resumen && e('div', { className: 'summary-box' },
          e('div', { style: { fontWeight: 700, marginBottom: 12, fontSize: 14 } }, 'Resumen del Avance'),
          e('div', { className: 'summary-row' }, e('span', { className: 'summary-label' }, 'Cuota Capital Fija'), e('span', { className: 'summary-value' }, fmtCOP(avanceDetail.resumen.cuotaCapitalFija))),
          e('div', { className: 'summary-row' }, e('span', { className: 'summary-label' }, 'Intereses Pagados'), e('span', { className: 'summary-value negative' }, fmtCOPDec(avanceDetail.resumen.interesesPagados))),
          e('div', { className: 'summary-row' }, e('span', { className: 'summary-label' }, 'Saldo Actual'), e('span', { className: 'summary-value negative' }, fmtCOP(avanceDetail.resumen.saldoActual))),
          e('div', { className: 'summary-row' }, e('span', { className: 'summary-label' }, 'Cuotas Restantes'), e('span', { className: 'summary-value' }, avanceDetail.resumen.cuotasRestantes + ' de ' + avanceDetail.amortizacion.length)),
          avanceDetail.resumen.ahorroIntereses > 0 && e('div', { className: 'summary-row' }, e('span', { className: 'summary-label' }, e(Ico, { name: 'trending', size: 14, color: 'var(--success)' }), ' Interes Ahorrado'), e('span', { className: 'summary-value', style: { color: 'var(--success)', fontWeight: 700 } }, fmtCOPDec(avanceDetail.resumen.ahorroIntereses)))
        )
      )
    );
    })(),

    // ──── MODALS ────
    // Registrar Movimiento modal (unified)
    e(Modal, { show: showMovModal, onClose: () => setShowMovModal(false), title: 'Registrar Movimiento', large: true },
      e('div', { style: { marginBottom: 16 } },
        e('div', { style: { display: 'flex', gap: 8 } },
          e('button', { type: 'button', className: 'btn' + (movType === 'compra' ? ' btn-primary' : ''), onClick: () => setMovType('compra') }, e(Ico, { name: 'cart', size: 14 }), ' Compra'),
          e('button', { type: 'button', className: 'btn' + (movType === 'avance' ? ' btn-primary' : ''), onClick: () => setMovType('avance') }, e(Ico, { name: 'dollar', size: 14 }), ' Avance')
        )
      ),
      movType === 'compra' && e(CompraForm, { personas, ciclo, tarjeta, onSave: saveCompra, onCancel: () => setShowMovModal(false) }),
      movType === 'avance' && e(AvanceForm, { tarjeta, onSave: saveAvance, onCancel: () => setShowMovModal(false) })
    ),
    // Edit compra modal
    e(Modal, { show: showCompraModal, onClose: () => setShowCompraModal(false), title: editCompra && editCompra._isGrupo ? 'Editar Compra Dividida' : 'Editar Compra' },
      e(CompraForm, { item: editCompra, personas, ciclo, tarjeta, onSave: saveCompra, onCancel: () => setShowCompraModal(false) })
    ),
    // Edit avance modal
    e(Modal, { show: showAvanceModal, onClose: () => setShowAvanceModal(false), title: 'Editar Detalles de Avance' },
      e(AvanceForm, { item: editAvance, tarjeta, onSave: saveAvance, onCancel: () => setShowAvanceModal(false) })
    ),
    // Edit diferida modal
    e(Modal, { show: showDiferidaModal, onClose: () => setShowDiferidaModal(false), title: 'Editar Detalles de Diferida' },
      e(DiferidaForm, { item: editDiferida, tarjeta, onSave: saveDiferida, onCancel: () => setShowDiferidaModal(false) })
    ),
    // Reprogramar saldo modal (Sellar y Renacer)
    e(Modal, { show: showReprogramarModal, onClose: () => { setShowReprogramarModal(false); setReproDiferida(null); }, title: 'Reprogramar Cuotas (saldo restante)' },
      reproDiferida && e(ReprogramarForm, { item: reproDiferida, tarjeta, onSave: saveReprograma, onCancel: () => { setShowReprogramarModal(false); setReproDiferida(null); } })
    ),
    // Plan completo de una diferida SIN compra vinculada (regenera desde el origen)
    e(Modal, { show: showPlanModal, onClose: () => { setShowPlanModal(false); setPlanDiferida(null); }, title: 'Cambiar Plan de Cuotas' },
      planDiferida && e(ReprogramarPlanForm, { item: planDiferida, onSave: savePlanUniforme, onCancel: () => { setShowPlanModal(false); setPlanDiferida(null); } })
    ),
    // Abono a avance modal
    e(Modal, { show: showAbonoModal, onClose: () => setShowAbonoModal(false), title: 'Registrar Abono a Avance' },
      e(AbonoForm, { onSave: saveAbono, onCancel: () => setShowAbonoModal(false) })
    ),
    // Abono a Capital modal
    e(Modal, { show: showAbonoCapitalModal, onClose: closeAbonoCapital, title: 'Abono a Capital' },
      (() => {
        const detalleTable = (detalle) => e('table', null,
          e('thead', null, e('tr', null,
            e('th', null, 'Tipo'),
            e('th', null, 'Descripcion'),
            e('th', { className: 'text-right' }, 'Saldo'),
            e('th', { className: 'text-right' }, 'Se aplica'),
            e('th', null, 'Estado')
          )),
          e('tbody', null,
            detalle.map((d, i) =>
              e('tr', { key: i },
                e('td', null, e('span', { className: 'badge badge-' + (d.tipo === 'compra' ? 'warning' : 'active') }, d.tipo.toUpperCase())),
                e('td', null, d.descripcion),
                e('td', { className: 'text-right text-mono' }, fmtCOP(d.saldoOriginal)),
                e('td', { className: 'text-right text-mono', style: { color: 'var(--success)', fontWeight: 600 } }, fmtCOP(d.montoAplicado)),
                e('td', null, e('span', { className: 'badge badge-' + (d.cubierto === 'total' ? 'pagado' : 'pendiente') },
                  d.cubierto === 'total' ? 'LIQUIDADO' : 'PARCIAL'))
              )
            )
          )
        );

        if (abonoCapitalResult) return e('div', null,
          e('div', { style: { marginBottom: 16, fontSize: 15, fontWeight: 700, color: 'var(--success)' } }, 'Abono aplicado correctamente'),
          e('div', { style: { marginBottom: 8 } }, 'Monto aplicado: ', e('strong', null, fmtCOP(abonoCapitalResult.aplicado))),
          abonoCapitalResult.restante > 0 && e('div', { style: { marginBottom: 8, color: 'var(--warning)' } }, 'Sobrante (sin deudas donde aplicar): ', e('strong', null, fmtCOP(abonoCapitalResult.restante))),
          abonoCapitalResult.bolsilloLiberado > 0 && e('div', { style: { marginBottom: 8, color: 'var(--accent)' } }, 'Se liberaron del bolsillo: ', e('strong', null, fmtCOP(abonoCapitalResult.bolsilloLiberado)), ' (disponibles de nuevo)'),
          e('div', { style: { marginTop: 16 } },
            e('div', { style: { fontWeight: 600, marginBottom: 8 } }, 'Distribucion del abono:'),
            detalleTable(abonoCapitalResult.detalle),
            e('div', { style: { marginTop: 12, padding: '8px 12px', background: 'var(--bg-tertiary)', borderRadius: 8, fontSize: 13 } },
              abonoCapitalResult.detalle.filter(d => d.tipo === 'compra' && d.cubierto === 'total').length > 0 &&
                e('div', { style: { color: 'var(--text-secondary)' } }, 'Las compras liquidadas fueron marcadas como pagadas.')
            )
          ),
          e('div', { className: 'modal-actions', style: { marginTop: 16 } },
            e('button', { className: 'btn btn-primary', onClick: closeAbonoCapital }, 'Cerrar')
          )
        );

        const montoNum = parseFloat(abonoCapitalMonto) || 0;
        const previewValido = abonoCapitalPreview && !abonoCapitalPreview.error && montoNum > 0;
        return e('form', { onSubmit: (ev) => { ev.preventDefault(); if (previewValido) submitAbonoCapital(); } },
          e('div', { style: { marginBottom: 12, fontSize: 13, color: 'var(--text-secondary)' } },
            'El abono se distribuye en orden: 1° Compras nacionales (más antiguas primero) → 2° Compras internacionales → 3° Cuotas diferidas → 4° Avances.'
          ),
          e('div', { className: 'form-row' },
            e('div', { className: 'form-group' },
              e('label', { className: 'form-label' }, 'Fecha'),
              e('input', { type: 'date', className: 'form-input', value: abonoCapitalFecha, onChange: ev => setAbonoCapitalFecha(ev.target.value), required: true })
            ),
            e('div', { className: 'form-group' },
              e('label', { className: 'form-label' }, 'Monto'),
              e(MoneyInput, { value: abonoCapitalMonto, onChange: val => setAbonoCapitalMonto(val), required: true, placeholder: 'Ej: 1.000.000' })
            )
          ),
          // Resumen EN VIVO: se actualiza conforme cambias el monto, sin pulsar nada.
          (() => {
            if (montoNum <= 0) return null;
            if (!abonoCapitalPreview) return e('div', { className: 'form-hint', style: { marginTop: 8 } }, 'Calculando distribucion...');
            if (abonoCapitalPreview.error) return e('div', { style: { marginTop: 8, padding: '10px 12px', background: 'var(--danger-bg)', color: 'var(--danger)', borderRadius: 8, fontSize: 13, lineHeight: 1.4 } }, abonoCapitalPreview.error);
            if (!abonoCapitalPreview.detalle || abonoCapitalPreview.detalle.length === 0) return e('div', { className: 'form-hint', style: { marginTop: 8, color: 'var(--warning)' } }, 'No hay deudas donde aplicar este abono.');
            return e('div', { style: { marginTop: 12 } },
              e('div', { style: { fontWeight: 600, marginBottom: 8, fontSize: 13 } }, 'Se aplicara asi (', fmtCOP(abonoCapitalPreview.aplicado), '):'),
              detalleTable(abonoCapitalPreview.detalle),
              abonoCapitalPreview.restante > 0 && e('div', { style: { marginTop: 8, fontSize: 13, color: 'var(--warning)' } }, 'Sobrante (sin deudas donde aplicar): ', e('strong', null, fmtCOP(abonoCapitalPreview.restante))),
              abonoCapitalPreview.bolsilloLiberado > 0 && e('div', { style: { marginTop: 8, fontSize: 13, color: 'var(--accent)' } }, 'Se liberaran ', e('strong', null, fmtCOP(abonoCapitalPreview.bolsilloLiberado)), ' del bolsillo (quedaran disponibles).')
            );
          })(),
          e('div', { className: 'modal-actions', style: { marginTop: 16 } },
            e('button', { type: 'button', className: 'btn', onClick: closeAbonoCapital }, 'Cancelar'),
            e('button', { type: 'submit', className: 'btn btn-success', disabled: abonoCapitalSaving || !previewValido }, abonoCapitalSaving ? 'Aplicando...' : 'Aplicar abono a capital')
          )
        );
      })()
    ),
    // Bolsillo modal (soporta compras regulares, diferidas y avances)
    (() => {
      if (!bolsilloCompra) return e(Modal, { show: showBolsilloModal, onClose: () => setShowBolsilloModal(false), title: 'Bolsillo' });
      var isAvance = !!bolsilloCompra._isAvance;
      var isDif = bolsilloCompra.estado === 'diferida';
      var isCuotaTarget = isDif || isAvance;
      // Detección de moneda: la compra es "USD pura" si valor_usd > 0 y valor_cop = 0/null.
      // Para diferidas USD, el target USD se calcula prorrateando valor_usd / num_cuotas.
      var esUsdBol = !!(bolsilloCompra.valor_usd && bolsilloCompra.valor_usd > 0 && !bolsilloCompra.valor_cop);
      var fmtBol = (n) => esUsdBol
        ? 'USD $' + new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0)
        : fmtCOP(n || 0);
      var targetCop = bolsilloCompra._bolsilloTarget || (isCuotaTarget ? (bolsilloCompra.cuotaCorte || bolsilloCompra.valor_cop) : bolsilloCompra.valor_cop);
      var targetUsd = isCuotaTarget && bolsilloCompra.cuotas_total
        ? (bolsilloCompra.valor_usd || 0) / bolsilloCompra.cuotas_total
        : (bolsilloCompra.valor_usd || 0);
      var target = esUsdBol ? targetUsd : targetCop;
      var mb = esUsdBol ? (bolsilloCompra.monto_bolsillo_usd || 0) : (bolsilloCompra.monto_bolsillo || 0);
      // Helper: construir body con cuota_num y moneda
      var mkBody = function(monto) {
        var b = { monto_bolsillo: monto, moneda: esUsdBol ? 'USD' : 'COP' };
        if ((isDif || isAvance) && bolsilloCompra.cuota_num) b.cuota_num = bolsilloCompra.cuota_num;
        return b;
      };
      var bState = isCuotaTarget
        ? (mb >= target ? 'bolsillo' : mb > 0 ? 'bolsillo_parcial' : 'pendiente')
        : bolsilloCompra.estado;
      var modalTitle = (bState === 'pendiente' ? 'Apartar en Bolsillo' : bState === 'bolsillo' ? 'Retirar de Bolsillo' : 'Gestionar Bolsillo') + (esUsdBol ? ' (USD)' : '');
      var endpoint = isAvance ? '/avances/' + bolsilloCompra.id + '/bolsillo' : bolsilloCompra._isDiferida ? '/diferidas/' + bolsilloCompra.id + '/bolsillo' : '/compras/' + bolsilloCompra.id + '/bolsillo';
      return e(Modal, { show: showBolsilloModal, onClose: () => setShowBolsilloModal(false), title: modalTitle },
        e('div', null,
          e('div', { style: { marginBottom: 16, padding: '12px 16px', background: 'var(--bg-tertiary)', borderRadius: 8 } },
            e('div', { style: { fontSize: 13, color: 'var(--text-secondary)', marginBottom: 4 } }, bolsilloCompra.descripcion),
            isAvance && bolsilloCompra.cuota_num && e('div', { style: { fontSize: 12, color: 'var(--accent)', marginBottom: 4 } }, 'Cuota ' + bolsilloCompra.cuota_num + '/' + (bolsilloCompra.cuotas_total || '?')),
            isDif && bolsilloCompra.cuota_num && e('div', { style: { fontSize: 12, color: 'var(--accent)', marginBottom: 4 } }, 'Cuota ' + badgeCuotaLabel(bolsilloCompra.cuota_num, bolsilloCompra.cuotas_total, bolsilloCompra.reprog_total)),
            isDif && bolsilloCompra.persona_id && e('div', { style: { fontSize: 12, color: 'var(--text-muted)', marginBottom: 4 } }, 'Parte de: ' + (bolsilloCompra.persona_nombre || 'Tercero')),
            e('div', { style: { fontSize: 18, fontWeight: 700, color: esUsdBol ? '#4FC3F7' : undefined } }, (isCuotaTarget ? 'Cuota: ' : 'Total: '), fmtBol(target)),
            isDif && !esUsdBol && target !== bolsilloCompra.valor_cop && e('div', { style: { fontSize: 11, color: 'var(--text-muted)', marginTop: 2 } }, 'Valor total compra: ' + fmtCOP(bolsilloCompra.valor_cop)),
            isDif && esUsdBol && e('div', { style: { fontSize: 11, color: 'var(--text-muted)', marginTop: 2 } }, 'Valor total compra: USD $' + new Intl.NumberFormat('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(bolsilloCompra.valor_usd)),
            mb > 0 && e('div', { style: { fontSize: 13, color: 'var(--success)', marginTop: 4 } }, 'Apartado actualmente: ', fmtBol(mb))
          ),
          bState === 'pendiente' && e('div', null,
            e('button', { type: 'button', className: 'btn btn-success', style: { width: '100%', marginBottom: 12, marginTop: 12 }, onClick: () => {
              api(endpoint, { method: 'PUT', body: mkBody(target) })
                .then(() => { setShowBolsilloModal(false); refreshAll(); toast((isAvance ? 'Cuota' : 'Compra') + ' apartada en bolsillo'); });
            } }, 'Apartar todo (' + fmtBol(target) + ')'),
            e('div', { style: { textAlign: 'center', fontSize: 13, color: 'var(--text-muted)', marginBottom: 12 } }, 'o apartar un monto parcial:')
          ),
          bState === 'bolsillo' && e('div', { style: { marginTop: 12, marginBottom: 12, fontSize: 13, color: 'var(--text-secondary)' } },
            'Ingresa el nuevo monto apartado (menor al total para parcial, 0 para quitar):'
          ),
          bState === 'bolsillo_parcial' && e('button', { type: 'button', className: 'btn btn-success', style: { width: '100%', marginBottom: 8, marginTop: 12 }, onClick: () => {
              api(endpoint, { method: 'PUT', body: mkBody(target) })
                .then(() => { setShowBolsilloModal(false); refreshAll(); toast('Apartado en bolsillo'); });
            } }, 'Apartar restante (' + fmtBol(target - mb) + ')'),
          e('div', { className: 'form-group' },
            e('label', { className: 'form-label' }, (bState === 'bolsillo_parcial' ? 'Monto a agregar' : 'Monto apartado') + (esUsdBol ? ' (USD)' : '')),
            e(MoneyInput, { value: bolsilloMonto, onChange: val => setBolsilloMonto(val), placeholder: esUsdBol ? 'Ej: 50.00' : 'Ej: 50.000' }),
            (() => {
              var val = parseFloat(bolsilloMonto) || 0;
              if (!val) return null;
              if (bState === 'bolsillo_parcial') {
                var totalR = mb + val;
                return totalR >= target
                  ? e('div', { className: 'form-hint', style: { color: 'var(--success)' } }, 'Total resultante: ' + fmtBol(totalR) + ' — Cubre el total')
                  : e('div', { className: 'form-hint', style: { color: 'var(--warning)' } }, 'Total resultante: ' + fmtBol(totalR) + ' · Faltaria: ' + fmtBol(target - totalR));
              }
              return val < target
                ? e('div', { className: 'form-hint', style: { color: 'var(--warning)' } }, 'Faltaria: ' + fmtBol(target - val))
                : e('div', { className: 'form-hint', style: { color: 'var(--success)' } }, 'Cubre el total — se marcara como Bolsillo completo');
            })()
          ),
          e('div', { className: 'modal-actions', style: { marginTop: 16 } },
            bState !== 'pendiente' && e('button', { type: 'button', className: 'btn btn-danger', onClick: () => {
              api(endpoint, { method: 'PUT', body: mkBody(0) })
                .then(() => { setShowBolsilloModal(false); refreshAll(); toast('Bolsillo removido'); });
            } }, 'Quitar de bolsillo'),
            e('button', { type: 'button', className: 'btn', onClick: () => setShowBolsilloModal(false) }, 'Cancelar'),
            e('button', { type: 'button', className: 'btn btn-primary', onClick: saveBolsillo }, 'Guardar')
          )
        )
      );
    })(),
    // Modal de edición de fecha de pago (override por ciclo)
    e(Modal, {
      show: showFechaPagoModal,
      onClose: () => setShowFechaPagoModal(false),
      title: 'Fecha de pago — ' + ciclo
    },
      e('div', null,
        e('div', { style: { marginBottom: 12, fontSize: 13, color: 'var(--text-secondary)' } },
          'Si la fecha que muestra el banco en el extracto difiere de la calculada (festivos, fines de semana), fíjala aquí. Solo afecta a este ciclo (', ciclo, '), no a los demás meses ni a otros cálculos.'
        ),
        e('div', { className: 'form-group' },
          e('label', { className: 'form-label' }, 'Fecha de pago'),
          e('input', {
            type: 'date',
            className: 'form-input',
            value: fechaPagoInput,
            onChange: (ev) => setFechaPagoInput(ev.target.value)
          }),
          data.fechaPago && data.fechaPago.esManual && e('div', { className: 'form-hint', style: { color: 'var(--accent)' } }, 'Actualmente esta fecha está fijada manualmente.')
        ),
        e('div', { className: 'modal-actions', style: { marginTop: 16 } },
          data.fechaPago && data.fechaPago.esManual && e('button', {
            type: 'button',
            className: 'btn btn-danger',
            onClick: () => {
              api('/extractos/fecha-pago-custom', { method: 'PUT', body: { tarjeta_id: tarjeta.id, ciclo, fecha_pago: null } })
                .then(() => { setShowFechaPagoModal(false); refreshAll(); toast('Override de fecha eliminado'); });
            }
          }, 'Quitar override'),
          e('button', { type: 'button', className: 'btn', onClick: () => setShowFechaPagoModal(false) }, 'Cancelar'),
          e('button', {
            type: 'button',
            className: 'btn btn-primary',
            onClick: () => {
              if (!fechaPagoInput) { toast('Selecciona una fecha valida'); return; }
              api('/extractos/fecha-pago-custom', { method: 'PUT', body: { tarjeta_id: tarjeta.id, ciclo, fecha_pago: fechaPagoInput } })
                .then(() => { setShowFechaPagoModal(false); refreshAll(); toast('Fecha de pago actualizada'); });
            }
          }, 'Guardar')
        )
      )
    )
  );
}
